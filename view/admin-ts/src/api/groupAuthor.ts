import request, { getData } from '@/utils/request';
import type { GroupAction } from '../../../common/groupAuthor';
const base = '/user/group/author';
export const apiGroupAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiGroupAuthorCommit = (action: GroupAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiGroupAuthorReceipt = (action: GroupAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiGroupAuthorResolve = (action: GroupAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
