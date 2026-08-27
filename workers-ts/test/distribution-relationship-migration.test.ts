import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import {
  promoterApply,
  userBrokerageFrozen,
  userSpread,
} from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";

describe("distribution relationship migration", () => {
  it("preserves every source column and primary migration key", () => {
    expect(getTableName(promoterApply)).toBe("promoter_apply");
    expect(Object.keys(getTableColumns(promoterApply))).toEqual([
      "id", "uid", "nickname", "realName", "phone", "status", "addTime",
      "statusTime", "refusalReason", "isDel",
    ]);
    expect(getTableName(userSpread)).toBe("user_spread");
    expect(Object.keys(getTableColumns(userSpread))).toEqual([
      "id", "storeId", "uid", "staffId", "spreadUid", "spreadTime", "adminId",
    ]);
    expect(getTableName(userBrokerageFrozen)).toBe("user_brokerage_frozen");
    expect(Object.keys(getTableColumns(userBrokerageFrozen))).toEqual([
      "id", "uid", "price", "uillId", "frozenTime", "status", "addTime", "orderId",
    ]);
    for (const table of ["promoter_apply", "user_spread", "user_brokerage_frozen"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
  });

  it("does not invent uniqueness or normalize away the legacy uill_id typo", () => {
    const migration = readFileSync("migrations/0056_distribution_relationships.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('"uill_id" INTEGER DEFAULT 0 NOT NULL');
    expect(migration).toContain('"price" DECIMAL(12,2) DEFAULT 0 NOT NULL');
    expect(migration).toContain("must not double-count it");
  });

  it("restores PHP-compatible application routes behind distribution ACL", () => {
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(publicRoutes).toContain('/user/promoter/apply/info"');
    expect(publicRoutes).toContain('/user/promoter/apply/:id"');
    for (const routes of [publicRoutes, adminRoutes]) {
      expect(routes).toContain('/promoter/apply/list"');
      expect(routes).toContain('/promoter/apply/examine/:id/:uid/:status"');
      expect(routes).toContain('/promoter/apply/del/:id"');
    }
    expect(requiredAdminPermission("GET", "/adminapi/promoter/apply/list")).toBe(
      "distribution.view",
    );
    expect(
      requiredAdminPermission("DELETE", "/api/admin/promoter/apply/del/1"),
    ).toBe("distribution.manage");
  });

  it("keeps SMS/config gates and ownership checks on distributor applications", () => {
    const service = readFileSync("src/services/agent/PromoterApplicationService.ts", "utf8");
    expect(service).toContain("brokerage_func_status");
    expect(service).toContain("store_brokerage_statu");
    expect(service).toContain("`code_${phone}`");
    expect(service).toContain("cacheDelete");
    expect(service).toContain("existing.uid !== uid");
    expect(service).toContain('.for("update")');
    expect(service).toContain("pg_advisory_xact_lock");
  });

  it("binds, counts and audits atomically while rejecting relationship cycles", () => {
    const service = readFileSync("src/services/user/UserFinanceService.ts", "utf8");
    const bind = service.slice(service.indexOf("async bindSpread"), service.indexOf("// 充值"));
    expect(bind).toContain("withTx");
    expect(bind).toContain("pg_advisory_xact_lock(505602, 0)");
    expect(bind).toContain("new Set<number>()");
    expect(bind).toContain("推广关系不能形成循环");
    expect(bind).toContain("depth >= 100");
    expect(bind).toContain("tx.insert(userSpread)");
    expect(bind).toContain("spreadCount");
    expect(bind).not.toContain("userBrokerageFrozen");
    const login = readFileSync("src/services/user/LoginService.ts", "utf8");
    const wechat = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    expect(login).toContain("new UserFinanceService(this.container)");
    expect(login).toContain("new UserFinanceService(c)");
    expect(wechat).toContain("new UserFinanceService(this.container)");
  });
});
