import { and, asc, desc, eq, gt, inArray, isNull, not, or, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { storeCombination, storeOrder, storePink, storeProduct, storeProductAttrValue } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { pendingPinkCancellationExists } from "./PinkCancellationIntent";

const MAX_SKUS = 500;
const MAX_GROUPS = 5;

function id(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new ValidateException(`${label}ID无效`);
  }
  return Number(value);
}

function integer(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
    throw new ValidateException(`拼团${label}配置无效`);
  }
  return value;
}

function money(value: string): string {
  if (!/^\d{1,10}\.\d{2}$/.test(value)) throw new ValidateException("拼团规格价格配置无效");
  return value;
}

function imageUrl(value: string): string {
  if (!value || value.length > 2_048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return "";
  if (/^\/(?!\/)/u.test(value)) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? value : "";
  } catch { return ""; }
}

function validDate(value: Date | null): boolean {
  return value === null || Number.isFinite(value.getTime());
}

/** Read-only selection snapshot. It is not a quote, cumulative allowance or seat reservation.
 * Activity IDs, base product IDs and group leader IDs belong to different namespaces.
 * Checkout must recheck mutable data under its existing transactional locks.
 */
export class CombinationSkuCatalogService {
  constructor(private readonly container: Container) {}

  async read(uid: number, rawId: unknown, rawPinkId?: unknown, now = new Date()) {
    const combinationId = id(rawId, "拼团活动");
    const pinkId = rawPinkId === undefined ? 0 : id(rawPinkId, "拼团团长");
    if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isFinite(now.getTime())) {
      throw new ValidateException("拼团规格查询参数无效");
    }
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      return new CombinationSkuCatalogService(createContainerFromDb(tx)).snapshot(uid, combinationId, pinkId, now);
    });
  }

  private async snapshot(uid: number, combinationId: number, pinkId: number, now: Date) {
    const current = uid > 0 ? await this.container.userDao.findForAuth(uid) : null;
    if (uid > 0 && (!current || current.status !== 1)) throw new ValidateException("请重新登录");
    const [entry] = await this.container.db.select({
      productId: storeCombination.productId, title: storeCombination.storeName, image: storeCombination.image,
      people: storeCombination.people, stock: storeCombination.stock, quota: storeCombination.quota,
      onceNum: storeCombination.onceNum, totalNum: storeCombination.num,
      startTime: storeCombination.startTime, stopTime: storeCombination.stopTime,
      productStock: storeProduct.stock, productImage: storeProduct.image,
    }).from(storeCombination).innerJoin(storeProduct, eq(storeProduct.id, storeCombination.productId))
      .where(and(eq(storeCombination.id, combinationId), eq(storeCombination.status, 1),
        eq(storeCombination.isShow, 1), eq(storeCombination.isDel, 0), eq(storeProduct.isShow, 1),
        eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1),
        ...(!current?.isMoneyLevel ? [eq(storeProduct.isVipProduct, 0)] : [])))
      .limit(1);
    if (!entry) throw new NotFoundException("拼团商品不存在或不可见");
    integer(entry.people, "人数", 1);
    integer(entry.onceNum, "限购", 1); integer(entry.totalNum, "限购", 1);
    if (!validDate(entry.startTime) || !validDate(entry.stopTime) ||
      entry.startTime && entry.stopTime && entry.startTime > entry.stopTime) {
      throw new ValidateException("拼团日期配置无效");
    }
    const baseStock = Math.min(integer(entry.stock, "库存"), integer(entry.quota, "库存"), integer(entry.productStock, "库存"));
    const fields = { unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
      stock: storeProductAttrValue.stock, quota: storeProductAttrValue.quota,
      price: storeProductAttrValue.price, otPrice: storeProductAttrValue.otPrice, image: storeProductAttrValue.image };
    const [activityRows, baseRows, groupData] = await Promise.all([
      this.container.db.select(fields).from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.productId, combinationId), eq(storeProductAttrValue.type, 3), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
      this.container.db.select({ unique: fields.unique, suk: fields.suk, stock: fields.stock }).from(storeProductAttrValue)
        .where(and(eq(storeProductAttrValue.productId, entry.productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
      this.groups(uid, combinationId, pinkId, now),
    ]);
    for (const rows of [activityRows, baseRows]) {
      if (rows.length > MAX_SKUS) throw new ValidateException("拼团规格超过500项，请先整理规格配置");
      const uniques = new Set<string>(), labels = new Set<string>();
      for (const row of rows) {
        if (!row.unique || row.unique.length > 8 || /[\s\u0000-\u001f\u007f]/u.test(row.unique) ||
          uniques.has(row.unique) || labels.has(row.suk)) {
          throw new ValidateException("拼团或基础商品规格标识不唯一或无效");
        }
        if (row.suk !== row.suk.trim()) throw new ValidateException("拼团规格名称配置无效");
        integer(row.stock, "库存");
        uniques.add(row.unique); labels.add(row.suk);
      }
    }
    const bySuk = new Map(baseRows.map(row => [row.suk, row]));
    const byUnique = new Map(baseRows.map(row => [row.unique, row]));
    const skus = activityRows.map(row => {
      if (!row.suk && activityRows.length > 1) throw new ValidateException("多规格拼团缺少规格名称");
      const base = bySuk.get(row.suk);
      if (!base) throw new ValidateException("拼团规格缺少有效基础规格，请先整理规格配置");
      const collision = byUnique.get(row.unique);
      if (collision && collision.suk !== row.suk) throw new ValidateException("拼团与基础规格标识冲突，请先整理规格配置");
      const available = Math.min(baseStock, row.stock, integer(row.quota, "库存"), base.stock);
      return { unique: row.unique, base_unique: base.unique, suk: row.suk,
        catalog_price: money(row.price), ot_price: money(row.otPrice),
        image: imageUrl(row.image) || imageUrl(entry.image) || imageUrl(entry.productImage),
        stock: available, max_quantity: Math.min(available, entry.onceNum, entry.totalNum, 32_767) };
    });
    return { selection_only: true as const, type: 3 as const, combination_id: combinationId, product_id: entry.productId,
      title: entry.title, image: imageUrl(entry.image) || imageUrl(entry.productImage), people: entry.people,
      once_limit: entry.onceNum, total_limit: entry.totalNum,
      start_time: entry.startTime?.toISOString() ?? null, stop_time: entry.stopTime?.toISOString() ?? null,
      // Combination uses the existing inclusive timestamp endpoint, not seckill's whole-day rule.
      date_window: entry.startTime && entry.startTime > now ? "future" as const
        : entry.stopTime && entry.stopTime < now ? "ended" as const : "active" as const,
      skus, ...groupData };
  }

  private async groups(uid: number, combinationId: number, pinkId: number, now: Date) {
    const fields = { id: storePink.id, combinationId: storePink.combinationId, people: storePink.people, stopTime: storePink.stopTime };
    const liveLeader = and(eq(storePink.combinationId, combinationId), eq(storePink.kId, 0),
      eq(storePink.status, 1), eq(storePink.isRefund, 0), or(isNull(storePink.stopTime), gt(storePink.stopTime, now)));
    const [suggested, requested] = await Promise.all([
      this.container.db.select(fields).from(storePink).where(and(liveLeader, not(pendingPinkCancellationExists())))
        .orderBy(desc(storePink.addTime), desc(storePink.id)).limit(MAX_GROUPS),
      pinkId ? this.container.db.select({ ...fields, cancellationPending: pendingPinkCancellationExists() }).from(storePink)
        .where(and(liveLeader, eq(storePink.id, pinkId))).limit(1) : Promise.resolve([]),
    ]);
    if (pinkId && !requested[0]) throw new ValidateException("指定拼团不存在、已结束或不是本活动团长");
    if (requested[0]?.cancellationPending) throw new ValidateException("指定拼团团长取消处理中，暂不能参团");
    const leaders = new Map([...suggested, ...requested].map(row => [row.id, row]));
    if (!leaders.size) return { groups: [], requested_group: null };
    const ids = [...leaders.keys()];
    // Exactly reservePinkJoin's predicates: count real active member rows and all
    // unpaid, undeleted type-3 pending orders linked to each leader, never memberCount.
    // Anonymous requests do not evaluate a UID predicate or perform personal lookups.
    const groupId = sql<number>`CASE WHEN ${storePink.kId} = 0 THEN ${storePink.id} ELSE ${storePink.kId} END`;
    const [members, reservations] = await Promise.all([
      this.container.db.select({ id: groupId, count: sql<number>`COUNT(*)::int`,
        joined: uid > 0 ? sql<boolean>`BOOL_OR(${storePink.uid} = ${uid})` : sql<boolean>`false` })
        .from(storePink).where(and(or(inArray(storePink.id, ids), inArray(storePink.kId, ids)),
          eq(storePink.isRefund, 0), inArray(storePink.status, [1, 2])))
        .groupBy(groupId),
      this.container.db.select({ id: storeOrder.pinkId, count: sql<number>`COUNT(*)::int`,
        pending: uid > 0 ? sql<boolean>`BOOL_OR(${storeOrder.uid} = ${uid})` : sql<boolean>`false` })
        .from(storeOrder).where(and(inArray(storeOrder.pinkId, ids), eq(storeOrder.type, 3),
          eq(storeOrder.paid, 0), eq(storeOrder.status, 0), eq(storeOrder.isDel, 0)))
        .groupBy(storeOrder.pinkId),
    ]);
    const memberCounts = new Map(members.map(row => [row.id, row]));
    const reservationCounts = new Map(reservations.map(row => [row.id, row]));
    const groups = new Map([...leaders].map(([key, leader]) => {
      const required = integer(leader.people, "人数", 1);
      if (!validDate(leader.stopTime)) throw new ValidateException("拼团日期配置无效");
      const active = integer(memberCounts.get(key)?.count ?? 0, "人数");
      const reserved = integer(reservationCounts.get(key)?.count ?? 0, "人数");
      return [key, { id: key, combination_id: combinationId, required_people: required,
        active_people: active, reserved_people: reserved, available_places: Math.max(0, required - active - reserved),
        already_joined: memberCounts.get(key)?.joined ?? false,
        has_pending_order: reservationCounts.get(key)?.pending ?? false,
        stop_time: leader.stopTime?.toISOString() ?? null }] as const;
    }));
    return { groups: suggested.map(row => groups.get(row.id)!), requested_group: pinkId ? groups.get(pinkId)! : null };
  }
}
