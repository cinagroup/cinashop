import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus } from '@/models/schema';
import { assertCashierSecondCardOriginCatalog } from '@/migrations/runCashierSecondCardOrigin';
import { outRequestHash, normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { parseCashierSecondCardCreationFact } from '@/services/order/CashierSecondCardOrigin';
import { AuthException, NotFoundException, ValidateException } from '@/utils/errors';
import { authorizeCustomerWorkActor, customerWorkId, type CustomerWorkActor, type CustomerWorkScope } from './CustomerWorkScope';
import { freezeCustomerActor } from './CustomerWorkOperationRequest';
import { readCashierConsumedForm } from './CustomerCashierFormImages';
import { loadUnpaidOrderCashierEditProof, cashierEditedSnapshotMatches } from '@/services/order/UnpaidOrderCashierEditProof';

export const CUSTOMER_CASHIER_READ_VERSION = 'customer-work-cashier-read-v1' as const;
const scopeName = 'own-second-card-creations' as const;
interface OriginRow extends Record<string,unknown> {
  order_id: number; actor_uid: number; service_id: number; buyer_uid: number;
  request_key: string; request_hash: string; scope_key: string; origin_hash: string;
  origin: unknown; created_at: string;
}
const originColumns = sql`c.order_id,c.actor_uid,c.service_id,c.buyer_uid,c.request_key::text,
  c.request_hash,c.scope_key,c.origin_hash,c.origin,
  to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;
const orderNumber = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new ValidateException('收银订单号无效');
  return value;
};
function queryKeys(query: Record<string,string>, allowed: string[]) {
  if (Object.keys(query).some(key => !['scope_key', ...allowed].includes(key))) throw new ValidateException('收银记录查询参数无效');
  if (query.scope_key !== undefined && !/^[a-f0-9]{64}$/.test(query.scope_key)) throw new ValidateException('收银身份摘要无效');
}
function limitValue(value: string | undefined) {
  if (value === undefined) return 20;
  if (!/^[1-9]\d?$/.test(value) || Number(value) > 50) throw new ValidateException('每次收银记录最多读取50条');
  return Number(value);
}
type Cursor = [string, number, string, string, string, string];
function decodeCursor(value: string | undefined, actor: CustomerWorkActor, scope: CustomerWorkScope, filter: string): Cursor | null {
  if (value === undefined) return null;
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ValidateException('收银记录游标无效');
  try {
    const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    if (btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value) throw Error();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 6 || parsed[0] !== CUSTOMER_CASHIER_READ_VERSION
      || parsed[1] !== actor.uid || parsed[2] !== scope.scope_key || parsed[3] !== filter
      || typeof parsed[4] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed[4])
      || !Number.isFinite(Date.parse(parsed[4])) || normalizeOutRequestKey(parsed[5]) !== parsed[5]) throw Error();
    return parsed as Cursor;
  } catch { throw new ValidateException('收银游标与当前账号、资格或筛选不匹配，请重新加载'); }
}
function encodeCursor(row: OriginRow, actor: CustomerWorkActor, scope: CustomerWorkScope, filter: string) {
  return btoa(JSON.stringify([CUSTOMER_CASHIER_READ_VERSION, actor.uid, scope.scope_key, filter, row.created_at, row.request_key]))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function recordObject(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('原收银记录内容无法核对');
  return value as Record<string,unknown>;
}
function snapshotText(value: unknown, maximum: number) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException('原收银商品文字无效');
  return value;
}

/** Current customer qualification grants this read, while immutable actor_uid
 * alone determines ownership. Historical service IDs are evidence, not grants. */
export class CustomerWorkCashierReadService {
  constructor(readonly container: Container, readonly env: Env) {}
  /** Caller supplies the owner-authorized RR/READ ONLY transaction. Recovery
   * remains possible after customer-role loss; it never dispatches a write. */
  async verifiedReceipt(db:DbClient,actorValue:CustomerWorkActor,keyValue:unknown,kind:'creation'|'payment') {
    const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue);
    let orderId:number|undefined;
    const receipts=kind==='creation'?await db.execute<{order_id:number;request_hash:string;origin_hash:string;evidence:unknown}>(sql`
      SELECT order_id,request_hash,origin_hash,origin AS evidence FROM public.cashier_second_card_origin_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 2`)
      :await db.execute<{order_id:number;request_hash:string;scope_key:string;amount:string;evidence:unknown}>(sql`
      SELECT order_id,request_hash,scope_key,amount,evidence FROM public.cashier_second_card_payment_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 2`);
    if(receipts.length>1)throw new ValidateException('原收银回执身份重复');
    if(!receipts.length)return null;orderId=receipts[0].order_id;
    const rows=await db.execute<OriginRow>(sql`SELECT ${originColumns} FROM public.cashier_second_card_origin_v1 c WHERE c.actor_uid=${actor.uid} AND c.order_id=${orderId} LIMIT 2`);
    if(rows.length!==1)throw new ValidateException('原收银回执缺少实际创建来源');
    const projection=await this.project(db,actor,rows[0]),receipt=receipts[0];
    await readCashierConsumedForm(db,this.container,this.env,actor,projection.record.id,projection.creation.request_key,projection.creation.request_hash);
    if(kind==='creation') {
      if(projection.creation.request_key!==key||projection.creation.request_hash!==receipt.request_hash)throw new ValidateException('原收银创建回执不匹配');
    } else {
      const payment=await this.payment(db,actor,projection.record,projection.creation.origin_hash);
      const saved=receipt as {scope_key:string;amount:string;request_hash:string};
      if(!payment||payment.request_key!==key||!hash64(saved.scope_key)||payment.amount!==saved.amount
        ||saved.request_hash!==await outRequestHash({version:'customer-cashier-second-card-payment-v1',scope_key:saved.scope_key,
          order_id:projection.record.id,order_no:projection.record.order_no,expected_amount:payment.amount}))throw new ValidateException('原收银付款请求回执不匹配');
    }
    return {...receipt,order:projection.record};
  }
  private async snapshot<T extends object>(value: CustomerWorkActor, query: Record<string,string>, read: (db: DbClient, scope: CustomerWorkScope) => Promise<T>) {
    const actor = freezeCustomerActor(value);
    const result = await withTx(this.container, async db => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await db.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
      const scope = await authorizeCustomerWorkActor(db, actor);
      if (query.scope_key !== undefined && query.scope_key !== scope.scope_key) throw new AuthException('收银经营资格已变化，请重新加载');
      await assertCashierSecondCardOriginCatalog(db);
      const data = { scope: scopeName, ...await read(db, scope) };
      return { version: CUSTOMER_CASHIER_READ_VERSION, actor_uid: actor.uid,
        principal: { kind: 'customer-order-manager' as const, service_id: scope.service_id, scope: 'global' as const },
        scope_key: scope.scope_key, consistency_key: await outRequestHash({ scope_key: scope.scope_key, version: CUSTOMER_CASHIER_READ_VERSION, data }), data };
    });
    const fresh = await authorizeCustomerWorkActor(this.container.db, actor);
    if (fresh.scope_key !== result.scope_key) throw new AuthException('收银经营资格已变化，请重新加载');
    return result;
  }
  private async project(db: DbClient, actor: CustomerWorkActor, saved: OriginRow) {
    const origin = parseCashierSecondCardCreationFact(saved.origin);
    const [order] = await db.select({ id:storeOrder.id, isSystemDel:storeOrder.isSystemDel, orderId:storeOrder.orderId,
      uid:storeOrder.uid, staffId:storeOrder.staffId, pid:storeOrder.pid, type:storeOrder.type, isChannel:storeOrder.isChannel,
      productType:storeOrder.productType, storeId:storeOrder.storeId, shippingType:storeOrder.shippingType, payPrice:storeOrder.payPrice,
      supplierId:storeOrder.supplierId, changePrice:storeOrder.changePrice, gainIntegral:storeOrder.gainIntegral,
      paid:storeOrder.paid, payType:storeOrder.payType, payTime:storeOrder.payTime, realName:storeOrder.realName, userPhone:storeOrder.userPhone,
      addTime:storeOrder.addTime, status:storeOrder.status, refundStatus:storeOrder.refundStatus }).from(storeOrder).where(eq(storeOrder.id, saved.order_id)).limit(1);
    if (!order || order.isSystemDel) throw new NotFoundException('收银记录不存在');
    if (saved.actor_uid !== actor.uid || origin.creator_uid !== actor.uid || await outRequestHash(origin) !== saved.origin_hash
      || origin.root_order_id !== order.id || origin.root_order_no !== order.orderId || origin.buyer_uid !== order.uid
      || saved.buyer_uid !== order.uid || saved.service_id !== origin.service_id || saved.request_key !== origin.creation_key
      || saved.request_hash !== origin.creation_hash || saved.scope_key !== origin.scope_key || order.staffId !== actor.uid
      || ![0,-1].includes(order.pid) || order.type !== 0 || order.isChannel !== 2 || order.productType !== 4 || order.storeId !== 0 || order.shippingType !== 2)
      throw new ValidateException('次卡收银原始创建来源与订单不一致');
    const audits = await db.select({ id: storeOrderStatus.id }).from(storeOrderStatus).where(and(
      eq(storeOrderStatus.id, origin.creation_status_id), eq(storeOrderStatus.oid, order.id), eq(storeOrderStatus.changeType, 'customer_cashier_create'))).limit(2);
    if (audits.length !== 1) throw new ValidateException('原收银创建记录缺失');
    const [cartCount] = await db.select({count:sql<number>`count(*)::int`}).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id));
    if (cartCount.count !== origin.cart_facts.length) throw new ValidateException('原收银商品行数量不一致');
    const carts=await db.select({...getTableColumns(storeOrderCartInfo),
      cartInfo:sql<string|null>`CASE WHEN octet_length(${storeOrderCartInfo.cartInfo})<=262144 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`})
      .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
    const editProof=await loadUnpaidOrderCashierEditProof(db,order,carts,origin.cart_facts);
    const items = [];
    for (const fact of origin.cart_facts) {
      const cart = carts.find(value=>value.id===fact.cart_row_id);
      if (!cart || cart.oid !== order.id || cart.uid !== order.uid || cart.cartId !== fact.opaque_cart_id
        || cart.productId !== fact.product_id || cart.productType !== 4 || cart.type !== fact.owner_type || cart.relationId !== fact.owner_id
        || cart.skuUnique !== fact.sku_unique || cart.cartNum !== fact.purchase_quantity || cart.writeTimes !== fact.write_times
        || cart.cartInfo === null || await outRequestHash(cart.cartInfo) !== fact.snapshot_hash&&!cashierEditedSnapshotMatches(editProof,cart,fact.snapshot_hash))
        throw new ValidateException('原收银商品快照不一致');
      const snapshot = recordObject(typeof cart.cartInfo === 'string' ? JSON.parse(cart.cartInfo) : cart.cartInfo);
      const product = recordObject(snapshot.product), attr = recordObject(snapshot.sku);
      items.push({ product_id: fact.product_id, sku_unique: fact.sku_unique, quantity: fact.purchase_quantity,
        write_times: fact.write_times, name: snapshotText(product.storeName, 512), sku: snapshotText(attr.suk, 512) });
    }
    if (!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(order.payPrice) || ![0,1].includes(order.paid)) throw new ValidateException('原收银订单金额或付款状态无效');
    const record = { id: order.id, order_no: orderNumber(order.orderId), buyer_uid: order.uid, creator_uid: actor.uid,
      real_name: snapshotText(order.realName,32), user_phone: snapshotText(order.userPhone,20), amount: order.payPrice,
      quantity: items.reduce((n,item) => n + item.quantity,0), paid: order.paid, pay_type: order.payType, pay_time: order.payTime,
      created_at: order.addTime, status: order.status, refund_status: order.refundStatus, root_retired: order.pid < 0, origin_hash: saved.origin_hash };
    return { record, creation: { request_key: saved.request_key, request_hash: saved.request_hash, origin_hash: saved.origin_hash,
      service_id: saved.service_id, created_at: saved.created_at }, items };
  }
  async records(value: CustomerWorkActor, query: Record<string,string> = {}) {
    queryKeys(query, ['limit','cursor','order_no']);
    const actor = freezeCustomerActor(value), limit = limitValue(query.limit), filter = query.order_no === undefined ? '' : orderNumber(query.order_no);
    return this.snapshot(actor, query, async (db, scope) => {
      const cursor = decodeCursor(query.cursor,actor,scope,filter);
      const rows = await db.execute<OriginRow>(sql`SELECT ${originColumns} FROM public.cashier_second_card_origin_v1 c
        JOIN store_order o ON o.id=c.order_id WHERE c.actor_uid=${actor.uid} AND o.is_system_del=0
        ${filter ? sql`AND o.order_id=${filter}` : sql``}
        ${cursor ? sql`AND (c.created_at,c.request_key)<(${cursor[4]}::timestamptz,${cursor[5]}::uuid)` : sql``}
        ORDER BY c.created_at DESC,c.request_key DESC LIMIT ${limit+1}`);
      const selected = rows.slice(0,limit), list = [];
      for (const row of selected) {
        const projected = await this.project(db,actor,row);
        await this.payment(db,actor,projected.record,projected.creation.origin_hash);
        list.push(projected.record);
      }
      const has_more = rows.length > limit;
      return { list, limit, has_more, next_cursor: has_more ? encodeCursor(selected[selected.length-1],actor,scope,filter) : null };
    });
  }
  async record(value: CustomerWorkActor, idValue: unknown, query: Record<string,string> = {}) {
    queryKeys(query, ['order_no']);
    const actor = freezeCustomerActor(value), id = customerWorkId(idValue,'物理订单'), no = orderNumber(query.order_no);
    return this.snapshot(actor,query,async db => {
      const rows = await db.execute<OriginRow>(sql`SELECT ${originColumns} FROM public.cashier_second_card_origin_v1 c WHERE c.actor_uid=${actor.uid} AND c.order_id=${id} LIMIT 2`);
      if (rows.length !== 1) throw new NotFoundException('收银记录不存在');
      const { record, creation, items } = await this.project(db,actor,rows[0]);
      if (record.order_no !== no) throw new NotFoundException('收银订单号与物理订单不匹配');
      const payment = await this.payment(db,actor,record,creation.origin_hash);
      const form=await readCashierConsumedForm(db,this.container,this.env,actor,record.id,creation.request_key,creation.request_hash);
      return { record, creation, items, payment, form };
    });
  }
  private async payment(db:DbClient, actor:CustomerWorkActor, record:Awaited<ReturnType<CustomerWorkCashierReadService['project']>>['record'], originHash:string) {
      const id = record.id, no = record.order_no;
      const payments = await db.execute<{request_key:string;actor_uid:number;amount:string;payment_kind:string;evidence:unknown;outbox_id:number;order_paid_status_id:number}>(sql`
        SELECT request_key::text,actor_uid,amount,payment_kind,evidence,outbox_id,order_paid_status_id
        FROM public.cashier_second_card_payment_v1 WHERE order_id=${id} LIMIT 2`);
      // A cash paid bit without the cashier receipt cannot claim completion.
      // Other payment methods remain observations with no cashier cash proof.
      if (record.paid===1 && record.pay_type==='cash' && payments.length===0) throw new ValidateException('原收银实际付款记录缺失');
      let payment = null;
      if (payments.length) {
        if (payments.length !== 1) throw new ValidateException('原收银付款来源重复');
        const saved = payments[0], evidence = recordObject(saved.evidence);
        const [audit] = await db.select().from(storeOrderStatus).where(eq(storeOrderStatus.id,saved.order_paid_status_id)).limit(1);
        const [event] = await db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,saved.outbox_id)).limit(1);
        const payload = event ? recordObject(event.payload) : null;
        if (saved.actor_uid !== actor.uid || evidence.version !== 'cashier-second-card-payment-v1' || evidence.order_id !== id
          || evidence.order_no !== no || evidence.creator_uid !== actor.uid || evidence.buyer_uid !== record.buyer_uid
          || evidence.origin_hash !== originHash || evidence.paid !== 1 || evidence.pay_type !== 'cash'
          || evidence.amount !== saved.amount || evidence.pay_time !== record.pay_time || record.paid !== 1 || record.pay_type !== 'cash'
          || saved.amount !== record.amount || !['zero','cash'].includes(saved.payment_kind) || (saved.amount === '0.00') !== (saved.payment_kind === 'zero')
          || !audit || audit.oid !== id || audit.changeType !== 'customer_cashier_paid' || evidence.status_id !== audit.id
          || !event || event.aggregateType !== 'order' || event.aggregateId !== id || event.eventType !== 'order.paid'
          || event.eventKey !== `order.paid:${id}` || payload?.orderId !== id || payload.orderNo !== no
          || evidence.outbox_id !== event.id || evidence.event_key !== event.eventKey
          || evidence.payload_hash !== await outRequestHash(event.payload)) throw new ValidateException('原收银实际付款记录无法核对');
        payment = { request_key: normalizeOutRequestKey(saved.request_key), amount: saved.amount, payment_kind: saved.payment_kind as 'zero'|'cash',
          paid_at: record.pay_time, outbox_id: event.id, origin_hash: originHash };
      }
      return payment;
  }
}
function hash64(value:unknown):value is string {return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);}
