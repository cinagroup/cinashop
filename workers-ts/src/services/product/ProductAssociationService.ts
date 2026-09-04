import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  legacyCategory,
  shippingTemplates,
  storeBrand,
  storeCouponIssue,
  storeProduct,
  storeProductCategory,
  storeProductEnsure,
  storeProductLabel,
  storeProductRelation,
  storeProductRule,
  storeProductSpecs,
  systemForm,
  systemLog,
  userLabel,
} from "@/models/schema";
import {
  hasProductSkuEditorPayload,
  loadProductSkuEditor,
  normalizeProductSkuEditorPayload,
  parseProductSkuRuleValue,
  productSkuSummary,
  replaceProductSkuEditor,
} from "@/services/product/ProductSkuEditorService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const PRODUCT_WRITE_LOCK_NAMESPACE = 731_617;
const CATEGORY_RELATION = 1;
const BRAND_RELATION = 2;
const PRODUCT_LABEL_RELATION = 3;
const ENSURE_RELATION = 5;
const PARAMETER_RELATION = 6;
const MANAGED_RELATIONS = [
  CATEGORY_RELATION,
  BRAND_RELATION,
  PRODUCT_LABEL_RELATION,
  ENSURE_RELATION,
  PARAMETER_RELATION,
] as const;
const PARAMETER_TEMPLATE_GROUP = 3;
const CARD_PRODUCT_TYPE = 1;
const MANUAL_VIRTUAL_PRODUCT_TYPE = 3;
const MAX_ASSOCIATION_IDS = 100;
const MAX_PARAMETER_SPECS = 100;

export interface ProductEditorActor {
  id: number;
  name: string;
  ip: string;
}

export interface ProductParameterSnapshot {
  name: string;
  value: string;
  sort: number;
  status: 0 | 1;
}

/** 所有商品主表、关系、SKU拓扑写入共用同一事务锁域。 */
export async function lockProductWrite(tx: DbClient, productId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_WRITE_LOCK_NAMESPACE}, ${productId})`);
}

export interface ProductAssociations {
  categoryIds: number[];
  brandIds: number[];
  productLabelIds: number[];
  ensureIds: number[];
  parameterTemplateId: number;
  parameterSpecs: ProductParameterSnapshot[];
}

function textValue(value: unknown, field: string, maximum: number, fallback = ""): string {
  const source = value === undefined || value === null ? fallback : value;
  if (typeof source !== "string") throw new ValidateException(`${field}格式错误`);
  const result = source.trim();
  if (result.length > maximum) throw new ValidateException(`${field}不能超过${maximum}个字符`);
  return result;
}

function integerValue(
  value: unknown,
  field: string,
  fallback: number,
  minimum = 0,
  maximum = 2_147_483_647,
): number {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${field}格式错误`);
  }
  return parsed;
}

function decimalValue(value: unknown, field: string, fallback: string, positive = false): string {
  const source = value === undefined || value === null || value === "" ? fallback : String(value);
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(source)) throw new ValidateException(`${field}格式错误`);
  const amount = Number(source);
  if (!Number.isFinite(amount) || amount < 0 || (positive && amount <= 0)) {
    throw new ValidateException(positive ? `${field}必须大于0` : `${field}不能小于0`);
  }
  return amount.toFixed(2);
}

export function normalizeProductAssociationIds(
  value: unknown,
  field = "关联ID",
  maximum = MAX_ASSOCIATION_IDS,
): number[] {
  let source: unknown[];
  if (Array.isArray(value)) source = value;
  else if (typeof value === "string") source = value.trim() ? value.split(",") : [];
  else if (value === undefined || value === null || value === "") source = [];
  else source = [value];
  const result: number[] = [];
  const seen = new Set<number>();
  for (const entry of source) {
    const id = Number(typeof entry === "string" ? entry.trim() : entry);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException(`${field}格式错误`);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  if (result.length > maximum) throw new ValidateException(`${field}不能超过${maximum}项`);
  return result;
}

export function normalizeProductParameterSnapshot(value: unknown): ProductParameterSnapshot[] {
  if (value === undefined || value === null || value === "") return [];
  let source: unknown = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value) as unknown;
    } catch {
      throw new ValidateException("商品参数快照格式错误");
    }
  }
  if (!Array.isArray(source) || source.length > MAX_PARAMETER_SPECS) {
    throw new ValidateException(`商品参数快照必须是数组且不能超过${MAX_PARAMETER_SPECS}项`);
  }
  const names = new Set<string>();
  return source.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ValidateException("商品参数快照格式错误");
    }
    const row = entry as Record<string, unknown>;
    const name = textValue(row.name, "参数名称", 255);
    if (!name) throw new ValidateException("参数名称不能为空");
    if (names.has(name)) throw new ValidateException("参数名称不能重复");
    names.add(name);
    return {
      name,
      value: textValue(row.value, "参数值", 255),
      sort: integerValue(row.sort, "参数排序", 0),
      status: integerValue(row.status, "参数状态", 1, 0, 1) as 0 | 1,
    };
  });
}

