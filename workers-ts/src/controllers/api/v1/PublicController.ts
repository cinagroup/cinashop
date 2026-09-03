/**
 * 公共接口控制器
 *
 * 对应 PHP app/controller/api/v1/PublicController.php
 */
import type { Context } from "hono";
import { jsonOk } from "@/utils/json";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { LegacyContentService } from "@/services/system/LegacyContentService";
import { PublicCatalogService } from "@/services/product/PublicCatalogService";
import { V2PublicCompatibilityService } from "@/services/content/V2PublicCompatibilityService";
import { jsonFail } from "@/utils/json";
import { ValidateException } from "@/utils/errors";
import type { AppVariables, Env } from "@/env";
import { ProductWordsService } from "@/services/product/ProductWordsService";
import { PublicBrandingService } from "@/services/system/PublicBrandingService";

type C = Context<{ Bindings: Env; Variables: AppVariables & { container: import("@/lib/di").Container } }>;

/**
 * GET /api/site_config
 *
 * 对应 PHP PublicController::getSiteConfig
 * 返回备案号等基础站点信息。
 */
export async function getSiteConfig(c: C) {
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return jsonOk(
    c,
    await new PublicBrandingService(c.get("container"), c.env).siteConfig(
      new URL(c.req.url).origin,
    ),
  );
}

/** GET /api/share — legacy global WeChat share defaults with fresh signed media. */
export async function share(c: C) {
  c.header("Cache-Control", "public, max-age=60, s-maxage=300");
  return jsonOk(
    c,
    await new PublicBrandingService(c.get("container"), c.env).share(
      new URL(c.req.url).origin,
    ),
  );
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
  return jsonOk(c, await new ProductWordsService(c.get("container")).publicKeywords());
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
  const content = await new LegacyContentService(c.get("container")).agreement(type);
  return jsonOk(c, { content, type });
}

/** GET /api/get_open_adv — PHP-compatible splash advertisement. */
export async function getOpenAdv(c: C) {
  return jsonOk(c, await new LegacyContentService(c.get("container")).openAdv());
}

/** GET /api/user/service/get_adv — PHP-compatible customer-service content. */
export async function getKfAdv(c: C) {
  return jsonOk(c, { content: await new LegacyContentService(c.get("container")).kfAdv() });
}

/** GET /api/navigation/:template_name? — legacy DIY bottom navigation. */
export async function navigation(c: C) {
  try {
    const data = await new PublicCatalogService(c.get("container"), c.env)
      .navigation(c.req.param("template_name") ?? "");
    return jsonOk(c, data);
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/index — legacy homepage payload. */
export async function index(c: C) {
  return jsonOk(
    c,
    await new PublicCatalogService(c.get("container"), c.env).home(c.get("uid") ?? 0),
  );
}

/** GET /api/subscribe — legacy component-compatible optional-auth follow status. */
export async function subscribe(c: C) {
  c.header("Cache-Control", "private, no-store");
  return jsonOk(c, {
    subscribe: await new PublicCatalogService(c.get("container"), c.env).subscribe(
      c.get("uid") ?? 0,
      { anonymousDefault: true },
    ),
  });
}

/** GET /api/menu/user — user-centre menu and DIY layout. */
export async function menuUser(c: C) {
  return jsonOk(
    c,
    await new PublicCatalogService(c.get("container"), c.env).menuUser(c.get("uid") ?? 0),
  );
}

/** GET /api/menu/date — PHP keeps the historical `date` spelling. */
export async function menuUserData(c: C) {
  return jsonOk(
    c,
    await new PublicCatalogService(c.get("container"), c.env).menuUserData(c.get("uid") ?? 0),
  );
}

function v2PublicService(c: C) {
  return new V2PublicCompatibilityService(c.get("container"), c.env);
}

/** GET /api/v2/index — compact legacy v2 homepage contract. */
export async function indexV2(c: C) {
  c.header("Cache-Control", "private, no-store");
  return jsonOk(
    c,
    await new PublicCatalogService(c.get("container"), c.env).homeV2(c.get("uid") ?? 0),
  );
}

/** GET /api/v2/subscribe — official-account follow status. */
export async function subscribeV2(c: C) {
  c.header("Cache-Control", "private, no-store");
  return jsonOk(c, {
    subscribe: await new PublicCatalogService(c.get("container"), c.env).subscribe(
      c.get("uid") ?? 0,
      { anonymousDefault: false, userType: "wechat" },
    ),
  });
}

/** GET /api/v2/diy/get_diy/:name? — public legacy DIY payload. */
export async function getDiyV2(c: C) {
  try {
    return jsonOk(c, await v2PublicService(c).diy(c.req.param("name") ?? ""));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/v2/bind_status — whether login must bind a mobile number. */
export async function bindPhoneStatusV2(c: C) {
  return jsonOk(c, await v2PublicService(c).bindPhoneStatus());
}

/** GET /api/v2/diy/get_store_status — self-pickup feature gate. */
export async function storeStatusV2(c: C) {
  return jsonOk(c, await v2PublicService(c).storeStatus());
}

/** GET /api/v2/diy/color_change/:name — theme and category switches. */
export async function colorChangeV2(c: C) {
  try {
    return jsonOk(c, await v2PublicService(c).colorChange(c.req.param("name")));
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}

/** GET /api/v2/diy/product_detail — legacy product-detail visual settings. */
export async function productDetailDiyV2(c: C) {
  return jsonOk(c, await v2PublicService(c).productDetail());
}

/** GET /api/v2/cityList — parse a slash-delimited imported WeChat address. */
export async function cityListV2(c: C) {
  try {
    const data = await v2PublicService(c).cityList(c.req.query("address"));
    return data === null
      ? jsonFail(c, "地址暂未录入，请联系管理员")
      : jsonOk(c, data);
  } catch (error) {
    if (error instanceof ValidateException) return jsonFail(c, error.message);
    throw error;
  }
}
