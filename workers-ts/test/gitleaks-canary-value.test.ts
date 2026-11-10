import { describe, expect, it } from 'vitest';
import { createGenericKeyCanary } from '../scripts/gitleaks-canary-value.mjs';

function entropy(value: string) {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return -[...counts.values()].reduce((sum, count) => {
    const probability = count / value.length;
    return sum + probability * Math.log2(probability);
  }, 0);
}
function acceptsProbeShape(value: string) {
  // Numeric/boolean assertions deliberately never print generated key values.
  expect(value.length).toBe(104);
  expect(/^(?:[a-z][0-9]){52}$/.test(value)).toBe(true);
  expect(entropy(value)).toBeGreaterThan(4.5);
  for (const block of [value.slice(0, 52), value.slice(52)]) {
    expect(new Set([...block].filter((_, index) => index % 2 === 0)).size).toBe(26);
  }
}

describe('generated Gitleaks generic key probe domain', () => {
  it.each([
    ['lowest index', () => 0],
    ['highest index', (bound: number) => bound - 1],
    ['middle index', (bound: number) => Math.floor(bound / 2)],
  ] as const)('keeps entropy and mixed character shape under %s choices without retries', (_name, choose) => {
    const calls: number[] = [];
    acceptsProbeShape(createGenericKeyCanary(bound => { calls.push(bound); return choose(bound); }));
    expect(calls).toEqual(Array.from({ length: 4 }, () => Array.from({ length: 25 }, (_, index) => 26 - index)).flat());
  });
  it('uses fresh cryptographic permutations in the production probe generator', () => {
    const first = createGenericKeyCanary(), second = createGenericKeyCanary();
    acceptsProbeShape(first); acceptsProbeShape(second);
    expect(first === second).toBe(false);
  });
  it.each([-1, 26, 0.5, NaN, Infinity])('refuses an invalid permutation index without logging generated material (%s)', value => {
    expect(() => createGenericKeyCanary(() => value)).toThrow('Invalid generated canary permutation index');
  });
});
