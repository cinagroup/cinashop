import { DIY_PROMOTION_DEFAULTS } from './diyPromotionDefaults';
import { NAVIGATION_BODY_NAMES, navigationDocument, navigationRecord, navRead, navSet, navTimestamp } from './diyNavigationEditor';
import { canonicalPresentationReference, presentationPreviewForReference, presentationPreviewUrl } from './diyPresentationEditor';

export const PROMOTION_NAMES = ['promotionList'] as const;
export type PromotionKind = typeof PROMOTION_NAMES[number];
export type PromotionRecord = Record<string, unknown>;
export type PromotionSelectionKind = 'product' | 'brand' | 'category' | 'label';
export interface PromotionSelection { kind: PromotionSelectionKind; id: number; name: string }
export const promotionLabels: Record<PromotionKind, string> = { promotionList: '商品选项卡' };
export const promotionKind = (value: unknown): PromotionKind | null => value === 'promotionList' ? 'promotionList' : null;
export const promotionRecord = navigationRecord;
export const promotionDocument = navigationDocument;
export const promotionRead = navRead;

export function promotionEntries(value: unknown[]) {
  return value.flatMap((row, index) => promotionKind(promotionRecord(row)?.name) ? [{ index, kind: 'promotionList' as const }] : [])
    .sort((a, b) => navTimestamp(value[a.index]) - navTimestamp(value[b.index]) || a.index - b.index);
}

/** Defaults belong exclusively to explicit creation, never imports. */
export function newPromotionBlock(timestamp: number): PromotionRecord {
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > Number.MAX_SAFE_INTEGER) throw Error('组件排序值无效');
  const block: PromotionRecord = structuredClone(DIY_PROMOTION_DEFAULTS);
  block.timestamp = timestamp;
  return block;
}

export function addPromotionBlock(value: unknown[]): { value: unknown[]; selected: number } {
  const copy = structuredClone(value);
  const times = copy.filter(row => NAVIGATION_BODY_NAMES.includes(promotionRecord(row)?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .map(row => Number(promotionRecord(row)?.timestamp)).filter(Number.isFinite);
  const maximum = Math.max(0, ...times), timestamp = maximum + Math.max(1, Math.abs(maximum) * Number.EPSILON * 2);
  if (!Number.isFinite(timestamp) || timestamp <= maximum || timestamp > Number.MAX_SAFE_INTEGER) throw Error('排序空间不足，请先在装修 JSON 中明确调整');
  const footer = copy.findIndex(row => String(promotionRecord(row)?.name).toLowerCase() === 'pagefoot');
  const selected = footer < 0 ? copy.length : footer;
  copy.splice(selected, 0, newPromotionBlock(timestamp));
  promotionDocument(JSON.stringify(copy));
  return { value: copy, selected };
}

export function movePromotionBlock(value: unknown[], selected: number, direction: number): { value: unknown[]; selected: number } {
  if (!promotionKind(promotionRecord(value[selected])?.name) || ![-1, 1].includes(direction)) throw Error('未选择商品选项卡或移动方向无效');
  const indices = value.map((_, index) => index)
    .filter(index => NAVIGATION_BODY_NAMES.includes(promotionRecord(value[index])?.name as typeof NAVIGATION_BODY_NAMES[number]))
    .sort((a, b) => navTimestamp(value[a]) - navTimestamp(value[b]) || a - b);
  const target = indices[indices.indexOf(selected) + direction];
  if (target === undefined || ['homeComb', 'headerSerch', 'tabNav', 'pageFoot'].includes(String(promotionRecord(value[target])?.name))) throw Error('不能越过头部或底部导航');
  const aTime = navTimestamp(value[selected]), bTime = navTimestamp(value[target]);
  if (aTime === bTime || aTime === Number.MAX_SAFE_INTEGER || bTime === Number.MAX_SAFE_INTEGER) throw Error('相同或异常排序值需要先在装修 JSON 中明确修复');
  const copy = structuredClone(value), a = promotionRecord(copy[selected])!, b = promotionRecord(copy[target])!;
  const hadA = Object.hasOwn(a, 'timestamp'), hadB = Object.hasOwn(b, 'timestamp'), rawA = a.timestamp, rawB = b.timestamp;
  if (hadB) a.timestamp = rawB; else delete a.timestamp;
  if (hadA) b.timestamp = rawA; else delete b.timestamp;
  [copy[selected], copy[target]] = [copy[target], copy[selected]];
  return { value: copy, selected: target };
}

export function removePromotionBlock(value: unknown[], selected: number): { value: unknown[]; selected: number } {
  if (!promotionKind(promotionRecord(value[selected])?.name)) throw Error('未选择商品选项卡');
  const copy = structuredClone(value);
  copy.splice(selected, 1);
  return { value: copy, selected: promotionEntries(copy)[0]?.index ?? -1 };
}

/** Pure display conversion; numerically equal typed events retain the raw spelling. */
export function promotionNumber(value: unknown, fallback = 0, maximum = Number.MAX_VALUE): number {
  const parsed = typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(maximum, parsed) : fallback;
}

function metadataCopy(value: unknown): unknown {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }], seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++nodes > 100_000 || next.depth > 64) throw Error('元数据超过 100000 节点或 64 层完整编辑容量');
    const item = next.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) continue;
    if (!item || typeof item !== 'object' || seen.has(item)) throw Error('元数据必须为完整的 JSON 值');
    seen.add(item);
    const proto = Object.getPrototypeOf(item), array = Array.isArray(item);
    if (proto !== Object.prototype && proto !== null && !(array && proto === Array.prototype)) throw Error('元数据必须为普通 JSON 对象');
    if (Object.getOwnPropertySymbols(item).length || Object.getOwnPropertyNames(item).length !== Object.keys(item).length + (array ? 1 : 0)) throw Error('元数据含不支持的字段');
    if (array && (Object.keys(item).length !== item.length || Object.keys(item).some(key => !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length))) throw Error('元数据列表不能含空缺或额外字段');
    for (const key of Object.keys(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('元数据含不安全字段');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, 'value')) throw Error('元数据不能含动态字段');
      pending.push({ value: descriptor.value, depth: next.depth + 1 });
    }
  }
  return structuredClone(value);
}

