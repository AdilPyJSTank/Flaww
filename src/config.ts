import { z } from 'zod';

export const PLATFORMS = ['reddit', 'threads', 'x', 'linkedin'] as const;
export type PlatformName = (typeof PLATFORMS)[number];

const PersonaSchema = z.object({
  company: z.string().min(1),
  product: z.string().min(20, 'Write at least a couple of real sentences — this is all the screener knows.'),
  icp: z.string().min(10),
  painPoints: z.array(z.string()).min(1),
  competitors: z.array(z.string()).default([]),
  negativeTerms: z.array(z.string()).default([]),
});

const RedditSchema = z.object({
  enabled: z.boolean(),
  subreddits: z.array(z.string().regex(/^[A-Za-z0-9_]+$/, 'Bare name only, no "r/" prefix')),
  keywords: z.array(z.string()).min(1),
  pollMinutes: z.number().int().min(5, 'Below 5 minutes you are hammering Reddit for no benefit.'),
  fetchLimit: z.number().int().min(1).max(100),
  maxAgeHours: z.number().min(1),
  minAuthorKarma: z.number().int().min(0).default(0),
});

const ThreadsSchema = z.object({
  enabled: z.boolean(),
  keywords: z.array(z.string()).default([]),
  searchType: z.enum(['TOP', 'RECENT']).default('RECENT'),
  pollMinutes: z.number().int().min(10),
  fetchLimit: z.number().int().min(1).max(50),
  maxAgeHours: z.number().min(1),
});

const XSchema = z.object({
  enabled: z.boolean(),
  tags: z.array(z.string()).default([]),
  phrases: z.array(z.string()).default([]),
  pollMinutes: z.number().int().min(15, 'X reads cost money per tweet — 15 minutes is the floor.'),
  fetchLimit: z.number().int().min(10).max(100),
  maxAgeHours: z.number().min(1),
  minAuthorFollowers: z.number().int().min(0).default(0),
  excludeRetweets: z.boolean().default(true),
  warnOnLinkCost: z.boolean().default(true),
});

const LinkedInSchema = z.object({
  enabled: z.boolean(),
  authorUrn: z.string().default(''),
  watchRecentPosts: z.number().int().min(1).max(50).default(10),
  pollMinutes: z.number().int().min(30),
  maxAgeHours: z.number().min(1),
});

const ScreeningSchema = z.object({
  model: z.string().min(1),
  minConfidence: z.number().min(0).max(1),
  temperature: z.number().min(0).max(2).nullable().default(0),
  promptVersion: z.string().default('v1'),
});

const BudgetsSchema = z.object({
  reddit: z.object({
    requestsPerHour: z.number().int().positive(),
    requestsPerDay: z.number().int().positive(),
  }),
  threads: z.object({
    requestsPerHour: z.number().int().positive(),
    requestsPerDay: z.number().int().positive(),
  }),
  // Denominated in tweets read, because that is the billing unit under
  // pay-per-use. requestsPerHour is a secondary guard, not the cost control.
  x: z.object({
    tweetsPerDay: z.number().int().positive(),
    tweetsPerMonth: z.number().int().positive(),
    requestsPerHour: z.number().int().positive(),
    writesPerDay: z.number().int().nonnegative(),
  }),
  linkedin: z.object({
    requestsPerHour: z.number().int().positive(),
    requestsPerDay: z.number().int().positive(),
  }),
  llm: z.object({
    postsPerDay: z.number().int().positive(),
    usdPerDay: z.number().positive(),
  }),
  onExhausted: z.enum(['stop', 'stop_and_notify']).default('stop_and_notify'),
});

const perPlatform = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ reddit: inner, x: inner, threads: inner, linkedin: inner });

const SafetySchema = z.object({
  maxRepliesPerDay: perPlatform(z.number().int().min(0)),
  minGapMinutes: perPlatform(z.number().min(0)),
  maxPerSubredditPerDay: z.number().int().min(1),
  authorCooldownDays: z.number().min(0),
  publishDelaySeconds: z.object({ min: z.number().min(0), max: z.number().min(0) }),
  activeHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(1).max(24) }),
  timezone: z.string(),
  maxSimilarityToRecent: z.number().min(0).max(1),
  similarityWindow: z.number().int().positive(),
});

const TelegramSchema = z.object({
  maxOutstandingCards: z.number().int().positive(),
  cardTtlHours: z.number().positive(),
  maxCardsPerDay: z.number().int().positive(),
});

export const ConfigSchema = z.object({
  persona: PersonaSchema,
  reddit: RedditSchema,
  threads: ThreadsSchema,
  x: XSchema,
  linkedin: LinkedInSchema,
  screening: ScreeningSchema,
  budgets: BudgetsSchema,
  safety: SafetySchema,
  telegram: TelegramSchema,
});

export type FlawwConfig = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;

/** Which sources are actually on. Everything downstream keys off this. */
export function enabledPlatforms(cfg: Config): PlatformName[] {
  return PLATFORMS.filter((p) => cfg[p].enabled);
}

let cached: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (cached) return cached;
  // tsx resolves the .js specifier to flaww.config.ts at run time.
  const mod = (await import('../flaww.config.js')) as { default: unknown };
  const parsed = ConfigSchema.safeParse(mod.default);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`flaww.config.ts is invalid:\n${lines.join('\n')}`);
  }

  const c = parsed.data;

  if (c.safety.publishDelaySeconds.min > c.safety.publishDelaySeconds.max) {
    throw new Error('safety.publishDelaySeconds.min must be <= max');
  }
  if (c.x.enabled && c.x.tags.length === 0 && c.x.phrases.length === 0) {
    throw new Error('x.enabled is true but no tags or phrases are configured.');
  }
  if (c.threads.enabled && c.threads.keywords.length === 0) {
    throw new Error('threads.enabled is true but threads.keywords is empty.');
  }
  if (c.linkedin.enabled && !c.linkedin.authorUrn) {
    throw new Error('linkedin.enabled is true but linkedin.authorUrn is not set.');
  }
  if (enabledPlatforms(c).length === 0) {
    throw new Error('Every source is disabled — flaww has nothing to do.');
  }

  cached = c;
  return c;
}
