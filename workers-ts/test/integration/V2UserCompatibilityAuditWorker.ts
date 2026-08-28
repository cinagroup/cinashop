import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import { CapitalFlowService } from "@/services/finance/CapitalFlowService";
import { V2UserCompatibilityService } from "@/services/user/V2UserCompatibilityService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_api004_user_";

async function authorize(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function transactionDb(tx: unknown, options: unknown): DbClient {
  const client = tx as { options?: unknown };
  if (!client.options) client.options = options;
  return drizzle(tx as never, { schema }) as unknown as DbClient;
}

async function productionSnapshot(client: postgres.Sql) {
  const rows = await client<Array<Record<string, unknown>>>`
    SELECT
      (SELECT jsonb_build_array(count(*), COALESCE(sum(uid), 0), COALESCE(max(last_time), 0)) FROM public."user") AS users,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.wechat_user) AS wechat_users,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.user_money) AS user_money,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.user_brokerage) AS user_brokerage,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.user_extract) AS user_extract,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.user_recharge) AS user_recharge,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.store_order_refund) AS refunds,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.capital_flow) AS capital_flow,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.agreement) AS agreement,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}) AS temporary_schemas
  `;
  return rows[0];
}

async function productionState(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_api004_user_state" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const state = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM "user") AS user_rows,
          (SELECT count(*)::integer FROM "user" WHERE status = 1 AND is_del = 0 AND delete_time IS NULL) AS active_user_rows,
          (SELECT count(*)::integer FROM wechat_user) AS wechat_rows,
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(user_type, rows) ORDER BY user_type), '[]'::jsonb)
             FROM (SELECT user_type, count(*)::integer AS rows FROM wechat_user GROUP BY user_type) channels) AS wechat_channels,
          (SELECT count(*)::integer FROM wechat_user identity
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = identity.uid)) AS orphan_wechat_rows,
          (SELECT count(*)::integer FROM (
             SELECT uid, user_type FROM wechat_user WHERE is_del = 0 GROUP BY uid, user_type HAVING count(*) > 1
           ) duplicates) AS duplicate_active_uid_channels,
          (SELECT count(*)::integer FROM user_money) AS money_rows,
          (SELECT count(*)::integer FROM user_brokerage) AS brokerage_rows,
          (SELECT count(*)::integer FROM user_extract) AS extract_rows,
          (SELECT count(*)::integer FROM user_recharge) AS recharge_rows,
          (SELECT count(*)::integer FROM store_order_refund) AS refund_rows,
          (SELECT count(*)::integer FROM capital_flow) AS capital_rows,
          (SELECT count(*)::integer FROM agreement WHERE type = 2) AS referral_agreement_rows,
          (SELECT count(*)::integer FROM "user" WHERE spread_uid > 0) AS referred_user_rows,
          (SELECT count(*)::integer FROM "user" WHERE spread_uid > 0 AND pay_count > 0) AS paid_referred_user_rows,
          (SELECT count(*)::integer FROM "user" child WHERE child.spread_uid > 0
             AND NOT EXISTS (SELECT 1 FROM "user" parent WHERE parent.uid = child.spread_uid)) AS orphan_referral_parents,
          (SELECT count(*)::integer FROM user_money ledger
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = ledger.uid)) AS orphan_money_rows,
          (SELECT count(*)::integer FROM user_brokerage ledger
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = ledger.uid)) AS orphan_brokerage_rows,
          (SELECT count(*)::integer FROM user_extract ledger
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = ledger.uid)) AS orphan_extract_rows,
          (SELECT count(*)::integer FROM user_recharge ledger
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = ledger.uid)) AS orphan_recharge_rows,
          (SELECT count(*)::integer FROM store_order_refund ledger
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = ledger.uid)) AS orphan_refund_rows,
          (SELECT count(*)::integer FROM capital_flow ledger
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = ledger.uid)) AS orphan_capital_rows,
          pg_total_relation_size('user_money'::regclass)::bigint AS money_total_bytes,
          pg_total_relation_size('user_brokerage'::regclass)::bigint AS brokerage_total_bytes,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}) AS temporary_schemas
      `;
      const providerConfig = await tx<Array<Record<string, unknown>>>`
        SELECT menu_name,
               bool_or(status = 1 AND NULLIF(btrim(value), '') IS NOT NULL) AS configured,
               count(*)::integer AS rows
        FROM system_config
        WHERE is_store = 0
          AND menu_name IN ('wechat_appid', 'wechat_appsecret', 'routine_appId', 'routine_appsecret')
        GROUP BY menu_name ORDER BY menu_name
      `;
      const providerConfigCandidates = await tx<Array<Record<string, unknown>>>`
        SELECT menu_name,
               bool_or(status = 1 AND NULLIF(btrim(value), '') IS NOT NULL) AS configured,
               count(*)::integer AS rows
        FROM system_config
        WHERE is_store = 0
          AND (lower(menu_name) LIKE '%wechat%appid%'
            OR lower(menu_name) LIKE '%wechat%secret%'
            OR lower(menu_name) LIKE '%routine%appid%'
            OR lower(menu_name) LIKE '%routine%secret%')
        GROUP BY menu_name ORDER BY menu_name
      `;
      const plan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM user_money WHERE uid = 1 ORDER BY id DESC LIMIT 10
      `;
      return {
        transaction: "READ ONLY",
        state: state[0],
        provider_config: providerConfig,
        provider_config_candidates: providerConfigCandidates,
        money_list_plan: plan[0]?.["QUERY PLAN"] ?? null,
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

function listSummary(value: unknown) {
  const list = (value as { list?: unknown[] } | null)?.list ?? [];
  return {
    length: list.length,
    first_keys: list[0] && typeof list[0] === "object"
      ? Object.keys(list[0] as Record<string, unknown>).sort()
      : [],
  };
}

async function productionContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_user_contracts",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const users = await tx<Array<{ uid: number }>>`
        SELECT uid FROM "user" WHERE status = 1 AND is_del = 0 AND delete_time IS NULL ORDER BY uid LIMIT 1
      `;
      const uid = users[0]?.uid ?? 0;
      if (!uid) return { transaction: "READ ONLY", observed: { has_user: false }, contracts: {} };
      const container = createContainerFromDb(transactionDb(tx, db.$client.options));
      const service = new V2UserCompatibilityService(container);
      const query = { page: 1, limit: 10 };
      const [money, spending, income, brokerage, extracts, capital, referrals, paid, info] = await Promise.all([
        service.moneyList(uid, 0, query),
        service.moneyList(uid, 1, query),
        service.moneyList(uid, 2, query),
        service.brokerageList(uid, query),
        service.extractList(uid, query),
        new CapitalFlowService(container).listForUser(uid, 0, 0, 1, 10),
        service.agentUserList(uid, 0, query),
        service.agentUserList(uid, 1, query),
        service.agentInfo(uid),
      ]);
      const owned = (value: { list?: Array<Record<string, unknown>> }) =>
        (value.list ?? []).every((row) => Number(row.uid) === uid);
      return {
        transaction: "READ ONLY",
        observed: { has_user: true, uid },
        contracts: {
          money: { ...listSummary(money), count: money.count, owned: owned(money) },
          spending: { ...listSummary(spending), count: spending.count, owned: owned(spending) },
          income: { ...listSummary(income), count: income.count, owned: owned(income) },
          brokerage: { ...listSummary(brokerage), owned: owned(brokerage) },
          extracts: { ...listSummary(extracts), owned: owned(extracts) },
          capital: { ...listSummary(capital), owned: owned(capital) },
          referrals: { ...listSummary(referrals), count: referrals.count },
          paid_referrals: { ...listSummary(paid), count: paid.count },
          agent_info: { ...listSummary(info), agreement: typeof info.agreement, price: typeof info.price },
        },
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function isolatedScenario(connectionString: string) {
  const random = crypto.randomUUID().replaceAll("-", "").toLowerCase();
  const schemaName = `${AUDIT_SCHEMA_PREFIX}${Date.now()}_${random.slice(0, 8)}`;
  if (!/^codex_api004_user_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const baseId = 1_850_000_000 + (Number.parseInt(random.slice(0, 6), 16) % 100_000);
  const now = Math.floor(Date.now() / 1_000);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_user_isolated_root",
  });
  const before = await productionSnapshot(root.$client);
  let created = false;
  let scoped: DbClient | undefined;
  let result: Record<string, unknown> = {};
  let scenarioError: unknown;
  try {
    await root.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      for (const table of [
        "user",
        "wechat_user",
        "user_money",
        "store_order_refund",
        "user_recharge",
        "user_brokerage",
        "user_extract",
        "capital_flow",
        "agreement",
      ]) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      const owner = baseId + 1;
      const invited = baseId + 2;
      const paid = baseId + 3;
      await tx`
        INSERT INTO "user" (uid, account, nickname, avatar, add_time, last_time, status, is_del, spread_uid, spread_time, pay_count)
        VALUES
          (${owner}, 'audit-owner', '原昵称', '/old.jpg', ${now - 100}, ${now - 100}, 1, 0, 0, 0, 0),
          (${invited}, 'audit-invited', '未下单好友', '/u.jpg', ${now - 90}, ${now - 90}, 1, 0, ${owner}, ${now - 80}, 0),
          (${paid}, 'audit-paid', '已下单好友', '/p.jpg', ${now - 70}, ${now - 70}, 1, 0, ${owner}, ${now - 60}, 2)
      `;
      await tx`
        INSERT INTO wechat_user
          (id, uid, openid, nickname, headimgurl, user_type, is_complete, is_del, add_time)
        VALUES
          (${baseId + 10}, ${owner}, ${`routine-${random.slice(0, 12)}`}, '旧小程序', '/r-old.jpg', 'routine', 0, 0, ${now - 100}),
          (${baseId + 11}, ${owner}, ${`wechat-${random.slice(0, 12)}`}, '旧公众号', '/w-old.jpg', 'wechat', 0, 0, ${now - 100}),
          (${baseId + 12}, ${paid}, ${`foreign-${random.slice(0, 12)}`}, '其他用户', '/foreign.jpg', 'routine', 0, 0, ${now - 100})
      `;
      await tx`
        INSERT INTO user_money (id, uid, link_id, type, title, number, balance, pm, mark, status, add_time)
        VALUES
          (${baseId + 20}, ${owner}, ${String(baseId + 30)}, 'pay_product', '商城购物', '20.00', '80.00', 0, '消费', 1, ${now - 30}),
          (${baseId + 21}, ${owner}, ${String(baseId + 31)}, 'recharge', '用户充值', '50.00', '130.00', 1, '充值', 1, ${now - 20}),
          (${baseId + 22}, ${owner}, '0', 'system_add', '系统充值', '5.00', '135.00', 1, '系统充值', 1, ${now - 10})
      `;
      await tx`
        INSERT INTO store_order_refund (id, store_order_id, order_id, uid, refund_type, add_time)
        VALUES (${baseId + 40}, ${baseId + 30}, ${`refund-${random.slice(0, 8)}`}, ${owner}, 4, ${now - 5})
      `;
      await tx`
        INSERT INTO user_recharge (id, uid, order_id, price, paid, refund_price, add_time)
        VALUES (${baseId + 31}, ${owner}, ${`cz-${random.slice(0, 8)}`}, '50.00', 1, '50.00', ${now - 20})
      `;
      await tx`
        INSERT INTO user_extract (id, uid, extract_type, real_name, extract_price, status, fail_msg, add_time)
        VALUES (${baseId + 50}, ${owner}, 'bank', '审计用户', '12.00', -1, '资料不完整', ${now - 15})
      `;
      await tx`
        INSERT INTO user_brokerage
          (id, uid, link_id, pm, title, category, type, number, balance, mark, status, add_time)
        VALUES
          (${baseId + 60}, ${owner}, 'order-1', 1, '获得推广订单佣金', 'now_money', 'one_brokerage', '30.00', '30.00', '收益', 1, ${now - 40}),
          (${baseId + 61}, ${owner}, ${String(baseId + 50)}, 0, '佣金提现', 'extract', 'extract', '12.00', '18.00', '提现', 1, ${now - 15}),
          (${baseId + 62}, ${owner}, ${String(baseId + 50)}, 1, '提现失败', 'extract', 'extract_fail', '12.00', '30.00', '退回', 1, ${now - 14}),
          (${baseId + 63}, ${owner}, 'balance-1', 0, '佣金提现到余额', 'extract', 'extract_money', '3.00', '27.00', '转余额', 1, ${now - 13}),
          (${baseId + 64}, ${paid}, 'order-2', 1, '获得推广订单佣金', 'now_money', 'one_brokerage', '8.00', '8.00', '收益', 1, ${now - 12})
      `;
      await tx`
        INSERT INTO capital_flow (id, flow_id, order_id, uid, nickname, price, trading_type, pay_type, add_time)
        VALUES
          (${baseId + 70}, 'flow-a', 'order-a', ${owner}, '审计用户', '20.00', 1, 'weixin', ${now - 9}),
          (${baseId + 71}, 'flow-b', 'order-b', ${owner}, '审计用户', '88.00', 7, 'weixin', ${now - 8}),
          (${baseId + 72}, 'flow-c', 'order-c', ${owner}, '审计用户', '5.00', 2, 'weixin', ${now - 7})
      `;
      await tx`
        INSERT INTO agreement (id, type, title, content, status, add_time)
        VALUES (${baseId + 80}, 2, '分销规则', '<p>审计规则</p>', 1, ${now})
      `;
    });
    created = true;
    scoped = createDbFromConnectionString(connectionString, 1, {
      searchPath: schemaName,
      applicationName: "cinashop_api004_user_isolated",
    });
    const owner = baseId + 1;
    const paid = baseId + 3;
    const officialOpenid = `wechat-${random.slice(0, 12)}`;
    const writeService = new V2UserCompatibilityService(createContainerFromDb(scoped));
    await writeService.updateRoutineProfile(owner, {
      nickName: "小程序新昵称",
      avatarUrl: "/routine-new.jpg",
      gender: 2,
      language: "zh_CN",
      city: "深圳",
      province: "广东",
      country: "中国",
    }, "203.0.113.10");
    const official = await writeService.refreshVerifiedOfficialProfile(owner, {
      openid: officialOpenid,
      nickname: "公众号新昵称",
      headimgurl: "/wechat-new.jpg",
      sex: 1,
      language: "zh_CN",
      city: "广州",
      province: "广东",
      country: "中国",
    }, "203.0.113.11");
    const scenario = await scoped.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`SET LOCAL statement_timeout = '40s'`;
      const container = createContainerFromDb(transactionDb(tx, scoped!.$client.options));
      const service = new V2UserCompatibilityService(container);
      const query = { page: 1, limit: 20 };
      const [all, spending, income, brokerage, extracts, capital, referrals, paidReferrals, info] = await Promise.all([
        service.moneyList(owner, 0, query),
        service.moneyList(owner, 1, query),
        service.moneyList(owner, 2, query),
        service.brokerageList(owner, { ...query, keyword: "audit-owner" }),
        service.extractList(owner, query),
        new CapitalFlowService(container).listForUser(owner, 0, 0, 1, 20),
        service.agentUserList(owner, 0, query),
        service.agentUserList(owner, 1, query),
        service.agentInfo(owner),
      ]);
      const persisted = await tx<Array<Record<string, unknown>>>`
        SELECT
          (SELECT jsonb_build_object('nickname', nickname, 'avatar', avatar, 'last_ip', last_ip)
             FROM "user" WHERE uid = ${owner}) AS account,
          (SELECT jsonb_build_object('nickname', nickname, 'avatar', headimgurl, 'complete', is_complete, 'city', city)
             FROM wechat_user WHERE uid = ${owner} AND user_type = 'routine') AS routine,
          (SELECT jsonb_build_object('nickname', nickname, 'avatar', headimgurl, 'complete', is_complete, 'city', city)
             FROM wechat_user WHERE uid = ${owner} AND user_type = 'wechat') AS official,
          (SELECT jsonb_build_object('nickname', nickname, 'avatar', headimgurl)
             FROM wechat_user WHERE uid = ${paid} AND user_type = 'routine') AS foreign_identity
      `;
      return { all, spending, income, brokerage, extracts, capital, referrals, paidReferrals, info, persisted };
    });
    const { all, spending, income, brokerage, extracts, capital, referrals, paidReferrals, info, persisted } = scenario;
    const allList = all.list as Array<Record<string, unknown>>;
    const brokerageList = brokerage.list as Array<Record<string, unknown>>;
    const persistedAccount = persisted[0]?.account as Record<string, unknown> | undefined;
    const persistedRoutine = persisted[0]?.routine as Record<string, unknown> | undefined;
    const persistedOfficial = persisted[0]?.official as Record<string, unknown> | undefined;
    const persistedForeign = persisted[0]?.foreign_identity as Record<string, unknown> | undefined;
    const assertions = {
      routine_profile: persistedRoutine?.nickname === "小程序新昵称"
        && persistedRoutine.avatar === "/routine-new.jpg" && persistedRoutine.complete === 1
        && persistedRoutine.city === "深圳",
      official_profile: persistedOfficial?.nickname === "公众号新昵称"
        && persistedOfficial.avatar === "/wechat-new.jpg" && persistedOfficial.complete === 1
        && persistedOfficial.city === "广州" && official.nickname === "公众号新昵称",
      core_profile: persistedAccount?.nickname === "公众号新昵称"
        && persistedAccount.avatar === "/wechat-new.jpg" && persistedAccount.last_ip === "203.0.113.11",
      foreign_identity_unchanged: persistedForeign?.nickname === "其他用户"
        && persistedForeign.avatar === "/foreign.jpg",
      money_filters: all.list.length === 3 && all.count === 3
        && spending.list.length === 1 && income.list.length === 2,
      refund_projection: allList.some((row) => row.type === "pay_product" && row.refund_status === "退款中")
        && allList.some((row) => row.type === "recharge" && row.refund_status === "已退款"),
      brokerage_projection: brokerage.list.length === 4 && brokerage.income === "30.00"
        && brokerage.expend === "15.00"
        && brokerageList.some((row) => row.type === "extract" && row.extract_status === -1 && row.extract_msg === "资料不完整"),
      extract_filter: extracts.list.length === 3,
      capital_filter: capital.list.length === 2
        && capital.list.every((row) => row.type === 1 || row.type === 7),
      referral_path_type: referrals.count === 2 && paidReferrals.count === 1
        && paidReferrals.list[0]?.uid === paid,
      agent_info: info.agreement === "<p>审计规则</p>" && info.price === "30.00"
        && info.list.length === 2,
    };
    if (Object.values(assertions).some((value) => !value)) {
      throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
    }
    result = {
      assertions,
      counts: {
        money: all.count,
        brokerage: brokerage.list.length,
        extracts: extracts.list.length,
        capital: capital.list.length,
        referrals: referrals.count,
        paid_referrals: paidReferrals.count,
        carousel: info.list.length,
      },
    };
  } catch (error) {
    scenarioError = error;
  } finally {
    if (scoped) await scoped.$client.end({ timeout: 1 });
    if (created) {
      await root.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }
  const after = await productionSnapshot(root.$client);
  await root.$client.end({ timeout: 1 });
  if (scenarioError) throw scenarioError;
  const beforeComparable = { ...before, temporary_schemas: undefined };
  const afterComparable = { ...after, temporary_schemas: undefined };
  const unchanged = JSON.stringify(beforeComparable) === JSON.stringify(afterComparable);
  if (!unchanged || before.temporary_schemas !== after.temporary_schemas) {
    throw new Error("public state or temporary schema count changed");
  }
  return {
    schema: schemaName,
    ...result,
    cleanup: "dropped",
    public_state_unchanged: unchanged,
    temporary_schemas_before: before.temporary_schemas,
    temporary_schemas_after: after.temporary_schemas,
  };
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || !["/state", "/contracts", "/isolated"].includes(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const result = path === "/state"
        ? await productionState(env.HYPERDRIVE.connectionString)
        : path === "/contracts"
          ? await productionContracts(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result);
    } catch (error) {
      console.error(JSON.stringify({
        event: "api004_user_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
