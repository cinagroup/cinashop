import type { SupplierProductBatchFacts, SupplierProductBatchPayload } from '@/types';
export function productBatchFactsValid(value: SupplierProductBatchFacts): boolean {
  return Boolean(value && /^[a-f0-9]{64}$/.test(value.revision) && value.count >= 1 && value.count <= 100
    && Array.isArray(value.ids) && value.ids.length === value.count && new Set(value.ids).size === value.count
    && value.ids.every(id => Number.isSafeInteger(id) && id > 0) && Array.isArray(value.products)
    && value.products.length === value.count && value.products.every((row, index) => row.id === value.ids[index]
      && row.type === 2 && Number.isSafeInteger(row.relation_id) && row.relation_id > 0 && row.is_del === 0 && [0, 1, 3].includes(row.product_type)
      && typeof row.store_name === 'string' && typeof row.cate_id === 'string' && typeof row.delivery_type === 'string'
      && [0, 1].includes(row.is_show) && [-2, -1, 0, 1].includes(row.is_verify)
      && Number.isSafeInteger(row.system_form_id) && row.system_form_id >= 0 && Number.isSafeInteger(row.temp_id) && row.temp_id >= 0
      && [0, 1, 2, 3].includes(row.freight) && /^\d{1,10}\.\d{2}$/.test(row.postage))
    && Array.isArray(value.relations) && value.relations.every(row => value.ids.includes(row.product_id)
      && Number.isSafeInteger(row.relation_id) && row.relation_id > 0 && Number.isSafeInteger(row.relation_pid)
      && row.relation_pid >= 0 && [0, 1].includes(row.status)));
}
export function productBatchMatches(facts: SupplierProductBatchFacts, payload: SupplierProductBatchPayload, ids: number[]): boolean {
  if (!productBatchFactsValid(facts) || facts.ids.join(',') !== [...ids].sort((a, b) => a - b).join(',')) return false;
  const data = payload.data;
  return facts.products.every(row => {
    if (payload.type === 1) {
      const expected = [...new Set(data.cate_id ?? [])].sort((a, b) => a - b);
      const relations = facts.relations.filter(relation => relation.product_id === row.id);
      return row.cate_id === expected.join(',') && relations.length === expected.length
        && relations.every(relation => relation.status === row.is_show)
        && relations.map(relation => relation.relation_id).sort((a, b) => a - b).join(',') === expected.join(',');
    }
    if (payload.type === 3) return row.delivery_type === [...new Set(data.delivery_type ?? [])].sort((a, b) => a - b).join(',');
    if (payload.type === 7) return row.system_form_id === data.system_form_id;
    return row.freight === data.freight && row.postage === (data.freight === 2 ? data.postage : '0.00')
      && row.temp_id === (data.freight === 3 ? data.temp_id : 0);
  });
}
