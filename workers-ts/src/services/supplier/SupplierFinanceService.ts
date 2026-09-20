import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import {
  storeOrder,
  storeOrderCartInfo,
  supplierExtract,
  supplierFlowingWater,
  supplierTransactions,
  systemSupplier,
} from "@/models/schema";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import { parsePagination } from "@/services/supplier/SupplierService";
import { NotFoundException, ValidateException } from "@/utils/errors";
import type { RefundLineCompensation } from '@/services/order/OrderSplitFinance';
import { lockSupplierFinance } from '@/services/supplier/SupplierFinanceLock';

type SupplierFinanceDb = Pick<DbClient, "execute" | "insert" | "select" | "update">;
type FinanceOrder = Pick<
  typeof storeOrder.$inferSelect,
  | "id"
  | "supplierId"
  | "uid"
  | "orderId"
  | "payType"
  | "payPrice"
  | "totalPrice"
  | "payPostage"
  | "shippingType"
  | "payTime"
  | "addTime"
>;

/**
 * Supplier refunds use the same nearest-cent rule as the previous proportional
 * implementation, but derive every partial refund from the cumulative target.
 * Full refunds are capped exactly at the original settlement amount.
 */
export function targetSupplierRefundCents(
  originalCents: number,
  cumulativeRefundCents: number,
  paidCents: number,
): number {
  if (!Number.isSafeInteger(originalCents) || originalCents < 0) {
    throw new Error("供应商原结算金额无效");
  }
  if (!Number.isSafeInteger(cumulativeRefundCents) || cumulativeRefundCents < 0) {
    throw new Error("累计退款金额无效");
  }
  if (!Number.isSafeInteger(paidCents) || paidCents <= 0) {
    throw new Error("订单实付金额无效");
  }
  if (cumulativeRefundCents >= paidCents) return originalCents;
  const numerator = BigInt(originalCents) * BigInt(cumulativeRefundCents);
  const rounded = (numerator + BigInt(Math.floor(paidCents / 2))) / BigInt(paidCents);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("供应商退款计算超出安全范围");
  }
  return Number(rounded);
}

const EXTRACT_TYPES = ["bank", "alipay", "weixin"] as const;
type ExtractType = (typeof EXTRACT_TYPES)[number];

function normalizeOptionalString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidateException(`${key} 格式错误`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ValidateException(`${key} 长度不能超过 ${maxLength}`);
  return normalized;
}

export function amountToCents(value: unknown, fieldName = "金额"): number {
  const text = typeof value === "number" ? value.toFixed(2) : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new ValidateException(`${fieldName}格式错误`);
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new ValidateException(`${fieldName}必须大于 0`);
  return cents;
}

function decimalToCents(value: string | number | null | undefined): number {
  const text = String(value ?? "0");
  const negative = text.startsWith("-");
  const normalized = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -cents : cents;
}

function configLimitToCents(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return 0;
  return Math.max(decimalToCents(normalized), 0);
}

function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

async function settlementCents(db: SupplierFinanceDb, order: FinanceOrder): Promise<number> {
  const rows = await db
    .select({
      amount: sql<string>`COALESCE(SUM(${storeOrderCartInfo.settlePrice} * ${storeOrderCartInfo.cartNum}), 0)::numeric(12,2)`,
    })
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, order.id));
  const goods = decimalToCents(rows[0]?.amount);
  const postage = [2, 4].includes(order.shippingType) ? 0 : decimalToCents(order.payPostage);
  return goods + postage;
}

