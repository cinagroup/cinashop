import { http } from '@/utils/request';
import type { BuyerInvoiceDraft, BuyerInvoiceOrder, BuyerInvoiceQuery, BuyerInvoiceTitle } from '../../../common/buyerInvoices';

export const apiBuyerInvoicePage = (query: BuyerInvoiceQuery): Promise<unknown> => http.get<unknown>(query.kind === 'titles' ? '/invoice' : '/order/invoice_list', { view: 'buyer', limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) });
export const apiBuyerInvoiceOrder = (reference: string): Promise<unknown> => http.get<unknown>(`/order/invoice_detail/${encodeURIComponent(reference)}`, { view: 'buyer' });
export const apiBuyerInvoiceSave = (draft: BuyerInvoiceDraft): Promise<unknown> => http.post<unknown>('/invoice/save?view=buyer', { ...draft });
export const apiBuyerInvoiceDelete = (id: number, revision: string): Promise<unknown> => http.delete<unknown>(`/invoice/del/${id}?view=buyer`, { revision });
export const apiBuyerInvoiceDefault = (id: number, revision: string): Promise<unknown> => http.post<unknown>(`/invoice/set_default/${id}?view=buyer`, { revision });
export const apiBuyerInvoiceApply = (order: BuyerInvoiceOrder, title: BuyerInvoiceTitle): Promise<unknown> => http.post<unknown>('/order/make_up_invoice?view=buyer', { orderId: order.orderId, orderNo: order.orderNo, revision: order.revision, titleId: title.id, titleRevision: title.revision });
