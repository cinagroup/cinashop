import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "../src/lib/di";
import { user, userMoney } from "../src/models/schema";
import { AdminUserMoneyLedgerService, parseAdminUserMoneyLedgerQuery } from "../src/services/admin/AdminUserMoneyLedgerService";
import { AdminUserMoneyLedgerExportService, USER_MONEY_EXPORT_HEADER, USER_MONEY_EXPORT_KEYS } from "../src/services/admin/AdminUserMoneyLedgerExportService";
import { financePostgres } from "./helpers/financePostgres";

function csv(manifest: Awaited<ReturnType<AdminUserMoneyLedgerExportService["manifest"]>>, rows = manifest.export): string {
  return "\ufeff" + [manifest.header, ...rows.map(row => manifest.filekey.map(key => row[key as keyof typeof row]))]
    .map(cells => cells.map(cell => `"${cell.replace(/"/gu, '""')}"`).join(",") + "\r\n").join("");
}

describe("legacy user_money Admin ledger, not user_bill", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminUserMoneyLedgerService;
  let exportService: AdminUserMoneyLedgerExportService;
  const query = (value: Record<string, string> = {}) => parseAdminUserMoneyLedgerQuery(new URLSearchParams(value));
  const manifest = (value: Record<string, string> = {}) => exportService.manifest(new URLSearchParams(value));

  beforeEach(async () => {
    fixture = await financePostgres([user, userMoney]);
    const container = createContainerFromDb(fixture.db);
    service = new AdminUserMoneyLedgerService(container);
    exportService = new AdminUserMoneyLedgerExportService(container);
  }, 30_000);
  afterEach(async () => { await fixture?.close(); }, 30_000);

  it("uses the cash ledger, the four legacy exclusions, 20-row pages and all-type directory", async () => {
    await fixture.db.insert(user).values([{ uid: 11, nickname: "会员甲", account: "cash-11", phone: "13800138000" },
      { uid: 22, nickname: "会员乙" }]);
    await fixture.exec("INSERT INTO user_money(uid,type,title,number,pm,add_time) SELECT 11,'recharge','充值余额',10.50,1,1700000000+n FROM generate_series(1,21) n");
    await fixture.db.insert(userMoney).values([
      { uid: 11, type: "sign", title: "排除签到", number: "99.00", addTime: 1_700_000_100 },
      { uid: 11, type: "gain", title: "排除增加", number: "99.00", addTime: 1_700_000_101 },
      { uid: 11, type: "system_sub", title: "排除扣减", number: "99.00", addTime: 1_700_000_102 },
      { uid: 11, type: "deduction", title: "排除抵扣", number: "99.00", addTime: 1_700_000_103 },
      { uid: 22, type: "recharge", title: "别的会员", number: "20.00", addTime: 1_700_000_104 },
    ]);
    const first = await service.list(query({ keyword: "cash-11" }));
    const second = await service.list(query({ keyword: "cash-11", page: "2" }));
    expect(first).toMatchObject({ count: 21, page: 1, limit: 20 });
    expect(first.list).toHaveLength(20);
    expect(second.list).toHaveLength(1);
    expect(first.list[0]).toMatchObject({ uid: 11, nickname: "会员甲", number: "10.50",
      add_time: "2023-11-15 06:13:41" });
    expect((await service.list(query({ keyword: "13800138000", type: "recharge",
      start: "1700000001", stop: "1700000021" }))).count).toBe(21);
    expect((await service.list(query({ type: "sign" }))).count).toBe(0);
    expect((await service.types()).list.map(row => row.type)).toEqual(["deduction", "gain", "recharge", "sign", "system_sub"]);
    for (const bad of ["page=0", "limit=15", "keyword=%00", "page=1&page=2", "type=%00", "start=3", "start=8&stop=7", "bogus=1"]) {
      expect(() => parseAdminUserMoneyLedgerQuery(new URLSearchParams(bad)), bad).toThrow();
    }
  });

  it("exports the six old columns and signed decimal amounts across stable pages", async () => {
    await fixture.db.insert(user).values({ uid: 11, nickname: "会员甲" });
    await fixture.exec("INSERT INTO user_money(uid,type,title,number,pm,mark,add_time) SELECT 11,'recharge','充值',10.50, CASE WHEN n=1 THEN 0 ELSE 1 END,'正常',1700000000+n FROM generate_series(1,1003) n");
    const first = await manifest({ keyword: "会员甲", type: "recharge", start: "1700000001", stop: "1700001003" });
    const second = await manifest({ keyword: "会员甲", type: "recharge", start: "1700000001", stop: "1700001003",
      page: "2", snapshot: first.snapshot });
    expect(first).toMatchObject({ header: [...USER_MONEY_EXPORT_HEADER], filekey: [...USER_MONEY_EXPORT_KEYS],
      filename: "资金监控", count: 1003, page: 1, limit: 1000, has_more: true,
      max_rows: 100000, max_bytes: 16777216, timezone: "Asia/Shanghai" });
    expect(second).toMatchObject({ count: 1003, page: 2, has_more: false, snapshot: first.snapshot,
      csv_bytes: first.csv_bytes });
    const rows = [...first.export, ...second.export];
    expect(rows).toHaveLength(1003);
    expect(rows[0]).toMatchObject({ uid: "11", nickname: "会员甲", pm: "10.50", title: "充值",
      add_time: "2023-11-15 06:30:03" });
    expect(rows.at(-1)?.pm).toBe("-10.50");
    expect(new TextEncoder().encode(csv(first, rows)).byteLength).toBe(first.csv_bytes);
  }, 45_000);

  it("guards formula text and rejects later pages after cash or member drift", async () => {
    await fixture.db.insert(user).values({ uid: 11, nickname: "=HYPERLINK(1)" });
    await fixture.db.insert(userMoney).values([{ id: 1, uid: 11, type: "recharge", title: "@充值", number: "5.00",
      mark: "\t=CMD", addTime: 1_700_000_000 },
      { id: 2, uid: 11, type: "recharge", title: "第二笔", number: "1.00" }]);
    const first = await manifest({ limit: "1" });
    expect(first.export[0]).toMatchObject({ nickname: "'=HYPERLINK(1)" });
    expect(new TextEncoder().encode(csv(first)).byteLength).toBeLessThan(first.csv_bytes);
    const initiallySafe = await manifest();
    expect(initiallySafe.export[1]).toMatchObject({ title: "'@充值", mark: "'\t=CMD" });
    expect(new TextEncoder().encode(csv(initiallySafe)).byteLength).toBe(initiallySafe.csv_bytes);
    await fixture.db.update(userMoney).set({ mark: "更新" }).where(eq(userMoney.id, 1));
    await expect(manifest({ limit: "1", page: "2", snapshot: first.snapshot })).rejects.toThrow("已变化");
    const again = await manifest({ limit: "1" });
    await fixture.db.update(user).set({ nickname: "新昵称" }).where(eq(user.uid, 11));
    await expect(manifest({ limit: "1", page: "2", snapshot: again.snapshot })).rejects.toThrow("已变化");
    const safe = await manifest();
    expect(safe.export[1]).toMatchObject({ title: "'@充值", mark: "更新" });
    expect(new TextEncoder().encode(csv(safe)).byteLength).toBe(safe.csv_bytes);
  });

  it("rejects invalid money and malformed export pagination", async () => {
    const empty = await manifest();
    expect(empty).toMatchObject({ count: 0, export: [], has_more: false });
    expect(new TextEncoder().encode(csv(empty)).byteLength).toBe(empty.csv_bytes);
    for (const bad of ["page=2", "limit=0", "limit=1001", "page=1&page=2", "snapshot=bad", "unknown=1"]) {
      await expect(exportService.manifest(new URLSearchParams(bad)), bad).rejects.toThrow();
    }
    await fixture.db.insert(userMoney).values({ id: 1, type: "recharge", number: "1.00" });
    await fixture.exec("UPDATE user_money SET number='NaN' WHERE id=1");
    await expect(manifest()).rejects.toThrow("金额或收支类型无效");
    await fixture.db.update(userMoney).set({ number: "-10.00" }).where(eq(userMoney.id, 1));
    await expect(manifest()).rejects.toThrow("金额或收支类型无效");
    await fixture.db.update(userMoney).set({ number: "10.00", pm: 2 }).where(eq(userMoney.id, 1));
    await expect(manifest()).rejects.toThrow("金额或收支类型无效");
  });
});
