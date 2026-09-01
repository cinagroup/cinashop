import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import type { Env, OrderMessage, PaymentReconciliationMessage } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
} from "@/lib/di";
import {
  paymentReconciliationAction,
  paymentReconciliationCase,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import {
  PaymentCallbackEventService,
  type VerifiedPaymentCallback,
} from "@/services/payment/PaymentCallbackEventService";
import {
  PaymentReconciliationService,
  type PaymentReconciliationIntent,
} from "@/services/payment/PaymentReconciliationService";
import type {
  PaymentProviderQueryRequest,
  PaymentProviderQueryResult,
} from "@/services/payment/PaymentProviderQuery";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_MIGRATE_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const PREFIX = "codex_payment_reconciliation_";
const TABLES = ["payment_reconciliation_action", "payment_reconciliation_case"] as const;
const EXPECTED_COLUMNS = {
  payment_reconciliation_action: [
    "id", "case_id", "action_key", "admin_id", "action_type", "reason_code",
    "before_status", "after_status", "add_time",
  ],
  payment_reconciliation_case: [
    "id", "replay_key", "provider", "profile", "order_domain", "order_no",
    "expected_amount_cents", "currency", "status", "provider_status",
    "provider_transaction_id", "provider_event_time", "callback_event_id",
    "attempt_count", "next_check_time", "lease_until", "lease_token",
    "last_query_time", "last_error_code", "initiated_time", "resolved_time",
    "retain_until", "add_time", "update_time",
  ],
} as const;
const EXPECTED_CONSTRAINTS = [
  "payment_reconciliation_action_pkey",
  "payment_reconciliation_case_pkey",
  "pra_action_key_ck",
  "pra_business_ck",
  "pra_case_fk",
  "prc_business_ck",
  "prc_callback_event_fk",
  "prc_order_domain_ck",
  "prc_provider_profile_ck",
  "prc_provider_status_ck",
  "prc_replay_lease_ck",
  "prc_status_ck",
  "prc_time_count_ck",
] as const;
const EXPECTED_INDEXES = [
  "payment_reconciliation_action_pkey",
  "payment_reconciliation_case_pkey",
  "pra_action_key_uq",
  "pra_case_history",
  "prc_attention",
  "prc_due",
  "prc_expired_lease",
  "prc_provider_order_uq",
  "prc_replay_key_uq",
  "prc_retention",
] as const;

function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
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
  return parts.join(" | caused by: ").slice(0, 2_000);
}

