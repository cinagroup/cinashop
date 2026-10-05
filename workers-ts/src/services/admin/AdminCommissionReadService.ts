import { and, countDistinct, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { user, userBrokerage, userExtract } from '@/models/schema';
import { NotFoundException, ValidateException } from '@/utils/errors';

const MAX_INT = 2_147_483_647;
type Query = { page: number; limit: number; offset: number; start?: number; end?: number;
  keyword: string; min?: string; max?: string };
type LedgerQuery = Pick<Query, 'page' | 'limit' | 'offset' | 'start' | 'end'>;

function positiveId(value: unknown, label: string): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^[1-9]\d{0,9}$/.test(String(value))) {
    throw new ValidateException(`${label}无效`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > MAX_INT) throw new ValidateException(`${label}无效`);
  return result;
}

function money(value: string | null, label: string): string | undefined {
  if (value === null || value === '') return undefined;
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) throw new ValidateException(`${label}无效`);
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function cents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  if (!/^-?\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction)) throw new ValidateException('历史佣金金额异常');
  const sign = whole.startsWith('-') ? -1n : 1n;
  return BigInt(whole) * 100n + sign * BigInt(fraction.padEnd(2, '0'));
}

function decimal(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function shanghai(value: string, label: string): { second: number; precision: 'day' | 'minute' } {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(value);
  if (!match) throw new ValidateException(`${label}须为YYYY-MM-DD或YYYY-MM-DD HH:mm`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(utc);
  if (year < 1970 || year > 2038 || date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day ||
    date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) throw new ValidateException(`${label}无效`);
  const second = Math.floor((utc - 8 * 3_600_000) / 1000);
  if (second < 0 || second > MAX_INT) throw new ValidateException(`${label}超出时间范围`);
  return { second, precision: match[4] === undefined ? 'day' : 'minute' };
}

function bounds(parameters: URLSearchParams, allowDay: boolean): Pick<Query, 'page' | 'limit' | 'offset' | 'start' | 'end'> {
  const page = parameters.has('page') ? positiveId(parameters.get('page'), '页码') : 1;
  const limit = parameters.has('limit') ? positiveId(parameters.get('limit'), '每页条数') : 20;
  const offset = (page - 1) * limit;
  if (page > 1000 || limit > 100 || offset > 10_000) throw new ValidateException('佣金分页超出范围');
  const rawStart = parameters.get('start_time'), rawEnd = parameters.get('end_time');
  if (Boolean(rawStart) !== Boolean(rawEnd)) throw new ValidateException('佣金时间须成对填写');
  const startTime = rawStart ? shanghai(rawStart, '开始时间') : undefined;
  const endTime = rawEnd ? shanghai(rawEnd, '结束时间') : undefined;
  if (startTime && endTime && (!allowDay && startTime.precision !== 'minute' ||
    startTime.precision !== endTime.precision)) throw new ValidateException('佣金时间精度须一致');
  const start = startTime?.second;
  const end = endTime ? endTime.second + (endTime.precision === 'day' ? 86_400 : 60) : undefined;
  if (end !== undefined && end > MAX_INT + 1) throw new ValidateException('结束时间超出时间范围');
  if (start !== undefined && end !== undefined && (end <= start ||
    end - start - (endTime?.precision === 'day' ? 86_400 : 60) > 366 * 86_400)) {
    throw new ValidateException('佣金时间范围须在366天内');
  }
  return { page, limit, offset, start, end };
}

function checkKeys(parameters: URLSearchParams, allowed: Set<string>): void {
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) throw new ValidateException('佣金查询参数未知或重复');
  }
}

