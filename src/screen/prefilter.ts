/**
 * Zero-cost filtering. Runs before the LLM and kills the large majority of
 * ingested posts for free.
 *
 * Every post that dies here is a screening call you didn't pay for and a
 * Telegram ping you didn't get. Tune this before you tune the prompt.
 */
import { prisma } from '../db';
import type { Config } from '../config';
import type { RawPost } from '../sources/types';

export interface PrefilterResult {
  pass: boolean;
  reason?: string;
  matchedKeywords: string[];
}

/** 64-bit SimHash over word trigrams — cheap near-duplicate detection. */
export function simhash(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ');
  const grams: string[] = [];
  for (let i = 0; i < Math.max(1, words.length - 2); i++) {
    grams.push(words.slice(i, i + 3).join(' '));
  }

  const bits = new Array<number>(64).fill(0);
  for (const g of grams) {
    // FNV-1a over 64 bits, split into two 32-bit halves to stay in JS ints.
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < g.length; i++) {
      h1 = Math.imul(h1 ^ g.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (g.charCodeAt(i) + i), 0x85ebca6b) >>> 0;
    }
    for (let b = 0; b < 32; b++) {
      bits[b] += (h1 >>> b) & 1 ? 1 : -1;
      bits[b + 32] += (h2 >>> b) & 1 ? 1 : -1;
    }
  }

  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0;
    for (let b = 0; b < 4; b++) if ((bits[nibble * 4 + b] ?? 0) > 0) v |= 1 << b;
    hex += v.toString(16);
  }
  return hex;
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export async function prefilter(cfg: Config, post: RawPost): Promise<PrefilterResult> {
  const haystack = `${post.title ?? ''} ${post.body}`.toLowerCase();

  // 1. Substance. A three-word post has nothing to reply to.
  if (haystack.trim().length < 40) {
    return { pass: false, reason: 'too short', matchedKeywords: [] };
  }

  // 2. Keyword gate. Reddit needs one applied here; X and Threads already
  //    matched server-side (a tracked tag / a search keyword), and LinkedIn
  //    comments arrive on your own posts so there is nothing to match against.
  let matched: string[] = [];
  if (post.platform === 'reddit') {
    matched = cfg.reddit.keywords.filter((k) => haystack.includes(k.toLowerCase()));
    if (matched.length === 0) {
      return { pass: false, reason: 'no keyword match', matchedKeywords: [] };
    }
  } else {
    matched = post.matchedTag ? [post.matchedTag] : [];
  }

  // 3. Negative terms — the cheapest precision you will ever buy.
  const negative = cfg.persona.negativeTerms.find((n) => haystack.includes(n.toLowerCase()));
  if (negative) {
    return { pass: false, reason: `negative term "${negative}"`, matchedKeywords: matched };
  }

  // 4. Freshness — per platform, since they move at very different speeds.
  const maxAge = cfg[post.platform].maxAgeHours;
  const ageHours = (Date.now() - post.postedAt.getTime()) / 3_600_000;
  if (ageHours > maxAge) {
    return { pass: false, reason: `stale (${ageHours.toFixed(1)}h)`, matchedKeywords: matched };
  }

  // 5. Author quality floor. Threads exposes no useful reputation signal and
  //    LinkedIn comments are on your own posts, so neither has a floor.
  if (post.platform === 'reddit' && (post.authorKarma ?? 0) < cfg.reddit.minAuthorKarma) {
    return { pass: false, reason: 'author below karma floor', matchedKeywords: matched };
  }
  if (post.platform === 'x' && (post.authorFollowers ?? 0) < cfg.x.minAuthorFollowers) {
    return { pass: false, reason: 'author below follower floor', matchedKeywords: matched };
  }
  if (post.authorHandle === '[deleted]' || post.authorHandle === 'AutoModerator') {
    return { pass: false, reason: 'bot or deleted author', matchedKeywords: matched };
  }

  // 6. Author cooldown — never pester the same person.
  if (post.authorExternalId) {
    const cd = await prisma.authorCooldown.findUnique({
      where: { id: `${post.platform}:${post.authorExternalId}` },
    });
    if (cd) {
      const days = (Date.now() - cd.lastRepliedAt.getTime()) / 86_400_000;
      if (days < cfg.safety.authorCooldownDays) {
        return {
          pass: false,
          reason: `replied to @${post.authorHandle} ${days.toFixed(1)}d ago`,
          matchedKeywords: matched,
        };
      }
    }
  }

  // 7. Near-duplicate: same question asked in three subreddits, or the same
  //    item arriving from two sources.
  const hash = simhash(haystack);
  const since = new Date(Date.now() - 48 * 3_600_000);
  const recent = await prisma.post.findMany({
    where: { ingestedAt: { gte: since } },
    select: { dedupeHash: true },
    take: 500,
    orderBy: { ingestedAt: 'desc' },
  });
  if (recent.some((r) => hamming(r.dedupeHash, hash) <= 3)) {
    return { pass: false, reason: 'near-duplicate of a recent post', matchedKeywords: matched };
  }

  return { pass: true, matchedKeywords: matched };
}
