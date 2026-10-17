import { apiRequest } from './http';

export interface PendingProactiveRefund { operation_id: string; actor_id: number; supplier_id: number; order_id: number }
export interface ProactiveRefundSeed {
  order_id: number; order_no: string; amount: string; paid: string; refunded: string; pay_type: string;
  settlement: 'cash' | 'balance' | 'provider' | 'zero'; kind: 'goods' | 'money'; quantity: number; revision: string;
}
export interface ProactiveRefundResult {
  order_id: number; refund_id: number | null; amount: string; kind: 'goods' | 'money' | 'refuse';
  status: 'CASH_SUCCESS' | 'BALANCE_SUCCESS' | 'ZERO_SUCCESS' | 'REFUSED';
}
export interface ProactiveRefundReceipt extends PendingProactiveRefund {
  state: 'unknown' | 'committed' | 'not_applied'; result: ProactiveRefundResult | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const money = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;
const id = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const cents = (value: string) => BigInt(value.replace('.', ''));
const fail = () => Error('主动退款资料或原操作身份不完整，请保留原记录并重新核对');
export const proactiveRefundStorageKey = (actor: number, supplier: number) => `supplier_proactive_refund_pending_v1:${supplier}:${actor}`;
export function parsePendingProactiveRefund(value: unknown, actor: number, supplier: number): PendingProactiveRefund {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'actor_id,operation_id,order_id,supplier_id'
    || !id(actor) || !id(supplier) || value.actor_id !== actor || value.supplier_id !== supplier || !id(value.order_id)
    || typeof value.operation_id !== 'string' || !uuid.test(value.operation_id)) throw fail();
  return { operation_id: value.operation_id, actor_id: actor, supplier_id: supplier, order_id: value.order_id };
}
export function parseProactiveRefundSeed(value: unknown, orderId: number): ProactiveRefundSeed {
  if (!id(orderId) || !object(value) || value.order_id !== orderId || value.action !== `/order/refund/${orderId}` || value.method !== 'PUT'
    || typeof value.order_no !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(value.order_no)
    || !['goods', 'money'].includes(String(value.kind)) || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
    || !['cash', 'offline', 'yue', 'weixin', 'alipay'].includes(String(value.pay_type))
    || ![value.refund_price, value.paid, value.refunded].every(amount => typeof amount === 'string' && money.test(amount))
    || !Number.isSafeInteger(value.quantity) || Number(value.quantity) < 0
    || (value.kind === 'money' ? value.quantity !== 0 : !id(value.quantity))) throw fail();
  const amount = value.refund_price as string, paid = value.paid as string, refunded = value.refunded as string;
  if (cents(paid) < cents(refunded) || cents(amount) !== cents(paid) - cents(refunded)
    || value.kind === 'money' && cents(amount) <= 0n) throw fail();
  const settlement = amount === '0.00' ? 'zero' : value.pay_type === 'yue' ? 'balance'
    : ['cash', 'offline'].includes(String(value.pay_type)) ? 'cash' : 'provider';
  if (value.settlement !== settlement) throw fail();
  return { order_id: orderId, order_no: value.order_no, amount, paid, refunded, pay_type: value.pay_type as string,
    settlement, kind: value.kind as ProactiveRefundSeed['kind'], quantity: value.quantity as number, revision: value.revision };
}
export function proactiveRefundPayload(seed: ProactiveRefundSeed, pending: PendingProactiveRefund, input: string, type: 1 | 2, cash: boolean) {
  parsePendingProactiveRefund(pending, pending.actor_id, pending.supplier_id);
  if (pending.order_id !== seed.order_id || ![1, 2].includes(type)) throw fail();
  if (typeof input !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(input.trim())) throw Error('退款金额最多保留两位小数');
  const [whole, fraction = ''] = input.trim().split('.'), amount = `${BigInt(whole!).toString()}.${fraction.padEnd(2, '0')}`;
  if (!money.test(amount) || cents(amount) > cents(seed.amount) || cents(amount) === 0n && seed.paid !== '0.00') throw Error('退款金额须在当前可退金额内，且大于零');
  if (type === 1 && seed.settlement === 'provider') throw Error('此订单暂不支持原渠道退款');
  const physical = type === 1 && seed.settlement === 'cash' && amount !== '0.00';
  if (physical && cash !== true) throw Error('请确认已向买家实际退还本次现金');
  return { operation_id: pending.operation_id, revision: seed.revision, refund_price: amount, type,
    ...(physical ? { cash_returned: true as const } : {}) };
}
export function parseProactiveRefundReceipt(value: unknown, identity: PendingProactiveRefund): ProactiveRefundReceipt {
  const pending = parsePendingProactiveRefund(identity, identity.actor_id, identity.supplier_id);
  if (!object(value) || Object.keys(value).sort().join(',') !== 'actor_id,operation_id,order_id,result,state,supplier_id'
    || value.operation_id !== pending.operation_id || value.actor_id !== pending.actor_id || value.supplier_id !== pending.supplier_id
    || !['unknown', 'committed', 'not_applied'].includes(String(value.state))
    || (value.state === 'unknown' ? value.order_id !== null : value.order_id !== pending.order_id)) throw fail();
  if (value.state !== 'committed') {
    if (value.result !== null) throw fail();
    return { ...pending, state: value.state as 'unknown' | 'not_applied', result: null };
  }
  const result = value.result;
  if (!object(result) || Object.keys(result).sort().join(',') !== 'amount,kind,order_id,refund_id,status'
    || result.order_id !== pending.order_id || typeof result.amount !== 'string' || !money.test(result.amount)
    || !['goods', 'money', 'refuse'].includes(String(result.kind))) throw fail();
  if (result.kind === 'refuse') {
    if (result.refund_id !== null || result.status !== 'REFUSED') throw fail();
  } else if (!id(result.refund_id) || !['CASH_SUCCESS', 'BALANCE_SUCCESS', 'ZERO_SUCCESS'].includes(String(result.status))
    || (result.amount === '0.00') !== (result.status === 'ZERO_SUCCESS') || result.kind === 'money' && result.amount === '0.00') throw fail();
  return { ...pending, state: 'committed', result: { order_id: pending.order_id, refund_id: result.refund_id as number | null,
    amount: result.amount, kind: result.kind as ProactiveRefundResult['kind'], status: result.status as ProactiveRefundResult['status'] } };
}
export async function getProactiveRefundSeed(orderId: number, signal?: AbortSignal) {
  if (!id(orderId)) throw fail();
  return parseProactiveRefundSeed(await apiRequest({ method: 'GET', url: `/order/refund/${orderId}`, signal }), orderId);
}
export async function saveProactiveRefund(seed: ProactiveRefundSeed, pending: PendingProactiveRefund, body: ReturnType<typeof proactiveRefundPayload>) {
  const result = parseProactiveRefundReceipt(await apiRequest({ method: 'PUT', url: `/order/refund/${pending.order_id}`, data: body }), pending);
  if (result.state === 'committed' && (result.result!.amount !== body.refund_price || result.result!.kind !== (body.type === 2 ? 'refuse' : seed.kind)))
    throw Error('已提交结果与原确认内容不一致，请查询原操作');
  return result;
}
export async function recoverProactiveRefund(pending: PendingProactiveRefund, resolve = false) {
  parsePendingProactiveRefund(pending, pending.actor_id, pending.supplier_id);
  return parseProactiveRefundReceipt(await apiRequest({ method: resolve ? 'POST' : 'GET',
    url: `/order/refund_operations/${pending.operation_id}${resolve ? '/resolve' : ''}`,
    ...(resolve ? { data: { order_id: pending.order_id } } : {}) }), pending);
}
