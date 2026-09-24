/** Full-payment base-product selection. Never a quote, reservation or admission. */
import { seckillImage } from './seckillPurchase';

export interface PresaleSku {
  unique: string; suk: string; catalog_price: string; ot_price: string; image: string; stock: number; max_quantity: number;
}
export interface PresaleSelection {
  version: 1; selection_only: true; type: 6; payment_mode: 'full'; product_id: number;
  title: string; subtitle: string; image: string; images: string[]; sales: number; unit_name: string;
  product_type: number; system_form_id: number;
  purchase_limits: { mode: 'none'; quantity: null } | { mode: 'per_order' | 'cumulative'; quantity: number };
  schedule: { timezone: 'Asia/Shanghai'; state: 'future' | 'active' | 'ended'; presale_pay_status: 1 | 2 | 3;
    starts_at: string; ends_at: string; start_time: number; stop_time: number; shipping_days_after_end: number };
  skus: PresaleSku[];
}
const invalid = (): never => { throw new Error('预售数据格式错误，请刷新或稍后重试'); };
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function int(value: unknown, min = 0, max = 2_147_483_647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function text(value: unknown): string { return typeof value === 'string' ? value : invalid(); }
function list(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : invalid(); }
function money(value: unknown): string { const raw = text(value); return /^\d{1,10}\.\d{2}$/.test(raw) ? raw : invalid(); }
function key(value: unknown): string {
  const raw = text(value); return raw && raw.length <= 8 && !/[\s\u0000-\u001f\u007f]/u.test(raw) ? raw : invalid();
}
export function presaleProductId(value: unknown): number {
  return typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? int(Number(value), 1) : invalid();
}
export function parsePresaleSelection(value: unknown, expectedId: number): PresaleSelection {
  const row = record(value), schedule = record(row.schedule), limits = record(row.purchase_limits);
  int(expectedId, 1);
  if (row.version !== 1 || row.selection_only !== true || row.type !== 6 || row.payment_mode !== 'full' || row.product_id !== expectedId) return invalid();
  let purchase_limits: PresaleSelection['purchase_limits'];
  if (limits.mode === 'none' && limits.quantity === null) purchase_limits = { mode: 'none', quantity: null };
  else if (limits.mode === 'per_order' || limits.mode === 'cumulative') purchase_limits = { mode: limits.mode, quantity: int(limits.quantity, 1) };
  else return invalid();
  const start_time = int(schedule.start_time), stop_time = int(schedule.stop_time), status = int(schedule.presale_pay_status, 1, 3) as 1 | 2 | 3;
  const starts_at = new Date(start_time * 1000).toISOString(), ends_at = new Date((stop_time + 1) * 1000).toISOString();
  if (schedule.timezone !== 'Asia/Shanghai' || stop_time < start_time || schedule.starts_at !== starts_at || schedule.ends_at !== ends_at ||
    schedule.state !== ['future', 'active', 'ended'][status - 1]) return invalid();
  const seen = new Set<string>();
  const skus = list(row.skus, 500).map(value => {
    const sku = record(value), unique = key(sku.unique), base = key(sku.base_unique), stock = int(sku.stock);
    if (unique !== base || seen.has(unique)) return invalid(); seen.add(unique);
    const bound = purchase_limits.mode === 'cumulative' ? 0 : Math.min(stock, 32767,
      purchase_limits.mode === 'per_order' ? purchase_limits.quantity : 32767);
    return { unique, suk: text(sku.suk), stock, max_quantity: int(sku.max_quantity, 0, bound),
      catalog_price: money(sku.catalog_price), ot_price: money(sku.ot_price), image: seckillImage(sku.image) };
  });
  return { version: 1, selection_only: true, type: 6, payment_mode: 'full', product_id: expectedId,
    title: text(row.title), subtitle: text(row.subtitle), image: seckillImage(row.image),
    images: [...new Set(list(row.images, 20).map(seckillImage).filter(Boolean))], sales: int(row.sales), unit_name: text(row.unit_name),
    product_type: int(row.product_type, 0, 4), system_form_id: int(row.system_form_id), purchase_limits,
    schedule: { timezone: 'Asia/Shanghai', state: schedule.state as PresaleSelection['schedule']['state'], presale_pay_status: status,
      starts_at, ends_at, start_time, stop_time, shipping_days_after_end: int(schedule.shipping_days_after_end) }, skus };
}
export function presaleOpen(detail: PresaleSelection, now = Date.now()): boolean {
  return detail.purchase_limits.mode !== 'cumulative' && detail.schedule.state === 'active' &&
    now >= detail.schedule.start_time * 1000 && now < (detail.schedule.stop_time + 1) * 1000;
}
export function presaleCartInput(detail: PresaleSelection, unique: string, quantity: number, now = Date.now()) {
  if (!presaleOpen(detail, now)) throw new Error('当前预售不可购买，请刷新商品');
  const sku = detail.skus.find(sku => sku.unique === unique);
  if (!sku || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > sku.max_quantity) throw new Error('请选择有效预售规格和购买数量');
  return { productId: detail.product_id, activityId: 0, type: 6 as const, unique: sku.unique, cartNum: quantity, new: 1 as const };
}
export function presaleCheckoutQuery(cartId: number) {
  int(cartId, 1); return { mode: 'buy', cartId: String(cartId), type: '6' };
}
