import bcrypt from "bcryptjs";
import { and, eq, or, sql } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type DbClient,
} from "@/lib/di";
import {
  legacyCategory,
  storeServiceLog,
  storeServiceRecord,
  storeServiceSpeechcraft,
  storeServiceTransfer,
  user as userTable,
  userLabelRelation,
} from "@/models/schema";
import {
  KefuAuthService,
  type KefuAuthEnv,
} from "@/services/kefu/KefuAuthService";
import { KefuCoreService } from "@/services/kefu/KefuCoreService";
import { KefuTransferService } from "@/services/kefu/KefuTransferService";
import {
  KefuRealtimeService,
  type ChatSocketSession,
} from "@/services/kefu/KefuRealtimeService";
import { CustomerServiceCatalogService } from "@/services/message/CustomerServiceCatalogService";
import { MigrationService } from "@/services/MigrationService";
import { md5, verifyToken } from "@/utils/jwt";

const TABLES = [
  "user",
  "store_service",
  "store_service_log",
  "store_service_record",
  "category",
  "store_service_speechcraft",
  "user_group",
  "user_label",
  "user_label_relation",
  "system_user_level",
] as const;

const PRIVATE_SEQUENCES = [
  ["store_service_log", "id"],
  ["store_service_record", "id"],
  ["category", "id"],
  ["store_service_speechcraft", "id"],
  ["user_label_relation", "id"],
] as const;

interface Fingerprint {
  count: number;
  digest: string;
}

interface ProductionSummary {
  service_accounts: number;
  active_accounts: number;
  online_accounts: number;
  sessions: number;
  messages: number;
  speechcraft: number;
  speechcraft_categories: number;
}

export interface KefuCorePostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  production: ProductionSummary;
  isolated: Record<string, boolean>;
}

