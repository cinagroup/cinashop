import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import type { Env, MerchantShipmentCallbackOutboxMessage, OrderMessage } from "@/env";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "@/lib/di";
import {
  expressCompany,
  merchantShipmentCallbackEvent,
  merchantShipmentCallbackOutbox,
  merchantShipmentCallbackWatermark,
  storeOrder,
  storeOrderOutbox,
  storeOrderStatus,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import {
  MerchantShipmentCallbackService,
} from "@/services/shipping/MerchantShipmentCallbackService";
import { kuaidi100CallbackSignature } from "@/services/shipping/Kuaidi100MerchantShipmentCallback";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_MIGRATE_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const PREFIX = "codex_merchant_shipment_";
const TABLES = [
  "merchant_shipment_callback_event",
  "merchant_shipment_callback_outbox",
  "merchant_shipment_callback_watermark",
] as const;
const SUPPORT_TABLES = [
  "express_company",
  "store_order",
  "store_order_refund",
  "store_order_status",
  "store_pink",
  "store_order_outbox",
  "order_waybill_job",
] as const;
const EXPECTED_COLUMNS = {
  merchant_shipment_callback_event: [
    "id", "provider", "event_key", "replay_key", "payload_hash", "subject_key_hash",
    "task_id", "provider_order_id", "carrier_code", "tracking_number", "callback_status",
    "order_status", "payload", "status", "attempt_count", "lease_until", "lease_token",
    "last_error_code", "received_time", "processed_time", "retain_until", "update_time",
  ],
  merchant_shipment_callback_outbox: [
    "id", "event_id", "replay_key", "status", "dispatch_count", "attempt_count",
    "available_time", "lease_until", "lease_token", "last_error_code", "enqueued_time",
    "processed_time", "add_time", "update_time",
  ],
  merchant_shipment_callback_watermark: [
    "provider", "projection_type", "subject_key_hash", "last_event_id", "last_event_key",
    "last_state", "last_rank", "terminal", "update_time",
  ],
} as const;
const EXPECTED_CONSTRAINTS = [
  "merchant_shipment_callback_event_pkey", "merchant_shipment_callback_outbox_pkey",
  "mscevt_hash_key_ck", "mscevt_identifier_ck", "mscevt_payload_ck", "mscevt_provider_ck",
  "mscevt_status_ck", "mscevt_time_count_ck", "mscout_event_fk", "mscout_replay_key_ck",
  "mscout_status_ck", "mscout_time_count_ck", "mscwm_event_fk", "mscwm_hash_rank_ck",
  "mscwm_pkey", "mscwm_projection_ck", "mscwm_provider_ck", "mscwm_state_ck",
] as const;
const EXPECTED_INDEXES = [
  "merchant_shipment_callback_event_pkey", "merchant_shipment_callback_outbox_pkey",
  "mscevt_actionable_status", "mscevt_provider_event_uq", "mscevt_replay_key_uq",
  "mscevt_retention_due", "mscevt_subject_order", "mscout_dispatch_ready", "mscout_event_uq",
  "mscout_expired_lease", "mscout_replay_key_uq", "mscwm_last_event", "mscwm_pkey",
] as const;
const SALT = "isolated-kuaidi100-callback-salt-32";
const IDS = {
  carrier: 1_960_000_001,
  active: 1_960_010_001,
  cancelled: 1_960_010_002,
  ignored: 1_960_010_003,
  queue: 1_960_010_004,
  reassigned: 1_960_010_005,
} as const;

function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = bytesFromHex(expectedHex);
  if (!expected) return false;
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe_postgres_identifier");
  return `"${value}"`;
}

