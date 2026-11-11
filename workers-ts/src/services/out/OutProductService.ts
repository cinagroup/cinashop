import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { boundBargainSourceProductChange, lockBargainSourceProductChange } from "@/services/activity/BargainSourceProductLifecycle";
import { lockShippingTemplateBindings } from '../product/ShippingTemplateLifecycleService';
import {
  outProductWriteReplay,
  storeCart,
  storeProduct,
  storeProductAttr,
  storeProductAttrResult,
  storeProductAttrValue,
  storeProductCategory,
  storeProductDescription,
  storeProductRelation,
  storeProductStockRecord,
} from "@/models/schema";
import {
  normalizeSupplierPhysicalProductInput,
  type SupplierPhysicalProductInput,
  type SupplierProductSku,
} from "@/services/supplier/SupplierProductManagementService";
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE } from "@/services/product/ProductSkuIdentity";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { normalizeOutRequestKey, outRequestHash } from "@/services/out/OutIdempotency";
import { supplierProductBrandInput, lockSupplierProductBrandPath } from '@/services/supplier/SupplierProductBrandBindings';
import { assertOutProductBrandBindings, replaceOutProductBrandBindings } from './OutProductBrandBindings';
import { supplierProductEnsureInput } from '@/services/supplier/SupplierProductEnsureBindings';
import { assertOutProductEnsureBindings, lockOutProductEnsures, replaceOutProductEnsureBindings } from './OutProductEnsureBindings';
import { captureOutProductRelationFence, assertOutProductRelationFence } from './OutProductRelationFence';
import { readOutProductDetail } from './OutProductDetailRead';
import { outProductLabelInput, lockOutProductLabels, replaceOutProductLabelBindings, assertOutProductLabelBindings } from './OutProductLabelBindings';
import { outProductParameterInput, lockOutProductParameterTemplate, replaceOutProductParameterBindings, assertOutProductParameterBindings } from './OutProductParameterBindings';
import { outProductCouponInput, captureOutProductCoupons, replaceOutProductCoupons, assertOutProductCoupons } from './OutProductCouponBindings';
import { outProductCustomFormInput, outProductSystemFormInput, lockOutProductSystemForm, outProductFormProof, assertOutProductForm } from './OutProductFormBindings';
import { outProductScheduleInput, outProductScheduleProof, assertOutProductSchedule } from './OutProductScheduleBindings';
import { outProductPresaleInput, outProductPresalePlan, assertOutProductPresale, assertOutProductPresaleFuture,
  type OutProductPresaleInput } from './OutProductPresaleBindings';

type UnknownRecord = Record<string, unknown>;
type ProductWriteOperation = "product_create" | "product_update" | "product_show" | "stock_upload";

const PLATFORM_TYPE = 0;
const PLATFORM_RELATION_ID = 0;
const PHYSICAL_PRODUCT_TYPE = 0;
const PRODUCT_ATTR_TYPE = 0;
const CATEGORY_RELATION_TYPE = 1;
const REPLAY_LOCK_NAMESPACE = 744_220_001;
const PRODUCT_SAVE_LOCK_NAMESPACE = PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE;
const MAX_STOCK_UPLOAD_ITEMS = 100;

interface OutAccountIdentity {
  id: number;
}

interface OutPhysicalProductInput extends SupplierPhysicalProductInput, OutProductPresaleInput {
  brandIds?: number[];
  ensureIds?: number[];
  storeLabelIds?: number[];
  userLabelIds?: number[];
  parameters?: NonNullable<ReturnType<typeof outProductParameterInput>>;
  couponIds?: number[];
  customForm?: string;
  systemFormId?: number;
  autoOnTime?: number;
  autoOffTime?: number;
  scheduleIntentVersion?: 1;
  activity?: string;
  recommendList?: string;
  isVipProduct?: 0 | 1;
  deliveryType: string;
  freight: 1 | 2 | 3;
  isShow: 0 | 1;
  sales: number;
  giveIntegral: string;
  recommendImage: string;
  sourceLink: string;
  code: string;
  isHot: 0 | 1;
  isBenefit: 0 | 1;
  isBest: 0 | 1;
  isNew: 0 | 1;
  isGood: 0 | 1;
}

interface StockUploadItem {
  barCode: string;
  quantity: number;
}

function strictInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum = 0,
  maximum = 2_147_483_647,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException(`${field}必须是整数`);
  }
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) throw new ValidateException(`${field}必须是整数`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${field}超出允许范围`);
  }
  return parsed;
}

function flag(value: unknown, field: string, fallback: 0 | 1): 0 | 1 {
  const parsed = strictInteger(value, field, fallback, 0, 1);
  if (parsed !== 0 && parsed !== 1) throw new ValidateException(`${field}格式错误`);
  return parsed as 0 | 1;
}

function decimal(value: unknown, field: string): string {
  if (value === undefined || value === null || value === "") return "0.00";
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidateException(`${field}格式错误`);
  }
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) {
    throw new ValidateException(`${field}必须是最多两位小数的非负金额`);
  }
  const [whole, fraction = ""] = text.split(".");
  return `${BigInt(whole).toString()}.${fraction.padEnd(2, "0")}`;
}

function moneyCents(value: string): bigint {
  const [whole, fraction = "00"] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function safeText(value: unknown, field: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidateException(`${field}格式错误`);
  const normalized = value.trim();
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ValidateException(`${field}格式错误`);
  }
  return normalized;
}

function safeAsset(value: unknown, field: string, maximum: number): string {
  const normalized = safeText(value, field, maximum);
  if (!normalized) return "";
  if (normalized.includes("\\")) throw new ValidateException(`${field}格式错误`);
  if (normalized.startsWith("/") && !normalized.startsWith("//") && !normalized.includes("\\")) {
    return normalized;
  }
  try {
    const url = new URL(normalized);
    if (url.protocol === "https:" && !url.username && !url.password) return normalized;
  } catch {
    // The common validation error below intentionally hides parser details.
  }
  throw new ValidateException(`${field}必须是HTTPS地址或站内绝对路径`);
}

function nonEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === 0 || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as UnknownRecord).length > 0;
  return true;
}

function validateOutProductScope(input: UnknownRecord): void {
  // PHP explicitly unsets this old editor echo; recommendation flags are
  // independent fields, and this array does not author them.
  if (nonEmpty(input.recommend) && (!Array.isArray(input.recommend) || input.recommend.length > 100)) {
    throw new ValidateException('商品推荐回显格式错误');
  }
  const supplierId = strictInteger(input.supplier_id, "供应商ID", 0);
  if (supplierId !== 0) throw new ValidateException("Out API 商品写入只允许平台作用域");
}

function recommendationInput(input: UnknownRecord): string | undefined {
  if (!Object.hasOwn(input, 'recommend_list') || input.recommend_list === undefined) return undefined;
  if (!Array.isArray(input.recommend_list) || input.recommend_list.length > 100) {
    throw new ValidateException('推荐商品列表格式错误');
  }
  const ids = input.recommend_list.map(value => {
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value).trim())) {
      throw new ValidateException('推荐商品ID格式错误');
    }
    const id = Number(String(value).trim());
    if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw new ValidateException('推荐商品ID超出允许范围');
    return id;
  });
  const encoded = ids.join(',');
  if (encoded.length > 256) throw new ValidateException('推荐商品列表超过存储长度');
  return encoded;
}

function activityInput(input: UnknownRecord): string | undefined {
  if (!Object.hasOwn(input, 'activity') || input.activity === undefined) return undefined;
  if (!Array.isArray(input.activity) || input.activity.length > 4) {
    throw new ValidateException('活动顺序格式错误');
  }
  const values = input.activity.map(value => {
    if (typeof value !== 'string' || value.length > 32 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new ValidateException('活动顺序格式错误');
    }
    return value === '秒杀' ? 1 : value === '砍价' ? 2 : value === '拼团' ? 3 : 0;
  });
  if (new Set(values).size !== values.length) throw new ValidateException('活动顺序不能重复');
  return values.join(',');
}

function deliveryTypes(value: unknown): string {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = [...new Set(rows.map((item) => strictInteger(item, "配送方式", 0, 1, 3)))];
  if (normalized.length === 0) throw new ValidateException("请选择商品配送方式");
  return normalized.sort((left, right) => left - right).join(",");
}

export function normalizeOutPhysicalProductInput(input: UnknownRecord): OutPhysicalProductInput {
  validateOutProductScope(input);
  const schedule = outProductScheduleInput(input);
  const activity = activityInput(input);
  const recommendList = recommendationInput(input);
  const presale = outProductPresaleInput(input);
  const vipProduct = Object.hasOwn(input, 'is_vip_product') && input.is_vip_product !== undefined
    ? flag(input.is_vip_product === false ? 0 : input.is_vip_product === true ? 1 : input.is_vip_product, '会员专属开关', 0)
    : undefined;
  // The former shared adapter included explicit empty timestamps in old
  // receipt hashes even though Out ignored them. Remove them before invoking
  // the base parser and bind the new author intent to an explicit version.
  const baseInput = { ...input };
  delete baseInput.auto_on_time; delete baseInput.auto_off_time;
  const base = normalizeSupplierPhysicalProductInput(baseInput, { requireSettlePrice: false });
  const freightValue = strictInteger(input.freight, "运费类型", 1, 1, 3) as 1 | 2 | 3;
  let postage = base.postage;
  let tempId = base.tempId;
  if (freightValue === 1) {
    postage = "0.00";
    tempId = 0;
  } else if (freightValue === 2) {
    if (moneyCents(postage) <= 0n) throw new ValidateException("请设置运费金额");
    tempId = 0;
  } else {
    if (tempId <= 0) throw new ValidateException("请选择运费模板");
    postage = "0.00";
  }
  const sliderImages = base.sliderImages.map((item) => safeAsset(item, "商品轮播图", 256));
  if (JSON.stringify(sliderImages).length > 5000) throw new ValidateException("商品轮播图总长度超限");
  if (base.cateIds.join(",").length > 64) throw new ValidateException("商品分类编码总长度超限");
  const skus = base.skus.map((sku) => ({
    ...sku,
    image: safeAsset(sku.image, "SKU图片", 128),
  }));
  const brandIds = supplierProductBrandInput(input);
  const ensureIds = supplierProductEnsureInput(input);
  const parameters = outProductParameterInput(input);
  const couponIds = outProductCouponInput(input);
  const customForm = outProductCustomFormInput(input);
  const systemFormId = outProductSystemFormInput(input);
  const requestedIsShow = flag(input.is_show, "商品状态", 0);
  return {
    ...base,
    ...(brandIds === undefined ? {} : { brandIds }),
    ...(ensureIds === undefined ? {} : { ensureIds }),
    ...(parameters === undefined ? {} : { parameters }),
    ...(couponIds === undefined ? {} : { couponIds }),
    ...(customForm === undefined ? {} : { customForm }),
    ...(systemFormId === undefined ? {} : { systemFormId }),
    ...schedule,
    ...(activity === undefined ? {} : { activity }),
    ...(recommendList === undefined ? {} : { recommendList }),
    ...(vipProduct === undefined ? {} : { isVipProduct: vipProduct }),
    ...presale,
    ...(Object.keys(schedule).length ? { scheduleIntentVersion: 1 as const } : {}),
    ...outProductLabelInput(input),
    sliderImages,
    skus,
    videoLink: safeAsset(base.videoLink, "商品视频", 500),
    postage,
    tempId,
    deliveryType: deliveryTypes(input.delivery_type),
    freight: freightValue,
    isShow: schedule.autoOnTime ? 0 : requestedIsShow,
    sales: strictInteger(input.sales, "销量", 0),
    giveIntegral: decimal(input.give_integral, "赠送积分"),
    recommendImage: safeAsset(input.recommend_image, "推荐图片", 256),
    sourceLink: safeAsset(input.soure_link ?? input.source_link, "来源链接", 2000),
    code: safeText(input.code, "商品编码", 50),
    isHot: flag(input.is_hot, "热卖状态", 0),
    isBenefit: flag(input.is_benefit, "促销状态", 0),
    isBest: flag(input.is_best, "精品状态", 0),
    isNew: flag(input.is_new, "新品状态", 0),
    isGood: flag(input.is_good, "优品状态", 0),
  };
}

export function normalizeOutStockUpload(input: UnknownRecord): StockUploadItem[] {
  const rows = Array.isArray(input.items) ? input.items : [];
  if (rows.length === 0 || rows.length > MAX_STOCK_UPLOAD_ITEMS) {
    throw new ValidateException("库存同步项必须为1至100条");
  }
  const items = rows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidateException("库存同步项格式错误");
    }
    const row = value as UnknownRecord;
    const barCode = safeText(row.bar_code, "属性编码", 50);
    if (!barCode) throw new ValidateException("请检查属性编码或库存数量");
    return {
      barCode,
      quantity: strictInteger(row.qty, "库存数量", -1, 0),
    };
  });
  if (new Set(items.map((item) => item.barCode)).size !== items.length) {
    throw new ValidateException("同一属性编码不能重复同步");
  }
  return items;
}

export function normalizeOutProductRequestKey(value: unknown): string {
  return normalizeOutRequestKey(value);
}

function generateOpaque(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}

async function replayResult(
  tx: DbClient,
  accountId: number,
  operation: ProductWriteOperation,
  key: string,
  hash: string,
) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPLAY_LOCK_NAMESPACE}, ${accountId})`);
  const rows = await tx
    .select()
    .from(outProductWriteReplay)
    .where(and(
      eq(outProductWriteReplay.outAccountId, accountId),
      eq(outProductWriteReplay.operation, operation),
      eq(outProductWriteReplay.requestKey, key),
    ))
    .limit(1);
  const replay = rows[0];
  if (!replay) return undefined;
  if (replay.requestHash !== hash) {
    throw new ValidateException("Idempotency-Key 已用于不同请求");
  }
  return replay;
}

