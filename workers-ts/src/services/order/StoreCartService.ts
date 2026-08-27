/**
 * 购物车 Service
 *
 * 对应 PHP app/services/order/StoreCartServices.php (核心方法: addCart/getCartList/setCartNum/delCart)
 */
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";
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
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { storeDiscounts, storeDiscountsProducts, storeOrder } from "@/models/schema";

export class StoreCartService {
  constructor(
    private readonly container: Container,
    private readonly env?: Env,
  ) {}

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
      if (cart.type === 5 && cart.activityId > 0 && sku) {
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
