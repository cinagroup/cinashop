import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {deliveryAction,deliveryCanonical,deliveryInteger,type DeliveryAction} from '../../../../view/common/deliveryAuthor';
export function deliveryInput<T>(f:()=>T):T{try{return f();}catch(e){throw new ValidateException(e instanceof Error?e.message:'配送员参数无效');}}
export function deliveryActionHash(a:Omit<DeliveryAction,'payload_hash'>){return createHash('sha256').update(JSON.stringify(deliveryCanonical(a))).digest('hex');}
export function deliveryRequest(v:unknown,actor:number){return deliveryInput(()=>{const a=deliveryAction(v,actor);if(deliveryActionHash(a)!==a.payload_hash)throw Error('原配送员内容或摘要已变化');return a;});}
export function deliveryAuthorId(v:unknown,zero=false){return deliveryInput(()=>deliveryInteger(typeof v==='string'&&/^(?:0|[1-9]\d*)$/.test(v)?Number(v):v,zero?0:1));}
export function deliveryQuery(q:URLSearchParams,allowed:string[]=[]){const r:Record<string,string>={};for(const[k,v]of q){if(!allowed.includes(k)||Object.hasOwn(r,k))throw new ValidateException('配送员查询字段无效或重复');r[k]=v;}return r;}
