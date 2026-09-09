import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeBargain, storeProductDescription } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { canonicalizePublishedAttachmentReference, renderPublishedArticleHtml,
  renderPublishedArticleMediaReferences, sanitizePublishedArticleHtml } from '@/services/content/ArticleContentPolicy';

export const MAX_BARGAIN_DESCRIPTION_CHARS = 16_000;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
type ContentRow = Pick<typeof storeBargain.$inferSelect, 'title' | 'info' | 'unitName' | 'image' | 'images'>;

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new ValidateException('砍价展示文本格式或长度无效');
  return value;
}
function media(value: unknown): string {
  if (typeof value !== 'string') throw new ValidateException('砍价图片格式无效');
  const result = canonicalizePublishedAttachmentReference(value);
  if (!result || result.length > 256 || /[\s\u0000-\u001f\u007f\\]/u.test(result)) throw new ValidateException('砍价图片须为HTTPS或站内绝对路径');
  if (/^\/(?!\/)/u.test(result)) return result;
  try { const url = new URL(result); if (url.protocol === 'https:' && !url.username && !url.password) return result; } catch { /* reject below */ }
  throw new ValidateException('砍价图片须为HTTPS或站内绝对路径');
}
export function parseBargainContent(body: Record<string, unknown>) {
  const fields: Partial<ContentRow> = {};
  for (const [key, maximum] of [['title',255],['info',255],['unitName',16]] as const) {
    if (own(body,key)) fields[key] = text(body[key],maximum);
  }
  if (own(body,'image')) fields.image = body.image === '' ? '' : media(body.image);
  if (own(body,'images')) {
    if (!Array.isArray(body.images) || body.images.length > 8) throw new ValidateException('砍价轮播图须为最多8张的数组');
    const images = body.images.map(media);
    if (new Set(images).size !== images.length) throw new ValidateException('砍价轮播图不能重复');
    fields.images = JSON.stringify(images);
    if (fields.images.length > 2000) throw new ValidateException('砍价轮播图总长度不能超过2000字符');
    if (fields.image !== undefined && fields.image !== (images[0] ?? '')) throw new ValidateException('砍价主图须与首张轮播图一致');
    fields.image = images[0] ?? '';
  }
  let description: string | undefined;
  if (own(body,'description')) {
    if (typeof body.description !== 'string' || body.description.length > MAX_BARGAIN_DESCRIPTION_CHARS || body.description.includes('\0')) throw new ValidateException('砍价描述须为不超过16000字符的HTML');
    description = sanitizePublishedArticleHtml(body.description);
    if (description.length > MAX_BARGAIN_DESCRIPTION_CHARS) throw new ValidateException('规范化后的砍价描述超过16000字符');
  }
  return {fields,description};
}

/** Legacy image-only clients replace the cover, without replaying other content. */
export function alignBargainCover(fields: Partial<ContentRow>, currentImages: string) {
  if(fields.image === undefined || fields.images !== undefined)return;
  let rest:string[]=[];
  try { const value:unknown=JSON.parse(currentImages||'[]'); if(Array.isArray(value))rest=value.slice(1,8).map(media); } catch { /* invalid old gallery cannot be preserved */ }
  fields.images=JSON.stringify(fields.image ? [fields.image,...rest.filter(image=>image!==fields.image)] : []);
  if(fields.images.length>2000)throw new ValidateException('砍价轮播图总长度不能超过2000字符');
}

/** Caller holds the activity boundary; only type=2 content is replaced. */
export async function saveBargainDescription(tx: DbClient, activityId: number, description: string | undefined) {
  if (description === undefined) return;
  await tx.delete(storeProductDescription).where(and(eq(storeProductDescription.productId,activityId),eq(storeProductDescription.type,2)));
  await tx.insert(storeProductDescription).values({productId:activityId,type:2,description});
}
export async function readBargainContent(tx: DbClient, activityId: number, row: ContentRow) {
  const descriptions = await tx.select({description:sql<string>`left(${storeProductDescription.description},${MAX_BARGAIN_DESCRIPTION_CHARS+1})`})
    .from(storeProductDescription).where(and(eq(storeProductDescription.productId,activityId),eq(storeProductDescription.type,2))).limit(2);
  if (descriptions.length > 1 || (descriptions[0]?.description?.length ?? 0) > MAX_BARGAIN_DESCRIPTION_CHARS) throw new ValidateException('砍价描述配置异常，请先整理');
  let images: string[] = [];
  try { const value:unknown = JSON.parse(row.images || '[]'); if(Array.isArray(value)) images = value.slice(0,8).flatMap(value=>{try{return [media(value)];}catch{return [];}}); } catch { /* legacy malformed gallery: use safe main image */ }
  if (!images.length && row.image) { try { images = [media(row.image)]; } catch { /* invalid historical image stays hidden */ } }
  return {title:row.title,info:row.info,unitName:row.unitName,images,description:sanitizePublishedArticleHtml(descriptions[0]?.description ?? '')};
}
export async function renderBargainContent(content: Awaited<ReturnType<typeof readBargainContent>>, appKey?: string) {
  return {info:content.info,unit_name:content.unitName,
    images:await renderPublishedArticleMediaReferences(appKey,content.images),
    description:await renderPublishedArticleHtml(appKey,content.description)};
}
