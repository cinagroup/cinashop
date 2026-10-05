import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment, systemSupplier } from '@/models/schema';
import { canonicalizePublishedAttachmentReference, renderPublishedArticleMediaReferences } from '@/services/content/ArticleContentPolicy';
import { adminAttachmentScope, parseCanonicalAttachmentId, R2_IMAGE_TYPE, supplierAttachmentScope } from '@/services/system/AttachmentService';
import { seckillTimePicture } from './SeckillTimeAssetPolicy';
import { ValidateException } from '@/utils/errors';

export type ProductPicture = { image: unknown; type: number; relationId: number };
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Catalogue media authority comes from the persisted product owner, never an
 * attachment id supplied by the client. Resolve in the read transaction, then
 * sign after it ends. There are no HTTP or R2 reads in this policy. */
export async function publicProductPictures(db: Pick<DbClient, 'select'>, values: readonly ProductPicture[]): Promise<string[]> {
  if (values.length > 10000) throw new ValidateException('商品图片超过完整预览容量');
  const validOwner = (row: ProductPicture) => [0, 1].includes(row.type) ? row.relationId === 0 : row.type === 2 && Number.isSafeInteger(row.relationId) && row.relationId > 0 && row.relationId <= 2147483647;
  const references = values.map(value => { try { return !validOwner(value) || value.image === '' ? '' : seckillTimePicture(value.image); } catch { return ''; } });
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  // Static catalogue references do not depend on a database or APP_KEY.
  if (!ids.length) return references;
  const supplierIds = [...new Set(values.filter((row, index) => row.type === 2 && parseCanonicalAttachmentId(references[index]) !== null).map(row => row.relationId))];
  const suppliers = supplierIds.length ? await db.select({ id: systemSupplier.id }).from(systemSupplier)
    .where(and(inArray(systemSupplier.id, supplierIds), eq(systemSupplier.isShow, 1), eq(systemSupplier.isDel, 0))) : [];
  const activeSuppliers = new Set(suppliers.map(row => row.id));
  const attachments = ids.length ? await db.select().from(systemAttachment)
    .where(and(inArray(systemAttachment.attId, ids), eq(systemAttachment.fileType, 1), eq(systemAttachment.moduleType, 1), eq(systemAttachment.imageType, R2_IMAGE_TYPE))) : [];
  const byId = new Map(attachments.map(row => [row.attId, row]));
  const platform = adminAttachmentScope();
  return references.map((reference, index) => {
    const owner = values[index], supplier = owner.type === 2 && activeSuppliers.has(owner.relationId) ? supplierAttachmentScope(owner.relationId) : null;
    const id = parseCanonicalAttachmentId(reference);
    if (id === null) return reference;
    if (!supplier && !([0, 1].includes(owner.type) && owner.relationId === 0)) return '';
    const asset = byId.get(id);
    if (!asset || canonicalizePublishedAttachmentReference(asset.attDir) !== `/api/assets/${id}`) return '';
    const isPlatform = asset.type === platform.type && asset.relationId === platform.relationId;
    if (!isPlatform && !(supplier && asset.type === supplier.type && asset.relationId === supplier.relationId)) return '';
    // AttachmentService stores platform relationId=0 under its fixed owner=1
    // object folder. A zero/other admin folder is not an uploaded platform key.
    const prefix = isPlatform ? 'attachments/admin/1/' : `attachments/supplier/${owner.relationId}/`;
    if (!asset.name.startsWith(prefix) || asset.name.split('/').some(part => part === '..' || part === '.') || /[\\\u0000-\u001f\u007f]/u.test(asset.name)) return '';
    const mime = asset.attType.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
    const extension = /\.(jpe?g|png|webp|gif)$/i.exec(asset.name)?.[1]?.toLowerCase();
    const expectedMime = extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : '';
    // Older R2 image rows may omit att_type. Their dedicated image_type,
    // file_type and generated raster object extension remain explicit proof;
    // unknown or contradictory nonempty MIME never gets a signature.
    if (!expectedMime || (mime !== '' && (!IMAGE_MIMES.has(mime) || mime !== expectedMime))) return '';
    return reference;
  });
}

export async function renderProductPictures(appKey: string | undefined, references: readonly string[]) {
  return renderPublishedArticleMediaReferences(appKey, references);
}
