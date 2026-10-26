import { reversePointsCentreManifest } from './helpers/customerPointsCentreManifest';
import { reverseSignCentreManifest } from './helpers/customerSignCentreManifest';
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reverseRouteSourceFollowup, type RouteSourceFollowup } from "./helpers/routeSourceIncrement";
import {
  LEGACY_ROUTE_RULES,
  REGISTERED_PAGE_ROUTES,
  resolveRegisteredPageRoute,
} from "../../view/uniapp-ts/src/config/navigation";
import {
  REGISTERED_PAGE_ROUTES as SERVER_REGISTERED_PAGE_ROUTES,
  resolveRegisteredPageRoute as resolveServerRegisteredPageRoute,
} from "../src/services/content/FabRouteRegistry";

interface ParityAudit {
  counting: {
    legacy: { pagesTreeVueFiles: number; logicalManifestRouteRecords: number; platformActiveRouteRecords: Record<string, number> };
    target: { pagesTreeVueFiles: number; logicalManifestRouteRecords: number; platformActiveRouteRecords: Record<string, number>; manifestSha256: string; manifestHashNormalization: string };
    routeLedger: Record<string, number>;
  };
  directRegisteredLegacyRoutes: string[];
  gaps: Array<{ id: string; status: string; legacyRoutes: string[] }>;
  checklist: Array<{ id: string; done: boolean }>;
}

