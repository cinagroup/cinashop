import { isAxiosError } from 'axios';
import { apiRequest, ApiError } from './http';
import type { SupplierProductRulePayload } from '@/types/productRules';
import { parseSupplierProductRuleCatalog, parseSupplierProductRuleDetail, parseSupplierProductRuleReceipt, parseSupplierProductRuleTemplates } from '@/utils/productRules';
export async function getSupplierProductRules(query: { rule_name?: string; page?: number; limit?: number } = {}, signal?: AbortSignal) {
  return parseSupplierProductRuleCatalog(await apiRequest<unknown>({ url: '/product/product/rule', method: 'GET', params: query, signal }));
}
export async function getSupplierProductRule(id: number, signal?: AbortSignal) {
  return parseSupplierProductRuleDetail(await apiRequest<unknown>({ url: `/product/product/rule/${id}`, method: 'GET', signal }));
}
export async function getSupplierProductRuleTemplates(signal?: AbortSignal) {
  return parseSupplierProductRuleTemplates(await apiRequest<unknown>({ url: '/product/product/get_rule', method: 'GET', signal }));
}
export async function saveSupplierProductRule(id: number, data: SupplierProductRulePayload, signal?: AbortSignal) {
  return parseSupplierProductRuleReceipt(await apiRequest<unknown>({ url: `/product/product/rule/${id}`, method: 'POST', data, signal }));
}
export async function deleteSupplierProductRule(id: number, expectedRevision?: string, signal?: AbortSignal): Promise<null> {
  const result = await apiRequest<unknown>({ url: `/product/product/rule/delete/${id}`, method: 'DELETE', ...(expectedRevision ? { data: { expected_revision: expectedRevision } } : {}), signal });
  if (result !== null) throw Error('规格模板删除结果未知，请重新读取核对'); return null;
}
export function supplierProductRuleKnownRejection(error: unknown) {
  if (error instanceof ApiError) return [400, 404, 409, 400011, 410000, 410001, 410002].includes(error.status);
  if (!isAxiosError(error) || !error.response || ![400, 404, 409].includes(error.response.status)) return false;
  const body: unknown = error.response.data;
  return !!body && typeof body === 'object' && !Array.isArray(body) && (body as { status?: unknown }).status === error.response.status && typeof (body as { msg?: unknown }).msg === 'string';
}