function csv(ids: readonly number[]): string {
  return ids.join(",");
}

function sameIds(actual: readonly number[], expected: readonly number[]): boolean {
  return [...new Set(actual)].sort((a, b) => a - b).join(",")
    === [...new Set(expected)].sort((a, b) => a - b).join(",");
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return [...new Set(actual)].sort().join("\u0000") === [...new Set(expected)].sort().join("\u0000");
}

function readableScope<T extends { type: unknown; relationId: unknown }>(
  table: T,
  owner: { type: number; relationId: number },
) {
  return owner.type === 0
    ? and(eq(table.type as never, 0), eq(table.relationId as never, 0))
    : or(
        and(eq(table.type as never, 0), eq(table.relationId as never, 0)),
        and(eq(table.type as never, owner.type), eq(table.relationId as never, owner.relationId)),
      );
}

function relationIds(
  rows: Array<{ type: number; relationId: number }>,
  type: number,
): number[] {
  return rows.filter((row) => row.type === type).map((row) => row.relationId);
}

export function productAssociationReadbackMatches(
  product: {
    cateId: string;
    brandId: number;
    brandCom: string;
    storeLabelId: string | null;
    ensureId: string | null;
    specsId: number;
    specs: string | null;
  } | undefined,
  relations: Array<{ type: number; relationId: number }>,
  expected: ProductAssociations,
): boolean {
  if (!product) return false;
  try {
    return sameIds(normalizeProductAssociationIds(product.cateId), expected.categoryIds)
      && sameIds(normalizeProductAssociationIds(product.brandCom), expected.brandIds)
      && product.brandId === (expected.brandIds.at(-1) ?? 0)
      && sameIds(normalizeProductAssociationIds(product.storeLabelId), expected.productLabelIds)
      && sameIds(normalizeProductAssociationIds(product.ensureId), expected.ensureIds)
      && product.specsId === expected.parameterTemplateId
      && JSON.stringify(normalizeProductParameterSnapshot(product.specs)) === JSON.stringify(expected.parameterSpecs)
      && sameIds(relationIds(relations, CATEGORY_RELATION), expected.categoryIds)
      && sameIds(relationIds(relations, BRAND_RELATION), expected.brandIds)
      && sameIds(relationIds(relations, PRODUCT_LABEL_RELATION), expected.productLabelIds)
      && sameIds(relationIds(relations, ENSURE_RELATION), expected.ensureIds)
      && sameIds(
        relationIds(relations, PARAMETER_RELATION),
        expected.parameterTemplateId > 0 ? [expected.parameterTemplateId] : [],
      );
  } catch {
    return false;
  }
}

async function writeAudit(
  tx: DbClient,
  actor: ProductEditorActor,
  operation: "create" | "update" | "set_show",
  productId: number,
  now: number,
): Promise<void> {
  await tx.insert(systemLog).values({
    adminId: actor.id,
    adminName: actor.name.slice(0, 64),
    path: operation === "create"
      ? "/adminapi/product/add"
      : operation === "set_show"
        ? `/adminapi/product/set_show/${productId}`
        : `/adminapi/product/edit/${productId}`,
    page: "/product/form",
    method: "POST",
    action: `product.${operation};id=${productId}`,
    ip: actor.ip.slice(0, 45),
    type: "product",
    addTime: now,
  });
}

export class ProductAssociationService {
  constructor(private readonly container: Container) {}

