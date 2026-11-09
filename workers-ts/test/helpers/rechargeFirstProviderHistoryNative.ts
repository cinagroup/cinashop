/** Genuine producer/author fixture plus a strict local merchant fetch adapter.
 * Provider rows are made ONLY by actual RSA sender + independent SQL writer. */
import { randomUUID,sign,verify } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { DbClient } from '@/lib/di';
import { claimAdminRechargeRefundFirstRequest } from '@/services/payment/RechargeRefundFirstRequest';
import { readRechargeRefundFirstProviderResultTx,type RechargeRefundFirstProviderStatus } from '@/services/payment/RechargeRefundFirstProviderResult';
import { WechatPayService } from '@/services/wechat/WechatPayService';
import { rechargeRefundAdminAuthorFixture,rechargeAuthorOriginal,rechargeAuthorUids } from './rechargeRefundAdminAuthorNative';

export async function rechargeFirstProviderHistoryFixture(values:Map<string,unknown>,options:Parameters<typeof rechargeRefundAdminAuthorFixture>[1]={}){
 const f=await rechargeRefundAdminAuthorFixture(values,options);let serial=0,uidIndex=0;
 try{
  f.env.ROUTINE_REFUND_NOTIFY_ORIGIN='https://recharge-refund.example';
  const oauth=f.network.getMockImplementation();if(!oauth)throw Error('Missing strict OAuth fixture');
  let active:{orderNo:string;transactionId:string;outRefundNo:string;status:RechargeRefundFirstProviderStatus}|undefined;
  const firstIssuerTranscripts=new Map<string,{refundId:string;successTime:string}>();
  const posts:Array<{body:Record<string,unknown>;status:string}>=[];
  f.network.mockImplementation(async(input,init)=>{
   const url=new URL(String(input));if(url.origin!=='https://api.mch.weixin.qq.com')return oauth(input,init);
   if(url.pathname!=='/v3/refund/domestic/refunds'||init?.method!=='POST'||!active||typeof init.body!=='string')throw Error('Unplanned provider history I/O');
   const headers=new Headers(init.headers),authorization=headers.get('Authorization')??'',body=JSON.parse(init.body) as Record<string,unknown>;
   expect(body).toEqual({out_refund_no:active.outRefundNo,reason:'充值原路退款',transaction_id:active.transactionId,
    notify_url:expect.stringMatching(/^https:\/\/recharge-refund\.example\/api\/pay\/notify\/recharge-refund\//u),amount:{refund:1000,total:1000,currency:'CNY'}});
   expect(authorization).toContain('mchid="'+rechargeAuthorOriginal.merchantId+'"');expect(authorization).toContain('serial_no="ABCDEF123456"');
   const nonce=authorization.match(/nonce_str="([^"]+)"/u)?.[1],timestamp=authorization.match(/timestamp="([0-9]+)"/u)?.[1],signature=authorization.match(/signature="([^"]+)"/u)?.[1];
   const publicKey=f.env.WECHAT_PLATFORM_PUBLIC_KEY,privateKey=f.env.WECHAT_MCH_PRIVATE_KEY;
   if(!nonce||!timestamp||!signature||typeof publicKey!=='string'||typeof privateKey!=='string')throw Error('Missing local synthetic RSA materials');
   expect(verify('RSA-SHA256',Buffer.from('POST\n/v3/refund/domestic/refunds\n'+timestamp+'\n'+nonce+'\n'+init.body+'\n'),publicKey,Buffer.from(signature,'base64'))).toBe(true);
   expect(headers.get('Wechatpay-Serial')).toBe(rechargeAuthorOriginal.serial);posts.push({body,status:active.status});
   const httpStatus=active.status==='UNKNOWN'?500:200;
   const response=active.status==='UNKNOWN'?{code:'SYSTEM_ERROR',message:'synthetic signed history response'}:{
    mchid:rechargeAuthorOriginal.merchantId,appid:rechargeAuthorOriginal.appId,out_trade_no:active.orderNo,transaction_id:active.transactionId,
    out_refund_no:active.outRefundNo,refund_id:'history_refund_'+(++serial),status:active.status,success_time:new Date().toISOString(),
    amount:{refund:1000,total:1000,currency:'CNY'}};
   if('refund_id' in response)firstIssuerTranscripts.set(active.outRefundNo,{refundId:String(response.refund_id),successTime:String(response.success_time)});
   const raw=JSON.stringify(response),time=String(Math.floor(Date.now()/1000)),responseNonce='history_local_response_nonce';
   const signed=Buffer.from(sign('RSA-SHA256',Buffer.from(time+'\n'+responseNonce+'\n'+raw+'\n'),privateKey)).toString('base64');
   return new Response(raw,{status:httpStatus,headers:{'content-type':'application/json','Wechatpay-Timestamp':time,'Wechatpay-Nonce':responseNonce,
    'Wechatpay-Serial':rechargeAuthorOriginal.serial,'Wechatpay-Signature':signed}});
  });
  async function requested(status:RechargeRefundFirstProviderStatus='SUCCESS',recoverGift=false,reuseBuyerUid?:number){
   // An explicit existing authenticated buyer still performs a NEW real paid
   // recharge/hold/order; it never reuses or fabricates the old payment source.
   const uid=reuseBuyerUid??rechargeAuthorUids[uidIndex++];
   if(!uid||!rechargeAuthorUids.includes(uid)||active)throw Error('Known buyer/serial provider fixture required');
   await f.approve();const paid=await f.paid(uid),q=await f.quote(paid.order),key=randomUUID();
   const operation=(await f.admit(key,f.body(paid.order,q,recoverGift))).operation;
   const claim=await claimAdminRechargeRefundFirstRequest(f.adminContainer,f.env,f.actor(),operation.operation_id);
   active={orderNo:paid.order.orderId,transactionId:paid.transaction,outRefundNo:String(operation.out_refund_no),status};
   try{
    const service=new WechatPayService(f.adminContainer,f.env),verified=await service.requestRechargeRefundFirst(claim);
    return{...paid,key,operation,claim,service,verified};
   }finally{active=undefined;}
  }
  async function persisted(status:RechargeRefundFirstProviderStatus='SUCCESS',recoverGift=false,reuseBuyerUid?:number){
   const {service,verified,...paid}=await requested(status,recoverGift,reuseBuyerUid);
   const receipt=await service.persistRechargeRefundFirstResult(verified);return{...paid,receipt};
  }
  const read=(operationId:unknown,resultId:unknown,role:'app'|'admin'|'financial'='admin',mode:'read'|'write'='read')=>
   f.profilePeers[role].db.transaction(tx=>readRechargeRefundFirstProviderResultTx(tx as unknown as DbClient,f.env,role,operationId,resultId,mode),
    {isolationLevel:mode==='read'?'repeatable read':'read committed',accessMode:mode==='read'?'read only':'read write'});
  async function raw(operationId:unknown,resultId:unknown){
   const records=await f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_result WHERE operation_id=${operationId}::uuid AND result_id=${resultId}::uuid`);
   expect(records).toHaveLength(1);const result=records[0];
   const attempts=await f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_refund_attempt WHERE attempt_id=${result.attempt_id}::uuid`);
   expect(attempts).toHaveLength(1);const attempt=attempts[0],payload=attempt.payload as Record<string,unknown>,approvalRef=payload.approval as Record<string,unknown>;
   const approvals=await f.adminRuntime.db.execute(sql`SELECT * FROM public.recharge_routine_refund_account_policy WHERE record_id=${approvalRef.recordId}::uuid`);
   expect(approvals).toHaveLength(1);return{result,attempt,approval:approvals[0]};
  }
  return{...f,posts,firstIssuerTranscripts,requested,persisted,read,raw};
 }catch(error){await f.close();throw error;}
}
export type RechargeFirstProviderHistoryFixture=Awaited<ReturnType<typeof rechargeFirstProviderHistoryFixture>>;
