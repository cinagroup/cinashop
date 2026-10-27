import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {systemConfig} from '@/models/schema';
import {ApiException,ValidateException} from '@/utils/errors';
import {readBoundedUtf8Text} from '@/utils/request-body';
import {LEVEL_ACTIVATION_KEYS,levelActivationHash,parseLevelActivationJson} from '@/services/admin/AdminLevelActivationInput';
import {configFlag} from '@/services/activity/StoreNewcomerService';
export type MemberLevelFieldFormat='text'|'num'|'mail'|'date'|'id'|'phone'|'radio'|'address';
export interface MemberLevelActivationField{info:string;param:string;format:MemberLevelFieldFormat;tip:string;required:0|1;singlearr:string[];value:string}
export interface MemberLevelActivationInput{revision:string;fields:Array<{info:string;value:string}>}
export interface MemberLevelActivationState{owner_uid:number;member_enabled:boolean;activation_required:boolean;level_status:number;activated:boolean;revision:string;fields:MemberLevelActivationField[]}
export interface MemberLevelOwnedCoupon{id:number;issue_id:number;status:number;start_time:string|null;end_time:string|null;is_fail:number;type:number;coupon_title:string;coupon_price:string;use_min_price:string}
export interface MemberLevelPolicyRow{id:number;sort:number;menuName:string;value:string;xmin:string}
export function memberLevelActivationView(query:URLSearchParams):boolean{
 if(!query.has('view'))return false;
 if(query.size!==1||query.getAll('view').length!==1||query.get('view')!=='1')throw new ValidateException('等级激活查询参数未知、重复或无效');return true;
}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new ValidateException('等级激活资料须为对象');return v as Record<string,unknown>;};
function text(v:unknown,max:number,label:string,empty=false):string{if(typeof v!=='string'||(!empty&&!v.trim())||[...v].length>max||/[\u0000-\u001f\u007f]/u.test(v)||[...v].some(c=>{const n=c.codePointAt(0)!;return n>=0xd800&&n<=0xdfff;}))throw new ValidateException(label+'无效');return v;}
function exact(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw new ValidateException('等级激活字段未知或不完整');}
export async function readMemberLevelActivationBody(request:Request):Promise<MemberLevelActivationInput>{
 const v=object(parseLevelActivationJson(await readBoundedUtf8Text(request,16*1024)));exact(v,['revision','fields']);if(typeof v.revision!=='string'||!/^[a-f0-9]{64}$/u.test(v.revision))throw new ValidateException('等级激活版本无效');
 if(!Array.isArray(v.fields)||v.fields.length>64)throw new ValidateException('等级激活资料须为至多64项数组');
 const fields=v.fields.map(value=>{const row=object(value);exact(row,['info','value']);return{info:text(row.info,80,'资料名称'),value:text(row.value,1024,'资料值',true)};});
 if(new Set(fields.map(v=>v.info)).size!==fields.length)throw new ValidateException('等级激活资料名称不能重复');return{revision:v.revision,fields};
}
const formats=new Set(['text','num','mail','date','id','phone','radio','address']);
const mappings:Record<string,MemberLevelFieldFormat>={real_name:'text',sex:'radio',birthday:'date',card_id:'id',address:'address',mark:'text'};
export function memberLevelActivationFields(raw:string|undefined):MemberLevelActivationField[]{
 if(raw===undefined||['','""','0','false','null'].includes(raw.trim()))return[];
 const parsed=parseLevelActivationJson(raw);if(!Array.isArray(parsed)||parsed.length>64)throw new ValidateException('等级激活资料模板须为至多64项数组');
 const fields=parsed.map(value=>{const v=object(value),info=text(v.info,80,'资料名称'),format=text(v.format,16,'资料格式') as MemberLevelFieldFormat,param=v.param===undefined?'':text(v.param,32,'资料映射',true);if(!formats.has(format)||param&&mappings[param]!==format)throw new ValidateException('等级激活资料格式或映射不受支持');
  const choices=param==='sex'?['男','女','保密']:v.singlearr??[];if(!Array.isArray(choices)||choices.length>32)throw new ValidateException('等级激活单选模板无效');const singlearr=choices.map(x=>text(x,80,'单选项'));if(format==='radio'&&(singlearr.length<2||new Set(singlearr).size!==singlearr.length)||format!=='radio'&&singlearr.length)throw new ValidateException('等级激活单选模板无效');
  return{info,param,format,tip:v.tip===undefined?'':text(v.tip,160,'资料提示',true),required:(configFlag(String(v.required??'0'))?1:0) as 0|1,singlearr,value:format==='radio'?'0':''};});
 if(new Set(fields.map(v=>v.info)).size!==fields.length||new Set(fields.filter(v=>v.param).map(v=>v.param)).size!==fields.filter(v=>v.param).length)throw new ValidateException('等级激活资料名称或映射重复');return fields;
}
export async function readMemberLevelActivationPolicy(tx:Pick<DbClient,'select'>,uid:number):Promise<{rows:MemberLevelPolicyRow[];revision:string;fields:MemberLevelActivationField[]}>{
 const rows=await tx.select({id:systemConfig.id,sort:systemConfig.sort,menuName:systemConfig.menuName,value:systemConfig.value,xmin:sql<string>`xmin::text`}).from(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,[...LEVEL_ACTIVATION_KEYS]))).orderBy(asc(systemConfig.sort),asc(systemConfig.id)).limit(1001);
 if(rows.length>1000)throw new ValidateException('等级激活历史配置超出完整读取容量');
 const revision=await levelActivationHash({domain:'member-level-activation-policy-v1',uid,rows}),raw=rows.filter(v=>v.menuName==='level_extend_info').at(-1)?.value;
 return{rows,revision,fields:memberLevelActivationFields(raw)};
}
export function assertMemberLevelActivationFields(input:unknown,fields:MemberLevelActivationField[]):void{
 if(!Array.isArray(input)||input.length!==fields.length||input.some(v=>!v||typeof v!=='object'||!fields.some(f=>f.info===(v as {info?:unknown}).info))||new Set(input.map(v=>(v as {info:string}).info)).size!==fields.length)throw new ValidateException('请完整提交当前等级激活资料');
}
export const memberLevelActivationConflict=()=>new ApiException('等级激活配置已变化，请重新读取并确认',409);
