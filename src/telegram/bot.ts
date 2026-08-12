/**
 * The Telegram side of the loop.
 *
 * No inline buttons anywhere. The interaction is: a card arrives, you reply to
 * it with what you want to say, and that text goes out verbatim. Writing the
 * reply *is* the approval — there is no second confirmation step.
 *
 * Webhook mode, not long polling: Cloud Run scales to zero, so there is no
 * process sitting around to hold a long poll open. Every update arrives as an
 * HTTP request that wakes the container.
 */
import { Bot } from 'grammy';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db';
import { log } from '../logger';
import { env } from '../env';
import * as budgetMod from '../budget';
import { evaluate, describeBlock } from '../publish/governor';
import { isPaused, setPaused } from '../state';
import type { Config, PlatformName } from '../config';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const ICON: Record<PlatformName, string> = {
  reddit: '🟠',
  x: '𝕏',
  threads: '@',
  linkedin: '💼',
};

export function registerHandlers(cfg: Config) {
  // Ignore every chat that isn't mine. The bot token and webhook secret are
  // the only credentials in play, so this is the access control.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.id !== env.TELEGRAM_CHAT_ID) return;
    await next();
  });

  bot.command('start', (ctx) =>
    ctx.reply(
      [
        '<b>flaww</b> is running.',
        '',
        'Cards arrive here as posts clear screening. Reply to a card with your text and it goes out verbatim.',
        '',
        '<code>/status</code>  budgets, queue, last poll per source',
        '<code>/stats</code>   corpus size and screening accuracy',
        '<code>/undo</code>    cancel the most recent pending reply',
        '<code>/skip</code>    (as a reply to a card) drop it',
        '<code>/pause</code> · <code>/resume</code>  halt or restart polling',
      ].join('\n'),
      { parse_mode: 'HTML' },
    ),
  );

  bot.command('skip', async (ctx) => {
    const card = await cardFromReply(ctx.message?.reply_to_message?.message_id);
    if (!card) return ctx.reply('Reply to a card with /skip.');

    await prisma.card.update({ where: { id: card.id }, data: { answeredAt: new Date() } });
    await prisma.post.update({ where: { id: card.postId }, data: { status: 'expired' } });
    await ctx.reply('Skipped.');
  });

  bot.command('undo', async (ctx) => {
    const pending = await prisma.reply.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (!pending) return ctx.reply('Nothing pending.');

    // Conditional update: if the publish cycle already claimed it, this is a
    // no-op and we say so rather than lying about having cancelled it.
    const cancelled = await prisma.reply.updateMany({
      where: { id: pending.id, status: 'pending' },
      data: { status: 'cancelled' },
    });
    if (cancelled.count === 0) return ctx.reply('Too late — it already went out.');

    await prisma.post.update({ where: { id: pending.postId }, data: { status: 'carded' } });
    await ctx.reply(
      `Cancelled — nothing was posted.\n\n<blockquote>${esc(pending.text.slice(0, 300))}</blockquote>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('status', async (ctx) => {
    const snap = await budgetMod.snapshot(cfg);
    const [pending, outstanding, todayPosted] = await Promise.all([
      prisma.reply.count({ where: { status: 'pending' } }),
      prisma.card.count({ where: { answeredAt: null, expiresAt: { gt: new Date() } } }),
      prisma.reply.count({
        where: {
          status: 'published',
          publishedAt: { gte: new Date(new Date().toISOString().slice(0, 10)) },
        },
      }),
    ]);

    const cursors = await prisma.pollCursor.findMany({
      where: { lastPolledAt: { not: null } },
      select: { id: true, lastPolledAt: true, pausedUntil: true },
      orderBy: { id: 'asc' },
    });

    const lines = [
      `<b>queue</b>  ${outstanding} cards waiting · ${pending} pending · ${todayPosted} posted today`,
      '',
    ];

    for (const [source, rows] of Object.entries(snap)) {
      lines.push(`<b>${source}</b>`);
      for (const r of rows) lines.push(`  ${esc(r)}`);
    }

    lines.push('', '<b>last poll</b>');
    for (const c of cursors) {
      if (c.id.includes('token') || c.id.includes('paused')) continue;
      const mins = Math.round((Date.now() - (c.lastPolledAt?.getTime() ?? 0)) / 60_000);
      const paused = c.pausedUntil && c.pausedUntil > new Date() ? ' ⏸' : '';
      lines.push(`  ${esc(c.id)} — ${mins}m ago${paused}`);
    }

    if (await isPaused()) lines.push('', '⏸️ <b>Polling is paused</b> — /resume');
    if (env.DRY_RUN) lines.push('', '⚠️ <b>DRY_RUN</b> — nothing is actually being posted');

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('stats', async (ctx) => {
    const [corpus, carded, replied, rejected] = await Promise.all([
      prisma.reply.count({ where: { status: 'published' } }),
      prisma.post.count({ where: { status: { in: ['carded', 'expired', 'replied', 'published'] } } }),
      prisma.reply.count(),
      prisma.post.count({ where: { status: 'rejected' } }),
    ]);

    const replyRate = carded > 0 ? Math.round((replied / carded) * 100) : 0;
    const sample = await prisma.reply.findMany({ select: { text: true }, take: 500 });
    const meanChars = sample.length
      ? Math.round(sample.reduce((a, r) => a + r.text.length, 0) / sample.length)
      : 0;

    const byPlatform = await prisma.post.groupBy({
      by: ['platform'],
      where: { status: 'published' },
      _count: true,
    });

    await ctx.reply(
      [
        `<b>style corpus</b>  ${corpus} published replies`,
        `mean length  ${meanChars} chars`,
        byPlatform.length
          ? `by platform  ${byPlatform.map((p) => `${ICON[p.platform as PlatformName] ?? ''}${p._count}`).join('  ')}`
          : '',
        '',
        `cards sent   ${carded}`,
        `answered     ${replied} (${replyRate}%)`,
        `screened out ${rejected}`,
        '',
        replyRate < 25 && carded > 20
          ? '⚠️ Below 25% — the screener is surfacing noise. Raise <code>screening.minConfidence</code> or tighten <code>persona.negativeTerms</code>.'
          : replyRate > 70 && carded > 20
            ? '💡 Above 70% — you could lower <code>minConfidence</code> and see more.'
            : '',
        corpus >= 150
          ? `\n🎯 ${corpus} examples — enough to start drafting in your voice. See "Phase 2" in the README.`
          : `\n${150 - corpus} more replies until there's enough to learn your voice from.`,
      ]
        .filter(Boolean)
        .join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('pause', async (ctx) => {
    await setPaused(true);
    await ctx.reply('Polling paused. Publishing still runs for anything already queued. /resume when ready.');
  });
  bot.command('resume', async (ctx) => {
    await setPaused(false);
    await ctx.reply('Polling resumed.');
  });

  // ── The main path: a plain text reply to a card ────────────────────────
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return;

    const card = await cardFromReply(ctx.message.reply_to_message?.message_id);
    if (!card) {
      return ctx.reply('Reply directly to a card so I know which post this is for.');
    }
    if (card.answeredAt) return ctx.reply('That card is already handled.');

    const text = ctx.message.text.trim();
    if (!text) return;

    const post = await prisma.post.findUnique({ where: { id: card.postId } });
    if (!post) return ctx.reply('That post is gone from the database.');

    // Governor decides IF and WHEN. It never touches WHAT — your words go out
    // exactly as typed or not at all.
    const decision = await evaluate(cfg, post, text);
    if (!decision.allowed) {
      return ctx.reply(`🛑 <b>Not posted.</b>\n\n${esc(describeBlock(decision))}`, {
        parse_mode: 'HTML',
      });
    }

    const scheduledFor = new Date(Date.now() + decision.delayMs);

    await prisma.$transaction([
      prisma.reply.create({
        data: {
          postId: post.id,
          text, // verbatim. this row is the corpus.
          source: 'manual',
          status: 'pending',
          scheduledFor,
          costUsd: decision.costUsd,
          idempotencyKey: `${post.platform}:${post.externalId}:${randomUUID().slice(0, 8)}`,
        },
      }),
      prisma.card.update({ where: { id: card.id }, data: { answeredAt: new Date() } }),
      prisma.post.update({ where: { id: post.id }, data: { status: 'replied' } }),
    ]);

    const mins = Math.round(decision.delayMs / 60_000);
    await ctx.reply(
      `✅ Queued for <b>${mins < 1 ? 'under a minute' : `~${mins} min`}</b> from now.\n` +
        `<i>/undo cancels it until then.</i>` +
        (decision.note ? `\n\n${esc(decision.note)}` : ''),
      { parse_mode: 'HTML' },
    );
  });

  bot.catch((err) => log.error({ err: String(err.error) }, 'telegram handler error'));
}

async function cardFromReply(messageId?: number) {
  if (!messageId) return null;
  return prisma.card.findUnique({ where: { telegramMessageId: messageId } });
}
