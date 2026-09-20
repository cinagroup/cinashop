import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminRefundEvidenceFixture } from './helpers/adminRefundEvidenceFixture';
import { systemAdmin, systemRole, systemMenus, storeOrderRefund, storeOrder, storeOrderRefundPayment, storeOrderOutbox } from '../src/models/schema';
import { adminRefundDecisionScope } from '../src/services/admin/AdminRefundDecisionService';
import { StoreOrderRefundService, approveStoreOrderReturn } from '../src/services/order/StoreOrderRefundService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { md5, verifyToken } from '../src/utils/jwt';
import { ADMIN_REFUND_OPERATION_SQL } from '../src/migrations/adminRefundOperation';
let f: Awaited<ReturnType<typeof adminRefundEvidenceFixture>>, afterAuth: () => Promise<void>;
beforeEach(async()=>{afterAuth=async()=>{};f=await adminRefundEvidenceFixture(()=>afterAuth());await f.exec(ADMIN_REFUND_OPERATION_SQL);});
afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
const review={uid:11,storeId:0,supplierId:0,storeOrderId:28,orderId:'history_refund_28',refundPrice:'5.00'};
const request=async(body:Record<string,unknown>)=>await(await f.adminApp.request('/adminapi/refund/operations/execute/28',{method:'POST',headers:{Authorization:'Bearer '+f.tokens.get(100),'content-type':'application/json',
  'Idempotency-Key':crypto.randomUUID(),'X-Refund-Operation-Scope':'v1:admin:100'},body:JSON.stringify({version:'admin-refund-operation-v1',...body})},f.env)).json() as {status:number;msg:string};
