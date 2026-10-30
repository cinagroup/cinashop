import { asc, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { parseCanonicalAttachmentId, R2_IMAGE_TYPE, signAttachmentReferences } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

export interface DeliveryAvatarReference { avatar: string }
export interface DeliveryAvatarSource { avatar: unknown; uid: number; userAvatar?: string }
const MAX_ROWS = 20000;
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const validUid = (uid: number) => Number.isSafeInteger(uid) && uid > 0 && uid <= 2_147_483_647;

/** New arbitrary delivery avatars use stable platform/public references. A real
 * selected user's exact persisted avatar has a separate, narrow history path. */
export function deliveryAvatarInput(value: unknown): string {
  if (typeof value !== 'string' || [...value].length > 250 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) throw new ValidateException('配送员头像须为不超过250字的稳定图片地址');
  if (value === '') return '';
  if (value.startsWith('/api/assets')) {
    const id = parseCanonicalAttachmentId(value);
    if (id === null || id > 2_147_483_647) throw new ValidateException('配送员头像须使用无票据稳定附件地址');
    return value;
  }
  if (/^\/(?!\/)/u.test(value)) return value;
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && url.hostname) return value; } catch { /* Invalid history is never a display capability. */ }
  throw new ValidateException('配送员头像只支持HTTPS或站内稳定地址');
}
function displayReference(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return '';
  const asset = /^\/api\/assets\/([1-9]\d*)(?:[?#][\s\S]*)?$/u.exec(value);
  if (asset) { const id = Number(asset[1]); return Number.isSafeInteger(id) && id <= 2_147_483_647 ? `/api/assets/${id}` : ''; }
  if (value.startsWith('/api/assets')) return '';
  let projected = value;
  if (/^http:\/\//iu.test(value)) {
    try { const url = new URL(value); if (url.protocol !== 'http:' || url.username || url.password || !url.hostname) return ''; projected = `https:${value.slice(value.indexOf(':') + 1)}`; } catch { return ''; }
  }
  try { return deliveryAvatarInput(projected); } catch { return ''; }
}

/** userAvatar must come from the current selected persisted user row, never
 * from a client claim. It grants no attachment authority by itself: a user
 * canonical token additionally needs exact current metadata and uid ownership.
 * Unknown object fields, other users and other module realms cannot authorize. */
export async function publicDeliveryAvatarReferences(db: Pick<DbClient, 'select'>, rows: readonly DeliveryAvatarSource[], lock = false): Promise<DeliveryAvatarReference[]> {
  if (rows.length > MAX_ROWS) throw new ValidateException('配送员头像超过完整目录容量');
  const references = rows.map(row => displayReference(row.avatar));
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))].sort((a, b) => a - b);
  if (ids.length) {
    const query = db.select().from(systemAttachment).where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId));
    const attachments = await (lock ? query.for('share', { noWait: true }) : query), byId = new Map(attachments.map(row => [row.attId, row]));
    for (let index = 0; index < references.length; index++) {
      const id = parseCanonicalAttachmentId(references[index]!); if (id === null) continue;
      const source = rows[index]!, asset = byId.get(id);
      const platform = asset?.type === 1 && asset.relationId === 0 && asset.moduleType === 1;
      const ownUser = asset?.type === 3 && asset.moduleType === 3 && validUid(source.uid) && asset.relationId === source.uid
        && typeof source.avatar === 'string' && source.avatar === source.userAvatar;
      if (!asset || !platform && !ownUser || asset.attDir !== `/api/assets/${id}` || asset.fileType !== 1 || asset.imageType !== R2_IMAGE_TYPE) { references[index] = ''; continue; }
      const prefix = platform ? 'attachments/admin/1/' : `attachments/user/${source.uid}/`;
      if (!asset.name.startsWith(prefix) || asset.name.split('/').some(part => part === '.' || part === '..') || /[\\\u0000-\u001f\u007f]/u.test(asset.name)) { references[index] = ''; continue; }
      const mime = asset.attType.trim().toLowerCase().replace(/^image\/jpg$/u, 'image/jpeg');
      const extension = /\.(jpe?g|png|webp|gif)$/iu.exec(asset.name)?.[1]?.toLowerCase();
      const expected = extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : '';
      if (!expected || mime !== '' && (!IMAGE_MIMES.has(mime) || mime !== expected)) references[index] = '';
    }
  }
  return references.map(avatar => ({ avatar }));
}
export async function renderDeliveryAvatarReferences(appKey: string | undefined, rows: readonly DeliveryAvatarReference[]): Promise<DeliveryAvatarReference[]> {
  if (rows.length > MAX_ROWS) throw new ValidateException('配送员头像超过完整目录容量');
  const canonical = [...new Set(rows.map(row => row.avatar).filter(reference => parseCanonicalAttachmentId(reference) !== null))];
  const signed = canonical.length ? await signAttachmentReferences(appKey, canonical) : [];
  const byReference = new Map(canonical.map((reference, index) => [reference, signed[index]!]));
  return rows.map(row => ({ avatar: byReference.get(row.avatar) ?? row.avatar }));
}
export async function assertDeliveryAvatarChange(db: Pick<DbClient, 'select'>, old: { avatar: string; uid: number } | null,
  next: { avatar: string; uid: number; userAvatar: string }): Promise<void> {
  if (old && old.avatar === next.avatar && old.uid === next.uid) return;
  if (!validUid(next.uid) || typeof next.avatar !== 'string' || [...next.avatar].length > 250) throw new ValidateException('配送员头像或关联用户无效');
  const selectedHistory = next.avatar === next.userAvatar;
  if (!selectedHistory) deliveryAvatarInput(next.avatar);
  const reference = displayReference(next.avatar), canonical = parseCanonicalAttachmentId(reference);
  // Exact selected legacy public/unsafe strings may be retained as business
  // history. They are never converted into a new signed media permission.
  if (selectedHistory && canonical === null) {
    if (next.avatar.startsWith('/api/assets')) throw new ValidateException('所选用户头像附件地址无效，请改选头像');
    return;
  }
  const [checked] = await publicDeliveryAvatarReferences(db, [next], true);
  if (!checked || checked.avatar !== reference || !selectedHistory && reference !== next.avatar) throw new ValidateException('配送员头像不属于当前可用的平台或所选用户图片');
}
