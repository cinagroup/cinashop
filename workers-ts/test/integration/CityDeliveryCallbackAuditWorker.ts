import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import type { CityDeliveryCallbackOutboxMessage, Env } from "@/env";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "@/lib/di";
import {
  cityDeliveryCallbackEvent,
  cityDeliveryCallbackOutbox,
  cityDeliveryCallbackWatermark,
  cityDeliveryReconciliationCase,
  storeDeliveryOrder,
  storeOrder,
  storeOrderStatus,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import { CityDeliveryCallbackService } from "@/services/delivery/CityDeliveryCallbackService";
import {
  dadaCallbackChecksum,
  normalizeDadaCityDeliveryQuery,
  verifyDadaCityDeliveryCallback,
} from "@/services/delivery/DadaCityDeliveryCallback";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_MIGRATE_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const PREFIX = "codex_city_delivery_";
const CALLBACK_TOKEN = "isolated-dada-callback-token-32";
const CLIENT_ID = "isolated-dada-client";
const TARGET_TABLES = [
  "city_delivery_callback_event",
  "city_delivery_callback_outbox",
  "city_delivery_callback_watermark",
  "city_delivery_reconciliation_case",
] as const;
const SUPPORT_TABLES = ["store_order", "store_order_status"] as const;
const IDS = {
  active: 1_961_010_001,
  cancel: 1_961_010_002,
  completed: 1_961_010_003,
  unknown: 1_961_010_004,
  queue: 1_961_010_005,
  returned: 1_961_010_006,
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

async function publicFingerprint(client: postgres.Sql) {
  const rows = await client<Array<{ table_name: string; row_count: number; digest: string }>>`
    SELECT table_name, row_count, digest
    FROM (
      SELECT 'store_order'::text AS table_name, count(*)::integer AS row_count,
        coalesce(md5(string_agg(md5(row_value::text), '' ORDER BY row_value::text)), '') AS digest
      FROM (SELECT to_jsonb(row) AS row_value FROM public.store_order AS row) AS valueset
      UNION ALL
      SELECT 'store_delivery_order', count(*)::integer,
        coalesce(md5(string_agg(md5(row_value::text), '' ORDER BY row_value::text)), '')
      FROM (SELECT to_jsonb(row) AS row_value FROM public.store_delivery_order AS row) AS valueset
      UNION ALL
      SELECT 'store_order_status', count(*)::integer,
        coalesce(md5(string_agg(md5(row_value::text), '' ORDER BY row_value::text)), '')
      FROM (SELECT to_jsonb(row) AS row_value FROM public.store_order_status AS row) AS valueset
      UNION ALL
      SELECT 'system_config', count(*)::integer,
        coalesce(md5(string_agg(md5(row_value::text), '' ORDER BY row_value::text)), '')
      FROM (SELECT to_jsonb(row) AS row_value FROM public.system_config AS row) AS valueset
    ) AS fingerprint
    ORDER BY table_name
  `;
  return rows;
}

async function schemaEvidence(client: postgres.Sql, schema: string) {
  const safeSchema = identifier(schema);
  const [relations, columns, constraints, indexes, scanIndex] = await Promise.all([
    client<Array<{ table_name: string; relkind: string; persistence: string }>>`
      SELECT c.relname AS table_name, c.relkind::text AS relkind, c.relpersistence::text AS persistence
      FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = ANY(${TARGET_TABLES as unknown as string[]})
      ORDER BY c.relname
    `,
    client<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM pg_attribute AS a JOIN pg_class AS c ON c.oid = a.attrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = ANY(${TARGET_TABLES as unknown as string[]})
        AND a.attnum > 0 AND NOT a.attisdropped
    `,
    client<Array<{ count: number; invalid: number; foreign_restrict: number }>>`
      SELECT count(*)::integer AS count,
        count(*) FILTER (WHERE NOT con.convalidated)::integer AS invalid,
        count(*) FILTER (WHERE con.contype = 'f' AND con.confdeltype = 'r')::integer AS foreign_restrict
      FROM pg_constraint AS con JOIN pg_class AS c ON c.oid = con.conrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = ANY(${TARGET_TABLES as unknown as string[]})
    `,
    client<Array<{ count: number; invalid: number; partial: number; unique_count: number }>>`
      SELECT count(*)::integer AS count,
        count(*) FILTER (WHERE NOT i.indisvalid OR NOT i.indisready)::integer AS invalid,
        count(*) FILTER (WHERE i.indpred IS NOT NULL)::integer AS partial,
        count(*) FILTER (WHERE i.indisunique)::integer AS unique_count
      FROM pg_index AS i JOIN pg_class AS c ON c.oid = i.indrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = ANY(${TARGET_TABLES as unknown as string[]})
    `,
    client<Array<{ ready: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_index AS i JOIN pg_class AS idx ON idx.oid = i.indexrelid
        JOIN pg_namespace AS n ON n.oid = idx.relnamespace
        WHERE n.nspname = ${schema} AND idx.relname = 'sdo_dada_reconcile_scan'
          AND i.indisvalid AND i.indisready
      ) AS ready
    `,
  ]);
  let totalRows = 0;
  for (const table of relations.map((row) => row.table_name)) {
    if (!TARGET_TABLES.includes(table as (typeof TARGET_TABLES)[number])) continue;
    const result = await client.unsafe<Array<{ rows: number }>>(
      `SELECT count(*)::integer AS rows FROM ${safeSchema}.${identifier(table)}`,
    );
    totalRows += result[0]?.rows ?? 0;
  }
  const complete = relations.length === 4
    && relations.every((row) => row.relkind === "r" && row.persistence === "p")
    && columns[0]?.count === 64
    && constraints[0]?.count === 25
    && constraints[0]?.invalid === 0
    && constraints[0]?.foreign_restrict === 4
    && indexes[0]?.count === 19
    && indexes[0]?.invalid === 0
    && indexes[0]?.partial === 6
    && indexes[0]?.unique_count === 10
    && scanIndex[0]?.ready === true;
  return {
    complete,
    relationCount: relations.length,
    columnCount: columns[0]?.count ?? -1,
    constraintCount: constraints[0]?.count ?? -1,
    invalidConstraintCount: constraints[0]?.invalid ?? -1,
    foreignRestrictCount: constraints[0]?.foreign_restrict ?? -1,
    indexCount: indexes[0]?.count ?? -1,
    invalidIndexCount: indexes[0]?.invalid ?? -1,
    partialIndexCount: indexes[0]?.partial ?? -1,
    uniqueIndexCount: indexes[0]?.unique_count ?? -1,
    scanIndexReady: scanIndex[0]?.ready ?? false,
    totalRows,
  };
}

async function readOnlyAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 2, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: "cinashop_city_delivery_read_only_audit" },
  });
  try {
    return await client.begin("isolation level repeatable read read only", async (tx) => {
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      const relationNames = await tx<Array<{ table_name: string }>>`
        SELECT c.relname AS table_name
        FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname = ANY(${TARGET_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      const relationRows: Array<{ table_name: string; rows: number }> = [];
      for (const relation of relationNames) {
        if (!TARGET_TABLES.includes(relation.table_name as (typeof TARGET_TABLES)[number])) continue;
        const count = await tx.unsafe<Array<{ rows: number }>>(
          `SELECT count(*)::integer AS rows FROM public.${identifier(relation.table_name)}`,
        );
        relationRows.push({ table_name: relation.table_name, rows: count[0]?.rows ?? 0 });
      }
      const [version, deliveries, config, temporary] = await Promise.all([
        tx<Array<{ version: string }>>`SELECT current_setting('server_version') AS version`,
        tx<Array<{
          total: number; dada: number; uu: number; active_dada: number; active_uu: number;
          duplicate_provider_order_groups: number; orphan_order_rows: number;
        }>>`
          SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE d.station_type = 1)::integer AS dada,
            count(*) FILTER (WHERE d.station_type = 2)::integer AS uu,
            count(*) FILTER (WHERE d.station_type = 1 AND d.status NOT IN (-1,4,6,10,1000))::integer AS active_dada,
            count(*) FILTER (WHERE d.station_type = 2 AND d.status NOT IN (-1,4,6,10,1000))::integer AS active_uu,
            (SELECT count(*) FROM (
              SELECT station_type, order_id FROM store_delivery_order
              WHERE btrim(order_id) <> '' GROUP BY station_type, order_id HAVING count(*) > 1
            ) AS duplicates)::integer AS duplicate_provider_order_groups,
            count(*) FILTER (WHERE o.id IS NULL)::integer AS orphan_order_rows
          FROM store_delivery_order AS d LEFT JOIN store_order AS o ON o.id = d.oid
        `,
        tx<Array<{ configured_keys: number; duplicate_keys: number }>>`
          SELECT count(DISTINCT menu_name)::integer AS configured_keys,
            (SELECT count(*) FROM (
              SELECT menu_name FROM system_config
              WHERE is_store = 0 AND menu_name = ANY(ARRAY[
                'dada_app_key','dada_app_sercret','dada_source_id',
                'uupt_appkey','uupt_app_id','uupt_open_id'
              ]) GROUP BY menu_name HAVING count(*) > 1
            ) AS duplicate)::integer AS duplicate_keys
          FROM system_config
          WHERE is_store = 0 AND menu_name = ANY(ARRAY[
            'dada_app_key','dada_app_sercret','dada_source_id',
            'uupt_appkey','uupt_app_id','uupt_open_id'
          ]) AND btrim(value) <> ''
        `,
        tx<Array<{ count: number }>>`
          SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
        `,
      ]);
      return {
        postgresVersion: version[0]?.version ?? "",
        targetRelations: relationRows.length,
        targetRows: relationRows.reduce((sum, row) => sum + row.rows, 0),
        delivery: deliveries[0],
        providerConfig: config[0],
        temporarySchemas: temporary[0]?.count ?? -1,
      };
    });
  } finally {
    await client.end({ timeout: 2 });
  }
}

async function prepareSupportTables(admin: postgres.Sql, schema: string) {
  await admin.unsafe(`CREATE TABLE ${identifier(schema)}.store_delivery_order
    (LIKE public.store_delivery_order INCLUDING ALL)`);
  await admin.unsafe(`CREATE SEQUENCE ${identifier(schema)}.store_delivery_order_id_seq_it START WITH 1961000001`);
  await admin.unsafe(`ALTER TABLE ${identifier(schema)}.store_delivery_order ALTER COLUMN id
    SET DEFAULT nextval('${schema}.store_delivery_order_id_seq_it'::regclass)`);
  for (const table of SUPPORT_TABLES) {
    await admin.unsafe(`CREATE TABLE ${identifier(schema)}.${identifier(table)}
      (LIKE public.${identifier(table)} INCLUDING ALL)`);
    await admin.unsafe(`CREATE SEQUENCE ${identifier(schema)}.${identifier(`${table}_id_seq_it`)} START WITH 1961000001`);
    await admin.unsafe(`ALTER TABLE ${identifier(schema)}.${identifier(table)} ALTER COLUMN id
      SET DEFAULT nextval('${schema}.${table}_id_seq_it'::regclass)`);
  }
}

function dadaBody(orderId: string, status: number, updateTime: number, overrides: Record<string, unknown> = {}) {
  const body = {
    client_id: CLIENT_ID,
    order_id: orderId,
    order_status: status,
    update_time: updateTime,
    cancel_reason: "",
    cancel_from: 0,
    repeat_reason_type: 0,
    finish_code: "1961",
    dm_name: "隔离骑手",
    dm_mobile: "000-0000-1961",
    ...overrides,
  };
  return JSON.stringify({
    ...body,
    signature: dadaCallbackChecksum(String(body.client_id), String(body.order_id), String(body.update_time)),
  });
}

async function isolatedScenario(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 5, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: "cinashop_city_delivery_isolated_admin" },
  });
  const schema = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const publicBefore = await publicFingerprint(admin);
  const beforeSchemas = await admin<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
  `;
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
  let result: Record<string, unknown> | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
    await prepareSupportTables(admin, schema);
    db = createDbFromConnectionString(connectionString, 5, {
      searchPath: schema,
      applicationName: "cinashop_city_delivery_isolated",
    });
    const container = createContainerFromDb(db);
    const migration = new MigrationService(container).cityDeliveryCallbackPipelineMigrationSqlForVerification();
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const firstEvidence = await schemaEvidence(admin, schema);
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const secondEvidence = await schemaEvidence(admin, schema);
    if (!firstEvidence.complete || !secondEvidence.complete) {
      throw new Error("isolated_city_delivery_migration_shape_failed");
    }

    const now = Math.floor(Date.now() / 1_000);
    const seeds = [
      [IDS.active, "dd-isolated-active", 1],
      [IDS.cancel, "dd-isolated-cancel", 1],
      [IDS.completed, "dd-isolated-complete", 2],
      [IDS.unknown, "dd-isolated-unknown", 1],
      [IDS.queue, "dd-isolated-queue", 1],
      [IDS.returned, "dd-isolated-returned", 1],
    ] as const;
    await withTx(container, async (tx) => {
      await tx.insert(storeOrder).values(seeds.map(([id, _providerOrderId, status], index) => ({
        id,
        orderId: `audit-city-${index + 1}`,
        uid: 1_961_100_001 + index,
        unique: `audit-city-unique-${index + 1}`,
        realName: "隔离收件人",
        userPhone: "000-0000-1961",
        userAddress: "隔离审计地址",
        shippingType: 1,
        paid: 1,
        status,
        refundStatus: 0,
        totalNum: 1,
        totalPrice: "10.00",
        payPrice: "10.00",
        deliveryType: "city_delivery",
        addTime: now - 60,
        payTime: now - 30,
      })));
      await tx.insert(storeDeliveryOrder).values(seeds.map(([id, providerOrderId, status], index) => ({
        id,
        oid: id,
        uid: 1_961_100_001 + index,
        stationType: 1,
        orderId: providerOrderId,
        deliveryNo: `DADA-${index + 1}`,
        userName: "隔离收件人",
        receiverPhone: "00000001961",
        status: status === 2 ? 3 : 0,
        addTime: now - 60,
      })));
    });

    const sent: CityDeliveryCallbackOutboxMessage[] = [];
    let failQueue = false;
    const queue = {
      async sendBatch(messages: Array<{ body: CityDeliveryCallbackOutboxMessage }>) {
        if (failQueue) throw new Error("injected_queue_failure");
        sent.push(...messages.map((message) => structuredClone(message.body)));
      },
    };
    const env = {
      ORDER_QUEUE: queue,
      DADA_CALLBACK_TOKEN: CALLBACK_TOKEN,
      DADA_CLIENT_ID: CLIENT_ID,
    } as unknown as Env;
    const service = new CityDeliveryCallbackService(container, env);
    const receive = async (orderId: string, status: number, updateTime: number, overrides = {}) => {
      const verified = verifyDadaCityDeliveryCallback(dadaBody(orderId, status, updateTime, overrides), {
        requestToken: CALLBACK_TOKEN,
        callbackToken: CALLBACK_TOKEN,
        expectedClientId: CLIENT_ID,
      });
      return service.receive(verified, now);
    };
    const consumeLast = async (stage: string) => {
      const message = sent.shift();
      if (!message) throw new Error(`isolated_city_delivery_queue_message_missing:${stage}`);
      return service.processMessage(message);
    };

    const activeAccepted = await receive("dd-isolated-active", 2, now - 50);
    await service.dispatchById(activeAccepted.outboxId);
    if (await consumeLast("active_accept") !== "completed") throw new Error("active_accept_projection_failed");
    const duplicate = await receive("dd-isolated-active", 2, now - 50);
    const activeDelivering = await receive("dd-isolated-active", 3, now - 40);
    await service.dispatchById(activeDelivering.outboxId);
    if (await consumeLast("active_delivery") !== "completed") throw new Error("active_delivery_projection_failed");
    const stale = await receive("dd-isolated-active", 1, now - 60);
    await service.dispatchById(stale.outboxId);
    if (await consumeLast("stale") !== "completed") throw new Error("stale_projection_failed");
    const lateCancel = await receive("dd-isolated-active", 5, now - 30, { cancel_reason: "迟到取消" });
    await service.dispatchById(lateCancel.outboxId);
    if (await consumeLast("late_cancel") !== "conflict") throw new Error("late_cancel_not_conflict");

    const cancelAccepted = await receive("dd-isolated-cancel", 2, now - 50);
    await service.dispatchById(cancelAccepted.outboxId);
    await consumeLast("cancel_accept");
    const cancelled = await receive("dd-isolated-cancel", 5, now - 40, { cancel_reason: "商家取消" });
    await service.dispatchById(cancelled.outboxId);
    await consumeLast("cancelled");

    const complete = await receive("dd-isolated-complete", 4, now - 20);
    await service.dispatchById(complete.outboxId);
    await consumeLast("complete");

    const unknown = await receive("dd-isolated-unknown", 777, now - 20);
    await service.dispatchById(unknown.outboxId);
    await consumeLast("unknown");

    const returning = await receive("dd-isolated-returned", 9, now - 30);
    await service.dispatchById(returning.outboxId);
    await consumeLast("returning");
    const returned = await receive("dd-isolated-returned", 10, now - 20);
    await service.dispatchById(returned.outboxId);
    await consumeLast("returned");

    const query = normalizeDadaCityDeliveryQuery({
      order_status: 3,
      update_time: now - 10,
      dm_name: "查询骑手",
      dm_mobile: "000-0000-1962",
    }, {
      expectedClientId: CLIENT_ID,
      providerOrderId: "dd-isolated-active",
      observedAt: now,
    });
    const queried = await service.receive(query, now);
    await service.dispatchById(queried.outboxId);
    await consumeLast("query");

    const queueEvent = await receive("dd-isolated-queue", 2, now - 10);
    failQueue = true;
    let queueFailed = false;
    try {
      await service.dispatchById(queueEvent.outboxId);
    } catch {
      queueFailed = true;
    }
    failQueue = false;
    await withTx(container, (tx) => tx.update(cityDeliveryCallbackOutbox).set({
      availableTime: 0,
    }).where(eq(cityDeliveryCallbackOutbox.id, queueEvent.outboxId)));
    await service.dispatchPending(100);
    await consumeLast("queue_retry");
    const seededCases = await service.seedReconciliation(100);

    const [events, outboxes, watermarks, cases, orders, deliveries, statusRows] = await Promise.all([
      withTx(container, (tx) => tx.select().from(cityDeliveryCallbackEvent).orderBy(cityDeliveryCallbackEvent.id)),
      withTx(container, (tx) => tx.select().from(cityDeliveryCallbackOutbox).orderBy(cityDeliveryCallbackOutbox.id)),
      withTx(container, (tx) => tx.select().from(cityDeliveryCallbackWatermark).orderBy(cityDeliveryCallbackWatermark.subjectKeyHash)),
      withTx(container, (tx) => tx.select().from(cityDeliveryReconciliationCase).orderBy(cityDeliveryReconciliationCase.id)),
      withTx(container, (tx) => tx.select({ id: storeOrder.id, status: storeOrder.status, deliveryType: storeOrder.deliveryType,
        deliveryName: storeOrder.deliveryName, deliveryId: storeOrder.deliveryId }).from(storeOrder).orderBy(storeOrder.id)),
      withTx(container, (tx) => tx.select({ oid: storeDeliveryOrder.oid, status: storeDeliveryOrder.status,
        reason: storeDeliveryOrder.reason }).from(storeDeliveryOrder).orderBy(storeDeliveryOrder.id)),
      withTx(container, (tx) => tx.select({ oid: storeOrderStatus.oid, changeType: storeOrderStatus.changeType })
        .from(storeOrderStatus).orderBy(storeOrderStatus.id)),
    ]);
    const byOrder = new Map(orders.map((row) => [row.id, row]));
    const byDelivery = new Map(deliveries.map((row) => [row.oid, row]));
    const statusTypes = statusRows.map((row) => `${row.oid}:${row.changeType}`);
    const assertions = {
      duplicate_event_deduped: duplicate.duplicate && duplicate.eventId === activeAccepted.eventId,
      event_count_expected: events.length === 12,
      every_outbox_terminal: outboxes.length === 12 && outboxes.every((row) => ["COMPLETED", "DEAD"].includes(row.status)),
      pii_redacted: events.every((row) => !row.riderName && !row.riderMobile && !row.reasonText && !row.finishCode),
      active_monotonic: byOrder.get(IDS.active)?.status === 1 && byDelivery.get(IDS.active)?.status === 3,
      stale_superseded: events.some((row) => row.providerOrderId === "dd-isolated-active"
        && row.providerStatus === "1" && row.status === "SUPERSEDED"),
      late_cancel_conflict: events.some((row) => row.providerOrderId === "dd-isolated-active"
        && row.providerStatus === "5" && row.status === "CONFLICT"),
      cancel_before_pickup_reset: byOrder.get(IDS.cancel)?.status === 0
        && byOrder.get(IDS.cancel)?.deliveryType === "" && byDelivery.get(IDS.cancel)?.status === -1,
      precompleted_idempotent: byOrder.get(IDS.completed)?.status === 2 && byDelivery.get(IDS.completed)?.status === 4,
      unknown_ignored: events.some((row) => row.providerOrderId === "dd-isolated-unknown" && row.status === "IGNORED"),
      abnormal_return_completed: byOrder.get(IDS.returned)?.status === 0
        && byOrder.get(IDS.returned)?.deliveryType === "" && byDelivery.get(IDS.returned)?.status === 10,
      same_state_query_no_duplicate_log: statusTypes.filter((value) => value === `${IDS.active}:city_delivery_3`).length === 1,
      queue_failure_recovered: queueFailed && outboxes.some((row) => row.id === queueEvent.outboxId
        && row.dispatchCount >= 2 && row.status === "COMPLETED"),
      watermark_subjects_unique: watermarks.length === 6
        && new Set(watermarks.map((row) => row.subjectKeyHash)).size === watermarks.length,
      reconciliation_seeded: seededCases >= 1 && cases.length === seededCases,
      migration_idempotent: JSON.stringify(firstEvidence) === JSON.stringify(secondEvidence),
    };
    const failedAssertions = Object.entries(assertions)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (failedAssertions.length > 0) {
      throw new Error(`isolated_city_delivery_assertion_failed:${failedAssertions.join(",")}`);
    }
    result = {
      assertions,
      passed: Object.values(assertions).filter(Boolean).length,
      total: Object.keys(assertions).length,
      firstEvidence,
      secondEvidence,
    };
  } finally {
    if (db) {
      const underlying = (db as unknown as { $client?: { end(options?: { timeout?: number }): Promise<void> } }).$client;
      await underlying?.end({ timeout: 2 });
    }
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
    const publicAfter = await publicFingerprint(admin);
    const afterSchemas = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
    `;
    if (!result) result = {};
    result.schemaRemoved = afterSchemas[0]?.count === beforeSchemas[0]?.count;
    result.publicStateUnchanged = JSON.stringify(publicBefore) === JSON.stringify(publicAfter);
    await admin.end({ timeout: 2 });
  }
  return result;
}

async function migratePublic(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 2, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: "cinashop_city_delivery_public_migration" },
  });
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
  try {
    const publicBefore = await publicFingerprint(admin);
    const existing = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${TARGET_TABLES as unknown as string[]})
    `;
    if (![0, 4].includes(existing[0]?.count ?? -1)) throw new Error("partial_city_delivery_callback_schema_exists");
    db = createDbFromConnectionString(connectionString, 2, {
      searchPath: "public,pg_temp",
      applicationName: "cinashop_city_delivery_public_ddl",
    });
    const container = createContainerFromDb(db);
    const migration = new MigrationService(container).cityDeliveryCallbackPipelineMigrationSqlForVerification();
    await withTx(container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '30s'"));
      await tx.execute(sql.raw(migration));
    });
    const first = await schemaEvidence(admin, "public");
    await withTx(container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '30s'"));
      await tx.execute(sql.raw(migration));
    });
    const second = await schemaEvidence(admin, "public");
    const publicAfter = await publicFingerprint(admin);
    if (!first.complete || !second.complete || first.totalRows !== 0 || second.totalRows !== 0) {
      throw new Error("city_delivery_public_schema_verification_failed");
    }
    return {
      createdFromEmpty: existing[0]?.count === 0,
      first,
      second,
      idempotent: JSON.stringify(first) === JSON.stringify(second),
      businessDml: false,
      publicBusinessStateUnchanged: JSON.stringify(publicBefore) === JSON.stringify(publicAfter),
    };
  } finally {
    if (db) {
      const underlying = (db as unknown as { $client?: { end(options?: { timeout?: number }): Promise<void> } }).$client;
      await underlying?.end({ timeout: 2 });
    }
    await admin.end({ timeout: 2 });
  }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store, private" },
  });
}

function auditErrorChain(error: unknown) {
  const chain: Array<{ name: string; code: string; message: string }> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current) && chain.length < 4) {
    seen.add(current);
    const item = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    chain.push({
      name: String(item.name ?? "Error").slice(0, 64),
      code: String(item.code ?? "").slice(0, 64),
      message: String(item.message ?? "audit_failed").slice(0, 512),
    });
    current = item.cause;
  }
  return chain;
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const path = new URL(request.url).pathname;
    if (!["/audit", "/migrate", "/isolated-scenario"].includes(path)) return json({ error: "not_found" }, 404);
    const expected = path === "/audit" ? env.AUDIT_READ_TOKEN_SHA256
      : path === "/migrate" ? env.AUDIT_MIGRATE_TOKEN_SHA256
        : env.AUDIT_ISOLATED_TOKEN_SHA256;
    if (!await authorized(request, expected)) return json({ error: "unauthorized" }, 401);
    try {
      const result = path === "/audit"
        ? await readOnlyAudit(env.HYPERDRIVE.connectionString)
        : path === "/migrate"
          ? await migratePublic(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return json(result);
    } catch (error) {
      return json({ error: "audit_failed", chain: auditErrorChain(error) }, 500);
    }
  },
};
