import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { storeOrder } from '../src/models/schema/order';
import { AdminAssistedOrderService } from '../src/services/admin/AdminAssistedOrderService';
import { financePostgres } from './helpers/financePostgres';

type Fixture = Awaited<ReturnType<typeof financePostgres>>;
type OrderInsert = typeof storeOrder.$inferInsert;
type ListRow = { id: number; order_id: string; add_time: number; pid: number };
type CursorPage = { list: ListRow[]; next_cursor: string | null; has_more: boolean };

const STAFF = 11;
const OTHER_STAFF = 22;

function order(id: number, orderId: string, overrides: Partial<OrderInsert> = {}): OrderInsert {
  return {
    id, orderId, uid: 501, staffId: STAFF, isChannel: 2, isDel: 0, isSystemDel: 0,
    pid: 0, addTime: 1000, paid: 1, refundStatus: 0, status: 0, shippingType: 1,
    ...overrides,
  };
}

describe('assisted cursor source boundary', () => {
  const serviceSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),
    '../src/services/admin/AdminAssistedOrderService.ts'), 'utf8');
  const method = serviceSource.split('async placeList(adminId: number')[1]?.split('/** Minimal actor-scoped mobile detail')[0] ?? '';

  it('keeps actor and deletion predicates on both keyset and legacy reads', () => {
    expect(method).toContain('eq(storeOrder.staffId, adminId)');
    expect(method).toContain('eq(storeOrder.isChannel, 2)');
    expect(method).toContain('eq(storeOrder.isSystemDel, 0)');
    expect(method).toContain('eq(storeOrder.isDel, 0)');
    expect(method).toContain('sql<boolean>`(${storeOrder.addTime}, ${storeOrder.id}) < (${cursor.addTime}, ${cursor.id})`');
    expect(method).toContain('.orderBy(desc(storeOrder.addTime), desc(storeOrder.id))');
    expect(method).toContain('.limit(limit + (cursorMode ? 1 : 0))');
  });

  it('validates the position before SQL and reads only the bounded public projection', () => {
    expect(method.indexOf('assistedListCursor(query.cursor)')).toBeGreaterThan(-1);
    expect(method.indexOf('assistedListCursor(query.cursor)')).toBeLessThan(method.indexOf('await withTx('));
    expect(method).toContain('SET TRANSACTION READ ONLY');
    expect(method).toContain("set_config('statement_timeout'");
    const projection = method.split('const selection = db.select({')[1]?.split('}).from(storeOrder)')[0] ?? '';
    expect(projection).toContain('orderId: storeOrder.orderId');
    for (const privateField of ['realName:', 'userPhone:', 'userAddress:', 'cartId:', 'virtualInfo:', 'refundReason:']) {
      expect(projection).not.toContain(privateField);
    }
  });
});

