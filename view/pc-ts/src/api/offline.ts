import request, { getData } from '@/utils/request';
import type { OfflineDraft, OfflineMethod } from '../../../common/offlineCashier';
export const offlineApi = {
  quote: (money: string) => getData<unknown>(request.post('/order/offline/check/price',{pay_price:money})),
  create: (draft: OfflineDraft) => getData<unknown>(request.post('/order/offline/create',draft)),
  read: (id: string) => getData<unknown>(request.get(`/order/offline/detail/${id}`)),
  history:(params:{cursor?:string;order_id?:string})=>getData<unknown>(request.get('/order/offline/history',{params})),
  capabilities:(id:string)=>getData<unknown>(request.get('/order/offline/pay/type',{params:{order_id:id,return_client:'pc'}})),
  pay: (id: string, method: OfflineMethod) => getData<unknown>(request.post('/order/offline/pay',{order_id:id,pay_type:method,return_client:'pc'})),
};
