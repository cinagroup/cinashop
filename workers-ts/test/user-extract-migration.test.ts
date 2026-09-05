import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { userExtract } from "../src/models/schema";
import { normalizeWithdrawalBody } from "../src/services/user/UserWithdrawalService";

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

  it("defines a user-scoped unique replay fence and bounded destination fields", () => {
    const columns = getTableColumns(userExtract);
    expect(columns.wechat.getSQLType()).toBe("varchar(64)");
    expect(columns.requestKey.getSQLType()).toBe("varchar(96)");
    expect(columns.requestHash.getSQLType()).toBe("varchar(64)");
    const replay = getTableConfig(userExtract).indexes.find((index) => index.config.name === "ue_request_replay_uq");
    expect(replay?.config.unique).toBe(true);
    expect(replay?.config.columns).toHaveLength(2);
    expect(replay?.config.where).toBeDefined();
  });

  it("writes normalized and legacy payment-account fields for new requests", () => {
    expect(normalizeWithdrawalBody({ money: "10", name: "姓名", cardnum: "123", bankname: "开户行", weixin: "微信号" }))
      .toMatchObject({ extractPrice: "10", realName: "姓名", bankCode: "123", bankName: "开户行", wechat: "微信号" });
  });
});
