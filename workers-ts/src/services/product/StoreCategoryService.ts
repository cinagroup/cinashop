/**
 * 商品分类 Service
 *
 * 对应 PHP app/services/product/category/StoreProductCategoryServices.php
 * 核心方法 getCategory —— 前台分类树, 带 Upstash 缓存。
 */
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { cacheGet, cacheSet } from "@/utils/cache";
import { buildTree } from "@/utils/tree";

const CATEGORY_CACHE_KEY = "category_all_tree";
const CATEGORY_CACHE_TTL = 3600; // 1 小时

export class StoreCategoryService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 前台分类树 (对应 PHP getCategory)
   *
   * 缓存策略: Upstash 存完整树 JSON, TTL 1h。
   * 后台改分类时调 invalidate() 失效。
   */
  async getCategory(): Promise<unknown[]> {
    // 1. 命中缓存
    const cached = await cacheGet<unknown[]>(CATEGORY_CACHE_KEY, this.env);
    if (cached) return cached;

    // 2. 取所有 is_show=1 的分类 (扁平)
    const flat = await this.container.storeProductCategoryDao.getTierList(
      { isShow: 1 },
      ["id", "pid", "cateName", "pic", "bigPic"],
    );

    // 3. 嵌套成树 (对应 PHP get_tree_children)
    const tree = buildTree(
      flat.map((f) => ({
        id: f.id,
        pid: f.pid,
        cate_name: f.cateName,
        pic: f.pic,
        big_pic: f.bigPic,
      })),
    );

    // 4. 回填缓存
    await cacheSet(CATEGORY_CACHE_KEY, tree, this.env, CATEGORY_CACHE_TTL);
    return tree;
  }

  /** 失效缓存 (后台改分类后调用) */
  async invalidate(): Promise<void> {
    const { cacheDelete } = await import("@/utils/cache");
    await cacheDelete(CATEGORY_CACHE_KEY, this.env);
  }

  /** 分类版本号 (对应 PHP getCategoryVersion, 用于前端缓存键) */
  async getVersion(): Promise<string> {
    const svc = new (await import("@/services/system/SystemConfigService")).SystemConfigService(
      this.container,
      this.env,
    );
    const v = await svc.get("category_version");
    return v || "init";
  }
}
