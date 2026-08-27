import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type DbClient,
} from "@/lib/di";
import { KefuProductService } from "@/services/kefu/KefuProductService";
import { MigrationService } from "@/services/MigrationService";

const TABLES = [
  "store_service_record",
  "store_order",
  "store_order_cart_info",
  "store_product",
  "store_product_description",
  "store_product_relation",
  "store_visit",
] as const;

const INDEXES = [
  "soci_kefu_order_product",
  "spr_kefu_category_product",
  "spr_kefu_product_category",
  "sv_kefu_recent",
] as const;

interface Fingerprint {
  count: number;
  digest: string;
}

interface ProductionSummary {
  sessions: number;
  products: number;
  descriptions: number;
  order_items: number;
  visits: number;
  relations: number;
}

export interface KefuProductPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  production: ProductionSummary;
  isolated: Record<string, boolean>;
}

export interface KefuProductIndexReport {
  server_version: string;
  indexes: string[];
  second_apply_idempotent: boolean;
  public_state_unchanged: boolean;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Kefu product integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function randomSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_kefu_product_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function publicFingerprints(db: DbClient) {
  const result: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const row = (await db.$client.unsafe<Array<Fingerprint>>(`
      SELECT count(*)::int AS count,
             COALESCE(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text))), md5('')) AS digest
      FROM public.${identifier(table)} AS t
    `))[0];
    assertCondition(row, `could not fingerprint public.${table}`);
    result[table] = row;
  }
  return result;
}

async function productionSummary(db: DbClient): Promise<ProductionSummary> {
  const row = (await db.$client<Array<ProductionSummary>>`
    SELECT
      (SELECT count(*)::int FROM public.store_service_record) AS sessions,
      (SELECT count(*)::int FROM public.store_product) AS products,
      (SELECT count(*)::int FROM public.store_product_description) AS descriptions,
      (SELECT count(*)::int FROM public.store_order_cart_info) AS order_items,
      (SELECT count(*)::int FROM public.store_visit) AS visits,
      (SELECT count(*)::int FROM public.store_product_relation WHERE type = 1) AS relations
  `)[0];
  assertCondition(row, "production summary returned no row");
  return row;
}

async function setupSchema(db: DbClient, schemaName: string) {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of TABLES) {
      await tx.unsafe(`CREATE TABLE ${schema}.${identifier(table)} (LIKE public.${identifier(table)} INCLUDING ALL)`);
    }
    await tx.unsafe(`
      INSERT INTO ${schema}.store_service_record
        (id, user_id, to_uid, nickname, avatar, is_tourist, online, type, add_time, update_time, mssage_num, message, message_type)
      VALUES
        (1, 1001, 2001, '客户一', '', 0, 1, 1, 1700000000, 1700000100, 0, '', 1),
        (2, 1002, 2002, '客户二', '', 0, 1, 1, 1700000000, 1700000100, 0, '', 1)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product
        (id, pid, store_name, image, slider_image, price, vip_price, ot_price, stock, sales, ficti, sort, is_show, is_del)
      VALUES
        (101, 0, '已购商品A', '/a.png', '["/a.png","/a-2.png"]', 10.00, 9.00, 12.00, 8, 7, 3, 8, 1, 0),
        (102, 0, '已购商品B', '/b.png', '[]', 20.00, 18.00, 25.00, 5, 5, 2, 9, 1, 0),
        (103, 0, '同类热销商品', '/hot.png', '["/hot.png"]', 30.00, 27.00, 35.00, 12, 90, 10, 7, 1, 0),
        (104, 0, '其他目录商品', '/other.png', 'invalid-json', 40.00, 36.00, 45.00, 4, 2, 1, 6, 1, 0),
        (105, 0, '已下架搜索商品', '/hidden.png', '[]', 50.00, 45.00, 55.00, 1, 1, 0, 10, 0, 0)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product_description (product_id, description, type)
      VALUES (103, '同类热销商品详情', 0), (104, '其他目录商品详情', 0)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order
        (id, order_id, uid, "unique", is_del, is_system_del)
      VALUES (301, 'kefu-product-order', 2001, 'kefu-product-order-key', 0, 0)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_order_cart_info
        (id, uid, oid, cart_id, product_id, "unique")
      VALUES
        (401, 2001, 301, '501', 101, 'audit-a'),
        (402, 2001, 301, '502', 102, 'audit-b')
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_visit
        (id, product_id, product_type, cate_id, type, uid, count, content, add_time)
      VALUES
        (501, 101, 'product', 10, 'view', 2001, 1, '', 1700000200),
        (502, 102, 'product', 20, 'view', 2001, 1, '', 1700000300),
        (503, 104, 'product', 30, 'view', 2002, 1, '', 1700000400)
    `);
    await tx.unsafe(`
      INSERT INTO ${schema}.store_product_relation
        (id, type, product_id, relation_id, relation_pid, status, add_time)
      VALUES
        (601, 1, 101, 10, 0, 1, 1700000000),
        (602, 1, 102, 20, 0, 1, 1700000000),
        (603, 1, 103, 10, 0, 1, 1700000000),
        (604, 1, 104, 30, 0, 1, 1700000000)
    `);
  });
}

