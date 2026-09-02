/**
 * 购物车 Service
 *
 * 对应 PHP app/services/order/StoreCartServices.php (核心方法: addCart/getCartList/setCartNum/delCart)
 */
import { withTx, type Container, type DbClient } from "@/lib/di";
import type { Env } from "@/env";
import { SystemConfigService, type SystemConfigEnv } from "@/services/system/SystemConfigService";
import { ValidateException, NotFoundException } from "@/utils/errors";
import {
  quoteFirstOrderDiscount,
  StoreNewcomerService,
  type FirstOrderDiscountQuote,
} from "@/services/activity/StoreNewcomerService";
import {
  isDiscountPackageAvailable,
  StoreDiscountService,
  type DiscountPackageSelectionInput,
} from "@/services/activity/StoreDiscountService";
import { decimalToCents } from "@/services/order/OrderBrokerageService";
import {
  calculateMemberUnitPriceCents,
  isPaidMembershipActive,
} from "@/services/order/StoreOrderCreateService";
import {
  resolveLegacyActivitySkuPair,
  type LegacyActivitySkuPair,
} from "@/services/activity/ActivityOrderSkuService";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  storeBargain,
  storeBargainUser,
  storeCart,
  storeCombination,
  storeDiscounts,
  storeDiscountsProducts,
  memberRight,
  storeOrder,
  storeProduct,
  storeProductAttrValue,
  storeSeckill,
} from "@/models/schema";

const CART_ADVISORY_LOCK_NAMESPACE = 1128354388;

