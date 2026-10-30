import request, { getData } from '@/utils/request';
import type { StaffAction } from '../../../common/staffAuthor';

const base = '/merchant/store_staff/author';
export const apiStaffAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiStaffAuthorCommit = (action: StaffAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiStaffAuthorReceipt = (action: StaffAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiStaffAuthorResolve = (action: StaffAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
export const apiStaffAuthorCategories = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-categories`, { signal }));
export const apiStaffAuthorOptions = (params: Record<string, unknown>, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/attachment-options`, { params, signal }));
export const apiStaffAuthorUsers = (params: Record<string, unknown>, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/users`, { params, signal }));
