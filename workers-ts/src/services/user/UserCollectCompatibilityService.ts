import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container } from "@/lib/di";
import { storeProduct, userRelation, video } from "@/models/schema";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import { V2PromotionCompatibilityService } from "@/services/activity/V2PromotionCompatibilityService";
import { ValidateException } from "@/utils/errors";

type CollectCategory = "product" | "video";

function category(value: string): CollectCategory {
  if (value === "product" || value === "video") return value;
  throw new ValidateException("该收藏分类暂未迁移");
}

/** PHP-compatible collection list without hiding delisted/deleted products. */
export class UserCollectCompatibilityService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async list(uid: number, page: number, limit: number, value: string) {
    const selectedCategory = category(value);
    const where = and(
      eq(userRelation.uid, uid),
      eq(userRelation.type, "collect"),
      eq(userRelation.category, selectedCategory),
    );
    const [relations, counts] = await Promise.all([
      this.container.db
        .select({ id: userRelation.relationId })
        .from(userRelation)
        .where(where)
        .orderBy(desc(userRelation.addTime), desc(userRelation.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userRelation)
        .where(where),
    ]);
    const ids = relations.map((row) => row.id);
    const list = selectedCategory === "video"
      ? await this.videoList(ids)
      : await this.productList(uid, ids);
    // PHP counts relation rows even when a referenced object was physically
    // removed; its list similarly omits only a truly missing object.
    return { list, count: counts[0]?.count ?? 0 };
  }

  private async productList(uid: number, ids: number[]): Promise<Record<string, unknown>[]> {
    if (!ids.length) return [];
    const [rows, visible] = await Promise.all([
      this.container.db
        .select({
          id: storeProduct.id,
          storeName: storeProduct.storeName,
          price: storeProduct.price,
          isPresaleProduct: storeProduct.isPresaleProduct,
          vipPrice: storeProduct.vipPrice,
          freight: storeProduct.freight,
          otPrice: storeProduct.otPrice,
          sales: storeProduct.sales,
          image: storeProduct.image,
          isDel: storeProduct.isDel,
          isShow: storeProduct.isShow,
          activity: storeProduct.activity,
        })
        .from(storeProduct)
        .where(inArray(storeProduct.id, ids)),
      new PublicCatalogService(this.container, this.env).recommend(uid, {
        ids,
        limit: ids.length,
      }),
    ]);
    const direct = new Map(rows.map((row) => [row.id, row]));
    const decorated = new Map(visible.map((item) => {
      const record = item as Record<string, unknown>;
      return [Number(record.id), record] as const;
    }));
    const list = ids.flatMap((id) => {
      const row = direct.get(id);
      if (!row) return [];
      const rich = decorated.get(id) ?? {};
      const priceType = typeof rich.price_type === "string" ? rich.price_type : "";
      const effectiveMemberPrice = rich.vip_price ?? "0";
      return [{
        ...rich,
        id: row.id,
        product_id: id,
        store_name: row.storeName,
        price_type: priceType,
        price: row.price,
        is_presale_product: row.isPresaleProduct,
        vip_price: priceType === "member" ? effectiveMemberPrice : "0",
        level_name: rich.level_name ?? "",
        // PHP exposes the same getMinPrice value under different keys based
        // on whether the winning price is paid-membership or user-level.
        level_price: priceType === "member" ? "0" : effectiveMemberPrice,
        freight: row.freight,
        ot_price: row.otPrice,
        sales: row.sales,
        image: row.image,
        is_del: row.isDel,
        is_show: row.isShow,
        // Correct the PHP `is_del && is_show` typo: either unavailable state
        // should be visible to the client so the relation can be removed.
        is_fail: row.isDel !== 0 || row.isShow === 0 ? 1 : 0,
        activity: row.activity,
        promotions: rich.promotions && typeof rich.promotions === "object"
          ? rich.promotions
          : {},
        activity_frame: [],
        activity_background: [],
      }];
    });
    return new V2PromotionCompatibilityService(this.container, this.env)
      .decorateCatalogProducts(list);
  }

  private async videoList(ids: number[]): Promise<Record<string, unknown>[]> {
    if (!ids.length) return [];
    const configs = await this.container.systemConfigDao.getValues([
      "video_func_status",
      "site_name",
      "wap_login_logo",
    ]);
    if (Number(configs.video_func_status ?? "1") === 0) return [];
    const rows = await this.container.db
      .select({
        id: video.id,
        image: video.image,
        description: video.desc,
        videoUrl: video.videoUrl,
        likeNum: video.likeNum,
      })
      .from(video)
      .where(inArray(video.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{
        id: row.id,
        video_id: id,
        image: row.image,
        site_name: configs.site_name ?? "",
        wap_login_logo: configs.wap_login_logo ?? "",
        desc: row.description,
        video_url: row.videoUrl,
        like_num: row.likeNum,
      }] : [];
    });
  }
}
