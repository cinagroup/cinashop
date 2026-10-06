import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { MerchantOrderActions } from '../../../../view/common/merchantManagement';
import type { Env } from '@/env';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { acquireManagerCarrierLock } from '@/migrations/runManagerScopeLock';
import { deliveryService, expressCompany, orderWaybillJob, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderStatus, storePink, user } from '@/models/schema';
import { presaleDispatchBoundary } from '@/services/activity/PresaleFulfillmentSnapshot';
import { assertManualOrderDeliveryType } from '@/services/order/ManualVirtualDeliveryPolicy';
import { SupplierFulfillmentService, type SupplierDeliveryInput, type SupplierSplitCartInput } from '@/services/supplier/SupplierFulfillmentService';
import { ValidateException } from '@/utils/errors';
import { ManagerOrderOperationRequest, freezeManagerJson, type ManagerOperationContext, type ManagerOperationInput, type ManagerOperationKind, type ManagerJson } from './ManagerOrderOperationRequest';
import { managerId, type StoreManagerScope } from './StoreManagerScope';

type Order = typeof storeOrder.$inferSelect;
type FulfillmentActions = Pick<MerchantOrderActions, 'remark'|'manual_delivery'|'split_delivery'|'electronic_waybill'>;
const available = { available: true, reason: '' };
const unavailable = (reason: string) => ({ available: false, reason });

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new ValidateException(`${label}格式无效`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new ValidateException('操作字段缺失或包含不支持的字段');
}
function text(value: unknown, label: string, max: number, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || controls.test(value)) throw new ValidateException(`${label}须为1至${max}个可见字符`);
  return value.trim();
}
export function parseManagerRemark(value: unknown): string {
  const body = record(value, '备注'); exactKeys(body, ['remark']);
  return text(body.remark, '订单备注', 512, true);
}
/** A new strict contract does not inherit legacy coercion of null/boolean IDs,
 * arbitrary agent names, or electronic provider submissions into manual SQL. */
export function parseManagerDelivery(value: unknown, split: boolean): { delivery: SupplierDeliveryInput; carts: SupplierSplitCartInput[] } {
  const body = record(value, '发货');
  const cartKey = split ? ['cart_ids'] : [];
  let delivery: SupplierDeliveryInput;
  if (body.type === 1) {
    exactKeys(body, ['type','express_record_type','delivery_name','delivery_code','delivery_id',...cartKey]);
    if (body.express_record_type !== 1) throw new ValidateException('电子面单必须通过已授权的持久任务提交');
    delivery = {deliveryType:'express',deliveryName:text(body.delivery_name,'快递公司',64),deliveryCode:text(body.delivery_code,'快递编码',50),deliveryId:text(body.delivery_id,'快递单号',64),fictitiousContent:'',deliveryUid:0};
  } else if (body.type === 2) {
    exactKeys(body, ['type','delivery_type','delivery_uid',...cartKey]);
    if (body.delivery_type !== 1) throw new ValidateException('第三方同城配送尚未接入店长提交合同');
    delivery = {deliveryType:'send',deliveryName:'',deliveryCode:'',deliveryId:'',fictitiousContent:'',deliveryUid:managerId(body.delivery_uid,'配送员')};
  } else if (body.type === 3) {
    exactKeys(body, ['type','fictitious_content',...cartKey]);
    delivery = {deliveryType:'fictitious',deliveryName:'',deliveryCode:'',deliveryId:'',fictitiousContent:text(body.fictitious_content,'虚拟交付内容',500,true),deliveryUid:0};
  } else throw new ValidateException('发货类型须为1、2或3');
  const carts: SupplierSplitCartInput[] = [];
  if (split) {
    if (!Array.isArray(body.cart_ids) || body.cart_ids.length === 0 || body.cart_ids.length > 200) throw new ValidateException('请选择1至200项发货商品');
    const seen = new Set<string>();
    for (const raw of body.cart_ids) {
      const item = record(raw, '发货商品'); exactKeys(item, ['cart_id','cart_num']);
      const cartId = text(item.cart_id, '商品快照ID', 50);
      if (seen.has(cartId)) throw new ValidateException('同一商品不能重复选择');
      if (typeof item.cart_num !== 'number' || !Number.isSafeInteger(item.cart_num) || item.cart_num <= 0 || item.cart_num > 2147483647) throw new ValidateException('发货数量须为正整数');
      seen.add(cartId); carts.push({cartId,cartNum:item.cart_num});
    }
  }
  return {delivery,carts};
}

/** Both projections and mutations use these live SQL gates. Read callers own
 * the merchant repeatable-read snapshot; writes already hold root/order locks
 * and additionally protect mutable cart evidence and insert phantoms NOWAIT. */
