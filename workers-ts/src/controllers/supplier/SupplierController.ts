import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { clearToken } from "@/utils/cache";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { md5 } from "@/utils/jwt";
import { extractToken } from "@/middleware/auth";
import {
  normalizeSupplierPickingSheetIds,
  normalizeSupplierProfileInput,
  normalizeSupplierPasswordInput,
  SupplierService,
} from "@/services/supplier/SupplierService";
import { SupplierCompatibilityService } from "@/services/supplier/SupplierCompatibilityService";
import { SupplierShippingTemplateService } from "@/services/supplier/SupplierShippingTemplateService";
import {
  normalizeSupplierAdminInput,
  normalizeSupplierRoleInput,
  SupplierAdminService,
} from "@/services/supplier/SupplierAdminService";
import { SupplierPermissionService } from "@/services/supplier/SupplierPermissionService";
import {
  normalizeSupplierDeliveryInput,
  normalizeSupplierSplitCartInput,
  SupplierFulfillmentService,
} from "@/services/supplier/SupplierFulfillmentService";
import {
  normalizeSupplierRefundDecisionInput,
  SupplierAfterSaleService,
} from "@/services/supplier/SupplierAfterSaleService";
import { SupplierFinanceService } from "@/services/supplier/SupplierFinanceService";
import {
  buildSkuCombinations,
  normalizeSupplierProductDimensions,
  SupplierProductManagementService,
} from "@/services/supplier/SupplierProductManagementService";
import {
  ProductMetadataService,
  supplierMetadataOwner,
} from "@/services/product/ProductMetadataService";
import { SystemMetadataService } from "@/services/system/SystemMetadataService";
import {
  ProductExperienceService,
  supplierEnsureOwner,
} from "@/services/product/ProductExperienceService";
import {
  ProductSkuRetirementService,
  supplierProductSkuScope,
} from "@/services/product/ProductSkuRetirementService";
import {
  requestedConfigGroup,
  StoreScopedConfigService,
} from "@/services/store/StoreScopedConfigService";
import { readBoundedJsonObject as readRequestJsonObject } from "@/utils/request-body";

type SupplierContext = Context<{
  Bindings: Env;
  Variables: AppVariables;
}>;

function service(c: SupplierContext) {
  return new SupplierService(c.get("container"), c.env);
}

function fulfillmentService(c: SupplierContext) {
  return new SupplierFulfillmentService(c.get("container"), c.env);
}

function afterSaleService(c: SupplierContext) {
  return new SupplierAfterSaleService(c.get("container"), c.env);
}

function financeService(c: SupplierContext) {
  return new SupplierFinanceService(c.get("container"), c.env);
}

function productManagementService(c: SupplierContext) {
  return new SupplierProductManagementService(c.get("container"));
}

function productSkuRetirementService(c: SupplierContext) {
  return new ProductSkuRetirementService(c.get("container"));
}

function productMetadataService(c: SupplierContext) {
  return new ProductMetadataService(c.get("container"));
}

function systemMetadataService(c: SupplierContext) {
  return new SystemMetadataService(c.get("container"));
}

function productExperienceService(c: SupplierContext) {
  return new ProductExperienceService(c.get("container"));
}

function storeScopedConfigService(c: SupplierContext) {
  return new StoreScopedConfigService(c.get("container"));
}

function compatibilityService(c: SupplierContext) {
  return new SupplierCompatibilityService(c.get("container"));
}

function shippingTemplateService(c: SupplierContext) {
  return new SupplierShippingTemplateService(c.get("container"));
}

function supplierAdminService(c: SupplierContext) {
  return new SupplierAdminService(c.get("container"));
}

const MAX_SIMPLE_BODY_BYTES = 64 * 1024;

async function readJsonObject(c: SupplierContext): Promise<Record<string, unknown>> {
  return readRequestJsonObject(c.req.raw, MAX_SIMPLE_BODY_BYTES);
}

async function readSkuLifecycleBody(c: SupplierContext): Promise<Record<string, unknown>> {
  return readRequestJsonObject(c.req.raw, 8 * 1024);
}

const MAX_PRODUCT_BODY_BYTES = 1024 * 1024;

