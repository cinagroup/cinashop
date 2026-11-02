import { createHash } from 'node:crypto';
import { routineSubscriptionUnavailable } from './RoutineSubscriptionAccount';
import { consumeRoutineSubscriptionSendAuthority, type RoutineSubscriptionSendAuthority } from './RoutineSubscriptionDispatch';

const DEADLINE_MS=8000,MAX_BYTES=32*1024;
export interface AcceptedRoutineSubscriptionResult {
 readonly code:number;readonly httpStatus:number;readonly rawDigest:string;
 readonly requestStartedAt:number;readonly verifiedAt:number;
}
const results=new WeakMap<AcceptedRoutineSubscriptionResult,Readonly<{attemptId:string;attemptSignature:string}>>();
const seconds=()=>{const value=Math.floor(Date.now()/1000);return Number.isSafeInteger(value)&&value>0?value:routineSubscriptionUnavailable();};

/** One consumed private authority permits one POST. Token refresh or another
 * provider call requires a separately admitted immutable attempt. No container,
 * current configuration, SQL, cache or provider-message logging is used here. */
export async function postRoutineSubscription(authority:RoutineSubscriptionSendAuthority,fetcher:typeof fetch=fetch,
 onPostStart:()=>void=()=>{}):Promise<AcceptedRoutineSubscriptionResult>{
 let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const controller=new AbortController();let stopped=false;
 const cancel=()=>{try{void(reader?reader.cancel():response?.body?.cancel())?.catch(()=>undefined);}catch{}};
 try{
  // Consume synchronously, then copy the exact frozen request to bytes before
  // any await. The dispatch module checks one-use and its monotonic lifetime.
  const intent=consumeRoutineSubscriptionSendAuthority(authority),body=JSON.stringify(intent.request);
  const url=new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');url.searchParams.set('access_token',intent.token);
  const requestStartedAt=seconds();
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{
   stopped=true;controller.abort();cancel();try{routineSubscriptionUnavailable();}catch(error){reject(error);}
  },DEADLINE_MS);});
  const receive=async()=>{
   onPostStart();
   response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body,redirect:'error',signal:controller.signal});
   if(stopped){cancel();return routineSubscriptionUnavailable();}
   const declared=response.headers.get('content-length');
   if(response.redirected||!response.body||!Number.isInteger(response.status)||response.status<200||response.status>599
    ||declared!==null&&(!/^\d+$/u.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>MAX_BYTES))return routineSubscriptionUnavailable();
   reader=response.body.getReader();let complete=false,size=0;const chunks:Uint8Array[]=[];
   try{
    while(true){
     const next=await reader.read();if(stopped)return routineSubscriptionUnavailable();
     if(next.done){complete=true;break;}
     size+=next.value.byteLength;if(size>MAX_BYTES)return routineSubscriptionUnavailable();chunks.push(next.value);
    }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return routineSubscriptionUnavailable();
    const code=(parsed as Record<string,unknown>).errcode;
    if(typeof code!=='number'||!Number.isInteger(code)||code < -2147483648||code > 2147483647||code===0&&!response.ok)return routineSubscriptionUnavailable();
    const verifiedAt=seconds();if(verifiedAt<requestStartedAt)return routineSubscriptionUnavailable();
    const result=Object.freeze({code:code===0?0:code,httpStatus:response.status,
     rawDigest:createHash('sha256').update(bytes).digest('hex'),requestStartedAt,verifiedAt});
    results.set(result,Object.freeze({attemptId:intent.attemptId,attemptSignature:intent.attemptSignature}));return result;
   }finally{if(!complete)cancel();try{reader.releaseLock();}catch{}}
  };
  return await Promise.race([receive(),deadline]);
 }catch{stopped=true;controller.abort();cancel();return routineSubscriptionUnavailable();}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
/** An object spread, parsed JSON, different attempt or altered signature cannot
 * supply provider evidence. Durable row authentication belongs to dispatch. */
export function assertRoutineSubscriptionProviderResult(attemptId:string,attemptSignature:string,result:AcceptedRoutineSubscriptionResult){
 const binding=results.get(result);
 if(!binding||binding.attemptId!==attemptId||binding.attemptSignature!==attemptSignature)return routineSubscriptionUnavailable();
 return result;
}
