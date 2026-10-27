import type { DbClient } from '@/lib/di';
import { ValidateException } from '@/utils/errors';
import { resolvePublicUserAvatars, type PublicUserAvatar } from '@/services/user/UserAvatarPolicy';
export const MAX_PINK_AVATAR_MEDIA = 3;
export type PinkAvatarPicture = PublicUserAvatar;
/** The public pink endpoint retains its original complete three-avatar budget. */
export async function publicPinkAvatarPictures(db: Pick<DbClient,'select'>,values:readonly PinkAvatarPicture[]):Promise<string[]>{
  if(values.length>MAX_PINK_AVATAR_MEDIA)throw new ValidateException('拼团头像超过完整预览容量');
  return resolvePublicUserAvatars(db,values);
}
