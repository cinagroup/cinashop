import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  or,
  type SQL,
} from "drizzle-orm";
import type { Container } from "@/lib/di";
import { queueAuxiliary, queueList, systemTimer } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export const LEGACY_QUEUE_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: "批量发放用户优惠券",
  2: "批量设置用户分组",
  3: "批量设置用户标签",
  4: "批量下架商品",
  5: "批量删除商品规格",
  6: "批量删除订单",
  7: "批量手动发货",
  8: "批量打印电子面单",
  9: "批量配送",
  10: "批量虚拟发货",
};

const LEGACY_QUEUE_CACHE_TYPES: Readonly<Record<number, string | number>> = {
  1: "DrivingSendCoupon-ADMIN",
  2: "DrivingUserGroup-ADMIN",
  3: "DrivingUserLabel-ADMIN",
  4: "DrivingProductUnshow-ADMIN",
  5: "DrivingProductRule-ADMIN",
  6: "DrivingOrderDel-ADMIN",
  7: 3,
  8: 4,
  9: 5,
  10: 6,
};

export const LEGACY_TIMER_TASK_NAMES: Readonly<Record<string, string>> = {
  auto_cancel: "自动取消订单",
  auto_take: "自动确认收货",
  auto_comment: "自动好评",
  auto_clear_integral: "自动清空用户积分",
  auto_off_user_svip: "自动取消用户到期 SVIP",
  auto_agent: "自动解绑上下级",
  auto_clear_poster: "自动清除昨日海报",
  auto_sms_code: "更新短信状态",
  auto_live: "更新直播商品和直播间状态",
  auto_pink: "更新拼团状态",
  auto_show: "自动上下架商品",
  auto_channel: "渠道码定时任务",
  auto_moment: "创建朋友圈发送任务",
  auto_group_task: "发送群发任务",
  auto_seckill: "清理秒杀过期缓存",
  rebate_points_orders: "未支付积分订单退积分",
  reminder_unverified_remind: "次卡未核销短信提醒",
  sign_remind_time: "用户签到提醒",
};

const TIMER_RUNTIME: Readonly<
  Record<string, { workerJob: string; note: string; status?: "partially_implemented" }>
> = {
  auto_take: {
    workerJob: "auto_receipt",
    note: "Worker 已通过可重放 scheduled 根任务和 Queue 消费者实现；执行阈值来自商城配置。",
  },
  auto_comment: {
    workerJob: "auto_comment",
    note: "Worker 已通过可重放 scheduled 根任务和 Queue 消费者实现；执行阈值来自商城配置。",
  },
  auto_live: {
    workerJob: "live_room_sync + live_goods_sync + live_anchor_sync",
    status: "partially_implemented",
    note: "Worker 已恢复用户直播列表、回放读取和直播间、商品、主播三类可重放只读同步；创建直播间、商品提审/删除及导入商品仍因外部接口缺少幂等键而保持关闭。",
  },
  sign_remind_time: {
    workerJob: "sign_remind_time",
    status: "partially_implemented",
    note: "Worker 已恢复上海 10:25 的分页扫描、可重试 Queue 消费和每日幂等站内信；短信与小程序订阅消息仍等待通用 provider 投递账本、凭据和真实模板验收。",
  },
};

const QUEUE_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "未处理",
  1: "正在处理",
  2: "完成",
  3: "失败",
  4: "已删除",
};

const AUXILIARY_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: "未执行",
  1: "成功",
  2: "失败",
  3: "已删除",
};

