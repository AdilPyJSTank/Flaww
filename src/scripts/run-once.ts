/**
 * Run one cycle by hand, without Cloud Scheduler.
 *
 *   npm run poll      # one poll + screen + card cycle
 *   npm run publish   # publish anything due
 *
 * Useful locally, and useful in production to force a cycle without waiting
 * for the next tick.
 */
import { loadConfig } from '../config';
import { prisma } from '../db';
import { runPollCycle, runPublishCycle, runHousekeeping } from '../cycle';

async function main() {
  const which = process.argv[2] ?? 'poll';
  const cfg = await loadConfig();

  const result =
    which === 'publish'
      ? await runPublishCycle()
      : which === 'housekeeping'
        ? await runHousekeeping()
        : await runPollCycle(cfg);

  console.log(JSON.stringify(result, null, 2));
  await prisma.$disconnect();
}

void main();
