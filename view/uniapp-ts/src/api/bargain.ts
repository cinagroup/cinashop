import { http } from '@/utils/request';
import { useAuthStore } from '@/stores/auth';
import { bargainPage, parseBargainList, parseBargainSelection, parseMyBargains } from '../../../common/bargainPurchase';
import { parseBargainFriendView } from '../../../common/bargainInvitation';

export async function apiBargainCatalogPage(page = 1) {
  return parseBargainList(await http.get<unknown>('/bargain/list', { page: bargainPage(page), limit: 20 }));
}
export async function apiBargainSelection(id: number, participantId = 0) {
  const auth = useAuthStore(), authenticated = auth.isLoggedIn, version = auth.sessionVersion;
  if (participantId && !authenticated) throw new Error('请先登录查看自己的砍价记录');
  const data = await http.get<unknown>(`/bargain/detail/${id}`, { view: 'skus', ...(participantId ? { bargain_user_id: participantId } : {}) });
  if (version !== auth.sessionVersion) throw new Error('登录状态已变化，请重新操作');
  return parseBargainSelection(data, id, participantId, authenticated);
}
export async function apiMyBargains(page = 1) {
  const auth = useAuthStore(), uid = auth.uid, version = auth.sessionVersion;
  if (!auth.isLoggedIn || !uid) throw new Error('请先登录查看自己的砍价记录');
  const data = await http.get<unknown>('/bargain/user/list', { page: bargainPage(page), limit: 20 });
  if (version !== auth.sessionVersion) throw new Error('登录状态已变化，请重新操作');
  return parseMyBargains(data, uid);
}
export async function apiBargainFriendView(id: number, participantId = 0, ownerUid = 0) {
  const auth = useAuthStore(), version = auth.sessionVersion;
  if (!auth.isLoggedIn || !auth.uid) throw new Error('请登录后帮助好友砍价');
  if ((!participantId) === (!ownerUid) || !Number.isSafeInteger(id) || id < 1 || id > 2147483647
    || [participantId, ownerUid].some(value => !Number.isSafeInteger(value) || value < 0 || value > 2147483647))
    throw new Error('砍价邀请标识无效');
  const data = await http.get<unknown>(`/bargain/detail/${id}`, { view: 'help',
    ...(participantId ? { bargain_user_id: participantId } : { bargain_user_uid: ownerUid }) });
  if (version !== auth.sessionVersion) throw new Error('登录状态已变化，请重新操作');
  return parseBargainFriendView(data, id, participantId);
}
export const apiBargainStart = (id: number) => http.post<{ id: number }>('/bargain/start', { bargain_id: id });
export const apiBargainHelp = (id: number) => http.post<unknown>('/bargain/help', { bargain_user_id: id });