const parity = JSON.parse(readFileSync("audit/uniapp-frontend-parity-product-detail-design-followup-20261002.json", "utf8")) as ParityAudit;
// The October 2 artifact is an immutable historical checklist/route snapshot.
// Current navigation adds the member-barcode page, three second-card cashier
// routes and the ordinary cashier. Exact added records verify each old hash.
const currentParity = JSON.parse(readFileSync("audit/uniapp-frontend-parity-customer-work-writeoff-followup-20261005.json", "utf8")) as Omit<ParityAudit, "checklist">;
const checkoutParity = JSON.parse(readFileSync("audit/uniapp-frontend-parity-customer-cashier-checkout-followup-20261011.json", "utf8")) as Omit<ParityAudit, "checklist">;
const ordinaryParity = JSON.parse(readFileSync("audit/uniapp-frontend-parity-customer-ordinary-cashier-followup-20261013.json", "utf8")) as Omit<ParityAudit, "checklist">;
const mergedParity = JSON.parse(readFileSync("audit/uniapp-frontend-parity-merged-work-branches-20261015.json", "utf8")) as Omit<ParityAudit, "checklist">;
// These later main records must remain present in the merged app. Remove only
// their exact bytes when verifying immutable October 5/11/13 manifest hashes.
const laterMainRecords = [
  '    {\n      "path": "pages/users/agent/bind",\n      "style": {\n        "navigationBarTitleText": "员工邀请"\n      }\n    },\n',
  ',\n    {\n      "path": "pages/share/landing",\n      "style": { "navigationBarTitleText": "分享内容核对" }\n    }',
];
function historicalCashierManifest(manifest: string): string {
  for (const record of laterMainRecords) {
    expect(manifest.split(record)).toHaveLength(2);
    manifest = manifest.replace(record, "");
  }
  return manifest;
}
const workspaceRecord = '    {\n      "path": "pages/discover/workspace",\n      "style": { "navigationBarTitleText": "社区管理" }\n    },\n';
const communityDetailRecord = '    {\n      "path": "pages/discover/discoverDetails/index",\n      "style": { "navigationBarTitleText": "社区帖子" }\n    },\n';
const communityEntryRecords = [
  ['discoverUser', '社区作者'], ['discoverFollow', '社区关系'], ['discoverCreate', '社区发布'],
].map(([page, title]) => `    {\n      "path": "pages/discover/${page}/index",\n      "style": { "navigationBarTitleText": "${title}" }\n    },\n`);
const footerBindingRaw = readFileSync('audit/diy-footer-source-binding-20261022.json', 'utf8');
const footerBinding = JSON.parse(footerBindingRaw) as { sources:Array<RouteSourceFollowup & {file:string}>; native_icon_sources:Array<{file:string;sha256:string;php_sha256:string;pagePath:string;slot:'iconPath'|'selectedIconPath'}> };
// Exact footer inverse reconstructs the pre-footer manifest; all dated ledgers stay immutable.
function historicalFooterManifest(manifest: string): string {
  manifest = reverseSignCentreManifest(reversePointsCentreManifest(manifest));
  expect(createHash('sha256').update(footerBindingRaw).digest('hex')).toBe('88ada866df4f97a5f50e3cce0321ac7accf16f0989198e2877d4455c7f51b2dd');
  const proof = footerBinding.sources.find(row=>row.file==='view/uniapp-ts/src/pages.json');
  expect(proof).toBeDefined();
  return reverseRouteSourceFollowup(manifest,proof!);
}
// Exact main-feed follow-up inverse; the dated snapshots below remain byte-for-byte intact.
function historicalMainFeedManifest(manifest: string): string {
  manifest = historicalFooterManifest(manifest);
  expect(createHash("sha256").update(manifest).digest("hex")).toBe("affa3ecd20f33bbd15d9c5336fb362734a810f4174e05d284a5362e74ce556be");
  const edits = [
    ['    {\n      "path": "pages/discoverIndex/index",\n      "style": { "navigationBarTitleText": "社区" }\n    },\n', ''],
    ['      "path": "pages/discover/index",\n      "style": {\n        "navigationBarTitleText": "逛逛",\n        "enablePullDownRefresh": true\n      }', '      "path": "pages/discover/index",\n      "style": {\n        "navigationBarTitleText": "逛逛"\n      }'],
    ['      "path": "pages/discover/workspace",\n      "style": { "navigationBarTitleText": "社区管理", "enablePullDownRefresh": true }', '      "path": "pages/discover/workspace",\n      "style": { "navigationBarTitleText": "社区管理" }'],
  ];
  for (const [after, before] of edits) {
    expect(manifest.split(after)).toHaveLength(2);
    manifest = manifest.replace(after, before);
  }
  expect(createHash("sha256").update(manifest).digest("hex")).toBe("8c64c53d6178e22dfa84741a632fa2828452a16982549ad10dad559c645fe989");
  return manifest;
}
function historicalCommunityManifest(manifest: string): string {
  manifest = historicalMainFeedManifest(manifest);
  for (const record of [workspaceRecord, communityDetailRecord, ...communityEntryRecords]) {
    expect(manifest.split(record)).toHaveLength(2);
    manifest = manifest.replace(record, '');
  }
  return manifest;
}
const memberCodeRoute = "/pages/users/user_member_code/index";
const currentDirectRoutes = [...currentParity.directRegisteredLegacyRoutes, memberCodeRoute];
const pages = JSON.parse(readFileSync("../view/uniapp-ts/src/pages.json", "utf8")) as {
  pages: Array<{ path: string }>;
};
const diy = readFileSync("../view/uniapp-ts/src/utils/diy.ts", "utf8");
const home = readFileSync("../view/uniapp-ts/src/pages/index/index.vue", "utf8");
const search = readFileSync("../view/uniapp-ts/src/pages/goods/search.vue", "utf8");

