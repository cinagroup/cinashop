import { sql } from "drizzle-orm";
import type { Container, DbClient } from "../../src/lib/di";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "../../src/lib/di";
import { systemQueueDeadLetter } from "../../src/models/schema";

export const DEAD_LETTER_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS "system_queue_dead_letter" (
  "id" SERIAL PRIMARY KEY,
  "queue_name" VARCHAR(128) NOT NULL,
  "message_id" VARCHAR(128) NOT NULL,
  "message_timestamp_ms" BIGINT DEFAULT 0 NOT NULL,
  "dlq_attempts" INTEGER DEFAULT 1 NOT NULL,
  "message_type" VARCHAR(64) DEFAULT 'unknown' NOT NULL,
  "body" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "body_sha256" VARCHAR(64) NOT NULL,
  "replay_policy" VARCHAR(24) DEFAULT 'BLOCK_UNSUPPORTED' NOT NULL,
  "status" VARCHAR(16) DEFAULT 'OPEN' NOT NULL,
  "occurrence_count" INTEGER DEFAULT 1 NOT NULL,
  "replay_count" INTEGER DEFAULT 0 NOT NULL,
  "first_seen_time" INTEGER DEFAULT 0 NOT NULL,
  "last_seen_time" INTEGER DEFAULT 0 NOT NULL,
  "replay_requested_time" INTEGER DEFAULT 0 NOT NULL,
  "replayed_time" INTEGER DEFAULT 0 NOT NULL,
  "resolved_time" INTEGER DEFAULT 0 NOT NULL,
  "replay_lease_until" INTEGER DEFAULT 0 NOT NULL,
  "replay_token" VARCHAR(36) DEFAULT '' NOT NULL,
  "replay_requested_by" INTEGER DEFAULT 0 NOT NULL,
  "resolved_by" INTEGER DEFAULT 0 NOT NULL,
  "replay_reason" VARCHAR(500) DEFAULT '' NOT NULL,
  "resolution_reason" VARCHAR(500) DEFAULT '' NOT NULL,
  "last_error" VARCHAR(1000) DEFAULT '' NOT NULL,
  "add_time" INTEGER DEFAULT 0 NOT NULL,
  "update_time" INTEGER DEFAULT 0 NOT NULL,
  CONSTRAINT "sqdl_queue_message_uq" UNIQUE ("queue_name", "message_id"),
  CONSTRAINT "sqdl_status_ck" CHECK (
    "status" IN ('OPEN', 'REPLAYING', 'REPLAYED', 'RESOLVED')
  ),
  CONSTRAINT "sqdl_replay_policy_ck" CHECK (
    "replay_policy" IN ('ALLOW', 'BLOCK_SENSITIVE', 'BLOCK_UNSUPPORTED')
  ),
  CONSTRAINT "sqdl_count_ck" CHECK (
    "dlq_attempts" > 0 AND "occurrence_count" > 0 AND "replay_count" >= 0
  ),
  CONSTRAINT "sqdl_time_ck" CHECK (
    "message_timestamp_ms" >= 0 AND "first_seen_time" >= 0
      AND "last_seen_time" >= 0 AND "replay_requested_time" >= 0
      AND "replayed_time" >= 0 AND "resolved_time" >= 0
      AND "replay_lease_until" >= 0
  )
);
CREATE INDEX IF NOT EXISTS "sqdl_open_alerts"
  ON "system_queue_dead_letter" ("status", "first_seen_time", "id");
CREATE INDEX IF NOT EXISTS "sqdl_type_status"
  ON "system_queue_dead_letter" ("message_type", "status", "id");
CREATE INDEX IF NOT EXISTS "sqdl_replay_lease"
  ON "system_queue_dead_letter" ("replay_lease_until", "id")
  WHERE "status" = 'REPLAYING';
