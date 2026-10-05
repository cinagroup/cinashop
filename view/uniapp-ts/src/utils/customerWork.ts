import type { CustomerWorkContext, CustomerWorkEnvelope, CustomerWorkOverview, CustomerWorkStatistics,
  CustomerWorkTrend, CustomerWorkDailyRow, CustomerWorkPaged, CustomerWorkOrder, CustomerWorkOrderDetail,
  CustomerWorkRefund, CustomerWorkRefundDetail, CustomerWorkCart, CustomerWorkLogistics, CustomerWorkTrackingPackage,
  CustomerWorkScopes } from '../types/customerWork';
import { customerWorkBusinessId } from '../../../common/customerWorkRoute';
import { isUserCenterPublicImage } from '../../../common/userCenterDesign';
export { CUSTOMER_WORK_PAGES, customerWorkBusinessId, parseCustomerWorkQuery, customerWorkRoute, resolveCustomerWorkPageRoute } from '../../../common/customerWorkRoute';

export const CUSTOMER_WORK_SCOPES: CustomerWorkScopes = { sales: 'global_fulfillment_orders', order_totals: 'global_fulfillment_orders',
  order_state_counts: 'platform_fulfillment_orders', refund_counts: 'global_refunds', inventory: 'global_products', visits: 'global_product_visits' };
export function customerWorkRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max;
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= 2_147_483_647;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const customerWorkMoney = (value: unknown): value is string => typeof value === 'string' && /^\d{1,12}\.\d{2}$/u.test(value);
const ints = (row: Record<string, unknown>, names: string[]) => names.every(name => integer(row[name]));
const strings = (row: Record<string, unknown>, names: string[], max = 4000) => names.every(name => text(row[name],max));
const monies = (row: Record<string, unknown>, names: string[]) => names.every(name => customerWorkMoney(row[name]));
function calendar(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value)||Number(value.slice(0,4))<1970)return false;
  const epoch=Date.parse(`${value}T00:00:00+08:00`);
  return Number.isFinite(epoch)&&new Date(epoch+28800000).toISOString().slice(0,10)===value;
}
export function customerWorkImage(value: unknown): value is string {
  return value === '' || isUserCenterPublicImage(value);
}
export function isCustomerWorkScopes(value: unknown): value is CustomerWorkScopes {
  return customerWorkRecord(value) && Object.entries(CUSTOMER_WORK_SCOPES).every(([key,expected]) => value[key] === expected);
}
export function parseCustomerWorkEnvelope<T>(value: unknown, actorUid: number, guard: (data: unknown) => data is T,
  authority?: CustomerWorkEnvelope<CustomerWorkContext>): CustomerWorkEnvelope<T> {
  if (!customerWorkRecord(value) || value.version !== 'customer-work-read-v1' || value.actor_uid !== actorUid
    || !customerWorkRecord(value.principal) || value.principal.kind !== 'customer-order-manager'
    || !integer(value.principal.service_id,1) || value.principal.scope !== 'global'
    || !hash(value.scope_key) || !hash(value.consistency_key) || !customerWorkRecord(value.data)
    || !isCustomerWorkScopes(value.data.metric_scopes) || !guard(value.data)
    || customerWorkRecord(value.data.profile) && value.data.profile.uid !== actorUid) throw Error('经营响应与当前身份不匹配，请重新读取');
  if (authority && (value.principal.service_id !== authority.principal.service_id || value.scope_key !== authority.scope_key
    || value.consistency_key !== authority.consistency_key)) throw Error('经营权限或数据依据已变化，请重新读取');
  return value as unknown as CustomerWorkEnvelope<T>;
}
export function isCustomerWorkContext(value: unknown): value is CustomerWorkContext {
  if (!customerWorkRecord(value) || !isCustomerWorkScopes(value.metric_scopes) || !customerWorkRecord(value.profile)
    || !integer(value.profile.uid,1) || !strings(value.profile,['nickname','phone'],200) || !customerWorkImage(value.profile.avatar)
    || !customerWorkRecord(value.capabilities)) return false;
  const capabilities=value.capabilities;
  return ['statistics','orders','refunds','logistics'].every(key => capabilities[key] === true)
    && typeof capabilities.product_management === 'boolean'
    && typeof capabilities.user_management === 'boolean'
    && (capabilities.writeoff_read === undefined || typeof capabilities.writeoff_read === 'boolean')
    && ['assisted_order','writes'].every(key => capabilities[key] === false);
}
function summary(value: unknown): boolean { return customerWorkRecord(value) && customerWorkMoney(value.after_price)
  && typeof value.growth_rate === 'number' && Number.isFinite(value.growth_rate) && customerWorkMoney(value.increase_time)
  && [1,2].includes(value.increase_time_status as number) && ints(value,['after_number','after_pay_number','today_visits']); }
