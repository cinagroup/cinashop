import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  legacyHomeLimit,
  legacyPresalePayStatus,
} from "@/services/product/PublicCatalogService";

describe("API-004 home compatibility migration", () => {
  it("mounts both v2 routes with optional authentication", () => {
    const routes = readFileSync("src/routes/v2/index.ts", "utf8");
    expect(routes).toContain(
      'v2Routes.get("/index", authMiddleware({ force: false }), PublicController.indexV2)',
    );
    expect(routes).toContain(
      'v2Routes.get("/subscribe", authMiddleware({ force: false }), PublicController.subscribeV2)',
    );
  });

  it("also restores the v1 subscribe path actually called by the old UniApp", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain(
      'v1Routes.get("/subscribe", authMiddleware({ force: false }), PublicController.subscribe)',
    );
  });

  it("preserves PHP integer-prefix counts while bounding homepage reads", () => {
    expect(legacyHomeLimit("12items")).toBe(12);
    expect(legacyHomeLimit("9999")).toBe(100);
    expect(legacyHomeLimit("0")).toBe(0);
    expect(legacyHomeLimit("bad")).toBe(0);
  });

  it("projects all four PHP presale states", () => {
    expect(legacyPresalePayStatus(0, 200, 300, 250)).toBe(0);
    expect(legacyPresalePayStatus(1, 300, 400, 250)).toBe(1);
    expect(legacyPresalePayStatus(1, 200, 300, 250)).toBe(2);
    expect(legacyPresalePayStatus(1, 100, 200, 250)).toBe(3);
  });

  it("uses child categories and the six-field v2 response shape", () => {
    const service = readFileSync("src/services/product/PublicCatalogService.ts", "utf8");
    expect(service).toContain("gt(storeProductCategory.pid, 0)");
    for (const key of ["info", "benefit", "likeInfo", "subscribe", "tengxun_map_key", "site_name"]) {
      expect(service).toContain(`${key}:`);
    }
  });

  it("scopes v2 follow status to a current official-account identity", () => {
    const service = readFileSync("src/services/product/PublicCatalogService.ts", "utf8");
    expect(service).toContain('userType: "wechat"');
    expect(service).toContain("eq(wechatUser.isDel, 0)");
    expect(service).toContain(".orderBy(desc(wechatUser.id))");
    const controller = readFileSync("src/controllers/api/v1/PublicController.ts", "utf8");
    expect(controller).toContain('"Cache-Control", "private, no-store"');
  });
});
