import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  PrintDocumentManagementService,
  type PrintDocumentActor,
  type PrintDocumentOwner,
} from "@/services/system/PrintDocumentManagementService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";
import { readBoundedJsonObject } from "@/utils/request-body";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_PRINT_BODY_BYTES = 16 * 1024;

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

function clientIp(c: C): string {
  return (c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0] ?? "")
    .trim().slice(0, 45);
}

function adminActor(c: C): PrintDocumentActor {
  const admin = c.get("adminInfo");
  if (!admin) throw new ValidateException("管理员身份不存在");
  return {
    supplierId: 0,
    actorType: "admin",
    actorId: admin.id,
    actorName: admin.realName || admin.account,
    ip: clientIp(c),
  };
}

function supplierActor(c: C): PrintDocumentActor {
  const supplierId = c.get("supplierId");
  const admin = c.get("supplierAdminInfo");
  if (!Number.isSafeInteger(supplierId) || !supplierId || supplierId <= 0 || !admin) {
    throw new Error("supplier auth context missing");
  }
  return {
    supplierId,
    actorType: "supplier",
    actorId: admin.id,
    actorName: admin.realName || admin.account,
    ip: clientIp(c),
  };
}

function noStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

function idParam(c: C, allowZero = false): number {
  const id = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(id) || id < (allowZero ? 0 : 1)) {
    throw new ValidateException("打印机ID错误");
  }
  return id;
}

async function list(c: C, owner: PrintDocumentOwner) {
  noStore(c);
  return jsonOk(c, await service(c).list(owner, c.req.query()));
}

async function detail(c: C, owner: PrintDocumentOwner) {
  noStore(c);
  return jsonOk(c, await service(c).detail(owner, idParam(c, true)));
}

async function save(c: C, actor: PrintDocumentActor) {
  noStore(c);
  const id = idParam(c, true);
  return jsonOk(
    c,
    await service(c).save(actor, id, await readBoundedJsonObject(c.req.raw, MAX_PRINT_BODY_BYTES)),
    id ? "修改成功" : "保存成功",
  );
}

async function setStatus(c: C, actor: PrintDocumentActor) {
  noStore(c);
  return jsonOk(
    c,
    await service(c).setStatus(
      actor,
      idParam(c),
      c.req.param("status"),
      c.req.method === "POST" ? "POST" : "PUT",
    ),
    "修改成功",
  );
}

async function remove(c: C, actor: PrintDocumentActor) {
  noStore(c);
  await service(c).delete(actor, idParam(c));
  return jsonOk(c, null, "删除成功");
}

async function content(c: C, owner: PrintDocumentOwner) {
  noStore(c);
  return jsonOk(c, await service(c).content(owner, idParam(c)));
}

async function saveContent(c: C, actor: PrintDocumentActor) {
  noStore(c);
  return jsonOk(
    c,
    await service(c).saveContent(
      actor,
      idParam(c),
      await readBoundedJsonObject(c.req.raw, MAX_PRINT_BODY_BYTES),
    ),
    "保存成功",
  );
}

export const supplierList = (c: C) => list(c, supplierOwner(c));
export const supplierDetail = (c: C) => detail(c, supplierOwner(c));
export const supplierSave = (c: C) => save(c, supplierActor(c));
export const supplierSetStatus = (c: C) => setStatus(c, supplierActor(c));
export const supplierDelete = (c: C) => remove(c, supplierActor(c));
export const supplierContent = (c: C) => content(c, supplierOwner(c));
export const supplierSaveContent = (c: C) => saveContent(c, supplierActor(c));

export const adminList = (c: C) => list(c, platformOwner());
export const adminDetail = (c: C) => detail(c, platformOwner());
export const adminSave = (c: C) => save(c, adminActor(c));
export const adminSetStatus = (c: C) => setStatus(c, adminActor(c));
export const adminDelete = (c: C) => remove(c, adminActor(c));
export const adminContent = (c: C) => content(c, platformOwner());
export const adminSaveContent = (c: C) => saveContent(c, adminActor(c));
