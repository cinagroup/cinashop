import { createCipheriv, createHash } from "node:crypto";
import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import type { OrderMessage, WorkCallbackOutboxMessage } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
} from "@/lib/di";
import { MigrationService } from "@/services/MigrationService";
import {
  EnterpriseWechatCallbackError,
  EnterpriseWechatCallbackService,
} from "@/services/work/EnterpriseWechatCallbackService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_MIGRATE_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const PREFIX = "codex_work_callback_";
const PIPELINE_TABLES = [
  "work_callback_event",
  "work_callback_outbox",
  "work_callback_watermark",
] as const;
const BUSINESS_TABLES = [
  "system_config",
  "work_member",
  "work_client",
  "work_client_follow",
  "work_group_chat",
  "work_group_chat_member",
] as const;
const ISOLATION_SAFETY_TABLES = [...BUSINESS_TABLES, ...PIPELINE_TABLES] as const;
const PROJECTION_TABLES = ["work_client", "work_client_follow"] as const;
const PROJECTION_INDEXES = [
  "work_client_active_identity_uq",
  "work_client_follow_active_identity_uq",
] as const;
const CALLBACK_EVENT_STATUSES = [
  "RECEIVED",
  "PROCESSING",
  "ORDERED",
  "APPLIED",
  "APPLIED_NOOP",
  "SUPERSEDED",
  "IGNORED",
  "FAILED",
  "DEAD",
] as const;

interface SafetySnapshot {
  tables: Array<{ table: string; rows: string; digest: string }>;
  sequences: Array<{ sequence: string; lastValue: string; isCalled: boolean }>;
}

function bytesFromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = bytesFromHex(expectedHex);
  if (!expected) return false;
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function productionAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_work_callback_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const version = await tx<Array<{ version: string }>>`SELECT version()`;
      const tables = await tx<Array<{ table_name: string; column_count: number; row_count: number | null }>>`
        SELECT requested.table_name,
          count(columns.column_name)::integer AS column_count,
          CASE WHEN to_regclass('public.' || requested.table_name) IS NULL THEN NULL
            ELSE NULL END AS row_count
        FROM (VALUES
          ('work_callback_event'),
          ('work_callback_outbox'),
          ('work_callback_watermark')
        ) AS requested(table_name)
        LEFT JOIN information_schema.columns AS columns
          ON columns.table_schema = 'public' AND columns.table_name = requested.table_name
        GROUP BY requested.table_name
        ORDER BY requested.table_name
      `;
      const existing = tables.filter((row) => row.column_count > 0).map((row) => row.table_name);
      const rowCounts: Record<string, number> = {};
      for (const table of existing) {
        const rows = await tx.unsafe<Array<{ count: number }>>(
          `SELECT count(*)::integer AS count FROM "public"."${table}"`,
        );
        rowCounts[table] = rows[0]?.count ?? -1;
      }
      const indexes = await tx<Array<{ tablename: string; indexname: string; indexdef: string }>>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND (tablename IN ${tx([...PIPELINE_TABLES])}
            OR indexname IN ${tx([...PROJECTION_INDEXES])})
        ORDER BY tablename, indexname
      `;
      const statusConstraint = await tx<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conname = 'wce_status_ck'
          AND constraint_row.conrelid = 'public.work_callback_event'::regclass
      `;
      const config = await tx<Array<Record<string, number>>>`
        SELECT
          count(*) FILTER (WHERE menu_name = 'wechat_work_corpid' AND value <> '')::integer AS corp_id_nonblank,
          count(*) FILTER (WHERE menu_name = 'wechat_work_token' AND value <> '')::integer AS legacy_callback_token_nonblank,
          count(*) FILTER (WHERE menu_name = 'wechat_work_aes_key' AND value <> '')::integer AS legacy_callback_aes_key_nonblank
        FROM system_config WHERE is_store = 0
      `;
      const domain = await tx<Array<Record<string, number>>>`
        SELECT
          (SELECT count(*)::integer FROM work_member) AS members,
          (SELECT count(*)::integer FROM work_client) AS clients,
          (SELECT count(*)::integer FROM work_client_follow) AS follows,
          (SELECT count(*)::integer FROM work_group_chat) AS groups,
          (SELECT count(*)::integer FROM work_group_chat_member) AS group_members
      `;
      const duplicates = await activeProjectionDuplicates(tx as unknown as postgres.Sql);
      return {
        complete: true,
        read_only: true,
        postgres_major: version[0]?.version.match(/PostgreSQL (\d+)/)?.[1] ?? "unknown",
        tables: tables.map(({ table_name, column_count }) => ({
          table_name,
          column_count,
          row_count: rowCounts[table_name] ?? null,
        })),
        indexes,
        event_status_constraint: statusConstraint[0]?.definition ?? null,
        config: config[0],
        domain: domain[0],
        active_identity_duplicates: duplicates,
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function safetySnapshot(
  client: postgres.Sql,
  tableNames: readonly string[] = BUSINESS_TABLES,
): Promise<SafetySnapshot> {
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await tx`SET LOCAL search_path TO public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '45s'`;
    await tx`SET LOCAL lock_timeout = '2s'`;
    const tables: SafetySnapshot["tables"] = [];
    for (const table of tableNames) {
      const exists = await tx<Array<{ exists: boolean }>>`
        SELECT to_regclass(${'public.' + table}) IS NOT NULL AS exists
      `;
      if (!exists[0]?.exists) {
        tables.push({ table, rows: "missing", digest: "missing" });
        continue;
      }
      const rows = await tx.unsafe<Array<{ row_count: string; digest: string }>>(
        `SELECT count(*)::text AS row_count,
          md5(COALESCE(string_agg(row_digest, '|' ORDER BY row_digest), '')) AS digest
         FROM (
           SELECT md5(to_jsonb(source_row)::text) AS row_digest
           FROM "public"."${table}" AS source_row
         ) AS row_digests`,
      );
      tables.push({
        table,
        rows: rows[0]?.row_count ?? "-1",
        digest: rows[0]?.digest ?? "",
      });
    }
    const sequenceRows = await tx<Array<{ sequence_name: string }>>`
      SELECT DISTINCT sequence_class.relname AS sequence_name
      FROM pg_class AS table_class
      JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_depend AS dependency
        ON dependency.refobjid = table_class.oid
       AND dependency.refobjsubid > 0
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class AS sequence_class
        ON sequence_class.oid = dependency.objid
       AND sequence_class.relkind = 'S'
      JOIN pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_class.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND sequence_namespace.nspname = 'public'
        AND table_class.relname IN ${tx([...tableNames])}
      ORDER BY sequence_class.relname
    `;
    const sequences: SafetySnapshot["sequences"] = [];
    for (const row of sequenceRows) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(row.sequence_name)) {
        throw new Error("unsafe public sequence identifier");
      }
      const values = await tx.unsafe<Array<{ last_value: string; is_called: boolean }>>(
        `SELECT last_value::text AS last_value, is_called FROM "public"."${row.sequence_name}"`,
      );
      if (!values[0]) throw new Error("public sequence fingerprint failed");
      sequences.push({
        sequence: row.sequence_name,
        lastValue: values[0].last_value,
        isCalled: values[0].is_called,
      });
    }
    return { tables, sequences };
  });
}

