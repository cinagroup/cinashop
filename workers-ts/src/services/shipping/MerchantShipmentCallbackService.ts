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
  Env,
  MerchantShipmentCallbackDispatchMessage,
  MerchantShipmentCallbackOutboxMessage,
  OrderMessage,
} from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  expressCompany,
  merchantShipmentCallbackEvent,
  merchantShipmentCallbackOutbox,
  merchantShipmentCallbackWatermark,
  storeOrder,
  storeOrderStatus,
  type MerchantShipmentCallbackEvent,
} from "@/models/schema";
import { SupplierFulfillmentService } from "@/services/supplier/SupplierFulfillmentService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import {
  kuaidi100TaskSubjectHash,
  merchantShipmentState,
  verifyKuaidi100MerchantShipmentCallback,
  type MerchantShipmentStateSpec,
  type VerifiedKuaidi100MerchantShipmentCallback,
} from "./Kuaidi100MerchantShipmentCallback";

const DISPATCH_LEASE_SECONDS = 120;
const PROCESS_LEASE_SECONDS = 180;
const MAX_ATTEMPTS = 8;
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMPLETED_EVENT_STATUSES = [
  "APPLIED", "APPLIED_NOOP", "SUPERSEDED", "IGNORED", "CONFLICT", "DEAD",
] as const;

interface ReceiveResult {
  eventId: number;
  outboxId: number;
  replayKey: string;
  duplicate: boolean;
}

interface ClaimedCallback {
  event: MerchantShipmentCallbackEvent;
  outboxId: number;
  leaseToken: string;
  attemptCount: number;
}

interface WatermarkSnapshot {
  lastState: string;
  lastRank: number;
  terminal: number;
}

type TransitionDecision = "apply" | "noop" | "superseded" | "conflict" | "ignored";
type ProcessResult =
  | "completed"
  | "already-completed"
  | "busy"
  | "dead"
  | "conflict"
  | { kind: "deferred"; delaySeconds: number };

class MerchantShipmentProjectionConflict extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function retryDelay(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, Math.min(attempt, MAX_ATTEMPTS) - 1), 3600);
}

function errorCode(error: unknown): string {
  const candidate = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]{1,64}$/i.test(candidate)
    ? candidate.toLowerCase()
    : "merchant_shipment_callback_processing_failed";
}

function callbackMessage(input: {
  outboxId: number;
  eventId: number;
  replayKey: string;
}): MerchantShipmentCallbackOutboxMessage {
  return { action: "processMerchantShipmentCallbackOutbox", ...input };
}

export function isMerchantShipmentCallbackOutboxMessage(
  value: unknown,
): value is MerchantShipmentCallbackOutboxMessage {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 4
    && value.action === "processMerchantShipmentCallbackOutbox"
    && Number.isSafeInteger(value.outboxId) && Number(value.outboxId) > 0
    && Number.isSafeInteger(value.eventId) && Number(value.eventId) > 0
    && typeof value.replayKey === "string" && UUID_V4.test(value.replayKey);
}

export function isMerchantShipmentCallbackDispatchMessage(
  value: unknown,
): value is MerchantShipmentCallbackDispatchMessage {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.action === "dispatchMerchantShipmentCallbackOutbox"
    && Number.isSafeInteger(value.scheduledAt)
    && Number(value.scheduledAt) > 0;
}

/** Explicit graph for a provider contract that has no event timestamp or sequence. */
export function merchantShipmentTransition(
  current: WatermarkSnapshot | undefined,
  next: MerchantShipmentStateSpec,
): TransitionDecision {
  if (next.projectionType === "ignored") return "ignored";
  if (next.projectionType === "metadata") return "apply";
  if (!current) return next.state === "RESURRECTED" ? "conflict" : "apply";
  if (current.lastState === next.state) return "noop";

  const currentTerminal = current.terminal === 1;
  if (currentTerminal) {
    if (next.state === "RESURRECTED") return "apply";
    if (next.terminal) {
      return next.state === "CANCELLED" && current.lastState !== "CANCELLED"
        ? "apply"
        : "superseded";
    }
    return "conflict";
  }

  if (next.state === "RESURRECTED") return "superseded";
  if (next.terminal) return current.lastRank >= 40 ? "superseded" : "apply";
  if (next.rank < current.lastRank) return "superseded";
  if (next.rank === current.lastRank) return "apply";
  return "apply";
}

