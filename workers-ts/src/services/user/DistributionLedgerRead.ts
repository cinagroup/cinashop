import { sql } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { user, userBrokerage, userExtract } from '@/models/schema';
import { NotFoundException } from '@/utils/errors';
import type { DistributionLedgerMode, DistributionLedgerQuery } from './DistributionLedgerInput';

/** PHP ModelTrait applies this only to ledger3/4's `time` array. Zero-ended
 * arrays stay closed intervals; equal timestamps and midnight stops add a day.
 * Other balance-ledger time contracts deliberately do not use this helper. */
export function legacyDistributionLedgerPeriod(start: number, stop: number) {
  if (!start && !stop) return null;
  const midnight = ((stop + 28800) % 86400 + 86400) % 86400 === 0;
  return { start, stop: start === stop || midnight ? stop + 86400 : stop };
}

export interface DistributionLedgerRow { id: number; title: string; type: string; pm: 0 | 1; number: string; add_time: number; time: string;
  withdrawal_status: -1 | 0 | 1 | null; withdrawal_message: string }
export interface DistributionLedgerReport { count: number; income: string | null; expend: string | null; list: DistributionLedgerRow[] }

/** One report statement: no type/status exclusions for commissions, distinct
 * full-filtered sums, ID paging and an owned-only withdrawal status projection. */
export async function readDistributionLedger(container: Pick<Container, 'db'>, uid: number, mode: DistributionLedgerMode,
  query: DistributionLedgerQuery): Promise<DistributionLedgerReport> {
  const pattern = `%${query.keyword}%`;
  const rows = await container.db.execute<{ data: DistributionLedgerReport }>(sql`
    with owner as (select uid, account, nickname, phone from ${user}
      where uid = ${uid} and status = 1 and is_del = 0 and delete_time is null),
    filtered as (select b.* from ${userBrokerage} b cross join owner o where b.uid = o.uid
      and ${mode === 'withdrawal' ? sql`b.type in ('extract','extract_money','extract_fail')` : sql`true`}
      and ${query.start || query.stop ? sql`b.add_time between ${query.start} and ${query.stop}` : sql`true`}
      and ${mode === 'commission' && query.keyword ? sql`(b.uid::text ilike ${pattern} or b.title ilike ${pattern}
        or o.account ilike ${pattern} or o.nickname ilike ${pattern} or o.phone ilike ${pattern})` : sql`true`}),
    page as (select * from filtered order by id desc limit ${query.limit} offset ${(query.page - 1) * query.limit}),
    projected as (select b.id,b.title,b.type,case when b.pm = 1 then 1 else 0 end as pm,round(b.number,2)::text as number,b.add_time,
      case when b.add_time <> 0 then to_char(to_timestamp(b.add_time) at time zone 'Asia/Shanghai','YYYY/MM/DD HH24:MI') else '' end as time,
      case when b.type = 'extract_money' then 1 when b.type in ('extract','extract_fail') and x.status in (-1,0,1) then x.status else null end as withdrawal_status,
      case when b.type in ('extract','extract_fail') and x.status = -1 then x.fail_msg else '' end as withdrawal_message
      from page b left join ${userExtract} x on x.uid = ${uid} and x.id = case
        when b.type in ('extract','extract_fail') and b.link_id ~ '^[0-9]{1,10}$' then
          case when b.link_id::numeric between 1 and 2147483647 then b.link_id::integer else null end else null end)
    select jsonb_build_object('count',(select count(*) from filtered),
      'income',${mode === 'commission' ? sql`(select round(coalesce(sum(number) filter(where pm = 1 and type <> 'extract_fail'),0),2)::text from filtered)` : sql`null::text`},
      'expend',${mode === 'commission' ? sql`(select round(coalesce(sum(number) filter(where pm = 0),0),2)::text from filtered)` : sql`null::text`},
      'list',coalesce((select jsonb_agg(to_jsonb(p) order by id desc) from projected p),'[]'::jsonb)) as data from owner
  `);
  if (!rows[0]) throw new NotFoundException('用户不存在或已被禁用');
  return rows[0].data;
}