/** 支付成功时创建待结算流水和交易记录；唯一交易号保证回调幂等。 */
export async function recordSupplierPayment(
  db: SupplierFinanceDb,
  order: FinanceOrder,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (order.supplierId <= 0) return;
  const number = centsToDecimal(await settlementCents(db, order));
  const financeOrderId = `P${order.orderId}`;
  const common = {
    supplierId: order.supplierId,
    uid: order.uid,
    orderId: financeOrderId,
    linkId: order.orderId,
    pm: 1,
    type: 1,
    payType: order.payType,
    payPrice: order.payPrice,
    totalPrice: order.totalPrice,
    payPostage: order.payPostage,
    tradeTime: order.payTime || now,
    addTime: now,
  } as const;

  await db
    .insert(supplierFlowingWater)
    .values({ ...common, number, status: 0 })
    .onConflictDoNothing({ target: supplierFlowingWater.orderId });
  await db
    .insert(supplierTransactions)
    .values(common)
    .onConflictDoNothing({ target: supplierTransactions.orderId });
}

/** 收货时同单的待结算收入和已完成退款一起转入余额，不能只转收入。 */
export async function settleSupplierPayment(
  db: SupplierFinanceDb,
  supplierId: number,
  linkId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (supplierId <= 0) return;
  await lockSupplierFinance(db, supplierId);
  await db
    .update(supplierFlowingWater)
    .set({ status: 1, finishTime: now })
    .where(
      and(
        eq(supplierFlowingWater.supplierId, supplierId),
        eq(supplierFlowingWater.linkId, linkId),
        inArray(supplierFlowingWater.type, [1, 2]),
        eq(supplierFlowingWater.status, 0),
        eq(supplierFlowingWater.isDel, 0),
      ),
    );
}

/** 实际退款完成后写供应商负向流水。现代订单按已退商品结算价和运费；
 * 无版本旧单继续使用原累计现金比例。调用者持有订单锁并传入锁后行级计划。 */
