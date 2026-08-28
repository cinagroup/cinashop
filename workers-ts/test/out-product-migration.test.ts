import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { outProductWriteReplay } from "@/models/schema";
import {
  normalizeOutPhysicalProductInput,
  normalizeOutProductRequestKey,
  normalizeOutStockUpload,
} from "@/services/out/OutProductService";

function physicalProduct() {
  return {
    product_type: 0,
    supplier_id: 0,
    cate_id: [10],
    store_name: "外部平台商品",
    slider_image: ["https://cdn.example.com/product.png"],
    delivery_type: [1, 2],
    freight: 1,
    spec_type: 0,
    attrs: [{
      suk: "默认",
      price: "19.90",
      stock: 8,
      bar_code: "OUT-SKU-001",
    }],
  };
}

describe("Out API product write migration", () => {
  it("normalizes the bounded platform-only physical product contract", () => {
    const normalized = normalizeOutPhysicalProductInput(physicalProduct());
    expect(normalized).toMatchObject({
      storeName: "外部平台商品",
      cateIds: [10],
      deliveryType: "1,2",
      freight: 1,
      postage: "0.00",
      tempId: 0,
      isShow: 0,
    });
    expect(normalized.skus[0]).toMatchObject({
      price: "19.90",
      settlePrice: "0.00",
      stock: 8,
      barCode: "OUT-SKU-001",
    });
  });

  it("fails closed for cross-tenant and unmigrated product capabilities", () => {
    expect(() => normalizeOutPhysicalProductInput({ ...physicalProduct(), supplier_id: 9 }))
      .toThrow("只允许平台作用域");
    expect(() => normalizeOutPhysicalProductInput({ ...physicalProduct(), product_type: 1 }))
      .toThrow("当前迁移阶段仅支持实物商品");
    expect(() => normalizeOutPhysicalProductInput({ ...physicalProduct(), coupon_ids: [1] }))
      .toThrow("不能静默丢弃");
    expect(() => normalizeOutPhysicalProductInput({
      ...physicalProduct(),
      slider_image: ["javascript:alert(1)"],
    })).toThrow("必须是HTTPS地址或站内绝对路径");
    expect(() => normalizeOutPhysicalProductInput({
      ...physicalProduct(),
      soure_link: "javascript:alert(1)",
    })).toThrow("必须是HTTPS地址或站内绝对路径");
  });

  it("requires UUID-v4 idempotency keys and exact absolute stock items", () => {
    expect(normalizeOutProductRequestKey("8c237c34-9995-4e47-8e02-c6d3e67524db"))
      .toBe("8c237c34-9995-4e47-8e02-c6d3e67524db");
    expect(() => normalizeOutProductRequestKey("retry-1")).toThrow("UUID v4");
    expect(normalizeOutStockUpload({ items: [{ bar_code: "OUT-SKU-001", qty: 0 }] }))
      .toEqual([{ barCode: "OUT-SKU-001", quantity: 0 }]);
    expect(() => normalizeOutStockUpload({
      items: [
        { bar_code: "OUT-SKU-001", qty: 1 },
        { bar_code: "OUT-SKU-001", qty: 2 },
      ],
    })).toThrow("不能重复同步");
  });

  it("persists only replay digests and bounded result identifiers", () => {
    expect(getTableName(outProductWriteReplay)).toBe("out_product_write_replay");
    expect(Object.keys(getTableColumns(outProductWriteReplay))).toEqual([
      "id",
      "outAccountId",
      "operation",
      "requestKey",
      "requestHash",
      "productId",
      "resultCount",
      "addTime",
    ]);
    const migration = readFileSync("migrations/0097_out_product_write_replay.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service
      .match(/private migration_0104\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/store_name|bar_code|stock_value|request_body|response_body/i);
  });

  it("uses fixed lock order, platform scope and stock-preserving updates", () => {
    const source = readFileSync("src/services/out/OutProductService.ts", "utf8");
    expect(source).toContain('LOCK TABLE "store_product_category" IN SHARE ROW EXCLUSIVE MODE');
    expect(source).toContain("Out API 修改商品不能增删SKU");
    expect(source).toContain("stock: current.stock");
    expect(source.indexOf('.from(storeProductAttrValue)')).toBeLessThan(
      source.indexOf('.from(storeProduct)\n            .where(and('),
    );
    expect(source).toContain("属性编码 ${item.barCode} 存在重复，拒绝猜测商品");
    expect(source).toContain("eq(storeProduct.type, PLATFORM_TYPE)");
    const stockUpload = source.slice(source.indexOf("async uploadStock"));
    expect(stockUpload.indexOf("pg_advisory_xact_lock(${PRODUCT_SAVE_LOCK_NAMESPACE}, 0)"))
      .toBeLessThan(stockUpload.indexOf("const barCodes"));
  });
});
