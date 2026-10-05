import {
  and,
  asc,
  desc,
  eq,
  inArray,
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
import { publicProductPictures, renderProductPictures } from "@/services/activity/ProductAssetPolicy";

const TASK_CATALOG_LOCK_NAMESPACE = 731_624;
const TASK_USER_LOCK_NAMESPACE = 731_628;

export const AGENT_TASK_TYPES = [
  { type: 1, name: "邀请好友成为下级", template: "邀请好友{$num}成为下级", unit: "人", image: "/uploads/system/agent_spread.png" },
  { type: 2, name: "自身消费金额", template: "自身消费满{$num}", unit: "元", image: "/uploads/system/agent_self_order_price.png" },
  { type: 3, name: "自身消费单数", template: "自身消费满{$num}", unit: "单", image: "/uploads/system/agent_self_order.png" },
  { type: 4, name: "下级消费金额", template: "下级消费满{$num}", unit: "元", image: "/uploads/system/agent_spread_order_price.png" },
  { type: 5, name: "下级消费单数", template: "下级消费满{$num}", unit: "单", image: "/uploads/system/agent_spread_order.png" },
] as const;

export interface AgentTaskMetrics {
  inviteCount: number;
  ownOrderCents: number;
  ownOrderCount: number;
  downlineOrderCents: number;
  downlineOrderCount: number;
}

/** Stable, PII-free failure category for the post-commit registration log and
 * paid-event retry path. Historical completed evidence is handled before this
 * check; this exception never revokes an already granted rank. */
export class AgentLevelTaskInvalidException extends ValidateException {
  constructor() {
    super("启用的分销等级任务无效，请先修复后重试");
    this.name = "AgentLevelTaskInvalidException";
  }
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

/** PHP TaskType templates and bcsub scale: amounts retain two decimal places,
 * while counts remain integers. Format integer cents, never rounded floats. */
export function agentTaskRemainingTitle(
  task: Pick<typeof agentLevelTask.$inferSelect, "type" | "number">, metrics: AgentTaskMetrics,
) {
  const definition = taskType(task.type);
  if (!definition) return "任务类型待核实";
  const progress = calculateAgentTaskProgress(task, metrics);
  const remaining = Math.max(0, progress.target - progress.current);
  const display = task.type === 2 || task.type === 4
    ? `${Math.floor(remaining / 100)}.${String(remaining % 100).padStart(2, "0")}` : String(remaining);
  return `还需${definition.template.replace("{$num}", display + definition.unit)}`;
}

export interface AgentUpgradePolicy {
  enabled: boolean;
  selfBuy: boolean;
  bindingMode: number;
  bindingDays: number;
}

type AgentLevelRow = typeof agentLevel.$inferSelect;
type AgentTaskRow = typeof agentLevelTask.$inferSelect;
const accountProjection = {
  uid: userTable.uid, nickname: userTable.nickname, avatar: userTable.avatar,
  brokeragePrice: userTable.brokeragePrice, agentLevel: userTable.agentLevel,
  spreadUid: userTable.spreadUid, spreadTime: userTable.spreadTime,
};
type AgentAccount = Pick<typeof userTable.$inferSelect, keyof typeof accountProjection>;
export type AgentUpgradeRelation = Pick<AgentAccount, "uid" | "spreadUid" | "spreadTime">;

/** PHP AgentJob -> getSpreadUid; self-buy replaces the first recipient only.
 * The second traversal always checks the real relation and its expiry. */
export function resolveAgentUpgradeUids(
  uid: number, policy: AgentUpgradePolicy, accounts: readonly AgentUpgradeRelation[], now: number,
): number[] {
  if (!policy.enabled) return [];
  const byId = new Map(accounts.map(account => [account.uid, account]));
  const parent = (account: AgentUpgradeRelation | undefined) => {
    if (!account) return 0;
    if ([1, 3].includes(policy.bindingMode)) return account.spreadUid;
    if (policy.bindingMode === 2 && account.spreadTime + policy.bindingDays * 86400 > now) return account.spreadUid;
    return 0;
  };
  const first = policy.selfBuy ? uid : parent(byId.get(uid));
  const second = first > 0 ? parent(byId.get(first)) : 0;
  return [...new Set([uid, first, second].filter(id => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

async function readAgentUpgradePolicy(db: DbClient): Promise<AgentUpgradePolicy> {
  const value = (name: string) => sql<string | null>`(SELECT ${systemConfig.value} FROM ${systemConfig}
    WHERE ${systemConfig.isStore} = 0 AND ${systemConfig.menuName} = ${name}
    ORDER BY ${systemConfig.sort} DESC, ${systemConfig.id} DESC LIMIT 1)`;
  const [row] = await db.select({ enabled: value("brokerage_func_status"), selfBuy: value("is_self_brokerage"),
    bindingMode: value("store_brokerage_binding_status"), bindingDays: value("store_brokerage_binding_time") })
    .from(sql`(VALUES (1)) agent_upgrade_policy(n)`);
  if (!row) throw new Error("分销升级配置读取失败");
  const bindingDays = parseConfigInteger(row.bindingDays ?? undefined, 30);
  if (!Number.isSafeInteger(bindingDays) || bindingDays < 0 || bindingDays > 2147483647) throw new ValidateException("分销绑定期限无效");
  return { enabled: parseConfigInteger(row.enabled ?? undefined, 0) === 1,
    selfBuy: parseConfigInteger(row.selfBuy ?? undefined, 0) === 1,
    bindingMode: parseConfigInteger(row.bindingMode ?? undefined, 1), bindingDays };
}

/** A completed historical record (including status=0 and duplicate rows) is
 * durable. All active tasks count; is_must never introduced an OR algorithm. */
export function planAgentLevelUpgrade(
  assignedLevelId: number, levels: readonly AgentLevelRow[], tasks: readonly AgentTaskRow[],
  completedKeys: ReadonlySet<string>, metrics: AgentTaskMetrics,
) {
  const assigned = levels.find(level => level.id === assignedLevelId);
  if (assignedLevelId > 0 && !assigned) throw new ValidateException("已授予分销等级引用缺失，请修复后重试");
  const currentGrade = assigned?.grade ?? 0;
  const active = levels.filter(level => level.status === 1 && level.isDel === 0)
    .sort((a, b) => a.grade - b.grade || b.id - a.id);
  if (active.some((level, index) => index > 0 && active[index - 1].grade === level.grade)) {
    throw new ValidateException("存在重复分销级别，请先修复等级目录");
  }
  let levelId = assignedLevelId;
  const completed = new Set(completedKeys);
  const newRecords: { levelId: number; taskId: number }[] = [];
  for (const level of active) {
    if (level.grade <= currentGrade) continue;
    const requirements = tasks.filter(task => task.levelId === level.id && task.isDel === 0 && task.status === 1);
    if (!requirements.length) continue;
    for (const task of requirements) {
      const key = `${level.id}:${task.id}`;
      if (completed.has(key)) continue;
      if (!taskType(task.type) || !Number.isSafeInteger(task.number) || task.number <= 0) {
        throw new AgentLevelTaskInvalidException();
      }
      if (!calculateAgentTaskProgress(task, metrics).complete) continue;
      completed.add(key);
      newRecords.push({ levelId: level.id, taskId: task.id });
    }
    if (!requirements.every(task => completed.has(`${level.id}:${task.id}`))) break;
    levelId = level.id;
  }
  return { levelId, currentGrade, newRecords };
}

interface AgentEvaluation {
  enabled: boolean;
  account: AgentAccount;
  agentLevel: number;
  currentGrade: number;
  metrics: AgentTaskMetrics;
  levels: AgentLevelRow[];
  tasks: AgentTaskRow[];
  completedKeys: Set<string>;
  imageReferences: string[];
}

/** Standalone transaction only: callers must finish their payment/registration
 * transaction first. The installed statement boundary shares this catalog lock
 * with every level/task writer and record INSERT, without a reverse table lock. */
async function evaluateAgentUsers(container: Container, uid: number, pictures = false) {
  if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 2147483647) throw new ValidateException("用户ID错误");
  return withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '5s'`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${TASK_CATALOG_LOCK_NAMESPACE}, 0)`);
    const policy = await readAgentUpgradePolicy(tx);
    if (!policy.enabled) return { state: null,
      result: { enabled: false, evaluatedUids: [] as number[], upgraded: [] as { uid: number; previousLevelId: number; levelId: number }[] } };
    const [levels, tasks] = await Promise.all([
      tx.select().from(agentLevel).orderBy(asc(agentLevel.grade), desc(agentLevel.id)).limit(10001),
      tx.select().from(agentLevelTask).where(and(eq(agentLevelTask.isDel, 0), eq(agentLevelTask.status, 1)))
        .orderBy(asc(agentLevelTask.levelId), desc(agentLevelTask.sort), desc(agentLevelTask.id)).limit(50001),
    ]);
    if (levels.length > 10000 || tasks.length > 50000) throw new ValidateException("分销等级目录超过完整读取容量");
    const [initial] = await tx.select(accountProjection).from(userTable)
      .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0))).limit(1);
    if (!initial) throw new NotFoundException("用户不存在");
    const hints = new Map<number, AgentAccount>([[uid, initial]]);
    const now = Math.floor(Date.now() / 1000);
    // Two bounded traversals; no parent lock is acquired after a child row lock.
    for (let depth = 0; depth < 2; depth++) {
      const missing = resolveAgentUpgradeUids(uid, policy, [...hints.values()], now).filter(id => !hints.has(id));
      if (!missing.length) break;
      const rows = await tx.select(accountProjection).from(userTable)
        .where(and(inArray(userTable.uid, missing), eq(userTable.isDel, 0)));
      for (const row of rows) hints.set(row.uid, row);
    }
    const requested = policy.enabled ? resolveAgentUpgradeUids(uid, policy, [...hints.values()], now) : [uid];
    for (const id of requested) await tx.execute(sql`SELECT pg_advisory_xact_lock(${TASK_USER_LOCK_NAMESPACE}, ${id})`);
    const accounts = await tx.select(accountProjection).from(userTable)
      .where(and(inArray(userTable.uid, requested), eq(userTable.isDel, 0))).orderBy(asc(userTable.uid)).for("update", { noWait: true });
    const locked = new Map(accounts.map(account => [account.uid, account]));
    if (!locked.has(uid)) throw new NotFoundException("用户不存在");
    for (const [id, hint] of hints) {
      const account = locked.get(id);
      if (requested.includes(id) && (!account || account.spreadUid !== hint.spreadUid || account.spreadTime !== hint.spreadTime)) {
        throw new ValidateException("推广关系已变化，请重试等级升级");
      }
    }
    const finalUids = policy.enabled ? resolveAgentUpgradeUids(uid, policy, accounts, Math.floor(Date.now() / 1000)) : [uid];
    if (finalUids.some(id => !requested.includes(id))) throw new ValidateException("推广关系已变化，请重试等级升级");
    const records = policy.enabled ? await tx.select({ uid: agentLevelTaskRecord.uid,
      levelId: agentLevelTaskRecord.levelId, taskId: agentLevelTaskRecord.taskId }).from(agentLevelTaskRecord)
      .where(inArray(agentLevelTaskRecord.uid, finalUids)) : [];
    const states = new Map<number, AgentEvaluation>();
    const upgraded: { uid: number; previousLevelId: number; levelId: number }[] = [];
    for (const id of finalUids) {
      const account = locked.get(id);
      if (!account) continue; // PHP skips a nonexistent upper account.
      const metrics = await loadAgentTaskMetrics(tx, id);
      const completedKeys = new Set(records.filter(row => row.uid === id).map(row => `${row.levelId}:${row.taskId}`));
      const plan = policy.enabled ? planAgentLevelUpgrade(account.agentLevel, levels, tasks, completedKeys, metrics)
        : { levelId: account.agentLevel, currentGrade: levels.find(level => level.id === account.agentLevel)?.grade ?? 0, newRecords: [] };
      for (const row of plan.newRecords) {
        await tx.insert(agentLevelTaskRecord).values({ uid: id, ...row, addTime: now });
        completedKeys.add(`${row.levelId}:${row.taskId}`);
      }
      if (plan.levelId !== account.agentLevel) {
        await tx.update(userTable).set({ agentLevel: plan.levelId }).where(eq(userTable.uid, id));
        upgraded.push({ uid: id, previousLevelId: account.agentLevel, levelId: plan.levelId });
      }
      states.set(id, { enabled: policy.enabled, account, agentLevel: plan.levelId,
        currentGrade: levels.find(level => level.id === plan.levelId)?.grade ?? plan.currentGrade,
        metrics, levels, tasks, completedKeys, imageReferences: [] });
    }
    const state = states.get(uid);
    if (!state) throw new NotFoundException("用户不存在");
    if (policy.enabled && pictures) state.imageReferences = await publicProductPictures(tx,
      levels.map(level => ({ image: level.image, type: 0, relationId: 0 })));
    return { state, result: { enabled: policy.enabled, evaluatedUids: [...states.keys()], upgraded } };
  });
}

