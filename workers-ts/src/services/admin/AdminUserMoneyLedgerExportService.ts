import { sql } from "drizzle-orm";
import { withTx, type Container } from "@/lib/di";
import { user as userTable, userMoney } from "@/models/schema";
import { ValidateException } from "@/utils/errors";
import { activityHash } from "./AdminSeckillActivityInput";
import { AdminUserMoneyLedgerService, parseAdminUserMoneyLedgerQuery } from "./AdminUserMoneyLedgerService";

export const USER_MONEY_EXPORT_HEADER = ["会员ID", "昵称", "金额", "类型", "备注", "创建时间"] as const;
export const USER_MONEY_EXPORT_KEYS = ["uid", "nickname", "pm", "title", "mark", "add_time"] as const;
export const USER_MONEY_EXPORT_MAX_ROWS = 100_000;
export const USER_MONEY_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const csvLine = (cells: readonly string[]) => cells.map(cell => `"${cell.replace(/"/gu, '""')}"`).join(",") + "\r\n";
const headerBytes = encoder.encode("\ufeff" + csvLine(USER_MONEY_EXPORT_HEADER)).byteLength;
type ExportRow = Record<(typeof USER_MONEY_EXPORT_KEYS)[number], string>;

function exportPage(parameters: URLSearchParams) {
  const query = parseAdminUserMoneyLedgerQuery(parameters, true);
  if ((query.page - 1) * query.limit >= USER_MONEY_EXPORT_MAX_ROWS) {
    throw new ValidateException("资金流水导出分页超出范围");
  }
  const snapshot = parameters.get("snapshot");
  if ((snapshot !== null && !/^[a-f0-9]{64}$/u.test(snapshot)) || (query.page > 1 && snapshot === null)) {
    throw new ValidateException("后续资金流水导出页必须携带有效快照");
  }
  return { ...query, offset: (query.page - 1) * query.limit, snapshot };
}

/** Each page is tied to all filtered rows, not only its own offset window. */
export class AdminUserMoneyLedgerExportService {
  constructor(private readonly container: Container) {}

  async manifest(parameters: URLSearchParams) {
    const query = exportPage(parameters);
    const where = new AdminUserMoneyLedgerService(this.container).filterPredicate(query);
    return withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',true)`);
      const [countRow] = await tx.select({ count: sql<string>`COUNT(*)::text` })
        .from(userMoney).leftJoin(userTable, sql`${userTable.uid}=${userMoney.uid}`).where(where);
      const count = Number(countRow?.count ?? 0);
      if (!Number.isSafeInteger(count) || count > USER_MONEY_EXPORT_MAX_ROWS) {
        throw new ValidateException("完整资金流水导出超过100000行，请缩小筛选范围");
      }

      const formulaPrefix = '^([\\x01-\\x20\\x7f-\\x9f\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*[=+@-]|[\\x09\\x0a\\x0d])';
      const projection = sql`WITH filtered AS MATERIALIZED (
        SELECT ${userMoney.id} AS id, user_money.xmin::text AS row_version, "user".xmin::text AS user_version,
          (${userMoney.number}::text !~ '^[0-9]+[.][0-9]{2}$' OR ${userMoney.pm} NOT IN (0,1)) AS invalid_money,
          ARRAY[
            ${userMoney.uid}::text,
            CASE WHEN coalesce(${userTable.nickname},'') ~ ${formulaPrefix} THEN chr(39)||${userTable.nickname} ELSE coalesce(${userTable.nickname},'') END,
            CASE WHEN ${userMoney.pm}=0 THEN '-'||${userMoney.number}::text ELSE ${userMoney.number}::text END,
            CASE WHEN ${userMoney.title} ~ ${formulaPrefix} THEN chr(39)||${userMoney.title} ELSE ${userMoney.title} END,
            CASE WHEN ${userMoney.mark} ~ ${formulaPrefix} THEN chr(39)||${userMoney.mark} ELSE ${userMoney.mark} END,
            CASE WHEN ${userMoney.addTime}=0 THEN '' ELSE to_char(to_timestamp(${userMoney.addTime}) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') END
          ]::text[] AS cells
        FROM user_money LEFT JOIN "user" ON ${userTable.uid}=${userMoney.uid} WHERE ${where}
      )`;
      const [aggregate] = await tx.execute(sql`${projection} SELECT
        encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(id,row_version,user_version,cells)::text,'UTF8')),'hex'),'' ORDER BY id DESC),''),'UTF8')),'hex') AS fingerprint,
        coalesce(sum((SELECT sum(octet_length(replace(cell,'"','""'))+2) FROM unnest(cells) cell)+7),0)::text AS csv_bytes,
        coalesce(bool_or(invalid_money),false) AS invalid_money FROM filtered`);
      if (aggregate?.invalid_money) throw new ValidateException("资金流水金额或收支类型无效，无法导出");
      const csvBytes = Number(aggregate?.csv_bytes ?? 0) + headerBytes;
      if (!Number.isSafeInteger(csvBytes) || csvBytes > USER_MONEY_EXPORT_MAX_BYTES) {
        throw new ValidateException("完整资金流水导出超过16MiB，请缩小筛选范围");
      }
      const snapshot = await activityHash({ version: 1, keyword: query.keyword, type: query.type,
        start: query.start, stop: query.stop, limit: query.limit, count, csv_bytes: csvBytes,
        fingerprint: aggregate?.fingerprint });
      if (query.snapshot !== null && query.snapshot !== snapshot) {
        throw new ValidateException("资金流水导出数据已变化，请重新开始完整导出");
      }
      if (query.offset >= count && query.page !== 1) throw new ValidateException("资金流水导出页码超出结果范围");
      const pageRows = await tx.execute(sql`${projection} SELECT cells FROM filtered ORDER BY id DESC LIMIT ${query.limit} OFFSET ${query.offset}`);
      const rows = pageRows.map(row => {
        if (!Array.isArray(row.cells) || row.cells.length !== USER_MONEY_EXPORT_KEYS.length || row.cells.some(cell => typeof cell !== "string")) {
          throw new ValidateException("资金流水导出字段格式无效");
        }
        return Object.fromEntries(USER_MONEY_EXPORT_KEYS.map((key, index) => [key, (row.cells as string[])[index]])) as ExportRow;
      });
      if (rows.length !== Math.min(query.limit, count - query.offset)) throw new ValidateException("资金流水导出结果不完整，请重试");
      const manifest = { header: [...USER_MONEY_EXPORT_HEADER], filekey: [...USER_MONEY_EXPORT_KEYS], export: rows,
        filename: "资金监控", count, page: query.page, limit: query.limit, has_more: query.offset + rows.length < count,
        snapshot, csv_bytes: csvBytes, max_rows: USER_MONEY_EXPORT_MAX_ROWS,
        max_bytes: USER_MONEY_EXPORT_MAX_BYTES, timezone: "Asia/Shanghai" as const };
      if (encoder.encode(JSON.stringify(manifest)).byteLength > MAX_RESPONSE_BYTES - 1024) {
        throw new ValidateException("资金流水导出单页超过4MiB，请减少每页数量");
      }
      return manifest;
    });
  }
}
