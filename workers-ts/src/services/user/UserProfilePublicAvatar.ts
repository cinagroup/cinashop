import type { DbClient } from '@/lib/di';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { canonicalizePublishedAttachmentReference } from '@/services/content/ArticleContentPolicy';
import { renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { ValidateException } from '@/utils/errors';
import { resolvePublicUserAvatars as resolveBoundedUserAvatars,MAX_PUBLIC_USER_AVATARS,type PublicUserAvatar } from './UserAvatarPolicy';
function budget(length:number){if(length>MAX_PUBLIC_USER_AVATARS)throw new ValidateException('用户头像超过完整预览容量');}
/** Existing consumers keep their own noncanonical legacy URL behavior. Only
 * canonical capabilities opt into UID-bound metadata authorization here. Pink
 * itself continues using its original strict URL grammar and max3 contract. */
export async function resolvePublicUserAvatars(db:DbClient,values:readonly PublicUserAvatar[]):Promise<string[]>{
  budget(values.length);const output=values.map(value=>typeof value.image==='string'?value.image:''),indices:number[]=[],canonical:PublicUserAvatar[]=[];
  values.forEach((value,index)=>{const ref=canonicalizePublishedAttachmentReference(output[index]);if(parseCanonicalAttachmentId(ref)!==null){indices.push(index);canonical.push({uid:value.uid,image:ref});}});
  const allowed=await resolveBoundedUserAvatars(db,canonical);indices.forEach((index,at)=>{output[index]=allowed[at];});return output;
}
/** Only resolved canonical references are signed; noncanonical legacy values
 * are not reinterpreted. Missing APP_KEY never leaks a bare capability. */
export async function renderPublicUserAvatars(appKey:string|undefined,refs:readonly string[]):Promise<string[]>{
  budget(refs.length);const output=[...refs],indices:number[]=[],canonical:string[]=[];
  refs.forEach((ref,index)=>{if(parseCanonicalAttachmentId(ref)!==null){indices.push(index);canonical.push(ref);}});
  const signed=appKey?await renderProductPictures(appKey,canonical):canonical.map(()=>'');indices.forEach((index,at)=>{output[index]=signed[at];});return output;
}
export async function publicUserAvatars(db:DbClient,appKey:string|undefined,values:readonly PublicUserAvatar[]):Promise<string[]>{
  return renderPublicUserAvatars(appKey,await resolvePublicUserAvatars(db,values));
}
