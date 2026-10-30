/** Local public live catalog only; no author image capability or provider I/O. */
export interface DiyLiveBroadcastGood { id: number; name: string; cover_img: string; price: string }
export interface DiyLiveBroadcastRoom {
  id: number; room_id: number; name: string; cover_img: string; show_time: string;
  anchor_name: string; anchor_img: string; live_status: 101 | 102 | 103; goods: DiyLiveBroadcastGood[];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('直播目录格式无效');
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 2147483647) throw Error('直播目录数值无效');
  return Number(value);
}
function text(value: unknown, maximum = 1024): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw Error('直播目录文字无效');
  return value;
}
function money(value: unknown): string {
  if (!(typeof value === 'number' || typeof value === 'string') || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/u.test(String(value))) throw Error('直播商品金额无效');
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}
function rows(value: unknown, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum) throw Error('直播目录列表无效');
  const ids = new Set<number>();
  // Array.from visits sparse holes too: no tail or omitted item is accepted.
  return Array.from(value, item => {
    const row = record(item), id = integer(row.id, 1);
    if (ids.has(id)) throw Error('直播目录标识重复');
    ids.add(id);
    return row;
  });
}
export function checkedDiyLiveBroadcastLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('直播预览数量必须为1至50的整数');
}
/** All rooms AND all goods are checked before any result escapes. No filtering,
 * sorting, deduplication, truncation, demo replacement or added image authority. */
export function checkedDiyLiveBroadcastRows(raw: unknown, limit: number, safeImage: (value: unknown) => string): DiyLiveBroadcastRoom[] {
  checkedDiyLiveBroadcastLimit(limit);
  const remoteIds = new Set<number>();
  return rows(raw, limit).map(row => {
    const remote = integer(row.room_id, 1), status = integer(row.live_status);
    if (remoteIds.has(remote)) throw Error('直播间来源重复');
    remoteIds.add(remote);
    if (status !== 101 && status !== 102 && status !== 103) throw Error('直播状态无效');
    return {
      id: integer(row.id, 1), room_id: remote, name: text(row.name), cover_img: safeImage(text(row.cover_img, 8192)),
      show_time: text(row.show_time), anchor_name: text(row.anchor_name), anchor_img: safeImage(text(row.anchor_img, 8192)), live_status: status,
      goods: rows(row.goods, 100).map(good => ({ id: integer(good.id, 1), name: text(good.name), cover_img: safeImage(text(good.cover_img, 8192)), price: money(good.price) })),
    };
  });
}
