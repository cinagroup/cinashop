import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSkuCombinations,
  normalizeStockAdjustments,
  normalizeSupplierProductInput,
  normalizeSupplierProductDimensions,
  normalizeSupplierProductSkus,
} from "@/services/supplier/SupplierProductManagementService";

function baseProduct() {
  return {
    product_type: 0,
    store_name: "  便携保温杯  ",
    store_info: "双层真空",
    cate_id: [12],
    slider_image: ["https://cdn.example.com/cup.jpg"],
    spec_type: 0,
    attrs: [
      {
        suk: "默认",
        price: "89.90",
        settle_price: "62.30",
        cost: "48",
        ot_price: "109",
        vip_price: "85",
        stock: 18,
        brokerage: "2.50",
        brokerage_two: "1.25",
        weight: "0.35",
        volume: "0",
      },
    ],
    is_postage: 1,
    is_support_refund: 1,
  };
}

describe("supplier product normalization", () => {
  it("normalizes a single-spec product and keeps money as exact decimal strings", () => {
    const product = normalizeSupplierProductInput(baseProduct());
    expect(product.storeName).toBe("便携保温杯");
    expect(product.dimensions).toEqual([{ value: "规格", detail: ["默认"] }]);
    expect(product.skus[0]).toMatchObject({
      suk: "默认",
      price: "89.90",
      settlePrice: "62.30",
      cost: "48.00",
      brokerage: "2.50",
      brokerageTwo: "1.25",
      stock: 18,
    });
    expect(product).toMatchObject({ freight: 1, postage: "0.00", tempId: 0 });
  });

  it("preserves PHP freight modes and refuses incomplete template/fixed-postage settings", () => {
    expect(normalizeSupplierProductInput({
      ...baseProduct(),
      freight: 2,
      postage: "6.50",
      temp_id: 91,
    })).toMatchObject({ freight: 2, postage: "6.50", tempId: 0 });
    expect(normalizeSupplierProductInput({
      ...baseProduct(),
      freight: 3,
      postage: "8.00",
      temp_id: 91,
    })).toMatchObject({ freight: 3, postage: "0.00", tempId: 91 });
    expect(() => normalizeSupplierProductInput({
      ...baseProduct(),
      freight: 3,
      temp_id: 0,
    })).toThrow("请选择运费模板");
    expect(() => normalizeSupplierProductInput({
      ...baseProduct(),
      freight: 2,
      postage: 0,
    })).toThrow("固定邮费必须大于0");
  });

  it("accepts card and manual-virtual products, forces no-logistics freight, and rejects unopened types", () => {
    expect(normalizeSupplierProductInput({
      ...baseProduct(),
      product_type: 1,
      freight: 3,
      temp_id: 0,
      attrs: [{ ...baseProduct().attrs[0], stock: 0, disk_info: "" }],
    })).toMatchObject({ productType: 1, freight: 2, postage: "0.00", tempId: 0 });
    expect(normalizeSupplierProductInput({
      ...baseProduct(),
      product_type: 1,
      attrs: [{ ...baseProduct().attrs[0], disk_info: "https://download.example/fixed" }],
    }).skus[0]).toMatchObject({ stock: 18, diskInfo: "https://download.example/fixed" });
    expect(normalizeSupplierProductInput({
      ...baseProduct(),
      product_type: 3,
      freight: 3,
      temp_id: 91,
      attrs: [{ ...baseProduct().attrs[0], stock: 9 }],
    })).toMatchObject({
      productType: 3,
      freight: 2,
      postage: "0.00",
      tempId: 0,
      skus: [expect.objectContaining({ stock: 9, diskInfo: "" })],
    });
    for (const product_type of [2, 4]) {
      expect(() => normalizeSupplierProductInput({ ...baseProduct(), product_type })).toThrow(
        "当前迁移阶段仅支持实物、卡密/固定内容和手工虚拟商品",
      );
    }
    expect(() => normalizeSupplierProductInput({
      ...baseProduct(),
      attrs: [{ ...baseProduct().attrs[0], disk_info: "not-physical" }],
    })).toThrow("只有卡密商品可以配置固定虚拟内容");
    expect(() => normalizeSupplierProductInput({
      ...baseProduct(),
      product_type: 3,
      attrs: [{ ...baseProduct().attrs[0], disk_info: "not-manual-content" }],
    })).toThrow("只有卡密商品可以配置固定虚拟内容");
    expect(() => normalizeSupplierProductInput({ ...baseProduct(), cate_id: [] })).toThrow(
      "请选择商品分类",
    );
    expect(() => normalizeSupplierProductInput({ ...baseProduct(), slider_image: [] })).toThrow(
      "请至少上传一张商品轮播图",
    );
  });

  it("builds the complete Cartesian SKU set in stable dimension order", () => {
    const dimensions = normalizeSupplierProductDimensions([
      { value: "颜色", detail: ["青绿", "云白"] },
      { attr_name: "容量", attr_values: ["350ml", "500ml"] },
    ]);
    expect(buildSkuCombinations(dimensions)).toEqual([
      { 颜色: "青绿", 容量: "350ml" },
      { 颜色: "青绿", 容量: "500ml" },
      { 颜色: "云白", 容量: "350ml" },
      { 颜色: "云白", 容量: "500ml" },
    ]);
  });

  it("rejects duplicate, missing, invalid and excessive SKU combinations", () => {
    const dimensions = normalizeSupplierProductDimensions([
      { value: "颜色", detail: ["青绿", "云白"] },
    ]);
    const sku = (color: string) => ({
      detail: { 颜色: color },
      price: "10.00",
      settle_price: "8.00",
      stock: 1,
    });
    expect(() => normalizeSupplierProductSkus([sku("青绿")], dimensions, 1)).toThrow(
      "SKU组合必须完整覆盖",
    );
    expect(() => normalizeSupplierProductSkus([sku("青绿"), sku("青绿")], dimensions, 1)).toThrow(
      "SKU组合不能重复",
    );
    expect(() => normalizeSupplierProductSkus([sku("青绿"), sku("黑色")], dimensions, 1)).toThrow(
      "SKU包含无效",
    );
    expect(() =>
      buildSkuCombinations([
        { value: "A", detail: Array.from({ length: 15 }, (_, index) => String(index)) },
        { value: "B", detail: Array.from({ length: 15 }, (_, index) => String(index)) },
      ]),
    ).toThrow("SKU组合不能超过200项");
  });

  it("enforces price, settlement and brokerage invariants", () => {
    const negative = baseProduct();
    negative.attrs[0].price = "0";
    expect(() => normalizeSupplierProductInput(negative)).toThrow("销售价必须大于0");

    const excessive = baseProduct();
    excessive.attrs[0].brokerage = "80.00";
    excessive.attrs[0].brokerage_two = "20.00";
    expect(() => normalizeSupplierProductInput(excessive)).toThrow(
      "一级佣金与二级佣金之和不能超过销售价",
    );

    const precision = baseProduct();
    precision.attrs[0].settle_price = "1.005";
    expect(() => normalizeSupplierProductInput(precision)).toThrow("最多两位小数");
  });
});

