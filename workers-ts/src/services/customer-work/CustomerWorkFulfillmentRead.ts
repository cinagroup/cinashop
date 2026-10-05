import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { createContainerFromDb,type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storePink, orderWaybillJob, expressCompany, deliveryService, user, systemConfig } from '@/models/schema';
import { presaleDispatchBoundary } from '@/services/activity/PresaleFulfillmentSnapshot';
import { merchantOrderRevision } from '@/services/store/StoreManagerScope';
import { themeHash } from '@/services/content/ThemeReadService';
import { managerMoney } from '@/services/store/StoreManagerOrderStatisticsService';
import { customerWorkOperationReadiness } from '@/migrations/runCustomerWorkOperation';
import { CustomerCityDeliveryService } from './CustomerCityDeliveryService';
import { readCityDeliverySettingsInTx } from '@/services/delivery/CityDeliverySettingsResolver';
import { customerWorkId } from './CustomerWorkScope';
import { assertCustomerFulfillmentReady } from './customerFulfillmentAuthority';
import { NotFoundException, ValidateException } from '@/utils/errors';

export type CustomerFulfillmentOrder = typeof storeOrder.$inferSelect;
export interface CustomerFulfillmentIdentity { requestedOrderId:number; rootOrderId:number; orderId:number; customerUid:number; storeId:number; supplierId:number }
export interface CustomerWorkAction { available:boolean; reason:string }
export const customerWorkAvailable = ():CustomerWorkAction=>({available:true,reason:''});
export const customerWorkUnavailable = (reason:string):CustomerWorkAction=>({available:false,reason});
const configKeys=['config_export_open','config_export_id','config_export_temp_id','config_export_to_name','config_export_to_tel','config_export_to_address','config_export_siid'] as const;
function scalar(value:string|null|undefined){if(value==null)return'';try{const parsed:unknown=JSON.parse(value);if(typeof parsed==='string'||typeof parsed==='number')return String(parsed);if(typeof parsed==='boolean')return parsed?'1':'0';}catch{}return value;}
export async function customerWorkDefaults(db:DbClient){
  const rows=await db.select({id:systemConfig.id,key:systemConfig.menuName,value:systemConfig.value}).from(systemConfig).where(and(eq(systemConfig.isStore,0),inArray(systemConfig.menuName,[...configKeys]))).orderBy(asc(systemConfig.id)).limit(configKeys.length+1),values=new Map<string,string>();
  for(const row of rows){if(values.has(row.key))throw new ValidateException('平台发货配置重复，请先核对');const value=scalar(row.value);if(value.length>1000||/[\u0000-\u001f\u007f]/.test(value))throw new ValidateException('平台发货配置格式无效');values.set(row.key,value);}
  const open=values.get('config_export_open')??'0';if(!['0','1'].includes(open))throw new ValidateException('电子面单开关格式无效');
  return{config_export_open:Number(open) as 0|1,config_export_id:values.get('config_export_id')??'',express_temp_id:values.get('config_export_temp_id')??'',to_name:values.get('config_export_to_name')??'',to_tel:values.get('config_export_to_tel')??'',to_add:values.get('config_export_to_address')??'',has_cloud_printer:Boolean(values.get('config_export_siid')?.trim())};
}
export async function customerWorkCarriers(db:DbClient){const list=await db.select({id:expressCompany.id,name:expressCompany.name,code:expressCompany.code}).from(expressCompany).where(and(eq(expressCompany.isShow,1),eq(expressCompany.status,1))).orderBy(asc(expressCompany.sort),asc(expressCompany.id)).limit(501);if(list.length>500||list.some(r=>!r.name.trim()||!r.code.trim())||new Set(list.map(r=>r.code)).size!==list.length)throw new ValidateException('有效快递公司目录超限、重复或缺少名称编码');return list;}
export async function customerWorkCouriers(db:DbClient){
  const list=await db.select({uid:deliveryService.uid,nickname:deliveryService.nickname,phone:deliveryService.phone}).from(deliveryService).innerJoin(user,eq(user.uid,deliveryService.uid)).where(and(eq(deliveryService.type,0),eq(deliveryService.relationId,0),eq(deliveryService.status,1),eq(deliveryService.isDel,0),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).orderBy(asc(deliveryService.id)).limit(501);
  if(list.length>500||new Set(list.map(row=>row.uid)).size!==list.length||list.some(row=>!row.nickname.trim()||!/^[+0-9-]{5,20}$/.test(row.phone)))throw new ValidateException('平台配送员目录超限、重复或信息无效');return list;
}
/** Business numbers are exact strings; numeric identifiers are never combined
 * with a number lookup. Header conversion requires one actual pending target. */
export async function resolveCustomerRemarkOrder(db:DbClient,reference:unknown,kind:'number'|'id'){
  let predicate:SQL;
  if(kind==='id')predicate=eq(storeOrder.id,customerWorkId(reference,'订单'));
  else{if(typeof reference!=='string'||!/^[A-Za-z0-9_-]{1,32}$/.test(reference))throw new ValidateException('业务订单编号无效');predicate=eq(storeOrder.orderId,reference);}
  const requested=await db.select().from(storeOrder).where(and(predicate,eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0))).limit(2);if(requested.length!==1)throw new NotFoundException('订单不存在或业务编号不唯一');
  const source=requested[0],rootId=source.pid>0?source.pid:source.id,roots=rootId===source.id?[source]:await db.select().from(storeOrder).where(and(eq(storeOrder.id,rootId),eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0))).limit(1),root=roots[0];
  if(!root||root.uid!==source.uid||root.storeId!==source.storeId&&!(root.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2))throw new ValidateException('订单父子归属无效');
  if(source.supplierAllocationStatus===1||root.supplierId!==source.supplierId&&!(root.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2))throw new ValidateException('订单分配或父子供应商归属无效');
  return{requested:source,root};
}
export async function customerWorkRemarkTarget(db:DbClient,reference:unknown,kind:'number'|'id'){
  const {requested,root}=await resolveCustomerRemarkOrder(db,reference,kind),operation=await customerWorkOperationReadiness(db),order_revision=await merchantOrderRevision(requested);
  const fulfillment_revision=await themeHash({version:'customer-work-remark-revision-v1',requested_id:requested.id,root_id:root.id,order_revision,root_revision:await merchantOrderRevision(root)});
  return{id:requested.id,order_id:requested.orderId,remark:requested.remark,order_revision,fulfillment_revision,available:operation.ready,reason:operation.ready?'':operation.reason||'工作台写权限尚未验收'};
}
export async function resolveCustomerFulfillmentOrder(db:DbClient,reference:unknown,kind:'number'|'id'){
  const {requested:source,root}=await resolveCustomerRemarkOrder(db,reference,kind);
  let order=source;
  if(source.pid===-1){const pending=await db.select().from(storeOrder).where(and(eq(storeOrder.pid,root.id),eq(storeOrder.uid,root.uid),root.supplierAllocationStatus===2?undefined:eq(storeOrder.storeId,root.storeId),eq(storeOrder.status,0),sql`${storeOrder.refundStatus}<>2`,eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0))).orderBy(asc(storeOrder.id)).limit(2);if(pending.length!==1)throw new ValidateException(pending.length?'订单存在多个待履约子单，请选择真实子单':'订单没有待履约子单');order=pending[0];}
  if(order.pid<0||order.supplierAllocationStatus===1||root.supplierId!==order.supplierId&&!(root.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2))throw new ValidateException('订单分配或父子供应商归属无效');
  const identity:CustomerFulfillmentIdentity={requestedOrderId:source.id,rootOrderId:root.id,orderId:order.id,customerUid:order.uid,storeId:order.storeId,supplierId:order.supplierId};return{requested:source,root,order,identity};
}
function snapshotCart(value:string|null){if(!value||new TextEncoder().encode(value).length>65536)throw new ValidateException('履约商品快照缺失或超限');let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new ValidateException('履约商品快照无效');}if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new ValidateException('履约商品快照无效');return parsed as Record<string,unknown>;}
function snapshotRecord(value:unknown){return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function snapshotText(value:unknown,max:number){if(typeof value!=='string'||[...value].length>max||/[\u0000-\u001f\u007f]/.test(value))throw new ValidateException('履约商品快照文本无效');return value;}
export async function customerWorkFulfillmentState(db:DbClient,env:Env,reference:unknown,kind:'number'|'id',lock=false){
  const state=await resolveCustomerFulfillmentOrder(db,reference,kind),{root,order,identity}=state;
  if(lock){await db.execute(sql`LOCK TABLE store_order_refund,order_waybill_job,store_order_cart_info IN SHARE MODE NOWAIT`);}
  const carts=await db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(501);
  if(!carts.length||carts.length>500||carts.some(c=>c.uid!==order.uid)||new Set(carts.map(c=>c.cartId)).size!==carts.length)throw new ValidateException('订单商品归属、唯一性或数量须先核对');
  const refunds=await db.select({id:storeOrderRefund.id,refundType:storeOrderRefund.refundType,uid:storeOrderRefund.uid,storeId:storeOrderRefund.storeId,supplierId:storeOrderRefund.supplierId,isCancel:storeOrderRefund.isCancel,isDel:storeOrderRefund.isDel}).from(storeOrderRefund).where(and(eq(storeOrderRefund.storeOrderId,order.id),eq(storeOrderRefund.isCancel,0),eq(storeOrderRefund.isDel,0),inArray(storeOrderRefund.refundType,[0,1,2,4,5]))).orderBy(asc(storeOrderRefund.id)).limit(501);
  const jobs=await db.select({id:orderWaybillJob.id,status:orderWaybillJob.status,orderId:orderWaybillJob.orderId,rootOrderId:orderWaybillJob.rootOrderId,storeId:orderWaybillJob.storeId,supplierId:orderWaybillJob.supplierId,updateTime:orderWaybillJob.updateTime}).from(orderWaybillJob).where(eq(orderWaybillJob.rootOrderId,root.id)).orderBy(asc(orderWaybillJob.id)).limit(501);
  if(refunds.length>500||jobs.length>500)throw new ValidateException('订单售后或面单历史超限');
  const defaults=await customerWorkDefaults(db),carriers=await customerWorkCarriers(db),couriers=await customerWorkCouriers(db),operation=await customerWorkOperationReadiness(db),cityService=new CustomerCityDeliveryService(createContainerFromDb(db),env),city=await cityService.bootstrap(db,identity),cityBlocking=city.schema_ready?await cityService.blocking(db,identity,lock):false,citySettings=(await readCityDeliverySettingsInTx(db,env)).snapshot.revision;
  // Every durable city proof participates, including an attempt changing while
  // the public job remains UNKNOWN. Hash xmin, never publish private intents.
  const cityHistory=city.schema_ready?await db.execute(sql`SELECT
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',j.id,'xmin',j.xmin::text) ORDER BY j.id),'[]'::jsonb) FROM customer_city_delivery_job j WHERE j.root_order_id=${root.id}) AS jobs,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'xmin',a.xmin::text) ORDER BY a.id),'[]'::jsonb) FROM customer_city_delivery_attempt a JOIN customer_city_delivery_job j ON j.id=a.job_id WHERE j.root_order_id=${root.id}) AS attempts,
   (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.job_id),'[]'::jsonb) FROM customer_city_delivery_binding b WHERE b.root_order_id=${root.id}) AS bindings`):[{jobs:[],attempts:[],bindings:[],catalog:'unreviewed'}];
  const pinkQuery=db.select().from(storePink).where(eq(storePink.id,order.pinkId)).limit(1),pink=order.type===3?await(lock?pinkQuery.for('share',{noWait:true}):pinkQuery):[];
  let reason='';if(!operation.ready)reason=operation.reason||'工作台写权限尚未验收';else if(!city.schema_ready)reason='同城配送完整目录或运行权限尚未验收，请保留原操作核对';else if(cityBlocking)reason='订单存在未结同城配送任务';
  if(!reason)try{await assertCustomerFulfillmentReady(db,{root,order},'manual',undefined,lock);}catch(error){if(!(error instanceof ValidateException))throw error;reason=error.message;}
  if(!reason&&order.type===6){const boundary=Math.max(...carts.map(c=>presaleDispatchBoundary(c.cartInfo,c.productId))),[clock]=await db.execute<{ready:boolean}>(sql`SELECT clock_timestamp()>=to_timestamp(${boundary}) AS ready`);if(clock?.ready!==true)reason='预售活动尚未结束';}
  const publicCarts=carts.filter(c=>[0,1].includes(c.splitStatus)&&c.splitSurplusNum>0).map(c=>{const snapshot=snapshotCart(c.cartInfo),product=snapshotRecord(snapshot.productInfo),attr=snapshotRecord(product.attrInfo);return{cart_id:c.cartId,product_id:c.productId,cart_num:c.cartNum,surplus_num:c.splitSurplusNum,store_name:snapshotText(product.store_name??snapshotRecord(snapshot.product).store_name??'',128),sku:snapshotText(attr.suk??'',128),price:managerMoney(snapshot.truePrice??product.price)};});
  if(!reason&&!publicCarts.length)reason='订单没有可履约商品';
  const electronicReady=defaults.config_export_open===1&&Boolean(env.CRMEB_ONEPASS_ACCESS_KEY?.trim()&&env.CRMEB_ONEPASS_SECRET_KEY?.trim())&&carriers.length>0;
  const actions={remark:operation.ready?customerWorkAvailable():customerWorkUnavailable(operation.reason||'工作台写权限尚未验收'),manual_delivery:reason?customerWorkUnavailable(reason):customerWorkAvailable(),split_delivery:reason?customerWorkUnavailable(reason):order.productType===3?customerWorkUnavailable('手工虚拟商品须整单交付'):customerWorkAvailable(),electronic_waybill:reason?customerWorkUnavailable(reason):order.shippingType!==1||order.productType!==0?customerWorkUnavailable('当前订单不支持电子面单'):electronicReady?customerWorkAvailable():customerWorkUnavailable('电子面单尚未配置完整'),city_delivery:reason?customerWorkUnavailable(reason):order.productType!==0?customerWorkUnavailable('虚拟商品不能同城配送'):![1,3].includes(order.shippingType)?customerWorkUnavailable('当前订单不支持同城配送'):city.providers.some(p=>p.available)?customerWorkAvailable():customerWorkUnavailable('同城配送平台、站点或回调尚未验收')};
  const {requestedOrderId:_requested,...resource}=identity;
  const order_revision=await merchantOrderRevision(order),fulfillment_revision=await themeHash({version:'customer-work-fulfillment-revision-v1',identity:resource,root_revision:await merchantOrderRevision(root),order_revision,carts,refunds,jobs,defaults,carriers,couriers,pink,city,cityHistory,citySettings,readiness:{ready:operation.ready,reason:operation.reason,electronic:electronicReady}});
  return{...state,carts:publicCarts,order_revision,fulfillment_revision,actions,defaults,carriers,couriers,city,readiness:{operations:{ready:operation.ready,reason:operation.reason},electronic:{ready:electronicReady,reason:electronicReady?'':'电子面单尚未配置完整'},city}};
}
