import { and, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { supplierFlowingWater, systemSupplier, user } from '@/models/schema';
import { ValidateException } from '@/utils/errors';

type PeriodType = 'day' | 'week' | 'month';
type BillQuery = {
  timeType: PeriodType;
  status: number | null;
  supplierId: number | null;
  start: number | null;
  end: number | null;
  data: string;
};
type Page = { page: number; limit: number; offset: number };
type GroupQuery = BillQuery & Page;
type DetailQuery = BillQuery & Page & { period: string; keyword: string };

const MAX_INT = 2_147_483_647;
const MAX_GROUPS = 10_000;
const MAX_EXPORT_ROWS = 5_000;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const EXPORT_HEADER = ['交易单号', '关联订单', '交易时间', '交易金额', '支出收入', '交易人', '交易类型', '支付方式'] as const;
const EXPORT_KEYS = ['order_id', 'link_id', 'trade_time', 'number', 'pm', 'user_nickname', 'type_name', 'pay_type_name'] as const;

function allowed(parameters: URLSearchParams, keys: readonly string[]) {
  for (const key of parameters.keys()) {
    if (!keys.includes(key) || parameters.getAll(key).length !== 1) {
      throw new ValidateException('供应商账单查询参数未知或重复');
    }
  }
}

function positiveInt(value: string | null, label: string, fallback: number, maximum: number) {
  if (value === null || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new ValidateException(`${label}无效`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum) throw new ValidateException(`${label}超出范围`);
  return result;
}

function optionalSupplier(value: string | null) {
  if (value === null || value === '' || value === '0') return null;
  return positiveInt(value, '供应商', 0, MAX_INT);
}

function shanghaiSecond(value: string, label: string) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(value);
  if (!match) throw new ValidateException(`${label}格式错误`);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4] ?? 0), minute = Number(match[5] ?? 0), second = Number(match[6] ?? 0);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(utc);
  if (year < 1970 || year > 2038 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second) throw new ValidateException(`${label}无效`);
  const epoch = Math.floor((utc - 8 * 3_600_000) / 1000);
  if (epoch < 0 || epoch > MAX_INT) throw new ValidateException(`${label}超出时间范围`);
  return { epoch, midnight: hour === 0 && minute === 0 && second === 0 };
}

function parseData(value: string | null) {
  const data = value ?? '';
  if (!data) return { data, start: null, end: null };
  const match = /^(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?)-(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?)$/.exec(data);
  if (!match) throw new ValidateException('账单日期范围格式错误');
  const start = shanghaiSecond(match[1], '开始时间');
  const end = shanghaiSecond(match[2], '结束时间');
  const extension = end.midnight || end.epoch === start.epoch ? 86_400 : 0;
  if (end.epoch < start.epoch || end.epoch - start.epoch > 366 * 86_400 ||
    end.epoch + extension > MAX_INT) {
    throw new ValidateException('所选账单起止点相差不能超过366天');
  }
  // PHP ModelTrait's BETWEEN includes both endpoints, and expands a midnight
  // ending or an identical start/end instant by one day.
  return { data, start: start.epoch, end: end.epoch + extension };
}

function baseQuery(parameters: URLSearchParams): BillQuery {
  const rawType = parameters.get('timeType') || 'day';
  if (!['day', 'week', 'month'].includes(rawType)) throw new ValidateException('账单周期无效');
  const rawStatus = parameters.get('status') ?? '';
  if (!['', '-1', '0', '1'].includes(rawStatus)) throw new ValidateException('账单状态无效');
  return { timeType: rawType as PeriodType, status: rawStatus === '' ? null : Number(rawStatus),
    supplierId: optionalSupplier(parameters.get('supplier_id')), ...parseData(parameters.get('data')) };
}

function pageQuery(parameters: URLSearchParams, defaultLimit: number): Page {
  const page = positiveInt(parameters.get('page'), '页码', 1, 1000);
  const limit = positiveInt(parameters.get('limit'), '每页条数', defaultLimit, 100);
  const offset = (page - 1) * limit;
  if (offset > 10_000) throw new ValidateException('账单分页超出范围');
  return { page, limit, offset };
}

function groupsQuery(parameters: URLSearchParams): GroupQuery {
  allowed(parameters, ['timeType', 'data', 'supplier_id', 'status', 'page', 'limit']);
  return { ...baseQuery(parameters), ...pageQuery(parameters, 15) };
}

function periodPattern(type: PeriodType) {
  return type === 'day' ? /^\d{4}-\d{2}-\d{2}$/ : type === 'month' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}$/;
}

