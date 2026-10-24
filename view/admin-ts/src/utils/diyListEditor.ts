import { DIY_LIST_DEFAULTS } from './diyListDefaults';
import { navigationDocument, navigationRecord, navArray, navRead, navSet, navTimestamp, NAVIGATION_BODY_NAMES } from './diyNavigationEditor';

export type ListRecord = Record<string, unknown>;
export const LIST_NAMES = ['goodList', 'articleList'] as const;
export type ListKind = typeof LIST_NAMES[number];
export type ListSelectionKind = 'product' | 'brand' | 'category' | 'label' | 'article_category';
export interface ListSelection { kind: ListSelectionKind; id: number; name: string }
export const listLabels: Record<ListKind, string> = { goodList: '商品列表', articleList: '文章列表' };
export const listKind = (value: unknown): ListKind | null => LIST_NAMES.includes(value as ListKind) ? value as ListKind : null;
export const listDocument = navigationDocument, listRecord = navigationRecord, listRead = navRead;
export const listRawNumber = (value: unknown, fallback = 0): number => { const n = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN; return Number.isFinite(n) && n >= 0 ? n : fallback; };
export const listOrdinal = (value: unknown, fallback = 0, max = 5): number => { const n = Number(value); return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback; };
export function listEntries(value: unknown[]) { return value.flatMap((row, index) => { const kind = listKind(listRecord(row)?.name); return kind ? [{ index, kind }] : []; }).sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index); }
export function newListBlock(kind: ListKind, timestamp: number): ListRecord { const value: ListRecord = structuredClone(DIY_LIST_DEFAULTS[kind]); value.timestamp = timestamp; return value; }
export function addListBlock(value: unknown[], kind: ListKind) {
  if (!listKind(kind)) throw Error('列表组件类型无效');
  const copy = structuredClone(value), ordinary = copy.filter(row => NAVIGATION_BODY_NAMES.includes(listRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]));
  const maximum = Math.max(0, ...ordinary.map(navTimestamp)), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isSafeInteger(timestamp) || timestamp <= maximum) throw Error('排序空间不足，请先明确调整排序');
  const footer = copy.findIndex(row => String(listRecord(row)?.name).toLowerCase() === 'pagefoot'), selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newListBlock(kind, timestamp)); return { value: copy, selected };
}
export function moveListBlock(value: unknown[], selected: number, direction: -1 | 1) {
  if (!listKind(listRecord(value[selected])?.name)) throw Error('未选择列表组件');
  const indices = value.map((_, index) => index).filter(index => NAVIGATION_BODY_NAMES.includes(listRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number])).sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(listRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || [aTime, bTime].includes(Number.MAX_SAFE_INTEGER)) throw Error('相同或异常排序值需要先明确调整');
  const copy = structuredClone(value), a = listRecord(copy[selected])!, b = listRecord(copy[target])!;
  [a.timestamp, b.timestamp] = [b.timestamp, a.timestamp]; [copy[selected], copy[target]] = [copy[target], copy[selected]]; return { value: copy, selected: target };
}
export const listScope = (block: unknown): ListSelectionKind => ({ 1: 'product', 2: 'brand', 3: 'category', 4: 'label' } as Record<number, ListSelectionKind>)[Number(listRead(block, ['typeConfig', 'activeValue']))] ?? 'product';
export const selectionPath = (kind: ListSelectionKind): string[] => ({ product: ['goodsList', 'ids'], brand: ['brandList', 'brandVal'], category: ['classList', 'classVal'], label: ['goodsLabel', 'activeValue'], article_category: ['selectConfig', 'activeValue'] })[kind];
export const listSelections = (block: unknown, kind: ListSelectionKind): unknown[] => navArray(block, selectionPath(kind));
export function listIdentity(raw: unknown, zero = false): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string' || !(zero ? /^(?:0|[1-9]\d{0,9})$/u : /^[1-9]\d{0,9}$/u).test(String(raw))) return null;
  const id = Number(raw); return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}
function assertSelection(block: ListRecord, choice: ListSelection) {
  if (!choice || listIdentity(choice.id, choice.kind === 'article_category') === null || typeof choice.name !== 'string' || !choice.name || choice.name.length > 512 || /[\u0000-\u001f\u007f]/u.test(choice.name)) throw Error('目录选择身份无效');
  if (block.name === 'goodList' ? choice.kind !== listScope(block) : block.name !== 'articleList' || choice.kind !== 'article_category') throw Error('目录选择与当前列表范围不匹配');
}
/** Only a real directory choice creates IDs. Stored PHP preview material is not
 * promoted into active identities on mount, scope changes or unrelated edits. */
