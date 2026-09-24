import { and, eq, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  paymentReconciliationCase,
  type PaymentCallbackOrderDomain,
  type PaymentCallbackProfile,
  type PaymentCallbackProvider,
  type PaymentReconciliationStatus,
} from "@/models/schema";
import { lockStoreOrderPaymentBoundary } from "./StoreOrderPaymentBoundary";

const INITIAL_QUERY_DELAY_SECONDS = 120;
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const ORDER_NO = /^[A-Za-z0-9_-]{2,64}$/;
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface PaymentReconciliationRegistration {
  provider: PaymentCallbackProvider;
  profile: PaymentCallbackProfile;
  orderDomain: PaymentCallbackOrderDomain;
  orderNo: string;
  expectedAmountCents: number;
  transactionId?: string;
  providerEventTime?: number;
  providerStatus?: "UNKNOWN" | "PENDING" | "SUCCESS";
  callbackEventId?: number;
  terminalConflict?: boolean;
  initiated?: boolean;
  now?: number;
}

/** Lock order shared by callback, intent and query evidence registrations. */
export async function lockPaymentReconciliationRegistrationTx(
  tx: DbClient,
  provider: PaymentCallbackProvider,
  orderNo: string,
  transactionId = "",
): Promise<void> {
  await lockStoreOrderPaymentBoundary(tx, orderNo);
  if (transactionId) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${provider}:${transactionId}`},0))`);
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`payment-reconciliation:${provider}:${orderNo}`}, 0)
  )`);
}

function assertRegistration(input: PaymentReconciliationRegistration): void {
  if (
    (input.provider === "alipay" && input.profile !== "alipay")
    || (input.provider === "wechat" && !["wechat", "routine", "app"].includes(input.profile))
  ) throw new Error("payment_reconciliation_profile_invalid");
  if (!ORDER_NO.test(input.orderNo)) throw new Error("payment_reconciliation_order_invalid");
  if (
    !Number.isSafeInteger(input.expectedAmountCents)
    || input.expectedAmountCents <= 0
    || input.expectedAmountCents > 2_147_483_647
  ) throw new Error("payment_reconciliation_amount_invalid");
  if (input.transactionId && !TRANSACTION_ID.test(input.transactionId)) {
    throw new Error("payment_reconciliation_transaction_invalid");
  }
  if (
    input.callbackEventId !== undefined
    && (!Number.isSafeInteger(input.callbackEventId) || input.callbackEventId <= 0)
  ) throw new Error("payment_reconciliation_callback_event_invalid");
}

/** Upsert one immutable provider/order intent inside the caller's short transaction. */
export async function registerPaymentReconciliationTx(
  tx: DbClient,
  input: PaymentReconciliationRegistration,
) {
  assertRegistration(input);
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const replayKey = crypto.randomUUID();
  // Direct store-order intent/query registrations use the same per-order
  // boundary as callbacks and assisted local writers. The reserved offline
  // order prefix keeps its own lock order. Callback persistence acquires the
  // store-order boundary before inserting an event; it is transaction-reentrant.
  // Shared with callback persistence and offline signed queries. An intent
  // without a transaction skips only the provider transaction key.
  await lockPaymentReconciliationRegistrationTx(tx, input.provider, input.orderNo, input.transactionId);
  await tx.insert(paymentReconciliationCase).values({
    replayKey,
    provider: input.provider,
    profile: input.profile,
    orderDomain: input.orderDomain,
    orderNo: input.orderNo,
    expectedAmountCents: input.expectedAmountCents,
    currency: "CNY",
    status: input.terminalConflict ? "CONFLICT" : "OPEN",
    providerStatus: input.providerStatus ?? (input.transactionId ? "SUCCESS" : "UNKNOWN"),
    providerTransactionId: input.transactionId ?? "",
    providerEventTime: input.providerEventTime ?? 0,
    callbackEventId: input.callbackEventId,
    nextCheckTime: now + INITIAL_QUERY_DELAY_SECONDS,
    lastErrorCode: input.terminalConflict ? "transaction_evidence_conflict" : "",
    initiatedTime: input.initiated ? now : 0,
    resolvedTime: input.terminalConflict ? now : 0,
    retainUntil: now + RETENTION_SECONDS,
    addTime: now,
    updateTime: now,
  }).onConflictDoNothing({
    target: [paymentReconciliationCase.provider, paymentReconciliationCase.orderNo],
  });

  const rows = await tx.select().from(paymentReconciliationCase).where(and(
    eq(paymentReconciliationCase.provider, input.provider),
    eq(paymentReconciliationCase.orderNo, input.orderNo),
  )).limit(1).for("update");
  const existing = rows[0];
  if (!existing) throw new Error("payment_reconciliation_registration_failed");
  const immutableConflict = existing.profile !== input.profile
    || existing.expectedAmountCents !== input.expectedAmountCents
    || existing.currency !== "CNY"
    || (
      existing.orderDomain !== ""
      && input.orderDomain !== ""
      && existing.orderDomain !== input.orderDomain
    )
    || (
      existing.providerTransactionId !== ""
      && !!input.transactionId
      && existing.providerTransactionId !== input.transactionId
    );
  const [foreignTransaction] = input.transactionId ? await tx.execute<{ present: boolean }>(sql`SELECT EXISTS(
    SELECT 1 FROM ${paymentReconciliationCase} WHERE provider=${input.provider} AND provider_transaction_id=${input.transactionId}
      AND order_no<>${input.orderNo}) AS present`) : [{ present: false }];
  const conflict = immutableConflict || input.terminalConflict === true || foreignTransaction.present;
  const update: Partial<typeof paymentReconciliationCase.$inferInsert> = {
    orderDomain: existing.orderDomain || input.orderDomain,
    callbackEventId: input.callbackEventId ?? existing.callbackEventId,
    initiatedTime: existing.initiatedTime || (input.initiated ? now : 0),
    updateTime: now,
  };
  if (!existing.providerTransactionId && input.transactionId) {
    update.providerTransactionId = input.transactionId;
    update.providerEventTime = input.providerEventTime ?? 0;
    update.providerStatus = input.providerStatus ?? "SUCCESS";
  }
  if (conflict) {
    update.status = "CONFLICT";
    update.lastErrorCode = immutableConflict
      ? "reconciliation_evidence_conflict"
      : "transaction_evidence_conflict";
    update.resolvedTime = now;
  }
  if (Object.keys(update).length) {
    await tx.update(paymentReconciliationCase).set(update)
      .where(eq(paymentReconciliationCase.id, existing.id));
  }
  const updated = await tx.select().from(paymentReconciliationCase)
    .where(eq(paymentReconciliationCase.id, existing.id)).limit(1);
  if (!updated[0]) throw new Error("payment_reconciliation_registration_lost");
  return updated[0];
}

/** Persist the recovery intent before any provider request leaves the Worker. */
export async function registerPaymentReconciliationIntent(
  container: Container,
  input: PaymentReconciliationRegistration,
) {
  return withTx(container, (tx) => registerPaymentReconciliationTx(tx, input));
}

export async function resolvePaymentReconciliationFromCallbackTx(
  tx: DbClient,
  input: {
    provider: PaymentCallbackProvider;
    orderNo: string;
    transactionId: string;
    providerEventTime: number;
    orderDomain: PaymentCallbackOrderDomain;
    callbackStatus: "COMPLETED" | "IGNORED" | "UNKNOWN";
    errorCode: string;
    now: number;
  },
): Promise<void> {
  const terminalStatus: PaymentReconciliationStatus = input.callbackStatus === "COMPLETED"
    ? "CONFIRMED"
    : input.callbackStatus === "UNKNOWN"
      ? "CONFLICT"
      : "WAITING";
  await tx.update(paymentReconciliationCase).set({
    status: terminalStatus,
    providerStatus: input.callbackStatus === "IGNORED" ? "PENDING" : "SUCCESS",
    providerTransactionId: input.transactionId,
    providerEventTime: input.providerEventTime,
    orderDomain: input.orderDomain,
    nextCheckTime: input.callbackStatus === "IGNORED" ? input.now + INITIAL_QUERY_DELAY_SECONDS : 0,
    leaseUntil: 0,
    leaseToken: "",
    lastErrorCode: input.errorCode,
    resolvedTime: input.callbackStatus === "IGNORED" ? 0 : input.now,
    updateTime: input.now,
  }).where(and(
    eq(paymentReconciliationCase.provider, input.provider),
    eq(paymentReconciliationCase.orderNo, input.orderNo),
    // A later conflicting notification can arrive after settlement commits but
    // before its queue acknowledgement. Never erase that durable evidence, nor
    // let a delayed non-success callback downgrade a resolved payment.
    sql`${paymentReconciliationCase.status} NOT IN ('CONFLICT', 'CLOSED')`,
    sql`(${paymentReconciliationCase.providerTransactionId} = '' OR ${paymentReconciliationCase.providerTransactionId} = ${input.transactionId})`,
    sql`(${paymentReconciliationCase.orderDomain} = '' OR ${paymentReconciliationCase.orderDomain} = ${input.orderDomain})`,
    ...(input.callbackStatus === 'IGNORED'
      ? [sql`${paymentReconciliationCase.status} NOT IN ('SETTLED', 'CONFIRMED')`] : []),
  ));
}