/** Whole-candidate validation precedes the one top-level commit. */
export function promotionSet(block: PromotionRecord, path: Array<string | number>, value: unknown): boolean {
  if (!promotionKind(block.name)) throw Error('未选择商品选项卡');
  const next = metadataCopy(value), candidate = metadataCopy(block) as PromotionRecord;
  navSet(candidate, path, next);
  promotionDocument(JSON.stringify([candidate]));
  if (JSON.stringify(candidate) === JSON.stringify(block)) return false;
  // Set only after both the value and all imported parent structures pass.
  navSet(block, path, next);
  return true;
}

export function setPromotionNumber(block: PromotionRecord, path: Array<string | number>, value: unknown, minimum = 0, maximum = Number.MAX_VALUE): boolean {
  if (!promotionKind(block.name)) throw Error('未选择商品选项卡');
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum || value < minimum || value > maximum) throw Error('请输入范围内的有效数字');
  const raw = navRead(block, path), current = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(current) && current === value ? false : promotionSet(block, path, value);
}

/** Include hidden, malformed, duplicate and overflow tabs without repairing any. */
export function promotionTabs(block: unknown): unknown[] {
  const value = promotionKind(promotionRecord(block)?.name) ? navRead(block, ['tabConfig', 'list']) : undefined;
  return Array.isArray(value) ? value : [];
}

export function newPromotionTab(): PromotionRecord {
  return structuredClone(DIY_PROMOTION_DEFAULTS.tabConfig.list[0]!);
}

function editableTabs(block: PromotionRecord): unknown[] {
  if (!promotionKind(block.name)) throw Error('未选择商品选项卡');
  const field = block.tabConfig;
  if (field !== undefined && !promotionRecord(field)) throw Error('选项卡结构异常，请在装修 JSON 中明确修复');
  const list = navRead(block, ['tabConfig', 'list']);
  if (list !== undefined && !Array.isArray(list)) throw Error('选项卡列表结构异常，请在装修 JSON 中明确修复');
  return Array.isArray(list) ? list : [];
}

function tabAt(block: PromotionRecord, index: number): PromotionRecord {
  const tabs = editableTabs(block), tab = tabs[index];
  if (!Number.isInteger(index) || index < 0 || index >= tabs.length || !promotionRecord(tab)) throw Error('选项卡索引或结构无效');
  return tab as PromotionRecord;
}

function editTabs(block: PromotionRecord, change: (candidate: PromotionRecord) => void): boolean {
  editableTabs(block);
  const candidate = metadataCopy(block) as PromotionRecord;
  change(candidate);
  promotionDocument(JSON.stringify([candidate]));
  if (JSON.stringify(candidate) === JSON.stringify(block)) return false;
  block.tabConfig = candidate.tabConfig;
  return true;
}

