import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { userSearch, userVisit } from "../src/models/schema";
import { normalizeBehaviorIds } from "../src/services/user/UserBehaviorService";

describe("user search and visit migration", () => {
  it("preserves every source column and migration key", () => {
    expect(getTableName(userSearch)).toBe("user_search");
    expect(Object.keys(getTableColumns(userSearch))).toEqual([
      "id", "uid", "keyword", "vicword", "num", "result", "isDel", "addTime",
    ]);
    expect(getTableName(userVisit)).toBe("user_visit");
    expect(Object.keys(getTableColumns(userVisit))).toEqual([
      "id", "uid", "url", "ip", "stayTime", "addTime", "channelType", "province",
    ]);
    for (const table of ["user_search", "user_visit"]) {
      expect(MIGRATION_TABLES.find((entry) => entry.table === table)?.key).toEqual(["id"]);
    }
  });

  it("keeps historical duplicates importable and indexes the runtime query shapes", () => {
    const migration = readFileSync("migrations/0058_user_search_and_visit.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('"user_search_uid_keyword_active"');
    expect(migration).toContain('"user_search_keyword_cache"');
    expect(migration).toContain('"user_visit_channel_time"');
  });

  it("normalizes cached result ids without accepting unsafe values", () => {
    expect(normalizeBehaviorIds("[3,2,3]")).toEqual([3, 2]);
    expect(normalizeBehaviorIds([4, "5", 4])).toEqual([4, 5]);
    expect(normalizeBehaviorIds("invalid")).toEqual([]);
    expect(normalizeBehaviorIds([0, -1, Number.MAX_SAFE_INTEGER + 1])).toEqual([]);
  });

  it("restores search/visit routes and product result reuse", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const product = readFileSync("src/services/product/StoreProductService.ts", "utf8");
    const behavior = readFileSync("src/services/user/UserBehaviorService.ts", "utf8");
    expect(routes).toContain('/user/search_list"');
    expect(routes).toContain('/user/clean_search"');
    expect(routes).toContain('/user/set_visit"');
    expect(product).toContain("resolveProductSearch");
    expect(behavior).toContain("pg_advisory_xact_lock");
    expect(behavior).toContain('.for("update")');
    expect(behavior).toContain("keywordWhere");
    expect(behavior).toContain("搜索关键词不能超过255个字符");
  });

  it("restores best-effort WeChat login visit evidence", () => {
    const wechat = readFileSync("src/services/wechat/WechatAuthService.ts", "utf8");
    expect(wechat).toContain("recordLoginVisit");
    expect(wechat).toContain("user_visit_record_failed");
  });
});
