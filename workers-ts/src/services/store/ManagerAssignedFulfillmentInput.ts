import { assignmentSnapshot, assignmentRecord, assignmentId, assignmentHash,
  assignmentOperationId, assignmentSame } from '@/services/order/FulfillmentAssignmentProtocol';
import { outRequestHash } from '@/services/out/OutIdempotency';
import type { ManagerOrderActor } from './ManagerOrderOperationRequest';
import { ValidateException } from '@/utils/errors';

export const ASSIGNED_FULFILLMENT_VERSION = 'merchant-assigned-whole-express-v1' as const;
export interface AssignedExpressPayload {
  readonly type: 1; readonly express_record_type: 1;
  readonly delivery_name: string; readonly delivery_code: string; readonly delivery_id: string;
}
export interface AssignedFulfillmentInput {
  readonly version: typeof ASSIGNED_FULFILLMENT_VERSION;
  readonly order_id: number; readonly store_id: number; readonly scope_key: string;
  readonly assignment_operation_id: string; readonly assignment_ordinal: number;
  readonly assignment_payload_hash: string; readonly expected_assignment_source_hash: string;
  readonly expected_order_revision: string; readonly payload: AssignedExpressPayload;
}
export interface AssignedFulfillmentRecord {
  readonly actor_uid: number; readonly request_key: string; readonly format_version: 1;
  readonly kind: 'assigned_whole_express'; readonly outcome: 'delivery-recorded';
  readonly request_hash: string; readonly target_store_id: number; readonly staff_id: number; readonly scope_key: string;
  readonly root_order_id: number; readonly order_id: number; readonly customer_uid: number;
  readonly financial_store_id: 0; readonly supplier_id: 0;
  readonly assignment_operation_id: string; readonly assignment_ordinal: number;
  readonly assignment_payload_hash: string; readonly assignment_source_hash: string;
  readonly assignment_order_revision: string; readonly expected_order_revision: string;
  readonly post_order_revision: string; readonly delivery_outbox_id: number; readonly delivery_event_key: string;
  readonly delivery_payload_hash: string; readonly intent: AssignedFulfillmentInput; readonly created_at: number;
}
export type AssignedFulfillmentReceipt = Readonly<Omit<AssignedFulfillmentRecord, 'intent'>>;
const invalid = () => new ValidateException('分配单快递履约请求或回执不完整');
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || [...value].length > max
    || /[\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  return value;
}
export function captureAssignedActor(value: ManagerOrderActor): Readonly<ManagerOrderActor> {
  const r = assignmentRecord(assignmentSnapshot(value, { nodes: 16, bytes: 512, string: 128 }), ['uid', 'authVersion', 'expiresAt']);
  if (typeof r.authVersion !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/u.test(r.authVersion)
    || typeof r.expiresAt !== 'number' || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= 0) throw invalid();
  return Object.freeze({ uid: assignmentId(r.uid), authVersion: r.authVersion, expiresAt: r.expiresAt });
}
export function captureAssignedFulfillmentInput(value: unknown): Readonly<AssignedFulfillmentInput> {
  const r = assignmentRecord(assignmentSnapshot(value, { nodes: 64, bytes: 8192, string: 1024 }), [
    'version','order_id','store_id','scope_key','assignment_operation_id','assignment_ordinal','assignment_payload_hash',
    'expected_assignment_source_hash','expected_order_revision','payload']);
  const p = assignmentRecord(r.payload, ['type','express_record_type','delivery_name','delivery_code','delivery_id']);
  if (r.version !== ASSIGNED_FULFILLMENT_VERSION || p.type !== 1 || p.express_record_type !== 1) throw invalid();
  const ordinal = assignmentId(r.assignment_ordinal);
  if (ordinal > 64) throw invalid();
  return Object.freeze({ version: ASSIGNED_FULFILLMENT_VERSION, order_id: assignmentId(r.order_id), store_id: assignmentId(r.store_id),
    scope_key: assignmentHash(r.scope_key), assignment_operation_id: assignmentOperationId(r.assignment_operation_id),
    assignment_ordinal: ordinal, assignment_payload_hash: assignmentHash(r.assignment_payload_hash),
    expected_assignment_source_hash: assignmentHash(r.expected_assignment_source_hash), expected_order_revision: assignmentHash(r.expected_order_revision),
    payload: Object.freeze({ type: 1, express_record_type: 1, delivery_name: text(p.delivery_name, 64),
      delivery_code: text(p.delivery_code, 50), delivery_id: text(p.delivery_id, 64) }) });
}
export function assignedFulfillmentHash(actorUid: number, key: string, input: AssignedFulfillmentInput): Promise<string> {
  return outRequestHash({ domain: ASSIGNED_FULFILLMENT_VERSION, actor_uid: assignmentId(actorUid),
    request_key: assignmentOperationId(key), intent: input });
}
export async function decodeAssignedFulfillmentRecord(value: unknown): Promise<AssignedFulfillmentRecord> {
  const r = assignmentRecord(assignmentSnapshot(value, { nodes: 128, bytes: 16384, string: 2048 }), [
    'actor_uid','request_key','format_version','kind','outcome','request_hash','target_store_id','staff_id','scope_key',
    'root_order_id','order_id','customer_uid','financial_store_id','supplier_id','assignment_operation_id','assignment_ordinal',
    'assignment_payload_hash','assignment_source_hash','assignment_order_revision','expected_order_revision','post_order_revision',
    'delivery_outbox_id','delivery_event_key','delivery_payload_hash','intent','created_at']);
  if (r.format_version !== 1 || r.kind !== 'assigned_whole_express' || r.outcome !== 'delivery-recorded'
    || r.financial_store_id !== 0 || r.supplier_id !== 0) throw invalid();
  const intent = captureAssignedFulfillmentInput(r.intent);
  const time = typeof r.created_at === 'string' && /^[1-9][0-9]{0,15}$/u.test(r.created_at) ? Number(r.created_at) : r.created_at;
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0) throw invalid();
  const record: AssignedFulfillmentRecord = Object.freeze({ actor_uid: assignmentId(r.actor_uid), request_key: assignmentOperationId(r.request_key),
    format_version: 1, kind: 'assigned_whole_express', outcome: 'delivery-recorded', request_hash: assignmentHash(r.request_hash),
    target_store_id: assignmentId(r.target_store_id), staff_id: assignmentId(r.staff_id), scope_key: assignmentHash(r.scope_key),
    root_order_id: assignmentId(r.root_order_id), order_id: assignmentId(r.order_id), customer_uid: assignmentId(r.customer_uid),
    financial_store_id: 0, supplier_id: 0, assignment_operation_id: assignmentOperationId(r.assignment_operation_id),
    assignment_ordinal: assignmentId(r.assignment_ordinal), assignment_payload_hash: assignmentHash(r.assignment_payload_hash),
    assignment_source_hash: assignmentHash(r.assignment_source_hash), assignment_order_revision: assignmentHash(r.assignment_order_revision),
    expected_order_revision: assignmentHash(r.expected_order_revision), post_order_revision: assignmentHash(r.post_order_revision),
    delivery_outbox_id: assignmentId(r.delivery_outbox_id), delivery_event_key: text(r.delivery_event_key, 128),
    delivery_payload_hash: assignmentHash(r.delivery_payload_hash), intent, created_at: time });
  if (record.root_order_id !== record.order_id || record.assignment_ordinal > 64
    || record.delivery_event_key !== 'order.delivery.notice:' + record.order_id
    || record.expected_order_revision !== record.assignment_order_revision
    || record.order_id !== intent.order_id || record.target_store_id !== intent.store_id || record.scope_key !== intent.scope_key
    || record.assignment_operation_id !== intent.assignment_operation_id || record.assignment_ordinal !== intent.assignment_ordinal
    || record.assignment_payload_hash !== intent.assignment_payload_hash || record.assignment_source_hash !== intent.expected_assignment_source_hash
    || record.expected_order_revision !== intent.expected_order_revision
    || await assignedFulfillmentHash(record.actor_uid, record.request_key, intent) !== record.request_hash) throw invalid();
  return record;
}
export function assignedFulfillmentReceipt(value: AssignedFulfillmentRecord): AssignedFulfillmentReceipt {
  const { intent: _intent, ...receipt } = value; return Object.freeze(receipt);
}
export function assertAssignedSameRequest(prior: AssignedFulfillmentRecord, actorUid: number, key: string,
  input: AssignedFulfillmentInput, hash: string): boolean {
  return prior.actor_uid === actorUid && prior.request_key === key && prior.request_hash === hash
    && assignmentSame(prior.intent, input);
}
