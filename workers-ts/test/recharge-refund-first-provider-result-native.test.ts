/** Genuine payment/hold/sole claim -> actual RSA first POST -> independent
 * immutable result COMMIT. No HTTP refund route or local settlement is tested. */
import { randomUUID,sign,verify } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import type { DbClient } from '@/lib/di';
import { claimAdminRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { rechargeRefundAdminAuthorFixture,rechargeAuthorOriginal,rechargeAuthorUids,
  type RechargeRefundAdminAuthorFixture } from './helpers/rechargeRefundAdminAuthorNative';

const transport=vi.hoisted(()=>{
 const values=new Map<string,unknown>();
 const get=vi.fn(async(key:string)=>values.get(key)??null),set=vi.fn(async(key:string,value:unknown)=>{values.set(key,value);return true;});
 const remove=vi.fn(async(key:string)=>values.delete(key)),take=vi.fn(async(key:string)=>{const value=values.get(key)??null;values.delete(key);return value;});
 const setIfAbsent=vi.fn(async(key:string,value:unknown)=>{if(values.has(key))return false;values.set(key,value);return true;});
 const redis={eval:vi.fn(async()=>1),get,set:vi.fn(async(key:string,value:unknown)=>{await set(key,value);return'OK';}),del:vi.fn(async(key:string)=>Number(await remove(key)))};
 return{values,get,set,remove,take,setIfAbsent,redis};
});
vi.mock('@/utils/cache',async original=>({...await original<typeof import('@/utils/cache')>(),getRedis:()=>transport.redis,
 cacheGet:transport.get,cacheSet:transport.set,cacheTake:transport.take,cacheDelete:transport.remove,cacheSetIfAbsent:transport.setIfAbsent,
 setTokenBucket:vi.fn(async()=>true),clearToken:vi.fn(async()=>true)}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('genuine recharge first POST and independent provider evidence',()=>{
 let f:RechargeRefundAdminAuthorFixture,nextUid=0,setup:Promise<void>|undefined,pending:Promise<unknown>|undefined,busy=false;
 let active:{orderNo:string;transactionId:string;outRefundNo:string}|undefined;
 let responseStatus='SUCCESS',httpStatus=200,wrongSignature=false,mutate:(body:Record<string,unknown>)=>Record<string,unknown>=body=>body;
 const posts:Array<{url:string;body:Record<string,unknown>}> = [];
 const start=<T>(run:()=>Promise<T>):Promise<T>=>{
  if(busy)throw Error('Previous genuine provider case still pending');busy=true;
  const work=run().finally(()=>{busy=false;});pending=work;void work.catch(()=>undefined);return work;
 };
 const service=(db=f.adminRuntime.db)=>new WechatPayService({...f.adminContainer,db},f.env);
 async function reserved(claimDb=f.adminRuntime.db,recoverGift=true){
  const uid=rechargeAuthorUids[nextUid++];if(!uid)throw Error('Distinct real buyer exhausted');
  await f.approve();const paid=await f.paid(uid),q=await f.quote(paid.order),key=randomUUID();
  const admitted=await f.admit(key,f.body(paid.order,q,recoverGift));
  const token=await claimAdminRechargeRefundFirstRequest({...f.adminContainer,db:claimDb},f.env,f.actor(),admitted.operation.operation_id);
  active={orderNo:paid.order.orderId,transactionId:paid.transaction,outRefundNo:String(admitted.operation.out_refund_no)};
  return{...paid,key,operation:admitted.operation,token};
 }
 const rows=(id:unknown)=>f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${id}::uuid`);
 const snapshot=async(order:Parameters<RechargeRefundAdminAuthorFixture['snapshot']>[0])=>JSON.parse(await f.snapshot(order)) as Record<string,unknown>;
 beforeAll(async()=>{
  setup=(async()=>{
   f=await rechargeRefundAdminAuthorFixture(transport.values);f.env.ROUTINE_REFUND_NOTIFY_ORIGIN='https://recharge-refund.example';
   const oauth=f.network.getMockImplementation();if(!oauth)throw Error('Missing strict local OAuth adapter');
   f.network.mockImplementation(async(input,init)=>{
    const url=new URL(String(input));
    if(url.origin!=='https://api.mch.weixin.qq.com')return oauth(input,init);
    if(url.pathname!=='/v3/refund/domestic/refunds'||init?.method!=='POST'||!active||typeof init.body!=='string')throw Error('Unplanned merchant I/O');
    const body=JSON.parse(init.body) as Record<string,unknown>,headers=new Headers(init.headers),auth=headers.get('Authorization')??'';
    expect(body).toEqual({out_refund_no:active.outRefundNo,reason:'充值原路退款',notify_url:expect.stringMatching(/^https:\/\/recharge-refund\.example\/api\/pay\/notify\/recharge-refund\//u),
     transaction_id:active.transactionId,amount:{refund:1000,total:1000,currency:'CNY'}});
    expect(auth).toContain('mchid="'+rechargeAuthorOriginal.merchantId+'"');expect(auth).toContain('serial_no="ABCDEF123456"');
    const nonce=auth.match(/nonce_str="([^"]+)"/u)?.[1],timestamp=auth.match(/timestamp="([0-9]+)"/u)?.[1],signature=auth.match(/signature="([^"]+)"/u)?.[1];
    const publicKey=f.env.WECHAT_PLATFORM_PUBLIC_KEY,privateKey=f.env.WECHAT_MCH_PRIVATE_KEY;
    if(!nonce||!timestamp||!signature||typeof publicKey!=='string'||typeof privateKey!=='string')throw Error('Missing local RSA fixture');
    expect(verify('RSA-SHA256',Buffer.from('POST\n/v3/refund/domestic/refunds\n'+timestamp+'\n'+nonce+'\n'+init.body+'\n'),publicKey,Buffer.from(signature,'base64'))).toBe(true);
    expect(headers.get('Wechatpay-Serial')).toBe(rechargeAuthorOriginal.serial);posts.push({url:String(url),body});
    const data=httpStatus>=400?{code:'SYSTEM_ERROR',message:'synthetic signed failure'}:mutate({mchid:rechargeAuthorOriginal.merchantId,
     appid:rechargeAuthorOriginal.appId,out_trade_no:active.orderNo,transaction_id:active.transactionId,out_refund_no:active.outRefundNo,
     refund_id:'refund_'+posts.length,status:responseStatus,success_time:new Date().toISOString(),amount:{refund:1000,total:1000,currency:'CNY'}});
    const raw=JSON.stringify(data),time=String(Math.floor(Date.now()/1000)),responseNonce='local_refund_response_nonce';
    const signed=Buffer.from(sign('RSA-SHA256',Buffer.from(time+'\n'+responseNonce+'\n'+raw+'\n'),privateKey)).toString('base64');
    return new Response(raw,{status:httpStatus,headers:{'content-type':'application/json','Wechatpay-Timestamp':time,'Wechatpay-Nonce':responseNonce,
     'Wechatpay-Serial':rechargeAuthorOriginal.serial,'Wechatpay-Signature':wrongSignature?'A'.repeat(signed.length):signed}});
   });
  })();await setup;
 },240000);
 afterAll(async()=>{
  try{if(setup)await Promise.allSettled([setup]);if(pending)await Promise.allSettled([pending]);}
  finally{try{await f?.close();}finally{vi.restoreAllMocks();}}
 },30000);
 afterEach(()=>{
  responseStatus='SUCCESS';httpStatus=200;wrongSignature=false;mutate=body=>body;active=undefined;
  if(!f)return;expect(f.calls).toHaveLength(rechargeAuthorUids.length);
  expect(f.calls.every(call=>{const u=new URL(call.url);return call.method==='GET'&&u.origin==='https://api.weixin.qq.com'&&u.pathname==='/sns/jscode2session';})).toBe(true);
 });

 it.each(['SUCCESS','PROCESSING','CLOSED','ABNORMAL'])('persists %s once with original-pair RSA and no local economic/projection writes',status=>start(async()=>{
  responseStatus=status;const recoverGift=status!=='SUCCESS',r=await reserved(f.adminRuntime.db,recoverGift),before=await snapshot(r.order),count=posts.length,s=service();
  expect(r.operation.debit_cents).toBe(recoverGift?1150:1000);expect(r.operation.reclaim_gift).toBe(recoverGift);
  const result=await s.requestRechargeRefundFirst(r.token);expect(posts).toHaveLength(count+1);
  expect(result.status).toBe(status);expect(Object.isFrozen(result)).toBe(true);expect(Object.keys(result).sort()).toEqual(['attemptId','operationId','status']);
  await expect(s.persistRechargeRefundFirstResult({...result})).rejects.toThrow();
  await expect(s.persistRechargeRefundFirstResult(JSON.parse(JSON.stringify(result)))).rejects.toThrow();
  const otherInstance=service(),otherRoot=service(f.profilePeers.financial.db);
  await expect(otherInstance.persistRechargeRefundFirstResult(result)).rejects.toThrow();
  await expect(otherRoot.persistRechargeRefundFirstResult(result)).rejects.toThrow();
  const first=s.persistRechargeRefundFirstResult(result);
  await expect(otherInstance.persistRechargeRefundFirstResult(result)).rejects.toThrow();
  await expect(otherRoot.persistRechargeRefundFirstResult(result)).rejects.toThrow();
  const saved=await Promise.all([first,s.persistRechargeRefundFirstResult(result)]);
  expect(saved[1]).toEqual(saved[0]);expect(await s.persistRechargeRefundFirstResult(result)).toEqual(saved[0]);
  await expect(otherInstance.persistRechargeRefundFirstResult(result)).rejects.toThrow();
  await expect(otherRoot.persistRechargeRefundFirstResult(result)).rejects.toThrow();
  const records=await rows(r.operation.operation_id);expect(records).toHaveLength(1);expect(records[0]).toMatchObject({result_id:saved[0].resultId,attempt_id:r.token.attemptId,
   source:'request',source_id:r.token.attemptId,status});
  const after=await snapshot(r.order);expect({...after,results:before.results}).toEqual(before);expect(await f.wallet(r.order.uid)).toBe(recoverGift?'0.00':'1.50');
  await expect(s.requestRechargeRefundFirst(r.token)).rejects.toThrow();expect(posts).toHaveLength(count+1);
 }),5000);

 const mismatches:Array<[string,(body:Record<string,unknown>)=>Record<string,unknown>]>=[
  ['order',b=>({...b,out_trade_no:'wrong_order'})],['transaction',b=>({...b,transaction_id:'wrong_transaction'})],
  ['refund',b=>({...b,out_refund_no:'wrong_refund'})],['refund amount',b=>({...b,amount:{refund:1,total:1000,currency:'CNY'}})],
  ['total amount',b=>({...b,amount:{refund:1000,total:1001,currency:'CNY'}})],['currency',b=>({...b,amount:{refund:1000,total:1000,currency:'USD'}})],
  ['merchant',b=>({...b,mchid:'9999999999'})],['app',b=>({...b,appid:rechargeAuthorOriginal.currentAppId})],
  ['future SUCCESS time',b=>({...b,success_time:'2037-01-01T00:00:00+08:00'})],
 ];
 it.each(mismatches)('rejects an actually signed response with mismatched %s and retains query-only hold',(_name,change)=>start(async()=>{
  mutate=change;const r=await reserved(),before=await snapshot(r.order),count=posts.length,s=service();
  await expect(s.requestRechargeRefundFirst(r.token)).rejects.toThrow();expect(posts).toHaveLength(count+1);
  expect(await rows(r.operation.operation_id)).toHaveLength(0);expect(await snapshot(r.order)).toEqual(before);
  await expect(s.requestRechargeRefundFirst(r.token)).rejects.toThrow();expect(posts).toHaveLength(count+1);
 }),5000);

 it('requires actual RSA verification and never records an unsigned or invalid-signature outcome',()=>start(async()=>{
  wrongSignature=true;const r=await reserved(),before=await snapshot(r.order),s=service();
  await expect(s.requestRechargeRefundFirst(r.token)).rejects.toThrow();expect(await rows(r.operation.operation_id)).toHaveLength(0);
  expect(await snapshot(r.order)).toEqual(before);
 }),5000);

 it('stores an authenticated HTTP error as UNKNOWN without releasing the reservation',()=>start(async()=>{
  httpStatus=500;const r=await reserved(),before=await snapshot(r.order),s=service();
  const token=await s.requestRechargeRefundFirst(r.token);expect(token.status).toBe('UNKNOWN');
  await s.persistRechargeRefundFirstResult(token);const records=await rows(r.operation.operation_id);expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({status:'UNKNOWN',evidence:{result:{status:'UNKNOWN',errorCode:'SYSTEM_ERROR'},verification:{httpStatus:500}}});
  const after=await snapshot(r.order);expect({...after,results:before.results}).toEqual(before);
 }),5000);

 it('retains verified SUCCESS and the same result identity across a real late SQL rollback',()=>start(async()=>{
  const transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db);
  let attemptedResultId='',failLate=true,evidenceStage=false;
  const failing=new Proxy(f.adminRuntime.db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);
   return(callback:(tx:DbClient)=>Promise<{resultId:string}>,options:Parameters<DbClient['transaction']>[1])=>transaction(async actual=>{
    const result=await callback(actual as unknown as DbClient);
    if(evidenceStage){attemptedResultId=result.resultId;if(failLate)await actual.execute(sql`SELECT 1/0`);}return result;
   },options);
  }});
  const r=await reserved(failing),before=await snapshot(r.order),s=service(failing),token=await s.requestRechargeRefundFirst(r.token);
  evidenceStage=true;
  await expect(s.persistRechargeRefundFirstResult(token)).rejects.toThrow();expect(attemptedResultId).not.toBe('');
  expect(await rows(r.operation.operation_id)).toHaveLength(0);expect(await snapshot(r.order)).toEqual(before);
  failLate=false;const receipt=await s.persistRechargeRefundFirstResult(token);expect(receipt.resultId).toBe(attemptedResultId);expect(receipt.status).toBe('SUCCESS');
  expect(await rows(r.operation.operation_id)).toHaveLength(1);
 }),5000);

 it('replays the same committed row after an actual COMMIT followed by a lost-acknowledgement equivalent',()=>start(async()=>{
  const transaction=f.adminRuntime.db.transaction.bind(f.adminRuntime.db);
  let committedResultId='',loseAck=true,evidenceStage=false;
  const lostAck=new Proxy(f.adminRuntime.db,{get(target,key,receiver){if(key!=='transaction')return Reflect.get(target,key,receiver);
   return async(callback:(tx:DbClient)=>Promise<{resultId:string}>,options:Parameters<DbClient['transaction']>[1])=>{
    const result=await transaction(actual=>callback(actual as unknown as DbClient),options);
    if(evidenceStage){committedResultId=result.resultId;if(loseAck)throw Error('synthetic post-COMMIT acknowledgement loss');}return result;
   };
  }});
  const r=await reserved(lostAck),s=service(lostAck),token=await s.requestRechargeRefundFirst(r.token);evidenceStage=true;
  await expect(s.persistRechargeRefundFirstResult(token)).rejects.toThrow();expect(await rows(r.operation.operation_id)).toHaveLength(1);
  loseAck=false;const receipt=await s.persistRechargeRefundFirstResult(token);expect(receipt).toMatchObject({resultId:committedResultId,replayed:true,status:'SUCCESS'});
  expect(await rows(r.operation.operation_id)).toHaveLength(1);
 }),5000);

 it('commits verified SUCCESS despite later mutable-source/hold/permission/approval/registry changes',()=>start(async()=>{
  const r=await reserved(),s=service(),token=await s.requestRechargeRefundFirst(r.token),registry=f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS;
  await f.maintenanceDb.execute(sql`UPDATE public."user" SET now_money=17 WHERE uid=${r.order.uid}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_recharge SET paid=0,refund_price=10 WHERE id=${r.order.id}`);
  await f.maintenanceDb.execute(sql`UPDATE public.user_bill SET status=0 WHERE event_key=${'recharge_refund_hold:'+r.operation.operation_id}`);
  await f.maintenanceDb.execute(sql`UPDATE public.store_order_outbox SET payload=payload||jsonb_build_object('signature',repeat('0',64)) WHERE id=${r.event.id}`);
  await f.rules('');await f.approve(1,'revoked');f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS='{}';
  const before=await snapshot(r.order);
  try{
   const receipt=await s.persistRechargeRefundFirstResult(token);expect(receipt.status).toBe('SUCCESS');
   expect(await rows(r.operation.operation_id)).toHaveLength(1);const after=await snapshot(r.order);expect({...after,results:before.results}).toEqual(before);
  }finally{f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=registry;await f.rules('recharge_order.refund');}
 }),5000);

 it('rechecks the deadline after actual asynchronous RSA and refuses before fetch',()=>start(async()=>{
  const r=await reserved(),count=posts.length,before=await snapshot(r.order),s=service();
  // The method reaches real async RSA before returning its Promise. Advance
  // only the clock while RSA is pending; do not mock the signer or callApi.
  const request=s.requestRechargeRefundFirst(r.token),clock=vi.spyOn(Date,'now').mockReturnValue(r.token.expiresAt*1000);
  try{await expect(request).rejects.toThrow();expect(posts).toHaveLength(count);}
  finally{clock.mockRestore();}
  expect(await rows(r.operation.operation_id)).toHaveLength(0);expect(await snapshot(r.order)).toEqual(before);
 }),5000);

 it('burns an actual Admin claim miswired to the actual Financial root before RSA/fetch',()=>start(async()=>{
  const r=await reserved(),count=posts.length,before=await snapshot(r.order);
  await expect(service(f.profilePeers.financial.db).requestRechargeRefundFirst(r.token)).rejects.toThrow();
  expect(posts).toHaveLength(count);await expect(service().requestRechargeRefundFirst(r.token)).rejects.toThrow();
  expect(posts).toHaveLength(count);expect(await rows(r.operation.operation_id)).toHaveLength(0);expect(await snapshot(r.order)).toEqual(before);
 }),5000);
});
