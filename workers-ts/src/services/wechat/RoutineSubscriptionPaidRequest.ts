/** A new-payment candidate only; fresh staging/dispatch independently prove authority. */
import { randomUUID } from 'node:crypto';
import type { Env } from '@/env';
import { ServiceUnavailableException } from '@/utils/errors';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { inspectRoutineSubscriptionDeliveryCatalog } from '@/migrations/routineSubscriptionDelivery';
import { capturePaidNoticeBusiness, paidNoticeEventKey, type PaidNoticeBusiness } from '@/services/order/OrderPaidNoticeCodec';
import { readRoutineSubscriptionNoticeWriterTx } from './RoutineSubscriptionNoticeRequest';
import { readPaidSubscriptionFamilyTx, selectPaidSubscriptionOwnerTx } from './RoutineSubscriptionPaidSource';
import { freezeSubscription } from './RoutineSubscriptionAccount';
import { paidSubscriptionInteger, paidSubscriptionMac, parseRoutineSubscriptionPaidRequest, type RoutineSubscriptionPaidRequest } from './RoutineSubscriptionPaidEvidenceCodec';
export { parseRoutineSubscriptionPaidRequest } from './RoutineSubscriptionPaidEvidenceCodec';
export type { RoutineSubscriptionPaidRequest } from './RoutineSubscriptionPaidEvidenceCodec';
export interface RoutineSubscriptionPaidUnavailable { readonly format: 7; readonly unavailable: true }
const UNAVAILABLE = Object.freeze({ kind: 'original' as const, request: Object.freeze({ format: 7 as const, unavailable: true as const }) });
export async function createRoutineSubscriptionPaidRequestTx(tx: DbClient, env: Readonly<{ APP_KEY?: string }> | undefined,
  input: { eventKey: string; aggregateId: number; payload: PaidNoticeBusiness; now: number }): Promise<{
    readonly kind: 'original'; readonly request: Readonly<RoutineSubscriptionPaidRequest | RoutineSubscriptionPaidUnavailable> }> {
  const body = capturePaidNoticeBusiness(input.payload), d = env && Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192 || body.userId === 0
    || input.eventKey !== paidNoticeEventKey(body.orderId) || input.aggregateId !== body.orderId || input.now !== body.occurredAt || !paidSubscriptionInteger(input.now)
    || Object.hasOwn(tx, '$client')) return UNAVAILABLE;
  const key = Object.freeze({ APP_KEY: d.value }) as Pick<Env, 'APP_KEY'>;
  try {
    return await withTx(createContainerFromDb(tx), async nested => {
      const catalog = await inspectRoutineSubscriptionDeliveryCatalog(nested), binding = catalog.binding;
      if (!catalog.ready || !binding?.app || !binding.appOid) return UNAVAILABLE;
      const writer = await readRoutineSubscriptionNoticeWriterTx(nested, binding);
      if (!writer || writer.actor.role !== binding.app || writer.actor.roleOid !== binding.appOid) return UNAVAILABLE;
      const source = await readPaidSubscriptionFamilyTx(nested, key, body), selection = await selectPaidSubscriptionOwnerTx(nested, key, source);
      const unsigned = { format: 7 as const, requestId: randomUUID(), ...writer, eventKey: input.eventKey, aggregateId: body.orderId,
        eventTime: body.occurredAt, body, selection, familyDigest: source.familyDigest, paymentDigest: source.paymentDigest };
      const request = parseRoutineSubscriptionPaidRequest(key, { ...unsigned, signature: paidSubscriptionMac(key, 'paid-notice-request', unsigned) }, writer.scope);
      return Object.freeze({ kind: 'original' as const, request: freezeSubscription(request) });
    });
  } catch (error) {
    // Only a proved absent/ambiguous source is frozen as unavailable. SQL
    // contention and unexpected failures must roll back the paid effects so
    // the same admitted payment can retry instead of losing its Mini notice.
    if (error instanceof ServiceUnavailableException) return UNAVAILABLE;
    throw error;
  }
}
