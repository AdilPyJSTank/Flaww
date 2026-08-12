/**
 * Threads ingest via Meta's keyword search.
 *
 * Free, with generous limits (250 posts / 1000 replies per 24h), which makes
 * it the only listening surface besides Reddit that costs nothing per item.
 *
 * Requires the `threads_keyword_search` permission on your Meta app, plus
 * `threads_basic` and `threads_content_publish` for replying.
 *
 * Publishing is TWO steps — create a media container, then publish it. That
 * is not a quirk of this code; it is how the Threads (and Instagram) Graph
 * API works, and forgetting the second call is the classic way to end up with
 * a reply that silently never appears.
 */
import { prisma } from '../db';
import { log } from '../logger';
import { env } from '../env';
import * as budget from '../budget';
import type { Config } from '../config';
import type { RawPost } from './types';

const API = 'https://graph.threads.net/v1.0';

let token: { value: string; expiresAt: number } | null = null;

/**
 * Threads long-lived tokens last ~60 days and must be refreshed BEFORE they
 * expire. Miss the window once and there is no recovery except re-authorising
 * by hand, so this refreshes at the halfway mark rather than at the edge.
 */
async function accessToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 86_400_000) return token.value;

  const stored = await prisma.pollCursor.findUnique({ where: { id: 'threads:token' } });
  const current = stored?.lastSeenId ?? env.THREADS_ACCESS_TOKEN;
  if (!current) throw new Error('threads.enabled is true but THREADS_ACCESS_TOKEN is not set');

  const storedExpiry = stored?.lastPolledAt?.getTime() ?? 0;
  const halfway = storedExpiry - 30 * 86_400_000;

  if (storedExpiry && Date.now() < halfway) {
    token = { value: current, expiresAt: storedExpiry };
    return current;
  }

  try {
    const res = await fetch(
      `${API}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(current)}`,
    );
    if (res.ok) {
      const json = (await res.json()) as { access_token: string; expires_in: number };
      const expiresAt = Date.now() + json.expires_in * 1000;
      await prisma.pollCursor.upsert({
        where: { id: 'threads:token' },
        create: { id: 'threads:token', lastSeenId: json.access_token, lastPolledAt: new Date(expiresAt) },
        update: { lastSeenId: json.access_token, lastPolledAt: new Date(expiresAt) },
      });
      token = { value: json.access_token, expiresAt };
      log.info({ days: Math.round(json.expires_in / 86400) }, 'threads token refreshed');
      return json.access_token;
    }
    log.warn({ status: res.status }, 'threads token refresh failed — using existing token');
  } catch (err) {
    log.warn({ err: String(err) }, 'threads token refresh errored — using existing token');
  }

  token = { value: current, expiresAt: Date.now() + 7 * 86_400_000 };
  return current;
}

interface ThreadsSearchResponse {
  data?: Array<{
    id: string;
    text?: string;
    permalink?: string;
    timestamp?: string;
    username?: string;
    media_type?: string;
  }>;
}

/**
 * One request per keyword — the keyword search endpoint takes a single `q`,
 * so unlike X there is no OR-folding available. That is why the keyword list
 * and the budget are both modest.
 */
export async function pollKeywords(cfg: Config): Promise<RawPost[]> {
  const out: RawPost[] = [];
  const cutoff = Date.now() - cfg.threads.maxAgeHours * 3_600_000;

  for (const keyword of cfg.threads.keywords) {
    const allowed = await budget.check(cfg, 'threads', 1);
    if (!allowed.ok) {
      log.info({ blockedBy: allowed.blockedBy }, 'threads poll stopped — budget');
      break;
    }

    const cursorId = `threads:${keyword}`;
    const cursor = await prisma.pollCursor.findUnique({ where: { id: cursorId } });
    if (cursor?.pausedUntil && cursor.pausedUntil > new Date()) continue;

    try {
      const t = await accessToken();
      const params = new URLSearchParams({
        q: keyword,
        search_type: cfg.threads.searchType,
        fields: 'id,text,permalink,timestamp,username,media_type',
        limit: String(cfg.threads.fetchLimit),
        access_token: t,
      });

      const res = await fetch(`${API}/keyword_search?${params}`);
      if (!res.ok) throw new Error(`threads ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const json = (await res.json()) as ThreadsSearchResponse;
      await budget.consume('threads', 1);

      const items = (json.data ?? []).filter((p) => {
        if (!p.text || !p.timestamp) return false;
        if (new Date(p.timestamp).getTime() < cutoff) return false;
        // The cursor is the newest id we've already handled for this keyword.
        return !cursor?.lastSeenId || p.id > cursor.lastSeenId;
      });

      const newest = json.data?.[0]?.id ?? cursor?.lastSeenId ?? null;
      await prisma.pollCursor.upsert({
        where: { id: cursorId },
        create: { id: cursorId, lastSeenId: newest, lastPolledAt: new Date() },
        update: {
          lastSeenId: newest,
          lastPolledAt: new Date(),
          consecutiveFailures: 0,
          pausedUntil: null,
        },
      });

      for (const p of items) {
        out.push({
          platform: 'threads',
          externalId: p.id,
          url: p.permalink ?? `https://www.threads.net/@${p.username}/post/${p.id}`,
          matchedTag: keyword,
          authorHandle: p.username ?? 'unknown',
          authorExternalId: p.username,
          body: p.text!,
          postedAt: new Date(p.timestamp!),
          raw: p,
        });
      }

      log.debug({ keyword, found: items.length }, 'threads poll');
    } catch (err) {
      const failures = (cursor?.consecutiveFailures ?? 0) + 1;
      const pauseMinutes = Math.min(2 ** failures * 10, 6 * 60);
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
      log.error({ keyword, err: String(err), pauseMinutes }, 'threads poll failed');
    }
  }

  return out;
}

/** Reply to a thread. Two calls: create container, then publish it. */
export async function postReply(replyToId: string, text: string) {
  const t = await accessToken();

  const create = await fetch(`${API}/me/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'TEXT',
      text,
      reply_to_id: replyToId,
      access_token: t,
    }),
  });
  if (!create.ok) {
    throw new Error(`threads container ${create.status}: ${(await create.text()).slice(0, 300)}`);
  }
  const { id: creationId } = (await create.json()) as { id: string };

  // Meta recommends a short pause between container creation and publish;
  // without it the publish call intermittently 400s on a not-yet-ready container.
  await new Promise((r) => setTimeout(r, 1500));

  const publish = await fetch(`${API}/me/threads_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ creation_id: creationId, access_token: t }),
  });
  if (!publish.ok) {
    throw new Error(`threads publish ${publish.status}: ${(await publish.text()).slice(0, 300)}`);
  }
  const { id } = (await publish.json()) as { id: string };

  return { id, url: `https://www.threads.net/post/${id}` };
}
