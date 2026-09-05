import { sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import type { Env } from "@/env";
import { user, userBill, userBrokerage, userExtract, userSpread, storeOrder } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { signAttachmentReferences } from "@/services/system/AttachmentService";
import { parseLegacyUserLedgerQuery } from "./V2UserCompatibilityService";

type JsonRecord = Record<string, unknown>;
type ReadResult = JsonRecord & { list?: JsonRecord[]; rank?: JsonRecord[] | number };
const SHANGHAI_OFFSET = 28_800;

/** Stable business-clock boundaries; never use the Worker/host local timezone. */
export function financeRankPeriod(type: unknown, now: number) {
  if (type !== undefined && type !== "" && type !== "week" && type !== "month") {
    throw new ValidateException("排行周期仅支持week或month");
  }
  const local = new Date((now + SHANGHAI_OFFSET) * 1_000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) / 1_000 - SHANGHAI_OFFSET;
  const week = midnight - ((local.getUTCDay() + 6) % 7) * 86_400;
  const month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) / 1_000 - SHANGHAI_OFFSET;
  // PHP's `strtotime('last month')` is a rolling calendar-month statistic, not month-to-date.
  const previous = new Date(local);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  return { start: type === "week" ? week : type === "month" ? month : 0, stop: now, week, previousMonth: previous.getTime() / 1_000 - SHANGHAI_OFFSET };
}

export function parseFinanceReadQuery(raw: JsonRecord) {
  const query = parseLegacyUserLedgerQuery(raw);
  query.limit = raw.limit === undefined || raw.limit === "" ? 20 : query.limit;
  query.start = Math.min(query.start, 2_147_483_647);
  query.stop = Math.min(query.stop, 2_147_483_647);
  return { ...query, offset: Math.min((query.page - 1) * query.limit, 10_000) };
}

function safeAvatar(value: unknown): string {
  const text = String(value ?? "").trim();
  if (/[\u0000-\u0020\u007f\\]/.test(text)) return "";
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? text : "";
  } catch { return ""; }
}

/** Six PHP read contracts. Each ledger/report is one SQL statement/snapshot, not N+1 queries. */
export class UserFinanceReadService {
  constructor(private readonly container: Container, private readonly env: Env) {}

  private async result(statement: SQL): Promise<ReadResult> {
    const rows = await this.container.db.execute<{ data: ReadResult }>(statement);
    return rows[0]?.data ?? {};
  }

  private async account(uid: number) {
    const rows = await this.container.db.execute<{ nickname: string; avatar: string }>(sql`
      select nickname, avatar from ${user}
      where uid = ${uid} and status = 1 and is_del = 0 and delete_time is null limit 1
    `);
    if (!rows[0]) throw new NotFoundException("数据不存在");
    return rows[0];
  }

  private async avatars(result: ReadResult): Promise<ReadResult> {
    const records = [result, ...(result.list ?? []), ...(Array.isArray(result.rank) ? result.rank : [])];
    const fields = records.filter((record) => Object.hasOwn(record, "avatar"));
    const references = fields.map((record) => safeAvatar(record.avatar));
    const signed = this.env.APP_KEY ? await signAttachmentReferences(this.env.APP_KEY, references) : references;
    fields.forEach((record, index) => { record.avatar = signed[index]; });
    return result;
  }

  async integralList(uid: number, raw: JsonRecord) {
    const { limit, offset } = parseFinanceReadQuery(raw);
    return this.result(sql`
      with owned as (select * from ${userBill} where uid = ${uid} and category = 'integral'),
      page as (select * from owned order by id desc limit ${limit} offset ${offset}),
      projected as (
        select id, uid, link_id, pm, title, category, type, mark, status, take, frozen_time,
          trunc(number)::bigint as number, trunc(balance)::bigint as balance,
          case when add_time > 0 then to_char(to_timestamp(add_time) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') else '' end as add_time,
          case when add_time > 0 then to_char(to_timestamp(add_time) at time zone 'Asia/Shanghai', 'YYYY-MM') else '' end as time_key,
          case when add_time > 0 then to_char(to_timestamp(add_time) at time zone 'Asia/Shanghai', 'YYYY-MM') else '' end as time,
          case when add_time > 0 then to_char(to_timestamp(add_time) at time zone 'Asia/Shanghai', 'YYYY-MM-DD') else '' end as day
        from page
      )
      select jsonb_build_object(
        'list', coalesce((select jsonb_agg(to_jsonb(p) order by id desc) from projected p), '[]'::jsonb),
        'count', (select count(*) from owned),
        'times', coalesce((select jsonb_agg(time_key order by last_id desc) from
          (select time_key, max(id) as last_id from projected group by time_key) m), '[]'::jsonb)
      ) as data
    `);
  }

