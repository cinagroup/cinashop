import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { SUPPLIER_ORDER_EDIT_OPERATION_SQL, SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256,
  inspectSupplierOrderEditOperation, assertSupplierOrderEditOperationReady, installSupplierOrderEditOperation } from '@/migrations/supplierOrderEditOperation';
import { financePostgres, validateFinanceFixtureUrl } from './helpers/financePostgres';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent Supplier order edit receipt PG16 catalog',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async()=>{f=await financePostgres([],{namespace:'public'});},60000);
  beforeEach(async()=>{await f.exec('DROP TABLE IF EXISTS public.supplier_order_edit_operation_v1 CASCADE; DROP FUNCTION IF EXISTS public.supplier_order_edit_operation_immutable_v1()');});
  afterAll(async()=>{await f?.close();},30000);
  it('pins actual PG16 Supplier order edit receipt constraints and the exact independent SQL mirror',async()=>{
    expect(readFileSync(resolve(import.meta.dirname,'../src/migrations/maintenance/0191_supplier_order_edit_operation.sql'),'utf8').split('\n').slice(1).join('\n')).toBe(SUPPLIER_ORDER_EDIT_OPERATION_SQL);
    await f.db.transaction(async tx=>{
      await tx.execute(sql.raw(SUPPLIER_ORDER_EDIT_OPERATION_SQL));
      const actual=await inspectSupplierOrderEditOperation(tx);
      console.log('SUPPLIER_ORDER_EDIT_OPERATION_PG16_CATALOG',JSON.stringify(actual));
      expect(actual?.constraints_hash).toBe(SUPPLIER_ORDER_EDIT_OPERATION_CONSTRAINTS_SHA256);
      await assertSupplierOrderEditOperationReady(tx);
    });
    expect(readFileSync(resolve(import.meta.dirname,'../src/services/MigrationService.ts'),'utf8')).not.toContain('supplierOrderEditOperation');
  });
  it('installs only with explicit owner maintenance, remains idempotent and does not create any business rows',async()=>{
    await expect(installSupplierOrderEditOperation(f.db)).rejects.toThrow('transaction');
    expect(await f.db.transaction(tx=>installSupplierOrderEditOperation(tx))).toEqual({applied:true});
    expect(await f.db.transaction(tx=>installSupplierOrderEditOperation(tx))).toEqual({applied:false});
    expect(await f.exec('SELECT * FROM public.supplier_order_edit_operation_v1')).toEqual([]);
  });
  it('refuses missing and partial catalogs without repairing them',async()=>{
    await expect(f.db.transaction(tx=>assertSupplierOrderEditOperationReady(tx))).rejects.toMatchObject({httpStatus:503});
    await f.exec('CREATE TABLE public.supplier_order_edit_operation_v1(operation_id uuid)');
    await expect(f.db.transaction(tx=>installSupplierOrderEditOperation(tx))).rejects.toThrow('Partial');
    expect(await f.exec("SELECT count(*)::integer AS n FROM pg_proc WHERE proname='supplier_order_edit_operation_immutable_v1'")).toEqual([{n:0}]);
  });
  it('rejects unsupported transaction contexts without adding objects',async()=>{
    for(const options of [{isolationLevel:'repeatable read' as const},{accessMode:'read only' as const}])
      await expect(f.db.transaction(tx=>installSupplierOrderEditOperation(tx),options)).rejects.toThrow();
    expect(await f.exec("SELECT to_regclass('public.supplier_order_edit_operation_v1')::text AS value")).toEqual([{value:null}]);
  });
  it('rejects exact catalog drift in constraints, columns, indexes, function, trigger and ACL without repair',async()=>{
    await f.db.transaction(tx=>installSupplierOrderEditOperation(tx));
    for(const statement of [
      'ALTER TABLE public.supplier_order_edit_operation_v1 DROP CONSTRAINT soeo_identity_ck',
      'ALTER TABLE public.supplier_order_edit_operation_v1 ADD COLUMN extra text',
      'CREATE INDEX bad_extra_copy_index ON public.supplier_order_edit_operation_v1(actor_id)',
      'ALTER TABLE public.supplier_order_edit_operation_v1 ENABLE ROW LEVEL SECURITY',
      'ALTER FUNCTION public.supplier_order_edit_operation_immutable_v1() SECURITY DEFINER',
      'ALTER FUNCTION public.supplier_order_edit_operation_immutable_v1() RESET ALL',
      'GRANT EXECUTE ON FUNCTION public.supplier_order_edit_operation_immutable_v1() TO PUBLIC',
      'GRANT SELECT ON public.supplier_order_edit_operation_v1 TO PUBLIC',
      'ALTER TABLE public.supplier_order_edit_operation_v1 DISABLE TRIGGER soeo_immutable_rows',
    ]){
      await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(statement));await assertSupplierOrderEditOperationReady(tx);})).rejects.toMatchObject({httpStatus:503});
      await f.db.transaction(tx=>assertSupplierOrderEditOperationReady(tx));
    }
  });
  it('uses an independent restricted LOGIN with only receipt SELECT INSERT and rejects evidence update delete truncate and direct guard execute',async()=>{
    const role='copy_receipt_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');
    const [origin]=await f.exec('SELECT current_database() AS database') as Array<{database:string}>;
    let connection:ReturnType<typeof postgres>|undefined;
    await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    try{
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"`);
      await f.db.transaction(tx=>installSupplierOrderEditOperation(tx,role));
      const url=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');url.pathname='/'+origin.database;url.username=role;url.password=password;
      connection=postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,connection:{options:'-c search_path=public,pg_temp'}});
      const db=drizzle(connection) as unknown as DbClient;
      await db.transaction(tx=>assertSupplierOrderEditOperationReady(tx));
      const id=randomUUID();
      await connection.unsafe(`INSERT INTO public.supplier_order_edit_operation_v1 VALUES('${id}',21,20,80,'','not_applied','','',NULL,NULL,1)`);
      for(const command of ['UPDATE public.supplier_order_edit_operation_v1 SET actor_id=22','DELETE FROM public.supplier_order_edit_operation_v1','TRUNCATE public.supplier_order_edit_operation_v1','SELECT public.supplier_order_edit_operation_immutable_v1()'])
        await expect(connection.unsafe(command)).rejects.toMatchObject({code:'42501'});
      expect(await f.exec('SELECT actor_id,supplier_id,order_id FROM public.supplier_order_edit_operation_v1')).toEqual([{actor_id:21,supplier_id:20,order_id:80}]);
    }finally{await connection?.end({timeout:5});await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);}
  },30000);
});
