import { asc, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';
import { pcBaseImage } from '../../../../view/common/pcBase';

type ImageDb = Pick<DbClient, 'select'>;
const MAX_PC_IMAGE_SLOTS = 5001;

function parsedImages(values: readonly unknown[]): string[] {
  if (values.length > MAX_PC_IMAGE_SLOTS) throw new ValidateException('PC图片超过完整处理容量');
  return values.map(value => { try { return pcBaseImage(value); } catch { return ''; } });
}

/** Stable public HTTP values retain their exact authored bytes. Only canonical
 * private references enter the mature platform attachment authority check.
 * Historical tickets/encoded private aliases are rejected, never canonicalized
 * into new signing authority. There is no HTTP/R2 fetch in this policy. */
export async function readPcBaseImageReferences(db: ImageDb, values: readonly unknown[]): Promise<string[]> {
  const references = parsedImages(values);
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  if (!ids.length) return references;
  const canonical = ids.map(id => `/api/assets/${id}`);
  const available = await publicProductPictures(db, canonical.map(image => ({ image, type: 0, relationId: 0 })));
  const allowed = new Set(available.filter(Boolean));
  return references.map(reference => parseCanonicalAttachmentId(reference) === null || allowed.has(reference) ? reference : '');
}

/** Author transaction only. Lock every selected physical ID, including wrong
 * owner/type rows, before checking its authority. Batch ordering prevents
 * client-authored filing order from becoming the attachment lock order. */
export async function assertPcBaseImageReplacements(db: ImageDb, values: readonly unknown[]): Promise<string[]> {
  if (values.length > MAX_PC_IMAGE_SLOTS) throw new ValidateException('PC图片超过完整处理容量');
  const references = values.map(value => {
    try { return pcBaseImage(value); } catch { throw new ValidateException('PC图片地址无效或包含临时凭据'); }
  });
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
  if (ids.length) {
    const locked = await db.select({ id: systemAttachment.attId }).from(systemAttachment)
      .where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId)).for('share', { noWait: true });
    // READ COMMITTED can see a previously missing row in the policy SELECT
    // below. Such a late insertion was never locked by this transaction.
    if (locked.length !== ids.length || locked.some((row, index) => row.id !== ids[index])) {
      throw new ValidateException('PC图片素材不存在、不可用或不属于平台');
    }
  }
  const checked = await readPcBaseImageReferences(db, references);
  if (checked.some((value, index) => value !== references[index])) throw new ValidateException('PC图片素材不存在、不可用或不属于平台');
  return references;
}

export async function assertPcBaseImageReplacement(db: ImageDb, value: unknown): Promise<string> {
  return (await assertPcBaseImageReplacements(db, [value]))[0]!;
}

/** Call only with references returned by the same read/author transaction's
 * authority policy. Sign canonical IDs alone; the generic article renderer's
 * HTTPS-only rule must not silently discard PHP-compatible stable HTTP. */
export async function renderPcBaseImages(appKey: string | undefined, references: readonly string[]): Promise<string[]> {
  const checked = parsedImages(references);
  const canonical = [...new Set(checked.filter(value => parseCanonicalAttachmentId(value) !== null))];
  if (!canonical.length) return checked;
  const signed = await signAttachmentReferences(appKey, canonical);
  const byReference = new Map(canonical.map((value, index) => [value, signed[index]!]));
  return checked.map(value => byReference.get(value) ?? value);
}
