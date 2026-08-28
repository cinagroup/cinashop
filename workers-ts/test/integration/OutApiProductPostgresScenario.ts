import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
  outProductWriteReplay,
  storeCart,
  storeProduct,
  storeProductAttrValue,
  storeProductCategory,
  storeProductRelation,
  storeProductStockRecord,
} from "@/models/schema";
import { MigrationService } from "@/services/MigrationService";
import { OutApiService, type AuthenticatedOutAccount } from "@/services/out/OutApiService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PUBLIC_TABLES = [
  "out_interface",
  "store_product_category",
  "store_product",
  "store_product_relation",
  "store_product_description",
  "store_product_attr",
  "store_product_attr_result",
  "store_product_attr_value",
  "store_product_stock_record",
  "store_cart",
] as const;

const SERIAL_KEYS: Partial<Record<(typeof PUBLIC_TABLES)[number], string>> = {
  out_interface: "id",
  store_product_category: "id",
  store_product: "id",
  store_product_relation: "id",
  store_product_attr: "id",
  store_product_attr_result: "id",
  store_product_attr_value: "id",
  store_product_stock_record: "id",
  store_cart: "id",
};

const PUBLIC_SEQUENCES = [
  "out_interface_id_seq",
  "store_product_category_id_seq",
  "store_product_id_seq",
  "store_product_relation_id_seq",
  "store_product_attr_id_seq",
  "store_product_attr_result_id_seq",
  "store_product_attr_value_id_seq",
  "store_product_stock_record_id_seq",
  "store_cart_id_seq",
] as const;

type Fingerprint = {
  tables: Record<string, { count: string; digest: string }>;
  sequences: Record<string, string | null>;
};

