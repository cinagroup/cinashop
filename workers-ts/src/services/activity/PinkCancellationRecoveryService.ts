import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { Env } from "@/env";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { storeOrder, storeOrderRefund } from "@/models/schema";
import { lockRefundExecution, StoreOrderRefundService } from "@/services/order/StoreOrderRefundService";
import { amountToCents } from "@/services/payment/RefundGateway";
import { PinkCancellationStatusService } from "./PinkCancellationStatusService";
import { ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

export const PINK_CANCELLATION_RECOVERY_PAGE_SIZE = 5;

/** One query definition for execution and isolated EXPLAIN audits. Callers must
 * validate the cursor/time and freeze the ceiling before executing this scan. */
export function pinkCancellationRecoveryScan(db: Pick<DbClient, "select">,
  cursor: number, highWater: number, scheduledAt: number) {
  return db.select({ id: storeOrderRefund.id, uid: storeOrderRefund.uid,
    orderId: storeOrderRefund.orderId, storeOrderId: storeOrderRefund.storeOrderId,
    refundPrice: storeOrderRefund.refundPrice, refundNum: storeOrderRefund.refundNum,
    pinkId: storeOrder.pinkId, cid: storeOrder.activityId })
    .from(storeOrderRefund).leftJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
    .where(and(gt(storeOrderRefund.id, cursor), lte(storeOrderRefund.id, highWater),
      // Allow an initiating HTTP request to finish before the next cron pass.
      lte(storeOrderRefund.addTime, Math.floor(scheduledAt / 1000) - 60),
      // Immutable business predicates stay literal so even a generic plan can
      // prove partial-index eligibility. Never inline cursor/time/user input.
      sql`${storeOrderRefund.isCancel} = 0 AND ${storeOrderRefund.isDel} = 0 AND ${storeOrderRefund.applyType} = 1
        AND ${storeOrderRefund.refundType} IN (0, 1, 2, 4, 5)
        AND ${storeOrderRefund.refundReason} = '用户手动取消拼团'
        AND ${storeOrderRefund.refundExplain} = '用户手动取消未成团的拼团订单'
        AND left(${storeOrderRefund.orderId}, 12) = 'pink_cancel_'`))
    .orderBy(asc(storeOrderRefund.id)).limit(PINK_CANCELLATION_RECOVERY_PAGE_SIZE);
}

/** Read-only discovery has its own budgets, restored before refund execution.
 * A timeout must reject the page, not masquerade as an exhausted traversal.
 * These are per-statement/lock/idle limits, not a total job latency guarantee. */
export async function pinkCancellationRecoverySnapshot(container: Container,
  cursor: number, scheduledAt: number, ceiling: number | null) {
  const validId = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 2_147_483_647;
  if (!validId(cursor) || ceiling !== null && !validId(ceiling) ||
    !Number.isSafeInteger(scheduledAt) || scheduledAt <= 0 || scheduledAt > 8_640_000_000_000_000) {
    throw new ValidateException("拼团取消恢复游标或时间无效");
  }
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    // Install LOCAL budgets in a separate statement before MAX or the scan.
    // Zero means disabled; never relax a stricter caller deadline.
    await tx.execute(sql`SELECT
      pg_catalog.set_config('statement_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'), 0), 3000)::text || 'ms', true),
      pg_catalog.set_config('lock_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'), 0), 500)::text || 'ms', true),
      pg_catalog.set_config('idle_in_transaction_session_timeout',
        LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'), 0), 5000)::text || 'ms', true)`);
    const highWater = ceiling ?? (await tx.select({ id: sql<number>`COALESCE(MAX(${storeOrderRefund.id}), 0)::int` })
      .from(storeOrderRefund))[0].id;
    const candidates = await pinkCancellationRecoveryScan(tx, cursor, highWater, scheduledAt);
    return { candidates, highWater };
  });
}

/** Recovery of a durable, owner-authorized cancellation, never auto-approval of
 * ordinary after-sales or creation of a replacement application. The scheduled
 * run supplies the age cutoff; a frozen high-water ID bounds every traversal.
 * No database transaction/row lock is held across refund provider I/O. */
export class PinkCancellationRecoveryService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  async recoverPage(cursor: number, scheduledAt: number, ceiling: number | null) {
    const { candidates, highWater } = await pinkCancellationRecoverySnapshot(this.container, cursor, scheduledAt, ceiling);
    let completed = 0, pending = 0, attention = 0, errors = 0;
    for (const candidate of candidates) {
      try {
        const cents = amountToCents(candidate.refundPrice);
        if (!candidate.pinkId || !candidate.cid || cents === null || cents <= 0 ||
          candidate.orderId !== `pink_cancel_${candidate.pinkId}_${candidate.storeOrderId}`) {
          attention++; continue;
        }
        // This validates current original-leader ownership, full amount/quantity,
        // duplicate receipts, parent payment scope and terminal channel evidence.
        const receipt = await new PinkCancellationStatusService(this.container)
          .read(candidate.uid, String(candidate.pinkId), String(candidate.cid));
        if (receipt.completed) { completed++; continue; }
        if (!receipt.resumable) { attention++; continue; }
        // Crucially call the refund-ID execution core, NOT removePink/applyRefund:
        // deletion/replacement between scan and execution must never create a new
        // application. The core revalidates this exact scope under its own locks.
        const result = await new StoreOrderRefundService(this.container, this.env).agreeRefund(candidate.id, {
          expectedUid: candidate.uid, expectedStoreOrderId: candidate.storeOrderId,
          expectedRefundOrderId: candidate.orderId, expectedRefundAmountCents: cents,
          requirePaid: true, requireSystemVisible: true,
          authorizeBeforeRefundLock: async tx => {
            // Reuse the core's refund-first advisory/row-lock order. Do not
            // acquire an activity/order/user lock here, or hold it over I/O.
            await lockRefundExecution(tx, candidate.id);
            const [current] = await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, candidate.id)).limit(1).for("update");
            if (!current || current.uid !== candidate.uid || current.storeOrderId !== candidate.storeOrderId ||
              current.orderId !== candidate.orderId || current.applyType !== 1 || current.refundNum !== candidate.refundNum ||
              current.refundReason !== "用户手动取消拼团" || current.refundExplain !== "用户手动取消未成团的拼团订单") {
              throw new ValidateException("原拼团取消申请已变化，停止自动恢复");
            }
          },
        });
        if (result.completed) completed++; else pending++;
      } catch (error) {
        errors++;
        emitOperationalEvent("error", { event: "pink_cancellation_recovery_failed", component: "refund",
          operation: "pink_cancellation_recovery", outcome: "failure", errorCode: operationalErrorCode(error) });
      }
    }
    // Poison rows do not starve later IDs. Unfinished rows remain durable and
    // are reconsidered by the next five-minute root run, not a tight local loop.
    const result = { checked: candidates.length, completed, pending, attention, errors,
      nextCursor: candidates.at(-1)?.id ?? cursor, hasMore: candidates.length === PINK_CANCELLATION_RECOVERY_PAGE_SIZE,
      highWater };
    emitOperationalEvent(attention || errors ? "warn" : "info", {
      event: "pink_cancellation_recovery_page", component: "refund", operation: "pink_cancellation_recovery",
      outcome: attention || errors ? "unknown" : "success", resourceCount: candidates.length,
      completed, pending, attention, errors,
    });
    return result;
  }
}
