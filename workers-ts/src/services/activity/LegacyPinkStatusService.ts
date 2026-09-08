import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { storeCombination, storeOrder, storePink, storeProduct, storeProductAttr, storeProductAttrValue, user } from "@/models/schema";
import { AuthException, NotFoundException, ValidateException } from "@/utils/errors";
import { normalizeConfigScalar } from "@/utils/config";
import { parseLegacyProductAttrValues } from "@/services/product/StoreProductService";

const MAX_MEMBERS = 500, MAX_SKUS = 500, MAX_ATTRS = 64, MAX_REDIRECTS = 32, MAX_HOSTS = 20;
const pinkFields = {
  id: storePink.id, uid: storePink.uid, nickname: storePink.nickname, avatar: storePink.avatar,
  combinationId: storePink.combinationId, productId: storePink.productId, kId: storePink.kId,
  people: storePink.people, status: storePink.status, stopTime: storePink.stopTime,
  isRefund: storePink.isRefund, isVirtual: storePink.isVirtual, addTime: storePink.addTime,
};
type Pink = Pick<typeof storePink.$inferSelect, keyof typeof pinkFields>;
const comboFields = {
  id: storeCombination.id, product_id: storeCombination.productId, title: storeCombination.storeName,
  image: storeCombination.image, price: storeCombination.price, ot_price: storeCombination.otPrice,
  people: storeCombination.people, num: storeCombination.num, once_num: storeCombination.onceNum,
  quota: storeCombination.quota, quota_show: storeCombination.quotaShow, unit_name: storeCombination.unitName,
  delivery_type: storeCombination.deliveryType, is_support_refund: storeCombination.isSupportRefund,
  product_price: storeProduct.price, total: sql<number>`(${storeProduct.sales} + ${storeProduct.ficti})::int`,
};

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}
export function legacyPinkId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || !validId(Number(value))) {
    throw new ValidateException("拼团记录ID无效");
  }
  return Number(value);
}
function image(value: string): string {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return "";
  if (/^\/(?!\/)/u.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? value : ""; }
  catch { return ""; }
}
function unix(value: Date | null): number {
  if (value === null) return 0;
  if (!Number.isFinite(value.getTime())) throw new ValidateException("拼团时间数据无效");
  return Math.floor(value.getTime() / 1000);
}
function publicPink(row: Pink) {
  return { id: row.id, uid: row.uid, nickname: row.nickname, avatar: image(row.avatar),
    cid: row.combinationId, pid: row.productId, k_id: row.kId, people: row.people,
    status: row.status, stop_time: unix(row.stopTime), is_refund: row.isRefund,
    is_virtual: row.isVirtual, add_time: row.addTime };
}

/** PHP /combination/pink/:id reads a pink record, NOT an activity.
 * One read-only snapshot; completion/refunds stay in PinkLifecycleService and
 * scheduled maintenance. A GET must never settle orders or contact providers.
 */
export class LegacyPinkStatusService {
  constructor(private readonly container: Container) {}

