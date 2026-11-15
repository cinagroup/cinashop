import request,{getData} from '@/utils/request';
import { apiReturnImage } from './refund';
import { parseBuyerReviewUpload } from '../../../common/buyerReviewFlow';
import type { BuyerReviewBody } from '../../../common/buyerReview';
export const apiBuyerReviews=(reference:string):Promise<unknown>=>getData(request.get(`/order/reviews/${encodeURIComponent(reference)}`));
export const apiBuyerReviewSubmit=(body:BuyerReviewBody):Promise<unknown>=>getData(request.post('/reply/submit?view=buyer',body));
export async function apiBuyerReviewImage(file:File,current:()=>boolean){
  if(!current())throw Error('评价页面已变化');
  const result=parseBuyerReviewUpload(await apiReturnImage(file));if(!current())throw Error('评价页面已变化');
  const preview=URL.createObjectURL(file);return {url:result.url,preview,release:()=>URL.revokeObjectURL(preview)};
}