async function readBoundedJsonObject(c: SupplierContext): Promise<Record<string, unknown>> {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_PRODUCT_BODY_BYTES) {
    throw new ValidateException("商品数据不能超过1 MiB");
  }
  const body = c.req.raw.body;
  if (!body) throw new ValidateException("请求数据格式错误");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_PRODUCT_BODY_BYTES) {
        await reader.cancel("request body too large");
        throw new ValidateException("商品数据不能超过1 MiB");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidateException("请求数据格式错误");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function positiveId(value: string | undefined, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ValidateException(`${fieldName}错误`);
  return parsed;
}

function supplierIdentity(c: SupplierContext) {
  const supplierId = c.get("supplierId");
  const adminId = c.get("supplierAdminId");
  if (!supplierId || !adminId) throw new Error("supplier auth context missing");
  return { supplierId, adminId };
}

function supplierAdminActor(c: SupplierContext) {
  const principal = c.get("supplierAdminInfo");
  if (!principal) throw new Error("supplier admin context missing");
  return {
    id: principal.id,
    name: principal.realName || principal.account,
    ip: (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
      .trim()
      .slice(0, 45),
  };
}

export async function login(c: SupplierContext) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  const body = await readJsonObject(c);
  const account = typeof body.account === "string" ? body.account : "";
  const password = typeof body.pwd === "string" ? body.pwd : "";
  return jsonOk(c, await service(c).login(account, password), "登录成功");
}

export function loginInfo(c: SupplierContext) {
  return jsonOk(c, {
    slide: [],
    logo_square: "",
    logo_rectangle: "",
    login_logo: "",
    site_name: "CinaShop 供应商中心",
    site_url: "",
    upload_file_size_max: 10 * 1024,
  });
}

export async function logout(c: SupplierContext) {
  const token = extractToken(c);
  if (token) await clearToken(md5(token), c.env);
  return jsonOk(c, null, "退出成功");
}

export function logo(c: SupplierContext) {
  const supplier = c.get("supplierInfo");
  return jsonOk(c, {
    logo: "",
    logo_square: "",
    site_name: supplier?.supplierName || "CinaShop 供应商中心",
  });
}

export function config(c: SupplierContext) {
  return jsonOk(c, { tengxun_map_key: "", open_erp: false });
}

export async function storeConfigForm(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const type = c.req.param("type");
  if (!type) throw new ValidateException("配置类型不正确");
  return jsonOk(
    c,
    await storeScopedConfigService(c).listSupplierConfig(supplierId, type),
  );
}

export async function saveStoreConfig(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const body = await readJsonObject(c);
  const group = requestedConfigGroup(body);
  const result = await storeScopedConfigService(c).saveSupplierConfig(supplierId, body, group);
  return jsonOk(c, result, "修改成功");
}

export async function profile(c: SupplierContext) {
  const { supplierId, adminId } = supplierIdentity(c);
  return jsonOk(c, await service(c).profile(supplierId, adminId));
}

export async function updateProfile(c: SupplierContext) {
  const { supplierId, adminId } = supplierIdentity(c);
  const body = await readJsonObject(c);
  await service(c).updateProfile(supplierId, adminId, normalizeSupplierProfileInput(body));
  return jsonOk(c, null, "保存成功");
}

export async function updatePassword(c: SupplierContext) {
  const { supplierId, adminId } = supplierIdentity(c);
  const body = await readJsonObject(c);
  await service(c).changePassword(supplierId, adminId, normalizeSupplierPasswordInput(body));
  const token = extractToken(c);
  if (token) await clearToken(md5(token), c.env).catch(() => undefined);
  return jsonOk(c, null, "密码修改成功，请重新登录");
}

export async function legacyPrinting(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await storeScopedConfigService(c).legacyPrinterConfig(supplierId));
}

export async function updateLegacyPrinting(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const body = await readJsonObject(c);
  await storeScopedConfigService(c).saveLegacyPrinterConfig(supplierId, body);
  return jsonOk(c, null, "保存成功");
}

export async function shippingTemplateList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await shippingTemplateService(c).list(supplierId, c.req.query()));
}

export async function shippingTemplateDetail(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await shippingTemplateService(c).detail(
      supplierId,
      positiveId(c.req.param("id"), "运费模板ID"),
    ),
  );
}

