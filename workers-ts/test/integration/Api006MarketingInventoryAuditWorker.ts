import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import { ActivityJoinService } from "@/services/activity/ActivityJoinService";
import { StoreNewcomerService } from "@/services/activity/StoreNewcomerService";
import { MigrationService } from "@/services/MigrationService";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

const EXPECTED_TABLES = [
  "store_seckill",
  "store_seckill_time",
  "store_combination",
  "store_pink",
  "store_bargain",
  "store_bargain_user",
  "store_bargain_user_help",
  "store_order",
  "user",
  "system_config",
  "system_group",
  "system_group_data",
  "video",
  "video_comment",
  "store_newcomer",
  "user_relation",
  "store_product",
  "store_product_attr_value",
] as const;

const PREFIX = "codex_api006_activity_";
const ACTIVITY_TABLES = [
  "store_seckill",
  "store_combination",
  "store_pink",
  "store_bargain",
  "store_bargain_user",
  "store_bargain_user_help",
  "store_order",
  "user",
  "system_config",
  "system_group",
  "system_group_data",
] as const;

const NEWCOMER_PREFIX = "codex_api006_newcomer_";
const NEWCOMER_TABLES = [
  "cache",
  "store_brand",
  "store_coupon_user",
  "store_newcomer",
  "store_order",
  "store_product",
  "store_product_attr",
  "store_product_attr_value",
  "store_product_description",
  "store_product_ensure",
  "store_product_label",
  "store_product_relation",
  "store_product_reply",
  "system_config",
  "user",
  "user_relation",
] as const;

async function authorized(request: Request, expectedHash: string): Promise<boolean> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actualHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const normalized = expectedHash.trim().toLowerCase();
  const valid = /^[a-f0-9]{64}$/.test(normalized);
  const configuredHash = valid
    ? Uint8Array.from(normalized.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16))
    : new Uint8Array(32);
  return valid && crypto.subtle.timingSafeEqual(actualHash, configuredHash.buffer);
}