export interface KefuCoreIndexApplyReport {
  server_version: string;
  applied_indexes: string[];
  second_apply_idempotent: boolean;
  public_state_unchanged: boolean;
  transfer_table_present: boolean;
  transfer_indexes: string[];
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Kefu core integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_kefu_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicFingerprints(db: DbClient) {
  const tables: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const rows = await db.$client.unsafe<Array<Fingerprint>>(`
      SELECT count(*)::int AS count,
             COALESCE(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest
      FROM public.${identifier(table)} AS t
    `);
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const sequences = await db.$client<Array<{ sequencename: string; last_value: string | null }>>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public'
      AND sequencename IN (
        'store_service_log_id_seq',
        'store_service_record_id_seq',
        'category_id_seq',
        'store_service_speechcraft_id_seq',
        'user_label_relation_id_seq'
      )
    ORDER BY sequencename
  `;
  return { tables, sequences };
}

async function productionSummary(db: DbClient): Promise<ProductionSummary> {
  const row = (await db.$client<Array<ProductionSummary>>`
    SELECT
      (SELECT count(*)::int FROM public.store_service) AS service_accounts,
      (SELECT count(*)::int FROM public.store_service WHERE is_del = 0 AND status = 1 AND account_status = 1) AS active_accounts,
      (SELECT count(*)::int FROM public.store_service WHERE is_del = 0 AND status = 1 AND account_status = 1 AND online = 1) AS online_accounts,
      (SELECT count(*)::int FROM public.store_service_record) AS sessions,
      (SELECT count(*)::int FROM public.store_service_log) AS messages,
      (SELECT count(*)::int FROM public.store_service_speechcraft) AS speechcraft,
      (SELECT count(*)::int FROM public.category WHERE type = 0 AND "group" = 1) AS speechcraft_categories
  `)[0];
  assertCondition(row, "production summary returned no row");
  return row;
}

async function setupSchema(db: DbClient, schemaName: string, passwordHash: string) {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await tx.unsafe(`CREATE TABLE ${schema}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`);
    }
    for (const [table, column] of PRIVATE_SEQUENCES) {
      const sequence = `${table}_${column}_seq`;
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequence)}`);
      await tx.unsafe(`ALTER SEQUENCE ${schema}.${identifier(sequence)} OWNED BY ${schema}.${identifier(table)}.${identifier(column)}`);
      await tx.unsafe(`ALTER TABLE ${schema}.${identifier(table)} ALTER COLUMN ${identifier(column)} SET DEFAULT nextval('${schemaName}.${sequence}'::regclass)`);
    }

    await tx.unsafe(`
      INSERT INTO ${schema}."user"
        (uid, account, pwd, nickname, avatar, phone, now_money, spread_uid, is_promoter, birthday, user_type, level, group_id, status, is_del)
      VALUES
        (1001, 'kefu-user-1', '', '客服一', '/kefu-1.png', '13800000001', 0, 0, 0, 0, 'kefu', 0, 0, 1, 0),
        (1002, 'kefu-user-2', '', '客服二', '/kefu-2.png', '13800000002', 0, 0, 0, 0, 'kefu', 0, 0, 1, 0),
        (2001, 'customer-1', '${md5("Audit-User-Pass-2026")}', '客户一', '/user-1.png', '13900000001', 88.50, 0, 1, 946684800, 'wechat', 1, 1, 1, 0),
        (2002, 'customer-2', '${md5("Audit-User-Pass-2026")}', '客户二', '/user-2.png', '13900000002', 10.00, 0, 0, 0, 'routine', 0, 0, 1, 0)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service
        (id, uid, online, account, password, avatar, nickname, phone, account_status, status, is_del)
      VALUES
        (1, 1001, 0, 'support-one', $1, '/kefu-1.png', '客服一', '13800000001', 1, 1, 0),
        (2, 1002, 1, 'support-two', $1, '/kefu-2.png', '客服二', '13800000002', 1, 1, 0),
        (3, 1003, 1, 'disabled-support', $1, '', '停用客服', '', 0, 1, 0)
    `, [passwordHash]);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service_record
        (id, user_id, to_uid, nickname, avatar, is_tourist, online, type, add_time, update_time, mssage_num, message, message_type)
      VALUES
        (1, 1001, 2001, '客户一', '/user-1.png', 0, 1, 1, 1700000000, 1700000020, 2, '请问库存？', 1),
        (2, 1002, 2002, '客户二', '/user-2.png', 0, 1, 1, 1700000010, 1700000030, 1, '其他会话', 1)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service_log
        (id, uid, to_uid, is_tourist, add_time, type, msn, msn_type)
      VALUES
        (1, 2001, 1001, 0, 1700000000, 0, '请问库存？', 1),
        (2, 1001, 2001, 0, 1700000001, 0, '库存充足', 1),
        (3, 2002, 1002, 0, 1700000010, 0, '其他会话', 1)
    `);
    await tx.unsafe(`INSERT INTO ${schema}.user_group (id, group_name) VALUES (1, '普通客户'), (2, '重点客户')`);
    await tx.unsafe(`
      INSERT INTO ${schema}.user_label (id, type, relation_id, label_cate, name, color, sort, status)
      VALUES (1, 0, 0, 5, '咨询客户', '#3366ff', 1, 1), (2, 0, 0, 5, '重点跟进', '#ff6600', 2, 1)
    `);
    await tx.unsafe(`INSERT INTO ${schema}.user_label_relation (id, uid, type, relation_id, label_id) VALUES (1, 2001, 0, 0, 1)`);
    await tx.unsafe(`INSERT INTO ${schema}.system_user_level (id, name, is_show, is_del) VALUES (1, '黄金会员', 1, 0)`);
    await tx.unsafe(`
      INSERT INTO ${schema}.category (id, owner_id, type, "group", relation_id, name, sort, add_time)
      VALUES
        (1, 0, 0, 1, 0, '公共话术', 10, 1700000000),
        (2, 1, 0, 1, 0, '个人话术', 9, 1700000000),
        (3, 1, 0, 1, 0, '并发话术', 8, 1700000000),
        (4, 2, 0, 1, 0, '他人话术', 7, 1700000000),
        (5, 0, 0, 0, 0, '客户状态', 10, 1700000000)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service_speechcraft (id, kefu_id, cate_id, title, message, sort, add_time)
      VALUES
        (1, 0, 1, '欢迎', '您好，请问有什么可以帮助您？', 10, 1700000000),
        (2, 1, 2, '库存', '库存以商品页面为准', 9, 1700000000),
        (3, 2, 4, '他人', '仅客服二可见', 8, 1700000000)
    `);
    await tx.unsafe(`SELECT setval('${schemaName}.category_id_seq', 10, true)`);
    await tx.unsafe(`SELECT setval('${schemaName}.store_service_log_id_seq', 10, true)`);
    await tx.unsafe(`SELECT setval('${schemaName}.store_service_record_id_seq', 10, true)`);
    await tx.unsafe(`SELECT setval('${schemaName}.store_service_speechcraft_id_seq', 10, true)`);
    await tx.unsafe(`SELECT setval('${schemaName}.user_label_relation_id_seq', 10, true)`);
  });
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function auditStep<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function temporarySchemaCount(db: DbClient): Promise<number> {
  return (await db.$client<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'codex_kefu_%'
  `)[0]?.count ?? 0;
}

