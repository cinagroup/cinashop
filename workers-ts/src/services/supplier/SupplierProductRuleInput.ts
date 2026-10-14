import { ValidateException } from '@/utils/errors';
import { normalizeProductRuleInput } from '@/services/product/ProductMetadataService';

export const SUPPLIER_RULE_LIMIT = 1_000;
export function supplierRuleId(value: unknown, zero = false): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) throw new ValidateException('规格模板ID错误');
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < (zero ? 0 : 1) || id > 2_147_483_647) throw new ValidateException('规格模板ID错误');
  return id;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidateException('规格模板数据格式错误');
  return value as Record<string, unknown>;
}
export function supplierRuleRevision(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException('规格模板版本错误');
  return value;
}
export function parseSupplierProductRuleInput(value: unknown) {
  const body = record(value);
  // The real legacy addAttr editor posts its complete read.info projection.
  const keys = ['rule_name', 'ruleName', 'spec', 'expected_revision', 'id', 'type', 'relation_id', 'rule_value', 'attr_name', 'attr_value', 'revision', 'valid'];
  if (Object.keys(body).some(key => !keys.includes(key))) throw new ValidateException('规格模板字段错误');
  const name = body.rule_name ?? body.ruleName;
  if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 32 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(name)) throw new ValidateException('模板名称需为1至32个字符');
  if (body.rule_name !== undefined && body.ruleName !== undefined && body.rule_name !== body.ruleName) throw new ValidateException('模板名称参数冲突');
  const spec = normalizeProductRuleInput(body.spec);
  if (spec.some(item => /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(item.value) || item.detail.some(value => /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)))) throw new ValidateException('规格内容包含无效字符');
  return { name: name.trim(), spec, expectedRevision: supplierRuleRevision(body.expected_revision) };
}
export function parseSupplierProductRuleDelete(value: unknown) {
  if (value === undefined) return {};
  const body = record(value);
  if (Object.keys(body).some(key => !['expected_revision', 'ids'].includes(key)) || body.ids !== undefined && body.ids !== '') throw new ValidateException('规格模板删除字段错误');
  return { expectedRevision: supplierRuleRevision(body.expected_revision) };
}
export function supplierRuleNoQuery(query: URLSearchParams) {
  if (query.size) throw new ValidateException('此规格模板操作不接受查询参数');
}
export function parseSupplierProductRuleList(query: URLSearchParams) {
  for (const key of query.keys()) if (!['rule_name', 'page', 'limit'].includes(key) || query.getAll(key).length !== 1) throw new ValidateException('规格模板查询参数错误');
  const name = query.get('rule_name') ?? '';
  if ([...name].length > 50 || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(name)) throw new ValidateException('规格模板搜索内容无效');
  const paged = query.has('page') || query.has('limit');
  const page = paged ? supplierRuleId(query.get('page') ?? 1) : 0;
  const limit = paged ? supplierRuleId(query.get('limit') ?? 20) : 0;
  if (page > 1_000_000 || limit > 100) throw new ValidateException('规格模板分页超限');
  return { name: name.trim(), page, limit, paged };
}
