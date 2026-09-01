import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type {
  CityDeliveryCallbackDispatchMessage,
  CityDeliveryCallbackOutboxMessage,
  Env,
  OrderMessage,
} from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  cityDeliveryCallbackEvent,
  cityDeliveryCallbackOutbox,
  cityDeliveryCallbackWatermark,
  cityDeliveryReconciliationCase,
  storeDeliveryOrder,
  storeOrder,
  storeOrderStatus,
  type CityDeliveryCallbackEvent,
  type CityDeliveryReconciliationCase,
} from "@/models/schema";
import { completeOrderReceipt } from "@/services/order/OrderBrokerageService";
import { emitOperationalEvent, operationalErrorCode } from "@/utils/observability";
import {
  cityDeliveryTransition,
  cityDeliverySubjectHash,
  dadaCityDeliveryState,
  verifyDadaCityDeliveryCallback,
  type CityDeliveryStateSpec,
  type CityDeliveryProvider,
  type VerifiedCityDeliveryEvent,
} from "./DadaCityDeliveryCallback";
import { DadaCityDeliveryProvider } from "./DadaCityDeliveryProvider";
import {
  uuCityDeliveryState,
  verifyUuCityDeliveryCallback,
} from "./UuCityDeliveryCallback";
import { UuCityDeliveryProvider } from "./UuCityDeliveryProvider";

const DISPATCH_LEASE_SECONDS = 120;
const PROCESS_LEASE_SECONDS = 180;
const QUERY_LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 8;
const RETENTION_SECONDS = 400 * 24 * 60 * 60;
const ACTIVE_QUERY_INTERVAL_SECONDS = 10 * 60;
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
  event: CityDeliveryCallbackEvent;
  outboxId: number;
  leaseToken: string;
  attemptCount: number;
}

type ProjectionResult = "APPLIED" | "APPLIED_NOOP" | "SUPERSEDED" | "IGNORED";
type ProcessResult =
  | "completed"
  | "already-completed"
  | "busy"
  | "dead"
  | "conflict"
  | { kind: "deferred"; delaySeconds: number };

class CityDeliveryProjectionConflict extends Error {}

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
    : "city_delivery_callback_processing_failed";
}

function callbackMessage(input: {
  outboxId: number;
  eventId: number;
  replayKey: string;
}): CityDeliveryCallbackOutboxMessage {
  return { action: "processCityDeliveryCallbackOutbox", ...input };
}

export function isCityDeliveryCallbackOutboxMessage(
  value: unknown,
): value is CityDeliveryCallbackOutboxMessage {
  if (!isRecord(value)) return false;
  return Object.keys(value).length === 4
    && value.action === "processCityDeliveryCallbackOutbox"
    && Number.isSafeInteger(value.outboxId) && Number(value.outboxId) > 0
    && Number.isSafeInteger(value.eventId) && Number(value.eventId) > 0
    && typeof value.replayKey === "string" && UUID_V4.test(value.replayKey);
}

export function isCityDeliveryCallbackDispatchMessage(
  value: unknown,
): value is CityDeliveryCallbackDispatchMessage {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.action === "dispatchCityDeliveryCallbacks"
    && Number.isSafeInteger(value.scheduledAt)
    && Number(value.scheduledAt) > 0;
}

function stateSpec(event: CityDeliveryCallbackEvent): CityDeliveryStateSpec {
  if (event.provider === "dada") return dadaCityDeliveryState(event.providerStatus);
  if (event.provider === "uu") return uuCityDeliveryState(event.providerStatus);
  throw new Error("city_delivery_provider_invalid");
}

