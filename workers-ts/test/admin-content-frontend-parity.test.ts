import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Status = "candidate" | "partial" | "missing" | "retired";
interface ContentRouteAudit {
  summary: Record<"legacyRoutes" | Status, number>;
  routes: Array<{
    legacyPath: string;
    status: Status;
    newScreens: string[];
    newApiContracts: string[];
    covered: string;
    remaining: string;
  }>;
}

const audit = JSON.parse(
  readFileSync("audit/admin-legacy-content-route-parity.json", "utf8"),
) as ContentRouteAudit;

describe("legacy Admin content screen parity", () => {
  it("accounts for all thirteen active legacy content routes with granular status", () => {
    expect(audit.routes.map((row) => row.legacyPath)).toEqual([
      "/admin/content/community/topic",
      "/admin/content/community/content",
      "/admin/content/community/addContent/:id?",
      "/admin/content/community/comment",
      "/admin/content/community/setting",
      "/admin/content/article/index/:id?",
      "/admin/content/article_category/index",
      "/admin/content/article/add_article/:id?",
      "/admin/content/live/live_room",
      "/admin/content/live/add_live_room",
      "/admin/content/live/live_goods",
      "/admin/content/live/add_live_goods",
      "/admin/content/live/anchor",
    ]);
    expect(audit.summary).toEqual({
      legacyRoutes: 13,
      candidate: 9,
      partial: 2,
      missing: 2,
      retired: 0,
    });
    for (const status of ["candidate", "partial", "missing", "retired"] as const) {
      expect(audit.routes.filter((row) => row.status === status)).toHaveLength(audit.summary[status]);
    }
    for (const row of audit.routes) {
      expect(row.covered.length).toBeGreaterThan(20);
      expect(row.remaining.length).toBeGreaterThan(20);
      if (row.status === "missing") {
        expect(row.newScreens).toEqual([]);
        expect(row.newApiContracts).toEqual([]);
      } else {
        expect(row.newScreens.length).toBeGreaterThan(0);
        expect(row.newApiContracts.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the consolidated CMS article replacement contract complete and explicit", () => {
    const category = audit.routes.find((row) => row.legacyPath === "/admin/content/article_category/index");
    const editor = audit.routes.find((row) => row.legacyPath === "/admin/content/article/add_article/:id?");
    const page = readFileSync("../view/admin-ts/src/pages/content/ArticleList.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/article.ts", "utf8");
    expect(category?.status).toBe("candidate");
    expect(editor?.status).toBe("candidate");
    expect(api).toContain('request.get("/article/list"');
    expect(api).toContain('request.get("/article/category"');
    expect(api).toContain('request.get("/article/product-options"');
    expect(api).toContain('request.get("/article/attachment-options"');
    expect(page).toContain("articleForm.synopsis");
    expect(page).toContain("articleForm.image_input");
    expect(page).toContain("articleForm.product_id");
    expect(page).not.toContain("v-html");
  });

  it("keeps mini-program live remote writes explicitly below parity", () => {
    const missing = audit.routes.filter((row) => row.status === "missing").map((row) => row.legacyPath);
    const page = readFileSync("../view/admin-ts/src/pages/marketing/WechatLiveCatalog.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/wechatLive.ts", "utf8");
    expect(missing).toContain("/admin/content/live/add_live_room");
    expect(missing).toContain("/admin/content/live/add_live_goods");
    const anchor = audit.routes.find((row) => row.legacyPath === "/admin/content/live/anchor");
    expect(anchor?.status).toBe("candidate");
    expect(page).toContain("微信远程写操作仍受保护");
    expect(page).toContain("apiWechatLiveAnchorSave");
    expect(api).toContain('request.get("/live/room/list"');
    expect(api).toContain('request.get(`/live/room/detail/${id}`');
    expect(api).toContain('request.get("/live/goods/list"');
    expect(api).toContain('request.get(`/live/goods/detail/${id}`');
    expect(api).toContain('request.get("/live/anchor/list"');
    expect(api).toContain('request.post("/live/anchor/save"');
    expect(api).not.toMatch(/request\.(?:post|put|delete)\("\/live\/(?:room|goods)\/(?:create|add|audit|reset|delete)/i);
  });
});
