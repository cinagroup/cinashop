import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { OrderMessage, PaymentCallbackMessage } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
} from "@/lib/di";
import { paymentCallbackEvent, paymentCallbackOutbox } from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import {
  PaymentCallbackEventService,
  type VerifiedPaymentCallback,
} from "@/services/payment/PaymentCallbackEventService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_MIGRATE_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const PREFIX = "codex_payment_callback_";
const TABLES = ["payment_callback_event", "payment_callback_outbox"] as const;
const EXPECTED_COLUMNS = {
  payment_callback_event: [
    "id", "provider", "profile", "provider_event_id", "replay_key", "payload_hash",
    "order_no", "transaction_id", "trade_state", "amount_cents", "currency",
    "provider_event_time", "order_domain", "status", "attempt_count", "lease_until",
    "lease_token", "last_error_code", "received_time", "processed_time", "retain_until",
    "update_time",
  ],
  payment_callback_outbox: [
    "id", "event_id", "replay_key", "status", "dispatch_count", "attempt_count",
    "available_time", "lease_until", "lease_token", "last_error_code", "enqueued_time",
    "processed_time", "add_time", "update_time",
  ],
} as const;
const EXPECTED_CONSTRAINTS = [
  "payment_callback_event_pkey",
  "payment_callback_outbox_pkey",
  "pce_business_ck",
  "pce_order_domain_ck",
  "pce_provider_profile_ck",
  "pce_replay_hash_ck",
  "pce_status_ck",
  "pce_time_count_ck",
  "pco_event_fk",
  "pco_replay_key_ck",
  "pco_status_ck",
  "pco_time_count_ck",
] as const;
const EXPECTED_INDEXES = [
  "payment_callback_event_pkey",
  "payment_callback_outbox_pkey",
  "pce_actionable_status",
  "pce_provider_event_uq",
  "pce_provider_transaction",
  "pce_replay_key_uq",
  "pce_retention_due",
  "pco_dispatch_ready",
  "pco_event_uq",
  "pco_expired_lease",
  "pco_replay_key_uq",
] as const;

function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function errorDetail(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message.replace(/[\r\n]+/g, " ").slice(0, 400));
      current = current.cause;
    } else {
      parts.push(String(current).replace(/[\r\n]+/g, " "));
      break;
    }
  }
  return parts.join(" | caused by: ").slice(0, 2000);
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = bytesFromHex(expectedHex);
  if (!expected) return false;
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  ));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function schemaEvidence(
  client: postgres.Sql,
  schema: string,
): Promise<{
  complete: boolean;
  tables: Array<{ table_name: string; row_count: number }>;
  columns: Array<{ table_name: string; columns: string[] }>;
  constraints: Array<{
    name: string;
    definition: string;
    type: string;
    validated: boolean;
    no_inherit: boolean;
    delete_action: string;
  }>;
  indexes: Array<{ name: string; definition: string }>;
}> {
  const relations = await client<Array<{ table_name: string; relkind: string; relpersistence: string }>>`
    SELECT relation.relname AS table_name, relation.relkind, relation.relpersistence
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY relation.relname
  `;
  const tableRows: Array<{ table_name: string; row_count: number }> = [];
  for (const table of TABLES) {
    if (relations.some((row) => row.table_name === table)) {
      const count = await client.unsafe<Array<{ count: number }>>(
        `SELECT count(*)::integer AS count FROM "${schema}"."${table}"`,
      );
      tableRows.push({ table_name: table, row_count: count[0]?.count ?? -1 });
    }
  }
  const columnRows = await client<Array<{ table_name: string; column_name: string; ordinal_position: number }>>`
    SELECT table_name, column_name, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name IN ${client([...TABLES])}
    ORDER BY table_name, ordinal_position
  `;
  const columns = TABLES.map((table) => ({
    table_name: table,
    columns: columnRows.filter((row) => row.table_name === table).map((row) => row.column_name),
  }));
  const constraints = await client<Array<{
    name: string;
    definition: string;
    type: string;
    validated: boolean;
    no_inherit: boolean;
    delete_action: string;
  }>>`
    SELECT constraint_row.conname AS name,
      pg_get_constraintdef(constraint_row.oid) AS definition,
      constraint_row.contype::text AS type,
      constraint_row.convalidated AS validated,
      constraint_row.connoinherit AS no_inherit,
      constraint_row.confdeltype::text AS delete_action
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY constraint_row.conname
  `;
  const indexes = await client<Array<{ name: string; definition: string }>>`
    SELECT indexname AS name, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = ${schema} AND tablename IN ${client([...TABLES])}
    ORDER BY indexname
  `;
  const relationShapeReady = relations.length === 2
    && relations.every((row) => row.relkind === "r" && row.relpersistence === "p");
  const columnShapeReady = columns.every((row) =>
    JSON.stringify(row.columns) === JSON.stringify(
      EXPECTED_COLUMNS[row.table_name as keyof typeof EXPECTED_COLUMNS],
    ));
  const constraintNames = constraints.map((row) => row.name);
  const indexNames = indexes.map((row) => row.name);
  const constraintShapeReady = JSON.stringify(constraintNames)
    === JSON.stringify([...EXPECTED_CONSTRAINTS].sort());
  const indexShapeReady = JSON.stringify(indexNames) === JSON.stringify([...EXPECTED_INDEXES].sort());
  const foreignKeyReady = constraints.some((row) =>
    row.name === "pco_event_fk"
    && /FOREIGN KEY \(event_id\).*payment_callback_event\(id\).*ON DELETE RESTRICT/i
      .test(row.definition));
  const predicateIndexesReady = indexes.some((row) =>
    row.name === "pco_dispatch_ready" && /WHERE.*status.*PENDING.*FAILED/i.test(row.definition))
    && indexes.some((row) =>
      row.name === "pco_expired_lease" && /WHERE.*ENQUEUING.*ENQUEUED.*PROCESSING/i.test(row.definition));
  return {
    complete: relationShapeReady && columnShapeReady && constraintShapeReady
      && indexShapeReady && foreignKeyReady && predicateIndexesReady,
    tables: tableRows,
    columns,
    constraints,
    indexes,
  };
}