export async function storeManagerFulfillmentActions(db: DbClient, scope: StoreManagerScope, order: Order, lock = false): Promise<FulfillmentActions> {
  const actions: FulfillmentActions = {remark:available,manual_delivery:available,split_delivery:available,electronic_waybill:unavailable('门店店长电子面单任务授权尚未接入')};
  if (order.storeId !== scope.store_id || order.pid < 0 || order.isDel || order.isSystemDel || order.supplierAllocationStatus === 1) {
    const denied=unavailable('订单不属于当前有效门店履约范围'); return {remark:denied,manual_delivery:denied,split_delivery:denied,electronic_waybill:actions.electronic_waybill};
  }
  let reason='';
  if (order.paid!==1) reason='订单未支付';
  else if (order.status!==0) reason='订单状态不允许发货';
  else if (![1,3].includes(order.shippingType)) reason='当前配送方式须使用独立核销或收银合同';
  else if (![0,3].includes(order.refundStatus)) reason='订单存在进行中的售后';
  else if (![0,3].includes(order.productType)) reason='当前商品不支持手工发货';
  if (!reason && order.pid>0) {
    const roots=await db.select({uid:storeOrder.uid,storeId:storeOrder.storeId,supplierId:storeOrder.supplierId,isSystemDel:storeOrder.isSystemDel}).from(storeOrder).where(eq(storeOrder.id,order.pid)).limit(1);
    if (roots.length!==1 || roots[0].uid!==order.uid || roots[0].storeId!==scope.store_id || roots[0].supplierId!==order.supplierId || roots[0].isSystemDel) reason='拆单父订单归属须先核对';
  }
  if (!reason) {
    if (lock) {
      // A live refund/waybill admission is another authority for this order.
      // Protect absent-row predicates as well as current rows without adding
      // a wait edge to peers that already hold their own financial resources.
      await db.execute(sql`LOCK TABLE store_order_refund, order_waybill_job IN SHARE MODE NOWAIT`);
    }
    const refunds=await db.select({id:storeOrderRefund.id,uid:storeOrderRefund.uid,storeId:storeOrderRefund.storeId,supplierId:storeOrderRefund.supplierId}).from(storeOrderRefund).where(and(eq(storeOrderRefund.storeOrderId,order.id),eq(storeOrderRefund.isCancel,0),eq(storeOrderRefund.isDel,0),sql`${storeOrderRefund.refundType} IN (0,1,2,4,5)`)).limit(1);
    if (refunds.length) reason='订单存在进行中的售后';
    const jobs=await db.select({id:orderWaybillJob.id}).from(orderWaybillJob).where(and(eq(orderWaybillJob.rootOrderId,order.pid>0?order.pid:order.id),sql`${orderWaybillJob.status} IN ('PENDING','ENQUEUING','ENQUEUED','PROCESSING','RETRYABLE','UNKNOWN','DEAD')`)).limit(1);
    if (jobs.length) reason='订单有未结电子面单任务，请先核对';
  }
  if (!reason && order.type===3) {
    const query=db.select({status:storePink.status}).from(storePink).where(eq(storePink.id,order.pinkId)).limit(1);
    const pink=await(lock?query.for('share',{noWait:true}):query);
    if (pink[0]?.status!==2) reason='拼团尚未成功，不能发货';
  }
  if (!reason) {
    if (lock) await db.execute(sql`LOCK TABLE store_order_cart_info IN SHARE MODE NOWAIT`);
    const query=db.select({uid:storeOrderCartInfo.uid,productId:storeOrderCartInfo.productId,cartId:storeOrderCartInfo.cartId,cartInfo:sql<string|null>`CASE WHEN ${order.type===6} AND octet_length(${storeOrderCartInfo.cartInfo}) <= 65536 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`}).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(501);
    const carts=await(lock?query.for('share',{noWait:true}):query);
    // Cart ownership is (oid, uid); this table has no store/supplier columns.
    // Those principals come only from the already scoped, locked order.
    if (!carts.length || carts.length>500 || carts.some(row=>row.uid!==order.uid) || new Set(carts.map(row=>row.cartId)).size!==carts.length) reason='订单商品归属或快照须先核对';
    if (!reason && order.type===6) {
      let boundary=0;
      try { for(const cart of carts) boundary=Math.max(boundary,presaleDispatchBoundary(cart.cartInfo,cart.productId)); }
      catch(error) { if (!(error instanceof ValidateException)) throw error; reason=error.message; }
      if (!reason) { const clock=await db.execute<{ready:boolean}>(sql`SELECT clock_timestamp() >= to_timestamp(${boundary}) AS ready`); if(clock[0]?.ready!==true) reason='预售活动尚未结束，不能发货'; }
    }
  }
  if (reason) actions.manual_delivery=actions.split_delivery=unavailable(reason);
  else if (order.productType===3) actions.split_delivery=unavailable('手工虚拟商品须整单交付');
  return actions;
}

