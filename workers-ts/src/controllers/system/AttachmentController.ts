import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  adminAttachmentScope,
  AttachmentService,
  kefuAttachmentScope,
  MAX_MULTIPART_IMAGE_BYTES,
  MAX_MULTIPART_VIDEO_CHUNK_BYTES,
  R2_IMAGE_TYPE,
  supplierAttachmentScope,
  userAttachmentScope,
  visitorAttachmentScope,
} from "@/services/system/AttachmentService";
import {
  enforceKefuUploadRateLimit,
  enforceVisitorUploadRateLimit,
} from "@/middleware/kefu-rate-limit";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C): AttachmentService {
  return new AttachmentService(c.get("container"), c.env);
}

async function boundedJson(c: C): Promise<Record<string, unknown>> {
  const maximum = 64 * 1024;
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maximum) {
    throw new ValidateException("请求数据不能超过64 KiB");
  }
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("请求数据格式错误");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new ValidateException("请求数据不能超过64 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidateException("请求数据格式错误");
  }
  return parsed as Record<string, unknown>;
}

async function boundedMultipartImage(c: C): Promise<{ file: File; pid: string | File | null }> {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new ValidateException("请使用multipart/form-data上传图片");
  }
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > MAX_MULTIPART_IMAGE_BYTES) {
    throw new ValidateException("上传请求不能超过10.25 MiB");
  }
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("请选择图片文件");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MULTIPART_IMAGE_BYTES) {
      await reader.cancel();
      throw new ValidateException("上传请求不能超过10.25 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ValidateException("上传表单格式错误");
  }
  const entries = [form.get("file"), form.get("filename")];
  const files = entries.filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length !== 1) throw new ValidateException("请选择一个图片文件");
  return { file: files[0], pid: form.get("pid") };
}

async function boundedMultipartVideoChunk(c: C) {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new ValidateException("请使用multipart/form-data上传视频分片");
  }
  const declaredLength = Number(c.req.header("content-length") ?? "0");
  if (
    !Number.isFinite(declaredLength) || declaredLength <= 0 ||
    declaredLength > MAX_MULTIPART_VIDEO_CHUNK_BYTES
  ) throw new ValidateException("视频分片请求不能超过5.25 MiB");
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("请选择视频文件");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MULTIPART_VIDEO_CHUNK_BYTES) {
      await reader.cancel();
      throw new ValidateException("视频分片请求不能超过5.25 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ValidateException("视频上传表单格式错误");
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size <= 0) throw new ValidateException("请选择视频文件");
  return {
    file,
    chunkNumber: form.get("chunkNumber"),
    currentChunkSize: form.get("currentChunkSize"),
    chunkSize: form.get("chunkSize"),
    totalChunks: form.get("totalChunks"),
    md5: form.get("md5"),
    filename: form.get("filename"),
    pid: form.get("pid"),
  };
}

async function upload(c: C, owner: "admin" | "supplier" | "user") {
  const { file, pid } = await boundedMultipartImage(c);
  const scope = owner === "admin"
    ? adminAttachmentScope()
    : owner === "supplier"
      ? supplierAttachmentScope(c.get("supplierId") ?? 0)
      : userAttachmentScope(c.get("uid"));
  return jsonOk(c, await service(c).uploadImage(scope, file, pid), "上传成功");
}

async function remove(c: C, owner: "admin" | "supplier") {
  const input = await boundedJson(c);
  const scope = owner === "admin"
    ? adminAttachmentScope()
    : supplierAttachmentScope(c.get("supplierId") ?? 0);
  return jsonOk(c, await service(c).delete(scope, input.ids), "删除成功");
}

async function move(c: C, owner: "admin" | "supplier") {
  const input = await boundedJson(c);
  const scope = owner === "admin"
    ? adminAttachmentScope()
    : supplierAttachmentScope(c.get("supplierId") ?? 0);
  return jsonOk(c, await service(c).move(scope, input.images ?? input.ids, input.pid), "移动成功");
}

async function rename(c: C, owner: "admin" | "supplier") {
  const input = await boundedJson(c);
  const scope = owner === "admin"
    ? adminAttachmentScope()
    : supplierAttachmentScope(c.get("supplierId") ?? 0);
  return jsonOk(c, await service(c).rename(scope, c.req.param("id"), input.real_name), "修改成功");
}

async function saveCategory(c: C, owner: "admin" | "supplier", id?: string) {
  const input = await boundedJson(c);
  const scope = owner === "admin"
    ? adminAttachmentScope()
    : supplierAttachmentScope(c.get("supplierId") ?? 0);
  return jsonOk(c, await service(c).saveCategory(scope, id, input), id ? "分类编辑成功" : "添加成功");
}

async function deleteCategory(c: C, owner: "admin" | "supplier") {
  const scope = owner === "admin"
    ? adminAttachmentScope()
    : supplierAttachmentScope(c.get("supplierId") ?? 0);
  return jsonOk(c, await service(c).deleteCategory(scope, c.req.param("id")), "删除成功");
}

async function categoryForm(c: C, owner: "admin" | "supplier", id?: string) {
  const scope = owner === "admin"
    ? adminAttachmentScope()
    : supplierAttachmentScope(c.get("supplierId") ?? 0);
  const pid = Number(c.req.param("parentId") ?? c.req.query("id") ?? 0) || 0;
  const fileType = Number(c.req.query("file_type") ?? 1) || 1;
  const info = id ? await service(c).categoryDetail(scope, id) : { pid, name: "", fileType };
  const prefix = owner === "admin" ? "/adminapi" : "/supplierapi";
  return jsonOk(c, {
    title: id ? "编辑附件分类" : "添加附件分类",
    method: id ? "PUT" : "POST",
    action: `${prefix}/file/category${id ? `/${id}` : ""}`,
    rules: [
      { field: "file_type", title: "文件类型", type: "hidden", value: info.fileType },
      { field: "pid", title: "上级分类", type: "number", value: info.pid },
      { field: "name", title: "分类名称", type: "input", value: info.name, maxlength: 50 },
    ],
    info,
  });
}