export async function saveShippingTemplate(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const templateId = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(templateId) || templateId < 0) {
    throw new ValidateException("运费模板ID错误");
  }
  const savedId = await shippingTemplateService(c).save(
    supplierId,
    templateId,
    await readJsonObject(c),
  );
  return jsonOk(c, { id: savedId }, templateId > 0 ? "修改成功！" : "添加成功!");
}

export async function deleteShippingTemplate(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await shippingTemplateService(c).delete(
    supplierId,
    positiveId(c.req.param("id"), "运费模板ID"),
  );
  return jsonOk(c, null, "删除成功");
}

export async function shippingTemplateCityList(c: SupplierContext) {
  supplierIdentity(c);
  return jsonOk(c, await shippingTemplateService(c).cityList());
}

export async function notices(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await compatibilityService(c).notices(supplierId));
}

export async function city(c: SupplierContext) {
  supplierIdentity(c);
  const raw = c.req.query("pid") ?? "0";
  const parentId = Number(raw);
  return jsonOk(c, await compatibilityService(c).cityChildren(parentId));
}

export async function menusList(c: SupplierContext) {
  supplierIdentity(c);
  const keys = new Set(c.get("supplierPermissions") ?? []);
  return jsonOk(c, new SupplierPermissionService(c.get("container").db).buildSearchMenus(keys));
}

export async function supplierAdminList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await supplierAdminService(c).list(supplierId, c.req.query()));
}

export async function supplierAdminCreateForm(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await supplierAdminService(c).createForm(supplierId));
}

export async function supplierRoleList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await supplierAdminService(c).roles(supplierId));
}

export async function createSupplierRole(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const input = normalizeSupplierRoleInput(await readJsonObject(c));
  return jsonOk(
    c,
    await supplierAdminService(c).saveRole(supplierId, supplierAdminActor(c), 0, input),
    "角色添加成功",
  );
}

export async function updateSupplierRole(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const input = normalizeSupplierRoleInput(await readJsonObject(c));
  return jsonOk(
    c,
    await supplierAdminService(c).saveRole(
      supplierId,
      supplierAdminActor(c),
      positiveId(c.req.param("id"), "角色ID"),
      input,
    ),
    "角色修改成功",
  );
}

export async function deleteSupplierRole(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await supplierAdminService(c).deleteRole(
    supplierId,
    supplierAdminActor(c),
    positiveId(c.req.param("id"), "角色ID"),
  );
  return jsonOk(c, null, "角色删除成功");
}

export async function createSupplierAdmin(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const input = normalizeSupplierAdminInput(await readJsonObject(c), true);
  return jsonOk(
    c,
    await supplierAdminService(c).create(supplierId, supplierAdminActor(c), input),
    "添加成功",
  );
}

export async function supplierAdminDetail(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await supplierAdminService(c).detail(
      supplierId,
      positiveId(c.req.param("id"), "管理员ID"),
    ),
  );
}

export async function supplierAdminEditForm(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await supplierAdminService(c).editForm(
      supplierId,
      positiveId(c.req.param("id"), "管理员ID"),
    ),
  );
}

export async function updateSupplierAdmin(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const id = positiveId(c.req.param("id"), "管理员ID");
  const input = normalizeSupplierAdminInput(await readJsonObject(c), false);
  return jsonOk(
    c,
    await supplierAdminService(c).update(supplierId, supplierAdminActor(c), id, input),
    "修改成功",
  );
}

export async function deleteSupplierAdmin(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await supplierAdminService(c).delete(
    supplierId,
    supplierAdminActor(c),
    positiveId(c.req.param("id"), "管理员ID"),
  );
  return jsonOk(c, null, "删除成功");
}

export async function setSupplierAdminStatus(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await supplierAdminService(c).setStatus(
    supplierId,
    supplierAdminActor(c),
    positiveId(c.req.param("id"), "管理员ID"),
    Number(c.req.param("status")),
  );
  return jsonOk(c, null, Number(c.req.param("status")) === 1 ? "开启成功" : "关闭成功");
}

export async function dashboard(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await service(c).dashboard(supplierId));
}

export async function homeSummary(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await compatibilityService(c).homeSummary(supplierId, c.req.query("data")));
}

export async function homeOrderChart(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await compatibilityService(c).orderChart(supplierId, c.req.query("data")));
}

