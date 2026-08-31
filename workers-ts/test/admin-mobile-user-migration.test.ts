import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminMobileUserAddresses,
  adminMobileUserCouponGrant,
  adminMobileUserDefaultAddress,
  adminMobileUserGroups,
  adminMobileUserLabels,
  adminMobileUserLevels,
  adminMobileUserUpdate,
  adminMobileUserUpdateOther,
} from "@/controllers/api/v1/AdminCrudController";
import {
  AdminMobileUserService,
  parseAdminUserBatchInput,
  parseAdminUserCouponQuery,
  parseAdminUserFinanceInput,
} from "@/services/admin/AdminMobileUserService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { MigrationService } from "@/services/MigrationService";

afterEach(() => vi.restoreAllMocks());

function context(options: {
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
} = {}) {
  const header = vi.fn();
  const actor = { id: 7, account: "admin", realName: "管理员" };
  return {
    header,
    value: {
      req: {
        query: () => options.query ?? {},
        param: (name: string) => options.params?.[name] ?? "",
        json: vi.fn().mockResolvedValue(options.body),
        header: (name: string) => name === "Idempotency-Key"
          ? options.idempotencyKey
          : name === "CF-Connecting-IP" ? "203.0.113.8" : undefined,
      },
      get: (key: string) => key === "container" ? {} : key === "adminInfo" ? actor : undefined,
      header,
      json: (body: unknown) => Response.json(body),
    } as never,
  };
}

