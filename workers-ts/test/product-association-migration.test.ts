import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  normalizeProductAssociationIds,
  normalizeProductParameterSnapshot,
  productAssociationReadbackMatches,
  type ProductAssociations,
} from "../src/services/product/ProductAssociationService";

const expected: ProductAssociations = {
  categoryIds: [11],
  brandIds: [21, 22],
  productLabelIds: [31, 32],
  ensureIds: [41, 42],
  parameterTemplateId: 51,
  parameterSpecs: [
    { name: "材质", value: "棉", sort: 30, status: 1 },
    { name: "季节", value: "四季", sort: 20, status: 1 },
  ],
};

const product = {
  cateId: "11",
  brandId: 22,
  brandCom: "21,22",
  storeLabelId: "31,32",
  ensureId: "41,42",
  specsId: 51,
  specs: JSON.stringify(expected.parameterSpecs),
};

const relations = [
  { type: 1, relationId: 11 },
  { type: 2, relationId: 21 },
  { type: 2, relationId: 22 },
  { type: 3, relationId: 31 },
  { type: 3, relationId: 32 },
  { type: 5, relationId: 41 },
  { type: 5, relationId: 42 },
  { type: 6, relationId: 51 },
];

describe("admin product association migration", () => {
  it("normalizes bounded unique ids and rejects unsafe input", () => {
    expect(normalizeProductAssociationIds("3,2,3", "标签")).toEqual([3, 2]);
    expect(normalizeProductAssociationIds([4, "5", 4], "标签")).toEqual([4, 5]);
    expect(() => normalizeProductAssociationIds("1,-2", "标签")).toThrow("标签格式错误");
    expect(() => normalizeProductAssociationIds([Number.MAX_SAFE_INTEGER + 1], "标签"))
      .toThrow("标签格式错误");
  });

  it("normalizes an editable parameter snapshot without duplicate names", () => {
    expect(normalizeProductParameterSnapshot([
      { name: "材质", value: "棉", sort: 10, status: 1 },
    ])).toEqual([{ name: "材质", value: "棉", sort: 10, status: 1 }]);
    expect(() => normalizeProductParameterSnapshot([
      { name: "材质", value: "棉", sort: 10, status: 1 },
      { name: "材质", value: "麻", sort: 9, status: 1 },
    ])).toThrow("参数名称不能重复");
    expect(() => normalizeProductParameterSnapshot([{ name: "材质", value: "棉", status: 2 }]))
      .toThrow("参数状态格式错误");
  });

  it("requires the main-row snapshot and every managed relation to match after save", () => {
    expect(productAssociationReadbackMatches(product, relations, expected)).toBe(true);
    expect(productAssociationReadbackMatches(
      { ...product, ensureId: "41" },
      relations,
      expected,
    )).toBe(false);
    expect(productAssociationReadbackMatches(
      product,
      relations.filter((item) => !(item.type === 3 && item.relationId === 32)),
      expected,
    )).toBe(false);
    expect(productAssociationReadbackMatches(
      { ...product, specs: "not-json" },
      relations,
      expected,
    )).toBe(false);
  });

  it("keeps validation, replacement, readback and audit inside the short transaction", () => {
    const service = readFileSync("src/services/product/ProductAssociationService.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/AdminCrudController.ts", "utf8");
    expect(service).toContain("return withTx(this.container, async (tx) =>");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("share")');
    expect(service).toContain("replaceRelations(tx, savedProductId");
    expect(service).toContain("assertAssociationReadback(tx, savedProductId");
    expect(service).toContain("await writeAudit(tx, actor");
    expect(service).toContain("inArray(storeProductRelation.type, [...MANAGED_RELATIONS])");
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, 64 * 1024)");
  });

  it("protects assurance, brand, product-label and parameter-template references", () => {
    const associations = readFileSync("src/services/product/ProductAssociationService.ts", "utf8");
    const experience = readFileSync("src/services/product/ProductExperienceService.ts", "utf8");
    const metadata = readFileSync("src/services/product/ProductMetadataService.ts", "utf8");
    expect(associations).toContain("该品牌仍被商品使用，不能删除");
    expect(associations).toContain("该商品标签仍被商品使用，不能删除");
    expect(experience).toContain("该保障服务仍被商品使用，不能删除");
    expect(metadata).toContain("该参数模板仍被商品使用，不能删除");
    expect(metadata).toContain("eq(storeProductRelation.type, 6)");
  });

  it("registers the editor options and product save contracts under product ACLs", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const aliases = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(adminRoutes).toContain('"/product/editor/options"');
    expect(aliases).toContain('"/admin/product/editor/options"');
    expect(requiredAdminPermission("GET", "/adminapi/product/editor/options")).toBe("product.view");
    expect(requiredAdminPermission("POST", "/adminapi/product/add")).toBe("product.manage");
    expect(requiredAdminPermission("POST", "/api/admin/product/update/:id")).toBe("product.manage");
  });

  it("wires the four association groups and editable snapshot into the responsive form", () => {
    const form = readFileSync("../view/admin-ts/src/pages/product/ProductForm.vue", "utf8");
    const api = readFileSync("../view/admin-ts/src/api/product.ts", "utf8");
    expect(form).toContain('v-model="form.brand_id"');
    expect(form).toContain('v-model="form.store_label_id"');
    expect(form).toContain('v-model="form.ensure_id"');
    expect(form).toContain('v-model="form.specs_id"');
    expect(form).toContain('v-model="item.value"');
    expect(form).toContain("@media (max-width: 640px)");
    expect(api).toContain('request.get("/product/editor/options")');
  });
});