function stateSpec(event: MerchantShipmentCallbackEvent): MerchantShipmentStateSpec {
  return merchantShipmentState(event.orderStatus);
}

function reassignmentPayload(event: MerchantShipmentCallbackEvent): {
  taskId: string;
  carrierCode: string;
  trackingNumber: string;
} {
  const reassignment = isRecord(event.payload) && isRecord(event.payload.reassignment)
    ? event.payload.reassignment
    : undefined;
  const taskId = typeof reassignment?.taskId === "string" ? reassignment.taskId : "";
  const carrierCode = typeof reassignment?.carrierCode === "string" ? reassignment.carrierCode : "";
  const trackingNumber = typeof reassignment?.trackingNumber === "string" ? reassignment.trackingNumber : "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(taskId)
    || !/^[a-z0-9_-]{1,50}$/.test(carrierCode)
    || [...trackingNumber].length > 64
    || /[\u0000-\u001f\u007f]/.test(trackingNumber)) {
    throw new MerchantShipmentProjectionConflict("merchant_shipment_reassignment_invalid");
  }
  return { taskId, carrierCode, trackingNumber };
}

async function upsertWatermark(
  tx: DbClient,
  event: MerchantShipmentCallbackEvent,
  spec: MerchantShipmentStateSpec,
  now: number,
  subjectKeyHash = event.subjectKeyHash,
): Promise<void> {
  await tx.insert(merchantShipmentCallbackWatermark).values({
    provider: "kuaidi100",
    projectionType: spec.projectionType,
    subjectKeyHash,
    lastEventId: event.id,
    lastEventKey: event.eventKey,
    lastState: spec.state,
    lastRank: spec.rank,
    terminal: spec.terminal ? 1 : 0,
    updateTime: now,
  }).onConflictDoUpdate({
    target: [
      merchantShipmentCallbackWatermark.provider,
      merchantShipmentCallbackWatermark.projectionType,
      merchantShipmentCallbackWatermark.subjectKeyHash,
    ],
    set: {
      lastEventId: event.id,
      lastEventKey: event.eventKey,
      lastState: spec.state,
      lastRank: spec.rank,
      terminal: spec.terminal ? 1 : 0,
      updateTime: now,
    },
  });
}

async function finishClaim(
  container: Container,
  claim: ClaimedCallback,
  status: "APPLIED" | "APPLIED_NOOP" | "SUPERSEDED" | "IGNORED" | "CONFLICT" | "DEAD",
  now: number,
  lastErrorCode = "",
): Promise<void> {
  await withTx(container, async (tx) => {
    const outbox = await tx.update(merchantShipmentCallbackOutbox).set({
      status: status === "DEAD" || status === "CONFLICT" ? "DEAD" : "COMPLETED",
      leaseUntil: 0,
      leaseToken: "",
      lastErrorCode,
      processedTime: now,
      updateTime: now,
    }).where(and(
      eq(merchantShipmentCallbackOutbox.id, claim.outboxId),
      eq(merchantShipmentCallbackOutbox.status, "PROCESSING"),
      eq(merchantShipmentCallbackOutbox.leaseToken, claim.leaseToken),
    )).returning({ id: merchantShipmentCallbackOutbox.id });
    const event = await tx.update(merchantShipmentCallbackEvent).set({
      status,
      leaseUntil: 0,
      leaseToken: "",
      lastErrorCode,
      processedTime: now,
      updateTime: now,
    }).where(and(
      eq(merchantShipmentCallbackEvent.id, claim.event.id),
      eq(merchantShipmentCallbackEvent.status, "PROCESSING"),
      eq(merchantShipmentCallbackEvent.leaseToken, claim.leaseToken),
    )).returning({ id: merchantShipmentCallbackEvent.id });
    if (!outbox[0] || !event[0]) throw new Error("merchant_shipment_callback_lease_lost");
  });
}

