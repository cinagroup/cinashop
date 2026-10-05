import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  supplierExtract,
  supplierFlowingWater,
  systemAdmin,
  systemLog,
  systemSupplier,
} from "@/models/schema";
import { HttpApiException, NotFoundException, ValidateException } from "@/utils/errors";
import { lockSupplierFinance } from '@/services/supplier/SupplierFinanceLock';

const MAX_INT = 2_147_483_647;
const QUERY_KEYS = ["supplier_id", "status", "pay_status", "extract_type", "keyword", "nireid",
  "data", "start_time", "end_time", "date_from", "date_to", "page", "limit"] as const;
type ListQuery = { supplierId: number | null; status: number | null; payStatus: number | null;
  extractType: string | null; keyword: string; start: number | null; end: number | null;
  page: number; limit: number; offset: number };

function positiveInt(value: string | null, label: string, fallback: number, maximum: number) {
  if (value === null || value === "") return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new ValidateException(`${label}无效`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new ValidateException(`${label}超出范围`);
  return parsed;
}

function optionalText(input: Record<string, unknown>, key: string, maxLength: number) {
  const value = input[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidateException(`${key}格式错误`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ValidateException(`${key}长度不能超过 ${maxLength}`);
  }
  return normalized;
}

export function normalizeSupplierExtractReviewInput(input: Record<string, unknown>) {
  const decision = Number(input.type ?? input.status ?? 1);
  // The old Admin radio submits type='2' for refusal. The new page uses 0.
  if (![1, 0, -1, 2].includes(decision)) throw new ValidateException("审核类型错误");
  const approved = decision === 1;
  const message = optionalText(input, "message", 128) || optionalText(input, "fail_msg", 128);
  if (!approved && !message) throw new ValidateException("请填写拒绝原因");
  return { approved, message };
}

export function normalizeSupplierTransferInput(input: Record<string, unknown>) {
  const voucherTitle = optionalText(input, "voucher_title", 256);
  const voucherImage = optionalText(input, "voucher_image", 256);
  if (!voucherTitle) throw new ValidateException("请填写转账说明");
  // Legacy transfer form requires its title; the image picker is optional.
  return { voucherTitle, voucherImage };
}

function shanghaiSecond(value: string, label: string) {
  if (/^\d{10}$/.test(value)) {
    const epoch = Number(value);
    if (epoch > MAX_INT) throw new ValidateException(`${label}超出时间范围`);
    const local = new Date((epoch + 8 * 3600) * 1000);
    return { epoch, midnight: local.getUTCHours() === 0 && local.getUTCMinutes() === 0 && local.getUTCSeconds() === 0 };
  }
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(value);
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

function parseRange(parameters: URLSearchParams) {
  const data = parameters.get("data") ?? "";
  const startRaw = parameters.get("start_time") ?? parameters.get("date_from") ?? "";
  const endRaw = parameters.get("end_time") ?? parameters.get("date_to") ?? "";
  if (data && (startRaw || endRaw)) throw new ValidateException("提现日期参数不能混用");
  if ((parameters.has("start_time") && parameters.has("date_from")) ||
    (parameters.has("end_time") && parameters.has("date_to"))) throw new ValidateException("提现日期参数重复");
  let from = startRaw, to = endRaw;
  if (data) {
    const match = /^(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?)-(\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2}:\d{2})?)$/.exec(data);
    if (!match) throw new ValidateException("提现日期范围格式错误");
    from = match[1]; to = match[2];
  }
  const start = from ? shanghaiSecond(from, "开始时间") : null;
  const end = to ? shanghaiSecond(to, "结束时间") : null;
  if (start && end && end.epoch < start.epoch) throw new ValidateException("提现结束时间早于开始时间");
  const extension = end && (end.midnight || end.epoch === start?.epoch) ? 86_400 : 0;
  if (end && end.epoch + extension > MAX_INT) throw new ValidateException("提现结束时间超出范围");
  if (start && end && end.epoch - start.epoch > 366 * 86_400) {
    throw new ValidateException("提现日期跨度不能超过366天");
  }
  // PHP ModelTrait uses inclusive BETWEEN and extends midnight endings or
  // identical start/end instants by one day.
  return { start: start?.epoch ?? null, end: end ? end.epoch + extension : null };
}

function listQuery(parameters: URLSearchParams): ListQuery {
  for (const key of parameters.keys()) {
    if (!(QUERY_KEYS as readonly string[]).includes(key) || parameters.getAll(key).length !== 1) {
      throw new ValidateException("提现查询参数未知或重复");
    }
  }
  const rawSupplier = parameters.get("supplier_id");
  // Legacy searchSupplierIdAttr filters literal 0; only an absent/empty value means all.
  const supplierId = rawSupplier === null || rawSupplier === "" ? null :
    rawSupplier === "0" ? 0 : positiveInt(rawSupplier, "供应商", 0, MAX_INT);
  const rawStatus = parameters.get("status") ?? "";
  const rawPayStatus = parameters.get("pay_status") ?? "";
  if (!["", "-1", "0", "1"].includes(rawStatus)) throw new ValidateException("审核状态无效");
  if (!["", "0", "1"].includes(rawPayStatus)) throw new ValidateException("转账状态无效");
  const rawType = parameters.get("extract_type") ?? "";
  const extractType = rawType === "wx" ? "weixin" : rawType;
  if (!["", "bank", "alipay", "weixin"].includes(extractType)) throw new ValidateException("收款方式无效");
  if (parameters.has("keyword") && parameters.has("nireid")) throw new ValidateException("提现搜索参数重复");
  const keyword = (parameters.get("keyword") ?? parameters.get("nireid") ?? "").trim();
  if ([...keyword].length > 80 || /[\u0000-\u001f\u007f]/u.test(keyword)) throw new ValidateException("提现搜索词无效");
  const page = positiveInt(parameters.get("page"), "页码", 1, 1000);
  const limit = positiveInt(parameters.get("limit"), "每页条数", 15, 100);
  const offset = (page - 1) * limit;
  if (offset > 10_000) throw new ValidateException("提现分页超出范围");
  return { supplierId, status: rawStatus ? Number(rawStatus) : null,
    payStatus: rawPayStatus ? Number(rawPayStatus) : null,
    extractType: extractType || null, keyword, ...parseRange(parameters), page, limit, offset };
}

async function readOnly(tx: DbClient) {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  await tx.execute(sql`SELECT
    set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
    set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
    set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
}

function baseWhere(input: ListQuery): SQL {
  const conditions: SQL[] = [];
  if (input.supplierId !== null) conditions.push(eq(supplierExtract.supplierId, input.supplierId));
  if (input.extractType) conditions.push(eq(supplierExtract.extractType, input.extractType));
  if (input.start !== null) conditions.push(gte(supplierExtract.addTime, input.start));
  if (input.end !== null) conditions.push(lte(supplierExtract.addTime, input.end));
  if (input.keyword) {
    const pattern = `%${input.keyword.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(or(ilike(systemSupplier.supplierName, pattern), ilike(systemSupplier.name, pattern),
      ilike(systemSupplier.phone, pattern), sql`${supplierExtract.id}::text ILIKE ${pattern}`)!);
  }
  return conditions.length ? and(...conditions)! : sql`true`;
}

function cents(value: string | null | undefined): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value ?? "0");
  if (!match) throw new Error("Invalid finance aggregate");
  const magnitude = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -magnitude : magnitude;
}

