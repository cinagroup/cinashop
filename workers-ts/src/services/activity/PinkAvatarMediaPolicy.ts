import { inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { parseCanonicalAttachmentId, R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { publicProductPictures } from './ProductAssetPolicy';
import { seckillTimePicture } from './SeckillTimeAssetPolicy';
import { ValidateException } from '@/utils/errors';

export const MAX_PINK_AVATAR_MEDIA = 3;
export interface PinkAvatarPicture { uid: number; image: unknown }

/** A persisted public participant UID authorizes only that user's ordinary image
 * namespace. Platform default avatars use the existing catalogue policy. A stored
 * URL or copied signature alone never grants another user's attachment. */
export async function publicPinkAvatarPictures(db: Pick<DbClient, 'select'>,
  values: readonly PinkAvatarPicture[]): Promise<string[]> {
  if (values.length > MAX_PINK_AVATAR_MEDIA) throw new ValidateException('拼团头像超过完整预览容量');
  const refs = values.map(value => {
    if (!Number.isSafeInteger(value.uid) || value.uid <= 0 || value.uid > 2147483647) return '';
    try { return value.image === '' ? '' : seckillTimePicture(value.image, 256); } catch { return ''; }
  });
  const fallback = await publicProductPictures(db, refs.map(image => ({ image, type: 0, relationId: 0 })), 256);
  const ids = [...new Set(refs.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  const assets = ids.length ? await db.select().from(systemAttachment).where(inArray(systemAttachment.attId, ids)) : [];
  const byId = new Map(assets.map(row => [row.attId, row]));
  return refs.map((ref, index) => {
    const id = parseCanonicalAttachmentId(ref);
    if (id === null) return fallback[index];
    const asset = byId.get(id), uid = values[index].uid;
    const extension = asset && /\.(jpe?g|png|webp|gif)$/i.exec(asset.name)?.[1]?.toLowerCase();
    const expectedMime = extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : '';
    const mime = asset?.attType.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
    const own = asset?.type === 3 && asset.relationId === uid && asset.moduleType === 3
      && asset.fileType === 1 && asset.imageType === R2_IMAGE_TYPE && asset.attDir === ref
      && asset.name.startsWith(`attachments/user/${uid}/`) && /^[A-Za-z0-9_./-]+$/.test(asset.name)
      && !asset.name.split('/').some(part => !part || part === '.' || part === '..')
      && !!expectedMime && mime === expectedMime;
    return own ? ref : fallback[index];
  });
}
