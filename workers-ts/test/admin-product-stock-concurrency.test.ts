import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAdmin, systemConfig, systemRole } from '@/models/schema';
import { AdminProductStockService } from '@/services/admin/AdminProductStockService';
import { AdminConfigBatchService } from '@/services/system/AdminConfigBatchService';
import { StaffNotificationAuthService } from '@/services/notification/StaffNotificationAuthService';
import { type StaffSocketSession } from '@/services/notification/StaffNotificationProtocol';
import { AuthException } from '@/utils/errors';
import { runProductStockEffects } from '@/migrations/runProductStockEffects';
import { PRODUCT_STOCK_EFFECTS_CHECK_DEFINITION } from '@/migrations/productStockEffects';
import { PINK_SUCCESS_NOTICE_CHECK_DEFINITION, PINK_SUCCESS_NOTICE_EVENTS } from '@/migrations/pinkSuccessNotice';
import { storeOrderOutbox } from '@/models/schema';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { md5 } from '@/utils/jwt';
import { stockFixture, seedStocks, resetStockSequences, stockActor, stockBody, stockRows, stockSnapshot } from './helpers/adminProductStocks';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const configEnv = () => ({ CONFIG_KV: { get: async () => null, put: async () => {}, delete: vi.fn(async () => {}) } });
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }

/** Pause only after the real PostgreSQL statement has executed. No SQL result,
 * lock or transaction is mocked, and the observer uses another physical pool. */
function pauseAfterStatement(db: DbClient, match: RegExp, pause: () => Promise<void>): DbClient {
  const dialect = new PgDialect();
  return new Proxy(db, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (property === 'transaction' && typeof method === 'function') return (callback: (tx: DbClient) => unknown, ...options: unknown[]) =>
        Reflect.apply(method, target, [(tx: DbClient) => callback(new Proxy(tx, {
          get(transaction, key, txReceiver) {
            const operation: unknown = Reflect.get(transaction, key, txReceiver);
            if (key === 'execute' && typeof operation === 'function') return async (...args: unknown[]) => {
              const result = await Reflect.apply(operation, transaction, args);
              const query = dialect.sqlToQuery(args[0] as Parameters<PgDialect['sqlToQuery']>[0]).sql;
              if (match.test(query)) await pause();
              return result;
            };
            return typeof operation === 'function' ? operation.bind(transaction) : operation;
          },
        })), ...options]);
      return typeof method === 'function' ? method.bind(target) : method;
    },
  });
}

