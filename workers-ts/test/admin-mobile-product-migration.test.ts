import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminMobileProductAttrs,
  adminMobileProductBatchProcess,
  adminMobileProductCategories,
  adminMobileProductLabels,
  adminMobileProductList,
  adminMobileProductSetShow,
  adminMobileProductUpdateAttrs,
} from "@/controllers/api/v1/AdminCrudController";
import {
  AdminMobileProductService,
  buildAdminProductCategoryTree,
  parseAdminProductBatchBody,
  parseAdminProductListQuery,
  parseAdminProductShowBody,
  parseAdminProductSkuUpdates,
} from "@/services/admin/AdminMobileProductService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

afterEach(() => vi.restoreAllMocks());

function context(options: {
  query?: Record<string, string>;
  param?: string;
  body?: unknown;
} = {}) {
  const header = vi.fn();
  const raw = new Request("http://localhost/api/admin/product/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options.body ?? {}),
  });
  return {
    header,
    value: {
      req: {
        query: () => options.query ?? {},
        param: () => options.param ?? "",
        header: vi.fn().mockReturnValue(undefined),
        json: vi.fn().mockResolvedValue(options.body),
        raw,
      },
      get: (key: string) => key === "container"
        ? {}
        : key === "adminInfo"
          ? { id: 1, account: "admin", realName: "管理员" }
          : undefined,
      header,
      json: (body: unknown) => Response.json(body),
    } as never,
  };
}

