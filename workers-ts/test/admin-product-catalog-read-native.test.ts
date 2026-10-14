import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, systemAttachment, systemStore,
  storeProductCategory, userRelation, storeVisit } from '@/models/schema';
import { AdminProductCatalogReadService } from '@/services/admin/AdminProductCatalogReadService';
import { catalogReadSchema, seedCatalogReads, catalogReadActor, catalogReadSnapshot,
  seedCatalogPrivatePictures, pauseCatalogCount } from './helpers/adminProductCatalogReads';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
type NativeData = { count: number; list: Array<Record<string, unknown> & { id: number; count: number; image: string; stock: number | null; slider_image: unknown }> };
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function hasCode(error: unknown, expected: string): boolean {
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if ('code' in error && String(error.code) === expected) return true;
    error = 'cause' in error ? error.cause : undefined;
  } return false;
}
const query = (value = '') => new URLSearchParams(value);
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('main catalogue PG16 SELECT-only LOGIN and native repeatable-read/public media receipts', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => { const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(catalogReadSchema))).join('\n'); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native catalogue contracts forbid remote I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Actual PG16 independent LOGIN peers required');
    await f.exec(ddl); await seedCatalogReads(f.db);
  }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const service = (db: DbClient) => new AdminProductCatalogReadService(createContainerFromDb(db), 'native-catalogue-key');
  const read = (db: DbClient, method: 'list' | 'header' = 'list', options = '', actor = catalogReadActor()) =>
    service(db)[method](query(options), actor) as unknown as Promise<NativeData>;
  async function login<T>(run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async reader => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(reader.role)) throw Error('Unsafe runtime LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${reader.role}"`);
      const [identity] = await reader.exec("SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version");
      expect(identity).toMatchObject({ role: reader.role, session: reader.role, pid: reader.pid });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16); return run(reader);
    });
  }
  async function heldRead(reader: Login, method: 'list' | 'header', mutate: () => Promise<void>, options = '', actor = catalogReadActor()) {
    const ready = signal(), release = signal();
    const hooked = pauseCatalogCount(reader.db, async () => { ready.resolve(); await release.promise; });
    const pending = outcome(read(hooked, method, options, actor));
    try {
      await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Read did not reach actual SQL count boundary'); })]);
      const [activity] = await f.exec(`SELECT state,backend_xmin,query FROM pg_stat_activity WHERE pid=${reader.pid}`) as unknown as Array<{ state: string; backend_xmin: string | null; query: string }>;
      expect(activity.state).toBe('idle in transaction'); expect(activity.backend_xmin).not.toBeNull();
      // Observer is the maintenance connection, never the single held reader pool.
      await mutate();
    } finally { release.resolve(); }
    return pending;
  }

  it('executes both genuine main reads under SELECT-only native LOGIN with no audit/sequence/order/catalogue write privileges and complete business immutability', async () => {
    await login(async reader => {
      const [acl] = await reader.exec(`SELECT has_table_privilege(current_user,'public.store_product','SELECT') AS product_select,
        has_table_privilege(current_user,'public.store_product','UPDATE') AS product_update,
        has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,
        has_table_privilege(current_user,'public.store_product_reply','INSERT') AS review_insert,
        has_table_privilege(current_user,'public.store_order','UPDATE') AS order_update,
        has_sequence_privilege(current_user,pg_get_serial_sequence('public.store_product','id'),'USAGE') AS sequence_usage`);
      expect(acl).toEqual({ product_select: true, product_update: false, audit_insert: false,
        review_insert: false, order_update: false, sequence_usage: false });
      for (const statement of ['UPDATE store_product SET stock=stock WHERE false', 'INSERT INTO system_log(admin_id) VALUES(120)',
        "SELECT nextval(pg_get_serial_sequence('store_product','id'))", 'UPDATE store_order SET status=status WHERE false'])
        await expect(reader.exec(statement)).rejects.toMatchObject({ code: '42501' });
      const before = await catalogReadSnapshot(f.db);
      expect((await read(reader.db)).count).toBe(9); expect((await read(reader.db, 'header')).list).toHaveLength(8);
      for (const id of [121, 122, 129]) expect((await read(reader.db, 'list', '', catalogReadActor(id))).count).toBe(9);
      for (const id of [123, 124, 125, 126, 127, 130]) await expect(read(reader.db, 'list', '', catalogReadActor(id))).rejects.toThrow('权限');
      expect(await catalogReadSnapshot(f.db)).toEqual(before);
    });
  }, 60000);

  it('uses one real repeatable-read snapshot across count, rows, SKU totals, names, relations and private publication metadata', async () => {
    await seedCatalogPrivatePictures(f.db);
    await login(async reader => {
      const before = await read(reader.db), platform = before.list.find(row => row.id === 10)!;
      const result = await heldRead(reader, 'list', async () => {
        await f.db.update(storeProduct).set({ storeName: '并发修改标题', isShow: 0, sales: 20 }).where(eq(storeProduct.id, 10));
        await f.db.update(storeProductAttrValue).set({ stock: 20 }).where(eq(storeProductAttrValue.id, 72));
        await f.db.update(storeProductCategory).set({ cateName: '并发分类名' }).where(eq(storeProductCategory.id, 2));
        await f.db.update(systemStore).set({ name: '并发门店名' }).where(eq(systemStore.id, 30));
        await f.db.insert(userRelation).values({ id: 90, uid: 3, relationId: 10, type: 'collect', category: 'product' });
        await f.db.insert(storeVisit).values({ id: 90, uid: 3, productId: 10, productType: 'product' });
        await f.db.update(systemAttachment).set({ relationId: 20 }).where(eq(systemAttachment.attId, 31));
      });
      expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      expect(result.value.count).toBe(9);
      const row = result.value.list.find(value => 'id' in value && value.id === 10);
      expect(row).toMatchObject({ store_name: '平台保温杯', sales: 7, stock: 11, collect: 2, visitor: 2,
        cate_name: '根分类/子分类' });
      expect(row && 'image' in row ? row.image : '').toMatch(/^\/api\/assets\/31\?expires=\d+&signature=/);
      expect(result.value.list.find(value => 'id' in value && value.id === 30)).toMatchObject({ plate_name: '门店：源门店名称' });
      expect(platform.stock).toBe(11);
      const afterMutation = await catalogReadSnapshot(f.db), fresh = await read(reader.db);
      expect(fresh.count).toBe(8); expect(fresh.list.some(row => row.id === 10)).toBe(false);
      const hidden = await read(reader.db, 'list', 'type=2');
      expect(hidden.list.find(row => row.id === 10)).toMatchObject({ store_name: '并发修改标题', stock: 22,
        collect: 3, visitor: 3, cate_name: '根分类/并发分类名', image: '' });
      expect(await catalogReadSnapshot(f.db)).toEqual(afterMutation);
    });
  }, 60000);

  it('keeps all eight real header counts on one native snapshot and exposes the newly committed product states only on the next read', async () => {
    await login(async reader => {
      const result = await heldRead(reader, 'header', async () => {
        await f.db.update(storeProduct).set({ isShow: 0 }).where(eq(storeProduct.id, 10));
        await f.db.update(storeProduct).set({ isVerify: 1 }).where(eq(storeProduct.id, 15));
      });
      expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      expect(result.value.list.map(row => 'count' in row ? row.count : null)).toEqual([9, 1, 2, 1, 3, 1, 1, 1]);
      const afterMutation = await catalogReadSnapshot(f.db), fresh = await read(reader.db, 'header');
      expect(fresh.list.map(row => row.count)).toEqual([9, 2, 2, 1, 3, 0, 1, 1]);
      expect(await catalogReadSnapshot(f.db)).toEqual(afterMutation);
    });
  }, 60000);

  it('renders authorized native canonical media without R2/HTTP access, blanks foreign/missing/malformed slots and rechecks live metadata on each new snapshot', async () => {
    await seedCatalogPrivatePictures(f.db);
    await f.db.update(storeProduct).set({ sliderImage: '["/api/assets/31","/api/assets/32","/api/assets/999","/api/assets/031","https://external.invalid/api/assets/31"]' })
      .where(eq(storeProduct.id, 10));
    await login(async reader => {
      const before = await catalogReadSnapshot(f.db), first = await read(reader.db);
      const row = first.list.find(value => value.id === 10)!;
      expect(row.image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=/);
      expect(row.slider_image).toEqual([row.image, '', '', '', 'https://external.invalid/api/assets/31']);
      expect(first.list.find(value => value.id === 20)?.image).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
      expect(first.list.find(value => value.id === 30)?.image).toMatch(/^\/api\/assets\/31\?expires=\d+&signature=/);
      expect(await catalogReadSnapshot(f.db)).toEqual(before);
      await f.db.update(systemAttachment).set({ attType: 'text/html' }).where(eq(systemAttachment.attId, 31));
      const changed = await catalogReadSnapshot(f.db), second = await read(reader.db);
      expect(second.list.find(value => value.id === 10)?.image).toBe('');
      expect(second.list.find(value => value.id === 30)?.image).toBe('');
      expect(await catalogReadSnapshot(f.db)).toEqual(changed); expect(fetch).not.toHaveBeenCalled();
    });
  }, 60000);

  it('rejects expiry after real count work using PostgreSQL wall clock, preserves full read-only snapshot and succeeds with a fresh actor', async () => {
    await login(async reader => {
      const before = await catalogReadSnapshot(f.db), expiresAt = Math.floor(Date.now() / 1000) + 2;
      const result = await heldRead(reader, 'list', () => waitForFinanceClock(f.db, expiresAt * 1000), '', { ...catalogReadActor(), expiresAt });
      expect(result.ok).toBe(false); if (result.ok) throw Error('Expired read unexpectedly succeeded');
      expect(String(result.error)).toContain('过期'); expect(await catalogReadSnapshot(f.db)).toEqual(before);
      expect((await read(reader.db)).count).toBe(9);
    });
  }, 60000);

  it('bounds an actual main-table lock wait, proves the exact blocker PID and SQLSTATE, leaves business unchanged and permits a clean retry', async () => {
    await login(reader => f.withPeer!(async blocker => {
      const ready = signal(), release = signal(), before = await catalogReadSnapshot(f.db);
      const hold = outcome(blocker.db.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE store_product IN ACCESS EXCLUSIVE MODE`); ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, hold.then(value => { if (!value.ok) throw value.error; throw Error('Lock boundary was not held'); })]);
      let pending: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
      try {
        pending = outcome(service(reader.db).list(query(), catalogReadActor()));
        await waitForFinanceBlock(f.db, reader.pid, blocker.pid);
        const [activity] = await f.exec(`SELECT wait_event_type,query FROM pg_stat_activity WHERE pid=${reader.pid}`) as unknown as Array<{ wait_event_type: string | null; query: string }>;
        expect(activity.wait_event_type).toBe('Lock'); expect(activity.query).toContain('store_product');
        const failed = await pending; expect(failed.ok).toBe(false);
        if (!failed.ok) expect(hasCode(failed.error, '55P03')).toBe(true);
      } finally { release.resolve(); }
      expect((await hold).ok).toBe(true); if (pending) await pending;
      expect(await catalogReadSnapshot(f.db)).toEqual(before); expect((await read(reader.db)).count).toBe(9);
    }));
  }, 60000);
});