export function isCustomerWorkOverview(value: unknown): value is CustomerWorkOverview { return customerWorkRecord(value)
  && summary(value.today) && customerWorkRecord(value.badges) && ints(value.badges,['unshipped_count','refunding_count','refunded_count','refund_count','outofstock','policeforce']); }
export function isCustomerWorkStatistics(value: unknown): value is CustomerWorkStatistics { return customerWorkRecord(value)
  && [1,7,30].includes(value.type as number) && summary(value.summary) && customerWorkRecord(value.counters)
  && ints(value.counters,['order_count','unpaid_count','unshipped_count','received_count','evaluated_count','unwritoff_count','complete_count','refunding_count','refunded_count','refund_count','todayCount','proCount','monthCount'])
  && monies(value.counters,['sum_price','todayPrice','proPrice','monthPrice']); }
export function isCustomerWorkTrend(value: unknown): value is CustomerWorkTrend { return customerWorkRecord(value)
  && [1,7,30].includes(value.type as number) && Array.isArray(value.list) && value.list.length === (value.type===1?2:value.type)
  && value.list.every((row,index,list) => customerWorkRecord(row) && calendar(row.date) && row.time===row.date.slice(5) && integer(row.num) && customerWorkMoney(row.price)
    && (index===0 || Date.parse(row.date)-Date.parse(list[index-1].date)===86400000)); }
export function isCustomerWorkDaily(value: unknown): value is CustomerWorkDailyRow { return customerWorkRecord(value)
  && calendar(value.date) && value.time===value.date.slice(5) && customerWorkMoney(value.price) && ints(value,['count','visit','add_time']); }
export function isCustomerWorkPaged<T>(guard: (row: unknown) => row is T) { return (value: unknown): value is CustomerWorkPaged<T> => customerWorkRecord(value)
  && Array.isArray(value.list) && value.list.length <= 100 && value.list.every(guard) && ints(value,['count'])
  && integer(value.page,1) && value.page <= 1_000_000 && integer(value.limit,1) && value.limit <= 100
  && value.list.length <= value.limit && typeof value.has_more === 'boolean'; }
function cart(value: unknown): value is CustomerWorkCart { return customerWorkRecord(value) && integer(value.id,1)
  && strings(value,['cart_id'],100) && ints(value,['product_id','cart_num','refund_num','surplus_num','is_gift'])
  && monies(value,['truePrice','sum_true_price']) && customerWorkRecord(value.productInfo)
  && text(value.productInfo.store_name,500) && customerWorkImage(value.productInfo.image) && customerWorkMoney(value.productInfo.price)
  && customerWorkRecord(value.productInfo.attrInfo) && text(value.productInfo.attrInfo.suk,500)
  && customerWorkImage(value.productInfo.attrInfo.image) && customerWorkMoney(value.productInfo.attrInfo.price); }
function refundLink(value: unknown): boolean { return customerWorkRecord(value) && integer(value.id,1) && customerWorkBusinessId(value.order_id)
  && ints(value,['refund_type','refund_num']) && customerWorkMoney(value.refund_price); }
export function isCustomerWorkOrder(value: unknown): value is CustomerWorkOrder { return customerWorkRecord(value)
  && integer(value.id,1) && integer(value.pid,-1) && customerWorkBusinessId(value.order_id)
  && ints(value,['uid','store_id','supplier_id','total_num','paid','shipping_type','type','refund_status','refund_type','add_time','pay_time'])
  && integer(value.status,-2) && value.status<=5
  && strings(value,['nickname','real_name','user_phone','user_address','pay_type','type_name','delivery_type','delivery_name','delivery_code','delivery_id','mark','remark','_add_time','_pay_time'])
  && monies(value,['total_price','total_postage','pay_price','pay_postage']) && hash(value.revision) && value.write_available === false
  && customerWorkRecord(value._status) && integer(value._status._type,-5) && strings(value._status,['_title','_msg'])
  && Array.isArray(value.cartInfo) && value.cartInfo.length <= 500 && value.cartInfo.every(cart)
  && Array.isArray(value.refund) && value.refund.length <= 500 && value.refund.every(refundLink); }
function safeJson(value: unknown, depth = 0): boolean { if (depth > 8) return false; if (value === null) return true;
  if (typeof value === 'string') return value.length <= 65536; if (typeof value === 'number') return Number.isFinite(value); if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length <= 200 && value.every(item => safeJson(item,depth+1));
  return customerWorkRecord(value) && Object.keys(value).length <= 200 && Object.entries(value).every(([key,item]) => !['__proto__','prototype','constructor'].includes(key) && key.length <= 500 && safeJson(item,depth+1)); }
