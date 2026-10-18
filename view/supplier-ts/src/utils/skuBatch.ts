import type { ProductDimension, ProductSku } from '@/types';
import type { SupplierSkuBatchDraft, SupplierSkuBatchFilters, SupplierSkuBatchIntent } from '@/types/skuBatch';
import { prepareSupplierProductRuleApplication } from './productRules';
import { classifyProductMediaReference } from '../../../common/productMediaReference';
export const emptySupplierSkuBatchDraft = (): SupplierSkuBatchDraft => ({ image: '', settle_price: '', stock: '', bar_code: '', code: '', weight: '', volume: '' });
const fields = ['image', 'settle_price', 'stock', 'bar_code', 'code', 'weight', 'volume'] as const;
export type SupplierSkuBatchPatch = Partial<Pick<ProductSku, typeof fields[number]>>;
export function supplierSkuBatchGraph(items: ProductDimension[], skus: ProductSku[]) {
  const prepared = prepareSupplierProductRuleApplication(items);
  if (!Array.isArray(skus) || skus.length !== prepared.details.length || skus.length > 200) throw Error('请先生成完整SKU再批量填充');
  const expected = new Set(prepared.details.map(detail => prepared.items.map(item => detail[item.value]).join(',')));
  const keys = new Set<string>();
  const identities = skus.map(sku => {
    if (!sku || !sku.detail || typeof sku.detail !== 'object' || Array.isArray(sku.detail) || sku.is_retired === 1) throw Error('批量目标包含无效或已退役SKU');
    const values = prepared.items.map(item => sku.detail[item.value]);
    if (values.some((value, index) => typeof value !== 'string' || !prepared.items[index]!.detail.includes(value))) throw Error('SKU规格已变化，请重新生成后选择');
    const key = values.join(',');
    if (sku.suk !== key || !expected.has(key) || keys.has(key)) throw Error('SKU组合缺失或重复，请重新生成');
    if (sku.id !== undefined && (!Number.isSafeInteger(sku.id) || sku.id <= 0 || sku.id > 2147483647)) throw Error('SKU身份无效');
    keys.add(key); return [key, sku.id ?? null, sku.unique ?? null, values];
  });
  return { items: prepared.items, signature: JSON.stringify([prepared.items, identities]) };
}
export function supplierSkuBatchTargets(items: ProductDimension[], skus: ProductSku[], filters: SupplierSkuBatchFilters) {
  const graph = supplierSkuBatchGraph(items, skus);
  if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(name => !graph.items.some(item => item.value === name))) throw Error('批量规格选择已变化，请重新选择');
  for (const item of graph.items) {
    if (!Object.hasOwn(filters, item.value)) continue;
    const selected = filters[item.value];
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.some(value => !item.detail.includes(value))) throw Error('批量规格选择包含不存在的值');
  }
  const indices = skus.flatMap((sku, index) => graph.items.every(item => !Object.hasOwn(filters, item.value) || filters[item.value]!.length === 0 || filters[item.value]!.includes(sku.detail[item.value]!)) ? [index] : []);
  return { ...graph, indices };
}
function raw(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 4096) throw Error(`${label}格式错误`);
  return value.trim();
}
function positiveDecimal(value: unknown, label: string): string | undefined {
  const input = raw(value, label);
  if (!input) return undefined;
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(input)) throw Error(`${label}须为最多两位小数的非负数`);
  const [whole, fraction = ''] = input.split('.');
  const normalized = `${BigInt(whole!).toString()}.${fraction.padEnd(2, '0')}`;
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0')) === 0n ? undefined : normalized;
}
export function supplierSkuBatchPatch(draft: SupplierSkuBatchDraft): SupplierSkuBatchPatch {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).length !== fields.length || fields.some(key => !Object.hasOwn(draft, key))) throw Error('批量填写资料无效');
  const patch: SupplierSkuBatchPatch = {};
  const image = raw(draft.image, '图片');
  if (image) {
    const parsed = classifyProductMediaReference(image);
    if (parsed.kind === 'invalid' || parsed.reference.length > 128) throw Error('请使用有效的图片稳定引用或HTTPS地址');
    patch.image = parsed.reference;
  }
  for (const [key, label] of [['settle_price', '结算价'], ['weight', '重量'], ['volume', '体积']] as const) {
    const value = positiveDecimal(draft[key], label); if (value !== undefined) patch[key] = value;
  }
  const stock = raw(draft.stock, '库存');
  if (stock) {
    if (!/^\d{1,10}$/.test(stock) || !Number.isSafeInteger(Number(stock)) || Number(stock) > 2147483647) throw Error('库存须为非负int4整数');
    if (Number(stock) > 0) patch.stock = Number(stock);
  }
  for (const [key, label] of [['bar_code', 'SKU条码'], ['code', 'SKU编号']] as const) {
    const value = raw(draft[key], label); if (value.length > 50) throw Error(`${label}不能超过50个字符`); if (value) patch[key] = value;
  }
  return patch;
}
/** Stage every target and all seven fields before the caller mutates any row. */
export function prepareSupplierSkuBatch(items: ProductDimension[], skus: ProductSku[], intent: SupplierSkuBatchIntent) {
  if (!intent || typeof intent !== 'object') throw Error('批量填写资料无效');
  const targets = supplierSkuBatchTargets(items, skus, intent.filters);
  if (targets.signature !== intent.signature) throw Error('SKU已变化，请重新选择批量目标');
  if (!targets.indices.length) throw Error('没有匹配的SKU');
  const patch = supplierSkuBatchPatch(intent.draft);
  if (!Object.keys(patch).length) throw Error('请填写要批量设置的内容；数值0和空白不会修改SKU');
  return { targets: targets.indices.map(index => skus[index]!), patch };
}
