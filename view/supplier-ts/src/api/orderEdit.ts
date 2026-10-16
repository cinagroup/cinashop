import { apiRequest } from './http';
export interface OrderEditValues { order_id: string; total_price: string; total_postage: string; pay_postage: string; pay_price: string; gain_integral: string }
export interface OrderEditSeed { title: string; action: string; method: 'PUT'; revision: string; values: OrderEditValues }
export interface PendingOrderEdit { operation_id: string; actor_id: number; supplier_id: number; order_id: number }
export interface OrderEditReceipt extends Omit<PendingOrderEdit, 'order_id'> {
  order_id: number | null; state: 'unknown' | 'committed' | 'not_applied';
  result: null | { id: number; order_id: string; pay_price: string; change_price: string; gain_integral: string; changed: boolean };
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const money = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const orderEditStorageKey = (actor: number, supplier: number) => `supplier_order_edit_pending_v1:${supplier}:${actor}`;
export function parsePendingOrderEdit(value: unknown, actor: number, supplier: number): PendingOrderEdit {
  if (!object(value) || Object.keys(value).length !== 4 || value.actor_id !== actor || value.supplier_id !== supplier
    || !positive(actor) || !positive(supplier) || !positive(value.order_id) || typeof value.operation_id !== 'string' || !uuid.test(value.operation_id))
    throw Error('待确认订单编辑记录无效，请保留本窗口并核对原操作');
  return value as unknown as PendingOrderEdit;
}
export function parseOrderEditSeed(value: unknown, id: number): OrderEditSeed {
  if (!positive(id) || !object(value) || value.method !== 'PUT' || value.action !== `/order/update/${id}` || value.title !== '修改订单'
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision) || !object(value.values)) throw Error('订单编辑资料或版本不完整');
  const values = value.values;
  if (Object.keys(values).length !== 6 || typeof values.order_id !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(values.order_id)
    || ['total_price', 'total_postage', 'pay_postage', 'pay_price'].some(field => typeof values[field] !== 'string' || !money.test(String(values[field])))
    || typeof values.gain_integral !== 'string' || !/^(?:0|[1-9]\d{0,9})$/.test(values.gain_integral)) throw Error('订单编辑金额或积分无效');
  return value as unknown as OrderEditSeed;
}
export function parseOrderEditReceipt(value: unknown, pending: PendingOrderEdit): OrderEditReceipt {
  if (!object(value) || Object.keys(value).length !== 6 || value.operation_id !== pending.operation_id || value.actor_id !== pending.actor_id
    || value.supplier_id !== pending.supplier_id || !['unknown', 'committed', 'not_applied'].includes(String(value.state))
    || (value.state === 'unknown' ? value.order_id !== null : value.order_id !== pending.order_id)) throw Error('订单编辑回执身份、订单或操作编号不一致');
  if (value.state === 'committed') {
    const result = value.result;
    if (!object(result) || Object.keys(result).length !== 6 || result.id !== pending.order_id || typeof result.order_id !== 'string'
      || !/^[A-Za-z0-9]{1,32}$/.test(result.order_id) || typeof result.pay_price !== 'string' || !money.test(result.pay_price)
      || typeof result.change_price !== 'string' || !/^-?(?:0|[1-9]\d{0,5})\.\d{2}$/.test(result.change_price)
      || typeof result.gain_integral !== 'string' || !/^(?:0|[1-9]\d{0,9})\.00$/.test(result.gain_integral)
      || typeof result.changed !== 'boolean') throw Error('订单编辑已提交回执不完整');
  } else if (value.result !== null) throw Error('订单编辑回执状态不一致');
  return value as unknown as OrderEditReceipt;
}
export function orderEditPayload(seed: OrderEditSeed, pending: PendingOrderEdit, payPrice: string, gainIntegral: string) {
  if (seed.action !== `/order/update/${pending.order_id}` || seed.method !== 'PUT') throw Error('订单编辑上下文已变化');
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(payPrice) || !/^(?:0|[1-9]\d{0,9})$/.test(gainIntegral)) throw Error('请填写最多两位小数的非负金额和非负整数积分');
  return { ...seed.values, pay_price: payPrice, gain_integral: gainIntegral, operation_id: pending.operation_id, revision: seed.revision };
}
export async function getOrderEditSeed(id: number, signal?: AbortSignal): Promise<OrderEditSeed> {
  return parseOrderEditSeed(await apiRequest({ method: 'GET', url: `/order/edit/${id}`, signal }), id);
}
export async function saveOrderEdit(pending: PendingOrderEdit, body: ReturnType<typeof orderEditPayload>): Promise<OrderEditReceipt> {
  if (body.operation_id !== pending.operation_id) throw Error('订单编辑操作已变化');
  const receipt = parseOrderEditReceipt(await apiRequest({ method: 'PUT', url: `/order/update/${pending.order_id}`, data: body }), pending);
  const [whole, fraction = ''] = body.pay_price.split('.');
  if (receipt.state === 'committed' && (receipt.result?.order_id !== body.order_id
    || receipt.result.pay_price !== `${whole}.${fraction.padEnd(2, '0')}` || receipt.result.gain_integral !== body.gain_integral + '.00'))
    throw Error('订单编辑结果与原提交金额或积分不一致，请核对原操作');
  return receipt;
}
export async function recoverOrderEdit(pending: PendingOrderEdit, resolve = false): Promise<OrderEditReceipt> {
  return parseOrderEditReceipt(await apiRequest({ method: resolve ? 'POST' : 'GET', url: `/order/edit_operations/${pending.operation_id}${resolve ? '/resolve' : ''}`,
    ...(resolve ? { data: { order_id: pending.order_id } } : {}) }), pending);
}
