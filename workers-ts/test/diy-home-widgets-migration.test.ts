import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  legacyMidThumbnailVariant,
  newcomerCouponIssueProjection,
  newcomerCouponUserProjection,
  transformLegacyHomeComponents,
} from "../src/services/content/DiyHomeCompatibilityService";
import { legacyStationOpenValue } from "../src/middleware/station-open";

const routesSource = readFileSync("src/routes/v1/index.ts", "utf8");
const controllerSource = readFileSync("src/controllers/api/v1/DiyHomeController.ts", "utf8");
const serviceSource = readFileSync("src/services/content/DiyHomeCompatibilityService.ts", "utf8");
const publicCompatibilitySource = readFileSync(
  "src/services/content/V2PublicCompatibilityService.ts",
  "utf8",
);
const stationSource = readFileSync("src/middleware/station-open.ts", "utf8");
const signSource = readFileSync("src/services/user/UserSignCompatibilityService.ts", "utf8");
const productDaoSource = readFileSync("src/dao/product/StoreProductDao.ts", "utf8");

const PUBLIC_ROUTES = [
  ["/diy/get_diy/:id?", "getDiy"],
  ["/diy/diy_version/:id?", "diyVersion"],
] as const;

const OPTIONAL_AUTH_ROUTES = [
  ["/diy/user_info", "userInfo"],
  ["/diy/video_list", "videoList"],
  ["/diy/newcomer_list", "newcomerList"],
  ["/diy/product_rank", "productRank"],
  ["/diy/sign", "sign"],
  ["/diy/get_suspended", "suspended"],
] as const;

