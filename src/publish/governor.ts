/**
 * Decides IF and WHEN a reply publishes. Never WHAT — your text is never
 * edited, truncated, or rewritten. If it can't go out as written, it doesn't
 * go out and you're told why.
 *
 * This is what stops a human-approved loop from *looking* automated. Posting
 * eight replies in four minutes at 03:00 reads exactly like a bot to every
 * platform's spam classifier, no matter how good the writing is.
 */
import { prisma } from '../db';
import { fetchRules } from '../sources/reddit';
import { X_PRICING } from '../budget';
import * as budget from '../budget';
import type { Config, PlatformName } from '../config';
import type { Post } from '@prisma/client';

export interface Decision {
  allowed: boolean;
  delayMs: number;
  blockedBy?: string;
  detail?: string;
  /** Shown to you on the confirmation — cost warnings, hold-until notes. */
  note?: string;
  /** Estimated marginal cost of publishing this reply. */
  costUsd: number;
}

const CHAR_LIMIT: Record<PlatformName, number> = {
  reddit: 10_000,
  x: 280,
  threads: 500,
  linkedin: 1_250,
};

const LINK_RE = /https?:\/\/\S+/i;

export function describeBlock(d: Decision): string {
  return d.detail ? `${d.blockedBy}\n\n${d.detail}` : (d.blockedBy ?? 'blocked');
}

function block(blockedBy: string, detail?: string): Decision {
  return { allowed: false, delayMs: 0, blockedBy, detail, costUsd: 0 };
}

/** Trigram Jaccard — cheap, no embedding call, good enough for "did I already say this". */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
    const out = new Set<string>();
    for (let i = 0; i < Math.max(1, t.length - 2); i++) out.add(t.slice(i, i + 3));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** What this reply will cost to publish. Only X charges. */
export function replyCost(platform: PlatformName, text: string): number {
  if (platform !== 'x') return 0;
  return LINK_RE.test(text) ? X_PRICING.writeWithLink : X_PRICING.writePlain;
}

function localHour(tz: string, at = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(at),
  );
}

/** Push a delay forward until it lands inside the configured active window. */
function shiftIntoActiveHours(delayMs: number, cfg: Config): { delayMs: number; note?: string } {
  const { start, end } = cfg.safety.activeHours;
  const target = new Date(Date.now() + delayMs);
  if (localHour(cfg.safety.timezone, target) >= start && localHour(cfg.safety.timezone, target) < end) {
    return { delayMs };
  }

  let extra = 0;
  for (let i = 1; i <= 24; i++) {
    const h = localHour(cfg.safety.timezone, new Date(target.getTime() + i * 3_600_000));
    if (h >= start && h < end) {
      extra = i * 3_600_000;
      break;
    }
  }
  return {
    delayMs: delayMs + extra,
    note: `Outside your ${start}:00–${end}:00 window — held until it opens.`,
  };
}

