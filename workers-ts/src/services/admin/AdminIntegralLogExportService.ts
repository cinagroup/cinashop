import { sql } from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import { user as userTable, userBill } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { activityHash } from "./AdminSeckillActivityInput";
import { AdminIntegralLogService, parseAdminIntegralLogQuery } from "./AdminIntegralLogService";

export const INTEGRAL_LOG_EXPORT_HEADER = ["编号", "标题", "变动后积分", "积分变动", "备注", "用户微信昵称", "添加时间"] as const;
export const INTEGRAL_LOG_EXPORT_KEYS = ["id", "title", "balance", "number", "mark", "nickname", "add_time"] as const;
export const INTEGRAL_LOG_EXPORT_MAX_ROWS = 100_000;
export const INTEGRAL_LOG_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_PAGE_ROWS = 1_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const csvLine = (cells: readonly string[]) => cells.map(cell => `"${cell.replace(/"/gu, '""')}"`).join(",") + "\r\n";
const headerBytes = encoder.encode("\ufeff" + csvLine(INTEGRAL_LOG_EXPORT_HEADER)).byteLength;
type ExportRow = Record<(typeof INTEGRAL_LOG_EXPORT_KEYS)[number], string>;

function positiveInteger(value: string | null, fallback: number, field: string): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/u.test(value)) throw new ValidateException(`${field}无效`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new ValidateException(`${field}无效`);
  return result;
}

export function parseAdminIntegralLogExportQuery(parameters: URLSearchParams) {
  const allowed = new Set(["page", "limit", "keyword", "type", "start", "stop", "snapshot"]);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) throw new ValidateException("不支持或重复的积分导出参数");
  }
  const page = positiveInteger(parameters.get("page"), 1, "页码");
  const limit = positiveInteger(parameters.get("limit"), MAX_PAGE_ROWS, "每页数量");
  if (limit > MAX_PAGE_ROWS || (page - 1) * limit >= INTEGRAL_LOG_EXPORT_MAX_ROWS) {
    throw new ValidateException("积分导出分页超出范围");
  }
  const raw = Object.fromEntries(["keyword", "type", "start", "stop"].map(key => [key, parameters.get(key) ?? ""]));
  const filters = parseAdminIntegralLogQuery(raw);
  const snapshot = parameters.get("snapshot");
  if ((snapshot !== null && !/^[a-f0-9]{64}$/u.test(snapshot)) || (page > 1 && snapshot === null)) {
    throw new ValidateException("后续积分导出页必须携带有效快照");
  }
  return { ...filters, page, limit, offset: (page - 1) * limit, snapshot };
}

/** One manifest page, bound to the complete filtered ledger and user display names. */
export class AdminIntegralLogExportService {
  constructor(private readonly container: Container) {}

