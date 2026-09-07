import { and, eq, inArray, or, sql } from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import { storeCart, storeOrder, storeProduct, storeSeckill } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { resolveLegacyActivitySkuPair } from "./ActivityOrderSkuService";
import { assertSeckillSchedule, loadSeckillSchedule } from "./SeckillScheduleService";

/** Quantity is not a reservation. Lock only the cart to serialize with order claim;
 * dependency reads intentionally take no row locks (create locks activity before cart).
 * Mutable activity/stock rules are checked again by the order transaction.
 */
export async function setSeckillCartQuantity(container: Container, uid: number, id: number, quantity: number): Promise<void> {
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(id) || id <= 0 ||
    !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 32767) {
    throw new ValidateException("购物车参数错误");
  }
  await withTx(container, async tx => {
    const scope = and(eq(storeCart.id, id), eq(storeCart.uid, uid), eq(storeCart.type, 1),
      eq(storeCart.isPay, 0), eq(storeCart.isDel, 0), eq(storeCart.status, 1),
      eq(storeCart.staffId, 0), eq(storeCart.touristUid, ""), eq(storeCart.storeId, 0));
    const [cart] = await tx.select().from(storeCart).where(scope).limit(1).for("update");
    if (!cart) throw new NotFoundException("购物车项不存在或已下单");
    if (!cart.productAttrUnique.trim()) throw new ValidateException("商品规格标识无效");
    const schedule = await loadSeckillSchedule(tx, cart.activityId);
    assertSeckillSchedule(schedule);
    const [activity] = await tx.select().from(storeSeckill).where(eq(storeSeckill.id, cart.activityId)).limit(1);
    if (!activity || activity.productId !== cart.productId || activity.activityId !== schedule.child.activityId) {
      throw new ValidateException("秒杀商品关联已变化");
    }
    // The second child read must not silently accept a now disabled child.
    const window = assertSeckillSchedule({ ...schedule, child: activity });
    const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, cart.productId)).limit(1);
    if (!product || product.isShow !== 1 || product.isDel !== 0 || product.isVerify !== 1) {
      throw new ValidateException("商品已下架或未审核通过");
    }
    const { activitySku, baseSku } = await resolveLegacyActivitySkuPair(tx, {
      activityId: activity.id, productId: product.id, type: 1, unique: cart.productAttrUnique,
    });
    if (activity.onceNum <= 0 || activity.num <= 0) throw new ValidateException("秒杀限购配置无效");
    if (quantity > activity.onceNum) throw new ValidateException(`每个订单限购 ${activity.onceNum} 件`);
    const [purchased] = await tx.select({ total: sql<string>`COALESCE(SUM(${storeOrder.totalNum}), 0)::text` })
      .from(storeOrder).where(and(eq(storeOrder.uid, uid), eq(storeOrder.type, 1),
        eq(storeOrder.activityId, activity.id), inArray(storeOrder.pid, [0, -1]),
        or(eq(storeOrder.paid, 1), and(eq(storeOrder.paid, 0), eq(storeOrder.isDel, 0)))));
    const total = Number(purchased?.total ?? 0);
    if (!Number.isSafeInteger(total) || total < 0 || total + quantity > activity.num) {
      throw new ValidateException(`每人累计限购 ${activity.num} 件`);
    }
    const available = Math.min(activity.stock, activity.quota, activitySku.stock, activitySku.quota, baseSku.stock, product.stock);
    if (quantity > available) throw new ValidateException(`秒杀库存不足, 当前库存 ${Math.max(available, 0)}`);
    const changed = await tx.update(storeCart).set({ cartNum: quantity }).where(and(scope,
      sql`extract(epoch from clock_timestamp()) * 1000 >= ${window.startsAt}`,
      sql`extract(epoch from clock_timestamp()) * 1000 < ${window.endsAt}`,
    )).returning({ id: storeCart.id });
    if (!changed.length) throw new ValidateException("秒杀时段已结束或购物车已下单");
  });
}