describe("UniApp manifest and legacy-navigation parity", () => {
  it('pins the complete current manifest and all ten real native selected/unselected icon assets without altering historical ledgers', () => {
    const manifest = readFileSync('../view/uniapp-ts/src/pages.json','utf8').replace(/\r\n/g,'\n');
    const prior = historicalFooterManifest(manifest), current = JSON.parse(manifest), previous = JSON.parse(prior);
    expect(current.pages.filter((row: {path:string}) => !['pages/user/signRecords','pages/user/points'].includes(row.path))).toEqual(previous.pages); expect(current.tabBar.list).toHaveLength(5);
    expect(footerBinding.native_icon_sources).toHaveLength(10);
    const slots = current.tabBar.list.flatMap((row:{pagePath:string;iconPath:string;selectedIconPath:string})=>['iconPath','selectedIconPath'].map(slot=>({pagePath:row.pagePath,slot,file:'view/uniapp-ts/src/'+row[slot as 'iconPath'|'selectedIconPath']})));
    expect(slots).toEqual(footerBinding.native_icon_sources.map(({pagePath,slot,file})=>({pagePath,slot,file})));
    for(const proof of footerBinding.native_icon_sources) expect(createHash('sha256').update(readFileSync(resolve('..',proof.file))).digest('hex')).toBe(proof.sha256);
    expect(footerBinding.native_icon_sources.every(row=>row.sha256===row.php_sha256)).toBe(true);
    const changed=manifest.replace('static/images/footer/1-001.png','static/images/footer/wrong.png');
    expect(()=>historicalFooterManifest(changed)).toThrow();
  });

  it("retains the historical October 2 route denominator without crediting it as the current manifest", () => {
    expect(parity.counting.legacy.pagesTreeVueFiles).toBe(250);
    expect(parity.counting.legacy.logicalManifestRouteRecords).toBe(151);
    expect(parity.counting.legacy.platformActiveRouteRecords).toEqual({ H5: 151, "MP-WEIXIN": 150, "APP-PLUS": 150 });
    expect(parity.counting.target.pagesTreeVueFiles).toBe(97);
    expect(parity.counting.target.logicalManifestRouteRecords).toBe(97);
    expect(parity.counting.target.platformActiveRouteRecords).toEqual({ H5: 97, "MP-WEIXIN": 97, "APP-PLUS": 97 });
    expect(parity.counting.routeLedger).toMatchObject({
      directRegistered: 28,
      legacyCompatibilityRules: 100,
      candidateCoveredRules: 62,
      partialReplacementRules: 38,
      unmappedOrCrossSurface: 23,
      accountedLegacyRoutes: 151,
    });
  });

  it("keeps the runtime allowlist synchronized with pages.json and actual page files", () => {
    const manifestRoutes = pages.pages.map((page) => `/${page.path}`).sort();
    expect([...REGISTERED_PAGE_ROUTES].sort()).toEqual(manifestRoutes);
    expect([...SERVER_REGISTERED_PAGE_ROUTES].sort()).toEqual(manifestRoutes);
    expect(currentParity.counting.target.logicalManifestRouteRecords).toBe(125);
    expect(manifestRoutes).toHaveLength(140);
    expect(manifestRoutes.filter(route => route === memberCodeRoute)).toHaveLength(1);
    const cashierRecords = [
      { path: '/pages/customer-work/cashier', title: '次卡现金收银' },
      { path: '/pages/customer-work/cashierRecord', title: '次卡收银凭据' },
      { path: '/pages/customer-work/cashierRecords', title: '本人次卡收银记录' },
    ];
    expect(manifestRoutes.filter(route => route.startsWith('/pages/customer-work/cashier')))
      .toEqual(cashierRecords.map(record => record.path));
    for (const record of cashierRecords) {
      expect(manifestRoutes.filter(route => route === record.path)).toHaveLength(1);
      const query = record.path.endsWith('/cashierRecord') ? 'orderId=17&orderNo=owned-cashier-record' : '';
      expect(resolveRegisteredPageRoute(record.path, query)).toBe(record.path + (query ? `?${query}` : ''));
      if (query) expect(resolveRegisteredPageRoute(record.path)).toBe('');
    }
    expect(currentParity.counting.target.manifestHashNormalization).toBe("LF");
    const manifest = historicalCommunityManifest(readFileSync("../view/uniapp-ts/src/pages.json", "utf8").replace(/\r\n/g, "\n"));
    const ordinaryRecord = '    {\n      "path": "pages/customer-work/ordinaryCashier",\n      "style": { "navigationBarTitleText": "普通商品现金收银" }\n    },\n';
    expect(manifest.split(ordinaryRecord)).toHaveLength(2);
    const checkoutManifest = historicalCashierManifest(manifest).replace(ordinaryRecord, "");
    expect(JSON.parse(checkoutManifest).pages).toHaveLength(129);
    expect(checkoutParity.counting.target.logicalManifestRouteRecords).toBe(129);
    expect(checkoutParity.counting.target.manifestHashNormalization).toBe("LF");
    expect(createHash("sha256").update(checkoutManifest).digest("hex").toUpperCase()).toBe(checkoutParity.counting.target.manifestSha256);
    expect(manifestRoutes.filter(route => route === '/pages/customer-work/ordinaryCashier')).toHaveLength(1);
    expect(resolveRegisteredPageRoute('/pages/customer-work/ordinaryCashier')).toBe('/pages/customer-work/ordinaryCashier');
    expect(resolveServerRegisteredPageRoute('/pages/customer-work/ordinaryCashier')).toBe('/pages/customer-work/ordinaryCashier');
    for (const query of ['uid=11', 'orderId=17', 'page=1', 'request_id=owned-record', 'uid=1&uid=1', 'unknown=x']) {
      expect(resolveRegisteredPageRoute('/pages/customer-work/ordinaryCashier', query)).toBe('');
      expect(resolveServerRegisteredPageRoute('/pages/customer-work/ordinaryCashier', query)).toBe('');
    }
    const memberRecord = '    {\n      "path": "pages/users/user_member_code/index",\n      "style": { "navigationBarTitleText": "会员核销码" }\n    },\n';
    expect(manifest.split(memberRecord)).toHaveLength(2);
    let writeoffManifest = checkoutManifest.replace(memberRecord, "");
    for (const record of cashierRecords) {
      const exactRecord = `    {\n      "path": "${record.path.slice(1)}",\n      "style": { "navigationBarTitleText": "${record.title}" }\n    },\n`;
      expect(writeoffManifest.split(exactRecord)).toHaveLength(2);
      writeoffManifest = writeoffManifest.replace(exactRecord, "");
    }
    expect(JSON.parse(writeoffManifest).pages).toHaveLength(currentParity.counting.target.logicalManifestRouteRecords);
    expect(createHash("sha256").update(writeoffManifest).digest("hex").toUpperCase()).toBe(currentParity.counting.target.manifestSha256);
    for (const page of pages.pages) {
      expect(existsSync(resolve("../view/uniapp-ts/src", `${page.path}.vue`))).toBe(true);
    }
    for (const [legacy, rule] of Object.entries(LEGACY_ROUTE_RULES)) {
      expect(legacy).toMatch(/^\/pages\/[a-z0-9_/-]+$/i);
      expect(REGISTERED_PAGE_ROUTES.has(rule.target)).toBe(true);
    }
  });

  it("accounts for all 151 legacy routes exactly once across direct, mapped and gap ledgers", () => {
    const gapRoutes = currentParity.gaps.flatMap((gap) => gap.legacyRoutes);
    const accounted = [
      ...currentDirectRoutes,
      ...Object.keys(LEGACY_ROUTE_RULES),
      ...gapRoutes,
    ];
    expect(accounted).toHaveLength(151);
    expect(new Set(accounted).size).toBe(151);
    expect(gapRoutes).toHaveLength(7);
    expect(currentParity.gaps.map((gap) => gap.id)).toEqual([
      "FE-003B", "FE-003C", "FE-003D", "FE-003E", "FE-003F", "FE-003G", "FE-003H",
    ]);
    expect(parity.checklist.filter((item) => item.done).map((item) => item.id)).toEqual(["FE-003A", "FE-003C", "FE-003H", "FE-003I"]);
  });

  it("aligns the current ordinary cashier ledger with the complete manifest without replacing the historical checkout ledger", () => {
    const manifest = historicalCommunityManifest(readFileSync("../view/uniapp-ts/src/pages.json", "utf8").replace(/\r\n/g, "\n"));
    const mappedRoutes = Object.keys(LEGACY_ROUTE_RULES);
    const gapRoutes = mergedParity.gaps.flatMap((gap) => gap.legacyRoutes);
    const accounted = [...mergedParity.directRegisteredLegacyRoutes, ...mappedRoutes, ...gapRoutes];
    const historicalAccounted = [
      ...currentDirectRoutes,
      ...mappedRoutes,
      ...currentParity.gaps.flatMap((gap) => gap.legacyRoutes),
    ];

    expect(ordinaryParity.counting.target.logicalManifestRouteRecords).toBe(130);
    expect(ordinaryParity.counting.target.manifestSha256).toBe(createHash("sha256")
      .update(historicalCashierManifest(manifest)).digest("hex").toUpperCase());
    // `manifest` has already passed the exact main-feed and five community inverses.
    expect(JSON.parse(manifest).pages).toHaveLength(132);
    expect(mergedParity.counting.target.logicalManifestRouteRecords).toBe(JSON.parse(manifest).pages.length);
    expect(mergedParity.counting.target.manifestHashNormalization).toBe("LF");
    expect(mergedParity.counting.target.manifestSha256)
      .toBe(createHash("sha256").update(manifest).digest("hex").toUpperCase());
    expect([...mergedParity.directRegisteredLegacyRoutes].sort()).toEqual([...currentDirectRoutes].sort());
    expect(mergedParity.directRegisteredLegacyRoutes).toEqual(checkoutParity.directRegisteredLegacyRoutes);
    expect(mergedParity.gaps).toEqual(checkoutParity.gaps);
    expect(mergedParity.directRegisteredLegacyRoutes).not.toContain('/pages/customer-work/ordinaryCashier');
    expect(gapRoutes).toContain('/pages/goods/cashier/index');
    expect(LEGACY_ROUTE_RULES).not.toHaveProperty('/pages/goods/cashier/index');
    for (const route of mergedParity.directRegisteredLegacyRoutes) {
      expect(REGISTERED_PAGE_ROUTES.has(route)).toBe(true);
    }
    expect(accounted).toHaveLength(mergedParity.counting.legacy.logicalManifestRouteRecords);
    expect(new Set(accounted).size).toBe(accounted.length);
    expect([...accounted].sort()).toEqual([...historicalAccounted].sort());
    // The original ledger remains immutable: this exact sign-history alias moves one partial rule to covered.
    expect({...mergedParity.counting.routeLedger, candidateCoveredRules: mergedParity.counting.routeLedger.candidateCoveredRules! + 1, partialReplacementRules: mergedParity.counting.routeLedger.partialReplacementRules! - 1}).toEqual({
      directRegistered: mergedParity.directRegisteredLegacyRoutes.length,
      legacyCompatibilityRules: mappedRoutes.length,
      candidateCoveredRules: Object.values(LEGACY_ROUTE_RULES)
        .filter((rule) => rule.coverage === "candidate_covered").length,
      partialReplacementRules: Object.values(LEGACY_ROUTE_RULES)
        .filter((rule) => rule.coverage === "partial_replacement").length,
      unmappedOrCrossSurface: gapRoutes.length,
      accountedLegacyRoutes: accounted.length,
    });
  });

  it("rejects unregistered internal links and preserves only audited legacy aliases", () => {
    expect(resolveRegisteredPageRoute("/pages/not-migrated/index")).toBe("");
    expect(resolveRegisteredPageRoute("/pages/index/index")).toBe("/pages/index/index");
    expect(resolveRegisteredPageRoute("/pages/user/couponProducts", "couponId=60"))
      .toBe("/pages/user/couponProducts?couponId=60");
    expect(resolveRegisteredPageRoute("/pages/goods/order_details/index", "order_id=abc&from=share"))
      .toBe("/pages/order/detail?orderId=abc&from=share");
    expect(resolveRegisteredPageRoute("/pages/goods/goods_search/index", "searchVal=tea"))
      .toBe("/pages/goods/search?keyword=tea");
    expect(resolveRegisteredPageRoute("/pages/activity/goods_seckill/index"))
      .toBe("/pages/activity/index");
  });

  it("resolves both directly registered offline payment deep links without losing query state", () => {
    for (const path of ["/pages/annex/offline_pay/index", "/pages/annex/offline_result/index"]) {
      expect(resolveRegisteredPageRoute(path, "order_id=xx123&from=share")).toBe(`${path}?order_id=xx123&from=share`);
      expect(currentDirectRoutes).toContain(path);
      expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(path);
    }
    expect(parity.checklist.find(item => item.id === "FE-003F")?.done).toBe(false);
  });

  it("registers five distinct distributor and agent customer routes without Supplier aliases", () => {
    const routes = [
      "/pages/users/distributor/apply", "/pages/users/agent/apply",
      "/pages/users/agent/state", "/pages/users/agent/record", "/pages/users/agent/staff_list",
    ];
    for (const route of routes) {
      expect(resolveRegisteredPageRoute(route, "id=7&type=promoter")).toBe(`${route}?id=7&type=promoter`);
      expect(currentDirectRoutes).toContain(route);
      expect(existsSync(resolve("../view/uniapp-ts/src", `${route.slice(1)}.vue`))).toBe(true);
    }
    expect(currentParity.gaps.find((gap) => gap.id === "FE-003C")?.legacyRoutes).toEqual([]);
    expect(currentParity.gaps.find((gap) => gap.id === "FE-003C")?.status).toBe("code_linux_complete_not_deployed");
    expect(parity.checklist.find((item) => item.id === "FE-003C")?.done).toBe(true);
    for (const id of ["FE-003J", "FE-003K"]) {
      expect(parity.checklist.find((item) => item.id === id)?.done).toBe(false);
    }
    const api = readFileSync("../view/uniapp-ts/src/api/agentSelfService.ts", "utf8");
    expect(api).toContain('"/user/promoter/apply/info"');
    expect(api).toContain('"/division/agent/apply/info"');
    expect(api).not.toContain("/user/apply/supplier/");
  });

  it("maps visit history to a real authenticated page without closing the governance parent", () => {
    expect(resolveRegisteredPageRoute('/pages/users/visit_list/index')).toBe('/pages/user/visitHistory');
    expect(LEGACY_ROUTE_RULES['/pages/users/visit_list/index'].coverage).toBe('partial_replacement');
    expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain('/pages/users/visit_list/index');
    expect(parity.checklist.find(item => item.id === 'FE-003B')?.done).toBe(false);
    const api = readFileSync('../view/uniapp-ts/src/api/visitHistory.ts', 'utf8');
    expect(api).toContain('"/user/visit_list"');
    expect(api).toContain('"/user/visit", { ids: productIds }');
    expect(readFileSync('../view/uniapp-ts/src/composables/useUserCenter.ts', 'utf8')).toContain("/pages/user/visitHistory");
    expect(readFileSync('../view/uniapp-ts/src/pages/user/index.vue', 'utf8')).toContain('@tap="go(item.url)"');
  });

  it('registers the old assisted-record route without closing the unfinished purchase flow', () => {
    const route = '/pages/behalf/record/index';
    expect(resolveRegisteredPageRoute(route, 'paid=1&uid=999')).toBe(route+'?paid=1&uid=999');
    expect(currentDirectRoutes).toContain(route);
    expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(route);
    expect(currentParity.gaps.find(gap => gap.id === 'FE-003G')?.legacyRoutes.filter(path => path.startsWith('/pages/behalf/'))).toHaveLength(0);
    expect(parity.checklist.find(item => item.id === 'FE-003G')?.done).toBe(false);
    const page = readFileSync('../view/uniapp-ts/src/pages/behalf/record/index.vue', 'utf8');
    expect(page).toContain('DiySuspendedNavigation');
    expect(page).toContain('useAssistedRecords');
    expect(readFileSync('../view/uniapp-ts/src/pages/user/index.vue', 'utf8')).toContain("goAdmin('/pages/behalf/record/index')");
  });

  it('registers real buyer/product-cart/confirm/cashier pages but keeps full parity open', () => {
    for (const name of ['user_list', 'goods_list', 'order_confirm', 'cashier']) {
      const route = `/pages/behalf/${name}/index`;
      expect(resolveRegisteredPageRoute(route, 'uid=11')).toBe(route + '?uid=11');
      expect(currentDirectRoutes).toContain(route);
      expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(route);
      expect(readFileSync(`../view/uniapp-ts/src${route}.vue`, 'utf8')).toContain('DiySuspendedNavigation');
    }
    expect(readFileSync('../view/uniapp-ts/src/pages/user/index.vue', 'utf8')).toContain("goAdmin('/pages/behalf/user_list/index')");
    expect(parity.checklist.find(item => item.id === 'FE-003G')?.done).toBe(false);
  });

  it('accounts for the feedback and five enterprise Work routes as direct pages while FE-003G stays open', () => {
    for (const route of [
      '/pages/extension/customer_list/feedback',
      '/pages/work/userInfo/index',
      '/pages/work/orderList/index',
      '/pages/work/orderDetail/index',
      '/pages/work/record/index',
      '/pages/work/groupInfo/index',
    ]) {
      expect(resolveRegisteredPageRoute(route, 'userid=sample')).toBe(`${route}?userid=sample`);
      expect(currentDirectRoutes).toContain(route);
      expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(route);
      expect(existsSync(resolve('../view/uniapp-ts/src', `${route.slice(1)}.vue`))).toBe(true);
    }
    expect(parity.checklist.find(item => item.id === 'FE-003G')?.done).toBe(false);
  });

  it('registers the newcomer purchase path and uses server goods payable in type-7 checkout while FE-003D stays open', () => {
    const oldRoute = '/pages/activity/new_customer/index';
    expect(resolveRegisteredPageRoute(oldRoute)).toBe(oldRoute);
    expect(currentDirectRoutes).toContain(oldRoute);
    expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(oldRoute);
    expect(resolveRegisteredPageRoute('/pages/activity/newcomerDetail', 'id=9'))
      .toBe('/pages/activity/newcomerDetail?id=9');
    expect(parity.checklist.find(item => item.id === 'FE-003D')?.done).toBe(false);
    const detail = readFileSync('../view/uniapp-ts/src/pages/activity/newcomerDetail.vue', 'utf8');
    expect(detail).toContain('立即购买');
    expect(detail).toContain('活动规格库存仅为配置快照');
    const checkout = readFileSync('../view/uniapp-ts/src/pages/order/confirm.vue', 'utf8');
    expect(checkout).toContain("activity.type === 7 ? '新人专享价' : '商品金额'");
    expect(checkout).toContain('activity.type === 7 ? quote.result.prices.goodsPayable : quote.result.prices.subtotal');
  });

  it('registers the old rank and live list routes while keeping activity checkout and release open', () => {
    for (const route of ['/pages/columnGoods/rank/index', '/pages/columnGoods/live_list/index']) {
      expect(resolveRegisteredPageRoute(route)).toBe(route);
      expect(currentDirectRoutes).toContain(route);
      expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(route);
    }
    expect(currentParity.gaps.find(gap => gap.id === 'FE-003D')?.legacyRoutes).toEqual([]);
    expect(parity.checklist.find(item => item.id === 'FE-003D')?.done).toBe(false);
  });

  it('maps the public agreement index and partially restores legal content without claiming account cancellation', () => {
    expect(resolveRegisteredPageRoute('/pages/users/user_agreement_list/index')).toBe('/pages/user/agreements');
    expect(resolveRegisteredPageRoute('/pages/users/privacy/index', 'type=privacy')).toBe('/pages/user/legalContent?type=privacy');
    expect(LEGACY_ROUTE_RULES['/pages/users/privacy/index'].coverage).toBe('partial_replacement');
    expect(LEGACY_ROUTE_RULES['/pages/users/user_agreement_list/index'].coverage).toBe('candidate_covered');
    expect(currentParity.gaps.find(gap => gap.id === 'FE-003B')?.legacyRoutes).toEqual([
      '/pages/users/user_cancellation/index',
    ]);
    expect(parity.checklist.find(item => item.id === 'FE-003B')?.done).toBe(false);
  });

  it('registers the original member-code route without claiming full governance or provider parity', () => {
    const route = '/pages/users/user_member_code/index';
    expect(resolveRegisteredPageRoute(route)).toBe(route);
    expect(currentDirectRoutes).toContain(route);
    expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(route);
    expect(parity.checklist.find(item => item.id === 'FE-003B')?.done).toBe(false);
  });

  it("routes all server-managed homepage links through the shared resolver", () => {
    expect(diy).toContain('import { resolveRegisteredPageRoute, TAB_ROUTES } from "@/config/navigation"');
    expect(diy).toContain("return resolveRegisteredPageRoute(path, query)");
    expect(home).toContain('openDiyLink } from "@/utils/diy"');
    expect(home).toContain('useDiyPageHost(() => 0, () => diyCommunityVisible.value)');
    expect(home.match(/openDiyLink\(/g)).toHaveLength(2);
    expect(home).not.toContain("uni.navigateTo({ url: link })");
    expect(home).not.toContain("uni.navigateTo({ url: banner.link })");
  });
  it('maps the legacy presell catalogue to a real page without closing incomplete presale and activity parity', () => {
    expect(resolveRegisteredPageRoute('/pages/activity/presell/index')).toBe('/pages/activity/presale');
    expect(LEGACY_ROUTE_RULES['/pages/activity/presell/index'].coverage).toBe('partial_replacement');
    expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain('/pages/activity/presell/index');
    expect(parity.checklist.find(item => item.id === 'FE-003D')?.done).toBe(false);
    expect(readFileSync('../view/uniapp-ts/src/pages/activity/index.vue', 'utf8')).toContain("url: '/pages/activity/presale'");
    expect(readFileSync('../view/pc-ts/src/router/index.ts', 'utf8')).toContain('alias: "/goods_presell"');
  });

  it("restores legacy searchVal deep-link behavior", () => {
    expect(search).toContain('import { onLoad } from "@dcloudio/uni-app"');
    expect(search).toContain("options?.keyword ?? options?.searchVal");
    expect(search).toContain("void doSearch()");
  });

  it("registers the three community deep links and the old App route without losing their query state", () => {
    for (const path of [
      "/pages/discover/discoverTopic/index",
      "/pages/discover/discoverSearch/index",
      "/pages/discover/discoverVideo/index",
    ]) {
      expect(resolveRegisteredPageRoute(path, "id=9003&relation_id=101")).toBe(`${path}?id=9003&relation_id=101`);
      expect(currentDirectRoutes).toContain(path);
      expect(currentParity.gaps.flatMap(gap => gap.legacyRoutes)).not.toContain(path);
    }
    expect(resolveRegisteredPageRoute("/pages/discover/discoverVideo/app", "id=9003"))
      .toBe("/pages/discover/discoverVideo/app?id=9003");
    expect(parity.checklist.find(item => item.id === "FE-003H")?.done).toBe(true);
  });
});
