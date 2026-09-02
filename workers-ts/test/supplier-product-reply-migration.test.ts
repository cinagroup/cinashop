import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeSupplierProductReplyContent,
  parseSupplierProductReplyQuery,
} from "@/services/supplier/SupplierProductReplyService";
import { requiredSupplierPermissions } from "@/services/supplier/SupplierPermissionService";

describe("supplier product-review migration", () => {
  it("parses bounded legacy filters in the Asia/Shanghai business calendar", () => {
    expect(parseSupplierProductReplyQuery({
      page: "2",
      limit: "25",
      is_reply: "0",
      product_id: "71",
      store_name: "保温杯",
      account: "采购",
      data: "2026-08-01 - 2026-08-02",
    })).toEqual({
      page: 2,
      limit: 25,
      isReply: 0,
      productId: 71,
      productKeyword: "保温杯",
      account: "采购",
      startTime: 1_785_513_600,
      endTime: 1_785_686_399,
    });
    expect(() => parseSupplierProductReplyQuery({ limit: "101" })).toThrow("每页数量无效");
    expect(() => parseSupplierProductReplyQuery({ is_reply: "2" })).toThrow("回复状态无效");
    expect(() => parseSupplierProductReplyQuery({ data: "9999999999" })).toThrow("评价时间范围无效");
  });

  it("normalizes bounded reply content and rejects empty or oversized values", () => {
    expect(normalizeSupplierProductReplyContent("  感\0谢反馈  ")).toBe("感谢反馈");
    expect(() => normalizeSupplierProductReplyContent(" \0 ")).toThrow("请输入回复内容");
    expect(() => normalizeSupplierProductReplyContent("评".repeat(501))).toThrow("不能超过500个字符");
  });

  it("mounts list and reply behind exact product permissions", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(routes).toContain('get("/product/reply", SupplierProductReplyController.list)');
    expect(routes).toContain('put("/product/reply/set_reply/:id", SupplierProductReplyController.setReply)');
    expect(routes).not.toContain('delete("/product/reply/:id"');
    expect(requiredSupplierPermissions("GET", "/supplierapi/product/reply"))
      .toEqual(["supplier.product.view"]);
    expect(requiredSupplierPermissions("PUT", "/supplierapi/product/reply/set_reply/601"))
      .toEqual(["supplier.product.manage"]);
  });

  it("requires both the review and joined product to belong to the Supplier", () => {
    const service = readFileSync("src/services/supplier/SupplierProductReplyService.ts", "utf8");
    expect(service).toContain("eq(storeProductReply.type, SUPPLIER_OWNER_TYPE)");
    expect(service).toContain("eq(storeProductReply.relationId, supplierId)");
    expect(service).toContain("eq(storeProduct.type, SUPPLIER_OWNER_TYPE)");
    expect(service).toContain("eq(storeProduct.relationId, supplierId)");
    expect(service).toContain('.for("update")');
    expect(service).toContain("eq(storeProductReplyComment.relationId, supplierId)");
    expect(service).not.toContain("merchantReply:");
  });

  it("retires the unscoped legacy Supplier delete contract", () => {
    const decisions = JSON.parse(readFileSync("audit/legacy-route-decisions.json", "utf8")) as {
      decisions: Array<Record<string, unknown>>;
    };
    expect(decisions.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: "supplier",
        method: "DELETE",
        path: "/supplierapi/product/reply/:id",
        status: "retired",
      }),
    ]));
  });

  it("connects the new page, navigation, preview data and manage-only reply UI", () => {
    const api = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    const router = readFileSync("../view/supplier-ts/src/router.ts", "utf8");
    const shell = readFileSync("../view/supplier-ts/src/components/AppShell.vue", "utf8");
    const page = readFileSync("../view/supplier-ts/src/pages/ProductReviews.vue", "utf8");
    expect(api).toContain('url: "/product/reply"');
    expect(api).toContain("url: `/product/reply/set_reply/${id}`");
    expect(router).toContain('path: "product-reviews"');
    expect(shell).toContain('{ path: "/product-reviews", label: "商品评价"');
    expect(page).toContain('auth.can("supplier.product.manage")');
    expect(page).toContain('v-if="canManageProducts"');
    expect(page).not.toContain("deleteProductReview");
  });
});
