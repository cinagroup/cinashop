import { and, eq, sql } from "drizzle-orm";
import type { Env } from "@/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  withTx,
  type Container,
  type DbClient,
} from "@/lib/di";
import {
  outInterface,
  storeProduct,
  storeProductCate,
  storeProductCategory,
  storeProductCategoryBrand,
  storeProductRelation,
} from "@/models/schema";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import { AuthException, NotFoundException, ValidateException } from "@/utils/errors";

const CLONED_TABLES = [
  "out_interface",
  "store_product_category",
  "store_product",
  "store_product_relation",
  "store_product_cate",
  "store_product_category_brand",
] as const;

const PRIMARY_KEYS: Record<(typeof CLONED_TABLES)[number], string> = {
  out_interface: "id",
  store_product_category: "id",
  store_product: "id",
  store_product_relation: "id",
  store_product_cate: "id",
  store_product_category_brand: "id",
};

const SEQUENCES: Record<(typeof CLONED_TABLES)[number], string> = {
  out_interface: "out_interface_id_seq",
  store_product_category: "store_product_category_id_seq",
  store_product: "store_product_id_seq",
  store_product_relation: "store_product_relation_id_seq",
  store_product_cate: "store_product_cate_id_seq",
  store_product_category_brand: "store_product_category_brand_id_seq",
};

type Fingerprint = {
  tables: Record<string, { count: string; max_id: string | null; digest: string }>;
  sequences: Record<string, string | null>;
};

export interface OutApiCategoryPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  category_acl_routes_allowed: boolean;
  unpermissioned_product_write_rejected: boolean;
  create_first_changed: boolean;
  create_replay_converged: boolean;
  concurrent_create_single_row: boolean;
  concurrent_create_observation: {
    idempotent: boolean[];
    ids: number[];
    row_count: number;
  };
  conflicting_sibling_rejected: boolean;
  descendant_cycle_rejected: boolean;
  fourth_level_rejected: boolean;
  move_updated_descendants: boolean;
  move_repaired_relation_parent: boolean;
  move_replay_converged: boolean;
  move_rollback_atomic: boolean;
  show_cascaded_direct_children: boolean;
  show_replay_converged: boolean;
  child_delete_rejected: boolean;
  relation_delete_rejected: boolean;
  csv_delete_rejected: boolean;
  legacy_cate_delete_rejected: boolean;
  category_brand_delete_rejected: boolean;
  supplier_product_reference_rejected: boolean;
  safe_delete_replay_converged: boolean;
  deleted_product_reference_ignored: boolean;
  supplier_scope_protected: boolean;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out category integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_category_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

async function fingerprint(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of CLONED_TABLES) {
    const key = identifier(PRIMARY_KEYS[table]);
    const rows = await db.$client.unsafe<Array<{
      count: string;
      max_id: string | null;
      digest: string;
    }>>(
      `SELECT count(*)::text AS count,
        max(t.${key})::text AS max_id,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.${key}), '')) AS digest
       FROM public.${identifier(table)} t`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const sequenceRows = await db.$client<Array<{ sequencename: string; last_value: string | null }>>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${Object.values(SEQUENCES)})
    ORDER BY sequencename
  `;
  const sequenceMap = new Map(sequenceRows.map((row) => [row.sequencename, row.last_value]));
  return {
    tables,
    sequences: Object.fromEntries(
      Object.values(SEQUENCES).map((name) => [name, sequenceMap.get(name) ?? null]),
    ),
  };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of CLONED_TABLES) {
      const tableName = identifier(table);
      const key = PRIMARY_KEYS[table];
      const sequenceName = `${table}_${key}_seq_it`;
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequenceName)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${identifier(key)} SET DEFAULT nextval('${schemaName}.${sequenceName}'::regclass)`,
      );
    }
  });
}

