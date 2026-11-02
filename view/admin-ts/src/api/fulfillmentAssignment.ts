import { sendOrderRequest } from '@/utils/orderRequest';
import { captureAdminAssignment, parseAdminAssignmentReceipt, parseAdminAssignmentReview, parseAssignmentStores,
  assignmentObject, assignmentSnapshot, assignmentId, assignmentUuid,
  type AdminAssignmentInput, type AdminAssignmentReceipt,
} from '../../../common/fulfillmentAssignment';

const base = '/order/fulfillment_assignment';
export async function assignmentReview(orderId: number, signal?: AbortSignal) {
  const id = assignmentId(orderId);
  return parseAdminAssignmentReview(await sendOrderRequest(base + '/review/' + id, 'get', undefined, undefined, signal), id);
}
export async function assignmentStores(after = 0, signal?: AbortSignal) {
  assignmentId(after, true);
  return parseAssignmentStores(await sendOrderRequest(base + '/stores', 'get', undefined, after ? { after } : undefined, signal), after);
}
export async function assignmentCommit(value: AdminAssignmentInput, actor: number, signal?: AbortSignal) {
  const input = captureAdminAssignment(value), uid = assignmentId(actor);
  const result = assignmentObject(assignmentSnapshot(await sendOrderRequest(base + '/commit', 'post', input, undefined, signal), 8192), ['receipt','replayed']);
  if (typeof result.replayed !== 'boolean') throw Error('分配提交结果未确认，请查询原请求');
  return { receipt: await parseAdminAssignmentReceipt(result.receipt, uid, input), replayed: result.replayed };
}
export async function assignmentReceipt(input: AdminAssignmentInput, actor: number, signal?: AbortSignal): Promise<AdminAssignmentReceipt | null> {
  const captured = captureAdminAssignment(input), uid = assignmentId(actor), key = assignmentUuid(captured.operation_id);
  const result = assignmentObject(assignmentSnapshot(await sendOrderRequest(base + '/receipt/' + key, 'get', undefined, undefined, signal), 8192), ['state','receipt']);
  if (result.state === 'unknown' && result.receipt === null) return null;
  if (result.state !== 'recorded' || result.receipt === null) throw Error('原请求回执不完整，请继续保留原请求');
  return parseAdminAssignmentReceipt(result.receipt, uid, captured);
}