  async extractBank(uid: number, now = Math.floor(Date.now() / 1_000)) {
    const [rows, config] = await Promise.all([
      this.container.db.execute<{ brokerage_price: string; broken_commission: string; commissionCount: string }>(sql`
        select u.brokerage_price::text as brokerage_price, round(f.frozen, 2)::text as broken_commission,
          round(u.brokerage_price - f.frozen, 2)::text as "commissionCount"
        from ${user} u cross join lateral (
          select greatest(coalesce(sum(number), 0), 0) as frozen
          from ${userBrokerage} where uid = u.uid and status = 1 and pm = 1 and frozen_time > ${now}
        ) f where u.uid = ${uid} and u.status = 1 and u.is_del = 0 and u.delete_time is null
      `),
      new SystemConfigService(this.container, this.env).getMany([
        "user_extract_bank", "user_extract_min_price", "user_extract_max_price", "withdraw_fee",
        "brokerage_type", "user_extract_balance_status",
      ]),
    ]);
    if (!rows[0]) throw new NotFoundException("数据不存在");
    let banks: unknown = config.user_extract_bank;
    try { banks = JSON.parse(String(banks)); } catch { /* Plain multiline PHP configuration. */ }
    const bankText = Array.isArray(banks) ? banks[0] : banks;
    return {
      ...rows[0],
      extractBank: String(bankText ?? "").replaceAll("\r\n", "\n").split("\n").map((v) => v.trim()).filter(Boolean),
      minPrice: config.user_extract_min_price || "0",
      maxPrice: config.user_extract_max_price || "0",
      withdraw_fee: config.withdraw_fee || "0",
      extract_wechat_type: Number(config.brokerage_type || 0),
      user_extract_balance_status: Number(config.user_extract_balance_status || 1),
    };
  }

  async spreadCount(uid: number, type: string) {
    await this.account(uid);
    if (type === "3") return this.result(sql`
      select jsonb_build_object('count', coalesce(sum(case when pm = 1 then number else -number end), 0)) as data
      from ${userBrokerage} where uid = ${uid} and status = 1 and pm in (0, 1)
    `);
    if (type === "4") return this.result(sql`
      select jsonb_build_object('count', coalesce(sum(extract_price), 0)) as data
      from ${userExtract} where uid = ${uid} and status in (0, 1)
    `);
    return { count: 0 };
  }

  async brokerageRank(uid: number, raw: JsonRecord, now = Math.floor(Date.now() / 1_000)) {
    const profile = await this.account(uid);
    const { start, stop } = financeRankPeriod(raw.type, now);
    const { limit, offset } = parseFinanceReadQuery(raw);
    const result = await this.result(sql`
      with totals as (
        select b.uid, sum(b.number) as brokerage_price from ${userBrokerage} b
        inner join ${user} u on u.uid = b.uid and u.status = 1 and u.is_del = 0 and u.delete_time is null
        where b.pm = 1 and b.type not in ('extract_fail', 'refund') and b.add_time between ${start} and ${stop}
        group by b.uid having sum(b.number) > 0
      ), ranked as (
        select *, row_number() over (order by brokerage_price desc, uid desc) as position from totals
      ), page as (
        select r.uid, r.brokerage_price::text as brokerage_price, u.nickname, u.avatar, r.position
        from ranked r inner join ${user} u on u.uid = r.uid
        order by r.position limit ${limit} offset ${offset}
      )
      select jsonb_build_object(
        'rank', coalesce((select jsonb_agg(to_jsonb(p) - 'position' order by position) from page p), '[]'::jsonb),
        'position', coalesce((select position from ranked where uid = ${uid}), 0),
        'brokerage_price', coalesce((select brokerage_price::text from ranked where uid = ${uid}), '0.00')
      ) as data
    `);
    return this.avatars({ ...result, ...profile });
  }

