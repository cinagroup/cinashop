import { describe, expect, it } from 'vitest';
import { productRecommendationInput } from '@/services/product/ProductRecommendationInput';

describe('ordered product recommendation input shared by Supplier and Out', () => {
  it('distinguishes omitted inherited undefined and explicit empty intent', () => {
    for (const raw of [{}, { recommend_list: undefined }, Object.create({ recommend_list: [1] })])
      expect(productRecommendationInput(raw)).toBeUndefined();
    expect(productRecommendationInput({ recommend_list: [] })).toBe('');
  });
  it('canonicalizes numeric spellings while preserving order duplicates and missing target identity', () => {
    expect(productRecommendationInput({ recommend_list: [' 00081 ', 999, '90', 81] })).toBe('81,999,90,81');
    expect(productRecommendationInput({ recommend_list: [2147483647] })).toBe('2147483647');
  });
  it('accepts exactly the database capacity and independently enforces the array capacity', () => {
    const exact = [...Array(63).fill(100), 1000];
    expect(productRecommendationInput({ recommend_list: exact })).toHaveLength(256);
    expect(() => productRecommendationInput({ recommend_list: [...exact, 1] })).toThrow();
    expect(productRecommendationInput({ recommend_list: Array(100).fill(1) })).toHaveLength(199);
    expect(() => productRecommendationInput({ recommend_list: Array(101).fill(1) })).toThrow();
  });
  it.each([null, false, '', '1,2', {}, [null], [true], [{}], [0], [-1], [1.5], ['1e2'], ['+1'], ['1.0'], [''], [2147483648], [Number.MAX_SAFE_INTEGER]])('rejects malformed explicit list %j', raw => {
    expect(() => productRecommendationInput({ recommend_list: raw })).toThrow();
  });
});