async function withSchema<T>(
  db: DbClient,
  schemaName: string,
  callback: (container: Container) => Promise<T>,
): Promise<T> {
  return withTx(createContainerFromDb(db), async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schemaName)}`));
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    return callback(createContainerFromDb(tx));
  });
}

function category(
  id: number,
  cateName: string,
  pid = 0,
  path = "",
  level = 0,
  type = 0,
  relationId = 0,
) {
  return {
    id,
    pid,
    type,
    relationId,
    cateName,
    path,
    level,
    pic: "",
    bigPic: "",
    sort: 0,
    isShow: 1,
    addTime: 1,
  };
}

async function seed(container: Container): Promise<void> {
  await container.db.insert(outInterface).values([
    { id: 900, pid: 0, type: 1, name: "创建分类", method: "POST", url: "/outapi/category", isDel: 0 },
    { id: 901, pid: 0, type: 1, name: "修改分类", method: "PUT", url: "/category/<id>", isDel: 0 },
    { id: 902, pid: 0, type: 1, name: "删除分类", method: "DELETE", url: "/category/:id", isDel: 0 },
    { id: 903, pid: 0, type: 1, name: "分类显隐", method: "PUT", url: "/category/set_show/{id}/{is_show}", isDel: 0 },
    { id: 904, pid: 0, type: 1, name: "创建商品", method: "POST", url: "/product", isDel: 0 },
  ]);
  await container.db.insert(storeProductCategory).values([
    category(100, "树A"),
    category(101, "树A-子", 100, "100", 1),
    category(102, "树A-孙", 101, "100,101", 2),
    category(200, "树B"),
    category(300, "新关联引用"),
    category(301, "CSV引用"),
    category(302, "旧类目引用"),
    category(303, "类目品牌引用"),
    category(304, "安全删除"),
    category(305, "仅回收商品引用"),
    category(306, "跨租户商品引用"),
    category(310, "有子类"),
    category(311, "有子类-子", 310, "310", 1),
    category(400, "供应商类目", 0, "", 0, 2, 9),
    category(777, "回滚目标"),
  ]);
  await container.db.insert(storeProduct).values([
    { id: 500, type: 0, relationId: 0, storeName: "relation", cateId: "300", stock: 10, isDel: 0 },
    { id: 501, type: 0, relationId: 0, storeName: "csv", cateId: "2, 301,99", stock: 10, isDel: 0 },
    { id: 502, type: 0, relationId: 0, storeName: "legacy", cateId: "", stock: 10, isDel: 0 },
    { id: 503, type: 0, relationId: 0, storeName: "brand", cateId: "", stock: 10, isDel: 0 },
    { id: 504, type: 0, relationId: 0, storeName: "recycled", cateId: "305", stock: 10, isDel: 1 },
    { id: 505, type: 2, relationId: 9, storeName: "supplier reference", cateId: "306", stock: 10, isDel: 0 },
  ]);
  await container.db.insert(storeProductRelation).values([
    { id: 600, type: 1, productId: 500, relationId: 300, relationPid: 0, status: 1, addTime: 1 },
    { id: 601, type: 1, productId: 500, relationId: 101, relationPid: 100, status: 1, addTime: 1 },
    { id: 602, type: 1, productId: 500, relationId: 102, relationPid: 101, status: 1, addTime: 1 },
    { id: 603, type: 1, productId: 504, relationId: 305, relationPid: 0, status: 0, addTime: 1 },
  ]);
  await container.db.insert(storeProductCate).values({
    id: 700,
    productId: 502,
    cateId: 302,
    catePid: 0,
    status: 1,
    addTime: 1,
  });
  await container.db.insert(storeProductCategoryBrand).values({
    id: 800,
    productId: 503,
    cateId: 303,
    brandId: 1,
    brandName: "audit",
    status: 1,
    addTime: 1,
  });
}

const IDENTITY: AuthenticatedOutAccount = {
  id: 1,
  appid: "out-category-audit",
  title: "Out category audit",
  rules: [900, 901, 902, 903],
};
const TEST_ENV = {} as Env;

function input(cateName: string, pid = 0, isShow = 1, sort = 0) {
  return {
    pid,
    cate_name: cateName,
    pic: "/uploads/audit.png",
    big_pic: "https://cdn.example.com/audit.png",
    sort,
    is_show: isShow,
  };
}

async function rejected(callback: () => Promise<unknown>, kind = ValidateException): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch (error) {
    return error instanceof kind;
  }
}

async function runScenario(container: Container, schemaName: string) {
  const service = new OutApiService(container, TEST_ENV);
  const acl = await withTx(container, async (tx) => {
    const scopedService = new OutApiService(createContainerFromDb(tx), TEST_ENV);
    let allowedRoutes = 0;
    for (const [method, route] of [
      ["POST", "/category"],
      ["PUT", "/category/{id}"],
      ["DELETE", "/category/{id}"],
      ["PUT", "/category/set_show/{id}/{is_show}"],
    ] as const) {
      await scopedService.assertInterfacePermission(IDENTITY, method, route);
      allowedRoutes += 1;
    }
    const productWriteRejected = await rejected(
      () => scopedService.assertInterfacePermission(IDENTITY, "POST", "/product"),
      AuthException,
    );
    return { allowedRoutes, productWriteRejected };
  });
  const first = await service.createCategory(IDENTITY, input("幂等创建", 0, 1, 8));
  const replay = await service.createCategory(IDENTITY, input("幂等创建", 0, 1, 8));
  const concurrent = await Promise.all([
    service.createCategory(IDENTITY, input("并发创建", 0, 1, 9)),
    service.createCategory(IDENTITY, input("并发创建", 0, 1, 9)),
  ]);
  const conflictingSibling = await rejected(() =>
    service.createCategory(IDENTITY, input("幂等创建", 0, 1, 99))
  );
  const descendantCycle = await rejected(() =>
    service.updateCategory(IDENTITY, 100, input("树A", 102))
  );
  const fourthLevel = await rejected(() =>
    service.createCategory(IDENTITY, input("第四级", 102))
  );

  const moved = await service.updateCategory(IDENTITY, 101, input("树A-子", 200));
  const moveReplay = await service.updateCategory(IDENTITY, 101, input("树A-子", 200));
  const movedState = await withTx(container, async (tx) => ({
    categories: await tx
      .select({ id: storeProductCategory.id, pid: storeProductCategory.pid, path: storeProductCategory.path, level: storeProductCategory.level })
      .from(storeProductCategory)
      .where(sql`${storeProductCategory.id} IN (101, 102)`),
    relations: await tx
      .select({ relationId: storeProductRelation.relationId, relationPid: storeProductRelation.relationPid })
      .from(storeProductRelation)
      .where(sql`${storeProductRelation.relationId} IN (101, 102)`),
  }));
  const movedById = new Map(movedState.categories.map((row) => [row.id, row]));
  const movedRelations = movedState.relations;
  const relationByCategory = new Map(movedRelations.map((row) => [row.relationId, row.relationPid]));

  const schema = identifier(schemaName);
  await container.db.execute(sql.raw(
    `ALTER TABLE ${schema}."store_product_relation"
       ADD CONSTRAINT "out_category_relation_failure_probe"
       CHECK ("relation_pid" <> 777) NOT VALID`,
  ));
  let rollbackFailed = false;
  try {
    await service.updateCategory(IDENTITY, 101, input("树A-子", 777));
  } catch {
    rollbackFailed = true;
  } finally {
    await container.db.execute(sql.raw(
      `ALTER TABLE ${schema}."store_product_relation"
       DROP CONSTRAINT "out_category_relation_failure_probe"`,
    ));
  }
  const afterRollback = await withTx(container, async (tx) => tx
    .select({ pid: storeProductCategory.pid, path: storeProductCategory.path })
    .from(storeProductCategory)
    .where(eq(storeProductCategory.id, 101)));

  const hidden = await service.setCategoryShow(IDENTITY, 200, 0);
  const hiddenReplay = await service.setCategoryShow(IDENTITY, 200, 0);
  const showRows = await withTx(container, async (tx) => tx
    .select({ id: storeProductCategory.id, isShow: storeProductCategory.isShow })
    .from(storeProductCategory)
    .where(sql`${storeProductCategory.id} IN (200, 101, 102)`));
  const showById = new Map(showRows.map((row) => [row.id, row.isShow]));

  const childDelete = await rejected(() => service.deleteCategory(IDENTITY, 310));
  const relationDelete = await rejected(() => service.deleteCategory(IDENTITY, 300));
  const csvDelete = await rejected(() => service.deleteCategory(IDENTITY, 301));
  const legacyCateDelete = await rejected(() => service.deleteCategory(IDENTITY, 302));
  const categoryBrandDelete = await rejected(() => service.deleteCategory(IDENTITY, 303));
  const supplierProductDelete = await rejected(() => service.deleteCategory(IDENTITY, 306));
  const deletedSafe = await service.deleteCategory(IDENTITY, 304);
  const deletedReplay = await service.deleteCategory(IDENTITY, 304);
  const recycledSafe = await service.deleteCategory(IDENTITY, 305);
  const supplierProtected = await rejected(
    () => service.deleteCategory(IDENTITY, 400),
    NotFoundException,
  );
  const createdCount = await withTx(container, async (tx) => tx
    .select({ count: sql<number>`count(*)::integer` })
    .from(storeProductCategory)
    .where(and(
      eq(storeProductCategory.type, 0),
      sql`${storeProductCategory.cateName} IN ('幂等创建', '并发创建')`,
    )));
  const createdRowCount = Number(createdCount[0]?.count ?? -1);
  const concurrentObservation = {
    idempotent: concurrent.map((row) => row.idempotent),
    ids: concurrent.map((row) => row.id),
    row_count: createdRowCount,
  };

  return {
    category_acl_routes_allowed: acl.allowedRoutes === 4,
    unpermissioned_product_write_rejected: acl.productWriteRejected,
    create_first_changed: !first.idempotent,
    create_replay_converged: replay.idempotent && replay.id === first.id,
    concurrent_create_single_row: concurrent.filter((row) => row.idempotent).length === 1
      && concurrent[0].id === concurrent[1].id && createdRowCount === 2,
    concurrent_create_observation: concurrentObservation,
    conflicting_sibling_rejected: conflictingSibling,
    descendant_cycle_rejected: descendantCycle,
    fourth_level_rejected: fourthLevel,
    move_updated_descendants: !moved.idempotent
      && movedById.get(101)?.pid === 200 && movedById.get(101)?.path === "200"
      && movedById.get(101)?.level === 1 && movedById.get(102)?.path === "200,101"
      && movedById.get(102)?.level === 2,
    move_repaired_relation_parent: relationByCategory.get(101) === 200
      && relationByCategory.get(102) === 101,
    move_replay_converged: moveReplay.idempotent,
    move_rollback_atomic: rollbackFailed
      && afterRollback[0]?.pid === 200 && afterRollback[0]?.path === "200",
    show_cascaded_direct_children: !hidden.idempotent
      && showById.get(200) === 0 && showById.get(101) === 0 && showById.get(102) === 1,
    show_replay_converged: hiddenReplay.idempotent,
    child_delete_rejected: childDelete,
    relation_delete_rejected: relationDelete,
    csv_delete_rejected: csvDelete,
    legacy_cate_delete_rejected: legacyCateDelete,
    category_brand_delete_rejected: categoryBrandDelete,
    supplier_product_reference_rejected: supplierProductDelete,
    safe_delete_replay_converged: !deletedSafe.idempotent && deletedReplay.idempotent,
    deleted_product_reference_ignored: !recycledSafe.idempotent,
    supplier_scope_protected: supplierProtected,
  };
}

export async function runOutApiCategoryPostgresScenario(
  connectionString: string,
): Promise<OutApiCategoryPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_category_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 4, {
    searchPath: schemaName,
    applicationName: "cinashop_out_category_scenario",
  });
  let created = false;
  let removed = false;
  let prefixCount = -1;
  let before: Fingerprint | undefined;
  let after: Fingerprint | undefined;
  let result: Awaited<ReturnType<typeof runScenario>> | undefined;
  let serverVersion = "unknown";
  try {
    const versions = await root.$client<{ server_version: string }[]>`
      SELECT current_setting('server_version') AS server_version
    `;
    serverVersion = versions[0]?.server_version ?? "unknown";
    before = await fingerprint(root);
    await setupSchema(root, schemaName);
    created = true;
    await withSchema(scoped, schemaName, seed);
    result = await runScenario(createContainerFromDb(scoped), schemaName);
  } finally {
    try {
      if (created) {
        await root.$client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '3s'`;
          await tx`SET LOCAL statement_timeout = '20s'`;
          await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        });
      }
      const state = await root.$client<{ schema_removed: boolean; prefix_count: number }[]>`
        SELECT to_regnamespace(${schemaName}) IS NULL AS schema_removed,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_category_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      prefixCount = state[0]?.prefix_count ?? -1;
      after = await fingerprint(root);
    } finally {
      await Promise.all([root.$client.end({ timeout: 1 }), scoped.$client.end({ timeout: 1 })]);
    }
  }

  assertCondition(result, "scenario report was not produced");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  for (const [name, passed] of Object.entries(result)) {
    if (name === "concurrent_create_observation") continue;
    assertCondition(
      passed,
      `${name} did not pass; concurrency=${JSON.stringify(result.concurrent_create_observation)}`,
    );
  }
  assertCondition(removed && prefixCount === 0, "temporary schema cleanup failed");
  assertCondition(unchanged, "public product/category tables or sequences changed");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    ...result,
  };
}