async function upsertWatermark(
  tx: DbClient,
  event: CityDeliveryCallbackEvent,
  spec: CityDeliveryStateSpec,
  now: number,
): Promise<void> {
  await tx.insert(cityDeliveryCallbackWatermark).values({
    provider: event.provider,
    subjectKeyHash: event.subjectKeyHash,
    lastEventId: event.id,
    lastEventKey: event.eventKey,
    lastState: spec.state,
    lastRank: spec.rank,
    providerUpdateTime: event.providerUpdateTime,
    terminal: spec.terminal ? 1 : 0,
    updateTime: now,
  }).onConflictDoUpdate({
    target: [cityDeliveryCallbackWatermark.provider, cityDeliveryCallbackWatermark.subjectKeyHash],
    set: {
      lastEventId: event.id,
      lastEventKey: event.eventKey,
      lastState: spec.state,
      lastRank: spec.rank,
      providerUpdateTime: event.providerUpdateTime,
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
    const outbox = await tx.update(cityDeliveryCallbackOutbox).set({
      status: status === "DEAD" || status === "CONFLICT" ? "DEAD" : "COMPLETED",
      leaseUntil: 0,
      leaseToken: "",
      lastErrorCode,
      processedTime: now,
      updateTime: now,
    }).where(and(
      eq(cityDeliveryCallbackOutbox.id, claim.outboxId),
      eq(cityDeliveryCallbackOutbox.status, "PROCESSING"),
      eq(cityDeliveryCallbackOutbox.leaseToken, claim.leaseToken),
    )).returning({ id: cityDeliveryCallbackOutbox.id });
    const event = await tx.update(cityDeliveryCallbackEvent).set({
      status,
      leaseUntil: 0,
      leaseToken: "",
      lastErrorCode,
      processedTime: now,
      updateTime: now,
      finishCode: "",
      riderName: "",
      riderMobile: "",
      reasonText: "",
    }).where(and(
      eq(cityDeliveryCallbackEvent.id, claim.event.id),
      eq(cityDeliveryCallbackEvent.status, "PROCESSING"),
      eq(cityDeliveryCallbackEvent.leaseToken, claim.leaseToken),
    )).returning({ id: cityDeliveryCallbackEvent.id });
    if (!outbox[0] || !event[0]) throw new Error("city_delivery_callback_lease_lost");

    if (["APPLIED", "APPLIED_NOOP"].includes(status)) {
      const spec = stateSpec(claim.event);
      await tx.update(cityDeliveryReconciliationCase).set(spec.terminal ? {
        status: "RESOLVED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "",
        resolvedTime: now,
        updateTime: now,
      } : {
        status: "PENDING",
        attemptCount: 0,
        nextAttemptTime: now + ACTIVE_QUERY_INTERVAL_SECONDS,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: "",
        updateTime: now,
      }).where(and(
        eq(cityDeliveryReconciliationCase.provider, claim.event.provider),
        eq(cityDeliveryReconciliationCase.subjectKeyHash, claim.event.subjectKeyHash),
        inArray(cityDeliveryReconciliationCase.status, ["PENDING", "QUERYING"]),
      ));
    }
  });
}

export class CityDeliveryCallbackService {
  private readonly dadaProvider: DadaCityDeliveryProvider;
  private readonly uuProvider: UuCityDeliveryProvider;

  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {
    this.dadaProvider = new DadaCityDeliveryProvider(env);
    this.uuProvider = new UuCityDeliveryProvider(env);
  }

  verifyDada(rawBody: string, requestToken: string | undefined): VerifiedCityDeliveryEvent<"dada"> {
    return verifyDadaCityDeliveryCallback(rawBody, {
      requestToken,
      callbackToken: this.env.DADA_CALLBACK_TOKEN,
      expectedClientId: this.env.DADA_CLIENT_ID,
    });
  }

  verifyUu(rawBody: string, requestToken: string | undefined): VerifiedCityDeliveryEvent<"uu"> {
    return verifyUuCityDeliveryCallback(rawBody, {
      requestToken,
      callbackToken: this.env.UU_CALLBACK_TOKEN,
      expectedOpenId: this.env.UU_OPEN_ID,
    });
  }

  async receive(
    callback: VerifiedCityDeliveryEvent,
    now = Math.floor(Date.now() / 1_000),
  ): Promise<ReceiveResult> {
    const replayKey = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`city-delivery-receive:${callback.eventKey}`}))`);
      const inserted = await tx.insert(cityDeliveryCallbackEvent).values({
        provider: callback.provider,
        source: callback.source,
        eventKey: callback.eventKey,
        replayKey,
        payloadHash: callback.payloadHash,
        subjectKeyHash: callback.subjectKeyHash,
        clientId: callback.clientId,
        providerOrderId: callback.providerOrderId,
        providerStatus: callback.providerStatus,
        providerUpdateTime: callback.providerUpdateTime,
        repeatReasonType: callback.repeatReasonType,
        cancelFrom: callback.cancelFrom,
        finishCode: callback.finishCode,
        riderName: callback.riderName,
        riderMobile: callback.riderMobile,
        reasonText: callback.reasonText,
        payload: callback.payload,
        status: "RECEIVED",
        receivedTime: now,
        retainUntil: now + RETENTION_SECONDS,
        updateTime: now,
      }).onConflictDoNothing({
        target: [cityDeliveryCallbackEvent.provider, cityDeliveryCallbackEvent.eventKey],
      }).returning({ id: cityDeliveryCallbackEvent.id });
      const events = await tx.select().from(cityDeliveryCallbackEvent).where(and(
        eq(cityDeliveryCallbackEvent.provider, callback.provider),
        eq(cityDeliveryCallbackEvent.eventKey, callback.eventKey),
      )).limit(1);
      const event = events[0];
      if (!event) throw new Error("city_delivery_callback_event_missing");
      if (event.source !== callback.source
        || event.payloadHash !== callback.payloadHash
        || event.subjectKeyHash !== callback.subjectKeyHash
        || event.clientId !== callback.clientId
        || event.providerOrderId !== callback.providerOrderId
        || event.providerStatus !== callback.providerStatus
        || event.providerUpdateTime !== callback.providerUpdateTime
        || event.repeatReasonType !== callback.repeatReasonType
        || event.cancelFrom !== callback.cancelFrom) {
        throw new Error("city_delivery_callback_event_conflict");
      }

      await tx.insert(cityDeliveryCallbackOutbox).values({
        eventId: event.id,
        replayKey: event.replayKey,
        status: "PENDING",
        availableTime: now,
        addTime: now,
        updateTime: now,
      }).onConflictDoNothing({ target: cityDeliveryCallbackOutbox.eventId });
      const outboxes = await tx.select({
        id: cityDeliveryCallbackOutbox.id,
        replayKey: cityDeliveryCallbackOutbox.replayKey,
      }).from(cityDeliveryCallbackOutbox)
        .where(eq(cityDeliveryCallbackOutbox.eventId, event.id)).limit(1);
      if (!outboxes[0] || outboxes[0].replayKey !== event.replayKey) {
        throw new Error("city_delivery_callback_outbox_conflict");
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
        inArray(cityDeliveryCallbackOutbox.status, ["PENDING", "FAILED"]),
        lte(cityDeliveryCallbackOutbox.availableTime, now),
      ),
      and(
        inArray(cityDeliveryCallbackOutbox.status, ["ENQUEUING", "ENQUEUED", "PROCESSING"]),
        lte(cityDeliveryCallbackOutbox.leaseUntil, now),
      ),
    )!;
    const claimed = await withTx(this.container, async (tx) => {
      const rows = await tx.select({
        outboxId: cityDeliveryCallbackOutbox.id,
        eventId: cityDeliveryCallbackOutbox.eventId,
        replayKey: cityDeliveryCallbackOutbox.replayKey,
      }).from(cityDeliveryCallbackOutbox)
        .where(onlyOutboxId
          ? and(eq(cityDeliveryCallbackOutbox.id, onlyOutboxId), eligible)
          : eligible)
        .orderBy(asc(cityDeliveryCallbackOutbox.id))
        .limit(bounded)
        .for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(cityDeliveryCallbackOutbox).set({
        status: "ENQUEUING",
        dispatchCount: sql`${cityDeliveryCallbackOutbox.dispatchCount} + 1`,
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken,
        updateTime: now,
      }).where(inArray(cityDeliveryCallbackOutbox.id, rows.map((row) => row.outboxId)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0 };
    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((row) => ({ body: callbackMessage(row) })));
      await withTx(this.container, (tx) => tx.update(cityDeliveryCallbackOutbox).set({
        status: "ENQUEUED",
        leaseUntil: now + DISPATCH_LEASE_SECONDS,
        leaseToken: "",
        lastErrorCode: "",
        enqueuedTime: now,
        updateTime: now,
      }).where(and(
        inArray(cityDeliveryCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(cityDeliveryCallbackOutbox.status, "ENQUEUING"),
        eq(cityDeliveryCallbackOutbox.leaseToken, leaseToken),
      )));
      return { claimed: claimed.length, enqueued: claimed.length };
    } catch (error) {
      await withTx(this.container, (tx) => tx.update(cityDeliveryCallbackOutbox).set({
        status: "FAILED",
        availableTime: now + retryDelay(1),
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode(error),
        updateTime: now,
      }).where(and(
        inArray(cityDeliveryCallbackOutbox.id, claimed.map((row) => row.outboxId)),
        eq(cityDeliveryCallbackOutbox.status, "ENQUEUING"),
        eq(cityDeliveryCallbackOutbox.leaseToken, leaseToken),
      )));
      throw error;
    }
  }

  private async claim(message: CityDeliveryCallbackOutboxMessage): Promise<ClaimedCallback | ProcessResult> {
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const outboxes = await tx.select().from(cityDeliveryCallbackOutbox)
        .where(eq(cityDeliveryCallbackOutbox.id, message.outboxId)).limit(1).for("update");
      const events = await tx.select().from(cityDeliveryCallbackEvent)
        .where(eq(cityDeliveryCallbackEvent.id, message.eventId)).limit(1).for("update");
      const outbox = outboxes[0];
      const event = events[0];
      if (!outbox || !event || outbox.eventId !== event.id
        || outbox.replayKey !== message.replayKey || event.replayKey !== message.replayKey) {
        throw new Error("city_delivery_callback_message_mismatch");
      }
      if ((COMPLETED_EVENT_STATUSES as readonly string[]).includes(event.status)) {
        return event.status === "DEAD" ? "dead"
          : event.status === "CONFLICT" ? "conflict"
            : "already-completed";
      }
      if (event.status === "PROCESSING" && event.leaseUntil > now) return "busy";
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`city-delivery-subject:${event.subjectKeyHash}`}))`);
      const active = await tx.select({ id: cityDeliveryCallbackEvent.id })
        .from(cityDeliveryCallbackEvent).where(and(
          eq(cityDeliveryCallbackEvent.provider, event.provider),
          eq(cityDeliveryCallbackEvent.subjectKeyHash, event.subjectKeyHash),
          eq(cityDeliveryCallbackEvent.status, "PROCESSING"),
          sql`${cityDeliveryCallbackEvent.id} <> ${event.id}`,
          sql`${cityDeliveryCallbackEvent.leaseUntil} > ${now}`,
        )).limit(1);
      if (active[0]) return { kind: "deferred", delaySeconds: 15 };
      const attemptCount = event.attemptCount + 1;
      if (attemptCount > MAX_ATTEMPTS) {
        await tx.update(cityDeliveryCallbackOutbox).set({
          status: "DEAD", attemptCount, leaseUntil: 0, leaseToken: "",
          lastErrorCode: "city_delivery_callback_attempts_exhausted", processedTime: now, updateTime: now,
        }).where(eq(cityDeliveryCallbackOutbox.id, outbox.id));
        await tx.update(cityDeliveryCallbackEvent).set({
          status: "DEAD", attemptCount, leaseUntil: 0, leaseToken: "",
          lastErrorCode: "city_delivery_callback_attempts_exhausted", processedTime: now, updateTime: now,
          finishCode: "", riderName: "", riderMobile: "", reasonText: "",
        }).where(eq(cityDeliveryCallbackEvent.id, event.id));
        return "dead";
      }
      await tx.update(cityDeliveryCallbackOutbox).set({
        status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken, updateTime: now,
      }).where(eq(cityDeliveryCallbackOutbox.id, outbox.id));
      await tx.update(cityDeliveryCallbackEvent).set({
        status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS,
        leaseToken, updateTime: now,
      }).where(eq(cityDeliveryCallbackEvent.id, event.id));
      return {
        event: { ...event, status: "PROCESSING", attemptCount, leaseUntil: now + PROCESS_LEASE_SECONDS, leaseToken },
        outboxId: outbox.id,
        leaseToken,
        attemptCount,
      };
    });
  }

  private async project(claim: ClaimedCallback): Promise<ProjectionResult> {
    const now = Math.floor(Date.now() / 1_000);
    const spec = stateSpec(claim.event);
    const prepared = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`city-delivery-subject:${claim.event.subjectKeyHash}`}))`);
      const watermarks = await tx.select().from(cityDeliveryCallbackWatermark).where(and(
        eq(cityDeliveryCallbackWatermark.provider, claim.event.provider),
        eq(cityDeliveryCallbackWatermark.subjectKeyHash, claim.event.subjectKeyHash),
      )).limit(1).for("update");
      const current = watermarks[0];
      const decision = cityDeliveryTransition(current, {
        eventKey: claim.event.eventKey,
        source: claim.event.source,
        providerUpdateTime: claim.event.providerUpdateTime,
        repeatReasonType: claim.event.repeatReasonType,
        state: spec,
      });
      if (decision === "ignored") {
        await upsertWatermark(tx, claim.event, spec, now);
        return { terminalStatus: "IGNORED" as const };
      }
      if (decision === "noop") return { terminalStatus: "APPLIED_NOOP" as const };
      if (decision === "superseded") return { terminalStatus: "SUPERSEDED" as const };
      if (decision === "conflict") throw new CityDeliveryProjectionConflict("city_delivery_state_conflict");

      const stationType = claim.event.provider === "dada" ? 1
        : claim.event.provider === "uu" ? 2
          : 0;
      if (!stationType) throw new CityDeliveryProjectionConflict("city_delivery_provider_invalid");
      const deliveries = await tx.select().from(storeDeliveryOrder).where(and(
        eq(storeDeliveryOrder.stationType, stationType),
        eq(storeDeliveryOrder.orderId, claim.event.providerOrderId),
      )).orderBy(asc(storeDeliveryOrder.id)).limit(2).for("update");
      if (deliveries.length === 0) throw new Error("city_delivery_order_unmatched");
      if (deliveries.length > 1) throw new CityDeliveryProjectionConflict("city_delivery_order_ambiguous");
      const delivery = deliveries[0];
      if (cityDeliverySubjectHash(claim.event.provider as CityDeliveryProvider, delivery.orderId)
        !== claim.event.subjectKeyHash) {
        throw new CityDeliveryProjectionConflict("city_delivery_subject_mismatch");
      }
      if (claim.event.provider === "uu") {
        const payload = isRecord(claim.event.payload) ? claim.event.payload : undefined;
        const orderCode = typeof payload?.providerOrderCode === "string"
          ? payload.providerOrderCode
          : "";
        if (!orderCode || !delivery.deliveryNo || delivery.deliveryNo !== orderCode) {
          throw new CityDeliveryProjectionConflict("city_delivery_provider_order_mismatch");
        }
      }
      const orders = await tx.select().from(storeOrder).where(and(
        eq(storeOrder.id, delivery.oid),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      )).limit(1).for("update");
      const order = orders[0];
      if (!order) throw new Error("city_delivery_store_order_unmatched");
      if (order.paid !== 1) throw new CityDeliveryProjectionConflict("city_delivery_order_unpaid");

      if (spec.completesOrder) {
        if (order.status === 2) {
          await tx.update(storeDeliveryOrder).set({ status: 4, reason: "" })
            .where(eq(storeDeliveryOrder.id, delivery.id));
          await upsertWatermark(tx, claim.event, spec, now);
          return { terminalStatus: "APPLIED_NOOP" as const };
        }
        if (order.status !== 1 || order.deliveryType !== "city_delivery") {
          throw new CityDeliveryProjectionConflict("city_delivery_completion_order_state_conflict");
        }
        return { orderId: order.id, deliveryId: delivery.id, terminalStatus: undefined };
      }

      if (spec.cancelsDelivery) {
        if (order.status >= 2) return { terminalStatus: "SUPERSEDED" as const };
        if (order.status === 0 && order.deliveryType === "") {
          await upsertWatermark(tx, claim.event, spec, now);
          return { terminalStatus: "APPLIED_NOOP" as const };
        }
        if (order.status !== 1 || order.deliveryType !== "city_delivery") {
          throw new CityDeliveryProjectionConflict("city_delivery_cancel_order_state_conflict");
        }
        await tx.update(storeDeliveryOrder).set({
          status: spec.legacyStatus ?? delivery.status,
          reason: claim.event.reasonText.slice(0, 255),
        }).where(eq(storeDeliveryOrder.id, delivery.id));
        await tx.update(storeOrder).set({
          status: 0,
          deliveryType: "",
          deliveryName: "",
          deliveryId: "",
          deliveryUid: 0,
        }).where(eq(storeOrder.id, order.id));
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "city_delivery_cancel",
          changeMessage: "同城配送取消",
          changeTime: now,
        });
        await upsertWatermark(tx, claim.event, spec, now);
        return { terminalStatus: "APPLIED" as const };
      }

      if (order.status !== 1 || order.deliveryType !== "city_delivery") {
        if (order.status >= 2) return { terminalStatus: "SUPERSEDED" as const };
        throw new CityDeliveryProjectionConflict("city_delivery_order_state_conflict");
      }
      const deliveryUpdate: Partial<typeof storeDeliveryOrder.$inferInsert> = {
        ...(spec.legacyStatus === null ? {} : { status: spec.legacyStatus }),
        ...(claim.event.finishCode && !delivery.finishCode ? { finishCode: claim.event.finishCode } : {}),
        ...(claim.event.reasonText ? { reason: claim.event.reasonText.slice(0, 255) } : {}),
      };
      if (Object.keys(deliveryUpdate).length > 0) {
        await tx.update(storeDeliveryOrder).set(deliveryUpdate).where(eq(storeDeliveryOrder.id, delivery.id));
      }
      if (spec.clearsRider) {
        await tx.update(storeOrder).set({ deliveryName: "", deliveryId: "" })
          .where(eq(storeOrder.id, order.id));
      } else if (claim.event.riderName || claim.event.riderMobile) {
        await tx.update(storeOrder).set({
          ...(claim.event.riderName ? { deliveryName: claim.event.riderName.slice(0, 64) } : {}),
          ...(claim.event.riderMobile ? { deliveryId: claim.event.riderMobile.slice(0, 64) } : {}),
        }).where(eq(storeOrder.id, order.id));
      }
      if (!current || current.lastState !== spec.state) {
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: `city_delivery_${spec.legacyStatus ?? "unknown"}`,
          changeMessage: `同城配送状态：${spec.state}`,
          changeTime: now,
        });
      }
      await upsertWatermark(tx, claim.event, spec, now);
      return { terminalStatus: "APPLIED" as const };
    });

    if (prepared.terminalStatus) return prepared.terminalStatus;
    const completed = await completeOrderReceipt(this.container, this.env, {
      orderId: prepared.orderId,
      actor: "scheduled",
      message: `${claim.event.provider === "uu" ? "UU跑腿" : "达达"}同城配送已送达`,
    });
    const finalStatus = completed ? "APPLIED" : await withTx(this.container, async (tx) => {
      const rows = await tx.select({ status: storeOrder.status }).from(storeOrder)
        .where(eq(storeOrder.id, prepared.orderId)).limit(1).for("key share");
      if (rows[0]?.status === 2) return "APPLIED_NOOP" as const;
      throw new CityDeliveryProjectionConflict("city_delivery_completion_failed");
    });
    await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`city-delivery-subject:${claim.event.subjectKeyHash}`}))`);
      await tx.update(storeDeliveryOrder).set({ status: 4, reason: "" })
        .where(eq(storeDeliveryOrder.id, prepared.deliveryId));
      await upsertWatermark(tx, claim.event, spec, now);
    });
    return finalStatus;
  }

  private async fail(claim: ClaimedCallback, error: unknown): Promise<"dead" | { kind: "deferred"; delaySeconds: number }> {
    const now = Math.floor(Date.now() / 1_000);
    const dead = claim.attemptCount >= MAX_ATTEMPTS;
    const code = errorCode(error);
    const delaySeconds = retryDelay(claim.attemptCount);
    await withTx(this.container, async (tx) => {
      await tx.update(cityDeliveryCallbackOutbox).set({
        status: dead ? "DEAD" : "FAILED",
        availableTime: dead ? 0 : now + delaySeconds,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        processedTime: dead ? now : 0,
        updateTime: now,
      }).where(and(
        eq(cityDeliveryCallbackOutbox.id, claim.outboxId),
        eq(cityDeliveryCallbackOutbox.status, "PROCESSING"),
        eq(cityDeliveryCallbackOutbox.leaseToken, claim.leaseToken),
      ));
      await tx.update(cityDeliveryCallbackEvent).set({
        status: dead ? "DEAD" : "FAILED",
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: code,
        processedTime: dead ? now : 0,
        updateTime: now,
        ...(dead ? { finishCode: "", riderName: "", riderMobile: "", reasonText: "" } : {}),
      }).where(and(
        eq(cityDeliveryCallbackEvent.id, claim.event.id),
        eq(cityDeliveryCallbackEvent.status, "PROCESSING"),
        eq(cityDeliveryCallbackEvent.leaseToken, claim.leaseToken),
      ));
    });
    return dead ? "dead" : { kind: "deferred", delaySeconds };
  }

  async processMessage(message: CityDeliveryCallbackOutboxMessage): Promise<ProcessResult> {
    const claimed = await this.claim(message);
    if (!(typeof claimed === "object" && "event" in claimed)) return claimed;
    try {
      const result = await this.project(claimed);
      await finishClaim(this.container, claimed, result, Math.floor(Date.now() / 1_000));
      return "completed";
    } catch (error) {
      if (error instanceof CityDeliveryProjectionConflict) {
        await finishClaim(
          this.container,
          claimed,
          "CONFLICT",
          Math.floor(Date.now() / 1_000),
          errorCode(error),
        );
        return "conflict";
      }
      return this.fail(claimed, error);
    }
  }

  private async seedProviderReconciliation(
    provider: CityDeliveryProvider,
    stationType: 1 | 2,
    limit: number,
  ): Promise<number> {
    if (limit <= 0) return 0;
    const now = Math.floor(Date.now() / 1_000);
    return withTx(this.container, async (tx) => {
      const candidates = await tx.select({
        deliveryOrderId: storeDeliveryOrder.id,
        providerOrderId: storeDeliveryOrder.orderId,
      }).from(storeDeliveryOrder)
        .innerJoin(storeOrder, eq(storeOrder.id, storeDeliveryOrder.oid))
        .leftJoin(cityDeliveryReconciliationCase, and(
          eq(cityDeliveryReconciliationCase.provider, provider),
          eq(cityDeliveryReconciliationCase.deliveryOrderId, storeDeliveryOrder.id),
        ))
        .where(and(
          eq(storeDeliveryOrder.stationType, stationType),
          notInArray(storeDeliveryOrder.status, [-1, 4, 6, 10, 1000]),
          eq(storeOrder.paid, 1),
          eq(storeOrder.status, 1),
          eq(storeOrder.deliveryType, "city_delivery"),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
          isNull(cityDeliveryReconciliationCase.id),
        ))
        .orderBy(asc(storeDeliveryOrder.id))
        .limit(limit);
      if (!candidates.length) return 0;
      const inserted = await tx.insert(cityDeliveryReconciliationCase).values(
        candidates.map((candidate) => ({
          provider,
          subjectKeyHash: cityDeliverySubjectHash(provider, candidate.providerOrderId),
          deliveryOrderId: candidate.deliveryOrderId,
          status: "PENDING" as const,
          nextAttemptTime: now,
          addTime: now,
          updateTime: now,
        })),
      ).onConflictDoNothing().returning({ id: cityDeliveryReconciliationCase.id });
      return inserted.length;
    });
  }

  /** Add bounded active Dada and UU delivery rows to the durable query schedule. */
  async seedReconciliation(limit = 100): Promise<number> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
    let inserted = await this.seedProviderReconciliation("dada", 1, Math.ceil(bounded / 2));
    inserted += await this.seedProviderReconciliation("uu", 2, bounded - inserted);
    if (inserted < bounded) {
      inserted += await this.seedProviderReconciliation("dada", 1, bounded - inserted);
    }
    return inserted;
  }

  private async claimReconciliation(limit: number): Promise<Array<{
    row: CityDeliveryReconciliationCase;
    leaseToken: string;
  }>> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit), 10));
    const now = Math.floor(Date.now() / 1_000);
    return withTx(this.container, async (tx) => {
      const rows = await tx.select().from(cityDeliveryReconciliationCase).where(or(
        and(
          eq(cityDeliveryReconciliationCase.status, "PENDING"),
          lte(cityDeliveryReconciliationCase.nextAttemptTime, now),
        ),
        and(
          eq(cityDeliveryReconciliationCase.status, "QUERYING"),
          lte(cityDeliveryReconciliationCase.leaseUntil, now),
        ),
      )).orderBy(asc(cityDeliveryReconciliationCase.id)).limit(bounded)
        .for("update", { skipLocked: true });
      const claimed: Array<{ row: CityDeliveryReconciliationCase; leaseToken: string }> = [];
      for (const row of rows) {
        const leaseToken = crypto.randomUUID();
        const attemptCount = row.attemptCount + 1;
        await tx.update(cityDeliveryReconciliationCase).set({
          status: "QUERYING",
          attemptCount,
          leaseUntil: now + QUERY_LEASE_SECONDS,
          leaseToken,
          updateTime: now,
        }).where(eq(cityDeliveryReconciliationCase.id, row.id));
        claimed.push({ row: { ...row, status: "QUERYING", attemptCount }, leaseToken });
      }
      return claimed;
    });
  }

  private async reconcileOne(claim: { row: CityDeliveryReconciliationCase; leaseToken: string }) {
    const now = Math.floor(Date.now() / 1_000);
    try {
      const deliveries = await withTx(this.container, (tx) => tx.select({
          providerOrderId: storeDeliveryOrder.orderId,
          stationType: storeDeliveryOrder.stationType,
          status: storeDeliveryOrder.status,
        }).from(storeDeliveryOrder)
          .where(eq(storeDeliveryOrder.id, claim.row.deliveryOrderId)).limit(1));
      const delivery = deliveries[0];
      const expectedStationType = claim.row.provider === "dada" ? 1
        : claim.row.provider === "uu" ? 2
          : 0;
      if (!delivery || !expectedStationType || delivery.stationType !== expectedStationType) {
        throw new Error("city_delivery_reconciliation_order_missing");
      }
      if ([-1, 4, 6, 10, 1000].includes(delivery.status)) {
        await withTx(this.container, (tx) => tx.update(cityDeliveryReconciliationCase).set({
          status: "RESOLVED", leaseUntil: 0, leaseToken: "", lastErrorCode: "",
          resolvedTime: now, updateTime: now,
        }).where(and(
          eq(cityDeliveryReconciliationCase.id, claim.row.id),
          eq(cityDeliveryReconciliationCase.status, "QUERYING"),
          eq(cityDeliveryReconciliationCase.leaseToken, claim.leaseToken),
        )));
        return "resolved" as const;
      }
      const verified = claim.row.provider === "dada"
        ? await this.dadaProvider.query(delivery.providerOrderId, now)
        : await this.uuProvider.query(delivery.providerOrderId, now);
      const received = await this.receive(verified, now);
      await withTx(this.container, (tx) => tx.update(cityDeliveryReconciliationCase).set({
        status: "PENDING",
        nextAttemptTime: now + ACTIVE_QUERY_INTERVAL_SECONDS,
        leaseUntil: 0,
        leaseToken: "",
        lastEventId: received.eventId,
        lastErrorCode: "",
        updateTime: now,
      }).where(and(
        eq(cityDeliveryReconciliationCase.id, claim.row.id),
        eq(cityDeliveryReconciliationCase.status, "QUERYING"),
        eq(cityDeliveryReconciliationCase.leaseToken, claim.leaseToken),
      )));
      await this.dispatchById(received.outboxId);
      return "queried" as const;
    } catch (error) {
      const dead = claim.row.attemptCount >= MAX_ATTEMPTS;
      const delaySeconds = retryDelay(claim.row.attemptCount);
      await withTx(this.container, (tx) => tx.update(cityDeliveryReconciliationCase).set({
        status: dead ? "DEAD" : "PENDING",
        nextAttemptTime: dead ? 0 : now + delaySeconds,
        leaseUntil: 0,
        leaseToken: "",
        lastErrorCode: errorCode(error),
        updateTime: now,
      }).where(and(
        eq(cityDeliveryReconciliationCase.id, claim.row.id),
        eq(cityDeliveryReconciliationCase.status, "QUERYING"),
        eq(cityDeliveryReconciliationCase.leaseToken, claim.leaseToken),
      )));
      if (dead) return "dead" as const;
      return "failed" as const;
    }
  }

  async reconcileDue(limit = 3) {
    const claims = await this.claimReconciliation(limit);
    const results = [];
    for (const claim of claims) results.push(await this.reconcileOne(claim));
    return {
      claimed: claims.length,
      queried: results.filter((result) => result === "queried").length,
      resolved: results.filter((result) => result === "resolved").length,
      failed: results.filter((result) => result === "failed").length,
      dead: results.filter((result) => result === "dead").length,
    };
  }
}

