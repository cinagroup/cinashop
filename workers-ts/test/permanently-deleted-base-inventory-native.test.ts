import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { readPermanentlyDeletedBaseInventory } from '@/services/order/PermanentlyDeletedBaseInventory';
import { supplierProductRecycleFixture, supplierRecycleActor, supplierRecycleSnapshot } from './helpers/supplierProductRecycle';
import { ownsFinanceFixtureTarget, validateFinanceFixtureUrl } from './helpers/financePostgres';

type Login = { db: DbClient; role: string; exec(statement: string): Promise<postgres.Row[]> };
function pgCode(error: unknown): string {
  let value = error;
  for (let depth = 0; depth < 8 && value && typeof value === 'object'; depth++) {
    if ('code' in value && typeof value.code === 'string') return value.code;
    value = 'cause' in value ? value.cause : undefined;
  }
  return '';
}
const expected = { productId: 81, skuId: 302, skuUnique: 'card0002', supplierId: 20, productType: 1 };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('permanently deleted inventory exact physical absence proof on restricted PG16 LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierProductRecycleFixture>>;
  beforeAll(async () => {
    f = await supplierProductRecycleFixture();
    // Real owner-scoped service and the real two-guard maintenance protocol
    // produce the permanent facts; the finance role cannot manufacture them.
    await f.service.thorough(81, supplierRecycleActor(), { expectedIsDel: 1 });
  }, 60000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); }, 30000);
  async function login<T>(run: (peer: Login) => Promise<T>): Promise<T> {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Restricted compensation proof forbids external I/O'));
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [origin] = await f.db.execute(sql`SELECT current_database() AS database,current_schema() AS schema,current_user AS role,current_setting('server_version_num') AS version`);
    if (!ownsFinanceFixtureTarget(String(origin.database), String(origin.schema), base.href) || origin.role !== 'finance_test'
      || Math.floor(Number(origin.version)/10000) !== 16) throw Error('Owned PG16 compensation fixture required');
    const role = `cinashop_absence_${randomUUID().replaceAll('-', '')}`, password = randomUUID().replaceAll('-', '');
    let created = false, client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`); created = true;
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}";
        GRANT SELECT ON public.store_product,public.store_product_attr_value,public.store_product_sku_retirement_log TO "${role}";
        GRANT UPDATE(id,stock,sales) ON public.store_product,public.store_product_attr_value TO "${role}"`);
      base.pathname = `/${origin.database}`; base.username = role; base.password = password;
      client = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000' } });
      const [identity] = await client`SELECT current_user AS role,session_user AS session,current_setting('server_version_num') AS version`;
      expect(identity).toMatchObject({ role, session: role }); expect(Math.floor(Number(identity.version)/10000)).toBe(16);
      const connection = client;
      return await run({ role, db: drizzle(client) as unknown as DbClient, exec: statement => connection.unsafe(statement) });
    } finally {
      await client?.end({ timeout: 5 });
      if (created) { await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); expect(await f.exec(`SELECT rolname FROM pg_roles WHERE rolname='${role}'`)).toEqual([]); }
    }
  }
  it('measures the actual PG16 SRE ACL with old stock-column grants, then proves only the explicit additional table-lock grant permits the protected absence branch', async () => {
    await login(async peer => {
      const before = await supplierRecycleSnapshot(f.db);
      const [privileges] = await peer.exec(`SELECT
        has_table_privilege(current_user,'public.store_product','UPDATE') AS root_table_update,
        has_table_privilege(current_user,'public.store_product_attr_value','UPDATE') AS sku_table_update,
        has_column_privilege(current_user,'public.store_product','stock','UPDATE') AS root_stock_update,
        has_column_privilege(current_user,'public.store_product_attr_value','stock','UPDATE') AS sku_stock_update,
        has_table_privilege(current_user,'public.store_product_sku_retirement_log','SELECT') AS fact_select,
        has_table_privilege(current_user,'public.store_product_sku_retirement_log','INSERT,UPDATE,DELETE,TRUNCATE') AS fact_write,
        has_function_privilege(current_user,'public.guard_product_permanent_delete_log()','EXECUTE') AS fact_guard_execute,
        has_function_privilege(current_user,'public.guard_retired_product_sku()','EXECUTE') AS sku_guard_execute`);
      expect(privileges).toEqual({ root_table_update: false, sku_table_update: false, root_stock_update: true, sku_stock_update: true,
        fact_select: true, fact_write: false, fact_guard_execute: false, sku_guard_execute: false });
      const probe = await peer.db.transaction(tx => tx.execute(sql`LOCK TABLE ONLY public.store_product, ONLY public.store_product_attr_value IN SHARE ROW EXCLUSIVE MODE NOWAIT`))
        .then(() => ({ permitted: true, code: '' }), error => ({ permitted: false, code: pgCode(error) }));
      console.log('PERMANENT_DELETION_PG16_SRE_COLUMN_ACL', JSON.stringify({ ...privileges, probe }));
      expect(probe).toEqual({ permitted: false, code: '42501' });
      await expect(peer.db.transaction(tx => readPermanentlyDeletedBaseInventory(tx as unknown as DbClient, expected))).rejects.toMatchObject({ httpStatus: 503 });
      expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
      // This ephemeral fixture role is a new-feature positive control. It is
      // not the frozen manager profile and grants nothing in a production DB.
      await f.exec(`GRANT UPDATE ON public.store_product,public.store_product_attr_value TO "${peer.role}"`);
      expect(await peer.db.transaction(tx => readPermanentlyDeletedBaseInventory(tx as unknown as DbClient, expected))).toEqual({ skuId: 302, supplierId: 20, productType: 1 });
      expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
      for (const statement of ['DELETE FROM public.store_product WHERE false', 'UPDATE public.store_product_sku_retirement_log SET action=action WHERE false',
        "INSERT INTO public.store_product_sku_retirement_log(product_id,sku_id,action) VALUES(81,302,'permanent_delete')",
        'DELETE FROM public.store_product_sku_retirement_log WHERE false', 'TRUNCATE public.store_product_sku_retirement_log',
        'SELECT public.guard_product_permanent_delete_log()', 'SELECT public.guard_retired_product_sku()'])
        await expect(peer.exec(statement)).rejects.toMatchObject({ code: '42501' });
      expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
    });
  }, 30000);
  it('fails closed without SELECT on immutable facts even after the two real inventory table-lock privileges are supplied', async () => {
    await login(async peer => {
      await f.exec(`GRANT UPDATE ON public.store_product,public.store_product_attr_value TO "${peer.role}";
        REVOKE SELECT ON public.store_product_sku_retirement_log FROM "${peer.role}"`);
      const before = await supplierRecycleSnapshot(f.db);
      await expect(peer.db.transaction(tx => readPermanentlyDeletedBaseInventory(tx as unknown as DbClient, expected))).rejects.toMatchObject({ httpStatus: 503 });
      expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
    });
  }, 30000);
});