export async function homeOrderChannel(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await compatibilityService(c).orderChannel(supplierId, c.req.query("data")));
}

export async function homeOrderType(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await compatibilityService(c).orderType(supplierId, c.req.query("data")));
}

export async function productList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await service(c).productList(supplierId, c.req.query()));
}

export async function productUnits(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await productMetadataService(c).allUnits(supplierMetadataOwner(supplierId)),
  );
}

export async function productEnsures(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await productExperienceService(c).allEnsures(supplierEnsureOwner(supplierId)),
  );
}

export async function productRuleList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await productMetadataService(c).ruleList(supplierMetadataOwner(supplierId), c.req.query()),
  );
}

export async function productRuleTemplates(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await productMetadataService(c).ruleTemplates(supplierMetadataOwner(supplierId)),
  );
}

export async function productRuleDetail(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await productMetadataService(c).ruleDetail(
      supplierMetadataOwner(supplierId),
      positiveId(c.req.param("id"), "规则ID"),
    ),
  );
}

export async function productRuleSave(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("规则ID错误");
  const result = await productMetadataService(c).saveRule(
    supplierMetadataOwner(supplierId),
    id,
    await readJsonObject(c),
  );
  return jsonOk(c, result, "保存成功");
}

export async function productRuleDelete(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await productMetadataService(c).deleteRule(
    supplierMetadataOwner(supplierId),
    positiveId(c.req.param("id"), "规则ID"),
  );
  return jsonOk(c, null, "删除成功");
}

export async function productSpecsAll(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await productMetadataService(c).allSpecTemplates(supplierMetadataOwner(supplierId)),
  );
}

export async function systemFormAll(c: SupplierContext) {
  supplierIdentity(c);
  return jsonOk(c, await systemMetadataService(c).allSystemForms(true));
}

export async function systemFormInfo(c: SupplierContext) {
  supplierIdentity(c);
  const id = positiveId(c.req.param("id"), "系统表单ID");
  const info = await systemMetadataService(c).formInfo(id, c.req.query("type") === "1", true);
  return jsonOk(c, { info });
}

export async function productDetail(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const productId = positiveId(c.req.param("id"), "商品ID");
  return jsonOk(c, await productManagementService(c).productDetail(supplierId, productId));
}

export async function setProductShow(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const productId = positiveId(c.req.param("id"), "商品ID");
  const isShow = Number(c.req.param("is_show"));
  await productManagementService(c).setProductShow(supplierId, productId, isShow);
  return jsonOk(c, null, isShow === 1 ? "上架成功" : "下架成功");
}

export async function categoryTree(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const includeHidden = c.req.query("is_show") !== "1";
  return jsonOk(c, await productManagementService(c).categoryTree(supplierId, includeHidden));
}

export async function categoryDetail(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(
    c,
    await productManagementService(c).categoryDetail(
      supplierId,
      positiveId(c.req.param("id"), "分类ID"),
    ),
  );
}

export async function saveCategory(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const categoryId = c.req.param("id") ? positiveId(c.req.param("id"), "分类ID") : 0;
  const result = await productManagementService(c).saveCategory(
    supplierId,
    categoryId,
    await readJsonObject(c),
  );
  return jsonOk(c, result, categoryId > 0 ? "分类修改成功" : "分类创建成功");
}

export async function deleteCategory(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await productManagementService(c).deleteCategory(
    supplierId,
    positiveId(c.req.param("id"), "分类ID"),
  );
  return jsonOk(c, null, "分类删除成功");
}

export async function setCategoryShow(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const categoryId = positiveId(c.req.param("id"), "分类ID");
  const isShow = Number(c.req.param("is_show"));
  await productManagementService(c).setCategoryShow(supplierId, categoryId, isShow);
  return jsonOk(c, null, isShow === 1 ? "分类已启用" : "分类已停用");
}

export async function saveProduct(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const productId = Number(c.req.param("id"));
  if (!Number.isInteger(productId) || productId < 0) throw new ValidateException("商品ID错误");
  const result = await productManagementService(c).saveProduct(
    supplierId,
    productId,
    await readBoundedJsonObject(c),
  );
  return jsonOk(c, result, productId === 0 ? "商品创建成功，等待平台审核" : "商品修改成功，已重新进入待审核");
}