async function recordReplay(
  tx: DbClient,
  accountId: number,
  operation: ProductWriteOperation,
  key: string,
  hash: string,
  productId: number,
  resultCount = 0,
) {
  await tx.insert(outProductWriteReplay).values({
    outAccountId: accountId,
    operation,
    requestKey: key,
    requestHash: hash,
    productId,
    resultCount,
    addTime: Math.floor(Date.now() / 1000),
  });
}

function skuInsert(
  sku: SupplierProductSku,
  productId: number,
  fallbackImage: string,
  unique: string,
) {
  return {
    productId,
    productType: PHYSICAL_PRODUCT_TYPE,
    suk: sku.suk,
    stock: sku.stock,
    sumStock: sku.stock,
    sales: 0,
    price: sku.price,
    settlePrice: sku.settlePrice,
    image: sku.image || fallbackImage.slice(0, 128),
    unique,
    cost: sku.cost,
    barCode: sku.barCode,
    otPrice: sku.otPrice,
    vipPrice: sku.vipPrice,
    weight: sku.weight,
    volume: sku.volume,
    brokerage: sku.brokerage,
    brokerageTwo: sku.brokerageTwo,
    type: PRODUCT_ATTR_TYPE,
    code: sku.code,
  } as const;
}

/** Only explicit non-waiting inventory locks become a refreshable business error. */
async function inventoryLock<T>(read: () => PromiseLike<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === "object"; depth++) {
      if ("code" in cause && cause.code === "55P03") {
        throw new ValidateException("商品或购物车正在变化，请刷新后重试");
      }
      cause = "cause" in cause ? cause.cause : undefined;
    }
    throw error;
  }
}

