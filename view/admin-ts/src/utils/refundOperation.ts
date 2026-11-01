import { parseRefundIntent, readRefundIntent, type RefundIntent, type RefundAction } from './refundIntent';
import { refundReview, type AdminRefundDetail } from './refundDetail';

export { withRefundActionLock } from './refundIntent';
export type { RefundAction } from './refundIntent';
export const operationVersion = 'admin-refund-operation-v1' as const;
export const executionVersion = 'admin-refund-execution-v1' as const;
export type OperationOutcome = 'return-approved' | 'refused' | 'balance-settled' | 'provider-admitted' | 'abandoned';
export interface OperationReceipt {
  version: typeof operationVersion; adminId: number; requestKey: string; requestHash: string;
  refundId: number; action: RefundAction; outcome: OperationOutcome;
}
export type OperationStatus = 'SUCCESS' | 'BALANCE_SUCCESS' | 'CREATED' | 'REQUESTING' | 'PROCESSING' | 'CLOSED' | 'ABNORMAL' | 'FAILED' | 'UNKNOWN' | 'NOT_FOUND';
export interface OperationExecution { completed: boolean; status: OperationStatus }
export interface RefundOperation extends Omit<RefundIntent, 'version'> {
  version: 3; requestHash: string; receipt: OperationReceipt | null; execution: OperationExecution | null;
}
export interface OperationResult { receipt: OperationReceipt | null; execution: OperationExecution | null }
export type OperationMode = 'execute' | 'receipt' | 'execution' | 'abandon';
const invalid = () => Error('原操作或回执无效，结果仍待核对');
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, keys: string[]) {
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) throw invalid();
}
export function operationBody(intent: Pick<RefundOperation, 'action' | 'review' | 'applyType' | 'initialStatus' | 'received' | 'reason'>) {
  return { version: operationVersion, action: intent.action, review: { ...intent.review },
    decision: { applyType: intent.applyType, refundType: intent.initialStatus, received: intent.received },
    ...(intent.action === 'refuse' ? { reason: intent.reason } : {}) };
}
function canonicalJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const row = record(value);
  return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(row[key])).join(',') + '}';
}
/** Mirrors the server's normalized hash, including empty reason and exact cents.
 * No token/session material is persisted or hashed. */
