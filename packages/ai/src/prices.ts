/**
 * What the AI assistant costs when the app itself asks Anthropic (route C,
 * with the user's own API key): the models it offers, what each costs, and
 * the limits of one run.
 *
 * The prices are copied by hand from Anthropic's own pages on
 * {@link PRICES_AS_OF}. They are an estimate that the app shows and that its
 * caps work from. Anthropic's bill is the truth; the window says so.
 */

/** The day the prices below were read from Anthropic's pages. */
export const PRICES_AS_OF = '2026-11-15';

/** The models a run may use. Only these can be chosen. */
export const API_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type ApiModel = (typeof API_MODELS)[number];

/** How much thinking a model may do before it answers. */
export const API_EFFORTS = ['low', 'medium', 'high'] as const;
export type ApiEffort = (typeof API_EFFORTS)[number];

/** Dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

export const MODEL_PRICES: Record<ApiModel, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

/** Writing to the cache costs this many times the input price. */
export const CACHE_WRITE_FACTOR = 1.25;
/** Reading from the cache costs this many times the input price. */
export const CACHE_READ_FACTOR = 0.1;

/** The tokens of one response, by kind. `input` is the part that was not cached. */
export interface ApiUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** What a response cost, in dollars, at the table's prices. */
export function costOf(model: ApiModel, usage: ApiUsage): number {
  const price = MODEL_PRICES[model];
  const inputUnits =
    usage.input + usage.cacheWrite * CACHE_WRITE_FACTOR + usage.cacheRead * CACHE_READ_FACTOR;
  return (inputUnits * price.input + usage.output * price.output) / 1_000_000;
}

/** The least, the most and the usual cap on what one run may cost, in dollars. */
export const API_CAP_MIN = 0.25;
export const API_CAP_MAX = 10;
export const API_CAP_DEFAULT = 1;

/** The most one response may hold. Thinking counts in it. */
export const API_MAX_TOKENS = 8000;
