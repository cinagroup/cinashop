import { describe, expect, it } from 'vitest';
import { HomepageReadBudget } from '@/services/product/HomepageReadBudget';

describe('complete homepage shared read budget', () => {
  it('uses one elapsed deadline across separate pages and both decoration stages', () => {
    let now = 10;
    const budget = new HomepageReadBudget(() => now, 50, 200);
    budget.consume([{ id: 1 }]); now = 59; budget.consume([{ id: 2 }]);
    now = 60;
    expect(() => budget.check()).toThrow('超时');
    expect(() => budget.assertResponse({ info: [] })).toThrow('超时');
  });
  it('counts UTF8 bytes cumulatively across lists and rejects instead of returning a prefix', () => {
    const budget = new HomepageReadBudget(() => 0, 50, 12);
    budget.consume('中'); // five UTF8 bytes including JSON quotes
    budget.consume('😀'); // six; only one byte remains across both lists
    expect(() => budget.consume(10)).toThrow('容量');
  });
  it('bounds the complete serialized response as well as intermediate chunks', () => {
    const budget = new HomepageReadBudget(() => 0, 50, 12);
    expect(() => budget.assertResponse({ ok: 1 })).not.toThrow();
    expect(() => budget.assertResponse({ extra: '中' })).toThrow('容量');
    expect(() => budget.check()).toThrow('容量');
  });
});
