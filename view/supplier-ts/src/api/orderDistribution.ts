import { isAxiosError } from 'axios';
import { apiRequest, ApiError } from './http';
import { previewMode } from './supplier';

export interface SupplierDistributionTarget { id: number; order_id: string; delivery_type: string }
export interface SupplierOrderDistribution extends SupplierDistributionTarget {
  delivery_type: 'express' | 'send' | 'fictitious';
  delivery_name: string; delivery_code: string; delivery_id: string; fictitious_content: string;
  revision: string; editable: boolean; reason: string;
  express_companies: Array<{ id: number; name: string; code: string }>;
}
export interface SupplierDistributionInput {
  expected_revision: string; delivery_name: string; delivery_id: string; fictitious_content: string;
}
function invalid(): never { throw Error('配送信息响应不完整或包裹身份已变化，请重新读取订单'); }
function record(value: unknown) { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown>; }
function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || value.length > max * 2 || [...value].length > max
    || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value)
    || [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) return invalid();
  return value;
}
function id(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) return invalid(); return value; }
export function parseSupplierOrderDistribution(value: unknown, target: SupplierDistributionTarget): SupplierOrderDistribution {
  const row = record(value);
  if (id(row.id) !== target.id || row.order_id !== target.order_id || row.delivery_type !== target.delivery_type
    || !['express', 'send', 'fictitious'].includes(String(row.delivery_type)) || typeof row.editable !== 'boolean'
    || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision) || !Array.isArray(row.express_companies) || row.express_companies.length > 1000) return invalid();
  const companies = row.express_companies.map(raw => { const company = record(raw); return { id: id(company.id), name: text(company.name, 64), code: text(company.code, 50) }; });
  if (new Set(companies.map(row => row.id)).size !== companies.length || new Set(companies.map(row => row.name)).size !== companies.length
    || companies.some(row => !row.name.trim() || !row.code.trim())) return invalid();
  const reason = text(row.reason, 500);
  if (!row.editable && !reason.trim()) return invalid();
  return { id: target.id, order_id: text(row.order_id, 32), delivery_type: row.delivery_type as SupplierOrderDistribution['delivery_type'],
    delivery_name: text(row.delivery_name, 64), delivery_code: text(row.delivery_code, 50), delivery_id: text(row.delivery_id, 64),
    fictitious_content: text(row.fictitious_content, 500, true), revision: row.revision, editable: row.editable, reason, express_companies: companies };
}
function checkTarget(target: SupplierDistributionTarget) {
  if (previewMode) throw Error('预览模式无法修改配送信息，请登录后操作');
  id(target.id); if (!text(target.order_id, 32).trim() || !['express', 'send', 'fictitious'].includes(target.delivery_type)) return invalid();
}
export async function getSupplierOrderDistribution(target: SupplierDistributionTarget, signal?: AbortSignal) {
  checkTarget(target);
  return parseSupplierOrderDistribution(await apiRequest<unknown>({ method: 'GET', url: `/order/distribution/${target.id}`, signal }), target);
}
export function distributionInput(data: SupplierOrderDistribution, form: { delivery_name: string; delivery_id: string; fictitious_content: string }): SupplierDistributionInput {
  const input = { expected_revision: data.revision, delivery_name: '', delivery_id: '', fictitious_content: '' };
  if (data.delivery_type === 'fictitious') {
    input.fictitious_content = form.fictitious_content;
    if ([...input.fictitious_content].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.fictitious_content)) throw Error('交付备注最多500字，请移除无效字符');
  } else {
    input.delivery_name = form.delivery_name.trim(); input.delivery_id = form.delivery_id.trim();
    if (!input.delivery_name || [...input.delivery_name].length > 64 || /[\u0000-\u001f\u007f]/u.test(input.delivery_name)) throw Error('请填写有效的配送名称');
    if (!input.delivery_id || [...input.delivery_id].length > 64 || /[\u0000-\u001f\u007f]/u.test(input.delivery_id)) throw Error('请填写有效的运单号或联系电话');
    if (data.delivery_type === 'express' && !data.express_companies.some(row => row.name === input.delivery_name)) throw Error('请选择当前启用的快递公司');
    if (data.delivery_type === 'send' && !/^1[3-9]\d{9}$/.test(input.delivery_id)) throw Error('请填写有效的配送联系电话');
  }
  return input;
}
export function distributionMatches(data: SupplierOrderDistribution, input: SupplierDistributionInput) {
  return data.delivery_type === 'fictitious' ? data.fictitious_content === input.fictitious_content
    : data.delivery_name === input.delivery_name && data.delivery_id === input.delivery_id;
}
export async function saveSupplierOrderDistribution(target: SupplierDistributionTarget, input: SupplierDistributionInput, signal?: AbortSignal) {
  checkTarget(target);
  const data = parseSupplierOrderDistribution(await apiRequest<unknown>({ method: 'PUT', url: `/order/distribution/${target.id}`, data: input, signal }), target);
  if (!distributionMatches(data, input)) throw Error('保存回执与提交内容不一致，请核对当前配送信息');
  return data;
}
export function distributionKnownRejection(error: unknown) {
  if (error instanceof ApiError) return [400, 404, 409, 400011, 410000, 410001, 410002].includes(error.status);
  if (!isAxiosError(error) || !error.response || ![400, 404, 409].includes(error.response.status)) return false;
  const body: unknown = error.response.data;
  return !!body && typeof body === 'object' && !Array.isArray(body) && (body as { status?: unknown }).status === error.response.status && typeof (body as { msg?: unknown }).msg === 'string';
}