  async read(uid: number, rawId: unknown, now = new Date()) {
    const id = legacyPinkId(rawId);
    if (!validId(uid)) throw new AuthException();
    if (!Number.isFinite(now.getTime())) throw new ValidateException("拼团查询时间无效");
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      return new LegacyPinkStatusService(createContainerFromDb(tx)).snapshot(uid, id, now);
    });
  }

  private async snapshot(uid: number, id: number, now: Date) {
    const db = this.container.db;
    const [current] = await db.select({ uid: user.uid, nickname: user.nickname, avatar: user.avatar, vip: user.isMoneyLevel })
      .from(user).where(and(eq(user.uid, uid), eq(user.status, 1), eq(user.isDel, 0))).limit(1);
    if (!current) throw new AuthException("请重新登录");
    const seen = new Set<number>();
    let record: Pink | undefined, origin: Pick<Pink, "combinationId" | "productId"> | undefined;
    // PHP recursively follows is_refund. Bound depth and reject cycles/foreign activities.
    for (let depth = 0; depth < MAX_REDIRECTS; depth++) {
      if (seen.has(id)) throw new ValidateException("拼团退款指向循环");
      seen.add(id);
      [record] = await db.select(pinkFields).from(storePink).where(eq(storePink.id, id)).limit(1);
      if (!record) throw new NotFoundException("拼团记录不存在");
      if (origin && (origin.combinationId !== record.combinationId || origin.productId !== record.productId)) {
        throw new ValidateException("拼团退款指向不匹配");
      }
      origin ??= record;
      if (!record.isRefund) break;
      if (record.isRefund === record.id) throw new ValidateException("订单已退款");
      if (!validId(record.isRefund)) throw new ValidateException("拼团退款指向无效");
      id = record.isRefund; record = undefined;
    }
    if (!record) throw new ValidateException("拼团退款指向层级过多");
    const [leader] = record.kId === 0 ? [record] : await db.select(pinkFields).from(storePink).where(eq(storePink.id, record.kId)).limit(1);
    if (!leader || leader.kId !== 0 || leader.isRefund !== 0 || leader.combinationId !== record.combinationId || leader.productId !== record.productId) {
      throw new ValidateException("拼团团长记录无效");
    }
    if (!validId(leader.people) || leader.people > MAX_MEMBERS || ![1, 2, 3].includes(leader.status)) {
      throw new ValidateException("拼团人数或状态数据无效");
    }
    const visible = and(eq(storeCombination.status, 1), eq(storeCombination.isShow, 1), eq(storeCombination.isDel, 0),
      eq(storeProduct.isShow, 1), eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1),
      ...(!current.vip ? [eq(storeProduct.isVipProduct, 0)] : []),
      sql`(${storeCombination.startTime} IS NULL OR ${storeCombination.startTime} <= ${now})`,
      sql`(${storeCombination.stopTime} IS NULL OR ${storeCombination.stopTime} >= ${now})`);
    const [combination] = await db.select(comboFields).from(storeCombination)
      .innerJoin(storeProduct, eq(storeProduct.id, storeCombination.productId))
      .where(and(visible, eq(storeCombination.id, leader.combinationId), eq(storeCombination.productId, leader.productId))).limit(1);
    if (!combination) throw new NotFoundException("拼团不存在或已下架，请从订单申请售后");
    const [members, hosts, configs, ownOrders, attrs] = await Promise.all([
      db.select(pinkFields).from(storePink).where(and(eq(storePink.kId, leader.id), eq(storePink.isRefund, 0)))
        .orderBy(asc(storePink.id)).limit(MAX_MEMBERS + 1),
      db.select(comboFields).from(storeCombination).innerJoin(storeProduct, eq(storeProduct.id, storeCombination.productId))
        .where(and(visible, eq(storeCombination.isHost, 1))).orderBy(desc(storeCombination.id)).limit(MAX_HOSTS + 1),
      this.container.systemConfigDao.getValuesWithPresence(["store_func_status", "store_self_mention"]),
      // Do not expose order IDs embedded in other members' rows or trust an untyped
      // order_id_key. Join canonically, with owner/activity/type/deletion checks.
      db.select({ orderId: storeOrder.orderId }).from(storePink).innerJoin(storeOrder,
        eq(storeOrder.id, sql<number>`CASE WHEN ${storePink.orderIdKey} ~ '^[1-9][0-9]{0,9}$'
          THEN ${storePink.orderIdKey}::bigint ELSE NULL END`))
        .where(and(or(eq(storePink.id, leader.id), eq(storePink.kId, leader.id)), eq(storePink.uid, uid),
          eq(storePink.combinationId, leader.combinationId), eq(storePink.productId, leader.productId), eq(storePink.isRefund, 0),
          eq(storeOrder.uid, uid), eq(storeOrder.type, 3), eq(storeOrder.activityId, leader.combinationId),
          eq(storeOrder.pinkId, leader.id),
          eq(storeOrder.isDel, 0), eq(storeOrder.isSystemDel, 0)))
        .orderBy(desc(storePink.id)).limit(1),
      this.attributes(leader.combinationId, leader.productId),
    ]);
    if (members.length + 1 > MAX_MEMBERS || members.some(row => row.combinationId !== leader.combinationId || row.productId !== leader.productId || ![1, 2, 3].includes(row.status))) {
      throw new ValidateException("拼团成员数据无效或超过500人");
    }
    const count = Math.max(0, leader.people - members.length - 1);
    const joined = leader.uid === uid || members.some(row => row.uid === uid);
    const expired = leader.stopTime === null || leader.stopTime.getTime() <= now.getTime();
    // Never invent committed success/refund from cached member_count or a clock.
    const pending = leader.status === 1 && (expired || count === 0);
    const enabled = configs.store_func_status?.exists ? Number(normalizeConfigScalar(configs.store_func_status.value)) === 1 : true;
    const mention = enabled && configs.store_self_mention?.exists && Number(normalizeConfigScalar(configs.store_self_mention.value)) === 1;
    const projectCombination = (row: typeof combination) => ({ ...row, image: image(row.image),
      delivery_type: row.delivery_type.split(",").filter(Boolean), pink_count: Math.max(0, row.quota_show - row.quota) });
    return {
      userInfo: { uid: current.uid, nickname: current.nickname, avatar: image(current.avatar) },
      is_ok: leader.status === 2 ? 1 : 0, userBool: joined ? 1 : 0,
      pinkBool: leader.status === 2 ? 1 : leader.status === 3 ? -1 : 0,
      pinkT: publicPink(leader), pinkAll: members.map(publicPink), count,
      store_combination: { ...projectCombination(combination), ...attrs },
      store_combination_host: hosts.slice(0, MAX_HOSTS).map(projectCombination),
      current_pink_order: ownOrders[0]?.orderId ?? null,
      store_func_status: enabled ? 1 : 0, store_self_mention: mention ? 1 : 0,
      // Safe extensions for the replacement status page; old clients may ignore them.
      resolved_pink_id: record.id, settlement_pending: pending,
      state: leader.status === 2 ? "success" : leader.status === 3 ? "failed" : pending ? "settlement_pending" : "active",
      store_combination_host_truncated: hosts.length > MAX_HOSTS,
    };
  }

  private async attributes(activityId: number, productId: number) {
    const db = this.container.db;
    const [allAttrs, activity, base] = await Promise.all([
      db.select().from(storeProductAttr).where(or(and(eq(storeProductAttr.productId, activityId), eq(storeProductAttr.type, 3)),
        and(eq(storeProductAttr.productId, productId), eq(storeProductAttr.type, 0)))).orderBy(asc(storeProductAttr.id)).limit(MAX_ATTRS * 2 + 1),
      db.select({ id: storeProductAttrValue.id, unique: storeProductAttrValue.unique, suk: storeProductAttrValue.suk,
        price: storeProductAttrValue.price, ot_price: storeProductAttrValue.otPrice, stock: storeProductAttrValue.stock,
        quota: storeProductAttrValue.quota, quota_show: storeProductAttrValue.quotaShow, image: storeProductAttrValue.image })
        .from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, activityId), eq(storeProductAttrValue.type, 3), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
      db.select({ suk: storeProductAttrValue.suk, stock: storeProductAttrValue.stock, price: storeProductAttrValue.price })
        .from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0), eq(storeProductAttrValue.isRetired, 0)))
        .orderBy(asc(storeProductAttrValue.id)).limit(MAX_SKUS + 1),
    ]);
    if (activity.length > MAX_SKUS || base.length > MAX_SKUS || allAttrs.length > MAX_ATTRS * 2 || allAttrs.some(row => row.attrValues.length > 32_768)) {
      throw new ValidateException("拼团规格数量或属性内容超限");
    }
    if (new Set(base.map(row => row.suk)).size !== base.length || new Set(activity.map(row => row.suk)).size !== activity.length ||
      new Set(activity.map(row => row.unique)).size !== activity.length || activity.some(row => !row.unique.trim())) throw new ValidateException("拼团规格标识不唯一或无效");
    const baseBySuk = new Map(base.map(row => [row.suk, row]));
    const chosenAttrs = allAttrs.some(row => row.type === 3) ? allAttrs.filter(row => row.type === 3) : allAttrs.filter(row => row.type === 0);
    if (chosenAttrs.length > MAX_ATTRS) throw new ValidateException("拼团属性数量超限");
    const productAttr = chosenAttrs.map((row, index) => {
      const allowed = new Set(activity.map(sku => sku.suk.split(",")[index]));
      const values = parseLegacyProductAttrValues(row.attrValues).filter(value => allowed.has(value));
      return { id: row.id, product_id: row.productId, type: row.type, attr_name: row.attrName,
        attr_values: values, attr_value: values.map(attr => ({ attr, check: false })) };
    });
    const productValue = Object.fromEntries(activity.map(row => {
      const original = baseBySuk.get(row.suk), stock = Math.max(0, original?.stock ?? 0);
      return [row.suk, { ...row, image: image(row.image), small_image: image(row.image), product_id: activityId, type: 3,
        stock: stock > 0 ? Math.max(0, row.stock) : 0, quota: stock > 0 ? Math.max(0, row.quota) : 0,
        product_stock: stock, product_price: original?.price ?? "0.00" }];
    }));
    return { productAttr, productValue };
  }
}
