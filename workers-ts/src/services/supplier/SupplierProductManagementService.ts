import { normalizeProductVideoReference, assertProductVideoReference, resolveProductVideoReference } from '@/services/product/ProductVideoPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import {
  and,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { lockShippingTemplateBindings } from '../product/ShippingTemplateLifecycleService';
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from '@/services/activity/BargainSourceProductLifecycle';
import {
  storeCart,
  systemAttachment,
  storeProduct,
  storeProductAttrValue,
  storeProductDescription,
  storeProductRelation,
  storeProductStockRecord,
} from "@/models/schema";
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from "@/services/product/ProductSkuIdentity";
import {
  normalizeSupplierProductDimensions,
  normalizeSupplierProductSkus,
  type PhysicalProductNormalizationOptions,
  type SupplierProductDimension,
  type SupplierProductSku,
} from "@/services/product/ProductSkuInput";
import {
  DEFAULT_SECOND_CARD_CONFIGURATION,
  loadProductSkuEditor,
  replaceProductSkuEditor,
} from "@/services/product/ProductSkuEditorService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import type { Env } from '@/env';
import { lockSupplierProductMedia, normalizeSupplierProductMediaReference, prepareSupplierProductMediaInput, projectSupplierProductMedia,
  supplierProductEditingHtml, supplierProductEditingMediaReference } from './SupplierProductMediaService';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { SupplierProductCategoryService, lockSupplierCategoryScope, assertSupplierProductCategoryBindings,
  type SupplierCategoryActor } from './SupplierProductCategoryService';
import { assertSupplierProductLabelBindings, replaceSupplierProductLabelBindings, supplierProductLabelInput } from './SupplierProductLabelBindings';
import { SupplierProductLabelService, type SupplierProductLabelActor } from './SupplierProductLabelService';
import { tryLockProductWrite } from '@/services/product/ProductAssociationService';
import { lockProductUnitLifecycle } from '@/services/product/ProductUnitLifecycle';
import { HttpApiException } from '@/utils/errors';
import { supplierProductScheduleInput, type SupplierProductScheduleInput } from './SupplierProductScheduleInput';
import { supplierProductBrandInput, lockSupplierProductBrandPath, readSupplierBrandProtectedRelations,
  readSupplierProductBrandSelection, replaceSupplierProductBrandBindings } from './SupplierProductBrandBindings';
import { supplierProductEnsureInput, lockSupplierProductEnsures, readSupplierEnsureProtectedRelations,
  readSupplierProductEnsureSelection, replaceSupplierProductEnsureBindings } from './SupplierProductEnsureBindings';
import { supplierProductSystemFormInput, lockSupplierProductSystemForm, readSupplierProductSystemFormSelection, replaceSupplierProductSystemFormBinding } from './SupplierProductSystemFormBindings';
import { supplierProductParameterInput, lockSupplierProductParameterTemplate, assertSupplierProductParameterTemplate, readSupplierParameterProtectedRelations,
  readSupplierProductParameterSelection, replaceSupplierProductParameterBindings } from './SupplierProductParameterBindings';

export {
  buildSkuCombinations,
  normalizeSupplierProductDimensions,
  normalizeSupplierProductSkus,
} from "@/services/product/ProductSkuInput";
export type {
  PhysicalProductNormalizationOptions,
  SupplierProductDimension,
  SupplierProductSku,
} from "@/services/product/ProductSkuInput";

const SUPPLIER_TYPE = 2;
const PHYSICAL_PRODUCT_TYPE = 0;
const CARD_PRODUCT_TYPE = 1;
const MANUAL_VIRTUAL_PRODUCT_TYPE = 3;
const PRODUCT_ATTR_TYPE = 0;
const CATEGORY_RELATION_TYPE = 1;
const PRODUCT_LOCK_NAMESPACE = PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE;
const MAX_SKUS = 200;

type UnknownRecord = Record<string, unknown>;

export interface SupplierProductInput extends SupplierProductScheduleInput {
  productType: 0 | 1 | 3;
  storeName: string;
  storeInfo: string;
  keyword: string;
  unitName: string;
  barCode: string;
  cateIds: number[];
  sliderImages: string[];
  description: string;
  specType: 0 | 1;
  dimensions: SupplierProductDimension[];
  skus: SupplierProductSku[];
  freight: 1 | 2 | 3;
  postage: string;
  tempId: number;
  isPostage: number;
  isSupportRefund: number;
  isLimit: number;
  limitType: number;
  limitNum: number;
  sort: number;
  ficti: number;
  videoLink: string;
}

export type SupplierPhysicalProductInput = SupplierProductInput;

export interface SupplierStockAdjustment {
  unique: string;
  pm: 0 | 1;
  stock: number;
}

function asRecord(value: unknown, message = "参数格式错误"): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(message);
  }
  return value as UnknownRecord;
}

function firstValue(input: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined) return input[key];
  }
  return undefined;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new ValidateException(`请填写${field}`);
  const normalized = value.trim();
  if (!normalized) throw new ValidateException(`请填写${field}`);
  if (normalized.length > maxLength) throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidateException(`${field}格式错误`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ValidateException(`${field}不能超过${maxLength}个字符`);
  return normalized;
}

/** Absence is not an instruction to restore an earlier editing snapshot. */
function supplierProductRecommendImageInput(input: UnknownRecord): string | undefined {
  if (!Object.hasOwn(input, 'recommend_image') || input.recommend_image === undefined) return undefined;
  if (typeof input.recommend_image !== 'string') throw new ValidateException('商品推荐图格式错误');
  const reference = normalizeSupplierProductMediaReference(input.recommend_image);
  if (reference.length > 256) throw new ValidateException('商品推荐图不能超过256个字符');
  return reference;
}

