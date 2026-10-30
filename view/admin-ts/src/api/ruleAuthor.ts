import request, { getData } from '@/utils/request';
import type { RuleAction } from '../../../common/ruleAuthor';
const base = '/product/rule/author';
export const apiRuleAuthorCatalog = (signal?: AbortSignal) => getData<unknown>(request.get(`${base}/catalog`, { signal }));
export const apiRuleAuthorCommit = (action: RuleAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/commit`, action, { signal }));
export const apiRuleAuthorReceipt = (action: RuleAction, signal?: AbortSignal) => getData<unknown>(request.get(`${base}/receipt/${action.operation_id}`, { signal }));
export const apiRuleAuthorResolve = (action: RuleAction, signal?: AbortSignal) => getData<unknown>(request.post(`${base}/resolve`, action, { signal }));
