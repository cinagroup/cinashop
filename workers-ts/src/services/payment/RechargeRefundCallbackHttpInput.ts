/** Exact HTTP bytes and a single five-second ACK budget. No parsed body,
 * caller credential/account selector, financial state or provider authority. */
import { ServiceUnavailableException } from '@/utils/errors';
const fail=():never=>{throw new ServiceUnavailableException('充值退款通知尚未完成持久核对');};
export interface RechargeRefundCallbackBudget { remainingMs():number; check():void }
export function createRechargeRefundCallbackBudget():Readonly<RechargeRefundCallbackBudget>{
 const end=performance.now()+5000;
 const remainingMs=()=>{const left=Math.floor(end-performance.now());if(left<=0)return fail();return left;};
 return Object.freeze({remainingMs,check:()=>{remainingMs();}});
}
export function rechargeRefundCallbackHttpHeaders(input:Headers):Readonly<Record<string,string>>{
 const limits={'wechatpay-timestamp':10,'wechatpay-nonce':128,'wechatpay-serial':128,'wechatpay-signature':1024}as const;
 const result:Record<string,string>={};
 for(const [name,limit]of Object.entries(limits)){
  const value=input.get(name);if(!value||value.length>limit)return fail();result[name]=value;
 }
 return Object.freeze(result);
}
/** Preserve BOM and whitespace, enforce the UTF8 byte limit before JSON/SQL.
 * Only body reads race a timer/abort; database writes are always awaited. */
export async function readRechargeRefundCallbackHttpBody(request:Request,budget:RechargeRefundCallbackBudget):Promise<string>{
 budget.check();if(request.signal.aborted)return fail();
 const header=request.headers.get('content-length');let declared:number|undefined;
 if(header!==null){if(!/^\d{1,6}$/u.test(header))return fail();declared=Number(header);if(declared>16384)return fail();}
 if(!request.body)return fail();
 const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0;
 try{
  while(true){
   let timer:ReturnType<typeof setTimeout>|undefined,abort:()=>void=()=>{};
   const stop=new Promise<never>((_resolve,reject)=>{
    const refuse=()=>{void reader.cancel().catch(()=>undefined);reject(new ServiceUnavailableException('充值退款通知尚未完成持久核对'));};
    abort=refuse;request.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(refuse,budget.remainingMs());
   });
   let chunk:ReadableStreamReadResult<Uint8Array>;
   try{chunk=await Promise.race([reader.read(),stop]);}
   finally{if(timer!==undefined)clearTimeout(timer);request.signal.removeEventListener('abort',abort);}
   budget.check();if(chunk.done)break;
   size+=chunk.value.byteLength;if(size>16384)return fail();parts.push(chunk.value);
  }
  if(!size||declared!==undefined&&declared!==size)return fail();
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  const body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);budget.check();return body;
 }catch{void reader.cancel().catch(()=>undefined);return fail();}
 finally{reader.releaseLock();}
}