export interface OutApiProductPostgresReport {
  server_version: string;
  schema_created: boolean;
  schema_removed: boolean;
  temporary_schemas_after: number;
  public_state_unchanged: boolean;
  product_acl_routes_allowed: boolean;
  unpermissioned_coupon_write_rejected: boolean;
  create_concurrent_single_product: boolean;
  create_replay_converged: boolean;
  create_key_conflict_rejected: boolean;
  cross_tenant_create_rejected: boolean;
  specialized_product_rejected: boolean;
  update_preserved_stock_and_identity: boolean;
  sku_topology_change_rejected: boolean;
  update_replay_converged: boolean;
  update_rollback_atomic: boolean;
  show_cascaded_and_replayed: boolean;
  stock_absolute_update_atomic: boolean;
  stock_replay_converged: boolean;
  stock_new_key_converged_without_duplicate_record: boolean;
  supplier_barcode_collision_ignored: boolean;
  platform_barcode_ambiguity_rejected: boolean;
  missing_barcode_batch_rollback: boolean;
  supplier_product_detail_protected: boolean;
  replay_ledger_content_free: boolean;
  replay_observation: {
    create_ids: number[];
    create_idempotent: boolean[];
    replay_rows: number;
    stock_records: number;
  };
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Out product integration failed: ${message}`);
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function makeSchemaName(): string {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return `codex_out_product_${Date.now().toString(36)}_${random[0].toString(36)}`.slice(0, 63);
}

export async function fingerprintOutProductPublicState(db: DbClient): Promise<Fingerprint> {
  const tables: Fingerprint["tables"] = {};
  for (const table of PUBLIC_TABLES) {
    const rows = await db.$client.unsafe<Array<{ count: string; digest: string }>>(
      `SELECT count(*)::text AS count,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
       FROM public.${identifier(table)} t`,
    );
    assertCondition(rows[0], `could not fingerprint public.${table}`);
    tables[table] = rows[0];
  }
  const sequenceRows = await db.$client<Array<{ sequencename: string; last_value: string | null }>>`
    SELECT sequencename, last_value::text
    FROM pg_sequences
    WHERE schemaname = 'public' AND sequencename = ANY(${[...PUBLIC_SEQUENCES]})
    ORDER BY sequencename
  `;
  const map = new Map(sequenceRows.map((row) => [row.sequencename, row.last_value]));
  return {
    tables,
    sequences: Object.fromEntries(PUBLIC_SEQUENCES.map((name) => [name, map.get(name) ?? null])),
  };
}

async function setupSchema(db: DbClient, schemaName: string): Promise<void> {
  const schema = identifier(schemaName);
  const migrationSql = new MigrationService(createContainerFromDb(db))
    .outProductWriteReplayMigrationSqlForVerification();
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    for (const table of PUBLIC_TABLES) {
      const tableName = identifier(table);
      await tx.unsafe(`CREATE TABLE ${schema}.${tableName} (LIKE public.${tableName} INCLUDING ALL)`);
      const key = SERIAL_KEYS[table];
      if (!key) continue;
      const sequenceName = `${table}_${key}_seq_it`;
      await tx.unsafe(`CREATE SEQUENCE ${schema}.${identifier(sequenceName)}`);
      await tx.unsafe(
        `ALTER TABLE ${schema}.${tableName} ALTER COLUMN ${identifier(key)} SET DEFAULT nextval('${schemaName}.${sequenceName}'::regclass)`,
      );
    }
    await tx.unsafe(`SET LOCAL search_path TO ${schema}`);
    await tx.unsafe(migrationSql);
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

async function seed(container: Container): Promise<void> {
  await container.db.insert(outInterface).values([
    { id: 900, pid: 0, type: 1, name: "创建商品", method: "POST", url: "/outapi/product", isDel: 0 },
    { id: 901, pid: 0, type: 1, name: "修改商品", method: "PUT", url: "/product/<id>", isDel: 0 },
    { id: 902, pid: 0, type: 1, name: "商品显隐", method: "PUT", url: "/product/set_show/:id/:is_show", isDel: 0 },
    { id: 903, pid: 0, type: 1, name: "库存同步", method: "PUT", url: "/product/stock/upload", isDel: 0 },
    { id: 904, pid: 0, type: 1, name: "创建优惠券", method: "POST", url: "/coupon", isDel: 0 },
  ]);
  await container.db.insert(storeProductCategory).values([
    { id: 100, pid: 0, type: 0, relationId: 0, cateName: "平台类目", path: "", level: 0, isShow: 1, addTime: 1 },
    { id: 400, pid: 0, type: 2, relationId: 9, cateName: "供应商类目", path: "", level: 0, isShow: 1, addTime: 1 },
  ]);
  await container.db.insert(storeProduct).values([
    {
      id: 200,
      type: 2,
      relationId: 9,
      productType: 0,
      storeName: "供应商同条码商品",
      image: "/supplier.png",
      sliderImage: "[\"/supplier.png\"]",
      price: "10.00",
      stock: 5,
      isShow: 1,
      isVerify: 1,
      isDel: 0,
      addTime: 1,
    },
    {
      id: 201,
      type: 0,
      relationId: 0,
      productType: 1,
      storeName: "平台卡密商品",
      image: "/virtual.png",
      sliderImage: "[\"/virtual.png\"]",
      price: "10.00",
      stock: 1,
      isShow: 0,
      isVerify: 1,
      isDel: 0,
      addTime: 1,
    },
  ]);
  await container.db.insert(storeProductAttrValue).values({
    id: 300,
    productId: 200,
    productType: 0,
    suk: "默认",
    stock: 5,
    sumStock: 5,
    price: "10.00",
    image: "/supplier.png",
    unique: "SUPP0001",
    barCode: "OUT-SKU-001",
    type: 0,
  });
}

const IDENTITY: AuthenticatedOutAccount = {
  id: 7,
  appid: "out-product-audit",
  title: "Out product audit",
  rules: [900, 901, 902, 903],
};
const TEST_ENV = {} as Env;

function productInput(overrides: Record<string, unknown> = {}) {
  return {
    product_type: 0,
    supplier_id: 0,
    cate_id: [100],
    store_name: "Out 平台商品",
    store_info: "隔离审计",
    slider_image: ["https://cdn.example.com/out-product.png"],
    delivery_type: [1],
    freight: 1,
    spec_type: 0,
    is_show: 0,
    attrs: [{
      suk: "默认",
      price: "19.90",
      stock: 8,
      bar_code: "OUT-SKU-001",
      code: "OUT-001",
    }],
    ...overrides,
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

async function rejectedByDatabase(callback: () => Promise<unknown>): Promise<boolean> {
  try {
    await callback();
    return false;
  } catch (error) {
    return error instanceof Error && !(error instanceof ValidateException);
  }
}

async function runScenario(container: Container, schemaName: string) {
  const scenarioTx = async <T>(callback: (scoped: Container) => Promise<T>): Promise<T> =>
    withTx(container, async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO ${identifier(schemaName)}`));
      await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
      return callback(createContainerFromDb(tx));
    });
  const invoke = <T>(callback: (service: OutApiService) => Promise<T>): Promise<T> =>
    scenarioTx((scoped) => callback(new OutApiService(scoped, TEST_ENV)));

  const acl = await scenarioTx(async (scopedContainer) => {
    const scoped = new OutApiService(scopedContainer, TEST_ENV);
    let allowed = 0;
    for (const [method, route] of [
      ["POST", "/product"],
      ["PUT", "/product/{id}"],
      ["PUT", "/product/set_show/{id}/{is_show}"],
      ["PUT", "/product/stock/upload"],
    ] as const) {
      await scoped.assertInterfacePermission(IDENTITY, method, route);
      allowed += 1;
    }
    return { allowed };
  });
  // Permission failures are AuthException subclasses in production. Keep the
  // scenario focused on denial rather than coupling to the exact HTTP mapper.
  let couponRejected = false;
  try {
    await invoke((service) => service.assertInterfacePermission(IDENTITY, "POST", "/coupon"));
  } catch {
    couponRejected = true;
  }

  const createKey = "11111111-1111-4111-8111-111111111111";
  const concurrent = await Promise.all([
    invoke((service) => service.createProduct(IDENTITY, productInput(), createKey)),
    invoke((service) => service.createProduct(IDENTITY, productInput(), createKey)),
  ]);
  const productId = concurrent[0].id;
  const replay = await invoke((service) => service.createProduct(IDENTITY, productInput(), createKey));
  const keyConflict = await rejected(() =>
    invoke((service) => service.createProduct(IDENTITY, productInput({ store_name: "冲突商品" }), createKey))
  );
  const crossTenant = await rejected(() =>
    invoke((service) => service.createProduct(
      IDENTITY,
      productInput({ supplier_id: 9 }),
      "22222222-2222-4222-8222-222222222222",
    ))
  );
  const specialized = await rejected(() =>
    invoke((service) => service.createProduct(
      IDENTITY,
      productInput({ product_type: 1 }),
      "33333333-3333-4333-8333-333333333333",
    ))
  );

  await scenarioTx(async (scoped) => {
    await scoped.db.insert(storeCart).values({
      uid: 1,
      productId,
      productAttrUnique: "",
      cartNum: 1,
      status: 0,
      addTime: 1,
    });
  });
  const updateKey = "44444444-4444-4444-8444-444444444444";
  const updated = await invoke((service) => service.updateProduct(
    IDENTITY,
    productId,
    productInput({
      store_name: "Out 平台商品-已编辑",
      attrs: [{
        suk: "默认",
        price: "29.90",
        stock: 999,
        bar_code: "OUT-SKU-001",
        code: "OUT-EDIT",
      }],
    }),
    updateKey,
  ));
  const updateReplay = await invoke((service) => service.updateProduct(
    IDENTITY,
    productId,
    productInput({
      store_name: "Out 平台商品-已编辑",
      attrs: [{
        suk: "默认",
        price: "29.90",
        stock: 999,
        bar_code: "OUT-SKU-001",
        code: "OUT-EDIT",
      }],
    }),
    updateKey,
  ));
  const topologyRejected = await rejected(() => invoke((service) => service.updateProduct(
    IDENTITY,
    productId,
    productInput({
      spec_type: 1,
      items: [{ value: "颜色", detail: ["红", "蓝"] }],
      attrs: [
        { detail: { 颜色: "红" }, price: "29.90", stock: 8, bar_code: "OUT-RED" },
        { detail: { 颜色: "蓝" }, price: "29.90", stock: 8, bar_code: "OUT-BLUE" },
      ],
    }),
    "55555555-5555-4555-8555-555555555555",
  )));
  const afterUpdate = await scenarioTx(async (scoped) => ({
    product: (await scoped.db.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1))[0],
    sku: (await scoped.db.select().from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.productId, productId)).limit(1))[0],
  }));

  await scenarioTx(async (scoped) => {
    await scoped.db.execute(sql.raw(
      `ALTER TABLE "store_product_attr_result"
         ADD CONSTRAINT "out_product_result_failure_probe"
         CHECK ("result" NOT LIKE '%ROLLBACK-PROBE%') NOT VALID`,
    ));
  });
  const rollbackRejected = await rejectedByDatabase(() => invoke((service) => service.updateProduct(
    IDENTITY,
    productId,
    productInput({
      store_name: "不应提交的名称",
      attrs: [{
        suk: "默认",
        price: "39.90",
        stock: 8,
        bar_code: "OUT-SKU-001",
        code: "ROLLBACK-PROBE",
      }],
    }),
    "66666666-6666-4666-8666-666666666666",
  )));
  await scenarioTx(async (scoped) => {
    await scoped.db.execute(sql.raw(
      `ALTER TABLE "store_product_attr_result" DROP CONSTRAINT "out_product_result_failure_probe"`,
    ));
  });
  const afterRollback = await scenarioTx(async (scoped) => ({
    product: (await scoped.db.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1))[0],
    sku: (await scoped.db.select().from(storeProductAttrValue)
      .where(eq(storeProductAttrValue.productId, productId)).limit(1))[0],
    failedReplay: await scoped.db.select().from(outProductWriteReplay)
      .where(eq(outProductWriteReplay.requestKey, "66666666-6666-4666-8666-666666666666")),
  }));

  const showKey = "77777777-7777-4777-8777-777777777777";
  const shown = await invoke((service) => service.setProductShow(IDENTITY, productId, 1, showKey));
  const shownReplay = await invoke((service) => service.setProductShow(IDENTITY, productId, 1, showKey));
  const shownNewKey = await invoke((service) => service.setProductShow(
    IDENTITY,
    productId,
    1,
    "88888888-8888-4888-8888-888888888888",
  ));
  const showState = await scenarioTx(async (scoped) => ({
    product: (await scoped.db.select({ isShow: storeProduct.isShow, autoOffTime: storeProduct.autoOffTime })
      .from(storeProduct).where(eq(storeProduct.id, productId)).limit(1))[0],
    relation: (await scoped.db.select({ status: storeProductRelation.status }).from(storeProductRelation)
      .where(eq(storeProductRelation.productId, productId)).limit(1))[0],
    cart: (await scoped.db.select({ status: storeCart.status }).from(storeCart)
      .where(eq(storeCart.productId, productId)).limit(1))[0],
  }));

  const stockKey = "99999999-9999-4999-8999-999999999999";
  const stock = await invoke((service) => service.uploadProductStock(
    IDENTITY,
    { items: [{ bar_code: "OUT-SKU-001", qty: 12 }] },
    stockKey,
  ));
  const stockReplay = await invoke((service) => service.uploadProductStock(
    IDENTITY,
    { items: [{ bar_code: "OUT-SKU-001", qty: 12 }] },
    stockKey,
  ));
  const stockNewKey = await invoke((service) => service.uploadProductStock(
    IDENTITY,
    { items: [{ bar_code: "OUT-SKU-001", qty: 12 }] },
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ));
  const stockState = await scenarioTx(async (scoped) => ({
    product: (await scoped.db.select({ stock: storeProduct.stock, isSold: storeProduct.isSold })
      .from(storeProduct).where(eq(storeProduct.id, productId)).limit(1))[0],
    sku: (await scoped.db.select({ stock: storeProductAttrValue.stock, sumStock: storeProductAttrValue.sumStock })
      .from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, productId)).limit(1))[0],
    records: await scoped.db.select().from(storeProductStockRecord)
      .where(eq(storeProductStockRecord.productId, productId)),
  }));

  const beforeMissing = stockState.sku.stock;
  const missingRollback = await rejected(() => invoke((service) => service.uploadProductStock(
    IDENTITY,
    { items: [
      { bar_code: "OUT-SKU-001", qty: 13 },
      { bar_code: "MISSING-SKU", qty: 1 },
    ] },
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  )));
  const afterMissing = await scenarioTx(async (scoped) => scoped.db
    .select({ stock: storeProductAttrValue.stock })
    .from(storeProductAttrValue)
    .where(eq(storeProductAttrValue.productId, productId))
    .limit(1));

  await scenarioTx(async (scoped) => {
    await scoped.db.insert(storeProduct).values({
      id: 203,
      type: 0,
      relationId: 0,
      productType: 0,
      storeName: "重复平台条码商品",
      image: "/duplicate.png",
      sliderImage: "[\"/duplicate.png\"]",
      price: "10.00",
      stock: 1,
      isShow: 0,
      isVerify: 1,
      isDel: 0,
      addTime: 1,
    });
    await scoped.db.insert(storeProductAttrValue).values({
      id: 301,
      productId: 203,
      productType: 0,
      suk: "默认",
      stock: 1,
      sumStock: 1,
      price: "10.00",
      image: "/duplicate.png",
      unique: "DUPL0001",
      barCode: "OUT-SKU-001",
      type: 0,
    });
  });
  const ambiguousRejected = await rejected(() => invoke((service) => service.uploadProductStock(
    IDENTITY,
    { items: [{ bar_code: "OUT-SKU-001", qty: 14 }] },
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  )));
  const afterAmbiguous = await scenarioTx(async (scoped) => scoped.db
    .select({ productId: storeProductAttrValue.productId, stock: storeProductAttrValue.stock })
    .from(storeProductAttrValue)
    .where(and(
      inArray(storeProductAttrValue.productId, [productId, 203]),
      eq(storeProductAttrValue.barCode, "OUT-SKU-001"),
    ))
    .orderBy(asc(storeProductAttrValue.productId)));

  const supplierDetailProtected = await rejected(
    () => invoke((service) => service.productInfo(200)),
    NotFoundException,
  );
  const specializedUpdateRejected = await rejected(() => invoke((service) => service.updateProduct(
    IDENTITY,
    201,
    productInput(),
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  )));
  const ledger = await scenarioTx(async (scoped) => scoped.db
    .select()
    .from(outProductWriteReplay)
    .orderBy(asc(outProductWriteReplay.id)));
  const productRows = await scenarioTx(async (scoped) => scoped.db
    .select({ id: storeProduct.id })
    .from(storeProduct)
    .where(and(
      eq(storeProduct.type, 0),
      eq(storeProduct.relationId, 0),
      eq(storeProduct.storeName, "Out 平台商品-已编辑"),
    )));
  const ledgerSerialized = JSON.stringify(ledger);

  return {
    product_acl_routes_allowed: acl.allowed === 4,
    unpermissioned_coupon_write_rejected: couponRejected,
    create_concurrent_single_product: concurrent[0].id === concurrent[1].id
      && concurrent.filter((row) => row.idempotent).length === 1
      && productRows.length === 1,
    create_replay_converged: replay.id === productId && replay.idempotent,
    create_key_conflict_rejected: keyConflict,
    cross_tenant_create_rejected: crossTenant,
    specialized_product_rejected: specialized && specializedUpdateRejected,
    update_preserved_stock_and_identity: !updated.idempotent && updated.stock_preserved
      && afterUpdate.product?.stock === 8 && afterUpdate.product?.storeName === "Out 平台商品-已编辑"
      && afterUpdate.sku?.stock === 8 && afterUpdate.sku?.price === "29.90"
      && /^[0-9a-f]{8}$/.test(afterUpdate.sku?.unique ?? ""),
    sku_topology_change_rejected: topologyRejected,
    update_replay_converged: updateReplay.idempotent && updateReplay.stock_preserved,
    update_rollback_atomic: rollbackRejected && afterRollback.failedReplay.length === 0
      && afterRollback.product?.storeName === "Out 平台商品-已编辑"
      && afterRollback.sku?.price === "29.90" && afterRollback.sku?.code === "OUT-EDIT",
    show_cascaded_and_replayed: !shown.idempotent && shownReplay.idempotent && shownNewKey.idempotent
      && showState.product?.isShow === 1 && showState.product?.autoOffTime === 0
      && showState.relation?.status === 1 && showState.cart?.status === 1,
    stock_absolute_update_atomic: stock.updated === 1 && !stock.idempotent
      && stockState.product?.stock === 12 && stockState.product?.isSold === 0
      && stockState.sku?.stock === 12 && stockState.sku?.sumStock === 12
      && stockState.records.length === 1 && stockState.records[0].number === 4
      && stockState.records[0].pm === 1,
    stock_replay_converged: stockReplay.idempotent && stockReplay.updated === 1,
    stock_new_key_converged_without_duplicate_record: stockNewKey.idempotent && stockNewKey.updated === 0
      && stockState.records.length === 1,
    supplier_barcode_collision_ignored: stock.updated === 1,
    platform_barcode_ambiguity_rejected: ambiguousRejected
      && afterAmbiguous.find((row) => row.productId === productId)?.stock === 12
      && afterAmbiguous.find((row) => row.productId === 203)?.stock === 1,
    missing_barcode_batch_rollback: missingRollback && beforeMissing === 12 && afterMissing[0]?.stock === 12,
    supplier_product_detail_protected: supplierDetailProtected,
    replay_ledger_content_free: ledger.length === 6
      && ledger.every((row) => /^[0-9a-f]{64}$/.test(row.requestHash))
      && !ledgerSerialized.includes("Out 平台商品")
      && !ledgerSerialized.includes("OUT-SKU-001"),
    replay_observation: {
      create_ids: concurrent.map((row) => row.id),
      create_idempotent: concurrent.map((row) => row.idempotent),
      replay_rows: ledger.length,
      stock_records: stockState.records.length,
    },
  };
}

