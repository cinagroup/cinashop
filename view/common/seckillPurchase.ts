/** The selection catalogue is not a quote, eligibility guarantee or inventory reservation. */
export interface SeckillSlot { id: number; start_time: string; end_time: string; status: 0 | 1 | 2; state: string }
export interface SeckillIndex { seckillTime: SeckillSlot[]; seckillTimeIndex: number }
export interface SeckillItem { id: number; product_id: number; title: string; image: string; price: number; ot_price: number }
export interface SeckillSku { unique: string; suk: string; catalog_price: string; ot_price: string; image: string; stock: number; max_quantity: number }
export interface SeckillSelection {
  selection_only: true; type: 1; seckill_id: number; product_id: number; title: string; image: string;
  once_limit: number; total_limit: number; skus: SeckillSku[];
  schedule: { timezone: 'Asia/Shanghai'; state: 'active' | 'future' | 'ended' | 'waiting' | 'unavailable' | 'invalid';
    message: string; starts_at: string | null; ends_at: string | null };
}
const invalid = (): never => { throw new Error('秒杀数据格式错误，请刷新或稍后重试'); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function int(value: unknown, min = 0, max = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function string(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function array(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid(); }
function unique(value: unknown): string {
  const key = string(value);
  return key && key.length <= 8 && !/[\s\u0000-\u001f\u007f]/u.test(key) ? key : invalid();
}
function money(value: unknown): string { const text = string(value); return /^\d{1,10}\.\d{2}$/.test(text) ? text : invalid(); }
function date(value: unknown): string | null {
  if (value === null) return null;
  const text = string(value);
  return /^\d{4}-\d{2}-\d{2}T.*Z$/.test(text) && Number.isFinite(Date.parse(text)) ? text : invalid();
}
export function seckillId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) return invalid();
  return int(Number(value), 1);
}
export function seckillImage(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return '';
  if (/^\/(?!\/)/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? value : ''; }
  catch { return ''; }
}
export function parseSeckillIndex(value: unknown): SeckillIndex {
  const data = record(value), seen = new Set<number>();
  const seckillTime = array(data.seckillTime, 1000).map(value => {
    const slot = record(value), id = int(slot.id, 1);
    if (seen.has(id)) return invalid(); seen.add(id);
    return { id, start_time: string(slot.start_time), end_time: string(slot.end_time),
      status: int(slot.status, 0, 2) as 0 | 1 | 2, state: string(slot.state) };
  });
  const index = int(data.seckillTimeIndex, -1, seckillTime.length - 1);
  return { seckillTime, seckillTimeIndex: index };
}
export function parseSeckillList(value: unknown): SeckillItem[] {
  const seen = new Set<number>();
  return array(value, 100).map(value => {
    const row = record(value), id = int(row.id, 1);
    if (seen.has(id)) return invalid(); seen.add(id);
    const price = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();
    return { id, product_id: int(row.product_id, 1), title: string(row.title), image: seckillImage(row.image),
      price: price(row.price), ot_price: price(row.ot_price) };
  });
}
export function parseSeckillSelection(value: unknown, expectedId: number): SeckillSelection {
  const row = record(value), schedule = record(row.schedule);
  if (row.selection_only !== true || row.type !== 1 || row.seckill_id !== expectedId) return invalid();
  const once_limit = int(row.once_limit, 1), total_limit = int(row.total_limit, 1);
  const seen = new Set<string>(), bases = new Set<string>(), labels = new Set<string>();
  const skus = array(row.skus, 500).map(value => {
    const sku = record(value), key = unique(sku.unique), base = unique(sku.base_unique), suk = string(sku.suk);
    if (seen.has(key) || bases.has(base) || labels.has(suk)) return invalid();
    seen.add(key); bases.add(base); labels.add(suk);
    const stock = int(sku.stock), max_quantity = int(sku.max_quantity, 0, Math.min(stock, once_limit, total_limit, 32767));
    return { unique: key, suk, stock, max_quantity, catalog_price: money(sku.catalog_price), ot_price: money(sku.ot_price), image: seckillImage(sku.image) };
  });
  const state = string(schedule.state);
  if (schedule.timezone !== 'Asia/Shanghai' || !['active', 'future', 'ended', 'waiting', 'unavailable', 'invalid'].includes(state)) return invalid();
  const starts_at = date(schedule.starts_at), ends_at = date(schedule.ends_at);
  if (state === 'active' && (!starts_at || !ends_at || Date.parse(starts_at) >= Date.parse(ends_at))) return invalid();
  return { selection_only: true, type: 1, seckill_id: int(row.seckill_id, 1), product_id: int(row.product_id, 1),
    title: string(row.title), image: seckillImage(row.image), once_limit, total_limit, skus,
    schedule: { timezone: 'Asia/Shanghai', state: state as SeckillSelection['schedule']['state'], message: string(schedule.message), starts_at, ends_at } };
}
export function seckillOpen(detail: SeckillSelection, now = Date.now()): boolean {
  const schedule = detail.schedule;
  return schedule.state === 'active' && !!schedule.starts_at && !!schedule.ends_at &&
    now >= Date.parse(schedule.starts_at) && now < Date.parse(schedule.ends_at);
}
export function seckillCartInput(detail: SeckillSelection, key: string, quantity: number, now = Date.now()) {
  if (!seckillOpen(detail, now)) throw new Error('当前秒杀不可购买，请刷新活动');
  const sku = detail.skus.find(sku => sku.unique === key);
  if (!sku || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > sku.max_quantity) throw new Error('请选择有效规格和购买数量');
  return { productId: detail.product_id, activityId: detail.seckill_id, type: 1 as const, unique: sku.unique, cartNum: quantity, new: 1 as const };
}
