import { asc, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { publicProductPictures, renderProductPictures, type ProductPicture } from '@/services/activity/ProductAssetPolicy';
import { sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export function combinationHtmlReferences(html: string) {
  const refs = [...new Set([...html.matchAll(/\b(?:href|src)="(\/api\/assets\/[1-9]\d*)"/g)].map(match => match[1]))];
  if (refs.length > 1000) throw new ValidateException('拼团详情图片超过完整媒体容量');
  return refs;
}
/** Persist only verified, owner-scoped image references. Attachment edits use
 * the same row locks; NOWAIT avoids reversing catalogue lifecycle lock order. */
export async function validateCombinationMedia(tx: DbClient, owner: Omit<ProductPicture, 'image'>, images: string[], description: string) {
  const refs = [...images, ...combinationHtmlReferences(description)], ids = [...new Set(refs.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  if (ids.length) await tx.select({ id: systemAttachment.attId }).from(systemAttachment).where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId)).for('share', { noWait: true });
  const checked = await publicProductPictures(tx, refs.map(image => ({ ...owner, image })));
  if (checked.some((image, index) => !image || image !== refs[index])) throw new ValidateException('拼团图片不属于商品所属方的有效图片素材');
}
export async function combinationDescription(tx: DbClient, owner: Omit<ProductPicture, 'image'>, raw: string) {
  const html = sanitizePublishedArticleHtml(raw), refs = combinationHtmlReferences(html);
  const checked = await publicProductPictures(tx, refs.map(image => ({ ...owner, image })));
  const safe = new Map(refs.map((ref, index) => [ref, checked[index]]));
  return html.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g, (match, attribute: string, ref: string) => safe.get(ref) ? match : `${attribute}=""`);
}
export async function renderCombinationDescription(appKey: string | undefined, html: string) {
  const refs = combinationHtmlReferences(html), signed = await renderProductPictures(appKey, refs), mapping = new Map(refs.map((ref, index) => [ref, signed[index]]));
  return html.replace(/\b(href|src)="(\/api\/assets\/[1-9]\d*)"/g, (_match, attribute: string, ref: string) => `${attribute}="${(mapping.get(ref) ?? '').replaceAll('&', '&amp;')}"`);
}
