import { checkedDiySeckillLimit, checkedDiySeckillRows, checkedDiySeckillSchedule, type DiySeckillRow, type DiySeckillSlot } from '../../../common/diySeckillData';
export type SeckillProductPreview=DiySeckillRow;
export { checkedDiySeckillSchedule as checkedDiySeckillPublicIndex };
function publicImage(value:unknown):string{if(typeof value!=='string')return '';const url=value.trim();if(!url||url.length>4096||/[\u0000-\u001f\u007f]/u.test(url))return '';if(/^https:\/\//iu.test(url))return url;if(/^http:\/\//iu.test(url))return `https://${url.slice(7)}`;if(/^\/(?!\/)/u.test(url))return url;if(/^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(url)&&url.length<=262144)return url;return '';}
export const checkedDiySeckillPublicRows=(raw:unknown,limit:number)=>checkedDiySeckillRows(raw,limit,publicImage);
function abortIfNeeded(signal?:AbortSignal){if(!signal?.aborted)return;if(signal.reason!==undefined)throw signal.reason;const error=new Error('秒杀预览读取已取消');error.name='AbortError';throw error;}
async function publicData(path:string,signal?:AbortSignal):Promise<unknown>{
 abortIfNeeded(signal);const response=await fetch(path,{method:'GET',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal});abortIfNeeded(signal);const raw:unknown=await response.json();abortIfNeeded(signal);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('秒杀预览响应格式错误');const body=raw as Record<string,unknown>;
 if(!Number.isSafeInteger(body.status)||typeof body.msg!=='string'||!Object.hasOwn(body,'data'))throw Error('秒杀预览响应格式错误');
 if(!response.ok||response.status<200||response.status>=300||body.status!==200)throw Error(body.msg||`秒杀预览读取失败（${response.status}）`);return body.data;
}
/** Explicit anonymous index -> server-selected slot -> list. No Admin bearer,
 * SDK, alternate-slot picker, detail or purchase calls. Editor zero count is a noop. */
export async function apiDiySeckillPreview(limit:number,signal?:AbortSignal):Promise<{products:SeckillProductPreview[];slot:DiySeckillSlot|null}>{
 checkedDiySeckillLimit(limit);abortIfNeeded(signal);const schedule=checkedDiySeckillSchedule(await publicData('/api/seckill/index',signal));abortIfNeeded(signal);
 const slot=schedule.index<0?null:schedule.slots[schedule.index]??null;if(!slot)return{products:[],slot:null};
 const products=checkedDiySeckillPublicRows(await publicData(`/api/seckill/list/${slot.id}?page=1&limit=${limit}&type=index`,signal),limit);abortIfNeeded(signal);return{products,slot};
}
