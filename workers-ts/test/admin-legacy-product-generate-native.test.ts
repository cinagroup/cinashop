import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableName } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeProductAttrResult, storeProductVirtual,
  systemAdmin, systemRole, systemMenus } from '@/models/schema';
import { AdminLegacyProductGenerateService } from '@/services/admin/AdminLegacyProductGenerateService';
import { AdminPermissionService, PRODUCT_SKU_GENERATION_PERMISSION } from '@/services/admin/AdminPermissionService';
import { legacySaveActor, legacySaveSchema } from './helpers/adminLegacyProductSave';
import { pauseSupplierOptionsRead } from './helpers/adminProductSupplierOptions';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceClock } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Login = SequenceRunnerPeer & { role: string };
const body = () => ({ attrs: [{ value: '规格', detail: ['默认'] }], product_type: 0 });
const generate = (db: DbClient, id = 10, mode: 0 | 1 | 2 = 0, input: unknown = body(), actor = legacySaveActor()) =>
  new AdminLegacyProductGenerateService(createContainerFromDb(db)).generate(id, mode, input, actor);
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 legacy generator isolated seed191 LOGIN, RR projection and database expiry', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(legacySaveSchema))).join('\n');
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native SKU generation forbids provider I/O'));
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Owned PG16 LOGIN and independent peers required');
    await f.exec(ddl);
    await f.db.insert(systemRole).values({ id: 1, rules: '191' });
    await f.db.insert(systemAdmin).values({ id: 1, account: 'sku-generator-native', pwd: 'legacy-save-password', roles: '1', level: 1 });
    await f.db.insert(systemMenus).values({ id: 191, authType: 2, apiUrl: 'product/generate_attr/<id>/<type>', methods: 'POST',
      menuPath: '/adminproduct/generate_attr/<id>', uniqueAuth: '' });
    await f.db.insert(storeProduct).values([
      { id: 10, productType: 1, specType: 0, storeName: '生成前卡密商品', stock: 1, price: '12.50' },
      { id: 20, productType: 1, specType: 0, storeName: '固定交付商品', stock: 3, price: '8.00' },
    ]);
    await f.db.insert(storeProductAttrValue).values([
      { id: 11, productId: 10, productType: 1, suk: '默认', unique: 'gen00001', stock: 1, sumStock: 2,
        price: '12.50', cost: '3.00', image: '/uploads/sku-before.png' },
      { id: 21, productId: 20, productType: 1, suk: '默认', unique: 'gen00002', stock: 3, sumStock: 3,
        price: '8.00', diskInfo: 'OWNED-FIXED-DELIVERY', image: '/uploads/fixed.png' },
    ]);
    await f.db.insert(storeProductVirtual).values([
      { id: 1, productId: 10, attrUnique: 'gen00001', cardNo: 'GEN-AVAILABLE-NO', cardPwd: 'GEN-AVAILABLE-SECRET', uid: 0 },
      { id: 2, productId: 10, attrUnique: 'gen00001', cardNo: 'GEN-ASSIGNED-NO', cardPwd: 'GEN-ASSIGNED-SECRET', uid: 88, orderId: 'assigned-generator-order' },
    ]);
    await f.db.insert(storeProductAttrResult).values({ productId: 10, type: 0,
      result: JSON.stringify({ value: [{ virtual_list: [{ key: 'GEN-SNAPSHOT-NO', value: 'GEN-SNAPSHOT-SECRET' }] }] }) });
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
      const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        current_setting('server_version_num') AS version,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
      expect(identity).toMatchObject({ role: peer.role, session: peer.role, pid: peer.pid, superuser: false });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      return run(peer);
    });
  }

  it('generates under a genuine seed191 SELECT-only LOGIN with denied credential columns and no identity, DML or sequence allocation', async () => {
    await login(async reader => {
      const [acl] = await reader.exec(`SELECT
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
      expect(acl).toEqual({ cards_table_select: false, card_product_select: true, card_sku_select: true, card_uid_select: true,
        card_no_select: false, card_pwd_select: false, any_public_dml: false, any_sequence_privilege: false });
      const before = await snapshot();
      for (const statement of ['SELECT card_no FROM store_product_virtual', 'SELECT card_pwd FROM store_product_virtual',
        'UPDATE store_product SET stock=stock WHERE false', 'INSERT INTO system_log(admin_id) VALUES(1)',
        "SELECT nextval(pg_get_serial_sequence('store_product_attr_value','id'))"])
        await expect(reader.exec(statement)).rejects.toMatchObject({ code: '42501' });
      const { keys } = await new AdminPermissionService(createContainerFromDb(reader.db)).resolveRoleAssignment('1');
      expect(keys.has(PRODUCT_SKU_GENERATION_PERMISSION)).toBe(true);
      expect(keys.has('product.manage')).toBe(false); expect(keys.has('product.view')).toBe(false);
      const result = await generate(reader.db);
      expect(result.info).toMatchObject({ product_type: 1, value: [{ values: '默认', stock: 1, price: 12.5,
        virtual_list: [], virtual_available: 1, virtual_total: 2 }] });
      for (const secret of ['GEN-AVAILABLE-NO', 'GEN-AVAILABLE-SECRET', 'GEN-ASSIGNED-NO',
        'GEN-ASSIGNED-SECRET', 'GEN-SNAPSHOT-NO', 'GEN-SNAPSHOT-SECRET']) expect(JSON.stringify(result)).not.toContain(secret);
      expect((await generate(reader.db, 20)).info.value[0]).toMatchObject({ disk_info: 'OWNED-FIXED-DELIVERY' });
      for (const mode of [1, 2] as const) {
        const rows = (await generate(reader.db, 20, mode)).info.value;
        expect(rows[0]).not.toHaveProperty('disk_info'); expect(rows[0]).not.toHaveProperty('virtual_list');
      }
      const fresh = await generate(reader.db, 0, 0, { attrs: [{ value: '颜色', detail: ['红', '蓝'] }], product_type: 0 });
      expect(fresh.info).toMatchObject({ product_type: 0, value: [
        { values: '红', detail: { 颜色: '红' }, value1: '红', price: 0, stock: 0, pic: '' },
        { values: '蓝', detail: { 颜色: '蓝' }, value1: '蓝', price: 0, stock: 0, pic: '' },
      ] });
      for (const row of [...result.info.value, ...fresh.info.value]) {
        expect(row).not.toHaveProperty('id'); expect(row).not.toHaveProperty('unique'); expect(row).not.toHaveProperty('suk');
      }
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);

  it('keeps current owner, fulfillment and matched SKU on one real RR snapshot while a different backend commits replacements', async () => {
    await login(reader => f.withPeer!(async writer => {
      expect(writer.pid).not.toBe(reader.pid);
      const baseline = await generate(reader.db), ready = signal(), release = signal();
      expect(baseline.info.header.some(column => column.slot === 'settle_price')).toBe(false);
      const held = pauseSupplierOptionsRead(reader.db, 'system_admin', async () => { ready.resolve(); await release.promise; });
      const pending = outcome(generate(held));
      try {
        await Promise.race([ready.promise, pending.then(result => {
          if (!result.ok) throw result.error;
          throw Error('Readonly generator did not reach its real authority SELECT');
        })]);
        const [activity] = await f.exec(`SELECT state,backend_xmin FROM pg_stat_activity WHERE pid=${reader.pid}`) as unknown as
          Array<{ state: string; backend_xmin: string | null }>;
        expect(activity.state).toBe('idle in transaction'); expect(activity.backend_xmin).not.toBeNull();
        await writer.db.transaction(async tx => {
          await tx.update(storeProduct).set({ type: 2, relationId: 20, productType: 4,
            storeName: '并发后次卡', stock: 9, price: '21.00' }).where(eq(storeProduct.id, 10));
          await tx.update(storeProductAttrValue).set({ productType: 4, stock: 9, price: '21.00', image: '/uploads/sku-after.png',
            writeTimes: 7, writeValid: 3, writeDays: 0, writeStart: 1893456000, writeEnd: 1893542400 }).where(eq(storeProductAttrValue.id, 11));
        });
      } finally { release.resolve(); await pending; }
      const completed = await pending;
      expect(completed.ok).toBe(true); if (!completed.ok) throw completed.error;
      expect(completed.value).toEqual(baseline);
      const changed = await snapshot(), fresh = await generate(reader.db);
      expect(fresh.info).toMatchObject({ product_type: 4, value: [{ stock: 9, price: 21, pic: '/uploads/sku-after.png',
        write_times: 7, write_valid: 3, days: 0, section_time: ['2030-01-01', '2030-01-02'] }] });
      expect(fresh.info.header.some(column => column.slot === 'settle_price')).toBe(true);
      expect(fresh.info.value[0]).not.toHaveProperty('virtual_list');
      expect(await snapshot()).toEqual(changed);
    }));
  }, 60000);

  it('refuses using actual PostgreSQL expiry while the application clock remains valid, preserving the full database and sequences', async () => {
    await login(async reader => {
      const before = await snapshot(), expiresAt = Math.floor(Date.now() / 1000) + 2;
      const actor = { ...legacySaveActor(), expiresAt };
      const clock = vi.spyOn(Date, 'now').mockReturnValue((expiresAt - 1) * 1000);
      try {
        const held = pauseSupplierOptionsRead(reader.db, 'system_admin', () => waitForFinanceClock(f.db, expiresAt * 1000));
        await expect(generate(held, 10, 0, body(), actor)).rejects.toThrow('过期');
        expect(Date.now()).toBeLessThan(expiresAt * 1000);
      } finally { clock.mockRestore(); }
      expect((await generate(reader.db)).info.product_type).toBe(1);
      expect(await snapshot()).toEqual(before);
    });
  }, 60000);
});