`;

export interface DeadLetterAuditPublicSnapshot {
  table_count: number;
  outbox_count: number;
  outbox_sequence: string | null;
  dead_letter_table: string | null;
}

export interface DeadLetterAuditStatus {
  rows: Array<{
    id: number;
    message_id: string;
    message_type: string;
    body: unknown;
    replay_policy: string;
    status: string;
    occurrence_count: number;
    replay_count: number;
    last_error: string;
  }>;
  deliveries: Array<{ audit_key: string; queue_attempt: number; outcome: string }>;
  processed: Array<{ audit_key: string; process_count: number }>;
  public_state_unchanged: boolean;
  public_before: DeadLetterAuditPublicSnapshot;
  public_after: DeadLetterAuditPublicSnapshot;
}

export function assertDeadLetterAuditSchema(value: string): string {
  if (!/^codex_order_dlq_[a-z0-9_]{1,43}$/.test(value) || value.length > 63) {
    throw new Error("unsafe order Queue DLQ audit schema name");
  }
  return value;
}

export function createDeadLetterAuditContainer(
  connectionString: string,
  schemaName: string,
): Container {
  return createContainerFromDb(createDbFromConnectionString(connectionString, 1, {
    searchPath: assertDeadLetterAuditSchema(schemaName),
    applicationName: "cinashop_order_dlq_audit",
  }));
}

export async function probeDeadLetterAuditTransactionScope(
  connectionString: string,
  schemaName: string,
) {
  const container = createDeadLetterAuditContainer(connectionString, schemaName);
  try {
    return withTx(container, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT current_schema() AS current_schema,
               current_setting('search_path') AS search_path,
               (SELECT count(*)::int FROM audit_control) AS controls,
               to_regclass('system_queue_dead_letter')::text AS dead_letter_table
      `) as unknown as Array<{
        current_schema: string;
        search_path: string;
        controls: number;
        dead_letter_table: string | null;
      }>;
      if (!rows[0]) throw new Error("transaction scope probe returned no row");
      return rows[0];
    });
  } finally {
    await container.db.$client.end();
  }
}

async function publicSnapshot(db: DbClient): Promise<DeadLetterAuditPublicSnapshot> {
  const rows = await db.$client.unsafe<DeadLetterAuditPublicSnapshot[]>(`
    SELECT
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS table_count,
      (SELECT count(*)::int FROM public.store_order_outbox) AS outbox_count,
      (SELECT last_value::text FROM public.store_order_outbox_id_seq) AS outbox_sequence,
      to_regclass('public.system_queue_dead_letter')::text AS dead_letter_table
  `);
  if (!rows[0]) throw new Error("could not capture public PostgreSQL snapshot");
  return rows[0];
}

export async function setupDeadLetterAudit(
  connectionString: string,
  schemaNameValue: string,
  auditKey: string,
) {
  const schemaName = assertDeadLetterAuditSchema(schemaNameValue);
  if (!/^[a-z0-9-]{8,80}$/.test(auditKey)) throw new Error("invalid audit key");
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_order_dlq_setup",
  });
  try {
    const existing = await adminDb.$client.unsafe<Array<{ schema_exists: boolean }>>(
      `SELECT to_regnamespace($1) IS NOT NULL AS schema_exists`,
      [schemaName],
    );
    if (existing[0]?.schema_exists) throw new Error("audit schema already exists");
    const before = await publicSnapshot(adminDb);
    await adminDb.$client.unsafe(`CREATE SCHEMA "${schemaName}"`);
    const container = createDeadLetterAuditContainer(connectionString, schemaName);
    try {
      await withTx(container, async (tx) => {
        await tx.execute(sql.raw(DEAD_LETTER_MIGRATION_SQL));
        await tx.execute(sql.raw(`
          CREATE TABLE audit_control (
            audit_key varchar(80) PRIMARY KEY,
            fail_enabled boolean DEFAULT true NOT NULL
          );
          CREATE TABLE audit_delivery (
            id serial PRIMARY KEY,
            audit_key varchar(80) NOT NULL,
            message_id varchar(128) NOT NULL,
            queue_attempt integer NOT NULL,
            outcome varchar(32) NOT NULL,
            add_time integer NOT NULL
          );
          CREATE TABLE audit_processed (
            audit_key varchar(80) PRIMARY KEY,
            process_count integer DEFAULT 1 NOT NULL,
            update_time integer NOT NULL
          );
          CREATE TABLE audit_public_snapshot (
            position varchar(8) PRIMARY KEY,
            table_count integer NOT NULL,
            outbox_count integer NOT NULL,
            outbox_sequence varchar(64),
            dead_letter_table varchar(128)
          );
        `));
        await tx.execute(sql`
          INSERT INTO audit_control (audit_key, fail_enabled) VALUES (${auditKey}, true)
        `);
        await tx.execute(sql`
          INSERT INTO audit_public_snapshot (
            position, table_count, outbox_count, outbox_sequence, dead_letter_table
          ) VALUES (
            'before', ${before.table_count}, ${before.outbox_count},
            ${before.outbox_sequence}, ${before.dead_letter_table}
          )
        `);
      });
    } finally {
      await container.db.$client.end();
    }
    return { schema: schemaName, audit_key: auditKey, public_before: before };
  } finally {
    await adminDb.$client.end();
  }
}