// The fixture refuses PGlite: these tests assert native PostgreSQL transaction
// semantics in a random, runner-owned local database only.
describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('assisted order cursor on native PostgreSQL 16', () => {
  let fixture: Fixture;
  let service: AdminAssistedOrderService;

  const cursor = async (query: Record<string, string> = {}): Promise<CursorPage> =>
    await service.placeList(STAFF, { paging: 'cursor', ...query }) as CursorPage;
  const ids = (page: CursorPage) => page.list.map(row => row.id);

  beforeAll(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    fixture = await financePostgres([storeOrder]);
  }, 30_000);

  beforeEach(async () => {
    await fixture.reset();
    await fixture.db.insert(storeOrder).values([
      order(90, 'CUR_A_OLD', { addTime: 900 }),
      order(101, 'CUR_A_TIE_1'),
      order(102, 'CUR_A_TIE_2'),
      order(103, 'CUR_A_TIE_3'),
      order(104, 'CUR_A_SPLIT_ROOT', { pid: -1, addTime: 800, refundStatus: 1 }),
      order(105, 'CUR_A_REFUND_CHILD', { pid: 104, addTime: 1200, refundStatus: 1 }),
      order(201, 'CUR_B_FOREIGN', { staffId: OTHER_STAFF, addTime: 1300 }),
      order(202, 'CUR_NON_CHANNEL', { isChannel: 0, addTime: 1400 }),
      order(203, 'CUR_A_DELETED', { isDel: 1, addTime: 1500 }),
      order(204, 'CUR_A_SYSTEM_DELETED', { isSystemDel: 1, addTime: 1600 }),
    ]);
    service = new AdminAssistedOrderService(createContainerFromDb(fixture.db), {} as Env);
  });

  afterAll(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await fixture?.close(); }
  });

  it('uses add_time/id keyset order without duplicates across equal timestamps or a new head insert', async () => {
    const first = await cursor({ limit: '2' });
    expect(ids(first)).toEqual([103, 102]);
    expect(first).toMatchObject({ has_more: true, next_cursor: '1000:102' });
    await fixture.db.insert(storeOrder).values(order(300, 'CUR_A_NEW_HEAD', { addTime: 1700 }));

    const second = await cursor({ limit: '2', cursor: first.next_cursor! });
    expect(ids(second)).toEqual([101, 90]);
    expect(second.next_cursor).toBe('900:90');
    const third = await cursor({ limit: '2', cursor: second.next_cursor! });
    expect(ids(third)).toEqual([104]);
    expect(third).toMatchObject({ has_more: false, next_cursor: null });
    expect(new Set([...first.list, ...second.list, ...third.list].map(row => row.id)).size).toBe(5);
    expect(ids(await cursor({ limit: '2' }))).toEqual([300, 103]);
  });

  it('reapplies staff/channel/system-deletion scope for every cursor including a foreign position', async () => {
    const forged = await cursor({ cursor: '2147483647:2147483647', limit: '100' });
    expect(ids(forged)).toEqual([103, 102, 101, 90, 104]);
    expect(forged.list.every(row => row.order_id.startsWith('CUR_A_'))).toBe(true);
    expect(ids(await cursor({ cursor: '1300:201', limit: '100' }))).toEqual([103, 102, 101, 90, 104]);
    expect(ids(await cursor({ cursor: '1000:103', limit: '100' }))).toEqual([102, 101, 90, 104]);
    const other = await service.placeList(OTHER_STAFF, { paging: 'cursor', limit: '100' }) as CursorPage;
    expect(ids(other)).toEqual([201]);
  });

  it('includes refund child orders only in the relevant status view and preserves status across pages', async () => {
    expect(ids(await cursor({ limit: '100' }))).not.toContain(105);
    const first = await cursor({ status: '-3', limit: '1' });
    expect(ids(first)).toEqual([105]);
    expect(first).toMatchObject({ has_more: true, next_cursor: '1200:105' });
    const second = await cursor({ status: '-3', limit: '1', cursor: first.next_cursor! });
    expect(ids(second)).toEqual([104]);
    expect(second).toMatchObject({ has_more: false, next_cursor: null });
    expect(ids(await cursor({ status: '-3', is_del: '1', limit: '100' }))).toEqual([]);
  });

  it('returns only staff-owned soft-deleted roots for status -4 and never system-deleted rows', async () => {
    const deleted = await cursor({ status: '-4', limit: '1' });
    expect(ids(deleted)).toEqual([203]);
    expect(deleted).toMatchObject({ has_more: false, next_cursor: null });
    expect(ids(await cursor({ is_del: '1', limit: '100' }))).toEqual([203]);
    expect(ids(await cursor({ status: '-4', is_del: '0', limit: '100' }))).toEqual([]);
  });

  it('rejects malformed positions, mixed pagination, and deep legacy offsets before a transaction', async () => {
    const transaction = vi.spyOn(fixture.db, 'transaction');
    const invalid: Record<string, string>[] = [
      { paging: 'cursor', cursor: 'bogus' }, { paging: 'cursor', cursor: '1:0' },
      { paging: 'cursor', cursor: '1:-1' }, { paging: 'cursor', cursor: '2147483648:1' },
      { paging: 'cursor', cursor: '1:2147483648' }, { paging: 'cursor', cursor: '1:1:1' },
      { paging: 'cursor', cursor: '1:1', page: '1' }, { cursor: '1:1' },
      { paging: 'offset' }, { page: '10002', limit: '1' }, { page: '102', limit: '100' },
    ];
    try {
      for (const query of invalid) {
        await expect(service.placeList(STAFF, query)).rejects.toMatchObject({ code: 400 });
      }
      expect(transaction).not.toHaveBeenCalled();
    } finally { transaction.mockRestore(); }
  });

  it('keeps legacy page mode as an array with deterministic shallow pages and a 10000-row cap', async () => {
    const first = await service.placeList(STAFF, { page: '1', limit: '2' });
    const second = await service.placeList(STAFF, { page: '2', limit: '2' });
    expect(Array.isArray(first)).toBe(true);
    expect(Array.isArray(second)).toBe(true);
    expect((first as ListRow[]).map(row => row.id)).toEqual([103, 102]);
    expect((second as ListRow[]).map(row => row.id)).toEqual([101, 90]);
    expect(await service.placeList(STAFF, { page: '10001', limit: '1' })).toEqual([]);
  });

  it('sets a transaction-local read-only boundary and 5s timeout without leaking either setting', async () => {
    const originalTransaction = fixture.db.transaction.bind(fixture.db);
    const observed: Array<{ readonly: string; timeout: string }> = [];
    const observedTransaction: typeof fixture.db.transaction = (callback, config) => originalTransaction(async tx => {
      const result = await callback(tx);
      const [settings] = Array.from(await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
        current_setting('statement_timeout') AS timeout`)) as Array<{ readonly: string; timeout: string }>;
      observed.push(settings);
      const writeFailure = await tx.transaction(nested => nested.execute(sql`UPDATE ${storeOrder} SET status=9 WHERE id=101`))
        .then(() => null, error => error as { code?: string; cause?: { code?: string } });
      expect(writeFailure?.code ?? writeFailure?.cause?.code).toBe('25006');
      return result;
    }, config);
    const wrapped = new Proxy(fixture.db, { get: (target, key, receiver) =>
      key === 'transaction' ? observedTransaction : Reflect.get(target, key, receiver) });
    const guarded = new AdminAssistedOrderService(createContainerFromDb(wrapped), {} as Env);
    const before = Array.from(await fixture.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
      current_setting('statement_timeout') AS timeout`));
    const page = await guarded.placeList(STAFF, { paging: 'cursor', limit: '2' }) as CursorPage;
    expect(ids(page)).toEqual([103, 102]);
    expect(observed).toEqual([{ readonly: 'on', timeout: '5s' }]);
    expect(Array.from(await fixture.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,
      current_setting('statement_timeout') AS timeout`))).toEqual(before);
    expect((await fixture.db.select({ status: storeOrder.status }).from(storeOrder)
      .where(sql`${storeOrder.id}=101`))[0]?.status).toBe(0);
  });
});
