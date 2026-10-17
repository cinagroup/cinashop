import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { parseSupplierProductReplyInput, SupplierProductReplyService } from "@/services/supplier/SupplierProductReplyService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";
import { categoryActor } from './SupplierProductCategoryController';

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
  const query: Record<string, string | undefined> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) throw new ValidateException('评价查询参数不能重复');
    query[key] = values[0];
  }
  const owner = supplierId(c);
  return jsonOk(c, await service(c).list(owner, query, { ...await categoryActor(c), supplierId: owner }));
}

export async function setReply(c: C) {
  if (new URL(c.req.url).search) throw new ValidateException('评价回复不接受查询参数');
  const body = parseSupplierProductReplyInput(await readBoundedJsonObject(c.req.raw, 8 * 1024)), owner = supplierId(c);
  return jsonOk(
    c,
    await service(c).setReply(owner, positiveId(c.req.param("id")), body.content, { ...await categoryActor(c), supplierId: owner }, body.expectedProductId),
    "回复成功",
  );
}
