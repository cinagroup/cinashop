import request, { getData } from '@/utils/request';
import type { UnitAction } from '../../../common/unitAuthor';
const base = '/product/unit/author';
export const apiUnitAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiUnitAuthorCommit = (action: UnitAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiUnitAuthorReceipt = (action: UnitAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiUnitAuthorResolve = (action: UnitAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