async function lockCartUser(tx: DbClient, uid: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CART_ADVISORY_LOCK_NAMESPACE}, ${uid})`);
}

async function normalProductAndSku(tx: DbClient, productId: number, unique: string) {
  const productRows = await tx
    .select()
    .from(storeProduct)
    .where(eq(storeProduct.id, productId))
    .limit(1)
    .for("share");
  const product = productRows[0];
  if (!product || product.isDel !== 0 || product.isShow !== 1 || product.isVerify !== 1) {
    throw new ValidateException("该商品已下架或删除");
  }
  if (
    product.isPresaleProduct > 0 && product.presaleEndTime > 0 &&
    product.presaleEndTime < Math.floor(Date.now() / 1000)
  ) {
    throw new ValidateException("预售活动已结束");
  }

  const predicates = [
    eq(storeProductAttrValue.productId, productId),
    eq(storeProductAttrValue.type, 0),
    eq(storeProductAttrValue.isRetired, 0),
  ];
  if (unique) predicates.push(eq(storeProductAttrValue.unique, unique));
  const skuRows = await tx
    .select()
    .from(storeProductAttrValue)
    .where(and(...predicates))
    .orderBy(asc(storeProductAttrValue.id))
    .limit(1)
    .for("share");
  const sku = skuRows[0];
  if (!sku) throw new ValidateException("请选择有效的商品属性");
  return { product, sku };
}

export class StoreCartService {
  constructor(
    private readonly container: Container,
    private readonly env?: Env,
  ) {}

  private async legacyCartPricing(uid: number): Promise<{
    levelDiscountPercent: number;
    paidMemberActive: boolean;
    paidMemberPriceEnabled: boolean;
  }> {
    const fallback = {
      levelDiscountPercent: 100,
      paidMemberActive: false,
      paidMemberPriceEnabled: false,
    };
    if (!this.env) return fallback;
    const [account, values, rights] = await Promise.all([
      this.container.userDao.findForAuth(uid),
      new SystemConfigService(this.container, this.env).getMany([
        "member_func_status",
        "member_card_status",
        "svip_price_status",
      ]),
      this.container.db
        .select({ status: memberRight.status, number: memberRight.number })
        .from(memberRight)
        .where(eq(memberRight.rightType, "vip_price"))
        .orderBy(asc(memberRight.id))
        .limit(1),
    ]);
    if (!account) return fallback;
    const enabled = (value: string | undefined, defaultValue = 1) => {
      const parsed = Number(value ?? defaultValue);
      return Number.isFinite(parsed) ? Math.trunc(parsed) === 1 : defaultValue === 1;
    };
    const memberFunctionEnabled = enabled(values.member_func_status);
    const paidMemberEnabled = enabled(values.member_card_status);
    const level = memberFunctionEnabled && account.level > 0
      ? await this.container.systemUserLevelDao.getById(account.level)
      : null;
    const discount = level && level.isShow === 1 && level.isDel === 0
      ? (Number(level.discount) || 100)
      : 100;
    const right = rights[0];
    return {
      levelDiscountPercent: discount,
      paidMemberActive: paidMemberEnabled && isPaidMembershipActive(
        account,
        Math.floor(Date.now() / 1000),
      ),
      paidMemberPriceEnabled: paidMemberEnabled && enabled(values.svip_price_status) &&
        right?.status === 1 && right.number > 0,
    };
  }

  /**
   * 加入购物车 (对应 PHP StoreCart::addCart)
   *
   * 逻辑:
   *   1. 校验商品存在 + 上架
   *   2. 校验 SKU unique 存在 + 库存 >= 数量
   *   3. 已存在同 SKU → 合并数量; 否则新建
   */
  async add(params: {
    uid: number;
    productId: number;
    unique: string; // SKU unique
    cartNum: number;
    type?: number; // 0普通 1秒杀...
    isNew?: number; // 立即购买
    activityId?: number;
  }): Promise<{ id: number; cartNum: number }> {
    const { uid, cartNum } = params;
    const type = params.type ?? 0;
    const isNew = params.isNew ?? 0;
    const activityId = params.activityId ?? 0;
    let productId = params.productId;
    let unique = params.unique;

    if (!Number.isSafeInteger(cartNum) || cartNum <= 0) {
      throw new ValidateException("购买数量必须是大于 0 的整数");
    }
    if (type === 5) {
      throw new ValidateException("套餐商品必须一次提交完整的套餐选择");
    }

    // 1. 校验商品。新人活动传入的 unique 属于 type=7 SKU；购物车改存
    // 对应 type=0 base unique，使下单与退款只修改基础库存。
    let product;
    let legacyActivitySku: LegacyActivitySkuPair | null = null;
    let legacyActivityOnceNum = 0;
    let legacyActivityTotalNum = 0;
    let legacyActivityPurchased = 0;
    let legacyActivityStock = Number.MAX_SAFE_INTEGER;
    let legacyActivityQuota = Number.MAX_SAFE_INTEGER;
    let integralContext: Awaited<ReturnType<StoreCartService["resolveIntegralSku"]>> | null = null;
    if (type === 4) {
      integralContext = await this.resolveIntegralSku({
        uid,
        productId,
        activityId,
        unique,
        quantity: cartNum,
      });
      product = integralContext.product;
      productId = product.id;
      // 购物车保存基础 SKU unique；积分活动 SKU 由 activity_id + suk 唯一解析。
      unique = integralContext.baseSku.unique;
    } else if (type === 7) {
      if (!this.env) throw new ValidateException("新人专享配置不可用");
      if (!Number.isSafeInteger(activityId) || activityId <= 0) {
        throw new ValidateException("缺少新人专享活动信息");
      }
      const resolved = await new StoreNewcomerService(this.container, this.env).resolveCartSku({
        uid,
        newcomerId: activityId,
        productId,
        activityUnique: unique,
        quantity: cartNum,
      });
      product = resolved.product;
      productId = resolved.product.id;
      unique = resolved.baseSku.unique;
    } else if ([1, 2, 3].includes(type)) {
      if (!Number.isSafeInteger(activityId) || activityId <= 0) {
        throw new ValidateException("缺少活动商品信息");
      }
      const now = new Date();
      let activityProductId = 0;
      let activityStatus = 0;
      let activityIsDel = 0;
      let activityIsShow = 1;
      let activityStart: Date | null = null;
      let activityStop: Date | null = null;
      if (type === 1) {
        const rows = await this.container.db.select().from(storeSeckill)
          .where(eq(storeSeckill.id, activityId)).limit(1);
        const activity = rows[0];
        if (!activity) throw new ValidateException("秒杀活动不存在");
        activityProductId = activity.productId;
        activityStatus = activity.status;
        activityIsDel = activity.isDel;
        activityIsShow = activity.isShow;
        activityStart = activity.startTime;
        activityStop = activity.stopTime;
        legacyActivityOnceNum = activity.onceNum;
        legacyActivityTotalNum = activity.num;
        legacyActivityStock = activity.stock;
        legacyActivityQuota = activity.quota;
      } else if (type === 2) {
        const rows = await this.container.db.select().from(storeBargain)
          .where(eq(storeBargain.id, activityId)).limit(1);
        const activity = rows[0];
        if (!activity) throw new ValidateException("砍价活动不存在");
        activityProductId = activity.productId;
        activityStatus = activity.status;
        activityIsDel = activity.isDel;
        activityStart = activity.startTime;
        activityStop = activity.stopTime;
        legacyActivityStock = activity.stock;
        legacyActivityQuota = activity.quota;
        const participants = await this.container.db
          .select({
            bargainPrice: storeBargainUser.bargainPrice,
            bargainPriceMin: storeBargainUser.bargainPriceMin,
            price: storeBargainUser.price,
          })
          .from(storeBargainUser)
          .where(and(
            eq(storeBargainUser.uid, uid),
            eq(storeBargainUser.bargainId, activityId),
            eq(storeBargainUser.isDel, 0),
            inArray(storeBargainUser.status, [1, 3]),
          ))
          .orderBy(desc(storeBargainUser.id))
          .limit(1);
        const participant = participants[0];
        if (
          !participant ||
          decimalToCents(participant.bargainPrice) - decimalToCents(participant.price) >
            decimalToCents(participant.bargainPriceMin)
        ) {
          throw new ValidateException("砍价未成功");
        }
      } else {
        const rows = await this.container.db.select().from(storeCombination)
          .where(eq(storeCombination.id, activityId)).limit(1);
        const activity = rows[0];
        if (!activity) throw new ValidateException("拼团活动不存在");
        activityProductId = activity.productId;
        activityStatus = activity.status;
        activityIsDel = activity.isDel;
        activityIsShow = activity.isShow;
        activityStart = activity.startTime;
        activityStop = activity.stopTime;
        legacyActivityOnceNum = activity.onceNum;
        legacyActivityTotalNum = activity.num;
        legacyActivityStock = activity.stock;
        legacyActivityQuota = activity.quota;
      }
      if (
        activityStatus !== 1 || activityIsDel !== 0 || activityIsShow !== 1 ||
        (activityStart !== null && activityStart.getTime() > now.getTime()) ||
        (activityStop !== null && activityStop.getTime() < now.getTime())
      ) {
        throw new ValidateException("活动已结束或商品已下架");
      }
      if (activityProductId !== productId) throw new ValidateException("活动商品与基础商品不匹配");
      legacyActivitySku = await resolveLegacyActivitySkuPair(this.container.db, {
        activityId,
        productId,
        type: type as 1 | 2 | 3,
        unique,
      });
      unique = legacyActivitySku.baseSku.unique;
      product = await this.container.storeProductDao.getById(productId);
      if ([1, 3].includes(type)) {
        const totals = await this.container.db
          .select({ total: sql<number>`COALESCE(SUM(${storeOrder.totalNum}), 0)::int` })
          .from(storeOrder)
          .where(and(
            eq(storeOrder.uid, uid),
            eq(storeOrder.type, type),
            eq(storeOrder.activityId, activityId),
            inArray(storeOrder.pid, [0, -1]),
            or(
              eq(storeOrder.paid, 1),
              and(eq(storeOrder.paid, 0), eq(storeOrder.isDel, 0)),
            ),
          ));
        legacyActivityPurchased = totals[0]?.total ?? 0;
      }
    } else {
      product = await this.container.storeProductDao.getById(productId);
    }
    if (!product) throw new NotFoundException("商品不存在");
    if (!product.isShow || product.isDel) {
      throw new ValidateException("商品已下架");
    }

    // 2. 校验 SKU
    const sku = await this.container.storeProductAttrValueDao.getByUnique(unique, 0, productId);
    if (!sku) throw new NotFoundException("商品规格不存在");
    if (sku.productId !== productId) {
      throw new ValidateException("商品规格与商品不匹配");
    }
    if (sku.stock < cartNum) {
      throw new ValidateException(`库存不足, 当前库存 ${sku.stock}`);
    }

    const assertLegacyActivityQuantity = (quantity: number) => {
      if (!legacyActivitySku) return;
      if (type !== 2 && legacyActivityOnceNum <= 0) {
        throw new ValidateException("活动单笔限购配置无效");
      }
      if (type !== 2 && quantity > legacyActivityOnceNum) {
        throw new ValidateException(`每个订单限购 ${legacyActivityOnceNum} 件`);
      }
      if (type !== 2 && legacyActivityTotalNum <= 0) {
        throw new ValidateException("活动累计限购配置无效");
      }
      if (type !== 2 && legacyActivityPurchased + quantity > legacyActivityTotalNum) {
        throw new ValidateException(`每人总共限购 ${legacyActivityTotalNum} 件`);
      }
      const available = Math.min(
        legacyActivityStock,
        legacyActivityQuota,
        legacyActivitySku.activitySku.stock,
        legacyActivitySku.activitySku.quota,
        legacyActivitySku.baseSku.stock,
        product.stock,
      );
      if (available < quantity) throw new ValidateException(`活动商品库存不足, 当前库存 ${Math.max(0, available)}`);
    };
    assertLegacyActivityQuantity(cartNum);

    // 3. 合并或新建
    const existing = await this.container.storeCartDao.findExisting(
      uid,
      productId,
      unique,
      type,
      activityId,
    );
    if (existing) {
      const newNum = existing.cartNum + cartNum;
      if (type === 7 && newNum > 1) throw new ValidateException("新人专享商品限购一件");
      assertLegacyActivityQuantity(newNum);
      if (integralContext) {
        await this.assertIntegralQuantity(uid, integralContext, newNum);
      } else if (newNum > sku.stock) {
        throw new ValidateException("加入购物车数量超过库存");
      }
      await this.container.storeCartDao.update(existing.id, { cartNum: newNum });
      return { id: existing.id, cartNum: newNum };
    }

    const row = await this.container.storeCartDao.save({
      uid,
      type,
      productId,
      productType: product.productType,
      activityId,
      productAttrUnique: unique,
      cartNum,
      addTime: Math.floor(Date.now() / 1000),
      isNew,
      status: 1,
    });
    return { id: row.id, cartNum };
  }

  /** Legacy `discountInfos` direct-buy contract for fixed/mix packages. */
  async addDiscountPackage(params: {
    uid: number;
    discountId: number;
    selections: DiscountPackageSelectionInput[];
  }): Promise<{ cartId: number[]; cartIds: number[]; cartNum: number; discountId: number }> {
    return new StoreDiscountService(this.container).createDirectBuyCarts(
      params.uid,
      params.discountId,
      params.selections,
    );
  }

  /**
   * 购物车列表 (对应 PHP StoreCart::getCartList)
   * 关联商品 + SKU 信息, 计算小计
   */
  async list(uid: number): Promise<unknown[]> {
    const carts = await this.container.storeCartDao.getUserCart(uid);
    if (carts.length === 0) return [];

    // 批量查商品和 SKU (避免 N+1)
    const productIds = [...new Set(carts.map((c) => c.productId))];
    const products = new Map<number, unknown>();
    for (const pid of productIds) {
      const p = await this.container.storeProductDao.getById(pid);
      if (p) products.set(pid, p);
    }

    const result = [];
    for (const cart of carts) {
      const product = products.get(cart.productId) as
        | (typeof import("@/models/schema").storeProduct.$inferSelect)
        | undefined;
      if (!product || !product.isShow || product.isDel) {
        // 商品失效, 跳过但保留购物车项 (前端可提示)
        result.push({ ...cart, isValid: false, productInfo: null });
        continue;
      }
      const sku = await this.container.storeProductAttrValueDao.getByUnique(
        cart.productAttrUnique,
        0,
        cart.productId,
      );
      let price = sku ? Number(sku.price) : Number(product.price);
      let integral = 0;
      let displayName = product.storeName;
      let displayImage = product.image;
      let displayStock = sku?.stock ?? product.stock;
      if ([1, 2, 3].includes(cart.type) && cart.activityId > 0 && sku) {
        try {
          const pair = await resolveLegacyActivitySkuPair(this.container.db, {
            activityId: cart.activityId,
            productId: cart.productId,
            type: cart.type as 1 | 2 | 3,
            unique: cart.productAttrUnique,
            suk: sku.suk,
          });
          const now = Date.now();
          let activityStock = 0;
          let activityQuota = 0;
          if (cart.type === 1) {
            const rows = await this.container.db.select().from(storeSeckill)
              .where(eq(storeSeckill.id, cart.activityId)).limit(1);
            const activity = rows[0];
            if (
              !activity || activity.productId !== product.id || activity.status !== 1 ||
              activity.isShow !== 1 || activity.isDel !== 0 ||
              activity.onceNum <= 0 || activity.num <= 0 ||
              (activity.startTime !== null && activity.startTime.getTime() > now) ||
              (activity.stopTime !== null && activity.stopTime.getTime() < now)
            ) throw new ValidateException("秒杀活动已失效");
            price = Number(pair.activitySku.price);
            displayName = activity.storeName || product.storeName;
            displayImage = pair.activitySku.image || activity.image || product.image;
            activityStock = activity.stock;
            activityQuota = activity.quota;
          } else if (cart.type === 2) {
            const [activities, participants] = await Promise.all([
              this.container.db.select().from(storeBargain)
                .where(eq(storeBargain.id, cart.activityId)).limit(1),
              this.container.db.select().from(storeBargainUser).where(and(
                eq(storeBargainUser.uid, uid),
                eq(storeBargainUser.bargainId, cart.activityId),
                eq(storeBargainUser.isDel, 0),
                inArray(storeBargainUser.status, [1, 3]),
              )).orderBy(desc(storeBargainUser.id)).limit(1),
            ]);
            const activity = activities[0];
            const participant = participants[0];
            if (
              !activity || !participant || activity.productId !== product.id ||
              activity.status !== 1 || activity.isDel !== 0 ||
              (activity.startTime !== null && activity.startTime.getTime() > now) ||
              (activity.stopTime !== null && activity.stopTime.getTime() < now) ||
              decimalToCents(participant.bargainPrice) - decimalToCents(participant.price) >
                decimalToCents(participant.bargainPriceMin)
            ) throw new ValidateException("砍价活动已失效");
            price = Math.max(
              decimalToCents(participant.bargainPriceMin),
              Math.max(
                decimalToCents(participant.bargainPrice),
                decimalToCents(activity.price),
              ) - decimalToCents(participant.price),
            ) / 100;
            displayName = activity.storeName || activity.title || product.storeName;
            displayImage = pair.activitySku.image || activity.image || product.image;
            activityStock = activity.stock;
            activityQuota = activity.quota;
          } else {
            const rows = await this.container.db.select().from(storeCombination)
              .where(eq(storeCombination.id, cart.activityId)).limit(1);
            const activity = rows[0];
            if (
              !activity || activity.productId !== product.id || activity.status !== 1 ||
              activity.isShow !== 1 || activity.isDel !== 0 ||
              activity.onceNum <= 0 || activity.num <= 0 ||
              (activity.startTime !== null && activity.startTime.getTime() > now) ||
              (activity.stopTime !== null && activity.stopTime.getTime() < now)
            ) throw new ValidateException("拼团活动已失效");
            price = Number(pair.activitySku.price);
            displayName = activity.storeName || product.storeName;
            displayImage = pair.activitySku.image || activity.image || product.image;
            activityStock = activity.stock;
            activityQuota = activity.quota;
          }
          displayStock = Math.max(0, Math.min(
            pair.baseSku.stock,
            product.stock,
            pair.activitySku.stock,
            pair.activitySku.quota,
            activityStock,
            activityQuota,
          ));
          if (!Number.isFinite(price) || price < 0 || displayStock < 1) {
            throw new ValidateException("活动商品已失效");
          }
        } catch {
          result.push({ ...cart, isValid: false, productInfo: null });
          continue;
        }
      } else if (cart.type === 5 && cart.activityId > 0 && sku) {
        const [discountRows, entryRows] = await Promise.all([
          this.container.db
            .select()
            .from(storeDiscounts)
            .where(eq(storeDiscounts.id, cart.activityId))
            .limit(1),
          this.container.db
            .select()
            .from(storeDiscountsProducts)
            .where(
              and(
                eq(storeDiscountsProducts.discountId, cart.activityId),
                eq(storeDiscountsProducts.productId, cart.productId),
              ),
            )
            .limit(2),
        ]);
        const discount = discountRows[0];
        const entry = entryRows.length === 1 ? entryRows[0] : null;
        const packageSku = entry
          ? await this.container.storeProductAttrValueDao.getBySuk(entry.id, sku.suk, 5)
          : null;
        const packagePrice = Number(packageSku?.price ?? Number.NaN);
        if (
          !discount || !isDiscountPackageAvailable(discount) || !entry || !packageSku ||
          packageSku.stock < 1 || sku.stock < 1 || product.stock < 1 || cart.cartNum !== 1 ||
          !Number.isFinite(packagePrice) || packagePrice < 0
        ) {
          result.push({ ...cart, isValid: false, productInfo: null });
          continue;
        }
        price = packagePrice;
        displayName = entry.title || product.storeName;
        displayImage = packageSku.image || entry.image || product.image;
        displayStock = Math.max(0, Math.min(packageSku.stock, sku.stock, product.stock));
      } else if (cart.type === 7 && cart.activityId > 0 && sku) {
        const activitySku = await this.container.storeProductAttrValueDao.getBySuk(
          cart.activityId,
          sku.suk,
          7,
        );
        if (activitySku) price = Number(activitySku.price);
      } else if (cart.type === 4 && cart.activityId > 0 && sku) {
        const activity = await this.container.storeIntegralDao.getById(cart.activityId);
        const activitySku = await this.container.storeProductAttrValueDao.getBySuk(
          cart.activityId,
          sku.suk,
          4,
        );
        if (
          !activity || !activitySku || activity.productId !== product.id ||
          activity.status !== 1 || activity.isShow !== 1 || activity.isDel !== 0
        ) {
          result.push({ ...cart, isValid: false, productInfo: null });
          continue;
        }
        price = Number(activitySku.price);
        integral = activitySku.integral;
        displayName = activity.storeName || product.storeName;
        displayImage = activitySku.image || activity.image || product.image;
        displayStock = Math.max(
          0,
          Math.min(
            sku.stock,
            product.stock,
            activitySku.stock,
            activitySku.quota,
            activity.stock,
            activity.quota,
          ),
        );
      }
      let systemFormId = product.systemFormId;
      if (cart.activityId > 0) {
        if (cart.type === 1) systemFormId = (await this.container.storeSeckillDao.getById(cart.activityId))?.systemFormId ?? 0;
        else if (cart.type === 2) systemFormId = (await this.container.storeBargainDao.getById(cart.activityId))?.systemFormId ?? 0;
        else if (cart.type === 3) systemFormId = (await this.container.storeCombinationDao.getById(cart.activityId))?.systemFormId ?? 0;
        else if (cart.type === 4) systemFormId = (await this.container.storeIntegralDao.getById(cart.activityId))?.systemFormId ?? 0;
      }
      result.push({
        id: cart.id,
        productId: cart.productId,
        cartNum: cart.cartNum,
        type: cart.type,
        activityId: cart.activityId,
        unique: cart.productAttrUnique,
        isValid: true,
        productInfo: {
          storeName: displayName,
          image: displayImage,
          price: String(price),
          integral,
          stock: displayStock,
          otPrice: sku ? String(sku.otPrice) : String(product.otPrice),
          suk: sku?.suk ?? "",
          systemFormId,
        },
        // 小计 = 单价 * 数量
        sumPrice: (price * cart.cartNum).toFixed(2),
      });
    }
    return result;
  }

  /** PHP v2 `/cart_list`: normal, reusable cart rows in the old mixed-case shape. */
  async listLegacyV2(
    uid: number,
    options: { includeInvalid?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const carts = await this.container.db
      .select()
      .from(storeCart)
      .where(and(
        eq(storeCart.uid, uid),
        eq(storeCart.type, 0),
        eq(storeCart.activityId, 0),
        eq(storeCart.storeId, 0),
        eq(storeCart.isDel, 0),
        eq(storeCart.isPay, 0),
        eq(storeCart.isNew, 0),
        options.includeInvalid ? undefined : eq(storeCart.status, 1),
      ))
      .orderBy(desc(storeCart.addTime), desc(storeCart.id));
    return this.projectLegacyV2Rows(uid, carts, options);
  }

  /** Project a pre-authorized cart set without widening its database scope. */
  async projectLegacyV2Rows(
    uid: number,
    carts: Array<typeof storeCart.$inferSelect>,
    options: { includeInvalid?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    if (carts.length === 0) return [];

    const productIds = [...new Set(carts.map((cart) => cart.productId))];
    const uniqueValues = [...new Set(carts.map((cart) => cart.productAttrUnique).filter(Boolean))];
    const [products, skus] = await Promise.all([
      this.container.db.select().from(storeProduct).where(inArray(storeProduct.id, productIds)),
      uniqueValues.length > 0
        ? this.container.db
          .select()
          .from(storeProductAttrValue)
          .where(and(
            eq(storeProductAttrValue.type, 0),
            eq(storeProductAttrValue.isRetired, 0),
            inArray(storeProductAttrValue.productId, productIds),
            inArray(storeProductAttrValue.unique, uniqueValues),
          ))
        : Promise.resolve([]),
    ]);
    const productById = new Map(products.map((product) => [product.id, product]));
    const skuByProductUnique = new Map(
      skus.map((sku) => [`${sku.productId}:${sku.unique}`, sku] as const),
    );
    const pricing = await this.legacyCartPricing(uid);

    const result: Record<string, unknown>[] = [];
    for (const cart of carts) {
      const product = productById.get(cart.productId);
      if (!product) continue;
      const productValid = product.isDel === 0 && product.isShow === 1 && product.isVerify === 1;
      if (!options.includeInvalid && !productValid) continue;
      const sku = skuByProductUnique.get(`${cart.productId}:${cart.productAttrUnique}`);
      const rawPrice = String(sku?.price ?? product.price);
      const rawPriceCents = decimalToCents(rawPrice);
      const quoted = calculateMemberUnitPriceCents({
        basePriceCents: rawPriceCents,
        levelDiscountPercent: pricing.levelDiscountPercent,
        paidMemberPriceCents: decimalToCents(sku?.vipPrice ?? product.vipPrice),
        paidMemberActive: pricing.paidMemberActive,
        paidMemberPriceEnabled: pricing.paidMemberPriceEnabled,
        productPaidMemberPriceEnabled: product.isVip === 1,
      });
      const price = quoted.unitPriceCents / 100;
      const stock = sku?.stock ?? product.stock;
      const attrInfo = {
        id: sku?.id ?? 0,
        product_id: cart.productId,
        product_type: sku?.productType ?? product.productType,
        suk: sku?.suk || "已失效",
        stock: sku?.stock ?? 0,
        sales: sku?.sales ?? 0,
        price: String(sku?.price ?? product.price),
        vip_price: String(sku?.vipPrice ?? product.vipPrice),
        ot_price: String(sku?.otPrice ?? product.otPrice),
        cost: String(sku?.cost ?? product.cost),
        image: sku?.image || product.image,
        unique: sku?.unique ?? cart.productAttrUnique,
      };
      result.push({
        id: cart.id,
        uid: cart.uid,
        type: cart.type,
        product_id: cart.productId,
        product_type: cart.productType,
        activity_id: cart.activityId,
        store_id: cart.storeId,
        staff_id: cart.staffId,
        product_attr_unique: cart.productAttrUnique,
        cart_num: cart.cartNum,
        add_time: cart.addTime,
        is_pay: cart.isPay,
        is_del: cart.isDel,
        is_new: cart.isNew,
        status: cart.status,
        is_gift: 0,
        attrStatus: Boolean(sku?.stock),
        vip_truePrice: quoted.discountCents / 100,
        price_type: quoted.priceType,
        costPrice: Number(sku?.cost ?? product.cost),
        trueStock: stock,
        branch_stock: stock,
        branch_sales: sku?.sales ?? product.sales,
        truePrice: price,
        sum_price: rawPriceCents / 100,
        integral: 0,
        is_valid: productValid && cart.status === 1 && Boolean(sku?.suk) && stock > 0 ? 1 : 0,
        productInfo: {
          id: product.id,
          type: product.type,
          product_type: product.productType,
          relation_id: product.relationId,
          image: product.image,
          store_name: product.storeName,
          store_info: product.storeInfo,
          price: String(product.price),
          vip_price: String(product.vipPrice),
          ot_price: String(product.otPrice),
          stock: product.stock,
          sales: product.sales,
          ficti: product.ficti,
          unit_name: product.unitName,
          delivery_type: String(product.deliveryType || "").split(",").filter(Boolean),
          temp_id: product.tempId,
          is_vip: product.isVip,
          is_presale_product: product.isPresaleProduct,
          system_form_id: product.systemFormId,
          store_label: [],
          attrInfo,
        },
      });
    }
    return result;
  }

  /** Admin-assisted normal cart list, bound to the authenticated staff actor. */
  async listAssistedLegacyV2(params: {
    adminId: number;
    uid: number;
    touristUid: string;
    isNew?: number;
    ids?: number[];
  }): Promise<Record<string, unknown>[]> {
    this.assertAssistedScope(params.adminId, params.uid, params.touristUid);
    const isNew = params.isNew ?? 0;
    if (![0, 1].includes(isNew)) throw new ValidateException("购物车类型无效");
    const ids = params.ids ?? [];
    if (ids.length > 200 || new Set(ids).size !== ids.length) {
      throw new ValidateException("购物车参数无效");
    }
    const conditions = [
      eq(storeCart.uid, params.uid),
      eq(storeCart.staffId, params.adminId),
      eq(storeCart.touristUid, params.uid === 0 ? params.touristUid : ""),
      eq(storeCart.type, 0),
      eq(storeCart.activityId, 0),
      eq(storeCart.storeId, 0),
      eq(storeCart.isDel, 0),
      eq(storeCart.isPay, 0),
      eq(storeCart.isNew, isNew),
      eq(storeCart.status, 1),
    ];
    if (ids.length) conditions.push(inArray(storeCart.id, ids));
    const carts = await this.container.db
      .select()
      .from(storeCart)
      .where(and(...conditions))
      .orderBy(desc(storeCart.addTime), desc(storeCart.id));
    if (ids.length && carts.length !== ids.length) {
      throw new ValidateException("购物车商品已失效或不属于当前代客会话");
    }
    const projected = await this.projectLegacyV2Rows(params.uid, carts);
    if (projected.length !== carts.length) {
      throw new ValidateException("购物车商品已失效，请重新选择");
    }
    if (!ids.length) return projected;
    const byId = new Map(projected.map((row) => [Number(row.id), row]));
    return ids.map((id) => byId.get(id)!);
  }

  /** Add or merge one normal assisted cart row under an actor/target lock. */
  async addAssisted(params: {
    adminId: number;
    uid: number;
    touristUid: string;
    productId: number;
    unique: string;
    cartNum: number;
    isNew: number;
  }): Promise<{ cartId: number; cartNum: number }> {
    this.assertAssistedScope(params.adminId, params.uid, params.touristUid);
    if (!Number.isSafeInteger(params.productId) || params.productId <= 0) {
      throw new ValidateException("商品参数错误");
    }
    if (!Number.isSafeInteger(params.cartNum) || params.cartNum <= 0 || params.cartNum > 32767) {
      throw new ValidateException("购买数量必须是大于 0 的整数");
    }
    if (![0, 1].includes(params.isNew)) throw new ValidateException("购物车类型无效");
    const unique = params.unique.trim();
    if (!unique || unique.length > 16) throw new ValidateException("请选择有效的商品属性");
    if (params.uid > 0 && !(await this.container.userDao.findForAuth(params.uid))) {
      throw new NotFoundException("用户不存在");
    }
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`cinashop:assisted-cart:${params.adminId}:${params.uid}:${params.touristUid}`}, 0::bigint)
        )
      `);
      const { product, sku } = await normalProductAndSku(tx, params.productId, unique);
      const existingRows = await tx
        .select()
        .from(storeCart)
        .where(and(
          eq(storeCart.uid, params.uid),
          eq(storeCart.staffId, params.adminId),
          eq(storeCart.touristUid, params.uid === 0 ? params.touristUid : ""),
          eq(storeCart.productId, params.productId),
          eq(storeCart.productAttrUnique, sku.unique),
          eq(storeCart.type, 0),
          eq(storeCart.activityId, 0),
          eq(storeCart.storeId, 0),
          eq(storeCart.isPay, 0),
          eq(storeCart.isDel, 0),
          eq(storeCart.isNew, params.isNew),
          eq(storeCart.status, 1),
        ))
        .orderBy(asc(storeCart.id))
        .limit(1)
        .for("update");
      const existing = existingRows[0];
      const nextNum = (existing?.cartNum ?? 0) + params.cartNum;
      if (nextNum > sku.stock || nextNum > product.stock || nextNum > 32767) {
        throw new ValidateException("加入购物车数量超过库存");
      }
      const now = Math.floor(Date.now() / 1000);
      if (existing) {
        await tx.update(storeCart).set({ cartNum: nextNum, addTime: now })
          .where(eq(storeCart.id, existing.id));
        return { cartId: existing.id, cartNum: nextNum };
      }
      const inserted = await tx.insert(storeCart).values({
        uid: params.uid,
        touristUid: params.uid === 0 ? params.touristUid : "",
        type: 0,
        productId: product.id,
        productType: product.productType,
        activityId: 0,
        storeId: 0,
        staffId: params.adminId,
        productAttrUnique: sku.unique,
        cartNum: params.cartNum,
        addTime: now,
        isPay: 0,
        isDel: 0,
        isNew: params.isNew,
        status: 1,
      }).returning({ id: storeCart.id });
      if (!inserted[0]) throw new Error("购物车写入失败");
      return { cartId: inserted[0].id, cartNum: params.cartNum };
    });
  }

  /** Change quantity only after locking the exact assisted row. */
  async setAssistedNum(params: {
    adminId: number;
    uid: number;
    touristUid: string;
    id: number;
    cartNum: number;
  }): Promise<void> {
    this.assertAssistedScope(params.adminId, params.uid, params.touristUid);
    if (
      !Number.isSafeInteger(params.id) || params.id <= 0 ||
      !Number.isSafeInteger(params.cartNum) || params.cartNum <= 0 || params.cartNum > 32767
    ) throw new ValidateException("购物车参数错误");
    await withTx(this.container, async (tx) => {
      const rows = await tx.select().from(storeCart).where(and(
        eq(storeCart.id, params.id),
        eq(storeCart.uid, params.uid),
        eq(storeCart.staffId, params.adminId),
        eq(storeCart.touristUid, params.uid === 0 ? params.touristUid : ""),
        eq(storeCart.type, 0),
        eq(storeCart.isPay, 0),
        eq(storeCart.isDel, 0),
        eq(storeCart.status, 1),
      )).limit(1).for("update");
      const cart = rows[0];
      if (!cart) throw new NotFoundException("购物车项不存在");
      const { product, sku } = await normalProductAndSku(tx, cart.productId, cart.productAttrUnique);
      if (params.cartNum > sku.stock || params.cartNum > product.stock) {
        throw new ValidateException("修改数量超过库存");
      }
      await tx.update(storeCart).set({ cartNum: params.cartNum }).where(eq(storeCart.id, cart.id));
    });
  }

  /** Soft-delete an exact assisted cart set; partial ownership never succeeds. */
  async delAssisted(params: {
    adminId: number;
    uid: number;
    touristUid: string;
    ids: number[];
  }): Promise<void> {
    this.assertAssistedScope(params.adminId, params.uid, params.touristUid);
    if (
      !params.ids.length || params.ids.length > 200 ||
      new Set(params.ids).size !== params.ids.length ||
      params.ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    ) throw new ValidateException("购物车参数错误");
    await withTx(this.container, async (tx) => {
      const rows = await tx.select({ id: storeCart.id }).from(storeCart).where(and(
        inArray(storeCart.id, params.ids),
        eq(storeCart.uid, params.uid),
        eq(storeCart.staffId, params.adminId),
        eq(storeCart.touristUid, params.uid === 0 ? params.touristUid : ""),
        eq(storeCart.isPay, 0),
        eq(storeCart.isDel, 0),
      )).orderBy(asc(storeCart.id)).for("update");
      if (rows.length !== params.ids.length) {
        throw new ValidateException("购物车商品不存在或不属于当前代客会话");
      }
      await tx.update(storeCart).set({ isDel: 1 }).where(inArray(storeCart.id, params.ids));
    });
  }

  private assertAssistedScope(adminId: number, uid: number, touristUid: string): void {
    if (!Number.isSafeInteger(adminId) || adminId <= 0) throw new ValidateException("管理员身份无效");
    if (!Number.isSafeInteger(uid) || uid < 0) throw new ValidateException("用户参数无效");
    if (uid > 0 && touristUid !== "") throw new ValidateException("实名用户不能携带游客标识");
    if (
      uid === 0 && (
        !touristUid || touristUid.length > 50 ||
        !/^[A-Za-z0-9_-]+$/.test(touristUid)
      )
    ) throw new ValidateException("游客标识无效");
  }

  /** PHP PC `/get_cart_list`: preserve both usable and expired cart rows. */
  async listLegacyPc(uid: number): Promise<{
    valid: Record<string, unknown>[];
    invalid: Record<string, unknown>[];
  }> {
    const rows = await this.listLegacyV2(uid, { includeInvalid: true });
    const valid: Record<string, unknown>[] = [];
    const invalid: Record<string, unknown>[] = [];
    for (const row of rows) {
      (Number(row.is_valid) === 1 ? valid : invalid).push(row);
    }
    return { valid, invalid };
  }

  /** Secure owner-scoped implementation of PHP v2 `resetCart`. */
  async resetLegacyV2(params: {
    uid: number;
    id: number;
    productId: number;
    unique: string;
    cartNum: number;
  }): Promise<{ id: number; cartNum: number }> {
    if (
      !Number.isSafeInteger(params.id) || params.id <= 0 ||
      !Number.isSafeInteger(params.productId) || params.productId <= 0 ||
      !Number.isSafeInteger(params.cartNum) || params.cartNum <= 0 || params.cartNum > 32767 ||
      !params.unique.trim()
    ) {
      throw new ValidateException("参数错误");
    }
    return withTx(this.container, async (tx) => {
      await lockCartUser(tx, params.uid);
      const sourceRows = await tx
        .select()
        .from(storeCart)
        .where(and(
          eq(storeCart.id, params.id),
          eq(storeCart.uid, params.uid),
          eq(storeCart.productId, params.productId),
          eq(storeCart.type, 0),
          eq(storeCart.activityId, 0),
          eq(storeCart.storeId, 0),
          eq(storeCart.isDel, 0),
          eq(storeCart.isPay, 0),
          eq(storeCart.isNew, 0),
          eq(storeCart.status, 1),
        ))
        .limit(1)
        .for("update");
      const source = sourceRows[0];
      if (!source) throw new NotFoundException("购物车项不存在");
      const { sku } = await normalProductAndSku(tx, params.productId, params.unique.trim());
      if (sku.stock <= 0) throw new ValidateException("选择的规格库存不足");

      const targetRows = await tx
        .select()
        .from(storeCart)
        .where(and(
          eq(storeCart.uid, params.uid),
          eq(storeCart.productId, params.productId),
          eq(storeCart.productAttrUnique, sku.unique),
          eq(storeCart.type, 0),
          eq(storeCart.activityId, 0),
          eq(storeCart.storeId, 0),
          eq(storeCart.isDel, 0),
          eq(storeCart.isPay, 0),
          eq(storeCart.isNew, 0),
          eq(storeCart.status, 1),
        ))
        .orderBy(asc(storeCart.id))
        .for("update");
      const target = targetRows[0];
      const now = Math.floor(Date.now() / 1000);
      if (target && target.id !== source.id) {
        const cartNum = Math.min(target.cartNum + params.cartNum, sku.stock, 32767);
        await tx.update(storeCart).set({ cartNum, addTime: now }).where(and(
          eq(storeCart.id, target.id),
          eq(storeCart.uid, params.uid),
        ));
        await tx.update(storeCart).set({ isDel: 1 }).where(and(
          eq(storeCart.id, source.id),
          eq(storeCart.uid, params.uid),
        ));
        return { id: target.id, cartNum };
      }
      if (params.cartNum > sku.stock) {
        throw new ValidateException(`库存不足, 当前库存 ${sku.stock}`);
      }
      await tx.update(storeCart).set({
        productAttrUnique: sku.unique,
        cartNum: params.cartNum,
        addTime: now,
      }).where(and(eq(storeCart.id, source.id), eq(storeCart.uid, params.uid)));
      return { id: source.id, cartNum: params.cartNum };
    });
  }

  /** PHP v2 `setCartNum` mode: -1=set, 0=subtract, 1=add. */
  async setProductQuantityLegacy(params: {
    uid: number;
    productId: number;
    unique: string;
    cartNum: number;
    mode: number;
  }): Promise<{ id: number; cartNum: number; deleted: boolean }> {
    if (
      !Number.isSafeInteger(params.productId) || params.productId <= 0 ||
      !Number.isSafeInteger(params.cartNum) || params.cartNum <= 0 || params.cartNum > 32767 ||
      ![-1, 0, 1].includes(params.mode)
    ) {
      throw new ValidateException("参数错误");
    }
    return withTx(this.container, async (tx) => {
      await lockCartUser(tx, params.uid);
      const { product, sku } = await normalProductAndSku(tx, params.productId, params.unique.trim());
      const rows = await tx
        .select()
        .from(storeCart)
        .where(and(
          eq(storeCart.uid, params.uid),
          eq(storeCart.productId, params.productId),
          eq(storeCart.productAttrUnique, sku.unique),
          eq(storeCart.type, 0),
          eq(storeCart.activityId, 0),
          eq(storeCart.storeId, 0),
          eq(storeCart.isDel, 0),
          eq(storeCart.isPay, 0),
          eq(storeCart.isNew, 0),
          eq(storeCart.status, 1),
        ))
        .orderBy(asc(storeCart.id))
        .for("update");
      const existing = rows[0];
      if (!existing && params.mode === 0) throw new NotFoundException("购物车项不存在");

      let desired = params.cartNum;
      if (existing) {
        if (params.mode === 0) desired = existing.cartNum - params.cartNum;
        else if (params.mode === 1) {
          if (existing.cartNum >= sku.stock) {
            throw new ValidateException(`该商品库存只有${sku.stock}`);
          }
          desired = Math.min(existing.cartNum + params.cartNum, sku.stock, 32767);
        }
      }
      if (desired <= 0 && existing) {
        await tx.update(storeCart).set({ isDel: 1 }).where(and(
          eq(storeCart.id, existing.id),
          eq(storeCart.uid, params.uid),
        ));
        return { id: existing.id, cartNum: 0, deleted: true };
      }
      if (desired > sku.stock) throw new ValidateException(`该商品库存不足${desired}`);
      const now = Math.floor(Date.now() / 1000);
      if (existing) {
        await tx.update(storeCart).set({ cartNum: desired, addTime: now }).where(and(
          eq(storeCart.id, existing.id),
          eq(storeCart.uid, params.uid),
        ));
        return { id: existing.id, cartNum: desired, deleted: false };
      }
      const inserted = await tx.insert(storeCart).values({
        uid: params.uid,
        productId: params.productId,
        productType: product.productType,
        productAttrUnique: sku.unique,
        cartNum: desired,
        type: 0,
        activityId: 0,
        storeId: 0,
        isPay: 0,
        isDel: 0,
        isNew: 0,
        status: 1,
        addTime: now,
      }).returning({ id: storeCart.id });
      return { id: inserted[0].id, cartNum: desired, deleted: false };
    });
  }

  /** v1 compatibility: type=2 identifies and updates the row by product id atomically. */
  async setNormalNumByProductLegacy(uid: number, productId: number, cartNum: number): Promise<void> {
    if (
      !Number.isSafeInteger(productId) || productId <= 0 ||
      !Number.isSafeInteger(cartNum) || cartNum <= 0 || cartNum > 32767
    ) {
      throw new ValidateException("参数错误!");
    }
    await withTx(this.container, async (tx) => {
      await lockCartUser(tx, uid);
      const rows = await tx
        .select()
        .from(storeCart)
        .where(and(
          eq(storeCart.uid, uid),
          eq(storeCart.productId, productId),
          eq(storeCart.type, 0),
          eq(storeCart.activityId, 0),
          eq(storeCart.storeId, 0),
          eq(storeCart.isPay, 0),
          eq(storeCart.isDel, 0),
          eq(storeCart.isNew, 0),
          eq(storeCart.status, 1),
        ))
        .orderBy(desc(storeCart.addTime), desc(storeCart.id))
        .limit(1)
        .for("update");
      const cart = rows[0];
      if (!cart) throw new NotFoundException("购物车项不存在");
      const { sku } = await normalProductAndSku(tx, productId, cart.productAttrUnique);
      if (cartNum > sku.stock) throw new ValidateException(`库存不足${cartNum}`);
      await tx.update(storeCart).set({
        cartNum,
        addTime: Math.floor(Date.now() / 1000),
      }).where(and(
        eq(storeCart.id, cart.id),
        eq(storeCart.uid, uid),
        eq(storeCart.isPay, 0),
        eq(storeCart.isDel, 0),
        eq(storeCart.isNew, 0),
        eq(storeCart.status, 1),
      ));
    });
  }

  /** 修改数量 (对应 PHP StoreCart::setCartNum) */
  async setNum(uid: number, id: number, cartNum: number): Promise<void> {
    if (cartNum <= 0) throw new ValidateException("数量必须大于 0");
    const cart = await this.container.storeCartDao.get(id);
    if (!cart || cart.uid !== uid || cart.isDel) {
      throw new NotFoundException("购物车项不存在");
    }
    if ([5, 7].includes(cart.type) && cartNum !== 1) {
      throw new ValidateException(cart.type === 5 ? "套餐商品每项限购一件" : "新人专享商品限购一件");
    }
    // 校验库存
    const sku = await this.container.storeProductAttrValueDao.getByUnique(
      cart.productAttrUnique,
      0,
      cart.productId,
    );
    if (!sku || sku.productId !== cart.productId) {
      throw new ValidateException("商品规格已失效");
    }
    if (cart.type === 4) {
      const context = await this.resolveIntegralSku({
        uid,
        productId: cart.productId,
        activityId: cart.activityId,
        unique: sku.unique,
        quantity: cartNum,
      });
      await this.assertIntegralQuantity(uid, context, cartNum);
    } else if (cartNum > sku.stock) {
      throw new ValidateException(`库存不足, 当前库存 ${sku.stock}`);
    }
    await this.container.storeCartDao.update(id, { cartNum });
  }

  /** 删除 (软删除, 对应 PHP delCart) */
  async del(uid: number, ids: number[]): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) {
      const cart = await this.container.storeCartDao.get(id);
      if (cart && cart.uid === uid) {
        await this.container.storeCartDao.update(id, { isDel: 1 });
      }
    }
  }

  /** 购物车数量统计 (角标用) */
  async count(uid: number): Promise<number> {
    return this.container.storeCartDao.count({
      uid,
      isDel: 0,
      isPay: 0,
    });
  }

  /** 结算页只读预览；最终金额仍由建单事务重新计算。 */
  async quoteFirstOrder(
    uid: number,
    cartIds: number[],
    configEnv?: SystemConfigEnv,
  ): Promise<FirstOrderDiscountQuote> {
    const runtime = configEnv ?? this.env;
    if (!runtime) throw new ValidateException("首单优惠配置不可用");
    if (!cartIds.length || cartIds.length > 200 || new Set(cartIds).size !== cartIds.length) {
      throw new ValidateException("请选择有效的结算商品");
    }
    const carts = await this.container.storeCartDao.getByIds(cartIds);
    if (carts.length !== cartIds.length) throw new NotFoundException("购物车商品不存在");
    let totalCents = 0;
    for (const cart of carts) {
      if (
        cart.uid !== uid || cart.isPay !== 0 || cart.isDel !== 0 ||
        cart.status !== 1 || cart.cartNum <= 0
      ) {
        throw new ValidateException("购物车商品已失效或已下单");
      }
      // PHP 只在没有 activity_id 的普通购物车上计算首单优惠。
      if (cart.type !== 0 || cart.activityId !== 0) {
        return {
          eligible: false,
          couponExclusive: false,
          subtotal: "0.00",
          firstOrderPrice: "0.00",
          payPercent: 100,
          discountLimit: "0.00",
        };
      }
      const product = await this.container.storeProductDao.getById(cart.productId);
      const sku = await this.container.storeProductAttrValueDao.getByUnique(
        cart.productAttrUnique,
        0,
        cart.productId,
      );
      if (!product || !product.isShow || product.isDel || !sku || sku.productId !== product.id) {
        throw new ValidateException("购物车商品或规格已失效");
      }
      const lineCents = decimalToCents(sku.price) * cart.cartNum;
      if (!Number.isSafeInteger(lineCents) || !Number.isSafeInteger(totalCents + lineCents)) {
        throw new ValidateException("结算金额超出安全范围");
      }
      totalCents += lineCents;
    }
    return quoteFirstOrderDiscount(this.container, runtime, uid, totalCents);
  }

  private async resolveIntegralSku(params: {
    uid: number;
    productId: number;
    activityId: number;
    unique: string;
    quantity: number;
  }) {
    if (!Number.isSafeInteger(params.activityId) || params.activityId <= 0) {
      throw new ValidateException("缺少积分商品信息");
    }
    const activity = await this.container.storeIntegralDao.getById(params.activityId);
    if (!activity || activity.status !== 1 || activity.isShow !== 1 || activity.isDel !== 0) {
      throw new ValidateException("积分商品已下架或删除");
    }
    if (activity.productId !== params.productId) {
      throw new ValidateException("积分商品与关联商品不匹配");
    }
    const product = await this.container.storeProductDao.getById(activity.productId);
    if (!product || !product.isShow || product.isDel) {
      throw new ValidateException("积分商品关联的商品已下架");
    }

    let activitySku = await this.container.storeProductAttrValueDao.getByUnique(
      params.unique,
      4,
      activity.id,
    );
    let baseSku = activitySku
      ? await this.container.storeProductAttrValueDao.getBySuk(product.id, activitySku.suk, 0)
      : await this.container.storeProductAttrValueDao.getByUnique(params.unique, 0, product.id);
    if (!activitySku && baseSku) {
      activitySku = await this.container.storeProductAttrValueDao.getBySuk(activity.id, baseSku.suk, 4);
    }
    if (!activitySku || !baseSku || activitySku.suk !== baseSku.suk) {
      throw new ValidateException("积分商品规格不存在或已失效");
    }
    const context = { activity, activitySku, baseSku, product };
    await this.assertIntegralQuantity(params.uid, context, params.quantity);
    return context;
  }

  private async assertIntegralQuantity(
    uid: number,
    context: {
      activity: NonNullable<Awaited<ReturnType<Container["storeIntegralDao"]["getById"]>>>;
      activitySku: NonNullable<Awaited<ReturnType<Container["storeProductAttrValueDao"]["getByUnique"]>>>;
      baseSku: NonNullable<Awaited<ReturnType<Container["storeProductAttrValueDao"]["getByUnique"]>>>;
      product: NonNullable<Awaited<ReturnType<Container["storeProductDao"]["getById"]>>>;
    },
    quantity: number,
  ): Promise<void> {
    const { activity, activitySku, baseSku, product } = context;
    if (activity.onceNum > 0 && quantity > activity.onceNum) {
      throw new ValidateException(`每个订单限购 ${activity.onceNum} 件`);
    }
    const available = Math.min(
      activity.stock,
      activity.quota,
      activitySku.stock,
      activitySku.quota,
      baseSku.stock,
      product.stock,
    );
    if (available < quantity) throw new ValidateException(`积分商品库存不足, 当前可兑 ${Math.max(available, 0)} 件`);

    if (activity.num > 0) {
      const rows = await this.container.db
        .select({ total: sql<number>`COALESCE(SUM(${storeOrder.totalNum}), 0)::int` })
        .from(storeOrder)
        .where(
          and(
            eq(storeOrder.uid, uid),
            eq(storeOrder.type, 4),
            eq(storeOrder.activityId, activity.id),
            inArray(storeOrder.pid, [0, -1]),
            or(
              eq(storeOrder.paid, 1),
              and(eq(storeOrder.paid, 0), eq(storeOrder.isDel, 0)),
            ),
          ),
        );
      if ((rows[0]?.total ?? 0) + quantity > activity.num) {
        throw new ValidateException(`每人累计限购 ${activity.num} 件`);
      }
    }
  }
}
