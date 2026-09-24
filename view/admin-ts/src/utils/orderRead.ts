import type { AdminOrder } from '@/types/admin';

const invalid = () => Error('订单响应不完整或不一致，请刷新后核对');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0, max = 2147483647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
}
function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || value.length > max) throw invalid();
  return value;
}
function money(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}(\.\d{1,2})?$/.test(value)) throw invalid();
  return value;
}
export function orderNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw Error('订单号无效');
  return value;
}
export interface AdminOrderSplit {
  id: number; orderId: string; pid: number; uid: number; paid: number; status: number;
  refundStatus: number; refundType: number; totalNum: number; payPrice: string; shippingType: number;
}
function split(value: unknown): AdminOrderSplit {
  const row = record(value);
  return { id: integer(row.id, 1), orderId: orderNumber(row.orderId), pid: integer(row.pid, -1), uid: integer(row.uid, 1),
    paid: integer(row.paid, 0, 1), status: integer(row.status, -2, 5), refundStatus: integer(row.refundStatus, 0, 3),
    refundType: integer(row.refundType, 0, 6), totalNum: integer(row.totalNum), payPrice: money(row.payPrice),
    shippingType: integer(row.shippingType, 1, 4) };
}
function header(value: unknown): AdminOrder {
  const row = record(value);
  if (row.isDel !== 0 || row.isSystemDel !== 0) throw invalid();
  return { ...split(row), realName: text(row.realName), userPhone: text(row.userPhone), totalPrice: money(row.totalPrice),
    payType: text(row.payType), productType: integer(row.productType, 0, 4), deliveryType: text(row.deliveryType),
    addTime: integer(row.addTime), remark: text(row.remark) };
}
export interface AdminOrderQuery { page?: number; limit?: number; order_id?: string; status?: number; paid?: number }
export interface AdminOrderChart {
  all: number; unpaid: number; unshipped: number; untake: number; unevaluate: number; complete: number;
}
export function parseAdminOrderChart(value: unknown): AdminOrderChart {
  const row = record(value);
  const keys: Array<keyof AdminOrderChart> = ['all', 'unpaid', 'unshipped', 'untake', 'unevaluate', 'complete'];
  if (Object.keys(row).length !== keys.length) throw invalid();
  const counts = Object.fromEntries(keys.map(key => [key, integer(row[key])])) as unknown as AdminOrderChart;
  if (counts.unpaid + counts.unshipped + counts.untake + counts.unevaluate + counts.complete > counts.all) throw invalid();
  return counts;
}
export function parseAdminOrderList(value: unknown, query: AdminOrderQuery) {
  const row = record(value), page = integer(row.page, 1, 10000), limit = integer(row.limit, 1, 100), total = integer(row.total);
  if (page !== (query.page ?? 1) || limit !== (query.limit ?? 10) || !Array.isArray(row.list)) throw invalid();
  const expected = Math.max(0, Math.min(limit, total - (page - 1) * limit));
  if (row.list.length !== expected) throw invalid();
  const list = row.list.map(header);
  if (list.some(item => item.pid < 0) || new Set(list.map(item => item.id)).size !== list.length
    || new Set(list.map(item => item.orderId)).size !== list.length) throw invalid();
  return { list, total, page, limit };
}
export interface AdminOrderCart { id: number; cartId: string; cartNum: number; name: string; image: string; sku: string; price: string | null }
export interface AdminOrderDetail extends AdminOrder {
  province: string; userAddress: string; totalPostage: string; payIntegral: number; useIntegral: string; deductionPrice: string; gainIntegral: string; mark: string;
  cartInfo: AdminOrderCart[]; splitOrders: AdminOrderSplit[];
}
function optionalRecord(value: unknown): Record<string, unknown> { return value == null ? {} : record(value); }
function cart(value: unknown, order: AdminOrder): AdminOrderCart {
  const row = record(value);
  if (row.oid !== order.id || row.uid !== order.uid) throw invalid();
  const snapshot = optionalRecord(row.cartInfo), product = optionalRecord(snapshot.product ?? snapshot.productInfo);
  const sku = optionalRecord(snapshot.sku ?? product.attrInfo);
  const price = snapshot.sum_price ?? snapshot.truePrice ?? sku.price ?? product.price;
  const image = product.image == null ? '' : text(product.image, 2048);
  // Order snapshots may be old. Missing price is unknown, never invented as zero.
  return { id: integer(row.id, 1), cartId: text(row.cartId, 64), cartNum: integer(row.cartNum, 1),
    name: product.storeName == null && product.store_name == null ? '商品' : text(product.storeName ?? product.store_name),
    image: /^(https?:\/\/|\/(?!\/))/.test(image) ? image : '',
    sku: sku.suk == null ? '默认' : text(sku.suk), price: price == null ? null : money(typeof price === 'number' ? String(price) : price) };
}
export function parseAdminOrderDetail(value: unknown, expectedNumber: string): AdminOrderDetail {
  const row = record(value), order = header(row);
  if (order.orderId !== expectedNumber || !Array.isArray(row.cartInfo) || row.cartInfo.length > 200
    || !Array.isArray(row.splitOrders) || row.splitOrders.length > 200) throw invalid();
  const cartInfo = row.cartInfo.map(item => cart(item, order)), splitOrders = row.splitOrders.map(split);
  if (new Set(cartInfo.map(item => item.id)).size !== cartInfo.length
    || new Set(cartInfo.map(item => item.cartId)).size !== cartInfo.length
    || new Set(splitOrders.map(item => item.id)).size !== splitOrders.length
    || new Set(splitOrders.map(item => item.orderId)).size !== splitOrders.length
    || (order.pid !== -1 && splitOrders.length > 0)
    || splitOrders.some(item => item.pid !== order.id || item.uid !== order.uid || item.id === order.id || item.orderId === order.orderId)) throw invalid();
  return { ...order, cartInfo, splitOrders, province: text(row.province), userAddress: text(row.userAddress),
    totalPostage: money(row.totalPostage), payIntegral: integer(row.payIntegral), useIntegral: money(row.useIntegral),
    deductionPrice: money(row.deductionPrice), gainIntegral: money(row.gainIntegral), mark: text(row.mark) };
}
export function adminOrderStatus(order: AdminOrderSplit & { deliveryType?: string }): string {
  if (order.pid === -1) return '已拆分支付单';
  if (order.refundStatus === 2 || order.refundType === 6) return '已退款';
  if (order.refundStatus === 1) return '退款处理中';
  if (order.status < 0) return '已取消';
  if (order.paid === 0) return '待支付';
  if (order.shippingType === 2 && order.status === 0) return '待到店核销';
  if (order.deliveryType === 'send' && order.status === 1) return '配送中，待送达核销';
  return ({ 0: '待发货', 1: '待收货', 2: '已收货', 3: '已完成', 4: '部分发货', 5: '部分核销' })[order.status] ?? '未知';
}
export function isCurrentFulfillment(order: AdminOrderSplit) {
  return order.pid >= 0 && order.paid === 1 && [0, 3].includes(order.refundStatus) && order.refundType !== 6 && order.status >= 0;
}