async function schemaEvidence(client: postgres.Sql, schema: string) {
  const relations = await client<Array<{ table_name: string; relkind: string; relpersistence: string }>>`
    SELECT relation.relname AS table_name, relation.relkind::text, relation.relpersistence::text
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY relation.relname
  `;
  const columnRows = await client<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name IN ${client([...TABLES])}
    ORDER BY table_name, ordinal_position
  `;
  const columns = TABLES.map((table) => ({
    table_name: table,
    columns: columnRows.filter((row) => row.table_name === table).map((row) => row.column_name),
  }));
  const constraints = await client<Array<{
    name: string; type: string; validated: boolean; no_inherit: boolean; current_state_set: boolean;
  }>>`
    SELECT constraint_row.conname AS name, constraint_row.contype::text AS type,
      constraint_row.convalidated AS validated, constraint_row.connoinherit AS no_inherit,
      strpos(pg_get_constraintdef(constraint_row.oid), 'SETTLED') > 0
        AND strpos(pg_get_constraintdef(constraint_row.oid), 'REASSIGNED') > 0 AS current_state_set
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY constraint_row.conname
  `;
  const indexes = await client<Array<{ name: string; valid: boolean; ready: boolean; partial: boolean; unique: boolean }>>`
    SELECT index_relation.relname AS name, index_row.indisvalid AS valid,
      index_row.indisready AS ready, index_row.indpred IS NOT NULL AS partial,
      index_row.indisunique AS unique
    FROM pg_index AS index_row
    JOIN pg_class AS relation ON relation.oid = index_row.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY index_relation.relname
  `;
  const rowCounts: Array<{ table: string; rows: number }> = [];
  for (const table of TABLES) {
    if (relations.some((relation) => relation.table_name === table)) {
      const rows = await client.unsafe<Array<{ count: number }>>(
        `SELECT count(*)::integer AS count FROM ${identifier(schema)}.${identifier(table)}`,
      );
      rowCounts.push({ table, rows: rows[0]?.count ?? -1 });
    }
  }
  const complete = relations.length === 3
    && relations.every((row) => row.relkind === "r" && row.relpersistence === "p")
    && columns.every((row) => JSON.stringify(row.columns) === JSON.stringify(
      EXPECTED_COLUMNS[row.table_name as keyof typeof EXPECTED_COLUMNS],
    ))
    && JSON.stringify(constraints.map((row) => row.name)) === JSON.stringify([...EXPECTED_CONSTRAINTS].sort())
    && constraints.every((row) => row.validated && (row.type !== "c" || !row.no_inherit))
    && constraints.some((row) => row.name === "mscwm_state_ck" && row.current_state_set)
    && JSON.stringify(indexes.map((row) => row.name)) === JSON.stringify([...EXPECTED_INDEXES].sort())
    && indexes.every((row) => row.valid && row.ready)
    && indexes.filter((row) => row.partial).length === 4
    && indexes.filter((row) => row.unique).length === 7;
  return { complete, relations, columns, constraints, indexes, rowCounts };
}

async function productionAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: "cinashop_merchant_shipment_callback_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const version = await tx<Array<{ version: string }>>`SELECT version()`;
      const evidence = await schemaEvidence(tx as unknown as postgres.Sql, "public");
      const config = await tx<Array<{ menu_name: string; configured_rows: number }>>`
        SELECT menu_name, count(*) FILTER (
          WHERE length(btrim(COALESCE(value, ''), ' "')) > 0
        )::integer AS configured_rows
        FROM system_config
        WHERE menu_name IN (
          'sms_account', 'sms_token', 'config_shippment_open',
          'config_export_siid', 'site_url'
        ) GROUP BY menu_name ORDER BY menu_name
      `;
      const orders = await tx<Array<{
        total: number; task_marked: number; provider_order_marked: number;
        tracking_marked: number; stock_up: number; any_merchant_marker: number;
      }>>`
        SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE btrim(kuaidi_task_id) <> '')::integer AS task_marked,
          count(*) FILTER (WHERE kuaidi_order_id <> 0)::integer AS provider_order_marked,
          count(*) FILTER (WHERE btrim(delivery_id) <> '')::integer AS tracking_marked,
          count(*) FILTER (WHERE is_stock_up <> 0)::integer AS stock_up,
          count(*) FILTER (
            WHERE btrim(kuaidi_task_id) <> '' OR kuaidi_order_id <> 0 OR is_stock_up <> 0
          )::integer AS any_merchant_marker
        FROM store_order WHERE is_del = 0
      `;
      const duplicates = await tx<Array<{ task_groups: number; provider_order_groups: number }>>`
        SELECT
          (SELECT count(*)::integer FROM (
            SELECT kuaidi_task_id FROM store_order
            WHERE is_del = 0 AND btrim(kuaidi_task_id) <> ''
            GROUP BY kuaidi_task_id HAVING count(*) > 1
          ) AS tasks) AS task_groups,
          (SELECT count(*)::integer FROM (
            SELECT kuaidi_order_id FROM store_order
            WHERE is_del = 0 AND kuaidi_order_id <> 0
            GROUP BY kuaidi_order_id HAVING count(*) > 1
          ) AS orders) AS provider_order_groups
      `;
      const temp = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
      `;
      return {
        engine: version[0]?.version ?? "unknown",
        schema: evidence,
        configuration_presence_only: config,
        order_aggregates: orders[0] ?? {},
        ambiguous_identifier_group_counts: duplicates[0] ?? {},
        temporary_schema_count: temp[0]?.count ?? -1,
        values_or_identifiers_returned: false,
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function migrateProduction(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_merchant_shipment_callback_migration",
  });
  const admin = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5 });
  try {
    const before = await schemaEvidence(admin, "public");
    if (before.relations.length !== 0 && before.relations.length !== 3) {
      throw new Error("partial_merchant_shipment_callback_schema_exists");
    }
    if (before.relations.length === 3 && !before.complete) {
      throw new Error("merchant_shipment_callback_schema_collision");
    }
    const migration = new MigrationService(createContainerFromDb(db))
      .merchantShipmentCallbackPipelineMigrationSqlForVerification();
    await withTx(createContainerFromDb(db), (tx) => tx.execute(sql.raw(migration)));
    const first = await schemaEvidence(admin, "public");
    if (!first.complete) throw new Error("merchant_shipment_callback_schema_verification_failed");
    await withTx(createContainerFromDb(db), (tx) => tx.execute(sql.raw(migration)));
    const second = await schemaEvidence(admin, "public");
    if (!second.complete || JSON.stringify(first.columns) !== JSON.stringify(second.columns)) {
      throw new Error("merchant_shipment_callback_migration_not_idempotent");
    }
    return { complete: true, created: before.relations.length === 0, idempotent_second_pass: true, evidence: second };
  } finally {
    await db.$client.end({ timeout: 1 });
    await admin.end({ timeout: 1 });
  }
}

