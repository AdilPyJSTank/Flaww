/**
 * Pre-flight check. Run before the first deploy, and again any time you
 * change the model ID, enable a source, or rotate a credential.
 *
 * Every check makes at most one real API call, so it costs essentially
 * nothing and tells you which specific thing is misconfigured instead of
 * leaving you to infer it from a Cloud Run log line at 3am.
 */
import { loadConfig, enabledPlatforms } from '../config';
import { env } from '../env';
import { prisma } from '../db';
import { ping } from '../screen/llm';
import { buildQuery } from '../sources/x';
import { X_PRICING } from '../budget';

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const info = (s: string) => console.log(`  \x1b[90m·\x1b[0m ${s}`);

let failures = 0;

async function main() {
  console.log('\nflaww doctor\n');

  console.log('config');
  let cfg;
  try {
    cfg = await loadConfig();
    ok('flaww.config.ts parses and validates');
    info(`persona: ${cfg.persona.company}`);
    info(`enabled sources: ${enabledPlatforms(cfg).join(', ')}`);
  } catch (err) {
    bad(String(err));
    process.exit(1);
  }

  // ── database ────────────────────────────────────────────────────────
  console.log('\ndatabase');
  try {
    await prisma.$queryRaw`SELECT 1`;
    const posts = await prisma.post.count();
    const corpus = await prisma.reply.count({ where: { status: 'published' } });
    ok(`connected — ${posts} posts, ${corpus} replies in corpus`);
    // The lock table is what keeps two Cloud Run instances from double-polling.
    await prisma.$queryRaw`SELECT 1 FROM "Lock" LIMIT 1`;
    ok('Lock table present');
  } catch (err) {
    bad(`${err}\n     run: npm run db:push`);
    failures++;
  }

  // ── screening model ─────────────────────────────────────────────────
  console.log('\nscreening model');
  const p = await ping(cfg);
  if (p.ok) {
    ok(p.detail);
  } else {
    bad(p.detail);
    if (/model|not found|does not exist|invalid.*model/i.test(p.detail)) {
      info(`"${cfg.screening.model}" was rejected — check the exact model ID against`);
      info('your provider\'s list and update screening.model in flaww.config.ts');
    }
    if (/temperature/i.test(p.detail)) {
      info('this model rejects sampling params — set screening.temperature to null');
    }
    if (/response_format|json_schema/i.test(p.detail)) {
      info('this model may need the Responses API instead of Chat Completions —');
      info('src/screen/llm.ts is the only file that needs to change');
    }
    failures++;
  }

  // ── telegram ────────────────────────────────────────────────────────
  console.log('\ntelegram');
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username: string }; description?: string };
    if (!json.ok) {
      bad(`getMe failed: ${json.description}`);
      failures++;
    } else {
      ok(`bot @${json.result?.username}`);

      const send = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: '🩺 flaww doctor: this chat is reachable.' }),
      });
      if (send.ok) ok(`chat ${env.TELEGRAM_CHAT_ID} reachable — check your phone`);
      else {
        bad(`cannot send to chat ${env.TELEGRAM_CHAT_ID}: ${(await send.text()).slice(0, 200)}`);
        info('send /start to your bot once, then re-run doctor');
        failures++;
      }

      const hook = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
      const hj = (await hook.json()) as { result?: { url?: string; last_error_message?: string } };
      if (hj.result?.url) {
        ok(`webhook registered${hj.result.last_error_message ? '' : ' and healthy'}`);
        if (hj.result.last_error_message) warn(`last delivery error: ${hj.result.last_error_message}`);
      } else if (env.PUBLIC_URL) {
        warn('no webhook registered yet — it registers itself on boot');
      } else {
        warn('PUBLIC_URL not set; Telegram cannot reach this instance');
      }
    }
  } catch (err) {
    bad(String(err));
    failures++;
  }

  // ── reddit ──────────────────────────────────────────────────────────
  if (cfg.reddit.enabled) {
    console.log('\nreddit  (free)');
    try {
      const { pollSubreddit } = await import('../sources/reddit');
      const first = cfg.reddit.subreddits[0]!;
      const posts = await pollSubreddit(cfg, first);
      ok(`authenticated — r/${first} returned ${posts.length} posts`);
      const perHour = Math.ceil(60 / cfg.reddit.pollMinutes) * cfg.reddit.subreddits.length;
      info(`projected: ~${perHour} req/hour (budget ${cfg.budgets.reddit.requestsPerHour})`);
      if (perHour > cfg.budgets.reddit.requestsPerHour) {
        bad('poll interval exceeds the hourly budget — raise pollMinutes or the budget');
        failures++;
      }
    } catch (err) {
      bad(String(err));
      failures++;
    }
  }

  // ── threads ─────────────────────────────────────────────────────────
  if (cfg.threads.enabled) {
    console.log('\nthreads  (free)');
    try {
      const { pollKeywords } = await import('../sources/threads');
      const posts = await pollKeywords(cfg);
      ok(`authenticated — ${posts.length} posts across ${cfg.threads.keywords.length} keywords`);
      const perDay = Math.ceil((60 / cfg.threads.pollMinutes) * 24) * cfg.threads.keywords.length;
      info(`projected: ~${perDay} req/day (budget ${cfg.budgets.threads.requestsPerDay})`);
      if (perDay > cfg.budgets.threads.requestsPerDay) {
        bad('keyword count × poll rate exceeds the daily budget');
        failures++;
      }
    } catch (err) {
      bad(String(err));
      info('needs threads_basic + threads_content_publish + threads_keyword_search');
      failures++;
    }
  }

  // ── x ───────────────────────────────────────────────────────────────
  if (cfg.x.enabled) {
    console.log('\nx  (PAY PER TWEET READ)');
    info(`query: ${buildQuery(cfg)}`);
    try {
      const { pollTags } = await import('../sources/x');
      const posts = await pollTags(cfg);
      ok(`authenticated — returned ${posts.length} tweets`);

      const pollsPerDay = Math.ceil((60 / cfg.x.pollMinutes) * 24);
      const worstReadsDay = pollsPerDay * cfg.x.fetchLimit;
      const cappedReadsDay = Math.min(worstReadsDay, cfg.budgets.x.tweetsPerDay);
      const readCost = cappedReadsDay * 30 * X_PRICING.readPerTweet;
      const writeCost = cfg.budgets.x.writesPerDay * 30 * X_PRICING.writePlain;

      info(`${pollsPerDay} polls/day × ${cfg.x.fetchLimit} = up to ${worstReadsDay} reads/day`);
      info(`budget caps it at ${cfg.budgets.x.tweetsPerDay}/day`);
      warn(
        `worst case ≈ $${(readCost + writeCost).toFixed(2)}/month ` +
          `($${readCost.toFixed(2)} reads + $${writeCost.toFixed(2)} writes)`,
      );
      warn(`a reply containing a link costs $${X_PRICING.writeWithLink.toFixed(2)} instead of $${X_PRICING.writePlain.toFixed(3)}`);
    } catch (err) {
      bad(String(err));
      failures++;
    }
  } else {
    console.log('\nx  — disabled, $0');
  }

  // ── linkedin ────────────────────────────────────────────────────────
  if (cfg.linkedin.enabled) {
    console.log('\nlinkedin');
    warn('LinkedIn has no post-search API — this only sees comments on YOUR OWN posts');
    try {
      const { pollOwnPostComments } = await import('../sources/linkedin');
      const posts = await pollOwnPostComments(cfg);
      ok(`authenticated — ${posts.length} new comments`);
    } catch (err) {
      bad(String(err));
      info('needs Community Management API approval; check LinkedIn-Version in src/sources/linkedin.ts');
      failures++;
    }
  } else {
    console.log('\nlinkedin  — disabled');
  }

  // ── projected total ─────────────────────────────────────────────────
  console.log('\nprojected monthly cost');
  const llmMonthly = cfg.budgets.llm.usdPerDay * 30;
  info(`llm ceiling      $${llmMonthly.toFixed(2)}  (hard cap: ${cfg.budgets.llm.postsPerDay} posts/day)`);
  info(`reddit           $0.00`);
  info(`threads          $0.00`);
  info(`linkedin         $0.00`);
  if (cfg.x.enabled) {
    const xMonthly =
      cfg.budgets.x.tweetsPerDay * 30 * X_PRICING.readPerTweet +
      cfg.budgets.x.writesPerDay * 30 * X_PRICING.writePlain;
    info(`x ceiling        $${xMonthly.toFixed(2)}`);
  } else {
    info(`x                $0.00  (disabled)`);
  }
  info('cloud run        ~$0 at this volume (scale-to-zero, free tier)');

  console.log(
    failures === 0
      ? '\n\x1b[32mAll checks passed.\x1b[0m Deploy with DRY_RUN=1 for the first day.\n'
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m Fix these before deploying.\n`,
  );

  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

void main();
