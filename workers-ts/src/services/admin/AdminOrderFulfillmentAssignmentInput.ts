/** Closed inputs and immutable receipts for the controlled Admin author. */
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { ValidateException } from '@/utils/errors';

export const ASSIGNMENT_FORMAT = 1 as const;
export const ASSIGNMENT_CHAIN_LIMIT = 64;
export const ASSIGNMENT_CHAIN_BYTES = 1024 * 1024;
export interface AssignmentHead { readonly ordinal: number; readonly operation_id: string | null }
export interface AssignmentRequest {
  readonly format_version: 1;
  readonly operation_id: string;
  readonly kind: 'grant' | 'revoke';
  readonly order_id: number;
  readonly target_store_id: number;
  readonly expected_head: AssignmentHead;
  readonly expected_order_revision: string;
  readonly expected_source_hash: string;
}
export interface AssignmentCartSource {
  readonly row_id: number; readonly cart_id: string; readonly product_id: number;
  /** The real sku_unique, NOT store_order_cart_info.unique. */
  readonly unique: string; readonly quantity: number;
}
export interface AssignmentSource { readonly cart_rows: readonly AssignmentCartSource[] }
export interface AssignmentEvent {
  readonly operation_id: string; readonly format_version: 1; readonly kind: 'grant' | 'revoke';
  readonly actor_id: number; readonly root_order_id: number; readonly order_id: number;
  readonly target_store_id: number; readonly customer_uid: number; readonly financial_store_id: 0;
  readonly ordinal: number; readonly previous_ref: string | null; readonly order_revision: string;
  readonly payload_hash: string; readonly source_hash: string; readonly source: AssignmentSource;
  readonly created_at: number;
}
export type AssignmentReceipt = Readonly<Omit<AssignmentEvent, 'source'>>;

export function assignmentBytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).byteLength;
}
/** No accessors, inherited fields, toJSON, symbols, coercion or mutable aliases.
 * Budgets are applied before any asynchronous operation. */
