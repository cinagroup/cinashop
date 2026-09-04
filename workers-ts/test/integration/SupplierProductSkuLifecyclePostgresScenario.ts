import { and, eq } from "drizzle-orm";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
  withTx,
} from "@/lib/di";
import {
  storeCart,
  storeProduct,
  storeProductAttrValue,
  storeProductCategory,
  storeProductSkuRetirementLog,
  storeProductStockRecord,
  systemLog,
} from "@/models/schema";
import { ProductAssociationService } from "@/services/product/ProductAssociationService";
import {
  ProductSkuRetirementService,
  supplierProductSkuScope,
} from "@/services/product/ProductSkuRetirementService";
import { VirtualProductInventoryService } from "@/services/product/VirtualProductInventoryService";
import { SupplierProductManagementService } from "@/services/supplier/SupplierProductManagementService";

const PREFIX = "codex_supplier_sku_";
const TABLES = [
  "store_product",
  "store_product_category",
  "shipping_templates",
  "store_product_relation",
  "store_product_description",
  "store_product_attr",
  "store_product_attr_result",
  "store_product_attr_value",
  "store_product_stock_record",
  "store_product_sku_retirement_log",
  "store_cart",
  "store_order",
  "store_order_cart_info",
  "store_product_reply",
  "store_product_virtual",
  "store_promotions",
  "store_promotions_auxiliary",
  "luck_prize",
  "store_branch_product_attr_value",
  "store_seckill",
  "store_bargain",
  "store_combination",
  "store_integral",
  "store_discounts_products",
  "store_newcomer",
  "system_log",
] as const;

const FINGERPRINT_TABLES = TABLES;

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function schemaName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return PREFIX + [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function publicState(db: DbClient) {
  const tableFingerprints: Record<string, { rows: number; digest: string }> = {};
  for (const table of FINGERPRINT_TABLES) {
    const rows = await db.$client.unsafe<Array<{ rows: number; digest: string }>>(`
      SELECT
        count(*)::integer AS rows,
        md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY to_jsonb(t)::text), '')) AS digest
      FROM public.${identifier(table)} t
    `);
    tableFingerprints[table] = rows[0] ?? { rows: 0, digest: "" };
  }
  const sequenceRows = await db.$client<Array<{ digest: string }>>`
    SELECT md5(COALESCE(string_agg(
      sequencename || ':' || COALESCE(last_value::text, 'null'),
      ',' ORDER BY sequencename
    ), '')) AS digest
    FROM pg_sequences
    WHERE schemaname = 'public'
      AND sequencename LIKE ANY (ARRAY[
        'store_product%', 'store_cart%', 'system_log%'
      ])
  `;
  const schemaRows = await db.$client<Array<{ value: number }>>`
    SELECT count(*)::integer AS value
    FROM pg_namespace
    WHERE nspname LIKE ${`${PREFIX}%`}
  `;
  return {
    tables: tableFingerprints,
    sequence_digest: sequenceRows[0]?.digest ?? "",
    temporary_schemas: Number(schemaRows[0]?.value ?? 0),
  };
}

async function provision(db: DbClient, schema: string): Promise<void> {
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`CREATE SCHEMA ${identifier(schema)}`);
    for (const table of TABLES) {
      await tx.unsafe(
        `CREATE TABLE ${identifier(schema)}.${identifier(table)} `
        + `(LIKE public.${identifier(table)} INCLUDING ALL)`,
      );
      const idColumns = await tx<Array<{ data_type: string }>>`
        SELECT data_type
        FROM information_schema.columns
        WHERE table_schema = ${schema}
          AND table_name = ${table}
          AND column_name = 'id'
          AND data_type IN ('integer', 'bigint')
      `;
      if (idColumns.length) {
        const sequence = `${table}_isolated_id_seq`;
        await tx.unsafe(`CREATE SEQUENCE ${identifier(schema)}.${identifier(sequence)}`);
        await tx.unsafe(
          `ALTER SEQUENCE ${identifier(schema)}.${identifier(sequence)} `
          + `OWNED BY ${identifier(schema)}.${identifier(table)}."id"`,
        );
        await tx.unsafe(
          `ALTER TABLE ${identifier(schema)}.${identifier(table)} ALTER COLUMN "id" `
          + `SET DEFAULT nextval('${schema}.${sequence}'::regclass)`,
        );
      }
    }
  });
}

