import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { withTx, type Container } from '@/lib/di';
import { storeCombination } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { activityHash, activityId, activityText } from './AdminSeckillActivityInput';

export const COMBINATION_EXPORT_HEADER = ['编号', '拼团名称', '划线价', '拼团价', '库存', '开团数', '参与记录数', '成团数量', '销量', '商品状态', '结束时间'] as const;
export const COMBINATION_EXPORT_KEYS = ['id', 'title', 'ot_price', 'price', 'stock', 'people', 'count_people_all', 'count_people_pink', 'sales', 'is_show', 'stop_time'] as const;
export const COMBINATION_EXPORT_MAX_ROWS = 100_000;
export const COMBINATION_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const csvLine = (cells: readonly string[]) => cells.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',') + '\r\n';
const headerBytes = encoder.encode('\ufeff' + csvLine(COMBINATION_EXPORT_HEADER)).byteLength;
type ExportRow = Record<typeof COMBINATION_EXPORT_KEYS[number], string>;

function queryInput(parameters: URLSearchParams) {
  for (const key of parameters.keys()) if (!['page', 'limit', 'keyword', 'phase', 'status', 'snapshot'].includes(key)
    || parameters.getAll(key).length !== 1) throw new ValidateException('不支持或重复的拼团导出查询参数');
  const page = parameters.has('page') ? activityId(parameters.get('page'), '页码') : 1;
  const limit = parameters.has('limit') ? activityId(parameters.get('limit'), '每页数量') : 1000;
  if (limit > 1000 || (page - 1) * limit >= COMBINATION_EXPORT_MAX_ROWS) throw new ValidateException('拼团导出分页超出范围');
  const keyword = activityText(parameters.get('keyword') ?? '', '查询名称', 100, false);
  const status = parameters.get('status') || 'all', phase = parameters.get('phase') || 'all';
  if (!['all', '0', '1'].includes(status) || !['all', 'future', 'active', 'ended', 'invalid'].includes(phase)) throw new ValidateException('拼团导出筛选参数无效');
  const snapshot = parameters.get('snapshot');
  if ((snapshot !== null && !/^[a-f0-9]{64}$/.test(snapshot)) || (page > 1 && snapshot === null)) throw new ValidateException('后续导出页必须携带有效快照');
  return { page, limit, offset: (page - 1) * limit, keyword, status, phase, snapshot };
}

function predicate(query: ReturnType<typeof queryInput>) {
  const now = new Date().toISOString();
  const badDates = sql`(${storeCombination.startTime} IS NULL OR ${storeCombination.stopTime} IS NULL OR NOT isfinite(${storeCombination.startTime}) OR NOT isfinite(${storeCombination.stopTime}) OR ${storeCombination.startTime}>${storeCombination.stopTime})`;
  const phase = query.phase === 'invalid' ? badDates : query.phase === 'future' ? sql`NOT ${badDates} AND ${storeCombination.startTime}>${now}`
    : query.phase === 'ended' ? sql`NOT ${badDates} AND ${storeCombination.stopTime}<${now}`
      : query.phase === 'active' ? sql`NOT ${badDates} AND ${storeCombination.startTime}<=${now} AND ${storeCombination.stopTime}>=${now}` : undefined;
  const keyword = query.keyword ? or(ilike(storeCombination.storeName, `%${query.keyword.replace(/[\\%_]/g, '\\$&')}%`),
    /^[1-9]\d{0,9}$/.test(query.keyword) && Number(query.keyword) <= 2147483647 ? eq(storeCombination.id, Number(query.keyword)) : undefined) : undefined;
  return and(eq(storeCombination.isDel, 0), keyword, phase, query.status === 'all' ? undefined : eq(storeCombination.status, Number(query.status)))!;
}

/** The SQL projection is also the fingerprint and byte-accounting authority.
 * Only the bounded requested page crosses the database wire. Current base
 * product ot_price intentionally differs from activity/SKU ot_price snapshots. */
