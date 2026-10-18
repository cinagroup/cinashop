export interface SupplierSkuBatchDraft {
  image: string;
  settle_price: string;
  stock: string;
  bar_code: string;
  code: string;
  weight: string;
  volume: string;
}
export type SupplierSkuBatchFilters = Record<string, string[]>;
export interface SupplierSkuBatchIntent {
  context: string;
  signature: string;
  filters: SupplierSkuBatchFilters;
  draft: SupplierSkuBatchDraft;
}