async function kefuIndexNames(db: DbClient, schemaName: string): Promise<string[]> {
  const rows = await db.$client<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = ${schemaName}
      AND indexname IN (
        'ss_active_online',
        'ssl_chat_history',
        'ssr_kefu_recent',
        'category_kefu_speechcraft',
        'ss_active_uid',
        'ssr_kefu_inbox',
        'ssr_direction',
        'ssl_unread_direction'
      )
    ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

export async function applyKefuCoreIndexes(
  connectionString: string,
): Promise<KefuCoreIndexApplyReport> {
  const root = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public",
    applicationName: "cinashop_kefu_index_apply",
  });
  try {
    const before = await publicFingerprints(root);
    const migrations = new MigrationService(createContainerFromDb(root));
    const migrationSql = [
      migrations.kefuCoreIndexMigrationSqlForVerification(),
      migrations.kefuRealtimeIndexMigrationSqlForVerification(),
      migrations.kefuTransferMigrationSqlForVerification(),
    ].join("\n");
    const apply = async () => root.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL search_path TO public`;
      await tx.unsafe(migrationSql);
    });
    await apply();
    const first = await kefuIndexNames(root, "public");
    await apply();
    const second = await kefuIndexNames(root, "public");
    const after = await publicFingerprints(root);
    const transferState = (await root.$client<Array<{ present: boolean; indexes: string[] }>>`
      SELECT
        to_regclass('public.store_service_transfer') IS NOT NULL AS present,
        COALESCE(
          ARRAY(
            SELECT indexname FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'store_service_transfer'
            ORDER BY indexname
          ),
          ARRAY[]::text[]
        ) AS indexes
    `)[0];
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    assertCondition(first.length === 8, `not all indexes were applied: ${first.join(",")}`);
    assertCondition(JSON.stringify(first) === JSON.stringify(second), "second index apply changed the index set");
    assertCondition(unchanged, "public business state changed while applying indexes");
    assertCondition(transferState?.present === true, "customer-service transfer audit table was not applied");
    assertCondition(
      transferState.indexes.join(",") === "sst_customer_time,sst_target_time,store_service_transfer_pkey",
      `unexpected transfer indexes: ${transferState.indexes.join(",")}`,
    );
    return {
      server_version: (await root.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      applied_indexes: first,
      second_apply_idempotent: true,
      public_state_unchanged: true,
      transfer_table_present: transferState?.present === true,
      transfer_indexes: transferState?.indexes ?? [],
    };
  } finally {
    await root.$client.end({ timeout: 1 });
  }
}

export async function runKefuCorePostgresScenario(
  connectionString: string,
  env: KefuAuthEnv,
): Promise<KefuCorePostgresReport> {
  const root = createDbFromConnectionString(connectionString, 2, {
    searchPath: "public",
    applicationName: "cinashop_kefu_audit_root",
  });
  const schemaName = randomSchemaName();
  let schemaCreated = false;
  let isolated: DbClient | null = null;
  let racerA: DbClient | null = null;
  let racerB: DbClient | null = null;
  try {
    const [before, production] = await Promise.all([
      publicFingerprints(root),
      productionSummary(root),
    ]);
    const passwordHash = await bcrypt.hash("Audit-Pass-2026", 4);
    await setupSchema(root, schemaName, passwordHash);
    schemaCreated = true;
    isolated = createDbFromConnectionString(connectionString, 2, {
      searchPath: schemaName,
      applicationName: "cinashop_kefu_audit_isolated",
    });
    const migrations = new MigrationService(createContainerFromDb(isolated));
    const migrationSql = [
      migrations.kefuCoreIndexMigrationSqlForVerification(),
      migrations.kefuRealtimeIndexMigrationSqlForVerification(),
      migrations.kefuTransferMigrationSqlForVerification(),
    ].join("\n");
    await isolated.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${identifier(schemaName)}`);
      await tx.unsafe(migrationSql);
    });

    const result = await withTx(createContainerFromDb(isolated), async (tx) => {
      const container = createContainerFromDb(tx);
      const auth = new KefuAuthService(container, env);
      const login = await auth.login({ account: "support-one", password: "Audit-Pass-2026" });
      const payload = await verifyToken(login.token, env.APP_KEY);
      const wrongPasswordRejected = await rejects(() => auth.login({
        account: "support-one",
        password: "wrong-password",
      }));
      const disabledRejected = await rejects(() => auth.login({
        account: "disabled-support",
        password: "Audit-Pass-2026",
      }));

      const core = new KefuCoreService(container);
      const services = await core.availableServices(1001, {});
      const sessions = await core.sessionList(1001, {});
      const chat = await core.chatHistory(1001, 2001, 0, 0, 20);
      const ownUser = await core.userInfo(1001, 2001);
      const labelOptionsBefore = await core.userLabels(1001, 2001);
      const foreignUserRejected = await rejects(() => core.userInfo(1001, 2002));
      const foreignChatRejected = await rejects(() => core.chatHistory(1001, 2002, 0, 0, 20));
      await core.setUserGroup(1001, 2001, 2);
      await core.setUserLabels(1001, 2001, { label_ids: [2], un_label_ids: [] });
      const updatedUser = await core.userInfo(1001, 2001);
      const labelOptionsAfter = await core.userLabels(1001, 2001);

      const catalog = new CustomerServiceCatalogService(container);
      const publicSpeechcraft = await catalog.speechcraftList(0, {});
      const privateSpeechcraft = await catalog.speechcraftList(1, {});
      const category = await catalog.saveSpeechcraftCategory(1, 0, {
        name: "售后说明",
        sort: 6,
      });
      const speechcraft = await catalog.saveSpeechcraft(1, 0, {
        title: "售后",
        cate_id: category.id,
        message: "售后进度以订单详情为准",
        sort: 6,
      });
      const crossOwnerRejected = await rejects(() => catalog.saveSpeechcraftCategory(
        2,
        category.id,
        { name: "越权修改", sort: 1 },
      ));
      const nonEmptyDeleteRejected = await rejects(() => catalog.deleteSpeechcraftCategory(1, category.id));
      await catalog.deleteSpeechcraft(1, speechcraft.id);
      await catalog.deleteSpeechcraftCategory(1, category.id);

      return {
        login,
        payload,
        wrongPasswordRejected,
        disabledRejected,
        services,
        sessions,
        chat,
        ownUser,
        labelOptionsBefore,
        foreignUserRejected,
        foreignChatRejected,
        updatedUser,
        labelOptionsAfter,
        publicSpeechcraft,
        privateSpeechcraft,
        crossOwnerRejected,
        nonEmptyDeleteRejected,
      };
    });

    const userSession: ChatSocketSession = {
      principalUid: 2001,
      role: 1,
      toUid: 1001,
      authId: 2001,
      tokenKey: "11111111111111111111111111111111",
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
      authVersion: md5("Audit-User-Pass-2026"),
      connectedAt: Math.floor(Date.now() / 1000),
    };
    const kefuSession: ChatSocketSession = {
      principalUid: 1001,
      role: 2,
      toUid: 2001,
      authId: 1,
      tokenKey: md5(result.login.token),
      expiresAt: result.login.exp_time,
      authVersion: md5(passwordHash),
      connectedAt: Math.floor(Date.now() / 1000),
    };
    const realtime = new KefuRealtimeService(createContainerFromDb(isolated), env);
    await auditStep("realtime-set-online", () => realtime.setOnline(kefuSession, true));
    const userRecord = await auditStep("realtime-user-record", () => realtime.userRecord(2001, { limit: "50" }));
    await auditStep("realtime-kefu-switch", () => realtime.switchConversation(kefuSession, 2001));
    await auditStep("realtime-user-switch", () => realtime.switchConversation(userSession, 1001));
    const userMessage = await auditStep("realtime-user-send", () => realtime.persistMessage(userSession, {
      toUid: 1001,
      message: "<b>实时消息</b>\u0000",
      messageType: 1,
    }));
    const userUnreadBeforeRead = await withTx(createContainerFromDb(isolated), async (tx) => (
      await tx.select({ count: storeServiceRecord.messageNum })
        .from(storeServiceRecord)
        .where(and(eq(storeServiceRecord.userId, 1001), eq(storeServiceRecord.toUid, 2001)))
        .limit(1)
    )[0]?.count ?? -1);
    await auditStep("realtime-user-read", () => realtime.markMessageRead(userMessage));
    const userUnreadAfterRead = await withTx(createContainerFromDb(isolated), async (tx) => (
      await tx.select({ count: storeServiceRecord.messageNum })
        .from(storeServiceRecord)
        .where(and(eq(storeServiceRecord.userId, 1001), eq(storeServiceRecord.toUid, 2001)))
        .limit(1)
    )[0]?.count ?? -1);
    const kefuMessage = await auditStep("realtime-kefu-send", () => realtime.persistMessage(kefuSession, {
      toUid: 2001,
      message: "客服实时回复",
      messageType: 1,
    }));
    await auditStep("realtime-kefu-read", () => realtime.markMessageRead(kefuMessage));
    const invalidTargetRejected = await rejects(() => realtime.persistMessage(userSession, {
      toUid: 1002,
      message: "不应写入",
      messageType: 1,
    }));

    await isolated.$client.unsafe(`
      CREATE OR REPLACE FUNCTION ${identifier(schemaName)}.reject_kefu_audit_message()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message = 'rollback-me' THEN
          RAISE EXCEPTION 'forced kefu audit rollback';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER reject_kefu_audit_message
      BEFORE INSERT OR UPDATE ON ${identifier(schemaName)}.store_service_record
      FOR EACH ROW EXECUTE FUNCTION ${identifier(schemaName)}.reject_kefu_audit_message();
    `);
    const messagesBeforeRollback = await withTx(createContainerFromDb(isolated), async (tx) => (
      await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceLog)
    )[0]?.count ?? -1);
    const rollbackRejected = await rejects(() => realtime.persistMessage(userSession, {
      toUid: 1001,
      message: "rollback-me",
      messageType: 1,
    }));
    const messagesAfterRollback = await withTx(createContainerFromDb(isolated), async (tx) => (
      await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceLog)
    )[0]?.count ?? -2);

    racerA = createDbFromConnectionString(connectionString, 1, {
      searchPath: schemaName,
      applicationName: "cinashop_kefu_audit_racer_a",
    });
    racerB = createDbFromConnectionString(connectionString, 1, {
      searchPath: schemaName,
      applicationName: "cinashop_kefu_audit_racer_b",
    });
    const race = await Promise.allSettled([
      withTx(createContainerFromDb(racerA), async (tx) => new CustomerServiceCatalogService(
        createContainerFromDb(tx),
      ).saveSpeechcraft(1, 0, {
        title: "并发一",
        cate_id: 3,
        message: "并发重复内容",
        sort: 1,
      })),
      withTx(createContainerFromDb(racerB), async (tx) => new CustomerServiceCatalogService(
        createContainerFromDb(tx),
      ).saveSpeechcraft(1, 0, {
        title: "并发二",
        cate_id: 3,
        message: "并发重复内容",
        sort: 2,
      })),
    ]);
    const raceSuccess = race.filter((item) => item.status === "fulfilled").length;
    const raceRejected = race.filter((item) => item.status === "rejected").length;
    const realtimeRace = await Promise.all([
      new KefuRealtimeService(createContainerFromDb(racerA), env).persistMessage(userSession, {
        toUid: 1001,
        message: "并发用户消息",
        messageType: 1,
      }),
      new KefuRealtimeService(createContainerFromDb(racerB), env).persistMessage(kefuSession, {
        toUid: 2001,
        message: "并发客服消息",
        messageType: 1,
      }),
    ]);

    const indexes = await kefuIndexNames(root, schemaName);
    const isolatedVerification = await withTx(createContainerFromDb(isolated), async (tx) => {
      const labels = await tx
        .select({ labelId: userLabelRelation.labelId })
        .from(userLabelRelation)
        .where(eq(userLabelRelation.uid, 2001));
      const duplicateRows = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storeServiceSpeechcraft)
        .where(and(
          eq(storeServiceSpeechcraft.kefuId, 1),
          eq(storeServiceSpeechcraft.message, "并发重复内容"),
        ));
      const deletedCategory = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(legacyCategory)
        .where(and(eq(legacyCategory.ownerId, 1), eq(legacyCategory.name, "售后说明")));
      const userGroup = await tx
        .select({ groupId: userTable.groupId })
        .from(userTable)
        .where(eq(userTable.uid, 2001))
        .limit(1);
      const realtimeLogs = await tx
        .select({
          uid: storeServiceLog.uid,
          toUid: storeServiceLog.toUid,
          message: storeServiceLog.msn,
          read: storeServiceLog.type,
        })
        .from(storeServiceLog)
        .where(sql`${storeServiceLog.id} > 10`)
        .orderBy(storeServiceLog.id);
      const realtimeRecords = await tx
        .select({
          userId: storeServiceRecord.userId,
          toUid: storeServiceRecord.toUid,
          unread: storeServiceRecord.messageNum,
        })
        .from(storeServiceRecord)
        .where(or(
          and(eq(storeServiceRecord.userId, 1001), eq(storeServiceRecord.toUid, 2001)),
          and(eq(storeServiceRecord.userId, 2001), eq(storeServiceRecord.toUid, 1001)),
        ));
      return {
        indexes,
        labels: labels.map((item) => item.labelId).sort((a, b) => a - b),
        duplicateCount: duplicateRows[0]?.count ?? 0,
        deletedCategoryCount: deletedCategory[0]?.count ?? -1,
        groupId: userGroup[0]?.groupId ?? 0,
        realtimeLogs,
        realtimeRecords,
        userUnreadBeforeRead,
        userUnreadAfterRead,
      };
    });

    const transferRollbackKey = "22222222-2222-4222-8222-222222222222";
    await isolated.$client.unsafe(`
      CREATE OR REPLACE FUNCTION ${identifier(schemaName)}.reject_kefu_transfer_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.request_key = '${transferRollbackKey}' THEN
          RAISE EXCEPTION 'forced kefu transfer rollback';
        END IF;
        RETURN NEW;
      END
      $$;
      CREATE TRIGGER reject_kefu_transfer_audit
      BEFORE INSERT ON ${identifier(schemaName)}.store_service_transfer
      FOR EACH ROW EXECUTE FUNCTION ${identifier(schemaName)}.reject_kefu_transfer_audit();
    `);
    const transferRollbackBefore = await withTx(createContainerFromDb(isolated), async (tx) => ({
      records: (await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceRecord))[0]?.count ?? -1,
      logs: (await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceLog))[0]?.count ?? -1,
    }));
    const transferRollbackRejected = await rejects(() => new KefuTransferService(
      createContainerFromDb(isolated!),
    ).transfer(2, 1002, {
      uid: 2002,
      kefuToUid: 1001,
      request_key: transferRollbackKey,
    }));
    const transferRollbackAfter = await withTx(createContainerFromDb(isolated), async (tx) => ({
      records: (await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceRecord))[0]?.count ?? -2,
      logs: (await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceLog))[0]?.count ?? -2,
      audits: (await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceTransfer))[0]?.count ?? -2,
    }));
    await isolated.$client.unsafe(`
      DROP TRIGGER reject_kefu_transfer_audit ON ${identifier(schemaName)}.store_service_transfer;
      DROP FUNCTION ${identifier(schemaName)}.reject_kefu_transfer_audit();
    `);

    const transferKey = "11111111-1111-4111-8111-111111111111";
    const transferService = new KefuTransferService(createContainerFromDb(isolated));
    const firstTransfer = await auditStep("kefu-transfer-first", () => transferService.transfer(1, 1001, {
      uid: 2001,
      kefuToUid: 1002,
      request_key: transferKey,
    }));
    const replayedTransfer = await auditStep("kefu-transfer-replay", () => transferService.transfer(1, 1001, {
      uid: 2001,
      kefuToUid: 1002,
      request_key: transferKey,
    }));
    const conflictingTransferRejected = await rejects(() => transferService.transfer(1, 1001, {
      uid: 2002,
      kefuToUid: 1002,
      request_key: transferKey,
    }));
    const sourceHttpRejected = await rejects(() => withTx(
      createContainerFromDb(isolated!),
      async (tx) => new KefuCoreService(createContainerFromDb(tx)).userInfo(1001, 2001),
    ));
    const targetHistory = await auditStep("kefu-transfer-target-history", () => withTx(
      createContainerFromDb(isolated!),
      async (tx) => new KefuCoreService(createContainerFromDb(tx)).chatHistory(1002, 2001, 0, 0, 100),
    ));
    const sourceSocketRejected = await rejects(() => realtime.persistMessage(kefuSession, {
      toUid: 2001,
      message: "原客服不应继续发送",
      messageType: 1,
    }));
    const staleUserSocketRejected = await rejects(() => realtime.persistMessage(userSession, {
      toUid: 1001,
      message: "用户旧连接不应发给原客服",
      messageType: 1,
    }));
    const targetKefuSession: ChatSocketSession = {
      ...kefuSession,
      principalUid: 1002,
      toUid: 2001,
      authId: 2,
    };
    const transferredUserSession: ChatSocketSession = { ...userSession, toUid: 1002 };
    await auditStep("kefu-transfer-target-switch", () => realtime.switchConversation(targetKefuSession, 2001));
    await auditStep("kefu-transfer-user-switch", () => realtime.switchConversation(transferredUserSession, 1002));

    const transferRaceKey = "33333333-3333-4333-8333-333333333333";
    const transferRace = await auditStep("kefu-transfer-idempotent-race", () => Promise.all([
      new KefuTransferService(createContainerFromDb(racerA!)).transfer(2, 1002, {
        uid: 2002,
        kefuToUid: 1001,
        request_key: transferRaceKey,
      }),
      new KefuTransferService(createContainerFromDb(racerB!)).transfer(2, 1002, {
        uid: 2002,
        kefuToUid: 1001,
        request_key: transferRaceKey,
      }),
    ]));

    const transferVerification = await withTx(createContainerFromDb(isolated), async (tx) => {
      const audits = await tx.select().from(storeServiceTransfer).orderBy(storeServiceTransfer.customerUid);
      const records = await tx
        .select({ userId: storeServiceRecord.userId, toUid: storeServiceRecord.toUid })
        .from(storeServiceRecord)
        .where(or(
          and(eq(storeServiceRecord.toUid, 2001), or(eq(storeServiceRecord.userId, 1001), eq(storeServiceRecord.userId, 1002))),
          and(eq(storeServiceRecord.toUid, 2002), or(eq(storeServiceRecord.userId, 1001), eq(storeServiceRecord.userId, 1002))),
        ));
      const copiedCustomerOne = (
        await tx.select({ count: sql<number>`COUNT(*)::int` }).from(storeServiceLog).where(and(
          or(
            and(eq(storeServiceLog.uid, 1002), eq(storeServiceLog.toUid, 2001)),
            and(eq(storeServiceLog.uid, 2001), eq(storeServiceLog.toUid, 1002)),
          ),
          eq(storeServiceLog.isTourist, 0),
        ))
      )[0]?.count ?? -1;
      return { audits, records, copiedCustomerOne };
    });

    const flags = {
      login_token_isolated:
        result.payload.type === "kefu" && result.payload.id === 1 &&
        result.login.kefuInfo.uid === 1001 && !("password" in result.login.kefuInfo),
      invalid_login_closed: result.wrongPasswordRejected && result.disabledRejected,
      active_service_scope:
        result.services.count === 1 && result.services.list[0]?.uid === 1002,
      session_scope:
        result.sessions.list.length === 1 && result.sessions.list[0]?.user_id === 1001 &&
        result.sessions.list[0]?.to_uid === 2001,
      chat_scope:
        result.chat.length === 2 && result.chat[0]?.uid === 2001 && result.chat[1]?.uid === 1001,
      foreign_conversation_closed: result.foreignUserRejected && result.foreignChatRejected,
      user_detail_exact:
        result.ownUser.group_name === "普通客户" && result.ownUser.level_name === "黄金会员" &&
        result.ownUser.labelNames.join(",") === "咨询客户",
      label_selector_php_compatible:
        result.labelOptionsBefore.length === 1 &&
        result.labelOptionsBefore[0]?.name === "客户状态" &&
        result.labelOptionsBefore[0]?.label.length === 2 &&
        result.labelOptionsBefore[0]?.label[0]?.disabled === false &&
        result.labelOptionsBefore[0]?.label[1]?.disabled === true &&
        result.labelOptionsAfter[0]?.label.every((item) => item.disabled),
      segmentation_atomic:
        result.updatedUser.group_name === "重点客户" &&
        result.updatedUser.labelNames.sort().join(",") === "咨询客户,重点跟进" &&
        isolatedVerification.groupId === 2 && isolatedVerification.labels.join(",") === "1,2",
      catalog_scope:
        result.publicSpeechcraft.list.length === 1 && result.publicSpeechcraft.list[0]?.kefu_id === 0 &&
        result.privateSpeechcraft.list.length === 1 && result.privateSpeechcraft.list[0]?.kefu_id === 1,
      catalog_owner_closed: result.crossOwnerRejected && result.nonEmptyDeleteRejected,
      catalog_cleanup_exact: isolatedVerification.deletedCategoryCount === 0,
      duplicate_concurrency_single_winner:
        raceSuccess === 1 && raceRejected === 1 && isolatedVerification.duplicateCount === 1,
      realtime_agent_selection:
        userRecord.uid === 1001 && userRecord.serviceList.length === 2,
      realtime_recipient_owned_records:
        userMessage.sender_role === 1 && userMessage.recored.user_id === 1001 &&
        userMessage.recored.to_uid === 2001 && userMessage.msn === "实时消息" &&
        kefuMessage.sender_role === 2 && kefuMessage.recored.user_id === 2001 &&
        kefuMessage.recored.to_uid === 1001,
      realtime_unread_reconciled:
        userUnreadBeforeRead === 1 && userUnreadAfterRead === 0,
      realtime_target_scope_closed: invalidTargetRejected,
      realtime_transaction_rollback:
        rollbackRejected && messagesBeforeRollback === messagesAfterRollback &&
        isolatedVerification.realtimeLogs.every((item) => item.message !== "rollback-me"),
      realtime_conversation_serialized:
        realtimeRace.length === 2 && isolatedVerification.realtimeLogs.length === 4 &&
        isolatedVerification.realtimeRecords.length === 2 &&
        isolatedVerification.realtimeRecords.every((item) => item.unread === 1),
      indexes_present:
        isolatedVerification.indexes.join(",") ===
          "category_kefu_speechcraft,ss_active_online,ss_active_uid,ssl_chat_history,ssl_unread_direction,ssr_direction,ssr_kefu_inbox,ssr_kefu_recent",
      transfer_transaction_rollback:
        transferRollbackRejected && transferRollbackBefore.records === transferRollbackAfter.records &&
        transferRollbackBefore.logs === transferRollbackAfter.logs && transferRollbackAfter.audits === 0,
      transfer_idempotent_audit:
        !firstTransfer.idempotent && replayedTransfer.idempotent && replayedTransfer.recored === null &&
        firstTransfer.request_key === transferKey && firstTransfer.copied_message_count === 6 &&
        conflictingTransferRejected && transferVerification.audits.length === 2,
      transfer_ownership_moved:
        firstTransfer.recored?.user_id === 1002 && firstTransfer.recored.to_uid === 2001 &&
        sourceHttpRejected && sourceSocketRejected && staleUserSocketRejected &&
        targetHistory.length === 6 && transferVerification.copiedCustomerOne === 6 &&
        transferVerification.records.some((item) => item.userId === 1002 && item.toUid === 2001) &&
        !transferVerification.records.some((item) => item.userId === 1001 && item.toUid === 2001),
      transfer_concurrency_single_commit:
        transferRace.length === 2 && transferRace.filter((item) => item.idempotent).length === 1 &&
        transferRace.filter((item) => !item.idempotent).length === 1 &&
        transferVerification.audits.filter((item) => item.requestKey === transferRaceKey).length === 1 &&
        transferVerification.records.some((item) => item.userId === 1001 && item.toUid === 2002) &&
        !transferVerification.records.some((item) => item.userId === 1002 && item.toUid === 2002),
    };
    for (const [name, value] of Object.entries(flags)) {
      assertCondition(value, `${name}; result=${JSON.stringify(result)} verification=${JSON.stringify(isolatedVerification)}`);
    }

    await Promise.all([
      racerA.$client.end({ timeout: 1 }),
      racerB.$client.end({ timeout: 1 }),
      isolated.$client.end({ timeout: 1 }),
    ]);
    racerA = null;
    racerB = null;
    isolated = null;
    await root.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
    schemaCreated = false;
    const after = await publicFingerprints(root);
    const temporarySchemasAfter = await temporarySchemaCount(root);
    const publicUnchanged = JSON.stringify(before) === JSON.stringify(after);
    assertCondition(publicUnchanged, "public state changed");
    assertCondition(temporarySchemasAfter === 0, "temporary schema leaked");
    return {
      server_version: (await root.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      schema_created: true,
      schema_removed: true,
      temporary_schemas_after: temporarySchemasAfter,
      public_state_unchanged: publicUnchanged,
      production,
      isolated: flags,
    };
  } finally {
    if (racerA) await racerA.$client.end({ timeout: 1 }).catch(() => undefined);
    if (racerB) await racerB.$client.end({ timeout: 1 }).catch(() => undefined);
    if (isolated) await isolated.$client.end({ timeout: 1 }).catch(() => undefined);
    if (schemaCreated) {
      await root.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`).catch(() => undefined);
    }
    await root.$client.end({ timeout: 1 });
  }
}
