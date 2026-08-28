/**
 * 会员等级 Service
 *
 * 对应 PHP app/services/user/level/SystemUserLevelServices.php::getLevelCache
 *
 * 缓存: KV 存等级信息 (变更频率低), key=level_grade_<id>, TTL 6h。
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  systemConfig,
  systemUserLevel,
  user as userTable,
  userBill as userBillTable,
  userMoney,
} from "@/models/schema";
import { type Container, withTx } from "@/lib/di";
import type { Env } from "@/env";
import { ValidateException } from "@/utils/errors";
import { detectUserLevel } from "@/services/order/OrderRewardService";
import {
  configFlag,
  parseConfigIds,
  parseLegacyWholeMoney,
} from "@/services/activity/StoreNewcomerService";

const CACHE_TTL = 6 * 3600;
const ACTIVATION_CONFIG_KEYS = [
  "member_func_status",
  "level_activate_status",
  "level_extend_info",
  "level_integral_status",
  "level_give_integral",
  "level_money_status",
  "level_give_money",
  "level_coupon_status",
  "level_give_coupon",
] as const;

export type ActivationField = Record<string, unknown> & {
  info?: string;
  param?: string;
  format?: string;
  value?: unknown;
};

interface ActivationConfig {
  memberEnabled: boolean;
  activationRequired: boolean;
  extendInfo: ActivationField[];
  integralEnabled: boolean;
  integral: number;
  moneyEnabled: boolean;
  moneyUnits: number;
  couponEnabled: boolean;
  couponIds: number[];
}

export interface LevelActivationResult {
  level_integral_status: number;
  level_give_integral: number;
  level_money_status: number;
  level_give_money: number;
  level_coupon_status: number;
  level_give_coupon: Array<{
    id: number;
    title: string;
    coupon_title: string;
    coupon_price: string;
    use_min_price: string;
  }>;
}

function parseConfigArray(value: string | undefined): ActivationField[] {
  const normalized = value?.trim() ?? "";
  if (!normalized) return [];
  try {
    const parsed: unknown = JSON.parse(normalized);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is ActivationField => Boolean(item) && typeof item === "object")
      : [];
  } catch {
    return [];
  }
}

function boundedText(value: unknown, maxLength: number, label: string): string {
  const text = String(value ?? "").trim();
  if (text.length > maxLength) throw new ValidateException(`${label}内容过长`);
  return text;
}

function parseBirthday(value: unknown): number {
  const text = boundedText(value, 10, "生日");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new ValidateException("生日格式错误");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) throw new ValidateException("生日格式错误");
  // PHP runs in Asia/Shanghai and strtotime("YYYY-MM-DD") stores local midnight.
  return Math.floor(date.getTime() / 1_000) - 8 * 60 * 60;
}

export function normalizeLevelActivationFields(
  submitted: unknown,
  template: ActivationField[],
): { extendInfo: ActivationField[]; fields: Partial<typeof userTable.$inferInsert> } {
  if (!template.length) return { extendInfo: [], fields: {} };
  if (!Array.isArray(submitted)) throw new ValidateException("会员卡激活资料格式错误");
  if (submitted.length > 64) throw new ValidateException("会员卡激活资料过多");
  const byInfo = new Map<string, ActivationField>();
  const byParam = new Map<string, ActivationField>();
  for (const item of submitted) {
    if (!item || typeof item !== "object") continue;
    const field = item as ActivationField;
    if (typeof field.info === "string") byInfo.set(field.info, field);
    if (typeof field.param === "string") byParam.set(field.param, field);
  }
  const fields: Partial<typeof userTable.$inferInsert> = {};
  const extendInfo = template.map((definition) => {
    const info = typeof definition.info === "string" ? definition.info : "";
    const param = typeof definition.param === "string" ? definition.param : "";
    const input = byInfo.get(info) ?? byParam.get(param);
    const value = input?.value ?? "";
    const text = typeof value === "string" ? value.trim() : value;
    if (configFlag(String(definition.required ?? "0")) && (text === "" || text === null)) {
      throw new ValidateException(boundedText(definition.tip || info || "必填信息", 80, "提示"));
    }
    const format = typeof definition.format === "string" ? definition.format : "";
    if (text !== "") {
      if (format === "phone" && !/^1[3-9]\d{9}$/.test(String(text))) {
        throw new ValidateException("请填写正确的手机号");
      }
      if (format === "mail" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text))) {
        throw new ValidateException("请填写正确的邮箱");
      }
      if (format === "id" && !/^(?:\d{15}|\d{17}[\dXx])$/.test(String(text))) {
        throw new ValidateException("请填写正确的身份证号码");
      }
      if (format === "num" && !/^\d+(?:\.\d+)?$/.test(String(text))) {
        throw new ValidateException(`${info || "数字"}格式错误`);
      }
    }
    if (param === "real_name" && text !== "") fields.realName = boundedText(text, 25, "姓名");
    if (param === "card_id" && text !== "") fields.cardId = boundedText(text, 20, "身份证");
    if (param === "address" && text !== "") fields.addres = boundedText(text, 255, "地址");
    if (param === "mark" && text !== "") fields.mark = boundedText(text, 255, "备注");
    if (param === "birthday" && text !== "") fields.birthday = parseBirthday(text);
    if (param === "sex" && text !== "") {
      const sex = new Map<unknown, number>([
        ["男", 1], ["女", 2], ["保密", 0],
        [0, 1], [1, 2], [2, 0], ["0", 1], ["1", 2], ["2", 0],
      ]).get(text);
      if (sex === undefined) throw new ValidateException("性别选项错误");
      fields.sex = sex;
    }
    return { ...definition, value: text };
  });
  const serialized = JSON.stringify(extendInfo);
  if (serialized.length > 16 * 1024) throw new ValidateException("会员卡激活资料过大");
  fields.levelExtendInfo = serialized;
  return { extendInfo, fields };
}

function nonNegativeMoneyCents(value: string | number): number {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new ValidateException("会员账户余额无效");
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new ValidateException("会员账户余额超出安全范围");
  }
  return cents;
}

function nonNegativeHundredths(value: string | number, label: string): number {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new ValidateException(`${label}无效`);
  const [whole, fraction = ""] = normalized.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 0) throw new ValidateException(`${label}超出安全范围`);
  return amount;
}

function couponUsable(issue: typeof storeCouponIssue.$inferSelect, now: number): boolean {
  const nowMs = now * 1_000;
  const issueWindow = (!issue.startTime && !issue.endTime)
    || Boolean(issue.startTime && issue.endTime
      && issue.startTime.getTime() <= nowMs && issue.endTime.getTime() >= nowMs);
  const useWindow = issue.day > 0 || Boolean(issue.useEndTime && issue.useEndTime.getTime() >= nowMs);
  return issue.status === 1 && issue.isDel === 0
    && (issue.isPermanent === 1 || issue.remainCount > 0)
    && issueWindow && useWindow;
}

export interface LevelInfo {
  id: number;
  name: string;
  discount: number; // 0-100
  grade: number;
  /** 升级所需经验 (可选) */
  expNum?: number;
  /** 购买金额 (可选) */
  money?: string;
  icon?: string;
  image?: string;
  isForever?: number;
}