describe("embedded admin mobile user migration", () => {
  it("parses bounded PHP coupon filters", () => {
    expect(parseAdminUserCouponQuery({})).toEqual({ uid: 0, page: 1, limit: 20, title: "" });
    expect(parseAdminUserCouponQuery({
      uid: "9",
      page: "2",
      limit: "100",
      coupon_title: " 会员券 ",
    })).toEqual({ uid: 9, page: 2, limit: 100, title: "会员券" });
    expect(() => parseAdminUserCouponQuery({ limit: "101" })).toThrow("每页数量错误");
    expect(() => parseAdminUserCouponQuery({ uid: "-1" })).toThrow("用户ID错误");
  });

  it("normalizes finance input without copying PHP negative-integral behavior", () => {
    expect(parseAdminUserFinanceInput("8", { status: 1, number: "12.30", type: 1 }))
      .toEqual({ uid: 8, status: 1, kind: "money", moneyCents: 1230, integral: 0 });
    expect(parseAdminUserFinanceInput(8, { status: 2, number: "7", type: 0 }))
      .toEqual({ uid: 8, status: 2, kind: "integral", moneyCents: 0, integral: 7 });
    expect(parseAdminUserFinanceInput(8, { status: 2, number: "7", type: 2 }).kind)
      .toBe("integral");
    expect(() => parseAdminUserFinanceInput(8, { status: 3, number: 1, type: 1 }))
      .toThrow("修改类型错误");
    expect(() => parseAdminUserFinanceInput(8, { status: 1, number: 0, type: 0 }))
      .toThrow("积分数量错误");
    expect(() => parseAdminUserFinanceInput(8, {
      status: 1,
      number: 1,
      type: 1,
      ignored: true,
    })).toThrow("不支持的字段");
  });

  it("accepts only the five old mobile update modes with explicit bounds", () => {
    expect(parseAdminUserBatchInput({ uid: 1, type: 1, level: 2 }))
      .toEqual({ type: 1, uids: [1], levelId: 2 });
    expect(parseAdminUserBatchInput({ uid: 1, type: 2, days_status: 2, days: 3 }))
      .toEqual({ type: 2, uids: [1], daysStatus: 2, days: 3 });
    expect(parseAdminUserBatchInput({ uid: [3, 2, 3], type: 3, coupon_id: 9 }))
      .toEqual({ type: 3, uids: [2, 3], couponId: 9 });
    expect(parseAdminUserBatchInput({ uid: [3, 2], type: 4, group_id: 8 }))
      .toEqual({ type: 4, uids: [2, 3], groupId: 8 });
    expect(parseAdminUserBatchInput({ uid: [3, 2], type: 5, label_id: [] }))
      .toEqual({ type: 5, uids: [2, 3], labelIds: [] });
    expect(() => parseAdminUserBatchInput({ uid: [1, 2], type: 2, days_status: 1, days: 3 }))
      .toThrow("会员时长修改只支持单个用户");
    expect(() => parseAdminUserBatchInput({ uid: 1, type: 6 })).toThrow("处理类型错误");
    expect(() => parseAdminUserBatchInput({ uid: Array.from({ length: 101 }, (_, i) => i + 1), type: 4, group_id: 1 }))
      .toThrow("用户不能超过100项");
  });

  it("returns private PHP envelopes from all eight handlers", async () => {
    vi.spyOn(AdminMobileUserService.prototype, "labels").mockResolvedValue([]);
    vi.spyOn(AdminMobileUserService.prototype, "couponGrant").mockResolvedValue({ list: [], count: 0 });
    vi.spyOn(AdminMobileUserService.prototype, "groups").mockResolvedValue([]);
    vi.spyOn(AdminMobileUserService.prototype, "levels").mockResolvedValue({ list: [], count: 0 });
    vi.spyOn(AdminMobileUserService.prototype, "adjustFinance").mockResolvedValue({ uid: 1, idempotent: false });
    vi.spyOn(AdminMobileUserService.prototype, "update").mockResolvedValue({ changed: 1 });
    vi.spyOn(AdminMobileUserService.prototype, "addresses").mockResolvedValue([]);
    vi.spyOn(AdminMobileUserService.prototype, "defaultAddress").mockResolvedValue(null);
    const calls = [
      [adminMobileUserLabels, context({ params: { uid: "1" } })],
      [adminMobileUserCouponGrant, context({ query: {} })],
      [adminMobileUserGroups, context()],
      [adminMobileUserLevels, context()],
      [adminMobileUserUpdateOther, context({
        params: { uid: "1" },
        body: { status: 1, number: 1, type: 1 },
        idempotencyKey: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
      })],
      [adminMobileUserUpdate, context({ body: { uid: 1, type: 1, level: 1 } })],
      [adminMobileUserAddresses, context({ params: { uid: "1" } })],
      [adminMobileUserDefaultAddress, context({ params: { uid: "1" } })],
    ] as const;
    for (const [handler, testContext] of calls) {
      const response = await handler(testContext.value);
      expect((await response.json()) as { status: number }).toMatchObject({ status: 200 });
      expect(testContext.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    }
  });

  it("mounts all exact PHP routes behind user view/manage ACL", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const expected = [
      'get("/admin/user/label/:uid", adminAuth, AdminCrud.adminMobileUserLabels)',
      'get("/admin/user/coupon/grant", adminAuth, AdminCrud.adminMobileUserCouponGrant)',
      'get("/admin/user/group/list", adminAuth, AdminCrud.adminMobileUserGroups)',
      'get("/admin/user/level/list", adminAuth, AdminCrud.adminMobileUserLevels)',
      'post("/admin/user/update_other/:uid", adminAuth, AdminCrud.adminMobileUserUpdateOther)',
      'post("/admin/user/update", adminAuth, AdminCrud.adminMobileUserUpdate)',
      'get("/admin/user/address/list/:uid", adminAuth, AdminCrud.adminMobileUserAddresses)',
      '"/admin/user/address/default/:uid"',
      "AdminCrud.adminMobileUserDefaultAddress",
    ];
    for (const route of expected) expect(routes).toContain(route);
    expect(requiredAdminPermission("GET", "/api/admin/user/coupon/grant")).toBe("user.view");
    expect(requiredAdminPermission("GET", "/api/admin/user/address/default/:uid")).toBe("user.view");
    expect(requiredAdminPermission("POST", "/api/admin/user/update_other/:uid")).toBe("user.manage");
    expect(requiredAdminPermission("POST", "/api/admin/user/update")).toBe("user.manage");
  });

  it("keeps irreversible writes locked, idempotent, atomic, and auditable", () => {
    const service = readFileSync("src/services/admin/AdminMobileUserService.ts", "utf8");
    expect(service).toContain("normalizeOutRequestKey(requestKeyValue)");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain("await tx.insert(adminUserWriteReplay).values");
    expect(service).toContain("type: AUDIT_TYPE");
    expect(service).toContain('orderBy(asc(user.uid)).for("update")');
    expect(service).toContain('type: input.status === 1 ? "system_add" : "system_sub"');
    expect(service).toContain('eventKey: input.status === 1 ? "admin_system_add_integral"');
    expect(service).toContain('throw new ValidateException("优惠券库存不足，整批未发放")');
    expect(service).toContain("await recordReplay(tx, actor, \"coupon_grant\", key, hash, subject, {");
    expect(service).toContain('receiveSource: "send"');
    expect(service).toContain("await tx.insert(otherOrderStatus).values");
    expect(service).toContain("Math.min(input.integral, account.integral)");
  });

  it("ships the exact idempotent replay DDL with a database unique fence", () => {
    const external = readFileSync("migrations/0119_admin_mobile_user_replay.sql", "utf8").trim();
    const embedded = new MigrationService({} as never)
      .adminMobileUserReplayMigrationSqlForVerification().trim();
    expect(embedded).toBe(external);
    expect(external).toContain('CREATE TABLE IF NOT EXISTS "admin_user_write_replay"');
    expect(external).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "auwr_admin_operation_key_uq"');
    expect(external).toContain('"operation" IN (\'finance\', \'membership\', \'coupon_grant\')');
    expect(external).not.toMatch(/coupon_title|coupon_price|now_money|integral"\s+(?:INTEGER|NUMERIC)/i);
  });
});
