import { and, eq, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { storeCart, storeProduct, storeProductAttrValue, user } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { presaleSchedule } from "./PresaleScheduleService";
import { assertPresalePurchaseLimit, presalePurchaseLimits } from "./PresalePurchaseLimits";

function positiveId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function selection(uid: number, productId: number, unique: string, quantity: number): void {
  if (!positiveId(uid)) throw new ValidateException("请先登录");
  if (!positiveId(productId) || typeof unique !== "string" || !unique || unique.length > 8 || /[\s\x00-\x1f\x7f]/.test(unique)) {
    throw new ValidateException("请选择有效的商品和规格");
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 32767) {
    throw new ValidateException("数量必须为 1 至 32767 的整数");
  }
}

async function boundTransaction(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
  await tx.execute(sql.raw(`SELECT
    pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
    pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),2000)::text || 'ms',true),
    pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
}

/** Cart selection is not inventory/price/limit reservation. Checkout must independently
 * authorize it. Follow checkout's cart -> base SKU -> product order; add uses a fresh
 * cart so it never locks or merges an existing checkout row after the catalogue locks.
 */
async function lockedSelection(tx: DbClient, uid: number, productId: number, unique: string, quantity: number) {
  const [sku] = await tx.select().from(storeProductAttrValue).where(and(
    eq(storeProductAttrValue.productId, productId), eq(storeProductAttrValue.type, 0),
    eq(storeProductAttrValue.unique, unique), eq(storeProductAttrValue.isRetired, 0),
  )).limit(1).for("share");
  if (!sku || sku.unique !== unique) throw new ValidateException("商品规格已失效");
  const [product] = await tx.select().from(storeProduct).where(eq(storeProduct.id, productId)).limit(1).for("share");
  if (!product || product.isShow !== 1 || product.isDel !== 0 || product.isVerify !== 1 || product.isPresaleProduct !== 1) {
    throw new ValidateException("预售商品已失效，请重新选择");
  }
  const [account] = await tx.select({ status: user.status, isDel: user.isDel, isMoneyLevel: user.isMoneyLevel,
    isEverLevel: user.isEverLevel, overdueTime: user.overdueTime }).from(user).where(eq(user.uid, uid)).limit(1);
  if (!account || account.status !== 1 || account.isDel !== 0) throw new ValidateException("用户状态已变化，请重新登录");
  const schedule = presaleSchedule(product);
  if (quantity > sku.stock || quantity > product.stock) throw new ValidateException("预售商品库存不足");
  assertPresalePurchaseLimit(presalePurchaseLimits(product), quantity);
  return { product, schedule, account };
}

async function assertCurrentWindow(tx: DbClient, context: Awaited<ReturnType<typeof lockedSelection>>): Promise<void> {
  const { schedule, product, account } = context;
  // The last check is after INSERT/UPDATE and any lock waits. Transaction-start NOW()
  // and an application timestamp taken before waiting cannot authorize admission.
  const [clock] = await tx.select({
    started: sql<boolean>`clock_timestamp() >= to_timestamp(${schedule.start_time})`,
    active: sql<boolean>`clock_timestamp() < to_timestamp(${schedule.stop_time + 1})`,
    member: sql<boolean>`${account.isEverLevel === 1} OR (${account.isMoneyLevel > 0} AND clock_timestamp() < to_timestamp(${account.overdueTime}))`,
  }).from(sql`(VALUES (1)) AS presale_cart_clock(n)`);
  if (!clock?.started) throw new ValidateException("预售活动未开始");
  if (!clock.active) throw new ValidateException("预售活动已结束");
  if (product.isVipProduct !== 0 && (product.isVipProduct !== 1 || !clock.member)) {
    throw new ValidateException("该预售商品仅限有效付费会员购买");
  }
}

export async function addPresaleCart(container: Container, params: {
  uid: number; productId: number; unique: string; cartNum: number; type?: number; isNew?: number; activityId?: number;
}): Promise<{ id: number; cartNum: number }> {
  selection(params.uid, params.productId, params.unique, params.cartNum);
  if (![0, 6].includes(params.type ?? 0) || (params.isNew ?? 0) !== 1 || (params.activityId ?? 0) !== 0) {
    throw new ValidateException("预售商品请使用立即购买，不能混入其它活动或普通购物车");
  }
  return withTx(container, async tx => {
    await boundTransaction(tx);
    const context = await lockedSelection(tx, params.uid, params.productId, params.unique, params.cartNum);
    const [cart] = await tx.insert(storeCart).values({ uid: params.uid, type: 6, activityId: 0,
      productId: params.productId, productType: context.product.productType, productAttrUnique: params.unique,
      cartNum: params.cartNum, isNew: 1, status: 1, addTime: Math.floor(Date.now() / 1000),
    }).returning({ id: storeCart.id });
    if (!cart) throw new Error("预售购物车写入失败");
    await assertCurrentWindow(tx, context);
    return { id: cart.id, cartNum: params.cartNum };
  });
}

export async function setPresaleCartQuantity(container: Container, uid: number, id: number, quantity: number): Promise<void> {
  if (!positiveId(uid) || !positiveId(id) || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 32767) {
    throw new ValidateException("购物车参数错误");
  }
  await withTx(container, async tx => {
    await boundTransaction(tx);
    const scope = and(eq(storeCart.id, id), eq(storeCart.uid, uid), eq(storeCart.type, 6),
      eq(storeCart.isNew, 1), eq(storeCart.activityId, 0), eq(storeCart.bargainUserId, 0),
      eq(storeCart.staffId, 0), eq(storeCart.touristUid, ""), eq(storeCart.storeId, 0),
      eq(storeCart.isPay, 0), eq(storeCart.isDel, 0), eq(storeCart.status, 1));
    const [cart] = await tx.select().from(storeCart).where(scope).limit(1).for("update");
    if (!cart) throw new NotFoundException("购物车项不存在或已下单");
    selection(uid, cart.productId, cart.productAttrUnique, quantity);
    const context = await lockedSelection(tx, uid, cart.productId, cart.productAttrUnique, quantity);
    if (context.product.productType !== cart.productType) throw new ValidateException("商品履约类型已变化，请重新购买");
    const changed = await tx.update(storeCart).set({ cartNum: quantity }).where(scope).returning({ id: storeCart.id });
    if (!changed.length) throw new ValidateException("预售购物车已变化，请重新选择");
    await assertCurrentWindow(tx, context);
  });
}

/** Read-only validity hint, never purchase authority or a reservation. */
export function presaleCartIsCurrent(cart: Pick<typeof storeCart.$inferSelect, "type" | "isNew" | "activityId" | "productType" | "bargainUserId">,
  product: typeof storeProduct.$inferSelect): boolean {
  if (cart.type !== 6) return cart.type !== 0 || product.isPresaleProduct === 0;
  try {
    return cart.isNew === 1 && cart.activityId === 0 && cart.bargainUserId === 0 && cart.productType === product.productType &&
      product.isShow === 1 && product.isDel === 0 && product.isVerify === 1 && presaleSchedule(product).state === "active";
  } catch { return false; }
}
