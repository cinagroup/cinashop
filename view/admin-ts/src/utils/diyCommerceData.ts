// Anonymous author preview parser; no navigation, coupon or cart actions.
import { navigationRecord as asDiyRecord } from './diyNavigationEditor';
import { presentationPreviewUrl as safeDiyImageUrl } from './diyPresentationEditor';
import type { DiyCommerceKind } from './diyCommerceProjection';

export interface CommerceCard {
  id: number; productId: number; title: string; image: string; price: string; oldPrice: string;
  people: number; count: number; stock: number; percent: number; integral: number; status: number;
}
export interface CommerceCoupon { id: number; type: number; coupon_type: number; coupon_title: string; coupon_price: string; use_min_price: string; is_use: boolean | 2; remain_count: number; receive_limit: number }
export interface CommerceRoom { id: number; room_id: number; name: string; cover_img: string; show_time: string; anchor_name: string; anchor_img: string; live_status: number; goods: { id: number; name: string; cover_img: string; price: string }[] }
export interface CommerceSlot { id: number; start_time: string; end_time: string; state: string; stop: number; status: number }
export function commerceRecord(value: unknown): Record<string, unknown> { const row = asDiyRecord(value); if (!row) throw Error('商城响应格式无效'); return row; }
export function commerceInteger(value: unknown, minimum = 0, maximum = 2147483647): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw Error('商城数值无效'); return Number(value);
}
export function commerceText(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('商城文字无效'); return value;
}
export function commerceMoney(value: unknown): string {
  if (!(typeof value === 'number' || typeof value === 'string') || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(String(value))) throw Error('商城金额无效');
  const [whole, fraction = ''] = String(value).split('.'); return `${whole}.${fraction.padEnd(2, '0')}`;
}
function rows(value: unknown, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > max) throw Error('商城列表格式无效');
  const seen = new Set<number>();
  return value.map(item => { const row = commerceRecord(item), id = commerceInteger(row.id, 1); if (seen.has(id)) throw Error('商城标识重复'); seen.add(id); return row; });
}
export function checkedCommerceCards(kind: DiyCommerceKind, value: unknown, limit: number): CommerceCard[] {
  const source = kind === 'presale' ? commerceRecord(value).list : value;
  if (kind === 'presale') commerceInteger(commerceRecord(value).count);
  return rows(source, limit).map(row => {
    const percent = kind === 'seckill' ? row.percent : 0;
    if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) throw Error('秒杀进度无效');
    return { id: commerceInteger(row.id, 1), productId: kind === 'presale' ? commerceInteger(row.id, 1) : commerceInteger(row.product_id, 1),
      title: commerceText(kind === 'presale' ? row.store_name : row.title), image: safeDiyImageUrl(commerceText(row.image, 8192)),
      price: commerceMoney(row.price), oldPrice: commerceMoney(kind === 'pointsMall' ? 0 : row.ot_price),
      people: ['combination', 'bargain'].includes(kind) ? commerceInteger(row.people) : 0,
      count: commerceInteger(kind === 'combination' ? row.pink_count : kind === 'bargain' || kind === 'presale' ? row.sales : 0),
      stock: commerceInteger(row.stock), percent, integral: kind === 'pointsMall' ? commerceInteger(row.integral) : 0,
      status: kind === 'presale' ? commerceInteger(row.presale_pay_status, 0, 3) : 0 };
  });
}
export function checkedCommerceSlots(value: unknown): { slots: CommerceSlot[]; index: number } {
  const result = commerceRecord(value), slots = rows(result.seckillTime, 1000).map(row => ({ id: commerceInteger(row.id, 1),
    start_time: commerceText(row.start_time, 16), end_time: commerceText(row.end_time, 16), state: commerceText(row.state, 64),
    stop: commerceInteger(row.stop, 0, 9999999999), status: commerceInteger(row.status, 0, 2) }));
  const index = commerceInteger(result.seckillTimeIndex, -1);
  if (index >= slots.length) throw Error('秒杀当前时段无效');
  return { slots, index };
}
export function checkedCommercePink(value: unknown) {
  const row = commerceRecord(value);
  if (!Array.isArray(row.avatars) || row.avatars.length > 100) throw Error('拼团头像格式无效');
  return { pink_count: commerceInteger(row.pink_count), avatars: row.avatars.map(item => safeDiyImageUrl(commerceText(item, 8192))).filter(Boolean) };
}
export function checkedCommerceCoupons(value: unknown, limit: number, uid: number): CommerceCoupon[] {
  const row = commerceRecord(value);
  if (!Array.isArray(row.count) || row.count.length !== 4) throw Error('优惠券数量格式无效'); row.count.forEach(item => commerceInteger(item));
  return rows(row.list, limit).map(item => {
    if (![true, false, 2].includes(item.is_use as boolean | number)) throw Error('优惠券状态无效');
    const id = commerceInteger(item.id, 1);
    if (item.is_use === true) { const used = commerceRecord(item.used); if (uid < 1 || used.uid !== uid || used.cid !== id) throw Error('优惠券不属于当前账号'); commerceInteger(used.id, 1); }
    return { id, type: commerceInteger(item.type, 0, 3), coupon_type: commerceInteger(item.coupon_type, 1, 2), coupon_title: commerceText(item.coupon_title),
      coupon_price: commerceMoney(item.coupon_price), use_min_price: commerceMoney(item.use_min_price), is_use: item.is_use as boolean | 2,
      remain_count: commerceInteger(item.remain_count), receive_limit: commerceInteger(item.receive_limit) };
  });
}
export function checkedCommerceRooms(value: unknown, limit: number): CommerceRoom[] {
  const remoteIds = new Set<number>();
  return rows(value, limit).map(row => {
    const remote = commerceInteger(row.room_id, 1); if (remoteIds.has(remote)) throw Error('直播间来源重复'); remoteIds.add(remote);
    if (![101, 102, 103].includes(commerceInteger(row.live_status))) throw Error('直播状态无效');
    return { id: commerceInteger(row.id, 1), room_id: remote, name: commerceText(row.name), cover_img: safeDiyImageUrl(commerceText(row.cover_img, 8192)), show_time: commerceText(row.show_time),
      anchor_name: commerceText(row.anchor_name), anchor_img: safeDiyImageUrl(commerceText(row.anchor_img, 8192)), live_status: Number(row.live_status),
      goods: rows(row.goods, 100).map(g => ({ id: commerceInteger(g.id, 1), name: commerceText(g.name), cover_img: safeDiyImageUrl(commerceText(g.cover_img, 8192)), price: commerceMoney(g.price) })) };
  });
}
