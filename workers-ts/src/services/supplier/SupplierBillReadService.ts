/** Supplier-only read projection. The caller derives supplierId from its JWT;
 * neither a query parameter nor an Admin session can replace that identity. */
import {and,asc,desc,eq,gte,ilike,inArray,isNull,lte,or,sql,type SQL} from 'drizzle-orm';
import type {Container} from '@/lib/di';
import {supplierFlowingWater,user} from '@/models/schema';
import {ValidateException} from '@/utils/errors';
import {supplierReadSnapshot} from './SupplierReadSupport';

export type SupplierBillParameters=Record<string,string|undefined>;
type PeriodType='day'|'week'|'month';
type Status=''|'-1'|'0'|'1';
type Base={timeType:PeriodType;status:Status;data:string;start:number|null;end:number|null;selection:'period'|'ids'};
type Page={page:number;limit:number;offset:number};
export type SupplierBillGroupQuery=Base&Page;
export type SupplierBillDetailQuery=Base&Page&{period:string;keyword:string;ids:number[]};
const MAX_INT=2147483647,MAX_IDS=1000,MAX_BYTES=2*1024*1024;
const fail=(message:string):never=>{throw new ValidateException(message);};
function allowed(parameters:SupplierBillParameters,keys:readonly string[]) {
 for(const [key,value] of Object.entries(parameters))if(!keys.includes(key)||typeof value!=='string')fail('供应商账单查询参数未知');
}
function positive(value:string|undefined,label:string,fallback:number,maximum=MAX_INT) {
 if(value===undefined||value==='')return fallback;
 if(!/^[1-9]\d{0,9}$/.test(value))return fail(label+'无效');
 const result=Number(value);if(!Number.isSafeInteger(result)||result>maximum)return fail(label+'超出范围');return result;
}
function second(value:string,periodKey=false) {
 const match=/^(\d{4})[/-](\d{2})[/-](\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(value);
 if(!match)return fail('账单日期格式错误');
 const [year,month,day,hour,minute,sec]=match.slice(1).map(value=>Number(value??0));
 const utc=Date.UTC(year,month-1,day,hour,minute,sec),date=new Date(utc),epoch=utc/1000-28800;
 if(year<1970||year>2038||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day
  ||date.getUTCHours()!==hour||date.getUTCMinutes()!==minute||date.getUTCSeconds()!==sec||!periodKey&&(epoch<0||epoch>MAX_INT))return fail('账单日期无效');
 return {epoch,midnight:hour===0&&minute===0&&sec===0};
}
export function parseSupplierBillDates(value:string|undefined,now=Math.floor(Date.now()/1000)) {
 const data=value??'';if(!data)return {data,start:null,end:null};
 if(data.length>100)return fail('账单日期范围过长');
 const aliases=['today','yesterday','week','last week','month','last month','quarter','year','last year','lately7','lately30'];
 if(aliases.includes(data)) {
  const local=new Date((now+28800)*1000),year=local.getUTCFullYear(),month=local.getUTCMonth(),day=local.getUTCDate();
  let start=Date.UTC(year,month,day)/1000-28800,end=start+86400;
  if(data==='yesterday'){start-=86400;end-=86400;}
  if(data==='week'||data==='last week'){start-=((local.getUTCDay()+6)%7)*86400;end=start+7*86400;if(data==='last week'){start-=7*86400;end-=7*86400;}}
  if(data==='month'||data==='last month'){const offset=data==='last month'?-1:0;start=Date.UTC(year,month+offset,1)/1000-28800;end=Date.UTC(year,month+offset+1,1)/1000-28800;}
  if(data==='quarter'){const quarter=Math.floor(month/3)*3;start=Date.UTC(year,quarter,1)/1000-28800;end=Date.UTC(year,quarter+3,0)/1000-28800+1;}
  if(data==='lately7'||data==='lately30'){start=now-(data==='lately7'?7:30)*86400;end=now+1;}
  if(data==='year'||data==='last year'){const first=year+(data==='last year'?-1:0);start=Date.UTC(first,0,1)/1000-28800;end=Date.UTC(first+1,0,1)/1000-28800;}
  if(start<0||end-1>MAX_INT)return fail('账单日期超出范围');return {data,start,end:end-1};
 }
 const match=/^(\d{4}[/-]\d{2}[/-]\d{2}(?: \d{2}:\d{2}:\d{2})?)\s*-\s*(\d{4}[/-]\d{2}[/-]\d{2}(?: \d{2}:\d{2}:\d{2})?)$/.exec(data);
 if(!match){
  const open=/^(?:(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?))?-(?:(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?))?$/.exec(data);
  if(!open||!open[1]&&!open[2])return fail('账单日期范围格式错误');
  if(open[1]&&!open[2])return {data,start:second(open[1]).epoch,end:null};
  if(!open[1]&&open[2]){const end=second(open[2]).epoch+86400-1;if(end>MAX_INT)return fail('账单日期超出范围');return {data,start:null,end};}
  return fail('账单日期范围格式错误');
 }
 const start=second(match[1]),end=second(match[2]);
 // Preserve PHP ModelTrait's inclusive endpoints and its one-day extension
 // for a midnight ending or equal start/end, including non-midnight instants.
 const extension=end.midnight||end.epoch===start.epoch?86400:0;
 if(end.epoch<start.epoch||end.epoch-start.epoch>366*86400||end.epoch+extension>MAX_INT)return fail('账单日期起止点相差不能超过366天');
 return {data,start:start.epoch,end:end.epoch+extension};
}
function base(parameters:SupplierBillParameters):Base {
 const timeType=parameters.timeType||'day',status=parameters.status??'';
 if(!['day','week','month'].includes(timeType))return fail('账单周期无效');
 if(!['','-1','0','1'].includes(status))return fail('账单状态无效');
 if(parameters.selection!==undefined&&parameters.selection!=='period')return fail('账单选择方式无效');
 return {timeType:timeType as PeriodType,status:status as Status,selection:parameters.selection==='period'?'period':'ids',...parseSupplierBillDates(parameters.data)};
}
function pagination(parameters:SupplierBillParameters,limit:number):Page {
 const page=positive(parameters.page,'页码',1),size=positive(parameters.limit,'每页条数',limit,100),offset=(page-1)*size;
 if(!Number.isSafeInteger(offset)||offset>MAX_INT)return fail('账单分页超出范围');return {page,limit:size,offset};
}
export function parseSupplierBillGroupQuery(parameters:SupplierBillParameters):SupplierBillGroupQuery {
 allowed(parameters,['selection','timeType','status','data','page','limit']);return {...base(parameters),...pagination(parameters,20)};
}
function keyword(value:string|undefined) {
 const result=(value??'').trim();if([...result].length>80||/[\u0000-\u001f\u007f]/u.test(result))return fail('账单搜索词无效');return result;
}
export function parseSupplierBillDetailQuery(parameters:SupplierBillParameters):SupplierBillDetailQuery {
 const common=base(parameters),page=pagination(parameters,10),search=keyword(parameters.keyword);
 if(common.selection==='period') {
  allowed(parameters,['selection','timeType','status','data','period','keyword','page','limit']);const period=parameters.period??'';
  if(common.timeType==='day')second(period,true);
  else if(common.timeType==='month'){if(!/^(?:19[7-9]\d|20[0-3]\d)-(?:0[1-9]|1[0-2])$/.test(period)||Number(period.slice(0,4))>2038)return fail('账单周期键无效');}
  else if(!/^(?:19[7-9]\d|20[0-3]\d)-(?:[0-4]\d|5[0-3])$/.test(period)||Number(period.slice(0,4))>2038)return fail('账单周期键无效');
  if(common.timeType==='day'&&!/^\d{4}-\d{2}-\d{2}$/.test(period))return fail('账单周期键无效');
  return {...common,...page,period,keyword:search,ids:[]};
 }
 allowed(parameters,['ids','keyword','page','limit','staff_id','data']);
 if(parameters.staff_id)fail('账单详情不支持指定员工身份');
 const raw=parameters.ids??'';if(!raw||raw.length>12000)return fail('账单明细ID不能为空或过长');
 const parts=raw.split(',').map(value=>value.trim());if(parts.length>MAX_IDS||parts.some(value=>!/^\d+$/.test(value)))return fail('账单明细每次最多1000个正整数ID');
 const ids=[...new Set(parts.map(value=>positive(value,'账单明细ID',0)))];if(ids.some(value=>value===0))return fail('账单明细ID无效');
 return {...common,...page,period:'',keyword:search,ids};
}
function scope(supplierId:number,query:Base):SQL {
 if(!Number.isSafeInteger(supplierId)||supplierId<1||supplierId>MAX_INT)return fail('供应商账单身份无效');
 const conditions=[eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.isDel,0)];
 if(query.status!=='')conditions.push(eq(supplierFlowingWater.status,Number(query.status)));
 if(query.start!==null)conditions.push(gte(supplierFlowingWater.addTime,query.start));
 if(query.end!==null)conditions.push(lte(supplierFlowingWater.addTime,query.end));
 return and(...conditions)!;
}
function periodSql(query:Base) {
 const clock=query.status==='1'?supplierFlowingWater.finishTime:supplierFlowingWater.addTime;
 const day=sql`(to_timestamp(${clock}) AT TIME ZONE 'Asia/Shanghai')::date`;
 if(query.timeType==='day')return sql<string>`to_char(${day},'YYYY-MM-DD')`;
 if(query.timeType==='month')return sql<string>`to_char(${day},'YYYY-MM')`;
 const week=sql`CASE WHEN EXTRACT(ISOYEAR FROM ${day}) < EXTRACT(YEAR FROM ${day}) THEN 0
  WHEN EXTRACT(ISOYEAR FROM ${day}) > EXTRACT(YEAR FROM ${day}) THEN 53 ELSE EXTRACT(WEEK FROM ${day}) END`;
 return sql<string>`to_char(${day},'YYYY')||'-'||lpad((${week})::int::text,2,'0')`;
}
function count(value:string|undefined) {const result=Number(value??'0');if(!Number.isSafeInteger(result)||result<0||result>MAX_INT)return fail('账单数量超出可分页范围');return result;}
function checked<T>(value:T):T {if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_BYTES)return fail('账单响应超过2MiB，请缩小范围');return value;}
const context=(supplierId:number,query:Base&Page)=>({version:'supplier-bill-v1' as const,selection:query.selection,supplier_id:supplierId,
 timeType:query.timeType,status:query.status,data:query.data,page:query.page,limit:query.limit,bounded:true as const});
