import { prisma } from '../db';
import { log } from '../logger';
import { bot, ICON } from './bot';
import { env } from '../env';
import type { Config, PlatformName } from '../config';

/**
 * HTML parse_mode, not MarkdownV2. MarkdownV2 requires escaping 18 characters
 * including "." "-" and "!"; a public post body will break it constantly and
 * Telegram rejects the whole message on a single bad escape.
 */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');

function age(d: Date): string {
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function context(platform: PlatformName, post: { subreddit: string | null; matchedTag: string | null }): string {
  switch (platform) {
    case 'reddit':
      return `r/${post.subreddit}`;
    case 'x':
      return post.matchedTag ?? 'x';
    case 'threads':
      return `“${post.matchedTag ?? ''}”`;
    case 'linkedin':
      return 'comment on your post';
  }
}

/** Telegram hard-caps a message at 4096 chars. Budget deliberately. */
export async function sendCard(cfg: Config, postId: string): Promise<boolean> {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: { verdict: true } });
  if (!post || !post.verdict) return false;

  const platform = post.platform as PlatformName;

  // Don't bury me: stop pinging while too many cards sit unanswered.
  const outstanding = await prisma.card.count({
    where: { answeredAt: null, expiresAt: { gt: new Date() } },
  });
  if (outstanding >= cfg.telegram.maxOutstandingCards) {
    log.info({ outstanding }, 'card suppressed — too many unanswered');
    return false;
  }

  const since = new Date(new Date().toISOString().slice(0, 10));
  const today = await prisma.card.count({ where: { sentAt: { gte: since } } });
  if (today >= cfg.telegram.maxCardsPerDay) {
    log.info({ today }, 'card suppressed — daily ping cap');
    return false;
  }

  const conf = Math.round(post.verdict.confidence * 100);

  const text = [
    `${ICON[platform]} <b>${esc(post.authorHandle)}</b> · <i>${esc(context(platform, post))} · ${age(post.postedAt)} · ${conf}%</i>`,
    '',
    post.title ? `<b>${esc(clip(post.title, 160))}</b>` : '',
    post.parentContext ? `<i>on: ${esc(clip(post.parentContext, 200))}</i>` : '',
    `<blockquote>${esc(clip(post.body, 900))}</blockquote>`,
    '',
    `💡 <i>${esc(post.verdict.reason)}</i>`,
    '',
    `<a href="${esc(post.url)}">open →</a>`,
    '',
    `<i>Reply to this message with your text and I'll post it. /skip to drop it.</i>`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const msg = await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });

    await prisma.card.create({
      data: {
        postId: post.id,
        telegramMessageId: msg.message_id,
        expiresAt: new Date(Date.now() + cfg.telegram.cardTtlHours * 3_600_000),
      },
    });

    log.info({ postId: post.id, platform, messageId: msg.message_id }, 'card sent');
    return true;
  } catch (err) {
    log.error({ postId: post.id, err: String(err) }, 'failed to send card');
    return false;
  }
}

export async function notify(text: string): Promise<void> {
  try {
    await bot.api.sendMessage(env.TELEGRAM_CHAT_ID, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    log.error({ err: String(err) }, 'notify failed');
  }
}

/** Sweep cards that were never answered. */
export async function expireStaleCards(): Promise<number> {
  const stale = await prisma.card.findMany({
    where: { answeredAt: null, expiresAt: { lt: new Date() } },
    select: { id: true, postId: true },
  });
  if (stale.length === 0) return 0;

  await prisma.post.updateMany({
    where: { id: { in: stale.map((c) => c.postId) }, status: 'carded' },
    data: { status: 'expired' },
  });
  await prisma.card.deleteMany({ where: { id: { in: stale.map((c) => c.id) } } });

  log.debug({ count: stale.length }, 'expired stale cards');
  return stale.length;
}
