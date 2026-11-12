import type { SupplierProductSku } from '@/services/product/ProductSkuInput';
import { normalizeVirtualCardImport, type VirtualCardImportRow } from '@/services/product/VirtualProductInventoryService';
import { ValidateException } from '@/utils/errors';

export interface OutCardImport { suk: string; cards: VirtualCardImportRow[] }

export function outCardProductInput(input: Record<string, unknown>, skus: SupplierProductSku[]) {
  const rows = Array.isArray(input.attrs) ? input.attrs : input.attrs && typeof input.attrs === 'object'
    ? Object.values(input.attrs as Record<string, unknown>) : [];
  const imports: OutCardImport[] = [];
  let count = 0;
  const values = skus.map((sku, index) => {
    const row = rows[index] as Record<string, unknown>;
    const raw = row.virtual_list === undefined ? [] : row.virtual_list;
    if (!Array.isArray(raw)) throw new ValidateException('卡密列表格式错误');
    count += raw.length;
    if (count > 1000) throw new ValidateException('单次商品保存最多导入1000条卡密');
    if (sku.diskInfo && raw.length) throw new ValidateException('固定内容与一次性卡密不能同时提交');
    if (raw.length) imports.push({ suk: sku.suk, cards: normalizeVirtualCardImport(raw).cards });
    return { ...sku, stock: sku.diskInfo ? sku.stock : 0 };
  });
  return { skus: values, cardImports: imports };
}
