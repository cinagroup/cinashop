import type { Context } from "hono";
import { inArray, sql } from "drizzle-orm";
import { createContainerFromDb, withTx } from "@/lib/di";
import { storeProduct } from "@/models/schema";
import { themeDeadlines } from "@/services/content/ThemeReadService";
import { publicProductPictures, renderProductPictures } from "@/services/activity/ProductAssetPolicy";
import type { AppVariables, Env } from "@/env";
import { jsonOk } from "@/utils/json";
import { couponScopeProductsQuery, CouponScopeProductsService } from "@/services/activity/CouponScopeProductsService";

export async function couponScopeProducts(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  c.header("Cache-Control", "private, no-store");
  const service = new CouponScopeProductsService(c.get("container"));
  if (c.req.query("view") === "search") {
    const projected = await withTx(c.get("container"), async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await themeDeadlines(tx);
      const result = await new CouponScopeProductsService(createContainerFromDb(tx))
        .search(c.get("uid"), c.req.param("id"), c.req.query());
      const products = result.list.length ? await tx.select({ id: storeProduct.id, image: storeProduct.image,
        type: storeProduct.type, relationId: storeProduct.relationId }).from(storeProduct)
        .where(inArray(storeProduct.id, result.list.map(row => row.id))) : [];
      const byId = new Map(products.map(row => [row.id, row]));
      const references = await publicProductPictures(tx, result.list.map(row => {
        const product = byId.get(row.id);
        return product && product.image === row.image ? product : { image: "", type: -1, relationId: -1 };
      }), 256);
      return { result, references };
    });
    const images = await renderProductPictures(c.env.APP_KEY, projected.references);
    return jsonOk(c, { ...projected.result, list: projected.result.list.map((row, index) => ({ ...row, image: images[index] })) });
  }
  const query = couponScopeProductsQuery(c.req.param("id"), c.req.query());
  const result = c.req.query("view") === "scope" ? await service.describe(c.get("uid"), query) : await service.list(c.get("uid"), query);
  return jsonOk(c, result);
}
