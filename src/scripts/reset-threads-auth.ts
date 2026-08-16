/**
 * Run this once, right after putting a freshly-authorized THREADS_ACCESS_TOKEN
 * in .env.
 *
 * accessToken() in src/sources/threads.ts prefers the token stored in the
 * PollCursor table over the env var — that's what makes 60-day auto-refresh
 * work — but it means dropping a new token into .env does nothing on its own.
 * This deletes the stored token so the new env value actually gets picked up,
 * and clears the per-keyword pause/failure state so polling doesn't keep
 * skipping keywords that backed off during the old token's failures.
 */
import { prisma } from '../db';

async function main() {
  const deletedToken = await prisma.pollCursor.deleteMany({ where: { id: 'threads:token' } });

  const resetKeywords = await prisma.pollCursor.updateMany({
    where: { id: { startsWith: 'threads:' }, NOT: { id: 'threads:token' } },
    data: { pausedUntil: null, consecutiveFailures: 0 },
  });

  console.log(`cleared stored token: ${deletedToken.count ? 'yes' : 'was already empty'}`);
  console.log(`reset ${resetKeywords.count} keyword cursor(s) — pausedUntil/consecutiveFailures cleared`);
  console.log('\nnext: npm run doctor  (or re-run the direct API check) to confirm a 200');

  await prisma.$disconnect();
}

void main();
