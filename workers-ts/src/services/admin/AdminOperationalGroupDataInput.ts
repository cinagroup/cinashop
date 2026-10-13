import {createHash} from 'node:crypto';
import {ValidateException,ServiceUnavailableException} from '@/utils/errors';
import {parseLevelActivationJson} from './AdminLevelActivationInput';
import {pcBannerImage,pcBannerLink} from './AdminPcBannerInput';
export const OPERATIONAL_GROUPS = {
  routine_home_bast_banner:'精品推荐图片',combination_banner:'拼团轮播图',routine_home_hot_banner:'热门榜单图片',
  routine_home_new_banner:'首发新品图片',routine_home_benefit_banner:'促销单品图片',integral_shop_banner:'积分商城轮播图',
} as const;
export type OperationalGroupName=keyof typeof OPERATIONAL_GROUPS;
export type OperationalOperation='create'|'update'|'status'|'delete'|'replace';
export interface OperationalActor {id:number;authVersion:string;expiresAt:number}
export interface OperationalValues {img:string;comment:string;link:string;sort:number;status:0|1}
export interface OperationalScope {gid?:number;config_name?:OperationalGroupName}
export interface OperationalIntent extends OperationalScope {expected_revision?:string;request_id?:string}
export interface OperationalField {name:string;title:'img'|'comment'|'link';type:'upload'|'input';param:string}
export function operationalObject(value:unknown,keys?:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new ValidateException('运营图片数据必须为JSON对象');
  const row=value as Record<string,unknown>;if(Object.keys(row).some(key=>['__proto__','constructor','prototype'].includes(key)||keys&&!keys.includes(key)))throw new ValidateException('运营图片包含未知字段');return row;
}
export function operationalInteger(value:unknown,min=1,max=2147483647):number{
  if((typeof value!=='number'&&typeof value!=='string')||!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw new ValidateException('运营图片整数参数无效');return Number(value);
}
export function operationalName(value:unknown):OperationalGroupName{if(typeof value!=='string'||!Object.hasOwn(OPERATIONAL_GROUPS,value))throw new ValidateException('此配置组不属于已支持的运营图片范围');return value as OperationalGroupName;}
export function operationalScope(row:Record<string,unknown>,required=true):OperationalScope{
  const scope={...(row.gid===undefined||row.gid===''||row.gid===0||row.gid==='0'?{}:{gid:operationalInteger(row.gid)}),...(row.config_name===undefined||row.config_name===''?{}:{config_name:operationalName(row.config_name)})};
  if(required&&!scope.gid&&!scope.config_name)throw new ValidateException('请选择运营图片组');return scope;
}
export function operationalIntent(row:Record<string,unknown>,required=true):OperationalIntent{
  if(row.expected_revision!==undefined&&(typeof row.expected_revision!=='string'||!/^[a-f0-9]{64}$/.test(row.expected_revision)))throw new ValidateException('运营图片确认版本无效');
  if(row.request_id!==undefined&&(typeof row.request_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.request_id)))throw new ValidateException('运营图片请求标识须为UUID');
  return {...operationalScope(row,required),...(row.expected_revision===undefined?{}:{expected_revision:row.expected_revision as string}),...(row.request_id===undefined?{}:{request_id:row.request_id as string})};
}
export function operationalValues(row:Record<string,unknown>):OperationalValues{
  const image=Array.isArray(row.img)&&row.img.length===1?row.img[0]:row.img;
  if(typeof row.comment!=='string'||!row.comment.trim()||[...row.comment].length>500||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(row.comment))throw new ValidateException('描述必填且不能超过500个字符');
  return {img:pcBannerImage(image),comment:row.comment,link:pcBannerLink(row.link),sort:operationalInteger(row.sort??0,0),status:operationalInteger(row.status??1,0,1) as 0|1};
}
export function operationalFields(raw:string|null):OperationalField[]{
  try{if(typeof raw!=='string'||new TextEncoder().encode(raw).length>16384)throw Error('字段定义缺失或超限');const source=parseLevelActivationJson(raw);
    if(!Array.isArray(source)||source.length!==3)throw Error('须为img/comment/link三项字段');const keys=new Set<string>();
    return source.map(value=>{const row=operationalObject(value,['name','title','type','param']);if(!['img','comment','link'].includes(String(row.title))||keys.has(String(row.title)))throw Error('字段名称不支持或重复');keys.add(String(row.title));
      if(row.type!==(row.title==='img'?'upload':'input')||row.param!==''||typeof row.name!=='string'||!row.name.trim()||row.name.length>256)throw Error('字段类型、参数或名称不支持');return row as unknown as OperationalField;});
  }catch(error){throw new ServiceUnavailableException(`运营图片组定义不支持，请先维护修复：${error instanceof Error?error.message:'格式错误'}`);}
}
export function operationalHash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function operationalQuery(query:URLSearchParams,paged=false){
  for(const key of new Set(query.keys()))if(!['gid','config_name',...(paged?['page','limit','status']:[])].includes(key)||query.getAll(key).length!==1)throw new ValidateException('运营图片查询字段未知或重复');
  const scope=operationalScope(Object.fromEntries(query));const page=operationalInteger(query.get('page')??1,1,5001),limit=operationalInteger(query.get('limit')??20,1,100),offset=(page-1)*limit;
  if(offset>5000)throw new ValidateException('运营图片分页超过安全容量');const status=query.get('status');if(status!==null&&status!==''&&status!=='0'&&status!=='1')throw new ValidateException('运营图片筛选状态无效');
  return {...scope,page,limit,offset,...(status===null||status===''?{}:{status:Number(status) as 0|1})};
}
export const operationalJson=(text:string)=>parseLevelActivationJson(text);
