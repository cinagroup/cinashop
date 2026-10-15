import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment, systemSupplier } from '@/models/schema';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { pcBannerLink } from '@/services/admin/AdminPcBannerInput';
import { normalizeExternalVideoUrl, parseCanonicalAttachmentId, R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';
import { classifyProductMediaReference } from '../../../../view/common/productMediaReference';

export const MAX_PRODUCT_VIDEO_REFERENCE_CHARS = 500;
export interface ProductVideoOwner { type: number; relationId: number }
export interface ProductVideoOptions { allowLegacyRelative?: boolean }

/** Keep durable private references separate from short-lived playback tickets.
 * Relative public MP4 paths are read-only compatibility for legacy products. */
export function normalizeProductVideoReference(value: unknown, options: ProductVideoOptions = {}): string {
  if (value === '' || value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 4096) throw new ValidateException('商品视频地址无效');
  const reference = canonicalizePublishedAttachmentReference(value), classified = classifyProductMediaReference(value);
  if (classified.kind === 'invalid') throw new ValidateException('商品视频地址无效');
  if (classified.kind === 'asset') {
    // Dot segments/encoded aliases must not acquire private-asset authority
    // through URL normalization. Pickers may supply canonical or absolute tickets.
    if (reference !== classified.reference && !/^https:\/\/[^/?#]+\/api\/assets\/[1-9]\d*(?:[?#]|$)/i.test(value.trim()))
      throw new ValidateException('商品私有视频须使用素材的稳定地址');
    return classified.reference;
  }
  if (reference.length > MAX_PRODUCT_VIDEO_REFERENCE_CHARS) throw new ValidateException('商品视频地址不能超过500字符');
  if (options.allowLegacyRelative && reference.startsWith('/')) {
    const safe = pcBannerLink(reference);
    if (!/\.mp4(?:[?#]|$)/i.test(safe)) throw new ValidateException('商品视频须为MP4');
    return safe;
  }
  const external = normalizeExternalVideoUrl(reference, MAX_PRODUCT_VIDEO_REFERENCE_CHARS);
  if (external.length > MAX_PRODUCT_VIDEO_REFERENCE_CHARS) throw new ValidateException('商品视频地址不能超过500字符');
  return external;
}

/** Only existing, correctly typed product-library metadata grants playback.
 * Platform media can be shared by all product owners; supplier media remains
 * confined to its active supplier. No R2/network I/O occurs in this policy. */
export async function resolveProductVideoReference(db: Pick<DbClient, 'select'>, value: unknown,
  owner: ProductVideoOwner, options: ProductVideoOptions = {}): Promise<string> {
  let reference: string;
  try { reference = normalizeProductVideoReference(value, options); } catch { return ''; }
  if (!reference) return '';
  const id = parseCanonicalAttachmentId(reference);
  if (id === null) return reference;
  if (![0, 1, 2].includes(owner.type) || !Number.isSafeInteger(owner.relationId)
    || (owner.type === 0 ? owner.relationId !== 0 : owner.relationId <= 0 || owner.relationId > 2147483647)) return '';
  const [asset] = await db.select({ type: systemAttachment.type, relationId: systemAttachment.relationId,
    module: systemAttachment.moduleType, file: systemAttachment.fileType, imageType: systemAttachment.imageType,
    name: systemAttachment.name, dir: systemAttachment.attDir, mime: systemAttachment.attType })
    .from(systemAttachment).where(eq(systemAttachment.attId, id)).limit(1);
  if (!asset || asset.module !== 1 || asset.file !== 2 || asset.imageType !== R2_IMAGE_TYPE || asset.dir !== reference
    || asset.mime.trim().toLowerCase() !== 'video/mp4' || !/\.mp4$/i.test(asset.name)
    || asset.name.split('/').some(part => part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/u.test(asset.name)) return '';
  if (asset.type === 1 && asset.relationId === 0 && asset.name.startsWith('attachments/admin/1/')) return reference;
  if (owner.type !== 2 || asset.type !== 4 || asset.relationId !== owner.relationId
    || !asset.name.startsWith(`attachments/supplier/${owner.relationId}/`)) return '';
  const [supplier] = await db.select({ id: systemSupplier.id }).from(systemSupplier).where(and(
    eq(systemSupplier.id, owner.relationId), eq(systemSupplier.isDel, 0), eq(systemSupplier.isShow, 1))).limit(1);
  return supplier ? reference : '';
}

export async function assertProductVideoReference(db: Pick<DbClient, 'select'>, value: unknown,
  owner: ProductVideoOwner, options: ProductVideoOptions = {}): Promise<string> {
  const reference = normalizeProductVideoReference(value, options);
  if (reference && await resolveProductVideoReference(db, reference, owner, options) !== reference)
    throw new ValidateException('商品视频不存在、类型错误或不属于当前商品可用素材');
  return reference;
}
