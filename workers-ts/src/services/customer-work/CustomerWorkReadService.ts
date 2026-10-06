import { and, asc, desc, eq, getTableColumns, gte, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Env } from '@/env';
import type { Container, DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, user, systemAttachment } from '@/models/schema';
import { cartProjection, orderProjection, refundProjection } from '@/services/kefu/KefuOrderService';
import { businessMidnight, parseMobileOrderDataQuery, parseMobileOrderPeriod, startOfBusinessDay, type MobileOrderPeriod } from '@/services/admin/AdminStatisticService';
import { refundTypesForFilter, parseAdminRefundListQuery } from '@/services/admin/AdminMobileRefundService';
import { parseAdminStatisticRange } from '@/services/admin/AdminStatisticService';
import { orderReadStatusPredicate } from '@/services/order/OrderReadStatusPredicate';
import { merchantOrderRevision } from '@/services/store/StoreManagerScope';
import { loadRefundOrderGeneration, currentGenerationRefunds } from '@/services/order/RefundOrderGeneration';
import { readRefundGenerationMarker } from '@/services/order/RefundGenerationMarker';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { managerCount, managerMoney } from '@/services/store/StoreManagerOrderStatisticsService';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { fabImage } from '@/services/admin/AdminFabSettingsInput';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ExpressService } from '@/services/order/ExpressService';
import { NotFoundException, ValidateException } from '@/utils/errors';
import { withCustomerWorkRead, type CustomerWorkActor } from './CustomerWorkScope';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
type Refund = typeof storeOrderRefund.$inferSelect;
export const CUSTOMER_WORK_METRIC_SCOPES = {
  sales: 'global_fulfillment_orders', order_totals: 'global_fulfillment_orders', order_state_counts: 'platform_fulfillment_orders',
  refund_counts: 'global_refunds', inventory: 'global_products', visits: 'global_product_visits',
} as const;
export function customerWorkQueryKeys(query: Record<string, string>, keys: readonly string[]) {
  for (const key of Object.keys(query)) if (key !== 'scope_key' && !keys.includes(key)) throw new ValidateException(`工作台不支持查询参数：${key}`);
  if (query.scope_key !== undefined && !/^[a-f0-9]{64}$/.test(query.scope_key)) throw new ValidateException('工作台身份指纹无效');
}
function integer(value: string | undefined, fallback: number, min: number, max: number, label: string) {
  if (value === undefined || value === '') return fallback;
  if (!/^-?\d{1,10}$/.test(value)) throw new ValidateException(`${label}无效`);
  const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new ValidateException(`${label}无效`); return n;
}
function text(value: string | undefined, max = 128) { const s = (value ?? '').trim(); if (s.length > max || /[\u0000-\u001f\u007f]/.test(s)) throw new ValidateException('查询文本无效'); return s; }
function number(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(value)) throw new ValidateException('业务订单编号无效'); return value; }
function date(epoch: number) { return new Date((epoch + 28800) * 1000).toISOString().slice(0, 10); }
function cents(value: unknown) { return BigInt(managerMoney(value).replace('.', '')); }
function decimal(value: bigint) { if (value < 0n) throw new ValidateException('金额分值无效'); return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`; }
function parsedJson(value: string | null) { if (!value) return null; try { const x: unknown = JSON.parse(value); if (x && typeof x === 'object') return x; } catch {} throw new ValidateException('历史订单快照格式无效'); }
function pictureList(value: string | null): string[] { if (!value) return []; const x = parsedJson(value); if (!Array.isArray(x) || x.length > 20 || x.some(row => typeof row !== 'string')) throw new ValidateException('历史售后图片格式无效'); return x as string[]; }

const orderColumns = getTableColumns(storeOrder), orderText = ['cartId', 'virtualInfo', 'customForm', 'promotionsGive', 'giveCoupon', 'expressDump', 'refundReasonWapImg'] as const;
const orderBytes = sql`(${sql.join(orderText.map(key => sql`COALESCE(octet_length(${orderColumns[key]})::bigint,0)`), sql`+`)})`;
const boundedOrder = { ...orderColumns, ...Object.fromEntries(orderText.map(key => [key, sql<string | null>`CASE WHEN ${orderBytes}<=262144 THEN ${orderColumns[key]} ELSE NULL END`])), oversized: sql<boolean>`${orderBytes}>262144` } as typeof orderColumns & { oversized: SQL<boolean> };
function checkedOrder(row: Order & { oversized: boolean }): Order { if (row.oversized) throw new ValidateException('订单快照超过读取容量，请先核对'); const { oversized: _large, ...value } = row; return value; }
const refundColumns = getTableColumns(storeOrderRefund), refundText = ['cartInfo', 'refundImg', 'refundGoodsImg'] as const;
const refundBytes = sql`(${sql.join(refundText.map(key => sql`COALESCE(octet_length(${refundColumns[key]})::bigint,0)`), sql`+`)})`;
const boundedRefund = { ...refundColumns, ...Object.fromEntries(refundText.map(key => [key, sql<string | null>`CASE WHEN ${refundBytes}<=131072 THEN ${refundColumns[key]} ELSE NULL END`])), oversized: sql<boolean>`${refundBytes}>131072` } as typeof refundColumns & { oversized: SQL<boolean> };
function checkedRefund(row: Refund & { oversized: boolean }): Refund { if (row.oversized) throw new ValidateException('售后快照超过读取容量，请先核对'); const { oversized: _large, ...value } = row; return value; }
async function userPictures(db: DbClient, uid: number, values: string[]) {
  const refs = values.map(value => { try { return value ? fabImage(value) : ''; } catch { return ''; } }), ids = refs.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null);
  const assets = ids.length ? await db.select().from(systemAttachment).where(inArray(systemAttachment.attId, ids)) : [], byId = new Map(assets.map(row => [row.attId, row]));
  const fallback = await publicProductPictures(db, refs.map(image => ({ image, type: 0, relationId: 0 })));
  return refs.map((ref, index) => { const id = parseCanonicalAttachmentId(ref), asset = id === null ? undefined : byId.get(id); if (id === null) return fallback[index]; return asset?.type === 3 && asset.relationId === uid && asset.moduleType === 3 && asset.fileType === 1 && asset.imageType === 8 && asset.attDir === ref && asset.name.startsWith(`attachments/user/${uid}/`) && !/[\\\u0000-\u001f\u007f]/.test(asset.name) && !asset.name.split('/').some(v => v === '.' || v === '..') && /\.(?:jpe?g|png|gif|webp)$/i.test(asset.name) && /^image\/(?:jpeg|jpg|png|gif|webp)$/i.test(asset.attType.trim()) ? ref : fallback[index]; });
}

/** The old mixed metric scopes are intentional: counts of business selectors
 * are platform fulfillments, monetary periods include every fulfillment, and
 * refund/product badges cover the whole shop. PHP's int pid=0 accessor means
 * pid>=0; a negative split payment header is never another physical sale. */
async function summary(db: DbClient, period: MobileOrderPeriod) {
  const [row] = await db.execute<Record<string, unknown>>(sql`SELECT
    COALESCE(SUM(pay_price) FILTER(WHERE add_time>=${period.currentStart}),0)::text AS after_price,
    COALESCE(SUM(pay_price) FILTER(WHERE add_time<${period.currentStart}),0)::text AS front_price,
    COUNT(*) FILTER(WHERE add_time>=${period.currentStart})::int AS after_number,
    COUNT(DISTINCT uid) FILTER(WHERE add_time>=${period.currentStart})::int AS after_pay_number,
    (SELECT COUNT(*)::int FROM store_product_log WHERE type='visit' AND delete_time IS NULL AND add_time>=${period.currentStart} AND add_time<${period.currentEndExclusive}) AS today_visits
    FROM store_order WHERE pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${period.previousStart} AND add_time<${period.currentEndExclusive}`);
  const current = cents(row.after_price), previous = cents(row.front_price), difference = current - previous, increase = difference < 0n ? -difference : difference;
  const rate = increase === 0n ? 0 : Number(increase * 100n / (previous || 100n));
  return { after_price: decimal(current), growth_rate: managerCount(rate), increase_time: decimal(increase), increase_time_status: difference >= 0n ? 1 : 2, after_number: managerCount(row.after_number), after_pay_number: managerCount(row.after_pay_number), today_visits: managerCount(row.today_visits) };
}
async function badges(db: DbClient) {
  const [r] = await db.execute<Record<string, unknown>>(sql`SELECT
    (SELECT COUNT(*) FROM store_order WHERE pid>=0 AND paid=1 AND status IN(0,4) AND refund_status IN(0,3) AND shipping_type IN(1,3) AND store_id=0 AND supplier_id=0 AND is_del=0 AND is_system_del=0)::int AS unshipped_count,
    (SELECT COUNT(*) FROM store_order_refund WHERE is_cancel=0 AND is_del=0 AND refund_type IN(0,1,2,4,5))::int AS refunding_count,
    (SELECT COUNT(*) FROM store_order_refund WHERE is_cancel=0 AND is_del=0 AND refund_type IN(3,6))::int AS refunded_count,
    (SELECT COUNT(*) FROM store_product WHERE pid=0 AND is_del=0 AND is_verify=1 AND(is_sold=1 OR stock=0))::int AS outofstock,
    (SELECT COUNT(*) FROM store_product WHERE pid=0 AND is_show=1 AND is_del=0 AND is_verify=1 AND is_police=1 AND stock>0)::int AS policeforce`);
  return { unshipped_count: managerCount(r.unshipped_count), refunding_count: managerCount(r.refunding_count), refunded_count: managerCount(r.refunded_count), refund_count: managerCount(r.refunding_count) + managerCount(r.refunded_count), outofstock: managerCount(r.outofstock), policeforce: managerCount(r.policeforce) };
}
async function counters(db: DbClient, now: number) {
  const today = startOfBusinessDay(now), previous = today - 86400, shifted = new Date((now + 28800) * 1000), month = businessMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  const [r] = await db.execute<Record<string, unknown>>(sql`SELECT COUNT(*)::int AS order_count,COALESCE(SUM(pay_price) FILTER(WHERE paid=1),0)::text AS sum_price,
    COUNT(*) FILTER(WHERE store_id=0 AND supplier_id=0 AND paid=0 AND status=0 AND refund_status=0)::int AS unpaid_count,
    COUNT(*) FILTER(WHERE store_id=0 AND supplier_id=0 AND paid=1 AND status IN(0,4) AND refund_status IN(0,3) AND shipping_type IN(1,3))::int AS unshipped_count,
    COUNT(*) FILTER(WHERE store_id=0 AND supplier_id=0 AND paid=1 AND refund_status IN(0,3) AND((status IN(1,5) AND shipping_type=1) OR(status IN(0,5) AND shipping_type=2)))::int AS received_count,
    COUNT(*) FILTER(WHERE store_id=0 AND supplier_id=0 AND paid=1 AND status=2 AND refund_status IN(0,3))::int AS evaluated_count,
    COUNT(*) FILTER(WHERE store_id=0 AND supplier_id=0 AND paid=1 AND status IN(0,1,5) AND refund_status IN(0,3) AND shipping_type=2)::int AS unwritoff_count,
    COUNT(*) FILTER(WHERE store_id=0 AND supplier_id=0 AND paid=1 AND status=3 AND refund_status IN(0,3))::int AS complete_count,
    COALESCE(SUM(pay_price) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${today} AND add_time<${now + 1}),0)::text AS today_price,
    COUNT(*) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${today} AND add_time<${now + 1})::int AS today_count,
    COALESCE(SUM(pay_price) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${previous} AND add_time<${today}),0)::text AS previous_price,
    COUNT(*) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${previous} AND add_time<${today})::int AS previous_count,
    COALESCE(SUM(pay_price) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${month} AND add_time<${now + 1}),0)::text AS month_price,
    COUNT(*) FILTER(WHERE paid=1 AND refund_status IN(0,3) AND add_time>=${month} AND add_time<${now + 1})::int AS month_count
    FROM store_order WHERE pid>=0 AND is_del=0 AND is_system_del=0`);
  const b = await badges(db);
  return { ...Object.fromEntries(['order_count', 'unpaid_count', 'unshipped_count', 'received_count', 'evaluated_count', 'unwritoff_count', 'complete_count'].map(key => [key, managerCount(r[key])])), sum_price: managerMoney(r.sum_price), refunding_count: b.refunding_count, refunded_count: b.refunded_count, refund_count: b.refund_count, todayPrice: managerMoney(r.today_price), todayCount: managerCount(r.today_count), proPrice: managerMoney(r.previous_price), proCount: managerCount(r.previous_count), monthPrice: managerMoney(r.month_price), monthCount: managerCount(r.month_count) };
}

export class CustomerWorkReadService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  private snapshot<T extends object>(actor: CustomerWorkActor, query: Record<string, string>, callback: (db: DbClient) => Promise<T>) { return withCustomerWorkRead(this.container, actor, query.scope_key, async db => ({ ...await callback(db), metric_scopes: CUSTOMER_WORK_METRIC_SCOPES })); }
  async context(actor: CustomerWorkActor, query: Record<string, string> = {}) {
    actor = Object.freeze({ ...actor });
    customerWorkQueryKeys(query, []); const result = await this.snapshot(actor, query, async db => { const [profile] = await db.select({ uid: user.uid, nickname: user.nickname, phone: user.phone, avatar: user.avatar }).from(user).where(eq(user.uid, actor.uid)); profile.avatar = (await userPictures(db, actor.uid, [profile.avatar]))[0]; return { profile, capabilities: { statistics: true, orders: true, refunds: true, logistics: true, product_management: true, user_management: true, writeoff_read: true, assisted_order: false, writes: false }, metric_scopes: CUSTOMER_WORK_METRIC_SCOPES }; }); result.data.profile.avatar = (await renderProductPictures(this.env.APP_KEY, [result.data.profile.avatar]))[0]; return result;
  }
  async overview(actor: CustomerWorkActor, query: Record<string, string> = {}, now = Math.floor(Date.now() / 1000)) {
    customerWorkQueryKeys(query, []); return this.snapshot(actor, query, async db => ({ badges: await badges(db), today: await summary(db, parseMobileOrderPeriod('1', now)), metric_scopes: CUSTOMER_WORK_METRIC_SCOPES }));
  }
  async statistics(actor: CustomerWorkActor, query: Record<string, string> = {}, now = Math.floor(Date.now() / 1000)) {
    customerWorkQueryKeys(query, ['type']); const period = parseMobileOrderPeriod(query.type, now); return this.snapshot(actor, query, async db => ({ type: period.type, summary: await summary(db, period), counters: await counters(db, now), metric_scopes: CUSTOMER_WORK_METRIC_SCOPES }));
  }
  async trend(actor: CustomerWorkActor, query: Record<string, string> = {}, now = Math.floor(Date.now() / 1000)) {
    customerWorkQueryKeys(query, ['type']); const p = parseMobileOrderPeriod(query.type, now); return this.snapshot(actor, query, async db => { const rows = await db.execute<{ day: string; num: number; price: string }>(sql`SELECT to_char(to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,COUNT(*)::int AS num,COALESCE(SUM(pay_price),0)::text AS price FROM store_order WHERE pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${p.chartStart} AND add_time<${p.currentEndExclusive} GROUP BY 1 ORDER BY 1`), byDate = new Map(rows.map(row => [row.day, row])), list = []; for (let t = p.chartStart; t < p.currentEndExclusive; t += 86400) { const key = date(t), row = byDate.get(key); list.push({ date: key, time: key.slice(5), num: managerCount(row?.num ?? 0), price: managerMoney(row?.price ?? '0.00') }); } return { type: p.type, list, metric_scopes: CUSTOMER_WORK_METRIC_SCOPES }; });
  }
  async daily(actor: CustomerWorkActor, query: Record<string, string> = {}, now = Math.floor(Date.now() / 1000)) {
    customerWorkQueryKeys(query, ['start', 'stop', 'page', 'limit']); const q = parseMobileOrderDataQuery(query, now);
    return this.snapshot(actor, query, async db => { const rows = await db.execute<{ day: string; price: string; count: number; add_time: number; visit: number }>(sql`WITH daily AS(SELECT (to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai')::date AS day,COALESCE(SUM(pay_price),0)::text AS price,COUNT(*)::int AS count,MAX(add_time)::int AS add_time FROM store_order WHERE pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${q.start} AND add_time<${q.endExclusive} GROUP BY 1 ORDER BY 1 DESC LIMIT ${q.limit} OFFSET ${q.offset}) SELECT to_char(d.day,'YYYY-MM-DD') AS day,d.price,d.count,d.add_time,(SELECT COUNT(*)::int FROM store_product_log v WHERE v.type='visit' AND v.delete_time IS NULL AND v.add_time>=EXTRACT(EPOCH FROM d.day::timestamp AT TIME ZONE 'Asia/Shanghai') AND v.add_time<EXTRACT(EPOCH FROM (d.day+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) AS visit FROM daily d ORDER BY d.day DESC`), [count] = await db.execute<{ count: number }>(sql`SELECT COUNT(DISTINCT (to_timestamp(add_time) AT TIME ZONE 'Asia/Shanghai')::date)::int AS count FROM store_order WHERE pid>=0 AND paid=1 AND refund_status IN(0,3) AND is_del=0 AND is_system_del=0 AND add_time>=${q.start} AND add_time<${q.endExclusive}`); return { list: rows.map(row => ({ date: row.day, time: row.day.slice(5), price: managerMoney(row.price), count: managerCount(row.count), add_time: managerCount(row.add_time), visit: managerCount(row.visit) })), count: count.count, page: q.page, limit: q.limit, has_more: q.offset + rows.length < count.count, metric_scopes: CUSTOMER_WORK_METRIC_SCOPES }; });
  }
  private async order(db: DbClient, value: unknown): Promise<Order> { const id = number(value), rows = await db.select(boundedOrder).from(storeOrder).where(and(eq(storeOrder.orderId, id), eq(storeOrder.isSystemDel, 0))).orderBy(asc(storeOrder.id)).limit(2); if (rows.length !== 1) throw new NotFoundException('订单不存在或业务编号不唯一'); return checkedOrder(rows[0]); }
  private async associations(db: DbClient, orders: Order[]) {
    const ids = orders.map(row => row.id), byId = new Map(orders.map(row => [row.id, row])); if (!ids.length) return { carts: [] as Cart[], refunds: [] as Refund[] };
    const bytes = sql`COALESCE(octet_length(${storeOrderCartInfo.cartInfo})::bigint,0)`, carts = await db.select({ ...getTableColumns(storeOrderCartInfo), cartInfo: sql<string | null>`CASE WHEN ${bytes}<=65536 AND sum(${bytes}) OVER()<=1048576 THEN ${storeOrderCartInfo.cartInfo} ELSE NULL END`, oversized: sql<boolean>`${bytes}>65536 OR sum(${bytes}) OVER()>1048576` }).from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, ids)).orderBy(asc(storeOrderCartInfo.id)).limit(501);
    const rawRefunds = await db.select(boundedRefund).from(storeOrderRefund).where(and(inArray(storeOrderRefund.storeOrderId, ids), eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0))).orderBy(asc(storeOrderRefund.id)).limit(501), refunds = rawRefunds.map(checkedRefund);
    if (carts.length > 500 || new Set(carts.map(row => `${row.oid}:${row.cartId}`)).size !== carts.length || carts.some(row => row.oversized || row.uid !== byId.get(row.oid)?.uid) || refunds.length > 500 || refunds.some(row => { const o = byId.get(row.storeOrderId); return !o || row.uid !== o.uid || row.storeId !== o.storeId || row.supplierId !== o.supplierId; })) throw new ValidateException('订单关联数据归属或容量异常');
    return { carts: carts.map(({ oversized: _large, ...row }) => row), refunds };
  }
  private async projectedOrder(db: DbClient, order: Order, carts: Cart[], refunds: Refund[]) {
    const mapped = await this.generationRefunds(db, order, carts, refunds);
    const projected = orderProjection(order, carts, mapped), [customer] = await db.select({ nickname: user.nickname }).from(user).where(eq(user.uid, order.uid)).limit(1);
    const images = await publicProductPictures(db, projected.cartInfo.map(cart => ({ image: cart.productInfo.image, type: order.supplierId > 0 ? 2 : 0, relationId: order.supplierId > 0 ? order.supplierId : 0 })));
    for (const [index, cart] of projected.cartInfo.entries()) { for (const key of ['truePrice', 'vip_truePrice', 'vip_sum_truePrice', 'sum_true_price', 'postage_price', 'coupon_price', 'integral_price', 'promotions_true_price'] as const) cart[key] = managerMoney(cart[key]); cart.productInfo.price = managerMoney(cart.productInfo.price); cart.productInfo.attrInfo.price = managerMoney(cart.productInfo.attrInfo.price); cart.productInfo.image = images[index]; cart.productInfo.attrInfo.image = images[index]; }
    return { ...projected, nickname: customer?.nickname ?? '', store_id: order.storeId, supplier_id: order.supplierId, revision: await merchantOrderRevision(order), write_available: false };
  }
  /** Preserve the immutable original refund/payment identity on physical refund
   * children; do not manufacture a new refund or repoint its business row. */
  private async generationRefunds(db: DbClient, order: Order, carts: Cart[], direct: Refund[]): Promise<Refund[]> {
    const invalid = () => new ValidateException('退款实体归属证据不一致，请先核对订单');
    const markers = carts.map(row => { if (!row.cartInfo?.includes('refund_order_generation') && !row.cartInfo?.includes('refund-order-line-finance-v1')) return null; const parsed = parsedJson(row.cartInfo); if (!parsed || Array.isArray(parsed) || (parsed as Record<string, unknown>).financial_version !== 'refund-order-line-finance-v1') throw invalid(); return readRefundGenerationMarker((parsed as Record<string, unknown>).refund_order_generation); });
    if (markers.every(value => value === null)) return direct;
    const marker = markers[0]; if (!marker || carts.length > 200 || markers.some(value => JSON.stringify(value) !== JSON.stringify(marker))) throw invalid();
    if (marker.role === 'remaining') return currentGenerationRefunds(direct, await loadRefundOrderGeneration(db, order, carts));
    const records = await db.select({ refundId: storeOrderRefundSplit.refundId, fingerprint: storeOrderRefundSplit.fingerprint, uid: storeOrderRefundSplit.uid, storeId: storeOrderRefundSplit.storeId, supplierId: storeOrderRefundSplit.supplierId, sourceOrderId: storeOrderRefundSplit.sourceOrderId, paymentOrderId: storeOrderRefundSplit.paymentOrderId, selectedOrderId: storeOrderRefundSplit.selectedOrderId, disposition: storeOrderRefundSplit.disposition, partitions: sql<unknown>`${storeOrderRefundSplit.partitions}::jsonb` }).from(storeOrderRefundSplit).where(and(eq(storeOrderRefundSplit.refundId, marker.refundId), eq(storeOrderRefundSplit.selectedOrderId, order.id))).limit(2);
    const record = records[0]; if (records.length !== 1 || record.uid !== order.uid || record.storeId !== order.storeId || record.supplierId !== order.supplierId || record.paymentOrderId !== (order.pid || order.id) || record.disposition !== 'split' || !Array.isArray(record.partitions) || record.partitions.length > 200 || order.refundStatus !== 2 || order.refundType !== 6) throw invalid();
    const expected = new Map<number, number>(); for (const value of record.partitions) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(); const part = value as Record<string, unknown>; if (part.selectedNum === 0) { if (part.selectedRowId !== null) throw invalid(); continue; } if (!Number.isSafeInteger(part.selectedRowId) || Number(part.selectedRowId) <= 0 || !Number.isSafeInteger(part.selectedNum) || Number(part.selectedNum) <= 0 || expected.has(Number(part.selectedRowId))) throw invalid(); expected.set(Number(part.selectedRowId), Number(part.selectedNum)); }
    if (expected.size !== carts.length || carts.some(row => expected.get(row.id) !== row.cartNum || row.cartId !== String(row.id) || row.refundNum !== row.cartNum)) throw invalid();
    const rows = await db.select(boundedRefund).from(storeOrderRefund).where(eq(storeOrderRefund.id, record.refundId)).limit(1), refund = rows[0] ? checkedRefund(rows[0]) : null;
    if (!refund || refund.storeOrderId !== record.sourceOrderId || refund.uid !== order.uid || refund.storeId !== order.storeId || refund.supplierId !== order.supplierId || refund.refundType !== 6 || refund.isDel || refund.isCancel || refund.refundedPrice !== refund.refundPrice || await refundOrderSplitFingerprint(refund) !== record.fingerprint) throw invalid();
    return [...direct.filter(row => row.id !== refund.id), refund];
  }
  private async renderCarts<T extends { cartInfo: ReturnType<typeof cartProjection>[] }>(list: T[]) { const pictures = await renderProductPictures(this.env.APP_KEY, list.flatMap(row => row.cartInfo.map(cart => cart.productInfo.image))); let i = 0; for (const row of list) for (const cart of row.cartInfo) { cart.productInfo.image = pictures[i]; cart.productInfo.attrInfo.image = pictures[i++]; } return list; }
  async orders(actor: CustomerWorkActor, query: Record<string, string> = {}, now = Math.floor(Date.now() / 1000)) {
    customerWorkQueryKeys(query, ['status', 'is_del', 'type', 'pay_type', 'field_key', 'keyword', 'data', 'page', 'limit']);
    const selector = query.status === undefined || query.status === '' ? null : integer(query.status, 0, -4, 9, '订单状态'), isDel = integer(query.is_del, 0, 0, 1, '删除筛选'), page = integer(query.page, 1, 1, 10000, '页码'), limit = integer(query.limit, 10, 1, 100, '每页数量'), keyword = text(query.keyword), field = query.field_key ?? '';
    if (selector === -4 && isDel !== 1 || selector !== null && selector !== -4 && isDel === 1 || !['', 'all', 'uid', 'order_id', 'real_name', 'user_phone', 'title', 'total_num'].includes(field)) throw new ValidateException('订单筛选合同无效');
    const conditions: SQL[] = [eq(storeOrder.isSystemDel, 0), eq(storeOrder.isDel, isDel), orderReadStatusPredicate(selector)]; if (selector === null || selector >= 0 || selector === -4) conditions.push(gte(storeOrder.pid, 0));
    if (query.type !== undefined && query.type !== '') { const type = integer(query.type, 0, 0, 107, '订单类型'); if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 105, 106, 107].includes(type)) throw new ValidateException('订单类型无效'); conditions.push(type === 105 ? eq(storeOrder.shippingType, 2) : type === 106 ? eq(storeOrder.shippingType, 4) : type === 107 ? inArray(storeOrder.shippingType, [1, 3]) : eq(storeOrder.type, type)); }
    if (query.pay_type) conditions.push(eq(storeOrder.payType, ['', 'weixin', 'yue', 'offline', 'alipay', 'integral'][integer(query.pay_type, 1, 1, 5, '支付类型')]));
    if (query.data) { const r = parseAdminStatisticRange(query.data, now); conditions.push(sql`${storeOrder.addTime}>=${r.start} AND ${storeOrder.addTime}<${r.endExclusive}`); }
    if (keyword) { const match = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`, title = sql`EXISTS(SELECT 1 FROM store_order_cart_info c JOIN store_product p ON p.id=c.product_id WHERE c.oid=${storeOrder.id} AND c.uid=${storeOrder.uid} AND(p.store_name ILIKE ${match} OR p.keyword ILIKE ${match}))`; if (field === 'uid' || field === 'total_num') conditions.push(eq(field === 'uid' ? storeOrder.uid : storeOrder.totalNum, integer(keyword, 0, 0, 2147483647, '数字搜索'))); else if (field === 'title') conditions.push(title); else if (field && field !== 'all') conditions.push(eq(field === 'order_id' ? storeOrder.orderId : field === 'real_name' ? storeOrder.realName : storeOrder.userPhone, keyword)); else conditions.push(or(ilike(storeOrder.orderId, match), ilike(storeOrder.realName, match), ilike(storeOrder.userPhone, match), title, sql`EXISTS(SELECT 1 FROM "user" u WHERE u.uid=${storeOrder.uid} AND(u.nickname ILIKE ${match} OR u.phone ILIKE ${match} OR u.uid::text ILIKE ${match}))`)!); }
    const result = await this.snapshot(actor, query, async db => { const orders = (await db.select(boundedOrder).from(storeOrder).where(and(...conditions)).orderBy(desc(storeOrder.id)).limit(limit).offset((page - 1) * limit)).map(checkedOrder), [count] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(storeOrder).where(and(...conditions)), linked = await this.associations(db, orders); const list = await Promise.all(orders.map(order => this.projectedOrder(db, order, linked.carts.filter(row => row.oid === order.id), linked.refunds.filter(row => row.storeOrderId === order.id)))); return { list, count: count.count, page, limit, has_more: page * limit < count.count }; }); await this.renderCarts(result.data.list); return result;
  }
  async orderDetail(actor: CustomerWorkActor, value: unknown, query: Record<string, string> = {}) {
    customerWorkQueryKeys(query, []); const result = await this.snapshot(actor, query, async db => { const order = await this.order(db, value), linked = await this.associations(db, [order]), projected = await this.projectedOrder(db, order, linked.carts, linked.refunds), [customer] = await db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar }).from(user).where(eq(user.uid, order.uid)).limit(1), split = order.pid === -1 ? (await db.select(boundedOrder).from(storeOrder).where(and(eq(storeOrder.pid, order.id), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).orderBy(asc(storeOrder.id)).limit(201)).map(checkedOrder) : [];
      if (split.length > 200 || split.some(child => child.uid !== order.uid || child.storeId !== order.storeId || child.supplierId !== order.supplierId)) throw new ValidateException('拆单父子归属异常');
      const vip = projected.cartInfo.reduce((sum, row) => sum + cents(row.vip_sum_truePrice), 0n), total = cents(projected.total_price); if (vip > total) throw new ValidateException('订单会员优惠金额异常');
      return { ...projected, total_price: decimal(total - vip), vip_true_price: decimal(vip), customer: { uid: order.uid, nickname: customer?.nickname ?? '', avatar: (await userPictures(db, order.uid, [customer?.avatar ?? '']))[0] }, split: split.map(child => ({ id: child.id, pid: child.pid, order_id: child.orderId, paid: child.paid, status: child.status, total_num: child.totalNum, pay_price: child.payPrice, delivery_type: child.deliveryType, delivery_name: child.deliveryName, delivery_code: child.deliveryCode, delivery_id: child.deliveryId })), custom_form: parsedJson(order.customForm), refund_reason_wap: order.refundReasonWap, refund_reason_wap_explain: order.refundReasonWapExplain, refund_reason_time: order.refundReasonTime, refund_img: await userPictures(db, order.uid, pictureList(order.refundReasonWapImg)), refund_goods_img: await userPictures(db, order.uid, linked.refunds.flatMap(refund => pictureList(refund.refundGoodsImg))) };
    }); await this.renderCarts([result.data]); const refs = await renderProductPictures(this.env.APP_KEY, [result.data.customer.avatar, ...result.data.refund_img, ...result.data.refund_goods_img]); result.data.customer.avatar = refs[0]; result.data.refund_img = refs.slice(1, 1 + result.data.refund_img.length); result.data.refund_goods_img = refs.slice(1 + result.data.refund_img.length); return result;
  }
  private async refund(db: DbClient, value: unknown): Promise<Refund> { const ref = number(value), id = /^\d{1,10}$/.test(ref) && Number(ref) <= 2147483647 ? Number(ref) : null, rows = await db.select(boundedRefund).from(storeOrderRefund).where(and(id !== null ? or(eq(storeOrderRefund.id, id), eq(storeOrderRefund.orderId, ref)) : eq(storeOrderRefund.orderId, ref), eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0))).orderBy(asc(storeOrderRefund.id)).limit(2); if (rows.length !== 1) throw new NotFoundException('退款不存在或编号有歧义'); return checkedRefund(rows[0]); }
  private async refundOrder(db: DbClient, refund: Refund) { const [row] = await db.select(boundedOrder).from(storeOrder).where(and(eq(storeOrder.id, refund.storeOrderId), eq(storeOrder.isSystemDel, 0))).limit(1); if (!row || row.uid !== refund.uid || row.storeId !== refund.storeId || row.supplierId !== refund.supplierId) throw new ValidateException('退款与原订单归属不一致'); return checkedOrder(row); }
  private async projectedRefund(db: DbClient, refund: Refund, order: Order, carts: Cart[]) { const projected = refundProjection(refund, carts); const images = await publicProductPictures(db, projected.cartInfo.map(cart => ({ image: cart.productInfo.image, type: order.supplierId > 0 ? 2 : 0, relationId: order.supplierId > 0 ? order.supplierId : 0 }))); for (const [index, cart] of projected.cartInfo.entries()) { for (const key of ['truePrice', 'vip_truePrice', 'vip_sum_truePrice', 'sum_true_price', 'postage_price', 'coupon_price', 'integral_price', 'promotions_true_price'] as const) cart[key] = managerMoney(cart[key]); cart.productInfo.price = managerMoney(cart.productInfo.price); cart.productInfo.attrInfo.price = managerMoney(cart.productInfo.attrInfo.price); cart.productInfo.image = images[index]; cart.productInfo.attrInfo.image = images[index]; } return { ...projected, store_order_sn: order.orderId, pay_type: order.payType, shipping_type: order.shippingType, write_available: false }; }
  async refunds(actor: CustomerWorkActor, query: Record<string, string> = {}) {
    customerWorkQueryKeys(query, ['order_id', 'time', 'refundTypes', 'apply_type', 'page', 'limit']); const q = parseAdminRefundListQuery(query); if (q.page > 10000) throw new ValidateException('页码超过安全读取范围'); const conditions: SQL[] = [eq(storeOrderRefund.isCancel, 0), eq(storeOrderRefund.isDel, 0)], types = refundTypesForFilter(q.refundTypes); if (types) conditions.push(inArray(storeOrderRefund.refundType, [...types])); if (q.applyType !== null) conditions.push(eq(storeOrderRefund.applyType, q.applyType)); if (q.startTime !== undefined) conditions.push(gte(storeOrderRefund.addTime, q.startTime)); if (q.endTime !== undefined) conditions.push(sql`${storeOrderRefund.addTime}<=${q.endTime}`); if (q.keyword) { const match = `%${q.keyword.replace(/[\\%_]/g, '\\$&')}%`; conditions.push(or(ilike(storeOrderRefund.orderId, match), sql`EXISTS(SELECT 1 FROM store_order o WHERE o.id=${storeOrderRefund.storeOrderId} AND(o.order_id ILIKE ${match} OR o.real_name ILIKE ${match} OR o.user_phone ILIKE ${match}))`)!); }
    const result = await this.snapshot(actor, query, async db => { const refunds = (await db.select(boundedRefund).from(storeOrderRefund).where(and(...conditions)).orderBy(desc(storeOrderRefund.id)).limit(q.limit).offset((q.page - 1) * q.limit)).map(checkedRefund), [count] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(storeOrderRefund).where(and(...conditions)), orders = await Promise.all(refunds.map(refund => this.refundOrder(db, refund))), linked = await this.associations(db, [...new Map(orders.map(order => [order.id, order])).values()]), list = await Promise.all(refunds.map((refund, i) => this.projectedRefund(db, refund, orders[i], linked.carts.filter(cart => cart.oid === orders[i].id)))); return { list, count: count.count, page: q.page, limit: q.limit, has_more: q.page * q.limit < count.count }; }); await this.renderCarts(result.data.list); return result;
  }
  async refundDetail(actor: CustomerWorkActor, value: unknown, query: Record<string, string> = {}) {
    customerWorkQueryKeys(query, []); const result = await this.snapshot(actor, query, async db => { const refund = await this.refund(db, value), order = await this.refundOrder(db, refund), linked = await this.associations(db, [order]); return { ...await this.projectedRefund(db, refund, order, linked.carts), real_name: order.realName, user_phone: order.userPhone, user_address: order.userAddress, custom_form: parsedJson(order.customForm), refund_img: await userPictures(db, refund.uid, pictureList(refund.refundImg)), refund_goods_img: await userPictures(db, refund.uid, pictureList(refund.refundGoodsImg)) }; }); await this.renderCarts([result.data]); const refs = await renderProductPictures(this.env.APP_KEY, [...result.data.refund_img, ...result.data.refund_goods_img]); result.data.refund_img = refs.slice(0, result.data.refund_img.length); result.data.refund_goods_img = refs.slice(result.data.refund_img.length); return result;
  }
  async logistics(actor: CustomerWorkActor, value: unknown, query: Record<string, string> = {}) {
    customerWorkQueryKeys(query, ['type']); if (query.type !== undefined && query.type !== '' && query.type !== 'refund') throw new ValidateException('物流类型无效');
    const snapshot = () => this.snapshot(actor, query, async db => { if (query.type === 'refund') { const refund = await this.refund(db, value), order = await this.refundOrder(db, refund); return { orders: [order], refund }; } const root = await this.order(db, value), children = root.pid === -1 || root.deliveryType === 'split' ? (await db.select(boundedOrder).from(storeOrder).where(and(eq(storeOrder.pid, root.id), eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0))).orderBy(asc(storeOrder.id)).limit(51)).map(checkedOrder) : []; if (children.length > 50 || children.some(child => child.uid !== root.uid || child.storeId !== root.storeId || child.supplierId !== root.supplierId)) throw new ValidateException('拆单物流包裹归属异常'); return { orders: [root, ...children], refund: null }; });
    const initial = await snapshot(), authorize = async () => { const fresh = await snapshot(); if (fresh.scope_key !== initial.scope_key || fresh.consistency_key !== initial.consistency_key) throw new ValidateException('工作台身份或物流依据已变化，请重新读取'); };
    await authorize(); const service = new ExpressService(this.container, this.env), data = initial.data.refund ? await service.query(initial.data.refund.uid, initial.data.refund.orderId, 'refund') : await service.queryScopedOrders(initial.data.orders, authorize, { allowUserDeleted: true }); await authorize(); return { ...initial, data: { ...data, metric_scopes: CUSTOMER_WORK_METRIC_SCOPES } };
  }
}
