/**
 * SKU 属性值 Dao
 *
 * 对应 PHP app/dao/product/sku/StoreProductAttrValueDao.php
 *
 * 核心: SKU 行查询 (库存/价格/销量权威来源), 聚合查询 (min/max/sum)。
 */
import { and, eq, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { storeProductAttrValue } from "@/models/schema";

export class StoreProductAttrValueDao extends BaseDao<typeof storeProductAttrValue> {
  constructor(db: DB) {
    super(db, storeProductAttrValue);
  }

  /**
   * 取商品的所有 SKU 行 (type=0 普通商品)
   * 对应 PHP getProductAttrValue
   */
  async getByProductId(productId: number, type = 0) {
    return this.db
      .select()
      .from(storeProductAttrValue)
      .where(
        sql`${storeProductAttrValue.productId} = ${productId} AND ${storeProductAttrValue.type} = ${type}`,
      );
  }

  /** 按 unique 取单行；活动链路必须同时传 type/productId，避免跨活动碰撞。 */
  async getByUnique(unique: string, type?: number, productId?: number) {
    const predicates = [eq(storeProductAttrValue.unique, unique)];
    if (type !== undefined) predicates.push(eq(storeProductAttrValue.type, type));
    if (productId !== undefined) predicates.push(eq(storeProductAttrValue.productId, productId));
    const rows = await this.db
      .select()
      .from(storeProductAttrValue)
      .where(and(...predicates))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 按 product/type/suk 取单行；默认只读普通商品 SKU。 */
  async getBySuk(productId: number, suk: string, type = 0) {
    const rows = await this.db
      .select()
      .from(storeProductAttrValue)
      .where(
        and(
          eq(storeProductAttrValue.productId, productId),
          eq(storeProductAttrValue.type, type),
          eq(storeProductAttrValue.suk, suk),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 价格区间 (min/max price) —— 对应 PHP productDetail 的价格展示
   * 单规格商品 PHP 直接用 product.price, 多规格取 attr_value 的 min/max
   */
  async getPriceRange(productId: number, type = 0): Promise<{ min: number; max: number }> {
    const rows = await this.db
      .select({
        min: sql<number>`COALESCE(MIN(${storeProductAttrValue.price}), 0)::numeric(12,2)`,
        max: sql<number>`COALESCE(MAX(${storeProductAttrValue.price}), 0)::numeric(12,2)`,
      })
      .from(storeProductAttrValue)
      .where(
        sql`${storeProductAttrValue.productId} = ${productId} AND ${storeProductAttrValue.type} = ${type}`,
      );
    return {
      min: Number(rows[0]?.min ?? 0),
      max: Number(rows[0]?.max ?? 0),
    };
  }

  /**
   * SKU 库存总和 (对应 PHP getProductStockByValues)
   * SUM(stock) GROUP BY product_id WHERE type=0
   */
  async sumStockByProductIds(ids: number[]): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({
        id: sql<number>`${storeProductAttrValue.productId}`,
        stock: sql<number>`COALESCE(SUM(${storeProductAttrValue.stock}), 0)::int`,
      })
      .from(storeProductAttrValue)
      .where(
        sql`${storeProductAttrValue.productId} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`,`,
        )}) AND ${storeProductAttrValue.type} = 0`,
      )
      .groupBy(storeProductAttrValue.productId);
    return new Map(rows.map((r) => [r.id, r.stock]));
  }
}
