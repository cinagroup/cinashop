import request, { getData } from '@/utils/request';
import { parseFabLinkTargets } from './fabSettings';
import type { ListSelection, ListSelectionKind } from '@/utils/diyListEditor';
import { listIdentity } from '@/utils/diyListEditor';
import { apiDiyAuthorTargets, type DiyAuthorTarget } from './diyAuthorOptions';
import { parseCategoryProducts } from '../../../common/categoryCatalog';
import { listSafeColor, type GoodsListParams } from '@/utils/diyListProjection';
import { presentationPreviewUrl } from '@/utils/diyPresentationEditor';

export interface ListCatalogQuery { page: number; limit: number; search?: string; parent_id?: number }
export interface ListCatalogEntry { id: number; name: string; parent_id?: number; has_children?: boolean; selectable: boolean; selection: ListSelection | null; issues: string[]; image_preview?: string; price?: string }
export interface ListCatalogPage { list: ListCatalogEntry[]; count: number; page: number; limit: number; issues: string[] }
const record = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('列表目录格式无效'); return value as Record<string, unknown>; };
const text = (value: unknown, maximum = 512): string => { if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('列表文字无效'); return value; };
function queryFor(kind: ListSelectionKind, query: ListCatalogQuery) {
  if (!Number.isSafeInteger(query.page) || query.page < 1 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 || (query.page - 1) * query.limit > 10000) throw Error('目录分页无效');
  const search = text(query.search ?? '', 8192).trim(); if ([...search].length > 100) throw Error('目录搜索不能超过100字');
  const parent = query.parent_id ?? 0; if (listIdentity(parent, true) === null || !['product', 'brand', 'category'].includes(kind) && parent !== 0) throw Error('目录父级无效');
  return { page: query.page, limit: query.limit, ...(search ? { search } : {}), ...(['product', 'brand', 'category'].includes(kind) ? { parent_id: parent } : {}) };
}
export async function apiDiyListCatalog(kind: ListSelectionKind, query: ListCatalogQuery, signal?: AbortSignal): Promise<ListCatalogPage> {
  const expected = queryFor(kind, query);
  if (kind === 'category') {
    const result = await apiDiyAuthorTargets({ ...expected, kind: 'product_category' }, true, signal);
    return { ...result, list: result.list.map(row => { const item = row as DiyAuthorTarget; return { ...row, selection: item.selection ? { kind: 'category' as const, id: item.selection.id, name: item.selection.name } : null }; }) };
  }
  const raw = await getData(kind === 'product' ? request.get('/dise/author-options/list-products', { params: expected, signal })
    : kind === 'brand' ? request.get('/dise/author-options/list-brands', { params: expected, signal })
      : kind === 'label' ? request.get('/dise/author-options/list-labels', { params: expected, signal })
        : request.get('/dise/author-options/list-article-categories', { params: expected, signal }));
  const result = record(raw);
  if (!Array.isArray(result.list) || result.list.length > expected.limit || !Number.isSafeInteger(result.count) || Number(result.count) < 0 || result.list.length > Number(result.count) || result.page !== expected.page || result.limit !== expected.limit || !Array.isArray(result.issues)) throw Error('目录分页身份不匹配');
  const issues = result.issues.map(item => text(item, 4096));
  if (kind === 'product') {
    const parsed = parseFabLinkTargets(raw, { ...expected, kind: 'product' });
    return { ...parsed, list: parsed.list.map(row => {
      const selection = record(row).selection;
      if (!row.selectable) { if (selection !== null) throw Error('不可选商品包含身份'); return { ...row, selection: null }; }
      const choice = record(selection); if (listIdentity(row.id) === null || choice.kind !== 'product' || choice.id !== row.id || choice.name !== row.name) throw Error('商品身份不匹配');
      return { ...row, selection: { kind: 'product' as const, id: row.id, name: row.name } };
    }) };
  }
  const seen = new Set<number>();
  const list = result.list.map(value => {
    const row = record(value), selection = record(row.selection), id = listIdentity(row.id, kind === 'article_category'), name = text(row.name);
    if (id === null || seen.has(id) || !name || selection.kind !== kind || selection.id !== id || selection.name !== name) throw Error('目录目标身份不匹配'); seen.add(id);
    if (kind === 'brand' && (row.parent_id !== (expected.parent_id ?? 0) || typeof row.has_children !== 'boolean')) throw Error('品牌归属不匹配');
    if (kind === 'article_category' && row.aggregate !== (id === 0)) throw Error('文章聚合身份不匹配');
    return { id, name, selectable: true, selection: { kind, id, name }, issues: [], ...(kind === 'brand' ? { parent_id: row.parent_id as number, has_children: row.has_children as boolean } : {}) };
  });
  return { list, count: result.count as number, page: expected.page, limit: expected.limit, issues };
}

