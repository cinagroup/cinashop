import { API_BASE, http } from '@/utils/request';
import type {UserCenterRequests} from '@/api/userCenter';
import { parseLegacyShareCode, parseSpreadPosterData, parseShareScene, posterImage, type LegacyShareType } from '@/utils/legacyShare';
export * from '@/utils/legacyShare';
function apiOrigin() { return API_BASE || (typeof window !== 'undefined' ? window.location.origin : ''); }
export async function apiLegacyShareCode(type: LegacyShareType, id: number, data: Record<string, unknown> = {}) {
  if (!Number.isSafeInteger(id) || id < 0 || id > 2147483647) throw Error('分享目标编号无效');
  return parseLegacyShareCode(await http.get<unknown>(`/get_qrcode/${type}/${id}`, data), apiOrigin());
}
export async function apiSpreadPosterData() { return parseSpreadPosterData(await http.get<unknown>('/user/spread_info'), API_BASE); }
export async function apiShareScene(token: string) {
  if (!/^[a-f0-9]{24}$/u.test(token)) throw Error('分享码无效');
  return parseShareScene(await http.get<unknown>(`/share/scene/${token}`));
}
export async function apiReadPrivateShareScene(token:string,scope:UserCenterRequests) {
  if(!/^[a-f0-9]{24}$/u.test(token))throw Error('分享码无效');
  return parseShareScene(await scope.request<unknown>(`/share/scene/${token}`,'GET',{},true));
}
export async function apiFollowPoster(): Promise<string> {
  const row = await http.get<unknown>('/wechat/follow');
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('关注海报格式无效');
  const path = posterImage((row as Record<string, unknown>).path); if (!path) throw Error('公众号关注码尚未配置'); return path;
}
