/**
 * Small key/value state that both the Telegram handlers and the poll cycle
 * need. Lives here rather than in cycle.ts so bot.ts doesn't have to import
 * cycle.ts (which imports the card sender, which imports bot.ts) — that loop
 * resolves at runtime under ESM, but only by accident of every use being
 * deferred. Not worth relying on.
 */
import { prisma } from './db';

export async function isPaused(): Promise<boolean> {
  const row = await prisma.pollCursor.findUnique({ where: { id: 'flaww:paused' } });
  return row?.lastSeenId === '1';
}

export async function setPaused(v: boolean): Promise<void> {
  await prisma.pollCursor.upsert({
    where: { id: 'flaww:paused' },
    create: { id: 'flaww:paused', lastSeenId: v ? '1' : '0' },
    update: { lastSeenId: v ? '1' : '0' },
  });
}