export class MerchantShipmentCallbackService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  verify(rawBody: string): VerifiedKuaidi100MerchantShipmentCallback {
    return verifyKuaidi100MerchantShipmentCallback(
      rawBody,
      this.env.KUAIDI100_CALLBACK_SALT,
    );
  }

  async receive(
    callback: VerifiedKuaidi100MerchantShipmentCallback,
    now = Math.floor(Date.now() / 1_000),
  ): Promise<ReceiveResult> {
    const replayKey = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`merchant-shipment-receive:${callback.eventKey}`}))`);
      const inserted = await tx.insert(merchantShipmentCallbackEvent).values({
        provider: callback.provider,
        eventKey: callback.eventKey,
        replayKey,
        payloadHash: callback.payloadHash,
        subjectKeyHash: callback.subjectKeyHash,
        taskId: callback.taskId,
        providerOrderId: callback.providerOrderId,
        carrierCode: callback.carrierCode,
        trackingNumber: callback.trackingNumber,
        callbackStatus: callback.callbackStatus,
        orderStatus: callback.orderStatus,
        payload: callback.payload,
        status: "RECEIVED",
        receivedTime: now,
        retainUntil: now + RETENTION_SECONDS,
        updateTime: now,
      }).onConflictDoNothing({
        target: [merchantShipmentCallbackEvent.provider, merchantShipmentCallbackEvent.eventKey],
      }).returning({ id: merchantShipmentCallbackEvent.id });
      const events = await tx.select().from(merchantShipmentCallbackEvent).where(and(
        eq(merchantShipmentCallbackEvent.provider, callback.provider),
        eq(merchantShipmentCallbackEvent.eventKey, callback.eventKey),
      )).limit(1);
      const event = events[0];
      if (!event) throw new Error("merchant_shipment_callback_event_missing");
      if (
        event.payloadHash !== callback.payloadHash
        || event.subjectKeyHash !== callback.subjectKeyHash
        || event.taskId !== callback.taskId
        || event.providerOrderId !== callback.providerOrderId
        || event.carrierCode !== callback.carrierCode
        || event.trackingNumber !== callback.trackingNumber
        || event.callbackStatus !== callback.callbackStatus
        || event.orderStatus !== callback.orderStatus
      ) throw new Error("merchant_shipment_callback_event_conflict");

      await tx.insert(merchantShipmentCallbackOutbox).values({
        eventId: event.id,
        replayKey: event.replayKey,
        status: "PENDING",
        availableTime: now,
        addTime: now,
        updateTime: now,
      }).onConflictDoNothing({ target: merchantShipmentCallbackOutbox.eventId });
      const outboxes = await tx.select({
        id: merchantShipmentCallbackOutbox.id,
        replayKey: merchantShipmentCallbackOutbox.replayKey,
      }).from(merchantShipmentCallbackOutbox)
        .where(eq(merchantShipmentCallbackOutbox.eventId, event.id)).limit(1);
      if (!outboxes[0] || outboxes[0].replayKey !== event.replayKey) {
        throw new Error("merchant_shipment_callback_outbox_conflict");
      }
      return {
        eventId: event.id,
        outboxId: outboxes[0].id,
        replayKey: event.replayKey,
        duplicate: inserted.length === 0,
      };
    });
  }

  async dispatchById(outboxId: number) {
    return this.dispatchPending(1, outboxId);
  }

  async dispatchPending(limit = 100, onlyOutboxId?: number) {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    const eligible = or(
      and(
        inArray(merchantShipmentCallbackOutbox.status, ["PENDING", "FAILED"]),
        lte(merchantShipmentCallbackOutbox.availableTime, now),
      ),
      and(
        inArray(merchantShipmentCallbackOutbox.status, ["ENQUEUING", "ENQUEUED", "PROCESSING"]),
        lte(merchantShipmentCallbackOutbox.leaseUntil, now),
      ),
    )!;
    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        outboxId: merchantShipmentCallbackOutbox.id,
        eventId: merchantShipmentCallbackOutbox.eventId,
        replayKey: merchantShipmentCallbackOutbox.replayKey,
      }).from(merchantShipmentCallbackOutbox)
        .where(onlyOutboxId
          ? and(eq(merchantShipmentCallbackOutbox.id, onlyOutboxId), eligible)
          : eligible)
        .orderBy(asc(merchantShipmentCallbackOutbox.id))
        .limit(bounded)
        .for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(merchantShipmentCallbackOutbox).set({
        status: "ENQUEUING",
        dispatchCount: sql`${merchantShipmentCallbackOutbox.dispatchCount} + 1`,
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(inArray(merchantShipmentCallbackOutbox.id, rows.map((row) => row.outboxId)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0 };
    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((row) => ({ body: callbackMessage(row) })));
      await withTx(this.container, (tx) => tx.update(merchantShipmentCallbackOutbox).set({
        status: "ENQUEUED",
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken: "",
        lastErrorCode: "",
        enqueuedTime: now,
        updateTime: now,
      }).where(and(
        inArray(merchantShipmentCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(merchantShipmentCallbackOutbox.status, "ENQUEUING"),
        eq(merchantShipmentCallbackOutbox.leaseToken, leaseToken),
      )));
      return { claimed: claimed.length, enqueued: claimed.length };
    } catch (error) {
      await withTx(this.container, (tx) => tx.update(merchantShipmentCallbackOutbox).set({
        status: "FAILED",
        availableTime: now + retryDelay(1),
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode(error),
        updateTime: now,
      }).where(and(
        inArray(merchantShipmentCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(merchantShipmentCallbackOutbox.status, "ENQUEUING"),
        eq(merchantShipmentCallbackOutbox.leaseToken, leaseToken),
      )));
      throw error;
    }
  }

  private async claim(message: MerchantShipmentCallbackOutboxMessage): Promise<ClaimedCallback | ProcessResult> {
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const outboxes = await tx.select().from(merchantShipmentCallbackOutbox)
        .where(eq(merchantShipmentCallbackOutbox.id, message.outboxId)).limit(1).for("update");
      const outbox = outboxes[0];
      const events = await tx.select().from(merchantShipmentCallbackEvent)
        .where(eq(merchantShipmentCallbackEvent.id, message.eventId)).limit(1).for("update");
      const event = events[0];
      if (!outbox || !event || outbox.eventId !== event.id
        || outbox.replayKey !== message.replayKey || event.replayKey !== message.replayKey) {
        throw new Error("merchant_shipment_callback_message_mismatch");
      }
      if ((COMPLETED_EVENT_STATUSES as readonly string[]).includes(event.status)) {
        return event.status === "DEAD" ? "dead"
          : event.status === "CONFLICT" ? "conflict"
            : "already-completed";
      }
      if (event.status === "PROCESSING" && event.leaseUntil > now) return "busy";
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`merchant-shipment-subject:${event.subjectKeyHash}`}))`);
      const active = await tx.select({ id: merchantShipmentCallbackEvent.id })
        .from(merchantShipmentCallbackEvent).where(and(
          eq(merchantShipmentCallbackEvent.provider, event.provider),
          eq(merchantShipmentCallbackEvent.subjectKeyHash, event.subjectKeyHash),
          eq(merchantShipmentCallbackEvent.status, "PROCESSING"),
          sql`${merchantShipmentCallbackEvent.id} <> ${event.id}`,
          sql`${merchantShipmentCallbackEvent.leaseUntil} > ${now}`,
        )).limit(1);
      if (active[0]) return { kind: "deferred", delaySeconds: 15 };
      const attemptCount = event.attemptCount + 1;
      if (attemptCount > MAX_ATTEMPTS) {
        await tx.update(merchantShipmentCallbackOutbox).set({
          status: "DEAD", attemptCount, leaseUntil: 0, leaseToken: "",
          lastErrorCode: "merchant_shipment_callback_attempts_exhausted", processedTime: now, updateTime: now,
        }).where(eq(merchantShipmentCallbackOutbox.id, outbox.id));
        await tx.update(merchantShipmentCallbackEvent).set({
          status: "DEAD", attemptCount, leaseUntil: 0, leaseToken: "",
          lastErrorCode: "merchant_shipment_callback_attempts_exhausted", processedTime: now, updateTime: now,
        }).where(eq(merchantShipmentCallbackEvent.id, event.id));
        return "dead";
      }
      await tx.update(merchantShipmentCallbackOutbox).set({
        status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken, updateTime: now,
      }).where(eq(merchantShipmentCallbackOutbox.id, outbox.id));
      await tx.update(merchantShipmentCallbackEvent).set({
        status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken, updateTime: now,
      }).where(eq(merchantShipmentCallbackEvent.id, event.id));
      return { event: { ...event, status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS, leaseToken }, outboxId: outbox.id, leaseToken, attemptCount };
    });
  }

  private async project(claim: ClaimedCallback): Promise<"APPLIED" | "APPLIED_NOOP" | "SUPERSEDED" | "IGNORED"> {
    const now = Math.floor(Date.now() / 1_000);
    const spec = stateSpec(claim.event);
    const prepared = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`merchant-shipment-subject:${claim.event.subjectKeyHash}`}))`);
      const watermarks = await tx.select().from(merchantShipmentCallbackWatermark).where(and(
        eq(merchantShipmentCallbackWatermark.provider, "kuaidi100"),
        eq(merchantShipmentCallbackWatermark.projectionType, spec.projectionType),
        eq(merchantShipmentCallbackWatermark.subjectKeyHash, claim.event.subjectKeyHash),
      )).limit(1).for("update");
      const decision = merchantShipmentTransition(watermarks[0], spec);
      if (decision === "ignored") {
        await upsertWatermark(tx, claim.event, spec, now);
        return { terminalStatus: "IGNORED" as const };
      }
      if (decision === "noop") return { terminalStatus: "APPLIED_NOOP" as const };
      if (decision === "superseded") return { terminalStatus: "SUPERSEDED" as const };
      if (decision === "conflict") throw new MerchantShipmentProjectionConflict("merchant_shipment_state_conflict");

      const orders = await tx.select().from(storeOrder).where(and(
        eq(storeOrder.kuaidiTaskId, claim.event.taskId),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      )).orderBy(asc(storeOrder.id)).limit(2).for("update");
      if (orders.length === 0) throw new Error("merchant_shipment_order_unmatched");
      if (orders.length > 1) throw new MerchantShipmentProjectionConflict("merchant_shipment_task_ambiguous");
      const order = orders[0];
      if (order.paid !== 1) throw new MerchantShipmentProjectionConflict("merchant_shipment_order_unpaid");
      if (spec.terminal && !spec.fulfilsOrder && order.status >= 1) {
        return { terminalStatus: "SUPERSEDED" as const };
      }
      if (order.status < 0) throw new MerchantShipmentProjectionConflict("merchant_shipment_order_terminal");

      if (spec.state === "REASSIGNED") {
        if (order.status >= 1) return { terminalStatus: "SUPERSEDED" as const };
        const reassignment = reassignmentPayload(claim.event);
        if (reassignment.taskId === claim.event.taskId) {
          throw new MerchantShipmentProjectionConflict("merchant_shipment_reassignment_same_task");
        }
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`merchant-shipment-reassigned-task:${reassignment.taskId}`}))`);
        const conflicts = await tx.select({ id: storeOrder.id }).from(storeOrder).where(and(
          eq(storeOrder.kuaidiTaskId, reassignment.taskId),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
          sql`${storeOrder.id} <> ${order.id}`,
        )).limit(1).for("update");
        if (conflicts[0]) {
          throw new MerchantShipmentProjectionConflict("merchant_shipment_reassigned_task_ambiguous");
        }
        await tx.update(storeOrder).set({
          kuaidiTaskId: reassignment.taskId,
          deliveryCode: reassignment.carrierCode,
          ...(reassignment.trackingNumber ? { deliveryId: reassignment.trackingNumber } : {}),
          isStockUp: 1,
        }).where(eq(storeOrder.id, order.id));
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "merchant_shipment_state",
          changeMessage: "商家寄件状态：REASSIGNED",
          changeTime: now,
        });
        await upsertWatermark(tx, claim.event, spec, now);
        await upsertWatermark(
          tx,
          claim.event,
          spec,
          now,
          kuaidi100TaskSubjectHash(reassignment.taskId),
        );
        return { terminalStatus: "APPLIED" as const };
      }

      const metadata = {
        ...(claim.event.carrierCode ? { deliveryCode: claim.event.carrierCode } : {}),
        ...(claim.event.trackingNumber ? { deliveryId: claim.event.trackingNumber } : {}),
      };
      if (spec.fulfilsOrder && order.status === 0) {
        const carriers = await tx.select({ name: expressCompany.name }).from(expressCompany)
          .where(eq(expressCompany.code, claim.event.carrierCode)).orderBy(asc(expressCompany.id)).limit(1);
        return {
          order,
          deliveryName: (carriers[0]?.name || claim.event.carrierCode).slice(0, 64),
          terminalStatus: undefined,
        };
      }
      if (spec.fulfilsOrder && order.status >= 1) {
        if (order.deliveryId && order.deliveryId !== claim.event.trackingNumber) {
          throw new MerchantShipmentProjectionConflict("merchant_shipment_tracking_conflict");
        }
        await tx.update(storeOrder).set({ ...metadata, isStockUp: 0 })
          .where(eq(storeOrder.id, order.id));
        await upsertWatermark(tx, claim.event, spec, now);
        return { terminalStatus: "APPLIED_NOOP" as const };
      }

      await tx.update(storeOrder).set({
        ...metadata,
        ...(spec.projectionType === "order_state" ? { isStockUp: spec.terminal ? 0 : 1 } : {}),
      }).where(eq(storeOrder.id, order.id));
      if (spec.projectionType === "order_state") {
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "merchant_shipment_state",
          changeMessage: `商家寄件状态：${spec.state}`,
          changeTime: now,
        });
      }
      await upsertWatermark(tx, claim.event, spec, now);
      return { terminalStatus: "APPLIED" as const };
    });

    if (prepared.terminalStatus) return prepared.terminalStatus;
    const order = prepared.order;
    await new SupplierFulfillmentService(this.container, this.env).deliver(
      order.supplierId,
      order.id,
      {
        deliveryType: "express",
        deliveryName: prepared.deliveryName,
        deliveryCode: claim.event.carrierCode,
        deliveryId: claim.event.trackingNumber,
        fictitiousContent: "",
        deliveryUid: 0,
      },
      {
        replay: {
          accountId: claim.event.id,
          requestHash: claim.event.payloadHash,
          changeType: "merchant_shipment_delivery",
        },
        authorize: async (tx, scope) => {
          const rows = await tx.select({ taskId: storeOrder.kuaidiTaskId }).from(storeOrder)
            .where(eq(storeOrder.id, scope.requestedOrderId)).limit(1).for("key share");
          if (rows[0]?.taskId !== claim.event.taskId) {
            throw new MerchantShipmentProjectionConflict("merchant_shipment_task_changed");
          }
        },
      },
    );
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`merchant-shipment-subject:${claim.event.subjectKeyHash}`}))`);
      await tx.update(storeOrder).set({ isStockUp: 0 }).where(and(
        eq(storeOrder.kuaidiTaskId, claim.event.taskId),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ));
      await upsertWatermark(tx, claim.event, spec, now);
    });
    return "APPLIED";
  }

  private async fail(claim: ClaimedCallback, error: unknown): Promise<"dead" | { kind: "deferred"; delaySeconds: number }> {
    const now = Math.floor(Date.now() / 1_000);
    const dead = claim.attemptCount >= MAX_ATTEMPTS;
    const code = errorCode(error);
    const delaySeconds = retryDelay(claim.attemptCount);
    await withTx(this.container, async (tx) => {
      await tx.update(merchantShipmentCallbackOutbox).set({
        status: dead ? "DEAD" : "FAILED",
        availableTime: dead ? 0 : now + delaySeconds,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        processedTime: dead ? now : 0,
        updateTime: now,
      }).where(and(
        eq(merchantShipmentCallbackOutbox.id, claim.outboxId),
        eq(merchantShipmentCallbackOutbox.status, "PROCESSING"),
        eq(merchantShipmentCallbackOutbox.leaseToken, claim.leaseToken),
      ));
      await tx.update(merchantShipmentCallbackEvent).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        processedTime: dead ? now : 0,
        updateTime: now,
      }).where(and(
        eq(merchantShipmentCallbackEvent.id, claim.event.id),
        eq(merchantShipmentCallbackEvent.status, "PROCESSING"),
        eq(merchantShipmentCallbackEvent.leaseToken, claim.leaseToken),
      ));
    });
    return dead ? "dead" : { kind: "deferred", delaySeconds };
  }

  async processMessage(message: MerchantShipmentCallbackOutboxMessage): Promise<ProcessResult> {
    const claim = await this.claim(message);
    if (!(typeof claim === "object" && "event" in claim)) return claim;
    try {
      const status = await this.project(claim);
      await finishClaim(this.container, claim, status, Math.floor(Date.now() / 1_000));
      return "completed";
    } catch (error) {
      if (error instanceof MerchantShipmentProjectionConflict) {
        await finishClaim(
          this.container,
          claim,
          "CONFLICT",
          Math.floor(Date.now() / 1_000),
          errorCode(error),
        );
        return "conflict";
      }
      return this.fail(claim, error);
    }
  }
}

export async function consumeMerchantShipmentCallbackMessage(
  message: Pick<Message<OrderMessage>, "body" | "attempts" | "ack" | "retry">,
  service: MerchantShipmentCallbackService,
): Promise<void> {
  if (!isMerchantShipmentCallbackOutboxMessage(message.body)) {
    throw new Error("Queue message is not a merchant shipment callback");
  }
  const startedAt = Date.now();
  try {
    const result = await service.processMessage(message.body);
    if (result === "busy") {
      message.retry({ delaySeconds: 15 });
      return;
    }
    if (typeof result === "object") {
      message.retry({ delaySeconds: result.delaySeconds });
      return;
    }
    emitOperationalEvent(result === "dead" || result === "conflict" ? "error" : "info", {
      event: result === "conflict"
        ? "merchant_shipment_callback_conflict"
        : result === "dead"
          ? "merchant_shipment_callback_dead"
          : "merchant_shipment_callback_consumed",
      component: "waybill",
      operation: "merchant_shipment_callback",
      outcome: result === "dead" || result === "conflict" ? "failure" : "success",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    const delaySeconds = Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 900);
    emitOperationalEvent("error", {
      event: "merchant_shipment_callback_failed",
      component: "waybill",
      operation: "merchant_shipment_callback",
      outcome: "retry",
      durationMs: Date.now() - startedAt,
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error, "merchant_shipment_callback_failed"),
    });
    message.retry({ delaySeconds });
  }
}