export async function operationHash(intent: Pick<RefundOperation, 'refundId' | 'action' | 'review' | 'applyType' | 'initialStatus' | 'received' | 'reason'>) {
  const body = operationBody(intent);
  const [whole, fraction] = intent.review.refundPrice.split('.');
  const normalized = { ...body, refundId: intent.refundId, reason: intent.reason,
    review: { ...body.review, refundPrice: BigInt(whole).toString() + '.' + fraction } };
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(normalized)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseOperationReceipt(value: unknown, intent: RefundOperation): OperationReceipt {
  const row = record(value);
  exact(row, ['version', 'adminId', 'requestKey', 'requestHash', 'refundId', 'action', 'outcome']);
  if (row.version !== operationVersion || row.adminId !== intent.actorId || row.requestKey !== intent.nonce
    || row.requestHash !== intent.requestHash || row.refundId !== intent.refundId || row.action !== intent.action) throw invalid();
  const outcome = row.outcome;
  if (outcome !== 'abandoned' && !(intent.action === 'return' && outcome === 'return-approved')
    && !(intent.action === 'refuse' && outcome === 'refused')
    && !(intent.action === 'refund' && (outcome === 'balance-settled' || outcome === 'provider-admitted'))) throw invalid();
  return { version: operationVersion, adminId: intent.actorId, requestKey: intent.nonce,
    requestHash: intent.requestHash, refundId: intent.refundId, action: intent.action, outcome: outcome as OperationOutcome };
}
function parseExecution(value: unknown, receipt: OperationReceipt | null): OperationExecution | null {
  if (value === null) return null;
  const row = record(value); exact(row, ['completed', 'status']);
  if (receipt?.outcome === 'balance-settled' && row.completed === true && row.status === 'BALANCE_SUCCESS') return { completed: true, status: 'BALANCE_SUCCESS' };
  if (receipt?.outcome === 'balance-settled' && row.completed === false && row.status === 'UNKNOWN') return { completed: false, status: 'UNKNOWN' };
  if (receipt?.outcome === 'provider-admitted') {
    if (row.completed === true && row.status === 'SUCCESS') return { completed: true, status: 'SUCCESS' };
    if (row.completed === false && typeof row.status === 'string'
      && ['CREATED','REQUESTING','PROCESSING','CLOSED','ABNORMAL','FAILED','UNKNOWN','NOT_FOUND'].includes(row.status)) return { completed: false, status: row.status as OperationStatus };
  }
  throw invalid();
}
export function operationResolved(result: OperationResult) {
  return !!result.receipt && (result.receipt.outcome === 'provider-admitted' ? result.execution?.completed === true
    : result.receipt.outcome !== 'balance-settled' || result.execution === null || result.execution.completed);
}
/** Copy synchronously before any crypto/network await; callers cannot change the
 * decision being verified by mutating a reactive row while hashing. */
export function parseRefundOperation(value: unknown, actorId: number, refundId: number): RefundOperation {
  const row = record(value);
  exact(row, ['version','nonce','actorId','refundId','action','review','applyType','initialStatus','reason','received','createdAt','phase','requestHash','receipt','execution']);
  exact(record(row.review), ['uid','storeOrderId','storeId','supplierId','orderId','refundPrice']);
  if (row.version !== 3 || typeof row.action !== 'string' || typeof row.phase !== 'string'
    || typeof row.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestHash)) throw invalid();
  const original = parseRefundIntent({ ...row, version: 2 }, actorId, refundId);
  const intent: RefundOperation = { ...original, version: 3, requestHash: row.requestHash, receipt: null, execution: null };
  intent.receipt = row.receipt === null ? null : parseOperationReceipt(row.receipt, intent);
  intent.execution = parseExecution(row.execution, intent.receipt);
  if ((intent.phase === 'resolved') !== operationResolved(intent)) throw invalid();
  if (new TextEncoder().encode(JSON.stringify(operationBody(intent))).length > 4096) throw invalid();
  return intent;
}
export async function verifyRefundOperation(value: unknown, actorId: number, refundId: number) {
  const intent = parseRefundOperation(value, actorId, refundId);
  if (await operationHash(intent) !== intent.requestHash) throw invalid();
  return intent;
}
export async function makeRefundOperation(actorId: number, row: AdminRefundDetail, action: RefundAction, reason: string, received: boolean) {
  const original = parseRefundIntent({ version: 2, nonce: crypto.randomUUID(), actorId, refundId: row.id, action,
    review: refundReview(row), applyType: row.applyType, initialStatus: row.refundType,
    reason: action === 'refuse' ? reason.trim() : '', received, createdAt: Date.now(), phase: 'pending' }, actorId, row.id);
  return parseRefundOperation({ ...original, version: 3, requestHash: await operationHash(original), receipt: null, execution: null }, actorId, row.id);
}
export function refundOperationKey(actorId: number, refundId: number) {
  if (![actorId,refundId].every(id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647)) throw invalid();
  return `admin-refund-intent-v3:${actorId}:${refundId}`;
}
export async function readRefundOperation(actorId: number, refundId: number) {
  const prior = readRefundIntent(actorId, refundId), key = refundOperationKey(actorId, refundId);
  const raw = localStorage.getItem(key);
  if (raw && raw.length > 8192) throw invalid();
  const intent = raw === null ? null : await verifyRefundOperation(JSON.parse(raw), actorId, refundId);
  const latest = readRefundIntent(actorId, refundId);
  if (localStorage.getItem(key) !== raw || latest.raw !== prior.raw || latest.legacy !== prior.legacy) throw Error('其他标签页已更新原操作，请刷新核对');
  // Even a v2 "resolved" marker was based only on mutable business state, not a
  // durable admission receipt. Never upgrade, replay or fence an unkeyed sender.
  return { raw, intent, legacy: prior.legacy || prior.intent !== null };
}
/** Caller holds the same entity Web Lock used by v2 and rechecks ownership after
 * every await. A retained tombstone prevents stale null-snapshot submissions. */
