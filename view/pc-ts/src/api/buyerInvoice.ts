import request, { getData } from '@/utils/request';
import type { BuyerInvoiceDraft, BuyerInvoiceOrder, BuyerInvoiceQuery, BuyerInvoiceTitle } from '../../../common/buyerInvoices';

export const apiBuyerInvoicePage = (query: BuyerInvoiceQuery): Promise<unknown> => getData(request.get(query.kind === 'titles' ? '/invoice' : '/order/invoice_list', { params: { view: 'buyer', limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) } }));
export const apiBuyerInvoiceOrder = (reference: string): Promise<unknown> => getData(request.get(`/order/invoice_detail/${encodeURIComponent(reference)}`, { params: { view: 'buyer' } }));
export const apiBuyerInvoiceSave = (draft: BuyerInvoiceDraft): Promise<unknown> => getData(request.post('/invoice/save?view=buyer', { ...draft }));
export const apiBuyerInvoiceDelete = (id: number, revision: string): Promise<unknown> => getData(request.delete(`/invoice/del/${id}?view=buyer`, { data: { revision } }));
export const apiBuyerInvoiceDefault = (id: number, revision: string): Promise<unknown> => getData(request.post(`/invoice/set_default/${id}?view=buyer`, { revision }));
export const apiBuyerInvoiceApply = (order: BuyerInvoiceOrder, title: BuyerInvoiceTitle): Promise<unknown> => getData(request.post('/order/make_up_invoice?view=buyer', { orderId: order.orderId, orderNo: order.orderNo, revision: order.revision, titleId: title.id, titleRevision: title.revision }));