function callbackBody(taskId: string, orderStatus: string, options: {
  tracking?: string; callbackStatus?: string; marker?: string; pii?: boolean; carrier?: string;
  reassignment?: { taskId: string; carrierCode: string; trackingNumber: string };
} = {}) {
  const param = JSON.stringify({
    kuaidicom: options.carrier ?? "yuantong",
    kuaidinum: options.tracking ?? "",
    status: options.callbackStatus ?? "200",
    message: options.marker ?? "ok",
    data: {
      orderId: `provider-${taskId}`,
      status: orderStatus,
      ...(options.reassignment ? {
        taskId: options.reassignment.taskId,
        kuaidiCom: options.reassignment.carrierCode,
        kuaidiNum: options.reassignment.trackingNumber,
      } : {}),
      ...(options.pii ? {
        courierName: "隔离快递员",
        courierMobile: "000-0000-1960",
        feeDetails: [{ feeType: "AUDIT", amount: "1.00" }],
        imgBase64: "private-image-content",
      } : {}),
    },
  });
  return new URLSearchParams({ taskId, sign: kuaidi100CallbackSignature(param, SALT), param }).toString();
}

async function publicFingerprint(client: postgres.Sql) {
  const rows: Record<string, { count: number; digest: string }> = {};
  for (const table of SUPPORT_TABLES) {
    const result = await client.unsafe<Array<{ count: number; digest: string }>>(
      `SELECT count(*)::integer AS count,
        md5(COALESCE(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')) AS digest
       FROM public.${identifier(table)} AS t`,
    );
    rows[table] = result[0] ?? { count: -1, digest: "" };
  }
  return rows;
}