async function inspectProduction(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_api006_inventory_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '25s'`;
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET TRANSACTION READ ONLY`;

      const tables = await tx<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY(${[...EXPECTED_TABLES]})
        ORDER BY table_name
      `;
      const present = new Set(tables.map((row) => row.table_name));
      const counts: Record<string, number> = {};
      for (const table of EXPECTED_TABLES) {
        if (!present.has(table)) continue;
        const rows = await tx.unsafe<Array<{ count: number }>>(
          `SELECT count(*)::integer AS count FROM public."${table}"`,
        );
        counts[table] = Number(rows[0]?.count ?? 0);
      }

      const [columns, indexes, state] = await Promise.all([
        tx<Array<Record<string, unknown>>>`
          SELECT table_name, column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ANY(${[...EXPECTED_TABLES]})
          ORDER BY table_name, ordinal_position
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT tablename, indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = ANY(${[...EXPECTED_TABLES]})
          ORDER BY tablename, indexname
        `,
        tx<Array<Record<string, unknown>>>`
          WITH activity_groups(name) AS (VALUES
            ('routine_lovely'), ('combination_banner')
          ), activity_configs(name) AS (VALUES
            ('routine_appId'), ('routine_appsecret'), ('share_qrcode'),
            ('seckill_header_banner'), ('bargain_subscribe')
          ), newcomer_configs(name) AS (VALUES
            ('newcomer_status'), ('newcomer_limit_status'), ('newcomer_limit_time'),
            ('register_integral_status'), ('register_give_integral'),
            ('register_money_status'), ('register_give_money'),
            ('register_coupon_status'), ('register_give_coupon'),
            ('first_order_status'), ('first_order_discount'),
            ('first_order_discount_limit'), ('register_price_status')
          )
          SELECT
            current_setting('server_version') AS server_version,
            current_setting('transaction_read_only') AS transaction_read_only,
            (SELECT count(*)::integer FROM store_seckill
              WHERE status=1 AND is_show=1 AND is_del=0
                AND (start_time IS NULL OR start_time <= now())
                AND (stop_time IS NULL OR stop_time >= now())) AS active_seckill,
            (SELECT count(*)::integer FROM store_seckill_time WHERE status=1) AS active_seckill_times,
            (SELECT count(*)::integer FROM store_combination
              WHERE status=1 AND is_show=1 AND is_del=0
                AND (start_time IS NULL OR start_time <= now())
                AND (stop_time IS NULL OR stop_time >= now())) AS active_combination,
            (SELECT count(*)::integer FROM store_pink WHERE is_refund=0 AND status=1) AS active_pinks,
            (SELECT count(*)::integer FROM store_bargain
              WHERE status=1 AND is_del=0
                AND (start_time IS NULL OR start_time <= now())
                AND (stop_time IS NULL OR stop_time >= now())) AS active_bargain,
            (SELECT count(*)::integer FROM store_bargain_user WHERE is_del=0 AND status=1) AS active_bargain_users,
            (SELECT count(*)::integer FROM store_order
              WHERE type IN (1,2,3) AND is_del=0 AND is_system_del=0) AS activity_orders,
            (SELECT count(*)::integer FROM store_order
              WHERE type IN (1,2,3) AND paid=1 AND is_del=0 AND is_system_del=0) AS paid_activity_orders,
            (SELECT count(*)::integer FROM system_group g
              JOIN system_group_data d ON d.gid=g.id
              JOIN activity_groups wanted ON wanted.name=g.config_name
              WHERE d.status=1) AS active_activity_group_rows,
            (SELECT COALESCE(jsonb_object_agg(wanted.name, COALESCE(group_counts.count, 0)), '{}'::jsonb)
              FROM activity_groups wanted
              LEFT JOIN (
                SELECT g.config_name AS name, count(*)::integer AS count
                FROM system_group g JOIN system_group_data d ON d.gid=g.id
                WHERE d.status=1 GROUP BY g.config_name
              ) group_counts USING (name)) AS activity_group_counts,
            (SELECT COALESCE(jsonb_object_agg(wanted.name, COALESCE(configs.present, false)), '{}'::jsonb)
              FROM activity_configs wanted
              LEFT JOIN (
                SELECT menu_name AS name, bool_or(status=1 AND btrim(value) <> '') AS present
                FROM system_config WHERE is_store=0 GROUP BY menu_name
              ) configs USING (name)) AS activity_config_presence,
            (SELECT COALESCE(jsonb_object_agg(wanted.name, COALESCE(configs.present, false)), '{}'::jsonb)
              FROM newcomer_configs wanted
              LEFT JOIN (
                SELECT menu_name AS name, bool_or(status=1 AND btrim(value) <> '') AS present
                FROM system_config WHERE is_store=0 GROUP BY menu_name
              ) configs USING (name)) AS newcomer_config_presence,
            (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api006_%') AS temporary_schemas
        `,
      ]);

      return {
        transaction: "READ ONLY",
        expected_tables: EXPECTED_TABLES,
        missing_tables: EXPECTED_TABLES.filter((table) => !present.has(table)),
        row_counts: counts,
        state: state[0],
        columns,
        indexes,
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

function transactionDb(tx: unknown, options: unknown): DbClient {
  const client = tx as { options?: unknown };
  if (!client.options) client.options = options;
  return drizzle(tx as never, { schema }) as unknown as DbClient;
}

function auditRuntimeEnv(env: AuditEnv): Env {
  const cache = new Map<string, string>();
  return {
    ...env,
    APP_KEY: "api006-audit-only",
    CONFIG_KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => {
        cache.set(key, value);
      },
      delete: async (key: string) => {
        cache.delete(key);
      },
    },
  } as unknown as Env;
}

async function publicSnapshot(client: postgres.Sql) {
  const rows = await client<Array<Record<string, unknown>>>`
    SELECT
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_seckill) AS seckill,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_combination) AS combinations,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_pink) AS pinks,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_bargain) AS bargains,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_bargain_user) AS bargain_users,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_bargain_user_help) AS bargain_help,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_order) AS orders,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(uid), 0)) FROM public."user") AS users,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.system_config) AS configs,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.system_group) AS groups,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.system_group_data) AS group_data,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`}) AS temporary_schemas
  `;
  return rows[0];
}