export interface ListPreviewProduct { id: number; title: string; image: string; frameImage: string; price: string; offer: { label: string; price: string } | null; sales: number; unit: string; star: string; brand: string; labels: Array<{ id: number; name: string; color: string; background: string; border: string; icon: string }> }
export interface ListPreviewArticle { id: number; title: string; image: string; time: string; visit: string; likes: number }
/** Public reads are anonymous and never share the Admin bearer or cookies.
 * The author never calls detail, visit, like, SKU or cart mutation endpoints. */
async function anonymousListRead(path: string, params: Record<string, string | number>, signal: AbortSignal) {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  const response = await fetch(path + '?' + query, { method: 'GET', credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw Error('公开列表读取失败'); const result = record(await response.json());
  if (result.status !== 200) throw Error(typeof result.msg === 'string' ? text(result.msg) : '公开列表读取失败'); return result.data;
}
export function parseListPreviewProducts(raw: unknown, limit: number): ListPreviewProduct[] {
  const data = record(raw), parsed = parseCategoryProducts(raw);
  if (parsed.list.length > limit) throw Error('商品返回超过请求数量');
  return parsed.list.map((product, index) => {
    const row = record((data.list as unknown[])[index]);
    if (product.star !== '' && (!/^\d(?:\.\d{1,2})?$/u.test(product.star) || Number(product.star) > 5)) throw Error('商品评分无效');
    const frame = row.activity_frame === undefined || row.activity_frame === null || Array.isArray(row.activity_frame) && !row.activity_frame.length ? {} : record(row.activity_frame);
    const offer = Number(product.vip_price) > 0 && row.price_type === 'level' ? { label: '等级参考价', price: product.vip_price }
      : Number(product.vip_price) > 0 && row.price_type === 'member' && product.is_vip === 1 ? { label: 'SVIP参考价', price: product.vip_price } : null;
    const labels = row.store_label ?? []; if (!Array.isArray(labels) || labels.length > 100) throw Error('商品标签格式无效'); const seen = new Set<number>();
    return { id: product.id, title: product.store_name, image: presentationPreviewUrl(product.image), frameImage: presentationPreviewUrl(frame.image), price: product.price, offer, sales: product.sales, unit: product.unit_name, star: product.star, brand: product.brand_name,
      labels: labels.map(value => { const label = record(value), id = listIdentity(label.id); if (id === null || seen.has(id)) throw Error('商品标签身份无效'); seen.add(id); return { id, name: text(label.label_name, 1024), color: listSafeColor(label.color, '#666666'), background: listSafeColor(label.bg_color, 'transparent'), border: listSafeColor(label.border_color, 'transparent'), icon: presentationPreviewUrl(label.icon) }; }) };
  });
}
export function parseListPreviewArticles(raw: unknown, limit: number): ListPreviewArticle[] {
  if (!Array.isArray(raw) || raw.length > limit) throw Error('文章列表格式无效'); const seen = new Set<number>();
  return raw.map(value => {
    const row = record(value), id = listIdentity(row.id), visit = text(row.visit, 20), time = text(row.add_time, 16);
    if (id === null || seen.has(id) || !/^\d{1,20}$/u.test(visit) || !/^\d{4}-\d\d-\d\d \d\d:\d\d$/u.test(time) || !Number.isSafeInteger(row.likes) || Number(row.likes) < 0 || Number(row.likes) > 2147483647 || !Array.isArray(row.image_input) || row.image_input.length > 20) throw Error('文章资料不完整');
    seen.add(id); text(row.synopsis, 4096); text(row.url, 8192); row.image_input.forEach(item => text(item, 8192));
    return { id, title: text(row.title), image: presentationPreviewUrl(row.image_input[0]), time, visit, likes: row.likes as number };
  });
}
export async function apiDiyListProductPreview(query: GoodsListParams, signal: AbortSignal) { return parseListPreviewProducts(await anonymousListRead('/api/products', query as Record<string, string | number>, signal), query.limit ?? 100); }
export async function apiDiyListArticlePreview(cid: number, limit: number, signal: AbortSignal) {
  if (listIdentity(cid, true) === null || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('文章预览范围无效');
  return parseListPreviewArticles(await anonymousListRead(`/api/article/list/${cid}`, { page: 1, limit }, signal), limit);
}
