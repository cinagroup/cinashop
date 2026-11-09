/** Real PG16 account approval authorities. Synthetic merchant material is
 * test-only registry input; no network, provider refund or payment is asserted. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { runRechargeRoutineRefundAccountInstallation, inspectRechargeRoutineRefundAccountCatalog } from '@/migrations/rechargeRoutineRefundAccount';
import { appendRechargeRoutineRefundAccountPolicy, readRechargeRoutineRefundAccountJournalTx, readRechargeRoutineRefundAccountPolicyTx } from '@/services/payment/RechargeRoutineRefundAccount';
import { rechargeRoutineRefundAccountId } from '@/services/payment/RechargeRoutineRefundAccountCodec';
import { routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { rechargeRefundCancellationFixture, type RechargeRefundCancellationFixture } from './helpers/rechargeRefundNative';
let f:RechargeRefundCancellationFixture;
const merchant=(version:number)=>({ref:'native_recharge_account',version,appId:'wx_owned_original',merchantId:'123456789',serialNo:'AB12',apiV3Key:'x'.repeat(32),
 privateKey:'-----BEGIN PRIVATE KEY-----fixture-not-provider-key-----END PRIVATE KEY-----',
 platformPublicKey:'-----BEGIN PUBLIC KEY-----fixture-not-provider-key-----END PUBLIC KEY-----',platformPublicKeyId:'PUB_KEY_ID_FIXTURE'});
const env={APP_KEY:'native-owned-recharge-account-approval-only',ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[merchant(1),merchant(2)]})};
const withdrawn={APP_KEY:env.APP_KEY,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:'{}'};
const policy=async(version=1)=>{
 const [clock]=await f.owner.execute<{now:string}>(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::bigint AS now`),now=Number(clock.now);
 const commitment=routinePaymentCredentialCommitment(env,'native_recharge_account',version);
 return{accountId:rechargeRoutineRefundAccountId(env,commitment.appId,commitment.merchantId),provider:'wechat',profile:'routine',state:'active',
  appId:commitment.appId,merchantId:commitment.merchantId,credentialRef:'native_recharge_account',credentialVersion:version,
  credentialStamp:commitment.credentialStamp,purposes:['refund_request','refund_query','refund_notify'],validFrom:now-60,validUntil:now+3600};
};
const pair={appId:'wx_owned_original',merchantId:'123456789'};
const read=(role:'admin'|'app'|'financial'='app',purpose:'refund_request'|'refund_query'|'refund_notify'='refund_request',runtime=env)=>
 f.peers[role].db.transaction(raw=>readRechargeRoutineRefundAccountPolicyTx(raw as never,runtime,pair,purpose,role,'read'),{isolationLevel:'repeatable read',accessMode:'read only'});
let recordId:string,firstData:Awaited<ReturnType<typeof policy>>;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real LOGIN recharge-only account approval maintenance and readers',()=>{
 beforeAll(async()=>{f=await rechargeRefundCancellationFixture();await runRechargeRoutineRefundAccountInstallation(f.owner,f.binding);},30000);
 afterAll(async()=>{if(f)await f.close();},30000);
 it('installs an exact isolated catalog; identical replay writes no catalog tuple',async()=>{
  expect(await inspectRechargeRoutineRefundAccountCatalog(f.owner)).toMatchObject({ready:true,binding:f.binding});
  const tuple=async()=>{const [r]=await f.owner.execute<{stamp:string}>(sql`SELECT c.xmin::text||':'||c.relacl::text||':'||obj_description(c.oid,'pg_class') AS stamp FROM pg_class c WHERE c.oid='public.recharge_routine_refund_account_policy'::regclass`);return r.stamp;};
  const before=await tuple();expect((await runRechargeRoutineRefundAccountInstallation(f.owner,f.binding)).replayed).toBe(true);expect(await tuple()).toBe(before);
 });
 it('starts with no inferred approval even if current registry material exists',async()=>{
  await expect(read()).rejects.toThrow('批准');
 });
 it('records only explicit maintenance approval and all three intended consumers read it',async()=>{
  recordId=randomUUID();firstData=await policy();
  expect(await appendRechargeRoutineRefundAccountPolicy(f.owner,env,f.binding,{operationId:recordId,expectedRevision:0,data:firstData})).toEqual({recordId,revision:1,replayed:false});
  for(const role of ['app','admin','financial'] as const)expect(await read(role)).toMatchObject({record_id:recordId,revision:1,payload:{data:{appId:pair.appId,credentialVersion:1}}});
 });
 it('recovers an immutable receipt after secret retirement without a duplicate row',async()=>{
  expect(await appendRechargeRoutineRefundAccountPolicy(f.owner,withdrawn,f.binding,{operationId:recordId,expectedRevision:0,data:firstData})).toEqual({recordId,revision:1,replayed:true});
  const row=await f.peers.admin.db.transaction(tx=>readRechargeRoutineRefundAccountJournalTx(tx as never,withdrawn,recordId,'admin'),{isolationLevel:'repeatable read',accessMode:'read only'});
  expect(row.record_id).toBe(recordId);await expect(read('app','refund_request',withdrawn)).rejects.toThrow();
 });
 it('rejects stale revision and global UUID reuse with a changed approval',async()=>{
  await expect(appendRechargeRoutineRefundAccountPolicy(f.owner,env,f.binding,{operationId:recordId,expectedRevision:0,data:{...firstData,purposes:['refund_query']}})).rejects.toThrow();
  await expect(appendRechargeRoutineRefundAccountPolicy(f.owner,env,f.binding,{operationId:randomUUID(),expectedRevision:0,data:firstData})).rejects.toThrow();
  expect((await read()).revision).toBe(1);
 });
 it('rejects runtime writers, Manager readers and role/DB OID substitution',async()=>{
  await expect(appendRechargeRoutineRefundAccountPolicy(f.peers.admin.db,env,f.binding,{operationId:randomUUID(),expectedRevision:1,data:firstData})).rejects.toThrow();
  await expect(f.peers.manager.exec('SELECT * FROM public.recharge_routine_refund_account_policy')).rejects.toThrow();
  await expect(runRechargeRoutineRefundAccountInstallation(f.owner,{...f.binding,adminOid:'4294967295'})).rejects.toThrow();
  await expect(runRechargeRoutineRefundAccountInstallation(f.owner,{...f.binding,databaseOid:'4294967295'})).rejects.toThrow();
 });
 it('refuses a partial ACL successor without repairing it',async()=>{
  await f.exec(`REVOKE SELECT ON public.recharge_routine_refund_account_policy FROM "${f.binding.admin}"`);
  try{expect((await inspectRechargeRoutineRefundAccountCatalog(f.owner)).ready).toBe(false);await expect(runRechargeRoutineRefundAccountInstallation(f.owner,f.binding)).rejects.toThrow('existing namespace drift');}
  finally{await f.exec(`GRANT SELECT ON public.recharge_routine_refund_account_policy TO "${f.binding.admin}"`);}
  expect((await inspectRechargeRoutineRefundAccountCatalog(f.owner)).ready).toBe(true);
 });
 it('blocks row rewriting even for maintenance and never enables runtime INSERT',async()=>{
  await expect(f.exec(`UPDATE public.recharge_routine_refund_account_policy SET signature=repeat('a',64) WHERE record_id='${recordId}'`)).rejects.toThrow('immutable');
  await expect(f.exec('TRUNCATE public.recharge_routine_refund_account_policy')).rejects.toThrow('immutable');
  const [r]=await f.owner.execute<{safe:boolean}>(sql`SELECT NOT has_table_privilege(${f.binding.app},'public.recharge_routine_refund_account_policy','INSERT')
   AND NOT has_table_privilege(${f.binding.admin},'public.recharge_routine_refund_account_policy','UPDATE')
   AND NOT has_function_privilege(${f.binding.financial},'public.recharge_routine_refund_account_immutable_v1()','EXECUTE') AS safe`);
  expect(r.safe).toBe(true);
 });
 it('honors a held account maintenance gate and leaves all receipts intact',async()=>{
  await f.peers.financial.db.transaction(async tx=>{
   await tx.execute(sql`SELECT pg_advisory_xact_lock(731731,0)`);
   await expect(runRechargeRoutineRefundAccountInstallation(f.owner,f.binding)).rejects.toThrow('gate');
  });expect((await read()).revision).toBe(1);
 });
 it('revokes without current credentials, preserves history and refuses new use',async()=>{
  const revoked={...firstData,state:'revoked'};
  expect(await appendRechargeRoutineRefundAccountPolicy(f.owner,withdrawn,f.binding,{operationId:randomUUID(),expectedRevision:1,data:revoked})).toMatchObject({revision:2,replayed:false});
  await expect(read()).rejects.toThrow('批准');
  expect((await f.peers.app.db.transaction(tx=>readRechargeRoutineRefundAccountJournalTx(tx as never,withdrawn,recordId,'app'),{isolationLevel:'repeatable read',accessMode:'read only'})).revision).toBe(1);
 });
 it('rotates explicitly to a new credential version under the same original subject',async()=>{
  const rotated=await policy(2);
  await appendRechargeRoutineRefundAccountPolicy(f.owner,env,f.binding,{operationId:randomUUID(),expectedRevision:2,data:rotated});
  expect(await read('financial','refund_query')).toMatchObject({revision:3,payload:{data:{credentialVersion:2}}});
  const wrongRegistry={...env,ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS:JSON.stringify({format:1,credentials:[merchant(1)]})};
  await expect(read('app','refund_request',wrongRegistry)).rejects.toThrow();
 });
});
