import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import type { Env, OrderMessage, WechatCallbackOutboxMessage } from "@/env";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "@/lib/di";
import {
  paymentCallbackEvent,
  qrcode,
  userCard,
  wechatCallbackEvent,
  wechatCallbackOutbox,
  wechatMessage,
  wechatQrcode,
  wechatQrcodeRecord,
  wechatUser,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import { WechatCallbackService } from "@/services/wechat/WechatCallbackService";
import {
  decryptWechatCallback,
  encryptWechatReply,
  wechatEncryptedXmlValue,
  wechatXmlText,
  type WechatCallbackSource,
} from "@/services/wechat/WechatCallbackCrypto";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_MIGRATE_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const PREFIX = "codex_wechat_callback_";
const TABLES = ["wechat_callback_event", "wechat_callback_outbox", "wechat_callback_watermark"] as const;
const EXPECTED_COLUMNS = {
  wechat_callback_event: [
    "id", "source", "event_key", "replay_key", "payload_hash", "subject_key_hash",
    "app_id", "from_user", "msg_type", "event_type", "event_time", "sequence_rank",
    "payload", "reply_payload", "status", "attempt_count", "lease_until", "lease_token",
    "last_error_code", "received_time", "processed_time", "retain_until", "update_time",
  ],
  wechat_callback_outbox: [
    "id", "event_id", "replay_key", "status", "dispatch_count", "attempt_count",
    "available_time", "lease_until", "lease_token", "last_error_code", "enqueued_time",
    "processed_time", "add_time", "update_time",
  ],
  wechat_callback_watermark: [
    "source", "projection_type", "subject_key_hash", "last_event_id", "last_event_key",
    "last_event_time", "last_sequence_rank", "update_time",
  ],
} as const;
const EXPECTED_CONSTRAINTS = [
  "wcwm_event_fk", "wcwm_hash_time_ck", "wcwm_pkey", "wcwm_projection_ck", "wcwm_source_ck",
  "wcevt_hash_key_ck", "wcevt_payload_ck", "wcevt_source_ck", "wcevt_status_ck",
  "wcevt_time_count_ck", "wechat_callback_event_pkey", "wechat_callback_outbox_pkey",
  "wcout_event_fk", "wcout_replay_key_ck", "wcout_status_ck", "wcout_time_count_ck",
] as const;
const EXPECTED_INDEXES = [
  "wcwm_last_event", "wcwm_pkey", "wcevt_actionable_status", "wcevt_replay_key_uq",
  "wcevt_retention_due", "wcevt_source_event_uq", "wcevt_subject_order",
  "wechat_callback_event_pkey", "wechat_callback_outbox_pkey", "wcout_dispatch_ready",
  "wcout_event_uq", "wcout_expired_lease", "wcout_replay_key_uq",
] as const;
const APP_ID = "wx-callback-isolated";
const TOKEN = "isolated-callback-token";
const AES_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1))
  .toString("base64").slice(0, -1);

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

