import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProductAttrValue, systemAdmin, systemRole } from '@/models/schema';
import { AdminProductModerationService } from '@/services/admin/AdminProductModerationService';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { lockBargainSourceProductAdmission } from '@/services/activity/BargainSourceProductLifecycle';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { moderationActor, moderationBody, moderationFixture, moderationRows, moderationSnapshot, pauseModerationExecute, pauseModerationQuery, seedModeration } from './helpers/adminProductModeration';
import { resetStockSequences } from './helpers/adminProductStocks';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
const service = (db: DbClient) => new AdminProductModerationService(createContainerFromDb(db));
type Login = { db: DbClient; pid: number; role: string; exec(statement: string): Promise<unknown> };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 product review LOGIN, native locks, snapshots and complete rollback', () => {
  let f: Awaited<ReturnType<typeof moderationFixture>>;
  beforeAll(async () => { f = await moderationFixture(); }, 30000);
  beforeEach(async () => { await f.reset(); await seedModeration(f.db); await resetStockSequences(f.exec); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Native moderation forbids remote I/O')); }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  async function login<T>(run: (peer: Login) => Promise<T>): Promise<T> {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [origin] = await f.db.select({ database: sql<string>`current_database()`, schema: sql<string>`current_schema()`, role: sql<string>`current_user`, version: sql<string>`current_setting('server_version_num')` }).from(sql`(values(1)) probe(n)`);
    if (!ownsFinanceFixtureTarget(origin.database, origin.schema, base.href) || origin.schema !== 'public' || origin.role !== 'finance_test' || Math.floor(Number(origin.version) / 10000) !== 16) throw Error('Owned PG16 moderation fixture required');
    const role = `cinashop_review_${randomUUID().replaceAll('-', '')}`, password = randomUUID().replaceAll('-', '');
    if (!/^cinashop_review_[a-f0-9]{32}$/.test(role)) throw Error('Unsafe fixture role');
    let created = false, client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); created = true;
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
      const target = new URL(base.href); target.pathname = `/${origin.database}`; target.username = role; target.password = password;
      client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000' } });
      const [identity] = await client`SELECT current_user AS role,session_user AS session,current_database() AS database,current_setting('server_version_num') AS version,pg_backend_pid() AS pid`;
      expect(identity).toMatchObject({ role, session: role, database: origin.database }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      const checked = client;
      return await run({ db: drizzle(checked) as unknown as DbClient, pid: Number(identity.pid), role, exec: statement => checked.unsafe(statement) });
    } finally {
      await client?.end({ timeout: 5 });
      if (created) { await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); expect(await f.exec(`SELECT rolname FROM pg_roles WHERE rolname='${role}'`)).toEqual([]); }
    }
  }

  it('executes both forms and ordinary-SKU preflight under SELECT-only LOGIN with proven DML/audit/sequence denial and no changes', async () => {
    await login(async reader => {
      const before = await moderationSnapshot(f.db);
      const [acl] = await reader.exec(`SELECT has_table_privilege(current_user,'public.store_product_attr_value','SELECT') AS sku_select,
        has_table_privilege(current_user,'public.store_product_attr_value','UPDATE') AS sku_update,
        has_table_privilege(current_user,'public.store_product','UPDATE') AS product_update,
        has_table_privilege(current_user,'public.store_cart','UPDATE') AS cart_update,
        has_table_privilege(current_user,'public.system_log','INSERT') AS audit_insert,
        has_sequence_privilege(current_user,pg_get_serial_sequence('public.system_log','id'),'USAGE') AS sequence_usage`) as Array<Record<string, boolean>>;
      expect(acl).toEqual({ sku_select: true, sku_update: false, product_update: false, cart_update: false, audit_insert: false, sequence_usage: false });
      expect(await service(reader.db).getVerify(10, moderationActor(102))).toEqual({ verify: 1 });
      expect(await service(reader.db).getVerify(998, moderationActor(102))).toEqual({ verify: 0 });
      expect(await service(reader.db).getVerify(999, moderationActor(102))).toEqual({ verify: 1 });
      expect(await service(reader.db).form(998, 'verify', moderationActor(102))).toMatchObject({ title: '商品审核', action: 'product/product/set_verify/998' });
      expect(await service(reader.db).form(998, 'remove', moderationActor(102))).toMatchObject({ title: '强制下架', rules: [{ type: 'hidden', field: 'is_verify', value: '-2' }, { field: 'refusal' }] });
      for (const statement of ['UPDATE store_product SET is_verify=1 WHERE false', 'UPDATE store_cart SET status=0 WHERE false', 'UPDATE store_product_attr_value SET price=0 WHERE false',
        'INSERT INTO system_log(admin_id) VALUES(101)', "SELECT nextval(pg_get_serial_sequence('system_log','id'))"]) await expect(reader.exec(statement)).rejects.toMatchObject({ code: '42501' });
      expect(await moderationSnapshot(f.db)).toEqual(before);
    });
  }, 60000);

  it('proves writer table-barrier UPDATE requirements, then commits with no order/outbox DML or non-audit sequence privileges', async () => {
    await login(async writer => {
      await f.exec(`GRANT UPDATE ON system_admin,system_role,store_product,store_cart TO "${writer.role}"; GRANT INSERT ON system_log TO "${writer.role}"; GRANT USAGE ON SEQUENCE system_log_id_seq TO "${writer.role}"`);
      const before = await moderationSnapshot(f.db);
      await expect(service(writer.db).save(10, moderationBody(), moderationActor())).rejects.toThrow();
      expect(await moderationSnapshot(f.db)).toEqual(before);
      // Real LOCK TABLE and SELECT FOR SHARE need UPDATE privilege. These are
      // deliberately declared broader table privileges, not SELECT-only SKU /
      // relation claims. Production service still never mutates those tables.
      await f.exec(`GRANT UPDATE ON store_product_attr_value,store_product_relation TO "${writer.role}"`);
      const [acl] = await writer.exec(`SELECT has_table_privilege(current_user,'public.store_product_attr_value','UPDATE') AS sku_update,
        has_table_privilege(current_user,'public.store_product_relation','UPDATE') AS relation_update,
        has_table_privilege(current_user,'public.store_order','UPDATE') AS order_update,
        has_table_privilege(current_user,'public.store_order_outbox','INSERT') AS outbox_insert,
        has_table_privilege(current_user,'public.store_product','DELETE') AS product_delete,
        has_sequence_privilege(current_user,pg_get_serial_sequence('public.store_product','id'),'USAGE') AS product_sequence,
        has_sequence_privilege(current_user,pg_get_serial_sequence('public.system_log','id'),'USAGE') AS audit_sequence`) as Array<Record<string, boolean>>;
      expect(acl).toEqual({ sku_update: true, relation_update: true, order_update: false, outbox_insert: false, product_delete: false, product_sequence: false, audit_sequence: true });
      await service(writer.db).save(10, moderationBody(), moderationActor());
      expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: 1, isShow: 1 });
      const after = await moderationSnapshot(f.db); expect(after.storeProductAttrValue).toEqual(before.storeProductAttrValue); expect(after.storeProductRelation).toEqual(before.storeProductRelation);
      for (const statement of ['UPDATE store_order SET status=status WHERE false', 'INSERT INTO store_order_outbox(event_key) VALUES(\'forbidden\')', 'DELETE FROM store_product WHERE false',
        "SELECT nextval(pg_get_serial_sequence('store_product','id'))"]) await expect(writer.exec(statement)).rejects.toMatchObject({ code: '42501' });
    });
  }, 60000);

  it('keeps one actual readonly snapshot across current authority and SKU warning, with the next request seeing changed prices and revoked credentials', async () => {
    await withFinancePeers(f.db, async ([reader]) => {
      const ready = signal(), release = signal();
      const hooked = pauseModerationQuery(reader.db, 'store_product_attr_value', async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).getVerify(10, moderationActor()));
      try {
        await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Readonly SKU snapshot not reached'); })]);
        const [activity] = await f.exec(`SELECT state,backend_xmin FROM pg_stat_activity WHERE pid=${reader.pid}`) as Array<{ state: string; backend_xmin: string | null }>;
        expect(activity.state).toBe('idle in transaction'); expect(activity.backend_xmin).not.toBeNull();
        await f.db.update(storeProductAttrValue).set({ settlePrice: '0.00' }).where(eq(storeProductAttrValue.productId, 10));
        await f.db.update(systemAdmin).set({ pwd: 'new-password' }).where(eq(systemAdmin.id, 101));
        await f.db.update(systemRole).set({ rules: 'reply.view' }).where(eq(systemRole.id, 1));
      } finally { release.resolve(); }
      const result = await pending; expect(result.ok).toBe(true); if (!result.ok) throw result.error; expect(result.value).toEqual({ verify: 1 });
      await expect(service(reader.db).getVerify(10, moderationActor())).rejects.toThrow('凭据');
      await f.db.update(systemAdmin).set({ pwd: 'stock-fixture-password' }).where(eq(systemAdmin.id, 101));
      await expect(service(reader.db).getVerify(10, moderationActor())).rejects.toThrow('权限');
      await f.db.update(systemRole).set({ rules: 'product.manage' }).where(eq(systemRole.id, 1));
      expect(await service(reader.db).getVerify(10, moderationActor())).toEqual({ verify: 0 });
    });
  }, 60000);

  it('uses database wall-clock expiry after an actual readonly snapshot and rolls back all writes when expiry occurs after product/cart mutation', async () => {
    await withFinancePeers(f.db, async ([reader, writer]) => {
      const before = await moderationSnapshot(f.db);
      for (const mode of ['read', 'write'] as const) {
        const actor = { ...moderationActor(), expiresAt: Math.ceil((Date.now() + 600) / 1000) }, ready = signal(), release = signal();
        const hooked = mode === 'read'
          ? pauseModerationQuery(reader.db, 'store_product_attr_value', async () => { ready.resolve(); await release.promise; })
          : pauseModerationExecute(writer.db, /SELECT floor\(extract\(epoch FROM clock_timestamp\(\)\)\)::integer AS now/i, async () => { ready.resolve(); await release.promise; });
        const pending = outcome<unknown>(mode === 'read' ? service(hooked).getVerify(10, actor) : service(hooked).save(10, moderationBody(), actor));
        try {
          await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Expiry boundary not reached'); })]);
          await waitForFinanceClock(f.db, actor.expiresAt * 1000);
          const [expired] = await f.exec(`SELECT extract(epoch FROM clock_timestamp()) >= ${actor.expiresAt} AS expired`) as Array<{ expired: boolean }>;
          expect(expired.expired).toBe(true);
        } finally { release.resolve(); }
        const result = await pending; expect(result.ok).toBe(false); if (result.ok) throw Error('Expired native request succeeded'); expect(result.error).toMatchObject({ code: 410001 });
        expect(await moderationSnapshot(f.db)).toEqual(before);
      }
    });
  }, 60000);

  it('refuses real direct SQL price/cart/parent row conflicts and authority changes without partial updates, then succeeds after release', async () => {
    await withFinancePeers(f.db, async ([writer, blocker]) => {
      const holds = [
        { statement: 'UPDATE store_product_attr_value SET price=price WHERE id=11', table: 'store_product_attr_value', mode: 'RowExclusiveLock' },
        { statement: 'SELECT id FROM store_cart WHERE id=201 FOR UPDATE', table: 'store_cart', mode: 'RowShareLock' },
        { statement: 'SELECT id FROM store_product WHERE id=10 FOR UPDATE', table: 'store_product', mode: 'RowShareLock' },
        { statement: 'UPDATE system_role SET rules=rules WHERE id=1', table: 'system_role', mode: 'RowExclusiveLock' },
      ];
      for (const hold of holds) {
        const before = await moderationSnapshot(f.db), ready = signal(), release = signal();
        const held = outcome(blocker.db.transaction(async tx => { await tx.execute(sql.raw(hold.statement)); ready.resolve(); await release.promise; }));
        try {
          await Promise.race([ready.promise, held.then(value => { if (!value.ok) throw value.error; throw Error('Physical blocker not held'); })]);
          expect(await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${blocker.pid} AND relation='public.${hold.table}'::regclass`)).toEqual(expect.arrayContaining([expect.objectContaining({ mode: hold.mode, granted: true })]));
          const result = await outcome(service(writer.db).save(10, moderationBody(), moderationActor()));
          expect(result.ok).toBe(false); if (result.ok) throw Error('Moderation bypassed actual PostgreSQL writer'); expect(result.error).toMatchObject({ code: 409, httpStatus: 409 });
          expect(await moderationSnapshot(f.db)).toEqual(before);
        } finally { release.resolve(); }
        const result = await held; expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      }
      await service(writer.db).save(10, moderationBody(), moderationActor());
      expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: 1, isShow: 1 });
    });
  }, 60000);

  it('protects absent target rows against real SKU/cart/relation inserts with actual table barriers, then exposes the committed inserts only afterward', async () => {
    await withFinancePeers(f.db, async ([writer, peer]) => {
      const ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db, /LOCK TABLE ONLY.*store_product_attr_value.*store_cart.*store_product_relation.*SHARE ROW EXCLUSIVE MODE NOWAIT/i,
        async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).save(10, moderationBody(), moderationActor()));
      let inserted: ReturnType<typeof outcome<unknown>> | undefined;
      try {
        await Promise.race([ready.promise, pending.then(value => { if (!value.ok) throw value.error; throw Error('Real relation table barriers not held'); })]);
        for (const table of ['store_product_attr_value', 'store_cart', 'store_product_relation']) expect(await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${writer.pid} AND relation='public.${table}'::regclass`)).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'ShareRowExclusiveLock', granted: true })]));
        inserted = outcome(peer.exec("INSERT INTO store_product_attr_value(id,product_id,\"unique\") VALUES(990,10,'later001'); INSERT INTO store_cart(id,product_id,status) VALUES(990,10,1); INSERT INTO store_product_relation(id,product_id,status) VALUES(990,10,1)"));
        await waitForFinanceBlock(f.db, peer.pid, writer.pid);
        expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 990)))).toEqual([]);
      } finally { release.resolve(); }
      const committed = await pending; expect(committed.ok).toBe(true); if (!committed.ok) throw committed.error;
      if (!inserted) throw Error('Missing native insert attempt'); const result = await inserted; expect(result.ok).toBe(true); if (!result.ok) throw result.error;
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 990)))).toHaveLength(1);
      // The source never promises to invalidate carts inserted after commit.
      expect((await moderationRows(f.db)).carts.find(row => row.id === 990)?.status).toBe(1);
    });
  }, 60000);

  it('serializes review with the real bargain admission boundary and an actual ProductAssociationService visibility writer', async () => {
    await withFinancePeers(f.db, async ([reviewer, admission, editor]) => {
      const ready = signal(), release = signal();
      const held = outcome(admission.db.transaction(async tx => { await lockBargainSourceProductAdmission(tx as unknown as DbClient, 10); ready.resolve(); await release.promise; }));
      await Promise.race([ready.promise, held.then(value => { if (!value.ok) throw value.error; throw Error('Bargain source admission not held'); })]);
      const pending = outcome(service(reviewer.db).save(10, moderationBody(1, 0), moderationActor()));
      try { await waitForFinanceBlock(f.db, reviewer.pid, admission.pid); expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: 0, isShow: 0 }); }
      finally { release.resolve(); }
      const review = await pending; expect(review.ok).toBe(true); if (!review.ok) throw review.error; expect((await held).ok).toBe(true);
      const locked = signal(), unlock = signal();
      const hooked = pauseModerationExecute(reviewer.db, /LOCK TABLE ONLY.*store_product_attr_value.*SHARE ROW EXCLUSIVE MODE NOWAIT/i, async () => { locked.resolve(); await unlock.promise; });
      const again = outcome(service(hooked).save(10, moderationBody(1, 0), moderationActor()));
      let edit: ReturnType<typeof outcome<void>> | undefined;
      try {
        await Promise.race([locked.promise, again.then(value => { if (!value.ok) throw value.error; throw Error('Review barrier not held'); })]);
        edit = outcome(new ProductAssociationService(createContainerFromDb(editor.db)).setShow(10, 1, { id: 101, name: 'actual editor fixture', ip: '127.0.0.1' }));
        await waitForFinanceBlock(f.db, editor.pid, reviewer.pid);
      } finally { unlock.resolve(); }
      const reviewed = await again; expect(reviewed.ok).toBe(true); if (!reviewed.ok) throw reviewed.error;
      if (!edit) throw Error('Actual editor not attempted'); const edited = await edit; expect(edited.ok).toBe(true); if (!edited.ok) throw edited.error;
      expect((await moderationRows(f.db)).product).toMatchObject({ isVerify: 1, isShow: 1 });
      expect((await moderationRows(f.db)).carts.filter(row => row.id !== 203).every(row => row.status === 0)).toBe(true);
    });
  }, 60000);
});
