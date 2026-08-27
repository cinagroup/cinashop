import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { storeDiscounts, storeDiscountsProducts } from "../src/models/schema";
import {
  assembleDiscountPackages,
  isDiscountPackageAvailable,
  validateDiscountPackageSelection,
  type DiscountPackage,
  type DiscountPackageSelectionInput,
  type DiscountProductRow,
  type DiscountSku,
} from "../src/services/activity/StoreDiscountService";

function discount(overrides: Partial<DiscountPackage> = {}): DiscountPackage {
  return {
    id: 1,
    title: "套餐",
    image: "",
    type: 0,
    isLimit: 0,
    limitNum: 0,
    linkIds: "",
    productIds: "10,20",
    isTime: 0,
    startTime: 0,
    stopTime: 0,
    sort: 0,
    addTime: 0,
    freeShipping: 0,
    status: 1,
    isDel: 0,
    isSupportRefund: 1,
    deliveryType: "",
    freight: 2,
    customForm: null,
    ...overrides,
  };
}

function productRow(
  entryId: number,
  productId: number,
  overrides: Partial<NonNullable<DiscountProductRow["product"]>> = {},
  entryOverrides: Partial<DiscountProductRow["entry"]> = {},
): DiscountProductRow {
  return {
    entry: {
      id: entryId,
      discountId: 1,
      productId,
      productType: 0,
      title: `商品 ${productId}`,
      image: "",
      type: 0,
      tempId: 0,
      ...entryOverrides,
    },
    product: {
      id: productId,
      isDel: 0,
      isShow: 1,
      stock: 10,
      price: "0.00",
      ...overrides,
    },
  };
}

function sku(productId: number, suk: string, price: string, stock = 10): DiscountSku {
  return { productId, suk, price, stock };
}

