import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { userFriends } from "../src/models/schema";

describe("user friend migration", () => {
  it("preserves every source column and the source primary key", () => {
    expect(getTableName(userFriends)).toBe("user_friends");
    expect(Object.keys(getTableColumns(userFriends))).toEqual([
      "id", "uid", "friendsUid", "addTime",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "user_friends")?.key).toEqual([
      "id",
    ]);
  });

  it("keeps historical duplicate pairs importable", () => {
    const migration = readFileSync("migrations/0057_user_friend_relationships.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('"friends_uid" INTEGER DEFAULT 0 NOT NULL');
    expect(migration).toContain('"uf_pair"');
  });

  it("writes one new friend pair in the same distributor binding transaction", () => {
    const service = readFileSync("src/services/user/UserFinanceService.ts", "utf8");
    const bind = service.slice(service.indexOf("async bindSpread"), service.indexOf("// 充值"));
    expect(bind).toContain("existingFriend");
    expect(bind).toContain("tx.insert(userFriends)");
    expect(bind).toContain("friendsUid: spreadUid");
    expect(bind.indexOf("tx.insert(userSpread)")).toBeLessThan(bind.indexOf("tx.insert(userFriends)"));
  });

  it("restores the authenticated community friend route and bidirectional lookup", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/community/CommunityService.ts", "utf8");
    const social = readFileSync("src/services/community/CommunitySocialService.ts", "utf8");
    expect(routes).toContain('/community/user_friend"');
    expect(routes).toContain("CommunityController.communityUserFriend");
    expect(service).toContain("CommunitySocialService(this.container).friendList");
    expect(social).toContain("eq(userFriends.uid, uid)");
    expect(social).toContain("eq(userFriends.friendsUid, uid)");
    expect(social).toContain("value !== uid");
    expect(social).toContain("is_follow: flags.follows.has(relationId)");
    expect(social).toContain("is_fans: flags.fans.has(relationId)");
  });
});
