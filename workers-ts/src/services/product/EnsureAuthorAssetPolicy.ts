import { asc, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { publicProductPictures, renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

/** Author media is one platform raster attachment. Raw historical DB text is
 * retained separately and never grants a URL, remote request or signature. */
export async function publicEnsureAuthorImages(db: Pick<DbClient, 'select'>, raw: readonly unknown[], lock = false): Promise<string[]> {
  if (raw.length > 20000) throw new ValidateException('商品保障图片超过完整目录容量');
  const refs = raw.map(value => typeof value === 'string' && /^\/api\/assets\/[1-9]\d*$/u.test(value)
    && Number(value.slice(12)) <= 2147483647 ? value : '');
  const ids = [...new Set(refs.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))].sort((a,b) => a-b);
  if (!ids.length) return refs;
  const query = db.select({id: systemAttachment.attId, path: systemAttachment.attDir}).from(systemAttachment)
    .where(inArray(systemAttachment.attId, ids)).orderBy(asc(systemAttachment.attId));
  const rows = await (lock ? query.for('share', {noWait: true}) : query);
  const exact = new Set(rows.filter(row => row.path === `/api/assets/${row.id}`).map(row => row.id));
  const tokens = ids.filter(id => exact.has(id)).map(id => `/api/assets/${id}`), allowed = new Map<string,string>();
  for (let index=0; index<tokens.length; index+=10000) {
    const chunk = tokens.slice(index,index+10000);
    const checked = await publicProductPictures(db,chunk.map(image=>({image,type:0,relationId:0})));
    chunk.forEach((reference,i)=>allowed.set(reference,checked[i] ?? ''));
  }
  return refs.map(reference=>allowed.get(reference) ?? '');
}
export async function renderEnsureAuthorImages(appKey: string | undefined, refs: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (let index=0; index<refs.length; index+=10000) result.push(...await renderProductPictures(appKey,refs.slice(index,index+10000)));
  return result;
}
export async function assertEnsureAuthorImageChange(db: Pick<DbClient,'select'>, previous: string | null, next: string) {
  if (previous !== null && previous === next) return;
  if (!next || (await publicEnsureAuthorImages(db,[next],true))[0] !== next) throw new ValidateException('请选择当前平台图库中的有效保障图片');
}
