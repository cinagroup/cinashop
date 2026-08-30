import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const routes = readFileSync(resolve(root, "src/routes/v1/index.ts"), "utf8");
const controller = readFileSync(resolve(root, "src/controllers/api/v1/ReplyController.ts"), "utf8");
const service = readFileSync(resolve(root, "src/services/product/ReplyService.ts"), "utf8");
const client = readFileSync(resolve(root, "../view/uniapp-ts/src/api/reply.ts"), "utf8");
const listPage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/goods/commentList.vue"), "utf8");
const detailPage = readFileSync(resolve(root, "../view/uniapp-ts/src/pages/goods/commentDetail.vue"), "utf8");
const pages = readFileSync(resolve(root, "../view/uniapp-ts/src/pages.json"), "utf8");
const checklist = readFileSync(resolve(root, "../MIGRATION_CHECKLIST.md"), "utf8");

function routeStatement(method: "get" | "post", path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`v1Routes\\.${method}\\(\\s*"${escaped}"`, "m").exec(routes);
  const start = match?.index ?? -1;
  expect(start, `missing ${method.toUpperCase()} ${path}`).toBeGreaterThanOrEqual(0);
  const end = routes.indexOf(";", start);
  expect(end).toBeGreaterThan(start);
  return routes.slice(start, end + 1);
}

describe("API-007 product review detail migration", () => {
  it("registers the four authenticated PHP contracts exactly once", () => {
    const expected = [
      ["post", "/reply/comment/:id", "replyComment"],
      ["get", "/reply/info/:id", "replyInfo"],
      ["post", "/reply/praise/:id", "praiseComment"],
      ["post", "/reply/un_praise/:id", "unpraiseComment"],
    ] as const;
    for (const [method, path, handler] of expected) {
      const statement = routeStatement(method, path);
      expect(statement).toContain("authMiddleware({ force: true })");
      expect(statement).toContain(`ReplyController.${handler}`);
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(routes.match(new RegExp(`v1Routes\\.${method}\\(\\s*"${escaped}"`, "gm")))
        .toHaveLength(1);
    }
  });

  it("keeps review-level likes separate from comment-level likes", () => {
    expect(routeStatement("post", "/reply/praise/:id")).toContain("ReplyController.praiseComment");
    expect(routeStatement("post", "/reply/reply_praise/:id")).toContain("ReplyController.praiseReply");
    expect(routeStatement("post", "/reply/un_reply_praise/:id")).toContain("ReplyController.unpraiseReply");
    expect(service).toContain('eq(userRelation.category, "comment")');
    expect(service).toContain('eq(userRelation.category, "reply")');
  });

  it("bounds content and fails closed on hidden parent reviews", () => {
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, 4 * 1024)");
    expect(controller.match(/c\.header\("Cache-Control", "private, no-store"\)/g))
      .toHaveLength(5);
    expect(service).toContain("MAX_REPLY_COMMENT_LENGTH = 1_000");
    expect(service).toContain("Array.from(content).length > MAX_REPLY_COMMENT_LENGTH");
    expect(service).toContain("回复内容包含非法字符");
    expect(service).toContain("eq(storeProductReply.status, 1)");
    expect(service).toContain("eq(storeProductReply.isDel, 0)");
  });

  it("makes comment likes idempotent and repairs their counter in one transaction", () => {
    expect(service).toContain("return withTx(this.container, async (tx) => {");
    expect(service).toContain('.for("update")');
    expect(service).toContain("onConflictDoNothing({");
    expect(service).toContain("where: sql`${userRelation.type} <> 'play'`");
    expect(service).toContain("COUNT(*)::int");
    expect(service).toContain("tx.update(storeProductReplyComment).set({ praise })");
    expect(service).not.toContain("praise: sql`${storeProductReplyComment.praise} - 1`");
  });

  it("returns the legacy detail shape and increments views atomically", () => {
    for (const field of [
      "reply:", "product:", "user:", "star:", "is_praise:", "comment_sum:", "suk:",
    ]) expect(service).toContain(field);
    expect(service).toContain(
      "viewsNum: sql`LEAST(${storeProductReply.viewsNum}::bigint + 1, 2147483647)::integer`",
    );
    expect(service).toContain("new Date((value + 28_800) * 1_000)");
    expect(service).toContain("String(Math.trunc((reply.productScore + reply.serviceScore) / 2))");
  });

  it("wires a typed, reachable UniApp detail flow without camelCase response drift", () => {
    for (const api of [
      "apiReplyInfo", "apiCreateReplyComment", "apiPraiseReplyComment", "apiUnpraiseReplyComment",
      "apiPraiseProductReview", "apiUnpraiseProductReview",
    ]) expect(client).toContain(`function ${api}`);
    expect(pages).toContain('"path": "pages/goods/commentDetail"');
    expect(listPage).toContain("r.product_score");
    expect(listPage).toContain("r.add_time");
    expect(listPage).not.toContain("r.productScore");
    expect(detailPage).toContain("await apiPraiseProductReview(reviewId.value)");
    expect(detailPage).toContain("await apiPraiseReplyComment(item.id)");
    expect(detailPage.indexOf("await apiPraiseReplyComment(item.id)"))
      .toBeLessThan(detailPage.indexOf("await reloadComments()", detailPage.indexOf("async function toggleCommentPraise")));
  });

  it("records the semantic false-positive and release gates in the checklist", () => {
    expect(checklist).toContain("API-007-PRODUCT-REPLY-DETAIL 4 条");
    expect(checklist).toContain("3 条 exact missing");
    expect(checklist).toContain("语义假匹配");
    expect(checklist).toContain("主 Worker/Pages 发布");
  });
});