export async function recordSupplierRefund(
  db: SupplierFinanceDb,
  order: FinanceOrder,
  refundId: number,
  refundPrice: string,
  cumulativeRefundCents: number,
  now = Math.floor(Date.now() / 1000),
  lineCompensation?: RefundLineCompensation | null,
): Promise<void> {
  if (order.supplierId <= 0) return;
  await lockSupplierFinance(db, order.supplierId);
  const original = await db
    .select({
      id: supplierFlowingWater.id,
      number: supplierFlowingWater.number,
      status: supplierFlowingWater.status,
      uid: supplierFlowingWater.uid,
      payType: supplierFlowingWater.payType,
      payPrice: supplierFlowingWater.payPrice,
      totalPrice: supplierFlowingWater.totalPrice,
      payPostage: supplierFlowingWater.payPostage,
    })
    .from(supplierFlowingWater)
    .where(
      and(
        eq(supplierFlowingWater.supplierId, order.supplierId),
        eq(supplierFlowingWater.linkId, order.orderId),
        eq(supplierFlowingWater.type, 1),
        eq(supplierFlowingWater.pm, 1),
        inArray(supplierFlowingWater.status, [0, 1]),
        eq(supplierFlowingWater.isDel, 0),
      ),
    )
    .limit(2).for('update');
  if (original.length > 1) throw new ValidateException("供应商退款原结算流水不唯一，请先完成核对");
  const supplierBasis = lineCompensation?.supplierSettlement;
  if (lineCompensation && !supplierBasis) throw new ValidateException('供应商退款行级结算证据缺失');
  const strictCents = (value: string): number => {
    if (!/^\d{1,10}\.\d{2}$/.test(value)) throw new ValidateException('供应商退款结算金额证据无效');
    const cents = decimalToCents(value);
    if (!Number.isSafeInteger(cents) || cents < 0) throw new ValidateException('供应商退款结算金额证据无效');
    return cents;
  };
  if (supplierBasis && (!original[0] || original[0].uid !== order.uid || original[0].payType !== order.payType
    || ['payPrice', 'totalPrice', 'payPostage'].some(field => {
      const key = field as 'payPrice' | 'totalPrice' | 'payPostage';
      return strictCents(original[0][key]) !== strictCents(order[key]);
    }) || strictCents(original[0].number) !== supplierBasis.total
    || [supplierBasis.total, supplierBasis.refunded].some(value => !Number.isSafeInteger(value) || value < 0)
    || supplierBasis.refunded > supplierBasis.total)) throw new ValidateException('供应商退款原结算账本与商品证据不一致');
  const previousRows = await db
    .select({ number: supplierFlowingWater.number, uid: supplierFlowingWater.uid, payType: supplierFlowingWater.payType })
    .from(supplierFlowingWater)
    .where(
      and(
        eq(supplierFlowingWater.supplierId, order.supplierId),
        eq(supplierFlowingWater.linkId, order.orderId),
        eq(supplierFlowingWater.type, 2),
        eq(supplierFlowingWater.pm, 0),
        inArray(supplierFlowingWater.status, [0, 1]),
        eq(supplierFlowingWater.isDel, 0),
      ),
    );
  const paidCents = decimalToCents(order.payPrice);
  const originalCents = decimalToCents(original[0]?.number);
  const targetCents = supplierBasis?.refunded ?? targetSupplierRefundCents(
    originalCents,
    cumulativeRefundCents,
    paidCents,
  );
  const previousCents = previousRows.reduce((sum, row) => {
    if (supplierBasis && (row.uid !== order.uid || row.payType !== order.payType)) throw new ValidateException('供应商历史退款归属证据不一致');
    const next = sum + (supplierBasis ? strictCents(row.number) : Math.max(decimalToCents(row.number), 0));
    if (!Number.isSafeInteger(next)) throw new Error("供应商已退结算金额超出安全范围");
    return next;
  }, 0);
  if (supplierBasis && previousCents > targetCents) throw new ValidateException('供应商历史已退结算额超过商品目标，请先核对');
  const number = centsToDecimal(Math.max(targetCents - previousCents, 0));
  const financeOrderId = `R${refundId}-${order.orderId}`;
  const common = {
    supplierId: order.supplierId,
    uid: order.uid,
    orderId: financeOrderId,
    linkId: order.orderId,
    pm: 0,
    type: 2,
    payType: order.payType,
    payPrice: refundPrice,
    totalPrice: order.totalPrice,
    payPostage: "0.00",
    tradeTime: now,
    addTime: now,
  } as const;

  // Pending refunds offset only their own pending entitlement. For a full
  // refund, recognize the income and all matching reversals together (net zero)
  // in the caller's settlement transaction. Cancelling the income while posting
  // a settled expense would consume unrelated received-order balances.
  const pending = original[0]?.status === 0;
  const fullyRefunded = supplierBasis?.fullyRefunded ?? cumulativeRefundCents >= paidCents;
  if (pending && fullyRefunded) await settleSupplierPayment(db, order.supplierId, order.orderId, now);
  const status = pending && !fullyRefunded ? 0 : 1;

  if (supplierBasis) {
    // The caller's terminal refund replay returns before this function. A
    // pre-existing modern identity here is inconsistent evidence, not success:
    // either collision must roll back both ledgers and the customer refund.
    await db.insert(supplierFlowingWater).values({ ...common, number, status, finishTime: status === 1 ? now : 0 });
    await db.insert(supplierTransactions).values(common);
    return;
  }
  await db
    .insert(supplierFlowingWater)
    .values({ ...common, number, status, finishTime: status === 1 ? now : 0 })
    .onConflictDoNothing({ target: supplierFlowingWater.orderId });
  await db
    .insert(supplierTransactions)
    .values(common)
    .onConflictDoNothing({ target: supplierTransactions.orderId });
}

