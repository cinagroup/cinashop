import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { getRedis } from '@/utils/cache';
import { ServiceUnavailableException } from '@/utils/errors';
import { assertPreparedRoutineSubscriptionAccount, captureRoutineSubscriptionEnv, routineSubscriptionAccountMaterials,
 subscriptionObject, type PreparedRoutineSubscriptionAccount } from '@/services/wechat/RoutineSubscriptionAccount';

const MAX_BYTES=32*1024,DEADLINE_MS=8000,MAX_LIFETIME_MS=7200*1000;
const token=(v:unknown):v is string=>typeof v==='string'&&/^[\x21-\x7e]{1,4096}$/u.test(v);
const unavailable=()=>new ServiceUnavailableException('小程序原账号订阅通知 access_token 暂不可用');
function unexpired(at:number){if(!Number.isSafeInteger(at)||at<=Date.now())throw unavailable();}
function cached(raw:unknown){
 const r=subscriptionObject(raw,['version','token','expiresAt']);
 if(r.version!==1||!token(r.token)||typeof r.expiresAt!=='number'||!Number.isSafeInteger(r.expiresAt)
  ||r.expiresAt>Date.now()+MAX_LIFETIME_MS)throw unavailable();
 unexpired(r.expiresAt);return{token:r.token,expiresAt:r.expiresAt};
}
function key(account:PreparedRoutineSubscriptionAccount){
 // Material commitment includes the opaque ref/version and every AppSecret byte.
 // It is never the global, current-config or AppID-only token namespace.
 routineSubscriptionAccountMaterials(account);return `routine:subscription:v1:access_token:${account.account.payload.data.credentialStamp}`;
}
async function responseJson(fetcher:typeof fetch,url:URL):Promise<Record<string,unknown>>{
 const controller=new AbortController();let stopped=false,response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const cancel=()=>{try{void(reader?reader.cancel():response?.body?.cancel())?.catch(()=>undefined);}catch{}};
 const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{stopped=true;controller.abort();cancel();reject(unavailable());},DEADLINE_MS);});
 const receive=async()=>{
  response=await fetcher(url,{method:'GET',redirect:'error',signal:controller.signal});
  if(stopped){cancel();throw unavailable();}
  const declared=response.headers.get('content-length');
  if(!response.ok||response.redirected||!response.body||declared!==null&&(!/^\d+$/u.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>MAX_BYTES))throw unavailable();
  reader=response.body.getReader();let complete=false,size=0;const chunks:Uint8Array[]=[];
  try{
   while(true){const next=await reader.read();if(stopped)throw unavailable();if(next.done){complete=true;break;}size+=next.value.byteLength;if(size>MAX_BYTES)throw unavailable();chunks.push(next.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw unavailable();return parsed as Record<string,unknown>;
  }finally{if(!complete)cancel();try{reader.releaseLock();}catch{}}
 };
 try{return await Promise.race([receive(),deadline]);}catch{stopped=true;controller.abort();cancel();throw unavailable();}finally{if(timer!==undefined)clearTimeout(timer);}
}
/** Fresh subscription approval, not current SQL credentials, authorizes this exact
 * historical AppSecret. Every cache hit/miss and provider result is rechecked
 * outside I/O. An expired or retired prepared approval cannot lend a token. */
export async function getRoutineSubscriptionAccessToken(container:Container,env:Env,account:PreparedRoutineSubscriptionAccount,
 options:{fetcher?:typeof fetch;forceRefresh?:boolean}={}):Promise<string>{
 if(!Object.hasOwn(container.db,'$client')||!container.db.$client)throw unavailable();
 const signing=captureRoutineSubscriptionEnv(env),cacheEnv={UPSTASH_REDIS_URL:env.UPSTASH_REDIS_URL,UPSTASH_REDIS_TOKEN:env.UPSTASH_REDIS_TOKEN},
  fetcher=options.fetcher??fetch,forceRefresh=options.forceRefresh===true,materials=routineSubscriptionAccountMaterials(account),cacheKey=key(account);
 let redis:ReturnType<typeof getRedis>;try{redis=getRedis(cacheEnv);}catch{throw unavailable();}
 await assertPreparedRoutineSubscriptionAccount(container,signing,account);
 if(redis&&!forceRefresh){
  let value:unknown;try{value=await redis.get<unknown>(cacheKey);}catch{throw unavailable();}
  await assertPreparedRoutineSubscriptionAccount(container,signing,account);
  if(value!==null)return cached(value).token;
 }
 const url=new URL('https://api.weixin.qq.com/cgi-bin/token');
 url.search=new URLSearchParams({grant_type:'client_credential',appid:materials.appId,secret:materials.secret}).toString();
 const requestedAt=Date.now(),data=await responseJson(fetcher,url);
 await assertPreparedRoutineSubscriptionAccount(container,signing,account);
 if(data.errcode!==undefined&&data.errcode!==0||!token(data.access_token)||typeof data.expires_in!=='number'
  ||!Number.isSafeInteger(data.expires_in)||data.expires_in<=0||data.expires_in>7200)throw unavailable();
 const expiresAt=requestedAt+data.expires_in*1000,cacheExpiresAt=requestedAt+Math.min(data.expires_in,Math.max(60,data.expires_in-200))*1000;
 unexpired(expiresAt);if(!Number.isSafeInteger(cacheExpiresAt)||cacheExpiresAt<=0)throw unavailable();
 if(redis){try{if(await redis.set(cacheKey,{version:1,token:data.access_token,expiresAt},{pxat:cacheExpiresAt})!=='OK')throw unavailable();}catch{throw unavailable();}}
 await assertPreparedRoutineSubscriptionAccount(container,signing,account);unexpired(expiresAt);return data.access_token;
}
/** Invalid-token rejection can retire only the pinned material namespace. */
export async function invalidateRoutineSubscriptionAccessToken(env:Env,account:PreparedRoutineSubscriptionAccount){
 const cacheKey=key(account),cacheEnv={UPSTASH_REDIS_URL:env.UPSTASH_REDIS_URL,UPSTASH_REDIS_TOKEN:env.UPSTASH_REDIS_TOKEN};
 try{const redis=getRedis(cacheEnv);if(redis){const count=await redis.del(cacheKey);if(!Number.isSafeInteger(count)||count<0)throw unavailable();}}catch{throw unavailable();}
}