describe("embedded admin mobile product migration", () => {
  it("parses bounded list filters and preserves the PHP default status", () => {
    expect(parseAdminProductListQuery({})).toEqual({
      page: 1,
      limit: 20,
      keyword: "",
      status: 1,
    });
    expect(parseAdminProductListQuery({
      page: "2",
      limit: "100",
      store_name: " 茶具 ",
      type: "",
    })).toEqual({ page: 2, limit: 100, keyword: "茶具", status: null });
    expect(() => parseAdminProductListQuery({ limit: "101" })).toThrow("每页数量错误");
    expect(() => parseAdminProductListQuery({ type: "8" })).toThrow("商品状态错误");
  });

  it("accepts only an explicit bounded show state and product set", () => {
    expect(parseAdminProductShowBody({ id: 8, is_show: 1 })).toEqual({ ids: [8], isShow: 1 });
    expect(parseAdminProductShowBody({ ids: [9, "8", 9], is_show: 0 })).toEqual({
      ids: [8, 9],
      isShow: 0,
    });
    expect(() => parseAdminProductShowBody({ id: [], is_show: 1 })).toThrow("请选择商品");
    expect(() => parseAdminProductShowBody({ id: 8, is_show: 2 })).toThrow("商品状态错误");
  });

  it("validates every SKU field without accepting an unknown client shape", () => {
    expect(parseAdminProductSkuUpdates({
      attr_value: [{ unique: "abc12345", price: "12.30", cost: 5, ot_price: "15", stock: 9 }],
    })).toEqual([{
      unique: "abc12345",
      price: "12.30",
      cost: "5.00",
      otPrice: "15.00",
      stock: 9,
    }]);
    expect(() => parseAdminProductSkuUpdates({
      attr_value: [{ unique: "abc12345", price: -1, cost: 5, ot_price: 15, stock: 9 }],
    })).toThrow("售价错误");
    expect(() => parseAdminProductSkuUpdates({
      attr_value: [
        { unique: "same", price: 1, cost: 1, ot_price: 1, stock: 1 },
        { unique: "same", price: 2, cost: 2, ot_price: 2, stock: 2 },
      ],
    })).toThrow("规格标识重复或为空");
    expect(() => parseAdminProductSkuUpdates({ attr_value: [{ unique: "x" }] }))
      .toThrow("请重新修改规格库存");
  });

  it("parses every bounded legacy product batch type into a deterministic replacement", () => {
    expect(parseAdminProductBatchBody({
      type: 1,
      ids: [1, 2],
      data: { cate_id: [3, 4] },
    })).toEqual({ type: 1, ids: [1, 2], relationIds: [3, 4] });
    expect(parseAdminProductBatchBody({
      type: 2,
      ids: 1,
      data: { store_label_id: [] },
    })).toEqual({ type: 2, ids: [1], relationIds: [] });
    expect(parseAdminProductBatchBody({
      type: 3,
      ids: [1],
      data: { delivery_type: [3, 1, 1] },
    })).toEqual({ type: 3, ids: [1], deliveryTypes: [1, 3] });
    expect(parseAdminProductBatchBody({
      type: 4,
      ids: [1],
      data: { give_integral: "12.5", coupon_ids: [8, 7] },
    })).toEqual({ type: 4, ids: [1], giveIntegral: "12.50", couponIds: [7, 8] });
    expect(parseAdminProductBatchBody({
      type: 5,
      ids: [1],
      data: { label_id: [] },
    })).toEqual({ type: 5, ids: [1], relationIds: [] });
    expect(parseAdminProductBatchBody({
      type: 6,
      ids: [1],
      data: { recommend: ["is_good", "is_hot"] },
    })).toEqual({ type: 6, ids: [1], recommendations: ["is_hot", "is_good"] });
    expect(parseAdminProductBatchBody({
      type: 7,
      ids: [1],
      data: { system_form_id: 9 },
    })).toEqual({ type: 7, ids: [1], systemFormId: 9 });
    expect(parseAdminProductBatchBody({
      type: 8,
      ids: [1],
      data: { freight: 2, postage: 3.5, temp_id: 99 },
    })).toEqual({ type: 8, ids: [1], freight: 2, postage: "3.50", templateId: 0 });
    expect(parseAdminProductBatchBody({
      type: 9,
      ids: [1],
      data: { brand_id: [5, 4] },
    })).toEqual({ type: 9, ids: [1], relationIds: [5, 4] });
    expect(() => parseAdminProductBatchBody({ type: 3, ids: [1], data: {} }))
      .toThrow("请选择商品配送方式");
    expect(() => parseAdminProductBatchBody({ type: 8, ids: [1], data: { freight: 3 } }))
      .toThrow("请选择运费模板");
    expect(() => parseAdminProductBatchBody({ type: 10, ids: [1], data: {} }))
      .toThrow("请选择处理类型");
    expect(() => parseAdminProductBatchBody({ type: 1, ids: [1], data: { cate_id: [] } }))
      .toThrow("请选择分类");
  });

  it("builds the old mobile category children contract deterministically", () => {
    const tree = buildAdminProductCategoryTree([
      { id: 1, pid: 0, cateName: "一级", pic: "a", bigPic: "A" },
      { id: 2, pid: 1, cateName: "二级", pic: "b", bigPic: "B" },
      { id: 3, pid: 2, cateName: "三级", pic: "c", bigPic: "C" },
    ] as never);
    expect(tree).toEqual([{
      id: 1,
      pid: 0,
      cate_name: "一级",
      pic: "a",
      big_pic: "A",
      children: [{
        id: 2,
        pid: 1,
        cate_name: "二级",
        pic: "b",
        big_pic: "B",
        children: [{
          id: 3,
          pid: 2,
          cate_name: "三级",
          pic: "c",
          big_pic: "C",
          children: [],
        }],
      }],
    }]);

    const cyclic = buildAdminProductCategoryTree([
      { id: 4, pid: 5, cateName: "环一", pic: "", bigPic: "" },
      { id: 5, pid: 4, cateName: "环二", pic: "", bigPic: "" },
    ] as never);
    expect(cyclic.map((node) => node.id)).toEqual([4, 5]);
    expect(() => JSON.stringify(cyclic)).not.toThrow();
  });

  it("returns private PHP envelopes from all seven handlers", async () => {
    vi.spyOn(AdminMobileProductService.prototype, "categories").mockResolvedValue([]);
    vi.spyOn(AdminMobileProductService.prototype, "list").mockResolvedValue({ list: [], count: 0 });
    vi.spyOn(AdminMobileProductService.prototype, "setShow").mockResolvedValue({ changed: 1, verified: true });
    vi.spyOn(AdminMobileProductService.prototype, "labels").mockResolvedValue([]);
    vi.spyOn(AdminMobileProductService.prototype, "getAttrs").mockResolvedValue([]);
    vi.spyOn(AdminMobileProductService.prototype, "updateAttrs").mockResolvedValue({ changed: 1 });
    vi.spyOn(AdminMobileProductService.prototype, "batchProcess")
      .mockResolvedValue({ changed: 1, relations: 1, verified: true });
    const calls = [
      [adminMobileProductCategories, context()],
      [adminMobileProductList, context({ query: {} })],
      [adminMobileProductSetShow, context({ body: { id: 1, is_show: 1 } })],
      [adminMobileProductLabels, context()],
      [adminMobileProductAttrs, context({ param: "1" })],
      [adminMobileProductUpdateAttrs, context({ param: "1", body: { attr_value: [] } })],
      [adminMobileProductBatchProcess, context({ body: { type: 1 } })],
    ] as const;
    for (const [handler, testContext] of calls) {
      const response = await handler(testContext.value);
      expect((await response.json()) as { status: number }).toMatchObject({ status: 200 });
      expect(testContext.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    }
  });

  it("mounts all exact routes behind product view/manage ACL", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const expected = [
      'get("/admin/product/category", adminAuth, AdminCrud.adminMobileProductCategories)',
      'get("/admin/product/admin_list", adminAuth, AdminCrud.adminMobileProductList)',
      'post("/admin/product/set_show", adminAuth, AdminCrud.adminMobileProductSetShow)',
      'get("/admin/product/product_label", adminAuth, AdminCrud.adminMobileProductLabels)',
      'get("/admin/product/get_attr/:id", adminAuth, AdminCrud.adminMobileProductAttrs)',
      'post("/admin/product/update_attrs/:id", adminAuth, AdminCrud.adminMobileProductUpdateAttrs)',
      'post("/admin/product/batch_process", adminAuth, AdminCrud.adminMobileProductBatchProcess)',
    ];
    for (const route of expected) expect(routes).toContain(route);
    expect(adminRoutes).toContain('post("/product/set_show", adminAuth, AdminCrud.adminMobileProductSetShow)');
    expect(adminRoutes).toContain('post("/product/batch_process", adminAuth, AdminCrud.adminMobileProductBatchProcess)');
    expect(requiredAdminPermission("GET", "/api/admin/product/admin_list")).toBe("product.view");
    expect(requiredAdminPermission("GET", "/api/admin/product/get_attr/:id")).toBe("product.view");
    expect(requiredAdminPermission("POST", "/api/admin/product/set_show")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/api/admin/product/update_attrs/:id")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/api/admin/product/batch_process")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/adminapi/product/set_show")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/adminapi/product/batch_process")).toBe("product.manage");
  });

  it("uses product and SKU locks, authoritative membership, and stock audit", () => {
    const service = readFileSync("src/services/admin/AdminMobileProductService.ts", "utf8");
    expect(service).toContain("for (const productId of input.ids) await lockProductWrite(tx, productId)");
    expect(service).toContain('.orderBy(asc(storeProduct.id)).for("update")');
    expect(service).toContain('eq(storeProductAttrValue.productId, productId)');
    expect(service).toContain('if (updates.some((item) => !currentByUnique.has(item.unique)))');
    expect(service).toContain('await tx.insert(storeProductStockRecord).values(stockRecords)');
    expect(service).toContain('await tx.update(storeCart).set({ status: input.isShow })');
    expect(service).toContain('eq(storeProductRelation.type, PRODUCT_CATEGORY_RELATION)');
    expect(service).toContain('eq(storeProduct.isDel, 0)');
    expect(service).toContain("商品批量上下架数据库回读校验失败");
    expect(service).toContain("商品批量运营数据库回读校验失败");
    expect(service).toContain("await tx.delete(storeProductCoupon)");
    expect(service).toContain("eq(systemForm.status, 1)");
    expect(service).toContain("eq(shippingTemplates.status, 1)");
    expect(service).toContain("await writeBatchAudit(");
    expect(service).toContain("await tx.insert(systemLog).values");
    const searchers = readFileSync("src/models/searchers/product.ts", "utf8");
    expect(searchers).toContain("isHot: (value) => (value ? eq(storeProduct.isHot, 1) : undefined)");
    expect(searchers).not.toContain("isHot: (value) => (value ? relationIn(3, [1])");
  });

  it("wires bounded, readback-verified batch operations into the Admin product list", () => {
    const api = readFileSync("../view/admin-ts/src/api/product.ts", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/product/ProductList.vue", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    const associations = readFileSync("src/services/product/ProductAssociationService.ts", "utf8");
    expect(api).toContain('request.post("/product/set_show", { ids, is_show: isShow })');
    expect(api).toContain('request.post("/product/batch_process"');
    expect(page).toContain('type="selection"');
    expect(page).toContain("apiAdminProductBatchSetShow");
    expect(page).toContain("apiAdminProductBatchRelations");
    expect(page).toContain("apiAdminProductBatchOperation");
    expect(page).toContain('value="delivery"');
    expect(page).toContain('value="reward"');
    expect(page).toContain('value="user-label"');
    expect(page).toContain('value="recommend"');
    expect(page).toContain('value="form"');
    expect(page).toContain('value="freight"');
    expect(page).toContain('value="brand"');
    expect(page).toContain("if (!result.verified)");
    expect(page).toContain("单次最多100项");
    expect(associations).toContain("gift_coupons: giftCoupons.map");
    expect(associations).toContain("user_labels: userLabels");
    expect(associations).toContain("system_forms: systemForms");
    expect(associations).toContain("shipping_templates: freightTemplates");
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, 8 * 1024)");
  });
});
