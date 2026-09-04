import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  luckPrize,
  storeBranchProductAttrValue,
  storeCart,
  storeOrder,
  storeOrderCartInfo,
  storeProduct,
  storeProductAttrValue,
  storeProductReply,
  storeProductSkuRetirementLog,
  storeProductStockRecord,
  storeProductVirtual,
  storePromotions,
  storePromotionsAuxiliary,
  systemLog,
} from "@/models/schema";
import { lockProductWrite, type ProductEditorActor } from "@/services/product/ProductAssociationService";
import {
  PRODUCT_SKU_IDENTITY_LOCK_KEY,
  PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE,
} from "@/services/product/ProductSkuIdentity";
import { rebuildActiveProductSkuState } from "@/services/product/ProductSkuEditorService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_SKUS = 50;
const PRODUCT_SKU_TYPE = 0;

export interface ProductSkuRetirementInput {
  productId: number;
  skuIds: number[];
  reason: string;
}

export interface ProductSkuRetirementScope {
  ownerType: 0 | 2;
  relationId: number;
  surface: "admin" | "supplier";
}

export const PLATFORM_PRODUCT_SKU_SCOPE: ProductSkuRetirementScope = {
  ownerType: 0,
  relationId: 0,
  surface: "admin",
};

export function supplierProductSkuScope(supplierId: number): ProductSkuRetirementScope {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    throw new ValidateException("供应商身份无效");
  }
  return { ownerType: 2, relationId: supplierId, surface: "supplier" };
}

export interface ProductSkuDependencySnapshot {
  open_carts: number;
  open_orders: number;
  activity_skus: number;
  promotion_gifts: number;
  promotion_relations: number;
  lottery_prizes: number;
  branch_skus: number;
  order_history: number;
  review_history: number;
  stock_history: number;
  virtual_inventory: number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidateException(label);
  return parsed;
}

function parseSkuIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new ValidateException("请选择SKU");
  const ids = [...new Set(value.map((item) => positiveInteger(item, "SKU标识错误")))]
    .sort((left, right) => left - right);
  if (!ids.length) throw new ValidateException("请选择SKU");
  if (ids.length > MAX_SKUS) throw new ValidateException(`单次最多操作${MAX_SKUS}个SKU`);
  return ids;
}

export function parseProductSkuRetirementInput(body: unknown): ProductSkuRetirementInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  const input = body as Record<string, unknown>;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 2 || reason.length > 255) throw new ValidateException("请填写2至255字的操作原因");
  return {
    productId: positiveInteger(input.product_id ?? input.productId, "商品标识错误"),
    skuIds: parseSkuIds(input.sku_ids ?? input.skuIds),
    reason,
  };
}

function valueOf(rows: Array<{ value: number }>): number {
  return Number(rows[0]?.value ?? 0);
}

