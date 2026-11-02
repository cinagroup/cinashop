import { assignmentId, assignmentUuid, assignmentDigest, assignmentObject, assignmentCanonical } from '../../../common/fulfillmentAssignment';
import { assignedSnapshot, assignedUtf8Bytes, assignedHashCanonical, captureAssignedInput, parseAssignedReceipt,
  type AssignedInput, type AssignedExpected, type AssignedReceipt } from '../../../common/managerAssignedFulfillment';
import { merchantSha256 } from './merchantIntentHash';

export interface AssignedIntent extends AssignedExpected { version: 1; created_at: number; receipt: AssignedReceipt | null }
export const assignedJournalKey = (actor: number) => 'manager_assigned_whole_express_pending_v1:' + assignmentId(actor);
export function assignedInputHash(actor: number, key: string, input: AssignedInput): string {
  // JSON.stringify escapes lone surrogates. Legal Unicode, including astral
  // characters, has exactly the backend TextEncoder UTF-8 bytes here.
  return merchantSha256(assignedHashCanonical(actor, key, input));
}
function parseIntent(value: unknown, actor: number): AssignedIntent {
  const r = assignmentObject(value, ['version','actor_uid','request_key','input','request_hash','created_at','receipt']);
  const input = captureAssignedInput(r.input), request_key = assignmentUuid(r.request_key), request_hash = assignmentDigest(r.request_hash);
  if (r.version !== 1 || r.actor_uid !== assignmentId(actor) || typeof r.created_at !== 'number'
    || !Number.isSafeInteger(r.created_at) || r.created_at <= 0 || assignedInputHash(actor, request_key, input) !== request_hash)
    throw Error('原分配履约记录损坏，禁止覆盖或重新提交');
  const intent: AssignedIntent = { version: 1, actor_uid: actor, request_key, input, request_hash, created_at: r.created_at, receipt: null };
  if (r.receipt !== null) intent.receipt = parseAssignedReceipt(r.receipt, intent);
  return Object.freeze(intent);
}
function rawJournal(actor: number): string {
  const raw: unknown = uni.getStorageSync(assignedJournalKey(actor));
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string' || assignedUtf8Bytes(raw) > 700000) throw Error('原分配履约记录损坏或超过容量，请人工核对');
  return raw;
}
export function readAssignedJournal(actor: number): { raw: string; records: AssignedIntent[] } {
  const raw = rawJournal(actor); let values: unknown;
  try { values = raw ? assignedSnapshot(JSON.parse(raw), 700000) : []; } catch { throw Error('原分配履约记录损坏，禁止覆盖或重新提交'); }
  if (!Array.isArray(values) || values.length > 50) throw Error('原分配履约记录超过容量，请人工核对');
  const requests = new Set<string>(), orders = new Set<number>();
  const records = values.map(v => { const intent = parseIntent(v, actor);
    if (requests.has(intent.request_key) || orders.has(intent.input.order_id)) throw Error('原分配履约记录重复，请人工核对');
    requests.add(intent.request_key); orders.add(intent.input.order_id); return intent; });
  return { raw, records };
}
function writeJournal(actor: number, expected: string, records: AssignedIntent[]): void {
  if (rawJournal(actor) !== expected) throw Error('另一页面已更新原操作，请先刷新核对');
  const value = JSON.stringify(records);
  uni.setStorageSync(assignedJournalKey(actor), value);
  if (rawJournal(actor) !== value) throw Error('原请求未能可靠保存，尚未提交');
}
export function beginAssignedIntent(actor: number, key: string, value: AssignedInput): AssignedIntent {
  const saved = readAssignedJournal(actor), raw = saved.raw; let records = saved.records;
  const input = captureAssignedInput(value), request_key = assignmentUuid(key);
  if (records.some(r => r.input.order_id === input.order_id || r.request_key === request_key)) throw Error('此订单已有原请求，请先查询原操作');
  if (records.length >= 50) {
    // Keep unresolved originals forever. Only a receipt already decoded and
    // confirmed for this exact original may leave the bounded local history.
    const confirmed = records.findIndex(r => r.receipt !== null);
    if (confirmed < 0) throw Error('待核对分配履约记录已达容量，请先查询原回执');
    records = records.filter((_r, index) => index !== confirmed);
  }
  const intent = parseIntent({ version: 1, actor_uid: actor, request_key, input, request_hash: assignedInputHash(actor, request_key, input),
    created_at: Math.floor(Date.now() / 1000), receipt: null }, actor);
  writeJournal(actor, raw, [...records, intent]); return assertAssignedIntent(intent);
}
export function assertAssignedIntent(value: AssignedIntent): AssignedIntent {
  const original = parseIntent(value, value.actor_uid), saved = readAssignedJournal(value.actor_uid).records.find(r => r.request_key === value.request_key);
  if (!saved || assignmentCanonical(saved.input) !== assignmentCanonical(original.input) || saved.request_hash !== original.request_hash)
    throw Error('原操作记录已变化，禁止发送旧内容');
  return saved;
}
export function recordAssignedReceipt(value: AssignedIntent, receiptValue: AssignedReceipt): AssignedIntent {
  const { raw, records } = readAssignedJournal(value.actor_uid), saved = assertAssignedIntent(value), receipt = parseAssignedReceipt(receiptValue, saved);
  if (saved.receipt && assignmentCanonical(saved.receipt) !== assignmentCanonical(receipt)) throw Error('原成功回执发生矛盾，请人工核对');
  const next = Object.freeze({ ...saved, receipt });
  writeJournal(saved.actor_uid, raw, records.map(r => r.request_key === saved.request_key ? next : r)); return next;
}
const owners = new Set<number>();
export async function withAssignedJournalLock<T>(actor: number, work: () => Promise<T>): Promise<T> {
  assignmentId(actor);
  const local = async () => { if (owners.has(actor)) throw Error('另一操作正在核对，请稍后继续'); owners.add(actor);
    try { return await work(); } finally { owners.delete(actor); } };
  // H5 uses a real cross-tab lock. Other platforms share this module's local
  // writer mutex; the server root/UUID locks remain the actual write authority.
  if (typeof window !== 'undefined') {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request) throw Error('当前浏览器缺少安全的跨页面操作支持，请更换浏览器后核对');
    return locks.request('manager-assigned-whole-express:' + actor, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!lock) throw Error('另一页面正在处理分配订单，请稍后核对'); return local(); });
  }
  return local();
}
export async function assignedRequestKey(): Promise<string> {
  const format = (bytes: Uint8Array) => { if (bytes.length !== 16) throw Error('安全请求编号生成失败');
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const s = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
    return assignmentUuid(`${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`); };
  if (typeof globalThis.crypto?.getRandomValues === 'function') return format(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  if (typeof uni.getRandomValues === 'function') return new Promise((resolve, reject) => uni.getRandomValues({ length: 16,
    success: value => { try { resolve(format(new Uint8Array(value.randomValues))); } catch (error) { reject(error); } },
    fail: () => reject(Error('安全请求编号生成失败，尚未提交')) }));
  throw Error('当前环境缺少安全随机数，尚未提交');
}