const displayTime=(epoch:number)=>epoch?new Date((epoch+28800)*1000).toISOString().slice(0,19).replace('T',' '):'';
const payTypes:Record<string,string>={weixin:'微信支付',yue:'余额支付',offline:'线下支付',alipay:'支付宝支付',cash:'现金支付',automatic:'自动转账',store:'微信支付'};
function detail(row:typeof supplierFlowingWater.$inferSelect,nickname:string|null) {
 return {id:row.id,supplier_id:row.supplierId,uid:row.uid,order_id:row.orderId,link_id:row.linkId,pm:row.pm,number:row.number,
  type:row.type,pay_type:row.payType,status:row.status,mark:row.mark,remark:row.remark,add_time:displayTime(row.addTime),
  trade_time:displayTime(row.tradeTime||row.addTime),finish_time:displayTime(row.finishTime),user_nickname:nickname||'游客',
  type_name:row.type===1?'支付订单':row.type===2?'退款订单':'其他类型',pay_type_name:payTypes[row.payType]??'其他方式'};
}
export class SupplierBillReadService {
 constructor(private readonly container:Container){}
 async groups(supplierId:number,parameters:SupplierBillParameters) {
  const query=parseSupplierBillGroupQuery(parameters),where=scope(supplierId,query),period=periodSql(query);
  return supplierReadSnapshot(this.container,async tx=>{
   const grouped=tx.select({period}).from(supplierFlowingWater).where(where).groupBy(period).as('supplier_bill_groups');
   const [total]=await tx.select({count:sql<string>`count(*)::text`}).from(grouped);
   const rows=await tx.select({period,detail_count:sql<string>`count(*)::text`,
    income_num:sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=1 THEN ${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`,
    exp_num:sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=0 THEN ${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`,
    entry_num:sql<string>`(coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=1 THEN ${supplierFlowingWater.number} ELSE 0 END),0)-coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=0 THEN ${supplierFlowingWater.number} ELSE 0 END),0))::numeric(20,2)::text`})
    .from(supplierFlowingWater).where(where).groupBy(period).orderBy(desc(period)).limit(query.limit).offset(query.offset);
   const identities=new Map<string,number[]>();
   if(query.selection==='ids'&&rows.length) {
    if(rows.some(row=>count(row.detail_count)>MAX_IDS))fail('本期明细超过1000行，请使用selection=period按账期完整分页读取');
    const selected=await tx.select({id:supplierFlowingWater.id,period}).from(supplierFlowingWater)
     .where(and(where,inArray(period,rows.map(row=>row.period)))).orderBy(asc(supplierFlowingWater.id)).limit(query.limit*MAX_IDS+1);
    if(selected.length>query.limit*MAX_IDS)fail('账单旧ID集合超出范围');
    for(const row of selected){const ids=identities.get(row.period)??[];ids.push(row.id);identities.set(row.period,ids);}
    for(const row of rows)if(identities.get(row.period)?.length!==count(row.detail_count))fail('账单旧ID集合无法完整核对');
   }
   return checked({...context(supplierId,query),list:rows.map((row,index)=>({id:index+1,period:row.period,day:row.period,
    title:query.timeType==='day'?'日账单':query.timeType==='week'?'周账单':'月账单',
    add_time:query.timeType==='week'?`${row.period.slice(0,4)}年第${row.period.slice(5)}周`:row.period,
    income_num:row.income_num,exp_num:row.exp_num,entry_num:row.entry_num,detail_count:count(row.detail_count),
    ...(query.selection==='ids'?{ids:identities.get(row.period)!.join(',')}:{})})),count:count(total?.count)});
  });
 }
 async details(supplierId:number,parameters:SupplierBillParameters) {
  const query=parseSupplierBillDetailQuery(parameters),conditions=[scope(supplierId,query)];
  if(query.selection==='period')conditions.push(eq(periodSql(query),query.period));else conditions.push(inArray(supplierFlowingWater.id,query.ids));
  if(query.keyword){const pattern=`%${query.keyword.replace(/[\\%_]/g,'\\$&')}%`;conditions.push(or(ilike(supplierFlowingWater.orderId,pattern),sql`EXISTS (SELECT 1 FROM "user" bill_user WHERE bill_user.uid=${supplierFlowingWater.uid} AND bill_user.delete_time IS NULL AND (bill_user.nickname ILIKE ${pattern} OR bill_user.uid::text ILIKE ${pattern}))`)!);}
  const where=and(...conditions)!;
  return supplierReadSnapshot(this.container,async tx=>{
   if(query.selection==='ids') {
    const [owned]=await tx.select({count:sql<string>`count(*)::text`}).from(supplierFlowingWater)
     .where(and(eq(supplierFlowingWater.supplierId,supplierId),eq(supplierFlowingWater.isDel,0),inArray(supplierFlowingWater.id,query.ids)));
    if(count(owned?.count)!==query.ids.length)fail('所选账单不存在或不属于当前供应商，未返回部分明细');
   }
   const [total]=await tx.select({count:sql<string>`count(*)::text`}).from(supplierFlowingWater).where(where);
   const rows=await tx.select({flow:supplierFlowingWater,nickname:user.nickname}).from(supplierFlowingWater)
    .leftJoin(user,and(eq(user.uid,supplierFlowingWater.uid),isNull(user.deleteTime))).where(where)
    .orderBy(desc(supplierFlowingWater.id)).limit(query.limit).offset(query.offset);
   return checked({...context(supplierId,query),...(query.selection==='period'?{period:query.period}:{ids:query.ids.join(',')}),keyword:query.keyword,
    list:rows.map(row=>query.selection==='period'?detail(row.flow,row.nickname):{...row.flow,...detail(row.flow,row.nickname)}),count:count(total?.count)});
  });
 }
}
