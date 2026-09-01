/**
 * 商品 searcher 注册表
 *
 * 对应 PHP app/model/product/product/StoreProduct.php 的所有 searchXxxAttr 方法。
 * 严格对齐 PHP 的查询逻辑, 保证迁移后筛选结果一致。
 *
 * 关键点:
 *   - status 是状态机 (8 种值映射到不同 where 组合)
 *   - keyword 多字段 LIKE (id|keyword|store_name|store_info|bar_code), 支持数组(分词)
 *   - cate_id/brand_id/标签 走 store_product_relation 子查询
 *   - 标签 (热卖/促销/精品/新品/优品) 也走 relation type=3
 */
import {
  and,
  eq,
  gt,
  or,
  like,
  inArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { storeProduct } from "@/models/schema";
import type { SearcherMap } from "./types";

/** 多字段关键字搜索的目标列 (对应 PHP 'id|keyword|store_name|store_info|bar_code'; id 为数字列不参与 LIKE) */
function keywordLike(keyword: string): SQL {
  const kw = `%${keyword.trim()}%`;
  return or(
    like(storeProduct.keyword, kw),
    like(storeProduct.storeName, kw),
    like(storeProduct.storeInfo, kw),
    like(storeProduct.barCode, kw),
  )!;
}

/** relation 子查询: 按 type + relation_id 集合查 product_id */
function relationSubquery(type: number, relationIds: number[]): SQL {
  return sql`(SELECT product_id FROM store_product_relation WHERE type = ${type} AND relation_id IN (${sql.join(
    relationIds.map((id) => sql`${id}`),
    sql`,`,
  )}))`;
}

/** relation 子查询: product_id IN (SELECT ...) */
function relationIn(type: number, relationIds: number[]): SQL {
  return inArray(storeProduct.id, relationSubquery(type, relationIds) as never);
}

export const storeProductSearchers: SearcherMap<typeof storeProduct> = {
  // Explicit product-id scopes also drive CASE ordering in StoreProductDao.
  // Keep the predicate here so a requested subset cannot silently widen to all products.
  ids: (value) => {
    const ids = Array.isArray(value) ? (value as number[]) : [Number(value)];
    const valid = ids.filter((id) => Number.isSafeInteger(id) && id > 0);
    return valid.length ? inArray(storeProduct.id, valid) : sql`false`;
  },

  // ─── 状态机 (8 种) ────────────────────────────────────────
  status: (value) => {
    const v = Number(value);
    switch (v) {
      case -2:
        return eq(storeProduct.isVerify, -2);
      case -1:
        return eq(storeProduct.isVerify, -1);
      case 0:
        return and(eq(storeProduct.isVerify, 0), eq(storeProduct.isDel, 0))!;
      case 1: // 上架
        return and(
          eq(storeProduct.isShow, 1),
          eq(storeProduct.isDel, 0),
          eq(storeProduct.isVerify, 1),
        )!;
      case 2: // 下架
        return and(
          eq(storeProduct.isShow, 0),
          eq(storeProduct.isDel, 0),
          eq(storeProduct.isVerify, 1),
        )!;
      case 3: // 已审核 (不限上下架)
        return and(eq(storeProduct.isDel, 0), eq(storeProduct.isVerify, 1))!;
      case 4: // 售罄
        return and(
          eq(storeProduct.isDel, 0),
          eq(storeProduct.isVerify, 1),
          or(eq(storeProduct.isSold, 1), eq(storeProduct.stock, 0))!,
        )!;
      case 5: // 库存预警
        return and(
          eq(storeProduct.isShow, 1),
          eq(storeProduct.isDel, 0),
          eq(storeProduct.isVerify, 1),
          eq(storeProduct.isPolices, 1),
          gt(storeProduct.stock, 0),
        )!;
      case 6: // 回收站
        return eq(storeProduct.isDel, 1);
      case 7: // 回收站 + 下架
        return or(eq(storeProduct.isDel, 1), eq(storeProduct.isShow, 0))!;
      default:
        return undefined;
    }
  },

  // ─── 关键字 (多字段 LIKE + 分词支持) ─────────────────────
  keyword: (value, data) => {
    // store_id 存在时跳过 (走门店搜索路径)
    if (data.store_id !== undefined) return undefined;
    if (Array.isArray(value)) {
      // 分词: OR 组合
      return or(...(value as string[]).map((k) => keywordLike(k)))!;
    }
    return keywordLike(String(value));
  },

  // ─── 门店版关键字 (历史兼容字段 store_name) ──────────────
  store_name: (value, data) => {
    if (data.store_id !== undefined) return undefined;
    if (value) return keywordLike(String(value));
    return undefined;
  },

  // ─── 分类 (走 relation type=1) ──────────────────────────
  cateId: (value) => {
    if (Array.isArray(value)) {
      const ids = value as number[];
      if (ids.length === 0) return undefined;
      return relationIn(1, ids);
    }
    // 标量: legacy find_in_set(cate_id, value)
    return sql`find_in_set(${value}, ${storeProduct.cateId})`;
  },
  cid: (value) => {
    if (!value) return undefined;
    const id = Number(value);
    return inArray(
      storeProduct.id,
      sql`(SELECT relation.product_id
        FROM store_product_relation AS relation
        WHERE relation.type = 1
          AND relation.relation_id IN (
            SELECT category.id
            FROM store_product_category AS category
            WHERE category.id = ${id}
              OR category.path = ${String(id)}
              OR category.path LIKE ${`${id},%`}
              OR category.path LIKE ${`%,${id},%`}
              OR category.path LIKE ${`%,${id}`}
          ))` as never,
    );
  },
  sid: (value) => {
    if (!value) return undefined;
    const id = Number(value);
    return inArray(
      storeProduct.id,
      sql`(SELECT relation.product_id
        FROM store_product_relation AS relation
        WHERE relation.type = 1
          AND relation.relation_id IN (
            SELECT category.id
            FROM store_product_category AS category
            WHERE category.id = ${id} OR category.pid = ${id}
          ))` as never,
    );
  },
  tid: (value) => {
    if (!value) return undefined;
    return relationIn(1, [Number(value)]);
  },

  // ─── 品牌 ────────────────────────────────────────────────
  brandId: (value) => {
    if (Array.isArray(value)) {
      const ids = value as number[];
      return ids.length ? relationIn(2, ids) : undefined;
    }
    return eq(storeProduct.brandId, Number(value));
  },

  // ─── 标签 (热卖/促销/精品/新品/优品) 走 relation type=3 ─
  // 注意 PHP 把 is_hot/is_benefit 等字段也映射到 relation type=3
  isHot: (value) => (value ? relationIn(3, [1]) : undefined),
  isBenefit: (value) => (value ? relationIn(3, [2]) : undefined),
  isBest: (value) => (value ? relationIn(3, [3]) : undefined),
  isNew: (value) => (value ? relationIn(3, [4]) : undefined),
  isGood: (value) => (value ? relationIn(3, [5]) : undefined),

  // ─── 标签ID / 保障ID (find_in_set) ───────────────────────
  labelId: (value) => sql`find_in_set(${value}, ${storeProduct.labelId})`,
  storeLabelIds: (value) => {
    const ids = (Array.isArray(value) ? value : [value])
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length) return sql`false`;
    return or(...ids.map((id) => sql`
      ${String(id)} = ANY(string_to_array(replace(COALESCE(${storeProduct.storeLabelId}, ''), ' ', ''), ','))
    `))!;
  },
  ensureId: (value) => sql`find_in_set(${value}, ${storeProduct.ensureId})`,

  // ─── 条形码 (product 表 + attr_value 子查询) ─────────────
  barCode: (value) =>
    or(
      eq(storeProduct.barCode, String(value)),
      inArray(
        storeProduct.id,
        sql`(SELECT product_id FROM store_product_attr_value WHERE bar_code = ${value})`,
      ),
    )!,

  // ─── 平台ID ──────────────────────────────────────────────
  pid: (value) => {
    if (value === -1) return gt(storeProduct.pid, 0);
    if (Array.isArray(value)) return inArray(storeProduct.pid, value as number[]);
    return eq(storeProduct.pid, Number(value));
  },

  // ─── 类型 (0平台 1门店 2供应商) ──────────────────────────
  type: (value) => {
    if (Array.isArray(value)) return inArray(storeProduct.type, value as number[]);
    return eq(storeProduct.type, Number(value));
  },

  // ─── 商品类型 (0普通 1卡密 2券 3虚拟 4次卡) ─────────────
  productType: (value) => {
    if (Array.isArray(value))
      return inArray(storeProduct.productType, value as number[]);
    return eq(storeProduct.productType, Number(value));
  },

  // ─── 门店/供应商 ─────────────────────────────────────────
  storeId: (value) => {
    const v = Array.isArray(value) ? (value as number[]) : [Number(value)];
    return and(
      inArray(storeProduct.relationId, v),
      eq(storeProduct.type, 1),
    )!;
  },
  supplierId: (value) => {
    const v = Array.isArray(value) ? (value as number[]) : [Number(value)];
    return and(
      inArray(storeProduct.relationId, v),
      eq(storeProduct.type, 2),
    )!;
  },

  merId: (value) => eq(storeProduct.merId, value ? Number(value) : 0),

  // ─── 布尔筛选 (空字符串跳过) ─────────────────────────────
  isShow: (value) => (value === "" ? undefined : eq(storeProduct.isShow, Number(value))),
  isVerify: (value) =>
    value === "" ? undefined : eq(storeProduct.isVerify, Number(value)),
  isDel: (value) => (value === "" ? undefined : eq(storeProduct.isDel, Number(value))),
  isVip: (value) => (value === "" ? undefined : eq(storeProduct.isVip, Number(value))),
  isPolices: (value) =>
    value === "" ? undefined : eq(storeProduct.isPolices, Number(value)),
  isSold: (value) => (value === "" ? undefined : eq(storeProduct.isSold, Number(value))),
  isPresaleProduct: (value) =>
    value === "" ? undefined : eq(storeProduct.isPresaleProduct, Number(value)),

  // ─── svip专属商品 (searchIsVipProductAttr) ───────────────
  isVipProduct: (value) => {
    const v = Number(value);
    switch (v) {
      case -1:
        return undefined; // 显示全部 (含 svip 专属)
      case 1:
        return eq(storeProduct.isVipProduct, 1);
      case 0:
      default:
        return eq(storeProduct.isVipProduct, 0);
    }
  },

  // ─── 配送类型 find_in_set ────────────────────────────────
  deliveryType: (value) => sql`find_in_set(${value}, ${storeProduct.deliveryType})`,

  // ─── 简单等值 ────────────────────────────────────────────
  id: (value) => {
    if (Array.isArray(value)) return inArray(storeProduct.id, value as number[]);
    return eq(storeProduct.id, Number(value));
  },
  spu: (value) => eq(storeProduct.spu, String(value)),
  stock: (value) => eq(storeProduct.stock, Number(value)),
  systemFormId: (value) => {
    if (Array.isArray(value))
      return inArray(storeProduct.systemFormId, value as number[]);
    return eq(storeProduct.systemFormId, Number(value));
  },
};