async function productionAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_payment_callback_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const version = await tx<Array<{ version: string }>>`SELECT version()`;
      const evidence = await schemaEvidence(tx as unknown as postgres.Sql, "public");
      return { engine: version[0]?.version ?? "unknown", ...evidence };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function migrateProduction(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_payment_callback_migration",
  });
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_payment_callback_migration_verify" },
  });
  try {
    const before = await schemaEvidence(admin, "public");
    if (before.tables.length === 1) throw new Error("partial_payment_callback_schema_exists");
    if (before.tables.length === 2 && !before.complete) {
      throw new Error("payment_callback_schema_collision");
    }
    const migration = new MigrationService(createContainerFromDb(db))
      .paymentCallbackPipelineMigrationSqlForVerification();
    await withTx(createContainerFromDb(db), async (tx) => {
      await tx.execute(sql.raw(migration));
    });
    const afterFirst = await schemaEvidence(admin, "public");
    if (!afterFirst.complete) throw new Error("payment_callback_schema_verification_failed");
    await withTx(createContainerFromDb(db), async (tx) => {
      await tx.execute(sql.raw(migration));
    });
    const afterSecond = await schemaEvidence(admin, "public");
    if (!afterSecond.complete || JSON.stringify(afterFirst.columns) !== JSON.stringify(afterSecond.columns)) {
      throw new Error("payment_callback_migration_not_idempotent");
    }
    return {
      complete: true,
      created: before.tables.length === 0,
      idempotent_second_pass: true,
      evidence: afterSecond,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
    await admin.end({ timeout: 1 });
  }
}

function callback(
  suffix: string,
  overrides: Partial<VerifiedPaymentCallback> = {},
): VerifiedPaymentCallback {
  return {
    provider: "wechat",
    profile: "wechat",
    providerEventId: `event-${suffix}`,
    orderNo: `order-${suffix}`,
    transactionId: `transaction-${suffix}`,
    tradeState: "SUCCESS",
    amountCents: 100,
    currency: "CNY",
    providerEventTime: 1_800_000_000,
    ...overrides,
  };
}

function queueMessage(received: {
  eventId: number;
  replayKey: string;
}): PaymentCallbackMessage {
  return {
    action: "processPaymentCallback",
    eventId: received.eventId,
    replayKey: received.replayKey,
  };
}

