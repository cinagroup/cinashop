import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { userExtract } from "../src/models/schema";

describe("user extract migration parity", () => {
  it("preserves all PHP withdrawal accounting and destination fields", () => {
    const columns = getTableColumns(userExtract);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        "alipayCode",
        "extractFee",
        "mark",
        "balance",
        "failTime",
        "wechat",
        "qrcodeUrl",
      ]),
    );
    expect(columns.realName.getSQLType()).toBe("varchar(64)");
    expect(columns.bankAddress.getSQLType()).toBe("varchar(256)");
  });

  it("keeps API rejection compatibility while storing PHP status -1 atomically", () => {
    const source = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    expect(source).toContain("body.status === 2 || body.status === -1");
    expect(source).toContain("status: newStatus");
    expect(source).toContain("eq(userExtract.status, 0)");
    expect(source).toContain("record.extractPrice} + ${record.extractFee");
    expect(source).toContain("withTx(container");
  });

  it("writes normalized and legacy payment-account fields for new requests", () => {
    const source = readFileSync("src/services/user/UserFinanceService.ts", "utf8");
    expect(source).toContain('params.extractType === "wx" ? "weixin"');
    expect(source).toContain("alipayCode,");
    expect(source).toContain("extractFee: \"0.00\"");
    expect(source).toContain("balance: account.brokeragePrice");
    expect(source).toContain("qrcodeUrl: params.qrcodeUrl ?? \"\"");
  });
});
