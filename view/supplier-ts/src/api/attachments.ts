import { apiRequest } from '@/api/http';
import { createSupplierSessionScope } from '@/utils/supplierSession';

export interface SupplierAttachment {
  id: number;
  pid: number;
  name: string;
  canonicalUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
}
export interface AttachmentCategory { id: number; pid: number; name: string; hasChildren: boolean }
export interface AttachmentQuery { pid: number; name: string; page: number }
export interface SupplierUploadedImage {
  id: number; canonicalUrl: string; previewUrl: string; name: string; size: number; mime: string;
}
const invalidResponse = () => new Error('图片资料响应无效，请刷新核对');
const maxId = 2_147_483_647;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maxId) throw invalidResponse();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw invalidResponse();
  return value;
}

export function normalizeAttachmentQuery(query: AttachmentQuery): AttachmentQuery {
  const pid = integer(query.pid, 0), page = integer(query.page);
  if (typeof query.name !== 'string' || query.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(query.name) || page > 1_000_000) {
    throw new Error('图片目录、搜索或分页参数错误');
  }
  return { pid, name: query.name.trim(), page };
}

/** Admin id and supplier id are separate identities. Never fall back to admin id. */
export function currentSupplierAttachmentOwner(): number {
  try { return integer(record(JSON.parse(localStorage.getItem('supplier-user') ?? 'null')).supplier_id); }
  catch { throw new Error('供应商登录资料已失效，请重新登录'); }
}

function externalImageUrl(value: string): string {
  if (value.length > 4096 || value.trim() !== value || /[\s\\\u0000-\u001f\u007f]/.test(value) || !value.startsWith('https://')) throw invalidResponse();
  let url: URL;
  try { url = new URL(value); } catch { throw invalidResponse(); }
  if (!url.hostname || url.username || url.password || url.hash || url.pathname.startsWith('/api/assets/')) throw invalidResponse();
  // These are temporary asset tickets, never a stable product reference.
  for (const key of url.searchParams.keys()) if (/^(expires|signature)$/i.test(key)) throw invalidResponse();
  return value;
}
function canonicalImageUrl(value: unknown, id: number): string {
  const url = text(value, 4096);
  if (url === `/api/assets/${id}`) return url;
  return externalImageUrl(url);
}
function previewImageUrl(value: unknown, canonical: string, id: number): string {
  const url = text(value, 4096);
  if (!canonical.startsWith('/api/assets/')) {
    if (url !== canonical) throw invalidResponse();
    return externalImageUrl(url);
  }
  // Match the raw string, not a normalized URL that could conceal a second path.
  const match = new RegExp(`^/api/assets/${id}\\?expires=([1-9]\\d*)&signature=([A-Za-z0-9_-]{43})$`).exec(url);
  const now = Math.floor(Date.now() / 1000), expires = match ? Number(match[1]) : 0;
  if (!match || !Number.isSafeInteger(expires) || expires <= now || expires > now + 3600) throw invalidResponse();
  return url;
}

/** Decode the whole page before publishing any row; one foreign/malformed row fails the batch. */
export function decodeSupplierAttachmentPage(value: unknown, target: AttachmentQuery, supplierId: number): { list: SupplierAttachment[]; count: number } {
  const query = normalizeAttachmentQuery(target), owner = integer(supplierId), body = record(value);
  const count = integer(body.count, 0);
  if (!Array.isArray(body.list) || body.list.length > 20 || body.list.length > Math.max(0, count - (query.page - 1) * 20)) throw invalidResponse();
  const ids = new Set<number>();
  const list = body.list.map(value => {
    const row = record(value), id = integer(row.att_id), pid = integer(row.pid, 0);
    if (ids.has(id) || row.type !== 4 || row.file_type !== 1 || row.module_type !== 1 || row.relation_id !== owner || pid !== query.pid) throw invalidResponse();
    ids.add(id);
    const mime = text(row.att_type, 128);
    if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) throw invalidResponse();
    const name = text(row.real_name, 255), canonicalUrl = canonicalImageUrl(row.canonical_url, id);
    const previewUrl = previewImageUrl(row.att_dir, canonicalUrl, id);
    const thumbnailUrl = row.satt_dir === '' ? previewUrl
      : canonicalUrl.startsWith('/api/assets/') ? previewImageUrl(row.satt_dir, canonicalUrl, id)
      : externalImageUrl(text(row.satt_dir, 4096));
    return Object.freeze({ id, pid, name, canonicalUrl, previewUrl, thumbnailUrl });
  });
  return { list, count };
}

