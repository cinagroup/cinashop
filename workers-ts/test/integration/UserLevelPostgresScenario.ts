import { and, eq, sql } from "drizzle-orm";
import type postgres from "postgres";
import { createContainerFromDb, createDbFromConnectionString, withTx } from "@/lib/di";
import type { Env } from "@/env";
import { UserLevelService } from "@/services/user/UserLevelService";
import { UserProfileService } from "@/services/user/UserProfileService";
import { KefuRealtimeService } from "@/services/kefu/KefuRealtimeService";
import {
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  systemConfig,
  systemUserLevel,
  user,
  userBill,
  userLevel,
  userMoney,
} from "@/models/schema";

const TABLES = [
  "user",
  "system_config",
  "system_user_level",
  "user_level",
  "user_bill",
  "user_money",
  "store_coupon_issue",
  "store_coupon_user",
  "store_coupon_issue_user",
] as const;

const SERIAL_TABLES = ["user_level", "user_bill", "user_money", "store_coupon_user"] as const;
const AUDIT_UID = 1_730_030_001;
const FIRST_LEVEL_ID = 1_730_031_001;
const SECOND_LEVEL_ID = 1_730_031_002;
const COUPON_ID = 1_730_032_001;

function assertSchema(schemaName: string): void {
  if (!/^codex_api003_[a-z0-9_]{8,55}$/.test(schemaName)) {
    throw new Error("unsafe API-003 audit schema");
  }
}

function auditEnv(connectionString: string): Env {
  const cache = new Map<string, string>();
  return {
    HYPERDRIVE: { connectionString },
    CONFIG_KV: {
      get: async (key: string) => cache.get(key) ?? null,
      put: async (key: string, value: string) => { cache.set(key, value); },
      delete: async (key: string) => { cache.delete(key); },
    },
  } as unknown as Env;
}