  async spreadRank(uid: number, raw: JsonRecord, now = Math.floor(Date.now() / 1_000)) {
    const [profile, avatar] = await Promise.all([
      this.account(uid), new SystemConfigService(this.container, this.env).get("h5_avatar"),
    ]);
    const { start, stop, week, previousMonth } = financeRankPeriod(raw.type, now);
    const { limit, offset } = parseFinanceReadQuery(raw);
    const result = await this.result(sql`
      with totals as (
        select s.spread_uid, count(s.uid) as count, max(s.spread_time) as spread_time
        from ${userSpread} s inner join ${user} u on u.uid = s.spread_uid
          and u.status = 1 and u.is_del = 0 and u.delete_time is null
        where s.spread_time between ${start} and ${stop} group by s.spread_uid
      ), ranked as (
        select *, row_number() over (order by count desc, spread_uid desc) as position from totals
      ), page as (
        select r.*, coalesce(nullif(u.nickname, ''), '神秘人') as nickname,
          coalesce(nullif(u.avatar, ''), ${avatar}) as avatar
        from ranked r inner join ${user} u on u.uid = r.spread_uid
        order by r.position limit ${limit} offset ${offset}
      )
      select jsonb_build_object(
        'list', coalesce((select jsonb_agg(to_jsonb(p) - 'position' order by position) from page p), '[]'::jsonb),
        'rank', coalesce((select position from ranked where spread_uid = ${uid}), 0),
        'week', (select count(*) from ${userSpread} where spread_uid = ${uid} and spread_time between ${week} and ${stop}),
        'month', (select count(*) from ${userSpread} where spread_uid = ${uid} and spread_time between ${previousMonth} and ${stop}),
        'start', to_char(to_timestamp(${start}) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI'),
        'end', to_char(to_timestamp(${stop}) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI')
      ) as data
    `);
    return this.avatars({ ...result, ...profile, uid });
  }

