/** Strict fetch-only local merchant. Every claim/role/row/RSA verifier and
 * provider result COMMIT is the actual production path, not a seeded record. */
import { generateKeyPairSync,sign,verify } from 'node:crypto';
import { expect } from 'vitest';
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { createContainerFromDb } from '@/lib/di';
import type { RechargeRefundRuntimeRole } from '@/migrations/rechargeRefund';
import type { PreparedRechargeRefundQuery } from '@/services/payment/RechargeRefundQueryClaim';
import { readRechargeRefundQueryAttemptTx } from '@/services/payment/RechargeRefundQueryHistory';
import type { RechargeRefundQueryAttempt } from '@/services/payment/RechargeRefundQueryCodec';
import { WechatPayService,type VerifiedRechargeRefundQueryResult } from '@/services/wechat/WechatPayService';
import { rechargeAuthorOriginal as original } from './rechargeRefundAdminAuthorNative';
import { rechargeFirstProviderHistoryFixture,type RechargeFirstProviderHistoryFixture } from './rechargeFirstProviderHistoryNative';
export type NativeQueryOutcome='NOT_FOUND'|'MERCHANT_NOT_FOUND'|'CLOSED'|'PROCESSING'|'SUCCESS'|'ABNORMAL'|'UNKNOWN'
 |'bad-signature'|'unsigned-404'|'bad-json'|'wrong-amount'|'wrong-account'|'wrong-success-time';
