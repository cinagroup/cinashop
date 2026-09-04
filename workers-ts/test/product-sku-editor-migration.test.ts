import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeProductSkuEditorPayload,
  parseProductSkuRuleValue,
  productSkuReadbackMatches,
  productSkuSummary,
  type ProductSkuEditorRow,
} from "@/services/product/ProductSkuEditorService";

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, "..", "..");

function sku(parts: [string, string], price = 100) {
  return {
    suk: parts.join(","),
    detail: { 颜色: parts[0], 尺码: parts[1] },
    price,
    cost: 40,
    ot_price: 120,
    vip_price: 90,
    stock: 5,
  };
}

describe("FE-001E5A product SKU editor migration", () => {
  it("normalizes a complete Cartesian SKU template and derives main-row totals", () => {
    const payload = normalizeProductSkuEditorPayload({
      spec_type: 1,
      items: [
        { value: "颜色", detail: ["米白", "藏青"] },
        { value: "尺码", detail: ["S", "M"] },
      ],
      attrs: [
        sku(["米白", "S"], 100),
        sku(["米白", "M"], 110),
        sku(["藏青", "S"], 120),
        sku(["藏青", "M"], 130),
      ],
    });

    expect(payload.skus.map((row) => row.suk)).toEqual([
      "米白,S", "米白,M", "藏青,S", "藏青,M",
    ]);
    expect(productSkuSummary(payload)).toEqual({
      stock: 20,
      price: "100.00",
      settlePrice: "0.00",
      cost: "40.00",
      otPrice: "120.00",
      vipPrice: "90.00",
      isSold: 0,
    });
  });

  it("rejects incomplete combinations and comma-ambiguous template values", () => {
    expect(() => normalizeProductSkuEditorPayload({
      spec_type: 1,
      items: [
        { value: "颜色", detail: ["米白", "藏青"] },
        { value: "尺码", detail: ["S", "M"] },
      ],
      attrs: [sku(["米白", "S"])],
    })).toThrow("SKU组合必须完整覆盖所有规格组合");

    expect(parseProductSkuRuleValue([
      { value: "颜色", detail: ["黑,白"] },
    ])).toBeNull();
  });

  it("normalizes card fixed content, permits type-three stock, and rejects fixed content elsewhere", () => {
    const body = {
      spec_type: 0,
      items: [{ value: "规格", detail: ["默认"] }],
      attrs: [{
        suk: "默认",
        price: 20,
        stock: 10,
        disk_info: " https://download.example/license ",
      }],
    };
    expect(normalizeProductSkuEditorPayload(body, 1).skus[0].diskInfo)
      .toBe("https://download.example/license");
    expect(() => normalizeProductSkuEditorPayload(body, 0))
      .toThrow("只有卡密商品可以配置固定虚拟内容");
    expect(() => normalizeProductSkuEditorPayload(body, 3))
      .toThrow("只有卡密商品可以配置固定虚拟内容");
    expect(normalizeProductSkuEditorPayload({
      ...body,
      attrs: [{ ...body.attrs[0], disk_info: "" }],
    }, 3).skus[0]).toMatchObject({ stock: 10, diskInfo: "" });
    expect(() => normalizeProductSkuEditorPayload(body, 4))
      .toThrow("只有卡密商品可以配置固定虚拟内容");
  });

  it("requires exact main, dimensions, SKU identities and snapshot readback", () => {
    const payload = normalizeProductSkuEditorPayload({
      spec_type: 0,
      items: [{ value: "规格", detail: ["默认"] }],
      attrs: [{ suk: "默认", price: 99, cost: 40, ot_price: 120, vip_price: 88, stock: 7 }],
    });
    const assigned: ProductSkuEditorRow[] = [{
      ...payload.skus[0],
      unique: "abc12345",
      sales: 0,
      sumStock: 7,
    }];
    const product = {
      specType: 0,
      stock: 7,
      price: "99.00",
      settlePrice: "0.00",
      cost: "40.00",
      otPrice: "120.00",
      vipPrice: "88.00",
      isSold: 0,
    };
    const dimensions = [{ value: "规格", detail: ["默认"] }];
    const rows = [{
      suk: "默认",
      unique: "abc12345",
      stock: 7,
      price: "99.00",
      settlePrice: "0.00",
      cost: "40.00",
      otPrice: "120.00",
      vipPrice: "88.00",
    }];
    const result = JSON.stringify({ attr: dimensions, value: assigned });

    expect(productSkuReadbackMatches(product, dimensions, rows, result, payload, assigned)).toBe(true);
    expect(productSkuReadbackMatches(product, dimensions, [
      { ...rows[0], unique: "wrong123" },
    ], result, payload, assigned)).toBe(false);
    expect(productSkuReadbackMatches(
      product,
      dimensions,
      rows,
      JSON.stringify({ attr: dimensions, value: [{ ...assigned[0], diskInfo: "changed" }] }),
      payload,
      assigned,
    )).toBe(false);
  });

  it("uses locks, stable suk identity, fail-closed retirement, stock audit and DB readback", () => {
    const source = readFileSync(join(
      repositoryRoot,
      "workers-ts", "src", "services", "product", "ProductSkuEditorService.ts",
    ), "utf8");

    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE");
    expect(source).toContain("PRODUCT_SKU_IDENTITY_LOCK_KEY");
    expect(source).toContain('for("update")');
    expect(source).toContain("currentBySuk.get(sku.suk)");
    expect(source).toContain("不能删除或重命名已有SKU");
    expect(source).toContain("storeProductStockRecord");
    expect(source).toContain("productSkuReadbackMatches");
    expect(source).toContain("商品SKU数据库回读校验失败");
  });

  it("serializes every SKU identity allocator through one shared lock namespace", () => {
    const identity = readFileSync(join(
      repositoryRoot,
      "workers-ts", "src", "services", "product", "ProductSkuIdentity.ts",
    ), "utf8");
    expect(identity).toContain("PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE = 731_602");

    for (const path of [
      ["product", "ProductSkuEditorService.ts"],
      ["supplier", "SupplierProductManagementService.ts"],
      ["out", "OutProductService.ts"],
      ["activity", "AdminNewcomerService.ts"],
      ["activity", "AdminDiscountPackageService.ts"],
    ]) {
      const allocator = readFileSync(join(
        repositoryRoot,
        "workers-ts", "src", "services", ...path,
      ), "utf8");
      expect(allocator).toContain("PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE");
    }
  });

  it("joins SKU persistence to the same bounded product transaction", () => {
    const source = readFileSync(join(
      repositoryRoot,
      "workers-ts", "src", "services", "product", "ProductAssociationService.ts",
    ), "utf8");

    expect(source).toContain("hasProductSkuEditorPayload(body)");
    expect(source).toContain("normalizeProductSkuEditorPayload(body, productType)");
    expect(source).toContain("await replaceProductSkuEditor(tx");
    expect(source).toContain("sku_verified: skuPayload !== null");
    expect(source).toContain("sku_rule_templates:");
    expect(source).toContain("商品创建后不能修改履约类型");
  });

  it("wires template application, generated rows and responsive SKU table into Admin", () => {
    const form = readFileSync(join(
      repositoryRoot,
      "view", "admin-ts", "src", "pages", "product", "ProductForm.vue",
    ), "utf8");
    const api = readFileSync(join(
      repositoryRoot,
      "view", "admin-ts", "src", "api", "product.ts",
    ), "utf8");

    expect(form).toContain("SKU规格与库存");
    expect(form).toContain("applySkuRuleTemplate");
    expect(form).toContain("skuCombinations");
    expect(form).toContain("prepareSkuPayload");
    expect(form).toContain('class="sku-table-shell"');
    expect(form).toContain("不能删除、重命名或改唯一标识");
    expect(form).toContain("卡密/网盘");
    expect(form).toContain("一次性卡密");
    expect(form).toContain("固定内容");
    expect(form).toContain("保存后进入卡密库存导入");
    expect(form).toContain("支付发货严格使用下单快照");
    expect(api).toContain("sku_rule_templates");
    expect(api).toContain("sku_verified: true");
  });
});
