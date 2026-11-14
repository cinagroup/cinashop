import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrderStatus } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

export interface OrderLifecycleLog { create: string; pay: string; delivery: string; take: string; complete: string }
export interface CityOrderLifecycleLog { create: string; pay: string; city_delivery: Array<{ time: string; label: string }>; take: string; complete: string }
export interface LifecycleRow { id?: number; changeType: string; changeTime: number }
const types = ['cache_key_create_order', 'pay_success', 'delivery', 'delivery_goods', 'delivery_fictitious', 'take_delivery', 'check_order_over'];
const cityLabels: Record<string, string> = { '-1': '已取消', '2': '待取货', '3': '配送中', '4': '已完成', '9': '物品返回中', '10': '物品返回完成', '100': '骑士到店' };
const clock = new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn', { timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function lifecycleTime(seconds: number, dateOnly = true): string {
  if (!Number.isInteger(seconds) || seconds < -2_147_483_648 || seconds > 2_147_483_647) throw new ValidateException('订单进度时间无效');
  const p = Object.fromEntries(clock.formatToParts(new Date(seconds * 1000)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}` + (dateOnly ? '' : ` ${p.hour}:${p.minute}:${p.second}`);
}

export function buildOrderLifecycleLog(rows: LifecycleRow[], city: true): CityOrderLifecycleLog;
export function buildOrderLifecycleLog(rows: LifecycleRow[], city?: false): OrderLifecycleLog;
export function buildOrderLifecycleLog(rows: LifecycleRow[], city = false): OrderLifecycleLog | CityOrderLifecycleLog {
  const ordered = rows.map((row, index) => ({ ...row, rank: row.id ?? index })).sort((a, b) => a.changeTime - b.changeTime || a.rank - b.rank);
  const last = new Map<string, typeof ordered[number]>();
  for (const row of ordered) {
    if (types.includes(row.changeType) || (city && row.changeType.includes('city_delivery'))) {
      lifecycleTime(row.changeTime); last.set(row.changeType, row);
    }
  }
  const date = (type: string) => { const row = last.get(type); return row ? lifecycleTime(row.changeTime) : ''; };
  const base = { create: date('cache_key_create_order'), pay: date('pay_success'), take: date('take_delivery'), complete: date('check_order_over') };
  if (city) return { create: base.create, pay: base.pay,
    city_delivery: [...last.values()].filter(row => row.changeType.includes('city_delivery'))
      .sort((a, b) => a.changeTime - b.changeTime || a.rank - b.rank)
      .map(row => ({ time: lifecycleTime(row.changeTime, false), label: Object.hasOwn(cityLabels, row.changeType.replaceAll('city_delivery_', '')) ? cityLabels[row.changeType.replaceAll('city_delivery_', '')]! : '配送中' })),
    take: base.take, complete: base.complete };
  // PHP gives the named delivery types this priority, independent of their dates.
  return { create: base.create, pay: base.pay,
    delivery: last.has('delivery') ? date('delivery') : last.has('delivery_goods') ? date('delivery_goods') : date('delivery_fictitious'),
    take: base.take, complete: base.complete };
}

/** One row per exact event type; repeated events do not grow the response.
 * Unknown city types retain PHP's substring/fallback behavior. No messages or
 * unrelated history are downloaded, and excessive distinct types fail explicitly. */
export async function readOrderLifecycleRows(db: DbClient, id: number, city = false): Promise<LifecycleRow[]> {
  const relevant = inArray(storeOrderStatus.changeType, types);
  const rows = await db.selectDistinctOn([storeOrderStatus.changeType], {
    id: storeOrderStatus.id, changeType: storeOrderStatus.changeType, changeTime: storeOrderStatus.changeTime,
  }).from(storeOrderStatus).where(and(eq(storeOrderStatus.oid, id), city
    ? or(relevant, sql`position('city_delivery' in ${storeOrderStatus.changeType}) > 0`) : relevant))
    .orderBy(asc(storeOrderStatus.changeType), desc(storeOrderStatus.changeTime), desc(storeOrderStatus.id)).limit(city ? 10001 : types.length);
  if (rows.length > 10000) throw new ValidateException('订单进度记录类型过多，请联系商家核对');
  return rows;
}
export async function readOrderLifecycleLog(db: DbClient, id: number): Promise<OrderLifecycleLog> {
  return buildOrderLifecycleLog(await readOrderLifecycleRows(db, id));
}
export function withOrderLifecycleSnapshot<T>(container: Container, read: (db: DbClient) => Promise<T>): Promise<T> {
  return withTx(container, async db => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await db.execute(sql`SELECT set_config('statement_timeout',
      LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true)`);
    return read(db);
  });
}
