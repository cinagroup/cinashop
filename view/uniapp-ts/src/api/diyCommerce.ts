import { http } from '@/utils/request';
import { apiSeckillIndex, apiSeckillList, apiCombinationList, apiBargainList, apiIntegralList, apiPresaleList, apiCouponList, apiLiveRooms } from './activity';
import { apiGoodsList, type GoodsListParams } from './product';
import { checkedCommerceCards, checkedCommerceCoupons, checkedCommercePink, checkedCommerceRooms, checkedCommerceSlots, checkedPromotionProducts } from '@/utils/diyCommerceData';
import type { DiyCommerceKind } from '@/utils/diyCommerceConfig';

export const apiDiyCommerceIndex = async () => checkedCommerceSlots(await apiSeckillIndex());
export const apiDiyCommerceSeckill = async (slot: number, limit: number) => checkedCommerceCards('seckill', await apiSeckillList(slot, { page: 1, limit, type: 'index' }), limit);
export const apiDiyCommercePink = async () => checkedCommercePink(await http.get<unknown>('/pink'));
export const apiDiyCommerceCoupons = async (limit: number, uid: number) => checkedCommerceCoupons(await apiCouponList({ page: 1, limit }), limit, uid);
export const apiDiyCommerceRooms = async (limit: number) => checkedCommerceRooms(await apiLiveRooms({ page: 1, limit }), limit);
export const apiDiyCommercePromotion = async (query: GoodsListParams) => checkedPromotionProducts(await apiGoodsList(query), query.limit ?? 100);
export async function apiDiyCommerceCards(kind: DiyCommerceKind, limit: number) {
  const query = { page: 1, limit };
  const result = kind === 'combination' ? await apiCombinationList(query) : kind === 'bargain' ? await apiBargainList(query)
    : kind === 'pointsMall' ? await apiIntegralList(query) : kind === 'presale' ? await apiPresaleList({ ...query, time_type: 0 }) : null;
  return checkedCommerceCards(kind, result, limit);
}
