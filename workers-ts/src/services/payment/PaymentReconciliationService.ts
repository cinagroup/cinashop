import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type {
  Env,
  PaymentReconciliationDispatchMessage,
  PaymentReconciliationMessage,
} from "@/env";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  otherOrder,
  paymentCallbackEvent,
  paymentReconciliationAction,
  paymentReconciliationCase,
  storeOrder,
  userRecharge,
  type PaymentCallbackOrderDomain,
  type PaymentReconciliationActionType,
  type PaymentReconciliationStatus,
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
import { AlipayTradeQueryService } from "@/services/payment/AlipayTradeQueryService";
import {
  type PaymentProviderQuery,
  type PaymentProviderQueryRequest,
  type PaymentProviderQueryResult,
} from "@/services/payment/PaymentProviderQuery";
import { lockPaymentReconciliationRegistrationTx, registerPaymentReconciliationTx } from "@/services/payment/PaymentReconciliationRegistry";
import { lockStoreOrderPaymentBoundary } from "@/services/payment/StoreOrderPaymentBoundary";
import { WechatPayService } from "@/services/wechat/WechatPayService";
import { settleOfflineOrderExternalPayment, settleOfflineOrderQueryPayment } from "@/services/order/OfflineOrderExternalPaymentService";
import { queryOfflineOrderPayment } from '@/services/order/OfflineOrderPaymentQueryService';
import { findOfflineQueryEvidence, persistOfflineQueryEvidence } from '@/services/order/OfflineOrderQueryEvidenceService';
import { ApiException, ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const DISPATCH_PAGE_SIZE = 50;
const DISPATCH_LEASE_SECONDS = 600;
const PROCESS_LEASE_SECONDS = 120;
const MAX_QUERY_ATTEMPTS = 12;
const NO_PAYMENT_MIN_AGE_SECONDS = 30 * 60;
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_TRANSACTION_ID = /^[A-Za-z0-9_-]{1,100}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{2,63}$/;
const TERMINAL_STATUSES: PaymentReconciliationStatus[] = [
  "SETTLED",
  "CONFIRMED",
  "NO_PAYMENT",
  "CONFLICT",
  "CLOSED",
];
const ATTENTION_STATUSES: PaymentReconciliationStatus[] = ["UNKNOWN", "CONFLICT", "DEAD"];

export interface PaymentReconciliationIntent extends PaymentProviderQueryRequest {
  initiatedAt?: number;
}

export type PaymentReconciliationProcessResult =
  | "settled"
  | "confirmed"
  | "waiting"
  | "no-payment"
  | "unknown"
  | "conflict"
  | "dead"
  | "already-terminal"
  | "busy"
  | { kind: "deferred"; delaySeconds: number };

interface ClaimedCase extends PaymentProviderQueryRequest {
  callbackEventId: number | null;
  id: number;
  replayKey: string;
  leaseToken: string;
  attemptCount: number;
  initiatedTime: number;
  addTime: number;
  providerTransactionId: string;
  providerEventTime: number;
}

interface SettlementResult {
  status: "completed" | "unknown";
  domain: PaymentCallbackOrderDomain;
  errorCode: string;
  outcome?: "paid" | "already-paid";
}

type PaymentReconciliationSettler = (
  request: ClaimedCase,
  result: PaymentProviderQueryResult,
) => Promise<SettlementResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isPaymentReconciliationMessage(
  value: unknown,
): value is PaymentReconciliationMessage {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 3
    && value.action === "processPaymentReconciliation"
    && Number.isSafeInteger(value.caseId)
    && Number(value.caseId) > 0
    && typeof value.replayKey === "string"
    && UUID_V4.test(value.replayKey);
}

export function isPaymentReconciliationDispatchMessage(
  value: unknown,
): value is PaymentReconciliationDispatchMessage {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 3
    && value.action === "dispatchPaymentReconciliation"
    && Number.isSafeInteger(value.scheduledAt)
    && Number(value.scheduledAt) > 0
    && Number.isSafeInteger(value.cursor)
    && Number(value.cursor) >= 0;
}

function reconciliationMessage(row: { id: number; replayKey: string }): PaymentReconciliationMessage {
  return {
    action: "processPaymentReconciliation",
    caseId: row.id,
    replayKey: row.replayKey,
  };
}

export function paymentReconciliationBackoff(attempt: number): number {
  const normalized = Math.max(1, Math.min(Math.trunc(attempt), MAX_QUERY_ATTEMPTS));
  return Math.min(60 * 2 ** (normalized - 1), 6 * 60 * 60);
}

function lowCardinalityError(error: unknown, fallback: string): string {
  if (error instanceof ApiException) return "payment_business_validation";
  return operationalErrorCode(error, fallback);
}

export class PaymentReconciliationService {
  private readonly queryProvider: PaymentProviderQuery;
  private readonly settler: PaymentReconciliationSettler;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
    queryProvider?: PaymentProviderQuery,
    settler?: PaymentReconciliationSettler,
  ) {
    this.queryProvider = queryProvider ?? ((request) => this.defaultProviderQuery(request));
    this.settler = settler ?? ((request, result) => this.settle(request, result));
  }

  async registerIntent(intent: PaymentReconciliationIntent) {
    const now = intent.initiatedAt ?? Math.floor(Date.now() / 1_000);
    return withTx(this.container, (tx) => registerPaymentReconciliationTx(tx, {
      provider: intent.provider,
      profile: intent.profile,
      orderDomain: intent.orderDomain,
      orderNo: intent.orderNo,
      expectedAmountCents: intent.expectedAmountCents,
      initiated: true,
      now,
    }));
  }

  async dispatchPage(
    message: PaymentReconciliationDispatchMessage,
    limit = DISPATCH_PAGE_SIZE,
  ): Promise<{
    claimed: number;
    enqueued: number;
    nextCursor: number;
    hasMore: boolean;
    attention: number;
  }> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(message.scheduledAt / 1_000);
    const leaseToken = crypto.randomUUID();
    const eligible = or(
      and(
        inArray(paymentReconciliationCase.status, ["OPEN", "WAITING", "UNKNOWN"]),
        lte(paymentReconciliationCase.nextCheckTime, now),
      ),
      and(
        inArray(paymentReconciliationCase.status, ["QUEUED", "QUERYING"]),
        lte(paymentReconciliationCase.leaseUntil, now),
      ),
    );
    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        id: paymentReconciliationCase.id,
        replayKey: paymentReconciliationCase.replayKey,
      }).from(paymentReconciliationCase).where(and(
        gt(paymentReconciliationCase.id, message.cursor),
        eligible,
      )).orderBy(asc(paymentReconciliationCase.id)).limit(bounded).for("update", {
        skipLocked: true,
      });
      if (!rows.length) return rows;
      await tx.update(paymentReconciliationCase).set({
        status: "QUEUED",
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(inArray(paymentReconciliationCase.id, rows.map((row) => row.id)));
      return rows;
    });
    const nextCursor = claimed.at(-1)?.id ?? message.cursor;
    const hasMore = claimed.length === bounded;
    if (claimed.length) {
      try {
        await this.env.ORDER_QUEUE.sendBatch(claimed.map((row) => ({
          body: reconciliationMessage(row),
          contentType: "json" as const,
        })));
        await withTx(this.container, (tx) => tx.update(paymentReconciliationCase).set({
          leaseToken: "",
          updateTime: now,
        }).where(and(
          inArray(paymentReconciliationCase.id, claimed.map((row) => row.id)),
          eq(paymentReconciliationCase.status, "QUEUED"),
          eq(paymentReconciliationCase.leaseToken, leaseToken),
        )));
      } catch (error) {
        await withTx(this.container, (tx) => tx.update(paymentReconciliationCase).set({
          status: "UNKNOWN",
          nextCheckTime: now + 60,
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: "queue_dispatch_failed",
          updateTime: now,
        }).where(and(
          inArray(paymentReconciliationCase.id, claimed.map((row) => row.id)),
          eq(paymentReconciliationCase.status, "QUEUED"),
          eq(paymentReconciliationCase.leaseToken, leaseToken),
        )));
        throw error;
      }
    }
    if (hasMore) {
      await this.env.ORDER_QUEUE.send({
        ...message,
        cursor: nextCursor,
      }, { contentType: "json" });
    }
    const attentionRows = await withTx(this.container, (tx) => tx
      .select({ count: sql<number>`count(*)::integer` })
      .from(paymentReconciliationCase)
      .where(inArray(paymentReconciliationCase.status, ATTENTION_STATUSES)));
    return {
      claimed: claimed.length,
      enqueued: claimed.length,
      nextCursor,
      hasMore,
      attention: attentionRows[0]?.count ?? 0,
    };
  }

  async processMessage(
    message: PaymentReconciliationMessage,
  ): Promise<PaymentReconciliationProcessResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string" || "kind" in claim) return claim;
    // Dedicated offline evidence/settlement; never fall through to membership.
    if (claim.orderDomain === 'offline_order' || /^xx[0-9a-f]{30}$/.test(claim.orderNo)) {
      return this.recoverOfflinePayment(claim);
    }
    let result: PaymentProviderQueryResult;
    try {
      // Provider I/O is deliberately outside every PostgreSQL transaction.
      result = await this.queryProvider(claim);
    } catch (error) {
      return this.finishQueryFailure(claim, error);
    }
    if (result.orderNo !== claim.orderNo || result.currency !== "CNY") {
      return this.finish(claim, {
        status: "CONFLICT",
        providerStatus: "UNKNOWN",
        result,
        errorCode: "provider_identity_mismatch",
      });
    }

    const local = await this.localEvidence(claim.orderNo, claim.orderDomain);
    if (result.status !== "SUCCESS") {
      if (local.paid) {
        return this.finish(claim, {
          status: "CONFLICT",
          providerStatus: result.status,
          result,
          errorCode: "local_paid_provider_not_success",
        });
      }
      if (result.status === "PENDING") {
        return this.finish(claim, {
          status: "WAITING",
          providerStatus: "PENDING",
          result,
          errorCode: "",
        });
      }
      if (result.status === "CLOSED" || result.status === "NOT_FOUND") {
        const age = Math.floor(Date.now() / 1_000) - (claim.initiatedTime || claim.addTime);
        const terminal = claim.attemptCount >= 3 && age >= NO_PAYMENT_MIN_AGE_SECONDS;
        return this.finish(claim, {
          status: terminal ? "NO_PAYMENT" : "WAITING",
          providerStatus: result.status,
          result,
          errorCode: terminal ? "" : result.errorCode,
        });
      }
      return this.finish(claim, {
        status: claim.attemptCount >= MAX_QUERY_ATTEMPTS ? "DEAD" : "UNKNOWN",
        providerStatus: "UNKNOWN",
        result,
        errorCode: result.errorCode || "provider_status_unknown",
      });
    }

    if (
      result.amountCents !== claim.expectedAmountCents
      || !PROVIDER_TRANSACTION_ID.test(result.transactionId)
      || result.errorCode
    ) {
      return this.finish(claim, {
        status: "CONFLICT",
        providerStatus: "SUCCESS",
        result,
        errorCode: result.errorCode || "provider_evidence_mismatch",
      });
    }
    // Persist the queried transaction before settlement. A verified callback
    // may have committed during provider I/O with a different identity.
    const registered = await this.registerQueriedSuccess(claim, result);
    if (registered) return registered;
    try {
      const settled = await this.settler(claim, result);
      if (settled.status === "unknown") {
        return this.finish(claim, {
          status: "CONFLICT",
          providerStatus: "SUCCESS",
          result,
          orderDomain: settled.domain,
          errorCode: settled.errorCode,
        });
      }
      return this.finish(claim, {
        status: settled.outcome === "already-paid" ? "CONFIRMED" : "SETTLED",
        providerStatus: "SUCCESS",
        result,
        orderDomain: settled.domain,
        errorCode: "",
      });
    } catch (error) {
      if (error instanceof ApiException) {
        return this.finish(claim, {
          status: "CONFLICT",
          providerStatus: "SUCCESS",
          result,
          errorCode: "payment_business_validation",
        });
      }
      return this.finishQueryFailure(claim, error, result);
    }
  }

  private async registerQueriedSuccess(
    claim: ClaimedCase,
    result: PaymentProviderQueryResult,
  ): Promise<PaymentReconciliationProcessResult | null> {
    return withTx(this.container, async (tx) => {
      // This case already exists. Reuse the registration lock order without an
      // INSERT privilege or an unnecessary speculative INSERT on every query.
      await lockPaymentReconciliationRegistrationTx(tx, claim.provider, claim.orderNo, result.transactionId);
      const [current] = await tx.select().from(paymentReconciliationCase)
        .where(eq(paymentReconciliationCase.id, claim.id)).limit(1).for("update");
      if (!current || current.replayKey !== claim.replayKey
        || current.provider !== claim.provider || current.orderNo !== claim.orderNo) {
        throw new Error("payment_reconciliation_query_registration_mismatch");
      }
      const now = Math.floor(Date.now() / 1_000);
      const [foreignTransaction] = await tx.execute<{ present: boolean }>(sql`SELECT EXISTS(
        SELECT 1 FROM ${paymentReconciliationCase}
        WHERE provider=${claim.provider} AND provider_transaction_id=${result.transactionId}
          AND order_no<>${claim.orderNo}
      ) AS present`);
      const conflict = current.profile !== claim.profile
        || current.expectedAmountCents !== claim.expectedAmountCents
        || current.currency !== "CNY"
        || !!(current.orderDomain && claim.orderDomain && current.orderDomain !== claim.orderDomain)
        || !!(current.providerTransactionId && current.providerTransactionId !== result.transactionId)
        || foreignTransaction.present;
      if (conflict && current.status !== "CONFLICT") {
        await tx.update(paymentReconciliationCase).set({
          status: "CONFLICT",
          nextCheckTime: 0,
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: "provider_query_transaction_conflict",
          resolvedTime: now,
          retainUntil: now + RETENTION_SECONDS,
          updateTime: now,
        }).where(eq(paymentReconciliationCase.id, claim.id));
        return "conflict";
      }
      if (current.status === "CONFLICT") {
        await tx.update(paymentReconciliationCase).set({
          nextCheckTime: 0,
          leaseUntil: 0,
          leaseToken: "",
          updateTime: now,
        }).where(eq(paymentReconciliationCase.id, claim.id));
        return "conflict";
      }
      if (TERMINAL_STATUSES.includes(current.status)) return "already-terminal";
      if (current.status !== "QUERYING" || current.leaseToken !== claim.leaseToken) {
        throw new Error("payment_reconciliation_processing_fence_lost");
      }
      if (current.callbackEventId !== claim.callbackEventId) {
        await tx.update(paymentReconciliationCase).set({
          status: "UNKNOWN",
          nextCheckTime: now + paymentReconciliationBackoff(claim.attemptCount),
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: "concurrent_callback_evidence",
          updateTime: now,
        }).where(eq(paymentReconciliationCase.id, claim.id));
        return "unknown";
      }
      await tx.update(paymentReconciliationCase).set({
        providerTransactionId: result.transactionId,
        providerEventTime: current.providerEventTime || result.providerEventTime,
        providerStatus: "SUCCESS",
        updateTime: now,
      }).where(eq(paymentReconciliationCase.id, claim.id));
      return null;
    });
  }

  private async recoverOfflinePayment(claim: ClaimedCase): Promise<PaymentReconciliationProcessResult> {
    try {
      const reference = { caseId: claim.id, replayKey: claim.replayKey };
      const prior = await findOfflineQueryEvidence(this.container, reference);
      if (prior) {
        const settled = await settleOfflineOrderQueryPayment(this.container, { queryId: prior.id, replayKey: prior.replayKey });
        return this.finish(claim, { status: settled.replayed ? 'CONFIRMED' : 'SETTLED', providerStatus: 'SUCCESS',
          orderDomain: 'offline_order', errorCode: '', result: { status: 'SUCCESS', providerTradeState: prior.tradeState,
            orderNo: prior.orderNo, transactionId: prior.transactionId, amountCents: prior.amountCents, currency: 'CNY',
            providerEventTime: prior.providerEventTime, errorCode: '' } });
      }
      if (claim.callbackEventId) return this.recoverOfflineCallback(claim);
      if (!claim.initiatedTime) throw new Error('offline_payment_intent_required');
      // Authoritative selection read commits before KV/provider I/O. This path
      // deliberately does not accept the ordinary injectable scalar-only query.
      const queried = await queryOfflineOrderPayment(this.container, this.env, claim);
      if (queried.result.status !== 'SUCCESS') {
        const pending = queried.result.status === 'PENDING';
        return this.finish(claim, { status: pending ? 'WAITING' : claim.attemptCount >= MAX_QUERY_ATTEMPTS ? 'DEAD' : 'UNKNOWN',
          providerStatus: queried.result.status, orderDomain: 'offline_order', result: queried.result,
          errorCode: pending ? '' : queried.result.errorCode || 'offline_provider_result_unknown' });
      }
      const stored = await persistOfflineQueryEvidence(this.container, { reference, request: claim, queried });
      if (stored.terminalConflict) return 'conflict';
      if (stored.closed) return 'already-terminal';
      const settled = await settleOfflineOrderQueryPayment(this.container, stored);
      return this.finish(claim, { status: settled.replayed ? 'CONFIRMED' : 'SETTLED', providerStatus: 'SUCCESS',
        orderDomain: 'offline_order', errorCode: '', result: queried.result });
    } catch (error) {
      return this.finishQueryFailure(claim, error);
    }
  }

  private async recoverOfflineCallback(claim: ClaimedCase): Promise<PaymentReconciliationProcessResult> {
    try {
      const callbackEventId = claim.callbackEventId;
      if (!callbackEventId) throw new Error('offline_verified_callback_required');
      const [event] = await withTx(this.container, tx => tx.select().from(paymentCallbackEvent)
        .where(eq(paymentCallbackEvent.id, callbackEventId)).limit(1));
      if (!event || event.orderDomain !== 'offline_order' || event.provider !== claim.provider
        || event.profile !== claim.profile || event.orderNo !== claim.orderNo || event.currency !== 'CNY'
        || event.amountCents !== claim.expectedAmountCents || event.transactionId !== claim.providerTransactionId) {
        throw new Error('offline_recovery_callback_mismatch');
      }
      // The settler re-locks and validates original identity, amount, event hash,
      // recovery conflicts and receipt. This is NOT an active provider query.
      const settled = await settleOfflineOrderExternalPayment(this.container, { eventId: event.id, replayKey: event.replayKey });
      return this.finish(claim, {
        status: settled.replayed ? 'CONFIRMED' : 'SETTLED', providerStatus: 'SUCCESS', orderDomain: 'offline_order', errorCode: '',
        result: { status: 'SUCCESS', providerTradeState: event.tradeState, orderNo: event.orderNo,
          transactionId: event.transactionId, amountCents: event.amountCents, currency: 'CNY',
          providerEventTime: event.providerEventTime, errorCode: '' },
      });
    } catch (error) {
      // Missing evidence is not proof of non-payment. Retain UNKNOWN/DEAD for
      // retry/attention without issuing a new payment or adopting current config.
      return this.finishQueryFailure(claim, error);
    }
  }

  async list(input: { status?: unknown; afterId?: unknown; limit?: unknown }) {
    const status = typeof input.status === "string" ? input.status.trim().toUpperCase() : "";
    const allowed = [
      "",
      ...ATTENTION_STATUSES,
      ...TERMINAL_STATUSES,
      "OPEN",
      "QUEUED",
      "QUERYING",
      "WAITING",
    ];
    if (!allowed.includes(status as PaymentReconciliationStatus | "")) {
      throw new ValidateException("对账状态无效");
    }
    const afterId = Number(input.afterId ?? 0);
    const limit = Number(input.limit ?? 50);
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new ValidateException("游标无效");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidateException("每页数量无效");
    }
    const conditions = [gt(paymentReconciliationCase.id, afterId)];
    if (status) conditions.push(eq(
      paymentReconciliationCase.status,
      status as PaymentReconciliationStatus,
    ));
    const rows = await withTx(this.container, (tx) => tx.select({
        id: paymentReconciliationCase.id,
        provider: paymentReconciliationCase.provider,
        profile: paymentReconciliationCase.profile,
        orderDomain: paymentReconciliationCase.orderDomain,
        orderNo: paymentReconciliationCase.orderNo,
        expectedAmountCents: paymentReconciliationCase.expectedAmountCents,
        status: paymentReconciliationCase.status,
        providerStatus: paymentReconciliationCase.providerStatus,
        providerTransactionId: paymentReconciliationCase.providerTransactionId,
        providerEventTime: paymentReconciliationCase.providerEventTime,
        attemptCount: paymentReconciliationCase.attemptCount,
        nextCheckTime: paymentReconciliationCase.nextCheckTime,
        lastQueryTime: paymentReconciliationCase.lastQueryTime,
        lastErrorCode: paymentReconciliationCase.lastErrorCode,
        initiatedTime: paymentReconciliationCase.initiatedTime,
        resolvedTime: paymentReconciliationCase.resolvedTime,
        updateTime: paymentReconciliationCase.updateTime,
      }).from(paymentReconciliationCase).where(and(...conditions))
        .orderBy(asc(paymentReconciliationCase.id)).limit(limit));
    return {
      list: rows,
      next_cursor: rows.at(-1)?.id ?? afterId,
      has_more: rows.length === limit,
    };
  }

  async decide(input: {
    caseId: number;
    adminId: number;
    actionKey: string;
    action: "retry" | "accept_local" | "close";
    reasonCode: string;
  }) {
    if (!Number.isSafeInteger(input.caseId) || input.caseId <= 0) {
      throw new ValidateException("对账案件无效");
    }
    if (!Number.isSafeInteger(input.adminId) || input.adminId <= 0) {
      throw new ValidateException("管理员身份无效");
    }
    if (!UUID_V4.test(input.actionKey)) throw new ValidateException("操作幂等键无效");
    if (!REASON_CODE.test(input.reasonCode)) throw new ValidateException("操作原因码无效");
    const actionType: PaymentReconciliationActionType = input.action === "retry"
      ? "RETRY"
      : input.action === "accept_local"
        ? "ACCEPT_LOCAL"
        : "CLOSE";
    return withTx(this.container, async (tx) => {
      const prior = await tx.select().from(paymentReconciliationAction)
        .where(eq(paymentReconciliationAction.actionKey, input.actionKey)).limit(1);
      if (prior[0]) {
        if (
          prior[0].caseId !== input.caseId
          || prior[0].adminId !== input.adminId
          || prior[0].actionType !== actionType
          || prior[0].reasonCode !== input.reasonCode
        ) throw new ValidateException("操作幂等键已用于其他处置");
        return { status: prior[0].afterStatus, duplicate: true };
      }
      const rows = await tx.select().from(paymentReconciliationCase)
        .where(eq(paymentReconciliationCase.id, input.caseId)).limit(1).for("update");
      const current = rows[0];
      if (!current) throw new ValidateException("对账案件不存在");
      if (!ATTENTION_STATUSES.includes(current.status)) {
        throw new ValidateException("当前对账状态不允许人工处置");
      }
      let afterStatus: PaymentReconciliationStatus;
      if (actionType === "RETRY") {
        afterStatus = "OPEN";
      } else if (actionType === "ACCEPT_LOCAL") {
        if (!(await localPaidTx(tx, current.orderNo, current.orderDomain))) {
          throw new ValidateException("本地订单尚未支付，不能接受本地证据");
        }
        afterStatus = "CONFIRMED";
      } else {
        afterStatus = "CLOSED";
      }
      const now = Math.floor(Date.now() / 1_000);
      await tx.insert(paymentReconciliationAction).values({
        caseId: current.id,
        actionKey: input.actionKey,
        adminId: input.adminId,
        actionType,
        reasonCode: input.reasonCode,
        beforeStatus: current.status,
        afterStatus,
        addTime: now,
      });
      await tx.update(paymentReconciliationCase).set({
        status: afterStatus,
        attemptCount: actionType === "RETRY" ? 0 : current.attemptCount,
        nextCheckTime: actionType === "RETRY" ? now : 0,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: actionType === "RETRY" ? "" : current.lastErrorCode,
        resolvedTime: actionType === "RETRY" ? 0 : now,
        retainUntil: now + RETENTION_SECONDS,
        updateTime: now,
      }).where(eq(paymentReconciliationCase.id, current.id));
      return { status: afterStatus, duplicate: false };
    });
  }

  private async claim(message: PaymentReconciliationMessage): Promise<
    ClaimedCase | "already-terminal" | "busy" | "dead" | { kind: "deferred"; delaySeconds: number }
  > {
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const rows = await tx.select().from(paymentReconciliationCase)
        .where(eq(paymentReconciliationCase.id, message.caseId)).limit(1).for("update");
      const row = rows[0];
      if (!row || row.replayKey !== message.replayKey) {
        throw new Error("payment_reconciliation_queue_message_mismatch");
      }
      if (TERMINAL_STATUSES.includes(row.status)) return "already-terminal";
      if (row.status === "DEAD") return "dead";
      if (row.status === "QUERYING" && row.leaseUntil > now) return "busy";
      if (["OPEN", "WAITING", "UNKNOWN"].includes(row.status) && row.nextCheckTime > now) {
        return { kind: "deferred", delaySeconds: Math.min(row.nextCheckTime - now, 21_600) };
      }
      const attemptCount = row.attemptCount + 1;
      if (attemptCount > MAX_QUERY_ATTEMPTS) {
        await tx.update(paymentReconciliationCase).set({
          status: "DEAD",
          leaseUntil: 0,
          leaseToken: "",
          lastErrorCode: "payment_reconciliation_attempts_exhausted",
          resolvedTime: now,
          updateTime: now,
        }).where(eq(paymentReconciliationCase.id, row.id));
        return "dead";
      }
      await tx.update(paymentReconciliationCase).set({
        status: "QUERYING",
        attemptCount,
        leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken,
        lastQueryTime: now,
        updateTime: now,
      }).where(eq(paymentReconciliationCase.id, row.id));
      return {
        id: row.id,
        replayKey: row.replayKey,
        provider: row.provider,
        profile: row.profile,
        orderDomain: row.orderDomain,
        orderNo: row.orderNo,
        expectedAmountCents: row.expectedAmountCents,
        currency: "CNY",
        leaseToken,
        attemptCount,
        initiatedTime: row.initiatedTime,
        addTime: row.addTime,
        providerTransactionId: row.providerTransactionId,
        providerEventTime: row.providerEventTime,
        callbackEventId: row.callbackEventId,
      };
    });
  }

  private async finish(
    claim: ClaimedCase,
    outcome: {
      status: PaymentReconciliationStatus;
      providerStatus: PaymentProviderQueryResult["status"];
      result: PaymentProviderQueryResult;
      orderDomain?: PaymentCallbackOrderDomain;
      errorCode: string;
    },
  ): Promise<PaymentReconciliationProcessResult> {
    const now = Math.floor(Date.now() / 1_000);
    const status = await withTx(this.container, async (tx) => {
      // The provider query happened without SQL locks. Re-read the case under
      // its row lock: a verified callback may have arrived after claim().
      const [current] = await tx.select().from(paymentReconciliationCase)
        .where(eq(paymentReconciliationCase.id, claim.id)).limit(1).for("update");
      if (!current) throw new Error("payment_reconciliation_processing_fence_lost");
      // A callback can terminate the case after query registration.
      if (current.status === "CONFLICT") return "CONFLICT";
      if (current.status === "CONFIRMED") return "CONFIRMED";
      if (current.status === "SETTLED") return "SETTLED";
      if (current.status === "CLOSED") return "CLOSED";
      if (current.status !== "QUERYING" || current.leaseToken !== claim.leaseToken) {
        throw new Error("payment_reconciliation_processing_fence_lost");
      }
      const queryTransaction = outcome.result.transactionId;
      const transactionConflict = !!(current.providerTransactionId && queryTransaction
        && current.providerTransactionId !== queryTransaction);
      const knownDomain = current.orderDomain || claim.orderDomain;
      const domainConflict = !!(knownDomain && outcome.orderDomain && knownDomain !== outcome.orderDomain);
      const newEvidence = current.callbackEventId !== claim.callbackEventId
        || (current.providerTransactionId !== claim.providerTransactionId
          && current.providerTransactionId !== queryTransaction);
      // Preserve the callback's immutable transaction/event evidence. If the
      // two trusted sources disagree, require review. If a callback appeared
      // while querying, let its outbox settle before drawing a query conclusion.
      const effectiveStatus: PaymentReconciliationStatus = transactionConflict || domainConflict
        ? "CONFLICT" : newEvidence ? "UNKNOWN" : outcome.status;
      const terminal = TERMINAL_STATUSES.includes(effectiveStatus) || effectiveStatus === "DEAD";
      const errorCode = transactionConflict ? "provider_query_transaction_conflict"
        : domainConflict ? "provider_query_domain_conflict"
          : newEvidence ? "concurrent_callback_evidence" : outcome.errorCode;
      const updated = await tx.update(paymentReconciliationCase).set({
        status: effectiveStatus,
        providerStatus: transactionConflict || domainConflict || newEvidence
          ? current.providerStatus : outcome.providerStatus,
        providerTransactionId: current.providerTransactionId || queryTransaction,
        providerEventTime: current.providerEventTime || outcome.result.providerEventTime,
        orderDomain: knownDomain || outcome.orderDomain || "",
        nextCheckTime: terminal ? 0 : now + paymentReconciliationBackoff(claim.attemptCount),
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode,
        resolvedTime: terminal ? now : 0,
        retainUntil: terminal ? now + RETENTION_SECONDS : sql`${paymentReconciliationCase.retainUntil}`,
        updateTime: now,
      }).where(and(
        eq(paymentReconciliationCase.id, claim.id),
        eq(paymentReconciliationCase.status, "QUERYING"),
        eq(paymentReconciliationCase.leaseToken, claim.leaseToken),
      )).returning({ id: paymentReconciliationCase.id });
      if (updated.length !== 1) throw new Error("payment_reconciliation_processing_fence_lost");
      return effectiveStatus;
    });
    if (status === "SETTLED") return "settled";
    if (status === "CONFIRMED") return "confirmed";
    if (status === "WAITING") return "waiting";
    if (status === "NO_PAYMENT") return "no-payment";
    if (status === "CONFLICT") return "conflict";
    if (status === "DEAD") return "dead";
    if (status === "CLOSED") return "already-terminal";
    return "unknown";
  }

  private async finishQueryFailure(
    claim: ClaimedCase,
    error: unknown,
    result?: PaymentProviderQueryResult,
  ): Promise<PaymentReconciliationProcessResult> {
    const dead = claim.attemptCount >= MAX_QUERY_ATTEMPTS;
    return this.finish(claim, {
      status: dead ? "DEAD" : "UNKNOWN",
      providerStatus: "UNKNOWN",
      result: result ?? {
        status: "UNKNOWN",
        providerTradeState: "UNKNOWN",
        orderNo: claim.orderNo,
        transactionId: "",
        amountCents: 0,
        currency: "CNY",
        providerEventTime: 0,
        errorCode: "",
      },
      errorCode: lowCardinalityError(error, "provider_query_failed"),
    });
  }

  private async defaultProviderQuery(
    request: PaymentProviderQueryRequest,
  ): Promise<PaymentProviderQueryResult> {
    return request.provider === "wechat"
      ? new WechatPayService(this.container, this.env).queryOrder(request)
      : new AlipayTradeQueryService(this.env).query(request);
  }

  private async localEvidence(orderNo: string, domain: PaymentCallbackOrderDomain) {
    return withTx(this.container, async (tx) => {
      const candidates: boolean[] = [];
      if (domain === "" || domain === "store_order") {
        const rows = await tx.select({ paid: storeOrder.paid }).from(storeOrder)
          .where(eq(storeOrder.orderId, orderNo)).limit(2);
        candidates.push(...rows.map((row) => row.paid === 1));
      }
      if (domain === "" || domain === "recharge") {
        const rows = await tx.select({ paid: userRecharge.paid }).from(userRecharge)
          .where(eq(userRecharge.orderId, orderNo)).limit(2);
        candidates.push(...rows.map((row) => row.paid === 1));
      }
      if (domain === "" || domain === "membership") {
        const rows = await tx.select({ paid: otherOrder.paid, type: otherOrder.type }).from(otherOrder)
          .where(eq(otherOrder.orderId, orderNo)).limit(2);
        candidates.push(...rows.map(isPaidMembershipOrder));
      }
      return { paid: candidates.length === 1 && candidates[0] === true };
    });
  }

  private async assertQueriedSettlementEvidenceTx(
    tx: DbClient,
    claim: ClaimedCase,
    result: PaymentProviderQueryResult,
    domain: PaymentCallbackOrderDomain,
  ): Promise<void> {
    // The order row was locked by the caller. Hold this boundary until its
    // paid transition commits, and re-read callback/query evidence inside it.
    await lockStoreOrderPaymentBoundary(tx, claim.orderNo);
    const [current] = await tx.select().from(paymentReconciliationCase)
      .where(eq(paymentReconciliationCase.id, claim.id)).limit(1).for("update");
    if (!current || current.replayKey !== claim.replayKey
      || current.status !== "QUERYING" || current.leaseToken !== claim.leaseToken
      || current.provider !== claim.provider || current.profile !== claim.profile
      || current.orderNo !== claim.orderNo
      || current.expectedAmountCents !== claim.expectedAmountCents
      || current.providerTransactionId !== result.transactionId
      || !!(current.orderDomain && current.orderDomain !== domain)
      || current.callbackEventId !== claim.callbackEventId) {
      throw new ValidateException("支付查询期间出现新的回调或对账状态，停止结算");
    }
  }

  private async settle(
    request: ClaimedCase,
    result: PaymentProviderQueryResult,
  ): Promise<SettlementResult> {
    const [store, recharge, membership] = await Promise.all([
      this.container.storeOrderDao.findByOrderId(request.orderNo),
      findRechargeOrderByOrderId(this.container, request.orderNo),
      findMembershipOrderByOrderId(this.container, request.orderNo),
    ]);
    const candidates = [store, recharge, membership].filter(Boolean);
    if (candidates.length !== 1) {
      return {
        status: "unknown",
        domain: "",
        errorCode: candidates.length === 0 ? "order_missing" : "order_domain_conflict",
      };
    }
    const expected = decimalToCents(String(store?.payPrice ?? recharge?.price ?? membership?.payPrice));
    if (expected !== request.expectedAmountCents || expected !== result.amountCents) {
      return { status: "unknown", domain: "", errorCode: "amount_mismatch" };
    }
    const payType = request.provider === "wechat" ? "weixin" : "alipay";
    if (store) {
      const settled = await applyStoreOrderPayment(this.container, {
        orderId: store.id,
        payType,
        tradeNo: result.transactionId,
        authorizeBeforePayment: (tx) => this.assertQueriedSettlementEvidenceTx(tx, request, result, "store_order"),
      });
      if (settled.outbox) {
        try {
          await new OrderOutboxService(this.container, this.env).dispatchById(settled.outbox.id);
        } catch (error) {
          emitOperationalEvent("error", {
            event: "payment_order_outbox_dispatch_failed",
            component: "queue",
            operation: "payment_reconciliation",
            outcome: "failure",
            errorCode: operationalErrorCode(error, "order_outbox_dispatch_failed"),
          });
        }
      }
      return settlementOutcome("store_order", settled.outcome);
    }
    if (recharge) {
      const settled = await applyRechargePayment(this.container, {
        orderId: request.orderNo,
        payType,
        tradeNo: result.transactionId,
        expectedAmountCents: result.amountCents,
        authorizeBeforePayment: (tx) => this.assertQueriedSettlementEvidenceTx(tx, request, result, "recharge"),
      });
      return settlementOutcome("recharge", settled.outcome);
    }
    const settled = await applyMembershipPayment(this.container, {
      orderId: request.orderNo,
      payType,
      tradeNo: result.transactionId,
      expectedAmountCents: result.amountCents,
      authorizeBeforePayment: (tx) => this.assertQueriedSettlementEvidenceTx(tx, request, result, "membership"),
    });
    return settlementOutcome("membership", settled.outcome);
  }
}

