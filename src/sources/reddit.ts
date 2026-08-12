/**
 * Reddit ingest — scoped to the exact subreddits in flaww.config.ts.
 *
 * Never touches r/all and never uses sitewide search. Each subreddit is polled
 * on its own cursor via /new, so a poll only ever asks for items newer than
 * the last one it saw. After the first run, a quiet subreddit costs one
 * request that returns an empty listing.
 */
import { prisma } from '../db';
import { log } from '../logger';
import { env, requireRedditCreds } from '../env';
import * as budget from '../budget';
import type { Config } from '../config';
import type { RawPost } from './types';

const API = 'https://oauth.reddit.com';
const AUTH = 'https://www.reddit.com/api/v1/access_token';

let token: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

/**
 * Script-app password grant. Single-process, so "single flight" is just a
 * shared promise — no distributed lock needed.
 */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  if (inflight) return inflight;

  inflight = (async () => {
    const c = requireRedditCreds();
    const res = await fetch(AUTH, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': c.userAgent,
      },
      body: new URLSearchParams({
        grant_type: 'password',
        username: c.username,
        password: c.password,
      }),
    });

    if (!res.ok) {
      throw new Error(`Reddit auth failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return token.value;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

async function call(path: string, params: Record<string, string>) {
  const t = await accessToken();
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${t}`, 'User-Agent': env.REDDIT_USER_AGENT },
  });

  // Reddit publishes remaining quota on every response. Trust it over any
  // number we hardcode — their limits change without announcement.
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? NaN);
  if (!Number.isNaN(remaining) && remaining < 5) {
    log.warn({ remaining }, 'reddit quota nearly exhausted, backing off this cycle');
  }

  if (res.status === 401) {
    token = null; // force refresh next call
    throw new Error('reddit 401 — token rejected');
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 60);
    throw Object.assign(new Error('reddit 429'), { retryAfterMs: retry * 1000 });
  }
  if (!res.ok) throw new Error(`reddit ${res.status}: ${await res.text()}`);

  return res.json() as Promise<RedditListing>;
}

interface RedditListing {
  data: { children: Array<{ kind: string; data: RedditThing }> };
}
interface RedditThing {
  id: string;
  name: string; // fullname, e.g. t3_abc123
  subreddit: string;
  author: string;
  author_fullname?: string;
  title?: string;
  selftext?: string;
  body?: string;
  permalink: string;
  created_utc: number;
  score: number;
  num_comments?: number;
  over_18?: boolean;
  stickied?: boolean;
  link_title?: string;
}

function toRawPost(t: RedditThing): RawPost {
  const body = (t.selftext ?? t.body ?? '').trim();
  return {
    platform: 'reddit',
    externalId: t.name,
    url: `https://www.reddit.com${t.permalink}`,
    subreddit: t.subreddit,
    authorHandle: t.author,
    authorExternalId: t.author_fullname,
    authorKarma: t.score,
    title: t.title,
    body: body || (t.title ?? ''),
    parentContext: t.link_title,
    postedAt: new Date(t.created_utc * 1000),
    raw: t,
  };
}

/**
 * Poll a single subreddit. Returns normalised posts; the caller decides what
 * to do with them. One request per call, always.
 */
export async function pollSubreddit(cfg: Config, sub: string): Promise<RawPost[]> {
  const cursorId = `reddit:${sub}`;
  const cursor = await prisma.pollCursor.findUnique({ where: { id: cursorId } });

  if (cursor?.pausedUntil && cursor.pausedUntil > new Date()) {
    log.debug({ sub, until: cursor.pausedUntil }, 'subreddit paused after repeated failures');
    return [];
  }

  const allowed = await budget.check(cfg, 'reddit', 1);
  if (!allowed.ok) {
    log.info({ sub, blockedBy: allowed.blockedBy }, 'reddit poll skipped — budget');
    return [];
  }

  const params: Record<string, string> = {
    limit: String(cfg.reddit.fetchLimit),
    raw_json: '1',
  };
  // `before` makes this an incremental fetch: Reddit returns only items newer
  // than the cursor, so steady-state polls come back empty and nearly free.
  if (cursor?.lastSeenId) params.before = cursor.lastSeenId;

  let listing: RedditListing;
  try {
    listing = await call(`/r/${sub}/new`, params);
    await budget.consume('reddit', 1);
  } catch (err) {
    const failures = (cursor?.consecutiveFailures ?? 0) + 1;
    // Exponential pause per-subreddit: a deleted or private sub shouldn't
    // burn a request every 12 minutes forever.
    const pauseMinutes = Math.min(2 ** failures * 5, 6 * 60);
    await prisma.pollCursor.upsert({
      where: { id: cursorId },
      create: {
        id: cursorId,
        consecutiveFailures: failures,
        pausedUntil: new Date(Date.now() + pauseMinutes * 60_000),
      },
      update: {
        consecutiveFailures: failures,
        pausedUntil: new Date(Date.now() + pauseMinutes * 60_000),
      },
    });
    log.error({ sub, err: String(err), failures, pauseMinutes }, 'reddit poll failed');
    return [];
  }

  const things = listing.data.children
    .filter((c) => c.kind === 't3')
    .map((c) => c.data)
    .filter((t) => !t.stickied && !t.over_18);

  // Newest first from Reddit — the cursor is the newest item we've seen.
  const newest = things[0]?.name ?? cursor?.lastSeenId ?? null;
  await prisma.pollCursor.upsert({
    where: { id: cursorId },
    create: { id: cursorId, lastSeenId: newest, lastPolledAt: new Date() },
    update: { lastSeenId: newest, lastPolledAt: new Date(), consecutiveFailures: 0, pausedUntil: null },
  });

  log.debug({ sub, found: things.length }, 'reddit poll');
  return things.map(toRawPost);
}

/** Post a comment in reply to a thing (t3_ post or t1_ comment). */
export async function postComment(parentFullname: string, text: string) {
  const t = await accessToken();
  const res = await fetch(`${API}/api/comment`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t}`,
      'User-Agent': env.REDDIT_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ thing_id: parentFullname, text, api_type: 'json' }),
  });

  if (!res.ok) throw new Error(`reddit comment ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    json: { errors: unknown[][]; data?: { things?: Array<{ data: { id: string; permalink?: string } }> } };
  };
  if (json.json.errors?.length) {
    throw new Error(`reddit comment rejected: ${JSON.stringify(json.json.errors)}`);
  }

  const thing = json.json.data?.things?.[0]?.data;
  return {
    id: thing?.id ? `t1_${thing.id}` : null,
    url: thing?.permalink ? `https://www.reddit.com${thing.permalink}` : null,
  };
}

/** Cached subreddit rules, so flaww can refuse to post where self-promo is banned. */
export async function fetchRules(sub: string): Promise<string[]> {
  try {
    const t = await accessToken();
    const res = await fetch(`${API}/r/${sub}/about/rules`, {
      headers: { Authorization: `Bearer ${t}`, 'User-Agent': env.REDDIT_USER_AGENT },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { rules?: Array<{ short_name: string; description: string }> };
    return (json.rules ?? []).map((r) => `${r.short_name}: ${r.description}`);
  } catch {
    return [];
  }
}
