import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { queueAuxiliary, queueList, storeOrder } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

const MAX_PAGE = 1_000_000;
const MAX_LIMIT = 100;
const MAX_TIME_QUERY = 100;
const VISIBLE_QUEUE_TYPES = [7, 8, 9, 10] as const;
const VISIBLE_QUEUE_STATUSES = [0, 1, 2, 3] as const;

const QUEUE_TYPE_NAMES: Readonly<Record<number, string>> = {
  7: "批量手动发货",
  8: "批量打印电子面单",
  9: "批量配送",
  10: "批量虚拟发货",
};

const QUEUE_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "未处理",
  1: "正在处理",
  2: "完成",
  3: "失败",
};

const AUXILIARY_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "未执行",
  1: "成功",
  2: "失败",
  3: "已删除",
};

export const SUPPLIER_QUEUE_CACHE_TYPE_BY_QUEUE_TYPE: Readonly<Record<number, number>> = {
  7: 3,
  8: 4,
  9: 5,
  10: 6,
};

export interface SupplierQueueHistoryQuery {
  page: number;
  limit: number;
  type?: number;
  status?: number;
  startTime?: number;
  endTime?: number;
  unsupportedType: boolean;
}

function positiveInteger(value: unknown, label: string, fallback: number, maximum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function requiredPositiveInteger(value: unknown, label: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function datePartEpoch(value: string, endOfDay: boolean): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return text.length === 13 ? Math.floor(numeric / 1_000) : numeric;
  }
  const day = text.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1];
  const parsed = Date.parse(day
    ? `${day}T${endOfDay ? "23:59:59" : "00:00:00"}+08:00`
    : text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : undefined;
}

function dateRange(value: unknown): { startTime?: number; endTime?: number } {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string" || value.length > MAX_TIME_QUERY) {
    throw new ValidateException("时间范围无效");
  }
  const parts = value
    .trim()
    .split(/\s+(?:-|~|至)\s+|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) throw new ValidateException("时间范围无效");
  const startTime = datePartEpoch(parts[0], false);
  const endTime = datePartEpoch(parts[1] ?? parts[0], true);
  if (startTime === undefined || endTime === undefined || startTime > endTime) {
    throw new ValidateException("时间范围无效");
  }
  return { startTime, endTime };
}

export function parseSupplierQueueHistoryQuery(
  query: Record<string, string | undefined>,
): SupplierQueueHistoryQuery {
  const type = optionalInteger(query.type, "任务类型", 0, 255);
  const status = optionalInteger(query.status, "任务状态", 0, 3);
  return {
    page: positiveInteger(query.page, "页码", 1, MAX_PAGE),
    limit: positiveInteger(query.limit, "每页数量", 20, MAX_LIMIT),
    type,
    status,
    ...dateRange(query.data ?? query.time),
    unsupportedType: type !== undefined && !VISIBLE_QUEUE_TYPES.includes(type as 7 | 8 | 9 | 10),
  };
}

export function supplierQueueTypeForCacheType(value: unknown): number {
  const cacheType = optionalInteger(value, "明细类型", 3, 6);
  const queueType = cacheType === undefined
    ? undefined
    : Object.entries(SUPPLIER_QUEUE_CACHE_TYPE_BY_QUEUE_TYPE)
        .find(([, candidate]) => candidate === cacheType)?.[0];
  if (!queueType) throw new ValidateException("明细类型无效");
  return Number(queueType);
}