  async spreadOrder(uid: number, raw: JsonRecord, now = Math.floor(Date.now() / 1_000)) {
    await this.account(uid);
    const { start, stop, keyword, limit, offset } = parseFinanceReadQuery(raw);
    const pattern = `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
    const time = sql`${start === 0 ? sql`true` : sql`o.add_time >= ${start}`} and ${stop === 0 ? sql`true` : sql`o.add_time <= ${stop}`}`;
    // The PHP search spans buyer/contact/product fields, but the response never exposes contacts.
    const search = keyword ? sql`(
      o.order_id ilike ${pattern} or o.real_name ilike ${pattern} or o.user_phone ilike ${pattern}
      or exists (select 1 from "user" b where b.uid = o.uid and
        (b.nickname ilike ${pattern} or b.uid::text ilike ${pattern} or b.phone ilike ${pattern}))
      or exists (select 1 from user_address a where a.uid = o.uid and
        (a.real_name ilike ${pattern} or a.uid::text ilike ${pattern} or a.phone ilike ${pattern}))
      or exists (select 1 from store_order_cart_info c join store_product p on p.id = c.product_id
        where c.oid = o.id and (p.store_name ilike ${pattern} or p.keyword ilike ${pattern}))
      or exists (select 1 from store_seckill a where a.id = o.activity_id and (a.store_name ilike ${pattern} or a.info ilike ${pattern}))
      or exists (select 1 from store_bargain a where a.id = o.activity_id and (a.title ilike ${pattern} or a.info ilike ${pattern}))
      or exists (select 1 from store_combination a where a.id = o.activity_id and (a.store_name ilike ${pattern} or a.info ilike ${pattern}))
    )` : sql`true`;
    return this.avatars(await this.result(sql`
      with eligible as (
        select o.id, o.order_id, o.uid, o.add_time, o.spread_uid, o.status, o.spread_two_uid,
          o.one_brokerage, o.two_brokerage, o.pay_price, o.cart_id, o.division_id, o.division_brokerage,
          o.division_agent_id, o.division_agent_brokerage, o.division_staff_id, o.division_staff_brokerage,
          o.real_name, o.user_phone, o.activity_id
        from ${storeOrder} o where o.pid = 0 and o.type = 0 and o.paid = 1
          and o.refund_status in (0, 3) and o.is_del = 0 and o.is_system_del = 0 and ${time}
          and (o.spread_uid = ${uid} or o.spread_two_uid = ${uid} or o.division_id = ${uid}
            or o.division_agent_id = ${uid} or o.division_staff_id = ${uid})
      ), matched as (select o.* from eligible o where ${search}),
      page as (select * from matched order by id desc limit ${limit} offset ${offset}),
      projected as (
        select p.id, p.order_id, p.uid, p.add_time, p.spread_uid, p.status, p.spread_two_uid,
          p.one_brokerage::text, p.two_brokerage::text, p.pay_price::text,
          case when p.cart_id is json array then p.cart_id::jsonb else '[]'::jsonb end as cart_id,
          p.division_id, p.division_brokerage::text, p.division_agent_id, p.division_agent_brokerage::text,
          p.division_staff_id, p.division_staff_brokerage::text,
          coalesce(u.avatar, '') as avatar, coalesce(u.nickname, '') as nickname,
          (case when p.division_staff_id = ${uid} then p.division_staff_brokerage
            when p.division_agent_id = ${uid} then p.division_agent_brokerage
            when p.division_id = ${uid} then p.division_brokerage
            when p.spread_uid = ${uid} then p.one_brokerage else p.two_brokerage end)::text as number,
          case when p.add_time > 0 then to_char(to_timestamp(p.add_time) at time zone 'Asia/Shanghai', 'YYYY-MM') else '' end as time_key,
          case when p.status in (2, 3) then 'brokerage' else 'number' end as type,
          case when coalesce(b.add_time, p.add_time) > 0 then to_char(to_timestamp(coalesce(b.add_time, p.add_time)) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') else '' end as time,
          case when b.frozen_time > ${now} then 1 else 0 end as is_frozen,
          coalesce(t.store_name, '') as store_name
        from page p left join ${user} u on u.uid = p.uid and u.is_del = 0 and u.delete_time is null
        left join lateral (select b.add_time, b.frozen_time from ${userBrokerage} b
          where b.uid = ${uid} and b.link_id = p.id::text and b.pm = 1
            and b.type in ('self_brokerage', 'one_brokerage', 'two_brokerage', 'staff_brokerage', 'agent_brokerage', 'division_brokerage')
          order by b.id desc limit 1) b on true
        left join lateral (select string_agg(title, '|' order by id) as store_name from
          (select c.id, case when c.cart_info is json object then
            coalesce(c.cart_info::jsonb #>> '{productInfo,store_name}', c.cart_info::jsonb #>> '{productInfo,storeName}') end as title
            from store_order_cart_info c where c.oid = p.id) snapshots) t on true
      ), months as (
        select case when add_time > 0 then to_char(to_timestamp(add_time) at time zone 'Asia/Shanghai', 'YYYY-MM') else '' end as time,
          count(*) as count, sum(pay_price)::text as "sumPrice"
        from matched group by time
      )
      select jsonb_build_object(
        'list', coalesce((select jsonb_agg(to_jsonb(p) order by id desc) from projected p), '[]'::jsonb),
        'count', (select count(*) from matched),
        'time', coalesce((select jsonb_agg(to_jsonb(m) order by time desc) from months m
          where m.time in (select time_key from projected)), '[]'::jsonb),
        'sum_brokerage', (select round(coalesce(sum(
          case when spread_uid = ${uid} then one_brokerage else 0 end +
          case when spread_two_uid = ${uid} then two_brokerage else 0 end +
          case when division_id = ${uid} then division_brokerage else 0 end +
          case when division_agent_id = ${uid} then division_agent_brokerage else 0 end +
          case when division_staff_id = ${uid} then division_staff_brokerage else 0 end), 0), 2)::text from eligible)
      ) as data
    `));
  }
}
