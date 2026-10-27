import { inArray } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { systemAttachment } from '@/models/schema';
import { parseCanonicalAttachmentId, signAttachmentReferences } from '@/services/system/AttachmentService';
import { publicDiyPresentationImages, publicDiyPresentationVideos } from '@/services/content/DiyPresentationVideoPolicy';
import { canonicalizePublishedHtmlAttachmentReferences } from '@/services/content/ArticleContentPolicy';
import { ValidateException } from '@/utils/errors';
import { canonicalDiyPresentationReference, diyPresentationHtmlMediaReferences, mapDiyPresentationHtmlMedia,
  safeDiyPresentationUrl, sanitizeDiyPresentationHtml, type DiyPresentationMediaKind } from '../../../../view/common/diyPresentationHtml';

export const MEMBERSHIP_RIGHT_MEDIA_LIMIT = 10_000;
export const MEMBERSHIP_RIGHT_HTML_READ_BYTES = 8 * 1024 * 1024;
export interface MembershipRightMediaSource { image: string; content: string | null }
const bad = (message: string): never => { throw new ValidateException(message); };
function html<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof ValidateException) throw error;
    return bad(error instanceof Error ? error.message.replaceAll('DIY', '会员权益') : '会员权益富文本格式无效');
  }
}
/** Stable editing values are projections; reading never rewrites imported bytes. */
export const stableMembershipRightImage = (value: string) => canonicalDiyPresentationReference(value);
export const stableMembershipRightContent = (value: string | null) => html(() => canonicalizePublishedHtmlAttachmentReferences(
  mapDiyPresentationHtmlMedia(value ?? '', canonicalDiyPresentationReference)));
export function newMembershipRightImage(value: unknown): string {
  if (typeof value !== 'string') return bad('权益图片须为字符串');
  const normalized = stableMembershipRightImage(value);
  if (!normalized || [...normalized].length > 200 || !safeDiyPresentationUrl(normalized)
    || normalized.startsWith('/api/assets/') && parseCanonicalAttachmentId(normalized) === null) return bad('权益图片须为200字内的稳定平台图片、站内路径或HTTPS地址');
  return normalized;
}
export function newMembershipRightContent(value: unknown): string {
  if (typeof value !== 'string' || [...value].length > 200_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || [...value].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })) return bad('权益介绍须为200000字内的富文本');
  const normalized = html(() => stableMembershipRightContent(sanitizeDiyPresentationHtml(value)));
  if (!normalized.trim()) return bad('请添加权益内容');
  return normalized;
}
type Slot = { reference: string; kind: DiyPresentationMediaKind };
interface Prepared { images: string[]; contents: string[]; slots: Slot[]; approved: string[] }
/** Persisted member_right rows authorize only the platform catalogue namespace.
 * No URL fetch, R2 call or arbitrary attachment signature occurs here. */
async function prepare(db: Pick<DbClient, 'select'>, rows: readonly MembershipRightMediaSource[], content: boolean, lock: boolean): Promise<Prepared> {
  if (rows.length > MEMBERSHIP_RIGHT_MEDIA_LIMIT) return bad('会员权益超过完整预览容量');
  const slots: Slot[] = [], imageSlots: number[] = [], contentSlots: number[][] = [], clean: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    imageSlots.push(slots.length); slots.push({ reference: stableMembershipRightImage(row.image), kind: 'image' });
    const source = content ? html(() => sanitizeDiyPresentationHtml(stableMembershipRightContent(row.content))) : '';
    bytes += Buffer.byteLength(source); if (bytes > MEMBERSHIP_RIGHT_HTML_READ_BYTES) return bad('会员权益介绍超过完整8MiB预览容量');
    const indices: number[] = [];
    for (const entry of content ? html(() => diyPresentationHtmlMediaReferences(source)) : []) { indices.push(slots.length); slots.push({ reference: canonicalDiyPresentationReference(entry.value), kind: entry.kind }); }
    contentSlots.push(indices); clean.push(source);
    if (slots.length > MEMBERSHIP_RIGHT_MEDIA_LIMIT) return bad('会员权益图片与视频超过完整10000项预览容量');
  }
  const ids = [...new Set(slots.map(slot => parseCanonicalAttachmentId(slot.reference)).filter((id): id is number => id !== null))].sort((a, b) => a - b);
  if (lock && ids.length) await db.select({ id: systemAttachment.attId }).from(systemAttachment).where(inArray(systemAttachment.attId, ids)).orderBy(systemAttachment.attId).for('share');
  const images = await publicDiyPresentationImages(db, slots.filter(slot => slot.kind === 'image').map(slot => slot.reference));
  const videos = await publicDiyPresentationVideos(db, slots.filter(slot => slot.kind === 'video').map(slot => slot.reference));
  let imageIndex = 0, videoIndex = 0;
  const approved = slots.map(slot => slot.kind === 'image' ? images[imageIndex++]! : videos[videoIndex++]!);
  return { slots, approved, images: imageSlots.map(index => approved[index]!),
    contents: clean.map((source, index) => html(() => sanitizeDiyPresentationHtml(mapDiyPresentationHtmlMedia(source, (_reference, _kind, at) => approved[contentSlots[index]![at]!]!)))) };
}
/** Only changed author fields acquire locks and validation; imported untouched
 * invalid media remains byte-identical and receives no public capability. */
export async function assertMembershipRightMedia(db: Pick<DbClient, 'select'>, image?: string, content?: string): Promise<void> {
  const p = await prepare(db, [{ image: image ?? '', content: content ?? '' }], content !== undefined, true);
  if (p.slots.some((slot, index) => slot.reference !== '' && p.approved[index] !== slot.reference)) return bad('权益图片或正文媒体不可用，或不属于平台');
}
export async function membershipRightMedia(db: Pick<DbClient, 'select'>, appKey: string | undefined,
  rows: readonly MembershipRightMediaSource[], content: boolean): Promise<{ images: string[]; contents: string[] }> {
  const p = await prepare(db, rows, content, false);
  const ids = [...new Set(p.approved.filter(reference => parseCanonicalAttachmentId(reference) !== null))];
  const tickets = ids.length ? await signAttachmentReferences(appKey, ids) : [];
  const byReference = new Map(ids.map((reference, index) => [reference, tickets[index]!]));
  return { images: p.images.map(reference => byReference.get(reference) ?? reference),
    contents: p.contents.map(source => mapDiyPresentationHtmlMedia(source, reference => byReference.get(reference) ?? reference)) };
}
