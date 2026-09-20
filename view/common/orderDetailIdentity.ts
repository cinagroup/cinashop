/** Customer order IDs, not database primary keys or arbitrary navigation URLs. */
export function orderDetailId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) throw Error('订单链接无效，请返回订单列表');
  return value;
}

export function orderDetailHashId(hash: string): string | null {
  const route = hash.replace(/^#/, ''), split = route.indexOf('?');
  if ((split < 0 ? route : route.slice(0, split)) !== '/pages/order/detail') return null;
  if (hash.length > 8192) throw Error('订单链接无效');
  const ids = new URLSearchParams(split < 0 ? '' : route.slice(split + 1)).getAll('orderId');
  if (ids.length !== 1) throw Error('订单链接无效');
  return orderDetailId(ids[0]);
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('订单响应无效，请重新加载');
  return value as Record<string, unknown>;
};
const money = (value: unknown) => typeof value === 'string' && /^\d+\.\d{2}$/.test(value) && Number.isSafeInteger(Number(value.replace('.', '')));
const methods = ['yue', 'weixin', 'alipay', 'offline'];

/** These checks bind displayed data; server authorization remains authoritative. */
export function assertOrderDetailIdentity(value: unknown, id: string, uid: number): void {
  const row = record(value);
  if (!Number.isSafeInteger(uid) || uid <= 0 || row.uid !== uid || row.order_id !== id
    || ![0, 1].includes(row.paid as number) || !money(row.pay_price)
    || [row.cart_info, row.custom_form, row.split_orders].some(items => items !== undefined && !Array.isArray(items))) {
    throw Error('订单响应与当前账号或订单不一致，请重新加载');
  }
}

export function assertOrderCashierIdentity(value: unknown, id: string, price: string): void {
  const row = record(value), options = record(row.methods);
  if (row.type !== 'order' || row.order_id !== id || row.paid !== false || row.pay_price !== price
    || !money(row.pay_price) || !money(row.now_money) || typeof row.payable !== 'boolean' || typeof row.zero_pay !== 'boolean'
    || row.zero_pay !== (Number(row.pay_price) === 0)
    || typeof row.payable_reason !== 'string' || ![row.integral, row.pay_integral].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
    || methods.some(method => { const option = options[method]; return !option || typeof option !== 'object' || Array.isArray(option)
      || typeof (option as Record<string, unknown>).enabled !== 'boolean' || typeof (option as Record<string, unknown>).reason !== 'string'; })) {
    throw Error('收银信息已变化或与当前订单不一致，请刷新订单');
  }
}

export function assertOrderPaymentIdentity(value: unknown, id: string, method: string): void {
  const row = record(value);
  if (row.order_id !== id || row.pay_type !== method || !methods.includes(method) || typeof row.paid !== 'boolean') {
    throw Error('支付结果与本次订单不一致，请刷新订单核对');
  }
}