export async function createProduct(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const result = await productManagementService(c).saveProduct(
    supplierId,
    0,
    await readBoundedJsonObject(c),
  );
  return jsonOk(c, result, "商品创建成功，等待平台审核");
}

export async function retireProductSkus(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const result = await productSkuRetirementService(c).change(
    "retire",
    await readSkuLifecycleBody(c),
    supplierAdminActor(c),
    supplierProductSkuScope(supplierId),
  );
  return jsonOk(c, result, "SKU已退役");
}

export async function restoreProductSkus(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const result = await productSkuRetirementService(c).change(
    "restore",
    await readSkuLifecycleBody(c),
    supplierAdminActor(c),
    supplierProductSkuScope(supplierId),
  );
  return jsonOk(c, result, "SKU已恢复");
}

export async function recycleProduct(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await productManagementService(c).recycleProduct(
    supplierId,
    positiveId(c.req.param("id"), "商品ID"),
  );
  return jsonOk(c, null, "商品已移入回收站");
}

export async function adjustProductStock(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const result = await productManagementService(c).adjustStock(
    supplierId,
    positiveId(c.req.param("id"), "商品ID"),
    await readJsonObject(c),
  );
  return jsonOk(c, result, "库存调整成功");
}

export async function batchSetProductShow(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const body = await readJsonObject(c);
  const rawIds = Array.isArray(body.ids) ? body.ids : [];
  const productIds = rawIds.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new ValidateException("商品ID错误");
    return parsed;
  });
  const isShow = Number(body.is_show ?? c.req.param("is_show"));
  const result = await productManagementService(c).batchSetProductShow(supplierId, productIds, isShow);
  return jsonOk(c, result, `已更新${result.updated}个商品`);
}

async function batchSetProductShowValue(c: SupplierContext, isShow: number) {
  const { supplierId } = supplierIdentity(c);
  const body = await readJsonObject(c);
  const rawIds = Array.isArray(body.ids) ? body.ids : [];
  const productIds = rawIds.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new ValidateException("商品ID错误");
    return parsed;
  });
  const result = await productManagementService(c).batchSetProductShow(supplierId, productIds, isShow);
  return jsonOk(c, result, `已更新${result.updated}个商品`);
}

export function batchProductShow(c: SupplierContext) {
  return batchSetProductShowValue(c, 1);
}

export function batchProductUnshow(c: SupplierContext) {
  return batchSetProductShowValue(c, 0);
}

export async function generateProductAttrs(c: SupplierContext) {
  supplierIdentity(c);
  const body = await readJsonObject(c);
  const dimensions = normalizeSupplierProductDimensions(body.items);
  return jsonOk(c, {
    items: dimensions,
    combinations: buildSkuCombinations(dimensions).map((detail) => ({
      detail,
      suk: dimensions.map((dimension) => detail[dimension.value]).join(","),
    })),
  });
}

export async function orderList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await service(c).orderList(supplierId, c.req.query()));
}

export async function pickingSheets(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const ids = normalizeSupplierPickingSheetIds(c.req.query("ids"));
  return jsonOk(c, await service(c).pickingSheets(supplierId, ids));
}

export async function orderDetail(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  return jsonOk(c, await service(c).orderDetail(supplierId, orderId));
}

export async function updateOrderRemark(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  const body = await readJsonObject(c);
  if (typeof body.remark !== "string") throw new ValidateException("请输入备注");
  await service(c).updateOrderRemark(supplierId, orderId, body.remark);
  return jsonOk(c, null, "保存成功");
}

export async function expressList(c: SupplierContext) {
  supplierIdentity(c);
  return jsonOk(c, await fulfillmentService(c).expressList());
}

export async function deliverOrder(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  const body = await readJsonObject(c);
  await fulfillmentService(c).deliver(
    supplierId,
    orderId,
    normalizeSupplierDeliveryInput(body),
  );
  return jsonOk(c, null, "发货成功");
}

export async function splitCartInfo(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  return jsonOk(c, await fulfillmentService(c).splitCartInfo(supplierId, orderId));
}

export async function splitDelivery(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  const body = await readJsonObject(c);
  const result = await fulfillmentService(c).splitDelivery(
    supplierId,
    orderId,
    normalizeSupplierDeliveryInput(body),
    normalizeSupplierSplitCartInput(body),
  );
  return jsonOk(c, result, result.split ? "拆单发货成功" : "发货成功");
}

