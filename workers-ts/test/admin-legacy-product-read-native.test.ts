import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableName } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductAttrResult, storeProductDescription, storeProductVirtual,
  storeProductCategory, shippingTemplates, systemForm, systemAdmin, systemRole, systemMenus } from '@/models/schema';
import { AdminLegacyProductReadService } from '@/services/admin/AdminLegacyProductReadService';
import { legacySaveActor, legacySaveSchema } from './helpers/adminLegacyProductSave';
import { pauseSupplierOptionsRead } from './helpers/adminProductSupplierOptions';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const form = (title: string) => [{ id: 'field1', name: 'texts', titleConfig: { value: title },
  tipConfig: { value: '提示' }, titleShow: { val: true }, value: '' }];
const read = (db: DbClient, id = 10, actor = legacySaveActor()) =>
  new AdminLegacyProductReadService(createContainerFromDb(db)).detail(id, new URLSearchParams(), actor);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 legacy editor GET restricted column LOGIN, RR snapshot and database expiry', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(legacySaveSchema))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native editor GET forbids provider I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Owned PG16 LOGIN and independent peers required');
    await f.exec(ddl);
    await f.db.insert(systemRole).values({ id: 1, rules: '620' });
    await f.db.insert(systemAdmin).values({ id: 1, account: 'editor-read-native', pwd: 'legacy-save-password', roles: '1', level: 1 });
    await f.db.insert(systemMenus).values({ id: 620, authType: 2, apiUrl: 'product/product/<id>', methods: 'GET', menuPath: '', uniqueAuth: '' });
    await f.db.insert(storeProductCategory).values({ id: 1, cateName: '读取前分类' });
    await f.db.insert(shippingTemplates).values({ id: 1, name: '读取前运费' });
    await f.db.insert(systemForm).values({ id: 1, name: '表单', status: 1, value: JSON.stringify(form('读取前表单')) });
    await f.db.insert(storeProduct).values({ id: 10, productType: 1, specType: 0, storeName: '读取前商品', stock: 1,
      price: '12.50', image: '/uploads/main.png', sliderImage: '["/uploads/main.png"]', cateId: '1',
      systemFormId: 1, customForm: JSON.stringify(form('商品持久快照')) });
    await f.db.insert(storeProductAttrValue).values({ id: 11, productId: 10, productType: 1, suk: '默认', unique: 'native01',
      stock: 1, sumStock: 2, price: '12.50', cost: '3.00', image: '/uploads/sku.png' });
    await f.db.insert(storeProductDescription).values({ productId: 10, type: 0, description: '<p>读取前详情</p>' });
    await f.db.insert(storeProductVirtual).values([
      { id: 1, productId: 10, attrUnique: 'native01', cardNo: 'NATIVE-AVAILABLE-NO', cardPwd: 'NATIVE-AVAILABLE-SECRET', uid: 0 },
      { id: 2, productId: 10, attrUnique: 'native01', cardNo: 'NATIVE-ASSIGNED-NO', cardPwd: 'NATIVE-ASSIGNED-SECRET', uid: 88, orderId: 'assigned-order' },
    ]);
    await f.db.insert(storeProductAttrResult).values({ productId: 10, type: 0,
      result: JSON.stringify({ value: [{ virtual_list: [{ key: 'SNAPSHOT-CARD-NO', value: 'SNAPSHOT-SECRET' }] }] }) });
    // Missing single SKU must remain an editor template, never a hidden GET repair.
    await f.db.insert(storeProduct).values({ id: 20, specType: 0, storeName: '无SKU历史商品', price: '4.00', stock: 5,
      image: '/uploads/fallback.png', sliderImage: '["/uploads/fallback.png"]', cateId: '1' });
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  async function snapshot() {
    const tables: Record<string, unknown[]> = {};
    for (const table of Object.values(legacySaveSchema)) tables[getTableName(table)] = (await f.db.select().from(table))
      .map(row => JSON.stringify(row)).sort();
    return { tables, sequences: await f.exec('SELECT sequencename,last_value FROM pg_sequences WHERE schemaname=\'public\' ORDER BY sequencename') };
  }
  async function login<T>(run: (peer: Login) => Promise<T>) {
    return f.withRuntimeRole!(async peer => {
      if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(peer.role)) throw Error('Unsafe owned runtime LOGIN');
      await f.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${peer.role}";
        REVOKE SELECT ON store_product_virtual FROM "${peer.role}";
        GRANT SELECT(product_id,attr_unique,uid) ON store_product_virtual TO "${peer.role}"`);
      const [identity] = await peer.exec('SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting(\'server_version_num\') AS version');
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return run(peer);
    });
  }

  it('reads with genuine seed620 SELECT-only LOGIN and only aggregate card columns, preserving all business rows and sequences', async () => {
    await login(async reader => {
      const [acl] = await reader.exec(`SELECT has_table_privilege(current_user,'public.store_product','SELECT') AS product_select,
        has_table_privilege(current_user,'public.store_product','UPDATE') AS product_update,
        has_table_privilege(current_user,'public.store_product_attr_value','INSERT') AS sku_insert,
        has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,
        has_sequence_privilege(current_user,pg_get_serial_sequence('public.store_product','id'),'USAGE') AS sequence_usage,
        has_table_privilege(current_user,'public.store_product_virtual','SELECT') AS cards_table_select,
        has_column_privilege(current_user,'public.store_product_virtual','product_id','SELECT') AS card_product_select,
        has_column_privilege(current_user,'public.store_product_virtual','attr_unique','SELECT') AS card_sku_select,
        has_column_privilege(current_user,'public.store_product_virtual','uid','SELECT') AS card_uid_select,
        has_column_privilege(current_user,'public.store_product_virtual','card_no','SELECT') AS card_no_select,
        has_column_privilege(current_user,'public.store_product_virtual','card_pwd','SELECT') AS card_pwd_select,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
          AND c.relkind='r' AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE')) AS any_public_dml,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
          AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS any_sequence_privilege`);
      expect(acl).toEqual({ product_select: true, product_update: false, sku_insert: false, audit_insert: false,
        sequence_usage: false, cards_table_select: false, card_product_select: true, card_sku_select: true,
        card_uid_select: true, card_no_select: false, card_pwd_select: false, any_public_dml: false, any_sequence_privilege: false });
      const before = await snapshot();
      for (const statement of ['SELECT card_no FROM store_product_virtual', 'SELECT card_pwd FROM store_product_virtual',
        'UPDATE store_product SET stock=stock WHERE false', 'INSERT INTO system_log(admin_id) VALUES(1)',
        "SELECT nextval(pg_get_serial_sequence('store_product','id'))"])
        await expect(reader.exec(statement)).rejects.toMatchObject({ code: '42501' });
      const result = await read(reader.db);
      expect(result.productInfo).toMatchObject({ id: 10, store_name: '读取前商品', attr: {
        unique: 'native01', stock: 1, virtual_list: [], virtual_available: 1, virtual_total: 2 } });
      for (const secret of ['NATIVE-AVAILABLE-NO', 'NATIVE-AVAILABLE-SECRET', 'NATIVE-ASSIGNED-NO',
        'NATIVE-ASSIGNED-SECRET', 'SNAPSHOT-CARD-NO', 'SNAPSHOT-SECRET']) expect(JSON.stringify(result)).not.toContain(secret);
      const fallback = await read(reader.db, 20);
      expect(fallback.productInfo).toMatchObject({ id: 20, sku_repair_required: true, attr: { price: 4, stock: 5 } });
      expect((fallback.productInfo.attr as Record<string, unknown>).unique).toBeUndefined();
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('keeps main, SKU, description, form and both directory selectors on one real RR snapshot while a distinct peer commits changes', async () => {
    await login(reader => f.withPeer!(async writer => {
      expect(writer.pid).not.toBe(reader.pid);
      const baseline = await read(reader.db), ready = signal(), release = signal();
      const held = pauseSupplierOptionsRead(reader.db, 'system_admin', async () => { ready.resolve(); await release.promise; });
      const pending = outcome(read(held));
      try {
        await Promise.race([ready.promise, pending.then(result => {
          if (!result.ok) throw result.error;
          throw Error('Readonly editor snapshot did not reach its real authority SELECT');
        })]);
        const [activity] = await f.exec(`SELECT state,backend_xmin FROM pg_stat_activity WHERE pid=${reader.pid}`) as unknown as
          Array<{ state: string; backend_xmin: string | null }>;
        expect(activity.state).toBe('idle in transaction'); expect(activity.backend_xmin).not.toBeNull();
        await writer.db.transaction(async tx => {
          await tx.update(storeProduct).set({ storeName: '并发后商品', stock: 9, price: '21.00' }).where(eq(storeProduct.id, 10));
          await tx.update(storeProductAttrValue).set({ stock: 9, price: '21.00' }).where(eq(storeProductAttrValue.id, 11));
          await tx.update(storeProductDescription).set({ description: '<p>并发后详情</p>' }).where(eq(storeProductDescription.productId, 10));
          await tx.update(systemForm).set({ value: JSON.stringify(form('并发后表单')) }).where(eq(systemForm.id, 1));
          await tx.update(storeProductCategory).set({ cateName: '并发后分类' }).where(eq(storeProductCategory.id, 1));
          await tx.update(shippingTemplates).set({ name: '并发后运费' }).where(eq(shippingTemplates.id, 1));
        });
      } finally { release.resolve(); await pending; }
      const completed = await pending;
      expect(completed.ok).toBe(true); if (!completed.ok) throw completed.error;
      expect(completed.value).toEqual(baseline);
      const changed = await snapshot(), fresh = await read(reader.db);
      expect(fresh.productInfo).toMatchObject({ store_name: '并发后商品', stock: 9, price: 21,
        description: '<p>并发后详情</p>', attr: { stock: 9, price: 21 },
        custom_form_info: [{ title: '并发后表单' }] });
      expect(fresh.cateList).toEqual([{ value: 1, label: '并发后分类', pid: 0 }]);
      expect(fresh.tempList).toEqual([{ id: 1, name: '并发后运费' }]);
      expect(await snapshot()).toEqual(changed);
    }));
  }, 60000);

  it('refuses expiry using actual PostgreSQL wall clock while the application clock remains before the deadline, without hidden writes', async () => {
    await login(async reader => {
      const before = await snapshot(), expiresAt = Math.floor(Date.now() / 1000) + 2;
      const actor = { ...legacySaveActor(), expiresAt };
      const clock = vi.spyOn(Date, 'now').mockReturnValue((expiresAt - 1) * 1000);
      try {
        const held = pauseSupplierOptionsRead(reader.db, 'system_admin', () => waitForFinanceClock(f.db, expiresAt * 1000));
        await expect(read(held, 10, actor)).rejects.toThrow('过期');
        expect(Date.now()).toBeLessThan(expiresAt * 1000);
      } finally { clock.mockRestore(); }
      expect((await read(reader.db)).productInfo.id).toBe(10);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);
});