describe("supplier stock adjustment normalization", () => {
  it("accepts PHP-compatible attrs and rejects unsafe adjustments", () => {
    expect(normalizeStockAdjustments({ attrs: [{ unique: "ABCD1234", pm: 1, stock: 5 }] })).toEqual([
      { unique: "ABCD1234", pm: 1, stock: 5 },
    ]);
    expect(() => normalizeStockAdjustments({ attrs: [{ unique: "ABCD1234", pm: 0, stock: 0 }] })).toThrow(
      "库存调整数量必须大于0",
    );
    expect(() =>
      normalizeStockAdjustments({
        attrs: [
          { unique: "ABCD1234", pm: 1, stock: 1 },
          { unique: "ABCD1234", pm: 0, stock: 1 },
        ],
      }),
    ).toThrow("同一个SKU不能重复调整");
  });
});

describe("supplier product migration contracts", () => {
  it("registers lifecycle routes before the dynamic product detail route", () => {
    const source = readFileSync("src/routes/supplierapi.ts", "utf8");
    for (const route of [
      "/product/category",
      "/product/category/tree/:type",
      "/product/product/attrs/:id",
      "/product/product/saveStocks/:id",
      "/product/product/batch_show/:is_show",
      "/product/product/product_show",
      "/product/product/product_unshow",
      "/product/generate_attr/:id/:type",
      "/product/product/:id",
    ]) {
      expect(source).toContain(route);
    }
    expect(source.indexOf('"/product/product/saveStocks/:id"')).toBeLessThan(
      source.lastIndexOf('"/product/product/:id"'),
    );
  });

  it("authorizes selected shipping templates against the current supplier", () => {
    const source = readFileSync("src/services/supplier/SupplierProductManagementService.ts", "utf8");
    expect(source).toContain("assertShippingTemplate(tx, supplierId, input)");
    expect(source).toContain("eq(shippingTemplates.ownerType, SUPPLIER_TYPE)");
    expect(source).toContain("eq(shippingTemplates.relationId, supplierId)");
    expect(source).toContain("eq(shippingTemplates.status, 1)");
  });

  it("keeps card-backed stock authoritative to the virtual inventory ledger", () => {
    const source = readFileSync("src/services/supplier/SupplierProductManagementService.ts", "utf8");
    expect(source).toContain("product.productType === CARD_PRODUCT_TYPE && !sku.diskInfo?.trim()");
    expect(source).toContain("请使用卡密库存导入");
    expect(source).toContain("existing.productType !== input.productType");
  });

  it("exposes Supplier type-one and type-three authoring without sending card secrets through the product form", () => {
    const form = readFileSync("../view/supplier-ts/src/pages/ProductForm.vue", "utf8");
    const products = readFileSync("../view/supplier-ts/src/pages/Products.vue", "utf8");
    expect(form).toContain("卡密 / 固定内容");
    expect(form).toContain(':disabled="editing"');
    expect(form).toContain("保存后前往卡密库存安全导入");
    expect(form).toContain("delivery_mode === \"fixed\"");
    expect(form).toContain("scope.row.suk}-${scope.row.delivery_mode");
    expect(form).toContain("手工虚拟");
    expect(form).toContain("手工虚拟商品由履约人员填写交付内容");
    expect(products).toContain("scope.row.product_type === 0 || scope.row.product_type === 3");
    expect(products).toContain("/virtual-inventory");
    expect(form).not.toContain("card_pwd");
    expect(form).not.toContain("card_no");
  });

  it("keeps the file migration and embedded production migration byte-equivalent after trimming", () => {
    const migration = readFileSync("migrations/0016_supplier_product_management.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(/private migration_0023\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]?.trim();
    expect(embedded).toBe(migration);
  });
});