export async function splitOrders(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  return jsonOk(c, await fulfillmentService(c).splitOrders(supplierId, orderId));
}

export async function orderStatus(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  return jsonOk(c, await fulfillmentService(c).statusLogs(supplierId, orderId));
}

export async function confirmOrderTake(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const orderId = positiveId(c.req.param("id"), "订单ID");
  await fulfillmentService(c).confirmTake(supplierId, orderId);
  return jsonOk(c, null, "确认收货成功");
}

export async function refundList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await afterSaleService(c).list(supplierId, c.req.query()));
}

export async function refundDetail(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const refundId = positiveId(c.req.param("id"), "售后ID");
  return jsonOk(c, await afterSaleService(c).detail(supplierId, refundId));
}

export async function refundForm(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const refundId = positiveId(c.req.param("id"), "售后ID");
  return jsonOk(c, await afterSaleService(c).refundForm(supplierId, refundId));
}

export async function refundReasons(c: SupplierContext) {
  return jsonOk(c, await afterSaleService(c).reasons());
}

export async function updateRefundRemark(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const refundId = positiveId(c.req.param("id"), "售后ID");
  const body = await readJsonObject(c);
  if (typeof body.remark !== "string") throw new ValidateException("请输入备注");
  await afterSaleService(c).updateRemark(supplierId, refundId, body.remark);
  return jsonOk(c, null, "备注成功");
}

export async function agreeRefundReturn(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const refundId = positiveId(c.req.param("id") ?? c.req.query("order_id"), "售后ID");
  await afterSaleService(c).agreeReturn(supplierId, refundId);
  return jsonOk(c, null, "已同意退货");
}

export async function refuseRefund(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const refundId = positiveId(c.req.param("id"), "售后ID");
  const body = await readJsonObject(c);
  const reason = typeof body.refuse_reason === "string" ? body.refuse_reason : "";
  await afterSaleService(c).refuse(supplierId, refundId, reason);
  return jsonOk(c, null, "已拒绝退款");
}

export async function refundOrder(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const refundId = positiveId(c.req.param("id"), "售后ID");
  const input = normalizeSupplierRefundDecisionInput(await readJsonObject(c));
  const result = await afterSaleService(c).refund(supplierId, refundId, input);
  return jsonOk(c, result, result.completed ? "退款成功" : "退款已受理，等待渠道确认");
}

export async function financeInfo(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await financeService(c).info(supplierId));
}

export async function updateFinanceInfo(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await financeService(c).updateInfo(supplierId, await readJsonObject(c));
  return jsonOk(c, null, "设置成功");
}

export async function financeSummary(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await financeService(c).summary(supplierId));
}

export async function financeFlowList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await financeService(c).flowList(supplierId, c.req.query()));
}

export function financeFlowTypes(c: SupplierContext) {
  supplierIdentity(c);
  return jsonOk(c, { 1: "支付订单", 2: "退款订单" });
}

export async function updateFinanceFlowMark(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const id = positiveId(c.req.param("id"), "流水ID");
  const body = await readJsonObject(c);
  if (typeof body.mark !== "string") throw new ValidateException("请输入备注");
  await financeService(c).updateFlowMark(supplierId, id, body.mark);
  return jsonOk(c, null, "备注成功");
}

export async function financeFundRecord(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await financeService(c).fundRecord(supplierId, c.req.query()));
}

export async function financeFundRecordInfo(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await financeService(c).fundRecordInfo(supplierId, c.req.query()));
}

export async function extractList(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  return jsonOk(c, await financeService(c).extractList(supplierId, c.req.query()));
}

export async function applyExtract(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  await financeService(c).applyExtract(supplierId, await readJsonObject(c));
  return jsonOk(c, null, "申请转账成功");
}

export async function updateExtractMark(c: SupplierContext) {
  const { supplierId } = supplierIdentity(c);
  const id = positiveId(c.req.param("id"), "提现记录ID");
  const body = await readJsonObject(c);
  if (typeof body.mark !== "string") throw new ValidateException("请输入备注");
  await financeService(c).updateExtractMark(supplierId, id, body.mark);
  return jsonOk(c, null, "备注成功");
}
