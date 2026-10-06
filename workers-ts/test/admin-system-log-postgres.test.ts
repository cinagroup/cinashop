import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContainerFromDb } from "../src/lib/di";
import { systemAdmin, systemLog } from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import { AdminSystemLogReadService } from "../src/services/admin/AdminSystemLogReadService";
import { financePostgres } from "./helpers/financePostgres";

const shanghai = (value: string) => Math.floor(Date.parse(`${value}+08:00`) / 1000);
const search = (values: Record<string, string>) => new URLSearchParams(values);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))("admin system log read contract on owned PG16", () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let service: AdminSystemLogReadService;
  beforeEach(async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("External I/O forbidden"));
    fixture = await financePostgres([systemAdmin, systemLog]);
    service = new AdminSystemLogReadService(createContainerFromDb(fixture.db));
    await fixture.db.insert(systemAdmin).values([
      { id: 1, realName: "顶级管理员", level: 0 },
      { id: 2, realName: "当前管理员", level: 1 },
      { id: 3, realName: "下级管理员", level: 2 },
    ]);
    await fixture.db.insert(systemLog).values([
      { id: 10, adminId: 1, adminName: "顶级管理员", path: "/root", page: "顶级操作", ip: "10.0.0.1", type: "admin", addTime: shanghai("2026-09-28T09:00:00") },
      { id: 11, adminId: 2, adminName: "当前管理员", path: "/orders", page: "订单", ip: "10.0.0.2", type: "admin", addTime: shanghai("2026-09-28T09:00:00") },
      { id: 12, adminId: 3, adminName: "下级管理员", path: "/orders?name=100%", page: "查看", ip: "10.0.0.3", type: "admin", addTime: shanghai("2026-09-28T10:00:00") },
      { id: 13, adminId: 3, adminName: "下级管理员", path: "/orders", action: "Worker 写入", ip: "10.0.0.3", type: "admin", addTime: shanghai("2026-09-28T10:00:01") },
      { id: 14, adminId: 0, adminName: "门店", path: "/store", page: "门店行为", ip: "10.0.0.4", type: "store", addTime: shanghai("2026-09-28T11:00:00") },
    ]);
  }, 30_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await fixture?.close(); }
  }, 30_000);

  it("keeps both admin options and all list filters within actor level, including explicit IDs", async () => {
    const before = await fixture.db.select().from(systemLog);
    expect((await service.adminOptions(1)).info.map(row => row.id)).toEqual([2, 3]);
    expect((await service.list(search({}), 1)).list.map(row => row.id)).toEqual([13, 12, 11]);
    expect((await service.list(search({ admin_id: "1" }), 1)).list).toEqual([]);
    expect((await service.list(search({ admin_id: "3", path: "100%", ip: "10.0.0.3" }), 1)).list.map(row => row.id)).toEqual([12]);
    expect((await service.list(search({ path: "100_" }), 1)).list).toEqual([]);
    expect((await service.list(search({ start_time: String(shanghai("2026-09-28T10:00:00")), end_time: String(shanghai("2026-09-28T10:00:01")) }), 1)).list.map(row => row.id)).toEqual([13, 12]);
    expect((await service.list(search({ start_time: String(shanghai("2026-09-28T10:00:01")), end_time: String(shanghai("2026-09-28T10:00:01")) }), 1)).list.map(row => row.id)).toEqual([13]);
    expect(await fixture.db.select().from(systemLog)).toEqual(before);
  });

  it("returns the legacy columns, stable filtered pagination and no SELECT * fields", async () => {
    const first = await service.list(search({ page: "1", limit: "1", path: "/orders" }), 1);
    const second = await service.list(search({ page: "2", limit: "1", path: "/orders" }), 1);
    expect(first).toMatchObject({ total: 3, count: 3, page: 1, limit: 1 });
    expect(first.list.map(row => row.id)).toEqual([13]);
    expect(second.list.map(row => row.id)).toEqual([12]);
    expect(Object.keys(first.list[0]).sort()).toEqual(["action", "add_time", "admin_id", "admin_name", "id", "ip", "page", "path", "type"]);
  });

  it("rejects unbounded, duplicate, unsupported and malformed queries before SQL", async () => {
    for (const query of ["limit=0", "limit=101", "page=0", "page=1002", "page=202&limit=100", "page=1&page=2", "sort=admin_id", "path=%20%20", "start_time=0", "end_time=0", "admin_id=-1", "start_time=10&end_time=9"]) {
      await expect(service.list(new URLSearchParams(query), 1)).rejects.toThrow();
    }
    await expect(service.adminOptions(-1)).rejects.toThrow();
  });

  it("maps both registered read-only URLs solely to log.view", () => {
    for (const prefix of ["/adminapi", "/api/admin"]) {
      expect(requiredAdminPermission("GET", `${prefix}/log/list`)).toBe("log.view");
      expect(requiredAdminPermission("GET", `${prefix}/log/admin-options`)).toBe("log.view");
    }
  });
});
