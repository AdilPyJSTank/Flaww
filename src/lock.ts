/**
 * Cross-instance mutex, backed by a single atomic Postgres upsert.
 *
 * Needed because Cloud Run is not a single process. Two things routinely
 * cause overlap:
 *   - a revision rollover briefly runs old and new instances together
 *   - Cloud Scheduler retries a job whose HTTP call timed out, while the
 *     original invocation is still working
 *
 * Without this, two poll cycles run concurrently and every source gets read
 * twice — which on X means being billed twice.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from './db';
import { log } from './logger';

const holder = randomUUID();

/**
 * Take `name` for at most `ttlSeconds`. Returns false if someone else holds
 * it and their lease hasn't expired.
 *
 * The WHERE clause on the DO UPDATE is what makes this atomic: Postgres
 * evaluates it against the existing row, so only one caller can win.
 */
export async function acquire(name: string, ttlSeconds: number): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "Lock" ("id", "holder", "expiresAt")
    VALUES (${name}, ${holder}, ${expiresAt})
    ON CONFLICT ("id") DO UPDATE
      SET "holder" = ${holder}, "expiresAt" = ${expiresAt}
      WHERE "Lock"."expiresAt" < NOW()
    RETURNING "id"
  `;
  return rows.length > 0;
}

export async function release(name: string): Promise<void> {
  // Only release a lock we still hold — a lease that already expired may have
  // been taken by someone else, and deleting it would evict them.
  await prisma.$executeRaw`
    DELETE FROM "Lock" WHERE "id" = ${name} AND "holder" = ${holder}
  `;
}

/** Run `fn` under `name`, or skip entirely if someone else holds it. */
export async function withLock<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!(await acquire(name, ttlSeconds))) {
    log.debug({ lock: name }, 'lock held elsewhere — skipping');
    return null;
  }
  try {
    return await fn();
  } finally {
    await release(name).catch((err) => log.warn({ err: String(err) }, 'lock release failed'));
  }
}