function routeStatement(path: string): string {
  const pathIndex = routesSource.indexOf(`"${path}"`);
  expect(pathIndex, `missing route ${path}`).toBeGreaterThanOrEqual(0);
  const start = routesSource.lastIndexOf("v1Routes.get(", pathIndex);
  expect(start, `missing GET registration for ${path}`).toBeGreaterThanOrEqual(0);
  const end = routesSource.indexOf(";", pathIndex);
  expect(end, `unterminated route ${path}`).toBeGreaterThan(pathIndex);
  return routesSource.slice(start, end + 1);
}

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex, `missing source marker ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing source marker ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function handlerBlock(name: string, nextName?: string): string {
  const start = `export async function ${name}(`;
  if (nextName) return sourceBlock(controllerSource, start, `export async function ${nextName}(`);
  const startIndex = controllerSource.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  return controllerSource.slice(startIndex);
}

function freshComponents() {
  return [
    { name: "pageFoot", keep: "footer" },
    {
      name: "promotionList",
      titleShow: { title: "remove", keep: 1 },
      opriceShow: { title: "remove", keep: 2 },
      priceShow: { title: "remove", keep: 3 },
      couponShow: { title: "remove", keep: 4 },
    },
    {
      name: "activeParty",
      titleConfig: { place: "remove", max: 9, keep: "title" },
      desConfig: { place: "remove", max: 8, keep: "description" },
      menuConfig: {
        list: {
          info: [
            { tips: "remove", max: 7, keep: "first" },
            { tips: "remove", max: 6, keep: "second" },
          ],
        },
      },
    },
    { name: "customerService", keep: true },
  ];
}

type NewcomerIssue = Parameters<typeof newcomerCouponIssueProjection>[0];
type NewcomerCouponUser = Parameters<typeof newcomerCouponUserProjection>[0];

function newcomerIssue(overrides: Partial<NewcomerIssue> = {}): NewcomerIssue {
  return {
    id: 31,
    cid: 3,
    category: 0,
    couponType: 2,
    couponTitle: "新人商品券",
    type: 1,
    couponPrice: "12.50",
    useMinPrice: "99.00",
    productId: "0",
    category_id: "0",
    brandId: "0",
    legacyProductIds: "71,72",
    legacyCategoryId: 73,
    legacyBrandId: 74,
    totalCount: 100,
    remainCount: 80,
    receiveLimit: 1,
    receiveType: 2,
    startTime: new Date("2026-08-29T00:00:00.000Z"),
    endTime: new Date("2026-08-31T00:00:00.000Z"),
    day: 7,
    isPermanent: 0,
    isGiveSubscribe: 0,
    isFullGive: 1,
    fullReduction: "3.25",
    isDel: 0,
    title: "新人商品券",
    integral: 0,
    useStartTime: new Date("2026-08-29T00:00:00.000Z"),
    useEndTime: new Date("2026-09-05T00:00:00.000Z"),
    rule: "fixture rule",
    status: 1,
    appType: 0,
    sort: 5,
    addTime: 1_787_961_600,
    ...overrides,
  };
}

function newcomerUser(overrides: Partial<NewcomerCouponUser> = {}): NewcomerCouponUser {
  return {
    id: 41,
    uid: 42,
    issueCouponId: 31,
    couponTitle: "已领新人券",
    couponPrice: "12.50",
    useMinPrice: "99.00",
    status: 0,
    startTime: new Date("2026-08-29T00:00:00.000Z"),
    endTime: new Date("2026-08-31T00:00:00.000Z"),
    useTime: new Date("2026-08-30T01:02:03.000Z"),
    type: 1,
    receiveTime: 1_787_961_500,
    receiveSource: "newcomer",
    isFail: 0,
    ...overrides,
  };
}

describe("DIY-HOME-WIDGETS migration gates", () => {
  describe("route and middleware contract", () => {
    it("registers exactly two public and six optional-auth GET routes", () => {
      const expectedPaths = [...PUBLIC_ROUTES, ...OPTIONAL_AUTH_ROUTES].map(([path]) => path);
      const registeredPaths = [...routesSource.matchAll(/"(\/diy\/[^"\r\n]+)"/g)]
        .map((match) => match[1]);
      expect(registeredPaths).toEqual(expectedPaths);
      for (const path of expectedPaths) {
        expect(routesSource.match(new RegExp(`"${path.replace(/[?]/g, "\\?")}"`, "g")))
          .toHaveLength(1);
      }

      for (const [path, handler] of PUBLIC_ROUTES) {
        const statement = routeStatement(path);
        expect(statement).not.toContain("authMiddleware(");
        expect(statement).toContain(`DiyHomeController.${handler}`);
      }
      for (const [path, handler] of OPTIONAL_AUTH_ROUTES) {
        const statement = routeStatement(path);
        expect(statement).toContain("authMiddleware({ force: false })");
        expect(statement).not.toContain("force: true");
        expect(statement).toContain(`DiyHomeController.${handler}`);
      }
    });

    it("runs StationOpen before auth and before every controller", () => {
      for (const [path, handler] of [...PUBLIC_ROUTES, ...OPTIONAL_AUTH_ROUTES]) {
        const statement = routeStatement(path);
        const station = statement.indexOf("stationOpenMiddleware()");
        const auth = statement.indexOf("authMiddleware(");
        const controller = statement.indexOf(`DiyHomeController.${handler}`);
        expect(station).toBeGreaterThanOrEqual(0);
        expect(station).toBeLessThan(controller);
        if (auth >= 0) {
          expect(station).toBeLessThan(auth);
          expect(auth).toBeLessThan(controller);
        }
      }
    });

    it("matches PHP json_decode truthiness for the station-open gate", () => {
      expect(stationSource).toContain('eq(systemConfig.menuName, "station_open")');
      expect(stationSource).toContain("eq(systemConfig.isStore, 0)");
      expect(stationSource).toContain("orderBy(desc(systemConfig.sort), desc(systemConfig.id))");
      expect(legacyStationOpenValue(undefined)).toBe(true);
      for (const closed of ["0", "0.0", '"0"', '""', "false", "null", "[]", "{}", "invalid"]) {
        expect(legacyStationOpenValue(closed), closed).toBe(false);
      }
      for (const open of ["1", '"1"', '"false"', "true", "[0]", '{"enabled":false}']) {
        expect(legacyStationOpenValue(open), open).toBe(true);
      }
      expect(stationSource).toContain("!legacyStationOpenValue(rows[0]?.value)");
      expect(stationSource).toContain('c.header("Cache-Control", "no-store")');
      expect(stationSource).toContain('jsonRaw(c, 410010, "站点升级中，请稍候访问")');
      expect(stationSource).toContain("await next()");
    });
  });

  describe("cache and side-effect boundaries", () => {
    it("marks all eight handlers no-store and personalized handlers private", () => {
      const orderedHandlers = [
        "getDiy",
        "diyVersion",
        "userInfo",
        "videoList",
        "newcomerList",
        "productRank",
        "sign",
        "suspended",
      ];
      for (const [index, name] of orderedHandlers.entries()) {
        const block = handlerBlock(name, orderedHandlers[index + 1]);
        if (index < PUBLIC_ROUTES.length) expect(block).toContain("noStore(c);");
        else expect(block).toContain("noStore(c, true);");
      }
      expect(controllerSource).toContain('personalized ? "private, no-store" : "no-store"');
    });

    it("keeps video play recording deferred, attributed, and rejection-handled", () => {
      const block = handlerBlock("videoList", "newcomerList");
      expect(block).toContain("c.executionCtx.waitUntil(");
      expect(block).toContain("recordPlays(result.playIds, uid)");
      expect(block).toContain(".catch((error)");
      expect(block).toContain('event: "diy_home_video_play_record_failed"');
    });
  });

  describe("legacy DIY component projection", () => {
    it("enables only a bounded, fully configured PHP mid thumbnail variant", () => {
      expect(legacyMidThumbnailVariant({})).toBeNull();
      expect(legacyMidThumbnailVariant({
        thumb_mid_width: { exists: true, value: "400" },
        thumb_mid_height: { exists: true, value: "400" },
      })).toBeNull();
      expect(legacyMidThumbnailVariant({
        image_thumb_status: { exists: true, value: "0" },
        thumb_mid_width: { exists: true, value: "400" },
        thumb_mid_height: { exists: true, value: "400" },
      })).toBeNull();
      expect(legacyMidThumbnailVariant({
        image_thumb_status: { exists: true, value: "1" },
        thumb_mid_width: { exists: true, value: "400" },
        thumb_mid_height: { exists: true, value: "300" },
      })).toEqual({ name: "mid", width: 400, height: 300 });
      expect(legacyMidThumbnailVariant({
        image_thumb_status: { exists: true, value: "1" },
        thumb_mid_width: { exists: true, value: "2049" },
        thumb_mid_height: { exists: true, value: "400" },
      })).toBeNull();
      expect(serviceSource).toContain("signAttachmentVariantReferences(this.env.APP_KEY, images, thumbnail)");
      expect(serviceSource).toContain("signAttachmentReferences(this.env.APP_KEY, images)");
    });

    it("omits default-home pageFoot and removes editor-only nested keys", () => {
      const result = transformLegacyHomeComponents(freshComponents(), false) as Array<Record<string, unknown>>;
      expect(result.map((item) => item.name)).toEqual([
        "promotionList",
        "activeParty",
        "customerService",
      ]);

      const promotion = result[0] as Record<string, Record<string, unknown>>;
      for (const key of ["titleShow", "opriceShow", "priceShow", "couponShow"]) {
        expect(promotion[key]).not.toHaveProperty("title");
        expect(promotion[key]).toHaveProperty("keep");
      }
      const active = result[1] as Record<string, any>;
      expect(active.titleConfig).toEqual({ keep: "title" });
      expect(active.desConfig).toEqual({ keep: "description" });
      expect(active.menuConfig.list.info).toEqual([
        { keep: "first" },
        { keep: "second" },
      ]);
    });

    it("retains pageFoot for an explicit id and fails closed on malformed values", () => {
      const explicit = transformLegacyHomeComponents(freshComponents(), true) as Array<Record<string, unknown>>;
      expect(explicit[0]?.name).toBe("pageFoot");
      expect(transformLegacyHomeComponents(null, false)).toEqual([]);
      expect(transformLegacyHomeComponents({}, false)).toEqual([]);
      expect(transformLegacyHomeComponents([null, 1, "bad", []], false)).toEqual([]);
    });

    it("preserves default lookup, fallback, response keys, and customer-service config", () => {
      const getDiy = sourceBlock(serviceSource, "async getDiy(", "async diyVersion(");
      expect(getDiy).toContain("id !== 0");
      expect(getDiy).toContain("eq(systemDise.status, 1)");
      expect(getDiy).toContain("eq(systemDise.type, 1)");
      expect(getDiy).toContain("eq(systemDise.isDiy, 1)");
      expect(getDiy).toContain('eq(systemDise.templateName, "default")');
      expect(getDiy).toContain("if (!row) return []");
      expect(getDiy).toContain('component?.name === "customerService"');
      expect(getDiy).toContain("component.routine_contact_type");
      for (const field of [
        "title", "value", "is_show", "is_bg_color", "color_picker",
        "bg_pic", "bg_tab_val", "is_bg_pic", "order_status",
      ]) expect(getDiy).toContain(`${field}:`);
    });
  });

  describe("strict PHP newcomer coupon contract", () => {
    it("keeps anonymous issue rows raw: Unix timestamps and DECIMAL strings", () => {
      const result = newcomerCouponIssueProjection(newcomerIssue());
      expect(result).toMatchObject({
        type: 2,
        coupon_type: 1,
        coupon_price: "12.50",
        use_min_price: "99.00",
        full_reduction: "3.25",
        product_id: "71,72",
        category_id: 73,
        brand_id: 74,
        start_time: 1_787_961_600,
        end_time: 1_788_134_400,
        coupon_time: 7,
        start_use_time: 1_787_961_600,
        end_use_time: 1_788_566_400,
      });
      expect(result.start_time).not.toEqual(expect.any(String));
    });

    it("applies accessors, issue binds and tidyCouponList to logged-in coupons", () => {
      const start = 1_787_961_600;
      const result = newcomerCouponUserProjection(
        newcomerUser(),
        newcomerIssue(),
        start + 3_600,
      );
      expect(result).toMatchObject({
        cid: 31,
        coupon_price: 12.5,
        use_min_price: 99,
        status: "未使用",
        type: "新人礼赠送",
        add_time: "2026/08/29",
        start_time: "2026/08/29",
        end_time: "2026/08/31",
        use_time: 1_788_051_723,
        is_fail: 0,
        _type: 2,
        _msg: "立即使用",
        pc_type: 1,
        pc_msg: "可使用",
        _add_time: "2026/08/29",
        _end_time: "2026/08/31",
        applicable_type: 2,
        coupon_time: 7,
        product_id: "71,72",
        category_id: 73,
        brand_id: 74,
        receive_type: 2,
        coupon_type: 1,
        start_use_time: 1_787_961_600,
        end_use_time: 1_788_566_400,
        rule: "fixture rule",
      });
      expect(result).not.toHaveProperty("receive_time");
    });

    it("reproduces未开始/过期/已使用 and post-24h state branches", () => {
      const now = 1_787_961_600;
      const future = newcomerCouponUserProjection(newcomerUser({
        startTime: new Date((now + 60) * 1_000),
        endTime: new Date((now + 3_600) * 1_000),
      }), null, now);
      expect(future).toMatchObject({ status: "未使用", _type: 0, _msg: "未开始", pc_type: 1, pc_msg: "未开始" });

      const expired = newcomerCouponUserProjection(newcomerUser({
        startTime: new Date((now - 7_200) * 1_000),
        endTime: new Date((now - 1) * 1_000),
      }), null, now);
      expect(expired).toMatchObject({ status: "未使用", is_fail: 1, _type: 0, _msg: "已过期", pc_type: 0, pc_msg: "已过期" });

      const used = newcomerCouponUserProjection(newcomerUser({ status: 1 }), null, now);
      expect(used).toMatchObject({ status: "已使用", _type: 0, _msg: "已使用", pc_type: 0, pc_msg: "已使用" });

      const older = newcomerCouponUserProjection(newcomerUser({
        startTime: new Date((now - 86_400) * 1_000),
        endTime: new Date((now + 86_400) * 1_000),
      }), null, now);
      expect(older).toMatchObject({ status: "未使用", _type: 1, _msg: "立即使用", pc_type: 1, pc_msg: "可使用" });
    });
  });

  describe("sign, input, and query bounds", () => {
    it("keeps the optional-login sign widget as one Monday-Sunday row", () => {
      const block = sourceBlock(signSource, "async homeDiy(", "async config(");
      expect(block).toContain("safeUid = Number.isSafeInteger(uid) && uid > 0 ? uid : 0");
      expect(signSource).toContain('configIntegerWithPresence(values, "member_func_status", 1) === 1');
      expect(block).toContain("const now = Math.floor(Date.now() / 1_000)");
      expect(block).toContain("currentWeekWindow(now)");
      expect(block).toContain("gte(userSign.addTime, window.start)");
      expect(block).toContain("lt(userSign.addTime, window.end)");
      expect(block).toContain("eq(systemSignReward.type, 0)");
      expect(block).toContain(".orderBy(asc(systemSignReward.days), asc(systemSignReward.id))");
      expect(block).toContain(".limit(1)");
      expect(block).toContain("Array.from({ length: 7 }");
      expect(block).toContain("signList: [signList]");
      for (const key of [
        "nextContinuousSignRewardList", "checkSign", "signStatus", "sign_give_point",
      ]) expect(block).toContain(`${key}:`);
    });

    it("caps pagination, video pages, ranks, and active-coupon decoration", () => {
      for (const declaration of [
        "const MAX_PAGE = 1_000_000;",
        "const MAX_PAGE_SIZE = 100;",
        "const MAX_PAGE_OFFSET = 10_000;",
        "const MAX_VIDEO_PAGE_SIZE = 10;",
        "const MAX_RANK_SIZE = 20;",
        "const MAX_ACTIVE_COUPONS = 1_000;",
      ]) expect(serviceSource).toContain(declaration);
      expect(serviceSource).toContain("Math.min(page, MAX_PAGE)");
      expect(serviceSource).toContain("Math.min(limit, cap)");
      expect(serviceSource).toContain("(safePage - 1) * safeLimit > MAX_PAGE_OFFSET");
      expect(serviceSource).toContain('throw new ValidateException("分页偏移超过安全上限")');
      expect(serviceSource).toContain("MAX_VIDEO_PAGE_SIZE, MAX_VIDEO_PAGE_SIZE");
      expect(serviceSource).toContain("raw < 1 || raw > MAX_RANK_SIZE");
      expect(serviceSource).toContain(".limit(MAX_ACTIVE_COUPONS + 1)");
      expect(serviceSource).toContain("coupons.length > MAX_ACTIVE_COUPONS");
      expect(serviceSource).toContain("parseLegacyDiyJson");
      expect(publicCompatibilitySource).toContain("const MAX_DIY_BYTES = 2_000_000;");
      expect(publicCompatibilitySource).toContain("const UTF8_ENCODER = new TextEncoder();");
      expect(publicCompatibilitySource).toContain("value.length > MAX_DIY_BYTES");
      expect(publicCompatibilitySource).toContain(
        "UTF8_ENCODER.encode(value).byteLength > MAX_DIY_BYTES",
      );
    });

    it("fails closed at anonymous, newcomer, rank, and suspended boundaries", () => {
      const userInfo = sourceBlock(serviceSource, "async userInfo(", "async videoList(");
      const newcomer = sourceBlock(serviceSource, "async newcomerList(", "private async rankDecorations(");
      const rank = sourceBlock(serviceSource, "async productRank(", "async homeSign(");
      const suspended = serviceSource.slice(serviceSource.indexOf("async suspended("));
      expect(serviceSource).toContain("Number.isSafeInteger(result)");
      expect(serviceSource).toContain("result >= -2_147_483_648 && result <= 2_147_483_647");
      expect(userInfo).toContain("uid <= 0) return []");
      expect(userInfo).toContain("legacyConfigEnabledWithPresence(configs.video_func_status)");
      expect(newcomer).toContain("getValuesWithPresence([");
      expect(newcomer).toContain('if (!enabled("newcomer_status")) return defaults');
      expect(newcomer).toContain("newcomer_integral: []");
      expect(newcomer).toContain('enabled("newcomer_limit_status", true)');
      expect(newcomer).toContain('enabled("register_price_status")');
      expect(newcomer).toContain("account.isNewcomer === 0");
      expect(newcomer).toContain("paid.length === 0");
      expect(rank).toContain('throw new ValidateException("排行榜数量参数错误")');
      expect(serviceSource).toContain("vipRights[0]?.status === 1");
      expect(serviceSource).toContain("legacyConfigEnabledWithPresence(configs.svip_price_status)");
      expect(suspended).toContain("if (!saved) return result");
      expect(suspended).toContain("for (const key of Object.keys(result))");
      expect(suspended).toContain("if (Object.hasOwn(saved, key))");
    });

    it("keeps the PHP rank projection's sort and presale-day fields", () => {
      expect(productDaoSource).toContain("sort: storeProduct.sort");
      expect(productDaoSource).toContain("presale_day: storeProduct.presaleDay");
    });
  });
});
