import { asc, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export interface StoreImageReference { image: string }
type StoreImageSource = { image: unknown };
const MAX_ROWS = 5000;

/** Validate only a new/changed author value. Same-value history is preserved by
 * assertStoreImageChange, independently of whether it can be displayed. */
export function storeImageInput(value: unknown): string {
  if (typeof value !== 'string' || [...value].length > 255 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new ValidateException('提货点图片须为不超过255字的稳定图片地址');
  }
  if (value === '') return '';
  if (value.startsWith('/api/assets')) {
    const id = parseCanonicalAttachmentId(value);
    if (id === null || id > 2_147_483_647) throw new ValidateException('提货点图片须使用无票据的稳定附件地址');
    return value;
  }
  if (/^\/(?!\/)/u.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.hostname) return value;
  } catch { /* Invalid history never becomes a display capability. */ }
  throw new ValidateException('提货点图片只支持HTTPS或站内稳定地址');
}

function displayReference(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return '';
  const asset = /^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/u.exec(value);
  if (asset) {
    const id = Number(asset[1]);
    return Number.isSafeInteger(id) && id <= 2_147_483_647 ? `/api/assets/${id}` : '';
  }
  if (value.startsWith('/api/assets')) return '';
  let projected = value;
  if (/^http:\/\//iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' || url.username || url.password || !url.hostname) return '';
      projected = `https:${value.slice(value.indexOf(':') + 1)}`;
    } catch { return ''; }
  }
  try { return storeImageInput(projected); } catch { return ''; }
}

/** Exactly one author slot. A caller projecting an existing read-only image
 * such as oblong_image must pass that value explicitly as a separate image
 * source; arbitrary properties never grant media authority. No provider/R2 I/O. */
export async function publicStoreImageReferences(
  db: Pick<DbClient, 'select'>,
  rows: readonly StoreImageSource[],
  lock = false,
): Promise<StoreImageReference[]> {
  if (rows.length > MAX_ROWS) throw new ValidateException('提货点图片超过完整目录容量');
  const references = rows.map(row => displayReference(row.image));
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
  if (ids.length) {
    const query = db.select({ id: systemAttachment.attId, path: systemAttachment.attDir }).from(systemAttachment)
      .where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId));
    const current = await (lock ? query.for('share', { noWait: true }) : query);
    const exactPaths = new Set(current.filter(row => row.path === `/api/assets/${row.id}`).map(row => row.id));
    const canonical = ids.filter(id => exactPaths.has(id)).map(id => `/api/assets/${id}`);
    // Only exact canonical tokens enter the legacy HTML-aware product policy.
    // Literal JSON entities are never decoded into attachment identifiers.
    const checked = canonical.length ? await publicProductPictures(db, canonical.map(image => ({ image, type: 0, relationId: 0 }))) : [];
    const allowed = new Map(canonical.map((reference, index) => [reference, checked[index] ?? '']));
    for (let index = 0; index < references.length; index++) {
      if (parseCanonicalAttachmentId(references[index]!) !== null) references[index] = allowed.get(references[index]!) ?? '';
    }
  }
  return references.map(image => ({ image }));
}

/** Sign response-only previews after metadata projection. Public strings need
 * neither an attachment query nor an APP_KEY; authored rows are never changed. */
export async function renderStoreImageReferences(appKey: string | undefined, rows: readonly StoreImageReference[]): Promise<StoreImageReference[]> {
  if (rows.length > MAX_ROWS) throw new ValidateException('提货点图片超过完整目录容量');
  const canonical = [...new Set(rows.map(row => row.image).filter(reference => parseCanonicalAttachmentId(reference) !== null))];
  const signed = canonical.length ? await signAttachmentReferences(appKey, canonical) : [];
  const byReference = new Map(canonical.map((reference, index) => [reference, signed[index]!]));
  return rows.map(row => ({ image: byReference.get(row.image) ?? row.image }));
}

export async function assertStoreImageChange(db: Pick<DbClient, 'select'>, old: string | null, next: string): Promise<void> {
  if (old !== null && old === next) return;
  storeImageInput(next);
  const [checked] = await publicStoreImageReferences(db, [{ image: next }], true);
  if (!checked || checked.image !== next) throw new ValidateException('提货点图片不属于当前可公开的平台图片');
}