async function updateCartStatus(tx: DbClient, productId: number, status: number): Promise<void> {
  // Preserve the Out API's existing all-carts predicate, and update only the
  // candidates locked by this same statement. Never skip busy carts.
  await inventoryLock(() => tx.execute(sql`
    WITH locked_carts AS MATERIALIZED (
      SELECT ${storeCart.id} FROM ${storeCart}
      WHERE ${eq(storeCart.productId, productId)}
      ORDER BY ${storeCart.id} FOR UPDATE NOWAIT
    )
    UPDATE ${storeCart} SET status = ${status}
    FROM locked_carts WHERE ${storeCart.id} = locked_carts.id
  `));
}

export class OutProductService {
  constructor(private readonly container: Container, private readonly appKey?: string) {}

  private async categories(tx: DbClient, ids: number[]) {
    const rows = await tx
      .select()
      .from(storeProductCategory)
      .where(and(
        inArray(storeProductCategory.id, ids),
        eq(storeProductCategory.type, PLATFORM_TYPE),
        eq(storeProductCategory.relationId, PLATFORM_RELATION_ID),
      ));
    if (rows.length !== ids.length) throw new ValidateException("商品分类不存在或不属于平台");
    return rows;
  }

  async save(
    account: OutAccountIdentity,
    productId: number,
    rawInput: UnknownRecord,
    requestKeyInput: unknown,
  ) {
    const key = normalizeOutProductRequestKey(requestKeyInput);
    const input = normalizeOutPhysicalProductInput(rawInput);
    const brandIds = input.brandIds;
    const ensureIds = input.ensureIds;
    const { storeLabelIds, userLabelIds, parameters, couponIds, customForm, systemFormId } = input;
    const operation: ProductWriteOperation = productId > 0 ? "product_update" : "product_create";
    const hash = await outRequestHash({ operation, productId, input });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, operation, key, hash);
      if (replay) {
        return { id: replay.productId, idempotent: true, stock_preserved: productId > 0 };
      }
      if (productId > 0) {
        await boundBargainSourceProductChange(tx);
        await lockBargainSourceProductChange(tx, productId);
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SAVE_LOCK_NAMESPACE}, 0)`);
      if (brandIds !== undefined) await inventoryLock(() => lockSupplierProductBrandPath(tx, brandIds));
      await tx.execute(sql`LOCK TABLE "store_product_category" IN SHARE ROW EXCLUSIVE MODE`);
      const categories = await this.categories(tx, input.cateIds);

      let existing: typeof storeProduct.$inferSelect | undefined;
      let currentSkus: Array<typeof storeProductAttrValue.$inferSelect> = [];
      if (productId > 0) {
        currentSkus = await inventoryLock(() => tx
          .select()
          .from(storeProductAttrValue)
          .where(and(
            eq(storeProductAttrValue.productId, productId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
          ))
          .orderBy(asc(storeProductAttrValue.id))
          .for("update", { noWait: true }));
        existing = (
          await inventoryLock(() => tx
            .select()
            .from(storeProduct)
            .where(and(
              eq(storeProduct.id, productId),
              eq(storeProduct.type, PLATFORM_TYPE),
              eq(storeProduct.relationId, PLATFORM_RELATION_ID),
              eq(storeProduct.isDel, 0),
            ))
            .limit(1)
            .for("update", { noWait: true }))
        )[0];
        if (!existing) throw new NotFoundException("商品不存在或不属于平台");
        if (existing.productType !== PHYSICAL_PRODUCT_TYPE) {
          throw new ValidateException("非实物商品尚未迁移，不能通过 Out API 编辑");
        }
        if (currentSkus.some((sku) => sku.isRetired === 1)) {
          throw new ValidateException("商品存在受控退役SKU，Out API不能修改其SKU拓扑");
        }
        const requestedSuks = input.skus.map((sku) => sku.suk).sort();
        const currentSuks = currentSkus.map((sku) => sku.suk).sort();
        if (JSON.stringify(requestedSuks) !== JSON.stringify(currentSuks)) {
          throw new ValidateException("Out API 修改商品不能增删SKU，请使用运营后台调整规格");
        }
      }

      await lockShippingTemplateBindings(tx, [{ tempId: input.tempId, freight: input.freight,
        ownerType: PLATFORM_TYPE, relationId: PLATFORM_RELATION_ID }]);
      const currentBySuk = new Map(currentSkus.map((sku) => [sku.suk, sku]));
      for (const sku of input.skus) {
        const current = currentBySuk.get(sku.suk);
        if (current && sku.unique && sku.unique !== current.unique) {
          throw new ValidateException("SKU唯一标识与当前商品不一致");
        }
      }
      const stock = existing
        ? currentSkus.reduce((sum, sku) => sum + sku.stock, 0)
        : input.skus.reduce((sum, sku) => sum + sku.stock, 0);
      if (!Number.isSafeInteger(stock)) throw new ValidateException("商品总库存超出安全范围");
      const presalePlan = outProductPresalePlan(input, existing);
      await assertOutProductPresaleFuture(tx, presalePlan);
      const minimum = (values: string[]) => values.reduce((left, right) =>
        moneyCents(right) < moneyCents(left) ? right : left
      );
      const now = Math.floor(Date.now() / 1000);
      const admittedEnsures = ensureIds === undefined ? undefined
        : await inventoryLock(() => lockOutProductEnsures(tx, ensureIds, existing));
      const admittedProductLabels = storeLabelIds === undefined ? undefined
        : await inventoryLock(() => lockOutProductLabels(tx, 'product', storeLabelIds));
      const admittedUserLabels = userLabelIds === undefined ? undefined
        : await inventoryLock(() => lockOutProductLabels(tx, 'user', userLabelIds));
      const admittedParameters = parameters === undefined ? undefined
        : await inventoryLock(() => lockOutProductParameterTemplate(tx, parameters.specs_id));
      const admittedForm = systemFormId === undefined ? undefined
        : await inventoryLock(() => lockOutProductSystemForm(tx, systemFormId));
      const productValues = {
        ...(input.isVipProduct === undefined ? {} : { isVipProduct: input.isVipProduct }),
        ...(presalePlan.authored ? { isPresaleProduct: presalePlan.isPresaleProduct,
          presaleStartTime: presalePlan.presaleStartTime, presaleEndTime: presalePlan.presaleEndTime,
          presaleDay: presalePlan.presaleDay } : {}),
        ...(input.activity === undefined ? {} : { activity: input.activity }),
        ...(input.recommendList === undefined ? {} : { recommendList: input.recommendList }),
        ...(customForm === undefined ? {} : { customForm }),
        ...(systemFormId === undefined ? {} : { systemFormId }),
        ...(brandIds === undefined ? {} : { brandId: brandIds.at(-1) ?? 0, brandCom: brandIds.join(',') }),
        ...(ensureIds === undefined ? {} : { ensureId: ensureIds.join(',') }),
        ...(storeLabelIds === undefined ? {} : { storeLabelId: storeLabelIds.join(',') }),
        ...(userLabelIds === undefined ? {} : { labelId: userLabelIds.join(',') }),
        ...(parameters === undefined ? {} : { specsId: parameters.specs_id, specs: parameters.specs.length ? JSON.stringify(parameters.specs) : '' }),
        productType: PHYSICAL_PRODUCT_TYPE,
        type: PLATFORM_TYPE,
        relationId: PLATFORM_RELATION_ID,
        image: input.sliderImages[0],
        recommendImage: input.recommendImage,
        sliderImage: JSON.stringify(input.sliderImages),
        storeName: input.storeName,
        storeInfo: input.storeInfo,
        keyword: input.keyword,
        barCode: input.barCode,
        cateId: input.cateIds.join(","),
        price: minimum(input.skus.map((sku) => sku.price)),
        settlePrice: minimum(input.skus.map((sku) => sku.settlePrice)),
        vipPrice: minimum(input.skus.map((sku) => sku.vipPrice)),
        otPrice: minimum(input.skus.map((sku) => sku.otPrice)),
        deliveryType: input.deliveryType,
        freight: input.freight,
        postage: input.postage,
        tempId: input.tempId,
        unitName: input.unitName,
        sort: input.sort,
        ficti: input.ficti,
        sales: existing?.sales ?? input.sales,
        stock,
        isShow: input.isShow,
        isHot: input.isHot,
        isBenefit: input.isBenefit,
        isBest: input.isBest,
        isNew: input.isNew,
        isGood: input.isGood,
        isVerify: 1,
        isPostage: input.isPostage,
        giveIntegral: input.giveIntegral,
        cost: minimum(input.skus.map((sku) => sku.cost)),
        videoOpen: input.videoLink ? 1 : 0,
        videoLink: input.videoLink,
        specType: input.specType,
        isSupportRefund: input.isSupportRefund,
        isLimit: input.isLimit,
        limitType: input.limitType,
        limitNum: input.limitNum,
        isSold: stock > 0 ? 0 : 1,
        soureLink: input.sourceLink,
        code: input.code,
        ...(input.autoOnTime === undefined ? {} : { autoOnTime: input.autoOnTime }),
        autoOffTime: input.autoOffTime ?? (input.isShow ? 0 : (existing?.autoOffTime ?? 0)),
      } as const;

      const relationFence = await inventoryLock(() => captureOutProductRelationFence(tx, existing,
          [1, ...(brandIds === undefined ? [] : [2]), ...(storeLabelIds === undefined ? [] : [3]),
            ...(userLabelIds === undefined ? [] : [4]), ...(ensureIds === undefined ? [] : [5]), ...(parameters === undefined ? [] : [6])]));
      let savedProductId = productId;
      let couponFence = existing ? await inventoryLock(() => captureOutProductCoupons(tx, productId)) : undefined;
      if (existing) {
        await tx.update(storeProduct).set(productValues).where(eq(storeProduct.id, productId));
      } else {
        const rows = await tx
          .insert(storeProduct)
          .values({
            ...productValues,
            addTime: now,
            isDel: 0,
            spu: generateOpaque(13),
          })
          .returning({ id: storeProduct.id });
        savedProductId = rows[0].id;
      }

      const formProof = outProductFormProof(savedProductId, existing, customForm, systemFormId, admittedForm);
      const scheduleProof = await inventoryLock(() => outProductScheduleProof(tx, savedProductId, existing, input));
      await assertOutProductPresale(tx, savedProductId, presalePlan);
      const expectedActivity = input.activity ?? existing?.activity ?? '';
      const expectedRecommendations = input.recommendList ?? existing?.recommendList ?? '';
      const expectedVipProduct = input.isVipProduct ?? existing?.isVipProduct ?? 0;
      const assertProductSelections = async () => {
        const [row] = await tx.select({ activity: storeProduct.activity, recommendList: storeProduct.recommendList,
          isVipProduct: storeProduct.isVipProduct }).from(storeProduct)
          .where(eq(storeProduct.id, savedProductId)).limit(1);
        if (!row || row.activity !== expectedActivity) throw new ValidateException('平台商品活动顺序已变化');
        if (row.recommendList !== expectedRecommendations) throw new ValidateException('平台推荐商品列表已变化');
        if (row.isVipProduct !== expectedVipProduct) throw new ValidateException('平台商品会员专属状态已变化');
      };
      await assertProductSelections();
      if (!couponFence) {
        couponFence = await inventoryLock(() => captureOutProductCoupons(tx, savedProductId));
        if (couponFence.rows.length) throw new ValidateException("新商品优惠券关联已变化");
      }
      await tx.delete(storeProductRelation).where(and(
        eq(storeProductRelation.productId, savedProductId),
        eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
      ));
      await tx.insert(storeProductRelation).values(categories.map((category) => ({
        type: CATEGORY_RELATION_TYPE,
        productId: savedProductId,
        relationId: category.id,
        relationPid: category.pid,
        status: input.isShow,
        addTime: now,
      })));
      await tx
        .insert(storeProductDescription)
        .values({ productId: savedProductId, description: input.description, type: PHYSICAL_PRODUCT_TYPE })
        .onConflictDoUpdate({
          target: [storeProductDescription.productId, storeProductDescription.type],
          set: { description: input.description },
        });
      await tx.delete(storeProductAttr).where(and(
        eq(storeProductAttr.productId, savedProductId),
        eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
      ));
      await tx.insert(storeProductAttr).values(input.dimensions.map((dimension) => ({
        productId: savedProductId,
        attrName: dimension.value,
        attrValues: dimension.detail.join(","),
        type: PRODUCT_ATTR_TYPE,
      })));

      const resultSkus: SupplierProductSku[] = [];
      if (!existing) {
        const used = new Set<string>();
        const inserts = [];
        for (const sku of input.skus) {
          let unique = "";
          while (!unique) {
            const candidate = generateOpaque(8);
            if (used.has(candidate)) continue;
            const collision = await tx
              .select({ id: storeProductAttrValue.id })
              .from(storeProductAttrValue)
              .where(eq(storeProductAttrValue.unique, candidate))
              .limit(1);
            if (!collision[0]) unique = candidate;
          }
          used.add(unique);
          inserts.push(skuInsert(sku, savedProductId, input.sliderImages[0], unique));
          resultSkus.push({ ...sku, unique });
        }
        await tx.insert(storeProductAttrValue).values(inserts);
      } else {
        for (const sku of input.skus) {
          const current = currentBySuk.get(sku.suk)!;
          await tx
            .update(storeProductAttrValue)
            .set({
              productType: PHYSICAL_PRODUCT_TYPE,
              price: sku.price,
              settlePrice: sku.settlePrice,
              image: sku.image || input.sliderImages[0].slice(0, 128),
              cost: sku.cost,
              barCode: sku.barCode,
              otPrice: sku.otPrice,
              vipPrice: sku.vipPrice,
              weight: sku.weight,
              volume: sku.volume,
              brokerage: sku.brokerage,
              brokerageTwo: sku.brokerageTwo,
              code: sku.code,
            })
            .where(eq(storeProductAttrValue.id, current.id));
          resultSkus.push({
            ...sku,
            unique: current.unique,
            stock: current.stock,
          });
        }
      }
      await tx.delete(storeProductAttrResult).where(and(
        eq(storeProductAttrResult.productId, savedProductId),
        eq(storeProductAttrResult.type, PRODUCT_ATTR_TYPE),
      ));
      await tx.insert(storeProductAttrResult).values({
        productId: savedProductId,
        result: JSON.stringify({ attr: input.dimensions, value: resultSkus }),
        changeTime: now,
        type: PRODUCT_ATTR_TYPE,
      });
      await updateCartStatus(tx, savedProductId, input.isShow);
      if (relationFence) relationFence.productId = savedProductId;
      const brandProof = brandIds === undefined ? undefined
        : await inventoryLock(() => replaceOutProductBrandBindings(tx, savedProductId, brandIds, relationFence!));
      const ensureProof = ensureIds === undefined ? undefined
        : await inventoryLock(() => replaceOutProductEnsureBindings(tx, savedProductId, ensureIds, admittedEnsures!, relationFence!));
      const productLabelProof = admittedProductLabels === undefined ? undefined
        : await inventoryLock(() => replaceOutProductLabelBindings(tx, savedProductId, admittedProductLabels, relationFence!));
      const userLabelProof = admittedUserLabels === undefined ? undefined
        : await inventoryLock(() => replaceOutProductLabelBindings(tx, savedProductId, admittedUserLabels, relationFence!));
      const parameterProof = parameters === undefined ? undefined
        : await inventoryLock(() => replaceOutProductParameterBindings(tx, savedProductId, parameters, admittedParameters, relationFence));
      const couponProof = couponIds === undefined ? couponFence
        : await inventoryLock(() => replaceOutProductCoupons(tx, couponFence, couponIds, now));
      await recordReplay(tx, account.id, operation, key, hash, savedProductId);
      if (brandProof) {
        await inventoryLock(() => assertOutProductBrandBindings(tx, brandProof));
        await inventoryLock(() => lockSupplierProductBrandPath(tx, brandProof.ids));
      }
      if (ensureProof) await inventoryLock(() => assertOutProductEnsureBindings(tx, ensureProof));
      if (productLabelProof) await inventoryLock(() => assertOutProductLabelBindings(tx, productLabelProof));
      if (userLabelProof) await inventoryLock(() => assertOutProductLabelBindings(tx, userLabelProof));
      if (parameterProof) await inventoryLock(() => assertOutProductParameterBindings(tx, parameterProof));
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await inventoryLock(() => assertOutProductRelationFence(tx, relationFence));
      await inventoryLock(() => assertOutProductCoupons(tx, couponProof));
      await inventoryLock(() => assertOutProductForm(tx, formProof));
      await inventoryLock(() => assertOutProductSchedule(tx, scheduleProof));
      await assertOutProductPresale(tx, savedProductId, presalePlan);
      await assertProductSelections();
      await assertOutProductPresaleFuture(tx, presalePlan);
      return { id: savedProductId, idempotent: false, stock_preserved: !!existing };
    });
  }

  async detail(productId: number) {
    return readOutProductDetail(this.container, productId, this.appKey);
  }

  async setShow(
    account: OutAccountIdentity,
    productId: number,
    isShowInput: unknown,
    requestKeyInput: unknown,
  ) {
    const key = normalizeOutProductRequestKey(requestKeyInput);
    const isShow = flag(isShowInput, "商品状态", 0);
    const hash = await outRequestHash({ operation: "product_show", productId, isShow });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, "product_show", key, hash);
      if (replay) return { id: replay.productId, is_show: isShow, idempotent: true };
      await boundBargainSourceProductChange(tx);
      await lockBargainSourceProductChange(tx, productId);
      const product = (
        await inventoryLock(() => tx
          .select({ id: storeProduct.id, isShow: storeProduct.isShow, price: storeProduct.price })
          .from(storeProduct)
          .where(and(
            eq(storeProduct.id, productId),
            eq(storeProduct.type, PLATFORM_TYPE),
            eq(storeProduct.relationId, PLATFORM_RELATION_ID),
            eq(storeProduct.isDel, 0),
          ))
          .limit(1)
          .for("update", { noWait: true }))
      )[0];
      if (!product) throw new NotFoundException("商品不存在或不属于平台");
      if (isShow === 1 && moneyCents(product.price) <= 0n) {
        throw new ValidateException("商品价格必须大于0才能上架");
      }
      const idempotent = product.isShow === isShow;
      if (!idempotent) {
        await tx
          .update(storeProduct)
          .set(isShow ? { isShow, autoOffTime: 0 } : { isShow })
          .where(eq(storeProduct.id, productId));
        await updateCartStatus(tx, productId, isShow);
        await tx
          .update(storeProductRelation)
          .set({ status: isShow })
          .where(eq(storeProductRelation.productId, productId));
      }
      await recordReplay(tx, account.id, "product_show", key, hash, productId);
      return { id: productId, is_show: isShow, idempotent };
    });
  }

  async uploadStock(account: OutAccountIdentity, raw: UnknownRecord, requestKeyInput: unknown) {
    const key = normalizeOutProductRequestKey(requestKeyInput);
    const items = normalizeOutStockUpload(raw);
    const hash = await outRequestHash({ operation: "stock_upload", items });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, "stock_upload", key, hash);
      if (replay) return { updated: replay.resultCount, idempotent: true };
      // Serialize barcode resolution with cooperating product/SKU identity writes.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SAVE_LOCK_NAMESPACE}, 0)`);
      const barCodes = items.map((item) => item.barCode);
      // Two eligible rows prove ambiguity. Apply all eligibility predicates before
      // ranking, so unrelated/retired/non-physical rows cannot hide a valid match.
      // Rank one filtered set, rather than rescanning unindexed barcodes per input.
      const candidates = await tx.execute<{ id: number; barCode: string }>(sql`
        SELECT matched.id, matched.bar_code AS "barCode"
        FROM (
          SELECT ${storeProductAttrValue.id} AS id, ${storeProductAttrValue.barCode} AS bar_code,
            row_number() OVER (PARTITION BY ${storeProductAttrValue.barCode} ORDER BY ${storeProductAttrValue.id}) AS match_number
          FROM ${storeProductAttrValue}
          INNER JOIN ${storeProduct} ON ${eq(storeProduct.id, storeProductAttrValue.productId)}
          WHERE ${and(
            inArray(storeProductAttrValue.barCode, barCodes),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
            eq(storeProductAttrValue.isRetired, 0),
            eq(storeProduct.type, PLATFORM_TYPE),
            eq(storeProduct.relationId, PLATFORM_RELATION_ID),
            eq(storeProduct.productType, PHYSICAL_PRODUCT_TYPE),
            eq(storeProduct.isDel, 0),
          )}
        ) AS matched
        WHERE matched.match_number <= 2
        ORDER BY matched.id
      `);
      const candidateCounts = new Map<string, number>();
      for (const row of candidates) candidateCounts.set(row.barCode, (candidateCounts.get(row.barCode) ?? 0) + 1);
      for (const item of items) {
        const matches = candidateCounts.get(item.barCode) ?? 0;
        if (matches === 0) throw new ValidateException(`属性编码 ${item.barCode} 不存在于平台商品`);
        if (matches > 1) throw new ValidateException(`属性编码 ${item.barCode} 存在重复，拒绝猜测商品`);
      }
      // Only an initially unique set proceeds to locks. Never reinterpret a
      // truncated ambiguous set as unique after one candidate changes/disappears.
      const candidateIds = candidates.map((row) => row.id);
      const allMatchingSkus = candidateIds.length > 0
        ? await inventoryLock(() => tx
            .select()
            .from(storeProductAttrValue)
            .where(inArray(storeProductAttrValue.id, candidateIds))
            .orderBy(asc(storeProductAttrValue.id))
            .for("update", { noWait: true }))
        : [];
      const productIds = [...new Set(allMatchingSkus.map((sku) => sku.productId))];
      const products = productIds.length > 0
        ? await inventoryLock(() => tx
            .select()
            .from(storeProduct)
            .where(inArray(storeProduct.id, productIds))
            .orderBy(asc(storeProduct.id))
            .for("update", { noWait: true }))
        : [];
      const platformProducts = new Map(products.filter((product) =>
        product.type === PLATFORM_TYPE
        && product.relationId === PLATFORM_RELATION_ID
        && product.productType === PHYSICAL_PRODUCT_TYPE
        && product.isDel === 0
      ).map((product) => [product.id, product]));
      const byBarCode = new Map<string, Array<typeof storeProductAttrValue.$inferSelect>>();
      for (const sku of allMatchingSkus) {
        if (!platformProducts.has(sku.productId)) continue;
        byBarCode.set(sku.barCode, [...(byBarCode.get(sku.barCode) ?? []), sku]);
      }
      for (const item of items) {
        const matches = byBarCode.get(item.barCode) ?? [];
        if (matches.length === 0) throw new ValidateException(`属性编码 ${item.barCode} 不存在于平台商品`);
        if (matches.length > 1) throw new ValidateException(`属性编码 ${item.barCode} 存在重复，拒绝猜测商品`);
      }

      const now = Math.floor(Date.now() / 1000);
      const affectedProducts = new Set<number>();
      let updated = 0;
      for (const item of items) {
        const sku = byBarCode.get(item.barCode)![0];
        affectedProducts.add(sku.productId);
        if (sku.stock === item.quantity) continue;
        const delta = item.quantity - sku.stock;
        await tx
          .update(storeProductAttrValue)
          .set({
            stock: item.quantity,
            sumStock: delta > 0 ? sku.sumStock + delta : sku.sumStock,
          })
          .where(eq(storeProductAttrValue.id, sku.id));
        await tx.insert(storeProductStockRecord).values({
          storeId: 0,
          productId: sku.productId,
          unique: sku.unique,
          costPrice: sku.cost,
          number: Math.abs(delta),
          pm: delta > 0 ? 1 : 0,
          addTime: now,
        });
        updated += 1;
      }
      for (const affectedProductId of [...affectedProducts].sort((left, right) => left - right)) {
        const totals = await tx
          .select({ stock: sql<number>`COALESCE(SUM(${storeProductAttrValue.stock}), 0)::integer` })
          .from(storeProductAttrValue)
          .where(and(
            eq(storeProductAttrValue.productId, affectedProductId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
            eq(storeProductAttrValue.isRetired, 0),
          ));
        const stock = Number(totals[0]?.stock ?? 0);
        await tx
          .update(storeProduct)
          .set({ stock, isSold: stock > 0 ? 0 : 1 })
          .where(and(
            eq(storeProduct.id, affectedProductId),
            eq(storeProduct.type, PLATFORM_TYPE),
            eq(storeProduct.relationId, PLATFORM_RELATION_ID),
            eq(storeProduct.isDel, 0),
          ));
      }
      await recordReplay(tx, account.id, "stock_upload", key, hash, 0, updated);
      return { updated, idempotent: updated === 0 };
    });
  }
}