function intParam(
  value: string | undefined,
  label: string,
  options: { fallback: number; min: number; max: number },
): number {
  if (value === undefined || value === "") return options.fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function optionalInt(
  value: string | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  return intParam(value, label, { fallback: min, min, max });
}

export function describeLegacyTimerCycle(type: number, cycle: string): string {
  const values = cycle.split("/").map((value) => value.trim());
  switch (type) {
    case 1:
      return `每隔 ${cycle} 分钟`;
    case 2:
      return `每 ${values[0] ?? "?"} 小时，第 ${values[1] ?? "?"} 分钟`;
    case 3:
      return `每小时第 ${cycle} 分钟`;
    case 4:
      return `每天 ${values[0] ?? "?"}:${values[1] ?? "?"}`;
    case 5:
      return `每 ${values[0] ?? "?"} 天，${values[1] ?? "?"}:${values[2] ?? "?"}`;
    case 6:
      return `每周 ${values[0] ?? "?"}，${values[1] ?? "?"}:${values[2] ?? "?"}`;
    case 7:
      return `每月 ${values[0] ?? "?"} 日，${values[1] ?? "?"}:${values[2] ?? "?"}`;
    case 8:
      return `每年 ${values[0] ?? "?"} 月 ${values[1] ?? "?"} 日，${values[2] ?? "?"}:${values[3] ?? "?"}`;
    default:
      return "周期格式未知";
  }
}

export class LegacyRuntimeCatalogService {
  constructor(private readonly container: Container) {}

  taskNames(): Readonly<Record<string, string>> {
    return LEGACY_TIMER_TASK_NAMES;
  }

  async timerList(query: Record<string, string>) {
    const page = intParam(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 });
    const limit = intParam(query.limit, "每页数量", { fallback: 20, min: 1, max: 100 });
    const keyword = String(query.keyword ?? "").trim().slice(0, 50);
    const conditions: SQL[] = [eq(systemTimer.isDel, 0)];
    if (keyword) {
      const match = or(
        ilike(systemTimer.name, `%${keyword}%`),
        ilike(systemTimer.mark, `%${keyword}%`),
      );
      if (match) conditions.push(match);
    }
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(systemTimer)
        .where(where)
        .orderBy(asc(systemTimer.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(systemTimer).where(where),
    ]);
    return {
      list: rows.map((row) => this.timerView(row)),
      count: Number(totals[0]?.value ?? 0),
      runtime_authority: "cloudflare_scheduled_queue",
      catalog_authority: "legacy_history_only",
    };
  }

  async timerDetail(idValue: string) {
    const id = intParam(idValue, "定时任务 ID", { fallback: 0, min: 1, max: 2_147_483_647 });
    const rows = await this.container.db
      .select()
      .from(systemTimer)
      .where(and(eq(systemTimer.id, id), eq(systemTimer.isDel, 0)))
      .limit(1);
    if (!rows[0]) throw new ValidateException("定时任务不存在");
    return this.timerView(rows[0]);
  }

  async queueHistory(query: Record<string, string>) {
    const page = intParam(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 });
    const limit = intParam(query.limit, "每页数量", { fallback: 20, min: 1, max: 100 });
    const type = optionalInt(query.type, "任务类型", 0, 255);
    const status = optionalInt(query.status, "任务状态", 0, 255);
    const conditions: SQL[] = [];
    if (type !== undefined) conditions.push(eq(queueList.type, type));
    if (status !== undefined) conditions.push(eq(queueList.status, status));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(queueList)
        .where(where)
        .orderBy(desc(queueList.addTime), desc(queueList.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(queueList).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        type: row.type,
        source: row.source,
        execute_key: row.executeKey,
        title: row.title,
        sort: row.sort,
        status: row.status,
        first_time: row.firstTime,
        again_time: row.againTime,
        finish_time: row.finishTime,
        surplus_num: row.surplusNum,
        total_num: row.totalNum,
        success_num: Math.max(0, row.totalNum - row.surplusNum),
        is_del: row.isDel,
        add_time: row.addTime,
        status_cn: QUEUE_STATUS_NAMES[row.status] ?? "未知",
        type_cn: LEGACY_QUEUE_TYPE_NAMES[row.type] ?? (row.title || `类型 ${row.type}`),
        cache_type: LEGACY_QUEUE_CACHE_TYPES[row.type] ?? 0,
        is_show_log: [7, 8, 9, 10].includes(row.type),
        has_payload: Boolean(row.queueInValue),
        runtime_authority: "legacy_history_only",
      })),
      count: Number(totals[0]?.value ?? 0),
      runtime_authority: "cloudflare_queues",
      history_authority: "legacy_history_only",
    };
  }

  async queueDeliveryLog(bindingValue: string, typeValue: string, query: Record<string, string>) {
    const bindingId = intParam(bindingValue, "队列 ID", {
      fallback: 0,
      min: 1,
      max: 2_147_483_647,
    });
    const type = intParam(typeValue, "明细类型", { fallback: 0, min: 0, max: 255 });
    const page = intParam(query.page, "页码", { fallback: 1, min: 1, max: 1_000_000 });
    const limit = intParam(query.limit, "每页数量", { fallback: 20, min: 1, max: 100 });
    const status = optionalInt(query.status, "明细状态", 0, 255);
    const conditions: SQL[] = [
      eq(queueAuxiliary.bindingId, bindingId),
      eq(queueAuxiliary.type, type),
    ];
    if (status !== undefined) conditions.push(eq(queueAuxiliary.status, status));
    const where = and(...conditions);
    const [rows, totals] = await Promise.all([
      this.container.db
        .select()
        .from(queueAuxiliary)
        .where(where)
        .orderBy(desc(queueAuxiliary.addTime), desc(queueAuxiliary.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db.select({ value: count() }).from(queueAuxiliary).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        binding_id: row.bindingId,
        relation_id: row.relationId,
        type: row.type,
        other: row.other,
        status: row.status,
        status_cn: AUXILIARY_STATUS_NAMES[row.status] ?? "未知",
        update_time: row.updateTime,
        add_time: row.addTime,
      })),
      count: Number(totals[0]?.value ?? 0),
      history_authority: "legacy_history_only",
    };
  }

  private timerView(row: typeof systemTimer.$inferSelect) {
    const runtime = TIMER_RUNTIME[row.mark];
    return {
      id: row.id,
      name: row.name,
      mark: row.mark,
      type: row.type,
      title: row.title,
      is_open: row.isOpen,
      cycle: row.cycle,
      execution_cycle: describeLegacyTimerCycle(row.type, row.cycle),
      last_execution_time: row.lastExecutionTime,
      update_execution_time: row.updateExecutionTime,
      is_del: row.isDel,
      add_time: row.addTime,
      runtime_status: runtime?.status ?? (runtime ? "implemented_independently" : "not_migrated"),
      worker_job: runtime?.workerJob ?? null,
      runtime_note:
        runtime?.note ??
        "该 PHP 任务消费者尚未迁移；目录行仅供核对，is_open 与 cycle 不会配置 Cloudflare。",
    };
  }
}
