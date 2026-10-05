import { and, count, desc, eq, gte, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { user, userRecharge } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

type Query = { page: number; limit: number; offset: number; paid?: 0 | 1;
  start?: number; end?: number; keyword: string };

const MAX_ID = 2_147_483_647;
const summaryColumns = {
  id: userRecharge.id, uid: userRecharge.uid, orderId: userRecharge.orderId,
  price: userRecharge.price, givePrice: userRecharge.givePrice,
  refundPrice: userRecharge.refundPrice, paid: userRecharge.paid,
  rechargeType: userRecharge.rechargeType, addTime: userRecharge.addTime,
  payTime: userRecharge.payTime, nickname: user.nickname, avatar: user.avatar,
  userUid: user.uid, userIsDel: user.isDel, userDeleteTime: user.deleteTime,
};

type SummaryRow = {
  id: number; uid: number; orderId: string; price: string; givePrice: string;
  refundPrice: string; paid: number; rechargeType: string; addTime: number;
  payTime: number; nickname: string | null; avatar: string | null;
  userUid: number | null; userIsDel: number | null; userDeleteTime: Date | null;
};

function positiveId(value: unknown, label: string): number {
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidateException(`${label}无效`);
  if (!/^[1-9]\d{0,9}$/.test(String(value))) throw new ValidateException(`${label}无效`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > MAX_ID) throw new ValidateException(`${label}无效`);
  return result;
}

function shanghaiMinute(value: string, label: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new ValidateException(`${label}须为YYYY-MM-DD HH:mm`);
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(utc);
  if (year < 1970 || year > 2038 || date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day ||
    date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
    throw new ValidateException(`${label}无效`);
  }
  const seconds = Math.floor((utc - 8 * 3_600_000) / 1000);
  if (seconds < 0 || seconds > MAX_ID) throw new ValidateException(`${label}超出时间范围`);
  return seconds;
}

function parseQuery(parameters: URLSearchParams): Query {
  const allowed = new Set(['page', 'limit', 'paid', 'start_time', 'end_time', 'keyword']);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) throw new ValidateException('充值订单查询参数未知或重复');
  }
  const page = parameters.has('page') ? positiveId(parameters.get('page'), '页码') : 1;
  const limit = parameters.has('limit') ? positiveId(parameters.get('limit'), '每页条数') : 20;
  const offset = (page - 1) * limit;
  if (limit > 100 || offset > 10_000) throw new ValidateException('充值订单分页超出范围');
  const rawPaid = parameters.get('paid') || 'all';
  if (!['all', '0', '1'].includes(rawPaid)) throw new ValidateException('支付状态无效');
  const keyword = (parameters.get('keyword') || '').trim();
  if ([...keyword].length > 80 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('充值订单搜索词无效');
  const rawStart = parameters.get('start_time'), rawEnd = parameters.get('end_time');
  if (Boolean(rawStart) !== Boolean(rawEnd)) throw new ValidateException('创建时间须成对填写');
  const start = rawStart ? shanghaiMinute(rawStart, '开始时间') : undefined;
  const end = rawEnd ? shanghaiMinute(rawEnd, '结束时间') + 60 : undefined;
  if (end !== undefined && end > MAX_ID + 1) throw new ValidateException('结束时间超出时间范围');
  if (start !== undefined && end !== undefined && (end <= start || end - 60 - start > 366 * 86_400)) {
    throw new ValidateException('创建时间范围须在366天内');
  }
  return { page, limit, offset, paid: rawPaid === 'all' ? undefined : Number(rawPaid) as 0 | 1,
    start, end, keyword };
}

