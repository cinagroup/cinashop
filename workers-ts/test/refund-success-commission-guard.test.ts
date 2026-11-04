import { describe, expect, it } from 'vitest';
import type { DbClient } from '@/lib/di';
import { REFUND_SUCCESS_NOTICE_INACTIVE_HISTORICAL, REFUND_SUCCESS_NOTICE_PREDECESSORS,
  REFUND_SUCCESS_NOTICE_SUCCESSORS, REFUND_SUCCESS_NOTICE_SQL,
  refundSuccessNoticeCommissionedTx } from '@/migrations/refundSuccessNotice';

// Closed published event order from 0091, 0129, 0131-0133, 0161, 0168,
// 0175 and 0177. This catalog stub never executes DDL or business completion.
const events = ['order.paid', 'order.delivery.notice', 'order.refund.refused.notice',
  'order.second_card.advent.notice', 'order.second_card.expired.notice', 'withdrawal.approved.notice',
  'withdrawal.refused.notice', 'withdrawal.applied.notice', 'withdrawal.staff.refresh', 'order.presale.fulfillment',
  'order.pink.success.notice', 'product.stock.effects', 'product.recycle.effects'];
const cases = [3, 5, 7, 8, 9, 10, 11, 12, 13].map(count => [count,
  `CHECK (((event_type)::text = ANY ((ARRAY[${events.slice(0, count).map(event => `'${event}'::character varying`).join(', ')}])::text[])))`] as const);
function target(rows: { definition: string; safe: boolean }[]) {
  const calls: unknown[] = [];
  return { calls, tx: { execute: async (query: unknown) => { calls.push(query); return rows; } } as unknown as Pick<DbClient, 'execute'> };
}

describe('refund-success historical whitelist stays inactive', () => {
  it.each(cases)('allows business completion without commissioning the exact %s-event generation', async (_count, definition) => {
    const t = target([{ definition, safe: true }]);
    await expect(refundSuccessNoticeCommissionedTx(t.tx)).resolves.toBe(false);
    expect(t.calls).toHaveLength(1);
    expect(REFUND_SUCCESS_NOTICE_INACTIVE_HISTORICAL).toContain(definition);
    expect(REFUND_SUCCESS_NOTICE_PREDECESSORS).not.toContain(definition);
    expect(REFUND_SUCCESS_NOTICE_SQL).not.toContain("'" + definition.replaceAll("'", "''") + "'");
  });

  it('retains only the original four explicit upgrade predecessors and their commissioned successors', async () => {
    expect(REFUND_SUCCESS_NOTICE_INACTIVE_HISTORICAL).toEqual(cases.map(([, definition]) => definition));
    expect(REFUND_SUCCESS_NOTICE_PREDECESSORS).toHaveLength(4);
    expect(REFUND_SUCCESS_NOTICE_SUCCESSORS).toHaveLength(4);
    for (const definition of REFUND_SUCCESS_NOTICE_PREDECESSORS) {
      await expect(refundSuccessNoticeCommissionedTx(target([{ definition, safe: true }]).tx)).resolves.toBe(false);
      expect(REFUND_SUCCESS_NOTICE_SQL).toContain("'" + definition.replaceAll("'", "''") + "'");
    }
    for (const definition of REFUND_SUCCESS_NOTICE_SUCCESSORS)
      await expect(refundSuccessNoticeCommissionedTx(target([{ definition, safe: true }]).tx)).resolves.toBe(true);
  });

  it.each([
    { rows: [{ definition: cases[0][1], safe: false }] },
    { rows: [{ definition: 'CHECK ((event_type <> \'\'))', safe: true }] },
    { rows: [{ definition: cases[0][1].replace('order.refund.refused.notice', 'order.refund.success.notice'), safe: true }] },
    { rows: [] },
  ])('rejects an unsafe, unknown or missing catalog without treating it as inactive: %j', async ({ rows }) => {
    await expect(refundSuccessNoticeCommissionedTx(target(rows).tx)).rejects.toMatchObject({ httpStatus: 503 });
  });
});
