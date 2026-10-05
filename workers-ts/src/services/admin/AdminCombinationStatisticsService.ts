import { sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { NotFoundException } from '@/utils/errors';
import { combinationGroupsQuery, combinationMembersQuery, combinationOrdersQuery, combinationStatisticsAvatar,
  combinationStatisticsId, combinationStatisticsLike } from './AdminCombinationStatisticsInput';

type Activity = { id: number; store_name: string; is_del: number };
type Pink = {
  id: number; uid: number; nickname: string; avatar: string; combination_id: number; product_id: number; k_id: number;
  people: number; member_count: number; price: string; status: number; is_refund: number; is_virtual: number;
  order_id: string; order_id_key: string; add_time: number; stop_time_epoch: string | null; stop_time_present: boolean;
  user_id: number | null; user_deleted: boolean | null;
};
type Group = Pink & { title: string | null; activity_id: number | null; activity_deleted: boolean | null;
  participant_record_count: number; active_real_count: number; virtual_count: number };
type OrderMatch = { id: number; order_id: string; is_del: number; is_system_del: number };

const pinkColumns = sql.raw(`p.id,p.uid,p.nickname,p.avatar,p.combination_id,p.product_id,p.k_id,p.people,p.member_count,p.price::text,
  p.status,p.is_refund,p.is_virtual,p.order_id,p.order_id_key,p.add_time,
  CASE WHEN p.stop_time IS NOT NULL AND isfinite(p.stop_time) THEN extract(epoch FROM p.stop_time)::text ELSE NULL END AS stop_time_epoch,
  p.stop_time IS NOT NULL AS stop_time_present,u.uid AS user_id,(u.is_del<>0 OR u.delete_time IS NOT NULL) AS user_deleted`);
const pinkUsers = sql.raw('public.store_pink p LEFT JOIN public."user" u ON u.uid=p.uid');
function stopTime(row: Pink) {
  if (row.stop_time_epoch === null) return null;
  const value = new Date(Number(row.stop_time_epoch) * 1000);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}
function pinkIssues(row: Pink) {
  const issues: string[] = [];
  if (row.is_virtual === 1) issues.push('虚拟补员，不代表真实用户或支付订单');
  else if (row.is_virtual !== 0) issues.push('历史虚拟标记无效');
  if (row.uid <= 0 && row.is_virtual !== 1) issues.push('历史记录缺少有效用户身份');
  if (row.uid > 0 && row.user_id === null) issues.push('关联用户缺失，保留拼团快照');
  if (row.uid > 0 && row.user_deleted) issues.push('关联用户已注销，保留拼团快照');
  if (row.is_refund !== 0) issues.push('已退款成员，保留历史记录');
  if (row.combination_id <= 0 || row.product_id <= 0) issues.push('历史活动或商品身份无效');
  if (![1, 2, 3].includes(row.status)) issues.push('历史拼团状态无效');
  if (row.people < 2 || row.member_count < 0) issues.push('历史人数配置无效');
  if (!stopTime(row)) issues.push(row.stop_time_present ? '历史结束时间无效' : '历史结束时间缺失');
  if (row.avatar && !combinationStatisticsAvatar(row.avatar)) issues.push('头像不是可公开预览地址');
  return issues;
}
function conjunction(values: Array<SQL | undefined>) { return sql.join(values.filter((value): value is SQL => value !== undefined), sql` AND `); }
function paidRoots(id: number) { return sql`o.type=3 AND o.activity_id=${id} AND o.paid=1 AND o.pid IN(0,-1)`; }
function orderFilter(status?: number): SQL | undefined {
  if (status === undefined) return undefined;
  if (status === 0) return sql`o.paid=0 AND o.status=0 AND o.refund_status=0 AND o.is_del=0`;
  const active = sql`o.is_del=0 AND o.refund_status IN(0,3)`;
  if (status === 1) return sql`${active} AND o.status IN(0,4) AND o.shipping_type IN(1,3)`;
  if (status === 2) return sql`${active} AND ((o.status IN(1,5) AND o.shipping_type=1) OR (o.status IN(0,5) AND o.shipping_type=2))`;
  if (status === 5) return sql`${active} AND o.status IN(0,1,5) AND o.shipping_type=2`;
  return sql`${active} AND o.status=${status === 3 ? 2 : 3}`;
}
export function combinationStatisticsOrderStatus(row: { is_del: number; is_system_del: number; paid: number; status: number; shipping_type: number; refund_status: number }) {
  if (row.is_del || row.is_system_del) return '已删除';
  if (!row.paid) return '待付款';
  if (row.status === 4 && [1, 3].includes(row.shipping_type) && row.refund_status === 0) return '部分发货';
  if (row.refund_status === 2) return '已退款';
  if (row.status === 5 && row.refund_status === 0) return row.shipping_type === 2 ? '部分核销' : '部分收货';
  if (row.refund_status === 1) return '申请退款';
  if (row.refund_status === 4) return '退款中';
  if (row.status === 0 && [1, 3].includes(row.shipping_type) && row.refund_status === 0) return '未发货';
  if ([0, 1].includes(row.status) && row.shipping_type === 2 && row.refund_status === 0) return '未核销';
  if ([1, 5].includes(row.status) && [1, 3].includes(row.shipping_type) && row.refund_status === 0) return '待收货';
  if (row.status === 2 && row.refund_status === 0) return '待评价';
  if (row.status === 3 && row.refund_status === 0) return '已完成';
  if (row.refund_status === 3) return '部分退款';
  return '未知';
}

/** Historical operational reads only. No timeout settlement, provider, audit
 * append, row/advisory lock or catalogue mutation is reachable from this class. */
export class AdminCombinationStatisticsService {
  constructor(private readonly container: Container) {}
  private async read<T>(run: (tx: DbClient) => Promise<T>) {
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
    const [row] = await tx.execute<Activity>(sql`SELECT id,store_name,is_del FROM public.store_combination WHERE id=${id}`);
    if (!row) throw new NotFoundException('拼团活动不存在');
    return row;
  }
  async globalHead() {
    return this.read(async tx => {
      const [row] = await tx.execute<{ participant_record_count: number; success_count: number }>(sql`SELECT count(*)::integer AS participant_record_count,
        count(*) FILTER(WHERE k_id=0 AND status=2)::integer AS success_count FROM public.store_pink`);
      return row;
    });
  }
  async head(combinationId: unknown) {
    const id = combinationStatisticsId(combinationId);
    return this.read(async tx => {
      const activity = await this.activity(tx, id);
      const [pink] = await tx.execute<{ people_count: number; spread_count: number; start_count: number; success_count: number }>(sql`SELECT
        count(DISTINCT uid)::integer AS people_count,count(DISTINCT uid) FILTER(WHERE k_id>0)::integer AS spread_count,
        count(*) FILTER(WHERE k_id=0)::integer AS start_count,count(*) FILTER(WHERE k_id=0 AND status=2)::integer AS success_count
        FROM public.store_pink WHERE combination_id=${id}`);
      const [orders] = await tx.execute<{ pay_price: string; pay_count: number }>(sql`SELECT coalesce(sum(o.pay_price),0.00)::text AS pay_price,
        count(DISTINCT o.uid)::integer AS pay_count FROM public.store_order o WHERE ${paidRoots(id)}`);
      return { id, store_name: activity.store_name, activity_deleted: activity.is_del !== 0, ...pink, ...orders };
    });
  }
  async groups(parameters: URLSearchParams, combinationId?: unknown) {
    const query = combinationGroupsQuery(parameters, combinationId);
    return this.read(async tx => {
      if (query.combinationId !== undefined) await this.activity(tx, query.combinationId);
      const [clock] = await tx.execute<{ now: number }>(sql`SELECT extract(epoch FROM transaction_timestamp())::double precision AS now`);
      const pattern = combinationStatisticsLike(query.keyword);
      const where = conjunction([sql`p.k_id=0`, query.combinationId === undefined ? undefined : sql`p.combination_id=${query.combinationId}`,
        query.status === undefined ? undefined : sql`p.status=${query.status}`,
        query.start === undefined ? undefined : sql`p.add_time>=${query.start}::bigint`, query.stop === undefined ? undefined : sql`p.add_time<${query.stop}::bigint`,
        query.keyword ? sql`(p.nickname ILIKE ${pattern} OR p.uid::text ILIKE ${pattern} OR u.phone ILIKE ${pattern} OR a.store_name ILIKE ${pattern})` : undefined]);
      const from = sql`${pinkUsers} LEFT JOIN public.store_combination a ON a.id=p.combination_id`;
      const [total] = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM ${from} WHERE ${where}`);
      const rows = await tx.execute<Group>(sql`SELECT ${pinkColumns},a.store_name AS title,a.id AS activity_id,a.is_del<>0 AS activity_deleted,
        (SELECT count(*)::integer FROM public.store_pink m WHERE m.combination_id=p.combination_id AND (m.id=p.id OR m.k_id=p.id)) AS participant_record_count,
        (SELECT count(*)::integer FROM public.store_pink m WHERE m.combination_id=p.combination_id AND (m.id=p.id OR m.k_id=p.id)
          AND m.uid>0 AND m.is_virtual=0 AND m.is_refund=0) AS active_real_count,
        (SELECT count(*)::integer FROM public.store_pink m WHERE m.combination_id=p.combination_id AND (m.id=p.id OR m.k_id=p.id) AND m.is_virtual=1) AS virtual_count
        FROM ${from} WHERE ${where} ORDER BY p.add_time DESC,p.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      return { list: rows.map(row => ({ id: row.id, combination_id: row.combination_id, product_id: row.product_id, uid: row.uid,
        nickname: row.nickname, avatar_preview: combinationStatisticsAvatar(row.avatar), title: row.title ?? '', people: row.people,
        member_count_raw: row.member_count, participant_record_count: row.participant_record_count, active_real_count: row.active_real_count,
        virtual_count: row.virtual_count, status: row.status, status_raw: row.status, is_refund: row.is_refund,
        expired_pending: row.status === 1 && row.stop_time_epoch !== null && Number(row.stop_time_epoch) < clock.now,
        add_time: row.add_time, stop_time: stopTime(row), deleted_user: row.uid > 0 && Boolean(row.user_deleted),
        missing_user: row.uid > 0 && row.user_id === null, activity_deleted: Boolean(row.activity_deleted), activity_missing: row.activity_id === null,
        issues: [...pinkIssues(row), ...(row.activity_id === null ? ['关联活动缺失，保留团历史'] : row.activity_deleted ? ['活动已删除，保留团历史'] : [])] })),
        count: total.count, page: query.page, limit: query.limit };
    });
  }
  async members(groupId: unknown, parameters: URLSearchParams, scopeCombinationId?: unknown) {
    const id = combinationStatisticsId(groupId, '拼团团长ID'), query = combinationMembersQuery(parameters);
    const scope = scopeCombinationId === undefined ? undefined : combinationStatisticsId(scopeCombinationId);
    return this.read(async tx => {
      if (scope !== undefined) await this.activity(tx, scope);
      const [leader] = await tx.execute<Pink>(sql`SELECT ${pinkColumns} FROM ${pinkUsers} WHERE p.id=${id}${scope === undefined ? sql`` : sql` AND p.combination_id=${scope}`}`);
      if (!leader || (leader.k_id !== 0 && leader.is_refund === 0)) throw new NotFoundException('拼团团长记录不存在');
      const [activity] = await tx.execute<Activity>(sql`SELECT id,store_name,is_del FROM public.store_combination WHERE id=${leader.combination_id}`);
      const activityIssues = !activity ? ['关联活动缺失，保留团历史'] : activity.is_del !== 0 ? ['活动已删除，保留团历史'] : [];
      const where = sql`p.combination_id=${leader.combination_id} AND (p.id=${id} OR (p.k_id=${id} AND p.is_refund=0))`;
      const [total] = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM public.store_pink p WHERE ${where}`);
      const rows = await tx.execute<Pink & { order_matches: OrderMatch[] }>(sql`SELECT ${pinkColumns},coalesce((SELECT jsonb_agg(to_jsonb(candidate)) FROM (
        SELECT o.id,o.order_id,o.is_del,o.is_system_del FROM public.store_order o
        WHERE p.uid>0 AND p.is_virtual=0 AND p.combination_id>0 AND p.product_id>0
          AND p.product_id=${leader.product_id} AND p.people=${leader.people}
          AND o.uid=p.uid AND o.type=3 AND o.activity_id=p.combination_id
          AND o.pink_id=CASE WHEN p.k_id=0 THEN p.id ELSE p.k_id END
          AND (p.order_id NOT IN('','0') OR p.order_id_key NOT IN('','0'))
          AND (p.order_id IN('','0') OR o.order_id=p.order_id)
          AND (p.order_id_key IN('','0') OR p.order_id_key=o.id::text OR p.order_id_key=o."unique")
        ORDER BY o.id LIMIT 2) candidate),'[]'::jsonb) AS order_matches FROM ${pinkUsers}
        WHERE ${where} ORDER BY p.add_time DESC,p.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      let replacement: number | null = null;
      if (leader.is_refund > 0 && leader.is_refund !== id) {
        const [row] = await tx.execute<{ id: number }>(sql`SELECT id FROM public.store_pink WHERE id=${leader.is_refund}
          AND combination_id=${leader.combination_id} AND product_id=${leader.product_id} AND k_id=0`);
        replacement = row?.id ?? null;
      }
      return { group_id: id, combination_id: leader.combination_id, replacement_leader_id: replacement,
        list: rows.map(row => {
          const issues = [...pinkIssues(row), ...activityIssues], order = row.order_matches.length === 1 ? row.order_matches[0] : undefined;
          if (row.product_id !== leader.product_id || row.people !== leader.people) issues.push('成员与团长商品或人数快照不一致');
          if (row.is_virtual === 0 && row.uid > 0 && !order) issues.push(row.order_matches.length > 1 ? '订单身份匹配不唯一' : '订单身份缺失或不一致');
          const deleted = Boolean(order && (order.is_del || order.is_system_del));
          if (deleted) issues.push('关联订单已删除，不能打开详情');
          return { pink_id: row.id, combination_id: row.combination_id, product_id: row.product_id, uid: row.uid, nickname: row.nickname,
            avatar_preview: combinationStatisticsAvatar(row.avatar), is_leader: row.id === id, is_virtual: row.is_virtual, is_refund: row.is_refund,
            price: row.price, add_time: row.add_time, status_raw: row.status, deleted_user: row.uid > 0 && Boolean(row.user_deleted),
            missing_user: row.uid > 0 && row.user_id === null, order_id: order?.order_id ?? '', order_db_id: order?.id ?? null,
            order_id_snapshot: row.order_id, order_key_snapshot: row.order_id_key, order_deleted: deleted,
            detail_available: Boolean(order && !deleted && order.order_id !== '' && order.order_id !== '0'), issues };
        }), count: total.count, page: query.page, limit: query.limit };
    });
  }
  async orders(combinationId: unknown, parameters: URLSearchParams) {
    const id = combinationStatisticsId(combinationId), query = combinationOrdersQuery(parameters);
    return this.read(async tx => {
      await this.activity(tx, id);
      const pattern = combinationStatisticsLike(query.keyword);
      const search = query.keyword ? sql`(o.order_id ILIKE ${pattern} OR o.real_name ILIKE ${pattern} OR o.user_phone ILIKE ${pattern}
        OR o.uid::text ILIKE ${pattern} OR EXISTS(SELECT 1 FROM public."user" searched_user WHERE searched_user.uid=o.uid
          AND (searched_user.nickname ILIKE ${pattern} OR searched_user.phone ILIKE ${pattern} OR searched_user.uid::text ILIKE ${pattern}))
        OR EXISTS(SELECT 1 FROM public.user_address address WHERE address.uid=o.uid
          AND (address.real_name ILIKE ${pattern} OR address.phone ILIKE ${pattern} OR address.uid::text ILIKE ${pattern}))
        OR EXISTS(SELECT 1 FROM public.store_order_cart_info cart JOIN public.store_product product ON product.id=cart.product_id WHERE cart.oid=o.id
          AND (product.store_name ILIKE ${pattern} OR product.keyword ILIKE ${pattern}))
        OR EXISTS(SELECT 1 FROM public.store_combination activity WHERE activity.id=o.activity_id
          AND (activity.store_name ILIKE ${pattern} OR activity.info ILIKE ${pattern})))` : undefined;
      const where = conjunction([paidRoots(id), orderFilter(query.status), search]);
      const [total] = await tx.execute<{ count: number }>(sql`SELECT count(*)::integer AS count FROM public.store_order o WHERE ${where}`);
      const rows = await tx.execute<{ id: number; order_id: string; uid: number; real_name: string; user_phone: string; nickname: string | null;
        pay_price: string; total_num: number; add_time: number; pay_time: number; paid: number; status: number; shipping_type: number;
        refund_status: number; refund_type: number; pid: number; is_del: number; is_system_del: number; user_id: number | null; user_deleted: boolean | null }>(sql`SELECT
        o.id,o.order_id,o.uid,o.real_name,o.user_phone,u.nickname,o.pay_price::text,o.total_num,o.add_time,o.pay_time,o.paid,o.status,
        o.shipping_type,o.refund_status,o.refund_type,o.pid,o.is_del,o.is_system_del,u.uid AS user_id,(u.is_del<>0 OR u.delete_time IS NOT NULL) AS user_deleted
        FROM public.store_order o LEFT JOIN public."user" u ON u.uid=o.uid WHERE ${where}
        ORDER BY o.add_time DESC,o.id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      return { id, combination_id: id, list: rows.map(row => {
        const deleted = Boolean(row.is_del || row.is_system_del), issues: string[] = [];
        if (deleted) issues.push('订单已删除，保留支付历史，不能打开详情');
        if (row.user_id === null) issues.push('关联用户缺失，保留订单快照'); else if (row.user_deleted) issues.push('关联用户已注销，保留订单快照');
        if (row.order_id === '' || row.order_id === '0') issues.push('历史业务订单号无效');
        return { id: row.id, order_id: row.order_id, uid: row.uid, real_name: row.real_name, user_phone: row.user_phone,
          nickname: row.nickname ?? '', pay_price: row.pay_price, total_num: row.total_num, add_time: row.add_time, pay_time: row.pay_time,
          status: combinationStatisticsOrderStatus(row), status_raw: row.status, shipping_type: row.shipping_type,
          refund_status: row.refund_status, refund_type: row.refund_type, parent_id: row.pid, deleted,
          detail_available: !deleted && row.order_id !== '' && row.order_id !== '0', issues };
      }), count: total.count, page: query.page, limit: query.limit };
    });
  }
}
