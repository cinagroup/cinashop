import { seckillImage } from './seckillPurchase';

export const PRESALE_PAGE_SIZE = 8;
export const PRESALE_FILTERS = [{ id: 1, name: '未开始' }, { id: 2, name: '正在进行' }, { id: 3, name: '已结束' }] as const;
export type PresaleTimeType = 1 | 2 | 3;
export interface PresaleCatalogItem {
  id: number; name: string; image: string; price: string; brand: string;
  starts: number; ends: number; shippingDays: number;
  labels: { id: number; name: string; icon: string; color: string; background: string; border: string }[];
}
export interface PresaleCatalogPage { list: PresaleCatalogItem[]; count: number }
export interface PresaleCatalogState extends PresaleCatalogPage {
  type: PresaleTimeType; page: number; loading: boolean; error: string;
}
const invalid = (): never => { throw new Error('预售列表数据无效，请刷新'); };
function int(value: unknown, min = 0, max = 2_147_483_647): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function text(value: unknown, max: number): string { return typeof value === 'string' && value.length <= max ? value : invalid(); }
const optional = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value.trim() : '';
const color = (value: unknown, fallback: string) => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value) ? value : fallback;
function labels(value: unknown): PresaleCatalogItem['labels'] {
  if (!Array.isArray(value)) return [];
  const result: PresaleCatalogItem['labels'] = [], seen = new Set<number>();
  for (const raw of value.slice(0, 32)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>, name = optional(row.label_name, 64), id = row.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647 || seen.has(id) || !name) continue;
    seen.add(id); result.push({ id, name, icon: seckillImage(optional(row.icon, 2048)),
      color: color(row.color, '#855224'), background: color(row.bg_color, '#fff7ec'), border: color(row.border_color, '#eed7b8') });
    if (result.length === 8) break;
  }
  return result;
}
export function presaleCatalogQuery(type: PresaleTimeType, page: number) {
  int(type, 1, 3); int(page, 1, Math.floor(2_147_483_647 / PRESALE_PAGE_SIZE));
  return { time_type: type, page, limit: PRESALE_PAGE_SIZE };
}
/** A display projection, never proof of purchase eligibility or a payable price. */
export function parsePresaleCatalog(value: unknown, type: PresaleTimeType, page: number): PresaleCatalogPage {
  presaleCatalogQuery(type, page);
  const data = record(value), count = int(data.count), seen = new Set<number>();
  if (!Array.isArray(data.list) || data.list.length !== Math.min(PRESALE_PAGE_SIZE, Math.max(0, count - (page - 1) * PRESALE_PAGE_SIZE))) return invalid();
  const list = data.list.map(raw => {
    const row = record(raw), id = int(row.id, 1), starts = int(row.presale_start_time), ends = int(row.presale_end_time);
    if (seen.has(id) || row.is_presale_product !== 1 || row.presale_pay_status !== type || ends < starts) return invalid();
    seen.add(id);
    const price = text(row.price, 13); if (!/^\d{1,10}\.\d{2}$/.test(price)) return invalid();
    return { id, name: text(row.store_name, 512), image: seckillImage(text(row.image, 2048)), price,
      starts, ends, shippingDays: int(row.presale_day), brand: optional(row.brand_name, 128), labels: labels(row.store_label) };
  });
  return { list, count };
}
export function presaleBeijingTime(seconds: number): string {
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
export const newPresaleCatalog = (): PresaleCatalogState => ({ type: 2, list: [], count: 0, page: 0, loading: false, error: '' });
/** Each view owns a session. Its reset boundary invalidates pending reads synchronously. */
export function createPresaleCatalogSession(state: PresaleCatalogState,
  fetchPage: (type: PresaleTimeType, page: number) => Promise<PresaleCatalogPage>, isActive: () => boolean) {
  let revision = 0, disposed = false;
  function reset() { revision++; state.list = []; state.count = 0; state.page = 0; state.loading = false; state.error = ''; }
  async function load(append = false): Promise<void> {
    if (disposed || !isActive() || append && (state.loading || state.page > 0 && state.list.length >= state.count)) return;
    if (!append) reset();
    const current = ++revision, page = append ? state.page + 1 : 1, type = state.type;
    state.loading = true; state.error = '';
    try {
      const result = await fetchPage(type, page);
      if (disposed || current !== revision || !isActive()) return;
      const next = append ? [...state.list, ...result.list] : result.list;
      if (append && state.page > 0 && result.count !== state.count || new Set(next.map(row => row.id)).size !== next.length || next.length > result.count || result.list.length === 0 && page > 1) {
        throw new Error('预售列表已变化，请刷新列表');
      }
      state.list = next; state.count = result.count; state.page = page;
    } catch (e) {
      if (!disposed && current === revision && isActive()) state.error = e instanceof Error ? e.message : '预售列表加载失败，请重试';
    } finally { if (current === revision && isActive()) state.loading = false; }
  }
  function select(type: PresaleTimeType) { if (disposed || !isActive()) return; presaleCatalogQuery(type, 1); state.type = type; return load(); }
  return { reset, load, select, dispose() { disposed = true; reset(); } };
}