export async function consumeCityDeliveryCallbackMessage(
  message: {
    body: OrderMessage;
    attempts: number;
    ack(): void;
    retry(options: { delaySeconds: number }): void;
  },
  service: CityDeliveryCallbackService,
): Promise<void> {
  if (!isCityDeliveryCallbackOutboxMessage(message.body)) {
    message.ack();
    return;
  }
  try {
    const result = await service.processMessage(message.body);
    if (result === "busy") {
      message.retry({ delaySeconds: 15 });
      return;
    }
    if (typeof result === "object" && result.kind === "deferred") {
      message.retry({ delaySeconds: result.delaySeconds });
      return;
    }
    emitOperationalEvent(result === "dead" || result === "conflict" ? "error" : "info", {
      event: result === "dead" ? "city_delivery_callback_dead"
        : result === "conflict" ? "city_delivery_callback_conflict"
          : "city_delivery_callback_consumed",
      component: "waybill",
      operation: "city_delivery_callback_consume",
      outcome: result === "dead" || result === "conflict" ? "failure" : "success",
      result: typeof result === "string" ? result : "deferred",
      queueAttempt: message.attempts,
    });
    message.ack();
  } catch (error) {
    const delaySeconds = retryDelay(message.attempts);
    emitOperationalEvent("error", {
      event: "city_delivery_callback_failed",
      component: "waybill",
      operation: "city_delivery_callback_consume",
      outcome: "retry",
      queueAttempt: message.attempts,
      retryDelaySeconds: delaySeconds,
      errorCode: operationalErrorCode(error, "city_delivery_callback_failed"),
    });
    message.retry({ delaySeconds });
  }
}
