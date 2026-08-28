import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import type { Env } from "@/env";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_api004_home_";
const CONFIG_KEYS = [
  "fast_number",
  "bast_number",
  "first_number",
  "promotion_number",
  "tengxun_map_key",
  "site_name",
] as const;

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

function auditServiceEnv(): Env {
  return {
    CONFIG_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as Env;
}

async function productionSnapshot(client: postgres.Sql) {
  const rows = await client<Array<Record<string, unknown>>>`
    SELECT
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(sort), 0))
         FROM public.system_config WHERE is_store = 0 AND menu_name IN ${client(CONFIG_KEYS)}) AS configs,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0))
         FROM public.store_product_category) AS categories,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0))
         FROM public.store_product) AS products,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(product_id), 0))
         FROM public.store_product_relation) AS product_relations,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(subscribe_time), 0))
         FROM public.wechat_user) AS wechat_users,
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
    connection: { application_name: "cinashop_api004_home_state" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM store_product_category WHERE is_show = 1 AND pid = 0) AS visible_root_categories,
          (SELECT count(*)::integer FROM store_product_category WHERE is_show = 1 AND pid > 0) AS visible_child_categories,
          (SELECT count(*)::integer FROM store_product_category child WHERE child.pid > 0
             AND NOT EXISTS (SELECT 1 FROM store_product_category parent WHERE parent.id = child.pid)) AS orphan_category_parents,
          (SELECT count(*)::integer FROM store_product_category WHERE id = pid) AS self_parent_categories,
          (SELECT count(*)::integer FROM store_product WHERE pid = 0 AND is_show = 1 AND is_del = 0
             AND is_verify = 1 AND is_vip_product = 0) AS visible_products,
          (SELECT jsonb_build_object(
             'hot', count(*) FILTER (WHERE is_hot = 1),
             'benefit', count(*) FILTER (WHERE is_benefit = 1),
             'best', count(*) FILTER (WHERE is_best = 1),
             'new', count(*) FILTER (WHERE is_new = 1)) FROM store_product
             WHERE pid = 0 AND is_show = 1 AND is_del = 0 AND is_verify = 1) AS legacy_product_flags,
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(relation_id, rows) ORDER BY relation_id), '[]'::jsonb)
             FROM (SELECT relation_id, count(*)::integer AS rows FROM store_product_relation
                    WHERE type = 3 AND relation_id IN (1, 2, 3, 4)
                    GROUP BY relation_id) grouped) AS homepage_label_relations,
          (SELECT count(*)::integer FROM store_product_relation relation WHERE relation.type = 3
             AND relation.relation_id IN (1, 2, 3, 4)
             AND NOT EXISTS (SELECT 1 FROM store_product product WHERE product.id = relation.product_id)) AS orphan_homepage_relations,
          (SELECT count(*)::integer FROM wechat_user) AS wechat_rows,
          (SELECT count(*)::integer FROM wechat_user WHERE user_type = 'wechat' AND is_del = 0) AS active_official_rows,
          (SELECT count(*)::integer FROM wechat_user WHERE user_type = 'wechat' AND is_del = 0 AND subscribe = 1) AS subscribed_official_rows,
          (SELECT count(*)::integer FROM wechat_user identity
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = identity.uid)) AS orphan_wechat_rows,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}) AS temporary_schemas
      `;
      const configs = await tx<Array<Record<string, unknown>>>`
        SELECT menu_name,
               count(*)::integer AS rows,
               count(*) FILTER (WHERE status = 1)::integer AS enabled_rows,
               count(*) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL)::integer AS nonempty_rows,
               max(length(value))::integer AS max_value_length
        FROM system_config
        WHERE is_store = 0 AND menu_name IN ${tx(CONFIG_KEYS)}
        GROUP BY menu_name ORDER BY menu_name
      `;
      const categoryPlan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM store_product_category
        WHERE pid > 0 AND is_show = 1 ORDER BY sort DESC, id DESC LIMIT 100
      `;
      const labelPlan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT product_id FROM store_product_relation WHERE type = 3 AND relation_id = 1
      `;
      return {
        transaction: "READ ONLY",
        state: rows[0],
        configs,
        plans: {
          child_categories: categoryPlan[0]?.["QUERY PLAN"] ?? null,
          homepage_labels: labelPlan[0]?.["QUERY PLAN"] ?? null,
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

function homeSummary(home: Record<string, unknown>) {
  const info = home.info as Record<string, unknown> | undefined;
  const list = (value: unknown) => Array.isArray(value) ? value : [];
  const ids = (value: unknown) => list(value).map((row) => Number((row as Record<string, unknown>).id));
  return {
    keys: Object.keys(home).sort(),
    info_keys: Object.keys(info ?? {}).sort(),
    fast_ids: ids(info?.fastList),
    best_ids: ids(info?.bastList),
    first_ids: ids(info?.firstList),
    benefit_ids: ids(home.benefit),
    hot_ids: ids(home.likeInfo),
    subscribe: home.subscribe,
    site_name_type: typeof home.site_name,
    map_key_type: typeof home.tengxun_map_key,
  };
}

async function productionContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_home_contracts",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const users = await tx<Array<{ uid: number }>>`
        SELECT uid FROM "user" WHERE status = 1 AND is_del = 0 AND delete_time IS NULL ORDER BY uid LIMIT 1
      `;
      const uid = users[0]?.uid ?? 0;
      const service = new PublicCatalogService(
        createContainerFromDb(transactionDb(tx, db.$client.options)),
        auditServiceEnv(),
      );
      const anonymousHome = await service.homeV2(0);
      const authenticatedHome = uid ? await service.homeV2(uid) : null;
      return {
        transaction: "READ ONLY",
        observed: { has_active_user: Boolean(uid) },
        contracts: {
          anonymous_home: homeSummary(anonymousHome),
          authenticated_home: authenticatedHome ? homeSummary(authenticatedHome) : null,
          anonymous_subscribe_v1: await service.subscribe(0, { anonymousDefault: true }),
          anonymous_subscribe_v2: await service.subscribe(0, { anonymousDefault: false, userType: "wechat" }),
          authenticated_subscribe_v1: uid
            ? await service.subscribe(uid, { anonymousDefault: true })
            : null,
          authenticated_subscribe_v2: uid
            ? await service.subscribe(uid, { anonymousDefault: false, userType: "wechat" })
            : null,
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
  if (!/^codex_api004_home_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const baseId = 1_890_000_000 + (Number.parseInt(random.slice(0, 6), 16) % 100_000);
  const now = Math.floor(Date.now() / 1_000);
  const rootCategory = baseId + 101;
  const childA = baseId + 102;
  const childB = baseId + 103;
  const products = Array.from({ length: 6 }, (_, index) => baseId + 201 + index);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_home_isolated_root",
  });
  const before = await productionSnapshot(root.$client);
  let created = false;
  let result: Record<string, unknown> = {};
  let scenarioError: unknown;
  try {
    await root.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      for (const table of [
        "system_config",
        "store_product_category",
        "store_product",
        "store_product_relation",
        "store_brand",
        "store_product_label",
        "wechat_user",
        "user",
      ]) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      const configValues = ["2", "2", "2", "2", "map-audit", "隔离商城"];
      for (let index = 0; index < CONFIG_KEYS.length; index += 1) {
        await tx`
          INSERT INTO system_config (id, is_store, menu_name, value, sort, status)
          VALUES (${baseId + 10 + index}, 0, ${CONFIG_KEYS[index]}, ${configValues[index]}, 10, 1)
        `;
      }
      await tx`
        INSERT INTO store_product_category (id, pid, type, cate_name, level, pic, sort, is_show, add_time)
        VALUES
          (${rootCategory}, 0, 0, '根分类', 0, '/root.jpg', 100, 1, ${now}),
          (${childA}, ${rootCategory}, 0, '二级甲', 1, '/a.jpg', 90, 1, ${now}),
          (${childB}, ${rootCategory}, 0, '二级乙', 1, '/b.jpg', 80, 1, ${now}),
          (${baseId + 104}, ${rootCategory}, 0, '隐藏二级', 1, '/hidden.jpg', 99, 0, ${now})
      `;
      for (let index = 0; index < products.length; index += 1) {
        await tx`
          INSERT INTO store_product
            (id, pid, image, store_name, price, stock, sort, is_show, is_del, is_verify,
             is_vip_product, is_presale_product, presale_start_time, presale_end_time,
             brand_id, store_label_id, add_time)
          VALUES
            (${products[index]}, 0, ${`/home-${index + 1}.jpg`}, ${`首页商品${index + 1}`}, '20.00',
             20, ${100 - index}, 1, 0, 1, 0, ${index === 2 ? 1 : 0},
             ${index === 2 ? now + 600 : 0}, ${index === 2 ? now + 1_200 : 0},
             ${index === 0 ? 91 : 0}, ${index === 0 ? "101" : ""}, ${now})
        `;
      }
      await tx`
        INSERT INTO store_product_relation (id, type, product_id, relation_id, status, add_time)
        VALUES
          (${baseId + 301}, 3, ${products[0]}, 3, 1, ${now}),
          (${baseId + 302}, 3, ${products[1]}, 3, 1, ${now}),
          (${baseId + 303}, 3, ${products[2]}, 4, 1, ${now}),
          (${baseId + 304}, 3, ${products[3]}, 2, 1, ${now}),
          (${baseId + 305}, 3, ${products[4]}, 1, 1, ${now}),
          (${baseId + 306}, 3, ${products[5]}, 1, 1, ${now})
      `;
      await tx`
        INSERT INTO store_brand (id, brand_name, pid, store_id, sort, is_show, add_time, is_del)
        VALUES (91, '审计品牌', 0, 0, 1, 1, ${now}, 0)
      `;
      await tx`
        INSERT INTO store_product_label
          (id, type, relation_id, label_cate, label_name, style_type, color, bg_color,
           border_color, icon, is_show, status, sort, add_time)
        VALUES (101, 0, 0, 0, '审计标签', 1, '#fff', '#000', '#333', '', 1, 1, 1, ${now})
      `;
      const uid = baseId + 1;
      await tx`
        INSERT INTO "user" (uid, account, nickname, add_time, last_time, status, is_del, level)
        VALUES (${uid}, 'home-audit-user', '首页审计用户', ${now}, ${now}, 1, 0, 0)
      `;
      await tx`
        INSERT INTO wechat_user
          (id, uid, openid, nickname, user_type, subscribe, is_complete, is_del, add_time)
        VALUES
          (${baseId + 401}, ${uid}, ${`wechat-${random.slice(0, 12)}`}, '公众号', 'wechat', 1, 1, 0, ${now}),
          (${baseId + 402}, ${uid}, ${`routine-${random.slice(0, 12)}`}, '小程序', 'routine', 0, 1, 0, ${now}),
          (${baseId + 403}, ${uid}, ${`deleted-${random.slice(0, 12)}`}, '已删公众号', 'wechat', 0, 1, 1, ${now})
      `;
    });
    created = true;
    const scenario = await root.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const service = new PublicCatalogService(
        createContainerFromDb(transactionDb(tx, root.$client.options)),
        auditServiceEnv(),
      );
      const uid = baseId + 1;
      const anonymous = await service.homeV2(0);
      const authenticated = await service.homeV2(uid);
      return {
        anonymous,
        authenticated,
        anonymousV1: await service.subscribe(0, { anonymousDefault: true }),
        anonymousV2: await service.subscribe(0, { anonymousDefault: false, userType: "wechat" }),
        userV1: await service.subscribe(uid, { anonymousDefault: true }),
        userV2: await service.subscribe(uid, { anonymousDefault: false, userType: "wechat" }),
      };
    });
    const summary = homeSummary(scenario.authenticated);
    const best = ((scenario.authenticated.info as Record<string, unknown>).bastList as Array<Record<string, unknown>>);
    const first = ((scenario.authenticated.info as Record<string, unknown>).firstList as Array<Record<string, unknown>>);
    const assertions = {
      exact_root_shape: JSON.stringify(summary.keys) === JSON.stringify([
        "benefit", "info", "likeInfo", "site_name", "subscribe", "tengxun_map_key",
      ]),
      exact_info_shape: JSON.stringify(summary.info_keys) === JSON.stringify(["bastList", "fastList", "firstList"]),
      child_categories_only: JSON.stringify(summary.fast_ids) === JSON.stringify([childA, childB]),
      best_products: JSON.stringify(summary.best_ids) === JSON.stringify([products[0], products[1]]),
      first_product_and_presale: JSON.stringify(summary.first_ids) === JSON.stringify([products[2]])
        && first[0]?.presale_pay_status === 1,
      benefit_products: JSON.stringify(summary.benefit_ids) === JSON.stringify([products[3]]),
      hot_products: JSON.stringify(summary.hot_ids) === JSON.stringify([products[4], products[5]]),
      product_decoration: best[0]?.brand_name === "审计品牌"
        && Array.isArray(best[0]?.store_label) && (best[0]?.store_label as unknown[]).length === 1,
      home_subscribe: scenario.anonymous.subscribe === true && scenario.authenticated.subscribe === true,
      v2_official_identity: scenario.anonymousV2 === false && scenario.userV2 === true,
      v1_client_contract: scenario.anonymousV1 === true && scenario.userV1 === false,
      config_projection: scenario.authenticated.site_name === "隔离商城"
        && scenario.authenticated.tengxun_map_key === "map-audit",
    };
    if (Object.values(assertions).some((value) => !value)) {
      throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
    }
    result = { assertions, summary };
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
        event: "api004_home_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
