import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {storeAction,storeCanonical,storeInteger,type StoreAction} from '../../../../view/common/storeAuthor';
export function storeInput<T>(f:()=>T):T{try{return f();}catch(e){throw new ValidateException(e instanceof Error?e.message:'提货点参数无效');}}
export function storeActionHash(a:Omit<StoreAction,'payload_hash'>){return createHash('sha256').update(JSON.stringify(storeCanonical(a))).digest('hex');}
export function storeRequest(v:unknown,actor:number){return storeInput(()=>{const a=storeAction(v,actor);if(storeActionHash(a)!==a.payload_hash)throw Error('原提货点操作内容或摘要已变化');return a;});}
export function storeId(v:unknown,zero=false){return storeInput(()=>storeInteger(typeof v==='string'&&/^(?:0|[1-9]\d*)$/.test(v)?Number(v):v,zero?0:1));}
export function storeQuery(q:URLSearchParams,allowed:string[]=[]){const r:Record<string,string>={};for(const[k,v]of q){if(!allowed.includes(k)||Object.hasOwn(r,k))throw new ValidateException('提货点查询字段无效或重复');r[k]=v;}return r;}
