import { createHash } from 'node:crypto';
import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { assertPreparedRoutineShippingAccount, captureRoutineShippingEnv, freezeShipping, routineShippingUnavailable, shippingInteger,
 type PreparedRoutineShippingAccount } from '@/services/payment/RoutineShippingAccount';
import { assertRoutineShippingUploadProof, recheckRoutineShippingUpload, type RoutineShippingUploadProof } from '@/services/payment/RoutineShippingDispatch';
import { getRoutineShippingAccessToken, invalidateRoutineShippingAccessToken } from './RoutineShippingAccessToken';
import { WechatProviderRejectedError } from './WechatNotificationProvider';

const INVALID_TOKEN=new Set([40001,40014,42001]),RETRYABLE=new Set([-1,45009,45011]);
const accepted=new WeakSet<RoutineShippingHttpResult>();
export interface RoutineShippingHttpResult {
 readonly dispatchId:string;readonly dispatchSignature:string;readonly code:number;readonly status:number;
 readonly rawDigest:string;readonly issuedAt:number;readonly requestStartedAt:number;readonly verifiedAt:number;
}
const unknown=()=>new Error('WeChat shipping outcome unknown');
type HttpResponse={data:Record<string,unknown>;code:number;status:number;rawDigest:string;requestStartedAt:number;verifiedAt:number;issuedAt?:number};
async function post(fetcher:typeof fetch,path:string,token:string,body:object,maxBytes:number):Promise<HttpResponse>{
 const url=new URL('https://api.weixin.qq.com/'+path);url.searchParams.set('access_token',token);
 const controller=new AbortController();let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
 const cancel=()=>{try{void(reader?reader.cancel():response?.body?.cancel())?.catch(()=>undefined);}catch{}};
 const requestStartedAt=Math.floor(Date.now()/1000);
 const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{stopped=true;controller.abort();cancel();reject(unknown());},8000);});
 const receive=async()=>{
  response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'manual',signal:controller.signal});
  if(stopped){cancel();throw unknown();}
  const declared=response.headers.get('content-length');
  if(response.status>=300&&response.status<400||response.redirected||!response.body||declared!==null&&(!/^\d+$/u.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>maxBytes))throw unknown();
  reader=response.body.getReader();let complete=false,size=0;const chunks:Uint8Array[]=[];
  try{
   while(true){const next=await reader.read();if(stopped)throw unknown();if(next.done){complete=true;break;}size+=next.value.byteLength;if(size>maxBytes)throw unknown();chunks.push(next.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
   const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
   if(!value||typeof value!=='object'||Array.isArray(value))throw unknown();const data=value as Record<string,unknown>,code=data.errcode;
   if(typeof code!=='number'||!Number.isSafeInteger(code)||code===0&&!response.ok)throw unknown();
   return{data,code,status:response.status,rawDigest:createHash('sha256').update(bytes).digest('hex'),requestStartedAt,verifiedAt:Math.floor(Date.now()/1000)};
  }finally{if(!complete)cancel();try{reader.releaseLock();}catch{}}
 };
 try{return await Promise.race([receive(),deadline]);}catch{stopped=true;controller.abort();cancel();throw unknown();}finally{if(timer!==undefined)clearTimeout(timer);}
}
async function withToken(container:Container,env:Env,account:PreparedRoutineShippingAccount,path:string,body:object,maxBytes:number,
 beforePost:()=>Promise<void|number>,fetcher:typeof fetch,onPostStart:()=>void=()=>{}):Promise<HttpResponse>{
 if(!Object.hasOwn(container.db,'$client')||!container.db.$client)return routineShippingUnavailable();
 const signing=captureRoutineShippingEnv(env);
 let token=await getRoutineShippingAccessToken(container,env,account,{fetcher});
 let issuedAt=await beforePost();onPostStart();let result=await post(fetcher,path,token,body,maxBytes);
 if(INVALID_TOKEN.has(result.code)){
  // Only an explicit rejection is safe to refresh. Timeout/invalid JSON never
  // reaches this branch, and both attempts retain the identical pinned body.
  await assertPreparedRoutineShippingAccount(container,signing,account);
  await invalidateRoutineShippingAccessToken(env,account);
  token=await getRoutineShippingAccessToken(container,env,account,{fetcher,forceRefresh:true});
  issuedAt=await beforePost();onPostStart();result=await post(fetcher,path,token,body,maxBytes);
 }
 return{...result,...(typeof issuedAt==='number'?{issuedAt}:{})};
}
/** The official list currently exceeds a thousand entries. Read it completely
 * within a separate finite 512 KiB / 4096-entry bound; never use a prefix or a
 * guessed default carrier. No global or different-App cache is consulted. */
export async function getRoutineShippingCarriers(container:Container,env:Env,account:PreparedRoutineShippingAccount,fetcher:typeof fetch=fetch){
 const signing=captureRoutineShippingEnv(env);
 const response=await withToken(container,env,account,'cgi-bin/express/delivery/open_msg/get_delivery_list',{},512*1024,
  ()=>assertPreparedRoutineShippingAccount(container,signing,account),fetcher);
 if(response.code!==0)throw new WechatProviderRejectedError(response.code,RETRYABLE.has(response.code)||response.status===429||response.status>=500);
 const {delivery_list:list,count}=response.data;
 if(!Array.isArray(list)||!list.length||list.length>4096||!Number.isSafeInteger(count)||count!==list.length)return routineShippingUnavailable();
 const carriers=list.map(raw=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return routineShippingUnavailable();const row=raw as Record<string,unknown>;
  if(typeof row.delivery_id!=='string'||!/^[\x21-\x7e]{1,128}$/u.test(row.delivery_id)||typeof row.delivery_name!=='string'
   ||!row.delivery_name.trim()||new TextEncoder().encode(row.delivery_name).byteLength>512||/[\u0000-\u001f\u007f]/u.test(row.delivery_name))return routineShippingUnavailable();
  return{id:row.delivery_id,name:row.delivery_name};
 });
 if(new Set(carriers.map(r=>r.id)).size!==carriers.length)return routineShippingUnavailable();return freezeShipping(carriers);
}
/** A plain payload/openid cannot authorize an upload. The dispatch service is
 * the only creator of this private proof and rechecks it after every token I/O. */
export async function uploadRoutineShipping(container:Container,env:Env,proof:RoutineShippingUploadProof,fetcher:typeof fetch=fetch,onPostStart:()=>void=()=>{}):Promise<RoutineShippingHttpResult>{
 const intent=assertRoutineShippingUploadProof(proof);
 const response=await withToken(container,env,intent.account,'wxa/sec/order/upload_shipping_info',intent.dispatch.payload.request,64*1024,
  ()=>recheckRoutineShippingUpload(container,env,proof),fetcher,onPostStart);
 // A genuine errcode=0 is final evidence even if maintenance retires the
 // account during HTTP. There is deliberately no post-send fresh-policy check.
 if(!shippingInteger(response.issuedAt))return routineShippingUnavailable();
 const result=freezeShipping({dispatchId:intent.dispatch.dispatch_id,dispatchSignature:intent.dispatch.signature,
  code:response.code,status:response.status,issuedAt:response.issuedAt,rawDigest:response.rawDigest,requestStartedAt:response.requestStartedAt,verifiedAt:response.verifiedAt});
 accepted.add(result);return result;
}
export function assertRoutineShippingHttpResult(value:RoutineShippingHttpResult,dispatchId:string,signature:string){
 if(!accepted.has(value)||value.dispatchId!==dispatchId||value.dispatchSignature!==signature)return routineShippingUnavailable();return value;
}
