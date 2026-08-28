import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import { PcCompatibilityService } from "@/services/pc/PcCompatibilityService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const PREFIX = "codex_api005_pc_";
const TABLES = [
  "system_config", "system_group", "system_group_data", "store_product_category",
  "store_product_relation", "store_product", "store_brand", "store_product_label",
  "city_area", "user", "member_right", "store_product_attr_value", "store_cart",
  "user_money", "user_brokerage", "user_extract", "user_recharge", "store_order",
  "store_order_cart_info", "user_relation", "store_order_refund",
] as const;

async function authorize(request: Request, expected: string): Promise<boolean> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!expected || actual.length !== expected.length) return false;
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

function auditEnv(): Env {
  return {
    CONFIG_KV: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as Env;
}

async function snapshot(client: postgres.Sql) {
  const rows = await client<Array<Record<string, unknown>>>`
    SELECT
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_product) AS products,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_product_relation) AS product_relations,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_product_category) AS categories,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_cart) AS carts,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_order) AS orders,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.store_order_refund) AS refunds,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.user_money) AS money,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.user_relation) AS relations,
      (SELECT jsonb_build_array(count(*), COALESCE(sum(id), 0)) FROM public.system_config) AS configs,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`}) AS temporary_schemas
  `;
  return rows[0];
}

async function productionState(connectionString: string) {
  const client = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5 });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '25s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx<Array<Record<string, unknown>>>`
        WITH pc_configs(name) AS (VALUES
          ('wechat_open_app_id'), ('product_phone_buy_url'), ('site_url'), ('contact_number'),
          ('links_open'), ('links_list'), ('company_address'), ('copyright'), ('record_No'),
          ('site_name'), ('site_keywords'), ('site_description'), ('pc_logo'), ('filing_list'),
          ('wechat_qrcode'), ('routine_appId'), ('routine_appsecret')
        )
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM store_product WHERE is_show=1 AND is_del=0 AND is_verify=1) AS visible_products,
          (SELECT count(*)::integer FROM store_product_relation WHERE type=1 AND status=1) AS active_category_relations,
          (SELECT count(*)::integer FROM store_product_category WHERE pid=0 AND is_show=1) AS visible_root_categories,
          (SELECT count(*)::integer FROM city_area) AS city_rows,
          (SELECT count(*)::integer FROM store_cart WHERE is_pay=0 AND is_del=0) AS open_carts,
          (SELECT count(*)::integer FROM store_order WHERE is_del=0 AND is_system_del=0) AS visible_orders,
          (SELECT count(*)::integer FROM store_order_refund WHERE is_del=0) AS visible_refunds,
          (SELECT count(*)::integer FROM user_money) AS money_rows,
          (SELECT count(*)::integer FROM user_relation WHERE type='collect' AND category='product') AS product_collections,
          (SELECT count(*)::integer FROM system_group g JOIN system_group_data d ON d.gid=g.id
             WHERE g.config_name='pc_home_banner' AND d.status=1) AS pc_banner_rows,
          (SELECT count(DISTINCT c.menu_name)::integer FROM system_config c JOIN pc_configs p ON p.name=c.menu_name
             WHERE c.is_store=0) AS present_pc_config_keys,
          (SELECT COALESCE(jsonb_agg(DISTINCT c.menu_name ORDER BY c.menu_name), '[]'::jsonb)
             FROM system_config c JOIN pc_configs p ON p.name=c.menu_name WHERE c.is_store=0) AS present_pc_configs,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE ${`${PREFIX}%`}) AS temporary_schemas
      `;
      return { transaction: "READ ONLY", ...rows[0] };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function productionContracts(connectionString: string) {
  const root = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_api005_pc_contract" });
  try {
    return await root.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const service = new PcCompatibilityService(
        createContainerFromDb(transactionDb(tx, root.$client.options)),
        auditEnv(),
      );
      const [app, phone, banner, categories, products, city, company, good, qrcode, status] = await Promise.all([
        service.appId(),
        service.productPhoneBuy(),
        service.banner(),
        service.categoryProducts(0, 1, 3),
        service.productList(0, { page: 1, limit: 5, product_types: [0, 1, 2, 3] }),
        service.city(0),
        service.companyInfo(),
        service.goodProducts(0),
        service.wechatQrcode(),
        service.orderStatus("codex-never-a-real-order", Math.floor(Date.now() / 1_000) + 30),
      ]);
      const recommendations = await Promise.all([1, 2, 3, 4].map((type) => service.recommend(0, type, 1, 5)));
      return {
        transaction: "READ ONLY",
        appid_present: Boolean(app.appid),
        version_present: Boolean(app.version),
        phone_buy: phone.phone_buy,
        site_url_present: Boolean(phone.sit_url),
        banner_count: banner.list.length,
        category_count: categories.count,
        category_page_count: categories.list.length,
        product_count: products.count,
        product_page_count: products.list.length,
        city_root_count: city.length,
        company_keys: Object.keys(company).sort(),
        company_logo_present: Boolean(company.logoUrl),
        recommendation_counts: recommendations.map((item) => ({ count: item.count, page: item.list.length })),
        good_count: good.list.length,
        wechat_qrcode_present: Boolean(qrcode.wechat_qrcode),
        missing_order_status: status.status,
        countdown_bounded: status.time >= 0 && status.time <= 30,
      };
    });
  } finally {
    await root.$client.end({ timeout: 1 });
  }
}

async function isolatedScenario(connectionString: string) {
  const schemaName = `${PREFIX}${Date.now()}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  if (!/^codex_api005_pc_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe schema name");
  const root = createDbFromConnectionString(connectionString, 1, { applicationName: "cinashop_api005_pc_isolated" });
  const before = await snapshot(root.$client);
  let created = false;
  let result: Record<string, unknown> = {};
  let scenarioError: unknown;
  try {
    await root.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '50s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      created = true;
      for (const table of TABLES) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`
        INSERT INTO system_config (id, menu_name, value, is_store, status) VALUES
          (1, 'product_phone_buy_url', '1', 0, 1),
          (2, 'site_url', 'https://audit.example', 0, 1),
          (3, 'site_name', 'PC Audit Shop', 0, 1),
          (4, 'pc_logo', '/logo.png', 0, 1),
          (5, 'links_open', '1', 0, 1),
          (6, 'links_list', ${JSON.stringify([{ sort: 1, url: "z" }, { sort: 2, url: "a" }])}, 0, 1),
          (7, 'filing_list', ${JSON.stringify([{ sort: 1, url: "b" }])}, 0, 1),
          (8, 'wechat_qrcode', '/wechat.png', 0, 1),
          (9, 'member_func_status', '0', 0, 1),
          (10, 'member_card_status', '0', 0, 1),
          (11, 'svip_price_status', '0', 0, 1)
      `;
      await tx`INSERT INTO system_group (id, name, info, config_name) VALUES (1, 'PC banner', 'audit', 'pc_home_banner')`;
      await tx`INSERT INTO system_group_data (id, gid, value, sort, status) VALUES
        (1, 1, ${JSON.stringify({ name: { value: "banner" }, pic: { value: "/banner.png" } })}, 9, 1)`;
      await tx`
        INSERT INTO store_product_category (id,pid,type,relation_id,cate_name,path,level,sort,is_show) VALUES
          (11,0,0,0,'root','',0,9,1), (12,11,0,0,'middle','11',1,8,1),
          (13,12,0,0,'leaf','11,12',2,7,1)
      `;
      await tx`
        INSERT INTO store_product (id,pid,type,product_type,image,store_name,store_info,cate_id,price,ot_price,
          vip_price,stock,sales,ficti,star,sort,is_show,is_verify,is_del,is_good) VALUES
          (101,0,0,0,'/p.png','deep product','audit','13',10,12,9,5,2,1,4.5,9,1,1,0,1),
          (102,0,0,0,'/p2.png','second product','audit','11',20,22,19,5,1,0,4.0,8,1,1,0,0)
      `;
      await tx`
        INSERT INTO store_product_relation (id,type,product_id,relation_id,relation_pid,status) VALUES
          (1,1,101,13,11,1), (2,1,102,11,11,1),
          (3,3,101,1,0,1), (4,3,101,3,0,1), (5,3,101,4,0,1), (6,3,101,5,0,1)
      `;
      await tx`INSERT INTO city_area (id,path,parent_id,type,name,level,snum) VALUES
        (1,'/1/',0,'province','Province',0,1), (2,'/1/2/',1,'city','City',1,1)`;
      await tx`INSERT INTO "user" (uid,account,nickname,status,is_del,is_money_level,level) VALUES
        (100,'audit-user','Audit User',1,0,0,0)`;
      await tx`INSERT INTO store_product_attr_value
        (id,product_id,product_type,suk,stock,price,image,"unique",cost,ot_price,vip_price,type) VALUES
        (201,101,0,'default',5,10,'/sku.png','sku00001',5,12,9,0)`;
      await tx`INSERT INTO store_cart
        (id,uid,type,product_id,product_type,activity_id,store_id,product_attr_unique,cart_num,add_time,is_pay,is_del,is_new,status) VALUES
        (301,100,0,101,0,0,0,'sku00001',1,10,0,0,0,1),
        (302,100,0,101,0,0,0,'sku00001',1,9,0,0,0,0)`;
      await tx`INSERT INTO user_money (id,uid,link_id,type,title,number,balance,pm,status,add_time)
        VALUES (401,100,'audit','system_add','Audit money',5,5,1,1,10)`;
      await tx`INSERT INTO store_order
        (id,order_id,uid,real_name,pid,paid,status,is_del,is_system_del,add_time,"unique") VALUES
        (501,'audit-order',100,'Audit User',0,1,0,0,0,10,'api005-audit-order')`;
      await tx`INSERT INTO store_order_cart_info
        (id,uid,oid,cart_id,product_id,product_type,sku_unique,cart_num,cart_info,"unique",add_time) VALUES
        (601,100,501,'301',101,0,'sku00001',1,${JSON.stringify({ productInfo: { id: 101, store_name: "deep product" } })},'api005-cart',10)`;
      await tx`INSERT INTO user_relation (id,uid,relation_id,type,category,add_time)
        VALUES (701,100,101,'collect','product',10)`;
      await tx`INSERT INTO store_order_refund
        (id,store_order_id,order_id,uid,apply_type,apply_price,refund_type,refund_price,cart_info,is_del,add_time) VALUES
        (801,501,'refund-audit',100,1,5,1,5,${JSON.stringify([{ cart_id: "301" }])},0,10)`;

      const service = new PcCompatibilityService(
        createContainerFromDb(transactionDb(tx, root.$client.options)),
        auditEnv(),
      );
      const [cid, sid, tid, categories, banner, company, city, cart, money, orders, collect, refunds, recommend, good, pay] = await Promise.all([
        service.productList(0, { cid: 11, page: 1, limit: 10, product_types: [0,1,2,3] }),
        service.productList(0, { sid: 12, page: 1, limit: 10, product_types: [0,1,2,3] }),
        service.productList(0, { tid: 13, page: 1, limit: 10, product_types: [0,1,2,3] }),
        service.categoryProducts(0, 1, 10), service.banner(), service.companyInfo(), service.city(0),
        service.cartList(100), service.balanceRecord(100, 0, { page: 1, limit: 10 }),
        service.orderList(100, { page: "1", limit: "10" }), service.collectList(100, 1, 10),
        service.refundList(100, 1, 1, 10), service.recommend(0, 1, 1, 10),
        service.goodProducts(0), service.payVipCode(),
      ]);
      const assertions = {
        hierarchical_cid: cid.count === 2 && cid.list.some((item) => item.id === 101),
        hierarchical_sid: sid.count === 1 && sid.list[0]?.id === 101,
        exact_tid: tid.count === 1 && tid.list[0]?.id === 101,
        category_envelope: categories.count === 1 && categories.list[0]?.productList.length === 2,
        banner_contract: banner.list.length === 1,
        company_sort_and_logo: company.logoUrl === "https://audit.example/logo.png"
          && (company.links_list[0]?.sort === 2),
        city_contract: city.length === 1 && Array.isArray(city[0]?.children),
        cart_partition: cart.valid.length === 1 && cart.invalid.length === 1,
        money_contract: !Array.isArray(money)
          && (money as { list: unknown[]; count?: number }).list.length === 1
          && (money as { count?: number }).count === 1,
        order_owner_scope: (orders as { count: number; list: unknown[] }).count === 1
          && (orders as { count: number; list: unknown[] }).list.length === 1,
        collect_owner_scope: collect.count === 1
          && (collect.list[0] as Record<string, unknown> | undefined)?.id === 101,
        refund_owner_scope: refunds.count === 1 && refunds.list.length === 1,
        recommend_flag: recommend.count === 1
          && (recommend.list[0] as Record<string, unknown> | undefined)?.id === 101,
        good_flag: good.list.length === 1
          && (good.list[0] as Record<string, unknown> | undefined)?.id === 101,
        paid_qr_data_url: pay.url.startsWith("data:image/svg+xml;base64,"),
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
      result = { assertions, assertion_count: Object.keys(assertions).length };
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
  const after = await snapshot(root.$client);
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
    public_state_unchanged: true,
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
        event: "api005_pc_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json({ error: error instanceof Error ? error.message : "unknown audit error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