async function dependencySnapshot(
  tx: DbClient,
  productId: number,
  skus: Array<{ suk: string; unique: string }>,
): Promise<ProductSkuDependencySnapshot> {
  const suks = skus.map((item) => item.suk);
  const uniques = skus.map((item) => item.unique);
  const uniqueArray = sql`ARRAY[${sql.join(uniques.map((value) => sql`${value}`), sql`, `)}]::text[]`;
  const [
    openCarts,
    openOrders,
    activitySkus,
    promotionGifts,
    promotionRelations,
    lotteryPrizes,
    branchSkus,
    orderHistory,
    reviewHistory,
    stockHistory,
    virtualInventory,
  ] = await Promise.all([
    tx.select({ value: count() }).from(storeCart).where(and(
      eq(storeCart.productId, productId),
      inArray(storeCart.productAttrUnique, uniques),
      eq(storeCart.isPay, 0),
      eq(storeCart.isDel, 0),
    )),
    tx.select({ value: count() }).from(storeOrderCartInfo)
      .innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))
      .where(and(
        eq(storeOrderCartInfo.productId, productId),
        inArray(storeOrderCartInfo.skuUnique, uniques),
        eq(storeOrder.paid, 0),
        eq(storeOrder.status, 0),
        eq(storeOrder.isDel, 0),
      )),
    tx.select({ value: count() }).from(storeProductAttrValue).where(and(
      inArray(storeProductAttrValue.suk, suks),
      or(
        and(eq(storeProductAttrValue.type, 1), sql`EXISTS (
          SELECT 1 FROM store_seckill activity
          WHERE activity.id = ${storeProductAttrValue.productId} AND activity.product_id = ${productId}
        )`),
        and(eq(storeProductAttrValue.type, 2), sql`EXISTS (
          SELECT 1 FROM store_bargain activity
          WHERE activity.id = ${storeProductAttrValue.productId} AND activity.product_id = ${productId}
        )`),
        and(eq(storeProductAttrValue.type, 3), sql`EXISTS (
          SELECT 1 FROM store_combination activity
          WHERE activity.id = ${storeProductAttrValue.productId} AND activity.product_id = ${productId}
        )`),
        and(eq(storeProductAttrValue.type, 4), sql`EXISTS (
          SELECT 1 FROM store_integral activity
          WHERE activity.id = ${storeProductAttrValue.productId} AND activity.product_id = ${productId}
        )`),
        and(eq(storeProductAttrValue.type, 5), sql`EXISTS (
          SELECT 1 FROM store_discounts_products activity
          WHERE activity.id = ${storeProductAttrValue.productId} AND activity.product_id = ${productId}
        )`),
        and(eq(storeProductAttrValue.type, 7), sql`EXISTS (
          SELECT 1 FROM store_newcomer activity
          WHERE activity.id = ${storeProductAttrValue.productId} AND activity.product_id = ${productId}
        )`),
      ),
    )),
    tx.select({ value: count() }).from(storePromotions).where(and(
      eq(storePromotions.isDel, 0),
      sql`string_to_array(COALESCE(${storePromotions.giveProductUnique}, ''), ',') && ${uniqueArray}`,
    )),
    tx.select({ value: count() }).from(storePromotionsAuxiliary).where(and(
      eq(storePromotionsAuxiliary.productId, productId),
      inArray(storePromotionsAuxiliary.unique, uniques),
    )),
    tx.select({ value: count() }).from(luckPrize).where(and(
      eq(luckPrize.productId, productId),
      eq(luckPrize.isDel, 0),
      inArray(luckPrize.unique, uniques),
    )),
    tx.select({ value: count() }).from(storeBranchProductAttrValue).where(and(
      eq(storeBranchProductAttrValue.productId, productId),
      inArray(storeBranchProductAttrValue.attrUnique, uniques),
    )),
    tx.select({ value: count() }).from(storeOrderCartInfo).where(and(
      eq(storeOrderCartInfo.productId, productId),
      inArray(storeOrderCartInfo.skuUnique, uniques),
    )),
    tx.select({ value: count() }).from(storeProductReply).where(and(
      eq(storeProductReply.productId, productId),
      inArray(storeProductReply.skuUnique, uniques),
    )),
    tx.select({ value: count() }).from(storeProductStockRecord).where(and(
      eq(storeProductStockRecord.productId, productId),
      inArray(storeProductStockRecord.unique, uniques),
    )),
    tx.select({ value: count() }).from(storeProductVirtual).where(and(
      eq(storeProductVirtual.productId, productId),
      inArray(storeProductVirtual.attrUnique, uniques),
    )),
  ]);
  return {
    open_carts: valueOf(openCarts),
    open_orders: valueOf(openOrders),
    activity_skus: valueOf(activitySkus),
    promotion_gifts: valueOf(promotionGifts),
    promotion_relations: valueOf(promotionRelations),
    lottery_prizes: valueOf(lotteryPrizes),
    branch_skus: valueOf(branchSkus),
    order_history: valueOf(orderHistory),
    review_history: valueOf(reviewHistory),
    stock_history: valueOf(stockHistory),
    virtual_inventory: valueOf(virtualInventory),
  };
}

function blockingSummary(snapshot: ProductSkuDependencySnapshot): string[] {
  return [
    ["未结购物车", snapshot.open_carts],
    ["未支付订单", snapshot.open_orders],
    ["活动规格", snapshot.activity_skus],
    ["赠品配置", snapshot.promotion_gifts],
    ["促销关系", snapshot.promotion_relations],
    ["抽奖奖品", snapshot.lottery_prizes],
    ["门店规格", snapshot.branch_skus],
  ].flatMap(([label, value]) => Number(value) > 0 ? [`${label}${value}`] : []);
}

function assertTrustedScope(scope: ProductSkuRetirementScope): void {
  const platform = scope.surface === "admin" && scope.ownerType === 0 && scope.relationId === 0;
  const supplier = scope.surface === "supplier" && scope.ownerType === 2
    && Number.isSafeInteger(scope.relationId) && scope.relationId > 0;
  if (!platform && !supplier) throw new ValidateException("商品归属范围无效");
}

export class ProductSkuRetirementService {
  constructor(private readonly container: Container) {}

