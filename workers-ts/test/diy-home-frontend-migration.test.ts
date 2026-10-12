import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const client = readFileSync(resolve(root, "../view/uniapp-ts/src/api/diy.ts"), "utf8");
const loader = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diy.ts"), "utf8");
const navigation = readFileSync(resolve(root, "../view/uniapp-ts/src/config/navigation.ts"), "utf8");
const fabSource = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/fab.ts"), "utf8");
// Execute the actual frontend pure module with its actual navigation registry.
// No source-function rewrite, frontend-global mock or duplicate policy copy.
const navigationExports: Record<string, unknown> = {}, fabExports: Record<string, unknown> = {};
const compile = (source: string) => transpileModule(source, { compilerOptions: {
  module: ModuleKind.CommonJS, target: ScriptTarget.ES2022,
} }).outputText;
const commonSources = new Set(['customerWorkRoute', 'customerWorkWriteoff', 'customerWorkIntent', 'userCenterDesign']);
const commonExports = new Map<string, Record<string, unknown>>();
function actualCommonModule(name: string): Record<string, unknown> {
  if (!commonSources.has(name)) throw Error(`Unexpected navigation pure dependency: ${name}`);
  const known = commonExports.get(name);
  if (known) return known;
  const exports: Record<string, unknown> = {};
  commonExports.set(name, exports);
  runInNewContext(compile(readFileSync(resolve(root, `../view/common/${name}.ts`), 'utf8')), {
    exports, URL, TextEncoder, require: (dependency: string) => {
      if (!/^\.\/[A-Za-z]+$/.test(dependency)) throw Error(`Unexpected common pure dependency: ${dependency}`);
      return actualCommonModule(dependency.slice(2));
    },
  });
  return exports;
}
runInNewContext(compile(navigation), { exports: navigationExports, URL, require: (name: string) => {
  if (name !== '../../../common/customerWorkRoute') throw Error(`Unexpected navigation pure dependency: ${name}`);
  return actualCommonModule('customerWorkRoute');
} });
runInNewContext(compile(fabSource), { exports: fabExports, URL, require: (name: string) => {
  if (name !== "@/config/navigation") throw Error(`Unexpected FAB pure dependency: ${name}`);
  return navigationExports;
} });
function parseFabConfig(value: unknown): unknown {
  const parse = fabExports.parseFabConfig;
  if (typeof parse !== "function") throw Error("Actual FAB parser export missing");
  return Reflect.apply(parse, undefined, [value]);
}
function fabCentre(percent: number, viewport: number, height: number, dragged?: number): unknown {
  const position = fabExports.fabCentre;
  if (typeof position !== "function") throw Error("Actual FAB position export missing");
  return Reflect.apply(position, undefined, [percent, viewport, height, dragged]);
}
const renderer = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiyHomeRenderer.vue"),
  "utf8",
);
const suspended = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiySuspendedNavigation.vue"),
  "utf8",
);
const editorial = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiyEditorialWidget.vue"),
  "utf8",
);
const commerce = readFileSync(
  resolve(root, "../view/uniapp-ts/src/components/diy/DiyCommerceWidget.vue"),
  "utf8",
);
const activityClient = readFileSync(
  resolve(root, "../view/uniapp-ts/src/api/activity.ts"),
  "utf8",
);
const homepage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/index/index.vue"), "utf8");
const microPage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/diy/detail.vue"), "utf8");
const pages = readFileSync(resolve(root, "../view/uniapp-ts/src/pages.json"), "utf8");
const main = readFileSync(resolve(root, "../view/uniapp-ts/src/main.ts"), "utf8");
const suspendedCache = readFileSync(
  resolve(root, "../view/uniapp-ts/src/utils/diySuspended.ts"),
  "utf8",
);
const suspendedPagePaths = [
  "pages/activity/bargainDetail",
  "pages/activity/detail",
  "pages/activity/index",
  "pages/activity/lottery",
  "pages/activity/lotteryRecords",
  "pages/annex/vip_active/index",
  "pages/article/detail",
  "pages/article/list",
  "pages/discover/index",
  "pages/discover/people",
  "pages/goods/commentDetail",
  "pages/goods/commentList",
  "pages/goods/list",
  "pages/goods/search",
  "pages/order/confirm",
  "pages/order/detail",
  "pages/order/express",
  "pages/order/payResult",
  "pages/order/refundApply",
  "pages/order/refundDetail",
  "pages/order/refundList",
  "pages/user/address",
  "pages/user/balanceLogs",
  "pages/user/collect",
  "pages/user/coupon",
  "pages/user/couponCenter",
  "pages/user/finance",
  "pages/user/integral",
  "pages/user/integralLogs",
  "pages/user/invoice",
  "pages/user/level",
  "pages/user/message",
  "pages/user/messageDetail",
  "pages/user/profile",
  "pages/user/recharge",
  "pages/user/sign",
  "pages/user/spread",
  "pages/user/vipOpen",
] as const;