async function isolatedScenario(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 5, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: "cinashop_merchant_shipment_callback_isolated_admin" },
  });
  const schema = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
  const beforeSchemas = await admin<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
  `;
  const publicBefore = await publicFingerprint(admin);
  let result: Record<string, unknown> | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
    db = createDbFromConnectionString(connectionString, 5, {
      searchPath: schema,
      applicationName: "cinashop_merchant_shipment_callback_isolated",
    });
    const container = createContainerFromDb(db);
    const migration = new MigrationService(container)
      .merchantShipmentCallbackPipelineMigrationSqlForVerification();
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const firstEvidence = await schemaEvidence(admin, schema);
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const secondEvidence = await schemaEvidence(admin, schema);
    if (!firstEvidence.complete || !secondEvidence.complete) {
      throw new Error("isolated_merchant_shipment_migration_shape_failed");
    }

    await admin.begin(async (tx) => {
      for (const table of SUPPORT_TABLES) {
        await tx.unsafe(
          `CREATE TABLE ${identifier(schema)}.${identifier(table)}
           (LIKE public.${identifier(table)} INCLUDING ALL)`,
        );
        await tx.unsafe(`CREATE SEQUENCE ${identifier(schema)}.${identifier(`${table}_id_seq_it`)} START WITH 1960900001`);
        await tx.unsafe(
          `ALTER TABLE ${identifier(schema)}.${identifier(table)} ALTER COLUMN id
           SET DEFAULT nextval('${schema}.${table}_id_seq_it'::regclass)`,
        );
      }
    });

    const now = Math.floor(Date.now() / 1_000);
    const seeded = [
      [IDS.active, "task-active"],
      [IDS.cancelled, "task-cancelled"],
      [IDS.ignored, "task-ignored"],
      [IDS.queue, "task-queue"],
      [IDS.reassigned, "task-reassigned"],
    ] as const;
    await withTx(container, async (tx) => {
      await tx.insert(expressCompany).values({
        id: IDS.carrier, code: "yuantong", name: "隔离圆通", isShow: 1, status: 1, sort: 100, addTime: now,
      });
      await tx.insert(storeOrder).values(seeded.map(([id, taskId], index) => ({
        id,
        orderId: `audit-merchant-${index + 1}`,
        supplierId: 101,
        storeId: 101,
        uid: 1_960_100_001 + index,
        unique: `audit-merchant-unique-${index + 1}`,
        realName: "隔离收件人",
        userPhone: "000-0000-1960",
        userAddress: "隔离审计收件地址",
        shippingType: 1,
        paid: 1,
        status: 0,
        refundStatus: 0,
        totalNum: 1,
        totalPrice: "10.00",
        payPrice: "10.00",
        kuaidiTaskId: taskId,
        isStockUp: 1,
        addTime: now - 60,
        payTime: now - 30,
      })));
    });

    const sent: MerchantShipmentCallbackOutboxMessage[] = [];
    let failQueue = false;
    const queue = {
      async sendBatch(messages: Array<{ body: MerchantShipmentCallbackOutboxMessage }>) {
        if (failQueue) throw new Error("injected_queue_failure");
        sent.push(...messages.map((message) => structuredClone(message.body)));
      },
    } as unknown as Queue<OrderMessage>;
    const env = { ORDER_QUEUE: queue, KUAIDI100_CALLBACK_SALT: SALT } as unknown as Env;
    const service = new MerchantShipmentCallbackService(container, env);
    const accept = async (taskId: string, orderStatus: string, options: Parameters<typeof callbackBody>[2] = {}) => {
      const received = await service.receive(service.verify(callbackBody(taskId, orderStatus, options)), now);
      await service.dispatchById(received.outboxId);
      const message = sent.at(-1);
      if (!message) throw new Error("isolated_queue_message_missing");
      return { received, message, result: await service.processMessage(message) };
    };

    const created = await accept("task-active", "0", { pii: true });
    const duplicate = await service.receive(service.verify(callbackBody("task-active", "0", { pii: true })), now);
    const accepted = await accept("task-active", "1");
    const stale = await accept("task-active", "0", { marker: "late-created" });

    const cancelled = await accept("task-cancelled", "99");
    const lateAccepted = await accept("task-cancelled", "1");
    const resurrected = await accept("task-cancelled", "166");
    const acceptedAfterResurrection = await accept("task-cancelled", "1", { marker: "after-resurrection" });

    const pickupVerified = service.verify(callbackBody("task-active", "10", { tracking: "YT196000001" }));
    const pickupReceived = await service.receive(pickupVerified, now);
    await service.dispatchById(pickupReceived.outboxId);
    const pickupMessage = sent.at(-1);
    if (!pickupMessage) throw new Error("isolated_pickup_message_missing");
    const concurrentPickup = await Promise.all([
      service.processMessage(pickupMessage),
      service.processMessage(pickupMessage),
    ]);
    const pickupReplay = await service.processMessage(pickupMessage);
    const lateCancel = await accept("task-active", "99", { tracking: "YT196000001", marker: "late-cancel" });
    const settled = await accept("task-active", "15", { tracking: "YT196000001" });
    const activeAfterSettlement = await accept("task-active", "1", { marker: "after-settlement" });
    const ignored = await accept("task-ignored", "777", { marker: "unknown" });
    const reassigned = await accept("task-reassigned", "302", {
      reassignment: {
        taskId: "task-reassigned-new",
        carrierCode: "jd",
        trackingNumber: "JD196000005",
      },
    });
    const reassignedStale = await accept("task-reassigned-new", "1", { carrier: "jd" });
    const reassignedBeforePickup = await withTx(container, (tx) => tx.select({ status: storeOrder.status })
      .from(storeOrder).where(eq(storeOrder.id, IDS.reassigned)).limit(1));
    const reassignedPickup = await accept("task-reassigned-new", "10", {
      carrier: "jd", tracking: "JD196000005",
    });

    failQueue = true;
    const queueReceived = await service.receive(service.verify(callbackBody("task-queue", "0")), now);
    let queueFailure = false;
    try { await service.dispatchById(queueReceived.outboxId); } catch { queueFailure = true; }
    failQueue = false;
    const failedOutbox = await withTx(container, (tx) => tx.select()
      .from(merchantShipmentCallbackOutbox)
      .where(eq(merchantShipmentCallbackOutbox.id, queueReceived.outboxId)).limit(1));
    await withTx(container, (tx) => tx.update(merchantShipmentCallbackOutbox)
      .set({ availableTime: 0 }).where(eq(merchantShipmentCallbackOutbox.id, queueReceived.outboxId)));
    await service.dispatchById(queueReceived.outboxId);

    const unmatched = await service.receive(service.verify(callbackBody("task-unmatched", "0")), now);
    await service.dispatchById(unmatched.outboxId);
    const unmatchedMessage = sent.at(-1);
    if (!unmatchedMessage) throw new Error("isolated_unmatched_message_missing");
    let unmatchedResult: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      unmatchedResult = await service.processMessage(unmatchedMessage);
    }

    const { orders, events, outboxRows, replayRows, watermarks } = await withTx(container, async (tx) => {
      const orders = await tx.select({
        id: storeOrder.id, status: storeOrder.status, isStockUp: storeOrder.isStockUp,
        deliveryId: storeOrder.deliveryId,
      }).from(storeOrder);
      const events = await tx.select({
        status: merchantShipmentCallbackEvent.status,
        payload: merchantShipmentCallbackEvent.payload,
      }).from(merchantShipmentCallbackEvent);
      const outboxRows = await tx.select().from(storeOrderOutbox);
      const replayRows = await tx.select({ changeType: storeOrderStatus.changeType })
        .from(storeOrderStatus).where(eq(storeOrderStatus.changeType, "merchant_shipment_delivery"));
      const watermarks = await tx.select().from(merchantShipmentCallbackWatermark);
      return { orders, events, outboxRows, replayRows, watermarks };
    });
    const eventText = JSON.stringify(events);
    const active = orders.find((order) => order.id === IDS.active);
    const cancelledOrder = orders.find((order) => order.id === IDS.cancelled);
    const reassignedOrder = orders.find((order) => order.id === IDS.reassigned);
    const assertions = {
      migration_exact_and_idempotent: firstEvidence.complete && secondEvidence.complete,
      official_form_signature_and_allowlist: created.result === "completed"
        && !eventText.includes("000-0000-1960") && !eventText.includes("隔离快递员")
        && !eventText.includes("private-image-content") && !eventText.includes("feeDetails"),
      duplicate_receive_is_atomic: duplicate.duplicate && duplicate.eventId === created.received.eventId,
      active_progress_and_stale_rejected: accepted.result === "completed" && stale.result === "completed"
        && events.some((event) => event.status === "SUPERSEDED"),
      cancellation_blocks_late_active_state: cancelled.result === "completed" && lateAccepted.result === "conflict",
      explicit_resurrection_reopens_state: resurrected.result === "completed"
        && acceptedAfterResurrection.result === "completed" && cancelledOrder?.isStockUp === 1,
      pickup_fulfils_exactly_once: concurrentPickup.includes("completed")
        && concurrentPickup.some((value) => value === "already-completed" || value === "busy")
        && pickupReplay === "already-completed" && active?.status === 1
        && active.deliveryId === "YT196000001" && active.isStockUp === 0
        && replayRows.length === 2 && outboxRows.length === 2,
      late_cancel_does_not_regress: lateCancel.result === "completed" && active?.status === 1,
      settlement_closes_state: settled.result === "completed" && activeAfterSettlement.result === "conflict",
      unknown_status_isolated: ignored.result === "completed" && events.some((event) => event.status === "IGNORED"),
      reassignment_links_future_task: reassigned.result === "completed"
        && reassignedStale.result === "completed" && reassignedBeforePickup[0]?.status === 0
        && reassignedPickup.result === "completed" && reassignedOrder?.status === 1
        && reassignedOrder.deliveryId === "JD196000005",
      queue_payload_is_opaque: sent.every((message) => JSON.stringify(Object.keys(message).sort())
        === JSON.stringify(["action", "eventId", "outboxId", "replayKey"])),
      queue_failure_is_durable: queueFailure && failedOutbox[0]?.status === "FAILED",
      unmatched_task_exhausts_to_dead: unmatchedResult === "dead"
        && events.some((event) => event.status === "DEAD"),
      state_and_metadata_watermarks_exist: watermarks.some((row) => row.projectionType === "order_state"),
    };
    const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
    if (failed.length) throw new Error(`isolated_assertions_failed:${failed.join(",")}`);
    result = {
      complete: true,
      checks_passed: Object.keys(assertions).length,
      expected_checks: Object.keys(assertions).length,
      assertions,
      evidence: secondEvidence,
      event_status_counts: Object.entries(events.reduce<Record<string, number>>((counts, event) => {
        counts[event.status] = (counts[event.status] ?? 0) + 1;
        return counts;
      }, {})),
      raw_form_signature_or_pii_columns: false,
    };
  } finally {
    if (db) await db.$client.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
    const afterSchemas = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
    `;
    const removed = await admin<Array<{ removed: boolean }>>`SELECT to_regnamespace(${schema}) IS NULL AS removed`;
    const publicAfter = await publicFingerprint(admin);
    await admin.end({ timeout: 1 });
    if (afterSchemas[0]?.count !== beforeSchemas[0]?.count || !removed[0]?.removed) {
      throw new Error("temporary_schema_cleanup_failed");
    }
    if (JSON.stringify(publicAfter) !== JSON.stringify(publicBefore)) {
      throw new Error("public_state_changed_during_isolated_scenario");
    }
  }
  if (!result) throw new Error("isolated_scenario_produced_no_result");
  return { ...result, temporary_schema_removed: true, public_state_unchanged: true };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/audit", "/migrate", "/isolated"].includes(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const expected = path === "/audit" ? env.AUDIT_READ_TOKEN_SHA256
      : path === "/migrate" ? env.AUDIT_MIGRATE_TOKEN_SHA256
        : env.AUDIT_ISOLATED_TOKEN_SHA256;
    if (!(await authorized(request, expected ?? ""))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = path === "/audit"
        ? await productionAudit(env.HYPERDRIVE.connectionString)
        : path === "/migrate"
          ? await migrateProduction(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result);
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000) : "audit_failed",
      }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