async function isolatedScenario(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 5,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_payment_callback_isolated_admin" },
  });
  const schema = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
  const beforeSchemas = await admin<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
  `;
  let result: Record<string, unknown> | undefined;
  let cleanupVerified = false;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    db = createDbFromConnectionString(connectionString, 5, {
      searchPath: schema,
      applicationName: "cinashop_payment_callback_isolated",
    });
    const container = createContainerFromDb(db);
    const migration = new MigrationService(container)
      .paymentCallbackPipelineMigrationSqlForVerification();
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    await withTx(container, (tx) => tx.execute(sql.raw(
      new MigrationService(container).paymentReconciliationMigrationSqlForVerification(),
    )));
    const firstEvidence = await schemaEvidence(admin, schema);
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const secondEvidence = await schemaEvidence(admin, schema);
    if (!firstEvidence.complete || !secondEvidence.complete) {
      throw new Error("isolated_migration_shape_failed");
    }

    const sent: unknown[] = [];
    let failQueue = false;
    const queue = {
      async sendBatch(messages: Array<{ body: unknown }>) {
        if (failQueue) throw new Error("injected_queue_failure");
        sent.push(...messages.map((message) => message.body));
      },
    } as unknown as Queue<OrderMessage>;

    let settlementCalls = 0;
    const service = new PaymentCallbackEventService(container, { ORDER_QUEUE: queue }, async () => {
      settlementCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: "completed", domain: "store_order", errorCode: "" };
    });
    const duplicateInput = callback("duplicate");
    const duplicateResults = await Promise.all([
      service.receive(duplicateInput),
      service.receive(duplicateInput),
    ]);
    const canonicalReceive = duplicateResults.find((item) => !item.duplicate) ?? duplicateResults[0];
    const duplicateCounts = await withTx(container, (tx) => tx.execute(sql`
        SELECT
          (SELECT count(*)::integer FROM payment_callback_event
            WHERE provider_event_id = ${duplicateInput.providerEventId}) AS event_count,
          (SELECT count(*)::integer FROM payment_callback_outbox
            WHERE event_id = ${canonicalReceive.eventId}) AS outbox_count
      `)) as unknown as Array<{ event_count: number; outbox_count: number }>;
    await service.dispatchById(canonicalReceive.outboxId);
    const processResults = await Promise.all([
      service.processMessage(queueMessage(canonicalReceive)),
      service.processMessage(queueMessage(canonicalReceive)),
    ]);
    const replayResult = await service.processMessage(queueMessage(canonicalReceive));

    const conflictBase = await service.receive(callback("conflict-a", {
      transactionId: "transaction-conflict",
      orderNo: "order-conflict-a",
    }));
    const conflict = await service.receive(callback("conflict-b", {
      transactionId: "transaction-conflict",
      orderNo: "order-conflict-b",
    }));
    const conflictRows = await withTx(container, (tx) => tx.select({
        status: paymentCallbackEvent.status,
        error: paymentCallbackEvent.lastErrorCode,
      }).from(paymentCallbackEvent).where(sql`${paymentCallbackEvent.id} IN (
        ${conflictBase.eventId}, ${conflict.eventId}
      )`).orderBy(paymentCallbackEvent.id));

    const queueFailure = await service.receive(callback("queue-failure"));
    failQueue = true;
    let queueFailureCaptured = false;
    try {
      await service.dispatchById(queueFailure.outboxId);
    } catch {
      queueFailureCaptured = true;
    }
    failQueue = false;
    const queueFailureRows = await withTx(container, (tx) => tx.select({
        status: paymentCallbackOutbox.status,
        error: paymentCallbackOutbox.lastErrorCode,
      }).from(paymentCallbackOutbox)
        .where(sql`${paymentCallbackOutbox.id} = ${queueFailure.outboxId}`));
    await withTx(container, (tx) => tx.update(paymentCallbackOutbox).set({ availableTime: 0 })
      .where(sql`${paymentCallbackOutbox.id} = ${queueFailure.outboxId}`));
    const queueRecovery = await service.dispatchById(queueFailure.outboxId);
    const queueRecoveryRows = await withTx(container, (tx) => tx.select({
        status: paymentCallbackOutbox.status,
        error: paymentCallbackOutbox.lastErrorCode,
      }).from(paymentCallbackOutbox)
        .where(sql`${paymentCallbackOutbox.id} = ${queueFailure.outboxId}`));

    await withTx(container, (tx) => tx.execute(sql.raw(`
        CREATE FUNCTION fail_payment_callback_outbox() RETURNS trigger
        LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'injected persistence failure'; END $fn$;
        CREATE TRIGGER fail_payment_callback_outbox_trigger
          BEFORE INSERT ON payment_callback_outbox
          FOR EACH ROW EXECUTE FUNCTION fail_payment_callback_outbox();
      `)));
    let persistenceFailureCaptured = false;
    try {
      await service.receive(callback("persistence-failure"));
    } catch {
      persistenceFailureCaptured = true;
    }
    const rolledBack = await withTx(container, (tx) => tx.execute(sql`
        SELECT count(*)::integer AS count FROM payment_callback_event
        WHERE provider_event_id = 'event-persistence-failure'
      `)) as unknown as Array<{ count: number }>;
    await withTx(container, (tx) => tx.execute(sql.raw(`
        DROP TRIGGER fail_payment_callback_outbox_trigger ON payment_callback_outbox;
        DROP FUNCTION fail_payment_callback_outbox();
      `)));

    await withTx(container, (tx) => tx.execute(sql.raw(`
        CREATE TABLE payment_callback_audit_settlement (
          transaction_id VARCHAR(100) PRIMARY KEY,
          add_time INTEGER NOT NULL
        );
      `)));
    let crashOnce = true;
    const crashService = new PaymentCallbackEventService(container, { ORDER_QUEUE: queue }, async (item) => {
      await withTx(container, (tx) => tx.execute(sql`
          INSERT INTO payment_callback_audit_settlement (transaction_id, add_time)
          VALUES (${item.transactionId}, ${Math.floor(Date.now() / 1000)})
          ON CONFLICT (transaction_id) DO NOTHING
        `));
      if (crashOnce) {
        crashOnce = false;
        throw new Error("injected_crash_after_settlement");
      }
      return { status: "completed", domain: "store_order", errorCode: "" };
    });
    const crash = await crashService.receive(callback("crash-replay"));
    let crashCaptured = false;
    try {
      await crashService.processMessage(queueMessage(crash));
    } catch {
      crashCaptured = true;
    }
    await withTx(container, (tx) => tx.update(paymentCallbackOutbox).set({ availableTime: 0 })
      .where(sql`${paymentCallbackOutbox.id} = ${crash.outboxId}`));
    const crashReplayResult = await crashService.processMessage(queueMessage(crash));
    const settlementRows = await withTx(container, (tx) => tx.execute(sql`
        SELECT count(*)::integer AS count FROM payment_callback_audit_settlement
        WHERE transaction_id = 'transaction-crash-replay'
      `)) as unknown as Array<{ count: number }>;

    const deadService = new PaymentCallbackEventService(container, { ORDER_QUEUE: queue }, async () => {
      throw new Error("injected_transient_storage_failure");
    });
    const dead = await deadService.receive(callback("dead"));
    let deadResult: unknown = "not-run";
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        deadResult = await deadService.processMessage(queueMessage(dead));
      } catch {
        deadResult = "retry";
      }
      await withTx(container, (tx) => tx.update(paymentCallbackOutbox).set({ availableTime: 0 })
        .where(sql`${paymentCallbackOutbox.id} = ${dead.outboxId}`));
    }
    const deadRows = await withTx(container, (tx) => tx.execute(sql`
        SELECT event_row.status AS event_status,
          outbox_row.status AS outbox_status,
          event_row.attempt_count,
          event_row.last_error_code
        FROM payment_callback_event AS event_row
        JOIN payment_callback_outbox AS outbox_row ON outbox_row.event_id = event_row.id
        WHERE event_row.id = ${dead.eventId}
      `)) as unknown as Array<{
      event_status: string;
      outbox_status: string;
      attempt_count: number;
      last_error_code: string;
    }>;

    let replayFailures = 0;
    const replayService = new PaymentCallbackEventService(container, { ORDER_QUEUE: queue }, async () => {
      replayFailures += 1;
      if (replayFailures <= 3) throw new Error("injected_dlq_failure");
      return { status: "completed", domain: "store_order", errorCode: "" };
    });
    const dlqReplay = await replayService.receive(callback("dlq-replay"));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await replayService.processMessage(queueMessage(dlqReplay));
      } catch {
        // Mirrors the main Queue's max_retries=3 path into the durable DLQ.
      }
      await withTx(container, (tx) => tx.update(paymentCallbackOutbox).set({ availableTime: 0 })
        .where(sql`${paymentCallbackOutbox.id} = ${dlqReplay.outboxId}`));
    }
    // The admin DLQ replay sends the same sanitized opaque body back to ORDER_QUEUE.
    const dlqReplayResult = await replayService.processMessage(queueMessage(dlqReplay));
    const dlqReplayRows = await withTx(container, (tx) => tx.select({
        eventStatus: paymentCallbackEvent.status,
        attemptCount: paymentCallbackEvent.attemptCount,
      }).from(paymentCallbackEvent)
        .where(sql`${paymentCallbackEvent.id} = ${dlqReplay.eventId}`));

    const ignored = await service.receive(callback("ignored", {
      provider: "alipay",
      profile: "alipay",
      tradeState: "WAIT_BUYER_PAY",
    }));
    const ignoredResult = await service.processMessage(queueMessage(ignored));
    const ignoredRows = await withTx(container, (tx) => tx
      .select({ status: paymentCallbackEvent.status })
      .from(paymentCallbackEvent).where(sql`${paymentCallbackEvent.id} = ${ignored.eventId}`));

    const assertions = {
      migration_shape_exact_and_idempotent:
        firstEvidence.complete && secondEvidence.complete
        && JSON.stringify(firstEvidence.columns) === JSON.stringify(secondEvidence.columns),
      duplicate_receive_is_atomic:
        duplicateResults.filter((item) => item.duplicate).length === 1
        && duplicateCounts[0]?.event_count === 1
        && duplicateCounts[0]?.outbox_count === 1,
      queue_payload_is_opaque:
        sent.length === 2
        && sent.every((item) => JSON.stringify(Object.keys(item as object).sort())
          === JSON.stringify(["action", "eventId", "replayKey"])),
      concurrent_consumer_settles_once:
        settlementCalls === 1
        && processResults.includes("completed")
        && processResults.includes("busy")
        && replayResult === "already-completed",
      transaction_conflict_is_terminal:
        !conflictBase.terminalConflict
        && conflict.terminalConflict
        && conflictRows[1]?.status === "UNKNOWN"
        && conflictRows[1]?.error === "transaction_evidence_conflict",
      queue_failure_is_durable:
        queueFailureCaptured
        && queueFailureRows[0]?.status === "FAILED"
        && queueFailureRows[0]?.error === "queue_dispatch_failed"
        && queueRecovery.enqueued === 1
        && queueRecoveryRows[0]?.status === "ENQUEUED"
        && queueRecoveryRows[0]?.error === "",
      ingress_transaction_rolls_back_on_outbox_failure:
        persistenceFailureCaptured && rolledBack[0]?.count === 0,
      crash_after_settlement_replays_idempotently:
        crashCaptured
        && crashReplayResult === "completed"
        && settlementRows[0]?.count === 1,
      attempts_exhaust_to_dead:
        deadResult === "dead"
        && deadRows[0]?.event_status === "DEAD"
        && deadRows[0]?.outbox_status === "DEAD"
        && deadRows[0]?.attempt_count === 8
        && deadRows[0]?.last_error_code === "injected_transient_storage_failure",
      dlq_replay_resumes_same_durable_event:
        replayFailures === 4
        && dlqReplayResult === "completed"
        && dlqReplayRows[0]?.eventStatus === "COMPLETED"
        && dlqReplayRows[0]?.attemptCount === 4,
      non_success_payment_is_ignored:
        ignoredResult === "ignored" && ignoredRows[0]?.status === "IGNORED",
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
    }
    result = {
      complete: true,
      checks_passed: Object.keys(assertions).length,
      expected_checks: Object.keys(assertions).length,
      assertions,
      evidence: secondEvidence,
      status: {
        conflict: conflictRows,
        queue_failure: queueFailureRows,
        queue_recovery: queueRecoveryRows,
        dead: deadRows,
        dlq_replay: dlqReplayRows,
      },
    };
  } finally {
    if (db) await db.$client.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const afterSchemas = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
    `;
    const removed = await admin<Array<{ removed: boolean }>>`
      SELECT to_regnamespace(${schema}) IS NULL AS removed
    `;
    if (afterSchemas[0]?.count !== beforeSchemas[0]?.count || !removed[0]?.removed) {
      throw new Error("temporary_schema_cleanup_failed");
    }
    cleanupVerified = true;
    await admin.end({ timeout: 1 });
  }
  if (!result) throw new Error("isolated_scenario_produced_no_result");
  return { ...result, temporary_schema_removed: cleanupVerified };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !["/audit", "/migrate", "/isolated"].includes(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const expected = url.pathname === "/audit"
      ? env.AUDIT_READ_TOKEN_SHA256
      : url.pathname === "/migrate"
        ? env.AUDIT_MIGRATE_TOKEN_SHA256
        : env.AUDIT_ISOLATED_TOKEN_SHA256;
    if (!(await authorized(request, expected ?? ""))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/audit"
        ? await productionAudit(env.HYPERDRIVE.connectionString)
        : url.pathname === "/migrate"
          ? await migrateProduction(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      console.error(JSON.stringify({
        event: "payment_callback_pipeline_audit_failed",
        error: error instanceof Error && /^[a-z0-9_ :.,{}"-]{1,1000}$/i.test(error.message)
          ? error.message
          : "audit_failed",
      }));
      return Response.json({
        error: "audit failed",
        detail: errorDetail(error),
      }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
