/**
 * 购物车 Service
 *
 * 对应 PHP app/services/order/StoreCartServices.php (核心方法: addCart/getCartList/setCartNum/delCart)
 */
import type { Container } from "@/lib/di";
import { ValidateException, NotFoundException } from "@/utils/errors";

export class StoreCartService {
  constructor(private readonly container: Container) {}

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
  }): Promise<{ id: number; cartNum: number }> {
    const { uid, productId, unique, cartNum } = params;
    const type = params.type ?? 0;
    const isNew = params.isNew ?? 0;

    if (cartNum <= 0) throw new ValidateException("购买数量必须大于 0");

    // 1. 校验商品
    const product = await this.container.storeProductDao.getById(productId);
    if (!product) throw new NotFoundException("商品不存在");
    if (!product.isShow || product.isDel) {
      throw new ValidateException("商品已下架");
    }

    // 2. 校验 SKU
    const sku = await this.container.storeProductAttrValueDao.getByUnique(unique);
    if (!sku) throw new NotFoundException("商品规格不存在");
    if (sku.stock < cartNum) {
      throw new ValidateException(`库存不足, 当前库存 ${sku.stock}`);
    }

    // 3. 合并或新建
    const existing = await this.container.storeCartDao.findExisting(uid, productId, unique, type);
    if (existing) {
      const newNum = existing.cartNum + cartNum;
      if (newNum > sku.stock) {
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
      productAttrUnique: unique,
      cartNum,
      addTime: Math.floor(Date.now() / 1000),
      isNew,
      status: 1,
    });
    return { id: row.id, cartNum };
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
      );
      const price = sku ? Number(sku.price) : Number(product.price);
      result.push({
        id: cart.id,
        productId: cart.productId,
        cartNum: cart.cartNum,
        type: cart.type,
        unique: cart.productAttrUnique,
        isValid: true,
        productInfo: {
          storeName: product.storeName,
          image: product.image,
          price: String(price),
          stock: sku?.stock ?? product.stock,
          otPrice: sku ? String(sku.otPrice) : String(product.otPrice),
          suk: sku?.suk ?? "",
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
    // 校验库存
    const sku = await this.container.storeProductAttrValueDao.getByUnique(
      cart.productAttrUnique,
    );
    if (sku && cartNum > sku.stock) {
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
}