export async function evaluate(cfg: Config, post: Post, text: string): Promise<Decision> {
  const platform = post.platform as PlatformName;
  const dayStart = new Date(new Date().toISOString().slice(0, 10));
  const notes: string[] = [];

  // 0. Source turned off since the card was sent.
  if (!cfg[platform].enabled) {
    return block(
      `${platform} is disabled in flaww.config.ts.`,
      'Re-enable it and restart, or /skip this card.',
    );
  }

  // 1. Hard character limit. Refuse rather than truncate — a reply cut off
  //    mid-sentence is worse than no reply.
  const len = [...new Intl.Segmenter().segment(text)].length;
  if (len > CHAR_LIMIT[platform]) {
    return block(
      `Too long for ${platform}: ${len}/${CHAR_LIMIT[platform]} characters.`,
      'Send a shorter version — I will not trim it for you.',
    );
  }

  // 2. X write budget and link surcharge. A reply containing a link is billed
  //    at ~13x a plain one, which is worth knowing BEFORE you spend it.
  const costUsd = replyCost(platform, text);
  if (platform === 'x') {
    const writeOk = await budget.check(cfg, 'x_writes', 1);
    if (!writeOk.ok) {
      return block(`X write budget reached (${writeOk.blockedBy}).`, 'Resets at midnight UTC.');
    }
    if (cfg.x.warnOnLinkCost && LINK_RE.test(text)) {
      notes.push(
        `⚠️ Contains a link — billed at $${X_PRICING.writeWithLink.toFixed(2)} instead of ` +
          `$${X_PRICING.writePlain.toFixed(3)}. /undo if that wasn't intentional.`,
      );
    } else {
      notes.push(`Costs $${costUsd.toFixed(3)}.`);
    }
  }

  // 3. Daily cap.
  const todayCount = await prisma.reply.count({
    where: {
      status: { in: ['published', 'pending', 'publishing'] },
      createdAt: { gte: dayStart },
      post: { platform },
    },
  });
  const cap = cfg.safety.maxRepliesPerDay[platform];
  if (todayCount >= cap) {
    return block(`Daily cap reached for ${platform} (${todayCount}/${cap}).`, 'Resets at midnight UTC.');
  }

  // 4. Subreddit concentration — repeatedly replying in one community reads
  //    as brigading even when every individual reply is good.
  if (platform === 'reddit' && post.subreddit) {
    const inSub = await prisma.reply.count({
      where: {
        status: { in: ['published', 'pending', 'publishing'] },
        createdAt: { gte: dayStart },
        post: { subreddit: post.subreddit },
      },
    });
    if (inSub >= cfg.safety.maxPerSubredditPerDay) {
      return block(
        `Already ${inSub} replies in r/${post.subreddit} today.`,
        'Concentration in one sub is what gets accounts flagged.',
      );
    }

    const rules = await cachedRules(post.subreddit);
    const bansPromo = rules.some((r) => /self.?promo|advertis|solicit/i.test(r));
    if (bansPromo && new RegExp(`\\b${escapeRe(cfg.persona.company)}\\b`, 'i').test(text)) {
      return block(
        `r/${post.subreddit} prohibits self-promotion and your reply names ${cfg.persona.company}.`,
        'Send a version that just helps, without the product mention.',
      );
    }
  }

  // 5. Author cooldown. Skipped on LinkedIn — someone commenting on your own
  //    post is inviting a response, so a cooldown there is just rude.
  if (platform !== 'linkedin' && post.authorExternalId) {
    const cd = await prisma.authorCooldown.findUnique({
      where: { id: `${platform}:${post.authorExternalId}` },
    });
    if (cd) {
      const days = (Date.now() - cd.lastRepliedAt.getTime()) / 86_400_000;
      if (days < cfg.safety.authorCooldownDays) {
        return block(
          `You replied to @${post.authorHandle} ${days.toFixed(1)} days ago.`,
          `Cooldown is ${cfg.safety.authorCooldownDays} days.`,
        );
      }
    }
  }

  // 6. Repetition — the single strongest automated-spam signal there is.
  const recent = await prisma.reply.findMany({
    where: { status: 'published' },
    orderBy: { publishedAt: 'desc' },
    take: cfg.safety.similarityWindow,
    select: { text: true },
  });
  let peak = 0;
  for (const r of recent) peak = Math.max(peak, similarity(text, r.text));
  if (peak > cfg.safety.maxSimilarityToRecent) {
    return block(
      `Too similar (${peak.toFixed(2)}) to a reply you already posted.`,
      'Reusing near-identical text across threads is what spam filters look for.',
    );
  }

  // 7. Spacing since the last reply on this platform.
  const last = await prisma.reply.findFirst({
    where: { status: { in: ['published', 'pending', 'publishing'] }, post: { platform } },
    orderBy: { createdAt: 'desc' },
    select: { publishedAt: true, scheduledFor: true },
  });
  const lastAt = last?.publishedAt ?? last?.scheduledFor ?? null;
  const gapMs = cfg.safety.minGapMinutes[platform] * 60_000;
  let delayMs = lastAt ? Math.max(0, lastAt.getTime() + gapMs - Date.now()) : 0;

  // 8. Human jitter. Never a round number, never the same offset twice.
  const { min, max } = cfg.safety.publishDelaySeconds;
  delayMs += (min + Math.random() * (max - min)) * 1000;

  // 9. Active hours.
  const shifted = shiftIntoActiveHours(delayMs, cfg);
  if (shifted.note) notes.push(shifted.note);

  return {
    allowed: true,
    delayMs: Math.round(shifted.delayMs),
    costUsd,
    note: notes.join('\n') || undefined,
  };
}

const ruleCache = new Map<string, { rules: string[]; at: number }>();
async function cachedRules(sub: string): Promise<string[]> {
  const hit = ruleCache.get(sub);
  if (hit && Date.now() - hit.at < 24 * 3_600_000) return hit.rules;
  const rules = await fetchRules(sub);
  ruleCache.set(sub, { rules, at: Date.now() });
  return rules;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
