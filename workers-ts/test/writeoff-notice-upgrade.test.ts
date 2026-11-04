/** Pure finite catalog and SQL artifact contracts; no provider authority. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { WRITEOFF_NOTICE_EVENT, WRITEOFF_NOTICE_EVENT_GENERATIONS, WRITEOFF_NOTICE_PREDECESSORS,
  WRITEOFF_NOTICE_SUCCESSORS, WRITEOFF_NOTICE_SQL, normalizeWriteoffNoticeEventDefinition,
  writeoffNoticeCommissionedTx, writeoffNoticeEventGeneration } from '@/migrations/writeoffNotice';
import { REFUND_SUCCESS_NOTICE_PREDECESSORS, REFUND_SUCCESS_NOTICE_SUCCESSORS,
  REFUND_SUCCESS_NOTICE_INACTIVE_HISTORICAL, REFUND_SUCCESS_NOTICE_SQL,
  refundSuccessNoticeCommissionedTx } from '@/migrations/refundSuccessNotice';
import { SUPPLIER_ORDER_PRICE_REVISION_SQL } from '@/migrations/supplierOrderPriceRevision';
import { classifyRoutineVirtualShippingSubjects, ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT,
  ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION } from '@/migrations/routineVirtualShippingSubjects';
const query = (rows: unknown[]) => ({ execute: vi.fn(async () => rows) }) as unknown as Pick<DbClient, 'execute'>;

describe('explicit writeoff notice finite successor contract', () => {
  it('leaves historical standalone SQL bytes fixed and renders the exact new maintenance artifact', () => {
    expect(readFileSync('src/migrations/maintenance/0199_writeoff_notice.sql', 'utf8')).toBe(WRITEOFF_NOTICE_SQL);
    expect(readFileSync('src/migrations/maintenance/0198_refund_success_notice.sql', 'utf8')).toBe(REFUND_SUCCESS_NOTICE_SQL);
    expect(readFileSync('src/migrations/maintenance/0193_supplier_order_price_revision.sql', 'utf8')).toBe(SUPPLIER_ORDER_PRICE_REVISION_SQL);
    expect(WRITEOFF_NOTICE_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|GRANT|CREATE\s+(?:ROLE|TABLE))\b/i);
    expect(WRITEOFF_NOTICE_SQL).toContain('ACCESS EXCLUSIVE MODE NOWAIT');
    expect(WRITEOFF_NOTICE_SQL).toContain('LIMIT 10001');
  });
  it('enumerates exactly four old bases and all five explicit independent addon tails', () => {
    expect(WRITEOFF_NOTICE_EVENT_GENERATIONS).toHaveLength(20);
    expect(new Set(WRITEOFF_NOTICE_EVENT_GENERATIONS.map(g => g.definition)).size).toBe(20);
    expect(WRITEOFF_NOTICE_PREDECESSORS).toHaveLength(8);
    expect(WRITEOFF_NOTICE_SUCCESSORS).toHaveLength(12);
    expect(WRITEOFF_NOTICE_PREDECESSORS).toEqual(expect.arrayContaining([
      ...REFUND_SUCCESS_NOTICE_PREDECESSORS, ...REFUND_SUCCESS_NOTICE_SUCCESSORS]));
    for (const generation of WRITEOFF_NOTICE_EVENT_GENERATIONS) {
      expect(new Set(generation.events).size).toBe(generation.events.length);
      expect(Object.isFrozen(generation)).toBe(true);
      expect(Object.isFrozen(generation.addons)).toBe(true);
      expect(Object.isFrozen(generation.events)).toBe(true);
      expect(writeoffNoticeEventGeneration(generation.definition)).toBe(generation);
    }
  });
  it.each(WRITEOFF_NOTICE_EVENT_GENERATIONS)('classifies exact family $price/$virtual/$addons without enabling another addon', async generation => {
    const rows = [{ definition: generation.definition, safe: true }], db = query(rows);
    expect(await writeoffNoticeCommissionedTx(db)).toBe(generation.addons.includes(WRITEOFF_NOTICE_EVENT));
    expect(await refundSuccessNoticeCommissionedTx(db)).toBe(generation.addons.includes('order.refund.success.notice'));
    const normalized = normalizeWriteoffNoticeEventDefinition(generation.definition);
    expect([...REFUND_SUCCESS_NOTICE_PREDECESSORS, ...REFUND_SUCCESS_NOTICE_SUCCESSORS]).toContain(normalized);
    const classified = classifyRoutineVirtualShippingSubjects({ safe: true, core: true, subject_safe: true, event_safe: true,
      event_definition: generation.definition, subject_columns: generation.virtual ? 2 : 0,
      columns_ready: generation.virtual, indexes: generation.virtual ? 1 : 0, index_ready: generation.virtual,
      subject_definition: generation.virtual ? ROUTINE_VIRTUAL_SHIPPING_SUBJECT_DEFINITION : ROUTINE_VIRTUAL_SHIPPING_OLD_SUBJECT,
      maintenance: 'owned_maintenance', maintenance_oid: '42' });
    expect(classified.failures).toEqual([]);
    expect(classified.state).toBe(generation.virtual ? generation.price ? 'virtual17' : 'virtual16' : generation.price ? 'base15' : 'base14');
    expect(classified.ready).toBe(generation.virtual);
  });
  it.each(REFUND_SUCCESS_NOTICE_INACTIVE_HISTORICAL.map((definition, index) => ({ definition, index })))('keeps known historical generation $index inactive', async ({ definition }) => {
    expect(await writeoffNoticeCommissionedTx(query([{ definition, safe: true }]))).toBe(false);
  });
  it('refuses missing, unsafe, ambiguous and unknown catalogs without rewriting or substring inference', async () => {
    const base = WRITEOFF_NOTICE_EVENT_GENERATIONS[0].definition;
    const malformed = [base + ' OR true', base.replace('order.paid', WRITEOFF_NOTICE_EVENT),
      base.replace('order.paid', 'order.writeoff.notice.evil'), base.replace('order.paid', 'order.paid\",\"order.writeoff.notice'),
      base.replace('order.paid', 'order.paid,order.writeoff.notice'), null, 42];
    for (const definition of malformed) {
      expect(writeoffNoticeEventGeneration(definition)).toBeNull();
      expect(normalizeWriteoffNoticeEventDefinition(definition)).toBe(definition);
      const db = query([{ definition, safe: true }]);
      await expect(writeoffNoticeCommissionedTx(db)).rejects.toMatchObject({ httpStatus: 503 });
      await expect(refundSuccessNoticeCommissionedTx(db)).rejects.toMatchObject({ httpStatus: 503 });
    }
    for (const rows of [[], [{ definition: base, safe: false }], [{ definition: base, safe: true }, { definition: base, safe: true }]]) {
      const db = query(rows);
      await expect(writeoffNoticeCommissionedTx(db)).rejects.toMatchObject({ httpStatus: 503 });
      expect(db.execute).toHaveBeenCalledTimes(1);
    }
  });
});
