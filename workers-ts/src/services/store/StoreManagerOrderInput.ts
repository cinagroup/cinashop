import { ValidateException } from '@/utils/errors';
import { parseAdminOrderNumber } from '@/services/admin/AdminMobileOrderReadService';
import { businessMidnight,parseAdminStatisticRange,parseMobileOrderDataQuery,parseMobileOrderPeriod,startOfBusinessDay,type MobileOrderDataQuery,type MobileOrderPeriod } from '@/services/admin/AdminStatisticService';
import { managerId } from './StoreManagerScope';
export interface ManagerListQuery {storeId:number;selector:number|null;isDel:0|1;type:number|null;payType:string|null;keyword:string;fieldKey:string;page:number;limit:number;start:number|null;endExclusive:number|null}
export function managerQueryKeys(query:Record<string,string>,keys:readonly string[]){for(const key of Object.keys(query))if(!keys.includes(key))throw new ValidateException(`不支持的管理查询参数：${key}`);}
function int(value:string|undefined,fallback:number,min:number,max:number,label:string){if(value===undefined||value==='')return fallback;if(!/^-?\d{1,10}$/.test(value))throw new ValidateException(`${label}无效`);const result=Number(value);if(!Number.isSafeInteger(result)||result<min||result>max)throw new ValidateException(`${label}无效`);return result;}
export function managerOrderNumber(value:unknown){if(typeof value!=='string')throw new ValidateException('订单号须为业务编号字符串');return parseAdminOrderNumber(value);}
function range(value:string,now:number):{start:number;endExclusive:number}{
  const today=startOfBusinessDay(now),date=new Date((now+28800)*1000);
  if(value==='today')return{start:today,endExclusive:today+86400};
  if(value==='yesterday')return{start:today-86400,endExclusive:today};
  if(value==='week')return{start:today-((date.getUTCDay()+6)%7)*86400,endExclusive:today+86400};
  if(value==='month')return{start:businessMidnight(date.getUTCFullYear(),date.getUTCMonth(),1),endExclusive:today+86400};
  if(value==='year')return{start:businessMidnight(date.getUTCFullYear(),0,1),endExclusive:today+86400};
  if(!/^\d{4}[/-]\d{1,2}[/-]\d{1,2}\s*(?:-|~|至|,|\s)\s*\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(value))throw new ValidateException('订单起止日期格式无效');
  const parsed=parseAdminStatisticRange(value,now);return{start:parsed.start,endExclusive:parsed.endExclusive};
}
export function parseManagerListQuery(query:Record<string,string>,now=Math.floor(Date.now()/1000)):ManagerListQuery{
  managerQueryKeys(query,['store_id','status','is_del','type','pay_type','field_key','keyword','data','page','limit']);
  const selector=query.status===undefined||query.status===''?null:int(query.status,0,-4,9,'订单状态');
  const isDel=int(query.is_del,0,0,1,'删除筛选') as 0|1;
  if(selector===-4&&isDel!==1)throw new ValidateException('查看已删除订单须明确选择 is_del=1');
  if(selector!==null&&selector!==-4&&isDel===1)throw new ValidateException('已删除筛选与业务状态不兼容');
  const type=query.type===undefined||query.type===''?null:int(query.type,0,0,107,'商品类型');if(type!==null&&![0,1,2,3,4,5,6,7,8,105,106,107].includes(type))throw new ValidateException('商品类型无效');
  const payment=query.pay_type===undefined||query.pay_type===''?null:int(query.pay_type,0,1,5,'支付类型');
  const keyword=(query.keyword??'').trim();if(keyword.length>128||/[\u0000-\u001f\u007f]/.test(keyword))throw new ValidateException('订单搜索内容无效');
  const fieldKey=query.field_key??'';if(!['','all','uid','order_id','real_name','user_phone','title','total_num'].includes(fieldKey))throw new ValidateException('订单搜索字段无效');
  const dates=query.data?range(query.data.trim(),now):null;
  return{storeId:managerId(query.store_id),selector,isDel,type,payType:payment===null?null:['','weixin','yue','offline','alipay','integral'][payment],keyword,fieldKey:fieldKey==='all'?'':fieldKey,page:int(query.page,1,1,10000,'页码'),limit:int(query.limit,10,1,100,'每页数量'),start:dates?.start??null,endExclusive:dates?.endExclusive??null};
}
export function parseManagerDailyQuery(query:Record<string,string>,now=Math.floor(Date.now()/1000)):MobileOrderDataQuery&{storeId:number}{managerQueryKeys(query,['store_id','start','stop','page','limit']);return{...parseMobileOrderDataQuery(query,now),storeId:managerId(query.store_id)};}
export function parseManagerPeriodQuery(query:Record<string,string>,now=Math.floor(Date.now()/1000)):MobileOrderPeriod&{storeId:number}{managerQueryKeys(query,['store_id','type']);return{...parseMobileOrderPeriod(query.type,now),storeId:managerId(query.store_id)};}
export function parseManagerStoreQuery(query:Record<string,string>):number{managerQueryKeys(query,['store_id']);return managerId(query.store_id);}
