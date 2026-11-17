import type { DbClient } from '@/lib/di';
import { publicProductPictures, type ProductPicture } from '@/services/activity/ProductAssetPolicy';
import { decodePublishedArticleAttribute } from '@/services/content/ArticleContentPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export const MAX_KEFU_SPLIT_CART_ROWS = 10_000;
// Split previews previously parsed the complete JSON. This is a complete
// response budget, not the order reader's 256Ki snapshot truncation rule.
export const MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS = 16 * 1024 * 1024;
const METADATA_BATCH_SIZE = 10_000;
const SIGNING_BATCH_SIZE = 256;

type Owner = { id: number; type: number; relationId: number };
export type KefuSplitCartMediaTarget = {
  id: number;
  image: string;
  cart_info: Record<string, unknown> | null;
};
export type KefuSplitCartMediaSlot = { target: Record<string, unknown>; reference: string };
const validId = (id: number) => Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647;
const unsafeReference = (value: string) => /[\u0000-\u001f\u007f\\\s]/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

/** Reject the whole preview before parsing or attachment SQL. Never silently
 * drop an otherwise valid snapshot or return a partial selection. */
export function assertKefuSplitCartPreviewBudget(rows: readonly { cartInfo: string | null }[]): void {
  if (rows.length > MAX_KEFU_SPLIT_CART_ROWS) throw new ValidateException('客服拆分商品超过完整预览容量');
  let units = 0;
  for (const row of rows) {
    units += row.cartInfo?.length ?? 0;
    if (units > MAX_KEFU_SPLIT_CART_SNAPSHOT_UNITS) throw new ValidateException('客服拆分商品快照超过完整预览容量');
  }
}

function mediaOwner(row: Owner, target: KefuSplitCartMediaTarget) {
  if (!validId(row.id) || row.id !== target.id) return null;
  if (row.type === 0 && row.relationId === 0) return { type: 0, relationId: 0 };
  if (row.type === 1 && validId(row.relationId)) return { type: 0, relationId: 0 };
  if (row.type === 2 && validId(row.relationId)) return { type: 2, relationId: row.relationId };
  return null;
}

function snapshotReference(value: string): string {
  // Inspect both complete forms before a canonical asset's query/fragment is
  // removed. Decode entities once; nested entity text is not decoded again.
  if (unsafeReference(value)) return '';
  const reference = decodePublishedArticleAttribute(value);
  if (!reference || unsafeReference(reference)) return '';
  const canonical = /^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/.exec(reference);
  if (canonical) return validId(Number(canonical[1])) ? `/api/assets/${canonical[1]}` : '';
  if (reference.startsWith('/api/assets/')) return '';
  if (/^\/(?!\/)/.test(reference)) return reference;
  try {
    const url = new URL(reference);
    if (url.protocol === 'https:' && !url.username && !url.password) return reference;
  } catch { /* Legacy references are not fetched or resolved here. */ }
  return '';
}

/** Owners and targets are paired from the same authorized, ordered cart read.
 * Known raw image slots remain independent; finance and arbitrary JSON fields
 * are neither interpreted nor recursively rewritten. */
export async function readKefuSplitCartMedia(
  db: Pick<DbClient, 'select'>,
  owners: readonly Owner[],
  targets: readonly KefuSplitCartMediaTarget[],
): Promise<KefuSplitCartMediaSlot[]> {
  if (targets.length !== owners.length || targets.length > MAX_KEFU_SPLIT_CART_ROWS) {
    throw new ValidateException('客服拆分商品超过完整预览容量');
  }
  const slots: Array<KefuSplitCartMediaSlot & { key: string | null }> = [];
  const canonical = new Map<string, ProductPicture>();
  targets.forEach((target, index) => {
    const owner = mediaOwner(owners[index], target);
    const add = (image: Record<string, unknown>) => {
      // Preserve non-string raw JSON, including arrays. The top image has
      // already used the unchanged projection's String()/nullish precedence.
      if (typeof image.image !== 'string') return;
      const reference = owner ? snapshotReference(image.image) : '';
      const key = owner && parseCanonicalAttachmentId(reference) !== null
        ? JSON.stringify([owner.type, owner.relationId, reference]) : null;
      if (key) canonical.set(key, { ...owner!, image: reference });
      slots.push({ target: image, reference, key });
    };
    add(target);
    const product = record(target.cart_info?.product);
    const productInfo = record(target.cart_info?.productInfo);
    for (const image of [product, record(product?.attrInfo), productInfo,
      record(productInfo?.attrInfo), record(target.cart_info?.sku)]) {
      if (image) add(image);
    }
  });
  const authorized = new Map<string, string>();
  const entries = [...canonical];
  // Top is either a string raw-slot alias, or a coercion of one non-string raw
  // slot. Thus at most five unique references per row and five fixed batches.
  // Every batch uses this same authorized read transaction, never per-row SQL.
  for (let offset = 0; offset < entries.length; offset += METADATA_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + METADATA_BATCH_SIZE);
    const references = await publicProductPictures(db, batch.map(([, image]) => image), 256);
    batch.forEach(([key], index) => authorized.set(key, references[index] ?? ''));
  }
  return slots.map(({ target, reference, key }) => ({ target,
    reference: key ? authorized.get(key) ?? '' : reference }));
}

/** Sign after an owned read commits. Caller-owned transactions keep their
 * original isolation and eventual commit timing. Existing tickets expire as
 * before; removing a conversation does not revoke a ticket already issued. */
export async function renderKefuSplitCartMedia(
  appKey: string | undefined,
  slots: readonly KefuSplitCartMediaSlot[],
): Promise<void> {
  const canonical = [...new Set(slots.map(slot => slot.reference)
    .filter(reference => parseCanonicalAttachmentId(reference) !== null))];
  const tickets = new Map<string, string>();
  for (let offset = 0; offset < canonical.length; offset += SIGNING_BATCH_SIZE) {
    const batch = canonical.slice(offset, offset + SIGNING_BATCH_SIZE);
    const signed = await signAttachmentReferences(appKey, batch);
    batch.forEach((reference, index) => tickets.set(reference, signed[index] ?? ''));
  }
  for (const slot of slots) slot.target.image = tickets.get(slot.reference) ?? slot.reference;
}
