import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env, OrderPrintJobMessage, OrderMessage } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { createContainerFromDb, withTx } from "@/lib/di";
import {
  orderPrintJob,
  orderPrintJobAction,
  printDocument,
  storeOrder,
  storeOrderCartInfo,
  type OrderPrintJobActionType,
  type OrderPrintJobStatus,
  type OrderPrintTrigger,
  type PrintDocument,
} from "@/models/schema";
import { printDocumentReadiness } from "@/services/system/PrintDocumentManagementService";
import {
  ReceiptPrinterConfigurationError,
  ReceiptPrinterPreflightError,
  ReceiptPrinterRejectedError,
  renderReceipt,
  sendReceiptToProvider,
  sha256Hex,
} from "@/services/printing/ReceiptPrintProvider";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";

const QUEUE_LEASE_SECONDS = 5 * 60;
const PROVIDER_LEASE_SECONDS = 2 * 60;
const MAX_PROVIDER_ATTEMPTS = 5;
const MAX_MANUAL_REPLAYS = 20;
const REQUEST_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const JOB_STATUSES = new Set<OrderPrintJobStatus>([
  "PENDING", "ENQUEUING", "ENQUEUED", "PROCESSING", "RETRYABLE",
  "SENT", "UNKNOWN", "DEAD", "CLOSED",
]);
const JOB_TRIGGERS = new Set<OrderPrintTrigger>(["created", "paid", "manual"]);

export interface AutomaticPrintOrder {
  id: number;
  orderId: string;
  supplierId: number;
}

export interface PrintJobActor {
  supplierId: number;
  actorType: "admin" | "supplier";
  actorId: number;
}

export interface ManualPrintInput {
  requestKey: unknown;
  printerId?: unknown;
}

export interface PrintJobListQuery {
  status?: string;
  trigger?: string;
  orderId?: number;
  afterId?: number;
  limit?: number;
}

export interface PrintJobOperationInput {
  requestKey: unknown;
  reason: unknown;
  providerReference?: unknown;
}

interface ClaimedPrintJob {
  id: number;
  eventKey: string;
  printerId: number;
  supplierId: number;
  provider: "yilianyun" | "feieyun";
  trigger: OrderPrintTrigger;
  orderId: number;
  attemptCount: number;
  leaseToken: string;
}

interface ProviderResult {
  providerReference: string;
  requestId: string;
  responseCode: string;
}

type ProcessingResult =
  | "sent"
  | "retry-scheduled"
  | "unknown"
  | "dead"
  | "closed"
  | "already-sent"
  | "busy";

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function positiveInt(value: unknown, label: string, maximum = 2_147_483_647): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return positiveInt(value, label);
}

function requestKey(value: unknown): string {
  const key = String(value ?? "").trim().toLowerCase();
  if (!REQUEST_KEY_PATTERN.test(key)) throw new ValidateException("请求键必须是 UUIDv4");
  return key;
}

function boundedText(value: unknown, label: string, maximum: number, minimum = 0): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const text = value.trim();
  const length = [...text].length;
  if (length < minimum || length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ValidateException(`${label}长度必须为${minimum}到${maximum}个可见字符`);
  }
  return text;
}

