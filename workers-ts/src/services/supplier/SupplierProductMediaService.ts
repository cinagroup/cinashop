import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import {
  canonicalizePublishedAttachmentReference,
  canonicalizePublishedHtmlAttachmentReferences,
  sanitizePublishedArticleHtml,
} from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId, R2_IMAGE_TYPE, signAttachmentReferences } from '@/services/system/AttachmentService';

export const MAX_SUPPLIER_PRODUCT_MEDIA_REFERENCES = 640;
export const MAX_SUPPLIER_PRODUCT_HTML_MEDIA_REFERENCES = 100;
const MAX_HTML_CHARS = 200_000;
const MAX_REFERENCE_CHARS = 4_096;

export interface SupplierProductMediaInput {
  sliderImages: readonly unknown[];
  skus: readonly { image?: unknown }[];
  description: string;
}
export type SupplierProductMediaPreview =
  | { status: 'ready'; src: string; expires_at: number | null }
  | { status: 'unavailable'; expires_at: null };
export interface SupplierProductMediaProjection {
  version: 1;
  status: 'ready' | 'partial' | 'too_many_references';
  previews: Record<string, SupplierProductMediaPreview>;
  description_html: string;
}

/** A signature is transport state. Persist only the asset ID or an external HTTPS reference. */
export function normalizeSupplierProductMediaReference(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > MAX_REFERENCE_CHARS) throw new ValidateException('商品图片引用无效');
  const reference = canonicalizePublishedAttachmentReference(value);
  if (/^\/api\/assets\//.test(reference)) {
    const id = parseCanonicalAttachmentId(reference);
    if (!id || id > 2_147_483_647) throw new ValidateException('商品图片引用无效');
    return reference;
  }
  if (/[\u0000-\u0020\u007f\\]/u.test(reference)) throw new ValidateException('商品图片引用无效');
  let url: URL;
  try { url = new URL(reference); } catch { throw new ValidateException('商品图片必须使用HTTPS或稳定附件引用'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new ValidateException('商品图片必须使用HTTPS或稳定附件引用');
  // Imported absolute asset tickets must also shed their expiring query string.
  if (/^\/api\/assets\/[1-9]\d*$/.test(url.pathname)) {
    const id = parseCanonicalAttachmentId(url.pathname);
    if (!id || id > 2_147_483_647) throw new ValidateException('商品图片引用无效');
    return url.pathname;
  }
  return reference;
}

export function prepareSupplierProductMediaInput(input: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...input };
  for (const key of ['slider_image', 'sliderImages', 'slider_images']) {
    let values = copy[key];
    if (typeof values === 'string') {
      const text = values.trim();
      if (text.startsWith('[')) {
        try { values = JSON.parse(text); } catch { /* product normalization supplies the format error */ }
      } else values = text ? text.split(',') : [];
    }
    if (Array.isArray(values)) copy[key] = values.map(normalizeSupplierProductMediaReference);
  }
  if (Array.isArray(copy.attrs)) {
    copy.attrs = copy.attrs.map(row => row && typeof row === 'object' && !Array.isArray(row)
      ? { ...row, image: normalizeSupplierProductMediaReference(row.image) } : row);
  }
  if (typeof copy.description === 'string') copy.description = canonicalizePublishedHtmlAttachmentReferences(copy.description);
  return copy;
}

/** Read projection strips copied private tickets without rewriting legacy storage. */
export function supplierProductEditingMediaReference(value: string): string {
  try { return normalizeSupplierProductMediaReference(value); }
  catch { return canonicalizePublishedAttachmentReference(value); }
}

export function supplierProductEditingHtml(value: string): string {
  if (value.length > MAX_HTML_CHARS * 2) return value;
  try { return canonicalizePublishedHtmlAttachmentReferences(value); }
  catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    // Oversized historical editing content is retained; the media projection
    // reports its bound explicitly and does not render or sign that document.
    return value;
  }
}

function mediaReferences(input: SupplierProductMediaInput): { references: string[]; html: string } {
  if (input.description.length > MAX_HTML_CHARS * 2) throw new ValidateException('商品详情过大，无法解析媒体');
  const privateHtmlReferences: string[] = [];
  canonicalizePublishedHtmlAttachmentReferences(input.description, reference => privateHtmlReferences.push(reference));
  const html = sanitizePublishedArticleHtml(input.description);
  // This operates on the shared allowlist's normalized output, not arbitrary input HTML.
  const attributes = [...html.matchAll(/\b(src|href)="([^"]*)"/g)];
  const htmlReferences = attributes.filter(match => match[1] === 'src' || /^\/api\/assets\//.test(match[2]));
  const externalHtmlCount = htmlReferences.filter(match => {
    try { return parseCanonicalAttachmentId(normalizeSupplierProductMediaReference(match[2])) === null; }
    catch { return true; }
  }).length;
  if (privateHtmlReferences.length + externalHtmlCount > MAX_SUPPLIER_PRODUCT_HTML_MEDIA_REFERENCES) throw new ValidateException('商品详情媒体引用超过100项');
  const values = [...input.sliderImages, ...input.skus.map(sku => sku.image), ...privateHtmlReferences, ...htmlReferences.map(match => match[2])];
  const references = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    let reference: string;
    try { reference = normalizeSupplierProductMediaReference(value); }
    catch { reference = canonicalizePublishedAttachmentReference(value).slice(0, MAX_REFERENCE_CHARS); }
    if (reference) references.add(reference);
    if (references.size > MAX_SUPPLIER_PRODUCT_MEDIA_REFERENCES) throw new ValidateException('商品媒体引用超过640项');
  }
  return { references: [...references], html };
}

