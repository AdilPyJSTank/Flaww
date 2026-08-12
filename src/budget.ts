/**
 * Hard API + spend ceilings.
 *
 * Every outbound call passes through here first. When a window is exhausted
 * the source *stops* until it rolls over — it does not slow down or degrade.
 *
 * Note the X units. Under pay-per-use you are billed per TWEET READ, not per
 * request, so counting requests would understate cost by up to 100x (one
 * request can return 100 tweets). `x_tweets` is the meter that matters;
 * `x_reqs` is a secondary guard against a poll storm.
 */
import { prisma } from './db';
import { log } from './logger';
import type { Config } from './config';

export type Meter =
  | 'reddit'
  | 'threads'
  | 'linkedin'
  | 'x_reqs'
  | 'x_tweets'
  | 'x_writes'
  | 'llm';

export type Window = 'hour' | 'day' | 'month';

/** Your rates, from the X pay-per-use pricing. Adjust if they change. */
export const X_PRICING = {
  readPerTweet: 0.005,
  writePlain: 0.015,
  writeWithLink: 0.2,
} as const;

function windowKey(meter: Meter, window: Window, now = new Date()): string {
  const iso = now.toISOString();
  const stamp =
    window === 'hour' ? iso.slice(0, 13) : window === 'day' ? iso.slice(0, 10) : iso.slice(0, 7);
  return `${meter}:${window}:${stamp}`;
}

async function read(key: string) {
  const row = await prisma.budget.findUnique({ where: { id: key } });
  return row ?? { used: 0, costUsd: 0, notified: false };
}

function limitsFor(cfg: Config, meter: Meter): Array<[Window, number]> {
  switch (meter) {
    case 'reddit':
      return [
        ['hour', cfg.budgets.reddit.requestsPerHour],
        ['day', cfg.budgets.reddit.requestsPerDay],
      ];
    case 'threads':
      return [
        ['hour', cfg.budgets.threads.requestsPerHour],
        ['day', cfg.budgets.threads.requestsPerDay],
      ];
    case 'linkedin':
      return [
        ['hour', cfg.budgets.linkedin.requestsPerHour],
        ['day', cfg.budgets.linkedin.requestsPerDay],
      ];
    case 'x_reqs':
      return [['hour', cfg.budgets.x.requestsPerHour]];
    case 'x_tweets':
      return [
        ['day', cfg.budgets.x.tweetsPerDay],
        ['month', cfg.budgets.x.tweetsPerMonth],
      ];
    case 'x_writes':
      return [['day', cfg.budgets.x.writesPerDay]];
    case 'llm':
      return [['day', cfg.budgets.llm.postsPerDay]];
  }
}

export interface BudgetCheck {
  ok: boolean;
  blockedBy?: string;
  /** Headroom in the tightest window — used to size the next X fetch. */
  remaining?: number;
}

/**
 * Ask permission for `count` units. Does NOT consume — call `consume()` once
 * the work actually happened, so a request that never reached the provider
 * doesn't eat quota.
 */
export async function check(cfg: Config, meter: Meter, count = 1): Promise<BudgetCheck> {
  let tightest = Infinity;

  for (const [window, limit] of limitsFor(cfg, meter)) {
    const { used } = await read(windowKey(meter, window));
    tightest = Math.min(tightest, limit - used);
    if (used + count > limit) {
      return { ok: false, blockedBy: `${meter} ${window} limit (${used}/${limit})`, remaining: 0 };
    }
  }

  if (meter === 'llm') {
    const { costUsd } = await read(windowKey('llm', 'day'));
    if (costUsd >= cfg.budgets.llm.usdPerDay) {
      return {
        ok: false,
        blockedBy: `llm daily spend ($${costUsd.toFixed(3)}/$${cfg.budgets.llm.usdPerDay})`,
      };
    }
  }

  return { ok: true, remaining: Number.isFinite(tightest) ? tightest : undefined };
}

export async function consume(meter: Meter, count = 1, costUsd = 0): Promise<void> {
  // Always write all three windows. Cheap, and it means `check` can consult
  // whichever ones a meter happens to care about without special-casing here.
  const windows: Window[] = ['hour', 'day', 'month'];

  await Promise.all(
    windows.map((w) => {
      const id = windowKey(meter, w);
      return prisma.budget.upsert({
        where: { id },
        create: { id, used: count, costUsd },
        update: { used: { increment: count }, costUsd: { increment: costUsd } },
      });
    }),
  );
}

/** Fire an exhaustion notice at most once per window, so a poller that keeps
 *  hitting the wall doesn't spam Telegram. */
export async function claimNotification(meter: Meter, window: Window): Promise<boolean> {
  const id = windowKey(meter, window);
  const row = await prisma.budget.findUnique({ where: { id } });
  if (row?.notified) return false;
  await prisma.budget.upsert({
    where: { id },
    create: { id, used: 0, notified: true },
    update: { notified: true },
  });
  return true;
}

/** Snapshot for /status. Only reports meters whose source is enabled. */
export async function snapshot(cfg: Config) {
  const get = async (m: Meter, w: Window) => (await read(windowKey(m, w))).used;
  const out: Record<string, string[]> = {};

  if (cfg.reddit.enabled) {
    out.reddit = [
      `${await get('reddit', 'hour')}/${cfg.budgets.reddit.requestsPerHour} per hour`,
      `${await get('reddit', 'day')}/${cfg.budgets.reddit.requestsPerDay} per day`,
    ];
  }
  if (cfg.threads.enabled) {
    out.threads = [
      `${await get('threads', 'hour')}/${cfg.budgets.threads.requestsPerHour} per hour`,
      `${await get('threads', 'day')}/${cfg.budgets.threads.requestsPerDay} per day`,
    ];
  }
  if (cfg.x.enabled) {
    const readsDay = await get('x_tweets', 'day');
    const readsMonth = await get('x_tweets', 'month');
    const writesDay = await get('x_writes', 'day');
    const spendDay = readsDay * X_PRICING.readPerTweet;
    const spendMonth = (await read(windowKey('x_tweets', 'month'))).costUsd
      + (await read(windowKey('x_writes', 'month'))).costUsd;
    out.x = [
      `${readsDay}/${cfg.budgets.x.tweetsPerDay} tweets read today ($${spendDay.toFixed(2)})`,
      `${readsMonth}/${cfg.budgets.x.tweetsPerMonth} this month`,
      `${writesDay}/${cfg.budgets.x.writesPerDay} replies posted today`,
      `≈ $${spendMonth.toFixed(2)} month to date`,
    ];
  }
  if (cfg.linkedin.enabled) {
    out.linkedin = [
      `${await get('linkedin', 'hour')}/${cfg.budgets.linkedin.requestsPerHour} per hour`,
      `${await get('linkedin', 'day')}/${cfg.budgets.linkedin.requestsPerDay} per day`,
    ];
  }

  const llm = await read(windowKey('llm', 'day'));
  out.llm = [
    `${llm.used}/${cfg.budgets.llm.postsPerDay} posts screened today`,
    `$${llm.costUsd.toFixed(4)}/$${cfg.budgets.llm.usdPerDay.toFixed(2)}`,
  ];

  return out;
}

export async function pruneOldWindows(): Promise<number> {
  const cutoff = new Date(Date.now() - 70 * 24 * 3600 * 1000);
  const { count } = await prisma.budget.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  if (count) log.debug({ count }, 'pruned old budget windows');
  return count;
}
