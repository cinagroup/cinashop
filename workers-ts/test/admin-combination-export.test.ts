import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { storeCombination, storePink, storeProduct } from '../src/models/schema';
import { AdminCombinationExportService, COMBINATION_EXPORT_HEADER, COMBINATION_EXPORT_KEYS } from '../src/services/admin/AdminCombinationExportService';
import { financePostgres } from './helpers/financePostgres';
import { combinationAdminFixture, combinationInput } from './helpers/combinationAdminFixture';

function csv(manifest: Awaited<ReturnType<AdminCombinationExportService['manifest']>>, rows = manifest.export) {
  return '\ufeff' + [manifest.header, ...rows.map(row => manifest.filekey.map(key => row[key]))]
    .map(cells => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',') + '\r\n').join('');
}

describe('Complete bounded Admin combination export manifest SQL', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: AdminCombinationExportService;
  const query = (values: Record<string, string> = {}) => service.manifest(new URLSearchParams(values));
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await financePostgres([storeCombination, storeProduct, storePink]);
    service = new AdminCombinationExportService(createContainerFromDb(f.db));
  }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const seed = async (extra: Partial<typeof storeCombination.$inferInsert> = {}) => {
    const [row] = await f.db.insert(storeCombination).values({ productId: 101, storeName: '历史拼团', price: '3.01', otPrice: '99.00',
      stock: 9, sales: 4, people: 88, startTime: new Date('2020-01-01T00:00:00Z'), stopTime: new Date('2099-01-01T02:03:04Z'), ...extra }).returning();
    return row.id;
  };

  it('keeps eleven PHP column semantics with explicit leader/record labels, fixed keys and empty-set BOM/header bytes', async () => {
    const result = await query();
    expect(result).toMatchObject({ header: [...COMBINATION_EXPORT_HEADER], filekey: [...COMBINATION_EXPORT_KEYS], export: [],
      filename: '拼团商品导出', count: 0, page: 1, limit: 1000, has_more: false, timezone: 'Asia/Shanghai', max_rows: 100000, max_bytes: 16777216 });
    expect(result.header).toEqual(['编号', '拼团名称', '划线价', '拼团价', '库存', '开团数', '参与记录数', '成团数量', '销量', '商品状态', '结束时间']);
    expect(result.filekey).toEqual(['id', 'title', 'ot_price', 'price', 'stock', 'people', 'count_people_all', 'count_people_pink', 'sales', 'is_show', 'stop_time']);
    expect(result.snapshot).toMatch(/^[a-f0-9]{64}$/); expect(result.csv_bytes).toBe(new TextEncoder().encode(csv(result)).byteLength);
    expect(await query({ snapshot: result.snapshot })).toEqual(result);
  });

  it('reads activity price, current base strike price and raw leader/all/success counts independently', async () => {
    await f.db.insert(storeProduct).values({ id: 101, price: '10.00', otPrice: '23.45' }); const id = await seed();
    await f.db.insert(storePink).values([{ combinationId: id, kId: 0, status: 1, uid: 5 },
      { combinationId: id, kId: 0, status: 2, uid: 5, isRefund: 8 }, { combinationId: id, kId: 8, status: 2, uid: 0, isVirtual: 1 },
      { combinationId: id, kId: 8, status: 3, uid: 5 }, { combinationId: id + 1, kId: 0, status: 2 }]);
    const result = await query();
    expect(result.export).toEqual([{ id: String(id), title: '历史拼团', ot_price: '23.45', price: '3.01', stock: '9', people: '2',
      count_people_all: '4', count_people_pink: '1', sales: '4', is_show: '开启', stop_time: '2099-01-01 10:03:04' }]);
    expect(Object.values(result.export[0]).every(cell => typeof cell === 'string')).toBe(true);
    await f.db.delete(storeProduct).where(eq(storeProduct.id, 101));
    const missing = await query(); expect(missing.count).toBe(1); expect(missing.export[0].ot_price).toBe('');
    expect(missing.snapshot).not.toBe(result.snapshot);
  });

  it('returns every requested page after 1000 rows in stable sort/id order with exact total bytes', async () => {
    await f.exec("INSERT INTO store_combination(store_name,sort,price,stop_time) SELECT '导出'||n,n%3,1.23,'2030-01-01'::timestamp FROM generate_series(1,1007) n");
    const first = await query(), second = await query({ page: '2', snapshot: first.snapshot });
    expect(first.export).toHaveLength(1000); expect(first.has_more).toBe(true);
    expect(second).toMatchObject({ count: 1007, page: 2, has_more: false, snapshot: first.snapshot, csv_bytes: first.csv_bytes });
    expect(second.export).toHaveLength(7);
    const ids = [...first.export, ...second.export].map(row => Number(row.id));
    const expected = Array.from({ length: 1007 }, (_, index) => index + 1).sort((a, b) => b % 3 - a % 3 || b - a);
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(1007);
    expect(first.csv_bytes).toBe(new TextEncoder().encode(csv(first, [...first.export, ...second.export])).byteLength);
  }, 30000);

  it('matches literal keyword, id, phase and independent status filtering and excludes deleted rows', async () => {
    const literal = await seed({ storeName: '价格%_\\匹配', status: 0, isShow: 1 }), normal = await seed({ storeName: '价格123匹配', status: 1, isShow: 0 });
    await seed({ storeName: '删除', isDel: 1 }); await seed({ storeName: '未来', startTime: new Date('2090-01-01Z') });
    await seed({ storeName: '结束', stopTime: new Date('2020-02-01Z') }); await seed({ storeName: '异常', startTime: null });
    expect((await query({ keyword: '%_\\' })).export.map(row => row.id)).toEqual([String(literal)]);
    expect((await query({ keyword: String(normal), status: '1', phase: 'active' })).export[0]).toMatchObject({ id: String(normal), is_show: '关闭' });
    expect((await query({ status: '0', phase: 'active' })).count).toBe(1);
    for (const phase of ['future', 'ended', 'invalid']) expect((await query({ phase })).count).toBe(1);
    expect((await query({ status: '' })).count).toBe(5);
  });

  it.each([
    ['main price', 'UPDATE store_combination SET price=7 WHERE id=1'],
    ['main non-exported version', "UPDATE store_combination SET info='new' WHERE id=1"],
    ['base price', 'UPDATE store_product SET ot_price=33 WHERE id=101'],
    ['base version', "UPDATE store_product SET store_name='new' WHERE id=101"],
    ['sort', 'UPDATE store_combination SET sort=20 WHERE id=1'],
    ['new pink', 'INSERT INTO store_pink(combination_id,k_id,status) VALUES(1,0,2)'],
    ['refund/virtual pink', 'INSERT INTO store_pink(combination_id,k_id,status,is_refund,is_virtual,uid) VALUES(1,10,3,10,1,0)'],
    ['deleted member', 'UPDATE store_combination SET is_del=1 WHERE id=1'],
    ['new row', "INSERT INTO store_combination(store_name) VALUES('new')"],
  ])('rejects further pages after a %s change anywhere in the result', async (_name, change) => {
    await f.db.insert(storeProduct).values({ id: 101, otPrice: '20.00' }); await seed(); await seed();
    const first = await query({ limit: '1' }); await f.exec(change);
    await expect(query({ limit: '1', page: '2', snapshot: first.snapshot })).rejects.toThrow('已变化');
  });

  it('binds the normalized filters and page size, and requires a snapshot for subsequent pages', async () => {
    await seed(); await seed(); const first = await query({ limit: '1' });
    for (const changed of [{ phase: 'active' }, { status: '1' }, { keyword: '历史' }, { limit: '2' }] as Record<string, string>[]) {
      await expect(query({ limit: '1', snapshot: first.snapshot, ...changed })).rejects.toThrow('已变化');
    }
    await expect(query({ page: '2', limit: '1' })).rejects.toThrow('快照');
    await expect(query({ page: '3', limit: '1', snapshot: first.snapshot })).rejects.toThrow('页码');
  });

  it('rejects a changed phase result when time crosses a boundary between export pages', async () => {
    await seed({ stopTime: new Date('2030-01-01T00:00:00Z') }); await seed();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2029-12-31T23:59:59Z'));
      const first = await query({ phase: 'active', limit: '1' });
      vi.setSystemTime(new Date('2030-01-01T00:00:01Z'));
      await expect(query({ phase: 'active', limit: '1', page: '2', snapshot: first.snapshot })).rejects.toThrow('已变化');
    } finally { vi.useRealTimers(); }
  });

  it('protects formula-like titles without truncating commas, quotes, Unicode or embedded newlines', async () => {
    const titles = ['=1+2', ' \t@SUM(1)', '\u00a0+1', '\u2007-1', '\u200b=1', '\ufeff=1', '\tplain', '\rplain', '\nplain', '普通,"中文"\r\n第二行😀'];
    for (const storeName of titles) await seed({ storeName });
    const result = await query();
    expect(result.export.map(row => row.title)).toEqual([...titles].reverse().map(title => title === titles.at(-1) ? title : `'${title}`));
    expect(result.csv_bytes).toBe(new TextEncoder().encode(csv(result)).byteLength);
    expect((await query({ snapshot: result.snapshot })).export).toEqual(result.export);
  });

  it('uses Shanghai dates independently of database timezone and keeps invalid times empty', async () => {
    await seed(); await seed({ stopTime: null }); await f.exec("INSERT INTO store_combination(stop_time) VALUES('infinity')");
    // SET LOCAL runs before each read transaction without relying on pool affinity.
    const observed = new Proxy(f.db, { get(target, property) {
      if (property === 'transaction') return (callback: (db: DbClient) => Promise<unknown>) => target.transaction(async tx => {
        await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Honolulu'`); return callback(tx as unknown as DbClient);
      });
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const original = await query(), shifted = await new AdminCombinationExportService(createContainerFromDb(observed)).manifest(new URLSearchParams());
    expect(shifted).toEqual(original); expect(original.export.map(row => row.stop_time)).toEqual(['', '', '2099-01-01 10:03:04']);
  });

  it('refuses non-finite money rather than serializing an invalid decimal', async () => {
    await seed(); await f.exec("UPDATE store_combination SET price='NaN'"); await expect(query()).rejects.toThrow('价格无效');
  });

  it('validates strict query shapes before starting any database read', async () => {
    const transact = vi.spyOn(f.db, 'transaction');
    for (const bad of ['page=0', 'page=01', 'page=1.5', 'page=-1', 'limit=0', 'limit=1001', 'page=101', 'status=2', 'phase=bad', 'keyword=%00',
      'keyword=' + 'x'.repeat(101), 'unknown=1', 'page=1&page=2', 'snapshot=', 'snapshot=' + 'f'.repeat(63)]) {
      await expect(service.manifest(new URLSearchParams(bad)), bad).rejects.toThrow();
    }
    expect(transact).not.toHaveBeenCalled();
  });

  it('keeps count, whole-set fingerprint and the bounded page in one actual read-only RR transaction', async () => {
    await seed(); let transactions = 0, statements = 0;
    const observed = new Proxy(f.db, { get(target, property) {
      if (property === 'select' || property === 'execute') throw Error('Read outside snapshot');
      if (property === 'transaction') return (callback: (db: DbClient) => Promise<unknown>) => target.transaction(async tx => {
        transactions++;
        const reader = new Proxy(tx, { get(inner, method) { const value = Reflect.get(inner, method);
          if (method === 'execute') return (...args: unknown[]) => { statements++; return Reflect.apply(value, inner, args); };
          return typeof value === 'function' ? value.bind(inner) : value;
        } }) as unknown as DbClient;
        const result = await callback(reader);
        const [settings] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,
          current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle`);
        expect(settings).toMatchObject({ isolation: 'repeatable read', readonly: 'on', statement: '5s', lock: '2s', idle: '5s' });
        return result;
      });
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await new AdminCombinationExportService(createContainerFromDb(observed)).manifest(new URLSearchParams());
    expect(transactions).toBe(1); expect(statements).toBe(4);
  });

  it('rejects an exact count above 100000 without fetching or hashing the oversized dataset', async () => {
    await f.exec("INSERT INTO store_combination(store_name) SELECT 'row'||n FROM generate_series(1,100001) n");
    let executions = 0;
    const observed = new Proxy(f.db, { get(target, property) {
      if (property === 'transaction') return (callback: (db: DbClient) => Promise<unknown>) => target.transaction(tx => callback(new Proxy(tx, {
        get(inner, method) { const value = Reflect.get(inner, method); if (method === 'execute') return (...args: unknown[]) => { executions++; return Reflect.apply(value, inner, args); };
          return typeof value === 'function' ? value.bind(inner) : value; }
      }) as unknown as DbClient));
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(new AdminCombinationExportService(createContainerFromDb(observed)).manifest(new URLSearchParams())).rejects.toThrow('100000行');
    expect(executions).toBe(2);
  }, 30000);

  it('rejects total CSV bytes above 16MiB instead of truncating before later pages', async () => {
    await f.exec("INSERT INTO store_combination(store_name) SELECT repeat('界',256) FROM generate_series(1,22000)");
    await expect(query()).rejects.toThrow('16MiB');
  }, 30000);

  it('rejects a single oversized JSON response even when the complete CSV is below 16MiB', async () => {
    await f.exec('ALTER TABLE store_combination ALTER COLUMN store_name TYPE text');
    await f.exec("INSERT INTO store_combination(store_name) SELECT repeat('x',6000) FROM generate_series(1,750)");
    await expect(query()).rejects.toThrow('4MiB');
  }, 30000);
});

describe('Admin combination summary read projection compatibility', () => {
  it('adds prices and PHP count aliases while preserving configuration people and SKU price sources', async () => {
    const f = await combinationAdminFixture();
    try {
      const { id } = await f.service.mutate('create', 0, combinationInput(), { id: 2 });
      await f.db.insert(storePink).values([{ combinationId: id, kId: 0, status: 2 }, { combinationId: id, kId: 7, uid: 0, isVirtual: 1, isRefund: 7 }]);
      const detail = await f.service.detail(id), list = await f.service.list(new URLSearchParams());
      for (const row of [detail, list.list[0]]) expect(row).toMatchObject({ people: 3, price: '5.00', ot_price: '20.00', count_people: 1,
        count_people_all: 2, count_people_pink: 1, group_count: 1, completed_group_count: 1 });
      expect(detail.skus[0].ot_price).toBe('10.00');
      await f.db.delete(storeProduct).where(eq(storeProduct.id, 101));
      expect((await f.service.list(new URLSearchParams())).list[0]).toMatchObject({ id, ot_price: '', price: '5.00' });
    } finally { await f.close(); }
  }, 30000);
});