async function productionContracts(connectionString: string, env: AuditEnv) {
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api006_activity_contract",
  });
  try {
    return await root.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '35s'`;
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const service = new ActivityJoinService(
        createContainerFromDb(transactionDb(tx, root.$client.options)),
        auditRuntimeEnv(env),
      );
      const newcomerService = new StoreNewcomerService(
        createContainerFromDb(transactionDb(tx, root.$client.options)),
        auditRuntimeEnv(env),
      );
      const active = await tx<Array<{
        seckill_id: number | null;
        combination_id: number | null;
        bargain_id: number | null;
        bargain_uid: number | null;
        newcomer_uid: number | null;
      }>>`
        SELECT
          (SELECT id FROM store_seckill WHERE status=1 AND is_show=1 AND is_del=0 ORDER BY id LIMIT 1) AS seckill_id,
          (SELECT id FROM store_combination WHERE status=1 AND is_show=1 AND is_del=0 ORDER BY id LIMIT 1) AS combination_id,
          (SELECT bargain_id FROM store_bargain_user WHERE is_del=0 ORDER BY id DESC LIMIT 1) AS bargain_id,
          (SELECT uid FROM store_bargain_user WHERE is_del=0 ORDER BY id DESC LIMIT 1) AS bargain_uid,
          (SELECT uid FROM "user" WHERE status=1 AND is_del=0 ORDER BY uid LIMIT 1) AS newcomer_uid
      `;
      const ids = active[0];
      const config = await service.bargainConfig();
      const banner = await service.combinationBanner();
      const seckillCode = ids?.seckill_id
        ? await service.activityDetailCode(1, ids.seckill_id, 0, {})
        : null;
      const combinationCode = ids?.combination_id
        ? await service.activityDetailCode(3, ids.combination_id, 0, {})
        : null;
      const startUser = ids?.bargain_id && ids.bargain_uid
        ? await service.bargainStartUser(ids.bargain_id, ids.bargain_uid)
        : null;
      const bargains = ids?.bargain_uid
        ? await service.myBargains(ids.bargain_uid, 1, 5)
        : [];
      const newcomerList = ids?.newcomer_uid
        ? await newcomerService.list(ids.newcomer_uid, "1", "5")
        : [];
      const newcomerInfo = ids?.newcomer_uid
        ? await newcomerService.info(ids.newcomer_uid, false)
        : {};
      const newcomerGift = ids?.newcomer_uid
        ? await newcomerService.info(ids.newcomer_uid, true)
        : {};
      return {
        transaction: "READ ONLY",
        bargain_config_is_object: config !== null && typeof config === "object" && !Array.isArray(config),
        combination_banner_is_array: Array.isArray(banner),
        seckill_detail_code: seckillCode === null || seckillCode.code_base.startsWith("data:image/svg+xml;base64,"),
        combination_detail_code: combinationCode === null || combinationCode.code_base.startsWith("data:image/svg+xml;base64,"),
        start_user_contract: startUser === null || (typeof startUser.nickname === "string" && typeof startUser.avatar === "string"),
        bargain_list_bounded: bargains.length <= 5,
        newcomer_list_is_array: Array.isArray(newcomerList) && newcomerList.length <= 5,
        newcomer_info_is_object: newcomerInfo !== null && typeof newcomerInfo === "object" && !Array.isArray(newcomerInfo),
        newcomer_gift_is_object: newcomerGift !== null && typeof newcomerGift === "object" && !Array.isArray(newcomerGift),
      };
    });
  } finally {
    await root.$client.end({ timeout: 1 });
  }
}

async function applyActivityIndexes(connectionString: string) {
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api006_activity_index_migration",
  });
  try {
    const before = await publicSnapshot(root.$client);
    const ddl = new MigrationService(
      createContainerFromDb(root),
    ).activityCompatibilityIndexMigrationSqlForVerification();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await root.$client.begin(async (tx) => {
        await tx`SET LOCAL search_path TO public`;
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SET LOCAL statement_timeout = '25s'`;
        await tx.unsafe(ddl);
      });
    }
    const after = await publicSnapshot(root.$client);
    const indexes = await root.$client<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname='public'
        AND indexname IN ('sbu_uid_bargain_active', 'so_activity_type_visible')
      ORDER BY indexname
    `;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error("production business fingerprint changed during index migration");
    }
    if (indexes.length !== 2) throw new Error("activity compatibility indexes are incomplete");
    return {
      attempts: 2,
      idempotent: true,
      installed_indexes: indexes.map((item) => item.indexname),
      business_fingerprint_unchanged: true,
      temporary_schemas: after.temporary_schemas,
    };
  } finally {
    await root.$client.end({ timeout: 1 });
  }
}

async function rejects(callback: () => Promise<unknown>): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch {
    return true;
  }
}

async function isolatedScenario(connectionString: string, env: AuditEnv) {
  const schemaName = `${PREFIX}${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  if (!/^codex_api006_activity_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe schema name");
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api006_activity_isolated",
  });
  const before = await publicSnapshot(root.$client);
  let created = false;
  let result: Record<string, unknown> = {};
  let scenarioError: unknown;
  try {
    await root.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '55s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      created = true;
      for (const table of ACTIVITY_TABLES) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      const migrationSql = new MigrationService(
        createContainerFromDb(transactionDb(tx, root.$client.options)),
      ).activityCompatibilityIndexMigrationSqlForVerification();
      await tx.unsafe(migrationSql);
      await tx`INSERT INTO system_config (id, menu_name, value, is_store, status)
        VALUES (1, 'site_url', 'https://audit.example/shop', 0, 1)`;
      await tx`INSERT INTO system_group (id, name, info, config_name) VALUES
        (1, 'Bargain config', 'audit', 'routine_lovely'),
        (2, 'Combination banner', 'audit', 'combination_banner')`;
      await tx`INSERT INTO system_group_data (id, gid, value, sort, status) VALUES
        (1, 1, ${JSON.stringify({ name: { value: "first" } })}, 30, 1),
        (2, 1, ${JSON.stringify({ name: { value: "second" } })}, 20, 1),
        (3, 1, ${JSON.stringify({ marker: { value: "bargain-config" } })}, 10, 1),
        (4, 2, ${JSON.stringify({ image: { value: "/combination.png" }, url: { value: "/activity" } })}, 10, 1)`;
      await tx`INSERT INTO "user" (uid, account, nickname, avatar, status, is_del) VALUES
        (100, 'api006-owner', 'Owner', '/owner.png', 1, 0),
        (200, 'api006-member', 'Member', '/member.png', 1, 0)`;
      await tx`INSERT INTO store_seckill
        (id, product_id, store_name, image, price, ot_price, quota, quota_show, stock, is_show, is_del, status, start_time, stop_time)
        VALUES (10, 1000, 'Seckill', '/seckill.png', 9.90, 19.90, 8, 10, 8, 1, 0, 1, now() - interval '1 hour', now() + interval '1 day')`;
      await tx`INSERT INTO store_combination
        (id, product_id, store_name, image, price, ot_price, people, quota, stock, is_show, is_del, status, start_time, stop_time)
        VALUES (20, 2000, 'Combination', '/combination.png', 9.99, 29.99, 2, 8, 8, 1, 0, 1, now() - interval '1 hour', now() + interval '1 day')`;
      await tx`INSERT INTO store_pink
        (id, uid, nickname, avatar, order_id, order_id_key, combination_id, product_id, k_id, people, member_count, price, status, stop_time, is_refund, add_time)
        VALUES
          (30, 100, 'Owner', '/owner.png', 'pink-owner', '1', 20, 2000, 0, 2, 0, 9.99, 1, now() + interval '1 day', 0, 100),
          (31, 200, 'Member', '/member.png', 'pink-member', '2', 20, 2000, 30, 2, 0, 9.99, 1, now() + interval '1 day', 0, 101)`;
      await tx`INSERT INTO store_bargain
        (id, product_id, store_name, title, image, min_price, price, quota, stock, people, bargain_num, look, share, is_del, status, start_time, stop_time)
        VALUES (40, 3000, 'Bargain', 'Bargain title', '/bargain.png', 20.00, 100.00, 10, 10, 3, 2, 5, 7, 0, 1, now() - interval '1 hour', now() + interval '1 day')`;
      await tx`INSERT INTO store_bargain_user
        (id, uid, bargain_id, bargain_price_min, bargain_price, price, status, add_time, is_del)
        VALUES (50, 100, 40, 20.00, 100.00, 30.00, 1, 100, 0)`;
      await tx`INSERT INTO store_bargain_user_help
        (id, uid, bargain_id, bargain_user_id, price, add_time, type)
        VALUES (60, 200, 40, 50, 5.00, 101, 0)`;
      await tx`INSERT INTO store_order
        (id, order_id, uid, activity_id, type, paid, status, is_del, is_system_del, add_time, "unique")
        VALUES (70, 'api006-order', 100, 40, 2, 1, 0, 0, 0, 100, 'api006-audit-order')`;
    });

    const scoped = createDbFromConnectionString(connectionString, 1, {
      searchPath: schemaName,
      applicationName: "cinashop_api006_activity_contract",
    });
    try {
      const withTransactionService = <T>(
        callback: (service: ActivityJoinService) => Promise<T>,
      ) => root.$client.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
        const service = new ActivityJoinService(
          createContainerFromDb(transactionDb(tx, root.$client.options)),
          auditRuntimeEnv(env),
        );
        return callback(service);
      });
      const readResults = await withTransactionService(async (service) => {
        const bargainConfig = await service.bargainConfig();
        const banner = await service.combinationBanner();
        const seckillDetailCode = await service.activityDetailCode(1, 10, 100, { time: "10:00", status: "1" });
        const combinationDetailCode = await service.activityDetailCode(3, 20, 100, {});
        const seckillRoutineCode = await service.activityRoutineCode(1, 10, 100);
        const combinationRoutineCode = await service.activityRoutineCode(3, 20, 100);
        const combinationPoster = await service.combinationPoster(100, 30);
        const combinationPosterDenied = await rejects(() => service.combinationPoster(999, 30));
        const startUser = await service.bargainStartUser(40, 100);
        const bargainPoster = await service.bargainPoster(100, 40);
        const bargainPosterDenied = await rejects(() => service.bargainPoster(200, 40));
        const myBargains = await service.myBargains(100, 1, 5);
        return {
          bargainConfig,
          banner,
          seckillDetailCode,
          combinationDetailCode,
          seckillRoutineCode,
          combinationRoutineCode,
          combinationPoster,
          combinationPosterDenied,
          startUser,
          bargainPoster,
          bargainPosterDenied,
          myBargains,
        };
      });
      const share = await new ActivityJoinService(
        createContainerFromDb(scoped),
        auditRuntimeEnv(env),
      ).bargainShare(40);
      const foreignCancelDenied = await rejects(() => withTransactionService(
        (service) => service.cancelBargain(200, { bargainId: 40 }),
      ));
      await withTransactionService((service) => service.cancelBargain(100, { bargainId: 40 }));
      const cancelled = await scoped.$client.unsafe<Array<{ is_del: number; status: number }>>(
        `SELECT is_del, status FROM "${schemaName}".store_bargain_user WHERE id=50`,
      );
      const installedIndexes = await scoped.$client.unsafe<Array<{ indexname: string }>>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = '${schemaName}'
          AND indexname IN ('sbu_uid_bargain_active', 'so_activity_type_visible') ORDER BY indexname`,
      );
      const {
        bargainConfig,
        banner,
        seckillDetailCode,
        combinationDetailCode,
        seckillRoutineCode,
        combinationRoutineCode,
        combinationPoster,
        combinationPosterDenied,
        startUser,
        bargainPoster,
        bargainPosterDenied,
        myBargains,
      } = readResults;
      const assertions = {
        bargain_config: bargainConfig.marker === "bargain-config",
        combination_banner: banner.length === 1 && banner[0]?.image === "/combination.png",
        seckill_detail_code: seckillDetailCode.code_base.startsWith("data:image/svg+xml;base64,"),
        combination_detail_code: combinationDetailCode.code_base.startsWith("data:image/svg+xml;base64,"),
        routine_code_safe_without_credentials: seckillRoutineCode.code === "" && combinationRoutineCode.code === "",
        combination_poster: combinationPoster.label === "2人团" && combinationPoster.msg.includes("还差0人"),
        combination_poster_owner_scope: combinationPosterDenied,
        bargain_start_user: startUser.nickname === "Owner" && startUser.avatar === "/owner.png",
        bargain_poster: bargainPoster.price === "70.00" && bargainPoster.msg.includes("50.00"),
        bargain_poster_owner_scope: bargainPosterDenied,
        bargain_share_atomic: share.lookCount === 5 && share.shareCount === 8 && share.userCount === 1 && share.payCount === 1,
        bargain_list_contract: myBargains.length === 1
          && myBargains[0]?.bargain_id === 40
          && myBargains[0]?.residue_price === "70.00"
          && myBargains[0]?.title === "Bargain title",
        bargain_cancel_owner_scope: foreignCancelDenied
          && cancelled[0]?.is_del === 1
          && cancelled[0]?.status === 2,
        activity_partial_indexes: installedIndexes.length === 2,
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
      result = { assertions, assertion_count: Object.keys(assertions).length };
    } finally {
      await scoped.$client.end({ timeout: 1 });
    }
  } catch (error) {
    scenarioError = error;
  } finally {
    if (created) {
      await root.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }
  const after = await publicSnapshot(root.$client);
  await root.$client.end({ timeout: 1 });
  if (scenarioError) throw scenarioError;
  const { temporary_schemas: beforeTemporarySchemas, ...beforeComparable } = before;
  const { temporary_schemas: afterTemporarySchemas, ...afterComparable } = after;
  if (
    JSON.stringify(beforeComparable) !== JSON.stringify(afterComparable)
    || beforeTemporarySchemas !== afterTemporarySchemas
  ) {
    throw new Error("public state or temporary schema count changed");
  }
  return {
    schema: schemaName,
    ...result,
    cleanup: "dropped",
    public_state_unchanged: true,
    temporary_schemas_before: beforeTemporarySchemas,
    temporary_schemas_after: afterTemporarySchemas,
  };
}

async function newcomerPublicSnapshot(client: postgres.Sql) {
  const tables: Record<string, { count: string; digest: string }> = {};
  for (const table of NEWCOMER_TABLES) {
    const rows = await client.unsafe<Array<{ count: string; digest: string }>>(`
      SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
      FROM public."${table}" t
    `);
    if (!rows[0]) throw new Error(`could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const temporarySchemas = await client<Array<{ count: number }>>`
    SELECT count(*)::integer AS count
    FROM pg_namespace
    WHERE nspname LIKE ${`${NEWCOMER_PREFIX}%`}
  `;
  return { tables, temporary_schemas: Number(temporarySchemas[0]?.count ?? 0) };
}

