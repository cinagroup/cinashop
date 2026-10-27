import { sql, type SQL } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { user, storeOrder, systemConfig } from '@/models/schema';
import { NotFoundException } from '@/utils/errors';

export interface PeopleReadQuery { grade: number; start: number; stop: number; keyword: string; limit: number; offset: number; sort?: string }
export interface PeopleReadRow { uid: number; nickname: string; avatar: string; add_time: number; spread_time: number;
  childCount: number; orderCount: number | null; numberCount: string | null; time: string }
export interface PeopleReadResult { total: number; totalLevel: number; filtered_count: number; count: number;
  division_mode: boolean; config_value: string | null; price: string; list: PeopleReadRow[] }

/** The legacy sort uses the persisted cache, then replaces its displayed child count.
 * Explicit NULL ordering preserves MySQL's LEFT JOIN aggregate ordering on Postgres. */
function peopleSort(value = ''): SQL {
  const sorts: Record<string, SQL> = {
    'childcount asc': sql`spread_count asc`, 'childcount desc': sql`spread_count desc`,
    'numbercount asc': sql`"numberCount" asc nulls first`, 'numbercount desc': sql`"numberCount" desc nulls last`,
    'ordercount asc': sql`"orderCount" asc nulls first`, 'ordercount desc': sql`"orderCount" desc nulls last`,
  };
  return sorts[value.trim().toLowerCase()] ?? sql`add_time desc`;
}

/** One shared report statement. The caller chooses its snapshot and presentation;
 * neither this query nor its persisted configuration lookup touches KV or media. */
export async function readPromoterPeople(container: Pick<Container, 'db'>, uid: number, query: PeopleReadQuery, readConfig = false): Promise<PeopleReadResult> {
  const { grade, start, stop, keyword, limit, offset } = query;
  const sort = peopleSort(query.sort), pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await container.db.execute<{ data: PeopleReadResult }>(sql`
    with owner as (select division_type from ${user} where uid = ${uid} and status = 1 and is_del = 0 and delete_time is null),
    active as (select uid, spread_uid, nickname, avatar, phone, add_time, spread_time, spread_count from ${user}
      where is_del = 0 and delete_time is null),
    one as (select * from active where spread_uid = ${uid}),
    two as (select * from active where spread_uid in (select uid from one) and uid <> ${uid}),
    candidates as (select * from ${grade === 0 ? sql`one` : sql`two`}),
    filtered as (select * from candidates where
      ${keyword ? sql`(nickname ilike ${pattern} or phone ilike ${pattern})` : sql`true`}
      and ${start || stop ? sql`spread_time between ${start} and ${stop}` : sql`true`}),
    purchases as (select o.uid, count(*) as "orderCount", sum(o.pay_price) as "numberCount"
      from ${storeOrder} o where o.uid in (select uid from filtered) and o.pid in (0,-1) and o.paid = 1
        and o.refund_status in (0,3) and o.is_del = 0 and o.is_system_del = 0 group by o.uid),
    enriched as (select f.*, p."orderCount", p."numberCount",
      (select count(*) from active a where a.spread_uid = f.uid) as "childCount"
      from filtered f left join purchases p on p.uid = f.uid),
    page as (select * from enriched order by ${sort}, uid desc limit ${limit} offset ${offset}),
    projected as (select uid, nickname, avatar, add_time, spread_time, "childCount", "orderCount", round("numberCount",2)::text as "numberCount",
      case when spread_time <> 0 then to_char(to_timestamp(spread_time) at time zone 'Asia/Shanghai','YYYY-MM-DD')
        else to_char(to_timestamp(add_time) at time zone 'Asia/Shanghai','YYYY/MM/DD') end as time,
      row_number() over (order by ${sort}, uid desc) as position from page)
    select jsonb_build_object('total',(select count(*) from one), 'totalLevel',(select count(*) from two),
      'filtered_count',(select count(*) from filtered), 'count',(select count(*) from page),
      'division_mode',owner.division_type = 1,
      'config_value',${readConfig ? sql`(select value from ${systemConfig} where menu_name = 'brokerage_level' and is_store = 0 order by sort desc,id desc limit 1)` : sql`null::text`},
      'list',coalesce((select jsonb_agg(to_jsonb(p)-'position' order by position) from projected p),'[]'::jsonb),
      'price',case when exists(select 1 from page) then (select round(coalesce(sum(
        case when owner.division_type = 1 then case when o.division_id = ${uid} then o.division_brokerage else 0 end
          else ${grade === 0 ? sql`case when o.spread_uid = ${uid} then o.one_brokerage else 0 end` : sql`case when o.spread_two_uid = ${uid} then o.two_brokerage else 0 end`} end),0),2)::text
        from ${storeOrder} o where o.pid = 0 and o.type = 0 and o.paid = 1 and o.refund_status in (0,3)
          and o.is_del = 0 and o.is_system_del = 0) else '0' end) as data from owner
  `);
  if (!rows[0]) throw new NotFoundException('用户不存在或已被禁用');
  return rows[0].data;
}
