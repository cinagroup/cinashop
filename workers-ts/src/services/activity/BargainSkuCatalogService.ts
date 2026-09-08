import { and, asc, eq, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { storeBargain, storeProduct, storeProductAttrValue } from "@/models/schema";
import { findBargainParticipation } from "./BargainParticipationSelection";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { centsToDecimal } from "@/services/order/OrderBrokerageService";

const MAX_SKUS = 500;
function id(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new ValidateException(`${label}ID无效`);
  }
  return Number(value);
}
function integer(value: number, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min || value > 2_147_483_647) throw new ValidateException(`砍价${label}配置无效`);
  return value;
}
function cents(value: string): number {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) throw new ValidateException("砍价金额配置无效");
  const [whole, fraction] = value.split(".");
  return Number(whole) * 100 + Number(fraction);
}
function imageUrl(value: string): string {
  if (!value || value.length > 2_048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return "";
  if (/^\/(?!\/)/u.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? value : "";
  } catch { return ""; }
}
function validDate(value: Date | null): boolean { return value === null || Number.isFinite(value.getTime()); }

/** Bounded, principal-scoped selection snapshot; not a quote or reservation.
 * New Worker states are 1=cutting, 2=closed, 3=cut complete, 4=used by an order.
 * Do not copy PHP's status-3 purchase interpretation into this new view.
 * Existing raw detail, help, start, quote and purchase contracts are unchanged.
 */
export class BargainSkuCatalogService {
  constructor(private readonly container: Container) {}

  async read(uid: number, rawId: unknown, rawParticipationId?: unknown, now = new Date()) {
    const bargainId = id(rawId, "砍价活动");
    const participationId = rawParticipationId === undefined ? 0 : id(rawParticipationId, "砍价记录");
    if (!Number.isSafeInteger(uid) || uid < 0 || uid > 2_147_483_647 || !Number.isFinite(now.getTime())) {
      throw new ValidateException("砍价规格查询参数无效");
    }
    if (participationId && !uid) throw new ValidateException("请先登录查看自己的砍价记录");
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql.raw(`SELECT
        pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
        pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
      return new BargainSkuCatalogService(createContainerFromDb(tx)).snapshot(uid, bargainId, participationId, now);
    });
  }

  private async snapshot(uid: number, bargainId: number, participationId: number, now: Date) {
    const current = uid > 0 ? await this.container.userDao.findForAuth(uid) : null;
    if (uid > 0 && (!current || current.status !== 1)) throw new ValidateException("请重新登录");
    const [entry] = await this.container.db.select({
      productId: storeBargain.productId, title: storeBargain.title, storeName: storeBargain.storeName,
      image: storeBargain.image, stock: storeBargain.stock, quota: storeBargain.quota,
      price: storeBargain.price, minimum: storeBargain.minPrice, people: storeBargain.people,
      startTime: storeBargain.startTime, stopTime: storeBargain.stopTime,
      productStock: storeProduct.stock, productImage: storeProduct.image,
    }).from(storeBargain).innerJoin(storeProduct, eq(storeProduct.id, storeBargain.productId))
      .where(and(eq(storeBargain.id, bargainId), eq(storeBargain.status, 1), eq(storeBargain.isDel, 0),
        eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1),
        ...(!current?.isMoneyLevel ? [eq(storeProduct.isVipProduct, 0)] : [])))
      .limit(1);
    if (!entry) throw new NotFoundException("砍价商品不存在或不可见");
    if (!validDate(entry.startTime) || !validDate(entry.stopTime) || entry.startTime && entry.stopTime && entry.startTime > entry.stopTime) {
      throw new ValidateException("砍价日期配置无效");
    }
    if (cents(entry.minimum) > cents(entry.price)) throw new ValidateException("砍价底价不能超过起价");
    integer(entry.people, "帮砍人数", 1);
    const baseStock = Math.min(integer(entry.stock, "库存"), integer(entry.quota, "库存"), integer(entry.productStock, "库存"));
    const fields = { unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
      stock: storeProductAttrValue.stock, quota: storeProductAttrValue.quota,
      image: storeProductAttrValue.image };
    const [activityRows, baseRows, participation] = await Promise.all([
      this.container.db.select(fields).from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.productId, bargainId), eq(storeProductAttrValue.type, 2), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
      this.container.db.select({ unique: fields.unique, suk: fields.suk, stock: fields.stock }).from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.productId, entry.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
      this.participation(uid, bargainId, participationId, entry.price),
    ]);
    for (const rows of [activityRows, baseRows]) {
      if (rows.length > MAX_SKUS) throw new ValidateException("砍价规格超过500项，请先整理规格配置");
      const uniques = new Set<string>(), labels = new Set<string>();
      for (const row of rows) {
        if (!row.unique || row.unique.length > 8 || /[\s\u0000-\u001f\u007f]/u.test(row.unique) ||
          uniques.has(row.unique) || labels.has(row.suk) || row.suk !== row.suk.trim()) {
          throw new ValidateException("砍价或基础商品规格标识不唯一或无效");
        }
        integer(row.stock, "库存"); uniques.add(row.unique); labels.add(row.suk);
      }
    }
    const bySuk = new Map(baseRows.map(row => [row.suk, row])), byUnique = new Map(baseRows.map(row => [row.unique, row]));
    const skus = activityRows.map(row => {
      if (!row.suk && activityRows.length > 1) throw new ValidateException("多规格砍价缺少规格名称");
      const base = bySuk.get(row.suk);
      if (!base) throw new ValidateException("砍价规格缺少有效基础规格，请先整理规格配置");
      if (byUnique.has(row.unique) && byUnique.get(row.unique)!.suk !== row.suk) throw new ValidateException("砍价与基础规格标识冲突");
      const available = Math.min(baseStock, row.stock, integer(row.quota, "库存"), base.stock);
      return { unique: row.unique, base_unique: base.unique, suk: row.suk, stock: available,
        // Existing type-2 checkout prices the participation, NOT the activity SKU's price.
        catalog_price: participation?.catalog_price ?? null, max_quantity: Math.min(available, 32_767),
        image: imageUrl(row.image) || imageUrl(entry.image) || imageUrl(entry.productImage) };
    });
    const dateWindow = entry.startTime && entry.startTime > now ? "future" as const
      : entry.stopTime && entry.stopTime < now ? "ended" as const : "active" as const;
    return { selection_only: true as const, type: 2 as const, bargain_id: bargainId, product_id: entry.productId,
      title: entry.title || entry.storeName, image: imageUrl(entry.image) || imageUrl(entry.productImage),
      activity_price: entry.price, minimum_price: entry.minimum, people: entry.people,
      start_time: entry.startTime?.toISOString() ?? null, stop_time: entry.stopTime?.toISOString() ?? null,
      date_window: dateWindow, participation, skus,
      can_select: dateWindow === "active" && participation?.state === "ready" && skus.some(sku => sku.max_quantity > 0) };
  }

  private async participation(uid: number, bargainId: number, requestedId: number, activityPrice: string) {
    if (!uid) return null;
    const participant = await findBargainParticipation(this.container.db, uid, bargainId, requestedId || undefined);
    const record = participant ? { id: participant.id, status: participant.status, original: participant.bargainPrice,
      minimum: participant.bargainPriceMin, cut: participant.price } : null;
    if (!record) {
      if (requestedId) throw new NotFoundException("指定砍价记录不存在或不属于当前用户及活动");
      return null;
    }
    if (![1, 2, 3, 4].includes(record.status)) throw new ValidateException("砍价记录状态无效");
    const original = cents(record.original), minimum = cents(record.minimum), cut = cents(record.cut);
    if (minimum > original || cut > original - minimum) throw new ValidateException("砍价记录金额异常");
    const remaining = original - minimum - cut;
    if (record.status === 3 && remaining !== 0) throw new ValidateException("砍价完成状态与金额不一致");
    const state = record.status === 4 ? "used" as const : record.status === 2 ? "closed" as const
      : remaining === 0 ? "ready" as const : "cutting" as const;
    return { id: record.id, status: record.status, state, original_price: record.original, minimum_price: record.minimum,
      cut_price: record.cut, current_price: centsToDecimal(original - cut), remaining_cut: centsToDecimal(remaining),
      // Match the existing checkout compatibility formula, while making any
      // mutable activity-price effect explicit rather than promising the floor.
      catalog_price: centsToDecimal(Math.max(minimum, Math.max(original, cents(activityPrice)) - cut)),
      activity_price_changed: cents(activityPrice) !== original,
      progress_percent: original === minimum ? 100 : Math.floor(cut * 100 / (original - minimum)) };
  }
}