function money(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

export class AdminSupplierFinanceService {
  constructor(private readonly container: Container) {}

  async suppliers(parameters: URLSearchParams) {
    if ([...parameters.keys()].length) throw new ValidateException("供应商选项不接受查询参数");
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const rows = await tx.select({ id: systemSupplier.id, supplierName: systemSupplier.supplierName })
        .from(systemSupplier).where(eq(systemSupplier.isDel, 0)).orderBy(desc(systemSupplier.id)).limit(10_001);
      if (rows.length > 10_000) throw new ValidateException("供应商选项超过10000行");
      return { list: rows };
    });
  }

  async list(parameters: URLSearchParams) {
    const input = listQuery(parameters);
    const base = baseWhere(input);
    const conditions: SQL[] = [base];
    if (input.status !== null) conditions.push(eq(supplierExtract.status, input.status));
    if (input.payStatus !== null) conditions.push(eq(supplierExtract.payStatus, input.payStatus));
    const listWhere = and(...conditions)!;
    const selection = {
      id: supplierExtract.id,
      supplierId: supplierExtract.supplierId,
      supplierName: systemSupplier.supplierName,
      contactName: systemSupplier.name,
      phone: systemSupplier.phone,
      extractType: supplierExtract.extractType,
      bankCode: supplierExtract.bankCode,
      bankAddress: supplierExtract.bankAddress,
      alipayAccount: supplierExtract.alipayAccount,
      wechat: supplierExtract.wechat,
      qrcodeUrl: supplierExtract.qrcodeUrl,
      extractPrice: supplierExtract.extractPrice,
      balance: supplierExtract.balance,
      mark: supplierExtract.mark,
      supplierMark: supplierExtract.supplierMark,
      status: supplierExtract.status,
      payStatus: supplierExtract.payStatus,
      adminId: supplierExtract.adminId,
      adminName: systemAdmin.realName,
      failMsg: supplierExtract.failMsg,
      failTime: supplierExtract.failTime,
      voucherImage: supplierExtract.voucherImage,
      voucherTitle: supplierExtract.voucherTitle,
      payTime: supplierExtract.payTime,
      addTime: supplierExtract.addTime,
    };
    return withTx(this.container, async tx => {
      await readOnly(tx);
      const [count] = await tx.select({ count: sql<number>`count(*)::int` })
        .from(supplierExtract).leftJoin(systemSupplier, eq(systemSupplier.id, supplierExtract.supplierId))
        .where(listWhere);
      const list = await tx.select(selection).from(supplierExtract)
        .leftJoin(systemSupplier, eq(systemSupplier.id, supplierExtract.supplierId))
        .leftJoin(systemAdmin, eq(systemAdmin.id, supplierExtract.adminId))
        .where(listWhere).orderBy(desc(supplierExtract.id)).limit(input.limit).offset(input.offset);
      const [stats] = await tx.select({
        pendingReview: sql<string>`coalesce(sum(case when ${supplierExtract.status}=0
          ${input.payStatus === null ? sql`` : sql`and ${supplierExtract.payStatus}=${input.payStatus}`}
          then ${supplierExtract.extractPrice} else 0 end),0)::numeric(20,2)::text`,
        pendingTransfer: sql<string>`coalesce(sum(case when ${supplierExtract.status}=1
          and ${supplierExtract.payStatus}=0 then ${supplierExtract.extractPrice} else 0 end),0)::numeric(20,2)::text`,
        paid: sql<string>`coalesce(sum(case when ${supplierExtract.status}=1
          and ${supplierExtract.payStatus}=1 then ${supplierExtract.extractPrice} else 0 end),0)::numeric(20,2)::text`,
        rejected: sql<string>`coalesce(sum(case when ${supplierExtract.status}=-1
          then ${supplierExtract.extractPrice} else 0 end),0)::numeric(20,2)::text`,
      }).from(supplierExtract).leftJoin(systemSupplier, eq(systemSupplier.id, supplierExtract.supplierId))
        .where(base);
      // This is a finance balance, not a filtered list subtotal. Deleted/orphan
      // supplier history remains included when every supplier is selected.
      // PHP's all-supplier supplier_id=0 sum accidentally omitted reservations.
      const flowWhere: SQL[] = [eq(supplierFlowingWater.isDel, 0), eq(supplierFlowingWater.status, 1)];
      const extractWhere: SQL[] = [sql`${supplierExtract.status}<>-1`];
      if (input.supplierId !== null) {
        flowWhere.push(eq(supplierFlowingWater.supplierId, input.supplierId));
        extractWhere.push(eq(supplierExtract.supplierId, input.supplierId));
      }
      const [flow] = await tx.select({ net: sql<string>`coalesce(sum(case when ${supplierFlowingWater.pm}=1
        then ${supplierFlowingWater.number} else -${supplierFlowingWater.number} end),0)::numeric(20,2)::text` })
        .from(supplierFlowingWater).where(and(...flowWhere));
      const [reserved] = await tx.select({ amount: sql<string>`coalesce(sum(${supplierExtract.extractPrice}),0)::numeric(20,2)::text` })
        .from(supplierExtract).where(and(...extractWhere));
      const available = cents(flow?.net) - cents(reserved?.amount);
      return { list: list.map(row => ({ ...row, supplierName: row.supplierName ?? "",
        contactName: row.contactName ?? "", phone: row.phone ?? "", adminName: row.adminName ?? "" })),
        count: count?.count ?? 0, page: input.page, limit: input.limit,
        extract_statistics: { pending_review: stats?.pendingReview ?? "0.00",
          pending_transfer: stats?.pendingTransfer ?? "0.00", paid: stats?.paid ?? "0.00",
          rejected: stats?.rejected ?? "0.00", withdrawable: money(available > 0n ? available : 0n) } };
    });
  }

  async review(id: number, adminId: number, input: Record<string, unknown>) {
    const { approved, message } = normalizeSupplierExtractReviewInput(input);
    const now = Math.floor(Date.now() / 1000);
    await this.container.db.transaction(async tx => {
      // supplierId is immutable in the extract workflow. Discover it without
      // taking a row lock: all writers must take supplier mutex -> extract row.
      const [target] = await tx.select({ supplierId: supplierExtract.supplierId })
        .from(supplierExtract).where(eq(supplierExtract.id, id)).limit(1);
      if (!target) throw new NotFoundException("提现记录不存在");
      await lockSupplierFinance(tx, target.supplierId);
      const rows = await tx.update(supplierExtract).set({
        status: approved ? 1 : -1,
        adminId,
        failMsg: approved ? "" : message,
        failTime: approved ? 0 : now,
      }).where(and(eq(supplierExtract.id, id), eq(supplierExtract.supplierId, target.supplierId),
        eq(supplierExtract.status, 0))).returning({ id: supplierExtract.id });
      if (rows[0]) return;
      const [existing] = await tx.select({ id: supplierExtract.id }).from(supplierExtract)
        .where(eq(supplierExtract.id, id)).limit(1);
      if (!existing) throw new NotFoundException("提现记录不存在");
      throw new ValidateException("提现记录已审核，请勿重复操作");
    });
  }

  async transfer(id: number, adminId: number, input: Record<string, unknown>) {
    const { voucherTitle, voucherImage } = normalizeSupplierTransferInput(input);
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.container.db
      .update(supplierExtract)
      .set({
        payStatus: 1,
        adminId,
        voucherTitle,
        voucherImage,
        payTime: now,
      })
      .where(
        and(
          eq(supplierExtract.id, id),
          eq(supplierExtract.status, 1),
          eq(supplierExtract.payStatus, 0),
        ),
      )
      .returning({ id: supplierExtract.id });
    if (rows[0]) return;
    const existing = await this.container.db
      .select({ status: supplierExtract.status, payStatus: supplierExtract.payStatus })
      .from(supplierExtract)
      .where(eq(supplierExtract.id, id))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("提现记录不存在");
    if (existing[0].status !== 1) throw new ValidateException("请先审核通过提现记录");
    throw new ValidateException("该提现记录已经完成转账");
  }

  async updateMark(id: number, adminId: number, input: Record<string, unknown>) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_INT ||
      !Number.isSafeInteger(adminId) || adminId <= 0) throw new ValidateException("备注身份或记录无效");
    if (Object.keys(input).some(key => !["mark", "expected_supplier_mark"].includes(key)) ||
      !Object.hasOwn(input, "expected_supplier_mark") || typeof input.mark !== "string" ||
      typeof input.expected_supplier_mark !== "string") throw new ValidateException("备注请求字段无效");
    const mark = input.mark, expected = input.expected_supplier_mark;
    if (!mark.trim() || [...mark].length > 200 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(mark) ||
      [...expected].length > 255 || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(expected)) {
      throw new ValidateException("备注无效或超过200字");
    }
    return withTx(this.container, async tx => {
      await tx.execute(sql`SELECT
        set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text||'ms',true),
        set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),2000),2000)::text||'ms',true),
        set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text||'ms',true)`);
      const [current] = await tx.select({ id: supplierExtract.id, supplierMark: supplierExtract.supplierMark })
        .from(supplierExtract).where(eq(supplierExtract.id, id)).limit(1).for("update");
      if (!current) throw new NotFoundException("提现记录不存在");
      if (current.supplierMark !== expected) throw new HttpApiException("备注已变更，请刷新后重试", 409, 409);
      if (current.supplierMark === mark) return { id, supplierMark: mark };
      const [updated] = await tx.update(supplierExtract).set({ supplierMark: mark })
        .where(and(eq(supplierExtract.id, id), eq(supplierExtract.supplierMark, expected)))
        .returning({ id: supplierExtract.id, supplierMark: supplierExtract.supplierMark });
      if (!updated) throw new HttpApiException("备注已变更，请刷新后重试", 409, 409);
      await tx.insert(systemLog).values({ adminId, type: "supplier_extract",
        path: "/adminapi/supplier/extract/mark/:id", page: "/finance/supplier-extract",
        method: "POST", action: `supplier_extract.mark.update;id=${id};length=${[...mark].length}`,
        addTime: Math.floor(Date.now() / 1000) });
      return updated;
    });
  }
}
