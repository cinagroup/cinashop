import { eq } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { parseCanonicalAttachmentId, userAttachmentScope, R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { seckillTimePicture } from '@/services/activity/SeckillTimeAssetPolicy';
import { publicPinkAvatarPictures } from '@/services/activity/PinkAvatarMediaPolicy';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { ValidateException } from '@/utils/errors';

export function profileAvatarIdentity(value: string): string {
  if(value==='')return '';
  try{return seckillTimePicture(value,256);}catch{return '';}
}
/** Same persisted UID authority as the existing public user-centre/pink policy.
 * Resolving/signing never reads an object, calls HTTP, or persists a ticket. */
export async function profileAvatarRead(tx: DbClient,uid:number,stored:string):Promise<string>{
  return(await publicPinkAvatarPictures(tx,[{uid,image:stored}]))[0]??'';
}
export async function renderProfileAvatar(appKey:string|undefined,reference:string):Promise<string>{
  return(await renderProductPictures(appKey,[reference]))[0]??'';
}
/** Existing avatars can survive unrelated edits, including legacy static/HTTPS.
 * A replacement capability must be an actual uploaded raster in this UID's
 * registered-user module, never a visitor/supplier/platform copied reference. */
export async function profileAvatarWrite(tx:DbClient,uid:number,value:string,stored:string):Promise<string>{
  const reference=profileAvatarIdentity(value),previous=profileAvatarIdentity(stored);
  if(value!==''&&!reference)throw new ValidateException('头像图片格式无效');
  if(reference===previous)return stored;
  const id=parseCanonicalAttachmentId(reference);
  if(id===null)throw new ValidateException('新头像须为本人上传的图片');
  const [asset]=await tx.select().from(systemAttachment).where(eq(systemAttachment.attId,id)).limit(1).for('share');
  const scope=userAttachmentScope(uid),ext=asset&&/\.(jpe?g|png|gif|webp)$/i.exec(asset.name)?.[1]?.toLowerCase();
  const mime=asset?.attType.trim().toLowerCase().replace(/^image\/jpg$/,'image/jpeg');
  if(!asset||asset.type!==scope.type||asset.relationId!==scope.relationId||asset.moduleType!==scope.moduleType
    ||asset.fileType!==1||asset.imageType!==R2_IMAGE_TYPE||asset.attDir!==reference
    ||!asset.name.startsWith(`attachments/user/${uid}/`)||!/^[A-Za-z0-9_./-]+$/.test(asset.name)
    ||asset.name.split('/').some(part=>!part||part==='.'||part==='..')||!ext||mime!==`image/${ext==='jpg'?'jpeg':ext}`)
    throw new ValidateException('头像不属于当前用户的有效图片');
  return reference;
}