const recommendationConflict = () => new HttpApiException('商品推荐图或素材已变化，请刷新后重试', 409, 409);
const sameRecommendationState = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Reuse the existing private-image row lock and public consumer authority.
 * The full metadata snapshot also detects same-transaction trigger rewrites. */
async function lockSupplierRecommendImage(db: DbClient, supplierId: number, reference: string) {
  await lockSupplierProductMedia(db, supplierId, { sliderImages: [reference], skus: [], description: '' });
  const id = parseCanonicalAttachmentId(reference);
  if (id === null) return undefined;
  const [eligible] = await publicProductPictures(db, [{ image: reference, type: SUPPLIER_TYPE, relationId: supplierId }]);
  if (eligible !== reference) throw new ValidateException('商品推荐图素材不可用，请重新选择');
  return (await db.select().from(systemAttachment).where(eq(systemAttachment.attId, id)).limit(1))[0];
}

/** Invalid historical public values may be retained unchanged while an editor
 * repairs other fields. Admission below still rejects every new invalid value. */
function editingVideoInput(value: unknown): string {
  try { return normalizeProductVideoReference(value, { allowLegacyRelative: true }); }
  catch { return optionalString(value, '视频地址', 500); }
}

function editingDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new ValidateException('商品详情格式错误');
  if (value.length > 200_000) throw new ValidateException('商品详情不能超过200000个字符');
  return value;
}

function integerValue(
  value: unknown,
  field: string,
  defaultValue = 0,
  max = 2_147_483_647,
): number {
  if (value === undefined || value === null || value === "") return defaultValue;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ValidateException(`${field}必须是非负整数`);
  }
  return parsed;
}

function flagValue(value: unknown, field: string, defaultValue: number): number {
  const parsed = integerValue(value, field, defaultValue, 1);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException(`${field}格式错误`);
  return parsed;
}

function decimalString(value: unknown, field: string, positive = false): string {
  if (value === undefined || value === null || value === "") value = "0";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${field}格式错误`);
  }
  const raw = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw)) {
    throw new ValidateException(`${field}必须是最多两位小数的非负金额`);
  }
  const [whole, fraction = ""] = raw.split(".");
  const normalized = `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
  if (positive && moneyCents(normalized) <= 0n) throw new ValidateException(`${field}必须大于0`);
  return normalized;
}

function moneyCents(value: string): bigint {
  const [whole, fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function normalizeStringArray(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  let values: unknown[];
  if (Array.isArray(value)) {
    values = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) values = [];
    else if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        values = Array.isArray(parsed) ? parsed : [];
      } catch {
        throw new ValidateException(`${field}格式错误`);
      }
    } else {
      values = trimmed.split(",");
    }
  } else {
    values = [];
  }
  const result = values.map((item) => requiredString(item, field, maxLength));
  if (result.length > maxItems) throw new ValidateException(`${field}不能超过${maxItems}项`);
  if (new Set(result).size !== result.length) throw new ValidateException(`${field}不能重复`);
  return result;
}

function normalizeCategoryIds(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const ids = raw.map((item) => integerValue(item, "商品分类", 0));
  if (ids.length === 0 || ids.some((id) => id <= 0)) throw new ValidateException("请选择商品分类");
  if (ids.length > 20) throw new ValidateException("商品分类不能超过20项");
  return [...new Set(ids)];
}

