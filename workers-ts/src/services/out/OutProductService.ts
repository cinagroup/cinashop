import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
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
import { NotFoundException, ValidateException } from "@/utils/errors";

type UnknownRecord = Record<string, unknown>;
type ProductWriteOperation = "product_create" | "product_update" | "product_show" | "stock_upload";

const PLATFORM_TYPE = 0;
const PLATFORM_RELATION_ID = 0;
const PHYSICAL_PRODUCT_TYPE = 0;
const PRODUCT_ATTR_TYPE = 0;
const CATEGORY_RELATION_TYPE = 1;
const REPLAY_LOCK_NAMESPACE = 744_220_001;
const PRODUCT_SAVE_LOCK_NAMESPACE = 744_220_002;
const MAX_STOCK_UPLOAD_ITEMS = 100;

interface OutAccountIdentity {
  id: number;
}

interface OutPhysicalProductInput extends SupplierPhysicalProductInput {
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

function rejectUnmigratedProductFeatures(input: UnknownRecord): void {
  const unsupported = [
    "activity",
    "auto_off_time",
    "auto_on_time",
    "brand_id",
    "coupon_ids",
    "custom_form",
    "ensure_id",
    "is_presale_product",
    "is_vip_product",
    "label_id",
    "presale_day",
    "presale_time",
    "recommend",
    "recommend_list",
    "specs",
    "specs_id",
    "store_label_id",
  ].filter((key) => nonEmpty(input[key]));
  if (unsupported.length > 0) {
    throw new ValidateException(`以下商品能力尚未迁移，不能静默丢弃：${unsupported.join(",")}`);
  }
  const supplierId = strictInteger(input.supplier_id, "供应商ID", 0);
  if (supplierId !== 0) throw new ValidateException("Out API 商品写入只允许平台作用域");
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
  rejectUnmigratedProductFeatures(input);
  const base = normalizeSupplierPhysicalProductInput(input, { requireSettlePrice: false });
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
  return {
    ...base,
    sliderImages,
    skus,
    videoLink: safeAsset(base.videoLink, "商品视频", 500),
    postage,
    tempId,
    deliveryType: deliveryTypes(input.delivery_type),
    freight: freightValue,
    isShow: flag(input.is_show, "商品状态", 0),
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
  if (typeof value !== "string") throw new ValidateException("缺少 Idempotency-Key");
  const key = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) {
    throw new ValidateException("Idempotency-Key 必须是 UUID v4");
  }
  return key;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as UnknownRecord;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

export class OutProductService {
  constructor(private readonly container: Container) {}

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
    const operation: ProductWriteOperation = productId > 0 ? "product_update" : "product_create";
    const hash = await requestHash({ operation, productId, input });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, operation, key, hash);
      if (replay) {
        return { id: replay.productId, idempotent: true, stock_preserved: productId > 0 };
      }
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SAVE_LOCK_NAMESPACE}, 0)`);
      await tx.execute(sql`LOCK TABLE "store_product_category" IN SHARE ROW EXCLUSIVE MODE`);
      const categories = await this.categories(tx, input.cateIds);

      let existing: typeof storeProduct.$inferSelect | undefined;
      let currentSkus: Array<typeof storeProductAttrValue.$inferSelect> = [];
      if (productId > 0) {
        currentSkus = await tx
          .select()
          .from(storeProductAttrValue)
          .where(and(
            eq(storeProductAttrValue.productId, productId),
            eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
          ))
          .orderBy(asc(storeProductAttrValue.id))
          .for("update");
        existing = (
          await tx
            .select()
            .from(storeProduct)
            .where(and(
              eq(storeProduct.id, productId),
              eq(storeProduct.type, PLATFORM_TYPE),
              eq(storeProduct.relationId, PLATFORM_RELATION_ID),
              eq(storeProduct.isDel, 0),
            ))
            .limit(1)
            .for("update")
        )[0];
        if (!existing) throw new NotFoundException("商品不存在或不属于平台");
        if (existing.productType !== PHYSICAL_PRODUCT_TYPE) {
          throw new ValidateException("非实物商品尚未迁移，不能通过 Out API 编辑");
        }
        const requestedSuks = input.skus.map((sku) => sku.suk).sort();
        const currentSuks = currentSkus.map((sku) => sku.suk).sort();
        if (canonicalJson(requestedSuks) !== canonicalJson(currentSuks)) {
          throw new ValidateException("Out API 修改商品不能增删SKU，请使用运营后台调整规格");
        }
      }

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
      const minimum = (values: string[]) => values.reduce((left, right) =>
        moneyCents(right) < moneyCents(left) ? right : left
      );
      const now = Math.floor(Date.now() / 1000);
      const productValues = {
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
        autoOffTime: input.isShow ? 0 : (existing?.autoOffTime ?? 0),
      } as const;

      let savedProductId = productId;
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
      await tx.update(storeCart).set({ status: input.isShow }).where(eq(storeCart.productId, savedProductId));
      await recordReplay(tx, account.id, operation, key, hash, savedProductId);
      return { id: savedProductId, idempotent: false, stock_preserved: !!existing };
    });
  }

  async detail(productId: number) {
    const product = (
      await this.container.db
        .select()
        .from(storeProduct)
        .where(and(
          eq(storeProduct.id, productId),
          eq(storeProduct.type, PLATFORM_TYPE),
          eq(storeProduct.relationId, PLATFORM_RELATION_ID),
          eq(storeProduct.isDel, 0),
        ))
        .limit(1)
    )[0];
    if (!product) throw new NotFoundException("商品不存在或不属于平台");
    const [categories, descriptions, dimensions, skus] = await Promise.all([
      this.container.db
        .select({ relation_id: storeProductRelation.relationId })
        .from(storeProductRelation)
        .where(and(
          eq(storeProductRelation.productId, productId),
          eq(storeProductRelation.type, CATEGORY_RELATION_TYPE),
        ))
        .orderBy(asc(storeProductRelation.id)),
      this.container.db
        .select({ description: storeProductDescription.description })
        .from(storeProductDescription)
        .where(and(
          eq(storeProductDescription.productId, productId),
          eq(storeProductDescription.type, PHYSICAL_PRODUCT_TYPE),
        ))
        .limit(1),
      this.container.db
        .select()
        .from(storeProductAttr)
        .where(and(
          eq(storeProductAttr.productId, productId),
          eq(storeProductAttr.type, PRODUCT_ATTR_TYPE),
        ))
        .orderBy(asc(storeProductAttr.id)),
      this.container.db
        .select()
        .from(storeProductAttrValue)
        .where(and(
          eq(storeProductAttrValue.productId, productId),
          eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
        ))
        .orderBy(asc(storeProductAttrValue.id)),
    ]);
    const items = dimensions.map((dimension) => ({
      value: dimension.attrName,
      detail: dimension.attrValues.split(",").filter(Boolean),
    }));
    return {
      ...product,
      cate_id: categories.map((row) => row.relation_id),
      description: descriptions[0]?.description ?? "",
      items,
      attrs: skus.map((sku) => ({
        ...sku,
        detail: Object.fromEntries(items.map((item, index) => [
          item.value,
          sku.suk.split(",")[index] ?? "",
        ])),
      })),
    };
  }

  async setShow(
    account: OutAccountIdentity,
    productId: number,
    isShowInput: unknown,
    requestKeyInput: unknown,
  ) {
    const key = normalizeOutProductRequestKey(requestKeyInput);
    const isShow = flag(isShowInput, "商品状态", 0);
    const hash = await requestHash({ operation: "product_show", productId, isShow });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, "product_show", key, hash);
      if (replay) return { id: replay.productId, is_show: isShow, idempotent: true };
      const product = (
        await tx
          .select({ id: storeProduct.id, isShow: storeProduct.isShow, price: storeProduct.price })
          .from(storeProduct)
          .where(and(
            eq(storeProduct.id, productId),
            eq(storeProduct.type, PLATFORM_TYPE),
            eq(storeProduct.relationId, PLATFORM_RELATION_ID),
            eq(storeProduct.isDel, 0),
          ))
          .limit(1)
          .for("update")
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
        await tx.update(storeCart).set({ status: isShow }).where(eq(storeCart.productId, productId));
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
    const hash = await requestHash({ operation: "stock_upload", items });
    return withTx(this.container, async (tx) => {
      const replay = await replayResult(tx, account.id, "stock_upload", key, hash);
      if (replay) return { updated: replay.resultCount, idempotent: true };
      // Serialize barcode resolution with product create/update so a concurrent
      // write cannot introduce or remove a duplicate between lookup and locks.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SAVE_LOCK_NAMESPACE}, 0)`);
      const barCodes = items.map((item) => item.barCode);
      const candidates = await tx
        .select({ id: storeProductAttrValue.id })
        .from(storeProductAttrValue)
        .innerJoin(storeProduct, eq(storeProduct.id, storeProductAttrValue.productId))
        .where(and(
          eq(storeProductAttrValue.type, PRODUCT_ATTR_TYPE),
          inArray(storeProductAttrValue.barCode, barCodes),
          eq(storeProduct.type, PLATFORM_TYPE),
          eq(storeProduct.relationId, PLATFORM_RELATION_ID),
          eq(storeProduct.isDel, 0),
        ));
      const candidateIds = candidates.map((row) => row.id);
      const allMatchingSkus = candidateIds.length > 0
        ? await tx
            .select()
            .from(storeProductAttrValue)
            .where(inArray(storeProductAttrValue.id, candidateIds))
            .orderBy(asc(storeProductAttrValue.id))
            .for("update")
        : [];
      const productIds = [...new Set(allMatchingSkus.map((sku) => sku.productId))];
      const products = productIds.length > 0
        ? await tx
            .select()
            .from(storeProduct)
            .where(inArray(storeProduct.id, productIds))
            .orderBy(asc(storeProduct.id))
            .for("update")
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
