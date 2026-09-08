/** Read-only selection and group availability, never a quote or seat reservation. */
import { seckillImage } from './seckillPurchase';
export interface CombinationSku { unique: string; suk: string; catalog_price: string; ot_price: string; image: string; stock: number; max_quantity: number }
export interface CombinationGroup {
  id: number; combination_id: number; required_people: number; active_people: number; reserved_people: number;
  available_places: number; already_joined: boolean; has_pending_order: boolean; stop_time: string | null;
}
export interface CombinationSelection {
  selection_only: true; type: 3; combination_id: number; product_id: number; title: string; image: string;
  people: number; once_limit: number; total_limit: number; start_time: string | null; stop_time: string | null;
  date_window: 'future' | 'active' | 'ended'; skus: CombinationSku[]; groups: CombinationGroup[]; requested_group: CombinationGroup | null;
}
export interface CombinationItem { id: number; product_id: number; title: string; image: string; price: number; ot_price: number; people: number }
const invalid = (): never => { throw new Error('拼团数据格式错误，请刷新或稍后重试'); };
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function int(value: unknown, min = 0, max = 2_147_483_647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function flag(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function list(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid(); }
function date(value: unknown): string | null {
  if (value === null) return null;
  const raw = text(value);
  return /^\d{4}-\d{2}-\d{2}T.*Z$/.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : invalid();
}
function key(value: unknown): string {
  const raw = text(value); return raw && raw.length <= 8 && !/[\s\u0000-\u001f\u007f]/u.test(raw) ? raw : invalid();
}
function money(value: unknown): string { const raw = text(value); return /^\d{1,10}\.\d{2}$/.test(raw) ? raw : invalid(); }
export function combinationId(value: unknown): number {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? int(Number(value), 1) : invalid();
}
export function parseCombinationList(value: unknown): CombinationItem[] {
  const seen = new Set<number>();
  return list(value, 50).map(value => {
    const row = record(value), id = int(row.id, 1);
    if (seen.has(id)) return invalid(); seen.add(id);
    const price = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();
    return { id, product_id: int(row.product_id, 1), title: text(row.title), image: seckillImage(row.image),
      people: int(row.people, 1), price: price(row.price), ot_price: price(row.ot_price) };
  });
}
export function parseCombinationSelection(value: unknown, expectedId: number, requestedPinkId = 0): CombinationSelection {
  const row = record(value);
  int(expectedId, 1); int(requestedPinkId);
  if (row.selection_only !== true || row.type !== 3 || row.combination_id !== expectedId) return invalid();
  const once_limit = int(row.once_limit, 1), total_limit = int(row.total_limit, 1);
  const uniques = new Map<string, string>(), bases = new Map<string, string>(), labels = new Set<string>();
  const skus = list(row.skus, 500).map(value => {
    const sku = record(value), unique = key(sku.unique), base = key(sku.base_unique), suk = text(sku.suk);
    if (suk !== suk.trim() || uniques.has(unique) || bases.has(base) || labels.has(suk)) return invalid();
    uniques.set(unique, suk); bases.set(base, suk); labels.add(suk);
    const stock = int(sku.stock);
    return { unique, suk, stock, max_quantity: int(sku.max_quantity, 0, Math.min(stock, once_limit, total_limit, 32767)),
      catalog_price: money(sku.catalog_price), ot_price: money(sku.ot_price), image: seckillImage(sku.image) };
  });
  for (const [unique, suk] of uniques) if (bases.has(unique) && bases.get(unique) !== suk) return invalid();
  if (skus.length > 1 && labels.has('')) return invalid();
  const start_time = date(row.start_time), stop_time = date(row.stop_time), state = text(row.date_window);
  if (!['future', 'active', 'ended'].includes(state) || start_time && stop_time && Date.parse(start_time) > Date.parse(stop_time)) return invalid();
  const group = (value: unknown): CombinationGroup => {
    const g = record(value), required_people = int(g.required_people, 1), active_people = int(g.active_people), reserved_people = int(g.reserved_people);
    if (g.combination_id !== expectedId || g.available_places !== Math.max(0, required_people - active_people - reserved_people)) return invalid();
    return { id: int(g.id, 1), combination_id: expectedId, required_people, active_people, reserved_people,
      available_places: int(g.available_places), already_joined: flag(g.already_joined), has_pending_order: flag(g.has_pending_order), stop_time: date(g.stop_time) };
  };
  const groups = list(row.groups, 5).map(group), ids = new Set(groups.map(g => g.id));
  if (ids.size !== groups.length) return invalid();
  const requested_group = row.requested_group === null ? null : group(row.requested_group);
  if (requestedPinkId ? requested_group?.id !== requestedPinkId : requested_group !== null) return invalid();
  const duplicate = groups.find(g => g.id === requested_group?.id);
  if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(requested_group)) return invalid();
  return { selection_only: true, type: 3, combination_id: expectedId, product_id: int(row.product_id, 1), title: text(row.title),
    image: seckillImage(row.image), people: int(row.people, 1), once_limit, total_limit, start_time, stop_time,
    date_window: state as CombinationSelection['date_window'], skus, groups, requested_group };
}
export function combinationOpen(detail: CombinationSelection, now = Date.now()): boolean {
  return detail.date_window === 'active' && (!detail.start_time || now >= Date.parse(detail.start_time)) && (!detail.stop_time || now <= Date.parse(detail.stop_time));
}
export function combinationGroup(detail: CombinationSelection, id: number): CombinationGroup | undefined {
  return detail.requested_group?.id === id ? detail.requested_group : detail.groups.find(group => group.id === id);
}
export function combinationGroupOpen(group: CombinationGroup, now = Date.now()): boolean {
  return group.available_places > 0 && !group.already_joined && !group.has_pending_order && (!group.stop_time || now < Date.parse(group.stop_time));
}
export function combinationCartInput(detail: CombinationSelection, unique: string, quantity: number, pinkId = 0, now = Date.now()) {
  if (!combinationOpen(detail, now)) throw new Error('当前拼团活动不可购买，请刷新活动');
  int(pinkId);
  if (pinkId) { const group = combinationGroup(detail, pinkId); if (!group || !combinationGroupOpen(group, now)) throw new Error('所选团已不可参加，请刷新并重新确认'); }
  const sku = detail.skus.find(sku => sku.unique === unique);
  if (!sku || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > sku.max_quantity) throw new Error('请选择有效活动规格和购买数量');
  return { productId: detail.product_id, activityId: detail.combination_id, type: 3 as const, unique: sku.unique, cartNum: quantity, new: 1 as const };
}
export function combinationCheckoutQuery(cartId: number, activityId: number, pinkId = 0) {
  int(cartId, 1); int(activityId, 1); int(pinkId);
  return { mode: 'buy', cartId: String(cartId), type: '3', combinationId: String(activityId), ...(pinkId ? { pinkId: String(pinkId) } : {}) };
}
