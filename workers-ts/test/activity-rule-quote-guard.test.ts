import { describe, expect, it } from 'vitest';
import { PgDialect, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { storeBargain } from '../src/models/schema';
import { activityRuleQuoteGuard } from '../src/services/activity/ActivityRuleQuoteGuard';

describe('activity rule quote SQL projection', () => {
  it('binds explicit scalar facts, ISO dates and null without including inventory columns', () => {
    const date = new Date('2026-09-09T00:00:00.000Z');
    const query = new PgDialect().sqlToQuery(activityRuleQuoteGuard({
      num: 3, startTime: date, stopTime: null, deliveryType: '1,2', giveIntegral: '2.00',
    }, storeBargain));
    expect(query.params).toEqual([3, date.toISOString(), null, '1,2', '2.00']);
    expect(query.sql.match(/IS NOT DISTINCT FROM/g)).toHaveLength(5);
    expect(query.sql).not.toMatch(/stock|quota|sales|title/);
  });

  it('does not turn an empty projection into an absent WHERE guard', () => {
    expect(() => activityRuleQuoteGuard({}, storeBargain)).toThrow('Empty activity rule quote projection');
  });

  it('fails closed on an unmapped dynamic rule column', () => {
    const facts: Record<string, number> = { unknownRule: 1 };
    const columns: Record<string, AnyPgColumn> = {};
    expect(() => activityRuleQuoteGuard(facts, columns)).toThrow('Invalid activity rule quote projection');
  });
});
