import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { Container } from "@/lib/di";
import {
  supplierExtract,
  systemAdmin,
  systemSupplier,
} from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

function parsePositiveInt(value: string | undefined, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
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
  if (![1, 0, -1].includes(decision)) throw new ValidateException("审核类型错误");
  const approved = decision === 1;
  const message = optionalText(input, "message", 128) || optionalText(input, "fail_msg", 128);
  if (!approved && !message) throw new ValidateException("请填写拒绝原因");
  return { approved, message };
}

export function normalizeSupplierTransferInput(input: Record<string, unknown>) {
  const voucherTitle = optionalText(input, "voucher_title", 256);
  const voucherImage = optionalText(input, "voucher_image", 256);
  if (!voucherTitle) throw new ValidateException("请填写转账说明");
  if (!voucherImage) throw new ValidateException("请填写转账凭证地址");
  return { voucherTitle, voucherImage };
}

function parseEpoch(value: string | undefined, endOfDay = false): number | undefined {
  if (!value) return undefined;
  if (/^\d{10}$/.test(value)) return Number(value);
  const suffix = endOfDay ? "T23:59:59+08:00" : "T00:00:00+08:00";
  const milliseconds = Date.parse(`${value}${suffix}`);
  if (!Number.isFinite(milliseconds)) throw new ValidateException("日期格式错误");
  return Math.floor(milliseconds / 1000);
}

export class AdminSupplierFinanceService {
  constructor(private readonly container: Container) {}

  async list(query: Record<string, string>) {
    const page = parsePositiveInt(query.page, 1, 100000);
    const limit = parsePositiveInt(query.limit, 20, 100);
    const baseConditions: SQL[] = [eq(systemSupplier.isDel, 0)];
    const supplierId = Number(query.supplier_id ?? 0);
    if (Number.isInteger(supplierId) && supplierId > 0) {
      baseConditions.push(eq(supplierExtract.supplierId, supplierId));
    }
    if (["bank", "alipay", "weixin"].includes(query.extract_type ?? "")) {
      baseConditions.push(eq(supplierExtract.extractType, query.extract_type));
    }
    const keyword = (query.keyword || query.nireid || "").trim();
    if (keyword) {
      const search = or(
        ilike(systemSupplier.supplierName, `%${keyword}%`),
        ilike(systemSupplier.name, `%${keyword}%`),
        ilike(systemSupplier.phone, `%${keyword}%`),
        sql`${supplierExtract.id}::text ILIKE ${`%${keyword}%`}`,
      );
      if (search) baseConditions.push(search);
    }
    const startTime = parseEpoch(query.start_time || query.date_from);
    const endTime = parseEpoch(query.end_time || query.date_to, true);
    if (startTime !== undefined) baseConditions.push(sql`${supplierExtract.addTime} >= ${startTime}`);
    if (endTime !== undefined) baseConditions.push(sql`${supplierExtract.addTime} <= ${endTime}`);

    const listConditions = [...baseConditions];
    if (["-1", "0", "1"].includes(query.status ?? "")) {
      listConditions.push(eq(supplierExtract.status, Number(query.status)));
    }
    if (["0", "1"].includes(query.pay_status ?? "")) {
      listConditions.push(eq(supplierExtract.payStatus, Number(query.pay_status)));
    }
    const listWhere = and(...listConditions);
    const statsWhere = and(...baseConditions);
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
    const [list, count, stats] = await Promise.all([
      this.container.db
        .select(selection)
        .from(supplierExtract)
        .innerJoin(systemSupplier, eq(systemSupplier.id, supplierExtract.supplierId))
        .leftJoin(systemAdmin, eq(systemAdmin.id, supplierExtract.adminId))
        .where(listWhere)
        .orderBy(desc(supplierExtract.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(supplierExtract)
        .innerJoin(systemSupplier, eq(systemSupplier.id, supplierExtract.supplierId))
        .where(listWhere),
      this.container.db
        .select({
          pendingReview: sql<string>`COALESCE(SUM(CASE WHEN ${supplierExtract.status} = 0 THEN ${supplierExtract.extractPrice} ELSE 0 END), 0)::numeric(12,2)`,
          pendingTransfer: sql<string>`COALESCE(SUM(CASE WHEN ${supplierExtract.status} = 1 AND ${supplierExtract.payStatus} = 0 THEN ${supplierExtract.extractPrice} ELSE 0 END), 0)::numeric(12,2)`,
          paid: sql<string>`COALESCE(SUM(CASE WHEN ${supplierExtract.status} = 1 AND ${supplierExtract.payStatus} = 1 THEN ${supplierExtract.extractPrice} ELSE 0 END), 0)::numeric(12,2)`,
          rejected: sql<string>`COALESCE(SUM(CASE WHEN ${supplierExtract.status} = -1 THEN ${supplierExtract.extractPrice} ELSE 0 END), 0)::numeric(12,2)`,
        })
        .from(supplierExtract)
        .innerJoin(systemSupplier, eq(systemSupplier.id, supplierExtract.supplierId))
        .where(statsWhere),
    ]);
    return {
      list,
      count: count[0]?.count ?? 0,
      page,
      limit,
      extract_statistics: {
        pending_review: stats[0]?.pendingReview ?? "0.00",
        pending_transfer: stats[0]?.pendingTransfer ?? "0.00",
        paid: stats[0]?.paid ?? "0.00",
        rejected: stats[0]?.rejected ?? "0.00",
      },
    };
  }

  async review(id: number, adminId: number, input: Record<string, unknown>) {
    const { approved, message } = normalizeSupplierExtractReviewInput(input);
    const now = Math.floor(Date.now() / 1000);
    const rows = await this.container.db
      .update(supplierExtract)
      .set({
        status: approved ? 1 : -1,
        adminId,
        failMsg: approved ? "" : message,
        failTime: approved ? 0 : now,
      })
      .where(and(eq(supplierExtract.id, id), eq(supplierExtract.status, 0)))
      .returning({ id: supplierExtract.id });
    if (rows[0]) return;
    const existing = await this.container.db
      .select({ status: supplierExtract.status })
      .from(supplierExtract)
      .where(eq(supplierExtract.id, id))
      .limit(1);
    if (!existing[0]) throw new NotFoundException("提现记录不存在");
    throw new ValidateException("提现记录已审核，请勿重复操作");
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

  async updateMark(id: number, mark: string) {
    const normalized = mark.trim();
    if (!normalized) throw new ValidateException("请填写后台备注");
    if (normalized.length > 512) throw new ValidateException("后台备注不能超过 512 个字符");
    const rows = await this.container.db
      .update(supplierExtract)
      .set({ mark: normalized })
      .where(eq(supplierExtract.id, id))
      .returning({ id: supplierExtract.id });
    if (!rows[0]) throw new NotFoundException("提现记录不存在");
  }
}
