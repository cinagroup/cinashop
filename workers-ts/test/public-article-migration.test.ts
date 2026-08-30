import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  formatArticleShanghaiUnix,
  legacyArticleImages,
  PublicArticleUnavailableException,
  publicArticlePagination,
} from "@/services/content/PublicArticleCompatibilityService";
import { errorHandler } from "@/middleware/error";
import { sanitizeArticleRichText } from "../../view/uniapp-ts/src/utils/articleRichText";

const root = resolve(import.meta.dirname, "..");
const routesSource = readFileSync(resolve(root, "src/routes/v1/index.ts"), "utf8");
const controllerSource = readFileSync(
  resolve(root, "src/controllers/api/v1/PublicArticleController.ts"),
  "utf8",
);
const serviceSource = readFileSync(
  resolve(root, "src/services/content/PublicArticleCompatibilityService.ts"),
  "utf8",
);
const checklistSource = readFileSync(resolve(root, "../MIGRATION_CHECKLIST.md"), "utf8");

const ROUTES = [
  ["/article/category/list", "categoryList"],
  ["/article/list/:cid", "articleList"],
  ["/article/like/:id", "articleLike"],
  ["/article/details/:id", "articleDetails"],
  ["/article/hot/list", "hotList"],
  ["/article/new/list", "newList"],
  ["/article/banner/list", "bannerList"],
] as const;

function routeStatement(path: string): string {
  const pathIndex = routesSource.indexOf(`"${path}"`);
  expect(pathIndex, `missing route ${path}`).toBeGreaterThanOrEqual(0);
  const start = routesSource.lastIndexOf("v1Routes.get(", pathIndex);
  const end = routesSource.indexOf(");", pathIndex);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(pathIndex);
  return routesSource.slice(start, end + 2);
}