export function selectPromotionTab(block: PromotionRecord, index: number): boolean {
  tabAt(block, index);
  return setPromotionNumber(block, ['tabConfig', 'tabCur'], index);
}

/** PHP has no enforced tab count cap; the complete document budget is the author bound. */
export function addPromotionTab(block: PromotionRecord): number {
  const tabs = editableTabs(block);
  const index = tabs.length;
  editTabs(block, candidate => {
    const list = structuredClone(editableTabs(candidate)); list.push(newPromotionTab());
    navSet(candidate, ['tabConfig', 'list'], list); navSet(candidate, ['tabConfig', 'tabCur'], index);
  });
  return index;
}

export function removePromotionTab(block: PromotionRecord, index: number): number {
  const tabs = editableTabs(block);
  if (!Number.isInteger(index) || index < 0 || index >= tabs.length) throw Error('选项卡索引无效');
  const selected = Math.min(index, tabs.length - 2);
  editTabs(block, candidate => {
    const list = structuredClone(editableTabs(candidate)); list.splice(index, 1);
    navSet(candidate, ['tabConfig', 'list'], list); navSet(candidate, ['tabConfig', 'tabCur'], Math.max(0, selected));
  });
  return selected;
}

export function movePromotionTab(block: PromotionRecord, index: number, direction: number): number {
  const tabs = editableTabs(block), target = index + direction;
  if (!Number.isInteger(index) || ![-1, 1].includes(direction) || index < 0 || index >= tabs.length || target < 0 || target >= tabs.length) throw Error('选项卡索引或移动方向无效');
  editTabs(block, candidate => {
    const list = structuredClone(editableTabs(candidate)); [list[index], list[target]] = [list[target], list[index]];
    navSet(candidate, ['tabConfig', 'list'], list); navSet(candidate, ['tabConfig', 'tabCur'], target);
  });
  return target;
}

export function promotionScope(tab: unknown): PromotionSelectionKind | null {
  const raw = promotionRecord(tab)?.tabVal;
  const source = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw === undefined ? 0 : NaN;
  return ({ 0: 'category', 1: 'product', 2: 'brand', 3: 'category', 4: 'label' } as Record<number, PromotionSelectionKind>)[source] ?? null;
}

/** Choosing a source never clears its siblings or rewrites source0 on mount. */
export function setPromotionSource(block: PromotionRecord, index: number, source: number): boolean {
  tabAt(block, index);
  if (!Number.isInteger(source) || source < 0 || source > 4) throw Error('商品来源无效');
  return setPromotionNumber(block, ['tabConfig', 'list', index, 'tabVal'], source, 0, 4);
}

export function promotionIdentity(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string' || !/^[1-9]\d{0,9}$/u.test(String(raw))) return null;
  const id = Number(raw); return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}
export const promotionSelectionToken = (raw: unknown): unknown => promotionRecord(raw)?.id ?? promotionRecord(raw)?.value ?? raw;
export const promotionSelectionId = (raw: unknown): number | null => promotionIdentity(promotionSelectionToken(raw));

export function promotionSelectionPath(kind: PromotionSelectionKind): string[] {
  const paths = { product: ['goodsList', 'ids'], brand: ['brandConfig', 'brandVal'], category: ['selectConfig', 'activeValue'], label: ['goodsLabel', 'activeValue'] };
  const path = paths[kind]; if (!path) throw Error('商品来源无效'); return [...path];
}

/** Stored representations are read without deduplication or the public 100-ID cap. */
export function promotionSelections(tab: unknown, kind: PromotionSelectionKind): unknown[] {
  const value = navRead(tab, promotionSelectionPath(kind));
  const selected = kind === 'product' && (value === undefined || value === null) ? navRead(tab, ['goodsList', 'list']) : value;
  return Array.isArray(selected) ? selected : [];
}

function assertScope(tab: PromotionRecord, kind: PromotionSelectionKind) {
  promotionSelectionPath(kind);
  if (promotionScope(tab) !== kind) throw Error('目录选择与当前商品来源不匹配');
}

