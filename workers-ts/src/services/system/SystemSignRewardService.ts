import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import type { Container } from "@/lib/di";
import { withTx } from "@/lib/di";
import { systemSignReward } from "@/models/schema";
import { parseConfigInteger } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";

const REWARD_WRITE_LOCK_NAMESPACE = 731_622;
const MAX_PAGE_SIZE = 100;
const MAX_REWARD_DAYS = 3_650;
const MAX_REWARD_AMOUNT = 999;

export interface SignRewardRule {
  id?: number;
  type: number;
  days: number;
  point: number;
  exp: number;
}

export interface CalculatedSignReward {
  point: number;
  exp: number;
  matchedContinuous: boolean;
  matchedCumulative: boolean;
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${field}必须是${min}到${max}之间的整数`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  return value as Record<string, unknown>;
}

function safeRewardTotal(values: number[], field: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${field}超出安全范围`);
  return total;
}

/**
 * Preserve CRMEB's milestone semantics: a matching milestone replaces the
 * base reward, while simultaneous continuous and cumulative milestones add.
 */
export function calculateSignReward(input: {
  basePoint: number;
  baseExp: number;
  continuousDays: number;
  cumulativeDays: number;
  rules: readonly SignRewardRule[];
  memberFunctionEnabled: boolean;
  levelActive: boolean;
  pointMultiplier: number;
}): CalculatedSignReward {
  const continuous = input.rules.find(
    (rule) => rule.type === 0 && rule.days === input.continuousDays,
  );
  const cumulative = input.rules.find(
    (rule) => rule.type === 1 && rule.days === input.cumulativeDays,
  );
  const matched = [continuous, cumulative].filter(
    (rule): rule is SignRewardRule => rule !== undefined,
  );
  const pointBeforeMultiplier = matched.length
    ? safeRewardTotal(matched.map((rule) => rule.point), "签到积分")
    : input.basePoint;
  const configuredExp = matched.length
    ? safeRewardTotal(matched.map((rule) => rule.exp), "签到经验")
    : input.baseExp;
  const multiplier = Math.max(1, Math.trunc(input.pointMultiplier));
  const point = pointBeforeMultiplier * multiplier;
  if (!Number.isSafeInteger(point) || point < 0) throw new Error("签到积分超出安全范围");
  return {
    point,
    exp: input.memberFunctionEnabled && input.levelActive ? configuredExp : 0,
    matchedContinuous: Boolean(continuous),
    matchedCumulative: Boolean(cumulative),
  };
}

export class SystemSignRewardService {
  constructor(private readonly container: Container) {}

  async list(query: Record<string, string>) {
    const type = integer(query.type, "奖励类型", 0, 0, 1);
    const page = integer(query.page, "页码", 1, 1, 1_000_000);
    const limit = integer(query.limit, "每页数量", 20, 1, MAX_PAGE_SIZE);
    const where = eq(systemSignReward.type, type);
    const [list, countRows] = await Promise.all([
      this.container.db
        .select()
        .from(systemSignReward)
        .where(where)
        .orderBy(asc(systemSignReward.days), asc(systemSignReward.id))
        .limit(limit)
        .offset((page - 1) * limit),
      this.container.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(systemSignReward)
        .where(where),
    ]);
    return { list, count: countRows[0]?.count ?? 0, page, limit };
  }

  async form(id: number, typeValue: unknown) {
    const info = id > 0
      ? await this.container.db
          .select()
          .from(systemSignReward)
          .where(eq(systemSignReward.id, id))
          .limit(1)
      : [];
    if (id > 0 && !info[0]) throw new NotFoundException("签到奖励不存在");
    const type = info[0]?.type ?? integer(typeValue, "奖励类型", 0, 0, 1);
    const signMode = parseConfigInteger(
      await this.container.systemConfigDao.getValue("sign_mode"),
      -1,
    );
    const maxDays = signMode === 1 ? 7 : 30;
    const value = info[0] ?? { id: 0, type, days: 0, point: 0, exp: 0 };
    return {
      title: type === 1 ? "累积签到奖励" : "连续签到奖励",
      method: "POST",
      action: `/setting/sign/save_rewards/${id}`,
      rules: [
        { type: "hidden", field: "type", value: type },
        {
          type: "number",
          field: "days",
          title: type === 1 ? "累积签到天数" : "连续签到天数",
          value: value.days,
          props: { min: 1, max: maxDays },
        },
        { type: "number", field: "point", title: "赠送积分", value: value.point, props: { min: 0, max: 999 } },
        { type: "number", field: "exp", title: "赠送经验", value: value.exp, props: { min: 0, max: 999 } },
      ],
      info: value,
    };
  }

  async save(id: number, input: unknown) {
    if (!Number.isSafeInteger(id) || id < 0) throw new ValidateException("签到奖励ID错误");
    const body = record(input);
    const values = {
      type: integer(body.type, "奖励类型", 0, 0, 1),
      days: integer(body.days, "签到天数", 0, 1, MAX_REWARD_DAYS),
      point: integer(body.point, "赠送积分", 0, 0, MAX_REWARD_AMOUNT),
      exp: integer(body.exp, "赠送经验", 0, 0, MAX_REWARD_AMOUNT),
    };
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${REWARD_WRITE_LOCK_NAMESPACE}, 0)`);
      if (id > 0) {
        const existing = await tx
          .select({ id: systemSignReward.id })
          .from(systemSignReward)
          .where(eq(systemSignReward.id, id))
          .limit(1)
          .for("update");
        if (!existing[0]) throw new NotFoundException("签到奖励不存在");
      }
      const duplicateConditions = [
        eq(systemSignReward.type, values.type),
        eq(systemSignReward.days, values.days),
      ];
      if (id > 0) duplicateConditions.push(ne(systemSignReward.id, id));
      const duplicate = await tx
        .select({ id: systemSignReward.id })
        .from(systemSignReward)
        .where(and(...duplicateConditions))
        .orderBy(desc(systemSignReward.id))
        .limit(1);
      if (duplicate[0]) throw new ValidateException("签到奖励已存在");
      if (id > 0) {
        await tx.update(systemSignReward).set(values).where(eq(systemSignReward.id, id));
        return { id };
      }
      const inserted = await tx
        .insert(systemSignReward)
        .values(values)
        .returning({ id: systemSignReward.id });
      return { id: inserted[0].id };
    });
  }

  async delete(id: number) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidateException("签到奖励ID错误");
    return withTx(this.container, async (tx) => {
      const existing = await tx
        .select({ id: systemSignReward.id })
        .from(systemSignReward)
        .where(eq(systemSignReward.id, id))
        .limit(1)
        .for("update");
      if (!existing[0]) throw new NotFoundException("签到奖励不存在");
      await tx.delete(systemSignReward).where(eq(systemSignReward.id, id));
    });
  }
}
