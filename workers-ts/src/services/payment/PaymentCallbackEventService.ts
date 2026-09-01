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
import { withTx } from "@/lib/di";
import {
  paymentCallbackEvent,
  paymentCallbackOutbox,
  type PaymentCallbackOrderDomain,
  type PaymentCallbackProfile,
  type PaymentCallbackProvider,
} from "@/models/schema";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import {
  applyStoreOrderPayment,
  type StoreOrderPaymentOutcome,
} from "@/services/order/StoreOrderPayService";
import { OrderOutboxService } from "@/services/order/OrderOutboxService";
import {
  applyRechargePayment,
  findRechargeOrderByOrderId,
} from "@/services/payment/RechargePaymentService";
import {
  applyMembershipPayment,
  findMembershipOrderByOrderId,
} from "@/services/user/PaidMembershipService";
import { ApiException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const DISPATCH_LEASE_SECONDS = 120;
const DELIVERY_LEASE_SECONDS = 600;
const PROCESS_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ORDER_NO = /^[A-Za-z0-9_-]{2,64}$/;
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TRADE_STATE = /^[A-Z][A-Z0-9_]{1,31}$/;

export interface VerifiedPaymentCallback {
  provider: PaymentCallbackProvider;
  profile: PaymentCallbackProfile;
  providerEventId: string;
  orderNo: string;
  transactionId: string;
  tradeState: string;
  amountCents: number;
  currency: "CNY";
  providerEventTime: number;
}

export interface PaymentCallbackReceiveResult {
  eventId: number;
  outboxId: number;
  replayKey: string;
  duplicate: boolean;
  terminalConflict: boolean;
}

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
}

interface ClaimedPaymentCallback extends VerifiedPaymentCallback {
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
  callback: VerifiedPaymentCallback,
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
  if (error instanceof ApiException) return "payment_business_validation";
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : "payment_callback_processing_failed";
}

