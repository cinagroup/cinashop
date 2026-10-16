import { apiRequest } from './http';
export type CashOperationKind = 'payment' | 'refund';
export interface PendingCashOperation { operation_id: string; actor_id: number; supplier_id: number; subject_id: number; kind: CashOperationKind }
export interface CashSeed { kind: CashOperationKind; subject_id: number; order_no: string; amount: string; revision: string; cash_required: boolean; gain_integral?: string }
export interface CashReceipt { operation_id: string; actor_id: number; supplier_id: number; subject_id: number | null; state: 'unknown' | 'committed' | 'not_applied'; amount: string | null }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const money = /^(?:0|[1-9]\d{0,9})\.\d{2}$/;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const cashOperationStorageKey = (kind: CashOperationKind, actor: number, supplier: number) => `supplier_cash_${kind}_pending_v1:${supplier}:${actor}`;
export function parsePendingCashOperation(value: unknown, kind: CashOperationKind, actor: number, supplier: number): PendingCashOperation {
  if (!object(value) || Object.keys(value).length !== 5 || value.kind !== kind || value.actor_id !== actor || value.supplier_id !== supplier
    || !positive(actor) || !positive(supplier) || !positive(value.subject_id) || typeof value.operation_id !== 'string' || !uuid.test(value.operation_id))
    throw Error('待确认收退款记录无效，请保留本窗口并核对原操作');
  return value as unknown as PendingCashOperation;
}
export function parseCashSeed(value: unknown, kind: CashOperationKind, id: number): CashSeed {
  if (!positive(id) || !object(value) || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw Error('收退款资料或版本不完整');
  const amount = kind === 'payment' ? value.amount : value.refund_price, orderNo = kind === 'payment' ? value.order_no : value.refund_no;
  if (typeof amount !== 'string' || !money.test(amount) || typeof orderNo !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(orderNo)
    || (kind === 'payment' ? value.id !== id || typeof value.cash_required !== 'boolean' || value.cash_required !== (amount !== '0.00')
      : value.refund_id !== id || !positive(value.order_id) || !['cash', 'offline'].includes(String(value.pay_type))
        || value.settlement !== (amount === '0.00' ? 'zero' : 'cash'))) throw Error('原订单、实际金额或现金确认资料不完整');
  if (kind === 'payment' && (typeof value.gain_integral !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.00)?$/.test(value.gain_integral))) throw Error('原订单积分不完整');
  return { kind, subject_id: id, order_no: orderNo, amount, revision: value.revision, cash_required: amount !== '0.00',
    ...(kind === 'payment' ? { gain_integral: value.gain_integral as string } : {}) };
}
export function parseCashReceipt(value: unknown, pending: PendingCashOperation): CashReceipt {
  const field = pending.kind === 'payment' ? 'order_id' : 'refund_id';
  if (!object(value) || Object.keys(value).length !== 6 || value.operation_id !== pending.operation_id || value.actor_id !== pending.actor_id
    || value.supplier_id !== pending.supplier_id || !['unknown', 'committed', 'not_applied'].includes(String(value.state))
    || (value.state === 'unknown' ? value[field] !== null : value[field] !== pending.subject_id)) throw Error('收退款回执身份或原操作不一致');
  let amount: string | null = null;
  if (value.state === 'committed') {
    const result = value.result;
    if (!object(result)) throw Error('已提交收退款回执不完整');
    if (pending.kind === 'payment') {
      if (Object.keys(result).length !== 6 || result.id !== pending.subject_id || result.paid !== 1 || result.pay_type !== 'offline'
        || typeof result.order_no !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(result.order_no) || !positive(result.pay_time)) throw Error('收款结果不完整');
      amount = result.pay_price as string;
    } else {
      if (Object.keys(result).length !== 4 || result.refund_id !== pending.subject_id || !positive(result.order_id)
        || !['CASH_SUCCESS', 'ZERO_SUCCESS'].includes(String(result.status))) throw Error('现金退款结果不完整');
      amount = result.amount as string;
      if ((amount === '0.00') !== (result.status === 'ZERO_SUCCESS')) throw Error('现金退款结果与金额不一致');
    }
    if (typeof amount !== 'string' || !money.test(amount)) throw Error('已提交收退款金额无效');
  } else if (value.result !== null) throw Error('收退款回执状态不一致');
  return { operation_id: pending.operation_id, actor_id: pending.actor_id, supplier_id: pending.supplier_id,
    subject_id: value[field] as number | null, state: value.state as CashReceipt['state'], amount };
}
const subjectPath = (kind: CashOperationKind, id: number) => kind === 'payment' ? `/order/pay_offline/${id}` : `/refund/manual/${id}`;
export async function getCashSeed(kind: CashOperationKind, id: number, signal?: AbortSignal) {
  return parseCashSeed(await apiRequest({ method: 'GET', url: subjectPath(kind, id), signal }), kind, id);
}
export async function saveCashOperation(seed: CashSeed, pending: PendingCashOperation, cashConfirmed: boolean) {
  if (seed.kind !== pending.kind || seed.subject_id !== pending.subject_id || seed.cash_required && !cashConfirmed) throw Error('请核对并明确确认实际现金交接');
  const data = pending.kind === 'payment'
    ? { operation_id: pending.operation_id, revision: seed.revision, order_no: seed.order_no, amount: seed.amount, ...(seed.cash_required ? { cash_received: true } : {}) }
    : { operation_id: pending.operation_id, revision: seed.revision, refund_price: seed.amount, ...(seed.cash_required ? { cash_returned: true } : {}) };
  const raw = await apiRequest({ method: pending.kind === 'payment' ? 'POST' : 'PUT', url: subjectPath(pending.kind, pending.subject_id), data });
  const receipt = parseCashReceipt(raw, pending);
  if (receipt.state === 'committed' && receipt.amount !== seed.amount) throw Error('已提交金额与原确认金额不一致，请查询原操作');
  return receipt;
}
export async function recoverCashOperation(pending: PendingCashOperation, resolve = false) {
  const base = pending.kind === 'payment' ? '/order/payment_operations' : '/refund/manual_operations';
  return parseCashReceipt(await apiRequest({ method: resolve ? 'POST' : 'GET', url: `${base}/${pending.operation_id}${resolve ? '/resolve' : ''}`,
    ...(resolve ? { data: { [pending.kind === 'payment' ? 'order_id' : 'refund_id']: pending.subject_id } } : {}) }), pending);
}
