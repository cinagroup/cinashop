import { checkedDiyLiveBroadcastLimit, checkedDiyLiveBroadcastRows, type DiyLiveBroadcastRoom } from '../../../common/diyLiveBroadcastData';
export type LiveBroadcastRoomPreview = DiyLiveBroadcastRoom;
/** Same public image projection as the existing consumer. Business images never
 * enter authored JSON and never create a DIY gallery/signing capability. */
function publicImage(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url || url.length > 4096 || /[\u0000-\u001f\u007f]/u.test(url)) return '';
  if (/^https:\/\//iu.test(url)) return url;
  if (/^http:\/\//iu.test(url)) return `https://${url.slice(7)}`;
  if (/^\/(?!\/)/u.test(url)) return url;
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(url) && url.length <= 262144) return url;
  return '';
}
export const checkedDiyLiveBroadcastPublicRows = (raw: unknown, limit: number) => checkedDiyLiveBroadcastRows(raw, limit, publicImage);
function abortIfNeeded(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('直播预览读取已取消'); error.name = 'AbortError'; throw error;
}
/** Isolated one-GET local catalog adapter. No Admin request client, bearer,
 * actor/journal, provider SDK, sync, replay lookup or live mutation imports. */
export async function apiDiyLiveBroadcastPreview(limit: number, signal?: AbortSignal): Promise<LiveBroadcastRoomPreview[]> {
  checkedDiyLiveBroadcastLimit(limit); abortIfNeeded(signal);
  const response = await fetch(`/api/wechat/live?page=1&limit=${limit}`, {
    method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal,
  });
  abortIfNeeded(signal);
  const raw: unknown = await response.json(); abortIfNeeded(signal);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('直播预览响应格式错误');
  const body = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(body.status) || typeof body.msg !== 'string' || !Object.hasOwn(body, 'data')) throw Error('直播预览响应格式错误');
  if (!response.ok || response.status < 200 || response.status >= 300 || body.status !== 200) throw Error(body.msg || `直播预览读取失败（${response.status}）`);
  const rooms = checkedDiyLiveBroadcastPublicRows(body.data, limit); abortIfNeeded(signal);
  return rooms;
}
