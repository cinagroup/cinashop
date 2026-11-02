/** Separate Manager assignment protocol. Discovery is not source admission.
 * SQL stores 26 columns; its public receipt omits the original intent. */
import { assignmentObject as object, assignmentId as id, assignmentUuid as uuid,
  assignmentDigest as digest, assignmentCanonical } from './fulfillmentAssignment';

export const MANAGER_ASSIGNED_VERSION = 'merchant-assigned-whole-express-v1' as const;
const fail = () => Error('分配订单数据或原回执不完整，请保留原请求核对');
/** TextEncoder-compatible byte count without a browser-only encoding API. */
export function assignedUtf8Bytes(value: string): number {
  let bytes = 0; for (const c of value) { const n = c.codePointAt(0)!; bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; } return bytes;
}
export function assignedSnapshot(value: unknown, max = 131072): unknown {
  let nodes = 0, bytes = 0;
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 8192 || depth > 12) throw fail();
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (typeof v === 'string') { bytes += assignedUtf8Bytes(v); if (bytes > max) throw fail(); return v; }
    if (!v || typeof v !== 'object' || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw fail();
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (v.length > 200 || keys.length !== v.length + 1 || keys.some(k => typeof k !== 'string'
        || k !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(k) || Number(k) >= v.length))) throw fail();
      return Object.freeze(Array.from({ length: v.length }, (_, n) => { const d = ds[String(n)];
        if (!d?.enumerable || !('value' in d)) throw fail(); return copy(d.value, depth + 1); }));
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (typeof k !== 'string' || ['__proto__','prototype','constructor'].includes(k) || !ds[k]?.enumerable || !('value' in ds[k])) throw fail();
      bytes += assignedUtf8Bytes(k); if (bytes > max) throw fail(); out[k] = copy(ds[k].value, depth + 1);
    }
    return Object.freeze(out);
  }
  const result = copy(value, 0); if (assignedUtf8Bytes(JSON.stringify(result)) > max) throw fail(); return result;
}
function text(v: unknown, max: number, empty = false, trimmed = false): string {
  if (typeof v !== 'string' || !empty && !v || [...v].length > max || /[\u0000-\u001f\u007f]/u.test(v)
    || trimmed && v !== v.trim() || [...v].some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)) throw fail();
  return v;
}
function orderNo(v: unknown) { const s = text(v, 128); if (!/^[A-Za-z0-9_-]+$/u.test(s)) throw fail(); return s; }
export interface AssignedGrant { operation_id: string; ordinal: number; payload_hash: string; source_hash: string; order_revision: string }
function grant(v: unknown): AssignedGrant {
  const r = object(v, ['operation_id','ordinal','payload_hash','source_hash','order_revision']), ordinal = id(r.ordinal);
  if (ordinal > 64) throw fail(); return Object.freeze({ operation_id: uuid(r.operation_id), ordinal,
    payload_hash: digest(r.payload_hash), source_hash: digest(r.source_hash), order_revision: digest(r.order_revision) });
}
export interface AssignedInboxItem { order_id: number; order_no: string; total_num: number; financial_store_id: 0; grant: AssignedGrant; admission: 'requires_review' }
export interface AssignedInbox { version: 'merchant-assigned-whole-express-inbox-v1'; actor_uid: number; store_id: number;
  scope_key: string; list: AssignedInboxItem[]; next_after: number | null; admission: 'requires_review' }
export function parseAssignedInbox(value: unknown, actor: number, store: number, after = 0): AssignedInbox {
  const r = object(assignedSnapshot(value), ['version','actor_uid','store_id','scope_key','list','next_after','admission']);
  if (r.version !== 'merchant-assigned-whole-express-inbox-v1' || r.actor_uid !== id(actor) || r.store_id !== id(store)
    || r.admission !== 'requires_review' || !Array.isArray(r.list) || r.list.length > 10) throw fail();
  let last = id(after, true); const operations = new Set<string>();
  const list = r.list.map(v => { const row = object(v, ['order_id','order_no','total_num','financial_store_id','grant','admission']);
    const order_id = id(row.order_id), g = grant(row.grant);
    if (order_id <= last || operations.has(g.operation_id) || row.financial_store_id !== 0 || row.admission !== 'requires_review') throw fail();
    last = order_id; operations.add(g.operation_id); return Object.freeze({ order_id, order_no: orderNo(row.order_no),
      total_num: id(row.total_num), financial_store_id: 0 as const, grant: g, admission: 'requires_review' as const }); });
  const next_after = r.next_after === null ? null : id(r.next_after);
  if (next_after !== null && (list.length !== 10 || next_after !== last)) throw fail();
  return Object.freeze({ version: 'merchant-assigned-whole-express-inbox-v1', actor_uid: actor, store_id: store,
    scope_key: digest(r.scope_key), list, next_after, admission: 'requires_review' });
}
export interface AssignedCart { row_id: number; cart_id: string; product_id: number; unique: string; quantity: number }
export interface AssignedReview { version: typeof MANAGER_ASSIGNED_VERSION; order_id: number; order_no: string; store_id: number;
  fulfillment_store_id: number; financial_store_id: 0; scope_key: string; order_revision: string; grant: AssignedGrant;
  source: { cart_rows: AssignedCart[] }; recipient: { name: string; phone: string; address: string };
  carriers: Array<{ name: string; code: string }>; admission: 'requires_locked_commit' }
