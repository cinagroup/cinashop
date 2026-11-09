/** Generic server plans must read real fresh permissions. This is an actual
 * local catalog-drift test; no SQL result, source, actor or role is mocked.
 * The five complete profile successor cases remain separate and unchanged. */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import type { DbClient } from '@/lib/di';
import { inspectRuntimeBusinessProfileInTransaction } from '@/migrations/auditRuntimeBusinessPrivileges';
import { rechargeRefundRuntimeProfileFixture,type RechargeRefundRuntimeProfileFixture } from './helpers/rechargeRefundRuntimeProfileNative';
import { coldPreparedRechargeMaintenance } from './helpers/preparedRechargeMaintenanceDriftNative';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('prepared maintenance plans preserve actual catalog privilege freshness',()=>{
 let f:RechargeRefundRuntimeProfileFixture,cold:Awaited<ReturnType<typeof coldPreparedRechargeMaintenance>>;
 let setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 // Only one started case may touch this real target. If a 5s case times out,
 // following cases fail closed until it drains; cleanup waits for its finally.
 const start=<T>(operation:()=>Promise<T>):Promise<T>=>{
  if(busy)throw Error('Earlier real catalog operation is still pending');
  busy=true;
  const work=operation().finally(()=>{busy=false;});pending=work;
  // Observe eventual rejection even if Vitest has already ended the 5s body.
  void work.catch(()=>undefined);
  return work;
 };
 const restore=()=>f.maintenanceDb.execute(sql`GRANT SELECT ON TABLE public.routine_original_payment_evidence TO ${sql.identifier(f.binding.app)}`);
 const revoke=()=>f.maintenanceDb.execute(sql`REVOKE SELECT ON TABLE public.routine_original_payment_evidence FROM ${sql.identifier(f.binding.app)}`);
 const profile=(root:DbClient)=>root.transaction(async tx=>{
  await tx.execute(sql`SET LOCAL search_path TO public,pg_temp`);
  return inspectRuntimeBusinessProfileInTransaction(tx,'app',f.target,'current',f.beforePeers,f.appReaders);
 },{isolationLevel:'read committed',accessMode:'read only'});
 beforeAll(async()=>{
  setup=(async()=>{f=await rechargeRefundRuntimeProfileFixture();cold=await coldPreparedRechargeMaintenance(f);})();
  await setup;
 },180000);
 afterAll(async()=>{
  try{
   if(setup)await Promise.allSettled([setup]);
   if(pending)await Promise.allSettled([pending]);
   if(f)await restore();
  }finally{try{await cold?.close();}finally{await f?.close();}}
 },30000);

 it('reads true then false then true from the same generic plan across actual transaction commits and external REVOKE/GRANT',async()=>start(async()=>{
  const probe=sql`SELECT pg_catalog.has_table_privilege(${f.binding.appOid}::oid,
   'public.routine_original_payment_evidence'::regclass,'SELECT') AS allowed,pg_backend_pid() AS pid`;
  const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
  const statementHash=digest(new PgDialect().sqlToQuery(probe).sql);
  // Plan identity survives COMMIT. Each actual author transaction starts with
  // PostgreSQL's real catalog invalidation boundary. The unsupported stronger
  // same-transaction pure-function claim failed for BOTH driver modes in16;
  // retain that diagnostic evidence instead of attributing it to PREPARE.
  const read=()=>cold.db.transaction(async tx=>{
   await tx.execute(sql`SET LOCAL plan_cache_mode TO force_generic_plan`);
   const [row]=await tx.execute<{allowed:boolean;pid:number}>(probe);return row;
  },{isolationLevel:'read committed',accessMode:'read write'});
  expect(await read()).toEqual({allowed:true,pid:cold.identity.pid});
  try{
   await revoke();expect(await read()).toEqual({allowed:false,pid:cold.identity.pid});
   await expect(f.profilePeers.app.db.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence LIMIT 0`))
    .rejects.toMatchObject({cause:{code:'42501'}});
   await restore();expect(await read()).toEqual({allowed:true,pid:cold.identity.pid});
   expect(await f.profilePeers.app.db.execute(sql`SELECT evidence_id FROM public.routine_original_payment_evidence LIMIT 0`)).toHaveLength(0);
   const plans=await cold.db.execute<{statement:string;generic_plans:string;custom_plans:string}>(sql`SELECT
    statement,generic_plans::text AS generic_plans,custom_plans::text AS custom_plans FROM pg_catalog.pg_prepared_statements`);
   const exact=Array.from(plans).filter(row=>digest(row.statement)===statementHash);
   expect(exact).toHaveLength(1);expect(BigInt(exact[0].generic_plans)).toBeGreaterThanOrEqual(3n);expect(exact[0].custom_plans).toBe('0');
  }finally{await restore();}
 }),5000);

 it('makes the unchanged complete maintenance App profile refuse a real missing original-payment SELECT',async()=>start(async()=>{
  try{
   await revoke();
   const result=await profile(cold.db);
   expect(result.ready).toBe(false);
   expect(result.failures).toContain('routine_original_payment_evidence_catalog');
  }finally{await restore();}
 }),5000);

 it('accepts the restored complete App profile with real prepared reads and retains the five actual LOGIN identities',async()=>start(async()=>{
  const result=await profile(cold.db);expect(result).toMatchObject({ready:true,failures:[]});
  expect(new Set(Object.values(f.identities).map(identity=>identity.pid)).size).toBe(5);
  expect(new Set(Object.values(f.identities).map(identity=>identity.oid)).size).toBe(5);
  expect(cold.counts.preparedCalls).toBeGreaterThan(0);
  const [identity]=await cold.db.execute<{pid:number;role:string;session:string}>(sql`SELECT
   pg_backend_pid() AS pid,current_user AS role,session_user AS session`);
  expect(identity).toEqual({pid:cold.identity.pid,role:f.binding.maintenance,session:f.binding.maintenance});
 }),5000);
});
