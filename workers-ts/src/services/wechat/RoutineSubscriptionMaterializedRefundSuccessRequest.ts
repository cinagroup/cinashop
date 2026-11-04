import { randomUUID } from 'node:crypto';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { inspectRoutineSubscriptionDeliveryCatalog } from '@/migrations/routineSubscriptionDelivery';
import { readRoutineSubscriptionNoticeWriterTx } from './RoutineSubscriptionNoticeRequest';
import { readRoutineMaterializedRefundSuccessSourceTx } from './RoutineSubscriptionMaterializedRefundSource';
import { freezeSubscription, routineSubscriptionUnavailable, subscriptionInteger, subscriptionMac, subscriptionObject } from './RoutineSubscriptionAccount';
import { captureRoutineSubscriptionMaterializedRefundSuccessBusiness, captureRoutineSubscriptionMaterializedRefundSuccessDecision,
  type RoutineSubscriptionMaterializedRefundSuccessBusiness, type RoutineSubscriptionMaterializedRefundSuccessDecision,
  type RoutineSubscriptionMaterializedRefundSuccessRequest } from './RoutineSubscriptionMaterializedRefundSuccessEvidenceCodec';

export { captureRoutineSubscriptionMaterializedRefundSuccessBusiness, captureRoutineSubscriptionMaterializedRefundSuccessDecision,
  assertRoutineSubscriptionMaterializedRefundSuccessDecision, parseRoutineSubscriptionMaterializedRefundSuccessRequest } from './RoutineSubscriptionMaterializedRefundSuccessEvidenceCodec';
export type { RoutineSubscriptionMaterializedRefundSuccessBusiness, RoutineSubscriptionMaterializedRefundSuccessDecision,
  RoutineSubscriptionMaterializedRefundSuccessRequest, RoutineSubscriptionMaterializedRefundSuccessSource } from './RoutineSubscriptionMaterializedRefundSuccessEvidenceCodec';

type Query = Pick<DbClient, 'execute'>;
type Signing = Readonly<{ APP_KEY?: string }>;
export interface RoutineSubscriptionMaterializedRefundSuccessUnavailable { readonly format: 6; readonly unavailable: true }
export type RoutineSubscriptionMaterializedRefundSuccessRequestOutcome = { readonly kind: 'legacy' } | {
  readonly kind: 'original'; readonly request: Readonly<RoutineSubscriptionMaterializedRefundSuccessRequest | RoutineSubscriptionMaterializedRefundSuccessUnavailable>;
};
const UNAVAILABLE = Object.freeze({ kind: 'original' as const, request: Object.freeze({ format: 6 as const, unavailable: true as const }) });
function signing(env: Signing | undefined): Readonly<Pick<Env, 'APP_KEY'>> | undefined {
  if (!env || typeof env !== 'object') return;
  const d = Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192) return;
  return Object.freeze({ APP_KEY: d.value });
}
function capture(raw: { eventKey: string; aggregateId: number; payload: RoutineSubscriptionMaterializedRefundSuccessBusiness; now: number }) {
  const r = subscriptionObject(raw, ['eventKey', 'aggregateId', 'payload', 'now']), body = captureRoutineSubscriptionMaterializedRefundSuccessBusiness(r.payload);
  if (r.eventKey !== `order.refund.success.notice:${body.refundId}` || r.aggregateId !== body.orderId || !subscriptionInteger(r.now)) {
    return routineSubscriptionUnavailable();
  }
  return Object.freeze({ eventKey: r.eventKey as string, aggregateId: body.orderId, body, eventTime: r.now });
}
/** A new format6 candidate only. The source helper reads public immutable
 * materialization and public physical rows, never provider/identity/policy
 * authority. Entire namespace absence is legacy; present-but-unready is6.
 * SQL faults propagate for the caller's real optional SAVEPOINT isolation. */
export async function createRoutineSubscriptionMaterializedRefundSuccessRequestTx(tx: Query, env: Signing | undefined,
  raw: { eventKey: string; aggregateId: number; payload: RoutineSubscriptionMaterializedRefundSuccessBusiness; now: number }): Promise<RoutineSubscriptionMaterializedRefundSuccessRequestOutcome> {
  const captured = capture(raw), key = signing(env);
  const catalog = await inspectRoutineSubscriptionDeliveryCatalog(tx), binding = catalog.binding;
  if (!catalog.present) return Object.freeze({ kind: 'legacy' as const });
  if (!catalog.ready || !binding?.app || !binding.appOid || !key || Object.hasOwn(tx, '$client') || captured.body.userId === 0) return UNAVAILABLE;
  const writer = await readRoutineSubscriptionNoticeWriterTx(tx, binding); if (!writer) return UNAVAILABLE;
  const b = captured.body, source = await readRoutineMaterializedRefundSuccessSourceTx(tx, b);
  let decision: Readonly<RoutineSubscriptionMaterializedRefundSuccessDecision>;
  try {
    decision = captureRoutineSubscriptionMaterializedRefundSuccessDecision(key, source.refund, b, captured.eventTime,
      { materializationDigest: source.materializationDigest, selectedDigest: source.selectedDigest });
  } catch { return UNAVAILABLE; }
  const body = { format: 6 as const, requestId: randomUUID(), scope: writer.scope, actor: writer.actor,
    eventKey: captured.eventKey, aggregateId: captured.aggregateId, eventTime: captured.eventTime, body: b, decision, createdAt: writer.createdAt };
  return Object.freeze({ kind: 'original' as const, request: freezeSubscription({ ...body,
    signature: subscriptionMac(key, 'materialized-refund-success-notice-request', body) }) });
}
