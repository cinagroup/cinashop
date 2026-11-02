/** Closed frontend assignment protocol. Digests bind content, not authority. */
export interface AdminAssignmentHead { ordinal: number; operation_id: string | null }
export interface AdminAssignmentInput {
  format_version: 1; operation_id: string; kind: 'grant' | 'revoke'; order_id: number; target_store_id: number;
  expected_head: AdminAssignmentHead; expected_order_revision: string; expected_source_hash: string;
}
export interface AdminAssignmentReceipt {
  operation_id: string; format_version: 1; kind: 'grant' | 'revoke'; actor_id: number; root_order_id: number;
  order_id: number; target_store_id: number; customer_uid: number; financial_store_id: 0; ordinal: number;
  previous_ref: string | null; order_revision: string; payload_hash: string; source_hash: string; created_at: number;
}
export interface AssignmentCart { row_id: number; cart_id: string; product_id: number; unique: string; quantity: number }
export interface AdminAssignmentReview {
  format_version: 1; order_id: number; customer_uid: number; financial_store_id: 0;
  current_head: AdminAssignmentReceipt | null; expected_head: AdminAssignmentHead;
  grant: { order_no: string; order_revision: string; source_hash: string; source: { cart_rows: AssignmentCart[] } } | null;
  grant_reason: string; revoke: { target_store_id: number; order_revision: string; source_hash: string } | null;
  admission: 'requires_locked_commit'; can_append: boolean;
}
const fail = () => Error('门店分配数据不完整，请保留原请求核对');
export function assignmentSnapshot(value: unknown, maxBytes = 2 * 1024 * 1024): unknown {
  let nodes = 0, bytes = 0; const encoder = new TextEncoder();
  function walk(v: unknown, depth: number): unknown {
    if (++nodes > 8192 || depth > 12) throw fail();
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (typeof v === 'string') { bytes += encoder.encode(v).length; if (bytes > maxBytes) throw fail(); return v; }
    if (!v || typeof v !== 'object' || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw fail();
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (v.length > 200 || keys.length !== v.length + 1 || keys.some(k => typeof k !== 'string'
        || k !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(k) || Number(k) >= v.length))) throw fail();
      return Object.freeze(Array.from({ length: v.length }, (_, i) => {
        const d = descriptors[String(i)]; if (!d?.enumerable || !('value' in d)) throw fail(); return walk(d.value, depth + 1);
      }));
    }
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string' || ['__proto__','prototype','constructor'].includes(key)
        || !descriptors[key]?.enumerable || !('value' in descriptors[key])) throw fail();
      bytes += encoder.encode(key).length; if (bytes > maxBytes) throw fail();
      result[key] = walk(descriptors[key].value, depth + 1);
    }
    return Object.freeze(result);
  }
  const result = walk(value, 0); if (encoder.encode(JSON.stringify(result)).length > maxBytes) throw fail(); return result;
}
export function assignmentObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw fail(); return value as Record<string, unknown>;
}
export function assignmentId(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647) throw fail(); return value;
}
export function assignmentUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) throw fail(); return value;
}
export function assignmentDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw fail(); return value;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || !empty && !value || [...value].length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw fail(); return value;
}
function head(value: unknown): AdminAssignmentHead {
  const r = assignmentObject(value, ['ordinal','operation_id']), ordinal = assignmentId(r.ordinal, true);
  const operation_id = r.operation_id === null ? null : assignmentUuid(r.operation_id);
  if (ordinal > 64 || (ordinal === 0) !== (operation_id === null)) throw fail(); return Object.freeze({ ordinal, operation_id });
}
export function captureAdminAssignment(value: unknown): AdminAssignmentInput {
  const r = assignmentObject(assignmentSnapshot(value, 4096), ['format_version','operation_id','kind','order_id','target_store_id',
    'expected_head','expected_order_revision','expected_source_hash']);
  if (r.format_version !== 1 || r.kind !== 'grant' && r.kind !== 'revoke') throw fail();
  const expected_head = head(r.expected_head); if (expected_head.ordinal >= 64) throw fail();
  return Object.freeze({ format_version: 1, operation_id: assignmentUuid(r.operation_id), kind: r.kind,
    order_id: assignmentId(r.order_id), target_store_id: assignmentId(r.target_store_id), expected_head,
    expected_order_revision: assignmentDigest(r.expected_order_revision), expected_source_hash: assignmentDigest(r.expected_source_hash) });
}
export function assignmentCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(assignmentCanonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + assignmentCanonical((value as Record<string, unknown>)[k])).join(',') + '}';
}
export async function adminAssignmentHash(input: AdminAssignmentInput, actor: number): Promise<string> {
  const a = captureAdminAssignment(input);
  const value = { version: 'store-order-fulfillment-assignment-request-v1', actor_id: assignmentId(actor), format_version: 1,
    operation_id: a.operation_id, kind: a.kind, root_order_id: a.order_id, order_id: a.order_id, financial_store_id: 0,
    target_store_id: a.target_store_id, expected_head: a.expected_head, expected_order_revision: a.expected_order_revision,
    expected_source_hash: a.expected_source_hash };
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(assignmentCanonical(value)));
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
export async function parseAdminAssignmentReceipt(value: unknown, actor?: number, input?: AdminAssignmentInput): Promise<AdminAssignmentReceipt> {
  const r = assignmentObject(assignmentSnapshot(value, 8192), ['operation_id','format_version','kind','actor_id','root_order_id','order_id',
    'target_store_id','customer_uid','financial_store_id','ordinal','previous_ref','order_revision','payload_hash','source_hash','created_at']);
  const ordinal = assignmentId(r.ordinal), previous_ref = r.previous_ref === null ? null : assignmentUuid(r.previous_ref);
  if (r.format_version !== 1 || r.kind !== 'grant' && r.kind !== 'revoke' || r.financial_store_id !== 0 || ordinal > 64
    || (ordinal === 1) !== (previous_ref === null) || ordinal === 1 && r.kind !== 'grant'
    || typeof r.created_at !== 'number' || !Number.isSafeInteger(r.created_at) || r.created_at <= 0) throw fail();
  const receipt: AdminAssignmentReceipt = Object.freeze({ operation_id: assignmentUuid(r.operation_id), format_version: 1, kind: r.kind,
    actor_id: assignmentId(r.actor_id), root_order_id: assignmentId(r.root_order_id), order_id: assignmentId(r.order_id),
    target_store_id: assignmentId(r.target_store_id), customer_uid: assignmentId(r.customer_uid), financial_store_id: 0, ordinal, previous_ref,
    order_revision: assignmentDigest(r.order_revision), payload_hash: assignmentDigest(r.payload_hash),
    source_hash: assignmentDigest(r.source_hash), created_at: r.created_at });
  const rebuilt = captureAdminAssignment({ format_version: 1, operation_id: receipt.operation_id, kind: receipt.kind, order_id: receipt.order_id,
    target_store_id: receipt.target_store_id, expected_head: { ordinal: ordinal - 1, operation_id: previous_ref },
    expected_order_revision: receipt.order_revision, expected_source_hash: receipt.source_hash });
  if (receipt.root_order_id !== receipt.order_id || previous_ref === receipt.operation_id || actor !== undefined && receipt.actor_id !== actor
    || input && assignmentCanonical(rebuilt) !== assignmentCanonical(captureAdminAssignment(input))
    || await adminAssignmentHash(rebuilt, receipt.actor_id) !== receipt.payload_hash) throw fail();
  return receipt;
}
function cartSource(value: unknown): { cart_rows: AssignmentCart[] } {
  const s = assignmentObject(value, ['cart_rows']); if (!Array.isArray(s.cart_rows) || !s.cart_rows.length || s.cart_rows.length > 200) throw fail();
  let last = 0; const carts = new Set<string>();
  const cart_rows = s.cart_rows.map(value => {
    const r = assignmentObject(value, ['row_id','cart_id','product_id','unique','quantity']);
    const row = { row_id: assignmentId(r.row_id), cart_id: text(r.cart_id, 50), product_id: assignmentId(r.product_id),
      unique: text(r.unique, 255, true), quantity: assignmentId(r.quantity) };
    if (row.row_id <= last || carts.has(row.cart_id)) throw fail(); last = row.row_id; carts.add(row.cart_id); return Object.freeze(row);
  });
  if (new TextEncoder().encode(JSON.stringify({ cart_rows })).length > 65536) throw fail(); return { cart_rows };
}
export async function parseAdminAssignmentReview(value: unknown, order: number): Promise<AdminAssignmentReview> {
  const r = assignmentObject(assignmentSnapshot(value), ['format_version','order_id','customer_uid','financial_store_id','current_head',
    'expected_head','grant','grant_reason','revoke','admission','can_append']);
  if (r.format_version !== 1 || r.order_id !== assignmentId(order) || r.financial_store_id !== 0
    || r.admission !== 'requires_locked_commit' || typeof r.can_append !== 'boolean') throw fail();
  const expected_head = head(r.expected_head), current_head = r.current_head === null ? null : await parseAdminAssignmentReceipt(r.current_head);
  const customer_uid = assignmentId(r.customer_uid);
  if (expected_head.ordinal !== (current_head?.ordinal ?? 0) || expected_head.operation_id !== (current_head?.operation_id ?? null)
    || current_head && (current_head.order_id !== order || current_head.customer_uid !== customer_uid)
    || r.can_append !== (expected_head.ordinal < 64)) throw fail();
  let grant: AdminAssignmentReview['grant'] = null, revoke: AdminAssignmentReview['revoke'] = null;
  if (r.grant !== null) {
    const g = assignmentObject(r.grant, ['order_no','order_revision','source_hash','source']);
    grant = { order_no: text(g.order_no, 50), order_revision: assignmentDigest(g.order_revision), source_hash: assignmentDigest(g.source_hash), source: cartSource(g.source) };
  }
  if (r.revoke !== null) {
    const v = assignmentObject(r.revoke, ['target_store_id','order_revision','source_hash']);
    revoke = { target_store_id: assignmentId(v.target_store_id), order_revision: assignmentDigest(v.order_revision), source_hash: assignmentDigest(v.source_hash) };
    if (current_head?.kind !== 'grant' || revoke.target_store_id !== current_head.target_store_id
      || revoke.order_revision !== current_head.order_revision || revoke.source_hash !== current_head.source_hash) throw fail();
  }
  if ((current_head?.kind === 'grant') !== (revoke !== null)) throw fail();
  return Object.freeze({ format_version: 1, order_id: order, customer_uid, financial_store_id: 0, current_head, expected_head,
    grant, revoke, grant_reason: text(r.grant_reason, 2048, true), admission: 'requires_locked_commit', can_append: r.can_append });
}
export function makeAdminAssignment(review: AdminAssignmentReview, kind: 'grant' | 'revoke', store: number): AdminAssignmentInput {
  const proof = kind === 'grant' ? review.grant : review.revoke;
  if (!review.can_append || !proof || kind === 'grant' && review.current_head?.kind === 'grant' && review.current_head.target_store_id === store
    || kind === 'revoke' && review.revoke?.target_store_id !== store) throw fail();
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') throw Error('当前环境缺少安全请求编号能力，请使用受支持的安全浏览器');
  return captureAdminAssignment({ format_version: 1, operation_id: crypto.randomUUID(), kind, order_id: review.order_id, target_store_id: assignmentId(store),
    expected_head: review.expected_head, expected_order_revision: proof.order_revision, expected_source_hash: proof.source_hash });
}
export function parseAssignmentStores(value: unknown, after = 0): { list: Array<{ id: number; name: string }>; next_after: number | null } {
  const r = assignmentObject(assignmentSnapshot(value, 65536), ['list','next_after']);
  if (!Array.isArray(r.list) || r.list.length > 50) throw fail(); let last = assignmentId(after, true);
  const list = r.list.map(value => { const s = assignmentObject(value, ['id','name']), id = assignmentId(s.id); if (id <= last) throw fail(); last = id;
    return { id, name: text(s.name, 100) }; });
  const next_after = r.next_after === null ? null : assignmentId(r.next_after);
  if (next_after !== null && (list.length !== 50 || next_after !== last)) throw fail(); return { list, next_after };
}
