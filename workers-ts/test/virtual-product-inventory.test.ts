import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classifyVirtualInventoryRisk,
  maskVirtualCardNumber,
  normalizeVirtualCardImport,
} from "@/services/product/VirtualProductInventoryService";

describe("虚拟卡密库存运营", () => {
  it("兼容 PHP key/value 与新 card_no/card_pwd 格式并在请求内去重", () => {
    expect(normalizeVirtualCardImport({
      cards: [
        { key: " CARD-001 ", value: " PWD-001 " },
        { card_no: "CARD-001", card_pwd: "PWD-001" },
        { card_no: "", card_pwd: "PASSWORD-ONLY" },
      ],
    })).toEqual({
      cards: [
        { cardNo: "CARD-001", cardPwd: "PWD-001" },
        { cardNo: "", cardPwd: "PASSWORD-ONLY" },
      ],
      requestDuplicates: 1,
    });
  });

  it("拒绝空密码、控制字符和超量批次", () => {
    expect(() => normalizeVirtualCardImport([{ key: "CARD", value: "" }]))
      .toThrow("密码不能为空");
    expect(() => normalizeVirtualCardImport([{ key: "CARD\n2", value: "PWD" }]))
      .toThrow("控制字符");
    expect(() => normalizeVirtualCardImport(Array.from({ length: 1_001 }, (_, index) => ({
      key: `CARD-${index}`,
      value: `PWD-${index}`,
    })))).toThrow("单次最多导入 1000 条卡密");
  });

  it("只暴露卡号尾部提示，不暴露完整卡号", () => {
    expect(maskVirtualCardNumber("CARD-12345678")).toBe("•••••••••5678");
    expect(maskVirtualCardNumber("1234")).toBe("••••");
    expect(maskVirtualCardNumber("A")).toBe("••••");
    expect(maskVirtualCardNumber("")).toBe("未设置");
  });

  it("查询投影不返回密码，导入响应不回显秘密，并使用事务锁串行化防重", () => {
    const source = readFileSync("src/services/product/VirtualProductInventoryService.ts", "utf8");
    const alertMethod = source.slice(source.indexOf("async alerts("), source.indexOf("async inventory("));
    const inventoryProjection = source.slice(source.indexOf("async inventory("), source.indexOf("async importCards("));
    const response = source.slice(source.indexOf("return {\n        inserted:"));
    expect(inventoryProjection).not.toContain("cardPwd: storeProductVirtual.cardPwd");
    expect(inventoryProjection).toContain("password_configured:");
    expect(alertMethod).not.toContain("card_no");
    expect(alertMethod).not.toContain("card_pwd");
    expect(response).not.toContain("cardPwd");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("storeId: inventoryStoreId(product)");
  });

  it("按可售库存覆盖量区分缺口、低缓冲和健康库存", () => {
    expect(classifyVirtualInventoryRisk(4, 5, 5)).toBe("shortage");
    expect(classifyVirtualInventoryRisk(5, 5, 0)).toBe("low_buffer");
    expect(classifyVirtualInventoryRisk(8, 5, 3)).toBe("low_buffer");
    expect(classifyVirtualInventoryRisk(9, 5, 3)).toBe("healthy");
  });

  it("密码-only 库存可以进入既有支付后交付链路", () => {
    const delivery = readFileSync("src/services/order/VirtualProductDeliveryService.ts", "utf8");
    expect(delivery).toContain("!card.cardPwd.trim()");
    expect(delivery).not.toContain("!card.cardNo.trim() || !card.cardPwd.trim()");
  });
});
