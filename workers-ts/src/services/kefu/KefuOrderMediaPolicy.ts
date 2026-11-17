import type { DbClient } from '@/lib/di';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export type KefuOrderMediaOwner = { id: number; type: number; relationId: number };
export type KefuOrderMediaTarget = {
  id: number;
  productInfo: { image: string; attrInfo: { image: string } };
};
export type KefuOrderMediaSlot = { target: KefuOrderMediaTarget; reference: string };
const MAX_PROJECTIONS = 10_000;
// A historical image lives inside the existing bounded cart JSON, not a
// present-day product/SKU varchar. Preserve long safe imported references.
const MAX_SNAPSHOT_CODE_UNITS = 256 * 1024;
const unsafeText = (value: string) => /[\u0000-\u001f\u007f\\]/u.test(value);
const validId = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;
const missingOwner = { type: -1, relationId: 0 };

function mediaOwner(row: KefuOrderMediaOwner | undefined) {
  if (row?.type === 0 && row.relationId === 0) return { type: 0, relationId: 0 };
  // Persisted PHP store copies have a positive store relation. They use
  // platform attachments, without granting malformed type1/relation0 rows.
  if (row?.type === 1 && validId(row.relationId)) return { type: 0, relationId: 0 };
  if (row?.type === 2 && validId(row.relationId)) return { type: 2, relationId: row.relationId };
  return missingOwner;
}

function snapshotReference(value: string): string {
  if (value.length > MAX_SNAPSHOT_CODE_UNITS || unsafeText(value)) return '';
  const reference = canonicalizePublishedAttachmentReference(value);
  if (!reference || reference.length > MAX_SNAPSHOT_CODE_UNITS || unsafeText(reference) || /\s/u.test(reference)) return '';
  if (reference.startsWith('/api/assets/')) {
    const id = parseCanonicalAttachmentId(reference);
    return id !== null && validId(id) ? reference : '';
  }
  if (/^\/(?!\/)/.test(reference)) return reference;
  try {
    const url = new URL(reference);
    if (url.protocol === 'https:' && !url.username && !url.password) return reference;
  } catch { /* References are not fetched, proxied or resolved here. */ }
  return '';
}

/** Call only with carts read under the response's SQL authorization. Owner
 * authority is the persisted cart row; JSON fields and live catalogue owners
 * cannot mint a historical ticket. Targets are fresh cartProjection objects,
 * after its exact image precedence, refund selection and finance validation.
 * Mirrored _info entries share those targets and retain identical pictures. */
export async function readKefuOrderMedia(
  db: Pick<DbClient, 'select'>,
  owners: readonly KefuOrderMediaOwner[],
  groups: readonly (readonly KefuOrderMediaTarget[])[],
): Promise<KefuOrderMediaSlot[]> {
  if (groups.reduce((total, group) => total + group.length, 0) > MAX_PROJECTIONS) {
    throw new ValidateException('客服订单图片超过完整预览容量');
  }
  const byId = new Map(owners.filter(row => validId(row.id)).map(row => [row.id, row]));
  const slots = groups.flatMap(group => group.map(target => {
    const owner = mediaOwner(byId.get(target.id));
    return { target, owner, reference: owner.type < 0 ? '' : snapshotReference(target.productInfo.image) };
  }));
  // Only short canonical IDs enter the product helper's main-image budget.
  // Long safe legacy references keep the cart snapshot's complete-input bound.
  const authorized = await publicProductPictures(db, slots.map(slot => ({
    ...slot.owner,
    image: parseCanonicalAttachmentId(slot.reference) === null ? '' : slot.reference,
  })), 256);
  return slots.map((slot, index) => ({ target: slot.target,
    reference: parseCanonicalAttachmentId(slot.reference) === null ? slot.reference : authorized[index] ?? '' }));
}

/** Pure response signing after an owned read commits. Caller-owned
 * transactions retain their original isolation and eventual commit timing. */
export async function renderKefuOrderMedia(appKey: string | undefined, slots: readonly KefuOrderMediaSlot[]): Promise<void> {
  const canonical = [...new Set(slots.map(slot => slot.reference)
    .filter(reference => parseCanonicalAttachmentId(reference) !== null))];
  const signed = canonical.length ? await signAttachmentReferences(appKey, canonical) : [];
  const tickets = new Map(canonical.map((reference, index) => [reference, signed[index] ?? '']));
  for (const slot of slots) {
    const image = tickets.get(slot.reference) ?? slot.reference;
    slot.target.productInfo.image = image;
    slot.target.productInfo.attrInfo.image = image;
  }
}
