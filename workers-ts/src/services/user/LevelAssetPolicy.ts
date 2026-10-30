import { asc, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export interface LevelImagePair { icon: string; image: string }
type ImageSource = { icon: unknown; image: unknown };
const fields = ['icon', 'image'] as const;
const MAX_PAIRS = 5000;

/** Validate a new stable value only. Existing unchanged history is deliberately
 * not passed through this function by assertLevelImageChanges. No HTML entity
 * decoding or external URL fetching is performed. */
export function levelImageInput(value: unknown, label = '等级图片'): string {
  if (typeof value !== 'string' || [...value].length > 255 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) {
    throw new ValidateException(`${label}须为不超过255字的稳定图片地址`);
  }
  if (value === '') return '';
  if (value.startsWith('/api/assets')) {
    const id = parseCanonicalAttachmentId(value);
    if (id === null || id > 2_147_483_647) throw new ValidateException(`${label}须使用无票据的稳定附件地址`);
    return value;
  }
  if (/^\/(?!\/)/u.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && url.hostname) return value;
  } catch { /* Invalid URLs never become a display or signing capability. */ }
  throw new ValidateException(`${label}只支持HTTPS或站内稳定地址`);
}

/** Historical HTTP remains untouched in the row; only this response projection
 * upgrades it. A malformed/unsafe historical value gets an empty preview. */
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
  try { return levelImageInput(projected); } catch { return ''; }
}

/** Resolve exactly icon/image against present platform attachment metadata.
 * Other object properties, user/supplier media and stale picker tickets never
 * grant an image capability. The caller owns transaction/snapshot semantics. */
export async function publicLevelImageReferences(
  db: Pick<DbClient, 'select'>,
  rows: readonly ImageSource[],
  lock = false,
): Promise<LevelImagePair[]> {
  if (rows.length > MAX_PAIRS) throw new ValidateException('等级图片超过完整目录容量');
  const references = rows.flatMap(row => fields.map(field => displayReference(row[field])));
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
  if (ids.length) {
    const currentQuery = db.select({ id: systemAttachment.attId, path: systemAttachment.attDir }).from(systemAttachment)
      .where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId));
    const current = await (lock ? currentQuery.for('share', { noWait: true }) : currentQuery);
    const exactPaths = new Set(current.filter(row => row.path === `/api/assets/${row.id}`).map(row => row.id));
    const canonical = ids.filter(id => exactPaths.has(id)).map(id => `/api/assets/${id}`);
    // Only exact canonical tokens cross the legacy product policy's HTML-aware
    // normalizer. Literal entities in ordinary JSON are never decoded here.
    const checked = canonical.length ? await publicProductPictures(db, canonical.map(image => ({ image, type: 0, relationId: 0 }))) : [];
    const allowed = new Map(canonical.map((reference, index) => [reference, checked[index] ?? '']));
    for (let i = 0; i < references.length; i++) if (parseCanonicalAttachmentId(references[i]!) !== null) references[i] = allowed.get(references[i]!) ?? '';
  }
  return rows.map((_row, index) => ({ icon: references[index * 2]!, image: references[index * 2 + 1]! }));
}

/** Sign response fields only, leaving public strings and authored rows intact.
 * Static/remote references require neither an APP_KEY nor attachment SQL. */
export async function renderLevelImageReferences(appKey: string | undefined, rows: readonly LevelImagePair[]): Promise<LevelImagePair[]> {
  if (rows.length > MAX_PAIRS) throw new ValidateException('等级图片超过完整目录容量');
  const canonical = [...new Set(rows.flatMap(row => fields.map(field => row[field]))
    .filter(reference => parseCanonicalAttachmentId(reference) !== null))];
  const signed = canonical.length ? await signAttachmentReferences(appKey, canonical) : [];
  const byReference = new Map(canonical.map((reference, index) => [reference, signed[index]!]));
  return rows.map(row => ({ icon: byReference.get(row.icon) ?? row.icon, image: byReference.get(row.image) ?? row.image }));
}

/** New/changed slots must be stable and currently publicable; same-value legacy
 * HTTP/invalid values are preserved. This function does not mutate either row. */
export async function assertLevelImageChanges(db: Pick<DbClient, 'select'>, prior: LevelImagePair | null, next: LevelImagePair): Promise<void> {
  const changes = fields.filter(field => prior === null || next[field] !== prior[field]);
  if (!changes.length) return;
  for (const field of changes) levelImageInput(next[field], field === 'icon' ? '等级图标' : '会员背景');
  const changed = { icon: changes.includes('icon') ? next.icon : '', image: changes.includes('image') ? next.image : '' };
  const [checked] = await publicLevelImageReferences(db, [changed], true);
  if (!checked || changes.some(field => checked[field] !== next[field])) throw new ValidateException('等级图片不属于当前可公开的平台图片');
}
