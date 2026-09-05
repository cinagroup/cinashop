import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { user, userBrokerage, userExtract, userMoney, userRecharge, systemConfig } from "@/models/schema";
import { createContainerFromDb, type Container } from "@/lib/di";
import type { AppVariables, Env } from "@/env";
import { UserWithdrawalService, normalizeWithdrawalBody, withdrawalPolicy } from "@/services/user/UserWithdrawalService";
import { extractCash } from "@/controllers/api/v1/UserFinanceController";
import { UserFinanceService } from "@/services/user/UserFinanceService";
import { USER_WITHDRAWAL_REPLAY_SQL } from "@/migrations/userWithdrawalReplay";
import { financePostgres } from "./helpers/financePostgres";
import { capitalFlow, storeOrderOutbox, orderNotificationDelivery } from "@/models/schema";
import { WITHDRAWAL_EFFECTS_SQL } from "@/migrations/withdrawalEffects";

let fixture: Awaited<ReturnType<typeof financePostgres>>;
let container: Container;
let service: UserWithdrawalService;
const bank = (overrides = {}) => ({ extractType: "bank", extractPrice: "20.00", realName: "收款人", extractNumber: "6222021234567890123", bankName: "测试银行", requestKey: "withdrawal-intent-0001", ...overrides });

beforeAll(async () => {
  fixture = await financePostgres([user, userBrokerage, userExtract, userMoney, userRecharge, systemConfig, capitalFlow, storeOrderOutbox, orderNotificationDelivery]);
  // Verify the actual deployment migration is idempotent and enables the unique intent fence.
  await fixture.exec(USER_WITHDRAWAL_REPLAY_SQL);
  await fixture.exec(WITHDRAWAL_EFFECTS_SQL);
  await fixture.exec('CREATE UNIQUE INDEX "soob_event_key_uq" ON "store_order_outbox" ("event_key")');
  await fixture.exec(USER_WITHDRAWAL_REPLAY_SQL);
  container = createContainerFromDb(fixture.db);
  service = new UserWithdrawalService(container);
}, 30_000);
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.reset();
  await fixture.db.insert(user).values([
    { uid: 7, nickname: "申请用户", brokeragePrice: "100.00", nowMoney: "5.00" },
    { uid: 8, nickname: "另一用户", brokeragePrice: "200.00" },
  ]);
  await fixture.db.insert(systemConfig).values(Object.entries({
    user_extract_min_price: "1.00", user_extract_max_price: "1000.00", withdraw_fee: "2.5", brokerage_type: "0", user_extract_balance_status: "1",
  }).map(([menuName, value]) => ({ menuName, value })));
});

async function state() {
  return {
    users: await fixture.db.select().from(user).orderBy(user.uid),
    requests: await fixture.db.select().from(userExtract).orderBy(userExtract.id),
    brokerage: await fixture.db.select().from(userBrokerage).orderBy(userBrokerage.id),
    money: await fixture.db.select().from(userMoney),
    recharge: await fixture.db.select().from(userRecharge),
  };
}
async function config(key: string, value: string) {
  await fixture.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, key));
}

