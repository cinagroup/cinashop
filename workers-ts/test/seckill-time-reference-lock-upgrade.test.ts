import { readFileSync, readdirSync } from 'node:fs';
import { assertExternalMigrationCohort, composeExplicitCityCatalog, registeredTableNames } from './helpers/registeredCatalogCohort';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MigrationService } from '../src/services/MigrationService';
import { createContainerFromDb } from '../src/lib/di';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { readCatalog } from '../scripts/data-migration/postgres-catalog-audit';
import { runSeckillTimeReferenceLockSchema } from '../src/migrations/runSeckillTimeReferenceLock';
import { inspectSeckillTimeReferenceLock } from '../src/migrations/seckillTimeReferenceLock';
import { seckillTimeReferenceLockCatalogReady } from '../src/migrations/seckillTimeReferenceLockCatalog';
import { PRICING_OWNER_SETTING } from '../src/migrations/checkoutPricingLockCatalog';
import { SECKILL_TIME_REFERENCE_OWNER_SETTING } from '../src/migrations/seckillTimeReferenceLockCatalog';

type Fixture = Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>;
const file = '0167_seckill_time_reference_lock.sql';
const files = () => readdirSync('migrations').filter(name => /^\d+.*\.sql$/u.test(name)).sort();
async function bindOwners(f: Fixture) {
  if (!f.seckillTimeReferenceOwner) throw Error('Explicit fixture reference owner missing');
  await f.db.execute(sql`SELECT set_config(${PRICING_OWNER_SETTING},${f.pricingOwner},false),
    set_config(${SECKILL_TIME_REFERENCE_OWNER_SETTING},${f.seckillTimeReferenceOwner},false)`);
}
async function applyExternal(f: Fixture, names: string[]) {
  await bindOwners(f);
  for (const name of names) await f.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
    await tx.execute(sql.raw(readFileSync(`migrations/${name}`, 'utf8')));
  });
}
async function catalog(f: Fixture) {
  return readCatalog(async query => (await f.query(query)).rows.map(row => {
    if (typeof row.key !== 'string' || typeof row.name !== 'string') throw Error('Invalid catalog row identity');
    return { ...row, key: row.key, name: row.name };
  }));
}
async function identities(f: Fixture) {
  return (await f.query(`SELECT c.oid,c.relname,c.relkind,c.relowner,c.relacl,c.reloptions,
    c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace ORDER BY c.relname`)).rows;
}
async function routineIdentities(f: Fixture) {
  return (await f.query(`SELECT p.oid,p.proname,p.proowner,p.proacl,p.prosrc,p.proconfig
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname<>'admin_lock_seckill_time_references_v1' ORDER BY p.oid`)).rows;
}
async function existingPrivileges(f: Fixture) {
  return (await f.query(`WITH owner AS (SELECT oid FROM pg_roles WHERE rolname='${f.seckillTimeReferenceOwner}')
    SELECT 'relation' AS kind,c.relname AS object,'' AS column_name,a.grantor,a.grantee,a.privilege_type,a.is_grantable
    FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
    WHERE c.relnamespace='public'::regnamespace AND a.grantee<>(SELECT oid FROM owner)
    UNION ALL SELECT 'column',c.relname,col.attname,a.grantor,a.grantee,a.privilege_type,a.is_grantable
    FROM pg_class c JOIN pg_attribute col ON col.attrelid=c.oid,
      LATERAL aclexplode(col.attacl) a
    WHERE c.relnamespace='public'::regnamespace AND a.grantee<>(SELECT oid FROM owner)
    UNION ALL SELECT 'schema',n.nspname,'',a.grantor,a.grantee,a.privilege_type,a.is_grantable
    FROM pg_namespace n,LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname='public' AND a.grantee<>(SELECT oid FROM owner)
    UNION ALL SELECT 'routine',p.proname,'',a.grantor,a.grantee,a.privilege_type,a.is_grantable
    FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.pronamespace='public'::regnamespace AND p.proname<>'admin_lock_seckill_time_references_v1'
      AND a.grantee<>(SELECT oid FROM owner)
    ORDER BY kind,object,column_name,grantor,grantee,privilege_type,is_grantable`)).rows;
}
async function allRows(f: Fixture): Promise<Record<string, string[]>> {
  const tables = (await f.query(`SELECT relname FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname`)).rows;
  const rows: Record<string, string[]> = {};
  for (const { relname } of tables) {
    if (typeof relname !== 'string' || !relname) throw Error('Invalid table identity');
    rows[relname] = (await f.query(`SELECT to_jsonb(t)::text AS row_json FROM ONLY public."${relname.replaceAll('"', '""')}" t
      ORDER BY to_jsonb(t)::text`)).rows.map(row => {
      if (typeof row.row_json !== 'string') throw Error('Invalid captured business row'); return row.row_json;
    });
  }
  return rows;
}
async function assertCapability(f: Fixture) {
  const state = await inspectSeckillTimeReferenceLock(f.db);
  expect(seckillTimeReferenceLockCatalogReady(state)).toBe(true);
  expect(f.seckillTimeReferenceOwner).toMatch(/^cinashop_runtime_[a-f0-9]{32}$/);
  const [owner] = await f.db.execute(sql`SELECT oid::text AS oid FROM pg_roles WHERE rolname=${f.seckillTimeReferenceOwner}`);
  expect(state.ownerOid).toBe(owner.oid);
  const [rights] = await f.db.execute(sql`SELECT
    has_table_privilege(${f.seckillTimeReferenceOwner},'public.store_activity','UPDATE') AS parent_lock,
    has_table_privilege(${f.seckillTimeReferenceOwner},'public.store_seckill','UPDATE') AS child_lock,
    has_table_privilege(${f.seckillTimeReferenceOwner},'public.store_seckill_time','UPDATE') AS slot_write,
    has_schema_privilege(${f.seckillTimeReferenceOwner},'public','CREATE') AS schema_create,
    EXISTS(SELECT 1 FROM pg_proc p,LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.proname='admin_lock_seckill_time_references_v1' AND a.grantee<>p.proowner) AS runtime_grant`);
  expect(rights).toEqual({ parent_lock: true, child_lock: true, slot_write: false, schema_create: false, runtime_grant: false });
  return state;
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('seckill capability complete PG16 schema paths', () => {
  it('forwards the full catalog through 0166 using only 0167, preserving every business row, existing ACL and five DDL categories', async () => {
    const f = await checkoutPricingMigrationDatabase();
    try {
      const list = files().filter(name => name <= file); expect(list).toHaveLength(171); expect(list.at(-1)).toBe(file);
      expect(list).toContain('0166_recharge_quota_group_seed.sql');expect(list).toContain('0167_member_barcode_index.sql');
      const previous = list.slice(0, -1); expect(previous).toHaveLength(170); expect(previous.at(-1)).toBe('0167_member_barcode_index.sql');
      await applyExternal(f, previous);
      await f.exec(`INSERT INTO public."user"(uid,account,now_money,brokerage_price) VALUES(10,'slot-upgrade-user',123.45,6.78);
        INSERT INTO user_recharge(uid,order_id,price,give_price,paid) VALUES(10,'slot-upgrade-recharge',23.45,1.23,0);
        INSERT INTO store_order(uid,order_id,total_price,pay_price) VALUES(10,'slot-upgrade-order',20.50,20.50);
        INSERT INTO system_config(menu_name,value,info) VALUES('slot_upgrade_setting','existing-value','existing setting');
        INSERT INTO store_seckill_time(start_time,end_time,title,pic,status) VALUES('08:00','09:00','existing slot','/api/assets/123',0);
        INSERT INTO store_activity(type,is_del,time_id,start_time,end_time) VALUES(1,0,'1',800,900);
        INSERT INTO store_seckill(time_id,is_del) VALUES('1',0);
        INSERT INTO system_log(admin_id,type,path,method,action) VALUES(0,'slot_upgrade_fixture','/fixture/keep','GET','keep-audit');`);
      const beforeRows = await allRows(f), beforeCatalog = await catalog(f), beforeIdentity = await identities(f), beforeRoutines = await routineIdentities(f);
      expect(beforeRows.store_seckill_time).toHaveLength(1); expect(beforeRows.store_activity).toHaveLength(1);
      expect(beforeRows.store_seckill).toHaveLength(1); expect(beforeRows.user_recharge).toHaveLength(1);
      expect((await inspectSeckillTimeReferenceLock(f.db)).absent).toBe(true);
      const role = f.withRuntimeRole; if (!role) throw Error('Real LOGIN required');
      await role(async existing => {
        await f.exec(`GRANT SELECT ON store_activity,store_seckill,store_seckill_time TO "${existing.role}"`);
        const priorGrants = await existingPrivileges(f);
        await bindOwners(f);
        await runSeckillTimeReferenceLockSchema(f.db);
        await assertCapability(f);
        expect(await existingPrivileges(f)).toEqual(priorGrants);
        const [runtime] = await existing.db.execute(sql`SELECT
          has_function_privilege(current_user,'public.admin_lock_seckill_time_references_v1()','EXECUTE') AS callable,
          has_table_privilege(current_user,'public.store_activity','UPDATE') AS writable,
          has_table_privilege(current_user,'public.store_seckill_time','DELETE') AS removable`);
        expect(runtime).toEqual({ callable: false, writable: false, removable: false });
      });
      expect(await allRows(f)).toEqual(beforeRows); expect(await catalog(f)).toEqual(beforeCatalog);
      expect(await routineIdentities(f)).toEqual(beforeRoutines);
      const afterIdentity = await identities(f);
      expect(afterIdentity.map(({ relacl: _, ...row }) => row)).toEqual(beforeIdentity.map(({ relacl: _, ...row }) => row));
      // Exact ACL comparison excludes only the new, independently owned capability role.
      const [newOwner] = await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${f.seckillTimeReferenceOwner}`);
      const acl = (await f.query(`SELECT c.relname,a.grantee,a.grantor,a.privilege_type,a.is_grantable
        FROM pg_class c,LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('store_activity','store_seckill') AND a.grantee=${Number(newOwner.oid)}
        ORDER BY c.relname,a.privilege_type`)).rows;
      expect(acl.map(row => ({ relname: row.relname, privilege_type: row.privilege_type, is_grantable: row.is_grantable })))
        .toEqual([{ relname: 'store_activity', privilege_type: 'UPDATE', is_grantable: false }, { relname: 'store_seckill', privilege_type: 'UPDATE', is_grantable: false }]);
      const stableRows = await allRows(f), stableIdentities = await identities(f), stable = await inspectSeckillTimeReferenceLock(f.db);
      await bindOwners(f);
      await runSeckillTimeReferenceLockSchema(f.db); expect(await inspectSeckillTimeReferenceLock(f.db)).toEqual(stable);
      expect(await allRows(f)).toEqual(stableRows); expect(await identities(f)).toEqual(stableIdentities);
    } finally { await f.close(); }
  }, 120_000);

  it('builds the current external 176-file and embedded 180-step catalogs with explicit city composition and identical five-category schema and exact independent capability', async () => {
    const external = await checkoutPricingMigrationDatabase();
    const embedded = await checkoutPricingMigrationDatabase();
    try {
      const list = files(); assertExternalMigrationCohort(list); expect(list.at(-1)).toBe('0173_customer_city_delivery.sql');
      await applyExternal(external, list);
      // The second root connection can expire while the first full catalog is
      // built. Bind explicit owner settings to this actual maintenance session.
      await bindOwners(embedded);
      const result = await new MigrationService(createContainerFromDb(embedded.db)).runAll();
      expect(result.errors).toEqual([]);
      expect(result.executed).toEqual(Array.from({ length: 180 }, (_, index) => String(index).padStart(4, '0')));
      await composeExplicitCityCatalog(external.db,'external');await composeExplicitCityCatalog(embedded.db,'embedded');
      expect(await catalog(embedded)).toEqual(await catalog(external));
      for (const f of [external, embedded]) {
        await assertCapability(f);
        const rows = await allRows(f);
        expect(Object.keys(rows)).toEqual(registeredTableNames('external'));
        for (const name of ['user', 'store_order', 'user_recharge', 'store_activity', 'store_seckill', 'store_seckill_time']) expect(rows[name]).toEqual([]);
        expect(rows.system_group).toHaveLength(1); expect(rows.system_group_data).toEqual([]); expect(rows.system_log).toHaveLength(1);
        const state = await inspectSeckillTimeReferenceLock(f.db), identity = await identities(f);
        await bindOwners(f);
        await runSeckillTimeReferenceLockSchema(f.db); expect(await inspectSeckillTimeReferenceLock(f.db)).toEqual(state);
        expect(await identities(f)).toEqual(identity); expect(await allRows(f)).toEqual(rows);
      }
    } finally { await embedded.close(); await external.close(); }
  }, 180_000);
});