// Authority validation runs against actual SQL in both the ordinary PGlite pass
// and the optional isolated PG16 pass. Token/provider I/O is not part of this proof.
describe('stock-only notification Admin level boundary', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  beforeAll(async () => { f = await stockFixture(); }, 30000);
  afterAll(async () => { await f?.close(); });
  afterEach(() => vi.restoreAllMocks());
  it('rejects level 10 for product_stock while preserving the existing withdrawal level semantics', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Scoped notification authority forbids remote I/O'));
    await f.db.update(systemRole).set({ rules: 'product.view,extract.view' }).where(eq(systemRole.id, 2));
    const auth = new StaffNotificationAuthService(f.container, { UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', NODE_ENV: 'test' });
    const session: StaffSocketSession = { audience: 'admin', id: 102, authId: 102, expiresAt: Math.floor(Date.now() / 1000) + 600,
      authVersion: md5('stock-fixture-password'), tokenKey: md5('stock-notice-test-token') };
    await f.db.update(systemAdmin).set({ level: 9 }).where(eq(systemAdmin.id, 102));
    await auth.assertSession({ ...session, scope: 'product_stock' });
    await f.db.update(systemAdmin).set({ level: 10 }).where(eq(systemAdmin.id, 102));
    const before = await stockSnapshot(f.db);
    await expect(auth.assertSession({ ...session, scope: 'product_stock' })).rejects.toBeInstanceOf(AuthException);
    await auth.assertSession(session);
    await auth.assertSession({ ...session, scope: 'withdrawal' });
    expect(await stockSnapshot(f.db)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 stock/config missing-key table barrier against the actual generic config writer', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  beforeAll(async () => { f = await stockFixture(); }, 30000);
  beforeEach(async () => {
    await f.reset(); await seedStocks(f.db); await resetStockSequences(f.exec);
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'erp_open'));
    // seedStocks inserts explicit fixture IDs; the real generic writer uses the sequence.
    await f.exec("SELECT setval(pg_get_serial_sequence('system_config','id'),1000,false)");
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Stock/config lock proof forbids remote I/O'));
  }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  it('holds the missing ERP key boundary until stock commit, then lets the real AdminConfigBatchService insert and blocks the next adjustment', async () => {
    await withFinancePeers(f.db, async ([stockPeer, configPeer]) => {
      const ready = signal(), release = signal(), env = configEnv();
      const db = pauseAfterStatement(stockPeer.db, /LOCK TABLE.*system_config.*IN SHARE MODE NOWAIT/i, async () => { ready.resolve(); await release.promise; });
      const stock = outcome(new AdminProductStockService(createContainerFromDb(db)).save(10, stockBody(), stockActor()));
      let config: ReturnType<typeof outcome<void>> | undefined;
      try {
        await Promise.race([ready.promise, stock.then(result => { if (!result.ok) throw result.error; throw Error('Stock writer did not hold the real configuration table barrier'); })]);
        expect(await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, 'erp_open'))).toEqual([]);
        config = outcome(new AdminConfigBatchService(createContainerFromDb(configPeer.db), env).save({ erp_open: '1' }));
        await waitForFinanceBlock(f.db, configPeer.pid, stockPeer.pid);
        const locks = await f.exec(`SELECT pid,mode,granted FROM pg_locks WHERE relation='public.system_config'::regclass AND pid IN (${stockPeer.pid},${configPeer.pid})`);
        expect(locks).toEqual(expect.arrayContaining([
          expect.objectContaining({ pid: stockPeer.pid, mode: 'ShareLock', granted: true }),
          expect.objectContaining({ pid: configPeer.pid, mode: 'ShareRowExclusiveLock', granted: false }),
        ]));
        expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
      } finally { release.resolve(); }
      const stockResult = await stock; expect(stockResult.ok).toBe(true);
      if (!stockResult.ok) throw stockResult.error;
      expect(stockResult.value).toEqual({ stock: '13' });
      if (!config) throw Error('Missing active generic config write');
      const configResult = await config; expect(configResult.ok).toBe(true); if (!configResult.ok) throw configResult.error;
      expect(env.CONFIG_KV.delete).toHaveBeenCalledWith('cfg_erp_open');
      expect((await stockRows(f.db)).parent?.stock).toBe(13);
      expect(await f.db.select().from(systemConfig).where(eq(systemConfig.menuName, 'erp_open'))).toMatchObject([{ value: '1' }]);
      const committed = await stockSnapshot(f.db);
      await expect(new AdminProductStockService(createContainerFromDb(stockPeer.db)).save(10, stockBody(), stockActor())).rejects.toThrow('ERP');
      expect(await stockSnapshot(f.db)).toEqual(committed);
    });
  }, 60000);

  it('refuses stock NOWAIT with no business changes while the actual generic writer owns its missing-key table fence', async () => {
    await withFinancePeers(f.db, async ([stockPeer, configPeer]) => {
      const ready = signal(), release = signal(), env = configEnv();
      const db = pauseAfterStatement(configPeer.db, /LOCK TABLE.*system_config.*IN SHARE ROW EXCLUSIVE MODE/i, async () => { ready.resolve(); await release.promise; });
      const config = outcome(new AdminConfigBatchService(createContainerFromDb(db), env).save({ erp_open: '1' }));
      try {
        await Promise.race([ready.promise, config.then(result => { if (!result.ok) throw result.error; throw Error('Generic config writer did not hold its actual table fence'); })]);
        const before = await stockSnapshot(f.db);
        const rejected = await outcome(new AdminProductStockService(createContainerFromDb(stockPeer.db)).save(10, stockBody(), stockActor()));
        expect(rejected.ok).toBe(false);
        if (rejected.ok) throw Error('Stock write bypassed the current config writer');
        expect(rejected.error).toMatchObject({ code: 409, httpStatus: 409 });
        expect(await stockSnapshot(f.db)).toEqual(before);
        const locks = await f.exec(`SELECT mode,granted FROM pg_locks WHERE relation='public.system_config'::regclass AND pid=${configPeer.pid}`);
        expect(locks).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'ShareRowExclusiveLock', granted: true })]));
        expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
      } finally { release.resolve(); }
      const result = await config; expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      expect((await stockRows(f.db)).parent?.stock).toBe(10);
      const committed = await stockSnapshot(f.db);
      await expect(new AdminProductStockService(createContainerFromDb(stockPeer.db)).save(10, stockBody(), stockActor())).rejects.toThrow('ERP');
      expect(await stockSnapshot(f.db)).toEqual(committed);
    });
  }, 60000);

  it('upgrades the exact previous native event check once, preserves comments and all business rows, and rejects definition drift without repair', async () => {
    // Use the actual prior migration DDL. pg_get_constraintdef's inspection
    // string is not round-trippable DDL: reparsing its casts changes the catalog shape.
    const previousEvents = PINK_SUCCESS_NOTICE_EVENTS.map(event => `'${event}'`).join(', ');
    await f.exec(`ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type IN (${previousEvents}))`);
    await f.exec("COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS 'stock migration preserved fixture comment'");
    await f.db.insert(storeOrderOutbox).values({ eventKey: 'order.paid:70', aggregateType: 'order', aggregateId: 70,
      eventType: 'order.paid', payload: { orderId: 70, orderNo: 'stock-unrelated-order' }, status: 'COMPLETED' });
    const before = await stockSnapshot(f.db);
    const definition = async () => f.exec(`SELECT pg_get_constraintdef(oid) AS definition,obj_description(oid,'pg_constraint') AS comment
      FROM pg_constraint WHERE conrelid='public.store_order_outbox'::regclass AND conname='soob_event_type_ck'`);
    expect(await definition()).toEqual([expect.objectContaining({ definition: PINK_SUCCESS_NOTICE_CHECK_DEFINITION,
      comment: 'stock migration preserved fixture comment' })]);
    await runProductStockEffects(f.db);
    const upgraded = await definition();
    expect(upgraded).toEqual([expect.objectContaining({ definition: PRODUCT_STOCK_EFFECTS_CHECK_DEFINITION,
      comment: 'stock migration preserved fixture comment' })]);
    expect(await stockSnapshot(f.db)).toEqual(before);
    await runProductStockEffects(f.db);
    expect(await definition()).toEqual(upgraded);
    expect(await stockSnapshot(f.db)).toEqual(before);
    await f.exec("ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck; ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK(event_type <> 'legacy.invalid')");
    const drift = await definition();
    await expect(runProductStockEffects(f.db)).rejects.toThrow('CHECK drift');
    expect(await definition()).toEqual(drift);
    expect(await stockSnapshot(f.db)).toEqual(before);
  }, 60000);

  it('executes full stock GET under a real SELECT-only LOGIN and proves business DML and sequence usage are unavailable', async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [origin] = await f.db.select({ database: sql<string>`current_database()`, schema: sql<string>`current_schema()`,
      role: sql<string>`current_user`, version: sql<string>`current_setting('server_version_num')` }).from(sql`(values(1)) probe(n)`);
    if (!ownsFinanceFixtureTarget(origin.database, origin.schema, base.href) || origin.schema !== 'public'
      || origin.role !== 'finance_test' || Math.floor(Number(origin.version) / 10000) !== 16) throw Error('Owned PG16 stock fixture required');
    const role = `cinashop_stock_reader_${randomUUID().replaceAll('-', '')}`, password = randomUUID().replaceAll('-', '');
    if (!/^cinashop_stock_reader_[a-f0-9]{32}$/.test(role)) throw Error('Unsafe stock fixture LOGIN');
    let created = false, client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      created = true;
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
      const target = new URL(base.href); target.pathname = `/${origin.database}`; target.username = role; target.password = password;
      client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000' } });
      const [identity] = await client`SELECT current_user AS role,session_user AS session,current_database() AS database,current_setting('server_version_num') AS version`;
      expect(identity).toMatchObject({ role, session: role, database: origin.database });
      expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      const [acl] = await client`SELECT has_table_privilege(current_user,'public.store_product_attr_value','SELECT') AS sku_select,
        has_table_privilege(current_user,'public.store_product_attr_value','UPDATE') AS sku_update,
        has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,
        has_table_privilege(current_user,'public.store_order_outbox','INSERT') AS outbox_insert,
        has_sequence_privilege(current_user,pg_get_serial_sequence('public.system_log','id'),'USAGE') AS sequence_usage`;
      expect(acl).toEqual({ sku_select: true, sku_update: false, audit_insert: false, outbox_insert: false, sequence_usage: false });
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const reader = drizzle(client) as unknown as DbClient, before = await stockSnapshot(f.db);
      expect(await new AdminProductStockService(createContainerFromDb(reader)).attrs(10, stockActor(102)))
        .toMatchObject([{ id: 11, product_id: 10, stock: 10, disk_info: null }, { id: 12 }, { id: 13, is_retired: 1 }]);
      for (const statement of ['UPDATE store_product_attr_value SET stock=stock WHERE false', 'INSERT INTO system_log(admin_id) VALUES(101)',
        "SELECT nextval(pg_get_serial_sequence('system_log','id'))", 'UPDATE store_product SET stock=stock WHERE false'])
        await expect(client.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
      expect(await stockSnapshot(f.db)).toEqual(before);
    } finally {
      await client?.end({ timeout: 5 });
      if (created) {
        await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
        const remaining = await f.exec(`SELECT rolname FROM pg_roles WHERE rolname='${role}'`);
        expect(remaining).toEqual([]);
      }
    }
  }, 60000);

});
