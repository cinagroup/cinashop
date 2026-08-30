import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { EnterpriseWechatJsSdkService } from "@/services/work/EnterpriseWechatJsSdkService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function signedUrl(c: C): string {
  const url = c.req.query("url");
  if (!url) throw new ValidateException("url 不能为空");
  return url;
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

/** GET /api/work/config — enterprise-level JS-SDK signature. */
export async function config(c: C) {
  noStore(c);
  const data = await new EnterpriseWechatJsSdkService(c.get("container"), c.env)
    .companyConfig(signedUrl(c));
  return jsonOk(c, data);
}

/** GET /api/work/agentConfig — application-level JS-SDK signature. */
export async function agentConfig(c: C) {
  noStore(c);
  const data = await new EnterpriseWechatJsSdkService(c.get("container"), c.env)
    .agentConfig(signedUrl(c));
  return jsonOk(c, data);
}
