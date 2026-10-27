import {createUserCenterRequests} from '@/api/userCenter';
import {memberLevelImage} from '@/api/memberLevels';
import {memberRightImage,memberRightMediaDeadline} from '../../../common/memberRightMedia';
export const PROMOTER_ORDER_PAGE_SIZE=10,MAX_PROMOTER_ORDER_PAGE=1000;
export type {DistributionReportPeriod as OrderPeriod} from '@/utils/distributionReportFilters';
export {shanghaiDay,distributionDaySeconds as orderDaySeconds,distributionRange as orderRange,distributionKeyword as orderKeyword} from '@/utils/distributionReportFilters';
import {shanghaiDay} from '@/utils/distributionReportFilters';
export interface PromoterOrderQuery {page:number;limit:10;start:number;stop:number;keyword:string}
export interface PromoterOrder {id:number;order_id:string;uid:number;nickname:string;avatar_source:string;avatar:string;paid_at:number;add_time:number;time_key:string;type:'brokerage'|'number';time:string;is_frozen:0|1;store_name:string;number:string}
export interface PromoterOrderMonth {month:string;count:number;pay_price:string}
export interface PromoterOrdersPage {owner_uid:number;query:PromoterOrderQuery;count:number;sum_brokerage:string;list:PromoterOrder[];months:PromoterOrderMonth[]}
const invalid=():never=>{throw Error('分销订单数据不完整，请刷新后重试');};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
const integer=(v:unknown,min=0):number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=2147483647?v:invalid();
const text=(v:unknown,max=255):string=>typeof v==='string'&&[...v].length<=max?v:invalid();
function keys(v:Record<string,unknown>,expected:string){if(Object.keys(v).sort().join(',')!==expected)invalid();}
const money=(v:unknown):string=>typeof v==='string'&&/^-?(?:0|[1-9]\d{0,30})\.\d{2}$/.test(v)?v:invalid();
export function orderBefore(a:PromoterOrder,b:PromoterOrder):boolean{return a.paid_at>b.paid_at||a.paid_at===b.paid_at&&a.id>b.id;}
export function orderAvatar(row:PromoterOrder,now=Date.now()):string{return memberLevelImage(memberRightImage(row.avatar_source,row.avatar,now));}
export function orderMediaDeadline(rows:PromoterOrder[]):number|null{return memberRightMediaDeadline(rows.map(row=>row.avatar),[]);}
export function decodePromoterOrders(value:unknown,owner:number,query:PromoterOrderQuery):PromoterOrdersPage {
 const v=object(value);keys(v,'count,list,months,owner_uid,query,sum_brokerage');const q=object(v.query);keys(q,'keyword,limit,page,start,stop');
 if(v.owner_uid!==owner||Object.keys(query).some(key=>q[key]!==query[key as keyof PromoterOrderQuery])||!Array.isArray(v.list)||!Array.isArray(v.months))return invalid();
 const count=integer(v.count),sum_brokerage=money(v.sum_brokerage);
 if(v.list.length!==Math.min(10,Math.max(0,count-(query.page-1)*10)))return invalid();
 const list=v.list.map(value=>{const r=object(value);keys(r,'add_time,avatar,avatar_source,id,is_frozen,nickname,number,order_id,paid_at,store_name,time,time_key,type,uid');
  const id=integer(r.id,1),uid=integer(r.uid),paid_at=integer(r.paid_at),add_time=integer(r.add_time),time_key=text(r.time_key,7),time=text(r.time,16),type=r.type,is_frozen=r.is_frozen;
  if(time_key!==(add_time?shanghaiDay(add_time*1000).slice(0,7):'')||time!==''&&!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(time)||!['brokerage','number'].includes(String(type))||![0,1].includes(Number(is_frozen))||typeof is_frozen!=='number')return invalid();
  const source=text(r.avatar_source,4096),preview=text(r.avatar,8192),safe=memberRightImage(source,preview)&&memberLevelImage(preview);
  return{id,uid,paid_at,add_time,time_key,time,type:type as PromoterOrder['type'],is_frozen:is_frozen as 0|1,order_id:text(r.order_id),nickname:text(r.nickname),store_name:text(r.store_name,1048576),number:money(r.number),avatar_source:safe?source:'',avatar:safe?preview:''};
 });
 if(new Set(list.map(row=>row.id)).size!==list.length||list.some((row,index)=>index>0&&!orderBefore(list[index-1]!,row)))return invalid();
 const monthKeys=[...new Set(list.map(row=>row.time_key))];
 if(v.months.length!==monthKeys.length)return invalid();
 const months=v.months.map((value,index)=>{const m=object(value);keys(m,'count,month,pay_price');if(m.month!==monthKeys[index])return invalid();const n=integer(m.count,1);if(n<list.filter(row=>row.time_key===m.month).length||n>count)return invalid();return{month:String(m.month),count:n,pay_price:money(m.pay_price)};});
 return{owner_uid:owner,query:{...query},count,sum_brokerage,list,months};
}
export function createPromoterOrdersRequests(current:()=>boolean,query:PromoterOrderQuery){const scope=createUserCenterRequests(current);return{...scope,page:async()=>decodePromoterOrders(await scope.request('spread/order?view=promoter_orders','POST',{...query},true),scope.owner.uid,query)};}
export type PromoterOrdersRequests=ReturnType<typeof createPromoterOrdersRequests>;
