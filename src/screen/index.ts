import { prisma } from '../db';
import { log } from '../logger';
import * as budget from '../budget';
import { screen } from './llm';
import { buildSystemPrompt, buildUserPrompt } from './prompt';
import { prefilter, simhash } from './prefilter';
import type { Config } from '../config';
import type { RawPost } from '../sources/types';

/**
 * Ingest -> prefilter -> screen. Returns the ids of posts that cleared the
 * confidence bar and are ready to be carded to Telegram.
 */
export async function ingestAndScreen(cfg: Config, posts: RawPost[]): Promise<string[]> {
  const system = buildSystemPrompt(cfg);
  const ready: string[] = [];

  for (const post of posts) {
    // Idempotent insert — a post seen twice from two sources is stored once.
    const existing = await prisma.post.findUnique({
      where: { platform_externalId: { platform: post.platform, externalId: post.externalId } },
      select: { id: true },
    });
    if (existing) continue;

    const pre = await prefilter(cfg, post);

    const row = await prisma.post.create({
      data: {
        platform: post.platform,
        externalId: post.externalId,
        url: post.url,
        subreddit: post.subreddit ?? null,
        matchedTag: post.matchedTag ?? null,
        authorHandle: post.authorHandle,
        authorExternalId: post.authorExternalId ?? null,
        authorKarma: post.authorKarma ?? null,
        authorFollowers: post.authorFollowers ?? null,
        title: post.title ?? null,
        body: post.body,
        parentContext: post.parentContext ?? null,
        postedAt: post.postedAt,
        dedupeHash: simhash(`${post.title ?? ''} ${post.body}`.toLowerCase()),
        matchedKeywords: JSON.stringify(pre.matchedKeywords),
        status: pre.pass ? 'screening' : 'prefiltered_out',
        raw: JSON.stringify(post.raw).slice(0, 40_000),
      },
    });

    if (!pre.pass) {
      log.debug({ id: row.id, reason: pre.reason }, 'prefiltered out');
      continue;
    }

    // Budget is checked per post, not per batch — a single noisy poll cannot
    // blow through the daily ceiling.
    const allowed = await budget.check(cfg, 'llm', 1);
    if (!allowed.ok) {
      log.warn({ blockedBy: allowed.blockedBy }, 'screening halted — budget exhausted');
      await prisma.post.update({ where: { id: row.id }, data: { status: 'ingested' } });
      break; // leave the rest as 'ingested'; they get picked up tomorrow
    }

    try {
      const v = await screen(cfg, system, buildUserPrompt(post));
      await budget.consume('llm', 1, v.costUsd);

      await prisma.verdict.create({
        data: {
          postId: row.id,
          isRelevant: v.is_relevant,
          confidence: v.confidence,
          reason: v.reason,
          model: cfg.screening.model,
          promptVersion: cfg.screening.promptVersion,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
          costUsd: v.costUsd,
          latencyMs: v.latencyMs,
        },
      });

      const passes = v.is_relevant && v.confidence >= cfg.screening.minConfidence;
      await prisma.post.update({
        where: { id: row.id },
        data: { status: passes ? 'carded' : 'rejected' },
      });

      if (passes) ready.push(row.id);
      log.info(
        { id: row.id, relevant: v.is_relevant, conf: v.confidence.toFixed(2), passes },
        'screened',
      );
    } catch (err) {
      log.error({ id: row.id, err: String(err) }, 'screening failed');
      await prisma.post.update({ where: { id: row.id }, data: { status: 'ingested' } });
    }
  }

  return ready;
}

/** Re-screen anything left in 'ingested' because a budget window closed. */
export async function drainBacklog(cfg: Config, limit = 20): Promise<string[]> {
  const rows = await prisma.post.findMany({
    where: { status: 'ingested', postedAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
    orderBy: { postedAt: 'desc' },
    take: limit,
  });
  if (rows.length === 0) return [];

  log.info({ count: rows.length }, 'draining screening backlog');

  const asRaw: RawPost[] = rows.map((r) => ({
    platform: r.platform as 'reddit' | 'x',
    externalId: r.externalId,
    url: r.url,
    subreddit: r.subreddit ?? undefined,
    matchedTag: r.matchedTag ?? undefined,
    authorHandle: r.authorHandle,
    authorExternalId: r.authorExternalId ?? undefined,
    authorKarma: r.authorKarma ?? undefined,
    authorFollowers: r.authorFollowers ?? undefined,
    title: r.title ?? undefined,
    body: r.body,
    parentContext: r.parentContext ?? undefined,
    postedAt: r.postedAt,
    raw: {},
  }));

  // Delete-then-reingest keeps one code path for screening.
  await prisma.post.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  return ingestAndScreen(cfg, asRaw);
}