function sameSafetySnapshot(left: SafetySnapshot, right: SafetySnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function projectionIndexesReady(
  indexes: ReadonlyArray<{
    indexname: string;
    indexdef: string;
    indisvalid?: boolean;
    indisready?: boolean;
  }>,
): boolean {
  const rows = new Map(indexes.map((row) => [row.indexname, row]));
  const clientRow = rows.get("work_client_active_identity_uq");
  const followRow = rows.get("work_client_follow_active_identity_uq");
  const client = clientRow?.indexdef.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ") ?? "";
  const follow = followRow?.indexdef.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ") ?? "";
  return clientRow?.indisvalid === true
    && clientRow.indisready === true
    && followRow?.indisvalid === true
    && followRow.indisready === true
    && client.startsWith("create unique index work_client_active_identity_uq ")
    && client.includes(".work_client using btree (corp_id, external_userid)")
    && client.includes("delete_time is null")
    && client.includes("external_userid")
    && client.includes("<> ''::text")
    && follow.startsWith("create unique index work_client_follow_active_identity_uq ")
    && follow.includes(".work_client_follow using btree (client_id, userid)")
    && follow.includes("is_del_user = 0")
    && follow.includes("client_id > 0")
    && follow.includes("userid")
    && follow.includes("<> ''::text");
}

function callbackEventStatusConstraintReady(definition: string | undefined): boolean {
  if (!definition?.startsWith("CHECK ")) return false;
  const statuses = [...definition.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
  return statuses.length === CALLBACK_EVENT_STATUSES.length
    && new Set(statuses).size === CALLBACK_EVENT_STATUSES.length
    && CALLBACK_EVENT_STATUSES.every((status) => statuses.includes(status));
}

async function activeProjectionDuplicates(client: postgres.Sql) {
  const rows = await client<Array<{ client_duplicates: number; follow_duplicates: number }>>`
    SELECT
      (SELECT count(*)::integer FROM (
        SELECT corp_id, external_userid
        FROM public.work_client
        WHERE delete_time IS NULL AND external_userid <> ''
        GROUP BY corp_id, external_userid HAVING count(*) > 1
      ) AS duplicate_clients) AS client_duplicates,
      (SELECT count(*)::integer FROM (
        SELECT client_id, userid
        FROM public.work_client_follow
        WHERE is_del_user = 0 AND client_id > 0 AND userid <> ''
        GROUP BY client_id, userid HAVING count(*) > 1
      ) AS duplicate_follows) AS follow_duplicates
  `;
  return rows[0] ?? { client_duplicates: -1, follow_duplicates: -1 };
}

async function pipelineState(client: postgres.Sql) {
  const state: Record<string, { exists: boolean; count: number | null }> = {};
  for (const table of PIPELINE_TABLES) {
    const exists = await client<Array<{ exists: boolean }>>`
      SELECT to_regclass(${'public.' + table}) IS NOT NULL AS exists
    `;
    let count: number | null = null;
    if (exists[0]?.exists) {
      const rows = await client.unsafe<Array<{ count: number }>>(
        `SELECT count(*)::integer AS count FROM "public"."${table}"`,
      );
      count = rows[0]?.count ?? -1;
    }
    state[table] = { exists: Boolean(exists[0]?.exists), count };
  }
  return state;
}

async function migrateProduction(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public,pg_temp",
    applicationName: "cinashop_work_callback_migration",
  });
  const admin = postgres(connectionString, { max: 1, prepare: false });
  try {
    const beforeSnapshot = await safetySnapshot(admin, ISOLATION_SAFETY_TABLES);
    const before = await pipelineState(admin);
    const duplicateState = await activeProjectionDuplicates(admin);
    if (duplicateState.client_duplicates !== 0 || duplicateState.follow_duplicates !== 0) {
      throw new Error("active projection identities are not unique");
    }
    const migrations = [
      new MigrationService(createContainerFromDb(db)).workCallbackPipelineMigrationSqlForVerification(),
      new MigrationService(createContainerFromDb(db)).workCallbackFollowProjectionMigrationSqlForVerification(),
    ];
    for (let pass = 0; pass < 2; pass += 1) {
      await withTx(createContainerFromDb(db), async (tx) => {
        await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
        await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '45s'"));
        for (const migration of migrations) await tx.execute(drizzleSql.raw(migration));
      });
    }
    const after = await pipelineState(admin);
    const afterSnapshot = await safetySnapshot(admin, ISOLATION_SAFETY_TABLES);
    const indexes = await admin<Array<{
      indexname: string;
      indexdef: string;
      indisvalid: boolean;
      indisready: boolean;
    }>>`
      SELECT catalog_indexes.indexname, catalog_indexes.indexdef,
        index_metadata.indisvalid, index_metadata.indisready
      FROM pg_indexes AS catalog_indexes
      JOIN pg_class AS index_class ON index_class.relname = catalog_indexes.indexname
      JOIN pg_namespace AS index_namespace
        ON index_namespace.oid = index_class.relnamespace
       AND index_namespace.nspname = catalog_indexes.schemaname
      JOIN pg_index AS index_metadata ON index_metadata.indexrelid = index_class.oid
      WHERE catalog_indexes.schemaname = 'public'
        AND (catalog_indexes.tablename IN ${admin([...PIPELINE_TABLES])}
          OR catalog_indexes.indexname IN ${admin([...PROJECTION_INDEXES])})
      ORDER BY catalog_indexes.indexname
    `;
    const constraints = await admin<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conname = 'wce_status_ck'
        AND constraint_row.conrelid = 'public.work_callback_event'::regclass
    `;
    const pipelineStateUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const publicStateUnchanged = sameSafetySnapshot(beforeSnapshot, afterSnapshot);
    const projectionReady = projectionIndexesReady(indexes)
      && callbackEventStatusConstraintReady(constraints[0]?.definition);
    return {
      complete: Object.values(after).every((item) => item.exists)
        && pipelineStateUnchanged && publicStateUnchanged && projectionReady,
      passes: 2,
      before,
      after,
      active_identity_duplicates: duplicateState,
      indexes,
      event_status_constraint: constraints[0]?.definition ?? null,
      pipeline_state_unchanged: pipelineStateUnchanged,
      business_rows_and_sequences_unchanged: publicStateUnchanged,
      public_rows_and_sequences_unchanged: publicStateUnchanged,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
    await admin.end({ timeout: 1 });
  }
}

const cipherKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const callbackAesKey = Buffer.from(cipherKey).toString("base64").slice(0, -1);
const callbackToken = "isolated-callback-token";
const callbackCorpId = "ww-isolated-corp";

function callbackRequest(xml: string, nonce: string) {
  const message = Buffer.from(xml);
  const receive = Buffer.from(callbackCorpId);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.byteLength);
  const plain = Buffer.concat([Buffer.alloc(16, 9), length, message, receive]);
  const padding = 32 - (plain.byteLength % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", cipherKey, cipherKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  const timestamp = "1788048999";
  const signature = createHash("sha1")
    .update([callbackToken, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
  return {
    query: { signature, timestamp, nonce },
    encrypted,
    wrapper: `<xml><ToUserName><![CDATA[${callbackCorpId}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID>1000002</AgentID></xml>`,
  };
}

function eventXml(input: {
  time: number;
  event: string;
  change: string;
  subjectTag: string;
  subjectValue: string;
  extra?: string;
}) {
  return `<xml><ToUserName><![CDATA[${callbackCorpId}]]></ToUserName><FromUserName><![CDATA[sys]]></FromUserName><CreateTime>${input.time}</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${input.event}]]></Event><ChangeType><![CDATA[${input.change}]]></ChangeType><${input.subjectTag}><![CDATA[${input.subjectValue}]]></${input.subjectTag}>${input.extra ?? ""}</xml>`;
}

async function isolatedScenario(connectionString: string) {
  const admin = postgres(connectionString, { max: 1, prepare: false });
  const schema = `${PREFIX}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const beforeSchemas = await admin<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
  `;
  const beforeSnapshot = await safetySnapshot(admin, ISOLATION_SAFETY_TABLES);
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
  let result: Record<string, unknown> | undefined;
  let cleanupVerified = false;
  let publicStateUnchanged = false;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    db = createDbFromConnectionString(connectionString, 3, {
      searchPath: schema,
      applicationName: "cinashop_work_callback_isolated",
    });
    const container = createContainerFromDb(db);
    await withTx(container, async (tx) => {
      await tx.execute(drizzleSql.raw(`CREATE TABLE system_config (
        id serial PRIMARY KEY,
        menu_name varchar(100) NOT NULL DEFAULT '',
        value text NOT NULL DEFAULT '',
        is_store smallint NOT NULL DEFAULT 0,
        sort integer NOT NULL DEFAULT 0
      )`));
      for (const table of PROJECTION_TABLES) {
        await tx.execute(drizzleSql.raw(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        ));
        await tx.execute(drizzleSql.raw(
          `ALTER TABLE "${table}" ALTER COLUMN "id" DROP IDENTITY IF EXISTS`,
        ));
        await tx.execute(drizzleSql.raw(
          `ALTER TABLE "${table}" ALTER COLUMN "id" DROP DEFAULT`,
        ));
        await tx.execute(drizzleSql.raw(
          `ALTER TABLE "${table}" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY`,
        ));
      }
      const migrationService = new MigrationService(container);
      await tx.execute(drizzleSql.raw(
        migrationService.workCallbackPipelineMigrationSqlForVerification(),
      ));
      await tx.execute(drizzleSql.raw(
        migrationService.workCallbackFollowProjectionMigrationSqlForVerification(),
      ));
      await tx.execute(drizzleSql`
        INSERT INTO system_config (menu_name, value, is_store, sort)
        VALUES ('wechat_work_corpid', ${callbackCorpId}, 0, 0)
      `);
      await tx.execute(drizzleSql`
        INSERT INTO work_client (id, corp_id, external_userid, name, create_time, update_time)
        VALUES
          (101, ${callbackCorpId}, 'wo-client-1', 'shared-client', 1788047000, 1788047000),
          (102, ${callbackCorpId}, 'wo-client-failure', 'rollback-client', 1788047000, 1788047000)
      `);
      await tx.execute(drizzleSql`
        INSERT INTO work_client_follow
          (id, client_id, userid, is_del_user, create_time, update_time)
        VALUES
          (201, 101, 'employee-a', 0, 1788047000, 1788047000),
          (202, 101, 'employee-b', 0, 1788047000, 1788047000),
          (203, 102, 'employee-failure', 0, 1788047000, 1788047000)
      `);
    });
    // Exact DDL is idempotent in the same isolated production engine.
    await withTx(container, async (tx) => {
      const migrationService = new MigrationService(container);
      await tx.execute(drizzleSql.raw(
        migrationService.workCallbackPipelineMigrationSqlForVerification(),
      ));
      await tx.execute(drizzleSql.raw(
        migrationService.workCallbackFollowProjectionMigrationSqlForVerification(),
      ));
    });

    const messages: WorkCallbackOutboxMessage[] = [];
    let failQueue = false;
    const queue = {
      async send(): Promise<void> {},
      async sendBatch(batch: Iterable<{ body: OrderMessage }>): Promise<void> {
        if (failQueue) throw new Error("synthetic_queue_failure");
        for (const item of batch) messages.push(item.body as WorkCallbackOutboxMessage);
      },
    } as unknown as Queue<OrderMessage>;
    const service = new EnterpriseWechatCallbackService(container, {
      WECHAT_WORK_CALLBACK_TOKEN: callbackToken,
      WECHAT_WORK_CALLBACK_AES_KEY: callbackAesKey,
      ORDER_QUEUE: queue,
    });

    const echoRequest = callbackRequest("callback-echo", "echo-nonce");
    const echo = await service.verifyUrl(echoRequest.query, echoRequest.encrypted);

    const firstRequest = callbackRequest(eventXml({
      time: 1788048000,
      event: "change_external_chat",
      change: "update",
      subjectTag: "ChatId",
      subjectValue: "wr-chat-1",
      extra: "<UpdateDetail><![CDATA[add_member]]></UpdateDetail>",
    }), "event-1");
    const first = await service.receive(firstRequest.query, firstRequest.wrapper);
    const duplicate = await service.receive(firstRequest.query, firstRequest.wrapper);
    const dispatched = await service.dispatchById(first.outboxId);
    const queueShape = Object.keys(messages[0] ?? {}).sort().join(",");
    const processed = await service.processMessage(messages[0]);
    const replay = await service.processMessage(messages[0]);

    const newerRequest = callbackRequest(eventXml({
      time: 1788048300,
      event: "change_external_chat",
      change: "update",
      subjectTag: "ChatId",
      subjectValue: "wr-chat-order",
      extra: "<UpdateDetail><![CDATA[change_name]]></UpdateDetail>",
    }), "event-newer");
    const olderRequest = callbackRequest(eventXml({
      time: 1788048200,
      event: "change_external_chat",
      change: "create",
      subjectTag: "ChatId",
      subjectValue: "wr-chat-order",
    }), "event-older");
    const newer = await service.receive(newerRequest.query, newerRequest.wrapper);
    const older = await service.receive(olderRequest.query, olderRequest.wrapper);
    await service.dispatchById(newer.outboxId);
    await service.dispatchById(older.outboxId);
    const newerMessage = messages.find((item) => item.eventId === newer.eventId)!;
    const olderMessage = messages.find((item) => item.eventId === older.eventId)!;
    const newerResult = await service.processMessage(newerMessage);
    const olderResult = await service.processMessage(olderMessage);

    const deleteRequest = callbackRequest(eventXml({
      time: 1788048400,
      event: "change_external_chat",
      change: "dismiss",
      subjectTag: "ChatId",
      subjectValue: "wr-chat-same-second",
    }), "event-delete");
    const createRequest = callbackRequest(eventXml({
      time: 1788048400,
      event: "change_external_chat",
      change: "create",
      subjectTag: "ChatId",
      subjectValue: "wr-chat-same-second",
      extra: "<State><![CDATA[late-create]]></State>",
    }), "event-create");
    const deletion = await service.receive(deleteRequest.query, deleteRequest.wrapper);
    const creation = await service.receive(createRequest.query, createRequest.wrapper);
    await service.dispatchById(deletion.outboxId);
    await service.dispatchById(creation.outboxId);
    const deleteResult = await service.processMessage(messages.find((item) => item.eventId === deletion.eventId)!);
    const lateCreateResult = await service.processMessage(messages.find((item) => item.eventId === creation.eventId)!);

    const unknownRequest = callbackRequest(eventXml({
      time: 1788048500,
      event: "future_event",
      change: "future_change",
      subjectTag: "ChatId",
      subjectValue: "wr-unknown",
    }), "event-unknown");
    const unknown = await service.receive(unknownRequest.query, unknownRequest.wrapper);
    await service.dispatchById(unknown.outboxId);
    const unknownResult = await service.processMessage(messages.find((item) => item.eventId === unknown.eventId)!);

    const failedQueueRequest = callbackRequest(eventXml({
      time: 1788048600,
      event: "change_contact",
      change: "delete_user",
      subjectTag: "UserID",
      subjectValue: "member-queue-failure",
    }), "queue-failure");
    const failedQueueEvent = await service.receive(failedQueueRequest.query, failedQueueRequest.wrapper);
    failQueue = true;
    let queueFailureCaptured = false;
    try {
      await service.dispatchById(failedQueueEvent.outboxId);
    } catch {
      queueFailureCaptured = true;
    }
    failQueue = false;

    const followARequest = callbackRequest(eventXml({
      time: 1788049000,
      event: "change_external_contact",
      change: "del_external_contact",
      subjectTag: "ExternalUserID",
      subjectValue: "wo-client-1",
      extra: "<UserID><![CDATA[employee-a]]></UserID>",
    }), "follow-a");
    const followA = await service.receive(followARequest.query, followARequest.wrapper);
    const followADuplicate = await service.receive(followARequest.query, followARequest.wrapper);
    await service.dispatchById(followA.outboxId);
    const followAMessage = messages.find((item) => item.eventId === followA.eventId)!;
    const followAResult = await service.processMessage(followAMessage);
    const afterFollowA = await withTx(container, async (tx) => tx.execute(drizzleSql`
      SELECT client.delete_time, follow.userid, follow.is_del_user
      FROM work_client AS client
      JOIN work_client_follow AS follow ON follow.client_id = client.id
      WHERE client.id = 101 ORDER BY follow.userid
    `));

    // This event is older than employee A's event, but is a different relationship subject.
    const followBRequest = callbackRequest(eventXml({
      time: 1788048800,
      event: "change_external_contact",
      change: "del_follow_user",
      subjectTag: "ExternalUserID",
      subjectValue: "wo-client-1",
      extra: "<UserID><![CDATA[employee-b]]></UserID>",
    }), "follow-b");
    const followB = await service.receive(followBRequest.query, followBRequest.wrapper);
    await service.dispatchById(followB.outboxId);
    const followBResult = await service.processMessage(
      messages.find((item) => item.eventId === followB.eventId)!,
    );

    const missingFollowRequest = callbackRequest(eventXml({
      time: 1788048900,
      event: "change_external_contact",
      change: "del_follow_user",
      subjectTag: "ExternalUserID",
      subjectValue: "wo-missing-client",
      extra: "<UserID><![CDATA[employee-missing]]></UserID>",
    }), "follow-missing");
    const missingFollow = await service.receive(missingFollowRequest.query, missingFollowRequest.wrapper);
    await service.dispatchById(missingFollow.outboxId);
    const missingFollowResult = await service.processMessage(
      messages.find((item) => item.eventId === missingFollow.eventId)!,
    );

    const rollbackRequest = callbackRequest(eventXml({
      time: 1788049100,
      event: "change_external_contact",
      change: "del_follow_user",
      subjectTag: "ExternalUserID",
      subjectValue: "wo-client-failure",
      extra: "<UserID><![CDATA[employee-failure]]></UserID>",
    }), "follow-rollback");
    const rollbackEvent = await service.receive(rollbackRequest.query, rollbackRequest.wrapper);
    await service.dispatchById(rollbackEvent.outboxId);
    const rollbackMessage = messages.find((item) => item.eventId === rollbackEvent.eventId)!;
    await withTx(container, (tx) => tx.execute(drizzleSql`
      ALTER TABLE work_client_follow
      ADD CONSTRAINT audit_keep_follow_active_ck CHECK (id <> 203 OR is_del_user = 0)
    `));
    let projectionFailureCaptured = false;
    try {
      await service.processMessage(rollbackMessage);
    } catch {
      projectionFailureCaptured = true;
    }
    const failureState = await withTx(container, async (tx) => {
      const rows = await tx.execute(drizzleSql`
        SELECT follow.is_del_user, event.status AS event_status,
          outbox.status AS outbox_status,
          (SELECT count(*)::integer FROM work_callback_watermark
            WHERE event_id = ${rollbackEvent.eventId}) AS watermark_count
        FROM work_client_follow AS follow
        CROSS JOIN work_callback_event AS event
        JOIN work_callback_outbox AS outbox ON outbox.event_id = event.id
        WHERE follow.id = 203 AND event.id = ${rollbackEvent.eventId}
      `);
      return (rows as unknown as Array<Record<string, unknown>>)[0];
    });
    await withTx(container, (tx) => tx.execute(drizzleSql`
      ALTER TABLE work_client_follow DROP CONSTRAINT audit_keep_follow_active_ck
    `));
    const rollbackRetryResult = await service.processMessage(rollbackMessage);

    const beforeForgery = await withTx(container, async (tx) => {
      const rows = await tx.execute(drizzleSql`SELECT count(*)::integer AS count FROM work_callback_event`);
      return Number((rows as unknown as Array<{ count: number }>)[0]?.count ?? -1);
    });
    let forgeryRejected = false;
    try {
      await service.receive({ ...firstRequest.query, signature: "0".repeat(40) }, firstRequest.wrapper);
    } catch (error) {
      forgeryRejected = error instanceof EnterpriseWechatCallbackError
        && error.kind === "authentication";
    }

    const state = await withTx(container, async (tx) => {
      const events = await tx.execute(drizzleSql`
        SELECT status, count(*)::integer AS count
        FROM work_callback_event GROUP BY status ORDER BY status
      `);
      const outbox = await tx.execute(drizzleSql`
        SELECT status, count(*)::integer AS count
        FROM work_callback_outbox GROUP BY status ORDER BY status
      `);
      const watermarks = await tx.execute(drizzleSql`
        SELECT count(*)::integer AS count FROM work_callback_watermark
      `);
      const afterForgery = await tx.execute(drizzleSql`
        SELECT count(*)::integer AS count FROM work_callback_event
      `);
      const follows = await tx.execute(drizzleSql`
        SELECT client.id AS client_id, client.delete_time, follow.userid, follow.is_del_user
        FROM work_client AS client
        JOIN work_client_follow AS follow ON follow.client_id = client.id
        ORDER BY client.id, follow.userid
      `);
      const indexes = await tx.execute(drizzleSql`
        SELECT catalog_indexes.indexname, catalog_indexes.indexdef,
          index_metadata.indisvalid, index_metadata.indisready
        FROM pg_indexes AS catalog_indexes
        JOIN pg_class AS index_class ON index_class.relname = catalog_indexes.indexname
        JOIN pg_namespace AS index_namespace
          ON index_namespace.oid = index_class.relnamespace
         AND index_namespace.nspname = catalog_indexes.schemaname
        JOIN pg_index AS index_metadata ON index_metadata.indexrelid = index_class.oid
        WHERE catalog_indexes.schemaname = current_schema()
          AND catalog_indexes.indexname IN (
            'work_client_active_identity_uq',
            'work_client_follow_active_identity_uq'
          )
        ORDER BY catalog_indexes.indexname
      `);
      const constraint = await tx.execute(drizzleSql`
        SELECT pg_get_constraintdef(constraint_row.oid) AS definition
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.conname = 'wce_status_ck'
          AND constraint_row.conrelid = 'work_callback_event'::regclass
      `);
      return { events, outbox, watermarks, afterForgery, follows, indexes, constraint };
    });
    const afterForgery = Number((state.afterForgery as unknown as Array<{ count: number }>)[0]?.count ?? -1);
    const afterFollowARows = afterFollowA as unknown as Array<{
      delete_time: number | null;
      userid: string;
      is_del_user: number;
    }>;
    const finalFollows = state.follows as unknown as Array<{
      client_id: number;
      delete_time: number | null;
      userid: string;
      is_del_user: number;
    }>;
    const eventStatuses = new Map(
      (state.events as unknown as Array<{ status: string; count: number }>)
        .map((row) => [row.status, Number(row.count)]),
    );
    const localIndexes = state.indexes as unknown as Array<{
      indexname: string;
      indexdef: string;
      indisvalid: boolean;
      indisready: boolean;
    }>;
    const constraintDefinition = (state.constraint as unknown as Array<{ definition: string }>)[0]?.definition ?? "";
    const assertions = {
      get_verification_plaintext: echo === "callback-echo",
      duplicate_event_single_identity: first.eventId === duplicate.eventId
        && first.outboxId === duplicate.outboxId && duplicate.duplicate,
      queue_dispatch_opaque: dispatched.claimed === 1 && dispatched.enqueued === 1
        && queueShape === "action,eventId,eventKey,outboxId",
      first_processed_once: processed === "ordered" && replay === "already-completed",
      older_event_superseded: newerResult === "ordered" && olderResult === "superseded",
      same_second_delete_precedes_create: deleteResult === "ordered" && lateCreateResult === "superseded",
      unknown_event_audited_ignored: unknownResult === "ignored",
      queue_failure_durable: queueFailureCaptured,
      forged_signature_no_write: forgeryRejected && beforeForgery === afterForgery,
      projection_duplicate_single_identity: followA.eventId === followADuplicate.eventId
        && followA.outboxId === followADuplicate.outboxId && followADuplicate.duplicate,
      relation_scoped_tombstone: followAResult === "applied"
        && afterFollowARows.length === 2
        && afterFollowARows.every((row) => row.delete_time === null)
        && afterFollowARows.find((row) => row.userid === "employee-a")?.is_del_user === 1
        && afterFollowARows.find((row) => row.userid === "employee-b")?.is_del_user === 0,
      older_other_employee_not_superseded: followBResult === "applied"
        && finalFollows.find((row) => row.userid === "employee-b")?.is_del_user === 1,
      shared_client_never_soft_deleted: finalFollows.every((row) => row.delete_time === null),
      missing_relationship_is_applied_noop: missingFollowResult === "applied-noop",
      projection_failure_rolls_back_atomically: projectionFailureCaptured
        && Number(failureState?.is_del_user ?? -1) === 0
        && failureState?.event_status === "FAILED"
        && failureState?.outbox_status === "FAILED"
        && Number(failureState?.watermark_count ?? -1) === 0
        && rollbackRetryResult === "applied"
        && finalFollows.find((row) => row.userid === "employee-failure")?.is_del_user === 1,
      projection_statuses_distinguish_outcomes:
        eventStatuses.get("APPLIED") === 3 && eventStatuses.get("APPLIED_NOOP") === 1,
      projection_identity_guards_present: projectionIndexesReady(localIndexes),
      projection_status_constraint_present: callbackEventStatusConstraintReady(constraintDefinition),
      watermark_count_expected:
        Number((state.watermarks as unknown as Array<{ count: number }>)[0]?.count ?? -1) === 7,
      status_evidence_present:
        Array.isArray(state.events) && Array.isArray(state.outbox),
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
    }
    const interimSnapshot = await safetySnapshot(admin, ISOLATION_SAFETY_TABLES);
    if (!sameSafetySnapshot(beforeSnapshot, interimSnapshot)) {
      throw new Error("public business rows or sequences changed during isolated scenario");
    }
    result = {
      complete: true,
      assertions,
      checks_passed: Object.keys(assertions).length,
      expected_checks: Object.keys(assertions).length,
      status: { events: state.events, outbox: state.outbox },
      projection_indexes: localIndexes,
      event_status_constraint: constraintDefinition,
    };
  } finally {
    if (db) await db.$client.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const afterSchemas = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
    `;
    const schemaRemoved = await admin<Array<{ removed: boolean }>>`
      SELECT to_regnamespace(${schema}) IS NULL AS removed
    `;
    const afterSnapshot = await safetySnapshot(admin, ISOLATION_SAFETY_TABLES);
    if (afterSchemas[0]?.count !== beforeSchemas[0]?.count) throw new Error("temporary schema leaked");
    if (!schemaRemoved[0]?.removed) throw new Error("temporary schema still resolves");
    publicStateUnchanged = sameSafetySnapshot(beforeSnapshot, afterSnapshot);
    if (!publicStateUnchanged) throw new Error("public business rows or sequences changed");
    cleanupVerified = true;
    await admin.end({ timeout: 1 });
  }
  if (!result) throw new Error("isolated scenario produced no result");
  return {
    ...result,
    temporary_schema_removed: cleanupVerified,
    public_rows_and_sequences_unchanged: publicStateUnchanged,
  };
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
      return Response.json({ error: "forbidden" }, {
        status: 403,
        headers: { "Cache-Control": "private, no-store" },
      });
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
        event: "enterprise_wechat_callback_audit_failed",
        error: error instanceof Error && /^[a-z0-9_ :.-]{1,256}$/i.test(error.message)
          ? error.message
          : "audit_failed",
      }));
      return Response.json({
        error: "audit failed",
        detail: error instanceof Error
          ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1000)
          : "unknown",
      }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