function tenantAttachmentWhere(supplierId: number, ids: number[]) {
  if (!Number.isSafeInteger(supplierId) || supplierId < 1) throw new ValidateException('供应商身份无效');
  return and(inArray(systemAttachment.attId, ids), eq(systemAttachment.type, 4),
    eq(systemAttachment.moduleType, 1), eq(systemAttachment.relationId, supplierId),
    eq(systemAttachment.fileType, 1), eq(systemAttachment.imageType, R2_IMAGE_TYPE));
}

/** Pin references until the surrounding product transaction commits. No network or object I/O. */
export async function lockSupplierProductMedia(db: DbClient, supplierId: number, input: SupplierProductMediaInput): Promise<void> {
  const { references } = mediaReferences(input);
  const ids = references.map(reference => {
    const normalized = normalizeSupplierProductMediaReference(reference);
    return parseCanonicalAttachmentId(normalized);
  }).filter((id): id is number => id !== null).sort((a, b) => a - b);
  if (!ids.length) return;
  let rows: Array<{ id: number; reference: string }>;
  try {
    rows = await db.select({ id: systemAttachment.attId, reference: systemAttachment.attDir })
      .from(systemAttachment).where(tenantAttachmentWhere(supplierId, ids))
      .orderBy(asc(systemAttachment.attId)).for('share', { noWait: true });
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
      if ('code' in cause && cause.code === '55P03') throw new ValidateException('商品附件正在变化，请刷新素材后重试');
      if (!('cause' in cause) || cause.cause === cause) break;
      cause = cause.cause;
    }
    throw error;
  }
  if (rows.length !== ids.length || rows.some(row => row.reference !== `/api/assets/${row.id}`)) {
    throw new ValidateException('商品附件不可用，请重新选择当前供应商素材');
  }
}

export async function projectSupplierProductMedia(db: DbClient, supplierId: number, input: SupplierProductMediaInput,
  appKey: string | undefined): Promise<SupplierProductMediaProjection> {
  let collected: ReturnType<typeof mediaReferences>;
  try { collected = mediaReferences(input); }
  catch (error) {
    if (!(error instanceof ValidateException)) throw error;
    return { version: 1, status: 'too_many_references', previews: {}, description_html: '' };
  }
  const previews: Record<string, SupplierProductMediaPreview> = Object.create(null);
  const ids = collected.references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null && id <= 2_147_483_647);
  const allowed = new Set(ids.length ? (await db.select({ id: systemAttachment.attId, reference: systemAttachment.attDir })
    .from(systemAttachment).where(tenantAttachmentWhere(supplierId, ids)))
    .filter(row => row.reference === `/api/assets/${row.id}`).map(row => row.reference) : []);
  const signable = collected.references.filter(reference => allowed.has(reference));
  const signed = appKey && signable.length ? await signAttachmentReferences(appKey, signable) : [];
  const byReference = new Map(signable.map((reference, index) => [reference, signed[index]]));
  for (const reference of collected.references) {
    const src = byReference.get(reference);
    if (src) {
      previews[reference] = { status: 'ready', src, expires_at: Number(new URL(src, 'https://asset.invalid').searchParams.get('expires')) };
    } else {
      let external: string | null = null;
      try { if (!parseCanonicalAttachmentId(reference)) external = normalizeSupplierProductMediaReference(reference); } catch { /* historical invalid reference */ }
      previews[reference] = external && !parseCanonicalAttachmentId(external)
        ? { status: 'ready', src: external, expires_at: null }
        : { status: 'unavailable', expires_at: null };
    }
  }
  const description_html = collected.html.replace(/\b(src|href)="([^"]*)"/g, (original, attribute: string, reference: string) => {
    let key = canonicalizePublishedAttachmentReference(reference);
    try { key = normalizeSupplierProductMediaReference(reference); } catch { /* omit inaccessible historical media */ }
    const preview = previews[key];
    if (!preview) return /^\/api\/assets\//.test(key) ? '' : original;
    if (preview.status !== 'ready') return '';
    return `${attribute}="${preview.src.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
  });
  return { version: 1, status: Object.values(previews).some(preview => preview.status === 'unavailable') ? 'partial' : 'ready',
    previews, description_html };
}