export function normalizeSupplierProductInput(
  input: UnknownRecord,
  options: PhysicalProductNormalizationOptions = {},
): SupplierProductInput {
  const productTypeValue = integerValue(firstValue(input, "product_type", "productType"), "商品类型", 0, 4);
  if (![PHYSICAL_PRODUCT_TYPE, CARD_PRODUCT_TYPE, MANUAL_VIRTUAL_PRODUCT_TYPE].includes(productTypeValue)) {
    throw new ValidateException("当前迁移阶段仅支持实物、卡密/固定内容和手工虚拟商品，优惠券和次卡暂不可创建");
  }
  const productType = productTypeValue as 0 | 1 | 3;
  const specTypeValue = integerValue(firstValue(input, "spec_type", "specType"), "规格类型", 0, 1);
  if (specTypeValue !== 0 && specTypeValue !== 1) throw new ValidateException("规格类型错误");
  const specType = specTypeValue as 0 | 1;
  const dimensions =
    specType === 0
      ? [{ value: "规格", detail: ["默认"] }]
      : normalizeSupplierProductDimensions(input.items);
  const sliderImages = normalizeStringArray(
    firstValue(input, "slider_image", "sliderImages", "slider_images"),
    "轮播图",
    20,
    256,
  );
  if (sliderImages.length === 0) throw new ValidateException("请至少上传一张商品轮播图");
  const isLimit = flagValue(firstValue(input, "is_limit", "isLimit"), "限购状态", 0);
  const limitType = isLimit
    ? integerValue(firstValue(input, "limit_type", "limitType"), "限购类型", 1, 2)
    : 0;
  const limitNum = isLimit
    ? integerValue(firstValue(input, "limit_num", "limitNum"), "限购数量", 1)
    : 0;
  if (isLimit && ![1, 2].includes(limitType)) throw new ValidateException("限购类型错误");
  if (isLimit && limitNum <= 0) throw new ValidateException("限购数量必须大于0");

  let postage = "0.00";
  let tempId = 0;
  let freight: 1 | 2 | 3 = 2;
  if (productType === PHYSICAL_PRODUCT_TYPE) {
    postage = decimalString(input.postage, "运费");
    tempId = integerValue(firstValue(input, "temp_id", "tempId"), "运费模板");
    const freightValue = firstValue(input, "freight");
    const inferredFreight = tempId > 0 ? 3 : moneyCents(postage) > 0n ? 2 : 1;
    const freightValueNormalized = integerValue(freightValue, "运费设置", inferredFreight, 3);
    if (![1, 2, 3].includes(freightValueNormalized)) throw new ValidateException("运费设置格式错误");
    freight = freightValueNormalized as 1 | 2 | 3;
    if (freight === 1) {
      postage = "0.00";
      tempId = 0;
    } else if (freight === 2) {
      if (moneyCents(postage) <= 0n) throw new ValidateException("固定邮费必须大于0");
      tempId = 0;
    } else {
      if (tempId <= 0) throw new ValidateException("请选择运费模板");
      postage = "0.00";
    }
  }

  const skus = normalizeSupplierProductSkus(input.attrs, dimensions, specType, options);
  if (productType !== CARD_PRODUCT_TYPE && skus.some((sku) => sku.diskInfo)) {
    throw new ValidateException("只有卡密商品可以配置固定虚拟内容");
  }

  return {
    ...supplierProductScheduleInput(input),
    productType,
    storeName: requiredString(firstValue(input, "store_name", "storeName"), "商品名称", 256),
    storeInfo: optionalString(firstValue(input, "store_info", "storeInfo"), "商品简介", 256),
    keyword: optionalString(input.keyword, "关键词", 256),
    unitName: optionalString(firstValue(input, "unit_name", "unitName"), "单位", 32) || "件",
    barCode: optionalString(firstValue(input, "bar_code", "barCode"), "商品条码", 15),
    cateIds: normalizeCategoryIds(firstValue(input, "cate_id", "cateIds", "cate_ids")),
    sliderImages,
    description: editingDescription(input.description),
    specType,
    dimensions,
    skus,
    freight,
    postage,
    tempId,
    isPostage: flagValue(firstValue(input, "is_postage", "isPostage"), "包邮状态", 0),
    isSupportRefund: flagValue(
      firstValue(input, "is_support_refund", "isSupportRefund"),
      "退款支持状态",
      1,
    ),
    isLimit,
    limitType,
    limitNum,
    sort: integerValue(input.sort, "排序", 0, 1_000_000),
    ficti: integerValue(input.ficti, "虚拟销量", 0),
    videoLink: editingVideoInput(firstValue(input, "video_link", "videoLink")),
  };
}

/** Physical-only compatibility boundary used by the external Out API. */
export function normalizeSupplierPhysicalProductInput(
  input: UnknownRecord,
  options: PhysicalProductNormalizationOptions = {},
): SupplierProductInput {
  const normalized = normalizeSupplierProductInput(input, options);
  if (normalized.productType !== PHYSICAL_PRODUCT_TYPE) {
    throw new ValidateException("当前迁移阶段仅支持实物商品");
  }
  return normalized;
}

export function normalizeStockAdjustments(value: unknown): SupplierStockAdjustment[] {
  const body = value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(body?.attrs)
      ? body.attrs
      : Array.isArray(body?.stock)
        ? body.stock
        : [];
  if (rows.length === 0 || rows.length > MAX_SKUS) throw new ValidateException("请填写库存调整项");
  const adjustments = rows.map((item) => {
    const row = asRecord(item, "库存调整格式错误");
    const pmValue = integerValue(row.pm, "库存方向", 1, 1);
    if (pmValue !== 0 && pmValue !== 1) throw new ValidateException("库存方向错误");
    const stock = integerValue(firstValue(row, "stock", "number"), "库存数量", 0);
    if (stock <= 0) throw new ValidateException("库存调整数量必须大于0");
    return {
      unique: requiredString(row.unique, "SKU唯一标识", 32),
      pm: pmValue as 0 | 1,
      stock,
    };
  });
  if (new Set(adjustments.map((item) => item.unique)).size !== adjustments.length) {
    throw new ValidateException("同一个SKU不能重复调整");
  }
  return adjustments;
}

function minMoney(values: string[]): string {
  return values.reduce((minimum, value) => (moneyCents(value) < moneyCents(minimum) ? value : minimum));
}

export class SupplierProductManagementService {
  constructor(private readonly container: Container, private readonly env?: Pick<Env, 'APP_KEY'>) {}

  private tenantProductWhere(supplierId: number, productId: number) {
    return and(
      eq(storeProduct.id, productId),
      eq(storeProduct.type, SUPPLIER_TYPE),
      eq(storeProduct.relationId, supplierId),
      eq(storeProduct.isDel, 0),
    );
  }

