import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {staffAction,staffCanonical,staffInteger,type StaffAction} from '../../../../view/common/staffAuthor';
export function staffInput<T>(f:()=>T):T{try{return f();}catch(e){throw new ValidateException(e instanceof Error?e.message:'核销员参数无效');}}
export function staffActionHash(a:Omit<StaffAction,'payload_hash'>){return createHash('sha256').update(JSON.stringify(staffCanonical(a))).digest('hex');}
export function staffRequest(v:unknown,actor:number){return staffInput(()=>{const a=staffAction(v,actor);if(staffActionHash(a)!==a.payload_hash)throw Error('原核销员内容或摘要已变化');return a;});}
export function staffId(v:unknown,zero=false){return staffInput(()=>staffInteger(typeof v==='string'&&/^(?:0|[1-9]\d*)$/.test(v)?Number(v):v,zero?0:1));}
export function staffQuery(q:URLSearchParams,allowed:string[]=[]){const r:Record<string,string>={};for(const[k,v]of q){if(!allowed.includes(k)||Object.hasOwn(r,k))throw new ValidateException('核销员查询字段无效或重复');r[k]=v;}return r;}
