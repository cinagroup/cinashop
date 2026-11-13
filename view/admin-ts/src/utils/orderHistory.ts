export interface AdminOrderHistoryRow {
  id: number; oid: number; change_type: string; change_message: string; change_time: string; timestamp: number;
}
export interface AdminOrderHistoryPage {
  id: number; order_id: string; list: AdminOrderHistoryRow[]; count: number; page: number; limit: number; revision: string;
}
export interface AdminOrderHistoryQuery { page: number; limit: number; revision?: string }
const clock = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function orderHistoryTime(seconds: number) {
  const p = Object.fromEntries(clock.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
export function parseAdminOrderHistory(value: unknown, id: number, orderNo: string, query: AdminOrderHistoryQuery): AdminOrderHistoryPage {
  const invalid = (): never => { throw Error('订单记录响应无效，请刷新记录'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>;
  if (row.id !== id || row.order_id !== orderNo || row.page !== query.page || row.limit !== query.limit
    || !Number.isInteger(row.count) || Number(row.count) < 0 || Number(row.count) > 10000
    || typeof row.revision !== 'string' || !/^[a-f0-9]{64}$/.test(row.revision)
    || (query.revision !== undefined && row.revision !== query.revision) || !Array.isArray(row.list)
    || row.list.length !== Math.min(query.limit, Math.max(0, Number(row.count) - (query.page - 1) * query.limit))) return invalid();
  const list: AdminOrderHistoryRow[] = [], ids = new Set<number>();
  for (const raw of row.list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const r = raw as Record<string, unknown>, previous = list.at(-1);
    if (!Number.isInteger(r.id) || Number(r.id) < 1 || Number(r.id) > 2_147_483_647 || ids.has(Number(r.id)) || r.oid !== id
      || typeof r.change_type !== 'string' || [...r.change_type].length > 32
      || typeof r.change_message !== 'string' || [...r.change_message].length > 256
      || !Number.isInteger(r.timestamp) || Number(r.timestamp) < -2_147_483_648 || Number(r.timestamp) > 2_147_483_647
      || r.change_time !== orderHistoryTime(Number(r.timestamp))
      || (previous && (Number(r.timestamp) < previous.timestamp || (r.timestamp === previous.timestamp && Number(r.id) <= previous.id)))) return invalid();
    ids.add(Number(r.id));
    list.push({ id: Number(r.id), oid: id, change_type: r.change_type, change_message: r.change_message,
      change_time: String(r.change_time), timestamp: Number(r.timestamp) });
  }
  return { id, order_id: orderNo, list, count: Number(row.count), page: query.page, limit: query.limit, revision: row.revision };
}
