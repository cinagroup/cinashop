import request, { getData } from '@/utils/request';
import type { StoreAction } from '../../../common/storeAuthor';

const base = '/merchant/store/author';
export const apiStoreAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiStoreAuthorCommit = (action: StoreAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiStoreAuthorReceipt = (action: StoreAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiStoreAuthorResolve = (action: StoreAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
export const apiStoreAuthorCategories = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-categories`, { signal }));
export const apiStoreAuthorOptions = (params: Record<string, unknown>, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-options`, { params, signal }));
export const apiStoreAuthorRegions = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/regions`, { signal }));
export const apiStoreAuthorMapConfig = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/map-config`, { signal }));
