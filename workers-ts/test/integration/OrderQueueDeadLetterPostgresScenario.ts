import { sql } from "drizzle-orm";
import type { Container, DbClient } from "../../src/lib/di";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "../../src/lib/di";
import { systemQueueDeadLetter } from "../../src/models/schema";
import { MigrationService } from "../../src/services/MigrationService";

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
  safety: DeadLetterAuditSafetySnapshot;
}

export interface DeadLetterAuditSafetySnapshot {
  tables: Array<{ table: string; rows: string; digest: string }>;
  sequences: Array<{ sequence: string; last_value: string; is_called: boolean }>;
}

const DEAD_LETTER_AUDIT_SAFETY_TABLES = [
  "system_config",
  "system_queue_dead_letter",
  "store_order_outbox",
  "work_member",
  "work_department",
  "work_client",
  "work_client_follow",
  "work_group_chat",
  "work_group_chat_member",
  "work_label",
  "work_callback_event",
  "work_callback_outbox",
  "work_callback_watermark",
] as const;

export const WORK_C2_CALLBACK_OUTBOX_MESSAGE = {
  action: "processWorkCallbackOutbox",
  outboxId: 2_100_000_001,
  eventId: 2_100_000_002,
  eventKey: "c".repeat(64),
} as const;

export const WORK_C2_CALLBACK_DISPATCH_MESSAGE = {
  action: "dispatchWorkCallbackOutbox",
  scheduledAt: 1_788_048_000_000,
} as const;

const WORK_C2_CALLBACK_PAYLOAD = {
  CorpID: "ww-c2-audit-corp",
  Event: "change_external_chat",
  ChangeType: "update",
  ChatId: "wr-c2-audit-chat",
} as const;