describe("PUBLIC-ARTICLE migration contract", () => {
  it("registers all seven exact GET routes behind StationOpen then optional auth", () => {
    for (const [path, handler] of ROUTES) {
      const statement = routeStatement(path);
      const station = statement.indexOf("stationOpenMiddleware()");
      const auth = statement.indexOf("authMiddleware({ force: false })");
      const controller = statement.indexOf(`PublicArticleController.${handler}`);
      expect(station).toBeGreaterThanOrEqual(0);
      expect(auth).toBeGreaterThan(station);
      expect(controller).toBeGreaterThan(auth);
      expect(routesSource.match(new RegExp(`"${path.replaceAll("/", "\\/")}"`, "g")))
        .toHaveLength(1);
    }
  });

  it("pins cache and legacy like-envelope behavior", () => {
    expect(controllerSource).toContain('personalized ? "private, no-store" : "no-store"');
    expect(controllerSource).toContain('return c.json({ status: 200, msg: "1" });');
    expect(controllerSource).not.toContain('return jsonOk(c, true');
    expect(routeStatement("/article/like/:id")).toContain("PublicArticleController.articleLike");
  });

  it("renders unavailable articles with the PHP business envelope", async () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/", () => {
      throw new PublicArticleUnavailableException();
    });

    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 400,
      msg: "文章不存在或已删除",
      data: [],
    });
  });

  it("records the audited migration and release gates", () => {
    expect(checklistSource).toContain("API-007-PUBLIC-ARTICLE 7 条公开文章合同");
    expect(checklistSource).toContain("parent::search($where,false)");
    expect(checklistSource).toContain("status=1 AND hide=0 AND is_del=0");
    expect(checklistSource).toContain("生产 Hyperdrive 审计只返回");
  });

  it("preserves PHP image token and Shanghai timestamp shapes", () => {
    expect(legacyArticleImages("")).toEqual([""]);
    expect(legacyArticleImages("a,b")).toEqual(["a", "b"]);
    expect(legacyArticleImages(" a,,b ")).toEqual([" a", "", "b "]);
    expect(formatArticleShanghaiUnix(0, "day")).toBe("1970-01-01");
    expect(formatArticleShanghaiUnix(0, "minute")).toBe("1970-01-01 08:00");
    const utcMidnight = Math.floor(Date.parse("2026-08-30T00:00:00.000Z") / 1_000);
    expect(formatArticleShanghaiUnix(utcMidnight, "minute")).toBe("2026-08-30 08:00");
  });

  it("reproduces page=0/page>0 semantics within explicit Worker bounds", () => {
    expect(publicArticlePagination({})).toEqual({ limit: 1_001, offset: 0, unpaged: true });
    expect(publicArticlePagination({ page: "0", limit: "10" })).toEqual({
      limit: 1_001,
      offset: 0,
      unpaged: true,
    });
    expect(publicArticlePagination({ page: "1" })).toEqual({ limit: 20, offset: 0, unpaged: false });
    expect(publicArticlePagination({ page: "2", limit: "101" })).toEqual({
      limit: 100,
      offset: 100,
      unpaged: false,
    });
    expect(() => publicArticlePagination({ page: "-1" })).toThrow("页码格式错误");
    expect(() => publicArticlePagination({ page: "102", limit: "100" }))
      .toThrow("分页偏移超过安全上限");
  });

  it("fails closed on unpublished rows and makes both counters transactional", () => {
    for (const clause of [
      "eq(systemArticle.status, 1)",
      "eq(systemArticle.hide, 0)",
      "eq(systemArticle.isDel, 0)",
    ]) expect(serviceSource).toContain(clause);
    expect(serviceSource).toContain("LEAST(${systemArticle.visit}::bigint + 1, 2147483647)::integer");
    expect(serviceSource).toContain('.for("update")');
    expect(serviceSource).toContain("withTx(this.container");
    expect(serviceSource).toContain("onConflictDoNothing({");
    expect(serviceSource).toContain("where: sql`${userRelation.type} <> 'play'`");
    expect(serviceSource).toContain("const likes = await relationCount(tx, id)");
    expect(serviceSource).toContain("if (!Number.isSafeInteger(uid) || uid <= 0) throw new AuthException()");
  });

  it("keeps list/detail field and source-table boundaries explicit", () => {
    expect(serviceSource).toContain("includeLikes = kind === \"category\"");
    expect(serviceSource).toContain("regexp_split_to_table(news.\"new_id\", ',')");
    expect(serviceSource).toContain("COALESCE(NULLIF(${systemArticle.content}, ''), ${articleContent.content})");
    for (const field of [
      "image_input:", "add_time:", "catename:", "store_info:", "is_like:",
    ]) expect(serviceSource).toContain(field);
    expect(serviceSource).not.toContain("contents,");
    expect(serviceSource).not.toContain("cateName:");
    expect(serviceSource).toContain("cid: String(article.cid)");
    expect(serviceSource).toContain("rows.length > MAX_UNPAGED_ROWS");
    expect(serviceSource).toContain("文章数量超过安全上限，请传入分页参数");
  });

  it("rebuilds legacy rich text with a conservative tag and attribute allowlist", () => {
    const result = sanitizeArticleRichText(`
      <!-- hidden -->
      <script>alert(1)</script>
      <p id="clobber" style="position:fixed" onclick="alert(1)">
        Hello
        <a href="jav&#x61;script:alert(1)" target="_blank">bad link</a>
        <a href="https://example.com/path" title="safe">safe link</a>
        <img src="https://cdn.example.com/cover.jpg" height="900" onerror="alert(1)" alt="1 > 0">
        <img src="data:image/svg+xml,active" alt="rejected">
        <table width="900"><tr><td>cell</td></tr></table>
      </p>
    `);
    expect(result).not.toMatch(/<(?:script|iframe|object|form)\b/i);
    expect(result).not.toMatch(/\b(?:id|style|onerror|onclick|target)\s*=/i);
    expect(result).not.toMatch(/(?:javascript|data):/i);
    expect(result).toContain('<a href="https://example.com/path" title="safe">');
    expect(result).toContain('<img src="https://cdn.example.com/cover.jpg" alt="1 &gt; 0" width="100%">');
    expect(result).toContain('<img alt="rejected" width="100%">');
    expect(result).toContain('<table width="100%">');
    expect(result).not.toContain('0">');
  });
});