export async function recordDeadLetterAuditDelivery(
  container: Container,
  input: { auditKey: string; messageId: string; queueAttempt: number },
) {
  return withTx(container, async (tx) => {
    const controls = await tx.execute(sql`
      SELECT fail_enabled FROM audit_control WHERE audit_key = ${input.auditKey} FOR UPDATE
    `) as unknown as Array<{ fail_enabled: boolean }>;
    if (!controls[0]) throw new Error("audit control is missing");
    const fail = controls[0].fail_enabled;
    const now = Math.floor(Date.now() / 1_000);
    await tx.execute(sql`
      INSERT INTO audit_delivery (audit_key, message_id, queue_attempt, outcome, add_time)
      VALUES (
        ${input.auditKey}, ${input.messageId}, ${input.queueAttempt},
        ${fail ? "failed" : "processed"}, ${now}
      )
    `);
    if (!fail) {
      await tx.execute(sql`
        INSERT INTO audit_processed (audit_key, process_count, update_time)
        VALUES (${input.auditKey}, 1, ${now})
        ON CONFLICT (audit_key) DO UPDATE SET
          process_count = audit_processed.process_count + 1,
          update_time = EXCLUDED.update_time
      `);
    }
    return { fail };
  });
}

export async function enableDeadLetterAuditReplay(container: Container, auditKey: string) {
  return withTx(container, async (tx) => {
    await tx.execute(sql`
      UPDATE audit_control SET fail_enabled = false WHERE audit_key = ${auditKey}
    `);
  });
}

async function readStoredPublicSnapshot(container: Container) {
  return withTx(container, async (tx) => {
    const rows = await tx.execute(sql`
      SELECT table_count, outbox_count, outbox_sequence, dead_letter_table
      FROM audit_public_snapshot WHERE position = 'before'
    `) as unknown as DeadLetterAuditPublicSnapshot[];
    if (!rows[0]) throw new Error("stored public snapshot is missing");
    return rows[0];
  });
}

