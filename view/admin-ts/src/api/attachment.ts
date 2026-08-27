import request, { getData } from "@/utils/request";

const previewMode =
  import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "1";

export interface AttachmentItem {
  att_id: number;
  att_dir: string;
  satt_dir: string;
  att_size: string;
  raw_size: number;
  att_type: string;
  pid: number;
  time: string;
  real_name: string;
}

export interface AttachmentCategoryItem {
  id: number;
  pid: number;
  name: string;
  title: string;
}

const previewItems: AttachmentItem[] = [
  { att_id: 31, att_dir: "/logo.png", satt_dir: "/logo.png", att_size: "48.2 KiB", raw_size: 49357, att_type: "image/png", pid: 0, time: "2026-08-10 10:20:00", real_name: "cinashop-brand.png" },
  { att_id: 30, att_dir: "/favicon.ico", satt_dir: "/favicon.ico", att_size: "2.1 KiB", raw_size: 2140, att_type: "image/x-icon", pid: 0, time: "2026-08-10 09:45:00", real_name: "storefront-reference.ico" },
];

export async function apiAttachmentList(params: Record<string, unknown>) {
  if (previewMode) return { list: previewItems, count: previewItems.length };
  return getData<{ list: AttachmentItem[]; count: number }>(
    request.get("/file/file", { params }),
  );
}

export async function apiAttachmentUpload(file: File, pid = 0) {
  if (previewMode) {
    const previewUrl = URL.createObjectURL(file);
    const item: AttachmentItem = {
      att_id: Date.now(), att_dir: previewUrl, satt_dir: previewUrl,
      att_size: `${(file.size / 1024).toFixed(1)} KiB`, raw_size: file.size,
      att_type: file.type, pid, time: new Date().toISOString().replace("T", " ").slice(0, 19), real_name: file.name,
    };
    previewItems.unshift(item);
    return { att_id: item.att_id, src: item.att_dir, url: item.att_dir };
  }
  const body = new FormData();
  body.append("file", file);
  body.append("pid", String(pid));
  return getData<{ att_id: number; src: string; url: string }>(request.post("/file/upload", body));
}

export async function apiAttachmentDelete(ids: number[]) {
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
    request.post("/file/file/delete", { ids }),
  );
}

export async function apiAttachmentCategories() {
  if (previewMode) return { list: [{ id: 1, pid: 0, name: "品牌素材", title: "品牌素材" }] };
  return getData<{ list: AttachmentCategoryItem[] }>(
    request.get("/file/category", { params: { pid: 0, file_type: 1 } }),
  );
}

export async function apiAttachmentCategoryCreate(name: string) {
  if (previewMode) return { id: Date.now(), name, pid: 0, file_type: 1 };
  return getData<{ id: number }>(
    request.post("/file/category", { name, pid: 0, file_type: 1 }),
  );
}

export async function apiAttachmentStorage() {
  if (previewMode) return { active: { name: "Cloudflare R2", binding: "ASSETS_BUCKET", configured: true, private: true } };
  return getData<{ active: { name: string; binding: string; configured: boolean; private: boolean } }>(
    request.get("/config/storage"),
  );
}
