/** Server-formatted Shanghai dates. Presence comes from recorded events only. */
export interface OrderLifecycleLog { create: string; pay: string; delivery: string; take: string; complete: string }
export interface CityOrderLifecycleLog { create: string; pay: string; city_delivery: Array<{ time: string; label: string }>; take: string; complete: string }
const base = ['create', 'pay', 'take', 'complete'];
const labels = ['已取消', '待取货', '配送中', '已完成', '物品返回中', '物品返回完成', '骑士到店'];
function validDate(value: unknown, empty: boolean): value is string {
  if (empty && value === '') return true;
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
const invalid = (): never => { throw Error('订单进度记录响应无效，请重新读取订单'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function parseOrderLifecycleLog(value: unknown): OrderLifecycleLog {
  const row = object(value), keys = [...base, 'delivery'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key) || !validDate(row[key], true))) return invalid();
  return { create: String(row.create), pay: String(row.pay), delivery: String(row.delivery), take: String(row.take), complete: String(row.complete) };
}
export function parseCityOrderLifecycleLog(value: unknown): CityOrderLifecycleLog {
  const row = object(value);
  if (Object.keys(row).length !== 5 || base.some(key => !Object.hasOwn(row, key) || !validDate(row[key], true))
    || !Object.hasOwn(row, 'city_delivery') || !Array.isArray(row.city_delivery) || row.city_delivery.length > 10000) return invalid();
  const city_delivery = row.city_delivery.map(raw => {
    const event = object(raw);
    if (Object.keys(event).length !== 2 || !Object.hasOwn(event, 'time') || !Object.hasOwn(event, 'label') || typeof event.time !== 'string' || typeof event.label !== 'string'
      || !validDate(event.time.slice(0, 10), false) || !/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(event.time)
      || !labels.includes(event.label)) return invalid();
    return { time: event.time, label: event.label };
  });
  return { create: String(row.create), pay: String(row.pay), city_delivery, take: String(row.take), complete: String(row.complete) };
}
export function lifecycleEntries(log: OrderLifecycleLog | CityOrderLifecycleLog) {
  const rows = [{ key: 'create', label: '订单生成', time: log.create }, { key: 'pay', label: '付款记录', time: log.pay }];
  if ('delivery' in log) rows.push({ key: 'delivery', label: '发货记录', time: log.delivery });
  else log.city_delivery.forEach((row, index) => rows.push({ key: 'city-' + index, label: row.label, time: row.time }));
  rows.push({ key: 'take', label: '收货记录', time: log.take }, { key: 'complete', label: '完成记录', time: log.complete });
  return rows.filter(row => row.time !== '');
}