export async function readDeadLetterAuditStatus(
  connectionString: string,
  schemaName: string,
): Promise<DeadLetterAuditStatus> {
  const container = createDeadLetterAuditContainer(connectionString, schemaName);
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_order_dlq_status",
  });
  try {
    const [rows, deliveries, processed, before, after] = await Promise.all([
      withTx(container, async (tx) => tx.execute(sql`
        SELECT id, message_id, message_type, body, replay_policy, status,
               occurrence_count, replay_count, last_error
        FROM system_queue_dead_letter ORDER BY id
      `) as unknown as DeadLetterAuditStatus["rows"]),
      withTx(container, async (tx) => tx.execute(sql`
        SELECT audit_key, queue_attempt, outcome FROM audit_delivery ORDER BY id
      `) as unknown as DeadLetterAuditStatus["deliveries"]),
      withTx(container, async (tx) => tx.execute(sql`
        SELECT audit_key, process_count FROM audit_processed ORDER BY audit_key
      `) as unknown as DeadLetterAuditStatus["processed"]),
      readStoredPublicSnapshot(container),
      publicSnapshot(adminDb),
    ]);
    return {
      rows,
      deliveries,
      processed,
      public_state_unchanged: JSON.stringify(before) === JSON.stringify(after),
      public_before: before,
      public_after: after,
    };
  } finally {
    await Promise.all([container.db.$client.end(), adminDb.$client.end()]);
  }
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Order Queue DLQ audit failed: ${message}`);
}

export async function verifyDeadLetterAudit(
  connectionString: string,
  schemaName: string,
  auditKey: string,
) {
  const status = await readDeadLetterAuditStatus(connectionString, schemaName);
  const allowed = status.rows.find((row) => row.message_type === "processOrderPaidOutbox");
  const sensitive = status.rows.find((row) => row.message_type === "sendSmsVerification");
  assertCondition(status.rows.length === 2, "expected exactly one business and one sensitive archive");
  assertCondition(allowed?.status === "REPLAYED", "business dead letter was not replayed");
  assertCondition(allowed.replay_policy === "ALLOW", "business replay policy changed");
  assertCondition(allowed.occurrence_count >= 2, "duplicate archive was not deduplicated");
  assertCondition(allowed.replay_count === 1, "business dead letter replay count is wrong");
  assertCondition(sensitive?.status === "RESOLVED", "sensitive dead letter was not resolved");
  assertCondition(sensitive.replay_policy === "BLOCK_SENSITIVE", "sensitive replay was not blocked");
  const sensitiveBody = sensitive.body as Record<string, unknown>;
  assertCondition(sensitiveBody.code === "[REDACTED]", "SMS code was persisted in clear text");
  assertCondition(sensitiveBody.phone === "138****8000", "SMS phone was not masked");
  assertCondition(status.deliveries.length >= 3, "source Queue did not show failure and replay deliveries");
  assertCondition(status.deliveries.slice(0, 2).every((row) => row.outcome === "failed"), "source failure attempts were not recorded");
  assertCondition(status.deliveries.at(-1)?.outcome === "processed", "replayed message was not processed");
  assertCondition(status.processed.length === 1, "replay processing evidence is missing");
  assertCondition(status.processed[0]?.audit_key === auditKey, "replay processed the wrong audit key");
  assertCondition(status.processed[0]?.process_count === 1, "replay business processing was duplicated");
  assertCondition(status.public_state_unchanged, "public PostgreSQL state changed during isolated audit");
  return status;
}

export async function cleanupDeadLetterAudit(connectionString: string, schemaNameValue: string) {
  const schemaName = assertDeadLetterAuditSchema(schemaNameValue);
  const adminDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_order_dlq_cleanup",
  });
  try {
    const before = await adminDb.$client.unsafe<DeadLetterAuditPublicSnapshot[]>(`
      SELECT table_count, outbox_count, outbox_sequence, dead_letter_table
      FROM "${schemaName}".audit_public_snapshot WHERE position = 'before'
    `);
    const after = await publicSnapshot(adminDb);
    if (!before[0] || JSON.stringify(before[0]) !== JSON.stringify(after)) {
      throw new Error("public PostgreSQL snapshot changed; refusing cleanup success");
    }
    await adminDb.$client.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    const removed = await adminDb.$client.unsafe<Array<{ schema_removed: boolean }>>(
      `SELECT to_regnamespace($1) IS NULL AS schema_removed`,
      [schemaName],
    );
    if (!removed[0]?.schema_removed) throw new Error("audit schema was not removed");
    return { schema_removed: true, public_state_unchanged: true, public_after: after };
  } finally {
    await adminDb.$client.end();
  }
}

export async function deadLetterAuditRowByType(
  container: Container,
  messageType: string,
) {
  return withTx(container, async (tx) => {
    const rows = await tx.select().from(systemQueueDeadLetter)
      .where(sql`${systemQueueDeadLetter.messageType} = ${messageType}`)
      .limit(1);
    if (!rows[0]) throw new Error(`dead-letter row ${messageType} is missing`);
    return rows[0];
  });
}
