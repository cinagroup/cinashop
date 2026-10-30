import request, { getData } from '@/utils/request';
import { orderNumber } from '@/utils/orderRead';
export interface BargainRecord {
  id:number; bargain_id:number; uid:number; title:string; image_preview:string; nickname:string; avatar_preview:string;
  bargain_price:string; bargain_price_min:string; price:string; now_price:string; people_num:number; already_num:number; num:number;
  status:number; status_raw:number; expired_pending:boolean; add_time:number; stop_time:string|null;
  deleted_user:boolean; missing_user:boolean; activity_deleted:boolean; activity_missing:boolean; issues:string[];
}
export interface BargainHelper { id:number; uid:number; price:string; type:number; add_time:number; nickname:string; avatar_preview:string; deleted_user:boolean; missing_user:boolean; issues:string[] }
export interface BargainHead { id:number; title:string; activity_deleted:boolean; people_count:number; spread_count:number; start_count:number; success_count:number; ordered_count:number; pay_price:string; pay_count:number; pay_rate:string }
export interface BargainOrder { id:number; order_id:string; uid:number; real_name:string; user_phone:string; nickname:string; pay_price:string; total_num:number; add_time:number; pay_time:number; status:string; status_raw:number; shipping_type:number; refund_status:number; refund_type:number; parent_id:number; deleted:boolean; detail_available:boolean; issues:string[] }
export interface BargainPage<T> { list:T[]; count:number; page:number; limit:number }
export interface BargainHelpersPage extends BargainPage<BargainHelper> { record_id:number; bargain_id:number }
export interface BargainRecordQuery { page:number; limit:number; keyword:string; status?:''|1|2|3|4; start_day?:string; end_day?:string; bargain_id?:number }
export interface BargainOrderQuery { page:number; limit:number; keyword:string; status:''|0|1|2|3|4|5 }
const int = (v:unknown):v is number => typeof v==='number' && Number.isSafeInteger(v) && v>=-2147483648 && v<=2147483647;
const positive = (v:unknown):v is number => int(v) && v>0;
const count = (v:unknown):v is number => typeof v==='number' && Number.isSafeInteger(v) && v>=0;
const money = (v:unknown):v is string => typeof v==='string' && /^-?\d+(?:\.\d{1,2})?$/u.test(v);
function object(value:unknown) { if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('砍价记录响应格式错误'); return value as Record<string,unknown>; }
function fields(value:unknown,text:string[],numbers:string[],flags:string[]) {
  const row=object(value); if(text.some(k=>typeof row[k]!=='string') || numbers.some(k=>!int(row[k])) || flags.some(k=>typeof row[k]!=='boolean') || !Array.isArray(row.issues) || row.issues.some(v=>typeof v!=='string')) throw Error('砍价历史记录响应不完整'); return row;
}
function record(value:unknown):BargainRecord {
  const row=fields(value,['title','image_preview','nickname','avatar_preview'],['id','bargain_id','uid','people_num','already_num','num','status','status_raw','add_time'],['expired_pending','deleted_user','missing_user','activity_deleted','activity_missing']);
  if(!positive(row.id) || !['bargain_price','bargain_price_min','price','now_price'].every(k=>money(row[k])) || !(row.stop_time===null || typeof row.stop_time==='string' && Number.isFinite(Date.parse(row.stop_time)))) throw Error('砍价金额、时间或记录身份无效'); return value as BargainRecord;
}
function helper(value:unknown):BargainHelper { const row=fields(value,['nickname','avatar_preview'],['id','uid','type','add_time'],['deleted_user','missing_user']); if(!positive(row.id) || !money(row.price)) throw Error('帮砍记录身份或金额无效'); return value as BargainHelper; }
function order(value:unknown):BargainOrder { const row=fields(value,['order_id','real_name','user_phone','nickname','status'],['id','uid','total_num','add_time','pay_time','status_raw','shipping_type','refund_status','refund_type','parent_id'],['deleted','detail_available']); if(!positive(row.id) || !money(row.pay_price)) throw Error('砍价订单身份或金额无效'); return value as BargainOrder; }
function page<T extends {id:number}>(value:unknown,q:{page:number;limit:number},parse:(value:unknown)=>T):BargainPage<T> {
  const raw=object(value); if(!Array.isArray(raw.list) || !count(raw.count) || raw.page!==q.page || raw.limit!==q.limit || raw.list.length>q.limit || raw.list.length>raw.count) throw Error('砍价分页响应不完整');
  const list=raw.list.map(parse); if(new Set(list.map(v=>v.id)).size!==list.length) throw Error('砍价分页身份重复'); return {...raw,list} as BargainPage<T>;
}
export function bargainReadId(value:unknown) { if(typeof value!=='string' && typeof value!=='number') return 0; return /^[1-9]\d*$/u.test(String(value)) && positive(Number(value)) ? Number(value) : 0; }
export function bargainReadDays(start:string,end:string) {
  for(const value of [start,end]) if(value) { if(!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw Error('日期须为有效上海日历日期'); const date=new Date(value+'T00:00:00Z'); if(Number(value.slice(0,4))<1970 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10)!==value) throw Error('日期须为有效上海日历日期'); }
  if(start && end && start>end) throw Error('开始日期不能晚于结束日期'); return {...(start?{start_day:start}:{}),...(end?{end_day:end}:{})};
}
function query(q:{page:number;limit:number;keyword?:string}) { if(!positive(q.page)||!positive(q.limit)||q.limit>100||(q.page-1)*q.limit>10000 || q.keyword!==undefined && (typeof q.keyword!=='string'||[...q.keyword].length>100||/[\u0000-\u001f\u007f]/u.test(q.keyword))) throw Error('砍价查询超限或无效'); }
function recordQuery(q:BargainRecordQuery) { query(q); if(q.status!==undefined && !['',1,2,3,4].includes(q.status) || q.bargain_id!==undefined && !positive(q.bargain_id)) throw Error('砍价筛选身份或状态无效'); bargainReadDays(q.start_day??'',q.end_day??''); }
export function bargainRecordStatus(row:Pick<BargainRecord,'status'|'expired_pending'>) { return ({1:'进行中',2:row.expired_pending?'已到期（历史状态未改）':'已失败',3:'可购买',4:'已创建订单'} as Record<number,string>)[row.status] ?? '未知状态 #'+row.status; }
export function bargainPreview(value:string) { if(value.startsWith('/')&&!value.startsWith('//')&&!/[\\\u0000-\u0020]/u.test(value)) return value; try { const url=new URL(value); return url.protocol==='https:'&&!url.username&&!url.password ? value : ''; } catch { return ''; } }
export function bargainOrderAvailable(row:Pick<BargainOrder,'order_id'|'detail_available'|'deleted'>) { if(!row.detail_available || row.deleted || row.order_id==='0') return false; try { orderNumber(row.order_id); return true; } catch { return false; } }
export function bargainReadError(reason:unknown,fallback:string) { const error=reason as {response?:{data?:{msg?:unknown}};message?:unknown}; const msg=error?.response?.data?.msg; return typeof msg==='string' && msg.trim() && msg.length<=512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(msg) ? msg : typeof error?.message==='string' && error.message ? error.message : fallback; }
export async function apiBargainRecords(q:BargainRecordQuery,signal?:AbortSignal) { recordQuery(q); return page(await getData(request.get('/activity/bargain-records',{params:q,signal})),q,record); }
export async function apiBargainHelpers(recordId:number,q:{page:number;limit:number},signal?:AbortSignal) { if(!positive(recordId)) throw Error('砍价参与记录ID无效'); query(q); const result=page(await getData(request.get(`/activity/bargain-records/${recordId}/helpers`,{params:q,signal})),q,helper) as BargainHelpersPage; if(result.record_id!==recordId || !int(result.bargain_id)) throw Error('帮砍详情参与身份不一致'); return result; }
export async function apiBargainStatisticsHead(id:number,signal?:AbortSignal):Promise<BargainHead> { if(!positive(id)) throw Error('砍价活动ID无效'); const row=object(await getData(request.get(`/activity/bargain-statistics/${id}/head`,{signal}))); if(row.id!==id || typeof row.title!=='string' || typeof row.activity_deleted!=='boolean' || !['people_count','spread_count','start_count','success_count','ordered_count','pay_count'].every(k=>count(row[k])) || !money(row.pay_price) || !money(row.pay_rate)) throw Error('砍价活动汇总响应无效'); return row as unknown as BargainHead; }
export async function apiBargainStatisticsRecords(id:number,q:Omit<BargainRecordQuery,'bargain_id'>,signal?:AbortSignal) { if(!positive(id)) throw Error('砍价活动ID无效'); recordQuery(q); const result=page(await getData(request.get(`/activity/bargain-statistics/${id}/records`,{params:q,signal})),q,record); if(result.list.some(row=>row.bargain_id!==id)) throw Error('砍价参与记录活动范围不一致'); return result; }
export async function apiBargainStatisticsOrders(id:number,q:BargainOrderQuery,signal?:AbortSignal) { if(!positive(id)) throw Error('砍价活动ID无效'); query(q); if(!['',0,1,2,3,4,5].includes(q.status)) throw Error('订单状态无效'); return page(await getData(request.get(`/activity/bargain-statistics/${id}/orders`,{params:q,signal})),q,order); }
export async function apiBargainStatisticsHelpers(id:number,recordId:number,q:{page:number;limit:number},signal?:AbortSignal) { if(!positive(id)||!positive(recordId)) throw Error('砍价活动或参与记录ID无效'); query(q); const result=page(await getData(request.get(`/activity/bargain-statistics/${id}/records/${recordId}/helpers`,{params:q,signal})),q,helper) as BargainHelpersPage; if(result.record_id!==recordId || result.bargain_id!==id) throw Error('帮砍详情活动范围不一致'); return result; }
