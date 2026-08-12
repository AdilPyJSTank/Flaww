/**
 * The single place flaww talks to a language model.
 *
 * Everything provider-specific is isolated here on purpose: if the model
 * needs a different endpoint shape (e.g. the Responses API instead of Chat
 * Completions), this is the only file that changes.
 *
 * Run `npm run doctor` after changing the model ID — it makes one live call
 * and reports exactly what the provider rejected, which beats discovering it
 * from a poller stack trace at 3am.
 */
import OpenAI from 'openai';
import { env } from '../env';
import { log } from '../logger';
import type { Config } from '../config';

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export interface Verdict {
  is_relevant: boolean;
  confidence: number;
  reason: string;
}

export interface ScreenResult extends Verdict {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    is_relevant: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['is_relevant', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

/**
 * Per-million-token rates used only for the daily spend counter. These are an
 * estimate — the hard ceiling that actually protects you is
 * budgets.llm.postsPerDay, which is a count and cannot drift. Correct these
 * once you've seen a real invoice.
 */
const PRICE_PER_MTOK = { input: 0.05, output: 0.4 };

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_PER_MTOK.input +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK.output
  );
}

export async function screen(
  cfg: Config,
  system: string,
  user: string,
): Promise<ScreenResult> {
  const started = Date.now();

  const request: Record<string, unknown> = {
    model: cfg.screening.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA },
    },
  };

  // Some models reject sampling params outright. Set screening.temperature to
  // null in flaww.config.ts if doctor reports a 400 about it.
  if (cfg.screening.temperature !== null) {
    request.temperature = cfg.screening.temperature;
  }

  const res = await client.chat.completions.create(
    request as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );

  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error('screening returned no content');

  let parsed: Verdict;
  try {
    parsed = JSON.parse(raw) as Verdict;
  } catch {
    throw new Error(`screening returned unparseable JSON: ${raw.slice(0, 200)}`);
  }

  // Never trust a model's own bounds checking.
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0));
  const inputTokens = res.usage?.prompt_tokens ?? 0;
  const outputTokens = res.usage?.completion_tokens ?? 0;

  return {
    is_relevant: Boolean(parsed.is_relevant),
    confidence,
    reason: String(parsed.reason ?? '').slice(0, 400),
    inputTokens,
    outputTokens,
    costUsd: estimateCost(inputTokens, outputTokens),
    latencyMs: Date.now() - started,
  };
}

/** One-shot connectivity + model-ID check used by `npm run doctor`. */
export async function ping(cfg: Config): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await screen(
      cfg,
      'Reply with a JSON verdict. This is a connectivity test.',
      '<post platform="reddit">Testing whether the model id and schema work.</post>',
    );
    return {
      ok: true,
      detail: `model="${cfg.screening.model}" ok · ${r.inputTokens}in/${r.outputTokens}out · ${r.latencyMs}ms`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.debug({ err: msg }, 'doctor ping failed');
    return { ok: false, detail: msg };
  }
}
