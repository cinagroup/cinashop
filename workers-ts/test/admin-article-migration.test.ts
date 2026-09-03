import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeAdminArticleCategoryInput,
  normalizeAdminArticleInput,
} from "@/services/content/AdminArticleService";

function validArticle(overrides: Record<string, unknown> = {}) {
  return {
    cid: 2,
    title: "迁移后的文章",
    author: "运营团队",
    content: '<h2>安全正文</h2><p><img src="/api/assets/42?expires=1&signature=stale"></p>',
    synopsis: "文章摘要",
    status: 1,
    image_input: "/api/assets/42?expires=1&signature=stale",
    share_title: "分享标题",
    share_synopsis: "分享摘要",
    sort: 30,
    url: "/pages/news/detail?id=18",
    product_id: 120,
    is_hot: 1,
    is_banner: 0,
    ...overrides,
  };
}

describe("Admin CMS article migration", () => {
  it("normalizes the complete legacy editor contract and canonicalizes private assets", () => {
    const article = normalizeAdminArticleInput(validArticle());
    expect(article).toMatchObject({
      id: 0,
      cid: 2,
      title: "迁移后的文章",
      productId: 120,
      isHot: 1,
      isBanner: 0,
      imageInput: "/api/assets/42",
    });
    expect(article.content).toContain('<img src="/api/assets/42" width="100%">');
    expect(article.content).not.toContain("signature=stale");
  });

  it("fails closed on unknown, incomplete, and unsafe article input", () => {
    expect(() => normalizeAdminArticleInput(validArticle({ admin_id: 1 }))).toThrow("未知字段");
    expect(() => normalizeAdminArticleInput(validArticle({ cid: 0 }))).toThrow("文章分类ID格式错误");
    expect(() => normalizeAdminArticleInput(validArticle({ image_input: "" }))).toThrow("请选择文章封面");
    expect(() => normalizeAdminArticleInput(validArticle({ url: "javascript:alert(1)" }))).toThrow("必须使用HTTPS");
  });

  it("keeps the legacy flat category fields strict", () => {
    expect(normalizeAdminArticleCategoryInput({
      title: "平台公告",
      intr: "规则与服务更新",
      image: "/api/assets/31?expires=1&signature=stale",
      status: 1,
      sort: 10,
    })).toEqual({
      title: "平台公告",
      intr: "规则与服务更新",
      image: "/api/assets/31",
      status: 1,
      sort: 10,
    });
    expect(() => normalizeAdminArticleCategoryInput({
      title: "这是一个超过二十个字符限制的文章分类名称字段",
      intr: "简介",
      image: "/logo.png",
      status: 1,
      sort: 0,
    })).toThrow("分类名称不能超过20个字符");
  });

  it("serializes writes, verifies readback, protects references, and audits without content", () => {
    const service = readFileSync("src/services/content/AdminArticleService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminArticleController.ts", "utf8");
    const routes = readFileSync("src/routes/adminapi.ts", "utf8");
    const permission = readFileSync("src/services/admin/AdminPermissionService.ts", "utf8");
    const migration = readFileSync("migrations/0127_admin_article_indexes.sql", "utf8");

    expect(controller).toContain("MAX_ARTICLE_BODY_BYTES = 1024 * 1024");
    expect(controller).toContain("MAX_CATEGORY_BODY_BYTES = 16 * 1024");
    expect(service).toContain("SET LOCAL lock_timeout = '2s'");
    expect(service).toContain("SET LOCAL statement_timeout = '5s'");
    expect(service).toContain("pg_advisory_xact_lock_shared");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update")');
    expect(service).toContain('.for("share")');
    expect(service).toContain("article_readback_mismatch");
    expect(service).toContain("article_category_readback_mismatch");
    expect(service).toContain("该分类下仍有文章，不能删除");
    expect(service).toContain("tx.insert(systemLog)");
    expect(service).not.toMatch(/action:\s*input\.(?:content|synopsis|title)/);

    for (const contract of [
      '/article/detail/:id", adminAuth, AdminArticle.detail',
      '/article/category", adminAuth, AdminArticle.categoryList',
      '/article/category/:id/status", adminAuth, AdminArticle.categoryStatus',
      '/article/product-options", adminAuth, AdminArticle.productOptions',
      '/article/attachment-options", adminAuth, AdminArticle.attachmentOptions',
      '/article/attachment-categories", adminAuth, AdminArticle.attachmentCategories',
    ]) expect(routes).toContain(contract);
    expect(permission).toContain('matches: ["article/"]');
    expect(migration).toContain('"sa_admin_category_active"');
    expect(migration).toContain('"sp_platform_article_options"');
  });

  it("keeps asset selection read-only and prevents unsafe HTML preview execution", () => {
    const page = readFileSync("../view/admin-ts/src/pages/content/ArticleList.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/article.ts", "utf8");
    expect(page).toContain("从素材库选择");
    expect(page).toContain("HTML 正文");
    expect(page).toContain("wrapContent");
    expect(page).not.toContain("v-html");
    expect(api).toContain('request.get("/article/attachment-options"');
    expect(api).toContain('request.get("/article/attachment-categories"');
    expect(api).not.toMatch(/request\.(?:post|put|delete)\("\/article\/attachment-options/);
  });
});
