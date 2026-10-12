import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface AttachmentItem {
  att_id: number;
  canonical_url: string;
  att_dir: string;
  satt_dir: string;
  att_size: string;
  raw_size: number;
  att_type: string;
  pid: number;
  time: string;
  real_name: string;
  type?: number;
  file_type?: number;
  relation_id?: number;
  module_type?: number;
}

export interface AttachmentCategoryItem {
  id: number;
  pid: number;
  name: string;
  title: string;
  type?: number;
  file_type?: number;
  relation_id?: number;
}

const previewItems: AttachmentItem[] = [
  { att_id: 31, canonical_url: "/logo.png", att_dir: "/logo.png", satt_dir: "/logo.png", att_size: "48.2 KiB", raw_size: 49357, att_type: "image/png", pid: 0, time: "2026-08-10 10:20:00", real_name: "cinashop-brand.png", type: 1, file_type: 1, relation_id: 0, module_type: 1 },
  { att_id: 30, canonical_url: "/favicon.ico", att_dir: "/favicon.ico", satt_dir: "/favicon.ico", att_size: "2.1 KiB", raw_size: 2140, att_type: "image/x-icon", pid: 0, time: "2026-08-10 09:45:00", real_name: "storefront-reference.ico", type: 1, file_type: 1, relation_id: 0, module_type: 1 },
];
const previewCategories: AttachmentCategoryItem[] = [{ id: 1, pid: 0, name: "品牌素材", title: "品牌素材", type: 1, file_type: 1, relation_id: 0 }];
let previewId = 32;
let previewCategoryId = 2;

export async function apiAttachmentList(params: Record<string, unknown>, signal?: AbortSignal) {
  if (previewMode) {
    const pid = Number(params.pid ?? 0), name = String(params.name ?? "").trim();
    const matching = previewItems.filter(item => item.pid === pid && item.real_name.includes(name));
    const page = Number(params.page ?? 1), limit = Number(params.limit ?? 20);
    return { list: matching.slice((page - 1) * limit, page * limit), count: matching.length };
  }
  return getData<{ list: AttachmentItem[]; count: number }>(
    request.get("/file/file", { params, signal }),
  );
}

export async function apiAttachmentUpload(file: File, pid = 0, signal?: AbortSignal) {
  if (previewMode) {
    const previewUrl = URL.createObjectURL(file);
    const item: AttachmentItem = {
      att_id: previewId++, canonical_url: previewUrl, att_dir: previewUrl, satt_dir: previewUrl,
      att_size: `${(file.size / 1024).toFixed(1)} KiB`, raw_size: file.size,
      att_type: file.type, pid, time: new Date().toISOString().replace("T", " ").slice(0, 19), real_name: file.name,
      type: 1, file_type: 1, relation_id: 0, module_type: 1,
    };
    previewItems.unshift(item);
    return { att_id: item.att_id, src: item.att_dir, url: item.att_dir };
  }
  const body = new FormData();
  body.append("file", file);
  body.append("pid", String(pid));
  return getData<{ att_id: number; src: string; url: string }>(request.post("/file/upload", body, { signal }));
}

export async function apiAttachmentDelete(ids: number[], signal?: AbortSignal) {
  if (previewMode) {
    for (const id of ids) {
      const index = previewItems.findIndex((item) => item.att_id === id);
      if (index >= 0) {
        const [removed] = previewItems.splice(index, 1);
        if (removed.att_dir.startsWith("blob:")) URL.revokeObjectURL(removed.att_dir);
      }
    }
    return { ids, deleted: ids.length };
  }
  return getData<{ ids: number[]; deleted: number }>(
    request.post("/file/file/delete", { ids }, { signal }),
  );
}

export async function apiAttachmentCategories(signal?: AbortSignal, options: { all?: boolean; pid?: number } = {}) {
  if (previewMode) return { list: previewCategories.filter(item => options.all || item.pid === (options.pid ?? 0)) };
  return getData<{ list: AttachmentCategoryItem[] }>(
    request.get("/file/category", { params: { pid: options.pid ?? 0, file_type: 1, ...(options.all ? { all: 1 } : {}) }, signal }),
  );
}

export async function apiAttachmentCategoryCreate(name: string, signal?: AbortSignal) {
  if (previewMode) {
    const result = { id: previewCategoryId++, name, pid: 0, type: 1, file_type: 1, relation_id: 0 };
    previewCategories.push({ ...result, title: name });
    return result;
  }
  return getData<{ id: number }>(
    request.post("/file/category", { name, pid: 0, file_type: 1 }, { signal }),
  );
}

export async function apiAttachmentStorage(signal?: AbortSignal) {
  if (previewMode) return { active: { name: "Cloudflare R2", binding: "ASSETS_BUCKET", configured: true, private: true } };
  return getData<{ active: { name: string; binding: string; configured: boolean; private: boolean } }>(
    request.get("/config/storage", { signal }),
  );
}

export interface AttachmentMoveInput { ids: number[]; pid: number }
export interface AttachmentRenameInput { id: number; real_name: string }

export function normalizeAttachmentMove(ids: unknown, pid: unknown): AttachmentMoveInput {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) || new Set(ids).size !== ids.length) throw Error("请选择1至50项当前图片");
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0 || pid > 2_147_483_647) throw Error("请选择有效目标分类");
  return { ids: [...ids].sort((a, b) => a - b), pid };
}

export function normalizeAttachmentRename(id: unknown, name: unknown): AttachmentRenameInput {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) throw Error("请选择当前图片");
  if (typeof name !== "string" || !name.trim() || [...name.trim()].length > 255 || /[\u0000-\u001f\u007f]/.test(name.trim())) throw Error("名称须为1至255字且不含控制字符");
  return { id, real_name: name.trim() };
}

export async function apiAttachmentMove(input: AttachmentMoveInput, signal?: AbortSignal) {
  const value = normalizeAttachmentMove(input.ids, input.pid);
  if (previewMode) {
    if (value.ids.some(id => !previewItems.some(item => item.att_id === id)) || value.pid > 0 && !previewCategories.some(item => item.id === value.pid)) throw Error("素材或目标分类已改变");
    for (const item of previewItems) if (value.ids.includes(item.att_id)) item.pid = value.pid;
    return value;
  }
  return getData<AttachmentMoveInput>(request.put("/file/file/do_move", value, { signal }));
}

export async function apiAttachmentRename(input: AttachmentRenameInput, signal?: AbortSignal) {
  const value = normalizeAttachmentRename(input.id, input.real_name);
  if (previewMode) {
    const item = previewItems.find(item => item.att_id === value.id);
    if (!item) throw Error("素材已改变");
    item.real_name = value.real_name;
    return value;
  }
  return getData<AttachmentRenameInput>(request.put(`/file/file/update/${value.id}`, { real_name: value.real_name }, { signal }));
}
