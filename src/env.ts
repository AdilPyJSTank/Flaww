import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  // Cloud Run injects PORT. Default matches the container's EXPOSE.
  PORT: z.coerce.number().int().default(8080),

  /** Public https base URL of this service — used to register the Telegram
   *  webhook on boot. On Cloud Run this is the service URL. */
  PUBLIC_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (Postgres connection string)'),

  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required for screening'),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.coerce.number().int(),
  /** Doubles as the webhook path segment and the header Telegram sends back.
   *  Any long random string; `openssl rand -hex 24`. */
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16, 'use at least 16 chars — this is in the URL path'),

  /** Shared secret Cloud Scheduler sends on /tasks/* calls. */
  TASKS_SECRET: z.string().min(16),

  // ── Reddit (script app, password grant) ──────────────────────────────
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  REDDIT_USERNAME: z.string().optional(),
  REDDIT_PASSWORD: z.string().optional(),
  REDDIT_USER_AGENT: z.string().default('flaww/0.1'),

  // ── Threads (Meta long-lived token, auto-refreshed) ──────────────────
  THREADS_ACCESS_TOKEN: z.string().optional(),

  // ── X (OAuth2 PKCE, refresh token rotates) ───────────────────────────
  X_CLIENT_ID: z.string().optional(),
  X_CLIENT_SECRET: z.string().optional(),
  X_REFRESH_TOKEN: z.string().optional(),

  // ── LinkedIn (Community Management API) ──────────────────────────────
  LINKEDIN_ACCESS_TOKEN: z.string().optional(),
  LINKEDIN_AUTHOR_URN: z.string().optional(),

  LOG_LEVEL: z.string().default('info'),
  DRY_RUN: z
    .string()
    .default('0')
    .transform((v) => v === '1' || v.toLowerCase() === 'true'),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  console.error(`Environment is not configured:\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;

export function requireRedditCreds() {
  const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD } = env;
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !REDDIT_USERNAME || !REDDIT_PASSWORD) {
    throw new Error('reddit.enabled is true but REDDIT_* credentials are missing');
  }
  return {
    clientId: REDDIT_CLIENT_ID,
    clientSecret: REDDIT_CLIENT_SECRET,
    username: REDDIT_USERNAME,
    password: REDDIT_PASSWORD,
    userAgent: env.REDDIT_USER_AGENT,
  };
}

export function requireXCreds() {
  const { X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN } = env;
  if (!X_CLIENT_ID || !X_REFRESH_TOKEN) {
    throw new Error('x.enabled is true but X_CLIENT_ID / X_REFRESH_TOKEN are missing');
  }
  return { clientId: X_CLIENT_ID, clientSecret: X_CLIENT_SECRET, refreshToken: X_REFRESH_TOKEN };
}
