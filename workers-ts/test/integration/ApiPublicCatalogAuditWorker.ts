import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import { StoreProductService } from "@/services/product/StoreProductService";
import { ReplyService } from "@/services/product/ReplyService";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

async function authorize(request: Request, verifier: string): Promise<boolean> {
  if (!verifier) return false;
  const encoder = new TextEncoder();
  const token = request.headers.get("X-Audit-Token") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function readState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api001_read_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const state = await tx<Array<{
        server_version: string;
        products: number;
        visible_products: number;
        visible_platform_products: number;
        product_type_distribution: Record<string, number>;
        legacy_feature_flags: Record<string, number>;
        product_label_relations: number;
        category_relations: number;
        brand_relations: number;
        categories: number;
        visible_root_categories: number;
        brands: number;
        visible_brands: number;
        descriptions: number;
        presale_products: number;
        active_presale_products: number;
        replies: number;
        visible_replies: number;
        reply_comments: number;
        visible_reply_comments: number;
        promotions: number;
        promotion_relations: number;
        discounts: number;
        discount_relations: number;
        coupon_templates: number;
        coupon_product_relations: number;
        diy_pages: number;
        active_navigation_pages: number;
        home_group_definitions: number;
        home_group_rows: number;
        relevant_config_rows: number;
        relevant_config_keys: number;
        relevant_duplicate_config_keys: number;
        temporary_schemas: number;
        relevant_indexes: number;
      }>>`
        WITH relevant_groups(name) AS (
          VALUES
            ('routine_home_banner'), ('routine_home_menus'), ('routine_home_roll_news'),
            ('routine_home_activity'), ('index_categy_images'), ('routine_index_page'),
            ('routine_home_bast_banner'), ('routine_home_new_banner'),
            ('routine_home_hot_banner'), ('routine_home_benefit_banner'),
            ('routine_my_menus'), ('routine_my_banner'), ('routine_spread_banner')
        ),
        relevant_configs(name) AS (
          VALUES
            ('site_name'), ('routine_index_logo'), ('site_url'), ('fast_number'),
            ('bast_number'), ('first_number'), ('promotion_number'),
            ('new_goods_bananr'), ('tengxun_map_key'), ('member_func_status'),
            ('brokerage_func_status'), ('store_brokerage_apply'), ('balance_func_status'),
            ('member_card_status'), ('division_open'), ('division_apply_open'),
            ('routine_contact_type'), ('level_activate_status')
        )
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM store_product) AS products,
          (SELECT count(*)::integer FROM store_product
            WHERE is_show = 1 AND is_del = 0 AND is_verify = 1) AS visible_products,
          (SELECT count(*)::integer FROM store_product
            WHERE is_show = 1 AND is_del = 0 AND is_verify = 1 AND pid = 0) AS visible_platform_products,
          (SELECT COALESCE(jsonb_object_agg(product_type::text, total), '{}'::jsonb)
            FROM (SELECT product_type, count(*)::integer AS total FROM store_product
              WHERE is_show = 1 AND is_del = 0 AND is_verify = 1
              GROUP BY product_type ORDER BY product_type) d) AS product_type_distribution,
          (SELECT jsonb_build_object(
            'hot', count(*) FILTER (WHERE is_hot = 1),
            'benefit', count(*) FILTER (WHERE is_benefit = 1),
            'best', count(*) FILTER (WHERE is_best = 1),
            'new', count(*) FILTER (WHERE is_new = 1),
            'good', count(*) FILTER (WHERE is_good = 1)
          ) FROM store_product WHERE is_show = 1 AND is_del = 0 AND is_verify = 1) AS legacy_feature_flags,
          (SELECT count(*)::integer FROM store_product_relation WHERE type = 3) AS product_label_relations,
          (SELECT count(*)::integer FROM store_product_relation WHERE type = 1) AS category_relations,
          (SELECT count(*)::integer FROM store_product_relation WHERE type = 2) AS brand_relations,
          (SELECT count(*)::integer FROM store_product_category) AS categories,
          (SELECT count(*)::integer FROM store_product_category
            WHERE type = 0 AND relation_id = 0 AND level = 0 AND is_show = 1) AS visible_root_categories,
          (SELECT count(*)::integer FROM store_brand) AS brands,
          (SELECT count(*)::integer FROM store_brand WHERE is_show = 1 AND is_del = 0) AS visible_brands,
          (SELECT count(*)::integer FROM store_product_description) AS descriptions,
          (SELECT count(*)::integer FROM store_product WHERE is_presale_product = 1) AS presale_products,
          (SELECT count(*)::integer FROM store_product
            WHERE is_presale_product = 1 AND is_show = 1 AND is_del = 0 AND is_verify = 1) AS active_presale_products,
          (SELECT count(*)::integer FROM store_product_reply) AS replies,
          (SELECT count(*)::integer FROM store_product_reply WHERE status = 1 AND is_del = 0) AS visible_replies,
          (SELECT count(*)::integer FROM store_product_reply_comment) AS reply_comments,
          (SELECT count(*)::integer FROM store_product_reply_comment WHERE is_del = 0) AS visible_reply_comments,
          (SELECT count(*)::integer FROM store_promotions) AS promotions,
          (SELECT count(*)::integer FROM store_promotions_auxiliary) AS promotion_relations,
          (SELECT count(*)::integer FROM store_discounts) AS discounts,
          (SELECT count(*)::integer FROM store_discounts_products) AS discount_relations,
          (SELECT count(*)::integer FROM store_coupon_issue) AS coupon_templates,
          (SELECT count(*)::integer FROM store_coupon_product) AS coupon_product_relations,
          (SELECT count(*)::integer FROM system_dise WHERE is_del = 0) AS diy_pages,
          (SELECT count(*)::integer FROM system_dise
            WHERE is_del = 0 AND ((status = 1 AND type = 1) OR template_name = 'default')) AS active_navigation_pages,
          (SELECT count(*)::integer FROM system_group g
            JOIN relevant_groups r ON r.name = g.config_name) AS home_group_definitions,
          (SELECT count(*)::integer FROM system_group_data d
            JOIN system_group g ON g.id = d.gid
            JOIN relevant_groups r ON r.name = g.config_name
            WHERE d.status = 1) AS home_group_rows,
          (SELECT count(*)::integer FROM system_config c
            JOIN relevant_configs r ON r.name = c.menu_name WHERE c.is_store = 0) AS relevant_config_rows,
          (SELECT count(DISTINCT c.menu_name)::integer FROM system_config c
            JOIN relevant_configs r ON r.name = c.menu_name WHERE c.is_store = 0) AS relevant_config_keys,
          (SELECT count(*)::integer FROM (
            SELECT c.menu_name FROM system_config c
            JOIN relevant_configs r ON r.name = c.menu_name
            WHERE c.is_store = 0 GROUP BY c.menu_name HAVING count(*) > 1
          ) duplicates) AS relevant_duplicate_config_keys,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api001_%') AS temporary_schemas,
          (SELECT count(*)::integer FROM pg_indexes
            WHERE schemaname = 'public' AND tablename IN (
              'store_product', 'store_product_relation', 'store_product_category', 'store_brand',
              'store_product_description', 'store_product_reply', 'store_product_reply_comment',
              'system_group', 'system_group_data', 'system_dise'
            )) AS relevant_indexes
      `;
      const samples = await tx<Array<{
        id: number;
        type: number;
        product_type: number;
        is_hot: number;
        is_best: number;
        is_new: number;
        is_good: number;
        is_presale_product: number;
        brand_id: number;
        cate_id: string;
      }>>`
        SELECT id, type, product_type, is_hot, is_best, is_new, is_good,
          is_presale_product, brand_id, cate_id
        FROM store_product
        WHERE is_show = 1 AND is_del = 0 AND is_verify = 1
        ORDER BY sort DESC, id DESC
        LIMIT 10
      `;
      const plans = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id, store_name, price, sales, ficti
        FROM store_product
        WHERE is_show = 1 AND is_del = 0 AND is_verify = 1 AND pid = 0
        ORDER BY sales DESC, sort DESC, id DESC
        LIMIT 20
      `;
      return { state: state[0], product_samples: samples, sales_rank_plan: plans[0]?.["QUERY PLAN"] ?? null };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

function serviceEnv(connectionString: string): Env {
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

function transactionDb(tx: unknown, options: unknown): DbClient {
  const client = tx as { options?: unknown };
  // postgres.js transaction handles are callable clients but do not repeat the
  // root client's parser registry; Drizzle requires that registry at setup.
  if (!client.options) client.options = options;
  return drizzle(tx as never, { schema }) as unknown as DbClient;
}

async function readContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api001_contract_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const container = createContainerFromDb(transactionDb(tx, db.$client.options));
      const env = serviceEnv(connectionString);
      const catalog = new PublicCatalogService(container, env);
      const products = new StoreProductService(container, env);
      const replies = new ReplyService(container);
      const sample = await tx<Array<{ id: number }>>`
        SELECT id FROM store_product
        WHERE is_show = 1 AND is_del = 0 AND is_verify = 1 AND pid = 0
        ORDER BY sort DESC, id DESC LIMIT 1
      `;
      const productId = sample[0]?.id ?? 0;
      const [
        navigation, home, categories, sales, star, collect, hot, brands,
        filters, presale, goods, activity, replyConfig, replyList, replyComments,
      ] = await Promise.all([
        catalog.navigation(),
        catalog.home(0),
        catalog.rankCategory(),
        catalog.recommend(0, { rank: "sales", limit: 8 }),
        catalog.recommend(0, { rank: "star", limit: 8 }),
        catalog.recommend(0, { rank: "collect", limit: 8 }),
        catalog.recommend(0, { flag: "hot", limit: 100 }),
        catalog.brand({}),
        catalog.searchFilter({}),
        catalog.presale(0, 0, 1, 10),
        products.getGoodsList({ page: 1, limit: 10 }, 0),
        productId ? catalog.productActivity(productId) : Promise.resolve(null),
        productId ? replies.replyConfig(productId) : Promise.resolve(null),
        productId ? replies.replyList(productId, 1, 10, 0, 0) : Promise.resolve([]),
        productId ? replies.commentList(productId, 1, 10, 0) : Promise.resolve([]),
      ]);
      const homeInfo = home.info as Record<string, unknown>;
      return {
        transaction: "READ ONLY",
        product_id: productId,
        navigation_keys: Object.keys(navigation),
        home_keys: Object.keys(home),
        home_counts: {
          banner: (home.banner as unknown[]).length,
          menus: (home.menus as unknown[]).length,
          categories: (homeInfo.fastList as unknown[]).length,
          best: (homeInfo.bastList as unknown[]).length,
          new: (homeInfo.firstList as unknown[]).length,
          benefit: (home.benefit as unknown[]).length,
          hot: (home.likeInfo as unknown[]).length,
        },
        rank_category_count: categories.length,
        sales_ids: sales.map((item) => (item as Record<string, unknown>).id),
        star_ids: star.map((item) => (item as Record<string, unknown>).id),
        collect_ids: collect.map((item) => (item as Record<string, unknown>).id),
        hot_count: hot.length,
        brand_count: brands.length,
        search_filter_counts: {
          promotions: (filters.promotions as unknown[]).length,
          brand: (filters.brand as unknown[]).length,
          store_label: (filters.store_label as unknown[]).length,
        },
        presale_count: presale.count,
        products_count: goods.count,
        products_page_ids: goods.list.map((item) => item.id),
        activity_counts: activity && {
          coupons: (activity.coupons as unknown[]).length,
          discounts: (activity.discounts_products as unknown[]).length,
          promotions: (activity.promotions as unknown[]).length,
        },
        reply_config: replyConfig,
        reply_list_count: replyList.length,
        reply_comment_count: replyComments.length,
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

const ISOLATED_TABLES = [
  "store_product", "store_product_relation", "store_product_category", "store_brand",
  "store_product_label", "store_product_description", "store_product_reply",
  "store_product_reply_comment", "user_relation", "user", "system_group",
  "system_group_data", "system_dise", "store_coupon_issue", "store_coupon_product",
  "store_discounts", "store_discounts_products", "store_promotions",
  "store_promotions_auxiliary",
] as const;

async function isolatedScenario(connectionString: string) {
  const suffix = `${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const schemaName = `codex_api001_${suffix}`;
  if (!/^codex_api001_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api001_isolated_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      for (const table of ISOLATED_TABLES) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`
        INSERT INTO store_product_category
          (id, pid, type, relation_id, cate_name, path, level, pic, big_pic, sort, is_show)
        VALUES (11, 0, 0, 0, '审计分类', '', 0, '/category.png', '/category-big.png', 9, 1)
      `;
      await tx`
        INSERT INTO store_brand (id, brand_name, sort, is_show, is_del)
        VALUES (7, '审计品牌', 9, 1, 0)
      `;
      await tx`
        INSERT INTO store_product_label
          (id, type, relation_id, label_cate, label_name, style_type, color, bg_color, border_color, icon, is_show, status, sort)
        VALUES (21, 0, 0, 0, '审计标签', 1, '#111', '#eee', '#ccc', '', 1, 1, 9)
      `;
      await tx`
        INSERT INTO store_product
          (id, pid, type, product_type, image, store_name, store_info, cate_id, price,
           ot_price, vip_price, stock, sales, ficti, star, collect, sort, is_show,
           is_verify, is_del, is_vip_product, is_presale_product, presale_start_time,
           presale_end_time, store_label_id, brand_id, recommend_list)
        VALUES
          (101, 0, 0, 0, '/p101.png', '审计热销商品', 'API-001', '11', 19.90,
           29.90, 17.90, 20, 30, 5, 4.8, 12, 10, 1, 1, 0, 0, 0, 0, 0, '21', 7, '102'),
          (102, 0, 0, 0, '/p102.png', '审计预售商品', 'API-001', '11', 39.90,
           49.90, 0, 10, 8, 2, 4.2, 2, 8, 1, 1, 0, 0, 1,
           extract(epoch FROM now())::integer - 60, extract(epoch FROM now())::integer + 3600,
           '', 7, '')
      `;
      await tx`
        INSERT INTO store_product_relation (id, type, product_id, relation_id, relation_pid, status)
        VALUES
          (1, 1, 101, 11, 0, 1), (2, 1, 102, 11, 0, 1),
          (3, 2, 101, 7, 0, 1), (4, 2, 102, 7, 0, 1),
          (5, 3, 101, 1, 0, 1), (6, 3, 101, 3, 0, 1), (7, 3, 101, 5, 0, 1)
      `;
      await tx`INSERT INTO store_product_description (product_id, description, type) VALUES (101, '<p>审计详情</p>', 0)`;
      await tx`
        INSERT INTO system_group (id, name, info, config_name)
        VALUES (31, '首页横幅', 'audit', 'routine_home_banner')
      `;
      await tx`
        INSERT INTO system_group_data (id, gid, value, sort, status)
        VALUES (32, 31, ${JSON.stringify({ name: { type: "input", value: "审计横幅" }, pic: { type: "upload", value: "/banner.png" } })}, 10, 1)
      `;
      await tx`
        INSERT INTO system_dise (id, name, title, value, type, status, is_del, template_name)
        VALUES (41, '审计导航', 'audit', ${JSON.stringify([{ name: "pageFoot", list: [{ name: "首页", url: "/pages/index" }] }])}, 1, 1, 0, 'default')
      `;
      await tx`
        INSERT INTO store_product_reply
          (id, product_id, uid, nickname, comment, sku, reply_score, product_score,
           service_score, logistics_score, delivery_score, pics, status, is_del, add_time)
        VALUES
          (51, 101, 1, '审计甲', '很好', '默认', 3, 5, 5, 5, 5, '["/reply.png"]', 1, 0, 100),
          (52, 101, 2, '审计乙', '一般', '默认', 2, 4, 4, 4, 4, '[]', 1, 0, 90),
          (53, 101, 3, '审计丙', '较差', '默认', 1, 2, 4, 4, 4, '[]', 1, 0, 80)
      `;
      await tx`
        INSERT INTO store_product_reply_comment
          (id, reply_id, pid, uid, nickname, content, praise, is_del, add_time, update_time)
        VALUES (61, 51, 0, 2, '审计乙', '追评', 2, 0, 110, 110)
      `;

      const scopedDb = transactionDb(tx, db.$client.options);
      const container = createContainerFromDb(scopedDb);
      const env = serviceEnv(connectionString);
      const catalog = new PublicCatalogService(container, env);
      const replies = new ReplyService(container);
      const [groups, navigation, hot, best, good, brands, filters, description, presale, stats, middle, poor, comments] = await Promise.all([
        catalog.groupDataMany(["routine_home_banner"]),
        catalog.navigation(),
        catalog.recommend(0, { flag: "hot", limit: 10 }),
        catalog.recommend(0, { flag: "best", limit: 10 }),
        catalog.recommend(0, { flag: "good", limit: 10 }),
        catalog.brand({ selectId: 11 }),
        catalog.searchFilter({ selectId: 11 }),
        catalog.detailContent(101),
        catalog.presale(0, 2, 1, 10),
        replies.replyConfig(101),
        replies.replyList(101, 1, 10, 0, 2),
        replies.replyList(101, 1, 10, 0, 3),
        replies.commentList(51, 1, 10, 0),
      ]);
      const assertions = {
        group_value: groups.routine_home_banner[0]?.name === "审计横幅",
        navigation: navigation.name === "pageFoot",
        hot: hot.map((item) => (item as Record<string, unknown>).id).join(",") === "101",
        best: best.map((item) => (item as Record<string, unknown>).id).join(",") === "101",
        good: good.map((item) => (item as Record<string, unknown>).id).join(",") === "101",
        brand: brands.length === 1 && brands[0]?.brand_name === "审计品牌",
        labels: (filters.store_label as unknown[]).length === 1,
        description: description.description === "<p>审计详情</p>",
        presale: presale.count === 1
          && (presale.list[0] as Record<string, unknown> | undefined)?.id === 102,
        reply_stats: stats.sum_count === 3 && stats.good_count === 1
          && stats.in_count === 1 && stats.poor_count === 1,
        reply_filters: middle.length === 1 && middle[0]?.id === 52
          && poor.length === 1 && poor[0]?.id === 53,
        reply_comments: comments.length === 1 && comments[0]?.id === 61,
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
      await tx.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      return { schema: schemaName, assertions, cleanup: "dropped" };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    console.log(JSON.stringify({ event: "api001_audit_request", method: request.method, path }));
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "POST" || !["/state", "/contracts", "/isolated"].includes(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const result = path === "/state"
        ? await readState(env.HYPERDRIVE.connectionString)
        : path === "/contracts"
          ? await readContracts(env.HYPERDRIVE.connectionString)
          : await isolatedScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result);
    } catch (error) {
      console.error(JSON.stringify({
        event: "api001_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
