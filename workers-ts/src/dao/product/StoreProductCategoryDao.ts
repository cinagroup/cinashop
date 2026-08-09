/**
 * 商品分类 Dao + searchers
 *
 * 对应 PHP app/dao/product/category/StoreProductCategoryDao.php +
 *       app/model/product/category/StoreProductCategory.php
 */
import { eq, like, inArray, sql } from "drizzle-orm";
import { BaseDao, type DB } from "@/dao/BaseDao";
import { storeProductCategory } from "@/models/schema";
import type { SearcherMap } from "@/models/searchers/types";

const categorySearchers: SearcherMap<typeof storeProductCategory> = {
  pid: (value) => eq(storeProductCategory.pid, Number(value)),
  level: (value) => {
    const v = Number(value);
    if (v === 0) return eq(storeProductCategory.level, 0);
    if (v === 1) return inArray(storeProductCategory.level, [0, 1]);
    // -1 或其他: 全部
    return undefined;
  },
  cateName: (value) => like(storeProductCategory.cateName, `%${value as string}%`),
  type: (value) => eq(storeProductCategory.type, Number(value)),
  relationId: (value) => eq(storeProductCategory.relationId, Number(value)),
  isShow: (value) => eq(storeProductCategory.isShow, Number(value)),
};

export class StoreProductCategoryDao extends BaseDao<typeof storeProductCategory> {
  constructor(db: DB) {
    super(db, storeProductCategory, categorySearchers);
  }

  /**
   * 取分类树 (扁平, 对应 PHP getTierList)
   * 默认按 sort desc, id desc 排序
   */
  async getTierList(
    where: Record<string, unknown>,
    fields: (keyof typeof storeProductCategory.$inferSelect & string)[] = [
      "id",
      "pid",
      "cateName",
      "pic",
      "bigPic",
    ],
  ): Promise<(typeof storeProductCategory.$inferSelect)[]> {
    const cond = this.buildWhere(where);
    const rows = await this.db
      .select()
      .from(storeProductCategory)
      .where(cond ?? sql`true`)
      .orderBy(
        sql`${storeProductCategory.sort} DESC`,
        sql`${storeProductCategory.id} DESC`,
      );
    // 只保留请求字段
    const set = new Set(fields);
    return rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(r)) {
        if (set.has(k as never)) out[k] = (r as Record<string, unknown>)[k];
      }
      return out as typeof storeProductCategory.$inferSelect;
    });
  }

  /** 按 path 找祖先链下的分类 (对应 PHP find_in_set(path, cid) OR id = cid) */
  async findByPathOrId(cid: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: storeProductCategory.id })
      .from(storeProductCategory)
      .where(
        sql`find_in_set(${cid}, ${storeProductCategory.path}) OR ${storeProductCategory.id} = ${cid}`,
      );
    return rows.map((r) => r.id);
  }

  /** 取一级/二级/三级映射 (对应 PHP getCateLevel) */
  async getCateLevel(cateId: number): Promise<{ cid: number; sid: number; tid: number }> {
    const row = await this.db
      .select()
      .from(storeProductCategory)
      .where(eq(storeProductCategory.id, cateId))
      .limit(1);
    const c = row[0];
    if (!c) return { cid: cateId, sid: 0, tid: 0 };
    // level 0→cid, 1→sid, 2→tid
    const result = { cid: 0, sid: 0, tid: 0 };
    if (c.level === 0) result.cid = c.id;
    else if (c.level === 1) {
      result.sid = c.id;
      result.cid = c.pid;
    } else if (c.level === 2) {
      result.tid = c.id;
      result.sid = c.pid;
      // 找祖父
      const parents = await this.db
        .select()
        .from(storeProductCategory)
        .where(eq(storeProductCategory.id, c.pid))
        .limit(1);
      result.cid = parents[0]?.pid ?? 0;
    }
    return result;
  }
}
