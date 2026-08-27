import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeReplyInput } from "@/services/product/ReplyService";

describe("订单评价完整性", () => {
  it("规范化 PHP/TS 共用的评分、文本和图片边界", () => {
    expect(
      normalizeReplyInput({
        unique: "  cart-unique  ",
        comment: "  很好的商品  ",
        productScore: "5",
        serviceScore: 4,
        logisticsScore: "3",
        replyScore: "3",
        pics: ["https://cdn.example.com/a.jpg", "/uploads/b.jpg", "/uploads/b.jpg"],
      }),
    ).toEqual({
      unique: "cart-unique",
      comment: "很好的商品",
      productScore: 5,
      serviceScore: 4,
      logisticsScore: 3,
      replyScore: 3,
      pics: ["https://cdn.example.com/a.jpg", "/uploads/b.jpg"],
    });
  });

  it("拒绝小数/越界评分、危险图片协议和超长评论", () => {
    const base = {
      unique: "u1",
      comment: "ok",
      productScore: 5,
      serviceScore: 5,
      logisticsScore: 5,
    };
    expect(() => normalizeReplyInput({ ...base, productScore: 4.5 })).toThrow("商品评分");
    expect(() => normalizeReplyInput({ ...base, logisticsScore: 6 })).toThrow("物流评分");
    expect(() => normalizeReplyInput({ ...base, pics: ["javascript:alert(1)"] })).toThrow(
      "评价图片地址",
    );
    expect(() => normalizeReplyInput({ ...base, comment: "a".repeat(513) })).toThrow(
      "512",
    );
  });

  it("先按 uid 查商品快照，再锁订单与快照并校验可评价状态", () => {
    const source = readFileSync("src/services/product/ReplyService.ts", "utf8");
    expect(source).toContain("eq(storeOrderCartInfo.uid, uid)");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain('.orderBy(storeOrderCartInfo.id)\n    .for("update")');
    expect(source).toContain("assertReviewableOrder(order, uid)");
    expect(source).toContain("orderCartInfoId: cart.id");
    expect(source).toContain("oid: order.id");
  });

  it("仅在所有非赠品快照已有评价后完成订单并记录 PHP 状态日志", () => {
    const source = readFileSync("src/services/product/ReplyService.ts", "utf8");
    expect(source).toContain("carts.filter((cart) => cart.isGift === 0)");
    expect(source).toContain("required.every((cart) => reviewedIds.has(cart.id))");
    expect(source).toContain('changeType: "check_order_over"');
    expect(source).toContain("eq(storeOrder.status, 2)");
  });

  it("自动评价真实补评价，不再直接把订单改为完成", () => {
    const worker = readFileSync("src/services/order/ScheduledMaintenanceService.ts", "utf8");
    expect(worker).toContain("autoCommentOrder(message.orderId)");
    expect(worker).not.toContain('storeOrderDao.update(order.id, { status: 3 })');
    const source = readFileSync("src/services/product/ReplyService.ts", "utf8");
    expect(source).toContain('comment: "此用户未作评价"');
    expect(source).toContain("insertedCount += 1");
  });

  it("点赞与取消点赞通过 user_relation 唯一关系保持计数幂等", () => {
    const source = readFileSync("src/services/product/ReplyService.ts", "utf8");
    expect(source).toContain('type: "like"');
    expect(source).toContain('category: "reply"');
    expect(source).toContain(".onConflictDoNothing()");
    expect(source).toContain("GREATEST(${storeProductReply.praise} - 1, 0)");
  });

  it("保留现路由并提供 PHP order/comment 与点赞兼容路由", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('"/reply/submit"');
    expect(routes).toContain('"/reply/unpraise/:id"');
    expect(routes).toContain('"/order/comment"');
    expect(routes).toContain('"/reply/reply_praise/:id"');
    expect(routes).toContain('"/reply/un_reply_praise/:id"');
  });

  it("物理迁移与 Worker 内嵌迁移逐字一致", () => {
    const migration = readFileSync("migrations/0019_order_review_integrity.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service
      .match(/private migration_0026\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
  });
});
