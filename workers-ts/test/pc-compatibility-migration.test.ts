import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("src/routes/v1/index.ts", "utf8");
const controller = readFileSync("src/controllers/api/v1/PcCompatibilityController.ts", "utf8");
const service = readFileSync("src/services/pc/PcCompatibilityService.ts", "utf8");
const productService = readFileSync("src/services/product/StoreProductService.ts", "utf8");
const productSearchers = readFileSync("src/models/searchers/product.ts", "utf8");
const cartService = readFileSync("src/services/order/StoreCartService.ts", "utf8");

describe("API-005 legacy PC compatibility", () => {
  it("registers every PHP /api/pc route", () => {
    const expected = [
      ['get', '/pc/key'],
      ['get', '/pc/scan/:key'],
      ['get', '/pc/get_appid'],
      ['get', '/pc/wechat_auth'],
      ['get', '/pc/get_pay_vip_code'],
      ['get', '/pc/get_product_phone_buy'],
      ['get', '/pc/get_banner'],
      ['get', '/pc/get_category_product'],
      ['get', '/pc/get_products'],
      ['get', '/pc/get_product_code/:product_id'],
      ['get', '/pc/get_city/:pid'],
      ['get', '/pc/check_order_status/:order_id/:end_time'],
      ['get', '/pc/get_company_info'],
      ['get', '/pc/get_recommend/:type'],
      ['get', '/pc/get_wechat_qrcode'],
      ['get', '/pc/get_good_product'],
      ['get', '/pc/get_cart_list'],
      ['get', '/pc/get_balance_record/:type'],
      ['get', '/pc/get_order_list'],
      ['get', '/pc/get_collect_list'],
      ['post', '/pc/order/refund/cart_info'],
      ['get', '/pc/order/refund/list'],
    ] as const;
    for (const [method, path] of expected) {
      expect(routes).toContain(`v1Routes.${method}("${path}"`);
    }
  });

  it("keeps all six user-data routes behind forced authentication", () => {
    const paths = [
      "/pc/get_cart_list",
      "/pc/get_balance_record/:type",
      "/pc/get_order_list",
      "/pc/get_collect_list",
      "/pc/order/refund/cart_info",
      "/pc/order/refund/list",
    ];
    for (const path of paths) {
      const statement = routes.slice(routes.indexOf(`"${path}"`), routes.indexOf(";", routes.indexOf(`"${path}"`)));
      expect(statement).toContain("authMiddleware({ force: true })");
    }
  });

  it("replaces the unsafe token-minting/OAuth routes with one-time challenges", () => {
    expect(routes).toContain('PcCompatibilityController.key');
    expect(routes).toContain('PcCompatibilityController.scan');
    expect(routes).toContain('PcCompatibilityController.wechatAuth');
    expect(routes).toContain('post("/pc/oauth_state", PcCompatibilityController.oauthState)');
    expect(controller).toContain('create("pc_user", clientIp(c))');
    expect(controller).toContain('c.req.header("X-Scan-Poll-Token")');
    expect(controller).toContain('.createOauthState("pc_user", clientIp(c))');
    expect(controller).not.toContain('jsonRaw(c, 501');
  });

  it("preserves hierarchical cid/sid/tid and PC selectId semantics", () => {
    expect(productSearchers).toContain("category.path LIKE");
    expect(productSearchers).toContain("category.pid =");
    expect(productSearchers).toContain("tid: (value)");
    expect(productService).toContain("if (params.selectId && (!sid || !cid))");
    expect(productService).toContain("where.timeOrder = 1");
    expect(productService).toContain("where.status = Number(params.type)");
  });

  it("owner-scopes carts, orders, collections, ledgers, and refunds", () => {
    expect(service).toContain("listLegacyPc(uid)");
    expect(service).toContain("listLegacyPc(uid, {");
    expect(service).toContain("eq(userRelation.uid, uid)");
    expect(service).toContain("moneyList(uid, type, query)");
    expect(service).toContain("eq(storeOrderRefund.uid, uid)");
  });

  it("returns explicit list/count envelopes required by the old PC client", () => {
    expect(service).toContain("return { list, count:");
    expect(cartService).toContain("return { valid, invalid }");
    expect(service).toContain("count: Number(countRows[0]?.count ?? 0)");
  });
});
