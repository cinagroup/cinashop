import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { VirtualProductInventoryService } from "@/services/product/VirtualProductInventoryService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

const MAX_IMPORT_BODY_BYTES = 512 * 1024;
const MAX_EXPORT_OPERATION_BODY_BYTES = 4 * 1024;

function service(c: C) {
  return new VirtualProductInventoryService(c.get("container"));
}

function productId(c: C): number {
  const value = Number(c.req.param("id") ?? "0");
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidateException("商品ID错误");
  }
  return value;
}

function supplierOwner(c: C) {
  const supplierId = c.get("supplierId");
  if (!supplierId) throw new ValidateException("供应商身份不存在");
  return { kind: "supplier" as const, supplierId };
}

async function boundedJsonObject(
  c: C,
  maxBytes = MAX_IMPORT_BODY_BYTES,
  label = "卡密导入数据",
): Promise<Record<string, unknown>> {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ValidateException(`${label}过大`);
  }
  const body = c.req.raw.body;
  if (!body) throw new ValidateException(`${label}格式错误`);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("request body too large");
        throw new ValidateException(`${label}过大`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidateException(`${label}格式错误`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return value as Record<string, unknown>;
}

function adminActor(c: C) {
  const actorId = Number(c.get("adminId"));
  if (!Number.isSafeInteger(actorId) || actorId <= 0) {
    throw new ValidateException("管理员身份无效");
  }
  return { kind: "admin" as const, actorId };
}

function supplierActor(c: C) {
  const actorId = Number(c.get("supplierAdminId"));
  const supplierId = Number(c.get("supplierId"));
  if (
    !Number.isSafeInteger(actorId) || actorId <= 0
    || !Number.isSafeInteger(supplierId) || supplierId <= 0
  ) {
    throw new ValidateException("供应商身份无效");
  }
  return { kind: "supplier" as const, actorId, supplierId };
}

function protectSensitiveResponse(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  c.header("Expires", "0");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
}

export async function adminInventory(c: C) {
  return jsonOk(
    c,
    await service(c).inventory({ kind: "admin" }, productId(c), c.req.query()),
  );
}

export async function adminAlerts(c: C) {
  return jsonOk(c, await service(c).alerts({ kind: "admin" }, c.req.query()));
}

export async function adminImport(c: C) {
  return jsonOk(
    c,
    await service(c).importCards({ kind: "admin" }, productId(c), await boundedJsonObject(c)),
    "卡密导入完成",
  );
}

export async function adminCreateExportTicket(c: C) {
  protectSensitiveResponse(c);
  return jsonOk(
    c,
    await service(c).createExportTicket(
      adminActor(c),
      productId(c),
      await boundedJsonObject(c, MAX_EXPORT_OPERATION_BODY_BYTES, "卡密导出申请"),
    ),
    "一次性导出票据已创建",
  );
}

export async function adminConsumeExportTicket(c: C) {
  protectSensitiveResponse(c);
  return jsonOk(
    c,
    await service(c).consumeExportTicket(
      adminActor(c),
      productId(c),
      await boundedJsonObject(c, MAX_EXPORT_OPERATION_BODY_BYTES, "卡密导出票据"),
    ),
    "未分配卡密已一次性导出",
  );
}

export async function supplierInventory(c: C) {
  return jsonOk(
    c,
    await service(c).inventory(supplierOwner(c), productId(c), c.req.query()),
  );
}

export async function supplierAlerts(c: C) {
  return jsonOk(c, await service(c).alerts(supplierOwner(c), c.req.query()));
}

export async function supplierImport(c: C) {
  return jsonOk(
    c,
    await service(c).importCards(supplierOwner(c), productId(c), await boundedJsonObject(c)),
    "卡密导入完成",
  );
}

export async function supplierCreateExportTicket(c: C) {
  protectSensitiveResponse(c);
  return jsonOk(
    c,
    await service(c).createExportTicket(
      supplierActor(c),
      productId(c),
      await boundedJsonObject(c, MAX_EXPORT_OPERATION_BODY_BYTES, "卡密导出申请"),
    ),
    "一次性导出票据已创建",
  );
}

export async function supplierConsumeExportTicket(c: C) {
  protectSensitiveResponse(c);
  return jsonOk(
    c,
    await service(c).consumeExportTicket(
      supplierActor(c),
      productId(c),
      await boundedJsonObject(c, MAX_EXPORT_OPERATION_BODY_BYTES, "卡密导出票据"),
    ),
    "未分配卡密已一次性导出",
  );
}
