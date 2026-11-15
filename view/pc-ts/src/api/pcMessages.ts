import request, { getData } from '@/utils/request';
import { normalizePcMessageSummary, normalizePcMessagePage, normalizePcMessageDetail, pcMessageInteger, pcMessagePageNumber, PC_MESSAGE_PAGE_SIZE } from '../../../common/pcMessageCenter';
export * from '../../../common/pcMessageCenter';
export async function apiPcMessageSummary(uid: number, signal?: AbortSignal) {
  pcMessageInteger(uid, 1);
  return normalizePcMessageSummary(await getData(request.get('/user/message', { params: { view: 'pc_message_summary' }, signal })), uid);
}
export async function apiPcMessagePage(uid: number, page: number, signal?: AbortSignal) {
  pcMessageInteger(uid, 1); pcMessagePageNumber(page);
  return normalizePcMessagePage(await getData(request.get('/user/message_system/list', { params: { view: 'pc_system_messages', page, limit: PC_MESSAGE_PAGE_SIZE }, signal })), uid, page);
}
export async function apiPcMessageDetail(uid: number, id: number, signal?: AbortSignal) {
  pcMessageInteger(uid, 1); pcMessageInteger(id, 1);
  return normalizePcMessageDetail(await getData(request.get(`/user/message_system/detail/${id}`, { params: { view: 'system_message_detail' }, signal })), uid, id);
}