function detailsQuery(parameters: URLSearchParams, exportMode = false): DetailQuery {
  allowed(parameters, exportMode
    ? ['timeType', 'period', 'data', 'supplier_id', 'status']
    : ['timeType', 'period', 'data', 'supplier_id', 'status', 'keyword', 'page', 'limit']);
  const base = baseQuery(parameters);
  const period = parameters.get('period') ?? '';
  if (!periodPattern(base.timeType).test(period)) throw new ValidateException('账单周期键无效');
  const keyword = (parameters.get('keyword') ?? '').trim();
  if ([...keyword].length > 80 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('账单搜索词无效');
  return { ...base, ...pageQuery(parameters, 10), period, keyword };
}

function periodExpression(type: PeriodType,
  clock: typeof supplierFlowingWater.addTime | typeof supplierFlowingWater.finishTime): SQL<string> {
  const day = sql`(to_timestamp(${clock}) AT TIME ZONE 'Asia/Shanghai')::date`;
  if (type === 'day') return sql<string>`to_char(${day},'YYYY-MM-DD')`;
  if (type === 'month') return sql<string>`to_char(${day},'YYYY-MM')`;
  // MySQL %Y-%u is calendar year plus Monday-first week 00–53, not ISO year.
  const week = sql`CASE WHEN EXTRACT(ISOYEAR FROM ${day}) < EXTRACT(YEAR FROM ${day}) THEN 0
    WHEN EXTRACT(ISOYEAR FROM ${day}) > EXTRACT(YEAR FROM ${day}) THEN 53
    ELSE EXTRACT(WEEK FROM ${day}) END`;
  return sql<string>`to_char(${day},'YYYY') || '-' || lpad((${week})::int::text,2,'0')`;
}

function scopedWhere(query: BillQuery): SQL {
  const conditions: SQL[] = [eq(supplierFlowingWater.isDel, 0)];
  if (query.supplierId !== null) conditions.push(eq(supplierFlowingWater.supplierId, query.supplierId));
  if (query.status !== null) conditions.push(eq(supplierFlowingWater.status, query.status));
  if (query.start !== null && query.end !== null) {
    conditions.push(gte(supplierFlowingWater.addTime, query.start), lte(supplierFlowingWater.addTime, query.end));
  }
  return and(...conditions)!;
}

async function readOnly(tx: DbClient) {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

async function validateSupplier(tx: DbClient, supplierId: number | null) {
  if (supplierId === null) return;
  // Historical rows may belong to soft-deleted suppliers; only existence is checked.
  const [supplier] = await tx.select({ id: systemSupplier.id }).from(systemSupplier)
    .where(eq(systemSupplier.id, supplierId)).limit(1);
  if (!supplier) throw new ValidateException('供应商不存在');
}

function detailWhere(query: DetailQuery): SQL {
  const period = periodExpression(query.timeType,
    query.status === 1 ? supplierFlowingWater.finishTime : supplierFlowingWater.addTime);
  const conditions: SQL[] = [scopedWhere(query), eq(period, query.period)];
  if (query.keyword) {
    const pattern = `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(or(ilike(supplierFlowingWater.orderId, pattern),
      sql`EXISTS (SELECT 1 FROM "user" keyword_user WHERE keyword_user.uid=${supplierFlowingWater.uid}
        AND keyword_user.delete_time IS NULL AND
        (keyword_user.nickname ILIKE ${pattern} OR keyword_user.uid::text ILIKE ${pattern}))`)!);
  }
  return and(...conditions)!;
}

const detailSelection = {
  id: supplierFlowingWater.id,
  supplierId: supplierFlowingWater.supplierId,
  orderId: supplierFlowingWater.orderId,
  linkId: supplierFlowingWater.linkId,
  tradeTime: supplierFlowingWater.tradeTime,
  addTime: supplierFlowingWater.addTime,
  finishTime: supplierFlowingWater.finishTime,
  number: supplierFlowingWater.number,
  pm: supplierFlowingWater.pm,
  uid: supplierFlowingWater.uid,
  nickname: user.nickname,
  type: supplierFlowingWater.type,
  payType: supplierFlowingWater.payType,
  remark: supplierFlowingWater.remark,
  status: supplierFlowingWater.status,
  supplierName: systemSupplier.supplierName,
};

function displayTime(epoch: number) {
  return epoch ? new Date((epoch + 8 * 3_600) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '';
}

function detailRecord(row: Awaited<ReturnType<typeof detailRows>>[number]) {
  const payTypes: Record<string, string> = { weixin: '微信支付', yue: '余额支付', offline: '线下支付',
    alipay: '支付宝支付', cash: '现金支付', automatic: '自动转账', store: '微信支付' };
  return { id: row.id, supplier_id: row.supplierId, supplier_name: row.supplierName ?? '',
    order_id: row.orderId, link_id: row.linkId,
    trade_time: displayTime(row.tradeTime || row.addTime), add_time: displayTime(row.addTime),
    finish_time: displayTime(row.finishTime), number: row.number, pm: row.pm,
    uid: row.uid, user_nickname: row.nickname || '游客',
    type_name: row.type === 1 ? '支付订单' : row.type === 2 ? '退款订单' : '其他类型',
    pay_type_name: payTypes[row.payType] ?? '其他方式', remark: row.remark, status: row.status };
}

function detailRows(tx: DbClient, where: SQL, limit: number, offset = 0) {
  return tx.select(detailSelection).from(supplierFlowingWater)
    .leftJoin(user, and(eq(user.uid, supplierFlowingWater.uid), isNull(user.deleteTime)))
    .leftJoin(systemSupplier, eq(systemSupplier.id, supplierFlowingWater.supplierId))
    .where(where).orderBy(desc(supplierFlowingWater.id)).limit(limit).offset(offset);
}

function csvSafe(value: string) {
  return /^[\x01-\x20\x7f-\x9f\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+@-]/u.test(value)
    ? `'${value}` : value;
}

export class AdminSupplierBillScreenService {
  constructor(private readonly container: Container) {}

  async suppliers(parameters: URLSearchParams) {
    allowed(parameters, []);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const rows = await tx.select({ id: systemSupplier.id, supplier_name: systemSupplier.supplierName })
        .from(systemSupplier).where(eq(systemSupplier.isDel, 0)).orderBy(desc(systemSupplier.id))
        .limit(10_001);
      if (rows.length > 10_000) throw new ValidateException('供应商选项超过10000行');
      return rows;
    });
  }

  async groups(parameters: URLSearchParams) {
    const query = groupsQuery(parameters);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      await validateSupplier(tx, query.supplierId);
      const period = periodExpression(query.timeType,
        query.status === 1 ? supplierFlowingWater.finishTime : supplierFlowingWater.addTime);
      const where = scopedWhere(query);
      const grouped = tx.select({ period }).from(supplierFlowingWater).where(where).groupBy(period).as('g');
      const [total] = await tx.select({ count: sql<number>`count(*)::int` }).from(grouped);
      const count = total?.count ?? 0;
      if (count > MAX_GROUPS) throw new ValidateException('账单分组超过10000项，请缩小日期范围');
      const income = sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=1 THEN ${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`;
      const expense = sql<string>`coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=0 THEN ${supplierFlowingWater.number} ELSE 0 END),0)::numeric(20,2)::text`;
      const entry = sql<string>`(coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=1 THEN ${supplierFlowingWater.number} ELSE 0 END),0)
        - coalesce(sum(CASE WHEN ${supplierFlowingWater.pm}=0 THEN ${supplierFlowingWater.number} ELSE 0 END),0))::numeric(20,2)::text`;
      const rows = await tx.select({ period, income, expense, entry }).from(supplierFlowingWater)
        .where(where).groupBy(period).orderBy(desc(period)).limit(query.limit).offset(query.offset);
      return { list: rows.map((row, index) => ({ id: index + 1, period: row.period, day: row.period,
        title: query.timeType === 'day' ? '日账单' : query.timeType === 'week' ? '周账单' : '月账单',
        add_time: query.timeType === 'week' ? `${row.period.slice(0, 4)}年第${row.period.slice(5)}周` : row.period,
        income_num: row.income, exp_num: row.expense, entry_num: row.entry })),
      count, page: query.page, limit: query.limit };
    });
  }

  async details(parameters: URLSearchParams) {
    const query = detailsQuery(parameters), where = detailWhere(query);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      await validateSupplier(tx, query.supplierId);
      const [total] = await tx.select({ count: sql<number>`count(*)::int` }).from(supplierFlowingWater)
        .where(where);
      const rows = await detailRows(tx, where, query.limit, query.offset);
      return { list: rows.map(detailRecord), count: total?.count ?? 0,
        page: query.page, limit: query.limit };
    });
  }

  async export(parameters: URLSearchParams) {
    const query = detailsQuery(parameters, true), where = detailWhere(query);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      await validateSupplier(tx, query.supplierId);
      const rows = await detailRows(tx, where, MAX_EXPORT_ROWS + 1);
      if (rows.length > MAX_EXPORT_ROWS) throw new ValidateException('账单导出超过5000行，请缩小供应商或日期范围');
      const exportRows = rows.map(row => {
        const detail = detailRecord(row);
        return { order_id: csvSafe(detail.order_id), link_id: csvSafe(detail.link_id),
          trade_time: detail.trade_time, number: detail.number,
          pm: detail.pm === 1 ? '收入' : '支出',
          user_nickname: csvSafe(detail.user_nickname), type_name: detail.type_name,
          pay_type_name: detail.pay_type_name };
      });
      const result = { filename: `供应商账单-${query.period}`, header: [...EXPORT_HEADER],
        filekey: [...EXPORT_KEYS], export: exportRows, count: exportRows.length };
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_EXPORT_BYTES) {
        throw new ValidateException('账单导出超过2MiB，请缩小供应商或日期范围');
      }
      return result;
    });
  }
}
