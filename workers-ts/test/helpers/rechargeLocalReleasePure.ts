/** Synthetic MAC fixtures only, with no physical/provider/funds authority. */
import { captureRechargeRefundReleaseFacts, signRechargeRefundLocalReleaseResult } from '@/services/payment/RechargeRefundLocalReleaseCodec';
import { signRechargeRefundRecord } from '@/services/payment/RechargeRefundLedger';
import type { RechargeRefundFirstProviderStatus } from '@/services/payment/RechargeRefundFirstProviderResult';
import { rechargeLocalCapturePureFixture, localCaptureScope as scope, localCaptureSigning as env } from './rechargeLocalCapturePure';
export { localCaptureScope as localReleaseScope, localCaptureSigning as localReleaseSigning } from './rechargeLocalCapturePure';

export function rechargeLocalReleasePureFixture(reclaimGift = true, status: RechargeRefundFirstProviderStatus = 'CLOSED', operationPatch: Record<string, unknown> = {}) {
  const f = rechargeLocalCapturePureFixture(reclaimGift, status, operationPatch), capture = f.facts();
  const { successTime: _time, ...provider } = capture.provider;
  const { postReservationBalanceCents: _reserved, ...recharge } = capture.recharge;
  const facts = (beforeCents = 1700, patch: Record<string, unknown> = {}) => ({ format: 1,
    purpose: 'recharge-refund-closed-release-facts-v1', scope, localResultId: capture.localResultId,
    operation: capture.operation, request: capture.request, provider, recharge: { ...recharge, refundAfterCents: 0 },
    holdBillId: capture.holdBillId, wallet: { beforeCents, afterCents: beforeCents + Number(recharge.debitCents) },
    bill: { id: 93, uid: recharge.buyerUid, linkId: recharge.orderNo,
      eventKey: 'recharge_refund_release:' + String(capture.operation.id), pm: 1, category: 'now_money', type: 'recharge_refund_release',
      title: '渠道关闭充值退款退回预留', numberCents: recharge.debitCents, balanceCents: beforeCents + Number(recharge.debitCents),
      status: 1, take: 0, frozenTime: 0, addTime: 1103, mark: '渠道已确认关闭，退回原充值退款预留' },
    projection: { beforeVersion: 1, afterVersion: 2 }, releasedAt: 1103, ...patch });
  const release = (value: unknown = facts()) => captureRechargeRefundReleaseFacts(env, scope, f.history, value);
  const local = (value: unknown = facts()) => signRechargeRefundLocalReleaseResult(env, scope, f.history, value);
  const signedLocal = (evidencePatch: Record<string, unknown> = {}, recordPatch: Record<string, unknown> = {}) => {
    const { signature: _sig, ...r } = local();
    return signRechargeRefundRecord(env, scope, 'recharge_refund_result', { ...r,
      evidence: { ...(r.evidence as Record<string, unknown>), ...evidencePatch }, ...recordPatch });
  };
  return { history: f.history, facts, release, local, signedLocal };
}