const images = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 50 && value.every(customerWorkImage);
export function isCustomerWorkOrderDetail(value: unknown): value is CustomerWorkOrderDetail { return isCustomerWorkOrder(value) && customerWorkRecord(value)
  && isCustomerWorkScopes(value.metric_scopes) && customerWorkRecord(value.customer) && value.customer.uid === value.uid
  && text(value.customer.nickname,500) && customerWorkImage(value.customer.avatar) && customerWorkMoney(value.vip_true_price)
  && safeJson(value.custom_form) && images(value.refund_img) && images(value.refund_goods_img)
  && strings(value,['refund_reason_wap','refund_reason_wap_explain']) && integer(value.refund_reason_time)
  && Array.isArray(value.split) && value.split.length <= 500 && value.split.every(row => customerWorkRecord(row) && integer(row.id,1)
    && integer(row.pid,1) && customerWorkBusinessId(row.order_id) && ints(row,['paid','total_num']) && integer(row.status,-2) && row.status<=5 && customerWorkMoney(row.pay_price)
    && strings(row,['delivery_type','delivery_name','delivery_code','delivery_id'])); }
export function isCustomerWorkRefund(value: unknown): value is CustomerWorkRefund { return customerWorkRecord(value)
  && integer(value.id,1) && customerWorkBusinessId(value.order_id) && integer(value.store_order_id,1) && customerWorkBusinessId(value.store_order_sn)
  && ints(value,['uid','apply_type','refund_type','refund_num']) && monies(value,['refund_price','refunded_price'])
  && strings(value,['refund_reason','refund_explain','refuse_reason','remark','_add_time']) && (integer(value.add_time) || text(value.add_time,100))
  && customerWorkRecord(value._status) && text(value._status.status_name,200) && Array.isArray(value.cartInfo)
  && value.cartInfo.length <= 500 && value.cartInfo.every(cart) && value.write_available === false; }
export function isCustomerWorkRefundDetail(value: unknown): value is CustomerWorkRefundDetail { return isCustomerWorkRefund(value)
  && customerWorkRecord(value) && isCustomerWorkScopes(value.metric_scopes) && strings(value,['real_name','user_phone','user_address','refund_express','refund_express_name','refund_phone'])
  && images(value.refund_img) && images(value.refund_goods_img); }
function tracking(value: unknown): value is CustomerWorkTrackingPackage { return customerWorkRecord(value) && customerWorkBusinessId(value.orderId)
  && strings(value,['deliveryStatus','expressName','expressCode','expressNo','message']) && integer(value.lastUpdatedAt)
  && ['pending','in_transit','delivered','exception','not_configured','temporarily_unavailable'].includes(String(value.trackingState))
  && ['merchant','carrier','cache'].includes(String(value.trackingSource)) && Array.isArray(value.traces) && value.traces.length <= 1000
  && value.traces.every(row => customerWorkRecord(row) && strings(row,['time','content','status'],2000)); }
export function isCustomerWorkLogistics(value: unknown): value is CustomerWorkLogistics { return tracking(value) && customerWorkRecord(value)
  && isCustomerWorkScopes(value.metric_scopes) && Array.isArray(value.packages) && value.packages.length <= 500 && value.packages.every(tracking)
  && customerWorkRecord(value.order) && customerWorkBusinessId(value.order.order_id) && strings(value.order,['delivery_id','delivery_name','delivery_code','delivery_type']); }

export function customerWorkDateRange(index: number, now = Date.now()): string {
  if (index === 0) return ''; if (!Number.isInteger(index) || index < 1 || index > 4) throw Error('日期筛选无效');
  const end = new Date(now+8*3600000), start = new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate()));
  if (index===1) start.setUTCDate(start.getUTCDate()-2); else { start.setUTCDate(1); if(index>=3)start.setUTCMonth(start.getUTCMonth()-(index===3?2:5)); }
  const format=(date:Date)=>`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
  return `${format(start)},${format(end)}`;
}
export function customerWorkDate(epoch: number): string { if (!integer(epoch) || !epoch) return '';
  const value=new Date((epoch+8*3600)*1000); return value.toISOString().slice(0,19).replace('T',' '); }
export function customerWorkFormRows(value: unknown): { name:string;value:string }[] {
  if (!safeJson(value) || value === null) return [];
  const rows=Array.isArray(value)?value.map((item,index)=>[String(index+1),item] as const):customerWorkRecord(value)?Object.entries(value):[];
  return rows.map(([name,item])=>({name,value:typeof item==='string'?item:JSON.stringify(item)}));
}
