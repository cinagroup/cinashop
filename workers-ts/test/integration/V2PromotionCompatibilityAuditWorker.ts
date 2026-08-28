import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import { V2PromotionCompatibilityService } from "@/services/activity/V2PromotionCompatibilityService";
import type { Env } from "@/env";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_api004_promo_";

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
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(update_time), 0))
         FROM public.store_promotions) AS promotions,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(promotions_id), 0))
         FROM public.store_promotions_auxiliary) AS auxiliary,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0))
         FROM public.store_product) AS products,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(product_id), 0))
         FROM public.store_product_relation) AS product_relations,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0))
         FROM public.store_coupon_issue) AS coupons,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(product_id), 0))
         FROM public.store_product_attr_value) AS skus,
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
    connection: { application_name: "cinashop_api004_promo_state" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM store_promotions) AS promotion_rows,
          (SELECT count(*)::integer FROM store_promotions WHERE pid = 0) AS parent_rows,
          (SELECT count(*)::integer FROM store_promotions WHERE pid <> 0) AS child_rows,
          (SELECT count(*)::integer FROM store_promotions
             WHERE pid = 0 AND type = 1 AND store_id = 0 AND status = 1 AND is_del = 0
               AND start_time <= extract(epoch FROM now())::integer
               AND stop_time >= extract(epoch FROM now())::integer) AS active_platform_parents,
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(promotions_type, rows) ORDER BY promotions_type), '[]'::jsonb)
             FROM (SELECT promotions_type, count(*)::integer AS rows FROM store_promotions
                    WHERE pid = 0 GROUP BY promotions_type) grouped) AS parent_types,
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(product_partake_type, rows) ORDER BY product_partake_type), '[]'::jsonb)
             FROM (SELECT product_partake_type, count(*)::integer AS rows FROM store_promotions
                    WHERE pid = 0 GROUP BY product_partake_type) grouped) AS scope_types,
          (SELECT count(*)::integer FROM store_promotions child WHERE child.pid <> 0
             AND NOT EXISTS (SELECT 1 FROM store_promotions parent WHERE parent.id = child.pid)) AS orphan_children,
          (SELECT count(*)::integer FROM store_promotions_auxiliary) AS auxiliary_rows,
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(type, rows) ORDER BY type), '[]'::jsonb)
             FROM (SELECT type, count(*)::integer AS rows FROM store_promotions_auxiliary GROUP BY type) grouped) AS auxiliary_types,
          (SELECT count(*)::integer FROM store_promotions_auxiliary auxiliary
             WHERE NOT EXISTS (SELECT 1 FROM store_promotions promotion WHERE promotion.id = auxiliary.promotions_id)) AS orphan_auxiliary,
          (SELECT count(*)::integer FROM store_promotions_auxiliary auxiliary WHERE auxiliary.type IN (1, 3)
             AND auxiliary.product_id > 0
             AND NOT EXISTS (SELECT 1 FROM store_product product WHERE product.id = auxiliary.product_id)) AS orphan_auxiliary_products,
          (SELECT count(*)::integer FROM store_promotions_auxiliary auxiliary WHERE auxiliary.type = 2
             AND auxiliary.coupon_id > 0
             AND NOT EXISTS (SELECT 1 FROM store_coupon_issue coupon WHERE coupon.id = auxiliary.coupon_id)) AS orphan_auxiliary_coupons,
          (SELECT count(*)::integer FROM store_promotions_auxiliary auxiliary WHERE auxiliary.type = 3
             AND NULLIF(auxiliary.unique, '') IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM store_product_attr_value sku
                              WHERE sku.unique = auxiliary.unique AND sku.type = 0)) AS orphan_auxiliary_skus,
          (SELECT count(*)::integer FROM store_product WHERE pid = 0 AND is_show = 1 AND is_del = 0 AND is_verify = 1) AS visible_product_rows,
          (SELECT count(*)::integer FROM store_product_relation WHERE type IN (2, 3)) AS brand_label_relation_rows,
          pg_total_relation_size('store_promotions'::regclass)::bigint AS promotion_total_bytes,
          pg_total_relation_size('store_promotions_auxiliary'::regclass)::bigint AS auxiliary_total_bytes,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}) AS temporary_schemas
      `;
      const activeTypes = await tx<Array<Record<string, unknown>>>`
        SELECT promotions_type, count(*)::integer AS rows
        FROM store_promotions
        WHERE pid = 0 AND type = 1 AND store_id = 0 AND status = 1 AND is_del = 0
          AND start_time <= extract(epoch FROM now())::integer
          AND stop_time >= extract(epoch FROM now())::integer
        GROUP BY promotions_type ORDER BY promotions_type
      `;
      const promotionPlan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM store_promotions
        WHERE pid = 0 AND status = 1 AND is_del = 0
          AND start_time <= extract(epoch FROM now())::integer
          AND stop_time >= extract(epoch FROM now())::integer
        ORDER BY promotions_type, update_time DESC, id DESC LIMIT 201
      `;
      const scopePlan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT product_id FROM store_promotions_auxiliary
        WHERE promotions_id = 1 AND type = 1 ORDER BY id
      `;
      return {
        transaction: "READ ONLY",
        state: rows[0],
        active_types: activeTypes,
        plans: {
          active_promotions: promotionPlan[0]?.["QUERY PLAN"] ?? null,
          promotion_scope: scopePlan[0]?.["QUERY PLAN"] ?? null,
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

function listSummary(value: unknown) {
  const list = (value as { list?: Array<Record<string, unknown>> } | null)?.list ?? [];
  return {
    length: list.length,
    ids: list.map((row) => Number(row.id)),
    first_keys: list[0] ? Object.keys(list[0]).sort() : [],
  };
}

async function productionContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_promo_contracts",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const container = createContainerFromDb(transactionDb(tx, db.$client.options));
      const service = new V2PromotionCompatibilityService(container, {} as Env);
      const catalog: Record<string, unknown> = {};
      for (let type = 1; type <= 6; type += 1) {
        catalog[String(type)] = listSummary(await service.productList(type, { page: 1, limit: 10 }));
      }
      const candidates = await tx<Array<{ id: number; promotions_type: number }>>`
        SELECT id, promotions_type FROM store_promotions
        WHERE pid = 0 AND type = 1 AND store_id = 0 AND status = 1 AND is_del = 0
          AND start_time <= extract(epoch FROM now())::integer
          AND stop_time >= extract(epoch FROM now())::integer
        ORDER BY promotions_type, id LIMIT 1
      `;
      const gift = await tx<Array<{ id: number }>>`
        SELECT id FROM store_promotions
        WHERE pid = 0 AND type = 1 AND store_id = 0 AND status = 1 AND is_del = 0
          AND promotions_type = 4
          AND start_time <= extract(epoch FROM now())::integer
          AND stop_time >= extract(epoch FROM now())::integer
        ORDER BY id LIMIT 1
      `;
      const users = await tx<Array<{ uid: number }>>`
        SELECT uid FROM "user" WHERE status = 1 AND is_del = 0 AND delete_time IS NULL ORDER BY uid LIMIT 1
      `;
      const give = gift[0] ? await service.giveInfo(gift[0].id) : {};
      const collect = candidates[0] && users[0]
        ? await service.collectOrderProduct(users[0].uid, candidates[0].id, { page: 1, limit: 10 })
        : null;
      return {
        transaction: "READ ONLY",
        observed: {
          active_candidate: candidates[0] ?? null,
          active_gift_id: gift[0]?.id ?? null,
          has_active_user: Boolean(users[0]),
        },
        contracts: {
          product_catalogs: catalog,
          gift: give && typeof give === "object" ? Object.keys(give).sort() : [],
          collect: collect ? {
            product_list: listSummary(collect),
            promotion_keys: Object.keys(collect.promotions).sort(),
          } : null,
          invalid_product_type: await service.productList(99, { page: 1, limit: 10 }),
          invalid_gift: await service.giveInfo(0),
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
  if (!/^codex_api004_promo_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const baseId = 1_870_000_000 + (Number.parseInt(random.slice(0, 6), 16) % 100_000);
  const now = Math.floor(Date.now() / 1_000);
  const products = Array.from({ length: 6 }, (_, index) => baseId + 101 + index);
  const parents = Array.from({ length: 7 }, (_, index) => baseId + 201 + index);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_promo_isolated_root",
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
        "store_promotions",
        "store_promotions_auxiliary",
        "store_product",
        "store_product_relation",
        "store_coupon_issue",
        "store_product_attr_value",
        "user",
      ]) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      for (let index = 0; index < products.length; index += 1) {
        await tx`
          INSERT INTO store_product
            (id, pid, image, store_name, price, stock, sort, is_show, is_del, is_verify, is_vip_product, add_time)
          VALUES
            (${products[index]}, 0, ${`/product-${index + 1}.jpg`}, ${`审计商品${index + 1}`},
             '100.00', 100, ${100 - index}, 1, 0, 1, 0, ${now})
        `;
      }
      await tx`
        INSERT INTO "user" (uid, account, nickname, add_time, last_time, status, is_del, level)
        VALUES (${baseId + 1}, 'promo-audit-user', '促销审计用户', ${now}, ${now}, 1, 0, 0)
      `;
      for (let index = 0; index < parents.length; index += 1) {
        const active = index < 6;
        const scope = index === 0 ? 1 : index === 1 ? 2 : index === 2 ? 3 : index === 3 ? 4 : index === 4 ? 5 : 2;
        await tx`
          INSERT INTO store_promotions
            (id, pid, type, store_id, promotions_type, promotions_cate, name, title, image,
             threshold_type, threshold, discount_type, discount, give_integral,
             product_partake_type, start_time, stop_time, status, is_del, update_time, add_time)
          VALUES
            (${parents[index]}, 0, 1, 0, ${index < 6 ? index + 1 : 6}, 1,
             ${`审计活动${index + 1}`}, ${`活动${index + 1}`}, ${`/promotion-${index + 1}.jpg`},
             1, '100.00', 1, ${index === 0 ? "85.00" : "0.00"}, ${index === 3 ? 20 : 0},
             ${scope}, ${now - 60}, ${active ? now + 3_600 : now - 1}, 1, 0, ${now + index}, ${now})
        `;
      }
      const child = baseId + 220;
      await tx`
        INSERT INTO store_promotions
          (id, pid, type, store_id, promotions_type, promotions_cate, name, title,
           threshold_type, threshold, give_integral, product_partake_type,
           start_time, stop_time, status, is_del, update_time, add_time)
        VALUES
          (${child}, ${parents[3]}, 1, 0, 4, 2, '审计阶梯', '阶梯', 1, '200.00', 30, 4,
           ${now - 60}, ${now + 3_600}, 1, 0, ${now}, ${now})
      `;
      await tx`
        INSERT INTO store_product_relation (id, type, product_id, relation_id, relation_pid, status, add_time)
        VALUES
          (${baseId + 301}, 2, ${products[3]}, 71, 0, 1, ${now}),
          (${baseId + 302}, 3, ${products[4]}, 81, 0, 1, ${now})
      `;
      await tx`
        INSERT INTO store_promotions_auxiliary
          (id, type, promotions_id, product_partake_type, product_id, coupon_id, brand_id,
           store_label_id, limit_num, surplus_num, is_all, "unique")
        VALUES
          (${baseId + 401}, 1, ${parents[1]}, 2, ${products[1]}, 0, 0, 0, 0, 0, 1, ''),
          (${baseId + 402}, 1, ${parents[2]}, 3, ${products[2]}, 0, 0, 0, 0, 0, 1, ''),
          (${baseId + 403}, 1, ${parents[3]}, 4, 0, 0, 71, 0, 0, 0, 1, ''),
          (${baseId + 404}, 1, ${parents[4]}, 5, 0, 0, 0, 81, 0, 0, 1, ''),
          (${baseId + 405}, 1, ${parents[5]}, 2, ${products[5]}, 0, 0, 0, 0, 0, 1, ''),
          (${baseId + 406}, 1, ${parents[6]}, 2, ${products[0]}, 0, 0, 0, 0, 0, 1, ''),
          (${baseId + 407}, 2, ${parents[3]}, 4, 0, ${baseId + 501}, 0, 0, 1, 9, 1, ''),
          (${baseId + 408}, 3, ${child}, 4, ${products[1]}, 0, 0, 0, 1, 4, 1, 'sku00001')
      `;
      await tx`
        INSERT INTO store_coupon_issue
          (id, coupon_title, type, coupon_price, use_min_price, total_count, remain_count,
           receive_limit, receive_type, status, is_del, title, add_time)
        VALUES
          (${baseId + 501}, '审计赠券', 1, '10.00', '50.00', 100, 50, 1, 3, 1, 0, '赠券', ${now})
      `;
      await tx`
        INSERT INTO store_product_attr_value
          (id, product_id, suk, stock, sum_stock, price, image, "unique", type)
        VALUES
          (${baseId + 601}, ${products[1]}, '默认', 10, 10, '100.00', '/sku.jpg', 'sku00001', 0)
      `;
    });
    created = true;
    const scenario = await root.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const container = createContainerFromDb(transactionDb(tx, root.$client.options));
      const service = new V2PromotionCompatibilityService(container, {} as Env);
      const catalogs: Array<{ list: Array<Record<string, unknown>> }> = [];
      for (let type = 1; type <= 6; type += 1) {
        catalogs.push(await service.productList(type, { page: 1, limit: 20 }));
      }
      const collects = [];
      for (let index = 1; index <= 4; index += 1) {
        collects.push(await service.collectOrderProduct(
          baseId + 1,
          parents[index],
          { page: 1, limit: 20 },
        ));
      }
      const give = await service.giveInfo(parents[3]) as {
        giveIntegral: Array<Record<string, unknown>>;
        giveCoupon: Array<Record<string, unknown>>;
        giveProducts: Array<Record<string, unknown>>;
      };
      const inactiveGift = await service.giveInfo(parents[6]);
      let inactiveRejected = false;
      try {
        await service.collectOrderProduct(baseId + 1, parents[6], { page: 1, limit: 20 });
      } catch (error) {
        inactiveRejected = error instanceof Error && error.message === "活动已失效，请刷新页面";
      }
      return { catalogs, collects, give, inactiveGift, inactiveRejected };
    });
    const ids = (value: { list: Array<Record<string, unknown>> }) => value.list.map((row) => Number(row.id));
    const first = scenario.catalogs[0]?.list[0];
    const assertions = {
      all_scope_and_discount: scenario.catalogs[0]?.list.length === 6 && Number(first?.price) === 85,
      selected_scope: JSON.stringify(ids(scenario.catalogs[1])) === JSON.stringify([products[1]]),
      excluded_scope: scenario.catalogs[2]?.list.length === 5 && !ids(scenario.catalogs[2]).includes(products[2]),
      brand_scope: JSON.stringify(ids(scenario.catalogs[3])) === JSON.stringify([products[3]]),
      label_scope_and_frame: JSON.stringify(ids(scenario.catalogs[4])) === JSON.stringify([products[4]])
        && typeof scenario.catalogs[4]?.list[0]?.activity_frame === "object",
      background_scope: JSON.stringify(ids(scenario.catalogs[5])) === JSON.stringify([products[5]])
        && typeof scenario.catalogs[5]?.list[0]?.activity_background === "object",
      authenticated_collect_scopes: scenario.collects[0]?.list.length === 1
        && scenario.collects[1]?.list.length === 5
        && scenario.collects[2]?.list.length === 1
        && scenario.collects[3]?.list.length === 1,
      hierarchy_projection: Array.isArray((scenario.collects[2]?.promotions as Record<string, unknown>).promotions)
        && ((scenario.collects[2]?.promotions as Record<string, unknown>).promotions as unknown[]).length === 1,
      gift_integral: scenario.give.giveIntegral.length === 2,
      gift_coupon: scenario.give.giveCoupon.length === 1
        && scenario.give.giveCoupon[0]?.coupon_title === "审计赠券",
      gift_product_sku: scenario.give.giveProducts.length === 1
        && scenario.give.giveProducts[0]?.unique === "sku00001"
        && scenario.give.giveProducts[0]?.store_name === "审计商品2",
      inactive_fail_closed: Object.keys(scenario.inactiveGift).length === 0 && scenario.inactiveRejected,
    };
    if (Object.values(assertions).some((value) => !value)) {
      throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
    }
    result = {
      assertions,
      counts: {
        catalog_lengths: scenario.catalogs.map((item) => item.list.length),
        gift_integral: scenario.give.giveIntegral.length,
        gift_coupon: scenario.give.giveCoupon.length,
        gift_products: scenario.give.giveProducts.length,
      },
    };
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
        event: "api004_promo_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