async function readOnly(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

function conditions(query: Query, paidForStats = false): SQL[] {
  const result: SQL[] = [];
  if (paidForStats) result.push(eq(userRecharge.paid, 1));
  else if (query.paid !== undefined) result.push(eq(userRecharge.paid, query.paid));
  if (query.start !== undefined && query.end !== undefined) {
    result.push(gte(userRecharge.addTime, query.start), lt(userRecharge.addTime, query.end));
  }
  if (query.keyword) {
    const escaped = `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`;
    const search = or(ilike(sql`${userRecharge.uid}::text`, escaped),
      ilike(userRecharge.orderId, escaped), ilike(user.nickname, escaped),
      ilike(user.realName, escaped), ilike(user.phone, escaped));
    if (search) result.push(search);
  }
  return result;
}

function rechargeTypeLabel(value: string): string {
  return ({ routine: '小程序充值', weixin: '公众号充值', alipay: '支付宝充值',
    balance: '佣金转入', store: '门店余额充值' } as Record<string, string>)[value] ?? '其他充值';
}

function safeAvatar(value: string | null): string {
  if (!value || value.includes('\\') || /[\u0000-\u001f\u007f\s]/u.test(value)) return '';
  if (/^\/(?!\/)/u.test(value)) return value;
  if (!/^https?:\/\//u.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password
      ? value : '';
  } catch { return ''; }
}

function issues(row: SummaryRow): string[] {
  const result: string[] = [];
  const price = Number(row.price), give = Number(row.givePrice), refund = Number(row.refundPrice);
  if (row.userUid === null) result.push('关联用户不存在');
  if (row.uid <= 0 || !row.orderId) result.push('充值订单身份异常');
  if (![0, 1].includes(row.paid)) result.push('支付状态异常');
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(give) || give < 0 ||
    !Number.isFinite(refund) || refund < 0 || refund > price) result.push('充值或退款金额异常');
  if (row.paid === 1 && row.payTime <= 0) result.push('已支付订单缺少支付时间');
  if (row.paid === 0 && (row.payTime > 0 || refund > 0)) result.push('未支付订单存在支付或退款痕迹');
  if (row.addTime <= 0) result.push('创建时间异常');
  return result;
}

function summary(row: SummaryRow) {
  return { id: row.id, uid: row.uid, order_id: row.orderId,
    price: row.price, give_price: row.givePrice, refund_price: row.refundPrice,
    paid: row.paid, paid_type: row.paid === 1 ? '已支付' : row.paid === 0 ? '待付款' : '状态异常',
    recharge_type: row.rechargeType, recharge_type_label: rechargeTypeLabel(row.rechargeType),
    add_time: row.addTime, pay_time: row.payTime, nickname: row.nickname ?? '',
    avatar: safeAvatar(row.avatar), user_deleted: row.userUid !== null &&
      (row.userIsDel !== 0 || row.userDeleteTime !== null),
    user_missing: row.userUid === null, issues: issues(row) };
}

/** Read the recharge order ledger itself, including unpaid orders. */
export class AdminRechargeOrderService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams) {
    const query = parseQuery(parameters);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const predicate = and(...conditions(query));
      const [total] = await tx.select({ count: count() }).from(userRecharge)
        .leftJoin(user, eq(user.uid, userRecharge.uid)).where(predicate);
      const rows = await tx.select(summaryColumns).from(userRecharge)
        .leftJoin(user, eq(user.uid, userRecharge.uid)).where(predicate)
        .orderBy(desc(userRecharge.id)).limit(query.limit).offset(query.offset);
      return { list: rows.map(summary), count: total.count, page: query.page, limit: query.limit };
    });
  }

  async stats(parameters: URLSearchParams) {
    const query = parseQuery(parameters);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [row] = await tx.select({
        sumPrice: sql<string>`coalesce(sum(${userRecharge.price}), 0)::numeric(20,2)::text`,
        sumRefundPrice: sql<string>`coalesce(sum(${userRecharge.refundPrice}), 0)::numeric(20,2)::text`,
        sumRoutinePrice: sql<string>`coalesce(sum(${userRecharge.price}) filter (where ${userRecharge.rechargeType} = 'routine'), 0)::numeric(20,2)::text`,
        sumWeixinPrice: sql<string>`coalesce(sum(${userRecharge.price}) filter (where ${userRecharge.rechargeType} = 'weixin'), 0)::numeric(20,2)::text`,
      }).from(userRecharge).leftJoin(user, eq(user.uid, userRecharge.uid))
        .where(and(...conditions(query, true)));
      return { sum_price: row.sumPrice, sum_refund_price: row.sumRefundPrice,
        sum_routine_price: row.sumRoutinePrice, sum_weixin_price: row.sumWeixinPrice };
    });
  }

  async detail(rawId: unknown) {
    const id = positiveId(rawId, '充值订单ID');
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [row] = await tx.select({ ...summaryColumns,
        tradeNo: userRecharge.tradeNo, channelType: userRecharge.channelType,
        storeId: userRecharge.storeId, staffId: userRecharge.staffId,
        remarks: userRecharge.remarks, phone: user.phone, realName: user.realName,
      }).from(userRecharge).leftJoin(user, eq(user.uid, userRecharge.uid))
        .where(eq(userRecharge.id, id)).limit(1);
      if (!row) throw new NotFoundException('充值订单不存在');
      return { ...summary(row), trade_no: row.tradeNo, channel_type: row.channelType,
        store_id: row.storeId, staff_id: row.staffId, remarks: row.remarks,
        phone: row.phone ?? '', real_name: row.realName ?? '' };
    });
  }
}