export interface DeadLetterAuditStatus {
  rows: Array<{
    id: number;
    queue_name: string;
    message_id: string;
    dlq_attempts: number;
    message_type: string;
    body: unknown;
    body_sha256: string;
    replay_policy: string;
    status: string;
    occurrence_count: number;
    replay_count: number;
    last_error: string;
  }>;
  deliveries: Array<{
    audit_key: string;
    queue_name: string;
    message_id: string;
    message_type: string;
    body_sha256: string;
    queue_attempt: number;
    outcome: string;
  }>;
  processed: Array<{ audit_key: string; process_count: number }>;
  callback: {
    event_status: string;
    projection_status: string;
    outbox_status: string;
    attempt_count: number;
    watermark_count: number;
  } | null;
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

function normalizedPublicSnapshot(value: DeadLetterAuditPublicSnapshot) {
  return {
    table_count: Number(value.table_count),
    outbox_count: Number(value.outbox_count),
    outbox_sequence: value.outbox_sequence === null ? null : String(value.outbox_sequence),
    dead_letter_table: value.dead_letter_table === null ? null : String(value.dead_letter_table),
    safety: {
      tables: value.safety.tables.map((row) => ({
        table: String(row.table),
        rows: String(row.rows),
        digest: String(row.digest),
      })).sort((left, right) => left.table.localeCompare(right.table)),
      sequences: value.safety.sequences.map((row) => ({
        sequence: String(row.sequence),
        last_value: String(row.last_value),
        is_called: Boolean(row.is_called),
      })).sort((left, right) => left.sequence.localeCompare(right.sequence)),
    },
  };
}

export function sameDeadLetterAuditPublicSnapshot(
  left: DeadLetterAuditPublicSnapshot,
  right: DeadLetterAuditPublicSnapshot,
): boolean {
  return JSON.stringify(normalizedPublicSnapshot(left))
    === JSON.stringify(normalizedPublicSnapshot(right));
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
  const tables: DeadLetterAuditSafetySnapshot["tables"] = [];
  for (const table of DEAD_LETTER_AUDIT_SAFETY_TABLES) {
    const exists = await db.$client.unsafe<Array<{ exists: boolean }>>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${table}`],
    );
    if (!exists[0]?.exists) {
      tables.push({ table, rows: "missing", digest: "missing" });
      continue;
    }
    const fingerprint = await db.$client.unsafe<Array<{ row_count: string; digest: string }>>(`
      SELECT count(*)::text AS row_count,
        md5(COALESCE(string_agg(row_digest, '|' ORDER BY row_digest), '')) AS digest
      FROM (
        SELECT md5(to_jsonb(source_row)::text) AS row_digest
        FROM "public"."${table}" AS source_row
      ) AS row_digests
    `);
    tables.push({
      table,
      rows: fingerprint[0]?.row_count ?? "-1",
      digest: fingerprint[0]?.digest ?? "",
    });
  }
  const sequenceNames = await db.$client.unsafe<Array<{ sequence_name: string }>>(`
    SELECT DISTINCT sequence_class.relname AS sequence_name
    FROM pg_class AS table_class
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
    JOIN pg_depend AS dependency
      ON dependency.refobjid = table_class.oid
     AND dependency.refobjsubid > 0
     AND dependency.deptype IN ('a', 'i')
    JOIN pg_class AS sequence_class
      ON sequence_class.oid = dependency.objid AND sequence_class.relkind = 'S'
    JOIN pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND sequence_namespace.nspname = 'public'
      AND table_class.relname = ANY($1::text[])
    ORDER BY sequence_class.relname
  `, [[...DEAD_LETTER_AUDIT_SAFETY_TABLES]]);
  const sequences: DeadLetterAuditSafetySnapshot["sequences"] = [];
  for (const row of sequenceNames) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(row.sequence_name)) {
      throw new Error("unsafe public sequence identifier");
    }
    const values = await db.$client.unsafe<Array<{ last_value: string; is_called: boolean }>>(
      `SELECT last_value::text AS last_value, is_called FROM "public"."${row.sequence_name}"`,
    );
    if (!values[0]) throw new Error("could not fingerprint public sequence");
    sequences.push({
      sequence: row.sequence_name,
      last_value: values[0].last_value,
      is_called: values[0].is_called,
    });
  }
  return { ...rows[0], safety: { tables, sequences } };
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
  let schemaCreated = false;
  try {
    const existing = await adminDb.$client.unsafe<Array<{ schema_exists: boolean }>>(
      `SELECT to_regnamespace($1) IS NOT NULL AS schema_exists`,
      [schemaName],
    );
    if (existing[0]?.schema_exists) throw new Error("audit schema already exists");
    const before = await publicSnapshot(adminDb);
    await adminDb.$client.unsafe(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
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
            queue_name varchar(128) NOT NULL,
            message_id varchar(128) NOT NULL,
            message_type varchar(64) NOT NULL,
            body_sha256 varchar(64) NOT NULL,
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
            dead_letter_table varchar(128),
            safety jsonb NOT NULL
          );
        `));
        const migrationService = new MigrationService(container);
        await tx.execute(sql.raw(
          migrationService.workCallbackPipelineMigrationSqlForVerification(),
        ));
        await tx.execute(sql.raw(
          migrationService.workCallbackProjectionStateMigrationSqlForVerification(),
        ));
        await tx.execute(sql`
          INSERT INTO audit_control (audit_key, fail_enabled) VALUES (${auditKey}, true)
        `);
        await tx.execute(sql`
          INSERT INTO audit_public_snapshot (
            position, table_count, outbox_count, outbox_sequence, dead_letter_table, safety
          ) VALUES (
            'before', ${before.table_count}, ${before.outbox_count},
            ${before.outbox_sequence}, ${before.dead_letter_table},
            ${JSON.stringify(before.safety)}::jsonb
          )
        `);
        await tx.execute(sql`
          INSERT INTO work_callback_event (
            id, event_key, payload_hash, subject_key_hash, corp_id,
            msg_type, event_type, change_type, event_time, sequence_rank,
            payload, status, received_time, update_time
          ) VALUES (
            ${WORK_C2_CALLBACK_OUTBOX_MESSAGE.eventId},
            ${WORK_C2_CALLBACK_OUTBOX_MESSAGE.eventKey},
            ${"d".repeat(64)}, ${"e".repeat(64)}, ${WORK_C2_CALLBACK_PAYLOAD.CorpID},
            'event', ${WORK_C2_CALLBACK_PAYLOAD.Event}, ${WORK_C2_CALLBACK_PAYLOAD.ChangeType},
            1788048000, 20, ${JSON.stringify(WORK_C2_CALLBACK_PAYLOAD)}::jsonb,
            'RECEIVED', 1788048000, 1788048000
          )
        `);
        await tx.execute(sql`
          INSERT INTO work_callback_outbox (
            id, event_id, event_key, status, enqueued_time, add_time, update_time
          ) VALUES (
            ${WORK_C2_CALLBACK_OUTBOX_MESSAGE.outboxId},
            ${WORK_C2_CALLBACK_OUTBOX_MESSAGE.eventId},
            ${WORK_C2_CALLBACK_OUTBOX_MESSAGE.eventKey},
            'ENQUEUED', 1788048000, 1788048000, 1788048000
          )
        `);
      });
    } finally {
      await container.db.$client.end();
    }
    return { schema: schemaName, audit_key: auditKey, public_before: before };
  } catch (error) {
    if (schemaCreated) {
      await adminDb.$client.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    }
    throw error;
  } finally {
    await adminDb.$client.end();
  }
}

