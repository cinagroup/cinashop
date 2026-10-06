import type { CategoryNode, GoodsItem } from '../uniapp-ts/src/types/product';
import { isProductCategoryStyleValue, type PublicProductCategoryStyle } from './productCategoryStyle';

export type CategoryStyle = PublicProductCategoryStyle;
export interface CategoryScope { cid?: number; sid?: number; tid?: number }
export interface OrdinaryCartRecovery { version: 1; actor: number; state: 'unknown' | 'acknowledged'; mode: 'cart' | 'buy'; productId: number; unique: string; quantity: number; cartId: number | null }
export const ordinaryRecoveryKey = (uid: number) => `cinashop_category_purchase_v1_${uid}`;
/** This journal is uncertainty protection, not a server receipt or proof of a failed mutation. */
export function parseOrdinaryRecovery(raw: unknown, actor: number): OrdinaryCartRecovery {
  if (typeof raw !== 'string' || raw.length > 2048) throw Error('购买恢复资料无效');
  const row = record(JSON.parse(raw));
  if (Object.keys(row).sort().join(',') !== 'actor,cartId,mode,productId,quantity,state,unique,version' || row.version !== 1 || row.actor !== actor
    || !Number.isSafeInteger(row.productId) || Number(row.productId) < 1 || Number(row.productId) > 2147483647 || typeof row.unique !== 'string' || !row.unique || row.unique.length > 16 || /[\u0000-\u001f\u007f]/u.test(row.unique)
    || !Number.isSafeInteger(row.quantity) || Number(row.quantity) < 1 || Number(row.quantity) > 32767 || row.mode !== 'cart' && row.mode !== 'buy' || row.state !== 'unknown' && row.state !== 'acknowledged'
    || row.state === 'unknown' && row.cartId !== null || row.state === 'acknowledged' && (!Number.isSafeInteger(row.cartId) || Number(row.cartId) < 1 || Number(row.cartId) > 2147483647)) throw Error('购买恢复资料无效');
  return row as unknown as OrdinaryCartRecovery;
}
export interface CategoryProduct extends GoodsItem {
  brand_name: string; spec_type: 0 | 1; is_presale_product: 0 | 1; cart_num: number;
}
export type CategoryTemplate = 'tree' | 'top-products' | 'side-products' | 'filter-products';
export function categoryTemplate(style: Pick<CategoryStyle, 'level' | 'index'>): CategoryTemplate {
  if (style.index === 0) return 'tree';
  if (style.index === (style.level === 2 ? 5 : 3)) return 'filter-products';
  if (style.level === 2 && (style.index === 1 || style.index === 4)) return 'side-products';
  return 'top-products';
}
export function categoryBigCards(style: Pick<CategoryStyle, 'level' | 'index'>): boolean {
  return style.level === 2 ? style.index === 1 || style.index === 3 : style.index === 1;
}
export function categoryId(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string' || !/^[1-9]\d{0,9}$/u.test(String(value))) throw Error('分类标识无效');
  const id = Number(value); if (!Number.isSafeInteger(id) || id > 2147483647) throw Error('分类标识无效'); return id;
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('分类响应格式无效'); return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('分类文字无效'); return value;
};
export function categoryImage(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !value) return '';
  let layer = value;
  for (let depth = 0; depth <= 3; depth++) {
    if (depth === 0 && /\s/u.test(layer) || /[\u0000-\u001f\u007f\\]/u.test(layer)) return '';
    try {
      if (/^\/(?!\/)/u.test(layer)) { if (!/^\/(?!\/)/u.test(new URL(layer, 'https://category.invalid').pathname)) return ''; }
      else { const parsed = new URL(layer); if (!/^https:\/\//iu.test(layer) || parsed.protocol !== 'https:' || parsed.username || parsed.password) return ''; }
    } catch { return ''; }
    if (!/%[a-f\d]{2}/iu.test(layer)) return value;
    if (depth === 3) return ''; try { layer = decodeURIComponent(layer); } catch { return ''; }
  }
  return '';
}
export function parseCategoryStyle(value: unknown): CategoryStyle {
  const raw = record(value), layout = record(raw.product_category);
  if (!Array.isArray(layout.issues) || layout.issues.length > 20 || typeof layout.configured !== 'boolean' || !isProductCategoryStyleValue(layout)) throw Error('分类布局响应无效');
  const issues = layout.issues.map(item => text(item, 256));
  return { level: layout.level, index: layout.index, configured: layout.configured, issues };
}
export function parseCategoryTree(value: unknown): CategoryNode[] {
  if (!Array.isArray(value)) throw Error('分类树响应无效');
  const ids = new Set<number>(); let count = 0;
  function nodes(rows: unknown[], parent: number, depth: number): CategoryNode[] {
    if (depth > 8) throw Error('分类层级超出范围');
    return rows.map(item => {
      const row = record(item), id = categoryId(row.id);
      if (ids.has(id) || ++count > 10000 || row.pid !== parent) throw Error('分类归属或标识无效'); ids.add(id);
      if (row.children !== undefined && !Array.isArray(row.children)) throw Error('子分类响应无效');
      return { id, pid: parent, cate_name: text(row.cate_name, 256), pic: categoryImage(row.pic), big_pic: categoryImage(row.big_pic), children: nodes((row.children ?? []) as unknown[], id, depth + 1) };
    });
  }
  return nodes(value, 0, 1);
}
export function categoryPath(tree: CategoryNode[], id: number): CategoryNode[] {
  for (const node of tree) { if (node.id === id) return [node]; const child = categoryPath(node.children, id); if (child.length) return [node, ...child]; } return [];
}
export function categoryScopeForPath(path: CategoryNode[]): CategoryScope {
  return { ...(path[0] ? { cid: path[0].id } : {}), ...(path[1] ? { sid: path[1].id } : {}), ...(path[2] ? { tid: path[2].id } : {}) };
}
export function categoryQuery(query: Record<string, unknown>): CategoryScope {
  return Object.fromEntries(['cid', 'sid', 'tid'].filter(key => query[key] !== undefined).map(key => [key, categoryId(query[key])])) as CategoryScope;
}
export function categoryListUrl(scope: CategoryScope): string {
  const query = Object.entries(scope).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${categoryId(value)}`).join('&');
  return `/pages/goods/list${query ? '?' + query : ''}`;
}
export function parseCategoryProducts(value: unknown): { list: CategoryProduct[]; count: number } {
  const row = record(value);
  if (!Array.isArray(row.list) || row.list.length > 100 || !Number.isSafeInteger(row.count) || Number(row.count) < 0) throw Error('分类商品分页响应无效');
  const seen = new Set<number>();
  const list = row.list.map(item => {
    const p = record(item), id = categoryId(p.id);
    if (seen.has(id)) throw Error('分类商品标识重复'); seen.add(id);
    const numeric = (snake: string, camel: string, fallback = 0): number => { const value = p[snake] ?? p[camel] ?? fallback; if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 2147483647) throw Error('分类商品数值无效'); return Number(value); };
    const money = (value: unknown): string => { if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value) || BigInt(value.split('.')[0]) > 9999999999n) throw Error('分类商品报价无效'); const [a, b = ''] = value.split('.'); return `${a}.${b.padEnd(2, '0')}`; };
    const spec = numeric('spec_type', 'specType'), presale = numeric('is_presale_product', 'isPresaleProduct'), cart = numeric('cart_button', 'cartButton', 1);
    if (spec > 1 || presale > 1 || cart > 1) throw Error('分类商品购买标记无效');
    return { id, store_name: text(p.store_name ?? p.storeName, 512), image: categoryImage(p.image), price: money(p.price),
      ot_price: money(p.ot_price ?? p.otPrice ?? '0'), vip_price: p.vip_price === '' || p.vipPrice === '' ? '' : money(p.vip_price ?? p.vipPrice ?? '0'), sales: numeric('sales', 'sales'), stock: numeric('stock', 'stock'),
      is_vip: numeric('is_vip', 'isVip'), is_vip_product: numeric('is_vip_product', 'isVipProduct'), cart_button: cart, unit_name: typeof (p.unit_name ?? p.unitName) === 'string' ? text(p.unit_name ?? p.unitName, 64) : '', star: typeof p.star === 'string' ? p.star : '',
      brand_name: typeof (p.brand_name ?? p.brandName) === 'string' ? text(p.brand_name ?? p.brandName, 256) : '', spec_type: spec as 0 | 1, is_presale_product: presale as 0 | 1, cart_num: numeric('cart_num', 'cartNum') };
  });
  return { list, count: Number(row.count) };
}
