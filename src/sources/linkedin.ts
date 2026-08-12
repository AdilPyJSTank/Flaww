/**
 * LinkedIn.
 *
 * Read this before enabling it, because LinkedIn is not like the other three:
 *
 *   LinkedIn has no public post-search API. There is no legitimate way to
 *   discover strangers' posts by keyword. Anything that claims otherwise is
 *   scraping, which violates the User Agreement and gets accounts restricted.
 *
 * So "listening" here means the one surface that IS available: new comments
 * on your own posts. That's genuinely useful — it's where inbound
 * conversation on your content actually happens — but it is a different job
 * from the keyword monitoring Reddit, Threads, and X do, and it will never
 * surface a stranger's post.
 *
 * Requires Community Management API approval (manual review, often weeks).
 * Ships disabled.
 */
import { prisma } from '../db';
import { log } from '../logger';
import { env } from '../env';
import * as budget from '../budget';
import type { Config } from '../config';
import type { RawPost } from './types';

const API = 'https://api.linkedin.com/rest';

// LinkedIn requires a version header on every versioned call, in YYYYMM form.
// Bump this when you renew app access — stale versions start 426-ing.
const LINKEDIN_VERSION = '202506';

function headers(): Record<string, string> {
  if (!env.LINKEDIN_ACCESS_TOKEN) {
    throw new Error('linkedin.enabled is true but LINKEDIN_ACCESS_TOKEN is not set');
  }
  return {
    Authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN}`,
    'LinkedIn-Version': LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

interface PostsResponse {
  elements?: Array<{ id: string; commentary?: string; createdAt?: number }>;
}

interface CommentsResponse {
  elements?: Array<{
    id: string;
    actor: string;
    message?: { text?: string };
    created?: { time?: number };
    object?: string;
  }>;
}

/**
 * Poll comments on your recent posts. Two request classes: one listing your
 * posts, then one per post for its comments — which is why the budget here is
 * per-hour rather than per-item and why watchRecentPosts is small.
 */
export async function pollOwnPostComments(cfg: Config): Promise<RawPost[]> {
  const out: RawPost[] = [];
  const cutoff = Date.now() - cfg.linkedin.maxAgeHours * 3_600_000;

  const allowed = await budget.check(cfg, 'linkedin', 1);
  if (!allowed.ok) {
    log.info({ blockedBy: allowed.blockedBy }, 'linkedin poll skipped — budget');
    return out;
  }

  let posts: PostsResponse;
  try {
    const params = new URLSearchParams({
      author: cfg.linkedin.authorUrn,
      q: 'author',
      count: String(cfg.linkedin.watchRecentPosts),
      sortBy: 'LAST_MODIFIED',
    });
    const res = await fetch(`${API}/posts?${params}`, { headers: headers() });
    if (!res.ok) throw new Error(`linkedin posts ${res.status}: ${(await res.text()).slice(0, 300)}`);
    posts = (await res.json()) as PostsResponse;
    await budget.consume('linkedin', 1);
  } catch (err) {
    log.error({ err: String(err) }, 'linkedin post listing failed');
    return out;
  }

  for (const post of posts.elements ?? []) {
    const cursorId = `linkedin:${post.id}`;
    const cursor = await prisma.pollCursor.findUnique({ where: { id: cursorId } });

    const ok = await budget.check(cfg, 'linkedin', 1);
    if (!ok.ok) break;

    try {
      const res = await fetch(
        `${API}/socialActions/${encodeURIComponent(post.id)}/comments?count=20`,
        { headers: headers() },
      );
      if (!res.ok) continue;

      const json = (await res.json()) as CommentsResponse;
      await budget.consume('linkedin', 1);

      const fresh = (json.elements ?? []).filter((c) => {
        const t = c.created?.time ?? 0;
        if (t < cutoff) return false;
        // Don't card your own comments back to you.
        if (c.actor === cfg.linkedin.authorUrn) return false;
        return !cursor?.lastSeenId || c.id > cursor.lastSeenId;
      });

      const newest = json.elements?.[0]?.id ?? cursor?.lastSeenId ?? null;
      await prisma.pollCursor.upsert({
        where: { id: cursorId },
        create: { id: cursorId, lastSeenId: newest, lastPolledAt: new Date() },
        update: { lastSeenId: newest, lastPolledAt: new Date() },
      });

      for (const c of fresh) {
        if (!c.message?.text) continue;
        out.push({
          platform: 'linkedin',
          externalId: c.id,
          url: `https://www.linkedin.com/feed/update/${post.id}`,
          matchedTag: post.id, // the parent post this comment belongs to
          authorHandle: c.actor.split(':').pop() ?? c.actor,
          authorExternalId: c.actor,
          body: c.message.text,
          parentContext: post.commentary?.slice(0, 600),
          postedAt: new Date(c.created?.time ?? Date.now()),
          raw: c,
        });
      }
    } catch (err) {
      log.warn({ postId: post.id, err: String(err) }, 'linkedin comment fetch failed');
    }
  }

  log.debug({ found: out.length }, 'linkedin poll');
  return out;
}

/** Reply to a comment on one of your posts. */
export async function postReply(parentCommentUrn: string, objectUrn: string, text: string) {
  const res = await fetch(
    `${API}/socialActions/${encodeURIComponent(objectUrn)}/comments`,
    {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: env.LINKEDIN_AUTHOR_URN,
        object: objectUrn,
        message: { text },
        parentComment: parentCommentUrn,
      }),
    },
  );

  if (!res.ok) throw new Error(`linkedin comment ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as { id?: string };
  return {
    id: json.id ?? null,
    url: `https://www.linkedin.com/feed/update/${objectUrn}`,
  };
}
