import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/models/schema";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "@/lib/di";
import type { Env } from "@/env";
import { StoreCartService } from "@/services/order/StoreCartService";
import { StoreProductService } from "@/services/product/StoreProductService";
import { NotFoundException } from "@/utils/errors";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

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

async function productionState(connectionString: string) {
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_api004_cart_state" },
  });
  try {
    return await sql.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const rows = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM store_cart) AS cart_rows,
          (SELECT count(*)::integer FROM store_cart
            WHERE type = 0 AND activity_id = 0 AND store_id = 0
              AND is_del = 0 AND is_pay = 0 AND is_new = 0 AND status = 1) AS active_normal_carts,
          (SELECT count(DISTINCT uid)::integer FROM store_cart
            WHERE type = 0 AND activity_id = 0 AND store_id = 0
              AND is_del = 0 AND is_pay = 0 AND is_new = 0 AND status = 1) AS active_cart_users,
          (SELECT count(*)::integer FROM store_product
            WHERE is_del = 0 AND is_show = 1 AND is_verify = 1) AS active_products,
          (SELECT count(*)::integer FROM store_product_attr WHERE type = 0) AS product_attributes,
          (SELECT count(*)::integer FROM store_product_attr_value WHERE type = 0) AS normal_skus,
          (SELECT count(DISTINCT product_id)::integer FROM store_product_attr WHERE type = 0) AS products_with_attributes,
          (SELECT count(DISTINCT product_id)::integer FROM store_product_attr_value WHERE type = 0) AS products_with_skus,
          (SELECT count(*)::integer FROM store_product p
            WHERE p.is_del = 0 AND p.is_show = 1 AND p.is_verify = 1
              AND NOT EXISTS (SELECT 1 FROM store_product_attr_value v WHERE v.product_id = p.id AND v.type = 0)) AS active_products_without_skus,
          (SELECT count(*)::integer FROM store_product_attr_value v
            WHERE v.type = 0 AND NOT EXISTS (SELECT 1 FROM store_product p WHERE p.id = v.product_id)) AS orphan_normal_skus,
          (SELECT count(*)::integer FROM store_cart c
            LEFT JOIN store_product p ON p.id = c.product_id
            WHERE c.type = 0 AND c.activity_id = 0 AND c.store_id = 0
              AND c.is_del = 0 AND c.is_pay = 0 AND c.is_new = 0 AND c.status = 1
              AND (p.id IS NULL OR p.is_del <> 0 OR p.is_show <> 1 OR p.is_verify <> 1)) AS carts_with_invalid_products,
          (SELECT count(*)::integer FROM store_cart c
            LEFT JOIN store_product_attr_value v
              ON v.product_id = c.product_id AND v."unique" = c.product_attr_unique AND v.type = 0
            WHERE c.type = 0 AND c.activity_id = 0 AND c.store_id = 0
              AND c.is_del = 0 AND c.is_pay = 0 AND c.is_new = 0 AND c.status = 1
              AND v.id IS NULL) AS carts_with_missing_skus,
          (SELECT count(*)::integer FROM store_cart c
            JOIN store_product_attr_value v
              ON v.product_id = c.product_id AND v."unique" = c.product_attr_unique AND v.type = 0
            WHERE c.type = 0 AND c.activity_id = 0 AND c.store_id = 0
              AND c.is_del = 0 AND c.is_pay = 0 AND c.is_new = 0 AND c.status = 1
              AND (c.cart_num <= 0 OR c.cart_num > v.stock)) AS carts_with_invalid_quantities,
          (SELECT count(*)::integer FROM (
            SELECT 1 FROM store_cart c
            WHERE c.type = 0 AND c.activity_id = 0 AND c.store_id = 0
              AND c.is_del = 0 AND c.is_pay = 0 AND c.is_new = 0 AND c.status = 1
            GROUP BY c.uid, c.product_id, c.product_attr_unique HAVING count(*) > 1
          ) duplicated) AS duplicate_active_cart_scopes,
          pg_total_relation_size('store_cart'::regclass)::bigint AS cart_total_bytes,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_cart_%') AS temporary_schemas,
          (SELECT COALESCE(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
             FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'store_cart') AS cart_index_names
      `;
      const plan = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT * FROM store_cart
        WHERE uid = -1 AND type = 0 AND activity_id = 0 AND store_id = 0
          AND is_del = 0 AND is_pay = 0 AND is_new = 0 AND status = 1
        ORDER BY add_time DESC, id DESC
      `;
      return {
        transaction: "READ ONLY",
        state: rows[0],
        cart_list_plan: plan[0]?.["QUERY PLAN"] ?? null,
      };
    });
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function productionContracts(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_cart_contracts",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const scoped = transactionDb(tx, db.$client.options);
      const container = createContainerFromDb(scoped);
      const users = await tx<Array<{ uid: number }>>`
        SELECT uid FROM store_cart
        WHERE type = 0 AND activity_id = 0 AND store_id = 0
          AND is_del = 0 AND is_pay = 0 AND is_new = 0 AND status = 1
        ORDER BY add_time DESC, id DESC LIMIT 1
      `;
      const products = await tx<Array<{ id: number }>>`
        SELECT p.id FROM store_product p
        WHERE p.is_del = 0 AND p.is_show = 1 AND p.is_verify = 1
          AND EXISTS (
            SELECT 1 FROM store_product_attr_value v
            WHERE v.product_id = p.id AND v.type = 0
          )
        ORDER BY p.id LIMIT 1
      `;
      const uid = users[0]?.uid ?? 0;
      const productId = products[0]?.id ?? 0;
      const cartList = uid ? await new StoreCartService(container).listLegacyV2(uid) : [];
      const attr = productId
        ? await new StoreProductService(container, {} as Env).getLegacyProductAttr(productId, 0, false)
        : { storeInfo: {}, productAttr: [], productValue: {} };
      const firstCart = cartList[0] as Record<string, unknown> | undefined;
      const productValueEntries = Object.entries(attr.productValue);
      return {
        transaction: "READ ONLY",
        observed: {
          cart_row: Boolean(firstCart),
          product_with_sku: productId > 0,
        },
        assertions: {
          cart_contract: Array.isArray(cartList),
          cart_snake_case: !firstCart || (
            "product_id" in firstCart && "cart_num" in firstCart && "productInfo" in firstCart
          ),
          product_attr_contract: Array.isArray(attr.productAttr),
          product_value_contract: !Array.isArray(attr.productValue),
          product_value_keyed_by_suk: productValueEntries.every(([key, value]) => key === value.suk),
        },
        counts: {
          carts: cartList.length,
          product_attributes: attr.productAttr.length,
          product_values: productValueEntries.length,
        },
        cart_keys: firstCart ? Object.keys(firstCart).sort() : [],
        product_value_keys: productValueEntries[0] ? Object.keys(productValueEntries[0][1]).sort() : [],
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function isolatedScenario(connectionString: string) {
  const random = crypto.randomUUID().replaceAll("-", "").toLowerCase();
  const schemaName = `codex_api004_cart_${Date.now()}_${random.slice(0, 8)}`;
  if (!/^codex_api004_cart_[a-z0-9_]+$/.test(schemaName)) throw new Error("unsafe audit schema");
  const baseId = 1_800_000_000 + (Number.parseInt(random.slice(0, 6), 16) % 100_000);
  const uid = baseId + 10;
  const productId = baseId + 20;
  const attrId = baseId + 30;
  const firstSkuId = baseId + 40;
  const secondSkuId = baseId + 41;
  const sourceCartId = baseId + 50;
  const firstUnique = `a${random.slice(0, 7)}`;
  const secondUnique = `b${random.slice(0, 7)}`;
  const setupDb = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api004_cart_isolated",
  });
  let schemaCreated = false;
  let scenarioError: unknown;
  let assertions: Record<string, boolean> = {};
  const before = (await setupDb.$client<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*)::integer FROM public.store_cart) AS carts,
      (SELECT count(*)::integer FROM public.store_product) AS products,
      (SELECT count(*)::integer FROM public.store_product_attr) AS attrs,
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS skus,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_cart_%') AS temporary_schemas
  `)[0];
  try {
    await setupDb.$client.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '40s'`;
      await tx.unsafe(`CREATE SCHEMA "${schemaName}"`);
      for (const table of ["user", "store_product", "store_product_attr", "store_product_attr_value", "store_cart"]) {
        await tx.unsafe(`CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      await tx.unsafe(`CREATE SEQUENCE "${schemaName}"."store_cart_id_seq" START WITH ${baseId + 100} OWNED BY "${schemaName}"."store_cart"."id"`);
      await tx.unsafe(`ALTER TABLE "${schemaName}"."store_cart" ALTER COLUMN "id" SET DEFAULT nextval('"${schemaName}"."store_cart_id_seq"'::regclass)`);
      await tx.unsafe(
        `INSERT INTO "${schemaName}"."user" (uid, account, nickname, is_del, level)
         VALUES ($1, $2, 'cart audit', 0, 0)`,
        [uid, `cart_audit_${random.slice(0, 12)}`],
      );
      await tx.unsafe(
        `INSERT INTO "${schemaName}"."store_product"
          (id, store_name, image, price, vip_price, ot_price, cost, stock,
           is_show, is_del, is_verify, product_type, spec_type)
         VALUES ($1, 'Cart audit product', 'audit.png', 12.50, 11.50, 15.00, 5.00, 5,
           1, 0, 1, 0, 1)`,
        [productId],
      );
      await tx.unsafe(
        `INSERT INTO "${schemaName}"."store_product_attr"
          (id, product_id, attr_name, attr_values, type)
         VALUES ($1, $2, '颜色', $3, 0)`,
        [attrId, productId, JSON.stringify(["黑色", "白色"])],
      );
      await tx.unsafe(
        `INSERT INTO "${schemaName}"."store_product_attr_value"
          (id, product_id, suk, stock, price, vip_price, ot_price, cost, image, "unique", type)
         VALUES
          ($1, $2, '黑色', 5, 12.50, 11.50, 15.00, 5.00, 'black.png', $3, 0),
          ($4, $2, '白色', 5, 13.50, 12.50, 16.00, 5.50, 'white.png', $5, 0)`,
        [firstSkuId, productId, firstUnique, secondSkuId, secondUnique],
      );
      await tx.unsafe(
        `INSERT INTO "${schemaName}"."store_cart"
          (id, uid, product_id, product_type, product_attr_unique, cart_num,
           type, activity_id, store_id, is_pay, is_del, is_new, status, add_time)
         VALUES ($1, $2, $3, 0, $4, 1, 0, 0, 0, 0, 0, 0, 1, 1700000000)`,
        [sourceCartId, uid, productId, firstUnique],
      );
    });
    schemaCreated = true;

    const readIsolated = async () => setupDb.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schemaName}"`);
      await tx`SET TRANSACTION READ ONLY`;
      const container = createContainerFromDb(transactionDb(tx, setupDb.$client.options));
      const [list, attr] = await Promise.all([
        new StoreCartService(container).listLegacyV2(uid),
        new StoreProductService(container, {} as Env).getLegacyProductAttr(productId, uid, true),
      ]);
      return { list, attr };
    });
    const initial = await readIsolated();

    const scopedDb = createDbFromConnectionString(connectionString, 1, {
      applicationName: "cinashop_api004_cart_writes",
      searchPath: schemaName,
    });
    const secondScopedDb = createDbFromConnectionString(connectionString, 1, {
      applicationName: "cinashop_api004_cart_concurrent",
      searchPath: schemaName,
    });
    try {
      const service = new StoreCartService(createContainerFromDb(scopedDb));
      const concurrentService = new StoreCartService(createContainerFromDb(secondScopedDb));
      const added = await service.setProductQuantityLegacy({
        uid, productId, unique: firstUnique, cartNum: 1, mode: 1,
      });
      const reset = await service.resetLegacyV2({
        uid, id: sourceCartId, productId, unique: secondUnique, cartNum: 2,
      });
      const created = await service.setProductQuantityLegacy({
        uid, productId, unique: firstUnique, cartNum: 1, mode: 1,
      });
      const merged = await service.resetLegacyV2({
        uid, id: sourceCartId, productId, unique: firstUnique, cartNum: 2,
      });
      let ownershipRejected = false;
      try {
        await service.resetLegacyV2({
          uid: uid + 1, id: merged.id, productId, unique: secondUnique, cartNum: 1,
        });
      } catch (error) {
        ownershipRejected = error instanceof NotFoundException;
      }
      const removed = await service.setProductQuantityLegacy({
        uid, productId, unique: firstUnique, cartNum: 3, mode: 0,
      });
      const concurrent = await Promise.all([
        service.setProductQuantityLegacy({
          uid, productId, unique: secondUnique, cartNum: 1, mode: 1,
        }),
        concurrentService.setProductQuantityLegacy({
          uid, productId, unique: secondUnique, cartNum: 1, mode: 1,
        }),
      ]);
      const concurrentRows = await setupDb.$client.unsafe<Array<{ id: number; cart_num: number }>>(
        `SELECT id, cart_num FROM "${schemaName}"."store_cart"
         WHERE uid = $1 AND product_id = $2 AND product_attr_unique = $3
           AND type = 0 AND activity_id = 0 AND store_id = 0
           AND is_pay = 0 AND is_del = 0 AND is_new = 0 AND status = 1`,
        [uid, productId, secondUnique],
      );
      const concurrentRemoved = await service.setProductQuantityLegacy({
        uid, productId, unique: secondUnique, cartNum: 2, mode: 0,
      });
      const finalRead = await readIsolated();
      const rows = await setupDb.$client.unsafe<Array<{
        id: number;
        uid: number;
        product_attr_unique: string;
        cart_num: number;
        is_del: number;
      }>>(`SELECT id, uid, product_attr_unique, cart_num, is_del
             FROM "${schemaName}"."store_cart" ORDER BY id`);
      const initialSku = initial.attr.productValue["黑色"];
      assertions = {
        initial_cart_contract: initial.list.length === 1 && initial.list[0].product_id === productId && initial.list[0].cart_num === 1,
        product_value_keyed_by_suk: initialSku?.unique === firstUnique && initialSku.cart_num === 1,
        attribute_shape: initial.attr.productAttr[0]?.attr_value instanceof Array && initial.attr.productAttr[0].attr_values instanceof Array,
        add_mode: added.id === sourceCartId && added.cartNum === 2,
        reset_mode: reset.id === sourceCartId && reset.cartNum === 2,
        merge_mode: created.id !== sourceCartId && merged.id === created.id && merged.cartNum === 3,
        ownership_rejected: ownershipRejected,
        concurrent_single_scope: concurrent[0].id === concurrent[1].id &&
          concurrent.map((item) => item.cartNum).sort((a, b) => a - b).join(",") === "1,2" &&
          concurrentRows.length === 1 && concurrentRows[0].cart_num === 2,
        soft_delete: removed.deleted && concurrentRemoved.deleted && finalRead.list.length === 0 &&
          rows.length === 3 && rows.every((row) => row.is_del === 1),
      };
      if (Object.values(assertions).some((value) => !value)) {
        throw new Error(`isolated assertions failed: ${JSON.stringify(assertions)}`);
      }
    } finally {
      await secondScopedDb.$client.end({ timeout: 1 });
      await scopedDb.$client.end({ timeout: 1 });
    }
  } catch (error) {
    scenarioError = error;
  } finally {
    if (schemaCreated) {
      await setupDb.$client.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        await tx`SET LOCAL statement_timeout = '20s'`;
        await tx.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      });
    }
  }

  const after = (await setupDb.$client<Array<Record<string, number>>>`
    SELECT
      (SELECT count(*)::integer FROM public.store_cart) AS carts,
      (SELECT count(*)::integer FROM public.store_product) AS products,
      (SELECT count(*)::integer FROM public.store_product_attr) AS attrs,
      (SELECT count(*)::integer FROM public.store_product_attr_value) AS skus,
      (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_cart_%') AS temporary_schemas
  `)[0];
  await setupDb.$client.end({ timeout: 1 });
  if (scenarioError) throw scenarioError;
  const publicStateUnchanged = ["carts", "products", "attrs", "skus"]
    .every((key) => before[key] === after[key]);
  if (!publicStateUnchanged || before.temporary_schemas !== after.temporary_schemas) {
    throw new Error("public state or temporary schema count changed");
  }
  return {
    schema: schemaName,
    assertions,
    cleanup: "dropped",
    public_state_unchanged: publicStateUnchanged,
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
        event: "api004_cart_audit_failed",
        error: error instanceof Error ? error.name : "unknown",
      }));
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown audit error" },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