function providerFor(printer: Pick<PrintDocument, "type">): "yilianyun" | "feieyun" {
  if (printer.type === 1) return "yilianyun";
  if (printer.type === 2) return "feieyun";
  throw new ReceiptPrinterConfigurationError("打印平台类型无效");
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(60 * 2 ** Math.max(attemptCount - 1, 0), 30 * 60);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOrderPrintJobMessage(value: unknown): value is OrderPrintJobMessage {
  return isRecord(value) && value.action === "processOrderPrintJob"
    && Number.isSafeInteger(value.printJobId) && Number(value.printJobId) > 0
    && typeof value.eventKey === "string"
    && /^order\.print\.(?:created|paid|manual):/.test(value.eventKey);
}

function printJobProjection(row: typeof orderPrintJob.$inferSelect) {
  return {
    id: row.id,
    event_key: row.eventKey,
    order_id: row.orderId,
    order_no: row.orderNo,
    printer_id: row.printerId,
    supplier_id: row.supplierId,
    trigger: row.trigger,
    provider: row.provider,
    actor_type: row.actorType,
    actor_id: row.actorId,
    status: row.status,
    dispatch_count: row.dispatchCount,
    attempt_count: row.attemptCount,
    replay_count: row.replayCount,
    available_time: row.availableTime,
    lease_until: row.leaseUntil,
    provider_reference: row.providerReference,
    provider_request_id: row.providerRequestId,
    response_code: row.responseCode,
    content_hash: row.contentHash,
    last_error: row.lastError,
    sent_time: row.sentTime,
    add_time: row.addTime,
    update_time: row.updateTime,
  };
}

/** Insert automatic print intent in the same transaction as its order event. */
export async function enqueueAutomaticReceiptPrintJobs(
  tx: DbClient,
  orders: readonly AutomaticPrintOrder[],
  trigger: Exclude<OrderPrintTrigger, "manual">,
  now: number,
): Promise<number> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("print job timestamp invalid");
  const candidates = orders.filter((order) => order.id > 0 && order.supplierId >= 0);
  if (!candidates.length) return 0;
  const scopes = [...new Set(candidates.map((order) => trigger === "created" ? 0 : order.supplierId))];
  const printers = await tx.select().from(printDocument).where(and(
    inArray(printDocument.supplierId, scopes),
    inArray(printDocument.type, [1, 2]),
    eq(printDocument.isDel, 0),
    eq(printDocument.status, 1),
    eq(printDocument.printType, trigger === "created" ? 2 : 1),
  ));
  const values = candidates.flatMap((order) => {
    const supplierId = trigger === "created" ? 0 : order.supplierId;
    return printers.filter((printer) => printer.supplierId === supplierId).map((printer) => ({
      eventKey: `order.print.${trigger}:${order.id}:${printer.id}`,
      orderId: order.id,
      orderNo: order.orderId,
      printerId: printer.id,
      supplierId,
      trigger,
      provider: providerFor(printer),
      actorType: "system" as const,
      actorId: 0,
      status: "PENDING" as const,
      availableTime: now,
      addTime: now,
      updateTime: now,
    }));
  });
  if (!values.length) return 0;
  const inserted = await tx.insert(orderPrintJob).values(values)
    .onConflictDoNothing({ target: orderPrintJob.eventKey })
    .returning({ id: orderPrintJob.id });
  return inserted.length;
}

export class ReceiptPrintJobService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async createManualJobs(orderIdValue: unknown, actor: PrintJobActor, input: ManualPrintInput) {
    const orderId = positiveInt(orderIdValue, "订单ID");
    this.assertActor(actor);
    const key = requestKey(input.requestKey);
    const selectedPrinterId = optionalPositiveInt(input.printerId, "打印机ID");
    const now = Math.floor(Date.now() / 1_000);