export function parseAssignedReview(value: unknown, order: number, store: number, scope: string): AssignedReview {
  const r = object(assignedSnapshot(value, 262144), ['version','order_id','order_no','store_id','fulfillment_store_id','financial_store_id',
    'scope_key','order_revision','grant','source','recipient','carriers','admission']);
  if (r.version !== MANAGER_ASSIGNED_VERSION || r.order_id !== id(order) || r.store_id !== id(store) || r.fulfillment_store_id !== store
    || r.financial_store_id !== 0 || r.scope_key !== digest(scope) || r.admission !== 'requires_locked_commit') throw fail();
  const g = grant(r.grant), revision = digest(r.order_revision), source = object(r.source, ['cart_rows']);
  if (g.order_revision !== revision || !Array.isArray(source.cart_rows) || !source.cart_rows.length || source.cart_rows.length > 200) throw fail();
  let last = 0, quantity = 0; const cartIds = new Set<string>();
  const cart_rows = source.cart_rows.map(v => { const c = object(v, ['row_id','cart_id','product_id','unique','quantity']);
    const row = { row_id: id(c.row_id), cart_id: text(c.cart_id, 50), product_id: id(c.product_id), unique: text(c.unique, 255, true), quantity: id(c.quantity) };
    if (row.row_id <= last || cartIds.has(row.cart_id)) throw fail(); last = row.row_id; cartIds.add(row.cart_id); quantity += row.quantity;
    if (!Number.isSafeInteger(quantity) || quantity > 2147483647) throw fail(); return Object.freeze(row); });
  if (assignedUtf8Bytes(JSON.stringify({ cart_rows })) > 65536) throw fail();
  const recipient = object(r.recipient, ['name','phone','address']);
  if (!Array.isArray(r.carriers) || r.carriers.length > 200) throw fail(); const codes = new Set<string>();
  const carriers = r.carriers.map(v => { const c = object(v, ['name','code']), name = text(c.name, 64, false, true), code = text(c.code, 50, false, true);
    if (codes.has(code)) throw fail(); codes.add(code); return Object.freeze({ name, code }); });
  return Object.freeze({ version: MANAGER_ASSIGNED_VERSION, order_id: order, order_no: orderNo(r.order_no), store_id: store,
    fulfillment_store_id: store, financial_store_id: 0, scope_key: scope, order_revision: revision, grant: g, source: { cart_rows },
    recipient: { name: text(recipient.name, 255, true), phone: text(recipient.phone, 64, true), address: text(recipient.address, 4096, true) },
    carriers, admission: 'requires_locked_commit' });
}
export interface AssignedInput { version: typeof MANAGER_ASSIGNED_VERSION; order_id: number; store_id: number; scope_key: string;
  assignment_operation_id: string; assignment_ordinal: number; assignment_payload_hash: string;
  expected_assignment_source_hash: string; expected_order_revision: string;
  payload: { type: 1; express_record_type: 1; delivery_name: string; delivery_code: string; delivery_id: string } }
