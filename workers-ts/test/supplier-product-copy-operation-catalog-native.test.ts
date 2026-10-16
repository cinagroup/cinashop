import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { SUPPLIER_PRODUCT_COPY_OPERATION_SQL, SUPPLIER_PRODUCT_COPY_OPERATION_CONSTRAINTS_SHA256,
  inspectSupplierProductCopyOperation, assertSupplierProductCopyOperationReady, installSupplierProductCopyOperation } from '@/migrations/supplierProductCopyOperation';
import { financePostgres, validateFinanceFixtureUrl } from './helpers/financePostgres';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent Supplier product copy receipt PG16 catalog',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async()=>{f=await financePostgres([],{namespace:'public'});},60000);
  beforeEach(async()=>{await f.exec('DROP TABLE IF EXISTS public.supplier_product_copy_operation_v1 CASCADE; DROP FUNCTION IF EXISTS public.supplier_product_copy_operation_immutable_v1()');});
  afterAll(async()=>{await f?.close();},30000);
  it('pins actual PG16 Supplier copy receipt constraints and the exact independent SQL mirror',async()=>{
    expect(readFileSync(resolve(import.meta.dirname,'../src/migrations/maintenance/0190_supplier_product_copy_operation.sql'),'utf8').split('\n').slice(1).join('\n')).toBe(SUPPLIER_PRODUCT_COPY_OPERATION_SQL);
    await f.db.transaction(async tx=>{
      await tx.execute(sql.raw(SUPPLIER_PRODUCT_COPY_OPERATION_SQL));
      const actual=await inspectSupplierProductCopyOperation(tx);
      console.log('SUPPLIER_PRODUCT_COPY_OPERATION_PG16_CATALOG',JSON.stringify(actual));
      expect(actual?.constraints_hash).toBe(SUPPLIER_PRODUCT_COPY_OPERATION_CONSTRAINTS_SHA256);
      await assertSupplierProductCopyOperationReady(tx);
    });
    expect(readFileSync(resolve(import.meta.dirname,'../src/services/MigrationService.ts'),'utf8')).not.toContain('supplierProductCopyOperation');
  });
  it('installs only with explicit owner maintenance, remains idempotent and does not create any business rows',async()=>{
    await expect(installSupplierProductCopyOperation(f.db)).rejects.toThrow('transaction');
    expect(await f.db.transaction(tx=>installSupplierProductCopyOperation(tx))).toEqual({applied:true});
    expect(await f.db.transaction(tx=>installSupplierProductCopyOperation(tx))).toEqual({applied:false});
    expect(await f.exec('SELECT * FROM public.supplier_product_copy_operation_v1')).toEqual([]);
  });
  it('refuses missing and partial catalogs without repairing them',async()=>{
    await expect(f.db.transaction(tx=>assertSupplierProductCopyOperationReady(tx))).rejects.toMatchObject({httpStatus:503});
    await f.exec('CREATE TABLE public.supplier_product_copy_operation_v1(operation_id uuid)');
    await expect(f.db.transaction(tx=>installSupplierProductCopyOperation(tx))).rejects.toThrow('Partial');
    expect(await f.exec("SELECT count(*)::integer AS n FROM pg_proc WHERE proname='supplier_product_copy_operation_immutable_v1'")).toEqual([{n:0}]);
  });
  it('rejects unsupported transaction contexts without adding objects',async()=>{
    for(const options of [{isolationLevel:'repeatable read' as const},{accessMode:'read only' as const}])
      await expect(f.db.transaction(tx=>installSupplierProductCopyOperation(tx),options)).rejects.toThrow();
    expect(await f.exec("SELECT to_regclass('public.supplier_product_copy_operation_v1')::text AS value")).toEqual([{value:null}]);
  });
  it('rejects exact catalog drift in constraints, columns, indexes, function, trigger and ACL without repair',async()=>{
    await f.db.transaction(tx=>installSupplierProductCopyOperation(tx));
    for(const statement of [
      'ALTER TABLE public.supplier_product_copy_operation_v1 DROP CONSTRAINT spco_identity_ck',
      'ALTER TABLE public.supplier_product_copy_operation_v1 ADD COLUMN extra text',
      'CREATE INDEX bad_extra_copy_index ON public.supplier_product_copy_operation_v1(actor_id)',
      'ALTER TABLE public.supplier_product_copy_operation_v1 ENABLE ROW LEVEL SECURITY',
      'ALTER FUNCTION public.supplier_product_copy_operation_immutable_v1() SECURITY DEFINER',
      'ALTER FUNCTION public.supplier_product_copy_operation_immutable_v1() RESET ALL',
      'GRANT EXECUTE ON FUNCTION public.supplier_product_copy_operation_immutable_v1() TO PUBLIC',
      'GRANT SELECT ON public.supplier_product_copy_operation_v1 TO PUBLIC',
      'ALTER TABLE public.supplier_product_copy_operation_v1 DISABLE TRIGGER spco_immutable_rows',
    ]){
      await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(statement));await assertSupplierProductCopyOperationReady(tx);})).rejects.toMatchObject({httpStatus:503});
      await f.db.transaction(tx=>assertSupplierProductCopyOperationReady(tx));
    }
  });
  it('uses an independent restricted LOGIN with only receipt SELECT INSERT and rejects evidence update delete truncate and direct guard execute',async()=>{
    const role='copy_receipt_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');
    const [origin]=await f.exec('SELECT current_database() AS database') as Array<{database:string}>;
    let connection:ReturnType<typeof postgres>|undefined;
    await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    try{
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"`);
      await f.db.transaction(tx=>installSupplierProductCopyOperation(tx,role));
      const url=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');url.pathname='/'+origin.database;url.username=role;url.password=password;
      connection=postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,connection:{options:'-c search_path=public,pg_temp'}});
      const db=drizzle(connection) as unknown as DbClient;
      await db.transaction(tx=>assertSupplierProductCopyOperationReady(tx));
      const id=randomUUID();
      await connection.unsafe(`INSERT INTO public.supplier_product_copy_operation_v1 VALUES('${id}',21,20,80,'','not_applied',NULL,1)`);
      for(const command of ['UPDATE public.supplier_product_copy_operation_v1 SET actor_id=22','DELETE FROM public.supplier_product_copy_operation_v1','TRUNCATE public.supplier_product_copy_operation_v1','SELECT public.supplier_product_copy_operation_immutable_v1()'])
        await expect(connection.unsafe(command)).rejects.toMatchObject({code:'42501'});
      expect(await f.exec('SELECT actor_id,supplier_id,source_id FROM public.supplier_product_copy_operation_v1')).toEqual([{actor_id:21,supplier_id:20,source_id:80}]);
    }finally{await connection?.end({timeout:5});await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);}
  },30000);
});
