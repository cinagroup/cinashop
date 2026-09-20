import { sendOrderRequest } from '@/utils/orderRequest';
import { offlineId, parseOfflineDetail, parseOfflineList, validateOfflineQuery, type OfflineQuery } from '@/utils/offlineOrderRead';
import { parseOfflineScan, type OfflineScanType } from '@/utils/offlineScan';

export async function apiOfflineRecords(input: OfflineQuery, signal?: AbortSignal) {
  const query = validateOfflineQuery(input);
  return parseOfflineList(await sendOrderRequest('/order/scan_list', 'get', undefined, query, signal), query);
}
export async function apiOfflineRecord(id: string, signal?: AbortSignal) {
  offlineId(id);
  return parseOfflineDetail(await sendOrderRequest(`/order/scan_detail/${id}`, 'get', undefined, undefined, signal), id);
}
export async function apiOfflineScan(type: OfflineScanType, signal?: AbortSignal) {
  if (type !== 0 && type !== 1) throw Error('收银码类型无效');
  return parseOfflineScan(await sendOrderRequest('/order/offline_scan', 'get', undefined, { type }, signal), type);
}
