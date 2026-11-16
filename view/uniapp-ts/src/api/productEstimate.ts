import { createUserCenterRequests } from '@/api/userCenter';
import { decodePublicProductEstimate, validPublicEstimateSku } from '../../../common/publicProductEstimate';
export type { PublicProductEstimate } from '../../../common/publicProductEstimate';

export function createProductEstimateRequests(current: () => boolean, productId: number, skuUnique: string) {
  if (!Number.isSafeInteger(productId) || productId < 1 || productId > 2_147_483_647 || !validPublicEstimateSku(skuUnique))
    throw Error('商品单件预估目标无效');
  const scope = createUserCenterRequests(current);
  return { ...scope, read: async () => decodePublicProductEstimate(await scope.request(
    `product/detail/activity/${productId}`, 'GET', { view: 'uni_product_estimate_v1', unique: skuUnique }),
  { ownerUid: scope.owner.token ? scope.owner.uid : 0, productId, skuUnique }) };
}
export type ProductEstimateRequests = ReturnType<typeof createProductEstimateRequests>;
