import {
  and,
  asc,
  eq,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  OrderMessage,
  PaymentCallbackDispatchMessage,
  PaymentCallbackMessage,
} from "@/env";
import type { Container } from "@/lib/di";
import { withTx, type DbClient } from "@/lib/di";
import { appendRoutineOriginalPaymentTx, prepareRoutineOriginalPaymentTx, assertRoutineOriginalReferenceTx } from './RoutineOriginalPaymentEvidence';
import { parseRoutineProviderObservation } from './RoutineProviderObservation';
import { prepareRoutineApprovedUseTx, appendRoutineApprovedUseTx, snapshotRoutinePaymentAccountAuthorization,
  assertRoutineApprovedUseDeadlineTx } from './RoutineApprovedPaymentAccount';
import { persistVerifiedPaymentCallbackTx, providerPaymentSucceeded,
  type VerifiedPaymentCallback, type PaymentCallbackReceiveResult } from './PaymentCallbackPersistence';
export type { VerifiedPaymentCallback, PaymentCallbackReceiveResult } from './PaymentCallbackPersistence';
import { bindOfflineOrderCallbackTx, settleOfflineOrderExternalPayment,
  type OfflineVerifiedCallbackIdentity, type OfflineCallbackReference } from '../order/OfflineOrderExternalPaymentService';
import { prepareOfflinePaymentTransaction } from '../order/OfflineOrderPaymentContext';
import {
  paymentCallbackEvent,
  paymentCallbackOutbox,
  paymentReconciliationCase,
  type PaymentCallbackOrderDomain,
} from "@/models/schema";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import {
  applyProviderStoreOrderPayment,
  type StoreOrderPaymentOutcome,
} from "@/services/order/StoreOrderPayService";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";
import {
  applyRechargePayment,
  findRechargeOrderByOrderId,
} from "@/services/payment/RechargePaymentService";
import {
  resolvePaymentReconciliationFromCallbackTx,
} from "@/services/payment/PaymentReconciliationRegistry";
import {
  applyProviderMembershipPayment,
  findMembershipOrderByOrderId,
} from "@/services/user/PaidMembershipService";
import { ApiException, ServiceUnavailableException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import { assertNativeAppCallbackWitnessInTx } from './NativeAppPaymentAuthority';
import { lockStoreOrderPaymentBoundary } from './StoreOrderPaymentBoundary';

const DISPATCH_LEASE_SECONDS = 120;
const DELIVERY_LEASE_SECONDS = 600;
const PROCESS_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type PaymentCallbackProcessResult =
  | "completed"
  | "ignored"
  | "unknown"
  | "already-completed"
  | "busy"
  | "dead"
  | { kind: "deferred"; delaySeconds: number };

interface PaymentCallbackEnvironment {
  ORDER_QUEUE: Queue<OrderMessage>;
  APP_KEY?: string;
  ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS?: string;
}

interface ClaimedPaymentCallback extends VerifiedPaymentCallback {
  orderDomain: PaymentCallbackOrderDomain;
  eventId: number;
  outboxId: number;
  replayKey: string;
  leaseToken: string;
  attemptCount: number;
}

interface SettlementResult {
  status: "completed" | "unknown";
  domain: PaymentCallbackOrderDomain;
  errorCode: string;
}

export type PaymentCallbackSettler = (
  callback: VerifiedPaymentCallback & OfflineCallbackReference,
) => Promise<SettlementResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isPaymentCallbackMessage(value: unknown): value is PaymentCallbackMessage {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 3
    && ["action", "eventId", "replayKey"].every((key) => Object.hasOwn(value, key))
    && value.action === "processPaymentCallback"
    && Number.isSafeInteger(value.eventId)
    && Number(value.eventId) > 0
    && typeof value.replayKey === "string"
    && UUID_V4.test(value.replayKey);
}

export function isPaymentCallbackDispatchMessage(
  value: unknown,
): value is PaymentCallbackDispatchMessage {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 2
    && value.action === "dispatchPaymentCallbackOutbox"
    && Number.isSafeInteger(value.scheduledAt)
    && Number(value.scheduledAt) > 0;
}

function paymentCallbackMessage(event: {
  eventId: number;
  replayKey: string;
}): PaymentCallbackMessage {
  return {
    action: "processPaymentCallback",
    eventId: event.eventId,
    replayKey: event.replayKey,
  };
}

function retryDelay(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, Math.min(attempt, MAX_ATTEMPTS) - 1), 3600);
}