function settlementOutcome(
  domain: PaymentCallbackOrderDomain,
  outcome: StoreOrderPaymentOutcome | "paid" | "already-paid" | "not-payable" | "missing",
): SettlementResult {
  if (outcome === "paid" || outcome === "already-paid") {
    return { status: "completed", domain, errorCode: "", outcome };
  }
  return {
    status: "unknown",
    domain,
    errorCode: outcome === "not-payable" ? "order_not_payable" : "order_missing",
  };
}

// Match PaidMembershipService's type=0/1 boundary. Do not filter type in SQL:
// an unsupported same-number row must still make the order identity ambiguous.
function isPaidMembershipOrder(row: { paid: number; type: number }): boolean {
  return row.paid === 1 && (row.type === 0 || row.type === 1);
}

async function localPaidTx(
  tx: DbClient,
  orderNo: string,
  domain: PaymentCallbackOrderDomain,
): Promise<boolean> {
  try {
    // ACCEPT_LOCAL already owns the case row. Every settlement now locks its
    // local order row before rechecking this case, so never wait backwards.
    if (domain === "store_order") {
      const rows = await tx.select({ paid: storeOrder.paid }).from(storeOrder)
        .where(eq(storeOrder.orderId, orderNo)).limit(2).for("update", { noWait: true });
      return rows.length === 1 && rows[0].paid === 1;
    }
    if (domain === "recharge") {
      const rows = await tx.select({ paid: userRecharge.paid }).from(userRecharge)
        .where(eq(userRecharge.orderId, orderNo)).limit(2).for("update", { noWait: true });
      return rows.length === 1 && rows[0].paid === 1;
    }
    if (domain === "membership") {
      const rows = await tx.select({ paid: otherOrder.paid, type: otherOrder.type }).from(otherOrder)
        .where(eq(otherOrder.orderId, orderNo)).limit(2).for("update", { noWait: true });
      return rows.length === 1 && isPaidMembershipOrder(rows[0]);
    }
    return false;
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && cause.code === "55P03") {
        throw new ValidateException("订单正在更新，请稍后重试人工对账处置");
      }
      if (!("cause" in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
}

interface QueueControl {
  body: PaymentReconciliationMessage;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export async function consumePaymentReconciliationMessage(
  message: QueueControl,
  service: Pick<PaymentReconciliationService, "processMessage">,
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
    const attention = ["unknown", "conflict", "dead"].includes(result);
    if (attention) {
      emitOperationalEvent("error", {
        event: "payment_reconciliation_attention",
        component: "payment",
        operation: "payment_reconciliation",
        outcome: "failure",
        result,
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
      });
    } else {
      emitOperationalEvent("info", {
        event: "payment_reconciliation_completed",
        component: "payment",
        operation: "payment_reconciliation",
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
      event: "payment_reconciliation_failed",
      component: "payment",
      operation: "payment_reconciliation",
      outcome: "retry",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error, "payment_reconciliation_failed"),
    });
    message.retry({ delaySeconds });
  }
}
