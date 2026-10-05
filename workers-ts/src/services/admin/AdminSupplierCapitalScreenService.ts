import { and, desc, eq, gte, ilike, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { supplierFlowingWater, systemLog, systemSupplier, user } from '@/models/schema';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';

type CapitalQuery = {
  supplierId: number | null;
  keyword: string;
  start: number | null;
  end: number | null;
  page: number;
  limit: number;
  offset: number;
};
export type CapitalRemarkActor = { id: number; name: string; ip: string };

const MAX_INT = 2_147_483_647;
const MAX_EXPORT_ROWS = 5_000;
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const EXPORT_HEADER = ['交易单号', '关联订单', '交易时间', '交易金额', '支出收入', '交易人', '交易类型', '支付方式'] as const;
const EXPORT_KEYS = ['order_id', 'link_id', 'trade_time', 'number', 'pm', 'user_nickname', 'type_name', 'pay_type_name'] as const;
const PAY_NAMES: Record<string, string> = { weixin: '微信支付', yue: '余额支付', offline: '线下支付',
  alipay: '支付宝支付', cash: '现金支付', automatic: '自动转账', store: '微信支付' };

function allowed(parameters: URLSearchParams, keys: readonly string[]) {
  for (const key of parameters.keys()) {
    if (!keys.includes(key) || parameters.getAll(key).length !== 1) {
      throw new ValidateException('供应商流水查询参数未知或重复');
    }
  }
}

function positiveInt(value: string | null, label: string, fallback: number, maximum: number) {
  if (value === null || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new ValidateException(`${label}无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new ValidateException(`${label}超出范围`);
  return parsed;
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

function dateRange(value: string | null) {
  if (!value) return { start: null, end: null };
  const match = /^(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?)-(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?)$/.exec(value);
  if (!match) throw new ValidateException('流水日期范围格式错误');
  const start = shanghaiSecond(match[1], '开始时间'), end = shanghaiSecond(match[2], '结束时间');
  const extension = end.midnight || end.epoch === start.epoch ? 86_400 : 0;
  if (end.epoch < start.epoch || end.epoch - start.epoch > 366 * 86_400 || end.epoch + extension > MAX_INT) {
    throw new ValidateException('流水起止点相差不能超过366天');
  }
  // The PHP ModelTrait uses inclusive BETWEEN and extends a midnight ending
  // or identical start/end instant by one day.
  return { start: start.epoch, end: end.epoch + extension };
}

function query(parameters: URLSearchParams, exportMode: boolean): CapitalQuery {
  allowed(parameters, exportMode ? ['supplier_id', 'data', 'keyword'] :
    ['supplier_id', 'data', 'keyword', 'page', 'limit']);
  const rawSupplier = parameters.get('supplier_id');
  // Legacy searchSupplierIdAttr treats only the empty string as all suppliers;
  // a literal 0 means supplier_id=0 and must never broaden the result scope.
  const supplierId = rawSupplier === null || rawSupplier === '' ? null
    : rawSupplier === '0' ? 0 : positiveInt(rawSupplier, '供应商', 0, MAX_INT);
  const keyword = (parameters.get('keyword') ?? '').trim();
  if ([...keyword].length > 80 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException('流水搜索词无效');
  const page = exportMode ? 1 : positiveInt(parameters.get('page'), '页码', 1, 1000);
  const limit = exportMode ? MAX_EXPORT_ROWS + 1 : positiveInt(parameters.get('limit'), '每页条数', 20, 100);
  const offset = (page - 1) * limit;
  if (offset > 10_000) throw new ValidateException('流水分页超出范围');
  return { supplierId, keyword, ...dateRange(parameters.get('data')), page, limit, offset };
}

async function readOnly(tx: DbClient) {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

function scopedWhere(input: CapitalQuery): SQL {
  const conditions: SQL[] = [eq(supplierFlowingWater.isDel, 0)];
  if (input.supplierId !== null) conditions.push(eq(supplierFlowingWater.supplierId, input.supplierId));
  if (input.start !== null && input.end !== null) {
    conditions.push(gte(supplierFlowingWater.addTime, input.start), lte(supplierFlowingWater.addTime, input.end));
  }
  if (input.keyword) {
    const pattern = `%${input.keyword.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(or(ilike(supplierFlowingWater.orderId, pattern),
      sql`EXISTS (SELECT 1 FROM "user" keyword_user WHERE keyword_user.uid=${supplierFlowingWater.uid}
        AND keyword_user.delete_time IS NULL AND
        (keyword_user.nickname ILIKE ${pattern} OR keyword_user.uid::text ILIKE ${pattern}))`)!);
  }
  return and(...conditions)!;
}

const selection = {
  id: supplierFlowingWater.id,
  supplierId: supplierFlowingWater.supplierId,
  orderId: supplierFlowingWater.orderId,
  linkId: supplierFlowingWater.linkId,
  tradeTime: supplierFlowingWater.tradeTime,
  addTime: supplierFlowingWater.addTime,
  number: supplierFlowingWater.number,
  pm: supplierFlowingWater.pm,
  uid: supplierFlowingWater.uid,
  nickname: user.nickname,
  supplierName: systemSupplier.supplierName,
  type: supplierFlowingWater.type,
  payType: supplierFlowingWater.payType,
  remark: supplierFlowingWater.remark,
};

function rows(tx: DbClient, where: SQL, limit: number, offset = 0) {
  return tx.select(selection).from(supplierFlowingWater)
    .leftJoin(user, and(eq(user.uid, supplierFlowingWater.uid), isNull(user.deleteTime)))
    .leftJoin(systemSupplier, eq(systemSupplier.id, supplierFlowingWater.supplierId))
    .where(where).orderBy(desc(supplierFlowingWater.id)).limit(limit).offset(offset);
}

function displayTime(epoch: number) {
  return epoch ? new Date((epoch + 8 * 3_600) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '';
}

/** Worker split/refund materialization stores machine lineage in this same column. */
export function isMachineLineageRemark(value: string): boolean {
  if (!value.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return !!parsed && typeof parsed === 'object' && 'version' in parsed &&
      (parsed.version === 'supplier-split-income-v1' || parsed.version === 'supplier-refund-split-v1');
  } catch { return false; }
}

function record(row: Awaited<ReturnType<typeof rows>>[number]) {
  return { id: row.id, supplier_id: row.supplierId, supplier_name: row.supplierName ?? '',
    order_id: row.orderId, link_id: row.linkId, trade_time: displayTime(row.tradeTime || row.addTime),
    number: row.number, pm: row.pm, uid: row.uid, user_nickname: row.nickname || '游客',
    type_name: row.type === 1 ? '支付订单' : row.type === 2 ? '退款订单' : '其他类型',
    pay_type_name: PAY_NAMES[row.payType] ?? '其他方式', remark: row.remark,
    remark_editable: !isMachineLineageRemark(row.remark) };
}

function csvSafe(value: string) {
  return /^[\x01-\x20\x7f-\x9f\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+@-]/u.test(value)
    ? `'${value}` : value;
}

function validRemark(value: unknown, label: string, max: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value) ||
    (!allowEmpty && !value.trim())) throw new ValidateException(`${label}无效`);
  return value;
}

export class AdminSupplierCapitalScreenService {
  constructor(private readonly container: Container) {}

  async suppliers(parameters: URLSearchParams) {
    allowed(parameters, []);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const result = await tx.select({ id: systemSupplier.id, supplier_name: systemSupplier.supplierName })
        .from(systemSupplier).where(eq(systemSupplier.isDel, 0)).orderBy(desc(systemSupplier.id)).limit(10_001);
      if (result.length > 10_000) throw new ValidateException('供应商选项超过10000行');
      return result;
    });
  }

  async list(parameters: URLSearchParams) {
    const input = query(parameters, false), where = scopedWhere(input);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [total] = await tx.select({ count: sql<number>`count(*)::int` }).from(supplierFlowingWater).where(where);
      const selected = await rows(tx, where, input.limit, input.offset);
      return { list: selected.map(record), count: total?.count ?? 0, page: input.page, limit: input.limit };
    });
  }

  async export(parameters: URLSearchParams) {
    const input = query(parameters, true), where = scopedWhere(input);
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const selected = await rows(tx, where, MAX_EXPORT_ROWS + 1);
      if (selected.length > MAX_EXPORT_ROWS) throw new ValidateException('流水导出超过5000行，请缩小供应商或日期范围');
      const exported = selected.map(row => {
        const item = record(row);
        return { order_id: csvSafe(item.order_id), link_id: csvSafe(item.link_id),
          trade_time: item.trade_time, number: item.number, pm: item.pm === 1 ? '收入' : '支出',
          user_nickname: csvSafe(item.user_nickname), type_name: item.type_name,
          pay_type_name: item.pay_type_name };
      });
      const result = { filename: '供应商资金流水导出', header: [...EXPORT_HEADER], filekey: [...EXPORT_KEYS],
        export: exported, count: exported.length };
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_EXPORT_BYTES) {
        throw new ValidateException('流水导出超过2MiB，请缩小供应商或日期范围');
      }
      return result;
    });
  }

  async remark(id: number, body: Record<string, unknown>, actor: CapitalRemarkActor) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_INT) throw new ValidateException('流水 ID 无效');
    if (!Number.isSafeInteger(actor.id) || actor.id <= 0) throw new ValidateException('管理员身份无效');
    if (Object.keys(body).some(key => !['remark', 'expected_remark'].includes(key)) ||
      !Object.hasOwn(body, 'expected_remark')) throw new ValidateException('备注请求字段无效');
    const remark = validRemark(body.remark, '备注', 200, false);
    const expected = validRemark(body.expected_remark, '原备注', 512, true);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SELECT set_config('lock_timeout','2000ms',true),
        set_config('statement_timeout','5000ms',true),
        set_config('idle_in_transaction_session_timeout','5000ms',true)`);
      const [current] = await tx.select({ id: supplierFlowingWater.id, remark: supplierFlowingWater.remark })
        .from(supplierFlowingWater).where(and(eq(supplierFlowingWater.id, id), eq(supplierFlowingWater.isDel, 0)))
        .limit(1).for('update');
      if (!current) throw new NotFoundException('账单流水不存在');
      if (current.remark !== expected) throw new HttpApiException('备注已变更，请刷新后重试', 409, 409);
      if (isMachineLineageRemark(current.remark)) throw new ValidateException('此流水的系统血缘记录不可修改');
      if (current.remark === remark) return { id, remark };
      const [updated] = await tx.update(supplierFlowingWater).set({ remark })
        .where(and(eq(supplierFlowingWater.id, id), eq(supplierFlowingWater.remark, expected),
          eq(supplierFlowingWater.isDel, 0)))
        .returning({ id: supplierFlowingWater.id, remark: supplierFlowingWater.remark });
      if (!updated) throw new HttpApiException('备注已变更，请刷新后重试', 409, 409);
      await tx.insert(systemLog).values({ adminId: actor.id, adminName: actor.name.slice(0, 64),
        path: '/adminapi/supplier/capital-screen/remark/:id', page: '/supplier/capital-flow',
        method: 'PUT', action: `supplier_capital.remark.update;id=${id};length=${[...remark].length}`,
        ip: actor.ip.slice(0, 45), type: 'supplier_capital', addTime: Math.floor(Date.now() / 1000) });
      return updated;
    });
  }
}
