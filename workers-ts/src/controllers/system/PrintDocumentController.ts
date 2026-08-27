import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  PrintDocumentManagementService,
  type PrintDocumentOwner,
} from "@/services/system/PrintDocumentManagementService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new PrintDocumentManagementService(c.get("container"));
}

function platformOwner(): PrintDocumentOwner {
  return { supplierId: 0 };
}

function supplierOwner(c: C): PrintDocumentOwner {
  const supplierId = c.get("supplierId");
  if (!Number.isSafeInteger(supplierId) || !supplierId || supplierId <= 0) {
    throw new Error("supplier auth context missing");
  }
  return { supplierId };
}

function idParam(c: C, allowZero = false): number {
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1)) {
    throw new ValidateException("打印机ID错误");
  }
  return id;
}

async function body(c: C): Promise<Record<string, unknown>> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > 64 * 1024) {
    throw new ValidateException("请求数据不能超过64 KiB");
  }
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  if (JSON.stringify(value).length > 64 * 1024) {
    throw new ValidateException("请求数据不能超过64 KiB");
  }
  return value as Record<string, unknown>;
}

async function list(c: C, owner: PrintDocumentOwner) {
  return jsonOk(c, await service(c).list(owner, c.req.query()));
}

async function detail(c: C, owner: PrintDocumentOwner) {
  return jsonOk(c, await service(c).detail(owner, idParam(c, true)));
}

async function save(c: C, owner: PrintDocumentOwner) {
  const id = idParam(c, true);
  return jsonOk(
    c,
    await service(c).save(owner, id, await body(c)),
    id ? "修改成功" : "保存成功",
  );
}

async function setStatus(c: C, owner: PrintDocumentOwner) {
  return jsonOk(
    c,
    await service(c).setStatus(owner, idParam(c), c.req.param("status")),
    "修改成功",
  );
}

async function remove(c: C, owner: PrintDocumentOwner) {
  await service(c).delete(owner, idParam(c));
  return jsonOk(c, null, "删除成功");
}

async function content(c: C, owner: PrintDocumentOwner) {
  return jsonOk(c, await service(c).content(owner, idParam(c)));
}

async function saveContent(c: C, owner: PrintDocumentOwner) {
  return jsonOk(
    c,
    await service(c).saveContent(owner, idParam(c), await body(c)),
    "保存成功",
  );
}

export const supplierList = (c: C) => list(c, supplierOwner(c));
export const supplierDetail = (c: C) => detail(c, supplierOwner(c));
export const supplierSave = (c: C) => save(c, supplierOwner(c));
export const supplierSetStatus = (c: C) => setStatus(c, supplierOwner(c));
export const supplierDelete = (c: C) => remove(c, supplierOwner(c));
export const supplierContent = (c: C) => content(c, supplierOwner(c));
export const supplierSaveContent = (c: C) => saveContent(c, supplierOwner(c));

export const adminList = (c: C) => list(c, platformOwner());
export const adminDetail = (c: C) => detail(c, platformOwner());
export const adminSave = (c: C) => save(c, platformOwner());
export const adminSetStatus = (c: C) => setStatus(c, platformOwner());
export const adminDelete = (c: C) => remove(c, platformOwner());
export const adminContent = (c: C) => content(c, platformOwner());
export const adminSaveContent = (c: C) => saveContent(c, platformOwner());