function callbackErrorCode(error: unknown): string {
  if (error instanceof ServiceUnavailableException) return 'payment_dependency_unavailable';
  if (error instanceof ApiException) return "payment_business_validation";
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : "payment_callback_processing_failed";
}

function domainOutcome(
  domain: PaymentCallbackOrderDomain,
  outcome: StoreOrderPaymentOutcome | "paid" | "already-paid" | "not-payable" | "missing",
): SettlementResult {
  if (outcome === "paid" || outcome === "already-paid") {
    return { status: "completed", domain, errorCode: "" };
  }
  return {
    status: "unknown",
    domain,
    errorCode: outcome === "not-payable" ? "order_not_payable" : "order_missing",
  };
}

export class PaymentCallbackEventService {
  private readonly settler: PaymentCallbackSettler;

  constructor(
    private readonly container: Container,
    private readonly env: PaymentCallbackEnvironment,
    settler?: PaymentCallbackSettler,
  ) {
    this.settler = settler ?? ((callback) => this.settle(callback));
  }

  async receive(callback: VerifiedPaymentCallback, identity?: OfflineVerifiedCallbackIdentity, routineProof?: unknown, routineAccountAuthorization?: unknown): Promise<PaymentCallbackReceiveResult> {
    callback = { ...callback };
    const proof = routineProof === undefined ? undefined : parseRoutineProviderObservation({ APP_KEY: this.env.APP_KEY ?? '' }, routineProof);
    const accountAuthorization = snapshotRoutinePaymentAccountAuthorization({ APP_KEY: this.env.APP_KEY ?? '' }, routineAccountAuthorization);
    const offline = /^xx[0-9a-f]{30}$/.test(callback.orderNo) && providerPaymentSucceeded(callback);
    if (offline && !identity) throw new Error("offline_callback_verified_identity_required");
    return withTx(this.container, async tx => {
      if (offline) await prepareOfflinePaymentTransaction(tx);
      const routine = callback.provider === 'wechat' && callback.profile === 'routine' && callback.tradeState === 'SUCCESS' && !offline;
      if (accountAuthorization !== undefined && !routine) throw Error('routine_approved_callback_scope_required');
      const accountUse = routine ? await prepareRoutineApprovedUseTx(tx,
        { APP_KEY: this.env.APP_KEY ?? '', ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: this.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS }, accountAuthorization, proof) : null;
      const prepared = routine ? await prepareRoutineOriginalPaymentTx(tx, { APP_KEY: this.env.APP_KEY ?? '' }, proof,
        { source: 'callback', ...callback }) : null;
      const original = prepared ? await appendRoutineOriginalPaymentTx(tx, { APP_KEY: this.env.APP_KEY ?? '' }, prepared) : null;
      const finish = async <T>(value: T): Promise<T> => { await assertRoutineApprovedUseDeadlineTx(tx,accountUse); return value; };
      if (accountUse && !original) throw Error('routine_approved_original_storage_required');
      if (original) {
        const use = await appendRoutineApprovedUseTx(tx,
          { APP_KEY: this.env.APP_KEY ?? '', ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS: this.env.ROUTINE_PAYMENT_ACCOUNT_CREDENTIALS }, accountUse, original.row);
        original.conflict ||= !use.scopeMatches;
      }
      if (callback.provider === 'wechat' && callback.profile === 'app') {
        await lockStoreOrderPaymentBoundary(tx, callback.orderNo);
        await assertNativeAppCallbackWitnessInTx(tx, { APP_KEY: this.env.APP_KEY ?? '' }, callback);
      }
      const received = await persistVerifiedPaymentCallbackTx(tx, callback);
      if (original?.conflict && !received.terminalConflict) {
        // Keep the genuine verified observation and minimized event together;
        // conflicting/unresolved original facts cannot dispatch settlement.
        const now = Math.floor(Date.now()/1000);
        await tx.update(paymentCallbackEvent).set({ status: 'UNKNOWN', lastErrorCode: 'routine_original_evidence_conflict', processedTime: now })
          .where(eq(paymentCallbackEvent.id, received.eventId));
        await tx.update(paymentCallbackOutbox).set({ status: 'COMPLETED', processedTime: now })
          .where(eq(paymentCallbackOutbox.id, received.outboxId));
        await tx.update(paymentReconciliationCase).set({ status: 'CONFLICT', nextCheckTime: 0, leaseUntil: 0, leaseToken: '',
          lastErrorCode: 'routine_original_evidence_conflict', resolvedTime: now, updateTime: now })
          .where(and(eq(paymentReconciliationCase.provider, callback.provider), eq(paymentReconciliationCase.orderNo, callback.orderNo)));
        return finish({ ...received, terminalConflict: true });
      }
      if (offline && identity && !received.terminalConflict) {
        const [recovery] = await tx.select({ status: paymentReconciliationCase.status }).from(paymentReconciliationCase)
          .where(and(eq(paymentReconciliationCase.provider, callback.provider), eq(paymentReconciliationCase.orderNo, callback.orderNo)));
        if (recovery?.status === 'CONFLICT') {
          // Keep newly verified conflicting evidence, without binding it for
          // payment. Throwing here would roll the conflict back and hide it.
          if (!received.duplicate) {
            const now = Math.floor(Date.now() / 1000);
            await tx.update(paymentCallbackEvent).set({ status: 'UNKNOWN', lastErrorCode: 'reconciliation_evidence_conflict', processedTime: now })
              .where(eq(paymentCallbackEvent.id, received.eventId));
            await tx.update(paymentCallbackOutbox).set({ status: 'COMPLETED', processedTime: now })
              .where(eq(paymentCallbackOutbox.id, received.outboxId));
          }
          return finish({ ...received, terminalConflict: true });
        }
        await bindOfflineOrderCallbackTx(tx, { ...received, ...identity });
        await tx.update(paymentCallbackEvent).set({ orderDomain: "offline_order" })
          .where(eq(paymentCallbackEvent.id, received.eventId));
        await tx.update(paymentReconciliationCase).set({ orderDomain: "offline_order" })
          .where(and(eq(paymentReconciliationCase.provider, callback.provider), eq(paymentReconciliationCase.orderNo, callback.orderNo)));
      }
      return finish(received);
    });
  }

