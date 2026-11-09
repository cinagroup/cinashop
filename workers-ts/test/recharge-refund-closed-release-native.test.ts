/** Actual local economics after an independently COMMITTED real RSA CLOSED.
 * No owner seeds payment/provider/hold truth. Controlled projection/wallet/bill
 * drift below is explicitly adversarial, never a legitimate money producer. */
import { randomUUID } from 'node:crypto';
import { eq, sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { user, userBill, userRecharge } from '@/models/schema';
import { releaseRechargeRefundClosedFirstResult } from '@/services/payment/RechargeRefundClosedRelease';
import { rechargeClosedReleaseNativeFixture, type RechargeClosedReleaseNativeFixture } from './helpers/rechargeClosedReleaseNative';
import { rechargeAuthorUids } from './helpers/rechargeRefundAdminAuthorNative';

const transport = vi.hoisted(() => {
 const values = new Map<string, unknown>(),get = vi.fn(async(key: string) => values.get(key) ?? null),
  set = vi.fn(async(key: string,value: unknown) => { values.set(key,value);return true; }),
  remove = vi.fn(async(key: string) => values.delete(key)),take = vi.fn(async(key: string) => { const v=values.get(key)??null;values.delete(key);return v; }),
  setIfAbsent = vi.fn(async(key: string,value: unknown) => { if(values.has(key))return false;values.set(key,value);return true; });
 const redis = { eval:vi.fn(async()=>1),get,set:vi.fn(async(key:string,value:unknown)=>{await set(key,value);return'OK';}),del:vi.fn(async(key:string)=>Number(await remove(key))) };
 return { values,get,set,remove,take,setIfAbsent,redis };
});
vi.mock('@/utils/cache',async original => ({ ...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent,
 setTokenBucket:vi.fn(async()=>true),clearToken:vi.fn(async()=>true) }));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('genuine first CLOSED local held-debit return', () => {
 let f:RechargeClosedReleaseNativeFixture,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 type Paid = Awaited<ReturnType<RechargeClosedReleaseNativeFixture['persisted']>>;
 let completed:Paid|undefined,rolledBack:Paid|undefined;
 const start = <T>(run:()=>Promise<T>) => {
  if(busy)throw Error('Previous genuine release case still pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;
 };
 beforeAll(async()=>{setup=(async()=>{f=await rechargeClosedReleaseNativeFixture(transport.values);})();await setup;},240000);
 afterAll(async()=>{try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}},30000);
 const rows=(r:Paid)=>f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${r.operation.operation_id}::uuid`);
 const state=(r:Paid)=>f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_state WHERE operation_id=${r.operation.operation_id}::uuid`);
 const noWrite=async(r:Paid,run:()=>Promise<unknown>)=>{
  const before=await f.economicSnapshot(r.order);await expect(run()).rejects.toThrow();expect(await f.economicSnapshot(r.order)).toBe(before);
  expect((await rows(r)).some(row=>row.result_id===r.receipt.resultId&&row.status==='CLOSED')).toBe(true);
 };
 for(const [role,recoverGift] of [['app',true],['admin',false],['financial',true]] as const)
  it('returns original held debit once on actual '+role+' LOGIN, recoverGift='+recoverGift,()=>start(async()=>{
   const r=await f.persisted('CLOSED',recoverGift),before=JSON.parse(await f.economicSnapshot(r.order)) as Record<string,unknown>,count=f.posts.length;
   expect(await f.wallet(r.order.uid)).toBe(recoverGift?'0.00':'1.50');
   const receipt=await f.release(r.operation.operation_id,r.receipt.resultId,role).catch(async error=>{
    console.info('RECHARGE_CLOSED_WRITE_FOOTPRINT '+await f.writeFootprintDiagnostic());throw error;
   });
   expect(receipt).toMatchObject({operationId:r.operation.operation_id,providerResultId:r.receipt.resultId,released:true,replayed:false});
   expect(await f.wallet(r.order.uid)).toBe('11.50');expect(f.posts).toHaveLength(count);
   const resultRows=await rows(r);expect(resultRows).toHaveLength(2);
   expect(resultRows.find(row=>row.source==='local_release')).toMatchObject({result_id:receipt.localResultId,source_id:'release:'+r.operation.operation_id,
    status:'SUCCESS',attempt_id:null,caused_by_result_id:r.receipt.resultId});
   expect((await state(r))[0]).toMatchObject({status:'FAILED',wallet_state:'released',version:2,attempt_count:1,last_result_id:receipt.localResultId,
    provider_refund_id:expect.any(String),lease_id:null,lease_until:null,next_query_at:null});
   const bills=await f.adminRuntime.db.select().from(userBill).where(eq(userBill.id,receipt.releaseBillId));
   expect(bills).toHaveLength(1);expect(bills[0]).toMatchObject({uid:r.order.uid,pm:1,type:'recharge_refund_release',number:recoverGift?'11.50':'10.00',balance:'11.50'});
   const after=JSON.parse(await f.economicSnapshot(r.order)) as Record<string,unknown>;
   for(const name of ['recharge','operations','attempts','originals','uses','settlement','callbacks','flow','outbox'])expect(after[name],name).toEqual(before[name]);
   if(role==='admin')completed=r;
  }),5000);

 it('replays strict physical receipt after later genuine wallet spending, without another credit or POST',()=>start(async()=>{
  if(!completed)throw Error('Actual preceding Admin release did not complete');const r=completed;
  await f.spend(r.order.uid);expect(await f.wallet(r.order.uid)).toBe('4.50');
  const before=await f.economicSnapshot(r.order),count=f.posts.length;
  const a=await f.release(r.operation.operation_id,r.receipt.resultId,'app');expect(a.replayed).toBe(true);
  expect(await f.economicSnapshot(r.order)).toBe(before);expect(f.posts).toHaveLength(count);
 }),5000);
 it('historical replay ignores retired credentials, revoked current approval and later mutable recharge attribution/refund drift',()=>start(async()=>{
  if(!completed)throw Error('Actual preceding release missing');const r=completed;
  await f.approve(2,'revoked');const registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
  await f.adminRuntime.db.update(userRecharge).set({refundPrice:'10.00',storeId:99}).where(eq(userRecharge.id,r.order.id));
  f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='';
  try{const before=await f.economicSnapshot(r.order);expect((await f.release(r.operation.operation_id,r.receipt.resultId,'financial')).replayed).toBe(true);
   expect(await f.economicSnapshot(r.order)).toBe(before);}finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;}
 }),5000);
 it('refuses wrong actual runtime/root and a local result substituted for provider cause without new writes',()=>start(async()=>{
  if(!completed)throw Error('Actual release missing');const r=completed,local=(await rows(r)).find(row=>row.source==='local_release');if(!local)throw Error('Actual local receipt missing');
  await noWrite(r,()=>releaseRechargeRefundClosedFirstResult({...f.adminContainer,db:f.profilePeers.financial.db},f.env,'admin',r.operation.operation_id,r.receipt.resultId));
  await noWrite(r,()=>releaseRechargeRefundClosedFirstResult({...f.adminContainer,db:f.maintenanceDb},f.env,'admin',r.operation.operation_id,r.receipt.resultId));
  await noWrite(r,()=>f.release(r.operation.operation_id,local.result_id));
 }),5000);

 for(const status of ['SUCCESS','PROCESSING','ABNORMAL','UNKNOWN'] as const)
  it('retains held wallet and actual '+status+' provider truth without attempting release',()=>start(async()=>{
   const r=await f.persisted(status,false),before=await f.economicSnapshot(r.order);
   await expect(f.release(r.operation.operation_id,r.receipt.resultId)).rejects.toThrow();
   expect(await f.economicSnapshot(r.order)).toBe(before);expect(await rows(r)).toHaveLength(1);
  }),5000);
 it('does not adopt a mutable FAILED/released scalar without its immutable local receipt and physical bill',()=>start(async()=>{
  const r=await f.persisted('CLOSED',false);
  await f.adminRuntime.db.execute(sql`UPDATE public.recharge_refund_state SET status='FAILED',wallet_state='released',version=2,
   lease_id=NULL,lease_until=NULL,next_query_at=NULL,last_result_id=${r.receipt.resultId}::uuid WHERE operation_id=${r.operation.operation_id}::uuid`);
  await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));expect(await f.wallet(r.order.uid)).toBe('1.50');
 }),5000);
 it('refuses actual hold-bill tamper while leaving independently committed CLOSED durable',()=>start(async()=>{
  const r=await f.persisted('CLOSED',true);
  await f.adminRuntime.db.update(userBill).set({mark:'controlled tamper'}).where(eq(userBill.eventKey,'recharge_refund_hold:'+r.operation.operation_id));
  await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('refuses an orphan physical release bill instead of crediting or adopting it',()=>start(async()=>{
  const r=await f.persisted('CLOSED',false);
  await f.adminRuntime.db.insert(userBill).values({uid:r.order.uid,linkId:r.order.orderId,eventKey:'recharge_refund_release:'+r.operation.operation_id,
   pm:1,category:'now_money',type:'recharge_refund_release',number:'0.00',balance:'1.50',mark:'controlled orphan accounting drift'});
  await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('refuses fresh CLOSED release when an operation-key capital-flow orphan already exists',()=>start(async()=>{
  const r=await f.persisted('CLOSED',false);
  // Controlled immutable-link contradiction, NOT an accepted economic author.
  await f.adminRuntime.db.execute(sql`INSERT INTO public.capital_flow(event_key,flow_id,order_id,uid,price,trading_type,mark)
   VALUES(${'recharge.refund:'+r.operation.operation_id},${String(r.operation.operation_id).replaceAll('-','')},${r.order.orderId},${r.order.uid},-10.00,4,'controlled orphan')`);
  await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('refuses a fresh operation-key notice orphan disguised as an allowed old event type',()=>start(async()=>{
  const r=await f.persisted('CLOSED',false);
  await f.adminRuntime.db.execute(sql`INSERT INTO public.store_order_outbox(event_key,aggregate_type,aggregate_id,event_type,status)
   VALUES(${'recharge.refund.success.notice:'+r.operation.operation_id},'recharge',${r.order.id},'order.paid','DEAD')`);
  await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('refuses a changed physical first-settlement MAC after provider CLOSED has already committed',()=>start(async()=>{
  const r=await f.persisted('CLOSED',false),event=await f.settlement(r.order);
  await f.adminRuntime.db.execute(sql`UPDATE public.store_order_outbox SET payload=pg_catalog.jsonb_set(payload,'{signature}',pg_catalog.to_jsonb(pg_catalog.repeat('0',64))) WHERE id=${event.id}`);
  await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('refuses overflow before changing a controlled near-limit current wallet or any existing provider evidence',()=>start(async()=>{
  const r=await f.persisted('CLOSED',false);
  // Explicit adversarial writable projection drift, NOT a genuine funds source.
  await f.adminRuntime.db.update(user).set({nowMoney:'9999999999.99'}).where(eq(user.uid,r.order.uid));
  await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));
 }),5000);
 it('uses a controlled signed current wallet plus full immutable debit without clamping',()=>start(async()=>{
  const r=await f.persisted('CLOSED',false);
  await f.adminRuntime.db.update(user).set({nowMoney:'-0.25'}).where(eq(user.uid,r.order.uid));
  await f.release(r.operation.operation_id,r.receipt.resultId,'app');expect(await f.wallet(r.order.uid)).toBe('9.75');
 }),5000);
 it('rolls wallet, actual positive bill, local receipt and FAILED CAS back on a real late SQL failure, preserving CLOSED',()=>start(async()=>{
  const r=await f.persisted('CLOSED',true),before=await f.economicSnapshot(r.order),transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db);
  let reached=false;
  const failing=new Proxy(f.adminRuntime.db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);
   return(callback:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
    const result=await callback(actual as unknown as DbClient);
    const [observed]=await actual.execute<{balance:string;bills:number;local:number;status:string}>(sql`SELECT
     (SELECT now_money::text FROM public."user" WHERE uid=${r.order.uid}) AS balance,
     (SELECT count(*)::integer FROM public.user_bill WHERE event_key=${'recharge_refund_release:'+r.operation.operation_id}) AS bills,
     (SELECT count(*)::integer FROM public.recharge_refund_result WHERE operation_id=${r.operation.operation_id}::uuid AND source='local_release') AS "local",
     (SELECT status FROM public.recharge_refund_state WHERE operation_id=${r.operation.operation_id}::uuid) AS status`);
    expect(observed).toEqual({balance:'11.50',bills:1,local:1,status:'FAILED'});reached=true;
    await actual.execute(sql`SELECT 1/0`);return result;
   },options);
  }});
  await expect(releaseRechargeRefundClosedFirstResult({...f.adminContainer,db:failing},f.env,'admin',r.operation.operation_id,r.receipt.resultId)).rejects.toThrow();
  expect(reached).toBe(true);expect(await f.economicSnapshot(r.order)).toBe(before);expect(await rows(r)).toHaveLength(1);rolledBack=r;
 }),5000);
 it('refuses a NULL-event-key flow alias on the real rolled-back held CLOSED chain without returning the wallet debit',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual earlier held CLOSED chain missing');const r=rolledBack;
  const before=await f.economicSnapshot(r.order),wallet=await f.wallet(r.order.uid),posts=f.posts.length;
  expect(wallet).toBe('0.00');
  // Explicit controlled physical contradiction, never an accepted economic
  // producer. Round-trip the real row ID and both immutable operation aliases.
  const flowId=String(r.operation.operation_id).replaceAll('-','');
  const inserted=await f.adminRuntime.db.execute<{id:number;event_key:string|null;flow_id:string}>(sql`INSERT INTO public.capital_flow
   (event_key,flow_id,order_id,uid,price,trading_type,mark)
   VALUES(NULL,${flowId},${r.order.orderId},${r.order.uid},-10.00,4,'controlled CLOSED flow alias orphan')
   RETURNING id,event_key,flow_id`);
  const orphan=inserted[0];
  try{
   if(!orphan)throw Error('Actual controlled CLOSED flow alias insert missing');
   expect(inserted).toHaveLength(1);expect(orphan).toMatchObject({event_key:null,flow_id:flowId});
   expect(Number.isInteger(orphan.id)&&orphan.id>0).toBe(true);
   await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));
   expect(await f.wallet(r.order.uid)).toBe(wallet);expect(f.posts).toHaveLength(posts);
   expect(await rows(r)).toHaveLength(1);
   expect((await state(r))[0]).toMatchObject({status:'SUBMITTING',wallet_state:'held',version:1,last_result_id:null});
  }finally{
   if(orphan&&Number.isInteger(orphan.id)&&orphan.id>0)
    await f.maintenanceDb.execute(sql`DELETE FROM public.capital_flow WHERE id=${orphan.id}`);
  }
  expect(await f.economicSnapshot(r.order)).toBe(before);
 }),5000);
 const closureRefusal=async(run:()=>Promise<unknown>)=>{
  if(!rolledBack)throw Error('Actual earlier held CLOSED chain missing');const r=rolledBack,before=await f.economicSnapshot(r.order);
  await expect(run()).rejects.toMatchObject({httpStatus:503});expect(await f.economicSnapshot(r.order)).toBe(before);
 };
 const ddl=(statements:readonly (string|SQL)[])=>f.maintenanceDb.transaction(async tx=>{
  await tx.execute(sql`SET LOCAL lock_timeout='1000ms'`);await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);
  for(const statement of statements)await tx.execute(typeof statement==='string'?sql.raw(statement):statement);
 });
 it('rejects an unknown executable same-name division CHECK before a fresh wallet write',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual held CLOSED chain missing');const r=rolledBack;
  await ddl(["CREATE FUNCTION public.recharge_closed_unreviewed_check(numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1>=0'",
   'ALTER TABLE public."user" DROP CONSTRAINT user_division_status_ck',
   'ALTER TABLE public."user" ADD CONSTRAINT user_division_status_ck CHECK(public.recharge_closed_unreviewed_check(division_status)) NOT VALID']);
  try{await closureRefusal(()=>f.release(r.operation.operation_id,r.receipt.resultId));}
  finally{await ddl(['ALTER TABLE public."user" DROP CONSTRAINT user_division_status_ck',
   'ALTER TABLE public."user" ADD CONSTRAINT user_division_status_ck CHECK(division_status BETWEEN 0 AND 1) NOT VALID',
   'DROP FUNCTION public.recharge_closed_unreviewed_check(numeric)']);}
 }),5000);
 it('rejects an unknown expression index function even when it only returns its input',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual held CLOSED chain missing');const r=rolledBack;
  await ddl(["CREATE FUNCTION public.recharge_closed_unreviewed_index(numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS 'SELECT $1'",
   'CREATE INDEX recharge_closed_expression_probe ON public."user" ((public.recharge_closed_unreviewed_index(now_money)))']);
  try{await closureRefusal(()=>f.release(r.operation.operation_id,r.receipt.resultId));}
  finally{await ddl(['DROP INDEX public.recharge_closed_expression_probe','DROP FUNCTION public.recharge_closed_unreviewed_index(numeric)']);}
 }),5000);
 it('rejects a new generated user column instead of executing its generated expression with a wallet UPDATE',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual held CLOSED chain missing');const r=rolledBack;
  await ddl(['ALTER TABLE public."user" ADD COLUMN recharge_closed_generated_probe numeric GENERATED ALWAYS AS(now_money+0) STORED']);
  try{await closureRefusal(()=>f.release(r.operation.operation_id,r.receipt.resultId));}
  finally{await ddl(['ALTER TABLE public."user" DROP COLUMN recharge_closed_generated_probe']);}
 }),5000);
 it('rejects a known-name index changed to a nondefault operator class',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual held CLOSED chain missing');const r=rolledBack;
  await ddl(['DROP INDEX public.user_phone_idx','CREATE INDEX user_phone_idx ON public."user" USING btree(phone varchar_pattern_ops)']);
  try{await closureRefusal(()=>f.release(r.operation.operation_id,r.receipt.resultId));}
  finally{await ddl(['DROP INDEX public.user_phone_idx','CREATE INDEX user_phone_idx ON public."user" USING btree(phone)']);}
 }),5000);
 it('requires an operable locked user for fresh release while keeping historical replay independent',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual held CLOSED chain missing');const r=rolledBack;
  for(const patch of [{isDel:1},{deleteTime:new Date()}]){
   await f.adminRuntime.db.update(user).set(patch).where(eq(user.uid,r.order.uid));
   try{await closureRefusal(()=>f.release(r.operation.operation_id,r.receipt.resultId));}
   finally{await f.adminRuntime.db.update(user).set({isDel:0,deleteTime:null}).where(eq(user.uid,r.order.uid));}
  }
 }),5000);
 it('rejects a disabled known internal FK trigger rather than trusting tgisinternal',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual held CLOSED chain missing');const r=rolledBack;
  const known=await f.maintenanceDb.execute<{name:string}>(sql`SELECT g.tgname AS name FROM pg_catalog.pg_trigger g
   JOIN pg_catalog.pg_constraint k ON k.oid=g.tgconstraint WHERE k.conrelid='public.offline_order_admission'::regclass
    AND k.conname='ooa_user_fk' AND g.tgrelid='public.user'::regclass AND g.tgtype=17`);
  expect(known).toHaveLength(1);await ddl([sql`ALTER TABLE public."user" DISABLE TRIGGER ${sql.identifier(known[0].name)}`]);
  try{await closureRefusal(()=>f.release(r.operation.operation_id,r.receipt.resultId));}
  finally{await ddl([sql`ALTER TABLE public."user" ENABLE TRIGGER ${sql.identifier(known[0].name)}`]);}
 }),5000);
 const stateCode=(error:unknown)=>{let e=error;for(let depth=0;depth<8&&e&&typeof e==='object';depth++){
  const row=e as {code?:unknown;cause?:unknown};if(typeof row.code==='string')return row.code;e=row.cause;
 }return undefined;};
 for(const kind of ['trigger','sequence'] as const)
  it('holds actual '+kind+' DDL fence after real wallet/bill/receipt/CAS writes and rolls the probe back',()=>start(async()=>{
   if(!rolledBack)throw Error('Actual held CLOSED chain missing');const r=rolledBack,before=await f.economicSnapshot(r.order);
   const transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db);let blocked=false,reached=false;
   if(kind==='trigger')await ddl(['CREATE FUNCTION public.recharge_closed_trigger_probe() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW;END$$']);
   const wrapped=new Proxy(f.adminRuntime.db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);
    return(callback:(tx:DbClient)=>Promise<unknown>,options:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
     const result=await callback(actual as unknown as DbClient);reached=true;
     try{await ddl([kind==='trigger'?'CREATE TRIGGER recharge_closed_trigger_probe BEFORE UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.recharge_closed_trigger_probe()':
      'ALTER SEQUENCE public.user_bill_id_seq OWNED BY NONE']);}
     catch(error){if(stateCode(error)!=='55P03')throw error;blocked=true;}
     expect(blocked).toBe(true);await actual.execute(sql`SELECT 1/0`);return result;
    },options);
   }});
   try{
    await expect(releaseRechargeRefundClosedFirstResult({...f.adminContainer,db:wrapped},f.env,'admin',r.operation.operation_id,r.receipt.resultId)).rejects.toThrow();
    expect(reached).toBe(true);expect(blocked).toBe(true);expect(await f.economicSnapshot(r.order)).toBe(before);
   }finally{
    if(kind==='trigger')await ddl(['DROP TRIGGER IF EXISTS recharge_closed_trigger_probe ON public."user"','DROP FUNCTION public.recharge_closed_trigger_probe()']);
    else await ddl(['ALTER SEQUENCE public.user_bill_id_seq OWNED BY public.user_bill.id']);
   }
  }),5000);
 it('recovers that real rolled-back attempt under two actual role contenders with one credit and no repeat POST',()=>start(async()=>{
  if(!rolledBack)throw Error('Actual preceding late rollback did not complete');const r=rolledBack,count=f.posts.length;
  const receipts=await Promise.all([f.release(r.operation.operation_id,r.receipt.resultId,'financial'),f.release(r.operation.operation_id,r.receipt.resultId,'app')]);
  expect(receipts.map(row=>row.replayed).sort()).toEqual([false,true]);expect(receipts[0].localResultId).toBe(receipts[1].localResultId);
  expect(receipts[0].releaseBillId).toBe(receipts[1].releaseBillId);
  expect(await f.wallet(r.order.uid)).toBe('11.50');expect(await rows(r)).toHaveLength(2);expect(f.posts).toHaveLength(count);
 }),5000);
 for(const artifact of ['flow','notice'] as const)
  it('refuses terminal replay with a later same-operation '+artifact+' orphan, without reading current refund or wallet',()=>start(async()=>{
   if(!completed)throw Error('Actual preceding release missing');const r=completed;
   const key=(artifact==='flow'?'recharge.refund:':'recharge.refund.success.notice:')+r.operation.operation_id;
   if(artifact==='flow')await f.adminRuntime.db.execute(sql`INSERT INTO public.capital_flow(event_key,flow_id,order_id,uid,price,trading_type,mark)
    VALUES(${key},${String(r.operation.operation_id).replaceAll('-','')},${r.order.orderId},${r.order.uid},-10.00,4,'controlled terminal orphan')`);
   else await f.adminRuntime.db.execute(sql`INSERT INTO public.store_order_outbox(event_key,aggregate_type,aggregate_id,event_type,status)
    VALUES(${key},'recharge',${r.order.id},'order.paid','DEAD')`);
   try{await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));}
   finally{await f.maintenanceDb.execute(artifact==='flow'?sql`DELETE FROM public.capital_flow WHERE event_key=${key}`:
    sql`DELETE FROM public.store_order_outbox WHERE event_key=${key}`);}
  }),5000);
 it('refuses terminal replay when a second physical legacy release bill duplicates the same key',()=>start(async()=>{
  if(!completed)throw Error('Actual preceding release missing');const r=completed;
  const [original]=await f.adminRuntime.db.select().from(userBill).where(eq(userBill.eventKey,'recharge_refund_release:'+r.operation.operation_id));
  if(!original)throw Error('Actual positive release bill missing');const {id:_id,...body}=original;
  const [duplicate]=await f.adminRuntime.db.insert(userBill).values(body).returning({id:userBill.id});
  try{await noWrite(r,()=>f.release(r.operation.operation_id,r.receipt.resultId));}
  finally{await f.maintenanceDb.delete(userBill).where(eq(userBill.id,duplicate.id));}
 }),5000);
 it('never confuses an actual pre-POST admin cancellation with a provider CLOSED release',()=>start(async()=>{
  const uid=rechargeAuthorUids[19];await f.approve();const paid=await f.paid(uid),q=await f.quote(paid.order),key=randomUUID();
  const op=(await f.admit(key,f.body(paid.order,q,true))).operation;await f.cancel(paid.order,key);
  const records=await f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${op.operation_id}::uuid`);
  expect(records).toHaveLength(2);const cause=records.find(row=>row.source==='local_cancel');if(!cause)throw Error('Actual cancellation cause missing');
  const before=await f.economicSnapshot(paid.order);await expect(f.release(op.operation_id,cause.result_id)).rejects.toThrow();expect(await f.economicSnapshot(paid.order)).toBe(before);
 }),5000);
});
