/**
 * Local pricing table for models where OpenClaw's own `usage.cost.total`
 * is missing or zero. Prices are USD per 1M tokens (input / output),
 * accurate as of 2026-07-04. Keep this in sync when providers change
 * their published rates.
 *
 * When adding a model, use a substring pattern that matches the model
 * id as it appears in OpenClaw trajectory logs (e.g. "claude-opus-4-7",
 * "gpt-5.3-codex").
 */
export interface PriceEntry {
  /** substring match against `${provider}/${model}` (case-insensitive) */
  match: string;
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read tokens (defaults to 0.1 * input) */
  cacheRead?: number;
  /** USD per 1M cache-write tokens (defaults to 1.25 * input) */
  cacheWrite?: number;
}

/** Ordered most-specific-first. First substring hit wins. */
export const PRICING: PriceEntry[] = [
  // -------- Anthropic --------
  { match: 'claude-opus-4-7',         input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  // Older Opus 4 snapshots (pre-4.7) — same list price
  { match: 'claude-opus-4-20250514',  input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  { match: 'claude-opus-4-3-20250514',input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  { match: 'claude-opus-4',           input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  { match: 'claude-sonnet-4-6',       input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 },
  { match: 'claude-sonnet-4',         input:  3.00, output: 15.00, cacheRead: 0.30,  cacheWrite:  3.75 },
  { match: 'claude-haiku',            input:  0.80, output:  4.00, cacheRead: 0.08,  cacheWrite:  1.00 },

  // -------- OpenAI --------
  { match: 'gpt-5.3-codex',           input:  1.25, output: 10.00, cacheRead: 0.125, cacheWrite: 1.25 },
  { match: 'gpt-5-codex',             input:  1.25, output: 10.00, cacheRead: 0.125, cacheWrite: 1.25 },
  { match: 'gpt-5',                   input:  1.25, output: 10.00, cacheRead: 0.125, cacheWrite: 1.25 },
  { match: 'gpt-4o',                  input:  2.50, output: 10.00, cacheRead: 1.25,  cacheWrite: 3.13 },
  { match: 'gpt-4.1',                 input:  2.00, output:  8.00, cacheRead: 0.50,  cacheWrite: 2.50 },
  { match: 'o1-preview',              input: 15.00, output: 60.00, cacheRead: 7.50,  cacheWrite: 18.75 },
  { match: 'o1-mini',                 input:  3.00, output: 12.00, cacheRead: 1.50,  cacheWrite: 3.75 },
  { match: 'o3-mini',                 input:  1.10, output:  4.40, cacheRead: 0.55,  cacheWrite: 1.38 },

  // -------- Google --------
  { match: 'gemini-2.5-pro',          input:  1.25, output: 10.00, cacheRead: 0.31,  cacheWrite: 1.25 },
  { match: 'gemini-2.5-flash',        input:  0.075, output: 0.30, cacheRead: 0.019, cacheWrite: 0.075 },
  { match: 'gemini-2.0-flash',        input:  0.10, output:  0.40, cacheRead: 0.025, cacheWrite: 0.10 },

  // -------- Free / self-hosted --------
  { match: 'ollama/minimax',          input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { match: 'ollama/qwen',             input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { match: 'ollama/',                 input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { match: 'openclaw/',               input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
];

/**
 * Per-image pricing for image-generation models (USD per image).
 * Substring match against `${provider}/${model}` (case-insensitive),
 * most-specific-first. Accurate as of 2026-07-05 (Google published rates).
 *
 * Note: OpenClaw's image_generate tool bypasses the trajectory usage/cost
 * pipeline, so these are inferred by counting `image_generate:*:ok`
 * runIds in trajectory files and multiplying by the flat per-image rate.
 */
export interface ImagePriceEntry {
  /** substring match against `${provider}/${model}` (case-insensitive) */
  match: string;
  /** USD per generated image */
  perImage: number;
}

export const IMAGE_PRICING: ImagePriceEntry[] = [
  // Google Gemini image models ("Nano Banana" family + Imagen)
  { match: 'google/gemini-3.1-flash-image', perImage: 0.039 }, // Nano Banana 2 (1024x)
  { match: 'google/gemini-2.5-flash-image', perImage: 0.039 }, // Nano Banana 1 (1024x)
  { match: 'google/nano-banana',            perImage: 0.039 },
  { match: 'google/imagen-4',               perImage: 0.04 },
  { match: 'google/imagen-3',               perImage: 0.04 },

  // OpenAI image models
  { match: 'openai/gpt-image-2',            perImage: 0.19 }, // hi-quality 1024x
  { match: 'openai/gpt-image-1.5',          perImage: 0.19 },
  { match: 'openai/gpt-image-1',            perImage: 0.19 },
  { match: 'openai/dall-e-3',               perImage: 0.04 }, // standard 1024x
];

export function lookupImagePrice(provider: string, model: string): ImagePriceEntry | undefined {
  const key = `${provider}/${model}`.toLowerCase();
  for (const p of IMAGE_PRICING) {
    if (key.includes(p.match.toLowerCase())) return p;
  }
  return undefined;
}

/** Look up a price entry. Returns undefined if no match (call remains unpriced). */
export function lookupPrice(provider: string, model: string): PriceEntry | undefined {
  const key = `${provider}/${model}`.toLowerCase();
  for (const p of PRICING) {
    if (key.includes(p.match.toLowerCase())) return p;
  }
  return undefined;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Estimate USD cost from token counts + a price entry. */
export function estimateCost(price: PriceEntry, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): CostBreakdown {
  const input = (tokens.input / 1_000_000) * price.input;
  const output = (tokens.output / 1_000_000) * price.output;
  const cacheRead = (tokens.cacheRead / 1_000_000) * (price.cacheRead ?? price.input * 0.1);
  const cacheWrite = (tokens.cacheWrite / 1_000_000) * (price.cacheWrite ?? price.input * 1.25);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
