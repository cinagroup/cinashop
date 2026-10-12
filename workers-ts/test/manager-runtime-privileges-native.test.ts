import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {withTx,createContainerFromDb,type DbClient} from '../src/lib/di';
import { auditManagerRuntimePrivileges, inspectManagerRuntimePrivileges,inspectManagerRuntimeCatalogPrerequisites } from '../src/migrations/auditManagerRuntimePrivileges';
import { managerRuntimeGrantSql, MANAGER_RUNTIME_ROLE } from '../src/migrations/managerRuntimePrivilegePlan';
import { managerOperationReadiness } from '../src/migrations/runManagerOrderOperation';
import { managerRefundMaterializationReadiness } from '../src/services/store/StoreManagerFinancialService';
import { managerRuntimePrivilegeFixture } from './helpers/managerRuntimePrivilegeFixture';
import { validateSequenceRunnerTestUrl } from './helpers/kefuSequenceRunnerDatabase';
import { MANAGER_SCOPE_CONTEXT } from '../src/migrations/managerRuntimeCapabilities';
import { writeOrderPromotionLedger } from '../src/services/order/OrderPromotionLedgerSplit';

describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL).sequential('fixed manager ACLs on owned native PG16', () => {
  let f: Awaited<ReturnType<typeof managerRuntimePrivilegeFixture>>;
  beforeEach(async () => {
    f = await managerRuntimePrivilegeFixture();
    await f.exec(`CREATE ROLE "${MANAGER_RUNTIME_ROLE}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    await f.markManagerRoleOwned();
    for (const statement of managerRuntimeGrantSql()) await f.exec(statement);
  }, 120_000);
  afterEach(async () => { await f?.close(); }, 30_000);

  it('stages NOLOGIN, verifies a genuine LOGIN and denies private/account/catalog writes', async () => {
    const absent=await f.db.execute<{name:string}>(sql`SELECT e.table_name||'.'||e.column_name AS name FROM
      (VALUES('order_waybill_job','actor_service_id'),('system_store','business'),('system_store','city_shop_id')) e(table_name,column_name)
      WHERE NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relnamespace='public'::regnamespace AND c.relname=e.table_name AND a.attname=e.column_name) ORDER BY 1`);
    expect(absent.map(r=>r.name)).toEqual(['order_waybill_job.actor_service_id','system_store.business','system_store.city_shop_id']);
    expect(await inspectManagerRuntimePrivileges(f.db, { requireLogin: false })).toMatchObject({ ready: true });
    expect((await inspectManagerRuntimePrivileges(f.db, { requireLogin: true })).failures).toContain('login_stage');
    const password = crypto.randomUUID().replaceAll('-', '');
    await f.exec(`ALTER ROLE "${MANAGER_RUNTIME_ROLE}" LOGIN PASSWORD '${password}'`);
    const target = validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL!);
    target.pathname = `/${f.database}`; target.username = MANAGER_RUNTIME_ROLE; target.password = password;
    const client = postgres(target.href, { max: 1, prepare: false, connect_timeout: 5 });
    try {
      const db = drizzle(client) as unknown as DbClient;
      expect(await auditManagerRuntimePrivileges(db)).toMatchObject({ ready: true, identity: {
        database: f.database, role: MANAGER_RUNTIME_ROLE, session: MANAGER_RUNTIME_ROLE, backend_role: MANAGER_RUNTIME_ROLE,
      } });
      expect(await managerOperationReadiness(db)).toMatchObject({ ready: true });
      expect(await managerRefundMaterializationReadiness(db)).toMatchObject({ ready: true });
      await expect(client.unsafe('UPDATE public."user" SET pwd=pwd WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(client.unsafe('UPDATE public.system_store_staff SET is_manager=is_manager WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(client.unsafe('UPDATE public.system_config SET value=value WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(client.unsafe('DELETE FROM public.manager_order_operation_request WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(client.unsafe('UPDATE public.store_order_invoice_evidence SET kind=kind WHERE false')).rejects.toMatchObject({ code: '42501' });
    } finally { await client.end({ timeout: 5 }); }
  });
  it('rejects an additional password column grant without repairing the role', async () => {
    await f.exec(`GRANT UPDATE(pwd) ON public."user" TO "${MANAGER_RUNTIME_ROLE}"`);
    const result = await inspectManagerRuntimePrivileges(f.db, { requireLogin: false });
    expect(result.ready).toBe(false); expect(result.failures).toContain('column:user.pwd:UPDATE');
    const [unchanged] = await f.db.execute(sql`SELECT has_column_privilege(${MANAGER_RUNTIME_ROLE},'public.user','pwd','UPDATE') AS allowed`);
    expect(unchanged.allowed).toBe(true);
  });
  it('binds promotion deletion to the real manager transaction and rejects incomplete or changed authority without deleting rows', async () => {
    const password=crypto.randomUUID().replaceAll('-','');
    await f.exec(`ALTER ROLE "${MANAGER_RUNTIME_ROLE}" LOGIN PASSWORD '${password}'`);
    await f.exec(`INSERT INTO public."user"(uid,pwd,status,is_del) VALUES(731,'manager-test-password',1,0);
      INSERT INTO public.system_store(id,is_store,is_show,is_del) VALUES(731,1,1,0);
      INSERT INTO public.system_store_staff(id,uid,store_id,status,is_del,order_status,is_manager) VALUES(731,731,731,1,0,1,1);
      INSERT INTO public.store_order(id,order_id,"unique",uid,store_id) VALUES(731,'manager-native-capability','manager-native-capability',732,731);
      INSERT INTO public.store_order_promotions(oid,uid,promotions_id,product_id,promotions_price,add_time) VALUES(731,732,731,731,'1.00',1)`);
    const [snapshot]=await f.db.execute<{original:Record<string,number>[]}>(sql`SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) AS original FROM public.store_order_promotions p WHERE oid=731`);
    const [digest]=await f.db.execute<{hash:string}>(sql`SELECT md5('manager-test-password') AS hash`);
    const context={actor_uid:731,store_id:731,staff_id:731,root_order_id:731,request_hash:'a'.repeat(64),kind:'split_delivery',auth_version:digest.hash,expires_at:2147483647};
    const target=validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL!);target.pathname=`/${f.database}`;target.username=MANAGER_RUNTIME_ROLE;target.password=password;
    const client=postgres(target.href,{max:1,prepare:false,connect_timeout:5});
    try{
      const variants=[Object.fromEntries(Object.entries(context).filter(([k])=>k!=='kind')),
        Object.fromEntries(Object.entries(context).filter(([k])=>k!=='request_hash')),
        {...context,kind:null},{...context,request_hash:null},{...context,extra:1},{...context,expires_at:1},
        {...context,root_order_id:999},{...context,auth_version:'b'.repeat(32)},{...context,actor_uid:999},
        {...context,staff_id:999},{...context,store_id:999},{...context,kind:'change_price'}];
      for(const invalid of variants){
        await expect(client.begin('isolation level read committed',async tx=>{
          await tx`SELECT public.manager_lock_scope_v1(731,731)`;
          await tx`SELECT set_config(${MANAGER_SCOPE_CONTEXT},${JSON.stringify(invalid)},true)`;
          await tx`SELECT public.manager_delete_order_promotions_v1(731,${tx.json(snapshot.original)}::jsonb)`;
        })).rejects.toMatchObject({code:'42501'});
        const [unchanged]=await f.db.execute(sql`SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) AS original FROM public.store_order_promotions p WHERE oid=731`);
        expect(unchanged.original).toEqual(snapshot.original);
      }
      await expect(client.begin('isolation level read committed',async tx=>{
        await tx`SELECT public.manager_lock_scope_v1(731,731)`;
        await tx`SELECT set_config(${MANAGER_SCOPE_CONTEXT},${JSON.stringify(context)},true)`;
        await tx`SELECT public.manager_delete_order_promotions_v1(731,'[]'::jsonb)`;
      })).rejects.toMatchObject({code:'40001'});
      await expect(client.begin('isolation level read committed',async tx=>{
        await tx`SELECT set_config(${MANAGER_SCOPE_CONTEXT},${JSON.stringify(context)},true)`;
        await tx`SELECT public.manager_delete_order_promotions_v1(731,${tx.json(snapshot.original)}::jsonb)`;
      })).rejects.toMatchObject({code:'42501'});
      await expect(client.unsafe('DELETE FROM public.store_order_promotions WHERE false')).rejects.toMatchObject({code:'42501'});
      await expect(client.unsafe('UPDATE public.order_waybill_job SET status=status WHERE false')).rejects.toMatchObject({code:'42501'});
      await client.begin('isolation level read committed',async tx=>{
        await tx`SELECT public.manager_lock_scope_v1(731,731),public.manager_lock_waybill_v1()`;
        await tx`SELECT set_config(${MANAGER_SCOPE_CONTEXT},${JSON.stringify(context)},true)`;
        expect((await tx`SELECT public.manager_delete_order_promotions_v1(731,${tx.json(snapshot.original)}::jsonb) AS deleted`)[0].deleted).toBe(1);
      });
      expect(await f.db.execute(sql`SELECT 1 FROM public.store_order_promotions WHERE oid=731`)).toHaveLength(0);
      await f.exec(`INSERT INTO public.store_order_promotions(oid,uid,promotions_id,product_id,promotions_price,add_time) VALUES(731,732,731,731,'1.00',1)`);
      const db=drizzle(client) as unknown as DbClient;
      await withTx(createContainerFromDb(db),async tx=>{
        await tx.execute(sql`SELECT public.manager_lock_scope_v1(731,731)`);
        await tx.execute(sql`SELECT set_config(${MANAGER_SCOPE_CONTEXT},${JSON.stringify(context)},true)`);
        await writeOrderPromotionLedger(tx,{id:731,uid:732,promotionsPrice:'0.00'},[],1,true);
      });
      expect(await f.db.execute(sql`SELECT 1 FROM public.store_order_promotions WHERE oid=731`)).toHaveLength(0);
    }finally{await client.end({timeout:5});}
  });
  it('rejects extra PUBLIC data, sequence delegation and unknown definer authority', async () => {
    await f.exec('CREATE TABLE public.manager_unreviewed_data(id integer); GRANT SELECT ON public.manager_unreviewed_data TO PUBLIC');
    await f.exec(`GRANT USAGE ON SEQUENCE public.store_order_id_seq TO "${MANAGER_RUNTIME_ROLE}" WITH GRANT OPTION`);
    await f.exec(`CREATE FUNCTION public.manager_unreviewed_function() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN NULL; END$$; REVOKE ALL ON FUNCTION public.manager_unreviewed_function() FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.manager_unreviewed_function() TO "${MANAGER_RUNTIME_ROLE}"`);
    await f.exec('CREATE FUNCTION public.manager_unreviewed_invoker() RETURNS integer LANGUAGE sql AS $$SELECT 1$$');
    const result = await inspectManagerRuntimePrivileges(f.db, { requireLogin: false });
    expect(result.ready).toBe(false);
    expect(result.failures).toContain('table:manager_unreviewed_data:SELECT');
    expect(result.failures).toContain('sequence:store_order_id_seq'); expect(result.failures).toContain('unreviewed_definer');
    expect(result.failures).toContain('unreviewed_routine:manager_unreviewed_invoker()');
  });
  it('rejects ledger/lock catalog drift and a missing required financial write', async () => {
    await f.exec('ALTER TABLE public.manager_order_operation_request DROP CONSTRAINT mor_kind_ck');
    await f.exec(`REVOKE INSERT ON public.store_order_refund_split FROM "${MANAGER_RUNTIME_ROLE}"`);
    const result = await inspectManagerRuntimePrivileges(f.db, { requireLogin: false });
    expect(result.ready).toBe(false); expect(result.failures).toContain('manager_operation_catalog');
    expect(result.failures).toContain('table:store_order_refund_split:INSERT');
  });
  it('accepts the complete fixed legacy profile without the unused gift receipt and proves an independent LOGIN',async()=>{
    await f.exec('DROP TABLE public.store_order_promotion_gift_coupon_reward;DROP INDEX public.ub_order_promotion_gift_uq');
    expect(await inspectManagerRuntimeCatalogPrerequisites(f.db)).toMatchObject({ready:true,profile:'legacy-without-promotion-gift-receipt',presence:{ready:true,failureCount:0}});
    expect(await inspectManagerRuntimePrivileges(f.db,{requireLogin:false})).toMatchObject({ready:true,profile:'legacy-without-promotion-gift-receipt'});
    const password=crypto.randomUUID().replaceAll('-','');await f.exec(`ALTER ROLE "${MANAGER_RUNTIME_ROLE}" LOGIN PASSWORD '${password}'`);
    const target=validateSequenceRunnerTestUrl(process.env.TEST_FINANCE_POSTGRES_URL!);target.pathname=`/${f.database}`;target.username=MANAGER_RUNTIME_ROLE;target.password=password;
    const client=postgres(target.href,{max:1,prepare:false,connect_timeout:5});
    try{expect(await auditManagerRuntimePrivileges(drizzle(client) as unknown as DbClient)).toMatchObject({ready:true,profile:'legacy-without-promotion-gift-receipt'});}
    finally{await client.end({timeout:5});}
  });
  it('reports complete fixed catalog prerequisites before any manager role exists and refuses another missing table',async()=>{
    await f.exec(`DROP OWNED BY "${MANAGER_RUNTIME_ROLE}";DROP ROLE "${MANAGER_RUNTIME_ROLE}"`);
    expect(await inspectManagerRuntimeCatalogPrerequisites(f.db)).toMatchObject({ready:true,profile:'current',presence:{ready:true,failureCount:0}});
    await f.exec('DROP TABLE public.system_attachment;ALTER TABLE public.system_store ADD COLUMN unreviewed_secret text');
    const state=await inspectManagerRuntimeCatalogPrerequisites(f.db);
    expect(state.ready).toBe(false);expect(state.presence.failures).toContain('missing:system_attachment');
    expect(state.presence.failures).toContain('unexpected_column:system_store.unreviewed_secret');
    expect(await f.db.execute(sql`SELECT oid FROM pg_roles WHERE rolname=${MANAGER_RUNTIME_ROLE}`)).toHaveLength(0);
  });
  it('refuses a present gift catalog drift and an orphaned gift sequence instead of selecting the legacy profile',async()=>{
    await f.exec('ALTER TABLE public.store_order_promotion_gift_coupon_reward ADD COLUMN unreviewed integer');
    const drift=await inspectManagerRuntimeCatalogPrerequisites(f.db);expect(drift.ready).toBe(false);expect(drift.profile).toBe('current');expect(drift.failures).toContain('promotion_gift_catalog');
    await f.exec('DROP TABLE public.store_order_promotion_gift_coupon_reward;CREATE SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq');
    const partial=await inspectManagerRuntimeCatalogPrerequisites(f.db);expect(partial.ready).toBe(false);expect(partial.failures).toContain('promotion_gift_residue');
  });
});
