/** Fetch-only observer: the production HTTP service creates its own claim.
 * A different genuine Admin connection proves the first attempt is committed
 * before validating/signing the local synthetic merchant exchange. */
import { sign,verify } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { DbClient } from '@/lib/di';
import { assertRechargeRoutineRefundAccountRuntimeTx } from '@/migrations/rechargeRoutineRefundAccount';
import { authenticateRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import { parseRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { rechargeQueryProviderNativeFixture } from './rechargeQueryProviderNative';
export type HttpFirstOutcome='SUCCESS'|'CLOSED'|'UNKNOWN'|'bad-signature';
export async function rechargeRefundHttpNativeFixture(values:Map<string,unknown>){
 const f=await rechargeQueryProviderNativeFixture(values);
 try{
  const base=f.network.getMockImplementation();if(!base)throw Error('Missing local provider observer');
  let outcome:HttpFirstOutcome|undefined;
  const committed:Array<{operationId:string;attemptId:string;credentialVersion:number}>=[];
  f.network.mockImplementation(async(input,init)=>{
   const url=new URL(String(input));
   if(url.origin!=='https://api.mch.weixin.qq.com'||init?.method!=='POST')return base(input,init);
   if(!outcome||url.pathname!=='/v3/refund/domestic/refunds'||url.search||typeof init.body!=='string')throw Error('Unplanned first HTTP POST');
   const body=JSON.parse(init.body) as Record<string,unknown>;
   const point=await f.profilePeers.admin.db.transaction(async raw=>{
    const tx=raw as unknown as DbClient,scope=await assertRechargeRoutineRefundAccountRuntimeTx(tx,'admin','read');
    const ops=await tx.execute(sql`SELECT * FROM public.recharge_refund_operation WHERE out_refund_no=${String(body.out_refund_no)} LIMIT 2`);expect(ops).toHaveLength(1);
    const op=authenticateRechargeRefundRecord(f.env,scope,'recharge_refund_operation',ops[0]);
    const attempts=await tx.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE operation_id=${String(op.operation_id)}::uuid ORDER BY ordinal LIMIT 2`);expect(attempts).toHaveLength(1);
    return parseRechargeRefundFirstRequest(f.env,scope,op,attempts[0]);
   },{isolationLevel:'repeatable read',accessMode:'read only'});
   const p=point.payload,a=p.approval;
   const registry=JSON.parse(f.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS!) as {credentials:Array<{version:number;privateKey:string;platformPublicKey:string;serialNo:string;platformPublicKeyId:string}>};
   const material=registry.credentials.find(v=>v.version===a.credentialVersion);if(!material)throw Error('Missing approved synthetic material');
   const headers=new Headers(init.headers),auth=headers.get('Authorization')??'';
   expect(headers.get('Wechatpay-Serial')).toBe(material.platformPublicKeyId);
   expect(auth).toContain('mchid="'+a.merchantId+'"');expect(auth).toContain('serial_no="'+material.serialNo+'"');
   const nonce=auth.match(/nonce_str="([^"]+)"/u)?.[1],timestamp=auth.match(/timestamp="([0-9]+)"/u)?.[1],signature=auth.match(/signature="([^"]+)"/u)?.[1];
   if(!nonce||!timestamp||!signature)throw Error('Missing actual request RSA');
   expect(verify('RSA-SHA256',Buffer.from('POST\n'+url.pathname+'\n'+timestamp+'\n'+nonce+'\n'+init.body+'\n'),material.platformPublicKey,Buffer.from(signature,'base64'))).toBe(true);
   expect(body).toEqual({out_refund_no:p.request.outRefundNo,reason:'充值原路退款',transaction_id:p.request.transactionId,
    notify_url:p.notifyUrl,amount:{refund:p.request.refundAmount,total:p.request.totalAmount,currency:'CNY'}});
   committed.push({operationId:p.operationId,attemptId:String(point.attempt.attempt_id),credentialVersion:a.credentialVersion});
   f.posts.push({body,status:outcome});
   const response=outcome==='UNKNOWN'?{code:'SYSTEM_ERROR',message:'Synthetic first HTTP result'}:{
    mchid:a.merchantId,appid:a.appId,out_trade_no:p.request.outTradeNo,transaction_id:p.request.transactionId,out_refund_no:p.request.outRefundNo,
    refund_id:'qr'+p.operationId.replaceAll('-','').slice(0,28),status:outcome==='bad-signature'?'SUCCESS':outcome,
    success_time:new Date().toISOString(),amount:{refund:p.request.refundAmount,total:p.request.totalAmount,currency:'CNY'}};
   const text=JSON.stringify(response),time=String(Math.floor(Date.now()/1000)),responseNonce='http_first_local_nonce';
   let signed=Buffer.from(sign('RSA-SHA256',Buffer.from(time+'\n'+responseNonce+'\n'+text+'\n'),material.privateKey)).toString('base64');
   if(outcome==='bad-signature')signed=(signed[0]==='A'?'B':'A')+signed.slice(1);
   return new Response(text,{status:outcome==='UNKNOWN'?500:200,headers:{'Content-Type':'application/json','Wechatpay-Timestamp':time,
    'Wechatpay-Nonce':responseNonce,'Wechatpay-Serial':material.platformPublicKeyId,'Wechatpay-Signature':signed}});
  });
  async function observeFirst<T>(expected:HttpFirstOutcome,run:()=>Promise<T>){
   if(outcome)throw Error('Serial first HTTP observer required');outcome=expected;
   try{return await run();}finally{outcome=undefined;}
  }
  return{...f,observeFirst,committed};
 }catch(error){await f.close();throw error;}
}
export type RechargeRefundHttpNativeFixture=Awaited<ReturnType<typeof rechargeRefundHttpNativeFixture>>;