function listQuery(parameters: URLSearchParams): Query {
  checkKeys(parameters, new Set(['page', 'limit', 'keyword', 'price_min', 'price_max', 'start_time', 'end_time']));
  const query = bounds(parameters, false);
  const keyword = (parameters.get('keyword') || '').trim();
  if ([...keyword].length > 80 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('佣金搜索词无效');
  const min = money(parameters.get('price_min'), '最低佣金');
  const max = money(parameters.get('price_max'), '最高佣金');
  if (min && max && cents(min) > cents(max)) throw new ValidateException('佣金范围无效');
  return { ...query, keyword, min, max };
}

function ledgerQuery(parameters: URLSearchParams): LedgerQuery {
  checkKeys(parameters, new Set(['page', 'limit', 'start_time', 'end_time']));
  return bounds(parameters, true);
}

async function readOnly(tx: DbClient): Promise<void> {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

function commissionConditions(query: Query): SQL[] {
  const conditions: SQL[] = [];
  if (query.start !== undefined && query.end !== undefined) {
    conditions.push(gte(userBrokerage.addTime, query.start), lt(userBrokerage.addTime, query.end));
  }
  if (query.keyword) {
    const pattern = `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(sql`(${user.account} ILIKE ${pattern} OR ${user.nickname} ILIKE ${pattern}
      OR ${user.uid}::text ILIKE ${pattern} OR ${user.phone} ILIKE ${pattern})`);
  }
  if (query.min !== undefined) conditions.push(gte(user.brokeragePrice, query.min));
  if (query.max !== undefined) conditions.push(sql`${user.brokeragePrice} <= ${query.max}`);
  return conditions;
}

function ledgerConditions(uid: number, query: LedgerQuery): SQL[] {
  const conditions: SQL[] = [eq(userBrokerage.uid, uid)];
  if (query.start !== undefined && query.end !== undefined) {
    conditions.push(gte(userBrokerage.addTime, query.start), lt(userBrokerage.addTime, query.end));
  }
  return conditions;
}

/** Independent read model for the legacy commission user grid, never /brokerage/list. */
export class AdminCommissionReadService {
  constructor(private readonly container: Container) {}

  async list(parameters: URLSearchParams) {
    const query = listQuery(parameters);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const where = and(...commissionConditions(query));
      const [total] = await tx.select({ count: countDistinct(user.uid) }).from(user)
        .leftJoin(userBrokerage, eq(userBrokerage.uid, user.uid)).where(where);
      const rows = await tx.select({ uid: user.uid, nickname: user.nickname, phone: user.phone,
        nowMoney: user.nowMoney, brokeragePrice: user.brokeragePrice,
        userIsDel: user.isDel, deleteTime: user.deleteTime,
        time: sql<number>`coalesce(max(${userBrokerage.addTime}),0)::int`,
        lastId: sql<number>`coalesce(max(${userBrokerage.id}),0)::int`,
      }).from(user).leftJoin(userBrokerage, eq(userBrokerage.uid, user.uid))
        .where(where).groupBy(user.uid).orderBy(desc(sql`coalesce(max(${userBrokerage.id}),0)`), desc(user.uid))
        .limit(query.limit).offset(query.offset);
      const uids = rows.map(row => row.uid);
      const extracts = uids.length ? await tx.select({ uid: userExtract.uid,
        amount: sql<string>`coalesce(sum(${userExtract.extractPrice} + ${userExtract.extractFee}),0)::numeric(20,2)::text`,
      }).from(userExtract).where(and(inArray(userExtract.uid, uids), inArray(userExtract.status, [0, 1])))
        .groupBy(userExtract.uid) : [];
      const grossByUid = new Map(extracts.map(row => [row.uid, row.amount]));
      return { list: rows.map(row => {
        const extract = grossByUid.get(row.uid) ?? '0.00';
        const balance = row.brokeragePrice;
        const issues: string[] = [];
        if (cents(balance) < 0n || cents(row.nowMoney) < 0n || cents(extract) < 0n) issues.push('账户或提现金额异常');
        return { uid: row.uid, nickname: row.nickname, phone: row.phone,
          display_name: `${row.nickname}|${row.phone ? `${row.phone}|` : ''}${row.uid}`,
          now_money: row.nowMoney, brokerage_price: balance, extract_price: extract,
          sum_number: decimal(cents(balance) + cents(extract)), time: row.time,
          user_deleted: row.userIsDel !== 0 || row.deleteTime !== null, issues };
      }), count: total.count, page: query.page, limit: query.limit };
    });
  }

  async detail(rawUid: unknown) {
    const uid = positiveId(rawUid, '用户UID');
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [person] = await tx.select({ uid: user.uid, nickname: user.nickname,
        spreadUid: user.spreadUid, nowMoney: user.nowMoney,
        brokeragePrice: user.brokeragePrice, addTime: user.addTime,
        isDel: user.isDel, deleteTime: user.deleteTime,
      }).from(user).where(eq(user.uid, uid)).limit(1);
      if (!person) throw new NotFoundException('佣金用户不存在');
      const [promoter] = person.spreadUid > 0 ? await tx.select({ nickname: user.nickname })
        .from(user).where(eq(user.uid, person.spreadUid)).limit(1) : [];
      const [totals] = await tx.select({
        income: sql<string>`coalesce(sum(${userBrokerage.number}) filter
          (where ${userBrokerage.type} in ('self_brokerage','one_brokerage','two_brokerage','brokerage_user')),0)::numeric(20,2)::text`,
        refund: sql<string>`coalesce(sum(${userBrokerage.number}) filter
          (where ${userBrokerage.type} = 'refund'),0)::numeric(20,2)::text`,
      }).from(userBrokerage).where(eq(userBrokerage.uid, uid));
      const net = cents(totals.income) - cents(totals.refund);
      const issues: string[] = [];
      if (cents(person.nowMoney) < 0n || cents(person.brokeragePrice) < 0n) issues.push('账户金额异常');
      return { uid, nickname: person.nickname, spread_name: promoter?.nickname ?? '',
        number: decimal(net > 0n ? net : 0n), now_money: person.nowMoney,
        brokerage_price: person.brokeragePrice, add_time: person.addTime,
        user_deleted: person.isDel !== 0 || person.deleteTime !== null, issues };
    });
  }

  async records(rawUid: unknown, parameters: URLSearchParams) {
    const uid = positiveId(rawUid, '用户UID');
    const query = ledgerQuery(parameters);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [owner] = await tx.select({ uid: user.uid }).from(user).where(eq(user.uid, uid)).limit(1);
      if (!owner) throw new NotFoundException('佣金用户不存在');
      const where = and(...ledgerConditions(uid, query));
      const [total] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(userBrokerage).where(where);
      const rows = await tx.select({ id: userBrokerage.id, number: userBrokerage.number,
        addTime: userBrokerage.addTime, mark: userBrokerage.mark,
        pm: userBrokerage.pm, type: userBrokerage.type, status: userBrokerage.status,
      }).from(userBrokerage).where(where).orderBy(desc(userBrokerage.id))
        .limit(query.limit).offset(query.offset);
      return { list: rows.map(row => ({ id: row.id, number: row.number,
        add_time: row.addTime, mark: row.mark, pm: row.pm, type: row.type,
        status: row.status, issues: cents(row.number) < 0n ? ['佣金流水金额异常'] : [] })),
      count: total.count, page: query.page, limit: query.limit };
    });
  }
}
