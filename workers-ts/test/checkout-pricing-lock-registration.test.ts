import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { MigrationService } from '../src/services/MigrationService';
import { CHECKOUT_PRICING_LOCK_INSTALLATION_SQL } from '../src/migrations/checkoutPricingLockInstallation';
import { PRICING_OWNER_SETTING, pricingCatalogReady } from '../src/migrations/checkoutPricingLockCatalog';
import { inspectCheckoutPricingLock, auditCheckoutPricingLockRuntime } from '../src/migrations/checkoutPricingLock';
import { runCheckoutPricingLockSchema } from '../src/migrations/runCheckoutPricingLock';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { outcome } from './helpers/financePeers';

const external = readFileSync('migrations/0160_checkout_pricing_lock.sql','utf8');
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('registered pricing lock capability PG16',()=>{
  let f:Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>, ddl:string;
  beforeAll(async()=>{const kit=await import('drizzle-kit/api'),models=await import('../src/models/schema');
    ddl=(await kit.generateMigration(kit.generateDrizzleJson({}),kit.generateDrizzleJson(models))).join('\n');},120000);
  beforeEach(async()=>{f=await checkoutPricingMigrationDatabase();await f.exec(ddl);
    await f.exec("INSERT INTO public.system_config(menu_name,value) VALUES('whole_free_shipping','0'); INSERT INTO public.member_right(right_type,number,status) VALUES('express',50,1)");},120000);
  afterEach(async()=>{await f?.close();},120000);
  const raw=(statement=external)=>f.db.transaction(tx=>tx.execute(sql.raw(statement)),{isolationLevel:'read committed',accessMode:'read write'});
  const data=()=>f.query(`SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.system_config t) AS config,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.member_right t) AS rights`);
  const objects=()=>f.query(`SELECT oid::text,relfilenode::text,relname FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY oid`);
  const noInstallation=async()=>{
    expect((await inspectCheckoutPricingLock(f.db)).absent).toBe(true);
    const [rights]=await f.db.execute(sql`SELECT has_table_privilege(${f.pricingOwner},'public.system_config','UPDATE') AS writable,
      has_schema_privilege(${f.pricingOwner},'public','CREATE') AS creatable`);
    expect(rights).toMatchObject({writable:false,creatable:false});
  };
  it.each(['external','embedded-sql','root'] as const)('uses the same %s protocol and preserves data, existing object IDs and repeat OID/ACL',async mode=>{
    const embedded=new MigrationService(createContainerFromDb(f.db)).checkoutPricingLockMigrationSqlForVerification();
    expect(external.trim()).toBe(CHECKOUT_PRICING_LOCK_INSTALLATION_SQL.trim());expect(embedded).toBe(CHECKOUT_PRICING_LOCK_INSTALLATION_SQL);
    const install=()=>mode==='root'?runCheckoutPricingLockSchema(f.db):raw(mode==='external'?external:embedded);
    const before=await data(),identities=await objects();await install();
    const state=await inspectCheckoutPricingLock(f.db);expect(pricingCatalogReady(state)).toBe(true);
    await install();expect(await inspectCheckoutPricingLock(f.db)).toEqual(state);
    expect(await objects()).toEqual(identities);expect(await data()).toEqual(before);
    await f.withRuntimeRole!(async peer=>{
      const [setting]=await peer.db.execute(sql`SELECT nullif(current_setting(${PRICING_OWNER_SETTING},true),'') AS owner`);
      expect(setting?.owner).toBe(null);
      expect((await auditCheckoutPricingLockRuntime(peer.db)).ready).toBe(false);
      await expect(peer.exec('SELECT public.checkout_lock_pricing_v1()')).rejects.toMatchObject({code:'42501'});
    });
  });
  it.each(['raw','root'] as const)('requires explicit owner configuration even through %s SQL',async mode=>{
    await f.db.execute(sql`SELECT set_config(${PRICING_OWNER_SETTING},'',false)`);
    const before=await data();await expect(mode==='raw'?raw():runCheckoutPricingLockSchema(f.db)).rejects.toThrow();
    await noInstallation();expect(await data()).toEqual(before);
  });
  it.each(['unknown_role','pg_database_owner','public;select 1','x'.repeat(64)])('refuses invalid or absent explicit owner %s without effects',async value=>{
    await f.db.execute(sql`SELECT set_config(${PRICING_OWNER_SETTING},${value},false)`);
    await expect(raw()).rejects.toThrow();await noInstallation();
  });
  it.each(['repeatable read','serializable'] as const)('refuses raw installation at %s',async isolationLevel=>{
    await expect(f.db.transaction(tx=>tx.execute(sql.raw(external)),{isolationLevel})).rejects.toThrow();await noInstallation();
  });
  it('refuses a read-only maintenance transaction without leaving partial grants',async()=>{
    await expect(f.db.transaction(tx=>tx.execute(sql.raw(external)),{accessMode:'read only'})).rejects.toThrow();await noInstallation();
  });
  it('restores caller search_path and honors stricter local timeouts without shadowing catalog functions',async()=>{
    await f.exec(`CREATE SCHEMA pricing_shadow;
      CREATE FUNCTION pricing_shadow.current_setting(text) RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'untrusted shadow called'; END$$;
      SET search_path=pricing_shadow,pg_catalog,public`);
    try {
      await f.db.transaction(async tx=>{
        await tx.execute(sql`SET LOCAL statement_timeout='2000ms'`);await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
        await tx.execute(sql.raw(external));
        const [state]=await tx.execute(sql`SELECT pg_catalog.current_setting('statement_timeout') AS statement,
          pg_catalog.current_setting('lock_timeout') AS lock,pg_catalog.current_setting('search_path') AS path`);
        expect(state).toMatchObject({statement:'2s',lock:'500ms',path:'pg_catalog,pg_temp'});
      });
      const [state]=await f.db.execute(sql`SELECT pg_catalog.current_setting('search_path') AS path`);
      expect(state?.path).toBe('pricing_shadow, pg_catalog, public');
    }finally{await f.exec('SET search_path=public,pg_temp');}
    expect(pricingCatalogReady(await inspectCheckoutPricingLock(f.db))).toBe(true);
  });
  it('rolls all new grants and function creation back when the outer maintenance transaction aborts',async()=>{
    await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(external));throw Error('rollback');})).rejects.toThrow('rollback');
    await noInstallation();
  });
  it.each(['gate','member_right','system_config'])('rejects raw maintenance competition on %s without residue',async target=>{
    await f.withPeer!(async peer=>{
      await peer.exec('BEGIN');
      try {
        await peer.exec(target==='gate'?"SELECT pg_advisory_xact_lock_shared(731622,'public'::regnamespace::integer)":`LOCK TABLE public.${target} IN ROW EXCLUSIVE MODE`);
        const result=await outcome(raw());expect(result.ok).toBe(false);
      }finally{await peer.exec('ROLLBACK');}
    });
    await noInstallation();
  });
  it.each([
    "CREATE OR REPLACE FUNCTION public.checkout_lock_pricing_v1() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN NULL; END'",
    'GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO PUBLIC',
    'ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY',
  ])('rejects raw upgrade drift without replacing an existing object: %s',async statement=>{
    await raw();await f.exec(statement);const state=await inspectCheckoutPricingLock(f.db),before=await data(),identities=await objects();
    await expect(raw()).rejects.toThrow();expect(await inspectCheckoutPricingLock(f.db)).toEqual(state);
    expect(await data()).toEqual(before);expect(await objects()).toEqual(identities);
  });
});