export async function asset(c: C) {
  try {
    const asset = await service(c).getSignedAsset(
      c.req.param("id"),
      c.req.query("expires"),
      c.req.query("signature"),
      c.req.query("variant"),
      c.req.query("width"),
      c.req.query("height"),
      c.req.header("range"),
    );
    if (asset.cacheWrite) c.executionCtx.waitUntil(asset.cacheWrite());
    const headers = new Headers(asset.response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
    return new Response(asset.response.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof NotFoundException) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}

export const userUploadImage = (c: C) => upload(c, "user");
export const adminUploadImage = (c: C) => upload(c, "admin");
export const supplierUploadImage = (c: C) => upload(c, "supplier");

export async function supplierUploadVideo(c: C) {
  const scope = supplierAttachmentScope(c.get("supplierId") ?? 0);
  return jsonOk(c, await service(c).uploadVideoChunk(scope, await boundedMultipartVideoChunk(c)));
}

export async function supplierSaveVideoAttachment(c: C) {
  const scope = supplierAttachmentScope(c.get("supplierId") ?? 0);
  return jsonOk(
    c,
    await service(c).saveExternalVideoAttachment(scope, await boundedJson(c)),
    "视频素材保存成功",
  );
}

/** Dedicated Kefu upload keeps the canonical path for chat persistence and a signed preview URL. */
export async function kefuUploadImage(c: C) {
  // Reject exhausted buckets before buffering a multipart body.
  await enforceKefuUploadRateLimit(c);
  const { file, pid } = await boundedMultipartImage(c);
  const result = await service(c).uploadImage(kefuAttachmentScope(c.get("kefuId") ?? 0), file, pid);
  return jsonOk(c, result, "图片上传成功!");
}

/** Visitor uploads are isolated from both registered-user and agent R2 namespaces. */
export async function visitorUploadImage(c: C) {
  await enforceVisitorUploadRateLimit(c);
  const identity = c.get("visitorSession");
  if (!identity) throw new ValidateException("游客会话无效");
  const { file, pid } = await boundedMultipartImage(c);
  const result = await service(c).uploadImage(visitorAttachmentScope(identity.visitorUid), file, pid);
  return jsonOk(c, result, "图片上传成功!");
}

export async function adminList(c: C) {
  return jsonOk(c, await service(c).list(adminAttachmentScope(), c.req.query()));
}

export async function supplierList(c: C) {
  return jsonOk(c, await service(c).list(
    supplierAttachmentScope(c.get("supplierId") ?? 0),
    c.req.query(),
  ));
}

export const adminDelete = (c: C) => remove(c, "admin");
export const supplierDelete = (c: C) => remove(c, "supplier");
export const adminMove = (c: C) => move(c, "admin");
export const supplierMove = (c: C) => move(c, "supplier");
export const adminRename = (c: C) => rename(c, "admin");
export const supplierRename = (c: C) => rename(c, "supplier");

export async function adminCategories(c: C) {
  return jsonOk(c, await service(c).listCategories(adminAttachmentScope(), c.req.query()));
}

export async function supplierCategories(c: C) {
  return jsonOk(c, await service(c).listCategories(
    supplierAttachmentScope(c.get("supplierId") ?? 0),
    c.req.query(),
  ));
}

export const adminCategoryCreateForm = (c: C) => categoryForm(c, "admin");
export const supplierCategoryCreateForm = (c: C) => categoryForm(c, "supplier");
export const adminCategoryEditForm = (c: C) => categoryForm(c, "admin", c.req.param("id"));
export const supplierCategoryEditForm = (c: C) => categoryForm(c, "supplier", c.req.param("id"));
export const adminCategorySave = (c: C) => saveCategory(c, "admin");
export const supplierCategorySave = (c: C) => saveCategory(c, "supplier");
export const adminCategoryUpdate = (c: C) => saveCategory(c, "admin", c.req.param("id"));
export const supplierCategoryUpdate = (c: C) => saveCategory(c, "supplier", c.req.param("id"));
export const adminCategoryDelete = (c: C) => deleteCategory(c, "admin");
export const supplierCategoryDelete = (c: C) => deleteCategory(c, "supplier");

export function uploadType(c: C) {
  return jsonOk(c, { upload_type: String(R2_IMAGE_TYPE), binding: "ASSETS_BUCKET" });
}

export function supplierUploadType(c: C) {
  return jsonOk(c, {
    upload_type: "1",
    storage_type: String(R2_IMAGE_TYPE),
    binding: "ASSETS_BUCKET",
    direct_upload: true,
  });
}

export function supplierUploadWayData(c: C) {
  return jsonOk(c, {
    is_way: 0,
    upload_file_size_max: 10 * 1024,
    upload_type: "1",
    storage_type: String(R2_IMAGE_TYPE),
    binding: "ASSETS_BUCKET",
  });
}

export async function adminStorage(c: C) {
  return jsonOk(c, await service(c).legacyStorageList(c.req.query()));
}

export function adminStorageConfig(c: C) {
  return jsonOk(c, {
    type: R2_IMAGE_TYPE,
    name: "Cloudflare R2",
    binding: "ASSETS_BUCKET",
    configured: true,
    private: true,
  });
}
