import { http } from '@/utils/request';
import { apiCommunityImage } from './communityImage';
import { parseBuyerReviewUpload } from '../../../common/buyerReviewFlow';
import type { BuyerReviewBody } from '../../../common/buyerReview';
import type { BuyerReviewCommunityRetry } from '../../../common/buyerReviewCommunitySync';
export const apiBuyerReviews=(reference:string):Promise<unknown>=>http.get<unknown>(`/order/reviews/${encodeURIComponent(reference)}`);
export const apiBuyerReviewSubmit=(body:BuyerReviewBody):Promise<unknown>=>http.post<unknown>('/reply/submit?view=buyer',{...body});
export const apiBuyerReviewCommunityRetry=(body:BuyerReviewCommunityRetry):Promise<unknown>=>http.post<unknown>(`/order/reviews/${encodeURIComponent(body.orderNo)}/community-sync`,{...body});
export async function apiBuyerReviewImage(filePath:string,current:()=>boolean){
  if(!current())throw Error('评价页面已变化');const result=parseBuyerReviewUpload(await apiCommunityImage(filePath));if(!current())throw Error('评价页面已变化');
  return {url:result.url,preview:filePath};
}