  async dispatchPending(
    limit = 20,
    onlyOutboxId?: number,
  ): Promise<{ claimed: number; enqueued: number }> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    const eligible = or(
      and(
        inArray(paymentCallbackOutbox.status, ["PENDING", "FAILED"]),
        lte(paymentCallbackOutbox.availableTime, now),
      ),
      and(
        inArray(paymentCallbackOutbox.status, ["ENQUEUING", "ENQUEUED", "PROCESSING"]),
        lte(paymentCallbackOutbox.leaseUntil, now),
      ),
    );
    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        outboxId: paymentCallbackOutbox.id,
        eventId: paymentCallbackOutbox.eventId,
        replayKey: paymentCallbackOutbox.replayKey,
      }).from(paymentCallbackOutbox)
        .where(onlyOutboxId
          ? and(eq(paymentCallbackOutbox.id, onlyOutboxId), eligible)
          : eligible)
        .orderBy(asc(paymentCallbackOutbox.id))
        .limit(bounded)
        .for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(paymentCallbackOutbox).set({
        status: "ENQUEUING",
        dispatchCount: sql`${paymentCallbackOutbox.dispatchCount} + 1`,
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(inArray(paymentCallbackOutbox.id, rows.map((row) => row.outboxId)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0 };

    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((event) => ({
        body: paymentCallbackMessage(event),
        contentType: "json" as const,
      })));
      await withTx(this.container, (tx) => tx.update(paymentCallbackOutbox).set({
        status: "ENQUEUED",
        leaseUntil: now + DELIVERY_LEASE_SECONDS,
        leaseToken: "",
        lastErrorCode: "",
        enqueuedTime: now,
        updateTime: now,
      }).where(and(
        inArray(paymentCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(paymentCallbackOutbox.status, "ENQUEUING"),
        eq(paymentCallbackOutbox.leaseToken, leaseToken),
      )));
      return { claimed: claimed.length, enqueued: claimed.length };
    } catch (error) {
      await withTx(this.container, (tx) => tx.update(paymentCallbackOutbox).set({
        status: "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        availableTime: now + 60,
        lastErrorCode: "queue_dispatch_failed",
        updateTime: now,
      }).where(and(
        inArray(paymentCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(paymentCallbackOutbox.status, "ENQUEUING"),
        eq(paymentCallbackOutbox.leaseToken, leaseToken),
      )));
      throw error;
    }
  }

  async dispatchById(outboxId: number): Promise<{ claimed: number; enqueued: number }> {
    return this.dispatchPending(1, outboxId);
  }

  async processMessage(message: PaymentCallbackMessage): Promise<PaymentCallbackProcessResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string" || "kind" in claim) return claim;
    try {
      if (!providerPaymentSucceeded(claim)) {
        await this.finish(claim, "IGNORED", "", "");
        return "ignored";
      }
      const settled = await this.settler(claim);
      if (settled.status === "unknown") {
        await this.finish(claim, "UNKNOWN", settled.domain, settled.errorCode);
        return "unknown";
      }
      await this.finish(claim, "COMPLETED", settled.domain, "");
      return "completed";
    } catch (error) {
      if (error instanceof ApiException && !(error instanceof ServiceUnavailableException)) {
        await this.finish(claim, "UNKNOWN", claim.orderDomain, callbackErrorCode(error));
        return "unknown";
      }
      if (await this.recordFailure(claim, error)) return "dead";
      throw error;
    }
  }

  private async claim(message: PaymentCallbackMessage): Promise<
    ClaimedPaymentCallback
    | "already-completed"
    | "busy"
    | "dead"
    | { kind: "deferred"; delaySeconds: number }
  > {
    const now = Math.floor(Date.now() / 1000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const outboxRows = await tx.select().from(paymentCallbackOutbox)
        .where(eq(paymentCallbackOutbox.eventId, message.eventId))
        .limit(1)
        .for("update");
      const outbox = outboxRows[0];
      if (!outbox || outbox.replayKey !== message.replayKey) {
        throw new Error("payment_callback_queue_message_mismatch");
      }
      const eventRows = await tx.select().from(paymentCallbackEvent)
        .where(eq(paymentCallbackEvent.id, message.eventId))
        .limit(1)
        .for("update");
      const event = eventRows[0];
      if (!event || event.replayKey !== message.replayKey) {
        throw new Error("payment_callback_queue_message_mismatch");
      }
      if (outbox.status === "COMPLETED") return "already-completed";
      if (outbox.status === "DEAD" || event.status === "DEAD") return "dead";
      if (outbox.status === "PROCESSING" && outbox.leaseUntil > now) return "busy";
      if (outbox.availableTime > now) {
        return { kind: "deferred", delaySeconds: Math.max(1, outbox.availableTime - now) };
      }
      const attemptCount = Math.max(outbox.attemptCount, event.attemptCount) + 1;
      if (attemptCount > MAX_ATTEMPTS) {
        await tx.update(paymentCallbackOutbox).set({
          status: "DEAD",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: "payment_callback_attempts_exhausted",
          updateTime: now,
        }).where(eq(paymentCallbackOutbox.id, outbox.id));
        await tx.update(paymentCallbackEvent).set({
          status: "DEAD",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: "payment_callback_attempts_exhausted",
          processedTime: now,
          updateTime: now,
        }).where(eq(paymentCallbackEvent.id, event.id));
        return "dead";
      }
      await tx.update(paymentCallbackOutbox).set({
        status: "PROCESSING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(eq(paymentCallbackOutbox.id, outbox.id));
      await tx.update(paymentCallbackEvent).set({
        status: "PROCESSING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(eq(paymentCallbackEvent.id, event.id));
      return {
        eventId: event.id,
        outboxId: outbox.id,
        replayKey: event.replayKey,
        provider: event.provider,
        orderDomain: event.orderDomain,
        profile: event.profile,
        providerEventId: event.providerEventId,
        orderNo: event.orderNo,
        transactionId: event.transactionId,
        tradeState: event.tradeState,
        amountCents: event.amountCents,
        currency: "CNY",
        providerEventTime: event.providerEventTime,
        leaseToken,
        attemptCount,
      };
    });
  }

  private async settle(callback: VerifiedPaymentCallback & OfflineCallbackReference): Promise<SettlementResult> {
    // The prefix is only a routing hint. Settlement re-reads type=3 admission,
    // selection, trusted identity binding, amount and cross-domain ambiguity.
    if (/^xx[0-9a-f]{30}$/.test(callback.orderNo)) {
      await settleOfflineOrderExternalPayment(this.container, callback);
      return { status: 'completed', domain: 'offline_order', errorCode: '' };
    }
    const [storeOrder, rechargeOrder, membershipOrder] = await Promise.all([
      this.container.storeOrderDao.findByOrderId(callback.orderNo),
      findRechargeOrderByOrderId(this.container, callback.orderNo),
      findMembershipOrderByOrderId(this.container, callback.orderNo),
    ]);
    const candidates = [storeOrder, rechargeOrder, membershipOrder].filter(Boolean);
    if (candidates.length !== 1) {
      return {
        status: "unknown",
        domain: "",
        errorCode: candidates.length === 0 ? "order_missing" : "order_domain_conflict",
      };
    }
    const expectedAmountCents = decimalToCents(String(
      storeOrder?.payPrice ?? rechargeOrder?.price ?? membershipOrder?.payPrice,
    ));
    if (expectedAmountCents !== callback.amountCents) {
      return { status: "unknown", domain: "", errorCode: "amount_mismatch" };
    }
    const payType = callback.provider === "wechat" ? "weixin" : "alipay";
    const original = (tx: DbClient, domain: string) => callback.provider === 'wechat' && callback.profile === 'routine'
      ? assertRoutineOriginalReferenceTx(tx, { APP_KEY: this.env.APP_KEY ?? '' }, callback.providerEventId,
        { source: 'callback', ...callback }, domain) : Promise.resolve();
    if (storeOrder) {
      const result = await applyProviderStoreOrderPayment(this.container, {
        orderId: storeOrder.id,
        payType,
        tradeNo: callback.transactionId,
        authorizeBeforePayment: tx => original(tx, 'store_order'),
      });
      if (result.outbox) {
        try {
          await new OrderOutboxService(this.container, this.env).dispatchById(result.outbox.id);
        } catch (error) {
          emitOperationalEvent("error", {
            event: "payment_order_outbox_dispatch_failed",
            component: "queue",
            operation: "payment_callback",
            outcome: "failure",
            errorCode: operationalErrorCode(error, "order_outbox_dispatch_failed"),
          });
        }
      }
      return domainOutcome("store_order", result.outcome);
    }
    if (rechargeOrder) {
      const result = await applyRechargePayment(this.container, {
        orderId: callback.orderNo,
        payType,
        tradeNo: callback.transactionId,
        expectedAmountCents: callback.amountCents,
        authorizeBeforePayment: tx => original(tx, 'recharge'),
      });
      return domainOutcome("recharge", result.outcome);
    }
    const result = await applyProviderMembershipPayment(this.container, {
      orderId: callback.orderNo,
      payType,
      tradeNo: callback.transactionId,
      expectedAmountCents: callback.amountCents,
      authorizeBeforePayment: tx => original(tx, 'membership'),
    });
    return domainOutcome("membership", result.outcome);
  }

  private async finish(
    claim: ClaimedPaymentCallback,
    status: "COMPLETED" | "IGNORED" | "UNKNOWN",
    domain: PaymentCallbackOrderDomain,
    errorCode: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await withTx(this.container, async (tx) => {
      const outboxes = await tx.update(paymentCallbackOutbox).set({
        status: "COMPLETED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode,
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(paymentCallbackOutbox.id, claim.outboxId),
        eq(paymentCallbackOutbox.status, "PROCESSING"),
        eq(paymentCallbackOutbox.leaseToken, claim.leaseToken),
      )).returning({ id: paymentCallbackOutbox.id });
      const events = await tx.update(paymentCallbackEvent).set({
        status,
        orderDomain: domain,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode,
        processedTime: now,
        updateTime: now,
      }).where(and(
        eq(paymentCallbackEvent.id, claim.eventId),
        eq(paymentCallbackEvent.status, "PROCESSING"),
        eq(paymentCallbackEvent.leaseToken, claim.leaseToken),
      )).returning({ id: paymentCallbackEvent.id });
      if (outboxes.length !== 1 || events.length !== 1) {
        throw new Error("payment_callback_processing_fence_lost");
      }
      await resolvePaymentReconciliationFromCallbackTx(tx, {
        provider: claim.provider,
        orderNo: claim.orderNo,
        transactionId: claim.transactionId,
        providerEventTime: claim.providerEventTime,
        orderDomain: domain,
        callbackStatus: status,
        errorCode,
        now,
      });
    });
  }

  private async recordFailure(claim: ClaimedPaymentCallback, error: unknown): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const dead = claim.attemptCount >= MAX_ATTEMPTS;
    const errorCode = callbackErrorCode(error);
    const availableTime = dead ? 0 : now + retryDelay(claim.attemptCount);
    return withTx(this.container, async (tx) => {
      const outboxes = await tx.update(paymentCallbackOutbox).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode,
        availableTime,
        updateTime: now,
      }).where(and(
        eq(paymentCallbackOutbox.id, claim.outboxId),
        eq(paymentCallbackOutbox.status, "PROCESSING"),
        eq(paymentCallbackOutbox.leaseToken, claim.leaseToken),
      )).returning({ id: paymentCallbackOutbox.id });
      const events = await tx.update(paymentCallbackEvent).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode,
        processedTime: dead ? now : 0,
        updateTime: now,
      }).where(and(
        eq(paymentCallbackEvent.id, claim.eventId),
        eq(paymentCallbackEvent.status, "PROCESSING"),
        eq(paymentCallbackEvent.leaseToken, claim.leaseToken),
      )).returning({ id: paymentCallbackEvent.id });
      if (outboxes.length === 0 && events.length === 0) return false;
      if (outboxes.length !== 1 || events.length !== 1) {
        throw new Error("payment_callback_failure_fence_lost");
      }
      return dead;
    });
  }
}

interface PaymentCallbackQueueControl {
  body: PaymentCallbackMessage;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export async function consumePaymentCallbackMessage(
  message: PaymentCallbackQueueControl,
  service: Pick<PaymentCallbackEventService, "processMessage">,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await service.processMessage(message.body);
    if (result === "busy") {
      message.retry({ delaySeconds: 30 });
      return;
    }
    if (typeof result === "object") {
      message.retry({ delaySeconds: result.delaySeconds });
      return;
    }
    if (result === "unknown" || result === "dead") {
      emitOperationalEvent("warn", {
        event: "payment_callback_failed",
        component: "payment",
        operation: "payment_callback",
        outcome: "failure",
        result,
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
      });
    } else {
      emitOperationalEvent("info", {
        event: "payment_callback_completed",
        component: "payment",
        operation: "payment_callback",
        outcome: "success",
        result,
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
      });
    }
    message.ack();
  } catch (error) {
    const delaySeconds = Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 900);
    emitOperationalEvent("error", {
      event: "payment_callback_failed",
      component: "payment",
      operation: "payment_callback",
      outcome: "retry",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error, "payment_callback_processing_failed"),
    });
    message.retry({ delaySeconds });
  }
}
