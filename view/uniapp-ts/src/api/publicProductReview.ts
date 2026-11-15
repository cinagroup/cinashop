import { http } from '@/utils/request';
import type { ReviewFilter } from '../../../common/publicProductReviews';
export const apiPublicReviewList=(id:number,type:ReviewFilter,page:number,limit:number):Promise<unknown>=>http.get<unknown>(`/product/reviews/${id}`,{type,page,limit});
export const apiPublicReviewDetail=(id:number):Promise<unknown>=>http.get<unknown>(`/product/review/${id}`);
export const apiPublicReviewVisit=(id:number):Promise<unknown>=>http.post<unknown>(`/product/review/${id}/visit`,{version:1});
export const apiPublicReviewComments=(id:number,page:number,limit:number):Promise<unknown>=>http.get<unknown>(`/product/review/${id}/comments`,{page,limit});
export const apiPublicReviewComment=(id:number,content:string):Promise<unknown>=>http.post<unknown>(`/product/review/${id}/comment`,{version:1,content});
export const apiPublicReviewPraise=(id:number,commentId:number|null,praised:boolean):Promise<unknown>=>http.post<unknown>(`/product/review/${id}${commentId===null?'':`/comments/${commentId}`}/praise`,{version:1,praised});
