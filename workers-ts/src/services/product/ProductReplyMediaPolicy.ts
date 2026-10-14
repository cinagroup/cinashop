import { asc, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { loadAdminAuthorityLiveActor, type AdminAuthorityActor } from '@/services/admin/AdminAuthorityWriteService';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

type AttachmentRow = typeof systemAttachment.$inferSelect;
export interface FictitiousReplyMediaProof {
  readonly references: readonly string[];
  readonly attachments: readonly AttachmentRow[];
}
export interface ProductReplyMediaRow {
  uid: number; type: number; relationId: number; avatar: string; pics: unknown;
}
const MAX_ID = 2_147_483_647;

/** Private transport paths never acquire authority from a guessed ID. Detect
 * malformed/encoded relative aliases too, but leave external source URLs alone. */
function privateReference(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return false;
  let path = value.split(/[?#]/, 1)[0];
  for (let index = 0; index < 2; index++) {
    try { const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded; } catch { break; }
  }
  path = path.replaceAll('\\', '/');
  try { path = new URL(path, 'https://reply-media.invalid/').pathname; } catch { /* Keep the raw namespace check. */ }
  return /^\/(?:api\/assets(?:\/|$)|attachments(?:\/|$))/i.test(path);
}
function attachmentIds(references: readonly string[]): number[] {
  return [...new Set(references.map(reference => {
    const id = parseCanonicalAttachmentId(reference);
    if (id === null || id > MAX_ID) throw new ValidateException('私有评价图片仅接受稳定的站内素材引用');
    return id;
  }))].sort((a, b) => a - b);
}
function sameRow(actual: AttachmentRow | undefined, expected: AttachmentRow): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => actual[key as keyof AttachmentRow] === value);
}
async function publishable(db: Pick<DbClient, 'select'>, references: readonly string[]): Promise<void> {
  const allowed = await publicProductPictures(db, references.map(image => ({ image, type: 0, relationId: 0 })));
  if (allowed.length !== references.length || allowed.some((reference, index) => reference !== references[index])) {
    throw new ValidateException('评价图片不存在或不是可发布的平台普通图片素材');
  }
}

/** Called inside the Admin write barrier after product/SKU locks. Only private
 * canonical R2 selections add attachment.view; raw PHP media adds no new grant.
 * SHARE NOWAIT metadata locks remain held by the caller until commit. */
export async function validateFictitiousReplyMedia(tx: DbClient, actor: AdminAuthorityActor,
  refs: readonly string[]): Promise<FictitiousReplyMediaProof> {
  if (refs.length > 9) throw new ValidateException('虚拟评价头像与图片最多9项');
  const references = [...new Set(refs.filter(privateReference))];
  if (!references.length) return { references: [], attachments: [] };
  const ids = attachmentIds(references);
  await loadAdminAuthorityLiveActor(tx, actor, 'attachment.view');
  const attachments: AttachmentRow[] = [];
  for (const id of ids) {
    const rows = await tx.select().from(systemAttachment).where(inArray(systemAttachment.attId, [id])).limit(1).for('share', { noWait: true });
    if (rows.length !== 1) throw new ValidateException('所选评价图片素材不存在');
    attachments.push(rows[0]);
  }
  await publishable(tx, references);
  return { references, attachments };
}

/** Audit triggers execute in the same transaction and can bypass our own row
 * locks, so compare every metadata column and recheck live publication rights. */
export async function verifyFictitiousReplyMedia(tx: DbClient, actor: AdminAuthorityActor,
  proof: FictitiousReplyMediaProof): Promise<void> {
  if (!proof.references.length) return;
  await loadAdminAuthorityLiveActor(tx, actor, 'attachment.view');
  const ids = attachmentIds(proof.references);
  const fresh = await tx.select().from(systemAttachment).where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId));
  if (fresh.length !== proof.attachments.length || fresh.some((row, index) => !sameRow(row, proof.attachments[index]))) throw new Error('虚拟评价素材完整回执核验失败');
  await publishable(tx, proof.references);
}

/** Conditional TS R2 transport extension: only UID0 platform review references
 * may become signed public catalogue pictures. Nonprivate strings and complex
 * PHP JSON values retain their original shape and bytes. Missing APP_KEY,
 * malformed private paths, foreign tuples or unavailable metadata yield an
 * empty private slot instead of a bare URL that cannot be consumed safely.
 * This reads metadata and signs locally; it never fetches HTTP/R2 or writes rows. */
export async function renderProductReplyMedia(db: Pick<DbClient, 'select'>, rows: readonly ProductReplyMediaRow[],
  appKey?: string): Promise<Array<{ avatar: string; pics: unknown }>> {
  const canonical: string[] = [];
  const slots: Array<{ row: number; position: number | 'avatar' | 'pics' }> = [];
  const output = rows.map(row => ({ avatar: row.avatar, pics: row.pics }));
  const consume = (value: string, row: number, position: number | 'avatar' | 'pics') => {
    if (!privateReference(value)) return value;
    const owner = rows[row], id = parseCanonicalAttachmentId(value);
    if (!appKey || owner.uid !== 0 || owner.type !== 0 || owner.relationId !== 0 || id === null || id > MAX_ID) return '';
    canonical.push(value); slots.push({ row, position });
    return '';
  };
  rows.forEach((row, index) => {
    output[index].avatar = consume(row.avatar, index, 'avatar');
    if (typeof row.pics === 'string') output[index].pics = consume(row.pics, index, 'pics');
    else if (Array.isArray(row.pics)) output[index].pics = row.pics.map((value, position) => typeof value === 'string' ? consume(value, index, position) : value);
  });
  if (!canonical.length) return output;
  const allowed = await publicProductPictures(db, canonical.map(image => ({ image, type: 0, relationId: 0 })));
  const rendered = await renderProductPictures(appKey, allowed);
  slots.forEach((slot, index) => {
    if (slot.position === 'avatar') output[slot.row].avatar = rendered[index];
    else if (slot.position === 'pics') output[slot.row].pics = rendered[index];
    else (output[slot.row].pics as unknown[])[slot.position] = rendered[index];
  });
  return output;
}
