import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { StoreOperationsService } from "@/services/store/StoreOperationsService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function operations(c: C) {
  return new StoreOperationsService(c.get("container"));
}

function idParam(c: C, name = "id", allowZero = false): number {
  const id = Number(c.req.param(name) ?? "0");
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1)) {
    throw new ValidateException("ID错误");
  }
  return id;
}

async function body(c: C): Promise<Record<string, unknown>> {
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

export async function storeList(c: C) {
  return jsonOk(c, await operations(c).storeList(c.req.query()));
}

export async function storeHeader(c: C) {
  return jsonOk(c, await operations(c).storeHeader());
}

export async function storeDetail(c: C) {
  return jsonOk(c, await operations(c).storeDetail(idParam(c)));
}

export async function storeOptions(c: C) {
  return jsonOk(c, await operations(c).storeOptions());
}

export async function storeSave(c: C) {
  const id = idParam(c, "id", true);
  const result = await operations(c).saveStore(id, await body(c));
  return jsonOk(c, result, id ? "修改成功" : "保存成功");
}

export async function storeVisibility(c: C) {
  const result = await operations(c).setStoreVisibility(idParam(c), c.req.param("isShow"));
  return jsonOk(c, result, result.is_show ? "设置营业成功" : "设置停业成功");
}

export async function storeDelete(c: C) {
  const result = await operations(c).toggleStoreDeleted(idParam(c));
  return jsonOk(c, result, result.is_del ? "门店已移入回收站" : "门店恢复成功");
}

export async function staffList(c: C) {
  return jsonOk(c, await operations(c).staffList(c.req.query()));
}

export async function staffForm(c: C) {
  return jsonOk(c, await operations(c).staffForm(idParam(c, "id", true)));
}

export async function staffSave(c: C) {
  const id = idParam(c, "id", true);
  const result = await operations(c).saveStaff(id, await body(c));
  return jsonOk(c, result, id ? "编辑成功" : "店员添加成功");
}

export async function staffStatus(c: C) {
  const result = await operations(c).setStaffStatus(idParam(c), c.req.param("status"));
  return jsonOk(c, result, result.status ? "开启成功" : "关闭成功");
}

export async function staffDelete(c: C) {
  await operations(c).deleteStaff(idParam(c));
  return jsonOk(c, null, "删除成功");
}

export async function deliveryList(c: C) {
  return jsonOk(c, await operations(c).deliveryList(c.req.query()));
}

export async function deliverySelectList(c: C) {
  return jsonOk(c, await operations(c).deliveryList(c.req.query(), true));
}

export async function deliveryCandidates(c: C) {
  return jsonOk(c, await operations(c).deliveryCandidates(c.req.query()));
}

export async function deliveryDetail(c: C) {
  return jsonOk(c, await operations(c).deliveryDetail(idParam(c)));
}

export async function deliverySave(c: C) {
  return jsonOk(c, await operations(c).saveDelivery(0, await body(c)), "配送员添加成功");
}

export async function deliveryUpdate(c: C) {
  return jsonOk(
    c,
    await operations(c).saveDelivery(idParam(c), await body(c)),
    "修改成功",
  );
}

export async function deliveryStatus(c: C) {
  const result = await operations(c).setDeliveryStatus(idParam(c), c.req.param("status"));
  return jsonOk(c, result, result.status ? "开启成功" : "关闭成功");
}

export async function deliveryDelete(c: C) {
  await operations(c).deleteDelivery(idParam(c));
  return jsonOk(c, null, "删除成功");
}
