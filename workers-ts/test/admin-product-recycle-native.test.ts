import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeCart, storeProduct } from '@/models/schema';
import { AdminProductRecycleService } from '@/services/admin/AdminProductRecycleService';
import { lockProductWrite, ProductAssociationService } from '@/services/product/ProductAssociationService';
import { lockBargainSourceProductAdmission } from '@/services/activity/BargainSourceProductLifecycle';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { pauseModerationExecute } from './helpers/adminProductModeration';
import { recycleActor, recycleFixture, recycleSnapshot, seedRecycle } from './helpers/adminProductRecycle';
import { resetStockSequences } from './helpers/adminProductStocks';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
const service = (db: DbClient) => new AdminProductRecycleService(createContainerFromDb(db));
const toggle = { mode: 'toggle' as const };
type Login = { db: DbClient; pid: number; role: string; exec(statement: string): Promise<unknown> };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 recycle LOGIN, physical family fences and exact rollback', () => {
  let f: Awaited<ReturnType<typeof recycleFixture>>;
  beforeAll(async () => { f = await recycleFixture(); }, 30000);
  beforeEach(async () => { await f.reset(); await seedRecycle(f.db); await resetStockSequences(f.exec); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native recycle forbids remote I/O')); }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  async function login<T>(run: (peer: Login) => Promise<T>): Promise<T> {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [origin] = await f.db.select({ database: sql<string>`current_database()`, schema: sql<string>`current_schema()`, role: sql<string>`current_user`, version: sql<string>`current_setting('server_version_num')` }).from(sql`(values(1)) probe(n)`);
    if (!ownsFinanceFixtureTarget(origin.database, origin.schema, base.href) || origin.schema !== 'public' || origin.role !== 'finance_test' || Math.floor(Number(origin.version) / 10000) !== 16) throw Error('Owned PG16 recycle fixture required');
    const role = `cinashop_recycle_${randomUUID().replaceAll('-', '')}`, password = randomUUID().replaceAll('-', '');
    if (!/^cinashop_recycle_[a-f0-9]{32}$/.test(role)) throw Error('Unsafe fixture role');
    let created = false, client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); created = true;
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
      const target = new URL(base.href); target.pathname = `/${origin.database}`; target.username = role; target.password = password;
      client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0, connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000' } });
      const [identity] = await client`SELECT current_user AS role,session_user AS session,current_database() AS database,current_setting('server_version_num') AS version,pg_backend_pid() AS pid`;
      expect(identity).toMatchObject({ role, session: role, database: origin.database }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      const checked = client;
      return await run({ db: drizzle(checked) as unknown as DbClient, pid: Number(identity.pid), role, exec: statement => checked.unsafe(statement) });
    } finally {
      await client?.end({ timeout: 5 });
      if (created) { await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); expect(await f.exec(`SELECT rolname FROM pg_roles WHERE rolname='${role}'`)).toEqual([]); }
    }
  }

  it('proves SELECT-only and missing SKU/relation UPDATE denial, then succeeds with only declared barriers and audit/intent insert privileges', async () => {
    await login(async writer => {
      const before = await recycleSnapshot(f.db);
      await expect(service(writer.db).change(10, recycleActor(), toggle)).rejects.toMatchObject({ httpStatus: 503 });
      expect(await recycleSnapshot(f.db)).toEqual(before);
      await f.exec(`GRANT UPDATE ON system_admin,system_role,store_product,store_cart TO "${writer.role}"; GRANT INSERT ON system_log,store_order_outbox TO "${writer.role}"; GRANT USAGE ON SEQUENCE system_log_id_seq,store_order_outbox_id_seq TO "${writer.role}"`);
      await expect(service(writer.db).change(10, recycleActor(), toggle)).rejects.toMatchObject({ httpStatus: 503 });
      expect(await recycleSnapshot(f.db)).toEqual(before);
      await f.exec(`GRANT UPDATE ON store_product_attr_value,store_product_relation TO "${writer.role}"`);
      // Numeric seed169 participates in the existing real decision-time menu
      // FOR SHARE lock too. Canonical capability writers have no menu row to
      // lock, but this exact imported source grant additionally needs UPDATE.
      await expect(service(writer.db).change(10, recycleActor(200), toggle)).rejects.toMatchObject({ httpStatus: 503 });
      expect(await recycleSnapshot(f.db)).toEqual(before);
      await f.exec(`GRANT UPDATE ON system_menus TO "${writer.role}"`);
      const [acl] = await writer.exec(`SELECT has_table_privilege(current_user,'public.store_product_attr_value','UPDATE') AS sku_update,
        has_table_privilege(current_user,'public.store_product_relation','UPDATE') AS relation_update,
        has_table_privilege(current_user,'public.system_menus','UPDATE') AS menu_update,
        has_table_privilege(current_user,'public.store_order','UPDATE') AS order_update,
        has_table_privilege(current_user,'public.store_order_cart_info','UPDATE') AS order_cart_update,
        has_table_privilege(current_user,'public.store_order_outbox','INSERT') AS outbox_insert,
        has_table_privilege(current_user,'public.store_order_outbox','UPDATE') AS outbox_update,
        has_table_privilege(current_user,'public.store_product','DELETE') AS product_delete,
        has_sequence_privilege(current_user,pg_get_serial_sequence('public.store_product','id'),'USAGE') AS product_sequence`) as Array<Record<string, boolean>>;
      expect(acl).toEqual({ sku_update: true, relation_update: true, menu_update: true, order_update: false, order_cart_update: false, outbox_insert: true, outbox_update: false, product_delete: false, product_sequence: false });
      expect(await service(writer.db).change(10, recycleActor(200), toggle)).toMatchObject({ message: '成功移到回收站' });
      const after = await recycleSnapshot(f.db);
      for (const name of ['storeProductAttrValue', 'storeProductRelation', 'storeOrder', 'storeOrderCartInfo']) expect(after[name]).toEqual(before[name]);
      for (const statement of ['UPDATE store_order SET status=status WHERE false', 'UPDATE store_order_cart_info SET cart_num=cart_num WHERE false', 'UPDATE store_order_outbox SET status=status WHERE false', 'DELETE FROM store_product WHERE false', "SELECT nextval(pg_get_serial_sequence('store_product','id'))"]) await expect(writer.exec(statement)).rejects.toMatchObject({ code: '42501' });
    });
  }, 60000);

  it('rejects real price/product/child-cart/relation/authority row and product-fence conflicts with no partial data, then succeeds', async () => {
    await withFinancePeers(f.db, async ([writer, blocker]) => {
      const holds = [
        ['UPDATE store_product_attr_value SET price=price WHERE id=401', 'store_product_attr_value', 'RowExclusiveLock'],
        ['SELECT id FROM store_product WHERE id=100 FOR UPDATE', 'store_product', 'RowShareLock'],
        ['SELECT id FROM store_cart WHERE id=206 FOR UPDATE', 'store_cart', 'RowShareLock'],
        ['UPDATE store_product_relation SET status=status WHERE id=203', 'store_product_relation', 'RowExclusiveLock'],
        ['UPDATE system_role SET rules=rules WHERE id=1', 'system_role', 'RowExclusiveLock'],
      ];
      for (const [statement, table, mode] of holds) {
        const before = await recycleSnapshot(f.db), ready = signal(), release = signal();
        const held = outcome(blocker.db.transaction(async tx => { await tx.execute(sql.raw(statement)); ready.resolve(); await release.promise; }));
        try {
          await Promise.race([ready.promise, held.then(value => { if (!value.ok) throw value.error; throw Error('Physical blocker not held'); })]);
          expect(await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${blocker.pid} AND relation='public.${table}'::regclass`)).toEqual(expect.arrayContaining([expect.objectContaining({ mode, granted: true })]));
          await expect(service(writer.db).change(10, recycleActor(), toggle)).rejects.toMatchObject({ code: 409, httpStatus: 409 });
          expect(await recycleSnapshot(f.db)).toEqual(before);
        } finally { release.resolve(); }
        const result = await held; if (!result.ok) throw result.error;
      }
      const before = await recycleSnapshot(f.db), ready = signal(), release = signal();
      const held = outcome(blocker.db.transaction(async tx => { await lockProductWrite(tx as unknown as DbClient, 102); ready.resolve(); await release.promise; }));
      try { await ready.promise; await expect(service(writer.db).change(10, recycleActor(), toggle)).rejects.toMatchObject({ httpStatus: 409 }); expect(await recycleSnapshot(f.db)).toEqual(before); }
      finally { release.resolve(); }
      const result = await held; if (!result.ok) throw result.error;
      await service(writer.db).change(10, recycleActor(), toggle);
    });
  }, 60000);

  it('takes every sorted bargain fence before business locks, permits cart-first checkout to finish, then refuses its changed full family snapshot', async () => {
    await withFinancePeers(f.db, async ([writer, checkout]) => {
      const admitted = signal(), finish = signal();
      const held = outcome(checkout.db.transaction(async tx => {
        await lockBargainSourceProductAdmission(tx as unknown as DbClient, 100);
        await tx.execute(sql`SELECT id FROM ${storeCart} WHERE ${storeCart.id}=206 FOR UPDATE`);
        admitted.resolve(); await finish.promise;
        // This actual update must complete while recycle is waiting; a product
        // table barrier acquired before its bargain wait would deadlock it.
        await tx.update(storeProduct).set({ stock: sql`${storeProduct.stock}+1` }).where(eq(storeProduct.id, 100));
      }));
      await Promise.race([admitted.promise, held.then(value => { if (!value.ok) throw value.error; throw Error('Checkout admission not held'); })]);
      const pending = outcome(service(writer.db).change(10, recycleActor(), toggle));
      try {
        await waitForFinanceBlock(f.db, writer.pid, checkout.pid);
        const locks = await f.exec(`SELECT relation::regclass::text AS name,mode FROM pg_locks WHERE pid=${writer.pid} AND relation IN ('public.store_product'::regclass,'public.store_product_attr_value'::regclass,'public.store_cart'::regclass,'public.store_product_relation'::regclass)`);
        expect(locks).toEqual([{ name: 'store_product', mode: 'AccessShareLock' }]);
      } finally { finish.resolve(); }
      const completed = await held; expect(completed.ok).toBe(true); if (!completed.ok) throw completed.error;
      const result = await pending; expect(result.ok).toBe(false); if (result.ok) throw Error('Changed family snapshot was accepted'); expect(result.error).toMatchObject({ httpStatus: 409 });
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 100)))[0]).toMatchObject({ stock: 41, isDel: 1 });
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0]).toMatchObject({ isDel: 0, isShow: 1 });
      await service(writer.db).change(10, recycleActor(), toggle);
    });
  }, 60000);

  it('refuses new child/pid phantoms that commit during the initial bargain wait, without touching the newly observed family', async () => {
    await withFinancePeers(f.db, async ([writer, admission]) => {
      const ready = signal(), release = signal();
      const held = outcome(admission.db.transaction(async tx => { await lockBargainSourceProductAdmission(tx as unknown as DbClient, 10); ready.resolve(); await release.promise; }));
      await ready.promise;
      const pending = outcome(service(writer.db).change(10, recycleActor(), toggle));
      let concurrent: Awaited<ReturnType<typeof recycleSnapshot>>;
      try {
        await waitForFinanceBlock(f.db, writer.pid, admission.pid);
        await f.exec('INSERT INTO store_product(id,pid,is_show,is_verify) VALUES(990,10,1,-1); UPDATE store_product SET pid=10 WHERE id=20');
        concurrent = await recycleSnapshot(f.db);
      } finally { release.resolve(); }
      const admitted = await held; if (!admitted.ok) throw admitted.error;
      const result = await pending; expect(result.ok).toBe(false); if (result.ok) throw Error('New child escaped family fencing'); expect(result.error).toMatchObject({ httpStatus: 409 });
      expect(await recycleSnapshot(f.db)).toEqual(concurrent!);
    });
  }, 60000);

  it('holds all four real table barriers across audit and blocks later family/SKU/cart/relation inserts until commit', async () => {
    await withFinancePeers(f.db, async ([writer, peer]) => {
      const ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db, /LOCK TABLE ONLY.*store_product.*store_product_attr_value.*store_cart.*store_product_relation.*SHARE ROW EXCLUSIVE MODE NOWAIT/i, async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).change(10, recycleActor(), toggle));
      let inserted: ReturnType<typeof outcome<unknown>> | undefined;
      try {
        await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Recycle barriers not reached'); })]);
        for (const table of ['store_product', 'store_product_attr_value', 'store_cart', 'store_product_relation']) expect(await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${writer.pid} AND relation='public.${table}'::regclass`)).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'ShareRowExclusiveLock', granted: true })]));
        inserted = outcome(peer.exec("INSERT INTO store_product(id,pid) VALUES(990,10); INSERT INTO store_product_attr_value(id,product_id,\"unique\") VALUES(990,10,'later001'); INSERT INTO store_cart(id,product_id,status) VALUES(990,10,1); INSERT INTO store_product_relation(id,product_id,status) VALUES(990,10,1)"));
        await waitForFinanceBlock(f.db, peer.pid, writer.pid);
        expect(await f.db.select().from(storeProduct).where(eq(storeProduct.id, 990))).toEqual([]);
      } finally { release.resolve(); }
      const committed = await pending; expect(committed.ok).toBe(true); if (!committed.ok) throw committed.error;
      if (!inserted) throw Error('Missing native insert attempt'); const result = await inserted; expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      // Source guarantees only rows present at the serialized transition. A
      // child/cart inserted after commit is independently owned later work.
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 990)))[0].isDel).toBe(0);
      expect((await f.db.select().from(storeCart).where(eq(storeCart.id, 990)))[0].status).toBe(1);
    });
  }, 60000);

  it('uses DB wallclock after mutation and fails closed on post-audit native triggers with complete rollback', async () => {
    await withFinancePeers(f.db, async ([writer]) => {
      const before = await recycleSnapshot(f.db), actor = { ...recycleActor(), expiresAt: Math.ceil((Date.now() + 600) / 1000) }, ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db, /SELECT floor\(extract\(epoch FROM clock_timestamp\(\)\)\)::integer AS now/i, async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).change(10, actor, toggle));
      try { await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Expiry boundary not reached'); })]); await waitForFinanceClock(f.db, actor.expiresAt * 1000); }
      finally { release.resolve(); }
      const result = await pending; expect(result.ok).toBe(false); if (result.ok) throw Error('Expired product recycle committed'); expect(result.error).toMatchObject({ code: 410001 }); expect(await recycleSnapshot(f.db)).toEqual(before);
      for (const [table, body] of [['system_log', "UPDATE system_role SET rules='product.view' WHERE id=1; RETURN NEW"], ['system_log', 'UPDATE store_product_attr_value SET price=99 WHERE id=401; RETURN NEW'], ['store_order_outbox', 'UPDATE store_cart SET status=0 WHERE id=206; RETURN NEW']]) {
        const snapshot = await recycleSnapshot(f.db);
        await f.exec(`CREATE FUNCTION recycle_native_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body}; END $$; CREATE TRIGGER recycle_native_trigger AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION recycle_native_trigger()`);
        try { await expect(service(writer.db).change(10, recycleActor(), toggle)).rejects.toThrow(); expect(await recycleSnapshot(f.db)).toEqual(snapshot); }
        finally { await f.exec(`DROP TRIGGER recycle_native_trigger ON ${table}; DROP FUNCTION recycle_native_trigger()`); }
      }
    });
  }, 60000);

  it('serializes with the actual ProductAssociation visibility writer while holding source/product fences', async () => {
    await withFinancePeers(f.db, async ([writer, editor]) => {
      const ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db, /LOCK TABLE ONLY.*store_product.*SHARE ROW EXCLUSIVE MODE NOWAIT/i, async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).change(10, recycleActor(), toggle));
      let edit: ReturnType<typeof outcome<void>> | undefined;
      try {
        await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Recycle fence not reached'); })]);
        edit = outcome(new ProductAssociationService(createContainerFromDb(editor.db)).setShow(10, 1, { id: 101, name: 'actual editor fixture', ip: '127.0.0.1' }));
        await waitForFinanceBlock(f.db, editor.pid, writer.pid);
      } finally { release.resolve(); }
      const recycled = await pending; expect(recycled.ok).toBe(true); if (!recycled.ok) throw recycled.error;
      if (!edit) throw Error('Actual visibility writer not attempted');
      const edited = await edit;
      // The existing target visibility writer rejects recycled products after
      // its wait. Its exact refusal is independent of the recycle transaction.
      expect(edited.ok).toBe(false);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10)))[0]).toMatchObject({ isDel: 1, isShow: 0 });
    });
  }, 60000);
});
