/** Additional REAL local RSA/AES callback ingress against the genuine author
 * fixture's synthetic keys. Never seeds original/use/MAC/paid/wallet rows. */
import { Buffer } from 'node:buffer';
import { createCipheriv,randomBytes,sign } from 'node:crypto';
import { Hono } from 'hono';
import type { AppVariables,Env } from '@/env';
import { errorHandler } from '@/middleware/error';
import { v1Routes } from '@/routes/v1';
import type { RechargeRefundOperationSource } from '@/services/payment/RechargeRefundOperationSource';
import { rechargeAuthorOriginal,type RechargeRefundAdminAuthorFixture } from './rechargeRefundAdminAuthorNative';

export async function appendRechargeOperationSourceCallback(f:Pick<RechargeRefundAdminAuthorFixture,'env'|'appContainer'>,
 source:RechargeRefundOperationSource,providerEventId:string){
 const A=rechargeAuthorOriginal,facts=source.facts;
 if(facts.appId!==A.appId||facts.merchantId!==A.merchantId||!f.env.WECHAT_MCH_PRIVATE_KEY)throw Error('Genuine disposable author fixture required');
 const plain={appid:facts.appId,mchid:facts.merchantId,out_trade_no:facts.orderNo,transaction_id:facts.transactionId,
  trade_state:facts.tradeState,trade_type:facts.tradeType,payer:{openid:facts.payerId},
  success_time:new Date(facts.providerEventTime*1000).toISOString(),amount:{total:facts.amountCents,currency:facts.currency}};
 const nonce=Buffer.from(randomBytes(6)).toString('hex'),associated='transaction';
 const cipher=createCipheriv('aes-256-gcm',Buffer.from(A.apiV3Key),Buffer.from(nonce));cipher.setAAD(Buffer.from(associated));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final(),cipher.getAuthTag()]).toString('base64');
 const body=JSON.stringify({id:providerEventId,event_type:'TRANSACTION.SUCCESS',resource_type:'encrypt-resource',resource:{
  algorithm:'AEAD_AES_256_GCM',original_type:'transaction',ciphertext,nonce,associated_data:associated}});
 const timestamp=String(Math.floor(Date.now()/1000)),headers={'content-type':'application/json',
  'wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':A.serial,
  'wechatpay-signature':Buffer.from(sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),f.env.WECHAT_MCH_PRIVATE_KEY)).toString('base64')};
 const app=new Hono<{Bindings:Env;Variables:AppVariables}>();
 app.use('*',async(c,next)=>{c.set('container',f.appContainer);await next();});app.onError(errorHandler);app.route('/api',v1Routes);
 const pending:Promise<unknown>[]=[];
 const response=await app.request('/api/pay/notify/routine-account/'+A.paymentAccount,{method:'POST',headers,body},f.env,
  {waitUntil:work=>pending.push(work),props:{},passThroughOnException:()=>{throw Error('Unexpected callback fallback');}});
 await Promise.all(pending);
 if(response.status!==200)throw Error('Actual local signed callback ingress rejected');
 await response.arrayBuffer();
}