  async editorOptions() {
    const [
      brands,
      labels,
      ensures,
      templates,
      categories,
      skuRules,
      userLabels,
      giftCoupons,
      systemForms,
      freightTemplates,
    ] = await Promise.all([
      this.container.db.select({ id: storeBrand.id, name: storeBrand.brandName })
        .from(storeBrand)
        .where(and(eq(storeBrand.isDel, 0), eq(storeBrand.isShow, 1)))
        .orderBy(desc(storeBrand.sort), asc(storeBrand.id))
        .limit(500),
      this.container.db.select({ id: storeProductLabel.id, name: storeProductLabel.labelName })
        .from(storeProductLabel)
        .where(and(
          eq(storeProductLabel.type, 0),
          eq(storeProductLabel.relationId, 0),
          eq(storeProductLabel.status, 1),
          eq(storeProductLabel.isShow, 1),
        ))
        .orderBy(desc(storeProductLabel.sort), asc(storeProductLabel.id))
        .limit(500),
      this.container.db.select({ id: storeProductEnsure.id, name: storeProductEnsure.name })
        .from(storeProductEnsure)
        .where(and(
          eq(storeProductEnsure.type, 0),
          eq(storeProductEnsure.relationId, 0),
          eq(storeProductEnsure.status, 1),
        ))
        .orderBy(desc(storeProductEnsure.sort), asc(storeProductEnsure.id))
        .limit(500),
      this.container.db.select({ id: legacyCategory.id, name: legacyCategory.name })
        .from(legacyCategory)
        .where(and(
          eq(legacyCategory.type, 0),
          eq(legacyCategory.relationId, 0),
          eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
          eq(legacyCategory.isShow, 1),
        ))
        .orderBy(desc(legacyCategory.sort), asc(legacyCategory.id))
        .limit(500),
      this.container.db.select({ id: storeProductCategory.id, name: storeProductCategory.cateName })
        .from(storeProductCategory)
        .where(and(
          eq(storeProductCategory.type, 0),
          eq(storeProductCategory.relationId, 0),
          eq(storeProductCategory.isShow, 1),
        ))
        .orderBy(desc(storeProductCategory.sort), asc(storeProductCategory.id))
        .limit(500),
      this.container.db.select({
        id: storeProductRule.id,
        name: storeProductRule.ruleName,
        value: storeProductRule.ruleValue,
      }).from(storeProductRule).where(and(
        eq(storeProductRule.type, 0),
        eq(storeProductRule.relationId, 0),
      )).orderBy(desc(storeProductRule.id)).limit(500),
      this.container.db.select({ id: userLabel.id, name: userLabel.name })
        .from(userLabel)
        .where(and(
          eq(userLabel.type, 0),
          eq(userLabel.relationId, 0),
          eq(userLabel.status, 1),
        ))
        .orderBy(desc(userLabel.sort), asc(userLabel.id))
        .limit(500),
      this.container.db.select({
        id: storeCouponIssue.id,
        couponTitle: storeCouponIssue.couponTitle,
        title: storeCouponIssue.title,
      }).from(storeCouponIssue).where(and(
        eq(storeCouponIssue.isDel, 0),
        eq(storeCouponIssue.status, 1),
      )).orderBy(desc(storeCouponIssue.sort), asc(storeCouponIssue.id)).limit(500),
      this.container.db.select({ id: systemForm.id, name: systemForm.name })
        .from(systemForm)
        .where(and(eq(systemForm.isDel, 0), eq(systemForm.status, 1)))
        .orderBy(desc(systemForm.id))
        .limit(500),
      this.container.db.select({ id: shippingTemplates.id, name: shippingTemplates.name })
        .from(shippingTemplates)
        .where(and(
          eq(shippingTemplates.ownerType, 0),
          eq(shippingTemplates.relationId, 0),
          eq(shippingTemplates.isDel, 0),
          eq(shippingTemplates.status, 1),
        ))
        .orderBy(desc(shippingTemplates.sort), asc(shippingTemplates.id))
        .limit(500),
    ]);
    const templateSpecs = templates.length
      ? await this.container.db.select({
          id: storeProductSpecs.id,
          temp_id: storeProductSpecs.tempId,
          name: storeProductSpecs.name,
          value: storeProductSpecs.value,
          sort: storeProductSpecs.sort,
          status: storeProductSpecs.status,
        }).from(storeProductSpecs).where(and(
          inArray(storeProductSpecs.tempId, templates.map((item) => item.id)),
          eq(storeProductSpecs.status, 1),
        )).orderBy(desc(storeProductSpecs.sort), asc(storeProductSpecs.id))
      : [];
    return {
      categories,
      brands,
      product_labels: labels,
      user_labels: userLabels,
      gift_coupons: giftCoupons.map((coupon) => ({
        id: coupon.id,
        name: coupon.couponTitle || coupon.title || `优惠券 ${coupon.id}`,
      })),
      system_forms: systemForms,
      shipping_templates: freightTemplates,
      ensures,
      parameter_templates: templates.map((template) => ({
        ...template,
        specs: templateSpecs.filter((item) => item.temp_id === template.id),
      })),
      sku_rule_templates: skuRules.flatMap((rule) => {
        const dimensions = parseProductSkuRuleValue(rule.value);
        return dimensions ? [{ id: rule.id, name: rule.name, dimensions }] : [];
      }),
    };
  }

