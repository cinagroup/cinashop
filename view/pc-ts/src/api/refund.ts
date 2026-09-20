import request, { getData } from '@/utils/request';
import type { RefundQuery } from '../../../common/refundRecords';
import type { ReturnBody } from '../../../common/refundReturn';

export const apiRefundRecords = (query: RefundQuery): Promise<unknown> => getData(request.get('/order/refund/list', {
  params: { view: 'customer', filter: query.filter, q: query.q, limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
}));
export const apiRefundRecord = (id: number): Promise<unknown> => getData(request.get(`/order/refund/detail/${id}`, { params: { view: 'customer' } }));
export const apiCancelRefund = (id: number): Promise<unknown> => getData(request.post(`/order/refund/cancel/${id}`));
export const apiReturnCarriers = (): Promise<unknown> => getData(request.get('/logistics', { params: { status: 1 } }));
export const apiReturnExpress = (body: ReturnBody): Promise<unknown> => getData(request.post('/order/refund/express', body));
export function apiReturnImage(file: File): Promise<unknown> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) throw Error('请选择不超过10 MiB的PNG、JPEG、WebP或GIF图片');
  const body = new FormData(); body.append('file', file); body.append('pid', '0');
  return getData(request.post('/upload/image', body));
}