    const result = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print-request:${key}`}))`);
      const prior = await tx.select().from(orderPrintJob)
        .where(eq(orderPrintJob.requestKey, key)).orderBy(asc(orderPrintJob.id));
      if (prior.length) {
        if (prior.some((job) =>
          job.trigger !== "manual" || job.orderId !== orderId || job.supplierId !== actor.supplierId ||
          job.actorType !== actor.actorType || job.actorId !== actor.actorId ||
          (selectedPrinterId !== undefined && job.printerId !== selectedPrinterId)
        )) throw new ValidateException("请求键已被不同的手工打印内容使用");
        return { duplicate: true, jobs: prior.map(printJobProjection) };
      }

      const conditions: SQL[] = [eq(storeOrder.id, orderId), eq(storeOrder.isSystemDel, 0)];
      if (actor.actorType === "supplier") {
        conditions.push(eq(storeOrder.supplierId, actor.supplierId), eq(storeOrder.isDel, 0));
      }
      const orders = await tx.select().from(storeOrder).where(and(...conditions)).limit(1).for("update");
      const order = orders[0];
      if (!order) throw new NotFoundException("订单不存在或无权打印");
      if (order.supplierId < 0) throw new ValidateException("汇总订单不可打印，请选择履约子单");

      const printerConditions: SQL[] = [
        eq(printDocument.supplierId, actor.supplierId),
        eq(printDocument.isDel, 0),
        eq(printDocument.status, 1),
      ];
      if (selectedPrinterId) printerConditions.push(eq(printDocument.id, selectedPrinterId));
      const configured = await tx.select().from(printDocument)
        .where(and(...printerConditions)).orderBy(asc(printDocument.id));
      const printers = configured.filter((printer) => printDocumentReadiness(printer).ready);
      if (!printers.length) {
        throw new ValidateException(selectedPrinterId
          ? "所选打印机未启用或配置不完整"
          : "没有已启用且配置完整的打印机");
      }

      const inserted = await tx.insert(orderPrintJob).values(printers.map((printer) => ({
        eventKey: `order.print.manual:${key}:${printer.id}`,
        requestKey: key,
        orderId: order.id,
        orderNo: order.orderId,
        printerId: printer.id,
        supplierId: actor.supplierId,
        trigger: "manual" as const,
        provider: providerFor(printer),
        actorType: actor.actorType,
        actorId: actor.actorId,
        status: "PENDING" as const,
        availableTime: now,
        addTime: now,
        updateTime: now,
      }))).returning();
      return { duplicate: false, jobs: inserted.map(printJobProjection) };
    });

    try {
      await this.dispatchPending(100, undefined, result.jobs.map((job) => job.id));
    } catch {
      // The durable rows are already committed; the scheduled dispatcher will retry.
    }
    return result;
  }

  async dispatchPending(
    limit = 20,
    eventKey?: string,
    jobIds?: readonly number[],
  ): Promise<{ claimed: number; enqueued: number; unknown: number }> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    const unknown = await this.markExpiredProviderCallsUnknown(now, eventKey, jobIds);
    const eligible = or(
      and(inArray(orderPrintJob.status, ["PENDING", "RETRYABLE"]), lte(orderPrintJob.availableTime, now)),
      and(inArray(orderPrintJob.status, ["ENQUEUING", "ENQUEUED"]), lte(orderPrintJob.leaseUntil, now)),
    )!;
    const claimed = await withTx(this.container, async (tx) => {
      const conditions: SQL[] = [eligible];
      if (eventKey) conditions.push(eq(orderPrintJob.eventKey, eventKey));
      if (jobIds?.length) conditions.push(inArray(orderPrintJob.id, [...jobIds]));
      const rows = await tx.select({ id: orderPrintJob.id, eventKey: orderPrintJob.eventKey })
        .from(orderPrintJob).where(and(...conditions)).orderBy(asc(orderPrintJob.id))
        .limit(boundedLimit).for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(orderPrintJob).set({
        status: "ENQUEUING",
        dispatchCount: sql`${orderPrintJob.dispatchCount} + 1`,
        leaseToken,
        leaseUntil: now + QUEUE_LEASE_SECONDS,
        updateTime: now,
      }).where(inArray(orderPrintJob.id, rows.map((row) => row.id)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0, unknown };

    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((job) => ({
        body: {
          action: "processOrderPrintJob" as const,
          printJobId: job.id,
          eventKey: job.eventKey,
        },
        contentType: "json" as const,
      })));
      await withTx(this.container, async (tx) => {
        const transitioned = await tx.update(orderPrintJob).set({
          status: "ENQUEUED",
          leaseToken: "",
          leaseUntil: now + QUEUE_LEASE_SECONDS,
          lastError: "",
          updateTime: now,
        }).where(and(
          inArray(orderPrintJob.id, claimed.map((job) => job.id)),
          eq(orderPrintJob.status, "ENQUEUING"),
          eq(orderPrintJob.leaseToken, leaseToken),
        )).returning({ id: orderPrintJob.id });
        if (transitioned.length !== claimed.length) throw new Error("打印 Queue 投递状态迁移不完整");
      });
      return { claimed: claimed.length, enqueued: claimed.length, unknown };
    } catch (error) {
      await withTx(this.container, async (tx) => {
        await tx.update(orderPrintJob).set({
          status: "RETRYABLE",
          availableTime: now + 60,
          leaseToken: "",
          leaseUntil: 0,
          lastError: `Queue delivery failed: ${errorText(error)}`.slice(0, 1_000),
          updateTime: now,
        }).where(and(
          inArray(orderPrintJob.id, claimed.map((job) => job.id)),
          eq(orderPrintJob.status, "ENQUEUING"),
          eq(orderPrintJob.leaseToken, leaseToken),
        ));
      });
      throw error;
    }
  }

  async processMessage(
    message: OrderPrintJobMessage,
    fetcher: typeof fetch = fetch,
  ): Promise<ProcessingResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string") return claim;
    let contentHash = "";
    try {
      const input = await this.loadReceipt(claim);
      const content = renderReceipt(input);
      contentHash = await sha256Hex(content);
      const result = await sendReceiptToProvider(input.printer, content, claim.eventKey, fetcher);
      await this.finalize(claim, "SENT", result, "", contentHash, Math.floor(Date.now() / 1_000));
      return "sent";
    } catch (error) {
      const now = Math.floor(Date.now() / 1_000);
      if (error instanceof ReceiptPrinterConfigurationError) {
        await this.finalize(claim, "DEAD", undefined, errorText(error), contentHash, now);
        return "dead";
      }
      if (error instanceof ReceiptPrinterPreflightError) {
        const canRetry = claim.attemptCount < MAX_PROVIDER_ATTEMPTS;
        await this.finalize(
          claim,
          canRetry ? "RETRYABLE" : "DEAD",
          undefined,
          errorText(error),
          contentHash,
          now,
          canRetry ? now + retryDelaySeconds(claim.attemptCount) : 0,
        );
        return canRetry ? "retry-scheduled" : "dead";
      }
      if (error instanceof ReceiptPrinterRejectedError) {
        const canRetry = error.retryable && claim.attemptCount < MAX_PROVIDER_ATTEMPTS;
        await this.finalize(
          claim,
          canRetry ? "RETRYABLE" : "DEAD",
          { providerReference: "", requestId: "", responseCode: error.code },
          errorText(error),
          contentHash,
          now,
          canRetry ? now + retryDelaySeconds(claim.attemptCount) : 0,
        );
        return canRetry ? "retry-scheduled" : "dead";
      }
      // A timeout, disconnect, malformed response, or Worker termination may
      // happen after the provider accepted the print. Never resend blindly.
      await this.finalize(claim, "UNKNOWN", undefined, errorText(error), contentHash, now);
      return "unknown";
    }
  }

  async listJobs(actor: PrintJobActor, query: PrintJobListQuery = {}) {
    this.assertActor(actor);
    const status = query.status?.trim().toUpperCase();
    if (status && !JOB_STATUSES.has(status as OrderPrintJobStatus)) {
      throw new ValidateException("打印任务状态无效");
    }
    const trigger = query.trigger?.trim().toLowerCase();
    if (trigger && !JOB_TRIGGERS.has(trigger as OrderPrintTrigger)) {
      throw new ValidateException("打印触发类型无效");
    }
    const orderId = optionalPositiveInt(query.orderId, "订单ID");
    const afterId = optionalPositiveInt(query.afterId, "游标");
    const limit = query.limit === undefined ? 20 : positiveInt(query.limit, "每页数量", 100);
    const conditions: SQL[] = [eq(orderPrintJob.supplierId, actor.supplierId)];
    if (status) conditions.push(eq(orderPrintJob.status, status as OrderPrintJobStatus));
    if (trigger) conditions.push(eq(orderPrintJob.trigger, trigger as OrderPrintTrigger));
    if (orderId) conditions.push(eq(orderPrintJob.orderId, orderId));
    if (afterId) conditions.push(lt(orderPrintJob.id, afterId));
    return withTx(this.container, async (tx) => {
      const rows = await tx.select().from(orderPrintJob)
        .where(and(...conditions)).orderBy(desc(orderPrintJob.id)).limit(limit);
      return {
        list: rows.map(printJobProjection),
        next_cursor: rows.length === limit ? rows.at(-1)?.id ?? null : null,
        summary: await this.summary(actor.supplierId, tx),
      };
    });
  }

  async listActions(jobIdValue: unknown, actor: PrintJobActor) {
    const jobId = positiveInt(jobIdValue, "打印任务ID");
    this.assertActor(actor);
    return withTx(this.container, async (tx) => {
      const job = await tx.select({ id: orderPrintJob.id }).from(orderPrintJob)
        .where(and(eq(orderPrintJob.id, jobId), eq(orderPrintJob.supplierId, actor.supplierId)))
        .limit(1);
      if (!job[0]) throw new NotFoundException("打印任务不存在");
      return tx.select({
        id: orderPrintJobAction.id,
        job_id: orderPrintJobAction.jobId,
        request_key: orderPrintJobAction.requestKey,
        action: orderPrintJobAction.action,
        previous_status: orderPrintJobAction.previousStatus,
        next_status: orderPrintJobAction.nextStatus,
        actor_type: orderPrintJobAction.actorType,
        actor_id: orderPrintJobAction.actorId,
        reason: orderPrintJobAction.reason,
        provider_reference: orderPrintJobAction.providerReference,
        add_time: orderPrintJobAction.addTime,
      }).from(orderPrintJobAction).where(eq(orderPrintJobAction.jobId, jobId))
        .orderBy(desc(orderPrintJobAction.id)).limit(100);
    });
  }

  confirmSent(id: unknown, actor: PrintJobActor, input: PrintJobOperationInput) {
    return this.operate(id, actor, "CONFIRM_SENT", input);
  }

  confirmRetry(id: unknown, actor: PrintJobActor, input: PrintJobOperationInput) {
    return this.operate(id, actor, "CONFIRM_RETRY", input);
  }

  closeWithoutRetry(id: unknown, actor: PrintJobActor, input: PrintJobOperationInput) {
    return this.operate(id, actor, "CLOSE_NO_RETRY", input);
  }

  private assertActor(actor: PrintJobActor): void {
    if (!Number.isSafeInteger(actor.actorId) || actor.actorId <= 0) throw new Error("print actor missing");
    if (!Number.isSafeInteger(actor.supplierId) || actor.supplierId < 0) throw new Error("print owner missing");
    if (actor.actorType === "admin" && actor.supplierId !== 0) throw new Error("admin print scope invalid");
    if (actor.actorType === "supplier" && actor.supplierId <= 0) throw new Error("supplier print scope invalid");
  }

  private async claim(message: OrderPrintJobMessage): Promise<ClaimedPrintJob | ProcessingResult> {
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const rows = await tx.select().from(orderPrintJob)
        .where(eq(orderPrintJob.id, message.printJobId)).limit(1).for("update");
      const row = rows[0];
      if (!row) throw new NotFoundException("打印任务不存在");
      if (row.eventKey !== message.eventKey) throw new ValidateException("Queue 消息与打印账本不匹配");
      if (row.status === "SENT") return "already-sent";
      if (row.status === "UNKNOWN") return "unknown";
      if (row.status === "DEAD") return "dead";
      if (row.status === "CLOSED") return "closed";
      if (row.status === "PROCESSING") {
        if (row.leaseUntil > now) return "busy";
        await tx.update(orderPrintJob).set({
          status: "UNKNOWN",
          leaseToken: "",
          leaseUntil: 0,
          lastError: "provider_result_unknown_after_expired_lease",
          updateTime: now,
        }).where(eq(orderPrintJob.id, row.id));
        return "unknown";
      }
      if (row.status !== "ENQUEUED") return "busy";
      const attemptCount = row.attemptCount + 1;
      await tx.update(orderPrintJob).set({
        status: "PROCESSING",
        attemptCount,
        leaseToken,
        leaseUntil: now + PROVIDER_LEASE_SECONDS,
        updateTime: now,
      }).where(eq(orderPrintJob.id, row.id));
      return {
        id: row.id,
        eventKey: row.eventKey,
        printerId: row.printerId,
        supplierId: row.supplierId,
        provider: row.provider,
        trigger: row.trigger,
        orderId: row.orderId,
        attemptCount,
        leaseToken,
      };
    });
  }

  private async loadReceipt(claim: ClaimedPrintJob) {
    return withTx(this.container, async (tx) => {
      const [printers, orders, carts, config] = await Promise.all([
        tx.select().from(printDocument).where(and(
          eq(printDocument.id, claim.printerId),
          eq(printDocument.supplierId, claim.supplierId),
          eq(printDocument.isDel, 0),
          eq(printDocument.status, 1),
        )).limit(1),
        tx.select().from(storeOrder).where(eq(storeOrder.id, claim.orderId)).limit(1),
        tx.select({
          id: storeOrderCartInfo.id,
          cartNum: storeOrderCartInfo.cartNum,
          cartInfo: storeOrderCartInfo.cartInfo,
        }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, claim.orderId))
          .orderBy(asc(storeOrderCartInfo.id)).limit(500),
        createContainerFromDb(tx).systemConfigDao.getValues(["site_name", "site_url"]),
      ]);
      const printer = printers[0];
      const order = orders[0];
      if (!printer) throw new ReceiptPrinterConfigurationError("打印机已停用、删除或越过租户边界");
      if (!order) throw new ReceiptPrinterConfigurationError("订单已不存在");
      if (claim.supplierId > 0 && order.supplierId !== claim.supplierId) {
        throw new ReceiptPrinterConfigurationError("订单已越过打印任务的供应商边界");
      }
      if (providerFor(printer) !== claim.provider) {
        throw new ReceiptPrinterConfigurationError("打印任务创建后打印平台已变更");
      }
      if (claim.trigger === "paid" && order.paid !== 1) {
        throw new ReceiptPrinterConfigurationError("支付后打印任务对应订单尚未支付");
      }
      return {
        order,
        carts,
        printer,
        trigger: claim.trigger,
        siteName: config.site_name || "CinaShop",
        siteUrl: config.site_url || "",
        printedAt: Math.floor(Date.now() / 1_000),
      };
    });
  }

  private async finalize(
    claim: ClaimedPrintJob,
    status: "SENT" | "RETRYABLE" | "UNKNOWN" | "DEAD",
    result: ProviderResult | undefined,
    lastError: string,
    contentHash: string,
    now: number,
    availableTime = 0,
  ): Promise<void> {
    const updated = await withTx(this.container, (tx) => tx.update(orderPrintJob).set({
      status,
      availableTime,
      leaseToken: "",
      leaseUntil: 0,
      providerReference: result?.providerReference ?? "",
      providerRequestId: result?.requestId ?? "",
      responseCode: result?.responseCode ?? "",
      contentHash,
      lastError: lastError.slice(0, 1_000),
      sentTime: status === "SENT" ? now : 0,
      updateTime: now,
    }).where(and(
      eq(orderPrintJob.id, claim.id),
      eq(orderPrintJob.status, "PROCESSING"),
      eq(orderPrintJob.leaseToken, claim.leaseToken),
    )).returning({ id: orderPrintJob.id }));
    if (!updated[0]) throw new Error("打印任务提供商租约已失效");
  }

  private async markExpiredProviderCallsUnknown(
    now: number,
    eventKey?: string,
    jobIds?: readonly number[],
  ): Promise<number> {
    const conditions: SQL[] = [eq(orderPrintJob.status, "PROCESSING"), lte(orderPrintJob.leaseUntil, now)];
    if (eventKey) conditions.push(eq(orderPrintJob.eventKey, eventKey));
    if (jobIds?.length) conditions.push(inArray(orderPrintJob.id, [...jobIds]));
    const rows = await withTx(this.container, (tx) => tx.update(orderPrintJob).set({
      status: "UNKNOWN",
      leaseToken: "",
      leaseUntil: 0,
      lastError: "provider_result_unknown_after_expired_lease",
      updateTime: now,
    }).where(and(...conditions)).returning({ id: orderPrintJob.id }));
    return rows.length;
  }

  private async summary(supplierId: number, db: DbClient = this.container.db) {
    const rows = await db.select({
      pending: sql<number>`count(*) FILTER (WHERE ${orderPrintJob.status} IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'))::int`,
      sent: sql<number>`count(*) FILTER (WHERE ${orderPrintJob.status} = 'SENT')::int`,
      unknown: sql<number>`count(*) FILTER (WHERE ${orderPrintJob.status} = 'UNKNOWN')::int`,
      dead: sql<number>`count(*) FILTER (WHERE ${orderPrintJob.status} = 'DEAD')::int`,
      closed: sql<number>`count(*) FILTER (WHERE ${orderPrintJob.status} = 'CLOSED')::int`,
    }).from(orderPrintJob).where(eq(orderPrintJob.supplierId, supplierId));
    return rows[0] ?? { pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 };
  }

  private async operate(
    idValue: unknown,
    actor: PrintJobActor,
    action: OrderPrintJobActionType,
    input: PrintJobOperationInput,
    now = Math.floor(Date.now() / 1_000),
  ) {
    const id = positiveInt(idValue, "打印任务ID");
    this.assertActor(actor);
    const key = requestKey(input.requestKey);
    const reason = boundedText(input.reason, "操作原因", 500, 8);
    const providerReference = input.providerReference === undefined
      ? ""
      : boundedText(input.providerReference, "提供商引用", 255);
    const result = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`print-operation:${key}`}))`);
      const current = await tx.select().from(orderPrintJob).where(and(
        eq(orderPrintJob.id, id), eq(orderPrintJob.supplierId, actor.supplierId),
      )).limit(1);
      if (!current[0]) throw new NotFoundException("打印任务不存在");
      const effectiveReference = providerReference || current[0].providerReference;
      const prior = await tx.select().from(orderPrintJobAction)
        .where(eq(orderPrintJobAction.requestKey, key)).limit(1);
      if (prior[0]) {
        if (
          prior[0].jobId !== id || prior[0].action !== action ||
          prior[0].actorType !== actor.actorType || prior[0].actorId !== actor.actorId ||
          prior[0].supplierId !== actor.supplierId || prior[0].reason !== reason ||
          prior[0].providerReference !== effectiveReference
        ) throw new ValidateException("操作请求键已被不同内容使用");
        return { duplicate: true, job: printJobProjection(current[0]) };
      }

      const rows = await tx.select().from(orderPrintJob).where(and(
        eq(orderPrintJob.id, id), eq(orderPrintJob.supplierId, actor.supplierId),
      )).limit(1).for("update");
      const row = rows[0];
      if (!row) throw new NotFoundException("打印任务不存在");
      let nextStatus: OrderPrintJobStatus;
      let values: Partial<typeof orderPrintJob.$inferInsert>;
      if (action === "CONFIRM_SENT") {
        if (row.status !== "UNKNOWN") throw new ValidateException("只有结果未知的打印任务可确认已发送");
        nextStatus = "SENT";
        values = {
          status: nextStatus,
          providerReference: effectiveReference,
          responseCode: "OPERATOR_CONFIRMED_SENT",
          lastError: "",
          availableTime: 0,
          leaseUntil: 0,
          leaseToken: "",
          sentTime: now,
          updateTime: now,
        };
      } else if (action === "CONFIRM_RETRY") {
        if (row.status !== "UNKNOWN" && row.status !== "DEAD") {
          throw new ValidateException("只有结果未知或明确失败的打印任务可确认重发");
        }
        if (row.replayCount >= MAX_MANUAL_REPLAYS) throw new ValidateException("已达到最大人工重发次数");
        nextStatus = "RETRYABLE";
        values = {
          status: nextStatus,
          replayCount: row.replayCount + 1,
          availableTime: now,
          leaseUntil: 0,
          leaseToken: "",
          lastError: "operator_confirmed_retry",
          responseCode: "OPERATOR_CONFIRMED_RETRY",
          updateTime: now,
        };
      } else {
        if (row.status !== "UNKNOWN") throw new ValidateException("只有结果未知的打印任务可关闭而不重发");
        nextStatus = "CLOSED";
        values = {
          status: nextStatus,
          availableTime: 0,
          leaseUntil: 0,
          leaseToken: "",
          lastError: "operator_closed_without_retry",
          responseCode: "OPERATOR_CLOSED_NO_RETRY",
          updateTime: now,
        };
      }
      const updated = await tx.update(orderPrintJob).set(values).where(and(
        eq(orderPrintJob.id, id), eq(orderPrintJob.status, row.status),
      )).returning();
      if (!updated[0]) throw new Error("打印任务状态已变化");
      await tx.insert(orderPrintJobAction).values({
        jobId: id,
        requestKey: key,
        action,
        previousStatus: row.status,
        nextStatus,
        actorType: actor.actorType,
        actorId: actor.actorId,
        supplierId: actor.supplierId,
        reason,
        providerReference: effectiveReference,
        addTime: now,
      });
      return { duplicate: false, job: printJobProjection(updated[0]) };
    });
    if (action === "CONFIRM_RETRY" && !result.duplicate) {
      try {
        await this.dispatchPending(1, result.job.event_key);
      } catch {
        // Scheduled dispatch remains authoritative.
      }
    }
    return result;
  }
}

export async function consumeOrderPrintJobMessage(
  message: Pick<Message<OrderMessage>, "body" | "attempts" | "ack" | "retry">,
  service: ReceiptPrintJobService,
): Promise<void> {
  if (!isOrderPrintJobMessage(message.body)) throw new Error("Queue message is not a print job");
  const body = message.body;
  const startedAt = Date.now();
  try {
    const result = await service.processMessage(body);
    if (result === "busy") {
      emitOperationalEvent("warn", {
        event: "order_print_job_retried",
        component: "print",
        operation: "queue_consume",
        outcome: "retry",
        result,
        durationMs: Date.now() - startedAt,
        queueAttempt: message.attempts,
      });
      message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 300) });
      return;
    }
    emitOperationalEvent(result === "unknown" || result === "dead" ? "error" : "info", {
      event: "order_print_job_consumed",
      component: "print",
      operation: "queue_consume",
      outcome: result === "unknown" ? "unknown" : result === "dead" ? "failure" : "success",
      result,
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    emitOperationalEvent("error", {
      event: "order_print_job_failed",
      component: "print",
      operation: "queue_consume",
      outcome: "failure",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      errorCode: operationalErrorCode(error),
    });
    message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 300) });
  }
}