function assertVerifiedCallback(callback: VerifiedPaymentCallback): void {
  if (
    (callback.provider === "alipay" && callback.profile !== "alipay")
    || (callback.provider === "wechat" && !["wechat", "routine", "app"].includes(callback.profile))
  ) throw new Error("payment_callback_profile_invalid");
  if (!PROVIDER_EVENT_ID.test(callback.providerEventId)) {
    throw new Error("payment_callback_event_id_invalid");
  }
  if (!ORDER_NO.test(callback.orderNo)) throw new Error("payment_callback_order_no_invalid");
  if (!TRANSACTION_ID.test(callback.transactionId)) {
    throw new Error("payment_callback_transaction_id_invalid");
  }
  if (!TRADE_STATE.test(callback.tradeState)) {
    throw new Error("payment_callback_trade_state_invalid");
  }
  if (
    !Number.isSafeInteger(callback.amountCents)
    || callback.amountCents <= 0
    || callback.amountCents > 2_147_483_647
    || callback.currency !== "CNY"
  ) throw new Error("payment_callback_amount_invalid");
  if (!Number.isSafeInteger(callback.providerEventTime) || callback.providerEventTime < 0) {
    throw new Error("payment_callback_event_time_invalid");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalCallback(callback: VerifiedPaymentCallback): string {
  return JSON.stringify({
    provider: callback.provider,
    profile: callback.profile,
    providerEventId: callback.providerEventId,
    orderNo: callback.orderNo,
    transactionId: callback.transactionId,
    tradeState: callback.tradeState,
    amountCents: callback.amountCents,
    currency: callback.currency,
    providerEventTime: callback.providerEventTime,
  });
}

function providerPaymentSucceeded(callback: VerifiedPaymentCallback): boolean {
  return callback.provider === "wechat"
    ? callback.tradeState === "SUCCESS"
    : callback.tradeState === "TRADE_SUCCESS" || callback.tradeState === "TRADE_FINISHED";
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

  async receive(callback: VerifiedPaymentCallback): Promise<PaymentCallbackReceiveResult> {
    assertVerifiedCallback(callback);
    const payloadHash = await sha256(canonicalCallback(callback));
    const now = Math.floor(Date.now() / 1000);
    const replayKey = crypto.randomUUID();
    const retainUntil = now + RETENTION_SECONDS;

    return withTx(this.container, async (tx) => {
      // Serialize evidence for one provider transaction so two different,
      // concurrently delivered event IDs cannot settle different orders.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${`${callback.provider}:${callback.transactionId}`}, 0)
      )`);

      const inserted = await tx.insert(paymentCallbackEvent).values({
        ...callback,
        replayKey,
        payloadHash,
        status: "RECEIVED",
        receivedTime: now,
        retainUntil,
        updateTime: now,
      }).onConflictDoNothing({
        target: [paymentCallbackEvent.provider, paymentCallbackEvent.providerEventId],
      }).returning({ id: paymentCallbackEvent.id });

      const rows = await tx.select().from(paymentCallbackEvent).where(and(
        eq(paymentCallbackEvent.provider, callback.provider),
        eq(paymentCallbackEvent.providerEventId, callback.providerEventId),
      )).limit(1).for("update");
      const event = rows[0];
      if (!event) throw new Error("payment_callback_event_insert_failed");
      if (
        event.payloadHash !== payloadHash
        || event.profile !== callback.profile
        || event.orderNo !== callback.orderNo
        || event.transactionId !== callback.transactionId
        || event.tradeState !== callback.tradeState
        || event.amountCents !== callback.amountCents
        || event.currency !== callback.currency
        || event.providerEventTime !== callback.providerEventTime
      ) throw new Error("payment_callback_immutable_conflict");

      const transactionEvidence = await tx.select({
        id: paymentCallbackEvent.id,
        orderNo: paymentCallbackEvent.orderNo,
        amountCents: paymentCallbackEvent.amountCents,
        currency: paymentCallbackEvent.currency,
      }).from(paymentCallbackEvent).where(and(
        eq(paymentCallbackEvent.provider, callback.provider),
        eq(paymentCallbackEvent.transactionId, callback.transactionId),
      )).orderBy(asc(paymentCallbackEvent.id)).for("update");
      const terminalConflict = transactionEvidence.some((candidate) =>
        candidate.id !== event.id
        && (
          candidate.orderNo !== callback.orderNo
          || candidate.amountCents !== callback.amountCents
          || candidate.currency !== callback.currency
        ));
      if (terminalConflict && event.status === "RECEIVED") {
        await tx.update(paymentCallbackEvent).set({
          status: "UNKNOWN",
          lastErrorCode: "transaction_evidence_conflict",
          processedTime: now,
          updateTime: now,
        }).where(eq(paymentCallbackEvent.id, event.id));
      }

      await tx.insert(paymentCallbackOutbox).values({
        eventId: event.id,
        replayKey: event.replayKey,
        status: terminalConflict ? "COMPLETED" : "PENDING",
        availableTime: now,
        processedTime: terminalConflict ? now : 0,
        addTime: now,
        updateTime: now,
      }).onConflictDoNothing({ target: paymentCallbackOutbox.eventId });
      const outboxRows = await tx.select({
        id: paymentCallbackOutbox.id,
        replayKey: paymentCallbackOutbox.replayKey,
      }).from(paymentCallbackOutbox)
        .where(eq(paymentCallbackOutbox.eventId, event.id))
        .limit(1);
      const outbox = outboxRows[0];
      if (!outbox || outbox.replayKey !== event.replayKey) {
        throw new Error("payment_callback_outbox_immutable_conflict");
      }
      return {
        eventId: event.id,
        outboxId: outbox.id,
        replayKey: event.replayKey,
        duplicate: inserted.length === 0,
        terminalConflict,
      };
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
      if (error instanceof ApiException) {
        await this.finish(claim, "UNKNOWN", "", callbackErrorCode(error));
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

  private async settle(callback: VerifiedPaymentCallback): Promise<SettlementResult> {
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
    if (storeOrder) {
      const result = await applyStoreOrderPayment(this.container, {
        orderId: storeOrder.id,
        payType,
        tradeNo: callback.transactionId,
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
      });
      return domainOutcome("recharge", result.outcome);
    }
    const result = await applyMembershipPayment(this.container, {
      orderId: callback.orderNo,
      payType,
      tradeNo: callback.transactionId,
      expectedAmountCents: callback.amountCents,
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
