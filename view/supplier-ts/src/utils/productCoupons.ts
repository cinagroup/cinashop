export interface SupplierCouponEntry { id: number; title: string; available: boolean }
export interface SupplierCouponSelection { version: 1; ids: number[]; entries: SupplierCouponEntry[]; truncated: boolean; consistent: boolean }
export interface SupplierCouponOption { id: number; title: string; status: number; coupon_price: string; discount_type: number; use_min_price: string }
export interface SupplierCouponCatalog { version: 1; list: SupplierCouponOption[]; count: number; page: number; limit: number }
export interface ProductCouponEditor { ready: boolean; changed: boolean; ids: number[]; selection: SupplierCouponSelection | null }
export function productCouponIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length > 100 || raw.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) throw Error('赠券最多选择100个有效发行实例');
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}
export function productCouponEditor(raw?: unknown, creating = false): ProductCouponEditor {
  if (raw === undefined) return { ready: creating, changed: false, ids: [], selection: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('商品赠券响应无效');
  const row = raw as SupplierCouponSelection;
  const ids = productCouponIds(row.ids);
  if (Object.keys(row).length !== 5 || row.version !== 1 || typeof row.truncated !== 'boolean' || typeof row.consistent !== 'boolean'
    || JSON.stringify(ids) !== JSON.stringify(row.ids) || !Array.isArray(row.entries) || row.entries.length !== ids.length
    || row.entries.some((entry, i) => !entry || entry.id !== ids[i] || typeof entry.title !== 'string' || [...entry.title].length > 255 || typeof entry.available !== 'boolean')) throw Error('商品赠券响应无效');
  return { ready: true, changed: false, ids, selection: row };
}
export function productCouponPayload(editor: ProductCouponEditor): { coupon_ids?: number[] } {
  return editor.ready && editor.changed ? { coupon_ids: productCouponIds(editor.ids) } : {};
}
export function productCouponCatalog(raw: unknown): SupplierCouponCatalog {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('赠券目录响应无效');
  const row = raw as SupplierCouponCatalog;
  if (Object.keys(row).length !== 5 || row.version !== 1 || !Number.isSafeInteger(row.count) || row.count < 0
    || !Number.isSafeInteger(row.page) || row.page < 1 || !Number.isSafeInteger(row.limit) || row.limit < 1 || row.limit > 50
    || !Array.isArray(row.list) || row.list.length > row.limit || new Set(row.list.map(x => x.id)).size !== row.list.length
    || row.list.some(x => !x || !Number.isSafeInteger(x.id) || x.id <= 0 || x.id > 2147483647 || typeof x.title !== 'string' || [...x.title].length > 255
      || ![-1, 0, 1].includes(x.status) || ![1, 2].includes(x.discount_type)
      || !/^\d{1,10}\.\d{2}$/.test(x.coupon_price) || !/^\d{1,10}\.\d{2}$/.test(x.use_min_price))) throw Error('赠券目录响应无效');
  return row;
}