function formatShanghaiEpoch(value: number): string {
  if (!value) return "";
  const date = new Date((value + 8 * 60 * 60) * 1_000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function assertSupplierId(supplierId: number): void {
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    throw new ValidateException("供应商身份无效");
  }
}

function readOnlyMetadata() {
  return {
    history_authority: "legacy_history_only",
    runtime_authority: "supplier_scoped_job_ledgers",
    read_only: true,
    mutation_routes_retired: true,
  } as const;
}

export class SupplierQueueHistoryService {
  constructor(private readonly container: Container) {}

  async list(supplierId: number, rawQuery: Record<string, string | undefined>) {
    assertSupplierId(supplierId);
    const query = parseSupplierQueueHistoryQuery(rawQuery);
    if (query.unsupportedType) return { list: [], count: 0, ...readOnlyMetadata() };

    const conditions: SQL[] = [
      inArray(queueList.type, VISIBLE_QUEUE_TYPES),
      query.status === undefined
        ? inArray(queueList.status, VISIBLE_QUEUE_STATUSES)
        : eq(queueList.status, query.status),
      eq(storeOrder.supplierId, supplierId),
    ];
    if (query.type !== undefined) conditions.push(eq(queueList.type, query.type));
    if (query.startTime !== undefined) conditions.push(gte(queueList.addTime, query.startTime));
    if (query.endTime !== undefined) conditions.push(lte(queueList.addTime, query.endTime));
    const where = and(...conditions);
    const cacheType = sql<number>`CASE ${queueList.type}
      WHEN 7 THEN 3 WHEN 8 THEN 4 WHEN 9 THEN 5 WHEN 10 THEN 6 ELSE 0 END`;
    const auxiliaryJoin = and(
      eq(queueAuxiliary.bindingId, queueList.id),
      sql`${queueAuxiliary.type} = ${cacheType}`,
    );
    const orderJoin = eq(storeOrder.id, queueAuxiliary.relationId);

    const [rows, totals] = await Promise.all([
      this.container.db
        .select({
          id: queueList.id,
          type: queueList.type,
          title: queueList.title,
          status: queueList.status,
          firstTime: queueList.firstTime,
          againTime: queueList.againTime,
          finishTime: queueList.finishTime,
          addTime: queueList.addTime,
          totalNum: sql<number>`COUNT(DISTINCT ${queueAuxiliary.id})::int`,
          successNum: sql<number>`COUNT(DISTINCT ${queueAuxiliary.id}) FILTER (WHERE ${queueAuxiliary.status} = 1)::int`,
          surplusNum: sql<number>`COUNT(DISTINCT ${queueAuxiliary.id}) FILTER (WHERE ${queueAuxiliary.status} <> 1)::int`,
        })
        .from(queueList)
        .innerJoin(queueAuxiliary, auxiliaryJoin)
        .innerJoin(storeOrder, orderJoin)
        .where(where)
        .groupBy(
          queueList.id,
          queueList.type,
          queueList.title,
          queueList.status,
          queueList.firstTime,
          queueList.againTime,
          queueList.finishTime,
          queueList.addTime,
        )
        .orderBy(desc(queueList.addTime), desc(queueList.id))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.container.db
        .select({ value: sql<number>`COUNT(DISTINCT ${queueList.id})::int` })
        .from(queueList)
        .innerJoin(queueAuxiliary, auxiliaryJoin)
        .innerJoin(storeOrder, orderJoin)
        .where(where),
    ]);

    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: QUEUE_TYPE_NAMES[row.type] ?? row.title,
        status: row.status,
        status_cn: QUEUE_STATUS_NAMES[row.status] ?? "未知",
        first_time: formatShanghaiEpoch(row.firstTime),
        again_time: formatShanghaiEpoch(row.againTime),
        finish_time: formatShanghaiEpoch(row.finishTime),
        add_time: formatShanghaiEpoch(row.addTime),
        total_num: Number(row.totalNum),
        success_num: Number(row.successNum),
        surplus_num: Number(row.surplusNum),
        cache_type: SUPPLIER_QUEUE_CACHE_TYPE_BY_QUEUE_TYPE[row.type] ?? 0,
        is_show_log: true,
        actions_available: [],
      })),
      count: Number(totals[0]?.value ?? 0),
      ...readOnlyMetadata(),
    };
  }

  async deliveryLog(
    supplierId: number,
    bindingValue: unknown,
    cacheTypeValue: unknown,
    rawQuery: Record<string, string | undefined>,
  ) {
    assertSupplierId(supplierId);
    const bindingId = requiredPositiveInteger(bindingValue, "队列 ID", 2_147_483_647);
    const queueType = supplierQueueTypeForCacheType(cacheTypeValue);
    const cacheType = SUPPLIER_QUEUE_CACHE_TYPE_BY_QUEUE_TYPE[queueType];
    const page = positiveInteger(rawQuery.page, "页码", 1, MAX_PAGE);
    const limit = positiveInteger(rawQuery.limit, "每页数量", 20, MAX_LIMIT);
    const status = optionalInteger(rawQuery.status, "明细状态", 0, 3);
    const conditions: SQL[] = [
      eq(queueList.id, bindingId),
      eq(queueList.type, queueType),
      eq(queueAuxiliary.bindingId, bindingId),
      eq(queueAuxiliary.type, cacheType),
      eq(storeOrder.supplierId, supplierId),
    ];
    if (status !== undefined) conditions.push(eq(queueAuxiliary.status, status));
    const where = and(...conditions);

    const selection = {
      id: queueAuxiliary.id,
      bindingId: queueAuxiliary.bindingId,
      relationId: queueAuxiliary.relationId,
      status: queueAuxiliary.status,
      updateTime: queueAuxiliary.updateTime,
      addTime: queueAuxiliary.addTime,
      orderNo: storeOrder.orderId,
      deliveryType: storeOrder.deliveryType,
      deliveryName: storeOrder.deliveryName,
      deliveryId: storeOrder.deliveryId,
      fictitiousContent: storeOrder.fictitiousContent,
    };
    const [rows, totals] = await Promise.all([
      this.container.db
        .select(selection)
        .from(queueAuxiliary)
        .innerJoin(queueList, and(
          eq(queueList.id, queueAuxiliary.bindingId),
          eq(queueList.type, queueType),
        ))
        .innerJoin(storeOrder, eq(storeOrder.id, queueAuxiliary.relationId))
        .where(where)
        .orderBy(desc(queueAuxiliary.addTime), desc(queueAuxiliary.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ value: sql<number>`COUNT(*)::int` })
        .from(queueAuxiliary)
        .innerJoin(queueList, and(
          eq(queueList.id, queueAuxiliary.bindingId),
          eq(queueList.type, queueType),
        ))
        .innerJoin(storeOrder, eq(storeOrder.id, queueAuxiliary.relationId))
        .where(where),
    ]);

    return {
      list: rows.map((row) => ({
        id: row.id,
        binding_id: row.bindingId,
        relation_id: row.relationId,
        type: cacheType,
        order_id: row.orderNo,
        delivery_name: queueType === 10
          ? ""
          : row.deliveryType === "fictitious" ? "虚拟发货" : row.deliveryName,
        delivery_id: queueType === 10
          ? ""
          : row.deliveryType === "fictitious" ? "无" : row.deliveryId,
        fictitious_content: queueType === 10 ? row.fictitiousContent : "",
        status: row.status,
        status_cn: AUXILIARY_STATUS_NAMES[row.status] ?? "未知",
        error: row.status === 1 ? "无" : "队列异常",
        update_time: formatShanghaiEpoch(row.updateTime),
        add_time: formatShanghaiEpoch(row.addTime),
      })),
      count: Number(totals[0]?.value ?? 0),
      ...readOnlyMetadata(),
    };
  }
}
