export const RECHARGE_REFUND_PERMISSION = 'recharge_order.refund';

/** Closed versioned namespace. Reads of durable keys and execution state use
 * POST to keep keys out of URLs; all require the dedicated money capability. */
export function rechargeRefundRoutePermission(method: string, route: string): string | null {
  if (method.toUpperCase() !== 'POST') return null;
  if (['finance/recharge-refunds/receipt', 'finance/recharge-refunds/execution', 'finance/recharge-refunds/query'].includes(route)) {
    return RECHARGE_REFUND_PERMISSION;
  }
  const parts = route.split('/');
  if (parts.length !== 4 || parts[0] !== 'finance' || parts[1] !== 'recharge-refunds'
    || !['quote', 'execute', 'abandon', 'cancel'].includes(parts[2])) return null;
  const id = parts[3];
  if (id === ':id' || id === '<id>' || /^[1-9]\d{0,9}$/.test(id) && String(Number(id)) === id && Number(id) <= 2_147_483_647) {
    return RECHARGE_REFUND_PERMISSION;
  }
  return null;
}
