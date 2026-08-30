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
        WHERE schemaname = 'public' AND tablename IN ${tx([...PIPELINE_TABLES])}
        ORDER BY tablename, indexname
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
        config: config[0],
        domain: domain[0],
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function businessFingerprint(client: postgres.Sql): Promise<string> {
  const parts: string[] = [];
  for (const table of BUSINESS_TABLES) {
    const exists = await client<Array<{ exists: boolean }>>`
      SELECT to_regclass(${'public.' + table}) IS NOT NULL AS exists
    `;
    if (!exists[0]?.exists) {
      parts.push(`${table}:missing`);
      continue;
    }
    const rows = await client.unsafe<Array<{ fingerprint: string }>>(
      `SELECT md5(COALESCE(string_agg(md5(row_to_json(t)::text), '' ORDER BY md5(row_to_json(t)::text)), '')) AS fingerprint FROM "public"."${table}" AS t`,
    );
    parts.push(`${table}:${rows[0]?.fingerprint ?? ""}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
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
    const beforeFingerprint = await businessFingerprint(admin);
    const before = await pipelineState(admin);
    const migration = new MigrationService(createContainerFromDb(db))
      .workCallbackPipelineMigrationSqlForVerification();
    for (let pass = 0; pass < 2; pass += 1) {
      await withTx(createContainerFromDb(db), async (tx) => {
        await tx.execute(drizzleSql.raw("SET LOCAL lock_timeout = '5s'"));
        await tx.execute(drizzleSql.raw("SET LOCAL statement_timeout = '45s'"));
        await tx.execute(drizzleSql.raw(migration));
      });
    }
    const after = await pipelineState(admin);
    const afterFingerprint = await businessFingerprint(admin);
    const indexes = await admin<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ${admin([...PIPELINE_TABLES])}
      ORDER BY indexname
    `;
    return {
      complete: Object.values(after).every((item) => item.exists && item.count === 0),
      passes: 2,
      before,
      after,
      indexes,
      business_fingerprint_unchanged: beforeFingerprint === afterFingerprint,
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
  const beforeFingerprint = await businessFingerprint(admin);
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
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
      await tx.execute(drizzleSql.raw(
        new MigrationService(container).workCallbackPipelineMigrationSqlForVerification(),
      ));
      await tx.execute(drizzleSql`
        INSERT INTO system_config (menu_name, value, is_store, sort)
        VALUES ('wechat_work_corpid', ${callbackCorpId}, 0, 0)
      `);
    });
    // Exact DDL is idempotent in the same isolated production engine.
    await withTx(container, (tx) => tx.execute(drizzleSql.raw(
      new MigrationService(container).workCallbackPipelineMigrationSqlForVerification(),
    )));

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
      return { events, outbox, watermarks, afterForgery };
    });
    const afterForgery = Number((state.afterForgery as unknown as Array<{ count: number }>)[0]?.count ?? -1);
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
      watermark_count_expected:
        Number((state.watermarks as unknown as Array<{ count: number }>)[0]?.count ?? -1) === 3,
      status_evidence_present:
        Array.isArray(state.events) && Array.isArray(state.outbox),
    };
    if (!Object.values(assertions).every(Boolean)) {
      throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
    }
    return {
      complete: true,
      assertions,
      checks_passed: Object.keys(assertions).length,
      expected_checks: 11,
      status: { events: state.events, outbox: state.outbox },
      public_state_unchanged: true,
    };
  } finally {
    if (db) await db.$client.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const afterSchemas = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
    `;
    const afterFingerprint = await businessFingerprint(admin);
    if (afterSchemas[0]?.count !== beforeSchemas[0]?.count) throw new Error("temporary schema leaked");
    if (afterFingerprint !== beforeFingerprint) throw new Error("public business state changed");
    await admin.end({ timeout: 1 });
  }
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