describe("DIY-home frontend migration", () => {
  it("provides typed clients for the eight legacy contracts", () => {
    for (const route of [
      "diy/get_diy/",
      "diy/diy_version/",
      "diy/user_info",
      "diy/video_list",
      "diy/newcomer_list",
      "diy/product_rank",
      "diy/sign",
      "diy/get_suspended",
    ]) {
      expect(client).toContain(route);
    }
    expect(client).toContain("Promise<DiyPage | []>");
    expect(client).toContain("Promise<DiySuspendedConfig | []>");
    expect(parseFabConfig([])).toBeNull();
    expect(parseFabConfig({ is_show: 1, index: 1, shifting: 0,
      main_ago_image: "/main.png", main_after_image: "", button: [] }))
      .toEqual({ is_show: 1, index: 1, shifting: 0,
        main_ago_image: "/main.png", main_after_image: "", button: [] });
  });

  it("normalizes only named, visible allowlisted components in timestamp order", () => {
    expect(client).toContain('"pageFoot"');
    expect(loader).toContain("ALLOWED_COMPONENTS.has(name)");
    expect(loader).toContain("isDiyEnabled(item.isHide)");
    expect(loader).toContain("componentTimestamp(left) - componentTimestamp(right)");
    expect(loader).toContain("slice(0, MAX_COMPONENTS)");
  });

  it("fails closed on malformed page, image, color, and navigation input", () => {
    expect(loader).toContain("if (!page || Array.isArray(value)) return null");
    expect(loader).toContain("/^https:\\/\\//i.test(url)");
    expect(loader).toContain("/^\\/(?!\\/)/.test(url)");
    expect(loader).toContain("return \"\";");
    expect(navigation).toContain('"/pages/goods_details/index": { target: "/pages/goods/detail"');
    expect(loader).toContain("resolveRegisteredPageRoute(path, query)");
    expect(loader).toContain("if (!raw.startsWith(\"/pages/\")) return \"\"");
  });

  it("only emits bounded safe page background styles", () => {
    expect(loader).toContain("safeDiyColor(page.color_picker)");
    expect(loader).toContain("safeDiyImageUrl(page.bg_pic)");
    expect(loader).toContain("backgroundSize");
    expect(loader).toContain("backgroundRepeat");
  });

  it("uses version-scoped storage and never dynamically instantiates server component names", () => {
    expect(loader).toContain("apiDiyVersion(safeId)");
    expect(loader).toContain("apiDiyPage(safeId)");
    expect(loader).toContain("cinashop_diy_page_v1_");
    expect(loader).toContain("ALLOWED_COMPONENTS.has(name)");
    expect(renderer).not.toContain("<component");
    expect(renderer).not.toContain("v-html");
    expect(renderer).toContain("sanitizeArticleRichText");
  });

  it("registers reachable home, micro-page, and suspended-navigation consumers", () => {
    expect(homepage).toContain("loadDiyPage(0");
    expect(homepage).toContain("<DiyHomeRenderer");
    expect(homepage).toContain("<DiySuspendedNavigation");
    expect(microPage).toContain("loadDiyPage(pageId.value");
    expect(microPage).toContain("micro-page");
    expect(pages).toContain('"path": "pages/diy/detail"');
    expect(suspended).toContain("loadDiySuspendedConfig()");
    expect(suspended).toContain("openFabLink(url)");
    const child = { img: "/child.png", url: "/pages/index/index" };
    const base = { is_show: 1, index: 1, shifting: 0, main_ago_image: "/main.png", main_after_image: "", button: [] };
    for (const index of [1, 2]) expect(parseFabConfig({ ...base, index })).toMatchObject({ index, shifting: 0, button: [] });
    expect(parseFabConfig({ ...base, index: 3, shifting: 100, main_after_image: "/after.png", button: [child, child, child] }))
      .toMatchObject({ index: 3, shifting: 100, main_after_image: "/after.png", button: [child, child, child] });
    expect(parseFabConfig({ ...base, index: 4, main_ago_image: "", button: [child, child, child] }))
      .toMatchObject({ index: 4, main_ago_image: "", main_after_image: "", button: [child, child, child] });
    for (const change of [{ is_show: "1" }, { index: 5 }, { shifting: -1 }, { shifting: 101 }, { main_ago_image: "javascript:alert(1)" },
      { index: 3, main_after_image: "/after.png", button: [child, child] }]) expect(parseFabConfig({ ...base, ...change })).toBeNull();
    expect(parseFabConfig({ ...base, button: [{ img: "/child.png", url: "javascript:alert(1)" }] }))
      .toMatchObject({ is_show: 1, button: [{ img: "/child.png", url: "" }] });
    expect(fabCentre(0, 800, 100)).toBe(50);
    expect(fabCentre(100, 800, 100)).toBe(750);
    expect(fabCentre(50, 800, 100)).toBe(400);
    expect(fabCentre(50, 800, 100, 1000)).toBe(750);
  });

  it("mounts suspended navigation on all 38 migrated legacy destination pages", () => {
    expect(main).toContain('app.component("DiySuspendedNavigation"');
    expect(suspendedCache).toContain("apiDiySuspended()");
    expect(suspendedCache).toContain("SUSPENDED_CACHE_TTL_MS");
    expect(suspendedPagePaths).toHaveLength(38);
    for (const path of suspendedPagePaths) {
      expect(pages).toContain(`"path": "${path}"`);
      const source = readFileSync(resolve(root, `../view/uniapp-ts/src/${path}.vue`), "utf8");
      expect(source).toContain("<DiySuspendedNavigation");
    }
  });

  it("renders the four editor-owned widgets without adding dynamic code paths", () => {
    for (const name of ["news", "hotspot", "follow", "activeParty"]) {
      expect(renderer).toContain(`\"${name}\"`);
      expect(editorial).toContain(`block.name === '${name}'`);
    }
    expect(editorial).toContain("normalizeDiyLink");
    expect(editorial).toContain("safeDiyImageUrl");
    // Theme adaptation moved authored colour sanitization into its real helper.
    expect(editorial).toContain("import { diyThemeColor, diyThemeVariables } from '@/utils/diyTheme'");
    expect(editorial).toContain("return diyThemeColor(props.block, key, index, fallback, theme.preset)");
    const theme = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diyTheme.ts"), "utf8");
    expect(theme).toContain("import { asDiyRecord, safeDiyColor } from '@/utils/diy'");
    expect(theme).toContain("return safeDiyColor(value,");
    expect(editorial).not.toContain("v-html");
    expect(editorial).not.toContain("<component");
    expect(editorial).not.toContain("downloadFile");
  });

  it("bounds editorial collection sizes, text, spacing, radii, and hotspot geometry", () => {
    expect(editorial).toContain("slice(0, 10)");
    expect(editorial).toContain("slice(0, 30)");
    expect(editorial).toContain("slice(0, 4)");
    expect(editorial).toContain("bounded(item.starX, 0, 0, 750)");
    expect(editorial).toContain("bounded(item.starY, 0, 0, 2_000)");
    expect(editorial).toContain("bounded(diyNumber(props.block, \"prConfig\"), 0, 0, 80)");
    expect(editorial).toContain("String(titleValue).trim().slice(0, 100)");
  });

  it("statically mounts all eight business-data widgets through typed clients", () => {
    for (const name of [
      "bargain",
      "combination",
      "coupon",
      "liveBroadcast",
      "promotionList",
      "seckill",
      "presale",
      "pointsMall",
    ]) {
      expect(renderer).toContain(`"${name}"`);
    }
    for (const route of [
      "/seckill/index",
      "/seckill/list/",
      "/combination/list",
      "/bargain/list",
      "/store_integral/list",
      "/presale/list",
      "/v2/coupons",
      "/wechat/live",
    ]) {
      expect(activityClient).toContain(route);
    }
    expect(commerce).toContain("type CouponListItem");
    expect(commerce).toContain("type LiveRoomListItem");
    expect(commerce).not.toContain(" as any");
    expect(commerce).not.toContain("<component");
    expect(commerce).not.toContain("v-html");
  });

  it("bounds commerce configuration and fails closed on empty scoped product selections", () => {
    expect(commerce).toContain("slice(0, 12)");
    expect(commerce).toContain("slice(0, 50)");
    expect(commerce).toContain("bounded(diyNumber(props.block, \"numberConfig\", 6), 6, 1, 20)");
    expect(commerce).toContain("type === 4 && !labels.length");
    expect(commerce).toContain("safeDiyImageUrl");
    expect(commerce).toContain("Number.isSafeInteger(roomId)");
    expect(renderer).toContain("type === 4 && !labels.length");
    expect(renderer).toContain("store_label_id: labels.join");
  });
});