async function lockDeliveryIdentity(tx:DbClient,scope:StoreManagerScope,input:SupplierDeliveryInput) {
  if (input.deliveryType==='express') {
    await acquireManagerCarrierLock(tx,input.deliveryCode);
    const carriers=await tx.select({name:expressCompany.name}).from(expressCompany).where(and(eq(expressCompany.code,input.deliveryCode),eq(expressCompany.status,1),eq(expressCompany.isShow,1))).limit(2);
    if(carriers.length!==1 || carriers[0].name!==input.deliveryName) throw new ValidateException('快递公司已停用、重复或名称编码不匹配');
  }
  if (input.deliveryType==='send') {
    await tx.execute(sql`LOCK TABLE delivery_service IN SHARE MODE NOWAIT`);
    const agents=await tx.select({nickname:deliveryService.nickname,phone:deliveryService.phone}).from(deliveryService).innerJoin(user,eq(user.uid,deliveryService.uid)).where(and(eq(deliveryService.uid,input.deliveryUid),eq(deliveryService.type,1),eq(deliveryService.relationId,scope.store_id),eq(deliveryService.status,1),eq(deliveryService.isDel,0),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).orderBy(asc(deliveryService.id)).limit(2).for('share',{noWait:true});
    if(agents.length!==1) throw new ValidateException('配送员不存在、已停用或身份重复');
    input.deliveryName=text(agents[0].nickname,'配送员姓名',64); input.deliveryId=text(agents[0].phone,'配送员电话',20);
  }
}
export class StoreManagerOrderOperationService {
  constructor(readonly container:Container,readonly env:Env) {}
  async saveRemark(ctx:ManagerOperationContext,input:ManagerOperationInput) {
    const immutable=freezeManagerJson(input) as unknown as ManagerOperationInput;
    return new ManagerOrderOperationRequest(this.container).execute('remark',ctx,immutable,async(tx,scope,order)=>{
      const remark=parseManagerRemark(immutable.payload);
      const changed=order.remark!==remark;
      if(changed) {
        await tx.update(storeOrder).set({remark}).where(and(eq(storeOrder.id,order.id),eq(storeOrder.storeId,scope.store_id)));
        await tx.insert(storeOrderStatus).values({oid:order.id,changeType:'manager_order_remark',changeMessage:`店长用户 ${scope.actor_uid}，店员 ${scope.staff_id}，门店 ${scope.store_id} 更新订单备注`,changeTime:Math.floor(Date.now()/1000)});
      }
      return {outcome:'remark-saved',evidence:{changed}};
    });
  }
  async delivery(kind:Extract<ManagerOperationKind,'manual_delivery'|'split_delivery'>,ctx:ManagerOperationContext,input:ManagerOperationInput) {
    const immutable=freezeManagerJson(input) as unknown as ManagerOperationInput;
    return new ManagerOrderOperationRequest(this.container).execute(kind,ctx,immutable,async(tx,scope,order)=>{
      const parsed=parseManagerDelivery(immutable.payload,kind==='split_delivery');
      const actions=await storeManagerFulfillmentActions(tx,scope,order,true),action=kind==='split_delivery'?actions.split_delivery:actions.manual_delivery;
      if(!action.available) throw new ValidateException(action.reason);
      assertManualOrderDeliveryType(order.productType,parsed.delivery.deliveryType);
      await lockDeliveryIdentity(tx,scope,parsed.delivery);
      const service=new SupplierFulfillmentService(createContainerFromDb(tx),this.env);
      const options={expectedStoreId:scope.store_id,authorize:async(_nested:DbClient,identity:{requestedOrderId:number;customerUid:number;supplierId:number})=>{
        if(identity.requestedOrderId!==order.id || identity.customerUid!==order.uid || identity.supplierId!==order.supplierId) throw new ValidateException('履约订单身份已变化');
      },audit:{changeType:kind==='split_delivery'?'manager_split_delivery':'manager_manual_delivery',changeMessage:`店长用户 ${scope.actor_uid}，店员 ${scope.staff_id}，门店 ${scope.store_id} 提交${kind==='split_delivery'?'拆单':'整单'}发货`}};
      const result=kind==='split_delivery'?await service.splitDelivery(order.supplierId,order.id,parsed.delivery,parsed.carts,options):await service.deliver(order.supplierId,order.id,parsed.delivery,options);
      const evidence:Record<string,ManagerJson>={split:result.split,order_id:result.order_id,remaining_order_id:result.remaining_order_id};
      return {outcome:'delivery-recorded',evidence};
    });
  }
}
