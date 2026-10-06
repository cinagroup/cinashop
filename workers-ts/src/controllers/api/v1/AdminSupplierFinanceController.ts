import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminSupplierFinanceService } from "@/services/admin/AdminSupplierFinanceService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new AdminSupplierFinanceService(c.get("container"));
}

function extractId(c: C) {
  const raw = c.req.param("id") ?? "";
  if (!/^[1-9]\d*$/.test(raw)) throw new ValidateException("提现记录ID错误");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) throw new ValidateException("提现记录ID错误");
  return id;
}

function adminId(c: C) {
  const id = c.get("adminId") ?? 0;
  if (!id) throw new ValidateException("管理员身份缺失");
  return id;
}

async function body(c: C): Promise<Record<string, unknown>> {
  return readBoundedJsonObject(c.req.raw, 2 * 1024);
}

function noStore(c: C) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

export async function supplierExtractSuppliers(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).suppliers(new URL(c.req.url).searchParams));
}

export async function supplierExtractList(c: C) {
  noStore(c);
  return jsonOk(c, await service(c).list(new URL(c.req.url).searchParams));
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
  noStore(c);
  return jsonOk(c, await service(c).updateMark(extractId(c), adminId(c), await body(c)), "备注已保存");
}
