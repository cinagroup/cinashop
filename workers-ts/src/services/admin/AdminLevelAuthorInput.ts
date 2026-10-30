import {createHash} from 'node:crypto';
import {ValidateException} from '@/utils/errors';
import {levelAction,levelCanonical,levelInteger,type LevelAction} from '../../../../view/common/levelAuthor';
export function levelInput<T>(f:()=>T):T{try{return f();}catch(e){throw new ValidateException(e instanceof Error?e.message:'等级参数无效');}}
export function levelActionHash(a:Omit<LevelAction,'payload_hash'>){return createHash('sha256').update(JSON.stringify(levelCanonical(a))).digest('hex');}
export function levelRequest(v:unknown,actor:number){return levelInput(()=>{const a=levelAction(v,actor);if(levelActionHash(a)!==a.payload_hash)throw Error('原等级操作内容或摘要已变化');return a;});}
export function levelId(v:unknown,zero=false){return levelInput(()=>levelInteger(typeof v==='string'&&/^(?:0|[1-9]\d*)$/.test(v)?Number(v):v,zero?0:1));}
export function levelQuery(q:URLSearchParams,allowed:string[]=[]){const r:Record<string,string>={};for(const[k,v]of q){if(!allowed.includes(k)||Object.hasOwn(r,k))throw new ValidateException('等级查询字段无效或重复');r[k]=v;}return r;}
