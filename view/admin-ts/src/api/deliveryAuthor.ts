import request, { getData } from '@/utils/request';
import type { DeliveryAction } from '../../../common/deliveryAuthor';

const base = '/order/delivery/author';
export const apiDeliveryAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiDeliveryAuthorCommit = (action: DeliveryAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiDeliveryAuthorReceipt = (action: DeliveryAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiDeliveryAuthorResolve = (action: DeliveryAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
export const apiDeliveryAuthorCategories = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-categories`, { signal }));
export const apiDeliveryAuthorOptions = (params: Record<string, unknown>, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-options`, { params, signal }));
export const apiDeliveryAuthorUsers = (params: Record<string, unknown>, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/users`, { params, signal }));