async function dropSchema(db: DbClient, schema: string): Promise<void> {
  await db.$client.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '3s'`;
    await tx`SET LOCAL statement_timeout = '30s'`;
    await tx.unsafe(`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`);
  });
}

async function withIsolatedContainer<T>(
  db: DbClient,
  callback: (container: ReturnType<typeof createContainerFromDb>) => Promise<T>,
): Promise<T> {
  return withTx(createContainerFromDb(db), async (tx) =>
    callback(createContainerFromDb(tx))
  );
}

function productPayload(
  colors: readonly string[],
  stock: Readonly<Record<string, number>>,
  uniques: Readonly<Record<string, string>> = {},
) {
  return {
    product_type: 0,
    store_name: "Isolated supplier SKU lifecycle fixture",
    store_info: "isolated PostgreSQL verification only",
    cate_id: [41],
    slider_image: ["https://example.com/audit-product.png"],
    spec_type: 1,
    items: [{ value: "颜色", detail: [...colors] }],
    attrs: colors.map((color) => ({
      unique: uniques[color],
      detail: { 颜色: color },
      image: "",
      price: "19.90",
      settle_price: "11.20",
      cost: "9.00",
      ot_price: "25.00",
      vip_price: "18.00",
      stock: stock[color] ?? 0,
      bar_code: "",
      weight: "0.10",
      volume: "0.00",
      brokerage: "1.00",
      brokerage_two: "0.50",
      code: `AUDIT-${color}`,
    })),
    freight: 1,
    postage: "0.00",
    temp_id: 0,
    is_postage: 1,
    is_support_refund: 1,
    is_limit: 0,
    sort: 0,
    ficti: 0,
    description: "isolated fixture",
  };
}

function supplierVirtualProductPayload(
  cardStock: number,
  cardDiskInfo: string,
  fixedStock: number,
  fixedDiskInfo: string,
  uniques: Readonly<Record<string, string>> = {},
) {
  return {
    product_type: 1,
    store_name: "Isolated supplier virtual product fixture",
    store_info: "isolated PostgreSQL verification only",
    cate_id: [41],
    slider_image: ["https://example.com/audit-supplier-virtual-product.png"],
    unit_name: "份",
    spec_type: 1,
    items: [{ value: "交付", detail: ["一次性卡密", "固定内容"] }],
    attrs: [
      {
        unique: uniques["一次性卡密"],
        detail: { 交付: "一次性卡密" },
        price: "19.90",
        settle_price: "11.20",
        cost: "9.00",
        ot_price: "25.00",
        vip_price: "18.00",
        stock: cardStock,
        disk_info: cardDiskInfo,
        brokerage: "1.00",
        brokerage_two: "0.50",
        code: "AUDIT-SUPPLIER-CARD",
      },
      {
        unique: uniques["固定内容"],
        detail: { 交付: "固定内容" },
        price: "29.90",
        settle_price: "17.20",
        cost: "10.00",
        ot_price: "35.00",
        vip_price: "28.00",
        stock: fixedStock,
        disk_info: fixedDiskInfo,
        brokerage: "1.00",
        brokerage_two: "0.50",
        code: "AUDIT-SUPPLIER-FIXED",
      },
    ],
    freight: 3,
    postage: "9.90",
    temp_id: 0,
    is_postage: 0,
    is_support_refund: 1,
    is_limit: 0,
    sort: 0,
    ficti: 0,
    description: "isolated supplier virtual fixture",
  };
}

function adminVirtualProductPayload(
  cardStock: number,
  cardDiskInfo: string,
  fixedStock: number,
  fixedDiskInfo: string,
  uniques: Readonly<Record<string, string>> = {},
) {
  return {
    product_type: 1,
    store_name: "Isolated admin virtual product fixture",
    store_info: "isolated PostgreSQL verification only",
    image: "https://example.com/audit-virtual-product.png",
    cate_id: [42],
    brand_id: [],
    store_label_id: [],
    ensure_id: [],
    specs_id: 0,
    specs: [],
    unit_name: "份",
    spec_type: 1,
    items: [{ value: "交付", detail: ["一次性卡密", "固定内容"] }],
    attrs: [
      {
        unique: uniques["一次性卡密"],
        detail: { 交付: "一次性卡密" },
        price: "19.90",
        cost: "9.00",
        ot_price: "25.00",
        vip_price: "18.00",
        stock: cardStock,
        disk_info: cardDiskInfo,
        code: "AUDIT-VIRTUAL-CARD",
      },
      {
        unique: uniques["固定内容"],
        detail: { 交付: "固定内容" },
        price: "29.90",
        cost: "10.00",
        ot_price: "35.00",
        vip_price: "28.00",
        stock: fixedStock,
        disk_info: fixedDiskInfo,
        code: "AUDIT-VIRTUAL-FIXED",
      },
    ],
  };
}

async function rejected(promise: Promise<unknown>, message: string): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(message);
  }
}

export async function runSupplierProductSkuLifecyclePostgresScenario(connectionString: string) {
  const root = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_supplier_sku_root",
  });
  const schema = schemaName();
  const before = await publicState(root).catch(async (error) => {
    await root.$client.end({ timeout: 1 });
    throw error;
  });
  let isolated: DbClient | undefined;
  let scenario: Record<string, unknown> | undefined;
  let cleanupSucceeded = false;
  try {
    await provision(root, schema);
    isolated = createDbFromConnectionString(connectionString, 2, {
      searchPath: schema,
      applicationName: "cinashop_supplier_sku_isolated",
    });
    const container = createContainerFromDb(isolated);
    await withIsolatedContainer(isolated, async (scoped) => {
      await scoped.db.insert(storeProductCategory).values([
        {
          id: 41,
          pid: 0,
          type: 2,
          relationId: 101,
          cateName: "Isolated supplier category",
          path: "",
          level: 0,
          isShow: 1,
          addTime: Math.floor(Date.now() / 1_000),
        },
        {
          id: 42,
          pid: 0,
          type: 0,
          relationId: 0,
          cateName: "Isolated admin category",
          path: "",
          level: 0,
          isShow: 1,
          addTime: Math.floor(Date.now() / 1_000),
        },
      ]);
    });

    const products = new SupplierProductManagementService(container);
    const retirement = new ProductSkuRetirementService(container);
    const actor = { id: 901, name: "isolated-supplier-admin", ip: "127.0.0.1" };
    const owner = supplierProductSkuScope(101);

    const created = await products.saveProduct(
      101,
      0,
      productPayload(["red", "blue"], { red: 5, blue: 7 }),
    );
    const readProduct = () => withIsolatedContainer(isolated!, (scoped) =>
      new SupplierProductManagementService(scoped).productDetail(101, created.id)
    );
    const first = await readProduct();
    const firstBySuk = new Map(first.attrs.map((row) => [row.suk, row]));
    const firstIds = Object.fromEntries(first.attrs.map((row) => [row.suk, Number(row.id)]));
    const firstUniques = Object.fromEntries(first.attrs.map((row) => [row.suk, String(row.unique)]));

    await products.saveProduct(
      101,
      created.id,
      productPayload(["red", "blue", "green"], { red: 6, blue: 7, green: 4 }, firstUniques),
    );
    const expanded = await readProduct();
    const expandedBySuk = new Map(expanded.attrs.map((row) => [row.suk, row]));
    const stableAfterEdit = ["red", "blue"].every((suk) =>
      expandedBySuk.get(suk)?.id === firstBySuk.get(suk)?.id
      && expandedBySuk.get(suk)?.unique === firstBySuk.get(suk)?.unique,
    );
    const newSkuHasNewIdentity = Number(expandedBySuk.get("green")?.id ?? 0) > 0
      && Boolean(expandedBySuk.get("green")?.unique);

    const missingActiveRejected = await rejected(
      products.saveProduct(
        101,
        created.id,
        productPayload(["red", "blue"], { red: 6, blue: 7 }, firstUniques),
      ),
      "不能删除或重命名已有SKU",
    );

    const greenId = Number(expandedBySuk.get("green")?.id ?? 0);
    const greenUnique = String(expandedBySuk.get("green")?.unique ?? "");
    const retired = await retirement.change(
      "retire",
      { product_id: created.id, sku_ids: [greenId], reason: "隔离测试退役" },
      actor,
      owner,
    );
    const afterRetire = await readProduct();

    const activeUniques = Object.fromEntries(afterRetire.attrs.map((row) => [row.suk, String(row.unique)]));
    await products.saveProduct(
      101,
      created.id,
      productPayload(["red", "blue"], { red: 8, blue: 7 }, activeUniques),
    );
    const afterRetiredSave = await readProduct();
    const retiredPreserved = afterRetiredSave.retired_attrs.length === 1
      && afterRetiredSave.retired_attrs[0]?.id === greenId
      && afterRetiredSave.retired_attrs[0]?.unique === greenUnique;

    const ordinaryRestoreRejected = await rejected(
      products.saveProduct(
        101,
        created.id,
        productPayload(
          ["red", "blue", "green"],
          { red: 8, blue: 7, green: 4 },
          { ...activeUniques, green: greenUnique },
        ),
      ),
      "退役SKU不能通过普通保存恢复",
    );
    const crossTenantRejected = await rejected(
      retirement.change(
        "retire",
        { product_id: created.id, sku_ids: [firstIds.red], reason: "跨租户测试" },
        actor,
        supplierProductSkuScope(202),
      ),
      "商品不存在或不属于当前供应商",
    );

    await withIsolatedContainer(isolated, async (scoped) => {
      await scoped.db.insert(storeCart).values({
        uid: 7001,
        type: 0,
        productId: created.id,
        productType: 0,
        productAttrUnique: firstUniques.blue,
        cartNum: 1,
        addTime: Math.floor(Date.now() / 1_000),
        isPay: 0,
        isDel: 0,
        status: 1,
      });
    });
    const blueId = Number(afterRetiredSave.attrs.find((row) => row.suk === "blue")?.id ?? 0);
    const openCartBlocked = await rejected(
      retirement.change(
        "retire",
        { product_id: created.id, sku_ids: [blueId], reason: "购物车阻断测试" },
        actor,
        owner,
      ),
      "未结购物车1",
    );

    const restored = await retirement.change(
      "restore",
      { product_id: created.id, sku_ids: [greenId], reason: "隔离测试恢复" },
      actor,
      owner,
    );
    const virtualInventory = new VirtualProductInventoryService(container);
    const supplierVirtualCreated = await products.saveProduct(
      101,
      0,
      supplierVirtualProductPayload(0, "", 5, "https://download.example/supplier-v1"),
    );
    const readSupplierVirtualProduct = () => withIsolatedContainer(isolated!, (scoped) =>
      new SupplierProductManagementService(scoped).productDetail(101, supplierVirtualCreated.id)
    );
    const supplierVirtualFirst = await readSupplierVirtualProduct();
    const supplierCardRow = supplierVirtualFirst.attrs.find((row) => !row.disk_info?.trim());
    const supplierFixedRow = supplierVirtualFirst.attrs.find((row) => row.disk_info?.trim());
    if (!supplierCardRow?.id || !supplierCardRow.unique || !supplierFixedRow?.unique) {
      throw new Error("isolated Supplier virtual SKU modes were not persisted");
    }
    const supplierVirtualUniques = {
      "一次性卡密": String(supplierCardRow.unique),
      "固定内容": String(supplierFixedRow.unique),
    };
    const supplierCardUnique = String(supplierCardRow.unique);
    const supplierFixedUnique = String(supplierFixedRow.unique);
    const supplierInventoryImport = await virtualInventory.importCards(
      { kind: "supplier", supplierId: 101 },
      supplierVirtualCreated.id,
      {
        attr_unique: supplierCardUnique,
        cards: [
          { card_no: "SUPPLIER-CARD-1", card_pwd: "SUPPLIER-PWD-1" },
          { card_no: "SUPPLIER-CARD-2", card_pwd: "SUPPLIER-PWD-2" },
        ],
      },
    );
    const supplierDirectSaveRejected = await rejected(
      products.saveProduct(
        101,
        supplierVirtualCreated.id,
        supplierVirtualProductPayload(
          3,
          "",
          5,
          "https://download.example/supplier-v1",
          supplierVirtualUniques,
        ),
      ),
      "库存由未分配卡密数量维护",
    );
    const supplierStockBypassRejected = await rejected(
      products.adjustStock(101, supplierVirtualCreated.id, {
        attrs: [{ unique: supplierCardUnique, pm: 1, stock: 1 }],
      }),
      "请使用卡密库存导入",
    );
    const supplierFixedStockAdjusted = await products.adjustStock(101, supplierVirtualCreated.id, {
      attrs: [{ unique: supplierFixedUnique, pm: 1, stock: 1 }],
    });
    const supplierCardToFixedRejected = await rejected(
      products.saveProduct(
        101,
        supplierVirtualCreated.id,
        supplierVirtualProductPayload(
          2,
          "https://download.example/should-not-switch",
          6,
          "https://download.example/supplier-v1",
          supplierVirtualUniques,
        ),
      ),
      "已有关联卡密",
    );
    const supplierFixedToCardRejected = await rejected(
      products.saveProduct(
        101,
        supplierVirtualCreated.id,
        supplierVirtualProductPayload(2, "", 6, "", supplierVirtualUniques),
      ),
      "切换为卡密库存时库存必须为0",
    );
    const supplierFixedCardImportRejected = await rejected(
      virtualInventory.importCards(
        { kind: "supplier", supplierId: 101 },
        supplierVirtualCreated.id,
        {
          attr_unique: supplierFixedUnique,
          cards: [{ card_no: "SUPPLIER-FIXED-CARD", card_pwd: "SUPPLIER-FIXED-PWD" }],
        },
      ),
      "固定虚拟内容",
    );
    const supplierTypeChangeRejected = await rejected(
      products.saveProduct(
        101,
        supplierVirtualCreated.id,
        productPayload(["physical"], { physical: 1 }),
      ),
      "商品创建后不能修改履约类型",
    );
    const supplierCrossTenantRejected = await rejected(
      virtualInventory.inventory(
        { kind: "supplier", supplierId: 202 },
        supplierVirtualCreated.id,
        {},
      ),
      "商品不存在或不属于当前供应商",
    );
    await products.saveProduct(
      101,
      supplierVirtualCreated.id,
      supplierVirtualProductPayload(
        2,
        "",
        6,
        "https://download.example/supplier-v2",
        supplierVirtualUniques,
      ),
    );
    const supplierVirtualRetired = await retirement.change(
      "retire",
      {
        product_id: supplierVirtualCreated.id,
        sku_ids: [Number(supplierCardRow.id)],
        reason: "隔离测试退役卡密SKU",
      },
      actor,
      owner,
    );
    const supplierInventoryAfterRetire = await virtualInventory.inventory(
      { kind: "supplier", supplierId: 101 },
      supplierVirtualCreated.id,
      {},
    );
    const supplierRetiredImportRejected = await rejected(
      virtualInventory.importCards(
        { kind: "supplier", supplierId: 101 },
        supplierVirtualCreated.id,
        {
          attr_unique: supplierCardUnique,
          cards: [{ card_no: "RETIRED-CARD", card_pwd: "RETIRED-PWD" }],
        },
      ),
      "SKU不存在或不属于当前商品",
    );
    const supplierRetiredStockRejected = await rejected(
      products.adjustStock(101, supplierVirtualCreated.id, {
        attrs: [{ unique: supplierCardUnique, pm: 1, stock: 1 }],
      }),
      "部分SKU不存在或不属于当前商品",
    );
    const supplierVirtualRestored = await retirement.change(
      "restore",
      {
        product_id: supplierVirtualCreated.id,
        sku_ids: [Number(supplierCardRow.id)],
        reason: "隔离测试恢复卡密SKU",
      },
      actor,
      owner,
    );
    const supplierVirtualFinal = await readSupplierVirtualProduct();
    const supplierVirtualFinalByUnique = new Map(
      supplierVirtualFinal.attrs.map((row) => [row.unique, row]),
    );
    const supplierVirtualMainRows = await withIsolatedContainer(isolated, async (scoped) =>
      scoped.db.select({
        stock: storeProduct.stock,
        productType: storeProduct.productType,
        freight: storeProduct.freight,
        postage: storeProduct.postage,
        tempId: storeProduct.tempId,
      }).from(storeProduct).where(eq(storeProduct.id, supplierVirtualCreated.id)).limit(1)
    );

    const finalDetail = await readProduct();
    const adminProducts = new ProductAssociationService(container);
    const virtualCreated = await adminProducts.save(
      0,
      adminVirtualProductPayload(0, "", 5, "https://download.example/checkout-v1"),
      actor,
    );
    const readAdminVirtualProduct = () => withIsolatedContainer(isolated!, (scoped) =>
      new ProductAssociationService(scoped).detail(virtualCreated.id)
    );
    const virtualFirst = await readAdminVirtualProduct();
    const cardRow = virtualFirst.attrs.find((row) => !row.disk_info?.trim());
    const fixedRow = virtualFirst.attrs.find((row) => row.disk_info?.trim());
    if (!cardRow?.unique || !fixedRow?.unique) {
      throw new Error(`isolated Admin virtual SKU modes were not persisted: ${JSON.stringify(
        virtualFirst.attrs.map((row) => ({
          suk: row.suk,
          unique: row.unique,
          disk_info: row.disk_info,
          stock: row.stock,
        })),
      )}`);
    }
    const virtualUniques = {
      "一次性卡密": String(cardRow.unique),
      "固定内容": String(fixedRow.unique),
    };
    const cardUnique = String(cardRow.unique);
    const fixedUnique = String(fixedRow.unique);
    const inventoryImport = await virtualInventory.importCards(
      { kind: "admin" },
      virtualCreated.id,
      {
        attr_unique: cardUnique,
        cards: [
          { card_no: "ADMIN-CARD-1", card_pwd: "ADMIN-PWD-1" },
          { card_no: "ADMIN-CARD-2", card_pwd: "ADMIN-PWD-2" },
        ],
      },
    );
    const directCardStockRejected = await rejected(
      adminProducts.save(
        virtualCreated.id,
        adminVirtualProductPayload(3, "", 5, "https://download.example/checkout-v1", virtualUniques),
        actor,
      ),
      "库存由未分配卡密数量维护",
    );
    const cardToFixedRejected = await rejected(
      adminProducts.save(
        virtualCreated.id,
        adminVirtualProductPayload(
          2,
          "https://download.example/should-not-switch",
          5,
          "https://download.example/checkout-v1",
          virtualUniques,
        ),
        actor,
      ),
      "已有关联卡密",
    );
    const fixedToCardRejected = await rejected(
      adminProducts.save(
        virtualCreated.id,
        adminVirtualProductPayload(2, "", 5, "", virtualUniques),
        actor,
      ),
      "切换为卡密库存时库存必须为0",
    );
    const fixedCardImportRejected = await rejected(
      virtualInventory.importCards(
        { kind: "admin" },
        virtualCreated.id,
        {
          attr_unique: fixedUnique,
          cards: [{ card_no: "FIXED-CARD", card_pwd: "FIXED-PWD" }],
        },
      ),
      "固定虚拟内容",
    );
    const productTypeChangeRejected = await rejected(
      adminProducts.save(virtualCreated.id, { product_type: 0 }, actor),
      "商品创建后不能修改履约类型",
    );
    const virtualUpdated = await adminProducts.save(
      virtualCreated.id,
      adminVirtualProductPayload(
        2,
        "",
        6,
        "https://download.example/checkout-v2",
        virtualUniques,
      ),
      actor,
    );
    const virtualFinal = await readAdminVirtualProduct();
    const virtualFinalByUnique = new Map(virtualFinal.attrs.map((row) => [row.unique, row]));
    const finalCardRow = virtualFinalByUnique.get(cardUnique);
    const finalFixedRow = virtualFinalByUnique.get(fixedUnique);
    const virtualStableIdentity = virtualFirst.attrs.every((row) =>
      virtualFinalByUnique.get(row.unique)?.id === row.id,
    );
    const virtualMainRows = await withIsolatedContainer(isolated, async (scoped) =>
      scoped.db.select({ stock: storeProduct.stock, productType: storeProduct.productType })
        .from(storeProduct).where(eq(storeProduct.id, virtualCreated.id)).limit(1)
    );
    const [logs, systemLogs, stockRows, persistedRows] = await withIsolatedContainer(
      isolated,
      async (scoped) => Promise.all([
        scoped.db.select().from(storeProductSkuRetirementLog)
          .where(eq(storeProductSkuRetirementLog.productId, created.id)),
        scoped.db.select().from(systemLog).where(eq(systemLog.type, "product")),
        scoped.db.select().from(storeProductStockRecord)
          .where(eq(storeProductStockRecord.productId, created.id)),
        scoped.db.select().from(storeProductAttrValue).where(and(
          eq(storeProductAttrValue.productId, created.id),
          eq(storeProductAttrValue.type, 0),
        )),
      ]),
    );

    scenario = {
      created_supplier_product: created.id > 0,
      initial_skus: first.attrs.length,
      expanded_skus: expanded.attrs.length,
      stable_identity_after_edit: stableAfterEdit,
      new_sku_has_new_identity: newSkuHasNewIdentity,
      missing_active_rejected: missingActiveRejected,
      retirement_verified: retired.verified && retired.changed === 1,
      retired_detail_split: afterRetire.attrs.length === 2 && afterRetire.retired_attrs.length === 1,
      save_with_retired_row_succeeded: retiredPreserved,
      ordinary_restore_rejected: ordinaryRestoreRejected,
      cross_tenant_rejected: crossTenantRejected,
      open_cart_blocked: openCartBlocked,
      restore_verified: restored.verified && restored.changed === 1,
      final_active_skus: finalDetail.attrs.length,
      final_retired_skus: finalDetail.retired_attrs.length,
      lifecycle_logs: logs.length,
      supplier_system_logs: systemLogs.filter((row) =>
        row.path.startsWith("/supplierapi/product/product/sku/")
      ).length,
      stock_history_rows: stockRows.length,
      supplier_stock_scope_verified: stockRows.length > 0
        && stockRows.every((row) => row.storeId === 101),
      persisted_skus: persistedRows.length,
      persisted_retired_skus: persistedRows.filter((row) => row.isRetired === 1).length,
      supplier_virtual_created:
        supplierVirtualCreated.id > 0
        && supplierVirtualFirst.product_type === 1,
      supplier_virtual_modes_persisted:
        supplierCardRow.disk_info === ""
        && supplierCardRow.stock === 0
        && supplierFixedRow.disk_info === "https://download.example/supplier-v1"
        && supplierFixedRow.stock === 5,
      supplier_virtual_forced_no_logistics:
        supplierVirtualMainRows[0]?.freight === 2
        && supplierVirtualMainRows[0]?.postage === "0.00"
        && supplierVirtualMainRows[0]?.tempId === 0,
      supplier_card_import_authoritative:
        supplierInventoryImport.inserted === 2
        && supplierInventoryImport.sku_stock === 2
        && supplierInventoryImport.product_stock === 7,
      supplier_direct_card_save_rejected: supplierDirectSaveRejected,
      supplier_stock_bypass_rejected: supplierStockBypassRejected,
      supplier_fixed_stock_adjusted: supplierFixedStockAdjusted.stock === 8,
      supplier_card_to_fixed_rejected: supplierCardToFixedRejected,
      supplier_fixed_to_card_rejected: supplierFixedToCardRejected,
      supplier_fixed_card_import_rejected: supplierFixedCardImportRejected,
      supplier_product_type_change_rejected: supplierTypeChangeRejected,
      supplier_virtual_cross_tenant_rejected: supplierCrossTenantRejected,
      supplier_virtual_retirement_verified:
        supplierVirtualRetired.verified
        && supplierVirtualRetired.changed === 1
        && supplierVirtualRetired.dependencies.virtual_inventory === 2,
      supplier_retired_inventory_hidden:
        supplierInventoryAfterRetire.skus.length === 1
        && supplierInventoryAfterRetire.skus[0]?.unique === supplierFixedUnique,
      supplier_retired_import_rejected: supplierRetiredImportRejected,
      supplier_retired_stock_rejected: supplierRetiredStockRejected,
      supplier_virtual_restore_verified:
        supplierVirtualRestored.verified && supplierVirtualRestored.changed === 1,
      supplier_virtual_final_readback:
        supplierVirtualFinalByUnique.get(supplierCardUnique)?.stock === 2
        && supplierVirtualFinalByUnique.get(supplierCardUnique)?.disk_info === ""
        && supplierVirtualFinalByUnique.get(supplierFixedUnique)?.stock === 6
        && supplierVirtualFinalByUnique.get(supplierFixedUnique)?.disk_info
          === "https://download.example/supplier-v2"
        && supplierVirtualMainRows[0]?.stock === 8
        && supplierVirtualMainRows[0]?.productType === 1,
      admin_virtual_created: virtualCreated.sku_verified && virtualFirst.product_type === 1,
      admin_virtual_modes_persisted:
        cardRow.disk_info === ""
        && cardRow.stock === 0
        && fixedRow.disk_info === "https://download.example/checkout-v1"
        && fixedRow.stock === 5,
      card_import_authoritative:
        inventoryImport.inserted === 2
        && inventoryImport.sku_stock === 2
        && inventoryImport.product_stock === 7,
      direct_card_stock_rejected: directCardStockRejected,
      card_to_fixed_rejected: cardToFixedRejected,
      fixed_to_card_rejected: fixedToCardRejected,
      fixed_card_import_rejected: fixedCardImportRejected,
      product_type_change_rejected: productTypeChangeRejected,
      admin_virtual_update_verified: virtualUpdated.sku_verified,
      admin_virtual_stable_identity: virtualStableIdentity,
      admin_virtual_final_readback:
        finalCardRow?.stock === 2
        && finalCardRow?.disk_info === ""
        && finalFixedRow?.stock === 6
        && finalFixedRow?.disk_info === "https://download.example/checkout-v2"
        && virtualMainRows[0]?.stock === 8
        && virtualMainRows[0]?.productType === 1,
    };

    const expectedTrue = [
      "created_supplier_product",
      "stable_identity_after_edit",
      "new_sku_has_new_identity",
      "missing_active_rejected",
      "retirement_verified",
      "retired_detail_split",
      "save_with_retired_row_succeeded",
      "ordinary_restore_rejected",
      "cross_tenant_rejected",
      "open_cart_blocked",
      "restore_verified",
      "supplier_stock_scope_verified",
      "supplier_virtual_created",
      "supplier_virtual_modes_persisted",
      "supplier_virtual_forced_no_logistics",
      "supplier_card_import_authoritative",
      "supplier_direct_card_save_rejected",
      "supplier_stock_bypass_rejected",
      "supplier_fixed_stock_adjusted",
      "supplier_card_to_fixed_rejected",
      "supplier_fixed_to_card_rejected",
      "supplier_fixed_card_import_rejected",
      "supplier_product_type_change_rejected",
      "supplier_virtual_cross_tenant_rejected",
      "supplier_virtual_retirement_verified",
      "supplier_retired_inventory_hidden",
      "supplier_retired_import_rejected",
      "supplier_retired_stock_rejected",
      "supplier_virtual_restore_verified",
      "supplier_virtual_final_readback",
      "admin_virtual_created",
      "admin_virtual_modes_persisted",
      "card_import_authoritative",
      "direct_card_stock_rejected",
      "card_to_fixed_rejected",
      "fixed_to_card_rejected",
      "fixed_card_import_rejected",
      "product_type_change_rejected",
      "admin_virtual_update_verified",
      "admin_virtual_stable_identity",
      "admin_virtual_final_readback",
    ];
    const failedAssertions = expectedTrue.filter((key) => scenario?.[key] !== true);
    if (failedAssertions.length) {
      throw new Error(`isolated Supplier SKU lifecycle assertion failed: ${failedAssertions.join(", ")}`);
    }
    if (
      scenario.final_active_skus !== 3
      || scenario.final_retired_skus !== 0
      || scenario.lifecycle_logs !== 2
      || scenario.supplier_system_logs !== 4
      || scenario.persisted_skus !== 3
      || scenario.persisted_retired_skus !== 0
    ) throw new Error("isolated Supplier SKU lifecycle readback failed");
  } finally {
    let cleanupFailure: unknown;
    if (isolated) {
      try {
        await isolated.$client.end({ timeout: 1 });
      } catch (error) {
        cleanupFailure = error;
      }
    }
    try {
      try {
        await dropSchema(root, schema);
        cleanupSucceeded = true;
      } catch (error) {
        cleanupFailure ??= error;
      }
      let after: Awaited<ReturnType<typeof publicState>> | undefined;
      try {
        after = await publicState(root);
      } catch (error) {
        cleanupFailure ??= error;
      }
      if (!after) throw cleanupFailure ?? new Error("isolated Supplier SKU cleanup state unavailable");
      const publicStateUnchanged = JSON.stringify(before.tables) === JSON.stringify(after.tables)
        && before.sequence_digest === after.sequence_digest;
      if (!cleanupSucceeded || after.temporary_schemas !== before.temporary_schemas) {
        throw new Error("isolated Supplier SKU schema cleanup failed");
      }
      if (!publicStateUnchanged) throw new Error("public state changed during isolated Supplier SKU audit");
      if (cleanupFailure) throw cleanupFailure;
      if (scenario) {
        scenario.cleanup_succeeded = cleanupSucceeded;
        scenario.temporary_schema_count_unchanged = true;
        scenario.public_state_unchanged = true;
      }
    } finally {
      await root.$client.end({ timeout: 1 });
    }
  }
  return scenario;
}
