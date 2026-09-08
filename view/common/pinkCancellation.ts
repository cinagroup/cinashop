/** Durable identity only: never store a token, provider result or permission. */
export interface PinkCancellationIntent { version: 1; uid: number; pinkId: number; cid: number }
export const pinkCancellationKey = (uid: number, pinkId: number) => `cinashop_pink_cancel_v1_${uid}_${pinkId}`;
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647;
const invalid = (): never => { throw new Error('取消记录无效，请核对本人订单，不要重新申请'); };
export function decodePinkCancellation(value: unknown, uid: number, pinkId: number): PinkCancellationIntent {
  if (typeof value !== 'string' || value.length > 512) return invalid();
  let row: PinkCancellationIntent;
  try { row = JSON.parse(value); } catch { return invalid(); }
  if (!row || row.version !== 1 || !positive(uid) || !positive(pinkId) || row.uid !== uid || row.pinkId !== pinkId || !positive(row.cid) ||
    Object.keys(row).sort().join(',') !== 'cid,pinkId,uid,version') return invalid();
  return { version: 1, uid, pinkId, cid: row.cid };
}
export function parsePinkCancellation(value: unknown, intent: PinkCancellationIntent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  const states = ['not_applied', 'accepted', 'processing', 'unknown', 'completed', 'needs_attention'] as const;
  const state = row.state as typeof states[number];
  if (!states.includes(state) || row.uid !== intent.uid || row.pink_id !== intent.pinkId || row.combination_id !== intent.cid ||
    row.completed !== (state === 'completed') || row.resumable !== ['accepted', 'processing', 'unknown'].includes(state) ||
    typeof row.current_pink_order !== 'string' || !row.current_pink_order || row.current_pink_order.length > 128 ||
    /[\s\u0000-\u001f\u007f]/u.test(row.current_pink_order)) return invalid();
  return { state, completed: state === 'completed', resumable: row.resumable as boolean, orderId: row.current_pink_order };
}
export type PinkCancellationReceipt = ReturnType<typeof parsePinkCancellation>;
export const pinkCancellationText: Record<PinkCancellationReceipt['state'], string> = {
  not_applied: '暂未查到取消申请；不代表先前请求失败，请保留原团记录。',
  accepted: '取消申请已受理，退款尚未完成。',
  processing: '取消退款处理中，尚未确认完成。',
  unknown: '取消退款结果未知，请查询或显式继续处理同一申请。',
  completed: '服务端已确认该团取消退款完成，实际到账请核对支付账户。',
  needs_attention: '取消记录需要人工核对，请联系店铺客服并核对本人订单。',
};
