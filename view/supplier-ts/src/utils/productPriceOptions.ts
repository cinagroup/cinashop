export interface SupplierProductPriceSelection { version: 1; is_vip: 0 | 1; is_sub: 0 | 1 }

export function productPriceSelection(value: unknown): { ready: boolean; selected: number[] } {
  if (value === undefined) return { ready: false, selected: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('商品价格开关响应无效，请重新读取');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || row.version !== 1 || ![0, 1].includes(Number(row.is_vip))
    || ![0, 1].includes(Number(row.is_sub)) || typeof row.is_vip !== 'number' || typeof row.is_sub !== 'number')
    throw Error('商品价格开关响应无效，请重新读取');
  return { ready: true, selected: [...(row.is_vip === 1 ? [0] : []), ...(row.is_sub === 1 ? [1] : [])] };
}

export function productPriceOptionsPayload(selected: number[], ready: boolean): { is_sub?: number[] } {
  if (!ready) return {};
  if (!Array.isArray(selected) || selected.length > 2 || selected.some(value => value !== 0 && value !== 1)
    || new Set(selected).size !== selected.length) throw Error('商品价格开关无效');
  return { is_sub: [...selected].sort() };
}