export async function runOutApiProductPostgresScenario(
  connectionString: string,
): Promise<OutApiProductPostgresReport> {
  const schemaName = makeSchemaName();
  const schema = identifier(schemaName);
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_out_product_root",
  });
  const scoped = createDbFromConnectionString(connectionString, 4, {
    searchPath: schemaName,
    applicationName: "cinashop_out_product_scenario",
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
    before = await fingerprintOutProductPublicState(root);
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
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_out_product_%') AS prefix_count
      `;
      removed = state[0]?.schema_removed === true;
      prefixCount = state[0]?.prefix_count ?? -1;
      after = await fingerprintOutProductPublicState(root);
    } finally {
      await Promise.all([root.$client.end({ timeout: 1 }), scoped.$client.end({ timeout: 1 })]);
    }
  }

  assertCondition(result, "scenario report was not produced");
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  for (const [name, passed] of Object.entries(result)) {
    if (name === "replay_observation") continue;
    assertCondition(passed, `${name} did not pass; replay=${JSON.stringify(result.replay_observation)}`);
  }
  assertCondition(removed && prefixCount === 0, "temporary schema cleanup failed");
  assertCondition(unchanged, "public product tables or sequences changed");
  return {
    server_version: serverVersion,
    schema_created: created,
    schema_removed: removed,
    temporary_schemas_after: prefixCount,
    public_state_unchanged: unchanged,
    ...result,
  };
}
