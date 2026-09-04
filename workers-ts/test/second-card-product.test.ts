import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertProductCheckoutShippingType } from "@/services/order/ManualVirtualDeliveryPolicy";
import {
  normalizeProductSkuEditorPayload,
  productSkuReadbackMatches,
  type ProductSkuEditorRow,
} from "@/services/product/ProductSkuEditorService";

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, "..", "..");

function secondCardSku(overrides: Record<string, unknown> = {}) {
  return {
    suk: "默认",
    price: 88,
    cost: 20,
    ot_price: 108,
    vip_price: 78,
    stock: 10,
    write_times: 12,
    write_valid: 1,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return normalizeProductSkuEditorPayload({
    spec_type: 0,
    items: [{ value: "规格", detail: ["默认"] }],
    attrs: [secondCardSku(overrides)],
  }, 4);
}

describe("FE-001E5E4 second-card product lifecycle", () => {
  it("normalizes all three validity modes and clears fields that do not belong to the mode", () => {
    expect(payload({ write_valid: 1, write_days: 99, write_start: 100, write_end: 200 }).skus[0])
      .toMatchObject({ writeTimes: 12, writeValid: 1, writeDays: 0, writeStart: 0, writeEnd: 0 });
    expect(payload({ write_valid: 2, write_days: 30, write_start: 100, write_end: 200 }).skus[0])
      .toMatchObject({ writeTimes: 12, writeValid: 2, writeDays: 30, writeStart: 0, writeEnd: 0 });
    expect(payload({ write_valid: 3, write_days: 30, write_start: 1_800_000_000, write_end: 1_800_086_400 }).skus[0])
      .toMatchObject({
        writeTimes: 12,
        writeValid: 3,
        writeDays: 0,
        writeStart: 1_800_000_000,
        writeEnd: 1_800_086_400,
      });
  });

  it("requires one SKU and bounded write-off configuration", () => {
    expect(() => normalizeProductSkuEditorPayload({
      spec_type: 1,
      items: [{ value: "次数", detail: ["10次"] }],
      attrs: [secondCardSku({ suk: "10次", detail: { 次数: "10次" } })],
    }, 4)).toThrow("次卡商品只支持单规格单SKU");
    expect(() => payload({ write_times: 0 })).toThrow("次卡核销次数必须为1至99999999");
    expect(() => payload({ write_valid: 2, write_days: 0 })).toThrow("次卡购买后有效天数必须为1至3650");
    expect(() => payload({ write_valid: 2, write_days: 3651 })).toThrow("次卡购买后有效天数必须为1至3650");
    expect(() => payload({ write_valid: 3, write_start: 200, write_end: 100 }))
      .toThrow("次卡固定有效期必须是合法且结束晚于开始的时间区间");
  });

  it("includes the second-card fields in database and immutable snapshot readback", () => {
    const normalized = payload({ write_valid: 2, write_days: 30 });
    const assigned: ProductSkuEditorRow[] = [{
      ...normalized.skus[0],
      unique: "scard001",
      sales: 0,
      sumStock: 10,
    }];
    const product = {
      specType: 0,
      stock: 10,
      price: "88.00",
      settlePrice: "0.00",
      cost: "20.00",
      otPrice: "108.00",
      vipPrice: "78.00",
      isSold: 0,
    };
    const dimensions = [{ value: "规格", detail: ["默认"] }];
    const row = {
      suk: "默认",
      unique: "scard001",
      stock: 10,
      price: "88.00",
      settlePrice: "0.00",
      cost: "20.00",
      otPrice: "108.00",
      vipPrice: "78.00",
      writeTimes: 12,
      writeValid: 2,
      writeDays: 30,
      writeStart: 0,
      writeEnd: 0,
    };
    const snapshot = JSON.stringify({ attr: dimensions, value: assigned });
    expect(productSkuReadbackMatches(product, dimensions, [row], snapshot, normalized, assigned)).toBe(true);
    expect(productSkuReadbackMatches(
      product,
      dimensions,
      [{ ...row, writeDays: 31 }],
      snapshot,
      normalized,
      assigned,
    )).toBe(false);
  });

  it("forces second-card checkout to store pickup", () => {
    expect(() => assertProductCheckoutShippingType(4, 1))
      .toThrow("次卡商品只能选择门店自提并到店核销");
    expect(() => assertProductCheckoutShippingType(4, 2)).not.toThrow();
  });

  it("wires authoring, pickup UX and customer entitlement presentation", () => {
    const association = readFileSync(join(
      repositoryRoot,
      "workers-ts", "src", "services", "product", "ProductAssociationService.ts",
    ), "utf8");
    const cart = readFileSync(join(
      repositoryRoot,
      "workers-ts", "src", "services", "order", "StoreCartService.ts",
    ), "utf8");
    const admin = readFileSync(join(
      repositoryRoot,
      "view", "admin-ts", "src", "pages", "product", "ProductForm.vue",
    ), "utf8");
    const clients = [
      join(repositoryRoot, "view", "pc-ts", "src", "pages", "order", "Checkout.vue"),
      join(repositoryRoot, "view", "uniapp-ts", "src", "pages", "order", "confirm.vue"),
    ].map((path) => readFileSync(path, "utf8"));
    const details = [
      join(repositoryRoot, "view", "pc-ts", "src", "pages", "order", "OrderDetail.vue"),
      join(repositoryRoot, "view", "uniapp-ts", "src", "pages", "order", "detail.vue"),
    ].map((path) => readFileSync(path, "utf8"));

    expect(association).toContain("次卡商品必须配置单规格核销规则");
    expect(association).toContain('deliveryType: "2"');
    expect(cart).toContain("productType: product.productType");
    for (const text of [admin, ...clients]) expect(text).toContain("次卡商品");
    expect(admin).toContain("write_times");
    expect(admin).toContain("second_card_range");
    for (const text of details) {
      expect(text).toContain("次卡权益");
      expect(text).toContain("write_surplus_times");
      expect(text).toContain("secondCardValidityText");
    }
  });

  it("retains the already audited payment, reminder, refund and transactional write-off controls", () => {
    const checkout = readFileSync(join(repositoryRoot, "workers-ts", "src", "services", "order", "StoreOrderCreateService.ts"), "utf8");
    const writeoff = readFileSync(join(repositoryRoot, "workers-ts", "src", "services", "order", "StoreOrderWriteoffService.ts"), "utf8");
    const refund = readFileSync(join(repositoryRoot, "workers-ts", "src", "services", "order", "StoreOrderRefundService.ts"), "utf8");
    const reminder = readFileSync(join(repositoryRoot, "workers-ts", "src", "services", "order", "SecondCardReminderService.ts"), "utf8");
    expect(checkout).toContain("resolveSecondCardValidityAtCheckout");
    expect(checkout).toContain("writeSurplusTimes: writeTimes");
    expect(writeoff).toContain("商品尚未到可核销时间");
    expect(writeoff).toContain("商品已超过可核销时间");
    expect(writeoff).toContain("writeSurplusTimes: remaining");
    expect(writeoff).toContain("generatePickupVerifyCode");
    expect(refund).toContain("cart.writeTimes > cart.writeSurplusTimes");
    expect(reminder).toContain("storeOrderCartInfo.writeEnd");
  });

  it("keeps the production scenario token-gated, isolated and disposable", () => {
    const integration = readFileSync(join(
      repositoryRoot,
      "workers-ts", "test", "integration", "StoreOrderWriteoffPostgresScenario.ts",
    ), "utf8");
    const worker = readFileSync(join(
      repositoryRoot,
      "workers-ts", "test", "integration", "SecondCardProductAuditWorker.ts",
    ), "utf8");
    const runner = readFileSync(join(
      repositoryRoot,
      "workers-ts", "scripts", "run-second-card-product-production-audit.ps1",
    ), "utf8");
    expect(integration).toContain("runSecondCardProductPostgresScenario");
    expect(integration).toContain("second-card validity must activate from the payment timestamp");
    expect(integration).toContain("second-card reminder must stage and dispatch exactly once");
    expect(integration).toContain("second-card audit changed public business rows or sequences");
    expect(worker).toContain("AUDIT_TOKEN_SHA256");
    expect(worker).toContain("runSecondCardProductPostgresScenario");
    expect(runner).toContain("wrangler delete $taskAuditName");
    expect(runner).toContain("Temporary Worker did not enforce token authorization");
  });
});
