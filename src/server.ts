/**
 * HTTP surface. This is the whole process on Cloud Run.
 *
 * Four routes:
 *   GET  /health                  — Cloud Run startup probe
 *   POST /telegram/<secret>       — Telegram webhook (public, secret in path + header)
 *   POST /tasks/poll              — Cloud Scheduler
 *   POST /tasks/publish           — Cloud Scheduler
 *   POST /tasks/housekeeping      — Cloud Scheduler
 *
 * Raw node:http rather than a framework: four routes don't justify the
 * dependency, and it keeps the container image small enough that cold starts
 * stay under a second.
 *
 * One Cloud Run constraint drives the whole design here: **CPU is only
 * guaranteed while a request is in flight.** You cannot ack a webhook and
 * then finish the work in the background — the instance may be frozen the
 * moment you respond. So every handler does its work *before* replying.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from './logger';
import { env } from './env';
import { bot } from './telegram/bot';
import { acquire } from './lock';
import { runPollCycle, runPublishCycle, runHousekeeping } from './cycle';
import type { Config } from './config';

const json = (res: ServerResponse, code: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Cloud Run services must be publicly reachable for Telegram to deliver
 * webhooks, so /tasks/* can't rely on IAM. A shared secret from Cloud
 * Scheduler is the guard instead.
 */
function authorizedTask(req: IncomingMessage): boolean {
  const header = req.headers['x-flaww-task-secret'];
  return typeof header === 'string' && safeEqual(header, env.TASKS_SECRET);
}

export function createApp(cfg: Config) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const started = Date.now();

    try {
      // ── health ────────────────────────────────────────────────────────
      if (req.method === 'GET' && (path === '/health' || path === '/')) {
        return json(res, 200, { ok: true, service: 'flaww' });
      }

      // ── telegram webhook ──────────────────────────────────────────────
      if (req.method === 'POST' && path === `/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`) {
        // Telegram also sends the secret as a header when registered with
        // setWebhook({secret_token}); check both.
        const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
        if (typeof headerSecret !== 'string' || !safeEqual(headerSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
          return json(res, 401, { error: 'bad secret' });
        }

        const update = JSON.parse(await readBody(req)) as { update_id: number };

        // Telegram redelivers on timeout or non-2xx. Claim the update id so a
        // redelivery can't post your reply twice.
        if (!(await acquire(`tg:update:${update.update_id}`, 3600))) {
          return json(res, 200, { ok: true, duplicate: true });
        }

        // Must complete before responding — see the CPU note at the top.
        await bot.handleUpdate(update as never);
        return json(res, 200, { ok: true });
      }

      // ── scheduled tasks ───────────────────────────────────────────────
      if (req.method === 'POST' && path.startsWith('/tasks/')) {
        if (!authorizedTask(req)) return json(res, 401, { error: 'unauthorized' });

        switch (path) {
          case '/tasks/poll': {
            const r = await runPollCycle(cfg);
            log.info({ ...r, ms: Date.now() - started }, 'poll cycle');
            return json(res, 200, r);
          }
          case '/tasks/publish': {
            const r = await runPublishCycle();
            if (r.published || r.expired) log.info({ ...r }, 'publish cycle');
            return json(res, 200, r);
          }
          case '/tasks/housekeeping': {
            const r = await runHousekeeping();
            return json(res, 200, r);
          }
          default:
            return json(res, 404, { error: 'unknown task' });
        }
      }

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error({ path, err: String(err) }, 'request failed');
      // 5xx makes Cloud Scheduler retry, which is what we want for a transient
      // failure — the distributed lock keeps the retry from double-polling.
      return json(res, 500, { error: String(err).slice(0, 300) });
    }
  });
}
