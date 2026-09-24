import { and, asc, eq, sql } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { paymentCallbackEvent, paymentCallbackOutbox, type PaymentCallbackProfile, type PaymentCallbackProvider } from "@/models/schema";
import { registerPaymentReconciliationTx } from "./PaymentReconciliationRegistry";
import { lockStoreOrderPaymentBoundary } from "./StoreOrderPaymentBoundary";

const RETENTION_SECONDS = 400 * 24 * 60 * 60;
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

export function providerPaymentSucceeded(callback: VerifiedPaymentCallback): boolean {
  return callback.provider === "wechat"
    ? callback.tradeState === "SUCCESS"
    : callback.tradeState === "TRADE_SUCCESS" || callback.tradeState === "TRADE_FINISHED";
}

/** Internal persistence primitive. Caller owns the transaction and any domain
 * evidence binding; HTTP must use PaymentCallbackEventService.receive instead.
 * No network or Queue I/O, and the canonical v1 hash remains unchanged.
 */
export async function persistVerifiedPaymentCallbackTx(tx: DbClient, callback: VerifiedPaymentCallback): Promise<PaymentCallbackReceiveResult> {
  assertVerifiedCallback(callback);
  const payloadHash = await sha256(canonicalCallback(callback));
  const now = Math.floor(Date.now() / 1000);
  const replayKey = crypto.randomUUID();
  const retainUntil = now + RETENTION_SECONDS;

  // The verified callback is not yet durable. For store-order numbers, take
  // the same boundary as assisted repricing/cancellation before transaction
  // keys or event writes. The reserved offline prefix keeps its own protocol.
  await lockStoreOrderPaymentBoundary(tx, callback.orderNo);
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
  const recovery = await registerPaymentReconciliationTx(tx, {
    provider: callback.provider,
    profile: callback.profile,
    orderDomain: "",
    orderNo: callback.orderNo,
    expectedAmountCents: callback.amountCents,
    transactionId: callback.transactionId,
    providerEventTime: callback.providerEventTime,
    providerStatus: providerPaymentSucceeded(callback) ? "SUCCESS" : "PENDING",
    callbackEventId: event.id,
    terminalConflict,
    now,
  });
  const reconciliationConflict = recovery.status === 'CONFLICT';
  if (reconciliationConflict && !terminalConflict && event.status === 'RECEIVED') {
    await tx.update(paymentCallbackEvent).set({ status: 'UNKNOWN', lastErrorCode: 'reconciliation_evidence_conflict',
      processedTime: now, updateTime: now }).where(eq(paymentCallbackEvent.id, event.id));
    await tx.update(paymentCallbackOutbox).set({ status: 'COMPLETED', processedTime: now, updateTime: now })
      .where(eq(paymentCallbackOutbox.eventId, event.id));
  }
  return {
    eventId: event.id,
    outboxId: outbox.id,
    replayKey: event.replayKey,
    duplicate: inserted.length === 0,
    terminalConflict: terminalConflict || reconciliationConflict,
  };
}