export function assignmentSnapshot(value: unknown, limits = { nodes: 8192, bytes: 2 * 1024 * 1024, string: 65536 }): unknown {
  let nodes = 0, bytes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > limits.nodes || depth > 12) throw new ValidateException('分配数据超过容量');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (typeof v === 'string') {
      bytes += new TextEncoder().encode(v).byteLength;
      if (bytes > limits.bytes || new TextEncoder().encode(v).byteLength > limits.string) throw new ValidateException('分配字段超过容量');
      return v;
    }
    if (!v || typeof v !== 'object' || (Array.isArray(v) ? Object.getPrototypeOf(v) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)))) throw new ValidateException('分配数据须为有限纯 JSON');
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      if (v.length > 200 || keys.length !== v.length + 1 || keys.some(k => typeof k !== 'string' || k !== 'length'
        && (!/^(0|[1-9][0-9]*)$/u.test(k) || Number(k) >= v.length))) throw new ValidateException('分配数组格式错误');
      return Object.freeze(Array.from({ length: v.length }, (_, i) => {
        const d = ds[String(i)];
        if (!d?.enumerable || !('value' in d)) throw new ValidateException('分配数组不能包含访问器');
        return walk(d.value, depth + 1);
      }));
    }
    const r: Record<string, unknown> = Object.create(null);
    for (const k of keys) {
      if (typeof k !== 'string' || !ds[k]?.enumerable || !('value' in ds[k])
        || ['__proto__', 'constructor', 'prototype'].includes(k)) throw new ValidateException('分配字段不是显式数据');
      bytes += new TextEncoder().encode(k).byteLength;
      if (bytes > limits.bytes) throw new ValidateException('分配字段超过容量');
      r[k] = walk(ds[k].value, depth + 1);
    }
    return Object.freeze(r);
  };
  const result = walk(value, 0);
  if (assignmentBytes(result) > limits.bytes) throw new ValidateException('分配数据超过容量');
  return result;
}
export function assignmentRecord(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    || Reflect.ownKeys(v).length !== keys.length
    || keys.some(k => !Object.hasOwn(v, k))
    || Reflect.ownKeys(v).some(k => typeof k !== 'string' || !keys.includes(k))) throw new ValidateException('分配字段缺失或包含未知字段');
  return v as Record<string, unknown>;
}
export function assignmentId(v: unknown, zero = false): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < (zero ? 0 : 1) || v > 2147483647) throw new ValidateException('分配标识无效');
  return v;
}
export function assignmentHash(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-f0-9]{64}$/u.test(v)) throw new ValidateException('分配来源摘要无效');
  return v;
}
export function assignmentOperationId(v: unknown): string {
  return normalizeOutRequestKey(v);
}
export function assignmentRouteId(v: unknown): number {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,9}$/u.test(v)) throw new ValidateException('订单标识无效');
  return assignmentId(Number(v));
}
export function assignmentNoQuery(q: URLSearchParams): void {
  if ([...q.keys()].length) throw new ValidateException('分配接口不接受查询参数');
}
export function captureAssignmentActor(value: AdminAuthorityActor): Readonly<AdminAuthorityActor> {
  const r = assignmentRecord(assignmentSnapshot(value, { nodes: 16, bytes: 512, string: 128 }), ['id', 'authVersion', 'expiresAt']);
  const actor = Object.freeze({ id: assignmentId(r.id), authVersion: r.authVersion as string, expiresAt: r.expiresAt as number });
  assertAdminAuthoritySession(actor);
  return actor;
}
export function captureAssignmentRequest(value: unknown): Readonly<AssignmentRequest> {
  const r = assignmentRecord(assignmentSnapshot(value, { nodes: 32, bytes: 4096, string: 128 }),
    ['format_version', 'operation_id', 'kind', 'order_id', 'target_store_id', 'expected_head', 'expected_order_revision', 'expected_source_hash']);
  if (r.format_version !== ASSIGNMENT_FORMAT || r.kind !== 'grant' && r.kind !== 'revoke') throw new ValidateException('分配请求版本或操作无效');
  const h = assignmentRecord(r.expected_head, ['ordinal', 'operation_id']), ordinal = assignmentId(h.ordinal, true);
  const operation_id = h.operation_id === null ? null : assignmentOperationId(h.operation_id);
  if ((ordinal === 0) !== (operation_id === null) || ordinal >= 2147483647) throw new ValidateException('分配前驱无效');
  return Object.freeze({ format_version: ASSIGNMENT_FORMAT, operation_id: assignmentOperationId(r.operation_id), kind: r.kind,
    order_id: assignmentId(r.order_id), target_store_id: assignmentId(r.target_store_id),
    expected_head: Object.freeze({ ordinal, operation_id }), expected_order_revision: assignmentHash(r.expected_order_revision),
    expected_source_hash: assignmentHash(r.expected_source_hash) });
}
export function captureAssignmentSource(value: unknown): AssignmentSource {
  const r = assignmentRecord(assignmentSnapshot(value), ['cart_rows']);
  if (!Array.isArray(r.cart_rows) || !r.cart_rows.length || r.cart_rows.length > 200) throw new ValidateException('分配商品须为1至200行');
  let lastId = 0;
  const carts = new Set<string>();
  const cart_rows = r.cart_rows.map(v => {
    const row = assignmentRecord(v, ['row_id', 'cart_id', 'product_id', 'unique', 'quantity']);
    const row_id = assignmentId(row.row_id), product_id = assignmentId(row.product_id), quantity = assignmentId(row.quantity);
    if (row_id <= lastId || typeof row.cart_id !== 'string' || [...row.cart_id].length < 1 || [...row.cart_id].length > 50
      || carts.has(row.cart_id) || typeof row.unique !== 'string' || [...row.unique].length > 255) throw new ValidateException('分配商品身份或顺序无效');
    lastId = row_id; carts.add(row.cart_id);
    return Object.freeze({ row_id, cart_id: row.cart_id, product_id, unique: row.unique, quantity });
  });
  const source = Object.freeze({ cart_rows: Object.freeze(cart_rows) });
  if (assignmentBytes(source) > 65536) throw new ValidateException('分配来源超过容量');
  return source;
}
/** Every hashed field is reproducible from one stored event. The current DB
 * source and actor checks supply authority; this digest is NOT a signature. */