export class UserLevelService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  /**
   * 取会员等级信息 (带缓存, 对应 PHP getLevelCache)
   * @param levelId user.level 字段 (system_user_level.id)
   */
  async getLevel(levelId: number): Promise<LevelInfo | null> {
    if (!levelId) return null;

    const cacheKey = `level_${levelId}`;
    const cached = await this.env.CONFIG_KV.get<LevelInfo>(cacheKey, "json");
    if (cached) return cached;

    const row = await this.container.systemUserLevelDao.getById(levelId);
    if (!row || !row.isShow || row.isDel) return null;

    const info: LevelInfo = {
      id: row.id,
      name: row.name,
      discount: Number(row.discount) || 100,
      grade: row.grade,
    };

    await this.env.CONFIG_KV.put(cacheKey, JSON.stringify(info), {
      expirationTtl: CACHE_TTL,
    });
    return info;
  }

  /** 失效缓存 (后台改等级后调用) */
  async invalidate(levelId: number): Promise<void> {
    await this.env.CONFIG_KV.delete(`level_${levelId}`);
  }

  // ═══ 用户端 API (对应原版 user/level/*) ═════════════════

  /** 等级列表 (user/level/grade) */
  async gradeList(): Promise<LevelInfo[]> {
    const rows = await this.container.db
      .select()
      .from(systemUserLevel)
      .where(sql`${systemUserLevel.isShow} = 1 AND ${systemUserLevel.isDel} = 0`)
      .orderBy(sql`${systemUserLevel.grade} ASC`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      discount: Number(r.discount) || 100,
      grade: r.grade,
      money: r.money,
      expNum: r.expNum,
      icon: r.icon,
      image: r.image,
      isForever: r.isForever,
    }));
  }

  /** 用户等级信息 (user/level/info) */
  async userLevelInfo(uid: number): Promise<{
    level: LevelInfo | null;
    currentExp: number;
    nextLevel: LevelInfo | null;
    nextExpNeed: number;
  }> {
    const user = await this.container.userDao.findForAuth(uid);
    if (!user) return { level: null, currentExp: 0, nextLevel: null, nextExpNeed: 0 };

    const current = user.level ? await this.getLevel(user.level) : null;
    const all = await this.gradeList();
    const idx = all.findIndex((l) => l.id === user.level);
    const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

    return {
      level: current,
      currentExp: Number(user.exp) || 0,
      nextLevel: next,
      nextExpNeed: next ? Math.max(0, (next.expNum ?? 0) - (Number(user.exp) || 0)) : 0,
    };
  }

  private async activationConfig(container: Container = this.container): Promise<ActivationConfig> {
    const rows = await container.db
      .select({ menuName: systemConfig.menuName, value: systemConfig.value })
      .from(systemConfig)
      .where(and(eq(systemConfig.isStore, 0), inArray(systemConfig.menuName, [...ACTIVATION_CONFIG_KEYS])))
      .orderBy(asc(systemConfig.sort), asc(systemConfig.id));
    const values: Record<string, string> = {};
    for (const row of rows) values[row.menuName] = row.value;
    const integralEnabled = configFlag(values.level_integral_status);
    const moneyEnabled = configFlag(values.level_money_status);
    const couponEnabled = configFlag(values.level_coupon_status);
    return {
      memberEnabled: configFlag(values.member_func_status),
      activationRequired: configFlag(values.level_activate_status),
      extendInfo: parseConfigArray(values.level_extend_info),
      integralEnabled,
      integral: integralEnabled ? Math.max(0, Number.parseInt(values.level_give_integral || "0", 10) || 0) : 0,
      moneyEnabled,
      moneyUnits: moneyEnabled ? parseLegacyWholeMoney(values.level_give_money) : 0,
      couponEnabled,
      couponIds: couponEnabled ? parseConfigIds(values.level_give_coupon) : [],
    };
  }

  /** GET user/level/activate_info — 与 PHP 相同的功能开关和表单配置。 */
  async activateInfo(): Promise<ActivationField[]> {
    const config = await this.activationConfig();
    if (!config.memberEnabled) throw new ValidateException("会员卡功能暂未开启");
    if (!config.activationRequired) throw new ValidateException("会员卡功能暂不需要激活");
    return config.extendInfo;
  }

  /** GET user/level/detection — 只按经验检测，客户端不能指定目标等级。 */
  async detection(uid: number): Promise<boolean> {
    return withTx(this.container, async (tx) => {
      const config = await this.activationConfig({ ...this.container, db: tx });
      if (!config.memberEnabled) return true;
      const accounts = await tx
        .select({
          uid: userTable.uid,
          nickname: userTable.nickname,
          exp: userTable.exp,
          levelStatus: userTable.levelStatus,
        })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0), isNull(userTable.deleteTime)))
        .limit(1)
        .for("update");
      const account = accounts[0];
      if (!account) throw new ValidateException("没有此用户，无法检测升级会员");
      if (account.levelStatus !== 1) return true;
      const expHundredths = nonNegativeHundredths(account.exp, "用户经验值");
      await detectUserLevel(tx, account.uid, account.nickname, expHundredths, Math.floor(Date.now() / 1_000));
      return true;
    });
  }

  /** POST user/level/activate — 激活状态、奖励和证据在同一事务内提交。 */
  async activateLevel(uid: number, input: unknown): Promise<LevelActivationResult> {
    const now = Math.floor(Date.now() / 1_000);
    return withTx(this.container, async (tx) => {
      const config = await this.activationConfig({ ...this.container, db: tx });
      if (!config.memberEnabled) throw new ValidateException("会员卡功能暂未开启");
      if (!config.activationRequired) throw new ValidateException("会员卡功能暂不需要激活");
      const normalized = normalizeLevelActivationFields(input, config.extendInfo);
      const accounts = await tx
        .select({
          uid: userTable.uid,
          integral: userTable.integral,
          nowMoney: userTable.nowMoney,
          levelStatus: userTable.levelStatus,
        })
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0), isNull(userTable.deleteTime)))
        .limit(1)
        .for("update");
      const account = accounts[0];
      if (!account) throw new ValidateException("用户已注销，或不存在");
      if (account.levelStatus === 1) throw new ValidateException("不需要重复激活");

      const integral = config.integral;
      const nextIntegral = account.integral + integral;
      if (!Number.isSafeInteger(nextIntegral)) throw new ValidateException("会员激活积分超出安全范围");
      const currentMoneyCents = nonNegativeMoneyCents(account.nowMoney);
      const giftMoneyCents = config.moneyUnits * 100;
      const nextMoneyCents = currentMoneyCents + giftMoneyCents;
      if (
        !Number.isSafeInteger(currentMoneyCents)
        || currentMoneyCents < 0
        || !Number.isSafeInteger(nextMoneyCents)
      ) throw new ValidateException("会员激活余额超出安全范围");
      const nextMoney = (nextMoneyCents / 100).toFixed(2);

      await tx.update(userTable).set({
        ...normalized.fields,
        levelStatus: 1,
        ...(integral > 0 ? { integral: nextIntegral } : {}),
        ...(giftMoneyCents > 0 ? { nowMoney: nextMoney } : {}),
      }).where(eq(userTable.uid, uid));

      if (integral > 0) {
        await tx.insert(userBillTable).values({
          uid,
          linkId: "0",
          pm: 1,
          title: "会员卡激活赠送积分",
          category: "integral",
          type: "level_add",
          eventKey: "level_give_integral",
          number: integral.toFixed(2),
          balance: nextIntegral.toFixed(2),
          mark: `会员卡激活赠送${integral}积分`,
          status: 1,
          addTime: now,
        });
      }
      if (giftMoneyCents > 0) {
        await tx.insert(userMoney).values({
          uid,
          linkId: "0",
          type: "level_add",
          title: "会员卡激活赠送余额",
          number: (giftMoneyCents / 100).toFixed(2),
          balance: nextMoney,
          pm: 1,
          mark: `会员卡激活赠送${(giftMoneyCents / 100).toFixed(2)}余额`,
          status: 1,
          addTime: now,
        });
      }

      const couponIds = [...new Set(config.couponIds)].sort((left, right) => left - right);
      const issues = couponIds.length
        ? await tx.select().from(storeCouponIssue)
            .where(inArray(storeCouponIssue.id, couponIds))
            .orderBy(asc(storeCouponIssue.id))
            .for("update")
        : [];
      const coupons: LevelActivationResult["level_give_coupon"] = [];
      for (const issue of issues) {
        if (!couponUsable(issue, now)) continue;
        if (issue.isPermanent !== 1) {
          const updated = await tx.update(storeCouponIssue)
            .set({ remainCount: sql`${storeCouponIssue.remainCount} - 1` })
            .where(and(eq(storeCouponIssue.id, issue.id), sql`${storeCouponIssue.remainCount} > 0`))
            .returning({ id: storeCouponIssue.id });
          if (!updated[0]) continue;
        }
        const rolling = issue.day > 0;
        await tx.insert(storeCouponUser).values({
          uid,
          issueCouponId: issue.id,
          couponTitle: issue.title || issue.couponTitle,
          couponPrice: issue.couponPrice,
          useMinPrice: issue.useMinPrice,
          status: 0,
          startTime: rolling ? new Date(now * 1_000) : issue.useStartTime,
          endTime: rolling ? new Date((now + issue.day * 86_400) * 1_000) : issue.useEndTime,
          useTime: null,
          type: issue.type,
          receiveTime: now,
          receiveSource: "activate_level",
          isFail: 0,
        });
        await tx.insert(storeCouponIssueUser).values({ uid, issueCouponId: issue.id, addTime: now });
        coupons.push({
          id: issue.id,
          title: issue.title,
          coupon_title: issue.couponTitle,
          coupon_price: issue.couponPrice,
          use_min_price: issue.useMinPrice,
        });
      }
      return {
        level_integral_status: config.integralEnabled ? 1 : 0,
        level_give_integral: integral,
        level_money_status: config.moneyEnabled ? 1 : 0,
        level_give_money: config.moneyUnits,
        level_coupon_status: config.couponEnabled ? 1 : 0,
        level_give_coupon: coupons,
      };
    });
  }

  /** 经验明细 (user/level/expList) */
  async expList(uid: number, page = 1, limit = 10) {
    const c = this.container;
    const rows = await c.db
      .select({
        id: userBillTable.id,
        title: userBillTable.title,
        number: userBillTable.number,
        addTime: userBillTable.addTime,
      })
      .from(userBillTable)
      .where(sql`${userBillTable.uid} = ${uid} AND ${userBillTable.category} = 'exp'`)
      .orderBy(sql`${userBillTable.addTime} DESC`)
      .limit(limit)
      .offset((page - 1) * limit);
    return rows;
  }
}
