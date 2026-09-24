import { adminRequest } from './adminRequest';

export interface AssistedOrderDetail {
  orderNo: string;
  uid: number;
  paid: boolean;
  amount: string;
  quantity: number;
  createdAt: number;
  statusTitle: string;
  payType: 'weixin' | 'alipay' | 'cash' | 'other';
  shippingType: number;
  split: boolean;
  items: Array<{ id: number; productId: number; name: string; sku: string; quantity: number; price: string }>;
}

export function validAssistedOrderNo(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('订单详情响应格式错误');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw Error('订单详情数值无效');
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw Error('订单详情文字无效');
  return value;
}
function amount(value: unknown): string {
  const result = text(value, 16);
  if (!/^\d{1,10}\.\d{2}$/.test(result)) throw Error('订单详情金额无效');
  return result;
}

export async function apiAssistedOrderDetail(orderNo: string): Promise<AssistedOrderDetail> {
  if (!validAssistedOrderNo(orderNo)) throw Error('订单号无效');
  const row = object(await adminRequest('GET', `admin/order/place/detail/${encodeURIComponent(orderNo)}`, {}, 'order.assisted'));
  if (row.order_id !== orderNo || !validAssistedOrderNo(row.order_id) || ![0, 1].includes(row.paid as number)
    || typeof row.split !== 'boolean') throw Error('订单详情不属于当前请求');
  const rawItems = row.items;
  if (!Array.isArray(rawItems) || rawItems.length > 200) throw Error('订单商品响应格式错误');
  const items = rawItems.map(value => {
    const item = object(value);
    return { id: integer(item.id, 1), productId: integer(item.product_id), name: text(item.store_name, 255),
      sku: text(item.suk, 255), quantity: integer(item.cart_num, 1), price: amount(item.price) };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) throw Error('订单商品响应存在重复项');
  const payType = row.pay_type === 'weixin' || row.pay_type === 'alipay' || row.pay_type === 'cash'
    ? row.pay_type : 'other';
  return { orderNo, uid: integer(row.uid), paid: row.paid === 1, amount: amount(row.pay_price),
    quantity: integer(row.total_num), createdAt: integer(row.add_time),
    statusTitle: text(object(row._status)._title, 100), payType,
    shippingType: integer(row.shipping_type), split: row.split, items };
}
