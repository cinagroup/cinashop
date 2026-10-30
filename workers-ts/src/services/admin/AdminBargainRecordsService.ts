import { sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { NotFoundException } from '@/utils/errors';
import { combinationStatisticsAvatar } from './AdminCombinationStatisticsInput';
import { combinationStatisticsOrderStatus } from './AdminCombinationStatisticsService';
import { bargainRecordId, bargainRecordsQuery, bargainHelpersQuery, bargainOrdersQuery, bargainRecordsLike } from './AdminBargainRecordsInput';

type Activity = { id: number; title: string; is_del: number };
type Identity = { uid: number; nickname: string | null; avatar: string | null; user_id: number | null; user_deleted: boolean | null };
type RecordRow = Identity & { id: number; bargain_id: number; bargain_price: string; bargain_price_min: string; price: string; now_price: string;
  status: number; effective_status: number; add_time: number; is_del: number; title: string | null; image: string | null;
  activity_id: number | null; activity_deleted: boolean | null; stop_epoch: string | null; people_num: number | null; already_num: number };
const identity = sql.raw('u.uid AS user_id,u.nickname,u.avatar,(u.is_del<>0 OR u.delete_time IS NOT NULL) AS user_deleted');
const join = sql.raw('public.store_bargain_user p LEFT JOIN public.store_bargain a ON a.id=p.bargain_id LEFT JOIN public."user" u ON u.uid=p.uid');
const effectiveStatus = sql.raw("CASE WHEN p.status=1 AND a.stop_time IS NOT NULL AND isfinite(a.stop_time) AND a.stop_time<transaction_timestamp() THEN 2 ELSE p.status END");
const conjunction = (items: Array<SQL | undefined>) => sql.join(items.filter((item): item is SQL => item !== undefined), sql` AND `);
function userIssues(row: Identity) {
  return row.user_id === null ? ['关联用户缺失，保留历史记录'] : row.user_deleted ? ['关联用户已注销，保留历史记录'] : [];
}
function iso(epoch: string | null) {
  if (epoch === null) return null;
  const date = new Date(Number(epoch) * 1000); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function paidRoots(id: number) { return sql`o.type=2 AND o.activity_id=${id} AND o.paid=1 AND o.pid IN(0,-1)`; }
function orderStatus(status?: number) {
  if (status === undefined) return undefined;
  if (status === 0) return sql`o.paid=0 AND o.status=0 AND o.refund_status=0 AND o.is_del=0`;
  const active = sql`o.is_del=0 AND o.refund_status IN(0,3)`;
  if (status === 1) return sql`${active} AND o.status IN(0,4) AND o.shipping_type IN(1,3)`;
  if (status === 2) return sql`${active} AND ((o.status IN(1,5) AND o.shipping_type=1) OR (o.status IN(0,5) AND o.shipping_type=2))`;
  if (status === 5) return sql`${active} AND o.status IN(0,1,5) AND o.shipping_type=2`;
  return sql`${active} AND o.status=${status === 3 ? 2 : 3}`;
}

/** Admin operational history. Every projection runs in a bounded consistent
 * read-only transaction; no participation settlement or order writer is called. */
export class AdminBargainRecordsService {
  constructor(private readonly container: Container) {}
  private read<T>(run: (tx: DbClient) => Promise<T>) {
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      return run(tx);
    });
  }
  private async activity(tx: DbClient, id: number) {
    const [row] = await tx.execute<Activity>(sql`SELECT id,coalesce(nullif(title,''),store_name) AS title,is_del FROM public.store_bargain WHERE id=${id}`);
    if (!row) throw new NotFoundException('砍价活动不存在'); return row;
  }
  async head(activityId: unknown) {
    const id = bargainRecordId(activityId);
    return this.read(async tx => {
      const activity = await this.activity(tx, id);
      const [help] = await tx.execute<{ people_count: number; spread_count: number }>(sql`SELECT count(*)::integer AS people_count,
        count(*) FILTER(WHERE type=0)::integer AS spread_count FROM public.store_bargain_user_help WHERE bargain_id=${id}`);
      const [records] = await tx.execute<{ start_count: number; success_count: number; ordered_count: number }>(sql`SELECT count(*)::integer AS start_count,
        count(*) FILTER(WHERE status=3)::integer AS success_count,count(*) FILTER(WHERE status=4)::integer AS ordered_count
        FROM public.store_bargain_user WHERE bargain_id=${id}`);
      // Gross paid root orders retain refunds/deletions as history. Split child
      // orders never double count the payment. Ratio preserves PHP's truncation.
      const [paid] = await tx.execute<{ pay_price: string; pay_count: number; pay_rate: string }>(sql`SELECT coalesce(sum(o.pay_price),0.00)::text AS pay_price,
        count(*)::integer AS pay_count,CASE WHEN ${records.start_count}::numeric>0 THEN
        (trunc(count(*)::numeric/${records.start_count}::numeric,2)*100)::numeric(20,2)::text ELSE '0.00' END AS pay_rate
        FROM public.store_order o WHERE ${paidRoots(id)}`);
      return { id, title: activity.title, activity_deleted: activity.is_del !== 0, ...help, ...records, ...paid };
    });
  }
  async records(parameters: URLSearchParams, activityId?: unknown) {
    const query = bargainRecordsQuery(parameters, activityId);
    return this.read(async tx => {
      if (query.bargainId !== undefined) await this.activity(tx, query.bargainId);
      const pattern = bargainRecordsLike(query.keyword);
      const where = conjunction([sql`TRUE`, query.bargainId === undefined ? undefined : sql`p.bargain_id=${query.bargainId}`,
        query.status === undefined ? undefined : sql`${effectiveStatus}=${query.status}`,
        query.start === undefined ? undefined : sql`p.add_time>=${query.start}::bigint`, query.stop === undefined ? undefined : sql`p.add_time<${query.stop}::bigint`,
        query.keyword ? sql`(p.uid::text ILIKE ${pattern} OR p.id::text ILIKE ${pattern} OR u.nickname ILIKE ${pattern}
          OR u.phone ILIKE ${pattern} OR a.title ILIKE ${pattern} OR a.store_name ILIKE ${pattern})` : undefined]);
      const [total] = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM ${join} WHERE ${where}`);
      const rows = await tx.execute<RecordRow>(sql`SELECT p.id,p.uid,p.bargain_id,p.bargain_price::text,p.bargain_price_min::text,p.price::text,
        (p.bargain_price-p.price)::text AS now_price,p.status,${effectiveStatus} AS effective_status,p.add_time,p.is_del,${identity},
        coalesce(nullif(a.title,''),a.store_name) AS title,a.image,a.id AS activity_id,a.is_del<>0 AS activity_deleted,a.people AS people_num,
        CASE WHEN a.stop_time IS NOT NULL AND isfinite(a.stop_time) THEN extract(epoch FROM a.stop_time)::text ELSE NULL END AS stop_epoch,
        (SELECT count(*)::integer FROM public.store_bargain_user_help h WHERE h.bargain_user_id=p.id AND h.bargain_id=p.bargain_id) AS already_num
        FROM ${join} WHERE ${where} ORDER BY p.add_time DESC,p.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      return { list: rows.map(row => {
        const issues = userIssues(row);
        if (row.activity_id === null) issues.push('关联活动缺失，保留参与历史'); else if (row.activity_deleted) issues.push('活动已删除，保留参与历史');
        if (row.is_del) issues.push('参与记录已取消或删除，保留历史');
        if (![1,2,3,4].includes(row.status)) issues.push('历史参与状态无效');
        if (!iso(row.stop_epoch)) issues.push('活动结束时间缺失或无效');
        if (Number(row.now_price) < Number(row.bargain_price_min) || Number(row.price) < 0) issues.push('历史金额快照异常');
        return { id: row.id, bargain_id: row.bargain_id, uid: row.uid, title: row.title ?? '', image_preview: combinationStatisticsAvatar(row.image ?? ''),
          nickname: row.nickname ?? '', avatar_preview: combinationStatisticsAvatar(row.avatar ?? ''), bargain_price: row.bargain_price,
          bargain_price_min: row.bargain_price_min, price: row.price, now_price: row.now_price, people_num: row.people_num ?? 0,
          already_num: row.already_num, num: Math.max(0, (row.people_num ?? 0) - row.already_num), status: row.effective_status, status_raw: row.status,
          expired_pending: row.status === 1 && row.effective_status === 2, add_time: row.add_time, stop_time: iso(row.stop_epoch),
          deleted_user: Boolean(row.user_deleted), missing_user: row.user_id === null, activity_deleted: Boolean(row.activity_deleted),
          activity_missing: row.activity_id === null, is_del: row.is_del, issues };
      }), count: total.count, page: query.page, limit: query.limit };
    });
  }
  async helpers(recordId: unknown, parameters: URLSearchParams, activityId?: unknown) {
    const id = bargainRecordId(recordId, '砍价参与记录ID'), query = bargainHelpersQuery(parameters);
    const scope = activityId === undefined ? undefined : bargainRecordId(activityId);
    return this.read(async tx => {
      const [record] = await tx.execute<{ bargain_id: number }>(sql`SELECT bargain_id FROM public.store_bargain_user WHERE id=${id}${scope === undefined ? sql`` : sql` AND bargain_id=${scope}`}`);
      if (!record) throw new NotFoundException('砍价参与记录不存在');
      const where = sql`h.bargain_user_id=${id} AND h.bargain_id=${record.bargain_id}`;
      const [total] = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM public.store_bargain_user_help h WHERE ${where}`);
      const rows = await tx.execute<Identity & { id: number; price: string; type: number; add_time: number }>(sql`SELECT h.id,h.uid,h.price::text,h.type,h.add_time,${identity}
        FROM public.store_bargain_user_help h LEFT JOIN public."user" u ON u.uid=h.uid WHERE ${where}
        ORDER BY h.add_time DESC,h.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      return { record_id: id, bargain_id: record.bargain_id, list: rows.map(row => ({ id: row.id, uid: row.uid, price: row.price, type: row.type,
        add_time: row.add_time, nickname: row.nickname ?? '', avatar_preview: combinationStatisticsAvatar(row.avatar ?? ''),
        deleted_user: Boolean(row.user_deleted), missing_user: row.user_id === null,
        issues: [...userIssues(row), ...([0,1].includes(row.type) ? [] : ['历史帮砍类型无效'])] })), count: total.count, page: query.page, limit: query.limit };
    });
  }
  async orders(activityId: unknown, parameters: URLSearchParams) {
    const id = bargainRecordId(activityId), query = bargainOrdersQuery(parameters);
    return this.read(async tx => {
      await this.activity(tx, id);
      const pattern = bargainRecordsLike(query.keyword);
      const search = query.keyword ? sql`(o.order_id ILIKE ${pattern} OR o.real_name ILIKE ${pattern} OR o.user_phone ILIKE ${pattern}
        OR o.uid::text ILIKE ${pattern} OR EXISTS(SELECT 1 FROM public."user" searched WHERE searched.uid=o.uid
          AND (searched.nickname ILIKE ${pattern} OR searched.phone ILIKE ${pattern}))
        OR EXISTS(SELECT 1 FROM public.user_address address WHERE address.uid=o.uid AND (address.real_name ILIKE ${pattern} OR address.phone ILIKE ${pattern}))
        OR EXISTS(SELECT 1 FROM public.store_order_cart_info cart JOIN public.store_product product ON product.id=cart.product_id WHERE cart.oid=o.id
          AND (product.store_name ILIKE ${pattern} OR product.keyword ILIKE ${pattern}))
        OR EXISTS(SELECT 1 FROM public.store_bargain a WHERE a.id=o.activity_id AND (a.title ILIKE ${pattern} OR a.store_name ILIKE ${pattern} OR a.info ILIKE ${pattern})))` : undefined;
      const where = conjunction([paidRoots(id), orderStatus(query.status), search]);
      const [total] = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM public.store_order o WHERE ${where}`);
      const rows = await tx.execute<{ id: number; order_id: string; uid: number; real_name: string; user_phone: string; nickname: string | null;
        pay_price: string; total_num: number; add_time: number; pay_time: number; paid: number; status: number; shipping_type: number;
        refund_status: number; refund_type: number; pid: number; is_del: number; is_system_del: number }>(sql`SELECT o.id,o.order_id,o.uid,o.real_name,o.user_phone,u.nickname,
        o.pay_price::text,o.total_num,o.add_time,o.pay_time,o.paid,o.status,o.shipping_type,o.refund_status,o.refund_type,o.pid,o.is_del,o.is_system_del
        FROM public.store_order o LEFT JOIN public."user" u ON u.uid=o.uid WHERE ${where}
        ORDER BY o.add_time DESC,o.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      return { id, bargain_id: id, list: rows.map(row => {
        const deleted = Boolean(row.is_del || row.is_system_del);
        return { id: row.id, order_id: row.order_id, uid: row.uid, real_name: row.real_name, user_phone: row.user_phone, nickname: row.nickname ?? '',
          pay_price: row.pay_price, total_num: row.total_num, add_time: row.add_time, pay_time: row.pay_time,
          status: combinationStatisticsOrderStatus(row), status_raw: row.status, shipping_type: row.shipping_type,
          refund_status: row.refund_status, refund_type: row.refund_type, parent_id: row.pid, deleted,
          detail_available: !deleted && row.order_id !== '' && row.order_id !== '0', issues: deleted ? ['订单已删除，保留支付历史，不能打开详情'] : [] };
      }), count: total.count, page: query.page, limit: query.limit };
    });
  }
}
