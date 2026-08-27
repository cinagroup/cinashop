import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { liveAnchor, liveGoods, liveRoom, liveRoomGoods } from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("WeChat mini-program live catalog migration", () => {
  it("preserves all four source tables and source-shaped columns", () => {
    expect([liveAnchor, liveGoods, liveRoom, liveRoomGoods].map(getTableName)).toEqual([
      "live_anchor", "live_goods", "live_room", "live_room_goods",
    ]);
    expect(Object.keys(getTableColumns(liveAnchor))).toEqual([
      "id", "name", "coverImg", "wechat", "phone", "isShow", "isDel", "addTime",
    ]);
    expect(Object.keys(getTableColumns(liveGoods))).toEqual([
      "id", "goodsId", "auditId", "productId", "name", "coverImg", "url", "priceType",
      "costPrice", "price", "price2", "auditStatus", "thirdPartTag", "sort", "isShow",
      "isDel", "addTime",
    ]);
    expect(Object.keys(getTableColumns(liveRoom))).toEqual([
      "id", "roomId", "name", "coverImg", "shareImg", "startTime", "endTime", "anchorName",
      "anchorWechat", "phone", "type", "screenType", "closeLike", "closeGoods", "closeComment",
      "errorMsg", "status", "liveStatus", "mark", "replayStatus", "sort", "isShow", "isDel",
      "addTime",
    ]);
    expect(Object.keys(getTableColumns(liveRoomGoods))).toEqual(["liveRoomId", "liveGoodsId"]);
    expect(getTableConfig(liveRoom).primaryKeys).toHaveLength(1);
    expect(getTableConfig(liveRoomGoods).primaryKeys).toHaveLength(0);
    expect(getTableConfig(liveRoomGoods).uniqueConstraints).toHaveLength(0);
  });

  it("uses the exact mixed primary key and a multiset strategy for the keyless relation", () => {
    expect(MIGRATION_TABLES.find((entry) => entry.table === "live_anchor")?.key).toEqual(["id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "live_goods")?.key).toEqual(["id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "live_room")?.key).toEqual(["id", "phone"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "live_room_goods")?.key).toEqual([]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "live_room_goods")?.copyStrategy)
      .toBe("append_multiset");
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0074 and embedded 0081 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0074_wechat_live_catalog.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0081\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('CONSTRAINT "live_room_pk" PRIMARY KEY ("id", "phone")');
    expect(migration).not.toContain('PRIMARY KEY ("live_room_id", "live_goods_id")');
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("exposes public reads, protected admin catalogs, and only read-oriented remote sync", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/wechat/WechatLiveService.ts", "utf8");
    const scheduler = readFileSync("src/services/order/ScheduledMaintenanceService.ts", "utf8");

    expect(publicRoutes).toContain('v1Routes.get("/wechat/live"');
    expect(publicRoutes).toContain('v1Routes.get("/wechat/livePlaybacks/:id"');
    for (const path of ["/live/room/list", "/live/goods/list", "/live/anchor/list", "/live/sync"]) {
      expect(adminRoutes).toContain(path);
    }
    expect(requiredAdminPermission("GET", "/adminapi/live/room/list")).toBe("live_broadcast.view");
    expect(requiredAdminPermission("POST", "/adminapi/live/sync")).toBe("live_broadcast.manage");
    expect(requiredAdminPermission("GET", "/adminapi/live/room/syncRoom")).toBe("live_broadcast.manage");
    expect(requiredAdminPermission("GET", "/adminapi/live/goods/syncGoods")).toBe("live_broadcast.manage");

    expect(service).toContain('this.request("wxa/business/getliveinfo"');
    expect(service).toContain('this.request("wxa/business/getgoodswarehouse"');
    expect(service).not.toMatch(/room\/create|room\/deleteroom|goods\/add|goods\/resetaudit|goods\/delete/i);
    expect(service).toContain('["live_room_sync", "live_goods_sync"]');
    expect(service).toContain("AbortSignal.timeout(WECHAT_FETCH_TIMEOUT_MS)");
    expect(service).toContain("message.cursor + remotePage.rawCount");
    expect(scheduler).toContain('case "live_room_sync"');
    expect(scheduler).toContain('case "live_goods_sync"');
  });

  it("wires a responsive Admin catalog without remote mutation controls", () => {
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/marketing/WechatLiveCatalog.vue", "utf8");
    expect(router).toContain('path: "marketing/live"');
    expect(layout).toContain('index="/marketing/live"');
    expect(page).toContain("微信外部写操作暂未迁移");
    expect(page).toContain("apiWechatLiveSync");
    expect(page).toContain("mobile-list");
    expect(page).not.toContain("apiWechatLiveCreate");
    expect(page).not.toContain("apiWechatLiveDelete");
    expect(page).not.toContain("apiWechatLiveAudit");
  });
});
