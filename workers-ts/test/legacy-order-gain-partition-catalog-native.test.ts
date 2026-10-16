import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { LEGACY_ORDER_GAIN_PARTITION_SQL, LEGACY_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256,
  inspectLegacyOrderGainPartition, assertLegacyOrderGainPartitionReady, installLegacyOrderGainPartition } from '@/migrations/legacyOrderGainPartition';
import { financePostgres, validateFinanceFixtureUrl } from './helpers/financePostgres';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('independent legacy order gain partition PG16 catalog',()=>{
  let f:Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async()=>{f=await financePostgres([],{namespace:'public'});},60000);
  beforeEach(async()=>{await f.exec('DROP TABLE IF EXISTS public.legacy_order_gain_partition_v1 CASCADE; DROP FUNCTION IF EXISTS public.legacy_order_gain_partition_immutable_v1()');});
  afterAll(async()=>{await f?.close();},30000);
  it('pins actual PG16 legacy order gain partition constraints and the exact independent SQL mirror',async()=>{
    expect(readFileSync(resolve(import.meta.dirname,'../src/migrations/maintenance/0192_legacy_order_gain_partition.sql'),'utf8').split('\n').slice(1).join('\n')).toBe(LEGACY_ORDER_GAIN_PARTITION_SQL);
    await f.db.transaction(async tx=>{
      await tx.execute(sql.raw(LEGACY_ORDER_GAIN_PARTITION_SQL));
      const actual=await inspectLegacyOrderGainPartition(tx);
      console.log('LEGACY_ORDER_GAIN_PARTITION_PG16_CATALOG',JSON.stringify(actual));
      expect(actual?.constraints_hash).toBe(LEGACY_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256);
      await assertLegacyOrderGainPartitionReady(tx);
    });
    expect(readFileSync(resolve(import.meta.dirname,'../src/services/MigrationService.ts'),'utf8')).not.toContain('legacyOrderGainPartition');
  });
  it('installs only with explicit owner maintenance, remains idempotent and does not create any business rows',async()=>{
    await expect(installLegacyOrderGainPartition(f.db)).rejects.toThrow('transaction');
    expect(await f.db.transaction(tx=>installLegacyOrderGainPartition(tx))).toEqual({applied:true});
    expect(await f.db.transaction(tx=>installLegacyOrderGainPartition(tx))).toEqual({applied:false});
    expect(await f.exec('SELECT * FROM public.legacy_order_gain_partition_v1')).toEqual([]);
  });
  it('refuses missing and partial catalogs without repairing them',async()=>{
    await expect(f.db.transaction(tx=>assertLegacyOrderGainPartitionReady(tx))).rejects.toMatchObject({httpStatus:503});
    await f.exec('CREATE TABLE public.legacy_order_gain_partition_v1(partition_id uuid)');
    await expect(f.db.transaction(tx=>installLegacyOrderGainPartition(tx))).rejects.toThrow('Partial');
    expect(await f.exec("SELECT count(*)::integer AS n FROM pg_proc WHERE proname='legacy_order_gain_partition_immutable_v1'")).toEqual([{n:0}]);
  });
  it('rejects unsupported transaction contexts without adding objects',async()=>{
    for(const options of [{isolationLevel:'repeatable read' as const},{accessMode:'read only' as const}])
      await expect(f.db.transaction(tx=>installLegacyOrderGainPartition(tx),options)).rejects.toThrow();
    expect(await f.exec("SELECT to_regclass('public.legacy_order_gain_partition_v1')::text AS value")).toEqual([{value:null}]);
  });
  it('rejects exact catalog drift in constraints, columns, indexes, function, trigger and ACL without repair',async()=>{
    await f.db.transaction(tx=>installLegacyOrderGainPartition(tx));
    for(const statement of [
      'ALTER TABLE public.legacy_order_gain_partition_v1 DROP CONSTRAINT logp_identity_ck',
      'ALTER TABLE public.legacy_order_gain_partition_v1 ADD COLUMN extra text',
      'CREATE INDEX bad_extra_copy_index ON public.legacy_order_gain_partition_v1(source_order_id)',
      'ALTER TABLE public.legacy_order_gain_partition_v1 ENABLE ROW LEVEL SECURITY',
      'ALTER FUNCTION public.legacy_order_gain_partition_immutable_v1() SECURITY DEFINER',
      'ALTER FUNCTION public.legacy_order_gain_partition_immutable_v1() RESET ALL',
      'GRANT EXECUTE ON FUNCTION public.legacy_order_gain_partition_immutable_v1() TO PUBLIC',
      'GRANT SELECT ON public.legacy_order_gain_partition_v1 TO PUBLIC',
      'ALTER TABLE public.legacy_order_gain_partition_v1 DISABLE TRIGGER logp_immutable_rows',
    ]){
      await expect(f.db.transaction(async tx=>{await tx.execute(sql.raw(statement));await assertLegacyOrderGainPartitionReady(tx);})).rejects.toMatchObject({httpStatus:503});
      await f.db.transaction(tx=>assertLegacyOrderGainPartitionReady(tx));
    }
  });
  it('uses an independent restricted LOGIN with only receipt SELECT INSERT and rejects evidence update delete truncate and direct guard execute',async()=>{
    const role='copy_receipt_'+randomUUID().replaceAll('-',''),password=randomUUID().replaceAll('-','');
    const [origin]=await f.exec('SELECT current_database() AS database') as Array<{database:string}>;
    let connection:ReturnType<typeof postgres>|undefined;
    await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    try{
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"`);
      await f.db.transaction(tx=>installLegacyOrderGainPartition(tx,role));
      const url=validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL??'');url.pathname='/'+origin.database;url.username=role;url.password=password;
      connection=postgres(url.href,{max:1,prepare:false,connect_timeout:5,idle_timeout:0,connection:{options:'-c search_path=public,pg_temp'}});
      const db=drizzle(connection) as unknown as DbClient;
      await db.transaction(tx=>assertLegacyOrderGainPartitionReady(tx));
      const id=randomUUID();
      await connection.unsafe(`INSERT INTO public.legacy_order_gain_partition_v1 VALUES('${id}','${randomUUID()}',80,81,11,20,'fulfillment','${'a'.repeat(64)}','${'b'.repeat(64)}','{"version":"legacy-order-gain-partition-v1","source":{},"child":{},"selection":[{}]}',1)`);
      for(const command of ['UPDATE public.legacy_order_gain_partition_v1 SET buyer_id=22','DELETE FROM public.legacy_order_gain_partition_v1','TRUNCATE public.legacy_order_gain_partition_v1','SELECT public.legacy_order_gain_partition_immutable_v1()'])
        await expect(connection.unsafe(command)).rejects.toMatchObject({code:'42501'});
      expect(await f.exec('SELECT buyer_id,supplier_id,child_order_id FROM public.legacy_order_gain_partition_v1')).toEqual([{buyer_id:11,supplier_id:20,child_order_id:81}]);
    }finally{await connection?.end({timeout:5});await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);}
  },30000);
});