export function chooseListSelection(block: ListRecord, choice: ListSelection) {
  assertSelection(block, choice);
  if (choice.kind === 'article_category') { navSet(block, selectionPath(choice.kind), choice.id); return; }
  const raw = listRead(block, selectionPath(choice.kind));
  if (raw !== undefined && !Array.isArray(raw)) throw Error('已存范围结构异常，可明确清空当前范围后重新选择');
  const ids = structuredClone(Array.isArray(raw) ? raw : []);
  if (ids.some(id => listIdentity(id) === null)) throw Error('已存范围含无效编号，请先移除该项或明确清空');
  if (ids.some(id => Number(id) === choice.id)) return;
  if (ids.length >= 100) throw Error('普通新增最多选择100项；全部导入项仍可查看、移除和排序');
  ids.push(choice.id); navSet(block, selectionPath(choice.kind), ids);
  if (choice.kind === 'product') {
    const rawRows = listRead(block, ['goodsList', 'list']);
    if (rawRows !== undefined && !Array.isArray(rawRows)) throw Error('已存商品资料结构异常，不能隐式替换');
    const rows = structuredClone(Array.isArray(rawRows) ? rawRows : []);
    if (!rows.some(row => listIdentity(listRecord(row)?.id) === choice.id)) rows.push({ id: choice.id, store_name: choice.name });
    navSet(block, ['goodsList', 'list'], rows);
  } else if (choice.kind === 'label') {
    const rawRows = listRead(block, ['goodsLabel', 'list']);
    if (rawRows !== undefined && !Array.isArray(rawRows)) throw Error('已存标签资料结构异常，不能隐式替换');
    const rows = structuredClone(Array.isArray(rawRows) ? rawRows : []);
    if (!rows.some(row => listIdentity(listRecord(row)?.id) === choice.id)) rows.push({ id: choice.id, label_name: choice.name });
    navSet(block, ['goodsLabel', 'list'], rows);
  }
}
export function removeListSelection(block: ListRecord, kind: ListSelectionKind, index: number) {
  const ids = structuredClone(listSelections(block, kind)); if (!Number.isInteger(index) || index < 0 || index >= ids.length) throw Error('范围项已变化');
  const [removed] = ids.splice(index, 1); navSet(block, selectionPath(kind), ids);
  const material = kind === 'product' ? ['goodsList', 'list'] : kind === 'label' ? ['goodsLabel', 'list'] : null;
  if (material && listIdentity(removed) !== null && !ids.some(id => Number(id) === Number(removed))) {
    const rows = structuredClone(navArray(block, material)), at = rows.findIndex(row => listIdentity(listRecord(row)?.id) === Number(removed));
    if (at >= 0) { rows.splice(at, 1); navSet(block, material, rows); }
  }
}
export function moveListSelection(block: ListRecord, kind: ListSelectionKind, index: number, direction: -1 | 1) {
  const ids = structuredClone(listSelections(block, kind)), to = index + direction;
  if (!Number.isInteger(index) || index < 0 || to < 0 || to >= ids.length) throw Error('范围排序位置无效');
  const a = listIdentity(ids[index]), b = listIdentity(ids[to]); [ids[index], ids[to]] = [ids[to], ids[index]]; navSet(block, selectionPath(kind), ids);
  const material = kind === 'product' ? ['goodsList', 'list'] : kind === 'label' ? ['goodsLabel', 'list'] : null;
  if (material && a !== null && b !== null) {
    const rows = structuredClone(navArray(block, material)), from = rows.findIndex(row => listIdentity(listRecord(row)?.id) === a), target = rows.findIndex(row => listIdentity(listRecord(row)?.id) === b);
    if (from >= 0 && target >= 0) { [rows[from], rows[target]] = [rows[target], rows[from]]; navSet(block, material, rows); }
  }
}
export function clearListSelection(block: ListRecord, kind: ListSelectionKind) { navSet(block, selectionPath(kind), kind === 'article_category' ? '' : []); }
export function listStoredName(block: unknown, kind: ListSelectionKind, raw: unknown): string {
  if (kind === 'article_category' && (raw === '' || raw === undefined || raw === null)) return '尚未选择文章分类';
  const id = listIdentity(raw, kind === 'article_category'); if (id === null) return `无效导入项：${String(raw).slice(0, 80)}`;
  const material = kind === 'product' ? ['goodsList', 'list'] : kind === 'label' ? ['goodsLabel', 'list'] : null;
  const row = material ? navArray(block, material).map(listRecord).find(row => listIdentity(row?.id) === id) : null;
  const text = row?.[kind === 'product' ? 'store_name' : 'label_name']; return typeof text === 'string' && text ? text : `${kind === 'article_category' && id === 0 ? '热门文章' : '已存目标'} #${id}`;
}
export function listPixelStyle(style: Record<string, string | number>) { return Object.fromEntries(Object.entries(style).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/(-?\d+(?:\.\d+)?)rpx/gu, (_, n: string) => `${Number(n) / 2}px`) : value])); }
export function listActionLabel(style: number, action: number): string { return style === 0 || style === 4 ? action === 0 ? '购买' : action === 1 ? '＋' : '购物车' : action === 0 ? '＋' : '购物车'; }
