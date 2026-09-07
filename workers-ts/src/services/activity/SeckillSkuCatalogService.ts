import { and, asc, eq } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { storeActivity, storeProduct, storeProductAttrValue, storeSeckill } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { readSeckillScheduleSlots, seckillDateEnd, seckillScheduleView } from "./SeckillScheduleService";

const MAX_SKUS = 500;

export function seckillSkuId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) {
    throw new ValidateException("秒杀商品ID无效");
  }
  const id = Number(value);
  if (id > 2_147_483_647) throw new ValidateException("秒杀商品ID无效");
  return id;
}

function imageUrl(value: string): string {
  if (!value || value.length > 2_048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return "";
  if (/^\/(?!\/)/u.test(value)) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? value : "";
  } catch { return ""; }
}

function stock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidateException("秒杀库存配置无效");
  return value;
}

function money(value: string): string {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) throw new ValidateException("秒杀规格价格配置无效");
  return value;
}

/** A bounded selection catalogue, NOT an eligibility decision, quote or stock reservation.
 * SKU identity matches ActivityOrderSkuService: (activity id, type=1, suk) ->
 * (base product id, type=0, suk). Checkout must re-read every mutable condition.
 */
export class SeckillSkuCatalogService {
  constructor(private readonly container: Container) {}

  async read(uid: number, rawId: unknown, now = new Date()) {
    const id = seckillSkuId(rawId);
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isFinite(now.getTime())) {
      throw new ValidateException("秒杀规格查询参数无效");
    }
    // Visibility derives from the verified request principal, never a query UID/VIP flag.
    const current = uid > 0 ? await this.container.userDao.findForAuth(uid) : null;
    if (uid > 0 && (!current || current.status !== 1)) throw new ValidateException("请重新登录");
    const [entry] = await this.container.db.select({
      id: storeSeckill.id, parentId: storeSeckill.activityId, productId: storeSeckill.productId,
      title: storeSeckill.storeName, image: storeSeckill.image, stock: storeSeckill.stock,
      quota: storeSeckill.quota, onceNum: storeSeckill.onceNum, totalNum: storeSeckill.num,
      startTime: storeSeckill.startTime, stopTime: storeSeckill.stopTime,
      timeId: storeSeckill.timeId,
      parent: { id: storeActivity.id, type: storeActivity.type, status: storeActivity.status, isDel: storeActivity.isDel,
        startDay: storeActivity.startDay, endDay: storeActivity.endDay, timeId: storeActivity.timeId },
      productStock: storeProduct.stock, productImage: storeProduct.image,
    }).from(storeSeckill).innerJoin(storeProduct, eq(storeProduct.id, storeSeckill.productId))
      .leftJoin(storeActivity, eq(storeActivity.id, storeSeckill.activityId))
      .where(and(eq(storeSeckill.id, id), eq(storeSeckill.status, 1), eq(storeSeckill.isShow, 1),
        eq(storeSeckill.isDel, 0), eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0),
        eq(storeProduct.isVerify, 1), ...(!current?.isMoneyLevel ? [eq(storeProduct.isVipProduct, 0)] : [])))
      .limit(1);
    if (!entry) throw new NotFoundException("秒杀商品不存在或不可见");
    if (entry.onceNum <= 0 || entry.totalNum <= 0) throw new ValidateException("秒杀限购配置无效");
    if (entry.startTime && entry.startTime.getTime() >= seckillDateEnd(entry.stopTime)) {
      throw new ValidateException("秒杀日期配置无效");
    }
    const baseStock = Math.min(stock(entry.stock), stock(entry.quota), stock(entry.productStock));
    const fields = { unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
      stock: storeProductAttrValue.stock, quota: storeProductAttrValue.quota,
      price: storeProductAttrValue.price, otPrice: storeProductAttrValue.otPrice, image: storeProductAttrValue.image };
    // Two indexed, bounded queries, not one resolver call per SKU. +1 detects overflow.
    const [activityRows, baseRows, schedule] = await Promise.all([
      this.container.db.select(fields).from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 1), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
      this.container.db.select({ unique: fields.unique, suk: fields.suk, stock: fields.stock }).from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.productId, entry.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
      readSeckillScheduleSlots(this.container.db, { id: entry.id, activityId: entry.parentId, productId: entry.productId,
        status: 1, isShow: 1, isDel: 0, timeId: entry.timeId, startTime: entry.startTime, stopTime: entry.stopTime }, entry.parent),
    ]);
    for (const rows of [activityRows, baseRows]) {
      if (rows.length > MAX_SKUS) throw new ValidateException("秒杀规格超过500项，请先整理规格配置");
      const uniques = new Set<string>(), labels = new Set<string>();
      for (const row of rows) {
        if (!row.unique || row.unique !== row.unique.trim() || row.unique.length > 8 ||
          /[\u0000-\u0020\u007f]/u.test(row.unique) || uniques.has(row.unique) || labels.has(row.suk)) {
          throw new ValidateException("秒杀或基础商品规格标识不唯一或无效");
        }
        // The order resolver trims suk; whitespace-only labels cannot be bridged reliably.
        if (row.suk !== row.suk.trim()) throw new ValidateException("秒杀规格名称配置无效");
        uniques.add(row.unique); labels.add(row.suk);
      }
    }
    const bySuk = new Map(baseRows.map(row => [row.suk, row]));
    const baseByUnique = new Map(baseRows.map(row => [row.unique, row]));
    const skus = activityRows.map(row => {
      if (!row.suk && activityRows.length > 1) throw new ValidateException("多规格秒杀缺少规格名称");
      const base = bySuk.get(row.suk);
      if (!base) throw new ValidateException("秒杀规格缺少有效基础规格，请先整理规格配置");
      // Both legacy activity uniques and persisted base uniques reach the resolver.
      // A cross-namespace collision naming a DIFFERENT suk is not a safe round trip.
      const collision = baseByUnique.get(row.unique);
      if (collision && collision.suk !== row.suk) throw new ValidateException("秒杀与基础规格标识冲突，请先整理规格配置");
      const available = Math.min(baseStock, stock(row.stock), stock(row.quota), stock(base.stock));
      return { unique: row.unique, base_unique: base.unique, suk: row.suk,
        catalog_price: money(row.price), ot_price: money(row.otPrice), stock: available,
        max_quantity: Math.min(available, entry.onceNum, entry.totalNum, 32_767),
        image: imageUrl(row.image) || imageUrl(entry.image) || imageUrl(entry.productImage) };
    });
    return { selection_only: true as const, type: 1 as const, seckill_id: id, product_id: entry.productId,
      parent_activity_id: entry.parentId, title: entry.title, image: imageUrl(entry.image) || imageUrl(entry.productImage),
      once_limit: entry.onceNum, total_limit: entry.totalNum,
      // Date-window state is deliberately not the time-slot/parent schedule or per-user remaining limit.
      date_window: entry.startTime && entry.startTime > now ? "future" as const
        : now.getTime() >= seckillDateEnd(entry.stopTime) ? "ended" as const : "active" as const,
      schedule: seckillScheduleView(schedule, now),
      start_time: entry.startTime?.toISOString() ?? null, stop_time: entry.stopTime?.toISOString() ?? null,
      skus };
  }
}
