import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { canonicalizePublishedAttachmentReference, renderPublishedArticleMediaReferences } from '@/services/content/ArticleContentPolicy';
import { adminAttachmentScope, parseCanonicalAttachmentId } from '@/services/system/AttachmentService';
import { ValidateException } from '@/utils/errors';

/** Only platform catalogue images can become public slot images. This never
 * contacts image URLs, reads R2 objects, or grants attachment operations. */
export function seckillTimePicture(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(value)) throw new ValidateException('图片格式错误');
  const reference = canonicalizePublishedAttachmentReference(value);
  if (!reference || [...reference].length > 255 || /\s/u.test(reference)) throw new ValidateException('图片须为1至255个字符');
  if (reference.startsWith('/api/assets/')) {
    const id = parseCanonicalAttachmentId(reference);
    if (id === null || id > 2_147_483_647) throw new ValidateException('平台图片标识无效');
  }
  if (/^\/(?!\/)/.test(reference)) return reference;
  try {
    const parsed = new URL(reference);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return reference;
  } catch { /* The reference remains a string, never an external fetch. */ }
  throw new ValidateException('图片只支持HTTPS或站内路径');
}

export async function publicSeckillTimePictures(db: Pick<DbClient, 'select'>, values: readonly unknown[], lock = false) {
  const references = values.map(value => { try { return seckillTimePicture(value); } catch { return ''; } });
  const ids = [...new Set(references.map(parseCanonicalAttachmentId).filter((id): id is number => id !== null))];
  if (!ids.length) return references;
  const scope = adminAttachmentScope();
  const query = db.select({ id: systemAttachment.attId, path: systemAttachment.attDir }).from(systemAttachment)
    .where(and(inArray(systemAttachment.attId, ids), eq(systemAttachment.type, scope.type), eq(systemAttachment.relationId, scope.relationId),
      eq(systemAttachment.moduleType, scope.moduleType), eq(systemAttachment.fileType, 1)));
  const rows = await (lock ? query.for('share') : query);
  const allowed = new Set(rows.filter(row => canonicalizePublishedAttachmentReference(row.path) === `/api/assets/${row.id}`).map(row => row.id));
  return references.map(reference => { const id = parseCanonicalAttachmentId(reference); return id !== null && !allowed.has(id) ? '' : reference; });
}

export async function renderSeckillTimePictures(appKey: string | undefined, references: readonly string[]) {
  return renderPublishedArticleMediaReferences(appKey, references);
}
