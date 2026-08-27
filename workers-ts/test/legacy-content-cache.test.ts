import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  AGREEMENT_CACHE_KEYS,
  normalizeAgreementKey,
  normalizeKfAdv,
  normalizeOpenAdv,
  normalizeProductDraft,
  PRODUCT_DRAFT_FIELDS,
} from "../src/services/system/LegacyContentService";

describe("legacy database-cache consumers", () => {
  it("uses safe disabled defaults and preserves PHP timing defaults", () => {
    expect(normalizeOpenAdv(null)).toEqual({
      status: 0,
      time: 3,
      interval_time: 24,
      type: "pic",
      value: [],
      video_link: "",
    });
  });

  it("normalizes at most five image records and rejects unsafe enabled content", () => {
    const normalized = normalizeOpenAdv({
      status: 1,
      time: "5",
      interval_time: "12.5",
      type: "pic",
      value: Array.from({ length: 7 }, (_, index) => ({
        img: `https://cdn.example.com/${index}.jpg`,
        link: "/pages/activity/index",
        status: 1,
      })),
    }, true);
    expect(normalized.value).toHaveLength(5);
    expect(normalized.time).toBe(5);
    expect(normalized.interval_time).toBe(12.5);
    expect(() => normalizeOpenAdv({
      status: 1,
      type: "pic",
      time: 3,
      interval_time: 24,
      value: [{ img: "javascript:alert(1)", status: 1 }],
    }, true)).toThrow("只支持 HTTPS 或站内路径");
    expect(() => normalizeOpenAdv({
      status: 1,
      type: "video",
      time: 3,
      interval_time: 24,
      video_link: "",
    }, true)).toThrow("配置视频地址");
  });

  it("whitelists legacy agreement keys and bounds customer-service content", () => {
    expect(AGREEMENT_CACHE_KEYS).toEqual(["privacy", "user", "cancel", "supplier", "agent"]);
    expect(normalizeAgreementKey("1")).toBe("user");
    expect(normalizeAgreementKey(2)).toBe("privacy");
    expect(normalizeAgreementKey("newcomer_agreement")).toBe("newcomer_agreement");
    expect(() => normalizeAgreementKey("arbitrary_cache_key")).toThrow("协议类型不支持");
    expect(normalizeKfAdv("<p>工作时间</p>", true)).toBe("<p>工作时间</p>");
    expect(() => normalizeKfAdv({ html: "bad" }, true)).toThrow("格式错误");
  });

  it("keeps only source/current product-draft fields and blocks prototype keys", () => {
    expect(PRODUCT_DRAFT_FIELDS).toContain("custom_form");
    expect(PRODUCT_DRAFT_FIELDS).toContain("store_name");
    const draft = normalizeProductDraft(JSON.parse(JSON.stringify({
      store_name: "隔夜草稿",
      price: 19.9,
      attrs: [{ suk: "默认", price: "19.90" }],
      unknown_server_field: "drop",
      __proto__: { polluted: true },
    })));
    expect(draft).toEqual({
      store_name: "隔夜草稿",
      price: 19.9,
      attrs: [{ suk: "默认", price: "19.90" }],
    });
    expect(() => normalizeProductDraft([])).toThrow("草稿格式错误");
  });

  it("maps every compatibility route to a server-side permission", () => {
    expect(requiredAdminPermission("GET", "/adminapi/config/runtime_content")).toBe("config.view");
    expect(requiredAdminPermission("POST", "/adminapi/config/runtime_content")).toBe("config.manage");
    expect(requiredAdminPermission("POST", "/adminapi/setting/set_kf_adv")).toBe("config.manage");
    expect(requiredAdminPermission("POST", "/adminapi/diy/open_adv/add")).toBe("dise.manage");
    expect(requiredAdminPermission("POST", "/adminapi/product/cache")).toBe("product.manage");
  });

  it("connects PHP-compatible public/Admin routes and real frontend consumers", () => {
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const publicController = readFileSync("src/controllers/api/v1/PublicController.ts", "utf8");
    const adminPage = readFileSync("../view/admin-ts/src/pages/config/RuntimeContent.vue", "utf8");
    const productForm = readFileSync("../view/admin-ts/src/pages/product/ProductForm.vue", "utf8");
    const uniHome = readFileSync("../view/uniapp-ts/src/pages/index/index.vue", "utf8");
    const uniKefu = readFileSync("../view/uniapp-ts/src/pages/user/kefu.vue", "utf8");
    expect(publicRoutes).toContain('"/get_open_adv"');
    expect(publicRoutes).toContain('"/user/service/get_adv"');
    expect(adminRoutes).toContain('"/setting/get_user_agreement/:type"');
    expect(adminRoutes).toContain('"/diy/get_url"');
    expect(adminRoutes).toContain('"/product/cache"');
    expect(publicController).toContain("LegacyContentService");
    expect(adminPage).toContain("客户端内容");
    expect(productForm).toContain("apiAdminProductDraftSave");
    expect(uniHome).toContain("loadOpenAdv");
    expect(uniKefu).toContain("apiKfAdv");
  });
});
