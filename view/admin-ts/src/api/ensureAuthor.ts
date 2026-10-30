import request, { getData } from '@/utils/request';
import type { EnsureAction } from '../../../common/ensureAuthor';
const base = '/product/ensure/author';
export const apiEnsureAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiEnsureAuthorCommit = (action: EnsureAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiEnsureAuthorReceipt = (action: EnsureAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiEnsureAuthorResolve = (action: EnsureAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
export const apiEnsureAuthorAttachmentCategories = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachments/categories`, { signal }));
export const apiEnsureAuthorAttachmentOptions = (params: { page: number; limit: number; pid: number; name: string }, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachments/options`, { params, signal }));