  async detail(productId: number) {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new ValidateException("商品ID错误");
    const product = await this.container.db.select().from(storeProduct)
      .where(and(eq(storeProduct.id, productId), eq(storeProduct.isDel, 0))).limit(1);
    if (!product[0]) throw new NotFoundException("商品不存在");
    const item = product[0];
    const [relations, skuEditor] = await Promise.all([
      this.container.db.select({
        type: storeProductRelation.type,
        relationId: storeProductRelation.relationId,
      }).from(storeProductRelation).where(and(
        eq(storeProductRelation.productId, productId),
        inArray(storeProductRelation.type, [...MANAGED_RELATIONS]),
      )),
      loadProductSkuEditor(this.container.db, productId, item.specType),
    ]);
    const categoryIds = normalizeProductAssociationIds([
      ...normalizeProductAssociationIds(item.cateId, "商品分类"),
      ...relationIds(relations, CATEGORY_RELATION),
    ], "商品分类");
    const brandIds = normalizeProductAssociationIds([
      ...normalizeProductAssociationIds(item.brandCom, "商品品牌"),
      ...(item.brandId > 0 ? [item.brandId] : []),
      ...relationIds(relations, BRAND_RELATION),
    ], "商品品牌");
    const productLabelIds = normalizeProductAssociationIds([
      ...normalizeProductAssociationIds(item.storeLabelId, "商品标签"),
      ...relationIds(relations, PRODUCT_LABEL_RELATION),
    ], "商品标签");
    const ensureIds = normalizeProductAssociationIds([
      ...normalizeProductAssociationIds(item.ensureId, "保障服务"),
      ...relationIds(relations, ENSURE_RELATION),
    ], "保障服务");
    const parameterTemplateId = item.specsId || relationIds(relations, PARAMETER_RELATION)[0] || 0;
    let specs: ProductParameterSnapshot[] = [];
    try {
      specs = normalizeProductParameterSnapshot(item.specs);
    } catch {
      // Historical malformed snapshots remain visible as an empty editor value;
      // a subsequent association save must provide a fresh validated snapshot.
    }
    return {
      id: item.id,
      product_type: item.productType,
      type: item.type,
      relation_id: item.relationId,
      store_name: item.storeName,
      store_info: item.storeInfo,
      image: item.image,
      price: item.price,
      ot_price: item.otPrice,
      stock: item.stock,
      sales: item.sales,
      is_show: item.isShow,
      is_verify: item.isVerify,
      is_del: item.isDel,
      cate_id: categoryIds,
      keyword: item.keyword,
      unit_name: item.unitName,
      sort: item.sort,
      is_vip: item.isVip,
      is_support_refund: item.isSupportRefund,
      vip_price: item.vipPrice,
      brand_id: brandIds,
      store_label_id: productLabelIds,
      ensure_id: ensureIds,
      specs_id: parameterTemplateId,
      specs,
      ...skuEditor,
    };
  }

  async save(
    productId: number,
    body: Record<string, unknown>,
    actor: ProductEditorActor,
  ): Promise<{ id: number; associations_verified: boolean; sku_verified: boolean }> {
    if (!Number.isSafeInteger(productId) || productId < 0) throw new ValidateException("商品ID错误");
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      if (productId > 0) {
        await lockProductWrite(tx, productId);
      }
      const existingRows = productId > 0
        ? await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1).for("update")
        : [];
      const existing = existingRows[0];
      if (productId > 0 && (!existing || existing.isDel === 1)) throw new NotFoundException("商品不存在");