  private async lockProduct(tx: DbClient, supplierId: number, productId: number) {
    const key = productId > 0 ? productId : supplierId;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_LOCK_NAMESPACE}, ${key})`);
  }

  async categoryTree(supplierId: number, includeHidden = true) {
    return new SupplierProductCategoryService(this.container).modernTree(supplierId, includeHidden);
  }

  async categoryDetail(supplierId: number, categoryId: number) {
    return new SupplierProductCategoryService(this.container).modernDetail(supplierId, categoryId);
  }

  async saveCategory(supplierId: number, categoryId: number, input: UnknownRecord, actor?: SupplierCategoryActor) {
    return new SupplierProductCategoryService(this.container).save(supplierId, categoryId, input, actor);
  }

  async deleteCategory(supplierId: number, categoryId: number, actor?: SupplierCategoryActor) {
    await new SupplierProductCategoryService(this.container).delete(supplierId, categoryId, undefined, actor);
  }

  async setCategoryShow(supplierId: number, categoryId: number, isShow: number, actor?: SupplierCategoryActor) {
    await new SupplierProductCategoryService(this.container).setShow(supplierId, categoryId, isShow, undefined, actor);
  }

  private async assertCategories(tx: DbClient, supplierId: number, cateIds: number[]) {
    return assertSupplierProductCategoryBindings(tx, supplierId, cateIds);
  }

  private async assertShippingTemplate(tx: DbClient, supplierId: number, input: SupplierProductInput) {
    if (input.productType !== PHYSICAL_PRODUCT_TYPE || input.freight !== 3) return;
    await lockShippingTemplateBindings(tx, [{ tempId: input.tempId, freight: input.freight,
      ownerType: SUPPLIER_TYPE, relationId: supplierId }]);
  }

  async saveProduct(supplierId: number, productId: number, rawInput: UnknownRecord, actor?: SupplierProductLabelActor) {
    const input = normalizeSupplierProductInput(prepareSupplierProductMediaInput(rawInput));
    const labelIds = supplierProductLabelInput(rawInput);
    const brandIds = supplierProductBrandInput(rawInput);
    const ensureIds = supplierProductEnsureInput(rawInput);
    const parameters = supplierProductParameterInput(rawInput);
    const systemFormId = supplierProductSystemFormInput(rawInput);
    const recommendImage = supplierProductRecommendImageInput(rawInput);
    const hasSchedule = input.autoOnTime !== undefined || input.autoOffTime !== undefined;
    const labelAuthority = new SupplierProductLabelService(this.container);
    const labelPath = `/supplierapi/product/product/${productId}`;
    return withTx(this.container, async (tx) => {
      await lockProductUnitLifecycle(tx);
      // Category moves/deletes and Supplier product bindings serialize before
      // any product/SKU/bargain lock, so no stale parent or missing category can
      // be committed while classification management is changing the tree.
      await lockSupplierCategoryScope(tx, supplierId);
      if (labelIds !== undefined || hasSchedule || brandIds !== undefined || ensureIds !== undefined || parameters !== undefined || systemFormId !== undefined || recommendImage !== undefined) {
        await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
        await labelAuthority.assertBindingAuthority(tx, supplierId, actor!, labelPath);
        if (labelIds !== undefined) await assertSupplierProductLabelBindings(tx, supplierId, labelIds);
        if (brandIds !== undefined) await lockSupplierProductBrandPath(tx, brandIds);
      }
      if (productId > 0) {
        await boundBargainSourceProductChange(tx);
        await lockBargainSourceProductChange(tx, productId);
      }
      await this.lockProduct(tx, supplierId, productId);
      // Legacy schema only indexed SKU unique; serialize saves so new rows can be checked globally
      // without racing another supplier product save. Historical duplicates remain a migration audit item.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_LOCK_NAMESPACE}, 0)`);
      if ((labelIds !== undefined || hasSchedule || brandIds !== undefined || ensureIds !== undefined || parameters !== undefined || systemFormId !== undefined || recommendImage !== undefined) && productId > 0 && !await tryLockProductWrite(tx, productId)) {
        throw new HttpApiException('商品正在修改，请刷新后重试', 409, 409);
      }
      const existing = productId > 0
        ? (
            await tx
              .select()
              .from(storeProduct)
              .where(this.tenantProductWhere(supplierId, productId))
              .limit(1)
          )[0]
        : undefined;
      if (productId > 0 && !existing) throw new NotFoundException("商品不存在或不属于当前供应商");
      if (existing && ![
        PHYSICAL_PRODUCT_TYPE,
        CARD_PRODUCT_TYPE,
        MANUAL_VIRTUAL_PRODUCT_TYPE,
      ].includes(existing.productType)) {
        throw new ValidateException("当前迁移阶段不能编辑此履约类型的商品");
      }
      if (existing && existing.productType !== input.productType) {
        throw new ValidateException("商品创建后不能修改履约类型");
      }
      let protectedBrandRelations = brandIds !== undefined && existing && ensureIds === undefined && parameters === undefined
        ? await readSupplierBrandProtectedRelations(tx, productId, labelIds !== undefined) : [];
      const admittedEnsures = ensureIds === undefined ? [] : await lockSupplierProductEnsures(tx, supplierId, ensureIds, existing);
      let protectedEnsureRelations = ensureIds !== undefined && existing
        ? await readSupplierEnsureProtectedRelations(tx, productId, labelIds !== undefined) : [];
      const admittedForm = systemFormId === undefined ? undefined : await lockSupplierProductSystemForm(tx, systemFormId);
      const admittedParameter = parameters === undefined ? undefined : await lockSupplierProductParameterTemplate(tx, supplierId, parameters.specs_id);
      const protectedParameterRelations = parameters !== undefined && existing
        ? await readSupplierParameterProtectedRelations(tx, productId, labelIds !== undefined) : [];
      const categories = await this.assertCategories(tx, supplierId, input.cateIds);
      await this.assertShippingTemplate(tx, supplierId, input);
      await lockSupplierProductMedia(tx, supplierId, input);
      const admittedRecommendImage = recommendImage === undefined ? undefined : await lockSupplierRecommendImage(tx, supplierId, recommendImage);
      if (parseCanonicalAttachmentId(input.videoLink) !== null) {
        await tx.execute(sql`LOCK TABLE ONLY ${systemAttachment} IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      }
      // Existing legacy bytes do not grant asset authority. Canonical private
      // references are always revalidated, even when unchanged.
      if (!existing || existing.videoLink !== input.videoLink || parseCanonicalAttachmentId(input.videoLink) !== null)
        await assertProductVideoReference(tx, input.videoLink, { type: 2, relationId: supplierId }, { allowLegacyRelative: true });
      const stock = input.skus.reduce((sum, sku) => sum + sku.stock, 0);
      if (!Number.isSafeInteger(stock)) throw new ValidateException("商品总库存超出安全范围");
      const price = minMoney(input.skus.map((sku) => sku.price));
      const settlePrice = minMoney(input.skus.map((sku) => sku.settlePrice));
      const cost = minMoney(input.skus.map((sku) => sku.cost));
      const otPrice = minMoney(input.skus.map((sku) => sku.otPrice));
      const vipPrice = minMoney(input.skus.map((sku) => sku.vipPrice));
      const now = Math.floor(Date.now() / 1000);
      const productValues = {
        productType: input.productType,
        type: SUPPLIER_TYPE,
        relationId: supplierId,
        image: input.sliderImages[0],
        ...(recommendImage === undefined ? {} : { recommendImage }),
        sliderImage: JSON.stringify(input.sliderImages),
        storeName: input.storeName,
        storeInfo: input.storeInfo,
        keyword: input.keyword,
        barCode: input.barCode,
        cateId: input.cateIds.join(","),
        price,
        settlePrice,
        vipPrice,
        otPrice,
        deliveryType: input.productType === PHYSICAL_PRODUCT_TYPE ? "1" : "",
        freight: input.freight,
        postage: input.postage,
        tempId: input.tempId,
        unitName: input.unitName,
        sort: input.sort,
        ficti: input.ficti,
        stock,
        isShow: 0,
        isVerify: 0,
        ...(input.autoOnTime === undefined ? {} : { autoOnTime: input.autoOnTime }),
        ...(input.autoOffTime === undefined ? {} : { autoOffTime: input.autoOffTime }),
        isPostage: input.isPostage,
        cost,
        videoOpen: input.videoLink ? 1 : 0,
        videoLink: input.videoLink,
        specType: input.specType,
        isSupportRefund: input.isSupportRefund,
        isLimit: input.isLimit,
        limitType: input.limitType,
        limitNum: input.limitNum,
        isSold: stock > 0 ? 0 : 1,
      } as const;
      let savedProductId = productId;
      let recommendationMain: typeof storeProduct.$inferSelect | undefined;
      if (existing) {
        // Checkout claims carts before SKU and product stock. Disable carts
        // before either row write so a checkout-owned cart cannot form a cycle.
        await tx.update(storeCart).set({ status: 0 }).where(eq(storeCart.productId, productId));
        if (recommendImage === undefined) {
          await tx.update(storeProduct).set(productValues).where(eq(storeProduct.id, productId));
        } else {
          const rows = await tx.update(storeProduct).set(productValues).where(eq(storeProduct.id, productId)).returning();
          if (rows.length !== 1 || !sameRecommendationState(rows[0], { ...existing, ...productValues })) throw recommendationConflict();
        }
      } else {
        const rows = await tx
          .insert(storeProduct)
          .values({ ...productValues, addTime: now, isDel: 0 })
          .returning({ id: storeProduct.id });
        if (recommendImage !== undefined && rows.length !== 1) throw recommendationConflict();
        savedProductId = rows[0].id;
      }
      if (recommendImage !== undefined) {
        const [read] = await tx.select().from(storeProduct).where(eq(storeProduct.id, savedProductId)).limit(1);
        if (!read || read.isDel !== 0 || Object.entries(productValues).some(([key, value]) => read[key as keyof typeof productValues] !== value)
          || existing && !sameRecommendationState(read, { ...existing, ...productValues })) throw recommendationConflict();
        recommendationMain = read;
      }

      await tx.delete(storeProductRelation).where(
        and(
          eq(storeProductRelation.productId, savedProductId),
          eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
        ),
      );
      await tx.insert(storeProductRelation).values(
        categories.map((category) => ({
          type: CATEGORY_RELATION_TYPE,
          productId: savedProductId,
          relationId: category.id,
          relationPid: category.pid,
          status: 0,
          addTime: now,
        })),
      );
      await tx
        .insert(storeProductDescription)
        .values({ productId: savedProductId, description: input.description, type: PRODUCT_ATTR_TYPE })
        .onConflictDoUpdate({
          target: [storeProductDescription.productId, storeProductDescription.type],
          set: { description: input.description },
        });
      await replaceProductSkuEditor(tx, {
        id: savedProductId,
        productType: input.productType,
        image: input.sliderImages[0],
        type: SUPPLIER_TYPE,
        relationId: supplierId,
      }, {
        specType: input.specType,
        dimensions: input.dimensions,
        skus: input.skus.map((sku) => ({ ...sku, ...DEFAULT_SECOND_CARD_CONFIGURATION })),
      }, now);
      if (!existing) await tx.update(storeCart).set({ status: 0 }).where(eq(storeCart.productId, savedProductId));
      if (labelIds !== undefined) {
        await replaceSupplierProductLabelBindings(tx, supplierId, savedProductId, labelIds);
      }
      if (parameters !== undefined) {
        await replaceSupplierProductParameterBindings(tx, supplierId, savedProductId, parameters, admittedParameter, existing ? {
          ...existing, ...productValues, ...(labelIds === undefined ? {} : { storeLabelId: labelIds.join(',') }),
        } : undefined, protectedParameterRelations, labelIds !== undefined);
        if (ensureIds !== undefined) protectedEnsureRelations = await readSupplierEnsureProtectedRelations(tx, savedProductId, labelIds !== undefined);
        else if (brandIds !== undefined) protectedBrandRelations = await readSupplierBrandProtectedRelations(tx, savedProductId, labelIds !== undefined);
      }
      if (ensureIds !== undefined) {
        await replaceSupplierProductEnsureBindings(tx, supplierId, savedProductId, ensureIds, admittedEnsures, existing ? {
          ...existing, ...productValues, ...(labelIds === undefined ? {} : { storeLabelId: labelIds.join(',') }),
          ...(parameters === undefined ? {} : { specsId: parameters.specs_id, specs: parameters.specs.length ? JSON.stringify(parameters.specs) : '' }),
        } : undefined, protectedEnsureRelations, labelIds !== undefined);
        if (brandIds !== undefined) protectedBrandRelations = await readSupplierBrandProtectedRelations(tx, savedProductId, labelIds !== undefined);
      }
      if (brandIds !== undefined) {
        await replaceSupplierProductBrandBindings(tx, supplierId, savedProductId, brandIds, existing ? {
          ...existing, ...productValues, ...(labelIds === undefined ? {} : { storeLabelId: labelIds.join(',') }),
          ...(ensureIds === undefined ? {} : { ensureId: ensureIds.join(',') }),
          ...(parameters === undefined ? {} : { specsId: parameters.specs_id, specs: parameters.specs.length ? JSON.stringify(parameters.specs) : '' }),
        } : undefined, protectedBrandRelations, labelIds !== undefined);
      }
      if (systemFormId !== undefined) {
        await replaceSupplierProductSystemFormBinding(tx, supplierId, savedProductId, systemFormId, admittedForm, existing ? {
          ...existing, ...productValues, ...(labelIds === undefined ? {} : { storeLabelId: labelIds.join(',') }),
          ...(brandIds === undefined ? {} : { brandId: brandIds.at(-1) ?? 0, brandCom: brandIds.join(',') }),
          ...(ensureIds === undefined ? {} : { ensureId: ensureIds.join(',') }),
          ...(parameters === undefined ? {} : { specsId: parameters.specs_id, specs: parameters.specs.length ? JSON.stringify(parameters.specs) : '' }),
        } : undefined);
        // The final form-column UPDATE may execute same-transaction triggers
        // after the earlier assurance/brand authors finished their own checks.
        // Reuse their row locks and admission rules without rewriting bindings.
        try {
          if (ensureIds !== undefined) {
            // Relations now describe the newly authored set. Use that current
            // CSV to retain legitimate old disabled items, then compare every
            // actual catalog row to its original admission snapshot. A newly
            // disabled/moved item cannot acquire retention authority this way.
            const currentEnsures = await lockSupplierProductEnsures(tx, supplierId, ensureIds,
              existing ? { ...existing, ensureId: ensureIds.join(',') } : undefined);
            if (JSON.stringify(currentEnsures) !== JSON.stringify(admittedEnsures)) {
              throw new HttpApiException('商品留言或关联目录已变化，请刷新后重试', 409, 409);
            }
          }
          if (brandIds !== undefined) await lockSupplierProductBrandPath(tx, brandIds);
        } catch (error) {
          if (error instanceof ValidateException) throw new HttpApiException('商品留言或关联目录已变化，请刷新后重试', 409, 409);
          throw error;
        }
      }
      if (parameters !== undefined) await assertSupplierProductParameterTemplate(tx, parameters.specs_id, admittedParameter);
      if (labelIds !== undefined || hasSchedule || brandIds !== undefined || ensureIds !== undefined || parameters !== undefined || systemFormId !== undefined || recommendImage !== undefined) await labelAuthority.assertBindingAuthority(tx, supplierId, actor!, labelPath);
      if (hasSchedule) {
        const [read] = await tx.select({ id: storeProduct.id, type: storeProduct.type, relationId: storeProduct.relationId,
          isDel: storeProduct.isDel, isShow: storeProduct.isShow, isVerify: storeProduct.isVerify,
          autoOnTime: storeProduct.autoOnTime, autoOffTime: storeProduct.autoOffTime }).from(storeProduct)
          .where(eq(storeProduct.id, savedProductId)).limit(1);
        if (!read || read.type !== SUPPLIER_TYPE || read.relationId !== supplierId || read.isDel !== 0
          || read.isShow !== 0 || read.isVerify !== 0
          || input.autoOnTime !== undefined && read.autoOnTime !== input.autoOnTime
          || input.autoOffTime !== undefined && read.autoOffTime !== input.autoOffTime) {
          throw new HttpApiException('定时计划保存核对失败，请刷新后重试', 409, 409);
        }
      }
      if (recommendImage !== undefined) {
        // Settle triggers only after every requested author has finished. The
        // expected row includes their approved columns, not a stale GET value.
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        const expected = { ...recommendationMain,
          ...(labelIds === undefined ? {} : { storeLabelId: labelIds.join(',') }),
          ...(brandIds === undefined ? {} : { brandId: brandIds.at(-1) ?? 0, brandCom: brandIds.join(',') }),
          ...(ensureIds === undefined ? {} : { ensureId: ensureIds.join(',') }),
          ...(parameters === undefined ? {} : { specsId: parameters.specs_id, specs: parameters.specs.length ? JSON.stringify(parameters.specs) : '' }),
          ...(systemFormId === undefined ? {} : { systemFormId }),
        };
        const [actual] = await tx.select().from(storeProduct).where(eq(storeProduct.id, savedProductId)).limit(1);
        if (!sameRecommendationState(actual, expected)) throw recommendationConflict();
        try {
          if (!sameRecommendationState(await lockSupplierRecommendImage(tx, supplierId, recommendImage), admittedRecommendImage)) throw recommendationConflict();
        } catch (error) { if (error instanceof ValidateException) throw recommendationConflict(); throw error; }
        await labelAuthority.assertBindingAuthority(tx, supplierId, actor!, labelPath);
      }
      return { id: savedProductId, is_verify: 0, is_show: 0 };
    }).catch((error: unknown) => {
      if (hasSchedule || brandIds !== undefined || ensureIds !== undefined || parameters !== undefined || systemFormId !== undefined || recommendImage !== undefined) {
        let cause = error;
        for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
          if ('code' in cause && ['55P03', '40P01', '40001'].includes(String(cause.code))) {
            throw new HttpApiException('商品计划或权限正在修改，请刷新后重试', 409, 409);
          }
          cause = 'cause' in cause ? cause.cause : undefined;
        }
      }
      throw error;
    });
  }

  async productDetail(supplierId: number, productId: number) {
    const product = (
      await this.container.db
        .select()
        .from(storeProduct)
        .where(this.tenantProductWhere(supplierId, productId))
        .limit(1)
    )[0];
    if (!product) throw new NotFoundException("商品不存在或不属于当前供应商");
    const [relations, descriptions, skuEditor] = await Promise.all([
      this.container.db
        .select({ relation_id: storeProductRelation.relationId })
        .from(storeProductRelation)
        .where(
          and(
            eq(storeProductRelation.productId, productId),
            eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
          ),
        ),
      this.container.db
        .select({ description: storeProductDescription.description })
        .from(storeProductDescription)
        .where(
          and(
            eq(storeProductDescription.productId, productId),
            eq(storeProductDescription.type, PHYSICAL_PRODUCT_TYPE),
          ),
        )
        .limit(1),
      loadProductSkuEditor(this.container.db, productId, product.specType),
    ]);
    const detail = {
      id: product.id,
      product_type: product.productType,
      store_name: product.storeName,
      store_info: product.storeInfo,
      keyword: product.keyword,
      unit_name: product.unitName,
      bar_code: product.barCode,
      recommend_image: supplierProductEditingMediaReference(product.recommendImage),
      cate_id: relations.map((relation) => relation.relation_id),
      store_label_id: product.storeLabelId,
      slider_image: (() => {
        try {
          const parsed: unknown = JSON.parse(product.sliderImage);
          return Array.isArray(parsed) ? parsed.map(value => typeof value === 'string' ? supplierProductEditingMediaReference(value) : value) : [];
        } catch {
          return [];
        }
      })(),
      description: supplierProductEditingHtml(descriptions[0]?.description ?? ""),
      ...skuEditor,
      attrs: skuEditor.attrs.map(row => ({ ...row, image: supplierProductEditingMediaReference(row.image) })),
      retired_attrs: skuEditor.retired_attrs.map(row => ({ ...row, image: supplierProductEditingMediaReference(row.image) })),
      freight: product.freight,
      postage: product.postage,
      temp_id: product.tempId,
      is_postage: product.isPostage,
      is_support_refund: product.isSupportRefund,
      is_limit: product.isLimit,
      limit_type: product.limitType,
      limit_num: product.limitNum,
      sort: product.sort,
      ficti: product.ficti,
      video_link: supplierProductEditingMediaReference(product.videoLink),
      is_show: product.isShow,
      is_verify: product.isVerify,
      auto_on_time: product.autoOnTime,
      auto_off_time: product.autoOffTime,
      refusal: product.refusal,
    };
    const media = await projectSupplierProductMedia(this.container.db, supplierId, {
      sliderImages: [...detail.slider_image, detail.recommend_image], skus: [...detail.attrs, ...detail.retired_attrs], description: detail.description,
    }, this.env?.APP_KEY);
    if (detail.recommend_image && parseCanonicalAttachmentId(detail.recommend_image) !== null) {
      const [eligible] = await publicProductPictures(this.container.db, [{ image: detail.recommend_image, type: SUPPLIER_TYPE, relationId: supplierId }]);
      if (eligible !== detail.recommend_image) {
        media.previews[detail.recommend_image] = { status: 'unavailable', expires_at: null };
        media.status = 'partial';
      }
    }
    const video = await resolveProductVideoReference(this.container.db, detail.video_link, { type: 2, relationId: supplierId }, { allowLegacyRelative: true });
    const videoPreview = video && parseCanonicalAttachmentId(video) !== null
      ? this.env?.APP_KEY ? (await signAttachmentReferences(this.env.APP_KEY, [video]))[0] : '' : video;
    const brand = await readSupplierProductBrandSelection(this.container.db, product);
    const ensures = await readSupplierProductEnsureSelection(this.container.db, supplierId, product);
    const parameters = await readSupplierProductParameterSelection(this.container.db, supplierId, product);
    const systemForm = await readSupplierProductSystemFormSelection(this.container.db, product);
    return { ...detail, ...brand, ...ensures, ...parameters, ...systemForm, media, video_preview_url: videoPreview };
  }

  async recycleProduct(supplierId: number, productId: number) {
    await withTx(this.container, async (tx) => {
      // Retire every bargain admission on this source before changing the
      // product row. Cancellation/refund remain independent of this boundary.
      await boundBargainSourceProductChange(tx);
      await lockBargainSourceProductChange(tx, productId);
      await this.lockProduct(tx, supplierId, productId);
      const [owned] = await tx.select({ id: storeProduct.id }).from(storeProduct)
        .where(this.tenantProductWhere(supplierId, productId)).limit(1);
      if (!owned) throw new NotFoundException("商品不存在或不属于当前供应商");
      // Checkout claims cart rows before its final product inventory write.
      // Disable carts first so recycling cannot hold the product row while
      // waiting for a checkout-owned cart row.
      await tx.update(storeCart).set({ status: 0 }).where(eq(storeCart.productId, productId));
      const rows = await tx
        .update(storeProduct)
        .set({ isDel: 1, isShow: 0 })
        .where(this.tenantProductWhere(supplierId, productId))
        .returning({ id: storeProduct.id });
      if (!rows[0]) throw new NotFoundException("商品不存在或不属于当前供应商");
      await tx
        .update(storeProductRelation)
        .set({ status: 0 })
        .where(eq(storeProductRelation.productId, productId));
    });
  }

  async setProductShow(supplierId: number, productId: number, isShow: number) {
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("商品状态错误");
    await withTx(this.container, async (tx) => {
      // A source hide must serialize with every bargain start/help before the
      // product is read or changed, including when another activity shares it.
      await boundBargainSourceProductChange(tx);
      await lockBargainSourceProductChange(tx, productId);
      await this.lockProduct(tx, supplierId, productId);
      const product = (
        await tx
          .select({ id: storeProduct.id, isVerify: storeProduct.isVerify, price: storeProduct.price })
          .from(storeProduct)
          .where(this.tenantProductWhere(supplierId, productId))
          .limit(1)
      )[0];
      if (!product) throw new NotFoundException("商品不存在或不属于当前供应商");
      if (isShow === 1 && product.isVerify !== 1) throw new ValidateException("商品尚未审核通过，不能上架");
      if (isShow === 1 && moneyCents(product.price) <= 0n) throw new ValidateException("商品价格必须大于0才能上架");
      // A checkout owns its cart before its final product row update.
      await tx.update(storeCart).set({ status: isShow }).where(eq(storeCart.productId, productId));
      await tx.update(storeProduct).set({ isShow }).where(eq(storeProduct.id, productId));
      await tx
        .update(storeProductRelation)
        .set({ status: isShow })
        .where(eq(storeProductRelation.productId, productId));
    });
  }

  async batchSetProductShow(supplierId: number, productIds: number[], isShow: number) {
    const ids = [...new Set(productIds)];
    if (ids.length === 0 || ids.length > 200) throw new ValidateException("请选择1至200个商品");
    if (isShow !== 0 && isShow !== 1) throw new ValidateException("商品状态错误");
    let updated = 0;
    const skipped: number[] = [];
    for (const productId of ids) {
      try {
        await this.setProductShow(supplierId, productId, isShow);
        updated += 1;
      } catch (error) {
        if (error instanceof ValidateException || error instanceof NotFoundException) skipped.push(productId);
        else throw error;
      }
    }
    return { updated, skipped, skipped_count: skipped.length };
  }

  async adjustStock(supplierId: number, productId: number, raw: unknown) {
    const adjustments = normalizeStockAdjustments(raw);
    return withTx(this.container, async (tx) => {
      await this.lockProduct(tx, supplierId, productId);
      const product = (
        await tx
          .select({ id: storeProduct.id, productType: storeProduct.productType })
          .from(storeProduct)
          .where(this.tenantProductWhere(supplierId, productId))
          .limit(1)
      )[0];
      if (!product) throw new NotFoundException("商品不存在或不属于当前供应商");
      if (![PHYSICAL_PRODUCT_TYPE, CARD_PRODUCT_TYPE, MANUAL_VIRTUAL_PRODUCT_TYPE].includes(product.productType)) {
        throw new ValidateException("当前商品履约类型不支持普通库存调整");
      }
      const uniques = adjustments.map((item) => item.unique);
      const skus = await tx
        .select()
        .from(storeProductAttrValue)
        .where(
          and(
            eq(storeProductAttrValue.productId, productId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
            eq(storeProductAttrValue.isRetired, 0),
            inArray(storeProductAttrValue.unique, uniques),
          ),
        );
      if (skus.length !== uniques.length) throw new ValidateException("部分SKU不存在或不属于当前商品");
      const byUnique = new Map(skus.map((sku) => [sku.unique, sku]));
      const now = Math.floor(Date.now() / 1000);
      for (const adjustment of adjustments) {
        const sku = byUnique.get(adjustment.unique);
        if (!sku) throw new ValidateException("SKU不存在");
        if (product.productType === CARD_PRODUCT_TYPE && !sku.diskInfo?.trim()) {
          throw new ValidateException(`SKU ${sku.suk} 的库存由未分配卡密数量维护，请使用卡密库存导入`);
        }
        if (adjustment.pm === 0 && sku.stock < adjustment.stock) {
          throw new ValidateException(`SKU ${sku.suk} 库存不足，不能扣减`);
        }
        const nextStock = adjustment.pm === 1 ? sku.stock + adjustment.stock : sku.stock - adjustment.stock;
        if (!Number.isSafeInteger(nextStock)) throw new ValidateException("库存超出安全范围");
        await tx
          .update(storeProductAttrValue)
          .set({
            stock: nextStock,
            sumStock: adjustment.pm === 1 ? sku.sumStock + adjustment.stock : sku.sumStock,
          })
          .where(eq(storeProductAttrValue.id, sku.id));
        await tx.insert(storeProductStockRecord).values({
          storeId: supplierId,
          productId,
          unique: sku.unique,
          costPrice: sku.cost,
          number: adjustment.stock,
          pm: adjustment.pm,
          addTime: now,
        });
      }
      const totals = await tx
        .select({ stock: sql<number>`COALESCE(SUM(${storeProductAttrValue.stock}), 0)::int` })
        .from(storeProductAttrValue)
        .where(
          and(
            eq(storeProductAttrValue.productId, productId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
          ),
        );
      const stock = totals[0]?.stock ?? 0;
      await tx.update(storeProduct).set({ stock, isSold: stock > 0 ? 0 : 1 }).where(eq(storeProduct.id, productId));
      return { stock };
    });
  }
}