export async function setupUserLevelAudit(connectionString: string, schemaName: string) {
  assertSchema(schemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_setup",
  });
  try {
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      for (const table of TABLES) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      for (const table of SERIAL_TABLES) {
        const sequence = `${table}_id_seq`;
        await tx.unsafe(`CREATE SEQUENCE "${schemaName}"."${sequence}"`);
        await tx.unsafe(
          `ALTER TABLE "${schemaName}"."${table}" ALTER COLUMN "id" SET DEFAULT nextval('"${schemaName}"."${sequence}"')`,
        );
      }
    });

    const scoped = createDbFromConnectionString(connectionString, 1, {
      searchPath: schemaName,
      applicationName: "cinashop_api003_seed",
    });
    try {
      await withTx(createContainerFromDb(scoped), async (tx) => {
        const now = Math.floor(Date.now() / 1_000);
        await tx.insert(user).values({
        uid: AUDIT_UID,
        account: "api003-audit",
        nickname: "API003审计用户",
        realName: "",
        nowMoney: "10.25",
        integral: 7,
        exp: "120.00",
        status: 1,
        level: 0,
        levelStatus: 0,
        isDel: 0,
      });
        await tx.insert(systemUserLevel).values([
        {
          id: FIRST_LEVEL_ID,
          name: "审计一级",
          grade: 1,
          expNum: 0,
          discount: "98.00",
          isForever: 1,
          isShow: 1,
          isDel: 0,
          addTime: now,
        },
        {
          id: SECOND_LEVEL_ID,
          name: "审计二级",
          grade: 2,
          expNum: 100,
          discount: "95.00",
          isForever: 1,
          isShow: 1,
          isDel: 0,
          addTime: now,
        },
      ]);
        await tx.insert(storeCouponIssue).values({
        id: COUPON_ID,
        title: "会员激活审计券",
        couponTitle: "会员激活审计券",
        couponPrice: "5.00",
        useMinPrice: "20.00",
        totalCount: 2,
        remainCount: 2,
        receiveType: 3,
        startTime: new Date((now - 60) * 1_000),
        endTime: new Date((now + 3_600) * 1_000),
        day: 7,
        isPermanent: 0,
        status: 1,
        isDel: 0,
        addTime: now,
      });
        const form = JSON.stringify([
        { info: "姓名", param: "real_name", format: "text", required: 1, tip: "请填写真实姓名" },
        { info: "性别", param: "sex", format: "radio", required: 0 },
        { info: "生日", param: "birthday", format: "date", required: 0 },
      ]);
        const configs: Array<[string, string]> = [
        ["member_func_status", "1"],
        ["level_activate_status", "1"],
        ["level_extend_info", form],
        ["level_integral_status", "1"],
        ["level_give_integral", "13"],
        ["level_money_status", "1"],
        ["level_give_money", "2.75"],
        ["level_coupon_status", "1"],
        ["level_give_coupon", JSON.stringify([COUPON_ID])],
      ];
        await tx.insert(systemConfig).values(configs.map(([menuName, value], index) => ({
          id: 1_730_033_000 + index,
          menuName,
          value,
          isStore: 0,
          status: 1,
        })));
      });
    } finally {
      await scoped.$client.end({ timeout: 1 });
    }
    return { schema: schemaName, seeded: true };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function runUserLevelAudit(connectionString: string, schemaName: string) {
  assertSchema(schemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_api003_run",
  });
  try {
    const service = new UserLevelService(createContainerFromDb(db), auditEnv(connectionString));
    const input = [
      { info: "姓名", value: "生产隔离审计" },
      { info: "性别", value: "女" },
      { info: "生日", value: "2001-02-03" },
      { info: "越权等级", param: "level", value: SECOND_LEVEL_ID },
    ];
    const reward = await service.activateLevel(AUDIT_UID, input);
    let replayError = "";
    try {
      await service.activateLevel(AUDIT_UID, input);
    } catch (error) {
      replayError = error instanceof Error ? error.message : String(error);
    }
    if (replayError !== "不需要重复激活") {
      throw new Error("activation replay did not fail closed");
    }
    await service.detection(AUDIT_UID);
    return {
      fulfilled: 1,
      rejected: 1,
      replay_error: replayError,
      reward,
      detection: true,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function runUserProfileAudit(connectionString: string, schemaName: string) {
  assertSchema(schemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_api003_profile_run",
  });
  try {
    const env = auditEnv(connectionString);
    const paymentCodes = new Map<string, string>();
    const service = new UserProfileService(createContainerFromDb(db), env, {
      get: async (key) => paymentCodes.get(key) ?? null,
      putIfAbsent: async (key, value) => {
        if (paymentCodes.has(key)) return false;
        paymentCodes.set(key, value);
        return true;
      },
    });
    const now = 1_800_000_000;
    const firstShare = await service.recordShare(AUDIT_UID, now);
    const replayShare = await service.recordShare(AUDIT_UID, now + 1);
    const firstCode = await service.paymentCode(AUDIT_UID);
    const replayCode = await service.paymentCode(AUDIT_UID);
    if (!firstShare || replayShare || firstCode !== replayCode || !/^\d{6}$/.test(firstCode)) {
      throw new Error("API-003 user-profile replay assertions failed");
    }
    return {
      share_recorded: firstShare,
      share_replay_rejected: !replayShare,
      payment_code_six_digits: /^\d{6}$/.test(firstCode),
      payment_code_reused: firstCode === replayCode,
    };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function verifyUserProfileAudit(connectionString: string, schemaName: string) {
  assertSchema(schemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_api003_profile_verify",
  });
  try {
    return await withTx(createContainerFromDb(db), async (tx) => {
      const rows = await tx.select({ count: sql<number>`count(*)::int` }).from(userBill)
        .where(and(
          eq(userBill.uid, AUDIT_UID),
          eq(userBill.eventKey, "user_share"),
          eq(userBill.status, 1),
        ));
      const assertions = { single_share_evidence: rows[0]?.count === 1 };
      if (!assertions.single_share_evidence) {
        throw new Error(`API-003 profile assertions failed: ${JSON.stringify(assertions)}`);
      }
      return { schema: schemaName, assertions };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

/** Production public smoke test. Every PostgreSQL query runs in one READ ONLY transaction. */
export async function smokeProductionUserProfile(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_profile_smoke",
  });
  try {
    return await withTx(createContainerFromDb(db), async (tx) => {
      await tx.execute(sql`SET LOCAL search_path TO public`);
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      const candidates = await tx.execute(sql`
        SELECT
          (SELECT uid FROM public."user" WHERE is_del = 0 AND status = 1 ORDER BY uid LIMIT 1) AS uid,
          (SELECT id FROM public.store_product ORDER BY id LIMIT 1) AS product_id
      `);
      const candidate = candidates[0] as Record<string, unknown> | undefined;
      const uid = Number(candidate?.uid ?? 0);
      const productId = Number(candidate?.product_id ?? 0);
      const service = new UserProfileService(createContainerFromDb(tx), auditEnv(connectionString));
      const activity = await service.activity();
      if (!Number.isSafeInteger(uid) || uid <= 0) {
        return { transaction: "READ ONLY", user_present: false, activity_shape: Object.keys(activity).sort() };
      }
      const [info, home, spread, words, conversations] = await Promise.all([
        service.userInfo(uid),
        service.personalHome(uid),
        service.spreadInfo(uid),
        productId > 0 ? service.shareWords(productId) : Promise.resolve(""),
        new KefuRealtimeService(createContainerFromDb(tx), {
          APP_KEY: "api003-read-only-smoke-key",
          UPSTASH_REDIS_URL: "",
          UPSTASH_REDIS_TOKEN: "",
        }).userConversationList(uid, { page: "1", limit: "10" }),
      ]);
      const forbidden = ["pwd", "account", "uniqid", "rand_code", "add_ip", "last_ip", "clean_time"];
      const safeProjection = forbidden.every((key) => !(key in info) && !(key in home));
      const requiredHomeKeys = [
        "couponCount", "orderStatusNum", "broken_commission", "commissionCount",
        "spread_user_count", "vip", "service_num", "visit_num",
      ];
      const assertions = {
        activity_shape: ["is_bargin", "is_pink", "is_seckill"].every((key) => key in activity),
        safe_projection: safeProjection,
        home_shape: requiredHomeKeys.every((key) => key in home),
        spread_shape: ["spread", "qrcode", "nickname", "avatar", "site_name"].every((key) => key in spread),
        conversation_list_shape: Array.isArray(conversations),
        words_shape: productId <= 0 || (
          words.startsWith("crmeb-fu致文本 Http:/ZБ") && words.includes("Б轉移至☞")
        ),
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`production profile smoke failed: ${JSON.stringify(assertions)}`);
      }
      return {
        transaction: "READ ONLY",
        user_present: true,
        product_present: productId > 0,
        assertions,
        home_key_count: Object.keys(home).length,
        conversation_count: conversations.length,
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function verifyUserLevelAudit(connectionString: string, schemaName: string) {
  assertSchema(schemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    searchPath: schemaName,
    applicationName: "cinashop_api003_verify",
  });
  try {
    return await withTx(createContainerFromDb(db), async (tx) => {
      const [accounts, bills, money, coupons, issueEvidence, levels, inventory] = await Promise.all([
      tx.select({
        levelStatus: user.levelStatus,
        level: user.level,
        realName: user.realName,
        sex: user.sex,
        birthday: user.birthday,
        integral: user.integral,
        nowMoney: user.nowMoney,
      }).from(user).where(eq(user.uid, AUDIT_UID)),
      tx.select({ count: sql<number>`count(*)::int` }).from(userBill)
        .where(eq(userBill.eventKey, "level_give_integral")),
      tx.select({ count: sql<number>`count(*)::int` }).from(userMoney)
        .where(eq(userMoney.type, "level_add")),
      tx.select({ count: sql<number>`count(*)::int` }).from(storeCouponUser)
        .where(eq(storeCouponUser.receiveSource, "activate_level")),
      tx.select({ count: sql<number>`count(*)::int` }).from(storeCouponIssueUser)
        .where(eq(storeCouponIssueUser.uid, AUDIT_UID)),
      tx.select({ count: sql<number>`count(*)::int` }).from(userLevel)
        .where(eq(userLevel.uid, AUDIT_UID)),
      tx.select({ remainCount: storeCouponIssue.remainCount }).from(storeCouponIssue)
        .where(eq(storeCouponIssue.id, COUPON_ID)),
    ]);
    const state = accounts[0];
    const assertions = {
      activated_once: state?.levelStatus === 1,
      level_from_exp: state?.level === SECOND_LEVEL_ID,
      profile_whitelist: state?.realName === "生产隔离审计" && state.sex === 2
        && state.birthday === 981_129_600,
      integral_once: state?.integral === 20 && bills[0]?.count === 1,
      money_truncated_like_php: state?.nowMoney === "12.25" && money[0]?.count === 1,
      coupon_once: coupons[0]?.count === 1 && issueEvidence[0]?.count === 1
        && inventory[0]?.remainCount === 1,
      detected_levels: levels[0]?.count === 2,
    };
    if (Object.values(assertions).some((value) => !value)) {
      throw new Error(`API-003 assertions failed: ${JSON.stringify(assertions)}`);
    }
      return { schema: schemaName, assertions, state };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function cleanupUserLevelAudit(connectionString: string, schemaName: string) {
  assertSchema(schemaName);
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_cleanup",
  });
  try {
    await db.$client.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    return { schema: schemaName, cleanup: "dropped" };
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function listUserLevelAuditSchemas(connectionString: string): Promise<string[]> {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_orphan_list",
  });
  try {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const rows = await db.$client.unsafe<{ nspname: string }[]>(`
      SELECT nspname
      FROM pg_namespace
      WHERE nspname ~ '^codex_api003_[0-9]+_[a-f0-9]{10}$'
      ORDER BY nspname
      /* api003_catalog_${nonce} */
    `);
    return rows.map((row) => row.nspname);
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export async function cleanupUserLevelAuditSchemas(connectionString: string) {
  const before = await listUserLevelAuditSchemas(connectionString);
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_orphan_cleanup",
  });
  try {
    for (const schemaName of before) {
      assertSchema(schemaName);
      await db.$client.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  } finally {
    await db.$client.end({ timeout: 1 });
  }
  return { before, after: await listUserLevelAuditSchemas(connectionString) };
}

/** Inspect only the immutable marker IDs used by the API-003 audit harness. */
export async function inspectPublicUserLevelAuditMarkers(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_marker_inspect",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx<Record<string, number>[]>`
        SELECT
          (SELECT count(*)::int FROM public."user"
            WHERE uid = ${AUDIT_UID} AND account = 'api003-audit') AS audit_users,
          (SELECT count(*)::int FROM public.system_user_level
            WHERE (id = ${FIRST_LEVEL_ID} AND name = '审计一级')
               OR (id = ${SECOND_LEVEL_ID} AND name = '审计二级')) AS audit_levels,
          (SELECT count(*)::int FROM public.store_coupon_issue
            WHERE id = ${COUPON_ID} AND title = '会员激活审计券') AS audit_coupon_issues,
          (SELECT count(*)::int FROM public.system_config
            WHERE id BETWEEN 1730033000 AND 1730033008
              AND menu_name IN (
                'member_func_status', 'level_activate_status', 'level_extend_info',
                'level_integral_status', 'level_give_integral', 'level_money_status',
                'level_give_money', 'level_coupon_status', 'level_give_coupon'
              )) AS audit_configs,
          (SELECT count(*)::int FROM public.user_level
            WHERE uid = ${AUDIT_UID} AND level_id IN (${FIRST_LEVEL_ID}, ${SECOND_LEVEL_ID})) AS audit_user_levels,
          (SELECT count(*)::int FROM public.user_bill
            WHERE uid = ${AUDIT_UID} AND event_key = 'level_give_integral') AS audit_integral_bills,
          (SELECT count(*)::int FROM public.user_money
            WHERE uid = ${AUDIT_UID} AND type = 'level_add') AS audit_money_bills,
          (SELECT count(*)::int FROM public.store_coupon_user
            WHERE uid = ${AUDIT_UID} AND issue_coupon_id = ${COUPON_ID}
              AND receive_source = 'activate_level') AS audit_user_coupons,
          (SELECT count(*)::int FROM public.store_coupon_issue_user
            WHERE uid = ${AUDIT_UID} AND issue_coupon_id = ${COUPON_ID}) AS audit_coupon_evidence
      `;
      return rows[0];
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

/** Remove only rows that match both the fixed audit IDs and their synthetic labels. */
export async function cleanupPublicUserLevelAuditMarkers(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api003_marker_cleanup",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      const before = await inspectPublicUserLevelAuditMarkersWithTx(tx);
      await tx`DELETE FROM public.store_coupon_issue_user
        WHERE uid = ${AUDIT_UID} AND issue_coupon_id = ${COUPON_ID}`;
      await tx`DELETE FROM public.store_coupon_user
        WHERE uid = ${AUDIT_UID} AND issue_coupon_id = ${COUPON_ID}
          AND receive_source = 'activate_level'`;
      await tx`DELETE FROM public.user_level
        WHERE uid = ${AUDIT_UID} AND level_id IN (${FIRST_LEVEL_ID}, ${SECOND_LEVEL_ID})`;
      await tx`DELETE FROM public.user_bill
        WHERE uid = ${AUDIT_UID} AND event_key = 'level_give_integral'`;
      await tx`DELETE FROM public.user_money
        WHERE uid = ${AUDIT_UID} AND type = 'level_add'`;
      await tx`DELETE FROM public.system_config
        WHERE id BETWEEN 1730033000 AND 1730033008
          AND menu_name IN (
            'member_func_status', 'level_activate_status', 'level_extend_info',
            'level_integral_status', 'level_give_integral', 'level_money_status',
            'level_give_money', 'level_coupon_status', 'level_give_coupon'
          )`;
      await tx`DELETE FROM public.store_coupon_issue
        WHERE id = ${COUPON_ID} AND title = '会员激活审计券'`;
      await tx`DELETE FROM public.system_user_level
        WHERE (id = ${FIRST_LEVEL_ID} AND name = '审计一级')
           OR (id = ${SECOND_LEVEL_ID} AND name = '审计二级')`;
      await tx`DELETE FROM public."user"
        WHERE uid = ${AUDIT_UID} AND account = 'api003-audit'`;
      const after = await inspectPublicUserLevelAuditMarkersWithTx(tx);
      return { before, after };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function inspectPublicUserLevelAuditMarkersWithTx(
  tx: postgres.TransactionSql,
) {
  const rows = await tx<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM public."user"
        WHERE uid = ${AUDIT_UID} AND account = 'api003-audit') AS audit_users,
      (SELECT count(*)::int FROM public.system_user_level
        WHERE (id = ${FIRST_LEVEL_ID} AND name = '审计一级')
           OR (id = ${SECOND_LEVEL_ID} AND name = '审计二级')) AS audit_levels,
      (SELECT count(*)::int FROM public.store_coupon_issue
        WHERE id = ${COUPON_ID} AND title = '会员激活审计券') AS audit_coupon_issues,
      (SELECT count(*)::int FROM public.system_config
        WHERE id BETWEEN 1730033000 AND 1730033008
          AND menu_name IN (
            'member_func_status', 'level_activate_status', 'level_extend_info',
            'level_integral_status', 'level_give_integral', 'level_money_status',
            'level_give_money', 'level_coupon_status', 'level_give_coupon'
          )) AS audit_configs,
      (SELECT count(*)::int FROM public.user_level
        WHERE uid = ${AUDIT_UID} AND level_id IN (${FIRST_LEVEL_ID}, ${SECOND_LEVEL_ID})) AS audit_user_levels,
      (SELECT count(*)::int FROM public.user_bill
        WHERE uid = ${AUDIT_UID} AND event_key = 'level_give_integral') AS audit_integral_bills,
      (SELECT count(*)::int FROM public.user_money
        WHERE uid = ${AUDIT_UID} AND type = 'level_add') AS audit_money_bills,
      (SELECT count(*)::int FROM public.store_coupon_user
        WHERE uid = ${AUDIT_UID} AND issue_coupon_id = ${COUPON_ID}
          AND receive_source = 'activate_level') AS audit_user_coupons,
      (SELECT count(*)::int FROM public.store_coupon_issue_user
        WHERE uid = ${AUDIT_UID} AND issue_coupon_id = ${COUPON_ID}) AS audit_coupon_evidence
  `;
  return rows[0];
}