describe("discount package migration", () => {
  it("preserves the install SQL table contracts without inventing runtime-only columns", () => {
    const packages = getTableColumns(storeDiscounts);
    const products = getTableColumns(storeDiscountsProducts);

    expect(Object.keys(packages)).toEqual([
      "id",
      "title",
      "image",
      "type",
      "isLimit",
      "limitNum",
      "linkIds",
      "productIds",
      "isTime",
      "startTime",
      "stopTime",
      "sort",
      "addTime",
      "freeShipping",
      "status",
      "isDel",
      "isSupportRefund",
      "deliveryType",
      "freight",
      "customForm",
    ]);
    expect(Object.keys(products)).toEqual([
      "id",
      "discountId",
      "productId",
      "productType",
      "title",
      "image",
      "type",
      "tempId",
    ]);
    expect(packages.deliveryType.getSQLType()).toBe("varchar(10)");
    expect(packages.customForm.notNull).toBe(false);
    expect(products.discountId.notNull).toBe(true);
    expect(packages).not.toHaveProperty("postage");
    expect(packages).not.toHaveProperty("systemFormId");
  });

  it("orders both package tables before parent activities in the activity phase", () => {
    const names = MIGRATION_TABLES.map((entry) => entry.table);
    for (const table of ["store_discounts", "store_discounts_products"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)).toMatchObject({
        key: ["id"],
        phase: "activity",
      });
      expect(names.indexOf(table)).toBeLessThan(names.indexOf("store_activity"));
    }
  });

  it("calculates a fixed package minimum and maximum savings with exact cents", () => {
    const result = assembleDiscountPackages(
      [discount()],
      [productRow(101, 10), productRow(102, 20)],
      [sku(101, "red", "8.50"), sku(102, "one", "4.50")],
      [sku(10, "red", "12.00"), sku(20, "one", "7.00")],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      min_price: "13.00",
      max_discounts_price: "6.00",
      products: [
        {
          product_id: 10,
          productValue: [{ product_price: "12.00", price: "8.50" }],
        },
        {
          product_id: 20,
          productValue: [{ product_price: "7.00", price: "4.50" }],
        },
      ],
    });
  });

  it("rejects a fixed package when any product or package SKU is unavailable", () => {
    expect(
      assembleDiscountPackages(
        [discount()],
        [productRow(101, 10), productRow(102, 20, { stock: 0 })],
        [sku(101, "red", "8.50"), sku(102, "one", "4.50")],
        [],
      ),
    ).toEqual([]);
    expect(
      assembleDiscountPackages(
        [discount()],
        [productRow(101, 10), productRow(102, 20)],
        [sku(101, "red", "8.50"), sku(102, "one", "4.50", 0)],
        [],
      ),
    ).toEqual([]);
  });

  it("drops an unavailable optional mix item but keeps only a still-purchasable mix", () => {
    const mixed = discount({ type: 1 });
    const optionalUnavailable = productRow(102, 20, { stock: 0 }, { type: 0 });
    const requiredAvailable = productRow(101, 10, {}, { type: 1 });
    const optionalAvailable = productRow(103, 30, {}, { type: 0 });

    expect(
      assembleDiscountPackages(
        [mixed],
        [requiredAvailable, optionalUnavailable, optionalAvailable],
        [sku(101, "red", "8.50"), sku(102, "one", "4.50"), sku(103, "one", "3.00")],
        [],
      ),
    ).toMatchObject([{ products: [{ product_id: 10 }, { product_id: 30 }] }]);
    expect(
      assembleDiscountPackages(
        [mixed],
        [requiredAvailable, optionalUnavailable],
        [sku(101, "red", "8.50"), sku(102, "one", "4.50")],
        [],
      ),
    ).toEqual([]);
    expect(
      assembleDiscountPackages(
        [mixed],
        [productRow(101, 10, { stock: 0 }, { type: 1 }), productRow(102, 20)],
        [sku(101, "red", "8.50"), sku(102, "one", "4.50")],
        [],
      ),
    ).toEqual([]);
  });

  it("enforces fixed and mix package membership on the server", () => {
    const entries = [
      productRow(101, 10, {}, { type: 1 }).entry,
      productRow(102, 20, {}, { type: 0 }).entry,
      productRow(103, 30, {}, { type: 0 }).entry,
    ];
    const selection = (
      entryId: number,
      productId: number,
    ): DiscountPackageSelectionInput => ({ entryId, productId, unique: `sku-${entryId}` });

    expect(() => validateDiscountPackageSelection(
      discount(),
      entries,
      [selection(101, 10), selection(102, 20)],
    )).toThrow("固定套餐必须购买全部商品");
    expect(validateDiscountPackageSelection(
      discount(),
      entries,
      [selection(101, 10), selection(102, 20), selection(103, 30)],
    )).toHaveLength(3);
    expect(() => validateDiscountPackageSelection(
      discount({ type: 1 }),
      entries,
      [selection(102, 20), selection(103, 30)],
    )).toThrow("请选择套餐必选商品");
    expect(validateDiscountPackageSelection(
      discount({ type: 1 }),
      entries,
      [selection(101, 10), selection(103, 30)],
    ).map(({ entry }) => entry.id)).toEqual([101, 103]);
  });

  it("rejects duplicate package products and unavailable windows or limits", () => {
    const duplicatedEntries = [
      productRow(101, 10).entry,
      productRow(102, 10).entry,
    ];
    expect(() => validateDiscountPackageSelection(
      discount(),
      duplicatedEntries,
      [
        { entryId: 101, productId: 10, unique: "a" },
        { entryId: 102, productId: 10, unique: "b" },
      ],
    )).toThrow("套餐配置包含重复商品");
    expect(isDiscountPackageAvailable(discount({ isLimit: 1, limitNum: 0 }), 100)).toBe(false);
    expect(isDiscountPackageAvailable(discount({ startTime: 101, stopTime: 200 }), 100)).toBe(false);
    expect(isDiscountPackageAvailable(discount({ startTime: 1, stopTime: 99 }), 100)).toBe(false);
    expect(isDiscountPackageAvailable(discount({ startTime: 1, stopTime: 100 }), 100)).toBe(true);
  });

  it("keeps the public route and legacy package-cart contract exact", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/activity/StoreDiscountService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/OrderController.ts", "utf8");
    const orderService = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(routes).toContain('"/store_discounts/list/:product_id"');
    expect(routes).toContain('"/cart/add"');
    expect(service).toContain(".selectDistinct({ discount: storeDiscounts })");
    expect(service).toContain("const [bundleSkus, productSkus] = await Promise.all");
    expect(service).toContain("createDirectBuyCarts");
    expect(controller).toContain("discountInfos");
    expect(controller).toContain("MAX_CART_BODY_BYTES");
    expect(orderService).toContain("limitNum: sql`limit_num - 1`");
    expect(orderService).toContain("type === 5");
  });
});
