/**
 * The publisher.
 *
 * At-most-once, deliberately. A duplicate reply on a stranger's post is worse
 * than a missed one: it's the most recognisable bot behaviour there is, and it
 * can't be undone. So an ambiguous failure (timeout, socket hang, 5xx) is
 * NEVER auto-retried — it parks for you to check by hand.
 *
 * On Cloud Run this runs from an HTTP endpoint driven by Cloud Scheduler, not
 * a background timer: with scale-to-zero there is no process alive to fire a
 * setTimeout, so a reply scheduled 7 minutes out would simply never go.
 */
import { prisma } from '../db';
import { log } from '../logger';
import { env } from '../env';
import * as budget from '../budget';
import { postComment } from '../sources/reddit';
import { postReply as postTweet } from '../sources/x';
import { postReply as postThread } from '../sources/threads';
import { postReply as postLinkedInComment } from '../sources/linkedin';
import { notify } from '../telegram/card';
import type { PlatformName } from '../config';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function isAmbiguous(err: unknown): boolean {
  const m = String(err).toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('econnreset') ||
    m.includes('socket hang up') ||
    m.includes('fetch failed') ||
    /\b5\d\d\b/.test(m)
  );
}

async function dispatch(
  platform: PlatformName,
  externalId: string,
  parentUrn: string | null,
  text: string,
): Promise<{ id: string | null; url: string | null }> {
  switch (platform) {
    case 'reddit':
      return postComment(externalId, text);
    case 'x':
      return postTweet(externalId, text);
    case 'threads':
      return postThread(externalId, text);
    case 'linkedin':
      // matchedTag carries the parent post URN the comment lives under.
      if (!parentUrn) throw new Error('linkedin reply missing parent post urn');
      return postLinkedInComment(externalId, parentUrn, text);
  }
}

/** Publish everything whose scheduled time has arrived. Returns how many went out. */
export async function publishDue(): Promise<number> {
  const due = await prisma.reply.findMany({
    where: { status: 'pending', scheduledFor: { lte: new Date() } },
    include: { post: true },
    orderBy: { scheduledFor: 'asc' },
    take: 5,
  });

  let published = 0;

  for (const reply of due) {
    // Atomic claim. If another instance (or a Scheduler retry) already took
    // it, count is 0 and we stop — this is the real duplicate guard.
    const claimed = await prisma.reply.updateMany({
      where: { id: reply.id, status: 'pending' },
      data: { status: 'publishing' },
    });
    if (claimed.count === 0) continue;

    const platform = reply.post.platform as PlatformName;

    if (env.DRY_RUN) {
      log.warn({ id: reply.id, platform }, 'DRY_RUN — not publishing');
      await prisma.reply.update({
        where: { id: reply.id },
        data: { status: 'published', publishedAt: new Date(), platformUrl: 'dry-run' },
      });
      await notify(`🧪 <b>DRY_RUN</b> — would have posted to ${platform}:\n\n<blockquote>${esc(reply.text)}</blockquote>`);
      continue;
    }

    try {
      const result = await dispatch(platform, reply.post.externalId, reply.post.matchedTag, reply.text);

      await prisma.$transaction([
        prisma.reply.update({
          where: { id: reply.id },
          data: {
            status: 'published',
            publishedAt: new Date(),
            platformReplyId: result.id,
            platformUrl: result.url,
          },
        }),
        prisma.post.update({ where: { id: reply.postId }, data: { status: 'published' } }),
      ]);

      // Bill the write only once it actually landed.
      if (platform === 'x') {
        await budget.consume('x_writes', 1, reply.costUsd);
      }

      // Start the author cooldown only once the reply actually landed.
      if (platform !== 'linkedin' && reply.post.authorExternalId) {
        const id = `${platform}:${reply.post.authorExternalId}`;
        await prisma.authorCooldown.upsert({
          where: { id },
          create: { id, handle: reply.post.authorHandle, lastRepliedAt: new Date() },
          update: { lastRepliedAt: new Date() },
        });
      }

      published++;
      log.info({ id: reply.id, platform, url: result.url }, 'published');
      await notify(
        `📤 Posted to ${platform} → <a href="${esc(result.url ?? reply.post.url)}">${esc(result.url ?? 'link')}</a>` +
          (reply.costUsd > 0 ? ` <i>($${reply.costUsd.toFixed(3)})</i>` : ''),
      );
    } catch (err) {
      if (isAmbiguous(err)) {
        // We genuinely don't know whether it landed. Retrying could double-post.
        await prisma.reply.update({
          where: { id: reply.id },
          data: { status: 'reconcile', error: String(err).slice(0, 500) },
        });
        log.warn({ id: reply.id, err: String(err) }, 'ambiguous publish — parked for reconcile');
        await notify(
          `⚠️ Unclear whether this posted to ${platform} — <b>not</b> retrying automatically.\n` +
            `<a href="${esc(reply.post.url)}">Check the thread</a>.`,
        );
        continue;
      }

      await prisma.reply.update({
        where: { id: reply.id },
        data: { status: 'failed', error: String(err).slice(0, 500) },
      });
      await prisma.post.update({ where: { id: reply.postId }, data: { status: 'failed' } });
      log.error({ id: reply.id, platform, err: String(err) }, 'publish failed');
      await notify(
        `❌ ${platform} publish failed: <code>${esc(String(err).slice(0, 200))}</code>\n\n` +
          `<blockquote>${esc(reply.text.slice(0, 300))}</blockquote>`,
      );
    }
  }

  return published;
}
