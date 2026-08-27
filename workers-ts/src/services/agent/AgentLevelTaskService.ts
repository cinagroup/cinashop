import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  sql,
} from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  agentLevel,
  agentLevelTask,
  agentLevelTaskRecord,
  storeOrder,
  systemConfig,
  user as userTable,
} from "@/models/schema";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";

const TASK_CATALOG_LOCK_NAMESPACE = 731_624;
const TASK_USER_LOCK_NAMESPACE = 731_625;
const MAX_PAGE_SIZE = 100;

export const AGENT_TASK_TYPES = [
  { type: 1, name: "邀请好友成为下级", unit: "人", image: "/uploads/system/agent_spread.png" },
  { type: 2, name: "自身消费金额", unit: "元", image: "/uploads/system/agent_self_order_price.png" },
  { type: 3, name: "自身消费单数", unit: "单", image: "/uploads/system/agent_self_order.png" },
  { type: 4, name: "下级消费金额", unit: "元", image: "/uploads/system/agent_spread_order_price.png" },
  { type: 5, name: "下级消费单数", unit: "单", image: "/uploads/system/agent_spread_order.png" },
] as const;

export interface AgentTaskMetrics {
  inviteCount: number;
  ownOrderCents: number;
  ownOrderCount: number;
  downlineOrderCents: number;
  downlineOrderCount: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max = 2_147_483_647,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${field}必须是${min}到${max}之间的整数`);
  }
  return parsed;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new ValidateException(`请输入${field}`);
  const normalized = value.trim();
  if (normalized.length > max) throw new ValidateException(`${field}不能超过${max}个字符`);
  return normalized;
}

function optionalString(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidateException(`${field}格式错误`);
  const normalized = value.trim();
  if (normalized.length > max) throw new ValidateException(`${field}不能超过${max}个字符`);
  return normalized;
}

function decimalToCents(value: string | number): number {
  const normalized = normalizeConfigScalar(String(value));
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("订单金额格式无效");
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("订单金额超出安全范围");
  return cents;
}

function taskType(type: number) {
  return AGENT_TASK_TYPES.find((item) => item.type === type);
}

function orderTaskWhere(uid: number) {
  return and(
    eq(storeOrder.pid, 0),
    eq(storeOrder.uid, uid),
    eq(storeOrder.paid, 1),
    inArray(storeOrder.refundStatus, [0, 3]),
    eq(storeOrder.isDel, 0),
    eq(storeOrder.isSystemDel, 0),
  );
}

async function loadAgentTaskMetrics(db: DbClient, uid: number): Promise<AgentTaskMetrics> {
  const [invites, ownOrders, downlineOrders] = await Promise.all([
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(userTable)
      .where(eq(userTable.spreadUid, uid)),
    db
      .select({
        count: sql<number>`COUNT(*)::int`,
        amount: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text`,
      })
      .from(storeOrder)
      .where(orderTaskWhere(uid)),
    db
      .select({
        count: sql<number>`COUNT(*)::int`,
        amount: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::text`,
      })
      .from(storeOrder)
      .innerJoin(userTable, eq(userTable.uid, storeOrder.uid))
      .where(
        and(
          eq(userTable.spreadUid, uid),
          eq(storeOrder.pid, 0),
          eq(storeOrder.paid, 1),
          inArray(storeOrder.refundStatus, [0, 3]),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
        ),
      ),
  ]);
  return {
    inviteCount: invites[0]?.count ?? 0,
    ownOrderCents: decimalToCents(ownOrders[0]?.amount ?? "0"),
    ownOrderCount: ownOrders[0]?.count ?? 0,
    downlineOrderCents: decimalToCents(downlineOrders[0]?.amount ?? "0"),
    downlineOrderCount: downlineOrders[0]?.count ?? 0,
  };
}

export function calculateAgentTaskProgress(
  task: Pick<typeof agentLevelTask.$inferSelect, "type" | "number">,
  metrics: AgentTaskMetrics,
) {
  if (!taskType(task.type)) {
    return {
      complete: false,
      current: 0,
      target: task.number,
      displayCurrent: 0,
      displayRemaining: Math.max(0, task.number),
      speed: 0,
    };
  }
  const moneyTask = task.type === 2 || task.type === 4;
  const target = moneyTask ? task.number * 100 : task.number;
  const current = task.type === 1
    ? metrics.inviteCount
    : task.type === 2
      ? metrics.ownOrderCents
      : task.type === 3
        ? metrics.ownOrderCount
        : task.type === 4
          ? metrics.downlineOrderCents
          : metrics.downlineOrderCount;
  if (!Number.isSafeInteger(target)) throw new Error("等级任务目标超出安全范围");
  return {
    complete: current >= target,
    current,
    target,
    displayCurrent: moneyTask ? current / 100 : current,
    displayRemaining: moneyTask ? Math.max(0, target - current) / 100 : Math.max(0, target - current),
    speed: target <= 0
      ? 100
      : Math.min(100, Number((BigInt(current) * 100n) / BigInt(target))),
  };
}

async function brokerageEnabled(db: DbClient): Promise<boolean> {
  const rows = await db
    .select({ value: systemConfig.value })
    .from(systemConfig)
    .where(and(eq(systemConfig.isStore, 0), eq(systemConfig.menuName, "brokerage_func_status")))
    .orderBy(desc(systemConfig.id))
    .limit(1);
  return parseConfigInteger(rows[0]?.value, 0) === 1;
}

export class AgentLevelTaskService {
  constructor(private readonly container: Container) {}

  async adminList(query: Record<string, string>) {
    const levelId = integer(query.id ?? query.level_id, "等级ID", 0, 1);
    const page = integer(query.page, "页码", 1, 1, 1_000_000);
    const limit = integer(query.limit, "每页数量", 20, 1, MAX_PAGE_SIZE);
    const conditions = [eq(agentLevelTask.levelId, levelId), eq(agentLevelTask.isDel, 0)];
    if (query.status !== undefined && query.status !== "") {
      conditions.push(eq(agentLevelTask.status, integer(query.status, "状态", 0, 0, 1)));
    }
    if (query.keyword?.trim()) conditions.push(ilike(agentLevelTask.name, `%${query.keyword.trim()}%`));
    const where = and(...conditions);
    const [rows, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(agentLevelTask)
        .where(where)
        .orderBy(desc(agentLevelTask.sort), desc(agentLevelTask.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(agentLevelTask)
        .where(where),
    ]);
    return {
      list: rows.map((item) => ({ ...item, type_name: taskType(item.type)?.name ?? "" })),
      count: countRows[0]?.count ?? 0,
      page,
      limit,
    };
  }

  async form(id: number, levelIdValue: unknown) {
    const rows = id > 0
      ? await this.container.db
          .select()
          .from(agentLevelTask)
          .where(and(eq(agentLevelTask.id, id), eq(agentLevelTask.isDel, 0)))
          .limit(1)
      : [];
    if (id > 0 && !rows[0]) throw new NotFoundException("等级任务不存在");
    const levelId = rows[0]?.levelId ?? integer(levelIdValue, "等级ID", 0, 1);
    const level = await this.container.db
      .select({ id: agentLevel.id })
      .from(agentLevel)
      .where(and(eq(agentLevel.id, levelId), eq(agentLevel.isDel, 0)))
      .limit(1);
    if (!level[0]) throw new NotFoundException("分销等级不存在");
    return {
      title: id > 0 ? "编辑等级任务" : "添加等级任务",
      method: id > 0 ? "PUT" : "POST",
      action: id > 0 ? `/agent/level_task/${id}` : "/agent/level_task",
      task_types: AGENT_TASK_TYPES,
      info: rows[0] ?? {
        id: 0,
        levelId,
        name: "",
        type: 0,
        number: 0,
        desc: "",
        isMust: 0,
        sort: 0,
        status: 1,
      },
    };
  }

  async save(id: number, input: unknown) {
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("等级任务ID错误");
    const body = record(input);
    const requestedLevelId = integer(body.level_id ?? body.levelId, "等级ID", 0, id > 0 ? 0 : 1);
    const values = {
      name: requiredString(body.name, "任务名称", 50),
      type: integer(body.type, "任务类型", 0, 1, 5),
      number: integer(body.number, "任务要求", 0, 1),
      desc: optionalString(body.desc, "任务描述", 255),
      isMust: integer(body.is_must ?? body.isMust, "是否必达", 0, 0, 1),
      sort: integer(body.sort, "排序", 0, 0, 32_767),
      status: integer(body.status, "状态", 1, 0, 1),
    };
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${TASK_CATALOG_LOCK_NAMESPACE}, 0)`);
      let levelId = requestedLevelId;
      let existing: typeof agentLevelTask.$inferSelect | undefined;
      if (id > 0) {
        const rows = await tx
          .select()
          .from(agentLevelTask)
          .where(and(eq(agentLevelTask.id, id), eq(agentLevelTask.isDel, 0)))
          .limit(1)
          .for("update");
        existing = rows[0];
        if (!existing) throw new NotFoundException("等级任务不存在");
        levelId = existing.levelId;
        if (existing.type !== values.type || existing.number !== values.number) {
          const completed = await tx
            .select({ id: agentLevelTaskRecord.id })
            .from(agentLevelTaskRecord)
            .where(eq(agentLevelTaskRecord.taskId, id))
            .limit(1);
          if (completed[0]) throw new ValidateException("已有用户完成该任务，不能修改任务类型或要求");
        }
      }
      const levels = await tx
        .select({ id: agentLevel.id, grade: agentLevel.grade })
        .from(agentLevel)
        .where(and(eq(agentLevel.id, levelId), eq(agentLevel.isDel, 0)))
        .limit(1)
        .for("key share");
      const level = levels[0];
      if (!level) throw new NotFoundException("分销等级不存在");
      const duplicateConditions = [
        eq(agentLevelTask.levelId, levelId),
        eq(agentLevelTask.type, values.type),
        eq(agentLevelTask.isDel, 0),
      ];
      if (id > 0) duplicateConditions.push(ne(agentLevelTask.id, id));
      const duplicate = await tx
        .select({ id: agentLevelTask.id })
        .from(agentLevelTask)
        .where(and(...duplicateConditions))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("该等级已存在此类型任务");
      const peers = await tx
        .select({ id: agentLevelTask.id, number: agentLevelTask.number, grade: agentLevel.grade })
        .from(agentLevelTask)
        .innerJoin(agentLevel, eq(agentLevel.id, agentLevelTask.levelId))
        .where(
          and(
            eq(agentLevelTask.type, values.type),
            eq(agentLevelTask.isDel, 0),
            eq(agentLevelTask.status, 1),
            eq(agentLevel.isDel, 0),
            id > 0 ? ne(agentLevelTask.id, id) : undefined,
          ),
        );
      for (const peer of peers) {
        if (level.grade > peer.grade && values.number <= peer.number) {
          throw new ValidateException("不能小于或等于低等级同类型任务要求");
        }
        if (level.grade < peer.grade && values.number >= peer.number) {
          throw new ValidateException("不能大于或等于高等级同类型任务要求");
        }
      }
      if (existing) {
        await tx.update(agentLevelTask).set(values).where(eq(agentLevelTask.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(agentLevelTask)
        .values({ levelId, ...values, addTime: Math.floor(Date.now() / 1000) })
        .returning({ id: agentLevelTask.id });
      return { id: inserted[0].id };
    });
  }

  async delete(id: number) {
    return this.updateState(id, { isDel: 1 });
  }

  async setStatus(id: number, statusValue: unknown) {
    return this.updateState(id, { status: integer(statusValue, "状态", 0, 0, 1) });
  }

  async userLevelList(uid: number) {
    const state = await this.evaluateLevels(uid);
    if (!state.enabled) return [];
    const levels = await this.container.db
      .select()
      .from(agentLevel)
      .where(and(eq(agentLevel.isDel, 0), eq(agentLevel.status, 1)))
      .orderBy(asc(agentLevel.grade), asc(agentLevel.id));
    const current = levels.find((level) => level.id === state.agentLevel) ?? null;
    const [taskCount, completedCount] = current
      ? await Promise.all([
          this.container.db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(agentLevelTask)
            .where(
              and(
                eq(agentLevelTask.levelId, current.id),
                eq(agentLevelTask.isDel, 0),
                eq(agentLevelTask.status, 1),
              ),
            ),
          this.container.db
            .select({ count: sql<number>`COUNT(DISTINCT ${agentLevelTaskRecord.taskId})::int` })
            .from(agentLevelTaskRecord)
            .where(and(eq(agentLevelTaskRecord.uid, uid), eq(agentLevelTaskRecord.levelId, current.id))),
        ])
      : [[{ count: 0 }], [{ count: 0 }]];
    return {
      user: {
        uid: state.account.uid,
        nickname: state.account.nickname,
        avatar: state.account.avatar,
        brokerage_price: state.account.brokeragePrice,
        agent_level: state.agentLevel,
        spread_count: state.metrics.inviteCount,
      },
      level_list: levels,
      level_info: current
        ? { ...current, sum_task: taskCount[0]?.count ?? 0, finish_task: completedCount[0]?.count ?? 0 }
        : { sum_task: 0, finish_task: 0 },
    };
  }

  async userTaskList(uid: number, levelIdValue: unknown) {
    const state = await this.evaluateLevels(uid);
    if (!state.enabled) return [];
    let levelId = integer(levelIdValue, "等级ID", 0, 0);
    const levels = await this.container.db
      .select()
      .from(agentLevel)
      .where(and(eq(agentLevel.isDel, 0), eq(agentLevel.status, 1)))
      .orderBy(asc(agentLevel.grade), asc(agentLevel.id));
    if (!levels.some((level) => level.id === levelId)) levelId = levels[0]?.id ?? 0;
    if (!levelId) return { list: [], speedAll: 0 };
    const [tasks, records] = await Promise.all([
      this.container.db
        .select()
        .from(agentLevelTask)
        .where(
          and(
            eq(agentLevelTask.levelId, levelId),
            eq(agentLevelTask.isDel, 0),
            eq(agentLevelTask.status, 1),
          ),
        )
        .orderBy(desc(agentLevelTask.sort), desc(agentLevelTask.id)),
      this.container.db
        .select({ taskId: agentLevelTaskRecord.taskId })
        .from(agentLevelTaskRecord)
        .where(and(eq(agentLevelTaskRecord.uid, uid), eq(agentLevelTaskRecord.levelId, levelId))),
    ]);
    const completed = new Set(records.map((item) => item.taskId));
    const list = tasks.map((task) => {
      const progress = calculateAgentTaskProgress(task, state.metrics);
      const definition = taskType(task.type);
      const finish = completed.has(task.id) || progress.complete;
      return {
        ...task,
        finish: finish ? 1 : 0,
        task_type_title: finish ? "已完成" : `还需${progress.displayRemaining}${definition?.unit ?? ""}`,
        speed: finish ? 100 : progress.speed,
        new_number: progress.displayCurrent,
        image: definition?.image ?? "",
      };
    });
    const speedAll = list.length
      ? Number((list.reduce((sum, task) => sum + task.speed, 0) / list.length).toFixed(2))
      : 0;
    return { list, speedAll };
  }

  private async updateState(
    id: number,
    values: Partial<Pick<typeof agentLevelTask.$inferInsert, "status" | "isDel">>,
  ) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("等级任务ID错误");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${TASK_CATALOG_LOCK_NAMESPACE}, 0)`);
      const existing = await tx
        .select({ id: agentLevelTask.id })
        .from(agentLevelTask)
        .where(and(eq(agentLevelTask.id, id), eq(agentLevelTask.isDel, 0)))
        .limit(1)
        .for("update");
      if (!existing[0]) throw new NotFoundException("等级任务不存在");
      await tx.update(agentLevelTask).set(values).where(eq(agentLevelTask.id, id));
    });
  }

  private async evaluateLevels(uid: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${TASK_CATALOG_LOCK_NAMESPACE}, 0)`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${TASK_USER_LOCK_NAMESPACE}, ${uid})`);
      const accounts = await tx
        .select({
          uid: userTable.uid,
          nickname: userTable.nickname,
          avatar: userTable.avatar,
          brokeragePrice: userTable.brokeragePrice,
          agentLevel: userTable.agentLevel,
        })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .limit(1)
        .for("update");
      const account = accounts[0];
      if (!account) throw new NotFoundException("用户不存在");
      const enabled = await brokerageEnabled(tx);
      const metrics = await loadAgentTaskMetrics(tx, uid);
      if (!enabled) return { enabled, account, agentLevel: account.agentLevel, metrics };
      const levels = await tx
        .select()
        .from(agentLevel)
        .where(and(eq(agentLevel.isDel, 0), eq(agentLevel.status, 1)))
        .orderBy(asc(agentLevel.grade), asc(agentLevel.id));
      const currentGrade = levels.find((level) => level.id === account.agentLevel)?.grade ?? 0;
      const tasks = await tx
        .select()
        .from(agentLevelTask)
        .where(and(eq(agentLevelTask.isDel, 0), eq(agentLevelTask.status, 1)))
        .orderBy(asc(agentLevelTask.levelId), desc(agentLevelTask.sort), asc(agentLevelTask.id));
      const records = await tx
        .select({ levelId: agentLevelTaskRecord.levelId, taskId: agentLevelTaskRecord.taskId })
        .from(agentLevelTaskRecord)
        .where(eq(agentLevelTaskRecord.uid, uid));
      const completed = new Set(records.map((item) => `${item.levelId}:${item.taskId}`));
      let nextAgentLevel = account.agentLevel;
      const now = Math.floor(Date.now() / 1000);
      for (const level of levels) {
        if (level.grade <= currentGrade) continue;
        const levelTasks = tasks.filter((task) => task.levelId === level.id);
        if (!levelTasks.length) continue;
        for (const task of levelTasks) {
          const key = `${level.id}:${task.id}`;
          if (completed.has(key) || !calculateAgentTaskProgress(task, metrics).complete) continue;
          await tx.insert(agentLevelTaskRecord).values({
            uid,
            levelId: level.id,
            taskId: task.id,
            status: 1,
            addTime: now,
          });
          completed.add(key);
        }
        if (levelTasks.every((task) => completed.has(`${level.id}:${task.id}`))) {
          nextAgentLevel = level.id;
        } else {
          break;
        }
      }
      if (nextAgentLevel !== account.agentLevel) {
        await tx.update(userTable).set({ agentLevel: nextAgentLevel }).where(eq(userTable.uid, uid));
      }
      return { enabled, account, agentLevel: nextAgentLevel, metrics };
    });
  }
}