export class SupplierFinanceService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async info(supplierId: number) {
    const supplier = await this.container.systemSupplierDao.getOrThrow(supplierId, "供应商不存在");
    return {
      bank_code: supplier.bankCode === "0" ? "" : supplier.bankCode,
      bank_address: supplier.bankAddress,
      alipay_account: supplier.alipayAccount,
      alipay_qrcode_url: supplier.alipayQrcodeUrl,
      wechat: supplier.wechat,
      wechat_qrcode_url: supplier.wechatQrcodeUrl,
    };
  }

  async updateInfo(supplierId: number, input: Record<string, unknown>) {
    const update: Partial<typeof systemSupplier.$inferInsert> = {};
    const bankCode = normalizeOptionalString(input, "bank_code", 32);
    const bankAddress = normalizeOptionalString(input, "bank_address", 256);
    const alipayAccount = normalizeOptionalString(input, "alipay_account", 64);
    const alipayQrcodeUrl = normalizeOptionalString(input, "alipay_qrcode_url", 255);
    const wechat = normalizeOptionalString(input, "wechat", 15);
    const wechatQrcodeUrl = normalizeOptionalString(input, "wechat_qrcode_url", 255);
    if (bankCode !== undefined) update.bankCode = bankCode;
    if (bankAddress !== undefined) update.bankAddress = bankAddress;
    if (alipayAccount !== undefined) update.alipayAccount = alipayAccount;
    if (alipayQrcodeUrl !== undefined) update.alipayQrcodeUrl = alipayQrcodeUrl;
    if (wechat !== undefined) update.wechat = wechat;
    if (wechatQrcodeUrl !== undefined) update.wechatQrcodeUrl = wechatQrcodeUrl;
    if (Object.keys(update).length === 0) throw new ValidateException("没有可保存的财务信息");
    const rows = await this.container.db
      .update(systemSupplier)
      .set(update)
      .where(and(eq(systemSupplier.id, supplierId), eq(systemSupplier.isDel, 0)))
      .returning({ id: systemSupplier.id });
    if (!rows[0]) throw new NotFoundException("供应商不存在");
  }

  async summary(supplierId: number) {
    const [flowRows, extractRows] = await Promise.all([
      this.container.db
        .select({
          settledIncome: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.status} = 1 AND ${supplierFlowingWater.pm} = 1 THEN ${supplierFlowingWater.number} ELSE 0 END), 0)::numeric(12,2)`,
          settledExpense: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.status} = 1 AND ${supplierFlowingWater.pm} = 0 THEN ${supplierFlowingWater.number} ELSE 0 END), 0)::numeric(12,2)`,
          pendingIncome: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.status} = 0 THEN CASE WHEN ${supplierFlowingWater.pm} = 1 THEN ${supplierFlowingWater.number} ELSE -${supplierFlowingWater.number} END ELSE 0 END), 0)::numeric(12,2)`,
          totalRefund: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.status} IN (0, 1) AND ${supplierFlowingWater.pm} = 0 THEN ${supplierFlowingWater.number} ELSE 0 END), 0)::numeric(12,2)`,
        })
        .from(supplierFlowingWater)
        .where(
          and(
            eq(supplierFlowingWater.supplierId, supplierId),
            eq(supplierFlowingWater.isDel, 0),
          ),
        ),
      this.container.db
        .select({
          reserved: sql<string>`COALESCE(SUM(CASE WHEN ${supplierExtract.status} <> -1 THEN ${supplierExtract.extractPrice} ELSE 0 END), 0)::numeric(12,2)`,
          paid: sql<string>`COALESCE(SUM(CASE WHEN ${supplierExtract.status} = 1 AND ${supplierExtract.payStatus} = 1 THEN ${supplierExtract.extractPrice} ELSE 0 END), 0)::numeric(12,2)`,
          pending: sql<string>`COALESCE(SUM(CASE WHEN ${supplierExtract.status} = 0 THEN ${supplierExtract.extractPrice} ELSE 0 END), 0)::numeric(12,2)`,
        })
        .from(supplierExtract)
        .where(eq(supplierExtract.supplierId, supplierId)),
    ]);
    const flow = flowRows[0];
    const extract = extractRows[0];
    const available = Math.max(
      decimalToCents(flow?.settledIncome) -
        decimalToCents(flow?.settledExpense) -
        decimalToCents(extract?.reserved),
      0,
    );
    return {
      available: centsToDecimal(available),
      pending_settlement: flow?.pendingIncome ?? "0.00",
      total_income: flow?.settledIncome ?? "0.00",
      total_refund: flow?.totalRefund ?? "0.00",
      pending_extract: extract?.pending ?? "0.00",
      paid_extract: extract?.paid ?? "0.00",
    };
  }

  async flowList(supplierId: number, query: Record<string, string>) {
    const page = parsePagination(query.page, query.limit);
    const conditions: SQL[] = [
      eq(supplierFlowingWater.supplierId, supplierId),
      eq(supplierFlowingWater.isDel, 0),
    ];
    if (query.type === "1" || query.type === "2") {
      conditions.push(eq(supplierFlowingWater.type, Number(query.type)));
    }
    const keyword = query.keyword?.trim();
    if (keyword) {
      const search = or(
        ilike(supplierFlowingWater.orderId, `%${keyword}%`),
        ilike(supplierFlowingWater.linkId, `%${keyword}%`),
      );
      if (search) conditions.push(search);
    }
    const where = and(...conditions);
    const [list, count] = await Promise.all([
      this.container.db
        .select()
        .from(supplierFlowingWater)
        .where(where)
        .orderBy(desc(supplierFlowingWater.id))
        .limit(page.limit)
        .offset(page.offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(supplierFlowingWater)
        .where(where),
    ]);
    return { list, count: count[0]?.count ?? 0, page: page.page, limit: page.limit };
  }

  async fundRecord(supplierId: number, query: Record<string, string>) {
    const page = parsePagination(query.page, query.limit);
    const timeType = ["day", "week", "month"].includes(query.timeType ?? "")
      ? query.timeType
      : "day";
    const period: SQL<string> =
      timeType === "week"
        ? sql`TO_CHAR(TO_TIMESTAMP(${supplierFlowingWater.addTime}) AT TIME ZONE 'Asia/Shanghai', 'IYYY-IW')`
        : timeType === "month"
          ? sql`TO_CHAR(TO_TIMESTAMP(${supplierFlowingWater.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM')`
          : sql`TO_CHAR(TO_TIMESTAMP(${supplierFlowingWater.addTime}) AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`;
    const where = and(
      eq(supplierFlowingWater.supplierId, supplierId),
      eq(supplierFlowingWater.status, 1),
      eq(supplierFlowingWater.isDel, 0),
    );
    const [list, count] = await Promise.all([
      this.container.db
        .select({
          period,
          add_time: sql<number>`MIN(${supplierFlowingWater.addTime})::int`,
          ids: sql<string>`STRING_AGG(${supplierFlowingWater.id}::text, ',' ORDER BY ${supplierFlowingWater.id})`,
          income_num: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.pm} = 1 THEN ${supplierFlowingWater.number} ELSE 0 END), 0)::numeric(12,2)`,
          exp_num: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.pm} = 0 THEN ${supplierFlowingWater.number} ELSE 0 END), 0)::numeric(12,2)`,
        })
        .from(supplierFlowingWater)
        .where(where)
        .groupBy(period)
        .orderBy(desc(sql`MAX(${supplierFlowingWater.addTime})`))
        .limit(page.limit)
        .offset(page.offset),
      this.container.db
        .select({ count: sql<number>`COUNT(DISTINCT ${period})::int` })
        .from(supplierFlowingWater)
        .where(where),
    ]);
    return {
      list: list.map((item) => ({
        ...item,
        title: timeType === "week" ? "周账单" : timeType === "month" ? "月账单" : "日账单",
        entry_num: centsToDecimal(
          decimalToCents(item.income_num) - decimalToCents(item.exp_num),
        ),
      })),
      count: count[0]?.count ?? 0,
      page: page.page,
      limit: page.limit,
    };
  }

  async fundRecordInfo(supplierId: number, query: Record<string, string>) {
    const ids = (query.ids ?? "")
      .split(",")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, 100);
    if (ids.length === 0) throw new ValidateException("账单明细ID不能为空");
    const page = parsePagination(query.page, query.limit);
    const where = and(
      eq(supplierFlowingWater.supplierId, supplierId),
      eq(supplierFlowingWater.isDel, 0),
      inArray(supplierFlowingWater.id, ids),
    );
    const [list, count] = await Promise.all([
      this.container.db
        .select()
        .from(supplierFlowingWater)
        .where(where)
        .orderBy(desc(supplierFlowingWater.id))
        .limit(page.limit)
        .offset(page.offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(supplierFlowingWater)
        .where(where),
    ]);
    return { list, count: count[0]?.count ?? 0, page: page.page, limit: page.limit };
  }

  async updateFlowMark(supplierId: number, id: number, mark: string) {
    const normalized = mark.trim();
    if (!normalized) throw new ValidateException("请输入备注");
    if (normalized.length > 255) throw new ValidateException("备注不能超过 255 个字符");
    const rows = await this.container.db
      .update(supplierFlowingWater)
      .set({ mark: normalized })
      .where(
        and(
          eq(supplierFlowingWater.id, id),
          eq(supplierFlowingWater.supplierId, supplierId),
          eq(supplierFlowingWater.isDel, 0),
        ),
      )
      .returning({ id: supplierFlowingWater.id });
    if (!rows[0]) throw new NotFoundException("流水不存在或不属于当前供应商");
  }

  async extractList(supplierId: number, query: Record<string, string>) {
    const page = parsePagination(query.page, query.limit);
    const conditions: SQL[] = [eq(supplierExtract.supplierId, supplierId)];
    if (["-1", "0", "1"].includes(query.status ?? "")) {
      conditions.push(eq(supplierExtract.status, Number(query.status)));
    }
    if (query.pay_status === "0" || query.pay_status === "1") {
      conditions.push(eq(supplierExtract.payStatus, Number(query.pay_status)));
    }
    if (EXTRACT_TYPES.includes(query.extract_type as ExtractType)) {
      conditions.push(eq(supplierExtract.extractType, query.extract_type));
    }
    const where = and(...conditions);
    const [list, count, summary] = await Promise.all([
      this.container.db
        .select()
        .from(supplierExtract)
        .where(where)
        .orderBy(desc(supplierExtract.id))
        .limit(page.limit)
        .offset(page.offset),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(supplierExtract)
        .where(where),
      this.summary(supplierId),
    ]);
    return { list, count: count[0]?.count ?? 0, page: page.page, limit: page.limit, extract_statistics: summary };
  }

  async applyExtract(supplierId: number, input: Record<string, unknown>) {
    const extractType = normalizeOptionalString(input, "extract_type", 32);
    if (!extractType || !EXTRACT_TYPES.includes(extractType as ExtractType)) {
      throw new ValidateException("转账方式不存在");
    }
    const amountCents = amountToCents(input.money, "提现金额");
    const mark = normalizeOptionalString(input, "mark", 512) ?? "";
    const config = new SystemConfigService(this.container, this.env);
    const limits = await config.getMany(["supplier_extract_min_price", "supplier_extract_max_price"]);
    const minCents = Math.max(configLimitToCents(limits.supplier_extract_min_price), 1);
    const maxCents = configLimitToCents(limits.supplier_extract_max_price);
    if (amountCents < minCents) throw new ValidateException(`最低提现 ${centsToDecimal(minCents)} 元`);
    if (maxCents > 0 && amountCents > maxCents) {
      throw new ValidateException(`最高提现 ${centsToDecimal(maxCents)} 元`);
    }

    await this.container.db.transaction(async (tx) => {
      await lockSupplierFinance(tx, supplierId);
      const supplierRows = await tx
        .select()
        .from(systemSupplier)
        .where(
          and(
            eq(systemSupplier.id, supplierId),
            eq(systemSupplier.isDel, 0),
            eq(systemSupplier.isShow, 1),
          ),
        )
        .limit(1);
      const supplier = supplierRows[0];
      if (!supplier) throw new NotFoundException("供应商不存在");

      const [flowRows, extractRows] = await Promise.all([
        tx
          .select({
            income: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.status} = 1 AND ${supplierFlowingWater.pm} = 1 THEN ${supplierFlowingWater.number} ELSE 0 END), 0)::numeric(12,2)`,
            expense: sql<string>`COALESCE(SUM(CASE WHEN ${supplierFlowingWater.status} = 1 AND ${supplierFlowingWater.pm} = 0 THEN ${supplierFlowingWater.number} ELSE 0 END), 0)::numeric(12,2)`,
          })
          .from(supplierFlowingWater)
          .where(
            and(
              eq(supplierFlowingWater.supplierId, supplierId),
              eq(supplierFlowingWater.isDel, 0),
            ),
          ),
        tx
          .select({
            reserved: sql<string>`COALESCE(SUM(${supplierExtract.extractPrice}), 0)::numeric(12,2)`,
          })
          .from(supplierExtract)
          .where(
            and(eq(supplierExtract.supplierId, supplierId), ne(supplierExtract.status, -1)),
          ),
      ]);
      const available =
        decimalToCents(flowRows[0]?.income) -
        decimalToCents(flowRows[0]?.expense) -
        decimalToCents(extractRows[0]?.reserved);
      if (amountCents > available) {
        throw new ValidateException(
          available > 0 ? `可提现金额为 ${centsToDecimal(available)} 元` : "暂无可提现金额",
        );
      }

      const snapshot: Partial<typeof supplierExtract.$inferInsert> = {};
      if (extractType === "bank") {
        if (!supplier.bankCode || supplier.bankCode === "0" || !supplier.bankAddress) {
          throw new ValidateException("请先设置提现银行卡和开户地址");
        }
        snapshot.bankCode = supplier.bankCode;
        snapshot.bankAddress = supplier.bankAddress;
      } else if (extractType === "alipay") {
        if (!supplier.alipayAccount) throw new ValidateException("请先设置提现支付宝账号");
        snapshot.alipayAccount = supplier.alipayAccount;
        snapshot.qrcodeUrl = supplier.alipayQrcodeUrl;
      } else {
        if (!supplier.wechat) throw new ValidateException("请先设置提现微信账号");
        snapshot.wechat = supplier.wechat;
        snapshot.qrcodeUrl = supplier.wechatQrcodeUrl;
      }

      await tx.insert(supplierExtract).values({
        supplierId,
        extractType,
        extractPrice: centsToDecimal(amountCents),
        balance: centsToDecimal(available - amountCents),
        supplierMark: mark,
        status: 0,
        payStatus: 0,
        addTime: Math.floor(Date.now() / 1000),
        ...snapshot,
      });
    // The advisory-lock SELECT can establish an old snapshot while waiting.
    // Pin admission to fresh per-statement reads, irrespective of role defaults.
    }, { isolationLevel: 'read committed' });
  }

  async updateExtractMark(supplierId: number, id: number, mark: string) {
    const normalized = mark.trim();
    if (!normalized) throw new ValidateException("请输入备注");
    if (normalized.length > 255) throw new ValidateException("备注不能超过 255 个字符");
    const rows = await this.container.db
      .update(supplierExtract)
      .set({ supplierMark: normalized })
      .where(and(eq(supplierExtract.id, id), eq(supplierExtract.supplierId, supplierId)))
      .returning({ id: supplierExtract.id });
    if (!rows[0]) throw new NotFoundException("提现记录不存在或不属于当前供应商");
  }
}