async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

async function indexNames(db: DbClient, schemaName: string): Promise<string[]> {
  const rows = await db.$client<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = ${schemaName}
      AND indexname = ANY(${[...INDEXES]})
    ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

async function temporarySchemaCount(db: DbClient): Promise<number> {
  return (await db.$client<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM pg_namespace WHERE nspname LIKE 'codex_kefu_product_%'
  `)[0]?.count ?? 0;
}

export async function applyKefuProductIndexes(
  connectionString: string,
): Promise<KefuProductIndexReport> {
  const root = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public",
    applicationName: "cinashop_kefu_product_index_apply",
  });
  try {
    const before = await publicFingerprints(root);
    const ddl = new MigrationService(createContainerFromDb(root))
      .kefuProductContextMigrationSqlForVerification();
    const apply = async () => root.$client.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '3s'`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL search_path TO public`;
      await tx.unsafe(ddl);
    });
    await apply();
    const first = await indexNames(root, "public");
    await apply();
    const second = await indexNames(root, "public");
    const after = await publicFingerprints(root);
    assertCondition(first.join(",") === [...INDEXES].sort().join(","), `unexpected index set: ${first.join(",")}`);
    assertCondition(JSON.stringify(first) === JSON.stringify(second), "second index apply changed the index set");
    assertCondition(JSON.stringify(before) === JSON.stringify(after), "public business rows changed while applying indexes");
    return {
      server_version: (await root.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      indexes: first,
      second_apply_idempotent: true,
      public_state_unchanged: true,
    };
  } finally {
    await root.$client.end({ timeout: 1 });
  }
}

export async function runKefuProductPostgresScenario(
  connectionString: string,
): Promise<KefuProductPostgresReport> {
  const root = createDbFromConnectionString(connectionString, 1, {
    searchPath: "public",
    applicationName: "cinashop_kefu_product_audit_root",
  });
  const schemaName = randomSchemaName();
  let schemaCreated = false;
  let isolated: DbClient | null = null;
  try {
    const [before, production] = await Promise.all([
      publicFingerprints(root),
      productionSummary(root),
    ]);
    await setupSchema(root, schemaName);
    schemaCreated = true;
    isolated = createDbFromConnectionString(connectionString, 1, {
      searchPath: schemaName,
      applicationName: "cinashop_kefu_product_audit_isolated",
    });
    const container = createContainerFromDb(isolated);
    const ddl = new MigrationService(container).kefuProductContextMigrationSqlForVerification();
    await isolated.$client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO ${identifier(schemaName)}`);
      await tx.unsafe(ddl);
    });

    const result = await withTx(container, async (tx) => {
      const service = new KefuProductService(createContainerFromDb(tx));
      const purchasedPageOne = await service.purchasedProducts(1001, 2001, { page: "1", limit: "1" });
      const purchasedPageTwo = await service.purchasedProducts(1001, 2001, { page: "2", limit: "1" });
      const widenedSearch = await service.purchasedProducts(1001, 2001, { store_name: "其他目录", limit: "20" });
      const hiddenSearch = await service.purchasedProducts(1001, 2001, { store_name: "已下架", limit: "20" });
      const visited = await service.visitedProducts(1001, 2001, { limit: "20" });
      const hot = await service.hotProducts(1001, 2001, {});
      const detail = await service.productInfo(103);
      const invalidSliderDetail = await service.productInfo(104);
      const foreignPurchasedRejected = await rejects(() => service.purchasedProducts(1001, 2002, {}));
      const foreignVisitedRejected = await rejects(() => service.visitedProducts(1001, 2002, {}));
      const foreignHotRejected = await rejects(() => service.hotProducts(1001, 2002, {}));
      return {
        purchasedPageOne,
        purchasedPageTwo,
        widenedSearch,
        hiddenSearch,
        visited,
        hot,
        detail,
        invalidSliderDetail,
        foreignPurchasedRejected,
        foreignVisitedRejected,
        foreignHotRejected,
      };
    });
    const indexes = await indexNames(root, schemaName);
    await isolated.$client.unsafe(`DELETE FROM ${identifier(schemaName)}.store_service_record WHERE user_id = 1001 AND to_uid = 2001`);
    const revokedAfterTransfer = await rejects(() => withTx(
      createContainerFromDb(isolated!),
      async (tx) => new KefuProductService(createContainerFromDb(tx))
        .purchasedProducts(1001, 2001, {}),
    ));
    const detailStillCatalogScoped = await withTx(
      createContainerFromDb(isolated),
      async (tx) => (await new KefuProductService(createContainerFromDb(tx)).productInfo(103)).id === 103,
    );

    const flags = {
      purchased_pagination_exact:
        result.purchasedPageOne.length === 1 && result.purchasedPageOne[0]?.id === 102 &&
        result.purchasedPageTwo.length === 1 && result.purchasedPageTwo[0]?.id === 101,
      explicit_search_widens_visible_catalog:
        result.widenedSearch.length === 1 && result.widenedSearch[0]?.id === 104 && result.hiddenSearch.length === 0,
      visits_follow_legacy_store_visit_order:
        result.visited.map((item) => item.id).join(",") === "102,101",
      hot_category_expansion_sorted:
        result.hot.map((item) => item.id).join(",") === "103,101,102",
      detail_contract_exact:
        result.detail.description === "同类热销商品详情" && result.detail.slider_image.join(",") === "/hot.png" &&
        result.detail.sales === 100 && result.detail.vip_price === "27.00",
      malformed_slider_safe: result.invalidSliderDetail.slider_image.length === 0,
      foreign_customer_closed:
        result.foreignPurchasedRejected && result.foreignVisitedRejected && result.foreignHotRejected,
      transfer_revokes_customer_context: revokedAfterTransfer,
      product_detail_is_authenticated_catalog: detailStillCatalogScoped,
      indexes_present: indexes.join(",") === [...INDEXES].sort().join(","),
    };
    for (const [name, value] of Object.entries(flags)) {
      assertCondition(value, `${name}; result=${JSON.stringify(result)} indexes=${indexes.join(",")}`);
    }

    await isolated.$client.end({ timeout: 1 });
    isolated = null;
    await root.$client.unsafe(`DROP SCHEMA ${identifier(schemaName)} CASCADE`);
    schemaCreated = false;
    const after = await publicFingerprints(root);
    const temporarySchemasAfter = await temporarySchemaCount(root);
    const publicUnchanged = JSON.stringify(before) === JSON.stringify(after);
    assertCondition(publicUnchanged, "public state changed");
    assertCondition(temporarySchemasAfter === 0, "temporary schema leaked");
    return {
      server_version: (await root.$client<Array<{ version: string }>>`
        SELECT current_setting('server_version') AS version
      `)[0]?.version ?? "",
      schema_created: true,
      schema_removed: true,
      temporary_schemas_after: temporarySchemasAfter,
      public_state_unchanged: true,
      production,
      isolated: flags,
    };
  } finally {
    if (isolated) await isolated.$client.end({ timeout: 1 }).catch(() => undefined);
    if (schemaCreated) {
      await root.$client.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schemaName)} CASCADE`).catch(() => undefined);
    }
    await root.$client.end({ timeout: 1 });
  }
}
