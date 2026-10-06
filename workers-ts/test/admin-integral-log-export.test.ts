import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createContainerFromDb } from "../src/lib/di";
import { user, userBill } from "../src/models/schema";
import { AdminIntegralLogExportService, INTEGRAL_LOG_EXPORT_HEADER, INTEGRAL_LOG_EXPORT_KEYS } from "../src/services/admin/AdminIntegralLogExportService";
import { financePostgres } from "./helpers/financePostgres";

function csv(manifest: Awaited<ReturnType<AdminIntegralLogExportService["manifest"]>>, rows = manifest.export): string {
  return "\ufeff" + [manifest.header, ...rows.map(row => manifest.filekey.map(key => row[key as keyof typeof row]))]
    .map(cells => cells.map(cell => `"${cell.replace(/"/gu, '""')}"`).join(",") + "\r\n").join("");
}

describe("complete bounded Admin integral log export", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminIntegralLogExportService;
  const manifest = (value: Record<string, string> = {}) => service.manifest(new URLSearchParams(value));

  beforeEach(async () => {
    fixture = await financePostgres([user, userBill]);
    service = new AdminIntegralLogExportService(createContainerFromDb(fixture.db));
  }, 30_000);
  afterEach(async () => { await fixture?.close(); }, 30_000);

  it("returns the seven legacy columns with complete empty-set bytes and strict parameters", async () => {
    const empty = await manifest();
    expect(empty).toMatchObject({ header: [...INTEGRAL_LOG_EXPORT_HEADER], filekey: [...INTEGRAL_LOG_EXPORT_KEYS],
      export: [], filename: "积分日志", count: 0, page: 1, limit: 1000, has_more: false,
      max_rows: 100000, max_bytes: 16777216, timezone: "Asia/Shanghai" });
    expect(empty.snapshot).toMatch(/^[a-f0-9]{64}$/u);
    expect(empty.csv_bytes).toBe(new TextEncoder().encode(csv(empty)).byteLength);
    for (const bad of ["page=0", "page=01", "page=100001&limit=1", "page=2", "limit=0", "limit=1001",
      "keyword=%00", "type=sign%3BDELETE", "start=-1", "start=500&stop=100", "unknown=1",
      "page=1&page=2", "snapshot=bad"]) {
      await expect(service.manifest(new URLSearchParams(bad)), bad).rejects.toThrow();
    }
  });

  it("exports all matching integral rows over multiple stable pages with the same filters as the list", async () => {
    await fixture.db.insert(user).values([{ uid: 11, nickname: "小明", phone: "13800138000" }, { uid: 22, nickname: "其他" }]);
    await fixture.exec("INSERT INTO user_bill(uid,category,type,title,number,balance,add_time) SELECT 11,'integral','sign','会员签到',1.99,n,1700000000+n FROM generate_series(1,1003) n");
    await fixture.db.insert(userBill).values([{ uid: 22, category: "integral", type: "sign", title: "其他签到", number: "9.00" },
      { uid: 11, category: "now_money", type: "sign", title: "余额签到", number: "99.00" }]);
    const first = await manifest({ keyword: "小明", type: "sign", start: "1700000001", stop: "1700001003" });
    const second = await manifest({ keyword: "小明", type: "sign", start: "1700000001", stop: "1700001003",
      page: "2", snapshot: first.snapshot });
    expect(first).toMatchObject({ count: 1003, page: 1, has_more: true });
    expect(second).toMatchObject({ count: 1003, page: 2, has_more: false, snapshot: first.snapshot,
      csv_bytes: first.csv_bytes });
    expect(first.export).toHaveLength(1000);
    expect(second.export).toHaveLength(3);
    const rows = [...first.export, ...second.export];
    expect(rows.map(row => Number(row.id))).toEqual(Array.from({ length: 1003 }, (_, index) => 1003 - index));
    expect(rows[0]).toMatchObject({ title: "会员签到", balance: "1003", number: "1", nickname: "小明",
      add_time: "2023-11-15 06:30:03" });
    expect(new TextEncoder().encode(csv(first, rows)).byteLength).toBe(first.csv_bytes);
  }, 45_000);

  it("invalidates subsequent pages after ledger or member changes, including changes outside the requested page", async () => {
    await fixture.db.insert(user).values({ uid: 11, nickname: "原昵称" });
    await fixture.db.insert(userBill).values([{ id: 1, uid: 11, category: "integral", title: "A" },
      { id: 2, uid: 11, category: "integral", title: "B" }]);
    const first = await manifest({ limit: "1" });
    await fixture.db.update(userBill).set({ mark: "变化" }).where(eq(userBill.id, 1));
    await expect(manifest({ limit: "1", page: "2", snapshot: first.snapshot })).rejects.toThrow("已变化");
    const again = await manifest({ limit: "1" });
    await fixture.db.update(user).set({ nickname: "新昵称" }).where(eq(user.uid, 11));
    await expect(manifest({ limit: "1", page: "2", snapshot: again.snapshot })).rejects.toThrow("已变化");
    const third = await manifest({ limit: "1" });
    await expect(manifest({ limit: "1", page: "2", keyword: "B", snapshot: third.snapshot })).rejects.toThrow("已变化");
    await fixture.db.insert(userBill).values({ id: 4, uid: 11, category: "integral", title: "新增" });
    await expect(manifest({ limit: "1", page: "2", snapshot: third.snapshot })).rejects.toThrow("已变化");
  });

  it("protects spreadsheet formula text and preserves quotes, newlines and Shanghai time", async () => {
    await fixture.db.insert(user).values({ uid: 11, nickname: "=HYPERLINK(1)" });
    await fixture.db.insert(userBill).values({ id: 1, uid: 11, category: "integral", title: "\t@SUM(1)", mark: "普通,\"引号\"\n第二行", addTime: 1_700_000_000 });
    const first = await manifest();
    expect(first.export[0]).toMatchObject({ title: "'\t@SUM(1)", mark: "普通,\"引号\"\n第二行",
      nickname: "'=HYPERLINK(1)", add_time: "2023-11-15 06:13:20" });
    expect(new TextEncoder().encode(csv(first)).byteLength).toBe(first.csv_bytes);
    await fixture.db.update(userBill).set({ mark: "-1+2" }).where(eq(userBill.id, 1));
    expect((await manifest()).export[0].mark).toBe("'-1+2");
  });

  it("rejects invalid decimal source values instead of exporting misleading points", async () => {
    await fixture.db.insert(userBill).values({ id: 1, category: "integral", title: "异常数值" });
    await fixture.exec("UPDATE user_bill SET number='NaN' WHERE id=1");
    await expect(manifest()).rejects.toThrow("数值无效");
  });
});
