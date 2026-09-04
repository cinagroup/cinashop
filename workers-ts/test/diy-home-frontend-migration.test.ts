import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const client = readFileSync(resolve(root, "../view/uniapp-ts/src/api/diy.ts"), "utf8");
const loader = readFileSync(resolve(root, "../view/uniapp-ts/src/utils/diy.ts"), "utf8");
const navigation = readFileSync(resolve(root, "../view/uniapp-ts/src/config/navigation.ts"), "utf8");
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
    expect(client).toContain("Promise<DiySuspendedConfig>");
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
    expect(suspended).toContain("normalizeDiyLink");
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
    expect(editorial).toContain("safeDiyColor");
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