/** Invoke AFTER registration/binding or the paid-outbox claim commit, before
 * its financial transaction; also permits an already-completed payment retry.
 * Never nest this in an existing transaction.
 * User/record changes are atomic and repeated deliveries do not add records. */
export async function upgradeAgentLevelsForUser(container: Container, uid: number) {
  return (await evaluateAgentUsers(container, uid)).result;
}

export class AgentLevelTaskService {
  constructor(private readonly container: Container, private readonly env: { APP_KEY?: string } = {}) {}

  async userLevelList(uid: number) {
    const state = await this.evaluateLevels(uid);
    if (!state?.enabled) return [];
    const rendered = await renderProductPictures(this.env.APP_KEY, state.imageReferences);
    const present = (level: AgentLevelRow) => ({ ...level,
      image: rendered[state.levels.findIndex(row => row.id === level.id)] ?? "",
      one_brokerage: level.oneBrokerage, two_brokerage: level.twoBrokerage,
      is_del: level.isDel, add_time: level.addTime,
      sum_task: state.tasks.filter(task => task.levelId === level.id).length,
    });
    const levels = state.levels.filter(level => level.isDel === 0 && level.status === 1).map(present);
    const current = state.levels.find(level => level.id === state.agentLevel && level.isDel === 0);
    const currentTasks = current ? state.tasks.filter(task => task.levelId === current.id) : [];
    const finishCount = currentTasks.filter(task => state.currentGrade >= current!.grade
      || state.completedKeys.has(`${current!.id}:${task.id}`)).length;
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
        ? { ...present(current), finish_task: finishCount }
        : { sum_task: 0, finish_task: 0 },
      current_grade: state.currentGrade,
      next_level: levels.find(level => level.grade > state.currentGrade && level.sum_task > 0) ?? null,
    };
  }

  async userTaskList(uid: number, levelIdValue: unknown) {
    const state = await this.evaluateLevels(uid);
    if (!state?.enabled) return [];
    let levelId = integer(levelIdValue, "等级ID", 0, 0);
    const levels = state.levels.filter(level => level.isDel === 0 && level.status === 1);
    if (!levels.some((level) => level.id === levelId)) levelId = levels[0]?.id ?? 0;
    if (!levelId) return { list: [], speedAll: 0 };
    const selectedLevel = levels.find(level => level.id === levelId)!;
    const tasks = state.tasks.filter(task => task.levelId === levelId);
    const gifted = state.agentLevel > 0 && state.currentGrade >= selectedLevel.grade;
    const list = tasks.map((task) => {
      const progress = calculateAgentTaskProgress(task, state.metrics);
      const definition = taskType(task.type);
      const finish = gifted || state.completedKeys.has(`${levelId}:${task.id}`) || progress.complete;
      return {
        ...task,
        level_id: task.levelId,
        is_must: task.isMust,
        is_del: task.isDel,
        add_time: task.addTime,
        finish: finish ? 1 : 0,
        task_type_title: finish ? "已完成" : agentTaskRemainingTitle(task, state.metrics),
        speed: finish ? 100 : progress.speed,
        new_number: finish ? task.number : progress.displayCurrent,
        image: definition?.image ?? "",
      };
    });
    const speedAll = list.length
      ? Math.trunc(list.reduce((sum, task) => sum + task.speed, 0) * 100 / list.length) / 100
      : 0;
    return { list, speedAll };
  }

  private async evaluateLevels(uid: number) {
    return (await evaluateAgentUsers(this.container, uid, true)).state;
  }
}