export async function deadLetterAuditShouldFail(
  container: Container,
  auditKey: string,
): Promise<boolean> {
  return withTx(container, async (tx) => {
    const controls = await tx.execute(sql`
      SELECT fail_enabled FROM audit_control WHERE audit_key = ${auditKey}
    `) as unknown as Array<{ fail_enabled: boolean }>;
    if (!controls[0]) throw new Error("audit control is missing");
    return controls[0].fail_enabled;
  });
}

function canonicalAuditJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("audit message contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalAuditJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalAuditJson(record[key])}`).join(",")}}`;
  }
  throw new Error("audit message is not JSON serializable");
}

export async function auditMessageBodySha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalAuditJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function recordDeadLetterAuditDelivery(
  container: Container,
  input: {
    auditKey: string;
    queueName: string;
    messageId: string;
    messageType: string;
    bodySha256: string;
    queueAttempt: number;
    outcome: "failed" | "processed" | "consumer_retry";
  },
) {
  return withTx(container, async (tx) => {
    const now = Math.floor(Date.now() / 1_000);
    await tx.execute(sql`
      INSERT INTO audit_delivery (
        audit_key, queue_name, message_id, message_type, body_sha256,
        queue_attempt, outcome, add_time
      )
      VALUES (
        ${input.auditKey}, ${input.queueName}, ${input.messageId},
        ${input.messageType}, ${input.bodySha256}, ${input.queueAttempt},
        ${input.outcome}, ${now}
      )
    `);
    if (input.outcome === "processed") {
      await tx.execute(sql`
        INSERT INTO audit_processed (audit_key, process_count, update_time)
        VALUES (${input.auditKey}, 1, ${now})
        ON CONFLICT (audit_key) DO UPDATE SET
          process_count = audit_processed.process_count + 1,
          update_time = EXCLUDED.update_time
      `);
    }
    return { recorded: true };
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
      SELECT table_count, outbox_count, outbox_sequence, dead_letter_table, safety
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
    const [rows, deliveries, processed, callbackRows, before, after] = await Promise.all([
      withTx(container, async (tx) => tx.execute(sql`
        SELECT id, queue_name, message_id, dlq_attempts, message_type, body,
               body_sha256, replay_policy, status, occurrence_count,
               replay_count, last_error
        FROM system_queue_dead_letter ORDER BY id
      `) as unknown as DeadLetterAuditStatus["rows"]),
      withTx(container, async (tx) => tx.execute(sql`
        SELECT audit_key, queue_name, message_id, message_type, body_sha256,
               queue_attempt, outcome
        FROM audit_delivery ORDER BY id
      `) as unknown as DeadLetterAuditStatus["deliveries"]),
      withTx(container, async (tx) => tx.execute(sql`
        SELECT audit_key, process_count FROM audit_processed ORDER BY audit_key
      `) as unknown as DeadLetterAuditStatus["processed"]),
      withTx(container, async (tx) => tx.execute(sql`
        SELECT event.status AS event_status,
          event.projection_status,
          outbox.status AS outbox_status,
          outbox.attempt_count,
          (SELECT count(*)::integer
             FROM work_callback_watermark AS watermark
            WHERE watermark.event_id = event.id) AS watermark_count
        FROM work_callback_event AS event
        JOIN work_callback_outbox AS outbox ON outbox.event_id = event.id
        WHERE event.id = ${WORK_C2_CALLBACK_OUTBOX_MESSAGE.eventId}
          AND outbox.id = ${WORK_C2_CALLBACK_OUTBOX_MESSAGE.outboxId}
      `) as unknown as Array<NonNullable<DeadLetterAuditStatus["callback"]>>),
      readStoredPublicSnapshot(container),
      publicSnapshot(adminDb),
    ]);
    return {
      rows,
      deliveries,
      processed,
      callback: callbackRows[0] ?? null,
      public_state_unchanged: sameDeadLetterAuditPublicSnapshot(before, after),
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

function exactObject(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(keys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => actual[key] === expected[key]);
}

export async function verifyWorkCallbackDeadLetterAudit(
  connectionString: string,
  schemaName: string,
  auditKey: string,
  sourceQueueName: string,
  dlqName: string,
) {
  const status = await readDeadLetterAuditStatus(connectionString, schemaName);
  const outbox = status.rows.find((row) => row.message_type === "processWorkCallbackOutbox");
  const dispatch = status.rows.find((row) => row.message_type === "dispatchWorkCallbackOutbox");
  const expectedBodyHash = await auditMessageBodySha256(WORK_C2_CALLBACK_OUTBOX_MESSAGE);
  const workDeliveries = status.deliveries.filter((row) =>
    row.audit_key === auditKey && row.message_type === "processWorkCallbackOutbox");
  assertCondition(status.rows.length === 2, "expected exactly two Work callback archives");
  assertCondition(outbox?.status === "REPLAYED", "Work callback outbox was not replayed");
  assertCondition(outbox.replay_policy === "ALLOW", "Work callback outbox replay was blocked");
  assertCondition(outbox.queue_name === dlqName, "Work callback outbox was archived from the wrong DLQ");
  assertCondition(outbox.dlq_attempts >= 1, "Work callback DLQ attempt count is invalid");
  assertCondition(outbox.body_sha256 === expectedBodyHash, "Work callback archive body fingerprint changed");
  assertCondition(outbox.occurrence_count >= 2, "Work callback duplicate archive was not deduplicated");
  assertCondition(outbox.replay_count === 1, "Work callback replay count is wrong");
  assertCondition(
    exactObject(outbox.body, WORK_C2_CALLBACK_OUTBOX_MESSAGE),
    "Work callback outbox body did not retain the exact strict four-key contract",
  );
  assertCondition(dispatch?.status === "RESOLVED", "Work callback dispatch archive was not resolved");
  assertCondition(dispatch.replay_policy === "ALLOW", "Work callback dispatch replay policy changed");
  assertCondition(dispatch.queue_name === dlqName, "Work callback dispatch was archived from the wrong DLQ");
  assertCondition(
    exactObject(dispatch.body, WORK_C2_CALLBACK_DISPATCH_MESSAGE),
    "Work callback dispatch body did not retain the exact strict two-key contract",
  );
  assertCondition(workDeliveries.length === 3, "expected two failed attempts and one replay delivery");
  assertCondition(
    workDeliveries[0]?.queue_name === sourceQueueName
      && workDeliveries[1]?.queue_name === sourceQueueName
      && workDeliveries[0]?.message_id === workDeliveries[1]?.message_id
      && workDeliveries[0]?.body_sha256 === expectedBodyHash
      && workDeliveries[1]?.body_sha256 === expectedBodyHash
      && workDeliveries[0]?.queue_attempt === 1
      && workDeliveries[0]?.outcome === "failed"
      && workDeliveries[1]?.queue_attempt === 2
      && workDeliveries[1]?.outcome === "failed",
    "Cloudflare Queue automatic retry attempts were not 1 then 2",
  );
  assertCondition(
    workDeliveries[2]?.queue_name === sourceQueueName
      && workDeliveries[2]?.body_sha256 === expectedBodyHash
      && workDeliveries[2]?.queue_attempt === 1
      && workDeliveries[2]?.outcome === "processed",
    "manual replay did not arrive as one fresh Queue delivery",
  );
  assertCondition(status.processed.length === 1, "Work callback replay processing evidence is missing");
  assertCondition(status.processed[0]?.audit_key === auditKey, "Work callback replay used the wrong audit key");
  assertCondition(status.processed[0]?.process_count === 1, "Work callback replay was processed more than once");
  assertCondition(status.callback?.event_status === "ORDERED", "callback event did not reach ORDERED");
  assertCondition(
    status.callback.projection_status === "REFRESH_REQUIRED",
    "callback projection did not retain REFRESH_REQUIRED",
  );
  assertCondition(status.callback.outbox_status === "COMPLETED", "callback outbox did not complete");
  assertCondition(status.callback.attempt_count === 1, "callback consumer did not process exactly once");
  assertCondition(status.callback.watermark_count === 1, "callback watermark was not advanced once");
  assertCondition(status.public_state_unchanged, "public business/callback/dead-letter state changed");
  return {
    ...status,
    work_assertions: {
      exact_archives: true,
      strict_validators: true,
      automatic_retry_attempts: [1, 2],
      dlq_archived: true,
      manual_replay_attempt: 1,
      replay_processed_once_by_callback_consumer: true,
      callback_state: status.callback,
      source_body_sha256: expectedBodyHash,
      public_rows_and_sequences_unchanged: true,
    },
  };
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
      SELECT table_count, outbox_count, outbox_sequence, dead_letter_table, safety
      FROM "${schemaName}".audit_public_snapshot WHERE position = 'before'
    `);
    const after = await publicSnapshot(adminDb);
    if (!before[0] || !sameDeadLetterAuditPublicSnapshot(before[0], after)) {
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