async function schemaEvidence(client: postgres.Sql, schema: string) {
  const relations = await client<Array<{ table_name: string; relkind: string; relpersistence: string }>>`
    SELECT relation.relname AS table_name, relation.relkind::text, relation.relpersistence::text
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY relation.relname
  `;
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
    type: string;
    validated: boolean;
    no_inherit: boolean;
  }>>`
    SELECT constraint_row.conname AS name, constraint_row.convalidated AS validated,
      constraint_row.connoinherit AS no_inherit, constraint_row.contype::text AS type
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = ${schema} AND relation.relname IN ${client([...TABLES])}
    ORDER BY constraint_row.conname
  `;
  const indexes = await client<Array<{ name: string; valid: boolean; ready: boolean; partial: boolean }>>`
    SELECT index_relation.relname AS name, index_row.indisvalid AS valid,
      index_row.indisready AS ready, index_row.indpred IS NOT NULL AS partial
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
        `SELECT count(*)::integer AS count FROM "${schema}"."${table}"`,
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
    && JSON.stringify(indexes.map((row) => row.name)) === JSON.stringify([...EXPECTED_INDEXES].sort())
    && indexes.every((row) => row.valid && row.ready)
    && indexes.filter((row) => row.partial).length === 4;
  return { complete, relations, columns, constraints, indexes, rowCounts };
}

async function productionAudit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_wechat_callback_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const version = await tx<Array<{ version: string }>>`SELECT version()`;
      const evidence = await schemaEvidence(tx as unknown as postgres.Sql, "public");
      const config = await tx<Array<{ menu_name: string; configured: boolean }>>`
        SELECT menu_name, length(btrim(COALESCE(value, ''), ' "')) > 0 AS configured
        FROM system_config
        WHERE menu_name IN (
          'wechat_appid', 'routine_appId', 'wechat_token', 'wechat_encodingaeskey',
          'wechat_encode', 'wechat_appsecret', 'routine_appsecret', 'create_wechat_user'
        )
        ORDER BY menu_name
      `;
      const identities = await tx<Array<{ user_type: string; subscribe: number; count: number }>>`
        SELECT user_type, subscribe, count(*)::integer AS count
        FROM wechat_user GROUP BY user_type, subscribe ORDER BY user_type, subscribe
      `;
      const catalog = await tx<Array<{ qrcodes: number; channels: number; cards: number; claims: number; messages: number }>>`
        SELECT
          (SELECT count(*)::integer FROM qrcode) AS qrcodes,
          (SELECT count(*)::integer FROM wechat_qrcode) AS channels,
          (SELECT count(*)::integer FROM wechat_card) AS cards,
          (SELECT count(*)::integer FROM user_card) AS claims,
          (SELECT count(*)::integer FROM wechat_message) AS messages
      `;
      const payments = await tx<Array<{ status: string; count: number }>>`
        SELECT status, count(*)::integer AS count FROM payment_callback_event
        GROUP BY status ORDER BY status
      `;
      const orders = await tx<Array<{ paid: number; status: number; count: number }>>`
        SELECT paid, status, count(*)::integer AS count FROM store_order
        GROUP BY paid, status ORDER BY paid, status
      `;
      return {
        engine: version[0]?.version ?? "unknown",
        schema: evidence,
        configuration_presence_only: config,
        identity_aggregates: identities,
        catalog_aggregates: catalog[0] ?? {},
        payment_ledger_aggregates: payments,
        order_state_aggregates: orders,
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
    applicationName: "cinashop_wechat_callback_migration",
  });
  const admin = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5 });
  try {
    const before = await schemaEvidence(admin, "public");
    if (before.relations.length !== 0 && before.relations.length !== 3) {
      throw new Error("partial_wechat_callback_schema_exists");
    }
    if (before.relations.length === 3 && !before.complete) throw new Error("wechat_callback_schema_collision");
    const container = createContainerFromDb(db);
    const migration = new MigrationService(container).wechatCallbackPipelineMigrationSqlForVerification();
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const first = await schemaEvidence(admin, "public");
    if (!first.complete) throw new Error("wechat_callback_schema_verification_failed");
    await withTx(container, (tx) => tx.execute(sql.raw(migration)));
    const second = await schemaEvidence(admin, "public");
    if (!second.complete || JSON.stringify(first.columns) !== JSON.stringify(second.columns)) {
      throw new Error("wechat_callback_migration_not_idempotent");
    }
    return { complete: true, created: before.relations.length === 0, idempotent_second_pass: true, evidence: second };
  } finally {
    await db.$client.end({ timeout: 1 });
    await admin.end({ timeout: 1 });
  }
}

function queueBody(result: { eventId: number; outboxId: number; replayKey: string }): WechatCallbackOutboxMessage {
  return { action: "processWechatCallbackOutbox", eventId: result.eventId, outboxId: result.outboxId, replayKey: result.replayKey };
}

async function isolatedScenario(connectionString: string) {
  const admin = postgres(connectionString, {
    max: 5, prepare: false, connect_timeout: 10, idle_timeout: 5,
    connection: { application_name: "cinashop_wechat_callback_isolated_admin" },
  });
  const schema = `${PREFIX}${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  let db: ReturnType<typeof createDbFromConnectionString> | undefined;
  const beforeSchemas = await admin<Array<{ count: number }>>`
    SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
  `;
  let result: Record<string, unknown> | undefined;
  try {
    await admin.unsafe(`CREATE SCHEMA "${schema}"`);
    db = createDbFromConnectionString(connectionString, 5, {
      searchPath: schema,
      applicationName: "cinashop_wechat_callback_isolated",
    });
    const container = createContainerFromDb(db);
    const migrations = new MigrationService(container);
    await withTx(container, (tx) => tx.execute(sql.raw(migrations.wechatCallbackPipelineMigrationSqlForVerification())));
    const firstEvidence = await schemaEvidence(admin, schema);
    await withTx(container, (tx) => tx.execute(sql.raw(migrations.wechatCallbackPipelineMigrationSqlForVerification())));
    const secondEvidence = await schemaEvidence(admin, schema);
    if (!firstEvidence.complete || !secondEvidence.complete) {
      throw new Error(`isolated_migration_shape_failed:${JSON.stringify({
        relations: firstEvidence.relations.length === 3
          && firstEvidence.relations.every((row) => row.relkind === "r" && row.relpersistence === "p"),
        columns: firstEvidence.columns.map((row) => row.columns.length),
        columnMatches: firstEvidence.columns.map((row) => JSON.stringify(row.columns) === JSON.stringify(
          EXPECTED_COLUMNS[row.table_name as keyof typeof EXPECTED_COLUMNS],
        )),
        constraintNames: JSON.stringify(firstEvidence.constraints.map((row) => row.name))
          === JSON.stringify([...EXPECTED_CONSTRAINTS].sort()),
        constraintsValid: firstEvidence.constraints.every((row) => (
          row.validated && (row.type !== "c" || !row.no_inherit)
        )),
        indexNames: JSON.stringify(firstEvidence.indexes.map((row) => row.name))
          === JSON.stringify([...EXPECTED_INDEXES].sort()),
        indexesValid: firstEvidence.indexes.every((row) => row.valid && row.ready),
        partialIndexes: firstEvidence.indexes.filter((row) => row.partial).length,
        secondComplete: secondEvidence.complete,
      })}`);
    }

    await admin.unsafe(`
      CREATE TABLE "${schema}".wechat_reply AS SELECT * FROM public.wechat_reply WITH NO DATA;
      CREATE TABLE "${schema}".wechat_key AS SELECT * FROM public.wechat_key WITH NO DATA;
      CREATE TABLE "${schema}".qrcode AS SELECT * FROM public.qrcode WITH NO DATA;
      CREATE TABLE "${schema}".wechat_qrcode AS SELECT * FROM public.wechat_qrcode WITH NO DATA;
      CREATE TABLE "${schema}".wechat_qrcode_record AS SELECT * FROM public.wechat_qrcode_record WITH NO DATA;
      CREATE TABLE "${schema}".wechat_message AS SELECT * FROM public.wechat_message WITH NO DATA;
      CREATE TABLE "${schema}".wechat_user AS SELECT * FROM public.wechat_user WITH NO DATA;
      CREATE TABLE "${schema}".wechat_card AS SELECT * FROM public.wechat_card WITH NO DATA;
      CREATE TABLE "${schema}".user_card AS SELECT * FROM public.user_card WITH NO DATA;
      CREATE TABLE "${schema}".store_order AS SELECT * FROM public.store_order WITH NO DATA;
      CREATE TABLE "${schema}".user_recharge AS SELECT * FROM public.user_recharge WITH NO DATA;
      CREATE TABLE "${schema}".other_order AS SELECT * FROM public.other_order WITH NO DATA;
      ${["wechat_reply", "wechat_key", "qrcode", "wechat_qrcode", "wechat_qrcode_record", "wechat_message", "wechat_user", "wechat_card", "user_card"]
        .map((table) => `CREATE SEQUENCE "${schema}".${table}_id_seq; ALTER TABLE "${schema}".${table} ALTER COLUMN id SET DEFAULT nextval('"${schema}".${table}_id_seq');`).join("\n")}
    `);
    await withTx(container, (tx) => tx.execute(sql.raw(migrations.paymentCallbackPipelineMigrationSqlForVerification())));
    await withTx(container, (tx) => tx.execute(sql.raw(migrations.paymentReconciliationMigrationSqlForVerification())));

    const configValues = new Map<string, string>([
      ["cfg_wechat_appid", APP_ID], ["cfg_routine_appId", APP_ID], ["cfg_create_wechat_user", "0"],
    ]);
    const sent: unknown[] = [];
    let failQueue = false;
    const queue = {
      async sendBatch(messages: Array<{ body: unknown }>) {
        if (failQueue) throw new Error("injected_queue_failure");
        sent.push(...messages.map((message) => message.body));
      },
    } as unknown as Queue<OrderMessage>;
    const serviceEnv = {
      ORDER_QUEUE: queue,
      WECHAT_OFFICIAL_CALLBACK_TOKEN: TOKEN,
      WECHAT_OFFICIAL_CALLBACK_AES_KEY: AES_KEY,
      WECHAT_MINI_CALLBACK_TOKEN: TOKEN,
      WECHAT_MINI_CALLBACK_AES_KEY: AES_KEY,
      CONFIG_KV: {
        async get(key: string) { return configValues.get(key) ?? ""; },
        async put(key: string, value: string) { configValues.set(key, value); },
        async delete(key: string) { configValues.delete(key); },
      },
    } as unknown as Env;
    const service = new WechatCallbackService(container, serviceEnv);
    let nonceCounter = 0;
    const receive = async (xml: string, source: WechatCallbackSource = "official") => {
      nonceCounter += 1;
      const timestamp = String(1_800_000_000 + nonceCounter);
      const nonce = `nonce-${nonceCounter}`;
      const encryptedOuter = await encryptWechatReply(xml, TOKEN, AES_KEY, APP_ID, timestamp, nonce);
      const encrypted = wechatEncryptedXmlValue(encryptedOuter);
      const msgSignature = wechatXmlText(encryptedOuter, "MsgSignature") ?? "";
      return service.receiveEncrypted(source, { signature: "", msgSignature, timestamp, nonce }, `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`);
    };
    const messageXml = (content: string) => `<xml><ToUserName>gh-audit</ToUserName><FromUserName>openid-message</FromUserName><CreateTime>1800000100</CreateTime><MsgType>text</MsgType><MsgId>9001</MsgId><Content><![CDATA[${content}]]></Content></xml>`;

    await withTx(container, (tx) => tx.execute(sql.raw(`
      INSERT INTO wechat_reply (id, type, data, status, hide) VALUES
        (1, 'text', '{"content":"exact-reply"}', 1, 0),
        (2, 'text', '{"content":"default-reply"}', 1, 0);
      INSERT INTO wechat_key (id, reply_id, keys) VALUES (1, 1, 'hello'), (2, 2, 'default');
    `)));
    const first = await receive(messageXml("hello"));
    const duplicate = await receive(messageXml("hello"));
    const replyPlain = first.responseBody === "success"
      ? ""
      : decryptWechatCallback(wechatEncryptedXmlValue(first.responseBody), AES_KEY, APP_ID);
    const duplicateReplyPlain = duplicate.responseBody === "success"
      ? ""
      : decryptWechatCallback(wechatEncryptedXmlValue(duplicate.responseBody), AES_KEY, APP_ID);
    let immutableConflict = false;
    try { await receive(messageXml("changed")); } catch { immutableConflict = true; }
    failQueue = true;
    let queueFailure = false;
    try { await service.dispatchById(first.outboxId); } catch { queueFailure = true; }
    failQueue = false;
    await withTx(container, (tx) => tx.update(wechatCallbackOutbox).set({ availableTime: 0 })
      .where(eq(wechatCallbackOutbox.id, first.outboxId)));
    await service.dispatchById(first.outboxId);
    const messageResult = await service.processMessage(queueBody(first));
    const messageReplay = await service.processMessage(queueBody(first));

    await withTx(container, (tx) => tx.insert(wechatUser).values({
      id: 1, uid: 101, openid: "openid-follow", userType: "wechat", isDel: 0,
      unionid: "", nickname: "", headimgurl: "", sex: 0, city: "", language: "",
      province: "", country: "", remark: "", groupid: 0, tagidList: "", subscribe: 1,
      subscribeTime: 100, addTime: 100, second: 0, isComplete: 0,
    }));
    const followXml = (event: string, time: number) => `<xml><ToUserName>gh-audit</ToUserName><FromUserName>openid-follow</FromUserName><CreateTime>${time}</CreateTime><MsgType>event</MsgType><Event>${event}</Event></xml>`;
    const unsubscribe = await receive(followXml("unsubscribe", 1800000300));
    const lateSubscribe = await receive(followXml("subscribe", 1800000200));
    await service.processMessage(queueBody(unsubscribe));
    await service.processMessage(queueBody(lateSubscribe));

    await withTx(container, (tx) => tx.execute(sql.raw(`
      INSERT INTO wechat_qrcode (id, uid, is_del, scan, follow) VALUES (1, 0, 0, 0, 0);
      INSERT INTO qrcode (id, third_type, third_id, ticket, status, scan) VALUES
        (1, 'wechatqrcode', 1, 'ticket-audit', 1, 0);
    `)));
    const scanXml = (time: number, eventKey: string) => `<xml><ToUserName>gh-audit</ToUserName><FromUserName>openid-follow</FromUserName><CreateTime>${time}</CreateTime><MsgType>event</MsgType><Event>SCAN</Event><EventKey>${eventKey}</EventKey><Ticket>ticket-audit</Ticket></xml>`;
    const scanNew = await receive(scanXml(1800000400, "scan-new"));
    const scanOld = await receive(scanXml(1800000390, "scan-old"));
    await service.processMessage(queueBody(scanNew));
    await service.processMessage(queueBody(scanOld));
    const scanReplay = await service.processMessage(queueBody(scanOld));

    await withTx(container, (tx) => tx.execute(sql.raw(`
      INSERT INTO wechat_card (id, card_id, status, is_del) VALUES (1, 'card-audit', 1, 0);
    `)));
    const cardXml = (event: string, time: number, code: string) => `<xml><ToUserName>gh-audit</ToUserName><FromUserName>openid-follow</FromUserName><CreateTime>${time}</CreateTime><MsgType>event</MsgType><Event>${event}</Event><CardId>card-audit</CardId>${code ? `<UserCardCode>${code}</UserCardCode>` : ""}</xml>`;
    const cardGet = await receive(cardXml("user_get_card", 1800000500, "code-a"));
    const cardDelete = await receive(cardXml("user_del_card", 1800000600, ""));
    const staleCardGet = await receive(cardXml("user_get_card", 1800000550, "code-b"));
    await service.processMessage(queueBody(cardGet));
    await service.processMessage(queueBody(cardDelete));
    await service.processMessage(queueBody(staleCardGet));

    await withTx(container, (tx) => tx.execute(sql.raw(`
      INSERT INTO store_order (id, order_id, pay_price, pid, paid, status)
      VALUES (1, 'wxAuditPayment', 1.00, 0, 0, 0), (2, 'wxAuditReceipt', 1.00, 0, 1, 2);
    `)));
    const payment = await receive(`<xml><ToUserName>gh-audit</ToUserName><FromUserName>openid-follow</FromUserName><CreateTime>1800000700</CreateTime><MsgType>event</MsgType><Event>funds_order_pay</Event><order_info><![CDATA[{"trade_no":"wxAuditPayment","transaction_id":"txAuditPayment"}]]></order_info></xml>`);
    const paymentResult = await service.processMessage(queueBody(payment));
    const receipt = await receive(`<xml><ToUserName>gh-audit</ToUserName><FromUserName>openid-follow</FromUserName><CreateTime>1800000800</CreateTime><MsgType>event</MsgType><Event>trade_manage_order_settlement</Event><merchant_trade_no>wxAuditReceipt</merchant_trade_no><confirm_receive_method>auto</confirm_receive_method></xml>`, "mini");
    const receiptResult = await service.processMessage(queueBody(receipt));

    const submit = await receive(cardXml("submit_membercard_user_info", 1800000900, "code-a"));
    let deadResult: unknown = "not-run";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { deadResult = await service.processMessage(queueBody(submit)); } catch { deadResult = "retry"; }
      await withTx(container, (tx) => tx.update(wechatCallbackOutbox).set({ availableTime: 0 })
        .where(eq(wechatCallbackOutbox.id, submit.outboxId)));
    }

    const [eventRows, followRows, scanRows, cardRows, messageRows, paymentRows, submitRows] = await Promise.all([
      withTx(container, (tx) => tx.select().from(wechatCallbackEvent).orderBy(wechatCallbackEvent.id)),
      withTx(container, (tx) => tx.select({ subscribe: wechatUser.subscribe }).from(wechatUser).where(eq(wechatUser.openid, "openid-follow"))),
      withTx(container, (tx) => tx.select({ qrScan: qrcode.scan, channelScan: wechatQrcode.scan }).from(qrcode).innerJoin(wechatQrcode, eq(wechatQrcode.id, qrcode.thirdId))),
      withTx(container, (tx) => tx.select({ isDel: userCard.isDel, code: userCard.code }).from(userCard)),
      withTx(container, (tx) => tx.select({ count: sql<number>`count(*)::integer`, result: sql<string>`min(${wechatMessage.result})` }).from(wechatMessage)),
      withTx(container, (tx) => tx.select({ count: sql<number>`count(*)::integer` }).from(paymentCallbackEvent)),
      withTx(container, (tx) => tx.select({ status: wechatCallbackEvent.status, attempts: wechatCallbackEvent.attemptCount }).from(wechatCallbackEvent).where(eq(wechatCallbackEvent.id, submit.eventId))),
    ]);
    const recordRows = await withTx(container, (tx) => tx.select({ count: sql<number>`count(*)::integer` }).from(wechatQrcodeRecord));
    const firstEvents = eventRows.filter((row) => row.eventKey === eventRows[0]?.eventKey);
    const lateFollow = eventRows.find((row) => row.id === lateSubscribe.eventId);
    const staleCard = eventRows.find((row) => row.id === staleCardGet.eventId);
    const assertions = {
      migration_shape_exact_and_idempotent: firstEvidence.complete && secondEvidence.complete,
      signature_decryption_and_reply_snapshot:
        replyPlain.includes("exact-reply") && duplicateReplyPlain === replyPlain,
      duplicate_receive_is_atomic: duplicate.duplicate && first.eventId === duplicate.eventId && firstEvents.length === 1,
      immutable_conflict_is_rejected: immutableConflict,
      queue_payload_is_opaque: sent.some((item) => JSON.stringify(Object.keys(item as object).sort()) === JSON.stringify(["action", "eventId", "outboxId", "replayKey"])),
      queue_failure_is_durable: queueFailure,
      message_projection_and_replay_are_idempotent: messageResult === "completed" && messageReplay === "already-completed" && messageRows[0]?.count === 1,
      user_text_is_not_persisted: !JSON.stringify(eventRows).includes("hello") && !String(messageRows[0]?.result ?? "").includes("hello"),
      follow_out_of_order_does_not_regress: followRows[0]?.subscribe === 0 && lateFollow?.status === "SUPERSEDED",
      scan_is_additive_but_replay_safe: scanRows[0]?.qrScan === 2 && scanRows[0]?.channelScan === 2 && recordRows[0]?.count === 2 && scanReplay === "already-completed",
      card_delete_is_terminal_against_late_get: cardRows[0]?.isDel === 1 && cardRows[0]?.code === "code-a" && staleCard?.status === "SUPERSEDED",
      payment_enters_shared_ledger: paymentResult === "completed" && paymentRows[0]?.count === 1,
      completed_receipt_is_idempotent_noop: receiptResult === "completed",
      listener_failure_is_not_acknowledged_and_exhausts: deadResult === "dead" && submitRows[0]?.status === "DEAD" && submitRows[0]?.attempts === 8,
    };
    if (!Object.values(assertions).every(Boolean)) {
      const failed = Object.entries(assertions).filter(([, passed]) => !passed).map(([name]) => name);
      throw new Error(`isolated assertions failed: ${JSON.stringify({
        failed,
        cardRows,
        staleCardStatus: staleCard?.status,
      })}`);
    }
    result = {
      complete: true,
      checks_passed: Object.keys(assertions).length,
      expected_checks: Object.keys(assertions).length,
      assertions,
      evidence: secondEvidence,
      stored_event_status_counts: Object.entries(eventRows.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {})),
      raw_xml_or_signature_columns: false,
      reply_catalog_value_returned: false,
    };
  } finally {
    if (db) await db.$client.end({ timeout: 1 });
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const afterSchemas = await admin<Array<{ count: number }>>`
      SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE ${PREFIX + "%"}
    `;
    const removed = await admin<Array<{ removed: boolean }>>`SELECT to_regnamespace(${schema}) IS NULL AS removed`;
    await admin.end({ timeout: 1 });
    if (afterSchemas[0]?.count !== beforeSchemas[0]?.count || !removed[0]?.removed) {
      throw new Error("temporary_schema_cleanup_failed");
    }
  }
  if (!result) throw new Error("isolated_scenario_produced_no_result");
  return { ...result, temporary_schema_removed: true };
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
    if (!(await authorized(request, expected ?? ""))) return Response.json({ error: "forbidden" }, { status: 403 });
    try {
      const result = path === "/audit"
        ? await productionAudit(env.HYPERDRIVE.connectionString)
        : path === "/migrate"
          ? await migrateProduction(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result);
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1000) : "audit_failed",
      }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