export function writeRefundOperation(intent: RefundOperation, expectedRaw: string | null) {
  const key = refundOperationKey(intent.actorId, intent.refundId), prior = readRefundIntent(intent.actorId, intent.refundId);
  if (prior.legacy || prior.intent || localStorage.getItem(key) !== expectedRaw) throw Error('原操作记录已变化，请刷新核对');
  const raw = JSON.stringify(parseRefundOperation(intent, intent.actorId, intent.refundId));
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw Error('原操作未能可靠保存，禁止提交');
  return raw;
}
export function parseOperationResult(value: unknown, intent: RefundOperation, mode: OperationMode): OperationResult {
  const row = record(value);
  exact(row, mode === 'execute' ? ['version','receipt','replayed','execution'] : mode === 'execution' ? ['version','receipt','execution'] : ['version','receipt']);
  if (row.version !== (mode === 'execution' ? executionVersion : operationVersion) || mode === 'execute' && typeof row.replayed !== 'boolean') throw invalid();
  const receipt = row.receipt === null && (mode === 'receipt' || mode === 'execution') ? null : parseOperationReceipt(row.receipt, intent);
  const execution = mode === 'execute' || mode === 'execution' ? parseExecution(row.execution, receipt) : null;
  if (mode === 'execute' && ['balance-settled','provider-admitted'].includes(receipt!.outcome) && !execution) throw invalid();
  if (mode === 'execution' && receipt && ['balance-settled','provider-admitted'].includes(receipt.outcome) && !execution) throw invalid();
  return { receipt, execution };
}
export function applyOperationResult(intent: RefundOperation, result: OperationResult): RefundOperation {
  // Receipt history is append-only; a later null/different outcome is not a
  // legitimate replacement for evidence already observed.
  if (intent.receipt && (!result.receipt || JSON.stringify(intent.receipt) !== JSON.stringify(result.receipt))) throw invalid();
  if (intent.execution?.completed && result.execution && !result.execution.completed) throw invalid();
  const next = { ...intent, receipt: result.receipt, execution: result.execution ?? intent.execution };
  return parseRefundOperation({ ...next, phase: operationResolved(next) ? 'resolved' : 'pending' }, intent.actorId, intent.refundId);
}
export function operationMessage(result: OperationResult): string {
  switch (result.receipt?.outcome) {
    case 'return-approved': return '原操作回执已确认：已同意退货，等待用户寄回';
    case 'refused': return '原操作回执已确认：已拒绝退款';
    case 'balance-settled': return result.execution?.completed === false ? '原操作已记录余额或零现金结算，实际完成证据暂不可核对；请保留原操作' : '原操作回执已确认：退款已完成（余额或零现金结算）';
    case 'provider-admitted': {
      if (result.execution?.completed) return '原操作渠道结算已确认完成';
      const status = result.execution?.status;
      if (status === 'UNKNOWN') return '原操作已受理，实际结算证据暂不可核对；请保留原键继续查询';
      if (status === 'CLOSED') return '原操作渠道退款已关闭，尚未确认结算；请保留原键并人工核对';
      if (status === 'ABNORMAL' || status === 'FAILED') return '原操作渠道退款异常，尚未确认结算；请保留原键并人工核对';
      if (status === 'NOT_FOUND') return '原操作已受理，暂未查到渠道退款；请保留原键，不可新建请求';
      return '原操作已受理，尚未确认渠道结算；可继续查询，或显式重试原操作';
    }
    case 'abandoned': return '原操作未受理，已建立永久放弃屏障；该原键不会再执行。这不是撤销已受理退款';
    default: return '暂未查到原操作回执；迟到请求仍可能受理，不可据此新建操作';
  }
}
