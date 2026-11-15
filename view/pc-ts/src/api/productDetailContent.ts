import request, { getData } from '@/utils/request';
import type { DetailRecommendation } from '../../../common/pcProductDetailContent';
import { normalizeProductDetailCouponPage, normalizeProductDetailCouponReceipt, normalizeProductDetailCouponClaim, normalizeProductDescriptionResponse, normalizeDetailRecommendations } from '../../../common/pcProductDetailContent';
export * from '../../../common/pcProductDetailContent';

export async function apiProductDetailCoupons(expected: { uid: number; productId: number; page: number; limit: number }) {
  return normalizeProductDetailCouponPage(await getData(request.get(`/product/detail/${expected.productId}/coupons`, { params: { page: expected.page, limit: expected.limit } })), expected);
}
export async function apiProductDetailCouponReceipt(expected: { uid: number; productId: number; couponId: number }) {
  return normalizeProductDetailCouponReceipt(await getData(request.get(`/product/detail/${expected.productId}/coupons/${expected.couponId}/receipt`)), expected);
}
export async function apiProductDetailCouponClaim(couponId: number): Promise<number> {
  return normalizeProductDetailCouponClaim(await getData(request.post('/coupon/receive', { id: couponId })));
}
export async function apiProductDescription(productId: number): Promise<string> {
  return normalizeProductDescriptionResponse(await getData(request.get(`/product/detail_content/${productId}`)));
}
export async function apiProductDetailRecommendations(productId: number): Promise<DetailRecommendation[]> {
  return normalizeDetailRecommendations(await getData(request.get(`/product/detail/recommend/${productId}`)));
}