it('rejects an administrator disabled after entry authentication and before the locked decision',async()=>{
  const before=await f.snapshot();afterAuth=async()=>{await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));};
  const result=await request({action:'return',review,decision:{applyType:2,refundType:0,received:false}});
  expect(result.status).not.toBe(200);expect(await f.snapshot()).toEqual(before);expect((await f.applications()).find(r=>r.id===28)?.refundType).toBe(0);expect(await f.statuses()).toEqual([]);
});
it('rejects a stale reviewed state after another administrator changes it',async()=>{
  afterAuth=async()=>{await f.db.update(storeOrderRefund).set({refundType:1}).where(eq(storeOrderRefund.id,28));};
  const result=await request({action:'return',review,decision:{applyType:2,refundType:0,received:false}});
  expect(result.status).not.toBe(200);expect((await f.applications()).find(r=>r.id===28)?.refundType).toBe(1);expect(await f.statuses()).toEqual([]);
});
it('requires an explicit reviewed decision contract, not just identity and amount',async()=>{
  expect((await request({action:'return',review})).status).not.toBe(200);expect(await f.statuses()).toEqual([]);
});
const actor=()=>({id:100,authVersion:md5('synthetic-digest'),expiresAt:Math.floor(Date.now()/1000)+3600});
it.each([{isDel:1},{adminType:4},{pwd:'changed-digest'},{level:1}])('rechecks current administrator fields after authentication: %j',async change=>{
  afterAuth=async()=>{await f.db.update(systemAdmin).set(change).where(eq(systemAdmin.id,100));};
  expect((await request({action:'return',review,decision:{applyType:2,refundType:0,received:false}})).status).not.toBe(200);
  expect((await f.applications()).find(r=>r.id===28)?.refundType).toBe(0);expect(await f.statuses()).toEqual([]);
});
it.each(['disabled','removed-permission','removed-assignment'])('rechecks a role granted at entry after %s',async kind=>{
  await f.db.update(systemAdmin).set({level:1,roles:'1'}).where(eq(systemAdmin.id,100));
  await f.db.update(systemRole).set({rules:'refund.manage'}).where(eq(systemRole.id,1));
  afterAuth=async()=>{if(kind==='removed-assignment')await f.db.update(systemAdmin).set({roles:''}).where(eq(systemAdmin.id,100));
    else await f.db.update(systemRole).set(kind==='disabled'?{status:0}:{rules:'refund.view'}).where(eq(systemRole.id,1));};
  expect((await request({action:'return',review,decision:{applyType:2,refundType:0,received:false}})).status).not.toBe(200);expect(await f.statuses()).toEqual([]);
});
it.each(['removed','changed','unchanged'])('resolves current legacy numeric menu permissions under the same transaction: %s',async kind=>{
  await f.db.insert(systemMenus).values({id:800,type:1,authType:2,access:1,uniqueAuth:'refund.manage'});
  await f.db.update(systemRole).set({rules:'800'}).where(eq(systemRole.id,1));
  await f.db.update(systemAdmin).set({level:1,roles:'1'}).where(eq(systemAdmin.id,100));
  afterAuth=async()=>{if(kind!=='unchanged')await f.db.update(systemMenus).set(kind==='removed'?{isDel:1}:{uniqueAuth:'refund.view'}).where(eq(systemMenus.id,800));};
  const result=await request({action:'return',review,decision:{applyType:2,refundType:0,received:false}});
  expect(result.status===200).toBe(kind==='unchanged');expect((await f.statuses()).length).toBe(kind==='unchanged'?1:0);
});
it('rejects JWT expiry after middleware authentication',async()=>{
  const payload=await verifyToken(f.tokens.get(100)!,f.env.APP_KEY);
  afterAuth=async()=>{vi.spyOn(Date,'now').mockReturnValue((payload.exp+1)*1000);};
  expect((await request({action:'return',review,decision:{applyType:2,refundType:0,received:false}})).status).not.toBe(200);expect(await f.statuses()).toEqual([]);
});
it.each([null,{}, {applyType:2,refundType:0,received:'true'}, {applyType:2,refundType:6,received:false}, {applyType:1,refundType:0,received:false}])('rejects malformed or inapplicable return decisions %j',async decision=>{
  expect((await request({action:'return',review,decision})).status).not.toBe(200);expect(await f.statuses()).toEqual([]);
});
it.each([{applyType:2,refundType:4,received:true},{applyType:2,refundType:5,received:false},{applyType:3,refundType:0,received:true}])('enforces receipt stage before any monetary execution: %j',async decision=>{
  const core=vi.spyOn(StoreOrderRefundService.prototype,'agreeRefund');
  expect((await request({action:'refund',review,decision})).status).not.toBe(200);expect(core).not.toHaveBeenCalled();expect(await f.statuses()).toEqual([]);
});
it('requires an exact application type even when the new type would also allow approval',async()=>{
  afterAuth=async()=>{await f.db.update(storeOrderRefund).set({applyType:3}).where(eq(storeOrderRefund.id,28));};
  expect((await request({action:'return',review,decision:{applyType:2,refundType:0,received:false}})).status).not.toBe(200);expect(await f.statuses()).toEqual([]);
});
it('captures the actor and decision instead of retaining mutable caller objects',async()=>{
  const originalActor=actor(),decision={applyType:2,refundType:0,received:false};
  const scope=adminRefundDecisionScope(review,decision,'return',originalActor);
  originalActor.id=102;decision.refundType=5;
  await expect(approveStoreOrderReturn(f.container,28,scope)).resolves.toEqual({changed:true});
});
it.each(['yue','weixin'])('rechecks permission at the second %s admission phase before money/intent writes',async payType=>{
  await f.db.update(storeOrder).set({payType}).where(eq(storeOrder.id,28));
  await f.db.update(storeOrderRefund).set({applyType:1}).where(eq(storeOrderRefund.id,28));
  const before=await f.snapshot(),scope=adminRefundDecisionScope(review,{applyType:1,refundType:0,received:false},'refund',actor());
  const original=scope.authorizeLockedDecision!;let admitted=0;
  scope.authorizeLockedDecision=async(tx,refund,order)=>{await original(tx,refund,order);if(++admitted===1)await tx.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));};
  const gateway=vi.spyOn(WechatPayService.prototype,'requestRefund').mockRejectedValue(Error('must not contact gateway'));
  await expect(new StoreOrderRefundService(f.container,f.env).agreeRefund(28,scope)).rejects.toThrow('已禁用');
  expect(admitted).toBe(1);expect(gateway).not.toHaveBeenCalled();expect(await f.snapshot()).toEqual(before);expect(await f.db.select().from(storeOrderRefundPayment)).toEqual([]);expect(await f.statuses()).toEqual([]);
});
it('reauthorizes before reclaiming a provider request after NOT_FOUND',async()=>{
  await f.db.update(storeOrder).set({payType:'weixin'}).where(eq(storeOrder.id,28));
  await f.db.update(storeOrderRefund).set({applyType:1}).where(eq(storeOrderRefund.id,28));
  await f.db.insert(storeOrderRefundPayment).values({refundId:28,storeOrderId:28,provider:'wechat',outRefundNo:'CNSR28',providerStatus:'UNKNOWN',requestAmount:500,totalAmount:1000});
  const query=vi.spyOn(WechatPayService.prototype,'queryRefund').mockImplementation(async()=>{await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));return {status:'NOT_FOUND'};});
  const send=vi.spyOn(WechatPayService.prototype,'requestRefund').mockRejectedValue(Error('must not send'));
  const scope=adminRefundDecisionScope(review,{applyType:1,refundType:0,received:false},'refund',actor());
  await expect(new StoreOrderRefundService(f.container,f.env).agreeRefund(28,scope)).rejects.toThrow('已禁用');
  expect(query).toHaveBeenCalledTimes(1);expect(send).not.toHaveBeenCalled();expect((await f.db.select().from(storeOrderRefundPayment))[0]).toMatchObject({providerStatus:'UNKNOWN',attemptCount:0});
});
it('commits a currently authorized refusal and one immutable notification event without settling money',async()=>{
  const before=await f.snapshot();
  const response=await request({action:'refuse',review,decision:{applyType:2,refundType:0,received:false},reason:'本地完整核对后拒绝'});
  expect(response).toMatchObject({status:200,data:{receipt:{outcome:'refused'},execution:null}});expect((await f.applications()).find(r=>r.id===28)).toMatchObject({refundType:3,refuseReason:'本地完整核对后拒绝',refundedPrice:'0.00'});
  const after=await f.snapshot();expect({...after,orders:[]}).toEqual({...before,orders:[]});
  expect(after.orders.sort((a,b)=>a.id-b.id)).toEqual(before.orders.map(r=>r.id===28?{...r,refundStatus:0,refundType:3}:r).sort((a,b)=>a.id-b.id));
  expect(await f.statuses()).toHaveLength(1);expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
});
it('a provider SUCCESS still routes to unscoped settlement after the admitted actor loses permission',async()=>{
  await f.db.update(storeOrder).set({payType:'weixin'}).where(eq(storeOrder.id,28));
  await f.db.update(storeOrderRefund).set({applyType:1}).where(eq(storeOrderRefund.id,28));
  const scope=adminRefundDecisionScope(review,{applyType:1,refundType:0,received:false},'refund',actor());
  const admitted=vi.fn(scope.authorizeLockedDecision!);scope.authorizeLockedDecision=admitted;
  const service=new StoreOrderRefundService(f.container,f.env);
  // Only prove callback routing here; actual settlement is covered by its existing dedicated suites.
  const settlement=vi.spyOn(service as unknown as {finalizeRefund(id:number):Promise<void>},'finalizeRefund').mockResolvedValue();
  vi.spyOn(WechatPayService.prototype,'requestRefund').mockImplementation(async()=>{await f.db.update(systemAdmin).set({status:0}).where(eq(systemAdmin.id,100));return {status:'SUCCESS'};});
  expect(await service.agreeRefund(28,scope)).toEqual({completed:true,status:'SUCCESS'});expect(admitted).toHaveBeenCalledTimes(2);expect(settlement).toHaveBeenCalledWith(28);
});