  async manifest(parameters: URLSearchParams) {
    const query = parseAdminIntegralLogExportQuery(parameters);
    const where = new AdminIntegralLogService(this.container).filterPredicate(query);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      const [countRow] = await tx.select({ count: sql<string>`COUNT(*)::text` })
        .from(userBill).leftJoin(userTable, sql`${userTable.uid} = ${userBill.uid}`).where(where);
      const count = Number(countRow?.count ?? 0);
      if (!Number.isSafeInteger(count) || count > INTEGRAL_LOG_EXPORT_MAX_ROWS) {
        throw new ValidateException("完整积分导出超过100000行，请缩小筛选范围");
      }

      // Include MVCC versions as well as projected cells, so an update to a
      // ledger or user row invalidates every later page even when the visible
      // values happen to remain equal. PostgreSQL text cannot contain NUL.
      const formulaPrefix = '^([\\x01-\\x20\\x7f-\\x9f\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+@-]|[\\x09\\x0a\\x0d])';
      const projection = sql`WITH filtered AS MATERIALIZED (
        SELECT ${userBill.id} AS id, user_bill.xmin::text AS row_version, "user".xmin::text AS user_version,
          (${userBill.number}::text !~ '^-?[0-9]+[.][0-9]{2}$' OR ${userBill.balance}::text !~ '^-?[0-9]+[.][0-9]{2}$') AS invalid_points,
          ARRAY[
            ${userBill.id}::text,
            CASE WHEN ${userBill.title} ~ ${formulaPrefix} THEN chr(39)||${userBill.title} ELSE ${userBill.title} END,
            TRUNC(${userBill.balance})::text,
            TRUNC(${userBill.number})::text,
            CASE WHEN ${userBill.mark} ~ ${formulaPrefix} THEN chr(39)||${userBill.mark} ELSE ${userBill.mark} END,
            CASE WHEN coalesce(${userTable.nickname},'') ~ ${formulaPrefix} THEN chr(39)||${userTable.nickname} ELSE coalesce(${userTable.nickname},'') END,
            CASE WHEN ${userBill.addTime}=0 THEN '' ELSE to_char(to_timestamp(${userBill.addTime}) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') END
          ]::text[] AS cells
        FROM user_bill LEFT JOIN "user" ON ${userTable.uid}=${userBill.uid} WHERE ${where}
      )`;
      const [aggregate] = await tx.execute(sql`${projection} SELECT
        encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(id,row_version,user_version,cells)::text,'UTF8')),'hex'),'' ORDER BY id DESC),''),'UTF8')),'hex') AS fingerprint,
        coalesce(sum((SELECT sum(octet_length(replace(cell,'"','""'))+2) FROM unnest(cells) cell)+8),0)::text AS csv_bytes,
        coalesce(bool_or(invalid_points),false) AS invalid_points FROM filtered`);
      if (aggregate?.invalid_points) throw new ValidateException("积分流水数值无效，无法导出");
      const csvBytes = Number(aggregate?.csv_bytes ?? 0) + headerBytes;
      if (!Number.isSafeInteger(csvBytes) || csvBytes > INTEGRAL_LOG_EXPORT_MAX_BYTES) {
        throw new ValidateException("完整积分导出超过16MiB，请缩小筛选范围");
      }
      const snapshot = await activityHash({ version: 1, keyword: query.keyword, type: query.type,
        start: query.start, stop: query.stop, limit: query.limit, count, csv_bytes: csvBytes,
        fingerprint: aggregate?.fingerprint });
      if (query.snapshot !== null && query.snapshot !== snapshot) {
        throw new ValidateException("积分导出数据已变化，请重新开始完整导出");
      }
      if (query.offset >= count && query.page !== 1) throw new ValidateException("积分导出页码超出结果范围");
      const pageRows = await tx.execute(sql`${projection} SELECT cells FROM filtered ORDER BY id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      const rows = pageRows.map(row => {
        if (!Array.isArray(row.cells) || row.cells.length !== INTEGRAL_LOG_EXPORT_KEYS.length || row.cells.some(cell => typeof cell !== "string")) {
          throw new ValidateException("积分导出字段格式无效");
        }
        return Object.fromEntries(INTEGRAL_LOG_EXPORT_KEYS.map((key, index) => [key, (row.cells as string[])[index]])) as ExportRow;
      });
      if (rows.length !== Math.min(query.limit, count - query.offset)) throw new ValidateException("积分导出结果不完整，请重试");
      const manifest = { header: [...INTEGRAL_LOG_EXPORT_HEADER], filekey: [...INTEGRAL_LOG_EXPORT_KEYS], export: rows,
        filename: "积分日志", count, page: query.page, limit: query.limit, has_more: query.offset + rows.length < count,
        snapshot, csv_bytes: csvBytes, max_rows: INTEGRAL_LOG_EXPORT_MAX_ROWS,
        max_bytes: INTEGRAL_LOG_EXPORT_MAX_BYTES, timezone: "Asia/Shanghai" as const };
      if (encoder.encode(JSON.stringify(manifest)).byteLength > MAX_RESPONSE_BYTES - 1024) {
        throw new ValidateException("积分导出单页超过4MiB，请减少每页数量");
      }
      return manifest;
    });
  }
}
