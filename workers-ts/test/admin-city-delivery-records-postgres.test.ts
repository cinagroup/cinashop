import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeDeliveryOrder, storeOrder, systemStore } from '../src/models/schema';
import { AdminCityDeliveryRecordService } from '../src/services/admin/AdminCityDeliveryRecordService';
import { cityDeliveryRecordFixture, observeCityDeliveryRecordDb } from './helpers/cityDeliveryRecordFixture';

const query = (raw = '') => new URLSearchParams(raw);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native city delivery records read foundation', () => {
  let f: Awaited<ReturnType<typeof cityDeliveryRecordFixture>>;
  beforeEach(async () => { f = await cityDeliveryRecordFixture(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider I/O in record reads')); }, 30_000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30_000);

  it('retains all independent attempts, typed owner labels and historical anomalies without projecting private fields or mutating rows', async () => {
    const before = await f.snapshot(), result = await f.serviceFor().records();
    expect(result).toMatchObject({ total: 10, page: 1, limit: 20 });
    expect(result.items.map(row => row.id)).toEqual([9, 8, 7, 6, 5, 4, 3, 10, 2, 1]);
    const records = new Map(result.items.map(row => [row.id, row]));
    expect(records.get(1)).toMatchObject({ owner: { kind: 'platform', label: '平台' }, status: 0, origin_order: { id: 100, order_id: 'origin-platform' } });
    expect(records.get(2)).toMatchObject({ owner: { kind: 'store', id: 7, label: '北区门店 %_\\', image: '/store-seven.png' }, origin_order: { id: 101, pid: 100 }, distance_meters: 1320.5, distance_km: '1.3205', fee: '2.10', mark: '本地备注' });
    expect(records.get(3)).toMatchObject({ owner: { kind: 'supplier', id: 42, label: '供应商四十二', image: '/supplier.png' }, origin_order: { id: 102 } });
    expect(records.get(3)?.issues).toEqual(['owner_hidden', 'owner_deleted']);
    expect(records.get(4)?.issues).toEqual(['owner_hidden', 'owner_deleted', 'origin_order_deleted']);
    expect(records.get(5)).toMatchObject({ origin_order: null, issues: ['owner_missing', 'origin_order_missing'] });
    expect(records.get(6)).toMatchObject({ origin_order: null, issues: ['status_ambiguous', 'origin_uid_mismatch'] });
    expect(records.get(7)).toMatchObject({ origin_order: null, issues: ['origin_owner_mismatch'] });
    expect(records.get(8)).toMatchObject({ owner: { kind: 'unknown', image: null }, origin_order: null, status_label: '未知状态 (32767)', fee: null, distance_meters: null, invalid_values: { fee: 'NaN', distance_meters: 'NaN' } });
    expect(records.get(9)).toMatchObject({ origin_order: null, distance_meters: null, invalid_values: { distance_meters: '-1' } });
    const detail = await f.serviceFor().detail('2');
    expect(detail.record).toEqual(records.get(2));
    expect(detail.metadata).toEqual({ city_code: '旧城市', mer_id: 9, mark: '本地备注', reason: '', receiver_name: '快照收件人', receiver_phone: '13800138000', from_address: '发货快照', to_address: '收货快照' });
    for (const secret of ['finish_code', 'private-finish-code', 'private-coordinate', 'private-store-bank', 'private-supplier-bank', 'foreign-uid-order', 'foreign-owner-order']) expect(JSON.stringify({ result, detail })).not.toContain(secret);
    expect(await f.snapshot()).toEqual(before);
  });
  it('uses literal contains across provider identifiers and trusted origin numbers, preserving zero/unknown statuses and inclusive timestamps', async () => {
    const service = f.serviceFor();
    expect((await service.records(new URLSearchParams({ keyword: '%_\\' }))).items.map(row => row.id)).toEqual([10, 2]);
    expect((await service.records(new URLSearchParams({ keyword: 'foreign-uid-order' }))).total).toBe(0);
    expect((await service.records(new URLSearchParams({ keyword: 'foreign-owner-order' }))).total).toBe(0);
    expect((await service.records(query('keyword=provider-uid-conflict'))).items[0].origin_order).toBeNull();
    for (const [status, id] of [[0, 1], [1, 6], [-1, 5], [32767, 8]]) expect((await service.records(query(`status=${status}`))).items.map(row => row.id)).toEqual([id]);
    expect((await service.records(query('station_type=2'))).items.map(row => row.id)).toEqual([3]);
    expect((await service.records(query('store_id=42'))).total).toBe(0);
    expect((await service.records(query('store_id=7'))).items.map(row => row.id)).toEqual([7, 6, 10, 2]);
    expect((await service.records(query('date_from=200&date_to=200'))).items.map(row => row.id)).toEqual([10, 2]);
    expect((await service.records(query('page=2&limit=3'))).items.map(row => row.id)).toEqual([6, 5, 4]);
    await expect(service.detail('999')).rejects.toThrow('配送记录不存在');
    // A current platform pickup store_id is not proof of the old delivery's
    // fulfillment station. Preserve that distinction without relaxing masking.
    await f.db.insert(storeOrder).values({ id: 106, uid: 77, orderId: 'current-pickup-private-number', supplierId: 0, storeId: 7, shippingType: 2 });
    await f.db.insert(storeDeliveryOrder).values({ id: 11, oid: 106, uid: 77, type: 0, relationId: 0, stationType: 1, orderId: 'legacy-platform-pickup', addTime: 900 });
    const pickup = await service.detail('11');
    expect(pickup.record).toMatchObject({ origin_order: null, issues: ['origin_owner_unverified'] });
    expect(JSON.stringify(pickup)).not.toContain('current-pickup-private-number');
    expect((await service.records(query('keyword=current-pickup-private-number'))).total).toBe(0);
  });
  it('bounds store choices in SQL and retains hidden/deleted labels without generic store secrets', async () => {
    await f.db.insert(systemStore).values(Array.from({ length: 65 }, (_, i) => ({ id: 1000 + i, name: `分页店${i}`, isShow: 1 })));
    const service = f.serviceFor(), first = await service.stores(query('limit=50')), second = await service.stores(query('limit=50&page=2'));
    expect(first.total).toBe(68); expect(first.items).toHaveLength(50); expect(second.items).toHaveLength(18);
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(68);
    expect(first.items.find(row => row.id === 8)).toMatchObject({ is_show: 0, is_del: 1, issues: ['owner_hidden', 'owner_deleted'] });
    const literal = await service.stores(new URLSearchParams({ keyword: '%_\\' })); expect(literal.total).toBe(1); expect(literal.items[0].id).toBe(7);
    expect(JSON.stringify(first)).not.toContain('private-store-bank');
  });
  it('executes all reads on actual independent nonowner Admin/app LOGINs with SELECT only and no DDL authority', async () => {
    const before = await f.snapshot();
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installReadSlice(app, admin);
      for (const peer of [app, admin]) {
        const service = f.serviceFor(peer.db);
        expect((await service.records()).total).toBe(10); expect((await service.detail('3')).record.owner.kind).toBe('supplier'); expect((await service.stores()).total).toBe(3);
        const [identity] = await peer.exec("SELECT current_user AS role,session_user AS session,has_table_privilege(current_user,'store_delivery_order','SELECT') AS readable,has_table_privilege(current_user,'store_delivery_order','UPDATE') AS writable,has_schema_privilege(current_user,'public','CREATE') AS ddl");
        expect(identity).toEqual({ role: peer.role, session: peer.role, readable: true, writable: false, ddl: false });
        await expect(peer.db.update(storeDeliveryOrder).set({ mark: 'forbidden' }).where(eq(storeDeliveryOrder.id, 2))).rejects.toMatchObject({ cause: { code: '42501' } });
      }
    }));
    expect(await f.snapshot()).toEqual(before);
  });
  it('preserves stricter deadlines in real RR READ ONLY transactions and restores session settings', async () => {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installReadSlice(app, admin);
      await admin.exec("SET statement_timeout='1s'; SET lock_timeout='500ms'; SET idle_in_transaction_session_timeout='1500ms'");
      const settings = sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,
        (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement,
        (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock,
        (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle`;
      const baseline = await admin.db.execute(settings), states: unknown[] = [];
      for (const run of [(service: AdminCityDeliveryRecordService) => service.records(), (service: AdminCityDeliveryRecordService) => service.detail('2'), (service: AdminCityDeliveryRecordService) => service.stores()]) {
        let executes = 0;
        const service = new AdminCityDeliveryRecordService(createContainerFromDb(observeCityDeliveryRecordDb(admin.db, async (tx, command) => {
          if (command === 'execute' && ++executes === 2) states.push((await tx.execute(settings))[0]);
        })));
        await run(service);
      }
      expect(states).toHaveLength(3); for (const state of states) expect(state).toEqual({ isolation: 'repeatable read', readonly: 'on', statement: 1000, lock: 500, idle: 1500 });
      expect(await admin.db.execute(settings)).toEqual(baseline);
    }));
    let attempted = false;
    const before = await f.snapshot(), service = new AdminCityDeliveryRecordService(createContainerFromDb(observeCityDeliveryRecordDb(f.db, async (tx, command) => {
      if (command === 'execute' && !attempted) { attempted = true; await tx.update(storeDeliveryOrder).set({ mark: 'must rollback' }).where(eq(storeDeliveryOrder.id, 2)); }
    })));
    await expect(service.detail('2')).rejects.toMatchObject({ cause: { code: '25006' } }); expect(attempted).toBe(true); expect(await f.snapshot()).toEqual(before);
  });
  it('keeps native count/list in one snapshot when a genuine independent writer adds a matching attempt or store between queries', async () => {
    await f.withRuntimeRole(app => f.withRuntimeRole(async admin => {
      await f.installReadSlice(app, admin);
      await f.withPeer(async writer => {
        let inserted = false;
        const service = new AdminCityDeliveryRecordService(createContainerFromDb(observeCityDeliveryRecordDb(admin.db, async (_tx, command) => {
          if (!inserted && command.includes('count(*)::integer') && command.includes('"store_delivery_order"')) {
            inserted = true; await writer.db.insert(storeDeliveryOrder).values({ id: 99, oid: 100, uid: 77, orderId: 'provider-platform-late', stationType: 1, type: 0, relationId: 0, addTime: 999 });
          }
        })));
        const result = await service.records(query('keyword=provider-platform')); expect(inserted).toBe(true); expect(result.total).toBe(1); expect(result.items.map(row => row.id)).toEqual([1]);
        expect((await f.serviceFor(admin.db).records(query('keyword=provider-platform'))).total).toBe(2);
        let storeInserted = false;
        const stores = new AdminCityDeliveryRecordService(createContainerFromDb(observeCityDeliveryRecordDb(admin.db, async (_tx, command) => {
          if (!storeInserted && command.includes('count(*)::integer') && command.includes('"system_store"')) { storeInserted = true; await writer.db.insert(systemStore).values({ id: 99, name: '历史隐藏门店 late' }); }
        })));
        const choices = await stores.stores(query('keyword=历史隐藏门店')); expect(storeInserted).toBe(true); expect(choices.total).toBe(1); expect(choices.items.map(row => row.id)).toEqual([8]);
        expect((await f.serviceFor(admin.db).stores(query('keyword=历史隐藏门店'))).total).toBe(2);
      });
    }));
  });
});
