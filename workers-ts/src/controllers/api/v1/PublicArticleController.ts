import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { PublicArticleCompatibilityService } from "@/services/content/PublicArticleCompatibilityService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C): PublicArticleCompatibilityService {
  return new PublicArticleCompatibilityService(c.get("container"), c.env.APP_KEY);
}

function noStore(c: C, personalized = false): void {
  c.header("Cache-Control", personalized ? "private, no-store" : "no-store");
}

export async function categoryList(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).categories());
}

export async function articleList(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).list(c.req.param("cid"), c.req.query()));
}

export async function articleLike(c: C) {
  noStore(c, true);
  await service(c).like(c.get("uid") ?? 0, c.req.param("id"), c.req.query("status"));
  // PHP's successful(true) promotes the scalar to msg and omits data. The
  // first-party client ignores the body, but retain the observable envelope.
  return c.json({ status: 200, msg: "1" });
}

export async function articleDetails(c: C) {
  noStore(c, true);
  return jsonOk(c, await service(c).details(c.get("uid") ?? 0, c.req.param("id")));
}

export async function hotList(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).hot(c.req.query()));
}

export async function newList(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).newest(c.req.query()));
}

export async function bannerList(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).banner(c.req.query()));
}