interface StoredSelection { ids: unknown[]; rows: unknown[] | null; fallback: boolean; path: string[]; material: string[] | null }
function storedSelection(tab: PromotionRecord, kind: PromotionSelectionKind): StoredSelection {
  assertScope(tab, kind);
  const path = promotionSelectionPath(kind), container = tab[path[0]!];
  if (container !== undefined && !promotionRecord(container)) throw Error('已存商品范围结构异常，请在装修 JSON 中明确修复');
  const material = kind === 'product' ? ['goodsList', 'list'] : kind === 'label' ? ['goodsLabel', 'list'] : null;
  const rawRows = material ? navRead(tab, material) : undefined;
  if (material && rawRows !== undefined && !Array.isArray(rawRows)) throw Error('已存商品或标签资料结构异常，不能隐式替换');
  const raw = navRead(tab, path), fallback = kind === 'product' && (raw === undefined || raw === null);
  if (!fallback && raw !== undefined && !Array.isArray(raw)) throw Error('已存商品范围不是数组，请明确清空或在装修 JSON 中修复');
  const rows = material ? structuredClone(Array.isArray(rawRows) ? rawRows : []) : null;
  const ids = structuredClone(fallback ? (rows ?? []).map(promotionSelectionToken) : Array.isArray(raw) ? raw : []);
  return { ids, rows, fallback, path, material };
}

function writeSelection(tab: PromotionRecord, state: StoredSelection) {
  if (state.fallback && state.ids.some(id => promotionIdentity(id) === null)) throw Error('商品资料中仍有无效编号，不能隐式生成 ids；请明确修复原 JSON');
  navSet(tab, state.path, state.ids);
  if (state.material && state.rows) navSet(tab, state.material, state.rows);
}

/** Match one material row per ID occurrence; unmatched/unknown metadata stays in place. */
function materialBindings(state: StoredSelection): Array<number | null> {
  const used = new Set<number>();
  return state.ids.map(raw => {
    const id = promotionSelectionId(raw);
    const at = id === null || !state.rows ? -1 : state.rows.findIndex((row, index) => !used.has(index) && promotionSelectionId(row) === id);
    if (at < 0) return null; used.add(at); return at;
  });
}

/** Narrow directory identity only: preview images/tickets/DTO objects cannot enter JSON. */
export function choosePromotionSelection(block: PromotionRecord, tabIndex: number, rawChoice: PromotionSelection): boolean {
  const choice = promotionRecord(metadataCopy(rawChoice));
  if (!choice || Object.keys(choice).some(key => !['kind', 'id', 'name'].includes(key)) || typeof choice.id !== 'number' || promotionIdentity(choice.id) === null || typeof choice.name !== 'string' || !choice.name || choice.name.length > 512 || /[\u0000-\u001f\u007f]/u.test(choice.name)) throw Error('目录选择必须是有效的窄身份，不能写入预览资料');
  const kind = choice.kind as PromotionSelectionKind;
  return editTabs(block, candidate => {
    const tab = tabAt(candidate, tabIndex), state = storedSelection(tab, kind);
    if (state.ids.some(id => promotionSelectionId(id) === null)) throw Error('已存范围含无效编号，请先移除该项或明确清空');
    if (state.ids.some(id => promotionSelectionId(id) === choice.id)) return;
    if (state.ids.length >= 100) throw Error('普通新增最多选择100项；全部导入项仍可查看、移除和排序');
    state.ids.push(choice.id);
    if (state.rows) state.rows.push({ id: choice.id, [kind === 'product' ? 'store_name' : 'label_name']: choice.name });
    writeSelection(tab, state);
  });
}

export function removePromotionSelection(block: PromotionRecord, tabIndex: number, kind: PromotionSelectionKind, index: number): number {
  let selected = -1;
  editTabs(block, candidate => {
    const tab = tabAt(candidate, tabIndex), state = storedSelection(tab, kind);
    if (!Number.isInteger(index) || index < 0 || index >= state.ids.length) throw Error('商品范围索引无效');
    const binding = state.fallback ? index : materialBindings(state)[index];
    state.ids.splice(index, 1);
    if (state.rows && binding !== null && binding !== undefined) state.rows.splice(binding, 1);
    selected = Math.min(index, state.ids.length - 1); writeSelection(tab, state);
  });
  return selected;
}

export function movePromotionSelection(block: PromotionRecord, tabIndex: number, kind: PromotionSelectionKind, index: number, direction: number): number {
  const target = index + direction;
  editTabs(block, candidate => {
    const tab = tabAt(candidate, tabIndex), state = storedSelection(tab, kind);
    if (!Number.isInteger(index) || ![-1, 1].includes(direction) || index < 0 || index >= state.ids.length || target < 0 || target >= state.ids.length) throw Error('商品范围索引或移动方向无效');
    const bindings = materialBindings(state);
    [state.ids[index], state.ids[target]] = [state.ids[target], state.ids[index]];
    if (state.rows) {
      if (state.fallback) [state.rows[index], state.rows[target]] = [state.rows[target], state.rows[index]];
      else {
        const from = bindings[index], to = bindings[target];
        // An unrelated edit must not reorder/repair other imported material.
        // Missing material is retained as missing, rather than synthesized.
        if (from !== null && from !== undefined && to !== null && to !== undefined) [state.rows[from], state.rows[to]] = [state.rows[to], state.rows[from]];
      }
    }
    writeSelection(tab, state);
  });
  return target;
}

