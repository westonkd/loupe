// Bundled per-model prices, USD per million tokens (Anthropic first-party API
// rates, cached 2026-09-25). Used only for *estimates*; the CLI's own
// `cost-state.totalCostUSD` is preferred for session totals when present.
// Update this table by hand; the app never fetches prices at runtime (N5).

export interface ModelPrice {
  input: number;
  output: number;
  /** Cache read price. Defaults to 0.1x input when omitted. */
  cacheRead?: number;
}

/** Cache write multipliers on the input price. */
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;

// Ordered most-specific first: lookup uses the first prefix that matches.
const PRICES: Array<[prefix: string, price: ModelPrice]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-opus-4-5', { input: 5, output: 25 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
];

/** Models whose `speed: "fast"` mode bills at 2x standard rates. */
const FAST_MODE_PREFIXES = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'];

export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase().replace(/\[.*\]$/, '');
  for (const [prefix, price] of PRICES) {
    if (m === prefix || m.startsWith(prefix + '-') || m.startsWith(prefix + '@')) return price;
  }
  return null;
}

export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  speed?: string | null;
}

export type InputUsageForCost = Omit<UsageForCost, 'outputTokens'>;

function fastMultiplier(model: string | null | undefined, speed: string | null | undefined): number {
  const m = (model ?? '').toLowerCase();
  return speed === 'fast' && FAST_MODE_PREFIXES.some((f) => m.startsWith(f)) ? 2 : 1;
}

/**
 * Estimated USD for the prompt side of one request: uncached input, cache
 * reads and cache writes. The whole prompt is re-sent on every request, so
 * this is the part a long-lived context keeps paying.
 */
export function inputSideCost(model: string | null | undefined, u: InputUsageForCost): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const usd =
    (u.inputTokens * p.input +
      u.cacheReadTokens * cacheRead +
      u.cacheWrite5mTokens * p.input * CACHE_WRITE_5M +
      u.cacheWrite1hTokens * p.input * CACHE_WRITE_1H) /
    1_000_000;
  return usd * fastMultiplier(model, u.speed);
}

/** Estimated USD for cache writes alone: what a prompt-cache miss re-paid. */
export function cacheWriteCost(
  model: string | null | undefined,
  cacheWrite5mTokens: number,
  cacheWrite1hTokens: number,
  speed?: string | null,
): number | null {
  return inputSideCost(model, { inputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens, cacheWrite1hTokens, speed });
}

/** Estimated USD cost of one API request, or null for unknown models. */
export function estimateCost(model: string | null | undefined, u: UsageForCost): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const input = inputSideCost(model, u) ?? 0;
  const output = ((u.outputTokens * p.output) / 1_000_000) * fastMultiplier(model, u.speed);
  return input + output;
}
