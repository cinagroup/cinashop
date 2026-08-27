import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminSupplierFinanceService } from "@/services/admin/AdminSupplierFinanceService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new AdminSupplierFinanceService(c.get("container"));
}

function extractId(c: C) {
  const id = Number(c.req.param("id") ?? 0);
  if (!Number.isInteger(id) || id <= 0) throw new ValidateException("提现记录ID错误");
  return id;
}

function adminId(c: C) {
  const id = c.get("adminId") ?? 0;
  if (!id) throw new ValidateException("管理员身份缺失");
  return id;
}

async function body(c: C): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求参数格式错误");
  }
  return value as Record<string, unknown>;
}

export async function supplierExtractList(c: C) {
  return jsonOk(c, await service(c).list(c.req.query()));
}

export async function supplierExtractReview(c: C) {
  await service(c).review(extractId(c), adminId(c), await body(c));
  return jsonOk(c, null, "审核完成");
}

export async function supplierExtractTransfer(c: C) {
  await service(c).transfer(extractId(c), adminId(c), await body(c));
  return jsonOk(c, null, "转账记录已确认");
}

export async function supplierExtractMark(c: C) {
  const input = await body(c);
  if (typeof input.mark !== "string") throw new ValidateException("后台备注格式错误");
  await service(c).updateMark(extractId(c), input.mark);
  return jsonOk(c, null, "备注已保存");
}
