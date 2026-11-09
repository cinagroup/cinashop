/** Real PG16 five-LOGIN local cancellation only.
 * Holds/markers below are explicitly OWNER-AUTHORED SPECIMENS: they prove no
 * payment author, actual POST, verified provider response or channel refund. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ApiErrorCode } from '@/utils/errors';
import { runRechargeRefundRuntimeCommission } from '@/migrations/rechargeRefundRuntimeCommission';
import { inspectRechargeRefundCatalog, RECHARGE_REFUND_CATALOG_SQL } from '@/migrations/rechargeRefund';
import { cancelAdminRechargeRefundBeforePost } from '@/services/admin/AdminRechargeRefundCancellation';
import { authenticateRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { rechargeRefundDecimal } from '@/services/payment/RechargeRefundMoney';
import { assertRechargeRefundBusinessResolutionTx } from '@/services/payment/RechargeRefundAccounting';
import { rechargeRefundCancellationFixture, seedRechargeRefundHold, rechargeRefundPublicSnapshot,
 ownerRequestMarker, ownerResultMarker, revokeSpecimenRule, rechargeRefundNativeEnv,
 type RechargeRefundCancellationFixture, type RechargeRefundHoldSpecimen } from './helpers/rechargeRefundNative';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('recharge refund native independent-LOGIN cancellation of owner hold specimens',()=>{
 let f:RechargeRefundCancellationFixture;
 // Dedicated DB + four new LOGIN sessions + explicit commissioning are setup,
 // not a larger business-case timeout. Every individual test remains 5 seconds.
 beforeAll(async()=>{f=await rechargeRefundCancellationFixture();},30000);
 afterAll(async()=>{await f?.close();},30000);
 const cancel=(s:RechargeRefundHoldSpecimen,actor=f.actor())=>
  cancelAdminRechargeRefundBeforePost(f.adminContainer,rechargeRefundNativeEnv,actor,s.rechargeId,s.key);

 it('proves five actual login identities/PIDs and exact no-write commissioning replay with narrow business grants',async()=>{
  const actors=[f.maintenance,f.peers.app,f.peers.admin,f.peers.financial,f.peers.manager];
  expect(new Set(actors.map(a=>a.role)).size).toBe(5);
  expect(new Set(actors.map(a=>a.oid)).size).toBe(5);
  expect(new Set(actors.map(a=>a.pid)).size).toBe(5);
  for(const kind of ['app','admin','financial','manager'] as const) {
   const rows=await f.peers[kind].db.execute<{role:string;session:string;oid:string;pid:number}>(sql`SELECT
    current_user AS role,session_user AS session,(SELECT oid::text FROM pg_catalog.pg_roles WHERE rolname=current_user) AS oid,pg_backend_pid() AS pid`);
   expect(rows).toEqual([{role:f.peers[kind].role,session:f.peers[kind].role,oid:f.peers[kind].oid,pid:f.peers[kind].pid}]);
  }
  const before=await f.owner.execute(sql.raw(RECHARGE_REFUND_CATALOG_SQL));
  expect(await runRechargeRefundRuntimeCommission(f.owner,f.binding)).toEqual({binding:f.binding,replayed:true});
  expect(await f.owner.execute(sql.raw(RECHARGE_REFUND_CATALOG_SQL))).toEqual(before);
  expect(await inspectRechargeRefundCatalog(f.owner)).toMatchObject({installed:true,commissioned:true,binding:f.binding});
  const [acl]=await f.peers.admin.db.execute(sql`SELECT
   has_table_privilege(current_user,'public.user_recharge','UPDATE') AS recharge_update,
   has_table_privilege(current_user,'public.user_bill','UPDATE') AS bill_update,
   has_column_privilege(current_user,'public.user','now_money','UPDATE') AS wallet_update,
   has_column_privilege(current_user,'public.system_admin','login_count','UPDATE') AS admin_lock_column,
   has_column_privilege(current_user,'public.system_admin','roles','UPDATE') AS admin_roles_update,
   has_column_privilege(current_user,'public.system_role','role_name','UPDATE') AS role_lock_column,
   has_column_privilege(current_user,'public.system_role','rules','UPDATE') AS rule_update,
   has_table_privilege(current_user,'public.system_menus','UPDATE') AS menu_update`);
  expect(acl).toEqual({recharge_update:false,bill_update:false,wallet_update:true,admin_lock_column:true,
   admin_roles_update:false,role_lock_column:true,rule_update:false,menu_update:false});
 },5000);

 for(const recoverGift of [false,true]) {
  it('releases exactly the owner-authored '+(recoverGift?'principal-plus-gift':'principal-only')+' hold through real Admin authorization and local evidence',async()=>{
   const s=await seedRechargeRefundHold(f,recoverGift),before=JSON.parse(await rechargeRefundPublicSnapshot(f,s));
   expect(before.wallet.now_money).toBe(rechargeRefundDecimal(s.after));
   expect(before.attempts).toEqual([]);expect(before.results).toEqual([]);
   const result=await cancel(s);
   expect(result.released).toBe(true);expect(result.operation.signature).toBe(s.operation.signature);
   const after=JSON.parse(await rechargeRefundPublicSnapshot(f,s));
   expect(after.wallet.now_money).toBe('100.00');
   expect(after.recharge).toEqual(before.recharge);expect(after.operation).toEqual(before.operation);
   expect(after.bills).toHaveLength(2);expect(after.bills[0]).toEqual(before.bills[0]);
   expect(after.bills[1]).toMatchObject({uid:s.uid,link_id:s.orderNo,event_key:'recharge_refund_release:'+s.operationId,
    pm:1,number:rechargeRefundDecimal(s.debit),balance:'100.00',type:'recharge_refund_release',status:1});
   expect(after.state).toMatchObject({status:'FAILED',wallet_state:'released',version:1,attempt_count:0});
   expect(after.attempts).toEqual([]);
   const rows=await f.owner.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${s.operationId}::uuid ORDER BY source`);
   const proofs=Array.from(rows,row=>authenticateRechargeRefundRecord(rechargeRefundNativeEnv,f.binding,'recharge_refund_result',row));
   expect(proofs).toHaveLength(2);expect(proofs.map(p=>p.source)).toEqual(['local_cancel','local_release']);
   expect(proofs[0]).toMatchObject({status:'CLOSED',attempt_id:null,caused_by_result_id:null});
   expect(proofs[1]).toMatchObject({status:'SUCCESS',attempt_id:null,caused_by_result_id:proofs[0].result_id});
   expect(after.state.last_result_id).toBe(proofs[1].result_id);
   expect(proofs[1].evidence).toMatchObject({holdBillId:s.holdBillId,releaseBillId:after.bills[1].id,
    walletBeforeCents:s.after,walletAfterCents:s.before,debitCents:s.debit});
  },5000);
 }

 it('does not credit a second time when cancellation is repeated',async()=>{
  const s=await seedRechargeRefundHold(f,true);expect((await cancel(s)).released).toBe(true);
  const afterFirst=await rechargeRefundPublicSnapshot(f,s);
  await expect(cancel(s)).rejects.toThrow('原操作已有执行证据');
  expect(await rechargeRefundPublicSnapshot(f,s)).toBe(afterFirst);
 },5000);

 it('refuses an immutable owner request marker even when the mutable projection still says unused RESERVED',async()=>{
  const s=await seedRechargeRefundHold(f,true);await ownerRequestMarker(f,s);
  const before=await rechargeRefundPublicSnapshot(f,s);
  await expect(cancel(s)).rejects.toThrow('原操作已有执行证据');
  expect(await rechargeRefundPublicSnapshot(f,s)).toBe(before);
 },5000);

 it('refuses an immutable owner result marker without treating it as a real provider observation',async()=>{
  const s=await seedRechargeRefundHold(f,false);await ownerResultMarker(f,s);
  const before=await rechargeRefundPublicSnapshot(f,s);
  await expect(cancel(s)).rejects.toThrow('原操作已有执行证据');
  expect(await rechargeRefundPublicSnapshot(f,s)).toBe(before);
 },5000);

 it('rejects an expired actual Admin actor without changing any public accounting row',async()=>{
  const s=await seedRechargeRefundHold(f,true),before=await rechargeRefundPublicSnapshot(f,s);
  await expect(cancel(s,{...f.actor(),expiresAt:Math.floor(Date.now()/1000)-1})).rejects.toMatchObject({code:ApiErrorCode.ERR_EXPIRED});
  expect(await rechargeRefundPublicSnapshot(f,s)).toBe(before);
 },5000);

 it('rejects a mismatched actual Admin authVersion without changing any public accounting row',async()=>{
  const s=await seedRechargeRefundHold(f,true),before=await rechargeRefundPublicSnapshot(f,s);
  await expect(cancel(s,{...f.actor(),authVersion:'0'.repeat(32)})).rejects.toMatchObject({code:ApiErrorCode.ERR_EXPIRED});
  expect(await rechargeRefundPublicSnapshot(f,s)).toBe(before);
 },5000);

 it('rechecks the non-level0 role capability and rejects a revoked recharge_order.refund rule',async()=>{
  const s=await seedRechargeRefundHold(f,true);await revokeSpecimenRule(f,false);
  try {
   const before=await rechargeRefundPublicSnapshot(f,s);
   await expect(cancel(s)).rejects.toMatchObject({code:ApiErrorCode.ERR_AUTH});
   expect(await rechargeRefundPublicSnapshot(f,s)).toBe(before);
  } finally {await revokeSpecimenRule(f,true);}
 },5000);

 for(const alias of ['user','user_bill','user_recharge'] as const) {
  it('rejects an actual implicit pg_temp '+alias+' alias while current_schema remains public, with public accounting byte-for-byte unchanged',async()=>{
   const s=await seedRechargeRefundHold(f,true),peer=f.peers.admin,quoted='"'+alias+'"';
   const predicate=alias==='user'?'uid='+s.uid:alias==='user_bill'?'uid='+s.uid:'id='+s.rechargeId;
   try {
    await peer.exec('CREATE TEMP TABLE '+quoted+' (LIKE public.'+quoted+' INCLUDING ALL)');
    await peer.exec('INSERT INTO pg_temp.'+quoted+' SELECT * FROM public.'+quoted+' WHERE '+predicate);
    // Omit explicit pg_temp: relations then resolve temporary-first although
    // current_schema() is still public, exposing the exact old resolver gap.
    await peer.exec('SET search_path TO public');
    const [resolution]=await peer.db.execute<{shadow:boolean;schema:string}>(sql`SELECT
     pg_catalog.to_regclass(${alias})=pg_catalog.to_regclass(${'pg_temp.'+alias}) AS shadow,current_schema() AS schema`);
    expect(resolution).toEqual({shadow:true,schema:'public'});
    const before=await rechargeRefundPublicSnapshot(f,s);
    // Exercise the business resolver itself even if the separate role-owner
    // guard also rejects this session's new temporary objects at admission.
    await expect(peer.db.transaction(async tx=>assertRechargeRefundBusinessResolutionTx(tx as unknown as import('@/lib/di').DbClient)))
     .rejects.toThrow('充值退款余额账本或资金状态');
    await expect(cancel(s)).rejects.toMatchObject({httpStatus:503});
    expect(await rechargeRefundPublicSnapshot(f,s)).toBe(before);
   } finally {
    await peer.exec('DROP TABLE IF EXISTS pg_temp.'+quoted);
    await peer.exec('SET search_path TO public,pg_temp');
   }
  },5000);
 }
});
