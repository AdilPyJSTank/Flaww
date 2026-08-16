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
    company: 'PicoFlow',
    product: `AI-powered systematic review assistant for researchers writing conference abstracts and meta-analyses.
It takes a clinical/research question through PICO framing, PubMed search-string generation, abstract + full-text screening (with PRISMA), data extraction, and meta-analysis (forest plots, I², Egger's test), ending in a submission-ready abstract — at picoflow.io, built by the person running this repo (C:\\Users\\user\\Picoflow).`,

    icp: 'Academic/clinical researchers, PhD students, and residents running a systematic review or meta-analysis, usually racing a conference or journal submission deadline.',

    painPoints: [
      'manually screening hundreds of PubMed abstracts',
      'building PRISMA flow diagrams by hand',
      'running meta-analysis stats (forest plots, heterogeneity, subgroup analysis) without a stats background',
      'conference abstract deadline with an unfinished review',
      'PICO framing / search-string construction for a vague research question',
      'losing track of time and falling behind on the review while juggling coursework/clinic',
      'feeling buried under hundreds of papers with no system for getting through them',
      'procrastinating on screening because it is tedious and never-ending',
      'burnout / overwhelm from a review dragging on far longer than planned',
      'imposter syndrome about doing a systematic review or meta-analysis "right"',
    ],

    competitors: ['Covidence', 'Rayyan', 'DistillerSR', 'Nested Knowledge'],

    // Runs before the LLM, costs nothing, kills the most common false positives.
    negativeTerms: ['hiring', 'we are hiring', 'job posting', 'giveaway', 'promo code'],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // SOURCES — each independently toggleable
  // ═══════════════════════════════════════════════════════════════════════

  // ── Reddit ──────────────────────────────────────── free, 100 req/min ──
  reddit: {
    enabled: false,

    subreddits: ['AskAcademia', 'PhD', 'epidemiology', 'medicine', 'biostatistics'],

    keywords: [
      'systematic review',
      'meta-analysis',
      'PRISMA',
      'PICO',
      'abstract screening',
      'covidence',
      'rayyan',
      'so behind on my literature review',
      'phd time management',
      'phd burnout',
      'drowning in papers',
      'can\'t manage my time as a phd',
      'behind on my research',
    ],

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

    keywords: [
      'systematic review',
      'meta-analysis',
      'PRISMA diagram',
      'covidence alternative',
      'rayyan alternative',
      'phd time management',
      'phd burnout',
      'behind on my research',
      'drowning in papers',
    ],

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

    tags: ['#systematicreview', '#metaanalysis', '#prisma', '#phdlife', '#epitwitter'],
    phrases: ['systematic review', 'covidence alternative', 'rayyan alternative'],

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
