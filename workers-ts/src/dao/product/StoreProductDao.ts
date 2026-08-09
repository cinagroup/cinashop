/**
 * 商品 Dao
 *
 * 对应 PHP app/dao/product/product/StoreProductDao.php。
 * 核心: getSearchList —— 带复杂排序 (ids/pids/priceOrder/salesOrder/defaultOrder) 的列表查询。
 */
import { asc, desc, sql, inArray, type SQL } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { storeProduct } from "@/models/schema";
import { storeProductSearchers } from "@/models/searchers/product";

/** 列表查询选项 */
export interface ProductListOpts {
  page?: number;
  limit?: number;
  /** 按 ids 数组顺序 (preserveOrder) */
  ids?: number[];
  /** 按 pids 数组顺序 */
  pids?: number[];
  /** 价格排序: 'desc'|'asc'|'' */
  priceOrder?: string;
  /** 销量排序 */
  salesOrder?: string;
  /** 默认排序模式: 0综合 1好评 2新品 */
  defaultOrder?: number;
  /** 时间倒序 */
  timeOrder?: number;
}

export class StoreProductDao extends BaseDao<typeof storeProduct> {
  constructor(db: DB) {
    super(db, storeProduct, storeProductSearchers);
  }

  /**
   * 商品列表查询 (对应 PHP StoreProductDao::getSearchList)
   *
   * 关键差异修复: PHP 的 sales 列用 IFNULL(sales,0)+IFNULL(ficti,0) 计算,
   * 这里通过 SQL 投影保留该计算列别名 sales。
   */
  async getSearchList(opts: {
    where: Record<string, unknown>;
    page?: number;
    limit?: number;
    fields?: string[]; // 默认用 getGoodsList 的字段集
  }): Promise<Record<string, unknown>[]> {
    const { where, page, limit } = opts;
    const cond = this.buildWhere(where);

    // 排序逻辑 (对应 PHP getSearchList 的多层 when)
    let orderSQL: SQL | undefined;
    const ids = where.ids as number[] | undefined;
    const pids = where.pids as number[] | undefined;
    const priceOrder = where.priceOrder as string | undefined;
    const salesOrder = where.salesOrder as string | undefined;
    const defaultOrder = Number(where.defaultOrder ?? 0);
    const timeOrder = Number(where.timeOrder ?? 0);

    if (ids && ids.length > 0 && !priceOrder && !salesOrder) {
      // 保持 ids 顺序
      orderSQL = sql`CASE id ${sql.join(
        ids.map((id, i) => sql`WHEN ${id} THEN ${i}`),
        sql` `,
      )} END`;
    } else if (priceOrder === "desc") {
      orderSQL = desc(storeProduct.price);
    } else if (priceOrder === "asc") {
      orderSQL = asc(storeProduct.price);
    } else if (salesOrder === "desc") {
      orderSQL = sql`sales DESC`;
    } else if (salesOrder === "asc") {
      orderSQL = sql`sales ASC`;
    } else if (defaultOrder === 1) {
      // 好评优先
      orderSQL = sql`${storeProduct.star} DESC, ${storeProduct.sort} DESC`;
    } else if (defaultOrder === 2) {
      // 新品
      orderSQL = sql`${storeProduct.id} DESC, ${storeProduct.sort} DESC`;
    } else if (timeOrder === 1) {
      orderSQL = desc(storeProduct.id);
    } else {
      // 默认: sort desc, id desc
      orderSQL = sql`${storeProduct.sort} DESC, ${storeProduct.id} DESC`;
    }
    void pids;

    let q = this.db
      .select({
        id: storeProduct.id,
        relation_id: storeProduct.relationId,
        type: storeProduct.type,
        pid: storeProduct.pid,
        delivery_type: storeProduct.deliveryType,
        product_type: storeProduct.productType,
        store_name: storeProduct.storeName,
        cate_id: storeProduct.cateId,
        image: storeProduct.image,
        sales: sql<number>`COALESCE(${storeProduct.sales}, 0) + COALESCE(${storeProduct.ficti}, 0)`,
        price: storeProduct.price,
        stock: storeProduct.stock,
        activity: storeProduct.activity,
        ot_price: storeProduct.otPrice,
        spec_type: storeProduct.specType,
        recommend_image: storeProduct.recommendImage,
        unit_name: storeProduct.unitName,
        is_vip: storeProduct.isVip,
        vip_price: storeProduct.vipPrice,
        is_presale_product: storeProduct.isPresaleProduct,
        is_vip_product: storeProduct.isVipProduct,
        system_form_id: storeProduct.systemFormId,
        presale_start_time: storeProduct.presaleStartTime,
        presale_end_time: storeProduct.presaleEndTime,
        is_limit: storeProduct.isLimit,
        limit_num: storeProduct.limitNum,
        video_open: storeProduct.videoOpen,
        video_link: storeProduct.videoLink,
        freight: storeProduct.freight,
        star: storeProduct.star,
        store_label_id: storeProduct.storeLabelId,
        brand_id: storeProduct.brandId,
      })
      .from(storeProduct)
      .where(cond ?? sql`true`)
      .$dynamic();

    if (page && limit) {
      q = q.limit(limit).offset((page - 1) * limit);
    }
    q = q.orderBy(orderSQL);

    const result = await q;
    return result as unknown as Record<string, unknown>[];
  }

  /**
   * 按 ID 集合查商品 (用于关键字搜索命中后的精确取数)
   * 对应 PHP getSearchList(where.ids, 0, 0, ['id'])
   */
  async getIdsByWhere(where: Record<string, unknown>): Promise<number[]> {
    const cond = this.buildWhere(where);
    const rows = await this.db
      .select({ id: storeProduct.id })
      .from(storeProduct)
      .where(cond ?? sql`true`);
    return rows.map((r) => r.id);
  }

  /** 取单个商品详情 (对应 PHP getOne(id, '*', ['descriptions'])) */
  async getById(id: number): Promise<typeof storeProduct.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(storeProduct)
      .where(sql`${storeProduct.id} = ${id}`)
      .limit(1);
    return rows[0] ?? null;
  }

  /** 计算库存总和 (M3 库存扣减用) */
  async sumStock(productId: number): Promise<number> {
    // 子查询示例: SUM(stock) FROM store_product_attr_value WHERE product_id
    const rows = await this.db
      .select({ s: sql<number>`COALESCE(SUM(stock), 0)::int` })
      .from(sql`store_product_attr_value`)
      .where(sql`product_id = ${productId}`);
    return rows[0]?.s ?? 0;
  }

  /** ids 是否存在 (校验搜索结果有效性) */
  async filterExistingIds(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: storeProduct.id })
      .from(storeProduct)
      .where(inArray(storeProduct.id, ids));
    return rows.map((r) => r.id);
  }
}