describe("API-014 withdrawal money-state and replay scenarios", () => {
  it("limits the secret-scan fixture exception to one exact non-secret and one test path", () => {
    const block = readFileSync("../.gitleaks.toml", "utf8").split("[[allowlists]]")
      .find((entry) => entry.includes("Fixed non-secret withdrawal idempotency fixture"))!;
    expect(block).toContain('targetRules = ["generic-api-key"]');
    expect(block).toContain('condition = "AND"');
    expect(block).toContain('regexTarget = "secret"');
    const path = new RegExp(block.match(/paths = \['''([^']+)'''\]/)![1]);
    const value = new RegExp(block.match(/regexes = \['''([^']+)'''\]/)![1]);
    expect(path.test("workers-ts/test/user-withdrawal-scenario.test.ts")).toBe(true);
    expect(path.test("workers-ts/src/services/user/UserWithdrawalService.ts")).toBe(false);
    expect(path.test("workers-ts/test/user-withdrawal-scenario.other.test.ts")).toBe(false);
    expect(value.test(bank().requestKey)).toBe(true);
    expect(value.test(bank().requestKey + "-changed")).toBe(false);
    expect(value.test("prefix-" + bank().requestKey)).toBe(false);
  });

  it("mirrors exact external/embedded DDL", () => {
    expect(readFileSync("migrations/0130_user_withdrawal_replay.sql", "utf8").trim()).toBe(USER_WITHDRAWAL_REPLAY_SQL.trim());
  });

  it("normalizes old and current fields, rejects ambiguous aliases and malformed amounts", async () => {
    const input = normalizeWithdrawalBody({ extract_type: "bank", money: "20.00", name: "收款人", bankname: "测试银行", cardnum: "6222021234567890123", request_id: "legacy-intent-0001" });
    expect(input).toMatchObject({ extractPrice: "20.00", realName: "收款人", bankCode: "6222021234567890123" });
    await service.apply(7, input);
    expect(() => normalizeWithdrawalBody({ money: "20.00", extract_price: "30.00" })).toThrow("参数冲突");
    for (const extractPrice of ["-1", "1.001", "1e2", "NaN", "", "0", "10000000000.00"]) {
      await expect(service.apply(7, bank({ extractPrice }))).rejects.toThrow();
    }
    expect((await state()).requests).toHaveLength(1);
  });

  it("deducts gross, stores net/fee separately, and immediately records one valid gross debit", async () => {
    const request = await service.apply(7, bank());
    const result = await state();
    expect(result.users[0]).toMatchObject({ brokeragePrice: "80.00", nowMoney: "5.00" });
    expect(result.requests).toEqual([expect.objectContaining({ id: request.id, extractPrice: "19.50", extractFee: "0.50", balance: "100.00", status: 0, bankCode: "6222021234567890123", bankAddress: "测试银行" })]);
    expect(result.brokerage).toEqual([expect.objectContaining({ uid: 7, pm: 0, status: 1, type: "extract", number: "20.00", balance: "80.00", linkId: String(request.id) })]);
    expect(result.money).toHaveLength(0);
  });

  it("matches PHP fee truncation without floating-point rounding", () => {
    const policy = { user_extract_min_price: "0", user_extract_max_price: "9999999999.99", withdraw_fee: "2.5555" };
    expect(withdrawalPolicy(policy, 199, "bank")).toMatchObject({ feeCents: 5, netCents: 194 });
    expect(withdrawalPolicy(policy, 999_999_999_999, "bank").feeCents).toBe(Number(999_999_999_999n * 255n / 10000n));
  });

  it("fails closed on limits/methods/recipients and leaves all business state untouched", async () => {
    const before = await state();
    for (const changes of [{ extractType: "unknown" }, { extractNumber: "short" }, { bankName: "" }, { extractPrice: "1001.00" }, { extractPrice: "0.99" }, { qrcodeUrl: "javascript:alert(1)" }]) {
      await expect(service.apply(7, bank(changes))).rejects.toThrow();
    }
    await config("user_extract_max_price", "0");
    await expect(service.apply(7, bank())).rejects.toThrow("尚未配置");
    expect(await state()).toEqual(before);
  });

  it("uses only valid frozen future credits and rejects unavailable commission", async () => {
    await fixture.db.insert(userBrokerage).values([
      { uid: 7, pm: 1, status: 1, number: "90.00", frozenTime: Math.floor(Date.now() / 1000) + 3600 },
      { uid: 8, pm: 1, status: 1, number: "200.00", frozenTime: Math.floor(Date.now() / 1000) + 3600 },
    ]);
    await expect(service.apply(7, bank())).rejects.toThrow("可提现佣金不足");
    const result = await state();
    expect(result.users[0].brokeragePrice).toBe("100.00");
    expect(result.requests).toHaveLength(0);
  });

  it("replays the same intent even after config changes, and rejects modified payloads", async () => {
    const first = await service.apply(7, bank());
    await config("user_extract_max_price", "0");
    expect(await service.apply(7, bank())).toEqual(first);
    await expect(service.apply(7, bank({ extractPrice: "30.00" }))).rejects.toMatchObject({ code: 409, message: expect.stringContaining("不能修改") });
    const result = await state();
    expect(result.requests).toHaveLength(1);
    expect(result.brokerage).toHaveLength(1);
    expect(result.users[0].brokeragePrice).toBe("80.00");
  });

  it("scopes identical intent keys to users and preserves keyless legacy submissions", async () => {
    await service.apply(7, bank());
    await service.apply(8, bank());
    await service.apply(7, bank({ requestKey: "" }));
    expect((await state()).requests).toHaveLength(3);
    await expect(fixture.db.insert(userExtract).values({ uid: 7, requestKey: bank().requestKey })).rejects.toThrow();
  });

  it("credits balance immediately with zero fee and all ledgers in one transaction", async () => {
    const request = await service.apply(7, bank({ extractType: "balance", extractNumber: "", bankName: "" }));
    expect(await service.apply(7, bank({ extractType: "balance", extractNumber: "", bankName: "" }))).toEqual(request);
    const result = await state();
    expect(result.users[0]).toMatchObject({ brokeragePrice: "80.00", nowMoney: "25.00" });
    expect(result.requests[0]).toMatchObject({ status: 1, extractPrice: "20.00", extractFee: "0.00" });
    expect(result.money).toEqual([expect.objectContaining({ pm: 1, number: "20.00", balance: "25.00", status: 1 })]);
    expect(result.recharge).toEqual([expect.objectContaining({ price: "20.00", paid: 1, rechargeType: "balance" })]);
    await expect(service.review(request.id, 2)).rejects.toThrow("已审核");
  });

  it("honors balance disable, manual WeChat account and automatic channel boundaries", async () => {
    await config("user_extract_balance_status", "0");
    await expect(service.apply(7, bank({ extractType: "balance" }))).rejects.toThrow("未开启");
    await expect(service.apply(7, bank({ extractType: "weixin", extractNumber: "" }))).rejects.toThrow("微信账号");
    await config("brokerage_type", "1");
    await expect(service.apply(7, bank({ extractType: "weixin", extractPrice: "1.00", extractNumber: "" }))).rejects.toThrow("不能小于1元");
    const request = await service.apply(7, bank({ extractType: "weixin", extractNumber: "" }));
    await expect(service.review(request.id, 1)).rejects.toThrow("渠道尚未完成");
    expect((await state()).requests[0].status).toBe(0);
  });

  it("rejects once with a compensating gross credit; never changes another user's matching link", async () => {
    const request = await service.apply(7, bank());
    await fixture.db.insert(userBrokerage).values({ uid: 8, pm: 0, type: "extract", category: "extract", linkId: String(request.id), number: "10.00", status: 0 });
    await service.review(request.id, 2, "账号需核实");
    expect(await service.review(request.id, -1, "重复拒绝")).toMatchObject({ replayed: true });
    const result = await state();
    expect(result.users[0].brokeragePrice).toBe("100.00");
    expect(result.requests[0]).toMatchObject({ status: -1, failMsg: "账号需核实" });
    expect(result.brokerage.filter((row) => row.uid === 7)).toEqual([
      expect.objectContaining({ pm: 0, number: "20.00", status: 1 }),
      expect.objectContaining({ pm: 1, number: "20.00", type: "extract_fail", balance: "100.00", status: 1 }),
    ]);
    expect(result.brokerage.find((row) => row.uid === 8)?.status).toBe(0);
    await expect(service.review(request.id, 1)).rejects.toThrow("不可改变");
  });

  it("requires a matching debit and rejects missing/malformed review decisions", async () => {
    const request = await service.apply(7, bank());
    for (const status of [0, 3, Number.NaN]) await expect(service.review(request.id, status)).rejects.toThrow("参数错误");
    await fixture.db.update(userBrokerage).set({ number: "1.00" }).where(eq(userBrokerage.uid, 7));
    await expect(service.review(request.id, 2)).rejects.toThrow("账本不一致");
    expect((await state()).requests[0].status).toBe(0);
  });

  it("normalizes a proven older pending debit on manual approval without deducting again", async () => {
    const request = await service.apply(7, bank());
    await fixture.db.update(userBrokerage).set({ status: 0 }).where(eq(userBrokerage.uid, 7));
    await service.review(request.id, 1);
    expect(await service.review(request.id, 1)).toMatchObject({ replayed: true });
    const result = await state();
    expect(result.requests[0].status).toBe(1);
    expect(result.users[0].brokeragePrice).toBe("80.00");
    expect(result.brokerage).toHaveLength(1);
    expect(result.brokerage[0].status).toBe(1);
  });

  it("rolls back balances, withdrawal and balance-credit records on a late ledger failure", async () => {
    const before = await state();
    await fixture.exec(`create function fail_withdrawal_ledger() returns trigger language plpgsql as $$ begin raise exception 'injected ledger failure'; end $$;
      create trigger fail_withdrawal before insert on user_brokerage for each row execute function fail_withdrawal_ledger()`);
    try {
      await expect(service.apply(7, bank({ extractType: "balance" }))).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally { await fixture.exec("drop trigger fail_withdrawal on user_brokerage; drop function fail_withdrawal_ledger()"); }
  });

  it("uses authenticated UID and accepts legacy HTTP bodies without leaking replay metadata", async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => { c.set("uid", 7); c.set("container", container); await next(); });
    app.post("/extract/cash", extractCash);
    const response = await app.request("/extract/cash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uid: 8, money: "20", extract_type: "bank", bankname: "测试银行", cardnum: "6222021234567890123", request_id: "http-intent-00000001" }) });
    expect(await response.json()).toMatchObject({ status: 200, data: { id: expect.any(Number) } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await state()).requests[0].uid).toBe(7);
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("PostgreSQL 16: concurrent same-key retries create exactly one request and debit", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => service.apply(7, bank())));
    expect(new Set(results.map((v) => v.id)).size).toBe(1);
    const result = await state();
    expect(result.requests).toHaveLength(1);
    expect(result.brokerage).toHaveLength(1);
    expect(result.users[0].brokeragePrice).toBe("80.00");
  });

  it("keeps request lookup owner-scoped and new-client ledger filtering ahead of pagination", async () => {
    const request = await service.apply(7, bank());
    const finance = new UserFinanceService(container);
    const own = await finance.extractList(7, bank().requestKey);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: request.id });
    expect(own[0]).not.toHaveProperty("requestKey");
    expect(own[0]).not.toHaveProperty("requestHash");
    expect(await finance.extractList(8, bank().requestKey)).toEqual([]);
    await fixture.db.insert(userBrokerage).values([
      { uid: 7, type: "one_brokerage", number: "2.00", pm: 1 },
      { uid: 7, type: "two_brokerage", number: "3.00", pm: 1 },
      { uid: 7, type: "one_brokerage", number: "4.00", pm: 1 },
      { uid: 8, type: "one_brokerage", number: "99.00", pm: 1 },
    ]);
    expect(await finance.commissionList(7, 1, 1, 1)).toMatchObject([{ number: "4.00" }]);
    expect(await finance.commissionList(7, 1, 2, 1)).toMatchObject([{ number: "2.00" }]);
    expect(await finance.commissionList(7, 3, 1, 1)).toMatchObject([{ linkId: String(request.id), type: "extract" }]);
    await expect(finance.commissionList(7, 4)).rejects.toThrow("类型错误");
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("PostgreSQL 16: concurrent distinct intents cannot overspend; repeated rejects credit once", async () => {
    const results = await Promise.allSettled([
      service.apply(7, bank({ extractPrice: "80.00", requestKey: "concurrent-intent-a" })),
      service.apply(7, bank({ extractPrice: "80.00", requestKey: "concurrent-intent-b" })),
    ]);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    const request = (await state()).requests[0];
    await Promise.all([service.review(request.id, 2), service.review(request.id, 2)]);
    const result = await state();
    expect(result.users[0].brokeragePrice).toBe("100.00");
    expect(result.brokerage.filter((v) => v.type === "extract_fail")).toHaveLength(1);
  });
});