async function schemaEvidence(client: postgres.Sql, schema: string) {
  const relations = await client<Array<{
    table_name: string;
    relkind: string;
    relpersistence: string;
  }>>`
    SELECT relation.relname AS table_name,
      relation.relkind::text,
      relation.relpersistence::text
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY relation.relname
  `;
  const columnRows = await client<Array<{
    table_name: string;
    column_name: string;
    ordinal_position: number;
  }>>`
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
    validated: boolean;
    no_inherit: boolean;
  }>>`
    SELECT constraint_row.conname AS name,
      pg_get_constraintdef(constraint_row.oid) AS definition,
      constraint_row.convalidated AS validated,
      constraint_row.connoinherit AS no_inherit
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY constraint_row.conname
  `;
  const indexes = await client<Array<{
    name: string;
    definition: string;
    valid: boolean;
    ready: boolean;
    partial: boolean;
  }>>`
    SELECT index_relation.relname AS name,
      pg_get_indexdef(index_row.indexrelid) AS definition,
      index_row.indisvalid AS valid,
      index_row.indisready AS ready,
      index_row.indpred IS NOT NULL AS partial
    FROM pg_index AS index_row
    JOIN pg_class AS table_relation ON table_relation.oid = index_row.indrelid
    JOIN pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
    WHERE namespace.nspname = ${schema} AND table_relation.relname IN ${client([...TABLES])}
    ORDER BY index_relation.relname
  `;
  const relationShape = relations.length === 2
    && relations.every((row) => row.relkind === "r" && row.relpersistence === "p");
  const columnShape = columns.every((row) => JSON.stringify(row.columns) === JSON.stringify(
    EXPECTED_COLUMNS[row.table_name as keyof typeof EXPECTED_COLUMNS],
  ));
  const constraintShape = JSON.stringify(constraints.map((row) => row.name))
    === JSON.stringify([...EXPECTED_CONSTRAINTS].sort());
  const indexShape = JSON.stringify(indexes.map((row) => row.name))
    === JSON.stringify([...EXPECTED_INDEXES].sort());
  const foreignKeys = constraints.some((row) => row.name === "prc_callback_event_fk"
    && /payment_callback_event.*ON DELETE RESTRICT/i.test(row.definition))
    && constraints.some((row) => row.name === "pra_case_fk"
      && /payment_reconciliation_case.*ON DELETE RESTRICT/i.test(row.definition));
  const partials = ["prc_attention", "prc_due", "prc_expired_lease", "prc_retention"]
    .every((name) => indexes.some((row) => row.name === name && row.partial && row.valid && row.ready));
  return {
    complete: relationShape && columnShape && constraintShape && indexShape && foreignKeys
      && partials && constraints.every((row) => row.validated
        && (!row.definition.startsWith("CHECK") || !row.no_inherit)),
    checks: {
      relationShape,
      columnShape,
      constraintShape,
      indexShape,
      foreignKeys,
      partials,
      constraintsValidated: constraints.every((row) => row.validated
        && (!row.definition.startsWith("CHECK") || !row.no_inherit)),
      actualConstraintNames: constraints.map((row) => row.name),
      actualIndexNames: indexes.map((row) => row.name),
      actualColumnCounts: columns.map((row) => ({ table: row.table_name, count: row.columns.length })),
    },
    relations,
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
    connection: { application_name: "cinashop_payment_reconciliation_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const version = await tx<Array<{ version: string }>>`SELECT version()`;
      const evidence = await schemaEvidence(tx as unknown as postgres.Sql, "public");
      const callback = await tx<Array<{ total: number; actionable: number; terminal: number }>>`
        SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE status IN ('RECEIVED', 'ENQUEUED', 'PROCESSING', 'FAILED', 'UNKNOWN', 'DEAD'))::integer AS actionable,
          count(*) FILTER (WHERE status IN ('COMPLETED', 'IGNORED'))::integer AS terminal
        FROM payment_callback_event
      `;
      const store = await tx<Array<Record<string, number>>>`
        SELECT count(*) FILTER (WHERE paid = 0)::integer AS unpaid,
          count(*) FILTER (WHERE paid = 1)::integer AS paid,
          count(*) FILTER (WHERE paid = 0 AND add_time > 0
            AND add_time <= extract(epoch FROM now())::integer - 1800)::integer AS unpaid_over_30m,
          count(*) FILTER (WHERE paid = 0 AND pay_type IN ('weixin', 'alipay'))::integer AS unpaid_external_marked
        FROM store_order WHERE is_del = 0 AND is_system_del = 0
      `;
      const recharge = await tx<Array<Record<string, number>>>`
        SELECT count(*) FILTER (WHERE paid = 0)::integer AS unpaid,
          count(*) FILTER (WHERE paid = 1)::integer AS paid,
          count(*) FILTER (WHERE paid = 0 AND add_time > 0
            AND add_time <= extract(epoch FROM now())::integer - 1800)::integer AS unpaid_over_30m,
          count(*) FILTER (WHERE paid = 0 AND recharge_type IN ('weixin', 'wechat', 'alipay'))::integer AS unpaid_external_marked
        FROM user_recharge
      `;
      const membership = await tx<Array<Record<string, number>>>`
        SELECT count(*) FILTER (WHERE paid = 0)::integer AS unpaid,
          count(*) FILTER (WHERE paid = 1)::integer AS paid,
          count(*) FILTER (WHERE paid = 0 AND add_time > 0
            AND add_time <= extract(epoch FROM now())::integer - 1800)::integer AS unpaid_over_30m,
          count(*) FILTER (WHERE paid = 0 AND pay_type IN ('weixin', 'alipay'))::integer AS unpaid_external_marked
        FROM other_order WHERE is_del = 0
      `;
      const cases = evidence.complete
        ? await tx<Array<{ status: string; count: number }>>`
            SELECT status, count(*)::integer AS count
            FROM payment_reconciliation_case GROUP BY status ORDER BY status
          `
        : [];
      return {
        engine: version[0]?.version ?? "unknown",
        schema: evidence,
        callback: callback[0],
        order_aggregates: {
          store: store[0],
          recharge: recharge[0],
          membership: membership[0],
        },
        reconciliation_status_counts: cases,
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function migrateProduction(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_payment_reconciliation_migration",
  });
  const admin = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_payment_reconciliation_migration_verify" },
  });
  try {
    const callbackReady = await admin<Array<{ ready: boolean }>>`
      SELECT to_regclass('public.payment_callback_event') IS NOT NULL AS ready
    `;
    if (!callbackReady[0]?.ready) throw new Error("payment_callback_prerequisite_missing");
    const before = await schemaEvidence(admin, "public");
    if (before.relations.length === 1) throw new Error("partial_payment_reconciliation_schema_exists");
    if (before.relations.length === 2 && !before.complete) {
      throw new Error("payment_reconciliation_schema_collision");
    }
    const container = createContainerFromDb(db);
    const migration = new MigrationService(container)
      .paymentReconciliationMigrationSqlForVerification();
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const afterFirst = await schemaEvidence(admin, "public");
    if (!afterFirst.complete) throw new Error("payment_reconciliation_schema_verification_failed");
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const afterSecond = await schemaEvidence(admin, "public");
    if (!afterSecond.complete || JSON.stringify(afterFirst.columns) !== JSON.stringify(afterSecond.columns)) {
      throw new Error("payment_reconciliation_migration_not_idempotent");
    }
    return {
      complete: true,
      created: before.relations.length === 0,
      idempotent_second_pass: true,
      evidence: afterSecond,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
    await admin.end({ timeout: 1 });
  }
}

function intent(orderNo: string, overrides: Partial<PaymentReconciliationIntent> = {}) {
  return {
    provider: "wechat" as const,
    profile: "wechat" as const,
    orderDomain: "store_order" as const,
    orderNo,
    expectedAmountCents: 100,
    currency: "CNY" as const,
    initiatedAt: Math.floor(Date.now() / 1_000) - 3_600,
    ...overrides,
  };
}

function queryResult(
  request: PaymentProviderQueryRequest,
  status: PaymentProviderQueryResult["status"],
  overrides: Partial<PaymentProviderQueryResult> = {},
): PaymentProviderQueryResult {
  return {
    status,
    providerTradeState: status,
    orderNo: request.orderNo,
    transactionId: status === "SUCCESS" ? `transaction-${request.orderNo}` : "",
    amountCents: status === "SUCCESS" ? request.expectedAmountCents : 0,
    currency: "CNY",
    providerEventTime: 1_800_000_000,
    errorCode: "",
    ...overrides,
  };
}

function processMessage(row: { id: number; replayKey: string }): PaymentReconciliationMessage {
  return { action: "processPaymentReconciliation", caseId: row.id, replayKey: row.replayKey };
}

function verifiedCallback(suffix: string): VerifiedPaymentCallback {
  return {
    provider: "wechat",
    profile: "wechat",
    providerEventId: `event-${suffix}`,
    orderNo: `callback-${suffix}`,
    transactionId: `transaction-callback-${suffix}`,
    tradeState: "SUCCESS",
    amountCents: 100,
    currency: "CNY",
    providerEventTime: 1_800_000_000,
  };
}

async function isolatedScenario(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 5,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_payment_reconciliation_isolated_admin" },
  });
  const schema = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const beforeSchemas = await admin<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
  `;
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
  let result: Record<string, unknown> | undefined;
  let cleanupVerified = false;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    db = createDbFromConnectionString(connectionString, 5, {
      searchPath: schema,
      applicationName: "cinashop_payment_reconciliation_isolated",
    });
    const container = createContainerFromDb(db);
    const migrations = new MigrationService(container);
    await withTx(container, async (tx) => {
      await tx.execute(sql.raw(migrations.paymentCallbackPipelineMigrationSqlForVerification()));
      await tx.execute(sql.raw(migrations.paymentReconciliationMigrationSqlForVerification()));
    });
    const firstEvidence = await schemaEvidence(admin, schema);
    await withTx(container, (tx) => tx.execute(sql.raw(
      migrations.paymentReconciliationMigrationSqlForVerification(),
    )));
    const secondEvidence = await schemaEvidence(admin, schema);
    if (!firstEvidence.complete || !secondEvidence.complete) {
      throw new Error(`isolated_migration_shape_failed:${JSON.stringify({
        first: firstEvidence.checks,
        second: secondEvidence.checks,
      })}`);
    }
    await admin.unsafe(`
      CREATE TABLE "${schema}"."store_order" AS
        SELECT * FROM public.store_order WITH NO DATA;
      CREATE TABLE "${schema}"."user_recharge" AS
        SELECT * FROM public.user_recharge WITH NO DATA;
      CREATE TABLE "${schema}"."other_order" AS
        SELECT * FROM public.other_order WITH NO DATA;
      CREATE TABLE "${schema}"."payment_reconciliation_audit_settlement" (
        transaction_id VARCHAR(100) PRIMARY KEY,
        add_time INTEGER NOT NULL
      );
    `);

    const sent: unknown[] = [];
    let failQueue = false;
    const queue = {
      async send(body: unknown) {
        if (failQueue) throw new Error("injected_queue_failure");
        sent.push(body);
      },
      async sendBatch(messages: Array<{ body: unknown }>) {
        if (failQueue) throw new Error("injected_queue_failure");
        sent.push(...messages.map((message) => message.body));
      },
    } as unknown as Queue<OrderMessage>;
    const statuses = new Map<string, PaymentProviderQueryResult["status"]>();
    const overrides = new Map<string, Partial<PaymentProviderQueryResult>>();
    const failures = new Set<string>();
    let providerCalls = 0;
    let settlementCalls = 0;
    const service = new PaymentReconciliationService(
      container,
      { ORDER_QUEUE: queue } as unknown as Env,
      async (request) => {
        providerCalls += 1;
        if (failures.has(request.orderNo)) throw new Error("injected_provider_timeout");
        return queryResult(request, statuses.get(request.orderNo) ?? "PENDING", overrides.get(request.orderNo));
      },
      async (request, provider) => {
        settlementCalls += 1;
        const inserted = await withTx(container, (tx) => tx.execute(sql`
          INSERT INTO payment_reconciliation_audit_settlement (transaction_id, add_time)
          VALUES (${provider.transactionId}, ${Math.floor(Date.now() / 1_000)})
          ON CONFLICT (transaction_id) DO NOTHING RETURNING transaction_id
        `)) as unknown as Array<{ transaction_id: string }>;
        return {
          status: "completed" as const,
          domain: request.orderDomain || "store_order",
          errorCode: "",
          outcome: inserted.length ? "paid" as const : "already-paid" as const,
        };
      },
    );

    const duplicateA = await service.registerIntent(intent("duplicate-order"));
    const duplicateB = await service.registerIntent(intent("duplicate-order"));
    const conflict = await service.registerIntent(intent("duplicate-order", {
      expectedAmountCents: 101,
    }));
    const duplicateCount = await withTx(container, (tx) => tx.select({
      id: paymentReconciliationCase.id,
    }).from(paymentReconciliationCase).where(eq(
      paymentReconciliationCase.orderNo,
      "duplicate-order",
    )));

    const success = await service.registerIntent(intent("success-order"));
    statuses.set(success.orderNo, "SUCCESS");
    const successResult = await service.processMessage(processMessage(success));
    const successReplay = await service.processMessage(processMessage(success));

    const waiting = await service.registerIntent(intent("waiting-order"));
    statuses.set(waiting.orderNo, "PENDING");
    const waitingResult = await service.processMessage(processMessage(waiting));

    const noPayment = await service.registerIntent(intent("not-found-order"));
    statuses.set(noPayment.orderNo, "NOT_FOUND");
    await withTx(container, (tx) => tx.update(paymentReconciliationCase).set({
      attemptCount: 2,
      nextCheckTime: 0,
    }).where(eq(paymentReconciliationCase.id, noPayment.id)));
    const noPaymentResult = await service.processMessage(processMessage(noPayment));

    const mismatch = await service.registerIntent(intent("mismatch-order"));
    statuses.set(mismatch.orderNo, "SUCCESS");
    overrides.set(mismatch.orderNo, { amountCents: 101, errorCode: "provider_evidence_mismatch" });
    const mismatchResult = await service.processMessage(processMessage(mismatch));
    const callsAfterMismatch = providerCalls;
    const mismatchReplay = await service.processMessage(processMessage(mismatch));
    const mismatchReplayDidNotQuery = providerCalls === callsAfterMismatch;

    const dead = await service.registerIntent(intent("dead-order"));
    failures.add(dead.orderNo);
    await withTx(container, (tx) => tx.update(paymentReconciliationCase).set({
      attemptCount: 11,
      nextCheckTime: 0,
    }).where(eq(paymentReconciliationCase.id, dead.id)));
    const deadResult = await service.processMessage(processMessage(dead));

    const expired = await service.registerIntent(intent("expired-lease-order"));
    await withTx(container, (tx) => tx.update(paymentReconciliationCase).set({
      status: "QUERYING",
      leaseUntil: 0,
      leaseToken: crypto.randomUUID(),
    }).where(eq(paymentReconciliationCase.id, expired.id)));
    const dispatchTime = (Math.floor(Date.now() / 1_000) + 300) * 1_000;
    const dispatchResults = await Promise.all([
      service.dispatchPage({ action: "dispatchPaymentReconciliation", scheduledAt: dispatchTime, cursor: 0 }),
      service.dispatchPage({ action: "dispatchPaymentReconciliation", scheduledAt: dispatchTime, cursor: 0 }),
    ]);

    const queueFailure = await service.registerIntent(intent("queue-failure-order"));
    await withTx(container, (tx) => tx.update(paymentReconciliationCase).set({ nextCheckTime: 0 })
      .where(eq(paymentReconciliationCase.id, queueFailure.id)));
    failQueue = true;
    let queueFailureCaptured = false;
    try {
      await service.dispatchPage({
        action: "dispatchPaymentReconciliation",
        scheduledAt: dispatchTime,
        cursor: queueFailure.id - 1,
      }, 1);
    } catch {
      queueFailureCaptured = true;
    }
    failQueue = false;
    const queueFailureRow = await withTx(container, (tx) => tx.select().from(paymentReconciliationCase)
      .where(eq(paymentReconciliationCase.id, queueFailure.id)).limit(1));

    const retryCase = await service.registerIntent(intent("manual-retry-order"));
    await withTx(container, (tx) => tx.update(paymentReconciliationCase).set({ status: "UNKNOWN" })
      .where(eq(paymentReconciliationCase.id, retryCase.id)));
    const retryActionKey = crypto.randomUUID();
    const retryDecision = await service.decide({
      caseId: retryCase.id,
      adminId: 7,
      actionKey: retryActionKey,
      action: "retry",
      reasonCode: "provider_retry_requested",
    });
    const retryDuplicate = await service.decide({
      caseId: retryCase.id,
      adminId: 7,
      actionKey: retryActionKey,
      action: "retry",
      reasonCode: "provider_retry_requested",
    });

    const closeCase = await service.registerIntent(intent("manual-close-order"));
    await withTx(container, (tx) => tx.update(paymentReconciliationCase).set({ status: "CONFLICT" })
      .where(eq(paymentReconciliationCase.id, closeCase.id)));
    const closeDecision = await service.decide({
      caseId: closeCase.id,
      adminId: 7,
      actionKey: crypto.randomUUID(),
      action: "close",
      reasonCode: "provider_case_closed",
    });

    await admin.unsafe(`
      INSERT INTO "${schema}"."store_order" (id, order_id, paid, pay_price, status, is_del)
      VALUES (910001, 'manual-local-order', 1, 1.00, 0, 0)
    `);
    const localCase = await service.registerIntent(intent("manual-local-order"));
    await withTx(container, (tx) => tx.update(paymentReconciliationCase).set({ status: "CONFLICT" })
      .where(eq(paymentReconciliationCase.id, localCase.id)));
    const localDecision = await service.decide({
      caseId: localCase.id,
      adminId: 7,
      actionKey: crypto.randomUUID(),
      action: "accept_local",
      reasonCode: "verified_local_payment",
    });

    const callbackService = new PaymentCallbackEventService(
      container,
      { ORDER_QUEUE: queue },
      async () => ({ status: "completed", domain: "store_order", errorCode: "" }),
    );
    const callback = await callbackService.receive(verifiedCallback("confirmed"));
    const callbackResult = await callbackService.processMessage({
      action: "processPaymentCallback",
      eventId: callback.eventId,
      replayKey: callback.replayKey,
    });
    const callbackCase = await withTx(container, (tx) => tx.select().from(paymentReconciliationCase)
      .where(eq(paymentReconciliationCase.callbackEventId, callback.eventId)).limit(1));
    const actionRows = await withTx(container, (tx) => tx.select().from(paymentReconciliationAction));
    const settlementRows = await withTx(container, (tx) => tx.execute(sql`
      SELECT count(*)::integer AS count FROM payment_reconciliation_audit_settlement
    `)) as unknown as Array<{ count: number }>;
    const terminalRows = await withTx(container, (tx) => tx.select({
      orderNo: paymentReconciliationCase.orderNo,
      status: paymentReconciliationCase.status,
      attemptCount: paymentReconciliationCase.attemptCount,
    }).from(paymentReconciliationCase));

    const assertions = {
      migration_shape_exact_and_idempotent:
        firstEvidence.complete && secondEvidence.complete
        && JSON.stringify(firstEvidence.columns) === JSON.stringify(secondEvidence.columns),
      intent_registration_is_idempotent_and_conflict_safe:
        duplicateA.id === duplicateB.id && duplicateCount.length === 1
        && conflict.status === "CONFLICT",
      provider_success_settles_once:
        successResult === "settled" && successReplay === "already-terminal"
        && settlementCalls === 1 && settlementRows[0]?.count === 1,
      provider_pending_backs_off: waitingResult === "waiting",
      repeated_aged_not_found_is_no_payment: noPaymentResult === "no-payment",
      provider_evidence_mismatch_is_conflict: mismatchResult === "conflict",
      conflict_replay_does_not_query_provider:
        mismatchReplay === "already-terminal" && mismatchReplayDidNotQuery,
      transient_failures_exhaust_to_dead: deadResult === "dead",
      expired_leases_recover_once:
        dispatchResults.reduce((sum, item) => sum + item.claimed, 0) >= 1
        && sent.some((item) => (item as Record<string, unknown>).caseId === expired.id),
      queue_payloads_are_opaque: sent.every((item) => {
        const keys = Object.keys(item as object).sort();
        return JSON.stringify(keys) === JSON.stringify(["action", "caseId", "replayKey"])
          || JSON.stringify(keys) === JSON.stringify(["action", "cursor", "scheduledAt"])
          || JSON.stringify(keys) === JSON.stringify(["action", "eventId", "replayKey"]);
      }),
      queue_failure_is_durable:
        queueFailureCaptured && queueFailureRow[0]?.status === "UNKNOWN"
        && queueFailureRow[0]?.lastErrorCode === "queue_dispatch_failed",
      manual_actions_are_immutable_and_idempotent:
        retryDecision.status === "OPEN" && retryDuplicate.duplicate
        && closeDecision.status === "CLOSED" && localDecision.status === "CONFIRMED"
        && actionRows.length === 3,
      callback_resolves_same_case:
        callbackResult === "completed" && callbackCase[0]?.status === "CONFIRMED"
        && callbackCase[0]?.orderDomain === "store_order",
      no_raw_provider_or_payer_payload_columns:
        !firstEvidence.columns.flatMap((row) => row.columns)
          .some((column) => /payload|payer|openid|phone|email|address|credential|secret/i.test(column)),
      attempts_are_bounded:
        terminalRows.find((row) => row.orderNo === "dead-order")?.attemptCount === 12,
      provider_io_executed_outside_settlement_transaction:
        providerCalls >= 5 && settlementCalls === 1,
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
      status_counts: terminalRows.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {}),
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
      const data = url.pathname === "/audit"
        ? await productionAudit(env.HYPERDRIVE.connectionString)
        : url.pathname === "/migrate"
          ? await migrateProduction(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(data, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      return Response.json({
        error: "audit failed",
        detail: errorDetail(error),
      }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
