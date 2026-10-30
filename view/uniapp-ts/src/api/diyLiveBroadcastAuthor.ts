import { http } from '@/utils/request';
import { safeDiyImageUrl } from '@/utils/diy';
import { checkedDiyLiveBroadcastLimit, checkedDiyLiveBroadcastRows } from '../../../common/diyLiveBroadcastData';
/** The caller owns MP-WEIXIN visibility/lifecycle. Every read is anonymous.
 * A stopped caller drops the result; this never starts any second request. */
export async function apiDiyLiveBroadcastRooms(limit: number) {
  checkedDiyLiveBroadcastLimit(limit);
  const raw = await http.get<unknown>('/wechat/live', { page: 1, limit }, { noAuth: true });
  return checkedDiyLiveBroadcastRows(raw, limit, safeDiyImageUrl);
}
