/**
 * X ingest — tag-scoped only.
 *
 * Every configured tag and phrase is folded into a SINGLE OR-query per poll.
 * That is the whole reason the tag list must stay short: ten tags cost the
 * same one request as one tag, but a hundred tags won't fit in a query and
 * would force you into one request per tag.
 *
 * X read quota is the most expensive resource flaww touches, so this poller
 * is the most conservative thing in the codebase: infrequent, budget-gated on
 * hour/day/month, and cursor-based so it never re-reads a tweet it has seen.
 */
import { prisma } from '../db';
import { log } from '../logger';
import { requireXCreds } from '../env';
import * as budget from '../budget';
import type { Config } from '../config';
import type { RawPost } from './types';

const API = 'https://api.x.com/2';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

let token: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;
let currentRefreshToken: string | null = null;

/**
 * X rotates the refresh token on every use — the old one dies the moment a
 * new pair is issued. Two concurrent refreshes therefore permanently brick
 * the connection. Single process means a shared promise is sufficient, but
 * the rotated token still has to be persisted or a restart loses access.
 */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 120_000) return token.value;
  if (inflight) return inflight;

  inflight = (async () => {
    const c = requireXCreds();
    const refresh = currentRefreshToken ?? (await loadRefreshToken()) ?? c.refreshToken;

    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (c.clientSecret) {
      headers.Authorization =
        'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: c.clientId,
      }),
    });

    if (!res.ok) {
      throw new Error(
        `X token refresh failed (${res.status}). If this says invalid_grant, the refresh ` +
          `token is spent — re-run the authorize flow and update X_REFRESH_TOKEN. ${await res.text()}`,
      );
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    if (json.refresh_token) {
      currentRefreshToken = json.refresh_token;
      await saveRefreshToken(json.refresh_token);
    }
    token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return token.value;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

// The rotated refresh token is stored in the DB rather than rewritten into
// .env, so a container restart picks up the live one instead of the stale
// value that was baked into the environment.
async function loadRefreshToken(): Promise<string | null> {
  const row = await prisma.pollCursor.findUnique({ where: { id: 'x:refresh_token' } });
  return row?.lastSeenId ?? null;
}
async function saveRefreshToken(value: string): Promise<void> {
  await prisma.pollCursor.upsert({
    where: { id: 'x:refresh_token' },
    create: { id: 'x:refresh_token', lastSeenId: value },
    update: { lastSeenId: value },
  });
}

/** Build one OR-query from all configured tags + phrases. */
export function buildQuery(cfg: Config): string {
  const parts = [
    ...cfg.x.tags.map((t) => (t.startsWith('#') || t.startsWith('$') ? t : `#${t}`)),
    ...cfg.x.phrases.map((p) => `"${p}"`),
  ];
  let q = `(${parts.join(' OR ')})`;
  q += ' -is:retweet -is:reply lang:en';
  if (cfg.x.excludeRetweets) q += ' -is:quote';
  return q;
}

interface XSearchResponse {
  data?: Array<{
    id: string;
    text: string;
    author_id: string;
    created_at: string;
    entities?: { hashtags?: Array<{ tag: string }> };
  }>;
  includes?: {
    users?: Array<{ id: string; username: string; public_metrics?: { followers_count: number } }>;
  };
  meta?: { newest_id?: string; result_count: number };
}

export async function pollTags(cfg: Config): Promise<RawPost[]> {
  const cursorId = 'x:tags';
  const cursor = await prisma.pollCursor.findUnique({ where: { id: cursorId } });

  if (cursor?.pausedUntil && cursor.pausedUntil > new Date()) return [];

  // Two separate gates. The request gate is a guard against a poll storm;
  // the tweet gate is the one that controls spend, because pay-per-use bills
  // per tweet returned, not per request issued.
  const reqOk = await budget.check(cfg, 'x_reqs', 1);
  if (!reqOk.ok) {
    log.info({ blockedBy: reqOk.blockedBy }, 'x poll skipped — request budget');
    return [];
  }

  const readOk = await budget.check(cfg, 'x_tweets', 1);
  if (!readOk.ok) {
    log.info({ blockedBy: readOk.blockedBy }, 'x poll skipped — read budget');
    return [];
  }

  // Never ask for more tweets than the tightest remaining window can pay for.
  // Without this, one poll near the daily edge overshoots by up to 99 reads.
  const headroom = readOk.remaining ?? cfg.x.fetchLimit;
  const maxResults = Math.max(10, Math.min(cfg.x.fetchLimit, headroom));

  const params = new URLSearchParams({
    query: buildQuery(cfg),
    max_results: String(maxResults),
    'tweet.fields': 'created_at,author_id,entities,public_metrics',
    expansions: 'author_id',
    'user.fields': 'username,public_metrics',
  });
  // since_id makes each poll incremental — this is what keeps monthly read
  // consumption proportional to new matches rather than to poll frequency.
  if (cursor?.lastSeenId) params.set('since_id', cursor.lastSeenId);

  let json: XSearchResponse;
  try {
    const t = await accessToken();
    const res = await fetch(`${API}/tweets/search/recent?${params}`, {
      headers: { Authorization: `Bearer ${t}` },
    });

    if (res.status === 429) {
      const reset = Number(res.headers.get('x-rate-limit-reset') ?? 0) * 1000;
      const until = reset > Date.now() ? new Date(reset) : new Date(Date.now() + 15 * 60_000);
      await prisma.pollCursor.upsert({
        where: { id: cursorId },
        create: { id: cursorId, pausedUntil: until },
        update: { pausedUntil: until },
      });
      log.warn({ until }, 'x rate limited — pausing until reset');
      return [];
    }
    if (!res.ok) throw new Error(`x ${res.status}: ${await res.text()}`);

    json = (await res.json()) as XSearchResponse;

    // Bill what actually came back. A poll that returns nothing costs one
    // request and zero reads, which is the normal steady state.
    const returned = json.meta?.result_count ?? json.data?.length ?? 0;
    await budget.consume('x_reqs', 1);
    if (returned > 0) {
      await budget.consume('x_tweets', returned, returned * budget.X_PRICING.readPerTweet);
    }
  } catch (err) {
    const failures = (cursor?.consecutiveFailures ?? 0) + 1;
    const pauseMinutes = Math.min(2 ** failures * 15, 12 * 60);
    await prisma.pollCursor.upsert({
      where: { id: cursorId },
      create: { id: cursorId, consecutiveFailures: failures, pausedUntil: new Date(Date.now() + pauseMinutes * 60_000) },
      update: { consecutiveFailures: failures, pausedUntil: new Date(Date.now() + pauseMinutes * 60_000) },
    });
    log.error({ err: String(err), failures, pauseMinutes }, 'x poll failed');
    return [];
  }

  const users = new Map(
    (json.includes?.users ?? []).map((u) => [u.id, u] as const),
  );

  if (json.meta?.newest_id) {
    await prisma.pollCursor.upsert({
      where: { id: cursorId },
      create: { id: cursorId, lastSeenId: json.meta.newest_id, lastPolledAt: new Date() },
      update: {
        lastSeenId: json.meta.newest_id,
        lastPolledAt: new Date(),
        consecutiveFailures: 0,
        pausedUntil: null,
      },
    });
  } else {
    await prisma.pollCursor.upsert({
      where: { id: cursorId },
      create: { id: cursorId, lastPolledAt: new Date() },
      update: { lastPolledAt: new Date(), consecutiveFailures: 0 },
    });
  }

  const tracked = new Set(cfg.x.tags.map((t) => t.replace(/^#/, '').toLowerCase()));

  const posts = (json.data ?? []).map((tw): RawPost => {
    const user = users.get(tw.author_id);
    const hit = tw.entities?.hashtags?.find((h) => tracked.has(h.tag.toLowerCase()));
    return {
      platform: 'x',
      externalId: tw.id,
      url: `https://x.com/${user?.username ?? 'i'}/status/${tw.id}`,
      matchedTag: hit ? `#${hit.tag}` : 'phrase',
      authorHandle: user?.username ?? tw.author_id,
      authorExternalId: tw.author_id,
      authorFollowers: user?.public_metrics?.followers_count,
      body: tw.text,
      postedAt: new Date(tw.created_at),
      raw: tw,
    };
  });

  log.debug({ found: posts.length }, 'x poll');
  return posts;
}

/** Reply to a specific tweet. */
export async function postReply(inReplyToId: string, text: string) {
  const t = await accessToken();
  const res = await fetch(`${API}/tweets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToId } }),
  });

  if (!res.ok) throw new Error(`x reply ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { id: string } };
  return { id: json.data.id, url: `https://x.com/i/status/${json.data.id}` };
}