async function newcomerIsolatedScenario(connectionString: string, env: AuditEnv) {
  const schemaName = `${NEWCOMER_PREFIX}${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  if (!/^codex_api006_newcomer_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe newcomer schema name");
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api006_newcomer_isolated",
  });
  const before = await newcomerPublicSnapshot(root.$client);
  let created = false;
  let result: Record<string, unknown> = {};
  let scenarioError: unknown;
  try {
    await root.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '55s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      created = true;
      for (const table of NEWCOMER_TABLES) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);

      const now = Math.floor(Date.now() / 1_000);
      await tx`INSERT INTO system_config (id, menu_name, value, is_store, status) VALUES
        (1, 'newcomer_status', '1', 0, 1),
        (2, 'newcomer_limit_status', '1', 0, 1),
        (3, 'newcomer_limit_time', '7', 0, 1),
        (4, 'register_integral_status', '1', 0, 1),
        (5, 'register_give_integral', '100', 0, 1),
        (6, 'register_money_status', '1', 0, 1),
        (7, 'register_give_money', '9', 0, 1),
        (8, 'register_coupon_status', '1', 0, 1),
        (9, 'register_give_coupon', '[90]', 0, 1),
        (10, 'first_order_status', '1', 0, 1),
        (11, 'first_order_discount', '90', 0, 1),
        (12, 'first_order_discount_limit', '15.00', 0, 1),
        (13, 'register_price_status', '1', 0, 1),
        (14, 'routine_contact_type', '2', 0, 1),
        (15, 'site_name', 'API006 audit shop', 0, 1),
        (16, 'share_qrcode', '1', 0, 1),
        (17, 'store_self_mention', '1', 0, 1),
        (18, 'store_func_status', '1', 0, 1),
        (19, 'product_poster_title', 'Audit poster', 0, 1)`;
      await tx`INSERT INTO cache ("key", result, expire_time, add_time)
        VALUES ('newcomer_agreement', ${JSON.stringify("isolated newcomer agreement")}, 0, ${now})`;
      await tx`INSERT INTO "user"
        (uid, account, nickname, status, is_del, add_time, last_time, is_newcomer, is_first_order)
        VALUES
          (100, 'newcomer-current', 'Current newcomer', 1, 0, ${now - 60}, ${now - 60}, 0, 0),
          (101, 'newcomer-expired', 'Expired newcomer', 1, 0, ${now - 8 * 86_400}, ${now - 8 * 86_400}, 0, 0),
          (102, 'newcomer-used', 'Used newcomer', 1, 0, ${now - 60}, ${now - 60}, 1, 0),
          (200, 'newcomer-detail', 'Detail viewer', 1, 0, ${now - 60}, ${now - 30}, 0, 0)`;
      await tx`INSERT INTO store_brand (id, brand_name, is_show, is_del)
        VALUES (30, 'Audit brand', 1, 0)`;
      await tx`INSERT INTO store_product_label
        (id, label_name, style_type, color, bg_color, border_color, icon, is_show, status)
        VALUES (40, 'Audit label', 1, '#111111', '#eeeeee', '#222222', '/label.png', 1, 1)`;
      await tx`INSERT INTO store_product_ensure
        (id, type, relation_id, name, image, "desc", sort, status, add_time)
        VALUES (50, 0, 0, 'Audit ensure', '/ensure.png', 'Guaranteed', 10, 1, ${now})`;
      await tx`INSERT INTO store_product
        (id, type, product_type, relation_id, image, slider_image, store_name, store_info,
          price, ot_price, stock, sales, ficti, is_show, is_del, is_verify, spec_type,
          brand_id, store_label_id, ensure_id, specs, video_open, video_link)
        VALUES
          (20, 0, 0, 0, '/product.png', ${JSON.stringify(["/one.png", "/two.png"])},
            'Newcomer product', 'Newcomer info', 100.00, 120.00, 3, 2, 3, 1, 0, 1, 1,
            30, '40', '50', ${JSON.stringify([{ name: "material", value: "audit" }])}, 1, '/video.mp4'),
          (21, 0, 0, 0, '/unverified.png', '[]', 'Unverified product', '', 10.00, 20.00,
            1, 0, 0, 1, 0, 0, 0, 0, '', '', '[]', 0, '')`;
      await tx`INSERT INTO store_product_description (product_id, description, type)
        VALUES (20, '<p>Audit description</p>', 0)`;
      await tx`INSERT INTO store_newcomer
        (id, type, product_id, product_type, relation_id, price, ot_price, sales, is_del, add_time)
        VALUES
          (10, 0, 20, 0, 0, 9.90, 999.00, 0, 0, ${now}),
          (11, 0, 20, 0, 0, 8.90, 888.00, 0, 0, ${now}),
          (12, 0, 21, 0, 0, 1.00, 20.00, 0, 0, ${now})`;
      await tx`INSERT INTO store_product_attr (id, product_id, attr_name, attr_values, type)
        VALUES (60, 20, 'Color', 'Red,Blue,Green', 0)`;
      await tx`INSERT INTO store_product_attr_value
        (id, product_id, product_type, suk, stock, sum_stock, sales, price, settle_price,
          integral, image, "unique", cost, bar_code, ot_price, vip_price, weight, volume,
          brokerage, brokerage_two, type, quota, quota_show, code)
        VALUES
          (70, 20, 0, 'Red', 3, 3, 1, 100.00, 80.00, 0, '/red.png', 'BASE0001',
            70.00, 'RED', 120.00, 0.00, 1.00, 1.00, 0.00, 0.00, 0, 0, 0, 'RED'),
          (71, 20, 0, 'Blue', 0, 0, 1, 110.00, 85.00, 0, '/blue.png', 'BASE0002',
            75.00, 'BLUE', 120.00, 0.00, 1.00, 1.00, 0.00, 0.00, 0, 0, 0, 'BLUE'),
          (80, 10, 0, 'Red', 99, 99, 0, 9.90, 8.00, 0, '/red-audit.png', 'NEWC0001',
            7.00, 'NRED', 100.00, 0.00, 1.00, 1.00, 0.00, 0.00, 7, 0, 0, 'NRED'),
          (81, 10, 0, 'Blue', 99, 99, 0, 10.90, 8.50, 0, '/blue-audit.png', 'NEWC0002',
            7.50, 'NBLUE', 110.00, 0.00, 1.00, 1.00, 0.00, 0.00, 7, 0, 0, 'NBLUE')`;
      await tx`INSERT INTO user_relation (id, uid, relation_id, type, category, add_time)
        VALUES (90, 200, 20, 'collect', 'product', ${now})`;
      await tx`INSERT INTO store_coupon_user
        (id, uid, issue_coupon_id, coupon_title, coupon_price, use_min_price, status, receive_time, receive_source)
        VALUES (91, 100, 90, 'Audit coupon', 5.00, 10.00, 0, ${now}, 'newcomer')`;
      await tx`INSERT INTO store_product_reply
        (id, product_id, oid, "unique", uid, nickname, avatar, comment, sku, sku_unique,
          product_score, service_score, logistics_score, delivery_score, status, is_del, add_time)
        VALUES (92, 20, 0, 'reply-audit', 100, 'Reviewer', '/reviewer.png', 'Good', 'Red',
          'BASE0001', 5, 5, 5, 5, 1, 0, ${now})`;
      await tx`INSERT INTO store_order
        (id, order_id, uid, pid, activity_id, type, paid, is_del, total_num, "unique", add_time)
        VALUES
          (100, 'newcomer-paid', 200, 0, 10, 7, 1, 1, 2, 'newcomer-paid', ${now}),
          (101, 'newcomer-open', 200, 0, 10, 7, 0, 0, 1, 'newcomer-open', ${now}),
          (102, 'newcomer-deleted', 200, 0, 10, 7, 0, 1, 4, 'newcomer-deleted', ${now}),
          (103, 'newcomer-child', 200, 100, 10, 7, 1, 0, 8, 'newcomer-child', ${now})`;
    });

    result = await root.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const service = new StoreNewcomerService(
        createContainerFromDb(transactionDb(tx, root.$client.options)),
        auditRuntimeEnv(env),
      );
      const [list, detail, info, gift, expired, used, unverifiedRejected] = await Promise.all([
        service.list(100, "1", "10"),
        service.detail(200, 10),
        service.info(100, false),
        service.info(100, true),
        service.list(101, "1", "10"),
        service.list(102, "1", "10"),
        rejects(() => service.detail(100, 12)),
      ]);
      const productValue = detail.productValue as Record<string, Record<string, unknown>>;
      const productAttr = detail.productAttr as Array<Record<string, unknown>>;
      const storeInfo = detail.storeInfo as Record<string, unknown>;
      const assertions = {
        list_contract: list.length === 2
          && list[0]?.id === 11
          && list[1]?.id === 10
          && list[0]?.ot_price === "120.00",
        eligibility_gates: expired.length === 0 && used.length === 0,
        visibility_gate: unverifiedRejected,
        sku_key_and_base_stock: Object.keys(productValue).join(",") === "Red,Blue"
          && productValue.Red?.stock === 3
          && productValue.Blue?.stock === 0
          && productValue.Red?.product_stock === 3,
        selectable_attributes: Array.isArray(productAttr[0]?.attr_values)
          && JSON.stringify(productAttr[0]?.attr_values) === JSON.stringify(["Red", "Blue"]),
        detail_product_contract: storeInfo.id === 10
          && storeInfo.product_id === 20
          && storeInfo.price === "9.90"
          && storeInfo.ot_price === "120.00"
          && storeInfo.brand_name === "Audit brand"
          && storeInfo.description === "<p>Audit description</p>"
          && storeInfo.userCollect === true,
        detail_metadata_contract: Array.isArray(storeInfo.store_label)
          && storeInfo.store_label.length === 1
          && Array.isArray(storeInfo.ensure)
          && storeInfo.ensure.length === 1
          && detail.replyCount === 1
          && detail.replyChance === 100
          && detail.buy_num === 3,
        detail_config_contract: detail.routine_contact_type === 2
          && detail.store_func_status === 1
          && detail.store_self_mention === 1
          && detail.site_name === "API006 audit shop"
          && detail.share_qrcode === 1
          && detail.product_poster_title === "Audit poster",
        info_contract: info.product_count === 3
          && info.coupon_count === 1
          && info.newcomer_agreement === "isolated newcomer agreement"
          && typeof info.last_time === "number",
        gift_contract: gift.product_count === 3
          && gift.coupon_count === 1
          && !("last_time" in gift)
          && !("newcomer_agreement" in gift),
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`newcomer isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
      return { assertions, assertion_count: Object.keys(assertions).length };
    });
  } catch (error) {
    scenarioError = error;
  } finally {
    if (created) {
      await root.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }
  const after = await newcomerPublicSnapshot(root.$client);
  await root.$client.end({ timeout: 1 });
  if (scenarioError) throw scenarioError;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("newcomer public state or temporary schema count changed");
  }
  return {
    schema: schemaName,
    ...result,
    cleanup: "dropped",
    public_state_unchanged: true,
    temporary_schemas_before: before.temporary_schemas,
    temporary_schemas_after: after.temporary_schemas,
  };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorized(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const path = new URL(request.url).pathname;
    const validRequest = (request.method === "GET" && path === "/audit")
      || (request.method === "POST" && [
        "/contracts", "/isolated", "/newcomer-isolated", "/migrate-indexes",
      ].includes(path));
    if (!validRequest) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    try {
      const result = path === "/audit"
        ? await inspectProduction(env.HYPERDRIVE.connectionString)
        : path === "/contracts"
          ? await productionContracts(env.HYPERDRIVE.connectionString, env)
          : path === "/newcomer-isolated"
            ? await newcomerIsolatedScenario(env.HYPERDRIVE.connectionString, env)
          : path === "/isolated"
            ? await isolatedScenario(env.HYPERDRIVE.connectionString, env)
            : await applyActivityIndexes(env.HYPERDRIVE.connectionString);
      return Response.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "api006_inventory_audit_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json({
        error: "audit_failed",
        detail: error instanceof Error ? error.message : String(error),
      }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