  async change(
    action: "retire" | "restore",
    body: unknown,
    actor: ProductEditorActor,
    scope: ProductSkuRetirementScope,
  ): Promise<{ changed: number; verified: true; dependencies: ProductSkuDependencySnapshot }> {
    const input = parseProductSkuRetirementInput(body);
    assertTrustedScope(scope);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      await lockProductWrite(tx, input.productId);
      // Match the normal admin editor's lock order, and serialize with Out/supplier
      // SKU identity and inventory writes before locking mutable rows.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        ${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},
        ${PRODUCT_SKU_IDENTITY_LOCK_KEY}
      )`);
      const products = await tx.select({
        id: storeProduct.id,
        type: storeProduct.type,
        relationId: storeProduct.relationId,
        productType: storeProduct.productType,
        specType: storeProduct.specType,
        isDel: storeProduct.isDel,
      }).from(storeProduct).where(and(
        eq(storeProduct.id, input.productId),
        eq(storeProduct.type, scope.ownerType),
        eq(storeProduct.relationId, scope.relationId),
        eq(storeProduct.isDel, 0),
      )).limit(1).for("update");
      const product = products[0];
      if (!product) {
        throw new NotFoundException(scope.surface === "supplier"
          ? "商品不存在或不属于当前供应商"
          : "平台自营商品不存在或已删除");
      }
      if (product.productType !== 0) throw new ValidateException("当前阶段仅支持实物商品SKU退役");
      const expectedStatus = action === "retire" ? 0 : 1;
      const skus = await tx.select().from(storeProductAttrValue).where(and(
        eq(storeProductAttrValue.productId, input.productId),
        eq(storeProductAttrValue.type, PRODUCT_SKU_TYPE),
        inArray(storeProductAttrValue.id, input.skuIds),
        eq(storeProductAttrValue.isRetired, expectedStatus),
      )).orderBy(storeProductAttrValue.id).for("update");
      if (skus.length !== input.skuIds.length) {
        throw new ValidateException(action === "retire" ? "SKU不存在或已退役" : "SKU不存在或未退役");
      }
      if (
        new Set(skus.map((sku) => sku.suk)).size !== skus.length
        || new Set(skus.map((sku) => sku.unique)).size !== skus.length
      ) throw new ValidateException("SKU身份存在重复，必须先专项清理");
      const dependencies = await dependencySnapshot(tx, input.productId, skus);
      if (action === "retire") {
        const blockers = blockingSummary(dependencies);
        if (blockers.length) throw new ValidateException(`SKU仍被引用：${blockers.join("、")}`);
      }
      const now = Math.floor(Date.now() / 1000);
      await tx.update(storeProductAttrValue).set(action === "retire" ? {
        isRetired: 1,
        retiredAt: now,
        retiredBy: actor.id,
        retireReason: input.reason,
      } : {
        isRetired: 0,
        retiredAt: 0,
        retiredBy: 0,
        retireReason: "",
      }).where(inArray(storeProductAttrValue.id, input.skuIds));
      await rebuildActiveProductSkuState(tx, product, now);
      const dependencyJson = JSON.stringify(dependencies);
      const inserted = await tx.insert(storeProductSkuRetirementLog).values(skus.map((sku) => ({
        productId: input.productId,
        skuId: sku.id,
        uniqueSnapshot: sku.unique,
        sukSnapshot: sku.suk,
        action,
        reason: input.reason,
        actorId: actor.id,
        actorName: actor.name.slice(0, 64),
        actorIp: actor.ip.slice(0, 45),
        dependencySnapshot: dependencyJson,
        addTime: now,
      }))).returning({ id: storeProductSkuRetirementLog.id });
      await tx.insert(systemLog).values(skus.map((sku) => ({
        adminId: actor.id,
        adminName: actor.name.slice(0, 64),
        path: scope.surface === "supplier"
          ? `/supplierapi/product/product/sku/${action}`
          : `/adminapi/product/sku/${action}`,
        page: scope.surface === "supplier"
          ? `/products/${input.productId}/edit`
          : `/product/edit/${input.productId}`,
        method: "POST",
        action: `product.sku_${action};product=${input.productId};sku=${sku.id}`,
        ip: actor.ip.slice(0, 45),
        type: "product",
        addTime: now,
      })));
      const readback = await tx.select({
        id: storeProductAttrValue.id,
        isRetired: storeProductAttrValue.isRetired,
      }).from(storeProductAttrValue).where(inArray(storeProductAttrValue.id, input.skuIds));
      const wantedStatus = action === "retire" ? 1 : 0;
      if (
        readback.length !== input.skuIds.length
        || readback.some((row) => row.isRetired !== wantedStatus)
        || inserted.length !== input.skuIds.length
      ) throw new Error("商品SKU退役日志数据库回读校验失败");
      return { changed: input.skuIds.length, verified: true, dependencies };
    });
  }
}