export function captureAssignedInput(value: unknown): AssignedInput {
  const r = object(assignedSnapshot(value, 8192), ['version','order_id','store_id','scope_key','assignment_operation_id','assignment_ordinal',
    'assignment_payload_hash','expected_assignment_source_hash','expected_order_revision','payload']);
  const p = object(r.payload, ['type','express_record_type','delivery_name','delivery_code','delivery_id']);
  const ordinal = id(r.assignment_ordinal);
  if (r.version !== MANAGER_ASSIGNED_VERSION || ordinal > 64 || p.type !== 1 || p.express_record_type !== 1) throw fail();
  return Object.freeze({ version: MANAGER_ASSIGNED_VERSION, order_id: id(r.order_id), store_id: id(r.store_id), scope_key: digest(r.scope_key),
    assignment_operation_id: uuid(r.assignment_operation_id), assignment_ordinal: ordinal, assignment_payload_hash: digest(r.assignment_payload_hash),
    expected_assignment_source_hash: digest(r.expected_assignment_source_hash), expected_order_revision: digest(r.expected_order_revision),
    payload: Object.freeze({ type: 1, express_record_type: 1, delivery_name: text(p.delivery_name, 64, false, true),
      delivery_code: text(p.delivery_code, 50, false, true), delivery_id: text(p.delivery_id, 64, false, true) }) });
}
export function assignedHashCanonical(actor: number, key: string, input: AssignedInput): string {
  return assignmentCanonical({ domain: MANAGER_ASSIGNED_VERSION, actor_uid: id(actor), request_key: uuid(key), intent: captureAssignedInput(input) });
}
export function makeAssignedInput(review: AssignedReview, carrier: { name: string; code: string }, tracking: string): AssignedInput {
  if (!review.carriers.some(c => c.code === carrier.code && c.name === carrier.name)) throw fail();
  return captureAssignedInput({ version: MANAGER_ASSIGNED_VERSION, order_id: review.order_id, store_id: review.store_id, scope_key: review.scope_key,
    assignment_operation_id: review.grant.operation_id, assignment_ordinal: review.grant.ordinal, assignment_payload_hash: review.grant.payload_hash,
    expected_assignment_source_hash: review.grant.source_hash, expected_order_revision: review.order_revision,
    payload: { type: 1, express_record_type: 1, delivery_name: carrier.name, delivery_code: carrier.code, delivery_id: tracking.trim() } });
}
export interface AssignedReceipt { actor_uid: number; request_key: string; format_version: 1; kind: 'assigned_whole_express'; outcome: 'delivery-recorded';
  request_hash: string; target_store_id: number; staff_id: number; scope_key: string; root_order_id: number; order_id: number; customer_uid: number;
  financial_store_id: 0; supplier_id: 0; assignment_operation_id: string; assignment_ordinal: number; assignment_payload_hash: string;
  assignment_source_hash: string; assignment_order_revision: string; expected_order_revision: string; post_order_revision: string;
  delivery_outbox_id: number; delivery_event_key: string; delivery_payload_hash: string; created_at: number }
export interface AssignedExpected { actor_uid: number; request_key: string; input: AssignedInput; request_hash: string }
export function parseAssignedReceipt(value: unknown, expected: AssignedExpected): AssignedReceipt {
  const r = object(assignedSnapshot(value, 16384), ['actor_uid','request_key','format_version','kind','outcome','request_hash','target_store_id','staff_id',
    'scope_key','root_order_id','order_id','customer_uid','financial_store_id','supplier_id','assignment_operation_id','assignment_ordinal',
    'assignment_payload_hash','assignment_source_hash','assignment_order_revision','expected_order_revision','post_order_revision',
    'delivery_outbox_id','delivery_event_key','delivery_payload_hash','created_at']);
  const input = captureAssignedInput(expected.input);
  if (r.actor_uid !== id(expected.actor_uid) || r.request_key !== uuid(expected.request_key) || r.format_version !== 1
    || r.kind !== 'assigned_whole_express' || r.outcome !== 'delivery-recorded' || r.request_hash !== digest(expected.request_hash)
    || r.target_store_id !== input.store_id || r.scope_key !== input.scope_key || r.root_order_id !== input.order_id || r.order_id !== input.order_id
    || r.financial_store_id !== 0 || r.supplier_id !== 0 || r.assignment_operation_id !== input.assignment_operation_id
    || r.assignment_ordinal !== input.assignment_ordinal || r.assignment_payload_hash !== input.assignment_payload_hash
    || r.assignment_source_hash !== input.expected_assignment_source_hash || r.assignment_order_revision !== input.expected_order_revision
    || r.expected_order_revision !== input.expected_order_revision || r.delivery_event_key !== 'order.delivery.notice:' + input.order_id
    || typeof r.created_at !== 'number' || !Number.isSafeInteger(r.created_at) || r.created_at <= 0) throw fail();
  id(r.staff_id); id(r.customer_uid); id(r.delivery_outbox_id); digest(r.post_order_revision); digest(r.delivery_payload_hash);
  return r as unknown as AssignedReceipt;
}
export function parseAssignedResult(value: unknown, expected: AssignedExpected): { receipt: AssignedReceipt; replayed: boolean } {
  const r = object(assignedSnapshot(value, 16384), ['receipt','replayed']); if (typeof r.replayed !== 'boolean') throw fail();
  return { receipt: parseAssignedReceipt(r.receipt, expected), replayed: r.replayed };
}
export function parseAssignedRecovery(value: unknown, expected: AssignedExpected): AssignedReceipt | null {
  const r = object(assignedSnapshot(value, 16384), ['state','receipt']);
  if (r.state === 'unknown' && r.receipt === null) return null;
  if (r.state !== 'recorded' || r.receipt === null) throw fail(); return parseAssignedReceipt(r.receipt, expected);
}
