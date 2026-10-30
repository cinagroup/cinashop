import request, { getData } from '@/utils/request';
import type { HotwordAction } from '../../../common/hotwordAuthor';
const base = '/product/words/author';
export const apiHotwordAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiHotwordAuthorCommit = (action: HotwordAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiHotwordAuthorReceipt = (action: HotwordAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiHotwordAuthorResolve = (action: HotwordAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
export const apiHotwordAuthorAttachmentCategories = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachments/categories`, { signal }));
export const apiHotwordAuthorAttachmentOptions = (params: { page: number; limit: number; pid: number; name: string }, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachments/options`, { params, signal }));
