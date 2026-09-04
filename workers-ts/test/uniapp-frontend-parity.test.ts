import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_ROUTE_RULES,
  REGISTERED_PAGE_ROUTES,
  resolveRegisteredPageRoute,
} from "../../view/uniapp-ts/src/config/navigation";

interface ParityAudit {
  counting: {
    legacy: { pagesTreeVueFiles: number; logicalManifestRouteRecords: number; platformActiveRouteRecords: Record<string, number> };
    target: { pagesTreeVueFiles: number; logicalManifestRouteRecords: number; platformActiveRouteRecords: Record<string, number> };
    routeLedger: Record<string, number>;
  };
  directRegisteredLegacyRoutes: string[];
  gaps: Array<{ id: string; status: string; legacyRoutes: string[] }>;
  checklist: Array<{ id: string; done: boolean }>;
}

const parity = JSON.parse(readFileSync("audit/uniapp-frontend-parity.json", "utf8")) as ParityAudit;
const pages = JSON.parse(readFileSync("../view/uniapp-ts/src/pages.json", "utf8")) as {
  pages: Array<{ path: string }>;
};
const diy = readFileSync("../view/uniapp-ts/src/utils/diy.ts", "utf8");
const home = readFileSync("../view/uniapp-ts/src/pages/index/index.vue", "utf8");
const search = readFileSync("../view/uniapp-ts/src/pages/goods/search.vue", "utf8");

describe("UniApp manifest and legacy-navigation parity", () => {
  it("uses active manifest records instead of raw Vue files as the denominator", () => {
    expect(parity.counting.legacy.pagesTreeVueFiles).toBe(250);
    expect(parity.counting.legacy.logicalManifestRouteRecords).toBe(151);
    expect(parity.counting.legacy.platformActiveRouteRecords).toEqual({ H5: 151, "MP-WEIXIN": 150, "APP-PLUS": 150 });
    expect(parity.counting.target.pagesTreeVueFiles).toBe(59);
    expect(parity.counting.target.logicalManifestRouteRecords).toBe(59);
    expect(parity.counting.target.platformActiveRouteRecords).toEqual({ H5: 59, "MP-WEIXIN": 59, "APP-PLUS": 59 });
    expect(parity.counting.routeLedger).toMatchObject({
      directRegistered: 3,
      legacyCompatibilityRules: 97,
      candidateCoveredRules: 60,
      partialReplacementRules: 37,
      unmappedOrCrossSurface: 51,
      accountedLegacyRoutes: 151,
    });
  });

  it("keeps the runtime allowlist synchronized with pages.json and actual page files", () => {
    const manifestRoutes = pages.pages.map((page) => `/${page.path}`).sort();
    expect([...REGISTERED_PAGE_ROUTES].sort()).toEqual(manifestRoutes);
    for (const page of pages.pages) {
      expect(existsSync(resolve("../view/uniapp-ts/src", `${page.path}.vue`))).toBe(true);
    }
    for (const [legacy, rule] of Object.entries(LEGACY_ROUTE_RULES)) {
      expect(legacy).toMatch(/^\/pages\/[a-z0-9_/-]+$/i);
      expect(REGISTERED_PAGE_ROUTES.has(rule.target)).toBe(true);
    }
  });

  it("accounts for all 151 legacy routes exactly once across direct, mapped and gap ledgers", () => {
    const gapRoutes = parity.gaps.flatMap((gap) => gap.legacyRoutes);
    const accounted = [
      ...parity.directRegisteredLegacyRoutes,
      ...Object.keys(LEGACY_ROUTE_RULES),
      ...gapRoutes,
    ];
    expect(accounted).toHaveLength(151);
    expect(new Set(accounted).size).toBe(151);
    expect(gapRoutes).toHaveLength(51);
    expect(parity.gaps.map((gap) => gap.id)).toEqual([
      "FE-003B", "FE-003C", "FE-003D", "FE-003E", "FE-003F", "FE-003G", "FE-003H",
    ]);
    expect(parity.checklist.filter((item) => item.done).map((item) => item.id)).toEqual(["FE-003A", "FE-003I"]);
  });

  it("rejects unregistered internal links and preserves only audited legacy aliases", () => {
    expect(resolveRegisteredPageRoute("/pages/not-migrated/index")).toBe("");
    expect(resolveRegisteredPageRoute("/pages/index/index")).toBe("/pages/index/index");
    expect(resolveRegisteredPageRoute("/pages/goods/order_details/index", "order_id=abc&from=share"))
      .toBe("/pages/order/detail?orderId=abc&from=share");
    expect(resolveRegisteredPageRoute("/pages/goods/goods_search/index", "searchVal=tea"))
      .toBe("/pages/goods/search?keyword=tea");
    expect(resolveRegisteredPageRoute("/pages/activity/goods_seckill/index"))
      .toBe("/pages/activity/index");
  });

  it("routes all server-managed homepage links through the shared resolver", () => {
    expect(diy).toContain('import { resolveRegisteredPageRoute, TAB_ROUTES } from "@/config/navigation"');
    expect(diy).toContain("return resolveRegisteredPageRoute(path, query)");
    expect(home).toContain('loadDiyPage, openDiyLink } from "@/utils/diy"');
    expect(home.match(/openDiyLink\(/g)).toHaveLength(2);
    expect(home).not.toContain("uni.navigateTo({ url: link })");
    expect(home).not.toContain("uni.navigateTo({ url: banner.link })");
  });

  it("restores legacy searchVal deep-link behavior", () => {
    expect(search).toContain('import { onLoad } from "@dcloudio/uni-app"');
    expect(search).toContain("options?.keyword ?? options?.searchVal");
    expect(search).toContain("void doSearch()");
  });
});
