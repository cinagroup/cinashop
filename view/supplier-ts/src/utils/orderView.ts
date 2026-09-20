import type { ExpressCompany, OrderRow, OrderStatusLog, SplitCartItem, SplitOrder } from '@/types';

export const positiveId = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const text = (value: unknown): value is string => typeof value === 'string';
const money = (value: unknown) => text(value) && value.length <= 40 && /^\d+(\.\d{1,2})?$/.test(value);
function requireContract(valid: unknown): asserts valid {
  if (!valid) throw new Error('订单响应不完整或与当前订单不匹配，请重新读取');
}

// These guards protect rendered identity/controls, not server-side authorization.
export function checkOrder(row: OrderRow) {
  requireContract(row && positiveId(row.id) && text(row.order_id) && text(row.real_name) && text(row.user_phone)
    && text(row.remark) && money(row.pay_price)
    && [row.paid, row.status, row.refund_status, row.product_type, row.shipping_type].every(Number.isInteger));
}
export function checkOrderPage(result: { list: OrderRow[]; count: number }, limit: number) {
  requireContract(result && Array.isArray(result.list) && result.list.length <= limit && Number.isSafeInteger(result.count)
    && result.count >= result.list.length && new Set(result.list.map(row => row?.id)).size === result.list.length);
  result.list.forEach(checkOrder);
}
export function checkOrderDetail(detail: OrderRow & { cart_info: unknown[] }, id: number, logs: OrderStatusLog[], shipments: SplitOrder[]) {
  checkOrder(detail);
  requireContract(detail.id === id && Array.isArray(detail.cart_info) && detail.cart_info.length <= 200);
  requireContract(Array.isArray(logs) && logs.length <= 500 && logs.every(log => log && positiveId(log.id)
    && log.oid === id && text(log.changeMessage) && Number.isInteger(log.changeTime)));
  requireContract(Array.isArray(shipments) && shipments.length <= 200 && shipments.every(row => row && positiveId(row.id)
    && text(row.order_id) && money(row.pay_price) && [row.paid, row.status, row.refund_status, row.total_num].every(Number.isInteger)
    && Array.isArray(row.cart_info) && row.cart_info.length <= 200 && row.cart_info.every(item => item && positiveId(item.id)
      && text(item.product_name) && Number.isSafeInteger(item.cart_num) && item.cart_num >= 0))
    && shipments.reduce((sum, row) => sum + row.cart_info.length, 0) <= 200);
}
export function checkDeliveryInputs(companies: ExpressCompany[], items: SplitCartItem[]) {
  requireContract(Array.isArray(companies) && companies.every(row => row && positiveId(row.id) && text(row.name) && text(row.code))
    && new Set(companies.map(row => row.id)).size === companies.length);
  requireContract(Array.isArray(items) && items.length > 0 && items.length <= 200 && new Set(items.map(row => row?.cart_id)).size === items.length
    && items.every(row => row && positiveId(row.id) && text(row.cart_id) && row.cart_id.length > 0 && text(row.product_name)
      && Number.isSafeInteger(row.cart_num) && positiveId(row.surplus_num) && row.surplus_num <= row.cart_num));
}
export function checkNullReceipt(result: unknown) {
  if (result !== null) throw new Error('提交结果未知，请先核对订单或任务账本，勿重复提交');
}
