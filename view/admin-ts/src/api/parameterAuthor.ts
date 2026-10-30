import request, { getData } from '@/utils/request';
import type { ParameterAction } from '../../../common/parameterAuthor';
const base = '/product/specs/author';
export const apiParameterAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiParameterAuthorCommit = (action: ParameterAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiParameterAuthorReceipt = (action: ParameterAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiParameterAuthorResolve = (action: ParameterAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