export function decodeSupplierAttachmentCategories(value: unknown, pidValue: number, supplierId: number): AttachmentCategory[] {
  const pid = integer(pidValue, 0), owner = integer(supplierId), body = record(value), ids = new Set<number>();
  if (!Array.isArray(body.list)) throw invalidResponse();
  return body.list.map(value => {
    const row = record(value), id = integer(row.id);
    if (ids.has(id) || id === pid || row.type !== 4 || row.file_type !== 1 || row.relation_id !== owner || row.pid !== pid
      || !Array.isArray(row.children) || row.children.length || (row.loading !== undefined && row.loading !== false)) throw invalidResponse();
    ids.add(id);
    return Object.freeze({ id, pid, name: text(row.name, 50), hasChildren: row.loading === false });
  });
}

export function decodeSupplierUploadedImage(value: unknown): SupplierUploadedImage {
  const row = record(value), id = integer(row.att_id), size = integer(row.size);
  const mime = text(row.type, 32), canonicalUrl = canonicalImageUrl(row.url, id);
  if (size > 10 * 1024 * 1024 || !/^image\/(jpeg|png|webp|gif)$/.test(mime) || canonicalUrl !== `/api/assets/${id}`) throw invalidResponse();
  return Object.freeze({ id, canonicalUrl, previewUrl: previewImageUrl(row.src, canonicalUrl, id), name: text(row.name, 255), size, mime });
}

async function scopedRequest<T>(signal: AbortSignal | undefined, read: (supplierId: number, signal: AbortSignal) => Promise<T>): Promise<T> {
  const scope = createSupplierSessionScope(), controller = new AbortController();
  const cancel = () => controller.abort();
  scope.signal.addEventListener('abort', cancel);
  signal?.addEventListener('abort', cancel);
  try {
    if (signal?.aborted || !scope.isCurrent()) controller.abort();
    if (controller.signal.aborted) throw new Error('图片读取已取消');
    const owner = currentSupplierAttachmentOwner();
    const result = await read(owner, controller.signal);
    if (controller.signal.aborted || !scope.isCurrent() || currentSupplierAttachmentOwner() !== owner) throw new Error('供应商会话已改变');
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel); scope.signal.removeEventListener('abort', cancel); scope.dispose();
  }
}

export function getSupplierAttachments(target: AttachmentQuery, signal?: AbortSignal) {
  const query = normalizeAttachmentQuery(target);
  return scopedRequest(signal, async (supplierId, signal) => decodeSupplierAttachmentPage(await apiRequest<unknown>({
    method: 'GET', url: '/file/file', params: { ...query, limit: 20, file_type: 1 }, signal,
  }), query, supplierId));
}
export function getSupplierAttachmentCategories(pidValue: number, signal?: AbortSignal) {
  const pid = integer(pidValue, 0);
  return scopedRequest(signal, async (supplierId, signal) => decodeSupplierAttachmentCategories(await apiRequest<unknown>({
    method: 'GET', url: '/file/category', params: { pid, file_type: 1 }, signal,
  }), pid, supplierId));
}

/** Caller decides whether an uncertain upload should be reconciled. This function never retries. */
export function uploadSupplierImage(form: FormData, signal?: AbortSignal) {
  return scopedRequest(signal, async (_supplierId, signal) => decodeSupplierUploadedImage(await apiRequest<unknown>({
    method: 'POST', url: '/file/upload', data: form, signal,
  })));
}