export interface NativeQueryExchange {
 readonly service:WechatPayService;readonly verified:VerifiedRechargeRefundQueryResult;readonly point:RechargeRefundQueryAttempt;
}
interface Extra {
 readonly queryIssuerRefundIds:Map<string,string>;
 readonly gets:Array<{operationId:string;attemptId:string;ordinal:number;outcome:NativeQueryOutcome}>;
 point(role:RechargeRefundRuntimeRole,token:PreparedRechargeRefundQuery):Promise<RechargeRefundQueryAttempt>;
 query(role:RechargeRefundRuntimeRole,token:PreparedRechargeRefundQuery,outcome:NativeQueryOutcome,root?:DbClient):Promise<NativeQueryExchange>;
 service(root:DbClient):WechatPayService;
 observeRecoveryQuery<T>(role:RechargeRefundRuntimeRole,operationId:string,outcome:NativeQueryOutcome,run:()=>Promise<T>):Promise<T>;
}
export type RechargeQueryProviderNativeFixture=RechargeFirstProviderHistoryFixture&Extra;
export async function rechargeQueryProviderNativeFixture(values:Map<string,unknown>,options:Parameters<typeof rechargeFirstProviderHistoryFixture>[1]={}):Promise<RechargeQueryProviderNativeFixture>{
 const f=await rechargeFirstProviderHistoryFixture(values,options);
 try{
  const rotated=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const rotatedSerial='ABCDEF234567',rotatedId=original.serial+'_V2';
  expect(rotated.publicKey).not.toBe(f.env.WECHAT_PLATFORM_PUBLIC_KEY);
  const registry=JSON.parse(f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS!) as {format:number;credentials:Array<Record<string,unknown>>};
  expect(registry.credentials.some(row=>row.version===2)).toBe(true);
  f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS=JSON.stringify({...registry,credentials:registry.credentials.map(row=>row.version===2
   ?{...row,serialNo:rotatedSerial,privateKey:rotated.privateKey,platformPublicKey:rotated.publicKey,platformPublicKeyId:rotatedId}:row)});
  const base=f.network.getMockImplementation();if(!base)throw Error('Missing genuine first-provider fixture');
  let active:{point:RechargeRefundQueryAttempt;outcome:NativeQueryOutcome}|undefined;
  let automatic:{role:RechargeRefundRuntimeRole;operationId:string;outcome:NativeQueryOutcome}|undefined;
  const gets:Extra['gets']=[],queryIssuerRefundIds=new Map<string,string>();
  f.network.mockImplementation(async(input,init)=>{
   const url=new URL(String(input));
   if(url.origin!=='https://api.mch.weixin.qq.com'||init?.method!=='GET')return base(input,init);
   let exchange=active;
   if(!exchange&&automatic){
    const expected=automatic;
    const observed=await f.profilePeers[expected.role].db.transaction(async tx=>{
     const rows=await tx.execute(sql`SELECT attempt_id FROM public.recharge_refund_attempt WHERE operation_id=${expected.operationId}::uuid AND kind='query' ORDER BY ordinal DESC LIMIT 1`);
     expect(rows).toHaveLength(1);
     return readRechargeRefundQueryAttemptTx(tx as unknown as DbClient,f.env,expected.role,expected.operationId,rows[0].attempt_id);
    },{isolationLevel:'repeatable read',accessMode:'read only'});
    exchange={point:observed,outcome:expected.outcome};
   }
   if(!exchange||url.pathname!==exchange.point.payload.request.path||url.search||url.hash)throw Error('Unplanned local refund GET');
   const {point:p,outcome}=exchange,headers=new Headers(init.headers),a=p.payload.approval,q=p.payload.original;
   expect(init.body).toBeUndefined();expect(headers.get('Content-Type')).toBeNull();expect(headers.get('Accept')).toBe('application/json');
   const rotatedRequest=a.credentialVersion===2;expect([1,2]).toContain(a.credentialVersion);
   expect(headers.get('Wechatpay-Serial')).toBe(rotatedRequest?rotatedId:original.serial);expect(a.appId).toBe(original.appId);expect(a.merchantId).toBe(original.merchantId);
   const authorization=headers.get('Authorization')??'';
   expect(authorization).toContain('mchid="'+original.merchantId+'"');expect(authorization).toContain('serial_no="'+(rotatedRequest?rotatedSerial:'ABCDEF123456')+'"');
   const nonce=authorization.match(/nonce_str="([^"]+)"/u)?.[1],timestamp=authorization.match(/timestamp="([0-9]+)"/u)?.[1],signature=authorization.match(/signature="([^"]+)"/u)?.[1];
   const publicKey=rotatedRequest?rotated.publicKey:f.env.WECHAT_PLATFORM_PUBLIC_KEY,privateKey=rotatedRequest?rotated.privateKey:f.env.WECHAT_MCH_PRIVATE_KEY;
   if(!nonce||!timestamp||!signature||typeof publicKey!=='string'||typeof privateKey!=='string')throw Error('Missing local synthetic RSA material');
   expect(verify('RSA-SHA256',Buffer.from('GET\n'+url.pathname+'\n'+timestamp+'\n'+nonce+'\n\n'),publicKey,Buffer.from(signature,'base64'))).toBe(true);
   gets.push({operationId:p.payload.operationId,attemptId:String(p.attempt.attempt_id),ordinal:p.payload.ordinal,outcome});
   const negative=['NOT_FOUND','MERCHANT_NOT_FOUND','unsigned-404','UNKNOWN'].includes(outcome);
   const status=negative?(outcome==='UNKNOWN'?500:404):200;
   const providerStatus=['PROCESSING','SUCCESS','CLOSED','ABNORMAL'].includes(outcome)?outcome:outcome==='wrong-success-time'?'SUCCESS':'PROCESSING';
   const body=negative?{code:outcome==='UNKNOWN'?'SYSTEM_ERROR':outcome==='MERCHANT_NOT_FOUND'?'MCH_NOT_EXISTS':'RESOURCE_NOT_EXISTS',message:'Synthetic local refund query'}:{
    mchid:outcome==='wrong-account'?'9999999999':original.merchantId,appid:original.appId,
    out_trade_no:q.outTradeNo,transaction_id:q.transactionId,out_refund_no:q.outRefundNo,
    refund_id:queryIssuerRefundIds.get(p.payload.operationId)??'qr'+p.payload.operationId.replaceAll('-','').slice(0,28),
    status:providerStatus,
    channel:'ORIGINAL',funds_account:'AVAILABLE',user_received_account:'synthetic wallet',
    create_time:new Date(p.payload.firstIssuedAt*1000).toISOString(),
    ...(providerStatus==='SUCCESS'?{success_time:new Date((p.payload.firstIssuedAt-(outcome==='wrong-success-time'?301:299))*1000).toISOString()}:{}),
    amount:{total:q.totalAmount,refund:outcome==='wrong-amount'?q.refundAmount-1:q.refundAmount,currency:'CNY',
     payer_total:q.totalAmount,payer_refund:q.refundAmount,settlement_total:q.totalAmount,settlement_refund:q.refundAmount,discount_refund:0}};
   const raw=outcome==='bad-json'?'signed-but-not-json':JSON.stringify(body),time=String(Math.floor(Date.now()/1000)),responseNonce='strict_query_local_nonce';
   let signed=Buffer.from(sign('RSA-SHA256',Buffer.from(time+'\n'+responseNonce+'\n'+raw+'\n'),privateKey)).toString('base64');
   if(outcome==='bad-signature')signed=(signed[0]==='A'?'B':'A')+signed.slice(1);
   return new Response(raw,{status,headers:outcome==='unsigned-404'?{'Content-Type':'application/json'}:{'Content-Type':'application/json',
    'Wechatpay-Timestamp':time,'Wechatpay-Nonce':responseNonce,'Wechatpay-Serial':rotatedRequest?rotatedId:original.serial,'Wechatpay-Signature':signed}});
  });
  const point:Extra['point']=(role,token)=>f.profilePeers[role].db.transaction(tx=>readRechargeRefundQueryAttemptTx(tx as unknown as DbClient,f.env,role,token.operationId,token.attemptId),
   {isolationLevel:'repeatable read',accessMode:'read only'});
  const service:Extra['service']=root=>new WechatPayService(createContainerFromDb(root),f.env);
  const query:Extra['query']=async(role,token,outcome,root=f.profilePeers[role].db)=>{
   if(active)throw Error('Serial local GET exchange required');const p=await point(role,token),client=service(root);active={point:p,outcome};
   try{return{service:client,verified:await client.queryRechargeRefund(token),point:p};}finally{active=undefined;}
  };
  // Only strict local fetch expectations are configured. The actual service
  // creates its claim/token; the observer reads the committed physical row on
  // another real connection and never creates a prepared/verifier capability.
  const observeRecoveryQuery:Extra['observeRecoveryQuery']=async(role,operationId,outcome,run)=>{
   if(active||automatic)throw Error('Serial local service query required');automatic={role,operationId,outcome};
   try{return await run();}finally{automatic=undefined;}
  };
  return{...f,gets,queryIssuerRefundIds,point,query,service,observeRecoveryQuery};
 }catch(error){await f.close();throw error;}
}
