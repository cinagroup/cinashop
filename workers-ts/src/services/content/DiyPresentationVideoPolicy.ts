import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { adminAttachmentScope, parseCanonicalAttachmentId, R2_IMAGE_TYPE } from '@/services/system/AttachmentService';
import { publicProductPictures } from '@/services/activity/ProductAssetPolicy';
import { canonicalDiyPresentationReference, safeDiyPresentationUrl } from '../../../../view/common/diyPresentationHtml';
import { ValidateException } from '@/utils/errors';

/** Authored DIY MP4s use the actual durable Admin video-upload metadata. Never
 * reinterpret an image/user/supplier attachment as a public platform video.
 * External HTTPS and static paths remain references; this policy fetches none. */
function reference(value:string):string {
  if(typeof value!=='string'||value.length>4096||/[\u0000-\u001f\u007f\\]/u.test(value))return '';
  const normalized=canonicalDiyPresentationReference(value).trim();
  if(!safeDiyPresentationUrl(normalized))return '';
  if(normalized.startsWith('/api/assets/')){const id=parseCanonicalAttachmentId(normalized);if(id===null||id>2147483647)return '';}
  return normalized;
}
/** JSON HTML/video slots have a4096-character URL contract, independent of the
 * catalogue's255-character persisted image columns. Only actual local IDs are
 * delegated to its unchanged platform raster ownership predicate. */
export async function publicDiyPresentationImages(db:Pick<DbClient,'select'>,values:readonly string[]):Promise<string[]>{
  if(values.length>10000)throw new ValidateException('DIY图片超过完整预览容量');
  const refs=values.map(reference),assets=refs.filter(ref=>parseCanonicalAttachmentId(ref)!==null);
  const approved=await publicProductPictures(db,assets.map(image=>({image,type:0,relationId:0})));
  let index=0;return refs.map(ref=>parseCanonicalAttachmentId(ref)!==null?approved[index++]!:ref);
}
export async function publicDiyPresentationVideos(db: Pick<DbClient, 'select'>, values: readonly string[]): Promise<string[]> {
  if(values.length>10000)throw new ValidateException('DIY视频超过完整预览容量');
  const refs=values.map(reference);
  const ids=[...new Set(refs.map(parseCanonicalAttachmentId).filter((id):id is number=>id!==null))];
  if(!ids.length)return refs;
  const scope=adminAttachmentScope();
  const rows=await db.select().from(systemAttachment).where(and(inArray(systemAttachment.attId,ids),eq(systemAttachment.type,scope.type),eq(systemAttachment.relationId,scope.relationId),eq(systemAttachment.moduleType,1),eq(systemAttachment.fileType,2),eq(systemAttachment.imageType,R2_IMAGE_TYPE)));
  const approved=new Set(rows.filter(row=>row.type===scope.type&&row.relationId===0&&row.moduleType===1&&row.fileType===2&&row.imageType===R2_IMAGE_TYPE
    &&canonicalDiyPresentationReference(row.attDir)===`/api/assets/${row.attId}`
    &&/^attachments\/admin\/1\/\d{4}\/(?:0[1-9]|1[0-2])\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.mp4$/u.test(row.name)
    &&row.attType.trim().toLowerCase()==='video/mp4').map(row=>row.attId));
  return refs.map(ref=>{const id=parseCanonicalAttachmentId(ref);return id!==null&&!approved.has(id)?'':ref;});
}
