import { and, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { capitalFlow } from "@/models/schema";
import type { Container } from "@/lib/di";
import { NotFoundException, ValidateException } from "@/utils/errors";

const CAPITAL_TYPE_NAMES: Record<number, string> = {
  1: "商城购物",
  2: "商城购物退款",
  3: "用户充值",
  4: "用户充值退款",
  5: "抽奖中奖",
  6: "佣金提现",
  7: "购买会员",
  8: "线下支付",
};

const ADMIN_TYPE_NAMES = [
  "未知",
  "支付订单",
  "订单退款",
  "充值订单",
  "充值退款",
  "抽奖红包",
  "佣金提现",
  "购买会员",
  "线下收银",
];

const PAY_TYPE_NAMES: Record<string, string> = {
  weixin: "微信支付",
  routine: "小程序",
  alipay: "支付宝",
  offline: "线下支付",
  bank: "银行",
};

type CapitalRow = typeof capitalFlow.$inferSelect;

function formatUnix(seconds: number, style: "month" | "day" | "minute" | "second"): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return "";
  const value = new Date((seconds + 8 * 60 * 60) * 1000).toISOString();
  if (style === "month") return value.slice(0, 7);
  if (style === "day") return value.slice(0, 10);
  if (style === "minute") return value.slice(0, 16).replace("T", " ").replace(/-/g, "/");
  return value.slice(0, 19).replace("T", " ");
}

export function formatUserCapitalRow(row: CapitalRow) {
  const typeName = CAPITAL_TYPE_NAMES[row.tradingType] ?? "未知类型";
  return {
    id: row.id,
    flow_id: row.flowId,
    order_id: row.orderId,
    store_id: row.storeId,
    uid: row.uid,
    nickname: row.nickname,
    phone: row.phone,
    price: row.price,
    trading_type: row.tradingType,
    pay_type: row.payType,
    mark: row.mark,
    time_key: formatUnix(row.addTime, "month"),
    day: formatUnix(row.addTime, "day"),
    add_time: formatUnix(row.addTime, "minute"),
    type: row.tradingType,
    type_name: typeName,
    title: typeName,
  };
}

export type AdminCapitalFlowQuery = {
  tradingType?: number;
  keywords?: string;
  ids?: number[];
  start?: number;
  stop?: number;
  page?: number;
  limit?: number;
  export?: boolean;
};

export class CapitalFlowService {
  constructor(private readonly container: Container) {}

  /** PHP v2 user/money_list/9: external cash purchases and paid membership only. */
  async listForUser(uid: number, start = 0, stop = 0, page = 1, limit = 10) {
    const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 10;
    const conditions: SQL[] = [
      eq(capitalFlow.uid, uid),
      inArray(capitalFlow.tradingType, [1, 7]),
    ];
    if (Number.isSafeInteger(start) && start > 0) conditions.push(gte(capitalFlow.addTime, start));
    if (Number.isSafeInteger(stop) && stop > 0) conditions.push(lte(capitalFlow.addTime, stop));
    const rows = await this.container.db
      .select()
      .from(capitalFlow)
      .where(and(...conditions))
      .orderBy(desc(capitalFlow.id))
      .limit(safeLimit)
      .offset((safePage - 1) * safeLimit);
    const list = rows.map(formatUserCapitalRow);
    return { list, time: [...new Set(list.map((row) => row.time_key).filter(Boolean))] };
  }

  /** PHP admin flow/get_list. */
  async adminList(query: AdminCapitalFlowQuery) {
    const safePage = Number.isSafeInteger(query.page) && Number(query.page) > 0 ? Number(query.page) : 1;
    const safeLimit = Number.isSafeInteger(query.limit)
      ? Math.min(Math.max(Number(query.limit), 1), 100)
      : 20;
    const conditions: SQL[] = [];
    if (Number.isSafeInteger(query.tradingType) && Number(query.tradingType) > 0) {
      conditions.push(eq(capitalFlow.tradingType, Number(query.tradingType)));
    }
    if (query.ids?.length) conditions.push(inArray(capitalFlow.id, query.ids.slice(0, 100)));
    if (Number.isSafeInteger(query.start) && Number(query.start) > 0) {
      conditions.push(gte(capitalFlow.addTime, Number(query.start)));
    }
    if (Number.isSafeInteger(query.stop) && Number(query.stop) > 0) {
      conditions.push(lte(capitalFlow.addTime, Number(query.stop)));
    }
    const keywords = query.keywords?.trim();
    if (keywords) {
      const keywordConditions: SQL[] = [
        ilike(capitalFlow.orderId, `%${keywords}%`),
        ilike(capitalFlow.nickname, `%${keywords}%`),
        ilike(capitalFlow.phone, `%${keywords}%`),
      ];
      const numericUid = Number(keywords);
      if (Number.isSafeInteger(numericUid) && numericUid >= 0) {
        keywordConditions.push(eq(capitalFlow.uid, numericUid));
      }
      conditions.push(or(...keywordConditions)!);
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(capitalFlow)
        .where(where)
        .orderBy(desc(capitalFlow.id))
        .limit(safeLimit)
        .offset((safePage - 1) * safeLimit),
      this.container.db.select({ count: sql<number>`COUNT(*)::int` }).from(capitalFlow).where(where),
    ]);
    const list = rows.map((row) => ({
      id: row.id,
      flow_id: row.flowId,
      order_id: row.orderId,
      store_id: row.storeId,
      uid: row.uid,
      nickname: row.nickname,
      phone: row.phone,
      price: row.price,
      trading_type_code: row.tradingType,
      trading_type: ADMIN_TYPE_NAMES[row.tradingType] ?? ADMIN_TYPE_NAMES[0],
      pay_type_code: row.payType,
      pay_type: PAY_TYPE_NAMES[row.payType] ?? "",
      mark: row.mark,
      add_time: formatUnix(row.addTime, "second"),
    }));
    if (query.export) {
      return {
        list,
        fileKey: [
          "flow_id",
          "order_id",
          "nickname",
          "phone",
          "price",
          "trading_type",
          "pay_type",
          "add_time",
          "mark",
        ],
        header: ["交易单号", "关联订单", "用户", "电话", "金额", "订单类型", "支付类型", "交易时间", "备注"],
        fileName: `账单导出${Date.now()}`,
      };
    }
    return { list, count: countRows[0]?.count ?? 0, status: ADMIN_TYPE_NAMES };
  }

  async setMark(id: number, mark: string): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("参数错误");
    if (mark.length > 500) throw new ValidateException("备注不能超过500个字符");
    const updated = await this.container.db
      .update(capitalFlow)
      .set({ mark })
      .where(eq(capitalFlow.id, id))
      .returning({ id: capitalFlow.id });
    if (!updated.length) throw new NotFoundException("资金流水不存在");
  }
}
