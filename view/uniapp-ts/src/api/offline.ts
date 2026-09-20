import { http } from '@/utils/request';
import type { OfflineDraft, OfflineMethod } from '../../../common/offlineCashier';
export const offlineApi = {
  quote:(money:string)=>http.post<unknown>('order/offline/check/price',{pay_price:money}),
  create:(draft:OfflineDraft)=>http.post<unknown>('order/offline/create',{...draft}),
  read:(id:string)=>http.get<unknown>(`order/offline/detail/${id}`),
  history:(params:{cursor?:string;order_id?:string})=>http.get<unknown>('order/offline/history',params),
  capabilities:(id:string)=>http.get<unknown>('order/offline/pay/type',{order_id:id,return_client:'h5'}),
  pay:(id:string,method:OfflineMethod)=>http.post<unknown>('order/offline/pay',{order_id:id,pay_type:method,return_client:'h5'}),
};