function projection(where: SQL) {
  // Enumerate JS/Excel whitespace as well as C0/C1 controls, independently of
  // the database locale. PostgreSQL text cannot contain NUL.
  const formulaPrefix = '^([\\x01-\\x20\\x7f-\\x9f\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+@-]|[\\x09\\x0a\\x0d])';
  return sql`WITH filtered AS MATERIALIZED (
    SELECT store_combination.id,store_combination.sort,store_combination.store_name,store_combination.price,
      store_combination.stock,store_combination.sales,store_combination.is_show,store_combination.stop_time,
      store_combination.xmin::text AS row_version,
      base.ot_price::text AS current_ot_price, base.xmin::text AS base_version
    FROM store_combination LEFT JOIN store_product base ON base.id=store_combination.product_id WHERE ${where}
  ), pink_counts AS (
    SELECT p.combination_id, count(*)::text AS all_people,
      (count(*) FILTER (WHERE p.k_id=0))::text AS leaders,
      (count(*) FILTER (WHERE p.k_id=0 AND p.status=2))::text AS succeeded
    FROM store_pink p JOIN filtered f ON f.id=p.combination_id GROUP BY p.combination_id
  ), projected AS (
    SELECT f.id, f.sort, f.row_version, f.base_version,
      (f.price::text !~ '^-?[0-9]+[.][0-9]{2}$' OR (f.current_ot_price IS NOT NULL AND f.current_ot_price !~ '^-?[0-9]+[.][0-9]{2}$')) AS invalid_money,
      ARRAY[f.id::text,
        CASE WHEN f.store_name ~ ${formulaPrefix} THEN chr(39)||f.store_name ELSE f.store_name END,
        coalesce(f.current_ot_price,''), f.price::text, f.stock::text,
        coalesce(p.leaders,'0'), coalesce(p.all_people,'0'), coalesce(p.succeeded,'0'), f.sales::text,
        CASE WHEN f.is_show=0 THEN '关闭' ELSE '开启' END,
        CASE WHEN f.stop_time IS NULL OR NOT isfinite(f.stop_time) THEN '' ELSE to_char((f.stop_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') END]::text[] AS cells
    FROM filtered f LEFT JOIN pink_counts p ON p.combination_id=f.id
  )`;
}

export class AdminCombinationExportService {
  constructor(private readonly container: Container) {}

  async manifest(parameters: URLSearchParams) {
    const query = queryInput(parameters), where = predicate(query);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      const [countRow] = await tx.select({ count: sql<string>`count(*)::text` }).from(storeCombination).where(where);
      const count = Number(countRow.count);
      if (!Number.isSafeInteger(count) || count > COMBINATION_EXPORT_MAX_ROWS) throw new ValidateException('完整导出超过100000行，请缩小筛选范围');
      const cte = projection(where);
      const [aggregate] = await tx.execute(sql`${cte} SELECT
        encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(id,sort,row_version,base_version,cells)::text,'UTF8')),'hex'),'' ORDER BY sort DESC,id DESC),''),'UTF8')),'hex') AS fingerprint,
        coalesce(sum((SELECT sum(octet_length(replace(cell,'"','""'))+2) FROM unnest(cells) cell)+12),0)::text AS csv_bytes,
        coalesce(bool_or(invalid_money),false) AS invalid_money FROM projected`);
      if (aggregate.invalid_money) throw new ValidateException('拼团或基础商品价格无效，无法导出');
      const csvBytes = Number(aggregate.csv_bytes) + headerBytes;
      if (!Number.isSafeInteger(csvBytes) || csvBytes > COMBINATION_EXPORT_MAX_BYTES) throw new ValidateException('完整导出超过16MiB，请缩小筛选范围');
      const snapshot = await activityHash({ version: 1, keyword: query.keyword, phase: query.phase, status: query.status, limit: query.limit,
        count, csv_bytes: csvBytes, fingerprint: aggregate.fingerprint });
      if (query.snapshot !== null && query.snapshot !== snapshot) throw new ValidateException('拼团导出数据已变化，请重新开始完整导出');
      if (query.offset >= count && query.page !== 1) throw new ValidateException('拼团导出页码超出结果范围');
      const pageRows = await tx.execute(sql`${cte} SELECT cells FROM projected ORDER BY sort DESC,id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      const rows = pageRows.map(row => {
        if (!Array.isArray(row.cells) || row.cells.length !== COMBINATION_EXPORT_KEYS.length || row.cells.some(cell => typeof cell !== 'string')) throw new ValidateException('拼团导出字段格式无效');
        return Object.fromEntries(COMBINATION_EXPORT_KEYS.map((key, index) => [key, (row.cells as string[])[index]])) as ExportRow;
      });
      if (rows.length !== Math.min(query.limit, count - query.offset)) throw new ValidateException('拼团导出结果不完整，请重试');
      const manifest = { header: [...COMBINATION_EXPORT_HEADER], filekey: [...COMBINATION_EXPORT_KEYS], export: rows, filename: '拼团商品导出',
        count, page: query.page, limit: query.limit, has_more: query.offset + rows.length < count, snapshot, csv_bytes: csvBytes,
        max_rows: COMBINATION_EXPORT_MAX_ROWS, max_bytes: COMBINATION_EXPORT_MAX_BYTES, timezone: 'Asia/Shanghai' as const };
      // Leave room for the controller's success envelope inside the same cap.
      if (encoder.encode(JSON.stringify(manifest)).byteLength > MAX_RESPONSE_BYTES - 1024) throw new ValidateException('导出单页超过4MiB，请减少每页数量');
      return manifest;
    });
  }
}
