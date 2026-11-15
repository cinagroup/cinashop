import request,{getData} from '@/utils/request';
import type { ReviewFilter } from '../../../common/publicProductReviews';
export const apiPublicReviewList=(id:number,type:ReviewFilter,page:number,limit:number):Promise<unknown>=>getData(request.get(`/product/reviews/${id}`,{params:{type,page,limit}}));
export const apiPublicReviewDetail=(id:number):Promise<unknown>=>getData(request.get(`/product/review/${id}`));
export const apiPublicReviewVisit=(id:number):Promise<unknown>=>getData(request.post(`/product/review/${id}/visit`,{version:1}));
export const apiPublicReviewComments=(id:number,page:number,limit:number):Promise<unknown>=>getData(request.get(`/product/review/${id}/comments`,{params:{page,limit}}));
export const apiPublicReviewComment=(id:number,content:string):Promise<unknown>=>getData(request.post(`/product/review/${id}/comment`,{version:1,content}));
export const apiPublicReviewPraise=(id:number,commentId:number|null,praised:boolean):Promise<unknown>=>getData(request.post(`/product/review/${id}${commentId===null?'':`/comments/${commentId}`}/praise`,{version:1,praised}));
