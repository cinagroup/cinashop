/** New Worker bargain states and exact participation identity; never a price quote. */
import { seckillImage } from './seckillPurchase';
export interface BargainSku { unique: string; suk: string; stock: number; max_quantity: number; catalog_price: string | null; image: string }
export interface BargainParticipation {
  id: number; status: number; state: 'cutting' | 'ready' | 'closed' | 'used'; original_price: string; minimum_price: string;
  cut_price: string; current_price: string; remaining_cut: string; catalog_price: string; activity_price_changed: boolean; progress_percent: number;
}
export interface BargainSelection {
  selection_only: true; type: 2; bargain_id: number; product_id: number; title: string; image: string; activity_price: string;
  minimum_price: string; people: number; start_time: string | null; stop_time: string | null; date_window: 'future' | 'active' | 'ended';
  can_select: boolean; participation: BargainParticipation | null; skus: BargainSku[];
}
export interface BargainItem { id: number; title: string; image: string; price: string; minimum: string }
export interface MyBargain { id: number; activityId: number; title: string; image: string; status: number; current: string; minimum: string; cut: string; progress: number; ready: boolean; amountsValid: boolean }
const invalid = (): never => { throw new Error('砍价数据格式错误，请刷新或稍后重试'); };
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid(); }
function int(value: unknown, min = 0, max = 2_147_483_647): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(); }
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function flag(value: unknown): boolean { return typeof value === 'boolean' ? value : invalid(); }
function array(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid(); }
function money(value: unknown): string { const raw = text(value); return /^\d{1,10}\.\d{2}$/.test(raw) ? raw : invalid(); }
function cents(value: string): number { const [whole, part] = value.split('.'); return Number(whole) * 100 + Number(part); }
function decimal(value: number): string { return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`; }
function date(value: unknown): string | null {
  if (value === null) return null;
  const raw = text(value); return /^\d{4}-\d{2}-\d{2}T.*Z$/.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : invalid();
}
function key(value: unknown): string { const raw = text(value); return raw && raw.length <= 8 && !/[\s\u0000-\u001f\u007f]/u.test(raw) ? raw : invalid(); }
export function bargainId(value: unknown): number { return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? int(Number(value), 1) : invalid(); }
export function bargainPage(value: number): number { return int(value, 1, 10_000); }
export function parseBargainList(value: unknown): BargainItem[] {
  const seen = new Set<number>();
  return array(value, 20).map(value => {
    const row = object(value), id = int(row.id, 1);
    if (seen.has(id)) return invalid(); seen.add(id);
    const numericMoney = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9_999_999_999.99 ? money(value.toFixed(2)) : invalid();
    return { id, title: text(row.title), image: seckillImage(row.image), price: numericMoney(row.price), minimum: numericMoney(row.min_price) };
  });
}
export function parseMyBargains(value: unknown, uid: number): MyBargain[] {
  int(uid, 1); const seen = new Set<number>();
  return array(value, 20).map(value => {
    const row = object(value), id = int(row.id, 1), status = int(row.status, 1, 4);
    if (row.uid !== uid || seen.has(id)) return invalid(); seen.add(id);
    const original = cents(money(row.bargain_price)), minimum = money(row.bargain_price_min), cut = money(row.price);
    const current = money(row.residue_price), capacity = original - cents(minimum), remaining = capacity - cents(cut);
    const amountsValid = capacity >= 0 && remaining >= 0 && cents(current) === original - cents(cut) && (status !== 3 || remaining === 0);
    return { id, activityId: int(row.bargain_id, 1), title: row.title === null ? '活动已不可用' : text(row.title), image: seckillImage(row.image),
      status, current, minimum, cut, amountsValid, progress: amountsValid ? capacity === 0 ? 100 : Math.floor(cents(cut) * 100 / capacity) : 0,
      ready: flag(row.pay_status) && amountsValid && [1, 3].includes(status) && remaining === 0 };
  });
}
export function parseBargainSelection(value: unknown, expectedId: number, requestedId = 0, authenticated = true): BargainSelection {
  const row = object(value); int(expectedId, 1); int(requestedId);
  if (row.selection_only !== true || row.type !== 2 || row.bargain_id !== expectedId) return invalid();
  const activity_price = money(row.activity_price), minimum_price = money(row.minimum_price);
  if (cents(minimum_price) > cents(activity_price)) return invalid();
  let participation: BargainParticipation | null = null;
  if (row.participation !== null) {
    if (!authenticated) return invalid();
    const p = object(row.participation), id = int(p.id, 1), status = int(p.status, 1, 4);
    if (requestedId && id !== requestedId) return invalid();
    const original_price = money(p.original_price), minimum = money(p.minimum_price), cut_price = money(p.cut_price);
    const original = cents(original_price), floor = cents(minimum), cut = cents(cut_price), remaining = original - floor - cut;
    if (floor > original || remaining < 0 || status === 3 && remaining !== 0) return invalid();
    const state = status === 4 ? 'used' : status === 2 ? 'closed' : remaining === 0 ? 'ready' : 'cutting';
    const progress = original === floor ? 100 : Math.floor(cut * 100 / (original - floor));
    const catalog = decimal(Math.max(floor, Math.max(original, cents(activity_price)) - cut));
    if (p.state !== state || p.current_price !== decimal(original - cut) || p.remaining_cut !== decimal(remaining)
      || p.catalog_price !== catalog || p.progress_percent !== progress || p.activity_price_changed !== (cents(activity_price) !== original)) return invalid();
    participation = { id, status, state, original_price, minimum_price: minimum, cut_price, current_price: money(p.current_price),
      remaining_cut: money(p.remaining_cut), catalog_price: money(p.catalog_price), activity_price_changed: flag(p.activity_price_changed), progress_percent: progress };
  } else if (requestedId) return invalid();
  const uniques = new Map<string, string>(), bases = new Map<string, string>(), labels = new Set<string>();
  const skus = array(row.skus, 500).map(value => {
    const sku = object(value), unique = key(sku.unique), base = key(sku.base_unique), suk = text(sku.suk), stock = int(sku.stock);
    if (suk !== suk.trim() || uniques.has(unique) || bases.has(base) || labels.has(suk)) return invalid();
    uniques.set(unique, suk); bases.set(base, suk); labels.add(suk);
    if (sku.catalog_price !== (participation?.catalog_price ?? null)) return invalid();
    return { unique, suk, stock, max_quantity: int(sku.max_quantity, 0, Math.min(stock, 32767)),
      catalog_price: sku.catalog_price === null ? null : money(sku.catalog_price), image: seckillImage(sku.image) };
  });
  for (const [unique, suk] of uniques) if (bases.has(unique) && bases.get(unique) !== suk) return invalid();
  if (skus.length > 1 && labels.has('')) return invalid();
  const start_time = date(row.start_time), stop_time = date(row.stop_time), state = text(row.date_window);
  if (!['future', 'active', 'ended'].includes(state) || start_time && stop_time && Date.parse(start_time) > Date.parse(stop_time)) return invalid();
  const can_select = flag(row.can_select);
  if (can_select !== (state === 'active' && participation?.state === 'ready' && skus.some(s => s.max_quantity > 0))) return invalid();
  return { selection_only: true, type: 2, bargain_id: expectedId, product_id: int(row.product_id, 1), title: text(row.title), image: seckillImage(row.image),
    activity_price, minimum_price, people: int(row.people, 1), start_time, stop_time, date_window: state as BargainSelection['date_window'], participation, skus, can_select };
}
export function bargainOpen(detail: BargainSelection, now = Date.now()): boolean {
  return detail.date_window === 'active' && (!detail.start_time || now >= Date.parse(detail.start_time)) && (!detail.stop_time || now <= Date.parse(detail.stop_time));
}
export function bargainCartInput(detail: BargainSelection, unique: string, quantity: number, now = Date.now()) {
  if (!bargainOpen(detail, now) || !detail.can_select || detail.participation?.state !== 'ready') throw new Error('该砍价参与当前不可购买，请刷新资格');
  const sku = detail.skus.find(s => s.unique === unique);
  if (!sku || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > sku.max_quantity) throw new Error('请选择有效活动规格和购买数量');
  return { productId: detail.product_id, activityId: detail.bargain_id, bargainUserId: detail.participation.id,
    type: 2 as const, unique, cartNum: quantity, new: 1 as const };
}
export function bargainCheckoutQuery(cartId: number, participantId: number) {
  int(cartId, 1); int(participantId, 1);
  return { mode: 'buy', cartId: String(cartId), type: '2', bargainUserId: String(participantId) };
}
