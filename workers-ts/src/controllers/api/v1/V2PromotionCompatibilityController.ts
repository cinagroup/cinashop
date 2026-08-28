import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { V2PromotionCompatibilityService } from "@/services/activity/V2PromotionCompatibilityService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { jsonFail, jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C): V2PromotionCompatibilityService {
  return new V2PromotionCompatibilityService(c.get("container"), c.env);
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store");
}

async function response<T>(c: C, operation: () => Promise<T>) {
  noStore(c);
  try {
    return jsonOk(c, await operation());
  } catch (error) {
    if (error instanceof ValidateException || error instanceof NotFoundException) {
      return jsonFail(c, error.message);
    }
    throw error;
  }
}

/** GET /api/v2/promotions/productList/:type — active platform promotion products. */
export async function productList(c: C) {
  return response(c, () => service(c).productList(c.req.param("type"), c.req.query()));
}

/** GET /api/v2/promotions/give_info/:id — active gift promotion rewards. */
export async function giveInfo(c: C) {
  return response(c, () => service(c).giveInfo(c.req.param("id")));
}

/** GET /api/v2/promotions/collect_order/product — authenticated promotion product picker. */
export async function collectOrderProduct(c: C) {
  return response(c, () => service(c).collectOrderProduct(
    c.get("uid") ?? 0,
    c.req.query("promotions_id"),
    c.req.query(),
  ));
}
