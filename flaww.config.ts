/**
 * flaww — the only file you edit day to day.
 *
 * Each source has its own `enabled` flag. Turning one off disables it
 * completely: no polling, no reading, no screening, no publishing. Nothing
 * else in the config needs to change.
 */
import type { FlawwConfig } from './src/config';

const config: FlawwConfig = {
  // ───────────────────────────────────────────────────────────────────────
  // Who you are. This is the entire context the screening model gets, so
  // write it like you'd brief a new contractor — concrete, not aspirational.
  // ───────────────────────────────────────────────────────────────────────
  persona: {
    company: 'Flaww',
    product: `One-sentence description of what you sell and who it's for.
Second sentence: the mechanism — how it actually works.`,

    icp: 'Series A-B B2B SaaS, 20-300 employees. Buyer is the CTO or first security hire.',

    painPoints: [
      'manual evidence collection',
      'audit deadline forced by a customer deal',
      'incumbent pricing frustration',
      'engineering time consumed by compliance',
    ],

    competitors: ['Vanta', 'Drata', 'Secureframe'],

    // Runs before the LLM, costs nothing, kills the most common false positives.
    negativeTerms: ['hiring', 'we are hiring', 'job posting', 'giveaway', 'promo code'],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SOURCES — each independently toggleable
  // ═══════════════════════════════════════════════════════════════════════

  // ── Reddit ──────────────────────────────────────── free, 100 req/min ──
  reddit: {
    enabled: false,

    subreddits: ['devops', 'startups', 'SaaS', 'cybersecurity', 'ExperiencedDevs'],

    keywords: ['soc 2', 'soc2', 'iso 27001', 'compliance', 'audit', 'vanta', 'drata'],

    pollMinutes: 12,
    fetchLimit: 25,
    maxAgeHours: 36,
    minAuthorKarma: 50,
  },

  // ── Threads ──────────────────────────────── free, 1000 replies/24h ──
  // Meta's keyword search. Free, generous limits, and the only paid-tier-free
  // way to do real listening besides Reddit. Requires the
  // `threads_keyword_search` permission on your Meta app.
  threads: {
    enabled: true,

    keywords: ['soc 2', 'soc2 compliance', 'iso 27001', 'vanta', 'security audit'],

    // TOP is ranked and quieter; RECENT is chronological and noisier.
    searchType: 'RECENT',

    pollMinutes: 60,
    fetchLimit: 25,
    maxAgeHours: 24,
  },

  // ── X ──────────────────────────────────────────── PAY PER TWEET READ ──
  // The only source that costs money per item. Budgets below are denominated
  // in TWEETS, not requests, because that's what you're billed for.
  x: {
    enabled: false, // flip on when you're ready to spend

    tags: ['#soc2', '#compliance', '#infosec', '#devsecops'],
    phrases: ['soc 2 audit', 'vanta alternative'],

    pollMinutes: 45,

    // Tweets pulled per poll. THIS IS THE COST DIAL — at $0.005/read,
    // 25 × 32 polls/day = 800 reads = $4/day if every poll comes back full.
    // In practice incremental polling means most come back near-empty.
    fetchLimit: 25,

    maxAgeHours: 12,
    minAuthorFollowers: 100,
    excludeRetweets: true,

    // A reply containing a link is billed at ~13× a plain one ($0.20 vs
    // $0.015). flaww warns you before spending it.
    warnOnLinkCost: true,
  },

  // ── LinkedIn ─────────────────────────── free, but no search API exists ──
  // Important: LinkedIn has no public post-search API. "Listening" here means
  // comments and mentions on YOUR OWN posts — that is the entire legitimate
  // surface. Requires Community Management API approval (manual review, can
  // take weeks). Ships off.
  linkedin: {
    enabled: false,

    // Your own author URN, e.g. "urn:li:person:xxxx" or "urn:li:organization:123".
    authorUrn: '',

    // How many of your recent posts to watch for new comments.
    watchRecentPosts: 10,

    pollMinutes: 60,
    maxAgeHours: 72,
  },

  // ═══════════════════════════════════════════════════════════════════════

  screening: {
    // Set from your spec. Verify the exact ID against your provider's model
    // list — `npm run doctor` makes one live call and tells you if it's wrong.
    model: 'gpt-5.4-nano',

    minConfidence: 0.7,
    temperature: 0,
    promptVersion: 'v1',
  },

  // ───────────────────────────────────────────────────────────────────────
  // Hard ceilings. When one is hit that source STOPS until the window rolls
  // over — it does not slow down or degrade.
  // ───────────────────────────────────────────────────────────────────────
  budgets: {
    reddit: { requestsPerHour: 60, requestsPerDay: 800 },

    threads: { requestsPerHour: 10, requestsPerDay: 120 },

    // Denominated in TWEETS READ, because that's the billing unit.
    // 200/day ≈ $1.00/day ≈ $30/month at $0.005/read.
    x: {
      tweetsPerDay: 200,
      tweetsPerMonth: 5_000,
      requestsPerHour: 4, // secondary guard against a poll storm
      writesPerDay: 10, // replies posted — $0.015 each, $0.20 with a link
    },

    linkedin: { requestsPerHour: 4, requestsPerDay: 40 },

    // The overall screening ceiling. This is the number that bounds LLM cost
    // regardless of how noisy every source gets.
    llm: { postsPerDay: 200, usdPerDay: 0.5 },

    onExhausted: 'stop_and_notify',
  },

  // ───────────────────────────────────────────────────────────────────────
  // Publishing safety. Your text goes out verbatim — these govern WHEN and
  // WHETHER, never WHAT.
  // ───────────────────────────────────────────────────────────────────────
  safety: {
    maxRepliesPerDay: { reddit: 8, x: 10, threads: 10, linkedin: 5 },
    minGapMinutes: { reddit: 20, x: 12, threads: 12, linkedin: 25 },

    maxPerSubredditPerDay: 3,
    authorCooldownDays: 7,

    // Delay between you sending and the reply going live. Doubles as your
    // undo window and as human-cadence jitter.
    //
    // On Cloud Run this is also bounded below by the publish scheduler's
    // interval (default 2 min) — a reply can't fire before the next tick.
    publishDelaySeconds: { min: 60, max: 900 },

    activeHours: { start: 8, end: 23 },
    timezone: 'Europe/Istanbul',

    maxSimilarityToRecent: 0.85,
    similarityWindow: 200,
  },

  telegram: {
    maxOutstandingCards: 12,
    cardTtlHours: 8,
    maxCardsPerDay: 25,
  },
};

export default config;
