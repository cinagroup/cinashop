import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import { V2CouponCompatibilityService } from "@/services/activity/V2CouponCompatibilityService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const AUDIT_SCHEMA_PREFIX = "codex_api004_coupon_";

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

function listSummary(value: unknown) {
  const list = (value as { list?: unknown[] } | null)?.list ?? [];
  return {
    length: list.length,
    first_keys: list[0] && typeof list[0] === "object"
      ? Object.keys(list[0] as Record<string, unknown>).sort()
      : [],
  };
}

async function productionSnapshot(client: postgres.Sql) {
  const rows = await client<Array<Record<string, unknown>>>`
    SELECT
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.store_coupon_issue) AS issue,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(receive_time), 0)) FROM public.store_coupon_user) AS coupon_user,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(issue_coupon_id), 0), COALESCE(sum(add_time), 0)) FROM public.store_coupon_issue_user) AS issue_user,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(coupon_id), 0), COALESCE(sum(product_id), 0)) FROM public.store_coupon_product) AS coupon_product,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(uid), 0), COALESCE(max(add_time), 0)) FROM public."user") AS users,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.store_product) AS products,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.store_product_category) AS categories,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0), COALESCE(max(add_time), 0)) FROM public.store_brand) AS brands,
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
    connection: { application_name: "cinashop_api004_coupon_state" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM store_coupon_issue) AS issue_rows,
          (SELECT count(*)::integer FROM store_coupon_user) AS user_coupon_rows,
          (SELECT count(*)::integer FROM store_coupon_issue_user) AS issue_user_rows,
          (SELECT count(*)::integer FROM store_coupon_product) AS coupon_product_rows,
          (SELECT count(*)::integer FROM store_coupon_issue WHERE status = 1 AND is_del = 0) AS enabled_rows,
          (SELECT count(*)::integer FROM store_coupon_issue WHERE receive_type = 1) AS manual_rows,
          (SELECT count(*)::integer FROM store_coupon_issue WHERE receive_type = 2) AS newcomer_rows,
          (SELECT count(*)::integer FROM store_coupon_issue WHERE receive_type = 4) AS popup_svip_rows,
          (SELECT COALESCE(jsonb_agg(jsonb_build_array(coupon_type, rows) ORDER BY coupon_type), '[]'::jsonb)
             FROM (SELECT coupon_type, count(*)::integer AS rows FROM store_coupon_issue GROUP BY coupon_type) scoped) AS scope_rows,
          (SELECT count(*)::integer FROM store_coupon_issue
             WHERE status = 1 AND is_del = 0
               AND (remain_count > 0 OR is_permanent = 1)
               AND ((start_time <= now() AND end_time >= now()) OR (start_time IS NULL AND end_time IS NULL))
               AND ((day = 0 AND use_end_time >= now()) OR day > 0)) AS currently_valid_rows,
          (SELECT count(*)::integer FROM store_coupon_issue
             WHERE (start_time IS NULL) <> (end_time IS NULL)) AS half_open_claim_windows,
          (SELECT count(*)::integer FROM store_coupon_issue
             WHERE day = 0 AND use_end_time IS NULL) AS fixed_use_without_end,
          (SELECT count(*)::integer FROM store_coupon_user u
             WHERE NOT EXISTS (SELECT 1 FROM store_coupon_issue i WHERE i.id = u.issue_coupon_id)) AS orphan_user_coupons,
          (SELECT count(*)::integer FROM store_coupon_issue_user u
             WHERE NOT EXISTS (SELECT 1 FROM store_coupon_issue i WHERE i.id = u.issue_coupon_id)) AS orphan_claim_evidence,
          (SELECT count(*)::integer FROM store_coupon_product r
             WHERE NOT EXISTS (SELECT 1 FROM store_coupon_issue i WHERE i.id = r.coupon_id)
                OR NOT EXISTS (SELECT 1 FROM store_product p WHERE p.id = r.product_id)) AS orphan_product_scope,
          (SELECT count(*)::integer FROM store_coupon_issue
             WHERE coupon_type = 2 AND COALESCE(NULLIF(legacy_product_ids, ''), '0') <> '0') AS product_scope_with_legacy_ids,
          (SELECT count(*)::integer FROM store_coupon_issue
             WHERE coupon_type = 2 AND COALESCE(NULLIF(product_id, ''), '0') <> '0') AS product_scope_with_current_mirror,
          pg_total_relation_size('store_coupon_issue'::regclass)::bigint AS issue_total_bytes,
          pg_total_relation_size('store_coupon_user'::regclass)::bigint AS user_coupon_total_bytes,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${AUDIT_SCHEMA_PREFIX}%`}) AS temporary_schemas,
          (SELECT COALESCE(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
             FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'store_coupon_issue') AS issue_indexes,
          (SELECT COALESCE(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
             FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'store_coupon_user') AS user_coupon_indexes
      `;
      const config = await tx<Array<Record<string, unknown>>>`
        SELECT menu_name, jsonb_agg(value ORDER BY sort DESC, id DESC) AS values, count(*)::integer AS rows
        FROM system_config WHERE is_store = 0 AND menu_name = 'member_card_status'
        GROUP BY menu_name
      `;
      const plan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM store_coupon_issue
        WHERE status = 1 AND is_del = 0 AND receive_type = 1
          AND (remain_count > 0 OR is_permanent = 1)
          AND ((start_time <= now() AND end_time >= now()) OR (start_time IS NULL AND end_time IS NULL))
          AND ((day = 0 AND use_end_time >= now()) OR day > 0)
        ORDER BY sort DESC, id DESC LIMIT 10
      `;
      return {
        transaction: "READ ONLY",
        state: rows[0],
        member_card_status: config,
        list_plan: plan[0]?.["QUERY PLAN"] ?? null,
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function productionContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_coupon_contracts",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const users = await tx<Array<{ uid: number }>>`
        SELECT uid FROM "user" WHERE status = 1 AND is_del = 0 ORDER BY uid LIMIT 1
      `;
      const products = await tx<Array<{ id: number }>>`
        SELECT id FROM store_product WHERE is_show = 1 AND is_del = 0 AND is_verify = 1 ORDER BY id LIMIT 1
      `;
      const service = new V2CouponCompatibilityService(
        createContainerFromDb(transactionDb(tx, db.$client.options)),
      );
      const [anonymous, scoped, todayAnonymous, todayUser, newcomer] = await Promise.all([
        service.available(0, { page: 1, limit: 10 }),
        products[0]
          ? service.available(users[0]?.uid ?? 0, { page: 1, limit: 10, product_id: products[0].id })
          : Promise.resolve({ list: [], count: [0, 0, 0, 0] }),
        service.today(0),
        users[0] ? service.today(users[0].uid) : Promise.resolve({ list: [], image: "" }),
        users[0]
          ? service.newCoupons(users[0].uid)
          : Promise.resolve({ list: [], image: "", show: 0 }),
      ]);
      const first = anonymous.list[0] as Record<string, unknown> | undefined;
      return {
        transaction: "READ ONLY",
        observed: { has_user: !!users[0], has_product: !!products[0] },
        contracts: {
          anonymous: { ...listSummary(anonymous), count: anonymous.count },
          product_scoped: { ...listSummary(scoped), count: scoped.count },
          today_anonymous: listSummary(todayAnonymous),
          today_user: listSummary(todayUser),
          newcomer: { ...listSummary(newcomer), show: newcomer.show, image: newcomer.image },
        },
        assertions: {
          anonymous_shape: Array.isArray(anonymous.list) && anonymous.count.length === 4,
          scoped_shape: Array.isArray(scoped.list) && scoped.count.length === 4,
          popup_shapes: Array.isArray(todayAnonymous.list) && Array.isArray(todayUser.list),
          newcomer_shape: Array.isArray(newcomer.list) && [0, 1].includes(newcomer.show),
          legacy_field_projection: !first || (
            "coupon_type" in first && "type" in first && "coupon_price" in first &&
            "products" in first && !("couponType" in first) && !("legacyProductIds" in first)
          ),
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
  if (!/^codex_api004_coupon_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const baseId = 1_800_000_000 + (Number.parseInt(random.slice(0, 6), 16) % 100_000);
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const dayStart = new Date(Date.UTC(
    new Date(now.getTime() + 8 * 3_600_000).getUTCFullYear(),
    new Date(now.getTime() + 8 * 3_600_000).getUTCMonth(),
    new Date(now.getTime() + 8 * 3_600_000).getUTCDate(),
  ) - 8 * 3_600_000);
  const todaySeconds = Math.floor((dayStart.getTime() + 3_600_000) / 1_000);
  const claimStart = new Date(now.getTime() - 24 * 3_600_000);
  const claimEnd = new Date(now.getTime() + 10 * 24 * 3_600_000);
  const useEnd = new Date(now.getTime() + 30 * 24 * 3_600_000);
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_coupon_isolated",
  });
  const before = await productionSnapshot(db.$client);
  let created = false;
  let auditStage = "create-fixtures";
  let scenarioError: unknown;
  let result: Record<string, unknown> = {};
  try {
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      for (const table of [
        "store_coupon_issue",
        "store_coupon_user",
        "store_coupon_product",
        "store_product",
        "store_product_category",
        "store_brand",
        "user",
        "system_config",
      ]) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);

      const normalUid = baseId + 1;
      const svipUid = baseId + 2;
      const parentCategory = baseId + 10;
      const childCategory = baseId + 11;
      const parentBrand = baseId + 20;
      const childBrand = baseId + 21;
      const productId = baseId + 30;
      await tx`
        INSERT INTO "user" (uid, account, nickname, add_time, last_time, status, is_del, is_money_level, is_ever_level, overdue_time)
        VALUES
          (${normalUid}, 'coupon-normal', 'normal', ${nowSeconds}, ${nowSeconds}, 1, 0, 0, 0, 0),
          (${svipUid}, 'coupon-svip', 'svip', ${nowSeconds - 10}, ${nowSeconds}, 1, 0, 0, 1, 0)
      `;
      await tx`
        INSERT INTO system_config (id, is_store, menu_name, value, sort, status)
        VALUES (${baseId + 3}, 0, 'member_card_status', '1', 0, 1)
      `;
      await tx`
        INSERT INTO store_product_category (id, pid, cate_name, path, level, is_show, add_time)
        VALUES
          (${parentCategory}, 0, '审计父分类', '', 0, 1, ${nowSeconds}),
          (${childCategory}, ${parentCategory}, '审计子分类', ${String(parentCategory)}, 1, 1, ${nowSeconds})
      `;
      await tx`
        INSERT INTO store_brand (id, brand_name, pid, fid, is_show, is_del, add_time)
        VALUES
          (${parentBrand}, '审计父品牌', 0, '', 1, 0, ${nowSeconds}),
          (${childBrand}, '审计子品牌', ${parentBrand}, ${String(parentBrand)}, 1, 0, ${nowSeconds})
      `;
      await tx`
        INSERT INTO store_product
          (id, image, store_name, cate_id, price, ficti, sales, stock, is_show, is_verify, is_del, brand_id, add_time)
        VALUES
          (${productId}, '/audit-product.jpg', '审计商品', ${String(childCategory)}, '100.00', 5, 7, 10, 1, 1, 0, ${childBrand}, ${nowSeconds})
      `;

      const coupons = [
        { id: baseId + 100, scope: 0, title: "通用券", product: "0", category: 0, brand: 0, receive: 1, day: 0, remain: 10, discount: 1, price: "10.00" },
        { id: baseId + 101, scope: 1, title: "分类券", product: "0", category: parentCategory, brand: 0, receive: 1, day: 0, remain: 10, discount: 1, price: "11.00" },
        { id: baseId + 102, scope: 2, title: "商品券", product: String(productId), category: 0, brand: 0, receive: 1, day: 7, remain: 10, discount: 2, price: "85.00" },
        { id: baseId + 103, scope: 3, title: "品牌券", product: "0", category: 0, brand: parentBrand, receive: 1, day: 0, remain: 10, discount: 1, price: "12.00" },
        { id: baseId + 104, scope: 0, title: "新人券", product: "0", category: 0, brand: 0, receive: 2, day: 0, remain: 10, discount: 1, price: "13.00" },
        { id: baseId + 105, scope: 0, title: "SVIP弹窗券", product: "0", category: 0, brand: 0, receive: 4, day: 0, remain: 10, discount: 1, price: "14.00" },
        { id: baseId + 106, scope: 0, title: "无库存新人券", product: "0", category: 0, brand: 0, receive: 2, day: 0, remain: 0, discount: 1, price: "15.00" },
      ];
      for (const [index, coupon] of coupons.entries()) {
        await tx`
          INSERT INTO store_coupon_issue
            (id, cid, category, coupon_type, coupon_title, type, coupon_price, use_min_price,
             product_id, category_id, brand_id, legacy_product_ids, legacy_category_id, legacy_brand_id,
             total_count, remain_count, receive_limit, receive_type, start_time, end_time, day,
             is_permanent, is_del, use_start_time, use_end_time, status, app_type, sort, add_time)
          VALUES
            (${coupon.id}, 0, 0, ${coupon.scope}, ${coupon.title}, ${coupon.discount}, ${coupon.price}, '50.00',
             ${coupon.product}, ${String(coupon.category)}, ${String(coupon.brand)}, ${coupon.product}, ${coupon.category}, ${coupon.brand},
             20, ${coupon.remain}, 1, ${coupon.receive}, ${claimStart.toISOString()}, ${claimEnd.toISOString()}, ${coupon.day},
             0, 0, ${claimStart.toISOString()}, ${useEnd.toISOString()}, 1, 0, ${100 - index}, ${todaySeconds})
        `;
      }
      await tx`
        INSERT INTO store_coupon_product (coupon_id, product_id)
        VALUES (${baseId + 102}, ${productId})
      `;
      await tx`
        INSERT INTO store_coupon_user
          (id, uid, issue_coupon_id, coupon_title, coupon_price, use_min_price, status,
           start_time, end_time, type, receive_time, receive_source, is_fail)
        VALUES
          (${baseId + 200}, ${normalUid}, ${baseId + 102}, '商品券', '85.00', '50.00', 0,
           ${claimStart.toISOString()}, ${new Date(now.getTime() + 7 * 24 * 3_600_000).toISOString()}, 2, ${nowSeconds}, 'get', 0)
      `;
    });
    created = true;

    result = await db.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const normalUid = baseId + 1;
      const svipUid = baseId + 2;
      const productId = baseId + 30;
      const service = new V2CouponCompatibilityService(
        createContainerFromDb(transactionDb(tx, db.$client.options)),
      );
      auditStage = "available-all";
      const all = await service.available(0, { page: 1, limit: 20 }, now);
      auditStage = "available-product-context";
      const scoped = await service.available(normalUid, { page: 1, limit: 20, product_id: productId }, now);
      auditStage = "available-product-only";
      const productOnly = await service.available(
        normalUid,
        { page: 1, limit: 20, product_id: productId, type: 2 },
        now,
      );
      auditStage = "available-brand-only";
      const brandOnly = await service.available(
        normalUid,
        { page: 1, limit: 20, product_id: productId, type: 3 },
        now,
      );
      auditStage = "newcomer";
      const newcomer = await service.newCoupons(normalUid, now);
      auditStage = "today-anonymous";
      const todayAnonymous = await service.today(0, now);
      auditStage = "today-normal";
      const todayNormal = await service.today(normalUid, now);
      auditStage = "today-svip";
      const todaySvip = await service.today(svipUid, now);
      const productCoupon = productOnly.list[0] as Record<string, unknown> | undefined;
      const assertions = {
        all_scopes: all.list.length === 4 && JSON.stringify(all.count) === "[1,1,1,1]",
        product_context: scoped.list.length === 4 && JSON.stringify(scoped.count) === "[1,1,1,1]",
        product_filter: productOnly.list.length === 1 && productCoupon?.type === 2 && productCoupon?.coupon_type === 2,
        product_brand_filter: brandOnly.list.length === 1 &&
          (brandOnly.list[0] as Record<string, unknown>)?.type === 3,
        source_projection: productCoupon?.product_id === String(productId) && !("couponType" in (productCoupon ?? {})),
        used_validity: productCoupon?.is_use === true && typeof productCoupon?.start_time === "string" && typeof productCoupon?.end_time === "string",
        product_sample: Array.isArray(productCoupon?.products) && (productCoupon.products as unknown[]).length === 1,
        newcomer_read_only: newcomer.list.length === 1 && newcomer.show === 1 && newcomer.image === "",
        daily_anonymous: todayAnonymous.list.length === 5,
        daily_normal_member_gate: todayNormal.list.length === 4,
        daily_svip_member_gate: todaySvip.list.length === 5,
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
      return {
        transaction: "READ ONLY",
        assertions,
        counts: {
          all: all.count,
          scoped: scoped.count,
          today_anonymous: todayAnonymous.list.length,
          today_normal: todayNormal.list.length,
          today_svip: todaySvip.list.length,
        },
      };
    });
  } catch (error) {
    scenarioError = new Error(
      `${auditStage}: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (created) {
      await db.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }
  const after = await productionSnapshot(db.$client);
  await db.$client.end({ timeout: 1 });
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
        event: "api004_coupon_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
