import { describe, expect, it } from 'vitest';
import {
  API_CAP_DEFAULT,
  API_CAP_MAX,
  API_CAP_MIN,
  API_EFFORTS,
  API_MAX_TOKENS,
  API_MODELS,
  CACHE_READ_FACTOR,
  CACHE_WRITE_FACTOR,
  MODEL_PRICES,
  PRICES_AS_OF,
  costOf,
} from './prices';

describe('the price table', () => {
  it('holds a positive price for every model offered, and no other model', () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual([...API_MODELS].sort());
    for (const model of API_MODELS) {
      expect(MODEL_PRICES[model].input).toBeGreaterThan(0);
      expect(MODEL_PRICES[model].output).toBeGreaterThan(MODEL_PRICES[model].input);
    }
  });

  it('is dated', () => {
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has the cache factors Anthropic lists', () => {
    expect(CACHE_WRITE_FACTOR).toBe(1.25);
    expect(CACHE_READ_FACTOR).toBe(0.1);
  });

  it('keeps the default cap between its bounds', () => {
    expect(API_CAP_MIN).toBeLessThan(API_CAP_DEFAULT);
    expect(API_CAP_DEFAULT).toBeLessThan(API_CAP_MAX);
  });

  it('offers the three efforts', () => {
    expect([...API_EFFORTS]).toEqual(['low', 'medium', 'high']);
    expect(API_MAX_TOKENS).toBe(8000);
  });
});

describe('costOf', () => {
  const none = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  it('is nothing for no tokens', () => {
    expect(costOf('claude-opus-5-5', none)).toBe(0);
  });

  it('prices plain input and output per million tokens', () => {
    expect(costOf('claude-opus-5-5', { ...none, input: 1_000_000 })).toBeCloseTo(4, 10);
    expect(costOf('claude-opus-5-5', { ...none, output: 1_000_000 })).toBeCloseTo(20, 10);
    expect(costOf('claude-sonnet-5-5', { ...none, input: 500_000, output: 100_000 })).toBeCloseTo(
      2,
      10,
    );
    expect(
      costOf('claude-haiku-5-5', { ...none, input: 1_000_000, output: 1_000_000 }),
    ).toBeCloseTo(0.6, 10);
  });

  it('charges cache writes at 1.25 times and cache reads at 0.1 times the input price', () => {
    expect(costOf('claude-opus-5-5', { ...none, cacheWrite: 1_000_000 })).toBeCloseTo(5, 10);
    expect(costOf('claude-opus-5-5', { ...none, cacheRead: 1_000_000 })).toBeCloseTo(0.4, 10);
  });

  it('adds the four kinds together', () => {
    const usage = { input: 1000, output: 2000, cacheWrite: 4000, cacheRead: 10_000 };
    const expected = (1000 * 2 + 4000 * 1.25 * 2 + 10_000 * 0.1 * 2 + 2000 * 10) / 1_000_000;
    expect(costOf('claude-sonnet-5-5', usage)).toBeCloseTo(expected, 12);
  });
});
