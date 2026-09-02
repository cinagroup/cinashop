import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { SupplierProductReplyService } from "@/services/supplier/SupplierProductReplyService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new SupplierProductReplyService(c.get("container"));
}

function supplierId(c: C): number {
  const value = c.get("supplierId");
  if (!Number.isSafeInteger(value) || !value || value <= 0) {
    throw new Error("supplier auth context missing");
  }
  return value;
}

function positiveId(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException("评价ID无效");
  }
  return parsed;
}

export async function list(c: C) {
  return jsonOk(c, await service(c).list(supplierId(c), c.req.query()));
}

export async function setReply(c: C) {
  const body = await readBoundedJsonObject(c.req.raw, 8 * 1024);
  return jsonOk(
    c,
    await service(c).setReply(supplierId(c), positiveId(c.req.param("id")), body.content),
    "回复成功",
  );
}
