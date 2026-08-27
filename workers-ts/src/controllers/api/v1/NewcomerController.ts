import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { StoreNewcomerService } from "@/services/activity/StoreNewcomerService";
import { ProductExperienceService } from "@/services/product/ProductExperienceService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function productList(c: C) {
  return jsonOk(
    c,
    await new StoreNewcomerService(c.get("container"), c.env)
      .list(c.get("uid") ?? 0, c.req.query("page"), c.req.query("limit")),
  );
}

export async function productDetail(c: C) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return jsonFail(c, "缺少参数");
  try {
    const data = await new StoreNewcomerService(c.get("container"), c.env)
      .detail(c.get("uid") ?? 0, id);
    const productId = Number((data.storeInfo as { product_id?: number } | undefined)?.product_id ?? 0);
    if (productId > 0) {
      c.executionCtx.waitUntil(
        new ProductExperienceService(c.get("container"))
          .recordVisit(c.get("uid") ?? 0, productId, id)
          .catch((error) => console.error(JSON.stringify({ event: "newcomer_visit_record_failed", error: String(error) }))),
      );
    }
    return jsonOk(c, data);
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}

export async function info(c: C) {
  return jsonOk(
    c,
    await new StoreNewcomerService(c.get("container"), c.env).info(c.get("uid"), false),
  );
}

export async function gift(c: C) {
  return jsonOk(
    c,
    await new StoreNewcomerService(c.get("container"), c.env).info(c.get("uid"), true),
  );
}