export function assignmentRequestHash(a: AssignmentRequest, actorId: number): Promise<string> {
  return outRequestHash({ version: 'store-order-fulfillment-assignment-request-v1', actor_id: assignmentId(actorId),
    format_version: ASSIGNMENT_FORMAT, operation_id: a.operation_id, kind: a.kind, root_order_id: a.order_id,
    order_id: a.order_id, financial_store_id: 0, target_store_id: a.target_store_id, expected_head: a.expected_head,
    expected_order_revision: a.expected_order_revision, expected_source_hash: a.expected_source_hash });
}
export async function decodeAssignmentEvent(value: unknown): Promise<AssignmentEvent> {
  const r = assignmentRecord(assignmentSnapshot(value), ['operation_id', 'format_version', 'kind', 'actor_id', 'root_order_id',
    'order_id', 'target_store_id', 'customer_uid', 'financial_store_id', 'ordinal', 'previous_ref', 'order_revision',
    'payload_hash', 'source_hash', 'source', 'created_at']);
  const ordinal = assignmentId(r.ordinal), previous_ref = r.previous_ref === null ? null : assignmentOperationId(r.previous_ref);
  const created_at = typeof r.created_at === 'string' && /^[1-9][0-9]{0,15}$/u.test(r.created_at) ? Number(r.created_at) : r.created_at;
  if (r.format_version !== 1 || r.kind !== 'grant' && r.kind !== 'revoke' || r.financial_store_id !== 0
    || !Number.isSafeInteger(created_at) || Number(created_at) <= 0 || (ordinal === 1) !== (previous_ref === null)
    || ordinal === 1 && r.kind !== 'grant') throw new ValidateException('原分配回执格式无效');
  const event: AssignmentEvent = Object.freeze({ operation_id: assignmentOperationId(r.operation_id), format_version: ASSIGNMENT_FORMAT,
    kind: r.kind, actor_id: assignmentId(r.actor_id), root_order_id: assignmentId(r.root_order_id), order_id: assignmentId(r.order_id),
    target_store_id: assignmentId(r.target_store_id), customer_uid: assignmentId(r.customer_uid), financial_store_id: 0,
    ordinal, previous_ref, order_revision: assignmentHash(r.order_revision), payload_hash: assignmentHash(r.payload_hash),
    source_hash: assignmentHash(r.source_hash), source: captureAssignmentSource(r.source), created_at: Number(created_at) });
  if (event.root_order_id !== event.order_id || event.previous_ref === event.operation_id
    || await assignmentRequestHash({ format_version: 1, operation_id: event.operation_id, kind: event.kind, order_id: event.order_id,
      target_store_id: event.target_store_id, expected_head: { ordinal: event.ordinal - 1, operation_id: event.previous_ref },
      expected_order_revision: event.order_revision, expected_source_hash: event.source_hash }, event.actor_id) !== event.payload_hash)
    throw new ValidateException('原分配请求与摘要不一致');
  return event;
}
export function assignmentReceipt(event: AssignmentEvent): AssignmentReceipt {
  const { source: _source, ...minimal } = event;
  return Object.freeze(minimal);
}
export function assignmentSame(left: unknown, right: unknown): boolean {
  // Both values must already be normalized/strictly captured by this module.
  return JSON.stringify(left) === JSON.stringify(right);
}
