import type { OrderListRow } from './orderListState';

/** UI admission only. The server rechecks ownership, refund claims and state under lock. */
export function canDeleteOrder(order: OrderListRow & { is_del?: number; is_system_del?: number }): boolean {
  if (!Number.isSafeInteger(order.id) || order.id <= 0 || !Number.isSafeInteger(order.uid) || order.uid <= 0
    || typeof order.order_id !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(order.order_id)
    || !Number.isSafeInteger(order.pid) || order.pid < 0
    || !Number.isSafeInteger(order.status)
    || ![0, 2].includes(order.supplier_allocation_status)
    || (order.is_del !== undefined && order.is_del !== 0)
    || (order.is_system_del !== undefined && order.is_system_del !== 0)) return false;
  if (order.paid === 0) return order.refund_status === 0 && [0, -2].includes(order.status);
  return order.paid === 1 && (order.refund_status === 2 || (order.status === 3 && order.refund_status === 0));
}

export function orderDeleteRequest(id: unknown): { order_id: string } {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(id)) throw Error('订单标识无效，请刷新列表');
  return { order_id: id };
}

export function orderDeleteConfirmation(order: OrderListRow): string {
  if (!canDeleteOrder(order)) throw Error('订单状态不允许删除，请刷新列表');
  return order.paid === 0 && order.status === 0
    ? `确认取消并删除未付款订单 ${order.order_id}？将释放库存、优惠券和抵扣积分，订单将从列表隐藏。`
    : `确认从列表删除订单 ${order.order_id}？此操作不会发起退款，已有售后退款记录仍会保留。`;
}

export function assertOrderDeleteResult(value: unknown): void {
  if (value !== null) throw Error('删除响应无效，请刷新列表核对');
}