/** Explicit clearing may repair this source's malformed arrays, never its parent or siblings. */
export function clearPromotionSelection(block: PromotionRecord, tabIndex: number, kind: PromotionSelectionKind): boolean {
  return editTabs(block, candidate => {
    const tab = tabAt(candidate, tabIndex); assertScope(tab, kind);
    const path = promotionSelectionPath(kind), container = tab[path[0]!];
    if (container !== undefined && !promotionRecord(container)) throw Error('商品范围父级结构异常，请在装修 JSON 中明确修复');
    navSet(tab, path, []);
    if (kind === 'product' || kind === 'label') navSet(tab, [path[0]!, 'list'], []);
  });
}

export function promotionStoredName(tab: unknown, kind: PromotionSelectionKind, raw: unknown): string {
  const id = promotionSelectionId(raw);
  if (id === null) return `无效导入项：${JSON.stringify(raw)?.slice(0, 80) ?? String(raw)}`;
  const material = kind === 'product' ? navRead(tab, ['goodsList', 'list']) : kind === 'label' ? navRead(tab, ['goodsLabel', 'list']) : null;
  const row = Array.isArray(material) ? material.map(promotionRecord).find(item => promotionSelectionId(item) === id) : null;
  const name = row?.[kind === 'product' ? 'store_name' : 'label_name'];
  return typeof name === 'string' && name ? name : `已存目标 #${id}`;
}

export function canonicalPromotionImage(raw: string): string {
  const value = canonicalPresentationReference(raw.trim());
  if (value.length > 4096 || value && (!/^(?:https:\/\/|\/(?!\/))/iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value))) throw Error('请选择有效的 HTTPS 或站内图片');
  return value;
}

export function setPromotionImage(block: PromotionRecord, tabIndex: number, raw: string): boolean {
  tabAt(block, tabIndex);
  return promotionSet(block, ['tabConfig', 'list', tabIndex, 'image'], canonicalPromotionImage(raw));
}

/** Only every exact tab image slot is canonicalized; product/label/unknown metadata stays exact. */
export function canonicalPromotionBlock(raw: PromotionRecord): PromotionRecord {
  const block = structuredClone(raw);
  for (const tab of promotionTabs(block)) {
    const row = promotionRecord(tab);
    if (row && typeof row.image === 'string') row.image = canonicalPresentationReference(row.image);
  }
  return block;
}

export function canonicalPromotionValue(raw: string): string {
  const value: unknown = JSON.parse(raw);
  if (value === null) throw Error('装修 value 不能为 null');
  if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
    const block = promotionRecord(value[index]);
    if (block && promotionKind(block.name)) value[index] = canonicalPromotionBlock(block);
  }
  return JSON.stringify(value);
}

/** Ephemeral capability: never persist it. Raw block + exact tab/index deny old-context reuse. */
export interface PromotionImageScope { block: string; tabIndex: number; tab: string; reference: string }
export interface PromotionImageCapability extends PromotionImageScope { preview: string }
export function promotionImageScope(block: PromotionRecord, tabIndex: number): PromotionImageScope {
  const tab = tabAt(block, tabIndex);
  return { block: JSON.stringify(block), tabIndex, tab: JSON.stringify(tab), reference: typeof tab.image === 'string' ? canonicalPresentationReference(tab.image) : '' };
}

export function promotionPreviewBlock(raw: PromotionRecord, capabilities: readonly PromotionImageCapability[] = []): PromotionRecord {
  const block = structuredClone(raw);
  promotionTabs(block).forEach((value, index) => {
    const tab = promotionRecord(value); if (!tab || typeof tab.image !== 'string') return;
    const scope = promotionImageScope(raw, index);
    const capability = capabilities.find(item => item.block === scope.block && item.tabIndex === index && item.tab === scope.tab && item.reference === scope.reference);
    const managed = /^\/api\/assets\//u.test(tab.image.trim());
    tab.image = presentationPreviewForReference(scope.reference, capability?.preview) || (managed ? '' : presentationPreviewUrl(tab.image));
  });
  return block;
}
