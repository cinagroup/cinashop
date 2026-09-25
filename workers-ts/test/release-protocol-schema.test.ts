import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { checkoutPricingMigrationDatabase } from './helpers/checkoutPricingMigrationDatabase';
import { offlinePredecessorSchemaSql } from './helpers/offlinePredecessorSchema';
import { RELEASE_SHARED_INDEXES } from '../src/migrations/releaseSharedIndexes';
import { inspectReleaseProtocolSchema, runReleaseProtocolSchema, type ReleaseProtocolTarget } from '../src/migrations/runReleaseProtocolSchema';

describe('fixed atomic release protocol schema PG16', () => {
  let f: Awaited<ReturnType<typeof checkoutPricingMigrationDatabase>>, target:ReleaseProtocolTarget;
  beforeEach(async () => {
    f = await checkoutPricingMigrationDatabase();
    await f.exec(await offlinePredecessorSchemaSql());
    // Release protocol predecessor checks the reviewed pre-barcode index stage.
    await f.exec('DROP INDEX public.user_bar_code_uq');
    // Build this independently from the canonical ORM, then remove only empty
    // unprotected new protocol tables in our own disposable database.
    await f.exec(`DROP TABLE public.admin_refund_operation,public.admin_refund_creation,
      public.store_order_invoice_evidence,public.store_order_invoice_allocation,
      public.store_order_refund_split,public.store_order_fulfillment_branch`);
    for (const indexes of Object.values(RELEASE_SHARED_INDEXES))
      for (const name of Object.keys(indexes)) await f.exec('DROP INDEX public."'+name+'"');
    const [row] = await f.db.execute(sql`SELECT current_database() AS database`);
    target={database:String(row.database),maintenanceRole:'finance_test',pricingOwner:f.pricingOwner};
    await f.exec(`INSERT INTO public.system_config(id,menu_name,value) VALUES(999,'synthetic','unchanged');
      INSERT INTO public.store_order_invoice(id,uid,order_id,invoice_amount) VALUES(999,1,1,12.34)`);
  },60000);
  afterEach(async () => {await f?.close();},45000);
  // Planner estimates can change while CREATE INDEX scans a table even when
  // that DDL later rolls back. Retain identity/storage/ACL/schema attributes.
  const catalog=()=>f.db.execute(sql`SELECT 'relation' AS kind,oid::text,(to_jsonb(c)-ARRAY['relpages','reltuples','relallvisible'])::text AS value FROM pg_class c WHERE relnamespace='public'::regnamespace
    UNION ALL SELECT 'function',oid::text,to_jsonb(p)::text FROM pg_proc p WHERE pronamespace='public'::regnamespace ORDER BY kind,oid`);
  it('installs every protocol atomically, preserves legacy rows and does not invent invoice history or change IDs on repetition', async () => {
    expect(await inspectReleaseProtocolSchema(f.db,target)).toMatchObject({schemaReady:false,runtimeCommissioned:false});
    const first=await runReleaseProtocolSchema(f.db,target);
    expect(first).toMatchObject({operation:'reviewed-indexes-and-0155-0160-schema-v1',schemaReady:true,indexesCreated:19,runtimeCommissioned:false});
    expect(first.after).toEqual(first.before);
    expect((await f.query('SELECT * FROM public.store_order_invoice_evidence')).rows).toEqual([]);
    const objects=await catalog();
    expect(await runReleaseProtocolSchema(f.db,target)).toMatchObject({schemaReady:true,indexesCreated:0,before:first.after,after:first.after});
    expect(await catalog()).toEqual(objects);
    expect(await inspectReleaseProtocolSchema(f.db,target)).toMatchObject({schemaReady:true,fingerprint:first.after});
  },60000);
  it('rolls back earlier indexes and protocols when the final owner check fails', async () => {
    const before=await catalog(), state=await inspectReleaseProtocolSchema(f.db,target);
    await expect(runReleaseProtocolSchema(f.db,{...target,pricingOwner:'missing_owner'})).rejects.toThrow();
    expect(await catalog()).toEqual(before);expect(await inspectReleaseProtocolSchema(f.db,target)).toEqual(state);
  },60000);
  it.each(['wrong-database','index-drift','busy-table'])('refuses %s without mutation', async reason => {
    if(reason==='index-drift') await f.exec('ALTER TABLE public.system_config ADD COLUMN unexpected text');
    const before=await catalog();
    await f.withPeer!(async peer=>{
      if(reason==='busy-table') await peer.exec('BEGIN; LOCK TABLE public.system_config IN ROW EXCLUSIVE MODE');
      try {await expect(runReleaseProtocolSchema(f.db,reason==='wrong-database'?{...target,database:'wrong'}:target)).rejects.toThrow();}
      finally {if(reason==='busy-table') await peer.exec('ROLLBACK');}
    });
    expect(await catalog()).toEqual(before);
  },60000);
});
