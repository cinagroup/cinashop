import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderRefund,storeOrderRefundPayment,storeOrderPromotions} from '@/models/schema';
import {storeOrderRefundSplit} from '@/models/schema/order_refund_split';
import {SUPPLIER_MANUAL_REFUND_SQL,SUPPLIER_MANUAL_REFUND_CONSTRAINTS_SHA256,inspectSupplierManualRefund,
  installSupplierManualRefund,assertSupplierManualRefundReady} from '@/migrations/supplierManualRefund';
import {financePostgres,validateFinanceFixtureUrl} from './helpers/financePostgres';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent Supplier cash refund PG16 catalog',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>,owner:string,channelLockOwner:string;
  const roles:string[]=[];
  beforeAll(async()=>{f=await financePostgres([storeOrder,storeOrderRefund,storeOrderRefundPayment,storeOrderPromotions,storeOrderRefundSplit],{namespace:'public'});},60000);
  beforeEach(async()=>{
    await f.exec('DROP TABLE IF EXISTS public.supplier_manual_refund_operation_v1 CASCADE; DROP TABLE IF EXISTS public.supplier_manual_refund_proof_v1 CASCADE; DROP FUNCTION IF EXISTS public.supplier_manual_refund_immutable_v1(); DROP FUNCTION IF EXISTS public.supplier_manual_refund_promotion_delete_v1(integer,integer); DROP FUNCTION IF EXISTS public.supplier_manual_refund_promotion_lock_v1(); DROP FUNCTION IF EXISTS public.supplier_manual_refund_channel_lock_v1()');
    // Each case owns one constrained promotion principal. Remove the previous
    // case's ACLs too, rather than leaving another DELETE owner in this DB.
    for(const role of roles.splice(0))await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    owner='supplier_manual_owner_'+randomUUID().replaceAll('-','');channelLockOwner='supplier_channel_owner_'+randomUUID().replaceAll('-','');roles.push(owner,channelLockOwner);
    await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE "${channelLockOwner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  });
  afterAll(async()=>{try{for(const role of roles)await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);}finally{await f?.close();}},30000);
  it('pins the independent PG16 Supplier manual refund catalog',async()=>{
    expect(readFileSync(resolve(import.meta.dirname,'../src/migrations/maintenance/0195_supplier_manual_refund.sql'),'utf8').split('\n').slice(1).join('\n')).toBe(SUPPLIER_MANUAL_REFUND_SQL);
    await f.db.transaction(async tx=>{
      await tx.execute(sql`SELECT set_config('cinashop.supplier_manual_refund_owner',${owner},true)`);
      await tx.execute(sql`SELECT set_config('cinashop.supplier_manual_refund_channel_owner',${channelLockOwner},true)`);
      await tx.execute(sql.raw(SUPPLIER_MANUAL_REFUND_SQL));
      const state=await inspectSupplierManualRefund(tx);console.log('SUPPLIER_MANUAL_REFUND_PG16_CATALOG',JSON.stringify(state));
      expect(state.constraints_hash).toBe(SUPPLIER_MANUAL_REFUND_CONSTRAINTS_SHA256);await assertSupplierManualRefundReady(tx);
    });
    expect(readFileSync(resolve(import.meta.dirname,'../src/services/MigrationService.ts'),'utf8')).not.toContain('supplierManualRefund');
  });
  it('requires explicit owner transactions, installs no business rows and is exactly idempotent',async()=>{
    await expect(installSupplierManualRefund(f.db,{promotionOwner:owner,channelLockOwner})).rejects.toThrow('transaction');
    expect(await f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner,channelLockOwner}))).toEqual({applied:true});
    expect(await f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner,channelLockOwner}))).toEqual({applied:false});
    expect(await f.exec('SELECT * FROM public.supplier_manual_refund_operation_v1')).toEqual([]);
    expect(await f.exec('SELECT * FROM public.supplier_manual_refund_proof_v1')).toEqual([]);
  });
  it('rejects unsupported and partial catalogs without repairing them',async()=>{
    for(const options of [{isolationLevel:'repeatable read' as const},{accessMode:'read only' as const}])
      await expect(f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner,channelLockOwner}),options)).rejects.toThrow();
    await f.exec('CREATE TABLE public.supplier_manual_refund_operation_v1(operation_id uuid)');
    await expect(f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner,channelLockOwner}))).rejects.toThrow('Partial');
    expect(await f.exec("SELECT to_regclass('public.supplier_manual_refund_proof_v1')::text AS value")).toEqual([{value:null}]);
  });
  it('rejects column CHECK index trigger function owner and ACL drift without repair',async()=>{
    await f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner,channelLockOwner}));
    for(const statement of ['ALTER TABLE public.supplier_manual_refund_proof_v1 ADD COLUMN unsupported text',
      'ALTER TABLE public.supplier_manual_refund_proof_v1 DROP CONSTRAINT smrp_bytes_ck',
      'CREATE INDEX bad_smr_index ON public.supplier_manual_refund_operation_v1(actor_id)',
      'ALTER TABLE public.supplier_manual_refund_operation_v1 ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.supplier_manual_refund_proof_v1 DISABLE TRIGGER smrp_immutable_rows',
      'ALTER FUNCTION public.supplier_manual_refund_immutable_v1() SECURITY DEFINER',
      'ALTER FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) RESET ALL',
      'ALTER FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) OWNER TO finance_test',
      'ALTER FUNCTION public.supplier_manual_refund_channel_lock_v1() RESET ALL',
      'ALTER FUNCTION public.supplier_manual_refund_promotion_lock_v1() SECURITY INVOKER',
      `GRANT SELECT ON public.store_order_refund_payment TO "${channelLockOwner}"`,
      `GRANT UPDATE ON public.store_order_refund TO "${channelLockOwner}"`,
      'GRANT SELECT ON public.supplier_manual_refund_proof_v1 TO PUBLIC',
      'GRANT EXECUTE ON FUNCTION public.supplier_manual_refund_promotion_delete_v1(integer,integer) TO PUBLIC',
      'GRANT EXECUTE ON FUNCTION public.supplier_manual_refund_channel_lock_v1() TO PUBLIC']){
      await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(statement));await assertSupplierManualRefundReady(tx);})).rejects.toMatchObject({httpStatus:503});
      await f.db.transaction(tx=>assertSupplierManualRefundReady(tx));
    }
  });
  it('keeps proof and operation rows append-only even for the maintenance owner',async()=>{
    await f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner,channelLockOwner}));
    const uuid=randomUUID();await f.exec(`INSERT INTO public.supplier_manual_refund_operation_v1 VALUES('${uuid}',21,7,1,'','not_applied',NULL,'','',NULL,1)`);
    for(const command of ['UPDATE public.supplier_manual_refund_operation_v1 SET actor_id=22','DELETE FROM public.supplier_manual_refund_operation_v1','TRUNCATE public.supplier_manual_refund_operation_v1','TRUNCATE public.supplier_manual_refund_proof_v1'])
      await expect(f.exec(command)).rejects.toMatchObject({code:'42501'});
    await expect(f.exec('SELECT public.supplier_manual_refund_promotion_delete_v1(1,1)')).rejects.toThrow();
  });
  it('uses an independently authenticated SELECT-only reader and denies all receipt mutation and definer execution',async()=>{
    await f.db.transaction(tx=>installSupplierManualRefund(tx,{promotionOwner:owner,channelLockOwner}));
    const role='supplier_manual_read_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');roles.push(role);
    const [identity]=await f.exec('SELECT current_database() AS database') as Array<{database:string}>;
    await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'; GRANT CONNECT ON DATABASE "${identity.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON public.supplier_manual_refund_operation_v1,public.supplier_manual_refund_proof_v1 TO "${role}"`);
    const url=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');url.pathname='/'+identity.database;url.username=role;url.password=password;
    const client=postgres(url.href,{max:1,prepare:false,connect_timeout:5,connection:{options:'-c search_path=public,pg_temp'}});
    try{
      const db=drizzle(client) as unknown as DbClient;await db.transaction(tx=>assertSupplierManualRefundReady(tx,'read'));
      expect((await client`SELECT current_user AS role,session_user AS session`)[0]).toEqual({role,session:role});
      for(const command of [`INSERT INTO public.supplier_manual_refund_operation_v1 VALUES('${randomUUID()}',21,7,1,'','not_applied',NULL,'','',NULL,1)`,'UPDATE public.supplier_manual_refund_proof_v1 SET actor_id=2','DELETE FROM public.supplier_manual_refund_operation_v1','TRUNCATE public.supplier_manual_refund_proof_v1','SELECT public.supplier_manual_refund_promotion_delete_v1(1,1)',
        'SELECT public.supplier_manual_refund_channel_lock_v1()','SELECT public.supplier_manual_refund_promotion_lock_v1()'])
        await expect(client.unsafe(command)).rejects.toMatchObject({code:'42501'});
    }finally{await client.end({timeout:5});}
  },30000);
});
