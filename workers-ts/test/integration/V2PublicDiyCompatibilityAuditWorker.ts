import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import type { Env } from "@/env";
import { V2PublicCompatibilityService } from "@/services/content/V2PublicCompatibilityService";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

const CONFIG_KEYS = [
  "store_user_mobile",
  "store_func_status",
  "store_self_mention",
  "navigation_open",
  "product_category_level",
  "product_video_status",
  "image_thumb_status",
  "site_url",
] as const;

async function authorize(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function testEnv(): Env {
  const values = new Map<string, string>();
  return {
    CONFIG_KV: {
      async get(key: string) { return values.get(key) ?? null; },
      async put(key: string, value: string) { values.set(key, value); },
      async delete(key: string) { values.delete(key); },
    },
  } as unknown as Env;
}

function summary(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (value !== null && typeof value === "object") {
    return { kind: "object", keys: Object.keys(value as Record<string, unknown>).sort() };
  }
  return { kind: value === null ? "null" : typeof value, value };
}

async function productionState(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_api004_diy_state" },
  });
  try {
    return await sql.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM system_dise) AS diy_rows,
          (SELECT count(*)::integer FROM system_dise WHERE status = 1 AND type = 1) AS active_home_diy_rows,
          (SELECT count(*)::integer FROM system_dise WHERE type = 3) AS typed_diy_rows,
          (SELECT count(*)::integer FROM (
            SELECT template_name, type FROM system_dise GROUP BY template_name, type HAVING count(*) > 1
          ) d) AS duplicate_diy_scopes,
          (SELECT count(*)::integer FROM city_area) AS city_rows,
          (SELECT count(*)::integer FROM city_area WHERE parent_id = 0) AS city_roots,
          (SELECT COALESCE(max(level), 0)::integer FROM city_area) AS city_max_level,
          (SELECT count(*)::integer FROM city_area c
            WHERE c.parent_id <> 0 AND NOT EXISTS (SELECT 1 FROM city_area p WHERE p.id = c.parent_id)) AS orphan_cities,
          (SELECT count(*)::integer FROM city_area WHERE id = parent_id) AS self_parent_cities,
          pg_total_relation_size('system_dise'::regclass)::bigint AS diy_total_bytes,
          pg_total_relation_size('city_area'::regclass)::bigint AS city_total_bytes,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_diy_%') AS temporary_schemas,
          (SELECT COALESCE(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
             FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'system_dise') AS diy_index_names,
          (SELECT COALESCE(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
             FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'city_area') AS city_index_names
      `;
      const configs = await tx<Array<{ menu_name: string; values: unknown; rows: number }>>`
        SELECT menu_name,
               jsonb_agg(value ORDER BY sort DESC, id DESC) AS values,
               count(*)::integer AS rows
        FROM system_config
        WHERE is_store = 0 AND menu_name IN ${tx(CONFIG_KEYS)}
        GROUP BY menu_name ORDER BY menu_name
      `;
      const sample = await tx<Array<{ name: string }>>`
        SELECT name FROM city_area ORDER BY level DESC, id DESC LIMIT 1
      `;
      const plan = sample[0]
        ? await tx<Array<{ "QUERY PLAN": unknown }>>`
            EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
            SELECT id, path FROM city_area WHERE name = ${sample[0].name} ORDER BY id DESC LIMIT 1
          `
        : [];
      return {
        transaction: "READ ONLY",
        state: rows[0],
        relevant_configs: configs,
        city_name_plan: plan[0]?.["QUERY PLAN"] ?? null,
      };
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function productionContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_diy_contracts",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const container = createContainerFromDb(transactionDb(tx, db.$client.options));
      const service = new V2PublicCompatibilityService(container, testEnv());
      const named = await tx<Array<{ template_name: string }>>`
        SELECT template_name FROM system_dise WHERE template_name <> '' ORDER BY id LIMIT 1
      `;
      const deepest = await tx<Array<{ id: number; path: string; name: string }>>`
        SELECT id, path, name FROM city_area ORDER BY level DESC, id DESC LIMIT 1
      `;
      let address = "";
      if (deepest[0]) {
        const ids = [...deepest[0].path.split("/").map(Number).filter((id) => id > 0), deepest[0].id];
        const names = await tx<Array<{ id: number; name: string }>>`
          SELECT id, name FROM city_area WHERE id IN ${tx(ids)}
        `;
        const byId = new Map(names.map((row) => [row.id, row.name]));
        address = ids.flatMap((id) => byId.get(id) ?? []).join("/");
      }
      const [home, namedDiy, bind, store, color, detail, cities] = await Promise.all([
        service.diy(""),
        named[0] ? service.diy(named[0].template_name) : Promise.resolve([]),
        service.bindPhoneStatus(),
        service.storeStatus(),
        service.colorChange(named[0]?.template_name ?? "color_change"),
        service.productDetail(),
        address ? service.cityList(address) : Promise.resolve([]),
      ]);
      return {
        transaction: "READ ONLY",
        observed: { named_template: named[0]?.template_name ?? null, city_address: address || null },
        contracts: {
          home: summary(home),
          named: summary(namedDiy),
          bind,
          store,
          color,
          detail: {
            product_detail_keys: Object.keys(detail.product_detail).sort(),
            product_video_status: detail.product_video_status,
            product_category: detail.product_category,
          },
          city: summary(cities),
        },
        assertions: {
          home_contract: Array.isArray(home) || (home !== null && typeof home === "object"),
          named_contract: Array.isArray(namedDiy) || namedDiy === null || typeof namedDiy === "object",
          boolean_bind_status: typeof bind.status === "boolean",
          numeric_store_status: Number.isInteger(store.store_status),
          numeric_color_contract: [color.status, color.navigation, color.product_category_level]
            .every(Number.isInteger),
          product_detail_defaults: detail.product_detail.navList instanceof Array &&
            detail.product_detail.recommendNum !== undefined,
          product_category_defaults: detail.product_category.level !== undefined &&
            detail.product_category.index !== undefined,
          city_contract: Array.isArray(cities),
        },
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function isolatedScenario(connectionString: string) {
  const random = crypto.randomUUID().replaceAll("-", "").toLowerCase();
  const schemaName = `codex_api004_diy_${Date.now()}_${random.slice(0, 8)}`;
  if (!/^codex_api004_diy_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const baseId = 1_700_000_000 + (Number.parseInt(random.slice(0, 6), 16) % 100_000);
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_diy_isolated",
  });
  const before = (await db.$client<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*)::integer FROM public.system_dise) AS diy,
      (SELECT count(*)::integer FROM public.city_area) AS city,
      (SELECT count(*)::integer FROM public.system_config) AS config,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_diy_%') AS temporary_schemas
  `)[0];
  let created = false;
  let scenarioError: unknown;
  let result: Record<string, unknown> = {};
  try {
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      for (const table of ["system_dise", "city_area", "system_config"]) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(
        `INSERT INTO "${schemaName}"."system_dise"
          (id, name, title, value, type, status, template_name)
         VALUES
          ($1, '首页', '首页', $2, 1, 1, 'audit_home'),
          ($3, '主题', '主题', '2', 3, 1, 'audit_theme'),
          ($4, '商品详情', '商品详情', $5, 3, 1, 'product_detail'),
          ($6, '商品分类', '商品分类', $7, 3, 1, 'category')`,
        [
          baseId + 1,
          JSON.stringify({ page: "home", f_scroll_box: { goodsList: { list: [{ pic: "/audit.png" }] } } }),
          baseId + 2,
          baseId + 3,
          JSON.stringify({ showCart: 0, replyNum: 8, ignored: true }),
          baseId + 4,
          JSON.stringify({ level: 3, extension: "kept" }),
        ],
      );
      const configs = [
        ["store_user_mobile", "1"],
        ["store_func_status", "1"],
        ["store_self_mention", "2"],
        ["navigation_open", "1"],
        ["product_category_level", "3"],
        ["product_video_status", "1"],
      ];
      for (const [index, config] of configs.entries()) {
        await tx.unsafe(
          `INSERT INTO "${schemaName}"."system_config"
            (id, is_store, menu_name, value, sort, status)
           VALUES ($1, 0, $2, $3, 0, 1)`,
          [baseId + 100 + index, config[0], config[1]],
        );
      }
      const province = baseId + 201;
      const city = baseId + 202;
      const district = baseId + 203;
      const street = baseId + 204;
      const sibling = baseId + 205;
      await tx.unsafe(
        `INSERT INTO "${schemaName}"."city_area"
          (id, path, parent_id, type, name, level, code, snum, create_time)
         VALUES
          ($1, '/', 0, 'province', '审计省', 1, 'P', 0, 1),
          ($2, $6, $1, 'city', '审计市', 2, 'C', 0, 2),
          ($3, $7, $2, 'area', '审计区', 3, 'D', 0, 3),
          ($4, $8, $3, 'street', '审计街道', 4, 'S', 0, 4),
          ($5, $7, $2, 'area', '审计旁区', 3, 'O', 0, 5)`,
        [province, city, district, street, sibling, `/${province}/`, `/${province}/${city}/`, `/${province}/${city}/${district}/`],
      );
    });
    created = true;

    result = await db.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const service = new V2PublicCompatibilityService(
        createContainerFromDb(transactionDb(tx, db.$client.options)),
        testEnv(),
      );
      const [home, named, bind, store, color, detail, city, municipality, missing] = await Promise.all([
        service.diy(""),
        service.diy("audit_home"),
        service.bindPhoneStatus(),
        service.storeStatus(),
        service.colorChange("audit_theme"),
        service.productDetail(),
        service.cityList("审计省/审计市/审计区/审计街道"),
        service.cityList("审计省/审计省/审计市/审计区"),
        service.cityList("未录入省"),
      ]);
      const cityRows = city ?? [];
      const assertions = {
        default_diy: (home as Record<string, unknown>).page === "home",
        named_diy: (named as Record<string, unknown>).page === "home",
        bind_status: bind.status === true,
        store_status: store.store_status === 2,
        color_contract: color.status === 2 && color.navigation === 1 && color.product_category_level === 3,
        product_detail_merge: detail.product_detail.showCart === 0 && detail.product_detail.replyNum === 8 &&
          !("ignored" in detail.product_detail),
        product_category_merge: detail.product_category.level === 3 && detail.product_category.index === 1 &&
          detail.product_category.extension === "kept",
        city_chain: cityRows.length === 4 && cityRows.every((row) => Array.isArray(row.children)) &&
          cityRows.at(-1)?.label === "审计街道",
        municipality_dedup: municipality?.length === 3 && municipality.at(-1)?.label === "审计区",
        missing_city: missing === null,
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
      return {
        transaction: "READ ONLY",
        assertions,
        city_labels: cityRows.map((row) => row.label),
        district_children: (cityRows[1]?.children as unknown[] | undefined)?.length ?? 0,
      };
    });
  } catch (error) {
    scenarioError = error;
  } finally {
    if (created) {
      await db.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }
  const after = (await db.$client<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*)::integer FROM public.system_dise) AS diy,
      (SELECT count(*)::integer FROM public.city_area) AS city,
      (SELECT count(*)::integer FROM public.system_config) AS config,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_diy_%') AS temporary_schemas
  `)[0];
  await db.$client.end({ timeout: 1 });
  if (scenarioError) throw scenarioError;
  const unchanged = ["diy", "city", "config"].every((key) => before[key] === after[key]);
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
        event: "api004_diy_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
