/**
 * One poll cycle and one publish cycle, each invocable on demand.
 *
 * On Cloud Run these are called by Cloud Scheduler over HTTP rather than run
 * from an in-process timer. That's not just an accommodation — it's better:
 * the cadence lives outside the container, so a crash loop can't turn into a
 * poll storm, and you can see and change the schedule without a redeploy.
 *
 * Both take a distributed lock. Cloud Scheduler retries on timeout, and a
 * revision rollover briefly runs two instances; without the lock those
 * overlap and every source gets read twice (which on X means billed twice).
 */
import { prisma } from './db';
import { log } from './logger';
import { withLock } from './lock';
import * as budget from './budget';
import { pollSubreddit } from './sources/reddit';
import { pollKeywords as pollThreads } from './sources/threads';
import { pollTags as pollX } from './sources/x';
import { pollOwnPostComments as pollLinkedIn } from './sources/linkedin';
import { ingestAndScreen, drainBacklog } from './screen';
import { sendCard, expireStaleCards } from './telegram/card';
import { publishDue } from './publish';
import { isPaused } from './state';
import type { Config } from './config';
import type { RawPost } from './sources/types';

export interface CycleResult {
  polled: Record<string, number>;
  screened: number;
  carded: number;
  skipped?: string;
}

async function dueForPoll(id: string, intervalMinutes: number): Promise<boolean> {
  const cursor = await prisma.pollCursor.findUnique({ where: { id } });
  if (!cursor?.lastPolledAt) return true;
  if (cursor.pausedUntil && cursor.pausedUntil > new Date()) return false;
  return Date.now() - cursor.lastPolledAt.getTime() >= intervalMinutes * 60_000;
}

export async function runPollCycle(cfg: Config): Promise<CycleResult> {
  const result: CycleResult = { polled: {}, screened: 0, carded: 0 };

  if (await isPaused()) {
    result.skipped = 'paused';
    return result;
  }

  const ran = await withLock('cycle:poll', 300, async () => {
    const harvested: RawPost[] = [];

    // ── Reddit: per-subreddit cursors, each on its own interval ──────────
    //
    // Because Cloud Scheduler fires the whole cycle at a fixed cadence, the
    // per-subreddit `lastPolledAt` check is what actually staggers them:
    // each sub only polls once its own interval has elapsed, so five subs on
    // a 12-minute interval spread across the ticks instead of bursting.
    if (cfg.reddit.enabled) {
      let n = 0;
      for (const sub of cfg.reddit.subreddits) {
        if (!(await dueForPoll(`reddit:${sub}`, cfg.reddit.pollMinutes))) continue;
        const posts = await pollSubreddit(cfg, sub);
        harvested.push(...posts);
        n += posts.length;
      }
      result.polled.reddit = n;
    }

    // ── Threads: one request per keyword ─────────────────────────────────
    if (cfg.threads.enabled && (await dueForPoll('threads:cycle', cfg.threads.pollMinutes))) {
      const posts = await pollThreads(cfg);
      harvested.push(...posts);
      result.polled.threads = posts.length;
      await prisma.pollCursor.upsert({
        where: { id: 'threads:cycle' },
        create: { id: 'threads:cycle', lastPolledAt: new Date() },
        update: { lastPolledAt: new Date() },
      });
    }

    // ── X: one OR-query for all tags, on the slowest interval ────────────
    if (cfg.x.enabled && (await dueForPoll('x:tags', cfg.x.pollMinutes))) {
      const posts = await pollX(cfg);
      harvested.push(...posts);
      result.polled.x = posts.length;
    }

    // ── LinkedIn: comments on your own posts ─────────────────────────────
    if (cfg.linkedin.enabled && (await dueForPoll('linkedin:cycle', cfg.linkedin.pollMinutes))) {
      const posts = await pollLinkedIn(cfg);
      harvested.push(...posts);
      result.polled.linkedin = posts.length;
      await prisma.pollCursor.upsert({
        where: { id: 'linkedin:cycle' },
        create: { id: 'linkedin:cycle', lastPolledAt: new Date() },
        update: { lastPolledAt: new Date() },
      });
    }

    // ── Screen ───────────────────────────────────────────────────────────
    const ready =
      harvested.length > 0
        ? await ingestAndScreen(cfg, harvested)
        : await drainBacklog(cfg, 10); // idle tick: clear anything a closed budget window left

    result.screened = harvested.length;

    // ── Card ─────────────────────────────────────────────────────────────
    for (const postId of ready) {
      if (await sendCard(cfg, postId)) result.carded++;
    }

    return result;
  });

  if (ran === null) {
    result.skipped = 'another instance holds the poll lock';
  }
  return result;
}

export async function runPublishCycle(): Promise<{ published: number; expired: number; skipped?: string }> {
  const ran = await withLock('cycle:publish', 120, async () => {
    const published = await publishDue();
    const expired = await expireStaleCards();
    return { published, expired };
  });

  return ran ?? { published: 0, expired: 0, skipped: 'another instance holds the publish lock' };
}

export async function runHousekeeping(): Promise<{ prunedBudgets: number; purgedRaw: number }> {
  const prunedBudgets = await budget.pruneOldWindows();

  // Raw payloads are only useful for debugging a recent ingest; keeping them
  // longer is storage cost and, on some platforms, a ToS problem.
  const { count: purgedRaw } = await prisma.post.updateMany({
    where: { ingestedAt: { lt: new Date(Date.now() - 30 * 86_400_000) }, raw: { not: '' } },
    data: { raw: '' },
  });

  await prisma.lock.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 3_600_000) } } });

  log.info({ prunedBudgets, purgedRaw }, 'housekeeping');
  return { prunedBudgets, purgedRaw };
}