      const productType = existing?.productType ?? integerValue(
        body.product_type,
        "商品类型",
        0,
        0,
        MANUAL_VIRTUAL_PRODUCT_TYPE,
      );
      if (![0, CARD_PRODUCT_TYPE, MANUAL_VIRTUAL_PRODUCT_TYPE].includes(productType)) {
        throw new ValidateException("当前迁移阶段仅支持实物、卡密或手工虚拟商品");
      }
      if (existing && Object.prototype.hasOwnProperty.call(body, "product_type")) {
        const requestedProductType = integerValue(
          body.product_type,
          "商品类型",
          existing.productType,
          0,
          4,
        );
        if (requestedProductType !== existing.productType) {
          throw new ValidateException("商品创建后不能修改履约类型");
        }
      }

      const skuPayload = hasProductSkuEditorPayload(body)
        ? normalizeProductSkuEditorPayload(body, productType)
        : null;
      if (!existing && productType === CARD_PRODUCT_TYPE && !skuPayload) {
        throw new ValidateException("卡密商品必须配置SKU及交付方式");
      }
      const skuSummary = skuPayload ? productSkuSummary(skuPayload) : null;
      const storeName = textValue(body.store_name ?? existing?.storeName, "商品名称", 256);
      if (!storeName) throw new ValidateException("商品名称不能为空");
      const price = skuSummary?.price
        ?? decimalValue(body.price, "价格", existing?.price ?? "0", true);
      const otPrice = skuSummary?.otPrice
        ?? decimalValue(body.ot_price, "原价", existing?.otPrice ?? price);
      const vipPrice = skuSummary?.vipPrice
        ?? decimalValue(body.vip_price, "会员价", existing?.vipPrice ?? "0");
      const stock = skuSummary?.stock ?? integerValue(body.stock, "库存", existing?.stock ?? 0);
      const sort = integerValue(body.sort, "排序", existing?.sort ?? 0, 0, 999);
      const isShow = integerValue(body.is_show, "上架状态", existing?.isShow ?? 1, 0, 1);
      const isVip = integerValue(body.is_vip, "会员状态", existing?.isVip ?? 0, 0, 1);
      const hasAssociations = productId === 0 || [
        "cate_id", "brand_id", "store_label_id", "ensure_id", "specs_id", "specs",
      ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
      const owner = { type: existing?.type ?? 0, relationId: existing?.relationId ?? 0 };
      let associationBody = body;
      let historicalParameters: { templateId: number; specs: ProductParameterSnapshot[] } | undefined;
      if (hasAssociations && existing) {
        const currentRelations = await tx.select({
          type: storeProductRelation.type,
          relationId: storeProductRelation.relationId,
        }).from(storeProductRelation).where(and(
          eq(storeProductRelation.productId, existing.id),
          inArray(storeProductRelation.type, [...MANAGED_RELATIONS]),
        ));
        let existingSpecs: ProductParameterSnapshot[] = [];
        try {
          existingSpecs = normalizeProductParameterSnapshot(existing.specs);
        } catch {
          // A malformed historical snapshot cannot be silently copied into a new save.
        }
        const fallback = {
          cate_id: normalizeProductAssociationIds([
            ...normalizeProductAssociationIds(existing.cateId),
            ...relationIds(currentRelations, CATEGORY_RELATION),
          ]),
          brand_id: normalizeProductAssociationIds([
            ...normalizeProductAssociationIds(existing.brandCom),
            ...(existing.brandId > 0 ? [existing.brandId] : []),
            ...relationIds(currentRelations, BRAND_RELATION),
          ]),
          store_label_id: normalizeProductAssociationIds([
            ...normalizeProductAssociationIds(existing.storeLabelId),
            ...relationIds(currentRelations, PRODUCT_LABEL_RELATION),
          ]),
          ensure_id: normalizeProductAssociationIds([
            ...normalizeProductAssociationIds(existing.ensureId),
            ...relationIds(currentRelations, ENSURE_RELATION),
          ]),
          specs_id: existing.specsId || relationIds(currentRelations, PARAMETER_RELATION)[0] || 0,
          specs: existingSpecs,
        };
        associationBody = { ...fallback, ...body };
        historicalParameters = { templateId: fallback.specs_id, specs: existingSpecs };
      }
      const associations = hasAssociations
        ? await this.validateAssociations(tx, owner, associationBody, historicalParameters)
        : null;

      const values = {
        storeName,
        storeInfo: textValue(body.store_info, "商品简介", 256, existing?.storeInfo ?? ""),
        image: textValue(body.image, "商品主图", 256, existing?.image ?? ""),
        price,
        otPrice,
        vipPrice,
        stock,
        keyword: textValue(body.keyword, "关键词", 256, existing?.keyword ?? ""),
        unitName: textValue(body.unit_name, "单位", 32, existing?.unitName ?? "件") || "件",
        sort,
        isShow,
        isVip,
        isSupportRefund: integerValue(
          body.is_support_refund,
          "退款支持状态",
          existing?.isSupportRefund ?? 1,
          0,
          1,
        ),
        productType,
        ...(productType === CARD_PRODUCT_TYPE || productType === MANUAL_VIRTUAL_PRODUCT_TYPE ? {
          deliveryType: "",
          freight: 2,
          postage: "0.00",
          tempId: 0,
          isPostage: 0,
        } : {}),
        ...(skuPayload ? {
          specType: skuPayload.specType,
          settlePrice: skuSummary!.settlePrice,
          cost: skuSummary!.cost,
          isSold: skuSummary!.isSold,
        } : {}),
        ...(associations ? {
          cateId: csv(associations.categoryIds),
          brandId: associations.brandIds.at(-1) ?? 0,
          brandCom: csv(associations.brandIds),
          storeLabelId: csv(associations.productLabelIds),
          ensureId: csv(associations.ensureIds),
          specsId: associations.parameterTemplateId,
          specs: associations.parameterSpecs.length ? JSON.stringify(associations.parameterSpecs) : "",
        } : {}),
      };

      let savedProductId = productId;
      if (existing) {
        const updated = await tx.update(storeProduct).set(values).where(and(
          eq(storeProduct.id, productId),
          eq(storeProduct.isDel, 0),
        )).returning({ id: storeProduct.id });
        if (!updated[0]) throw new NotFoundException("商品不存在");
      } else {
        const inserted = await tx.insert(storeProduct).values({
          ...values,
          type: 0,
          relationId: 0,
          isVerify: 1,
          isDel: 0,
          specType: integerValue(body.spec_type, "规格类型", 0, 0, 1),
          addTime: now,
          ficti: integerValue(body.ficti, "虚拟销量", 0),
        }).returning({ id: storeProduct.id });
        if (!inserted[0]) throw new Error("商品创建后未返回ID");
        savedProductId = inserted[0].id;
        await lockProductWrite(tx, savedProductId);
      }

      if (associations) {
        await this.replaceRelations(tx, savedProductId, isShow, associations, now);
        await this.assertAssociationReadback(tx, savedProductId, associations);
      }
      if (skuPayload) {
        await replaceProductSkuEditor(tx, {
          id: savedProductId,
          productType,
          image: values.image,
          type: existing?.type ?? 0,
          relationId: existing?.relationId ?? 0,
        }, skuPayload, now);
      }
      await writeAudit(tx, actor, existing ? "update" : "create", savedProductId, now);
      return {
        id: savedProductId,
        associations_verified: associations !== null,
        sku_verified: skuPayload !== null,
      };
    });
  }

  async deleteBrand(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("品牌ID错误");
    await withTx(this.container, async (tx) => {
      const brand = await tx.select({ id: storeBrand.id }).from(storeBrand)
        .where(and(eq(storeBrand.id, id), eq(storeBrand.isDel, 0))).limit(1).for("update");
      if (!brand[0]) throw new NotFoundException("品牌不存在");
      const [relation, direct, legacy] = await Promise.all([
        tx.select({ id: storeProductRelation.id }).from(storeProductRelation).where(and(
          eq(storeProductRelation.type, BRAND_RELATION), eq(storeProductRelation.relationId, id),
        )).limit(1),
        tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
          eq(storeProduct.brandId, id), eq(storeProduct.isDel, 0),
        )).limit(1),
        tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
          eq(storeProduct.isDel, 0),
          sql`(',' || COALESCE(${storeProduct.brandCom}, '') || ',') LIKE ${`%,${id},%`}`,
        )).limit(1),
      ]);
      if (relation[0] || direct[0] || legacy[0]) throw new ValidateException("该品牌仍被商品使用，不能删除");
      await tx.update(storeBrand).set({ isDel: 1, isShow: 0 }).where(eq(storeBrand.id, id));
    });
  }

  async setShow(productId: number, isShow: number, actor: ProductEditorActor): Promise<void> {
    if (!Number.isSafeInteger(productId) || productId <= 0) throw new ValidateException("商品ID错误");
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("上架状态只能是0或1");
    await withTx(this.container, async (tx) => {
      await lockProductWrite(tx, productId);
      const updated = await tx.update(storeProduct).set({ isShow }).where(and(
        eq(storeProduct.id, productId),
        eq(storeProduct.isDel, 0),
      )).returning({ id: storeProduct.id });
      if (!updated[0]) throw new NotFoundException("商品不存在");
      await tx.update(storeProductRelation).set({ status: isShow }).where(and(
        eq(storeProductRelation.productId, productId),
        eq(storeProductRelation.type, CATEGORY_RELATION),
      ));
      await writeAudit(tx, actor, "set_show", productId, Math.floor(Date.now() / 1000));
    });
  }

  async deleteProductLabel(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("商品标签ID错误");
    await withTx(this.container, async (tx) => {
      const label = await tx.select({ id: storeProductLabel.id }).from(storeProductLabel)
        .where(eq(storeProductLabel.id, id)).limit(1).for("update");
      if (!label[0]) throw new NotFoundException("商品标签不存在");
      const [relation, legacy] = await Promise.all([
        tx.select({ id: storeProductRelation.id }).from(storeProductRelation).where(and(
          eq(storeProductRelation.type, PRODUCT_LABEL_RELATION),
          eq(storeProductRelation.relationId, id),
        )).limit(1),
        tx.select({ id: storeProduct.id }).from(storeProduct).where(and(
          eq(storeProduct.isDel, 0),
          sql`(',' || COALESCE(${storeProduct.storeLabelId}, '') || ',') LIKE ${`%,${id},%`}`,
        )).limit(1),
      ]);
      if (relation[0] || legacy[0]) throw new ValidateException("该商品标签仍被商品使用，不能删除");
      await tx.delete(storeProductLabel).where(eq(storeProductLabel.id, id));
    });
  }

  private async validateAssociations(
    tx: DbClient,
    owner: { type: number; relationId: number },
    body: Record<string, unknown>,
    historicalParameters?: { templateId: number; specs: ProductParameterSnapshot[] },
  ): Promise<ProductAssociations> {
    const categoryIds = normalizeProductAssociationIds(body.cate_id, "商品分类", 20);
    const brandIds = normalizeProductAssociationIds(body.brand_id, "商品品牌", 20);
    const productLabelIds = normalizeProductAssociationIds(body.store_label_id, "商品标签");
    const ensureIds = normalizeProductAssociationIds(body.ensure_id, "保障服务");
    const parameterTemplateId = integerValue(body.specs_id, "参数模板", 0);
    const parameterSpecs = normalizeProductParameterSnapshot(body.specs);
    const [categories, brands, labels, ensures, templates] = await Promise.all([
      categoryIds.length ? tx.select({ id: storeProductCategory.id }).from(storeProductCategory)
        .where(and(inArray(storeProductCategory.id, categoryIds), readableScope(storeProductCategory, owner)))
        .for("share") : [],
      brandIds.length ? tx.select({ id: storeBrand.id }).from(storeBrand)
        .where(and(inArray(storeBrand.id, brandIds), eq(storeBrand.isDel, 0))).for("share") : [],
      productLabelIds.length ? tx.select({ id: storeProductLabel.id }).from(storeProductLabel)
        .where(and(inArray(storeProductLabel.id, productLabelIds), readableScope(storeProductLabel, owner)))
        .for("share") : [],
      ensureIds.length ? tx.select({ id: storeProductEnsure.id }).from(storeProductEnsure)
        .where(and(inArray(storeProductEnsure.id, ensureIds), readableScope(storeProductEnsure, owner)))
        .for("share") : [],
      parameterTemplateId > 0 ? tx.select({ id: legacyCategory.id }).from(legacyCategory)
        .where(and(
          eq(legacyCategory.id, parameterTemplateId),
          eq(legacyCategory.group, PARAMETER_TEMPLATE_GROUP),
          readableScope(legacyCategory, owner),
        )).limit(1).for("share") : [],
    ]);
    if (!sameIds(categories.map((item) => item.id), categoryIds)) throw new ValidateException("商品分类不存在或不属于当前商品");
    if (!sameIds(brands.map((item) => item.id), brandIds)) throw new ValidateException("商品品牌不存在或已删除");
    if (!sameIds(labels.map((item) => item.id), productLabelIds)) throw new ValidateException("商品标签不存在或不属于当前商品");
    if (!sameIds(ensures.map((item) => item.id), ensureIds)) throw new ValidateException("保障服务不存在或不属于当前商品");
    if (parameterTemplateId > 0 && !templates[0]) throw new ValidateException("参数模板不存在或不属于当前商品");
    if (parameterTemplateId === 0 && parameterSpecs.length) throw new ValidateException("请选择参数模板后再填写商品参数");
    if (parameterTemplateId > 0) {
      const templateSpecs = await tx.select({ name: storeProductSpecs.name })
        .from(storeProductSpecs).where(and(
          eq(storeProductSpecs.tempId, parameterTemplateId),
          eq(storeProductSpecs.status, 1),
        )).orderBy(desc(storeProductSpecs.sort), asc(storeProductSpecs.id)).for("share");
      const currentShapeMatches = sameNames(
        parameterSpecs.map((item) => item.name),
        templateSpecs.map((item) => item.name),
      );
      const historicalShapeMatches = historicalParameters?.templateId === parameterTemplateId
        && sameNames(
          parameterSpecs.map((item) => item.name),
          historicalParameters.specs.map((item) => item.name),
        );
      if (!currentShapeMatches && !historicalShapeMatches) {
        throw new ValidateException("商品参数快照必须完整对应所选模板的启用参数");
      }
    }
    return { categoryIds, brandIds, productLabelIds, ensureIds, parameterTemplateId, parameterSpecs };
  }

  private async replaceRelations(
    tx: DbClient,
    productId: number,
    isShow: number,
    associations: ProductAssociations,
    now: number,
  ): Promise<void> {
    const categoryRows = associations.categoryIds.length
      ? await tx.select({ id: storeProductCategory.id, pid: storeProductCategory.pid })
        .from(storeProductCategory).where(inArray(storeProductCategory.id, associations.categoryIds))
      : [];
    const categoryParent = new Map(categoryRows.map((item) => [item.id, item.pid]));
    await tx.delete(storeProductRelation).where(and(
      eq(storeProductRelation.productId, productId),
      inArray(storeProductRelation.type, [...MANAGED_RELATIONS]),
    ));
    const rows = [
      ...associations.categoryIds.map((relationId) => ({
        type: CATEGORY_RELATION, productId, relationId,
        relationPid: categoryParent.get(relationId) ?? 0, status: isShow, addTime: now,
      })),
      ...associations.brandIds.map((relationId) => ({
        type: BRAND_RELATION, productId, relationId, relationPid: 0, status: 1, addTime: now,
      })),
      ...associations.productLabelIds.map((relationId) => ({
        type: PRODUCT_LABEL_RELATION, productId, relationId, relationPid: 0, status: 1, addTime: now,
      })),
      ...associations.ensureIds.map((relationId) => ({
        type: ENSURE_RELATION, productId, relationId, relationPid: 0, status: 1, addTime: now,
      })),
      ...(associations.parameterTemplateId > 0 ? [{
        type: PARAMETER_RELATION, productId, relationId: associations.parameterTemplateId,
        relationPid: 0, status: 1, addTime: now,
      }] : []),
    ];
    if (rows.length) await tx.insert(storeProductRelation).values(rows);
  }

  private async assertAssociationReadback(
    tx: DbClient,
    productId: number,
    expected: ProductAssociations,
  ): Promise<void> {
    const [products, relations] = await Promise.all([
      tx.select({
        cateId: storeProduct.cateId,
        brandId: storeProduct.brandId,
        brandCom: storeProduct.brandCom,
        storeLabelId: storeProduct.storeLabelId,
        ensureId: storeProduct.ensureId,
        specsId: storeProduct.specsId,
        specs: storeProduct.specs,
      }).from(storeProduct).where(eq(storeProduct.id, productId)).limit(1),
      tx.select({ type: storeProductRelation.type, relationId: storeProductRelation.relationId })
        .from(storeProductRelation).where(and(
          eq(storeProductRelation.productId, productId),
          inArray(storeProductRelation.type, [...MANAGED_RELATIONS]),
        )),
    ]);
    const verified = productAssociationReadbackMatches(products[0], relations, expected);
    if (!verified) throw new Error("商品关联资料数据库回读校验失败");
  }
}
