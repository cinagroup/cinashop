/**
 * 公共接口控制器
 *
 * 对应 PHP app/controller/api/v1/PublicController.php
 */
import type { Context } from "hono";
import { jsonOk } from "@/utils/json";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import type { AppVariables, Env } from "@/env";

type C = Context<{ Bindings: Env; Variables: AppVariables & { container: import("@/lib/di").Container } }>;

/**
 * GET /api/site_config
 *
 * 对应 PHP PublicController::getSiteConfig
 * 返回备案号等基础站点信息。
 */
export async function getSiteConfig(c: C) {
  const svc = new SystemConfigService(c.get("container"), c.env);
  const recordNo = await svc.get("record_No");
  return jsonOk(c, { record_No: recordNo });
}

/**
 * GET /api/get_copyright
 * 对应 PHP Common::getCopyright
 */
export async function getCopyright(c: C) {
  const svc = new SystemConfigService(c.get("container"), c.env);
  const values = await svc.getMany([
    "copyright_context",
    "copyright_image",
    "image_site_url",
  ]);
  return jsonOk(c, values);
}

/** GET /api/search/hot_keyword — 热门搜索词 */
export async function hotKeywords(c: C) {
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeProductWords } = await import("@/models/schema");
  try {
    const rows = await container.db
      .select()
      .from(storeProductWords)
      .where(
        sql`${storeProductWords.isShow} = 1 AND ${storeProductWords.isHot} = 1`,
      )
      .orderBy(sql`${storeProductWords.sort} DESC, ${storeProductWords.addTime} DESC`)
      .limit(20);
    return jsonOk(
      c,
      rows.map((r) => ({
        keyword: r.name,
        color: r.color,
        bg_color: r.bgColor,
        border_color: r.borderColor,
        icon: r.icon,
      })),
    );
  } catch {
    // 表不存在时返回空
    return jsonOk(c, []);
  }
}

/** GET /api/search/keyword — 关键词联想 (商品名模糊匹配) */
export async function searchWords(c: C) {
  const keyword = c.req.query("keyword") ?? "";
  if (!keyword || keyword === "%") {
    return jsonOk(c, { keyword, list: [] });
  }
  const container = c.get("container");
  const { sql } = await import("drizzle-orm");
  const { storeProduct } = await import("@/models/schema");
  try {
    const rows = await container.db
      .select({ id: storeProduct.id, storeName: storeProduct.storeName })
      .from(storeProduct)
      .where(
        sql`${storeProduct.storeName} LIKE ${`%${keyword}%`} AND ${storeProduct.isShow} = 1 AND ${storeProduct.isDel} = 0 AND ${storeProduct.isVerify} = 1`,
      )
      .orderBy(sql`${storeProduct.sort} DESC, ${storeProduct.sales} DESC`)
      .limit(10);
    return jsonOk(c, { keyword, list: rows });
  } catch {
    return jsonOk(c, { keyword, list: [] });
  }
}

/** GET /api/user_agreement/:type — 用户协议 (type: 1=用户协议 2=隐私政策) */
export async function getUserAgreement(c: C) {
  const type = c.req.param("type") ?? "1";
  const svc = new SystemConfigService(c.get("container"), c.env);
  // 协议内容存系统配置
  const key = type === "2" ? "privacy_policy" : "user_agreement";
  const content = await svc.get(key);
  return jsonOk(c, { content, type: Number(type) });
}
