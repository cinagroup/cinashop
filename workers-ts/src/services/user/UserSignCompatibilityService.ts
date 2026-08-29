import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import {
  memberRight,
  systemConfig,
  systemSignReward,
  user as userTable,
  userBill,
  userSign,
} from "@/models/schema";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";
import { effectiveContinuousSignDays, signDayWindow } from "@/utils/sign";

const BUSINESS_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;
const MAX_PAGE_SIZE = 100;
const MAX_REWARD_RULES_PER_TYPE = 200;
const POSTGRES_INT_MAX = 2_147_483_647;
const SIGN_COMPAT_CONFIG_KEYS = [
  "sign_mode",
  "sign_give_point",
  "sign_give_exp",
  "member_func_status",
  "member_card_status",
  "sign_remind",
  "sign_status",
  "integral_effective_status",
  "integral_effective_time",
  "store_brokerage_statu",
] as const;

interface CalendarWindow {
  start: number;
  end: number;
  days: number;
  firstWeekday: number;
}

interface CompatConfig {
  signMode: number;
  basePoint: number;
  baseExp: number;
  memberFunctionEnabled: boolean;
  memberCardEnabled: boolean;
  signRemindSwitch: number;
  signStatus: number;
  integralEffectiveStatus: number;
  integralEffectiveTime: number;
  brokerageStatus: number;
}

type Account = Pick<typeof userTable.$inferSelect,
  | "uid"
  | "nickname"
  | "phone"
  | "nowMoney"
  | "integral"
  | "isPromoter"
  | "signNum"
  | "signRemind"
  | "isMoneyLevel"
  | "isEverLevel"
  | "overdueTime"
>;

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidateException(`${field}参数错误`);
  }
  return parsed;
}

function localDate(timestamp: number): Date {
  return new Date((timestamp + BUSINESS_OFFSET_SECONDS) * 1000);
}

function dateKey(timestamp: number): string {
  return localDate(timestamp).toISOString().slice(0, 10);
}

function monthKey(timestamp: number): string {
  return localDate(timestamp).toISOString().slice(0, 7);
}

function monthWindow(value: string | undefined, now = Math.floor(Date.now() / 1000)): CalendarWindow {
  const fallback = monthKey(now);
  const input = (value ?? "").trim() || fallback;
  // Legacy UniApp emits YYYY-M for January through September. PHP strtotime
  // accepts it, so normalize either one- or two-digit months here.
  const match = /^(\d{4})-(0?[1-9]|1[0-2])$/.exec(input);
  if (!match) throw new ValidateException("月份格式错误");
  const year = Number(match[1]);
  const month = Number(match[2]);
  // user_sign.add_time remains PostgreSQL int4; keep generated boundaries in
  // its representable Unix epoch until the shared schema is upgraded.
  if (year < 1970 || year > 2037) throw new ValidateException("月份格式错误");
  const start = Math.trunc(Date.UTC(year, month - 1, 1) / 1000) - BUSINESS_OFFSET_SECONDS;
  const end = Math.trunc(Date.UTC(year, month, 1) / 1000) - BUSINESS_OFFSET_SECONDS;
  return {
    start,
    end,
    days: Math.round((end - start) / DAY_SECONDS),
    firstWeekday: localDate(start).getUTCDay(),
  };
}

function currentWeekWindow(now = Math.floor(Date.now() / 1000)): CalendarWindow {
  const day = signDayWindow(now);
  const daysFromMonday = day.weekday === 0 ? 6 : day.weekday - 1;
  const start = day.todayStart - daysFromMonday * DAY_SECONDS;
  return { start, end: start + 7 * DAY_SECONDS, days: 7, firstWeekday: 1 };
}

function nonNegativeConfig(value: string | undefined, fallback: number): number {
  const parsed = parseConfigInteger(value, fallback);
  return parsed >= 0 && parsed <= 1_000_000 ? parsed : fallback;
}

function configIntegerWithPresence(
  values: Readonly<Record<string, string>>,
  key: string,
  missingFallback: number,
): number {
  return Object.hasOwn(values, key)
    ? parseConfigInteger(values[key], 0)
    : missingFallback;
}

async function loadConfig(db: DbClient): Promise<CompatConfig> {
  const rows = await db
    .select({ name: systemConfig.menuName, value: systemConfig.value })
    .from(systemConfig)
    .where(and(
      eq(systemConfig.isStore, 0),
      inArray(systemConfig.menuName, [...SIGN_COMPAT_CONFIG_KEYS]),
    ))
    .orderBy(asc(systemConfig.sort), asc(systemConfig.id));
  const values: Record<string, string> = {};
  for (const row of rows) values[row.name] = normalizeConfigScalar(row.value);
  const rawSignMode = configIntegerWithPresence(values, "sign_mode", 1);
  return {
    signMode: rawSignMode === 0 ? 0 : 1,
    basePoint: nonNegativeConfig(values.sign_give_point, 0),
    baseExp: nonNegativeConfig(values.sign_give_exp, 0),
    memberFunctionEnabled: configIntegerWithPresence(values, "member_func_status", 1) === 1,
    memberCardEnabled: configIntegerWithPresence(values, "member_card_status", 1) === 1,
    signRemindSwitch: parseConfigInteger(values.sign_remind, 0),
    signStatus: parseConfigInteger(values.sign_status, 0),
    integralEffectiveStatus: parseConfigInteger(values.integral_effective_status, 0),
    integralEffectiveTime: configIntegerWithPresence(values, "integral_effective_time", 3),
    brokerageStatus: parseConfigInteger(values.store_brokerage_statu, 0),
  };
}

async function displayRewardRules(db: DbClient) {
  const selectType = (type: number) => db
    .select({ type: systemSignReward.type, days: systemSignReward.days, point: systemSignReward.point })
    .from(systemSignReward)
    .where(eq(systemSignReward.type, type))
    .orderBy(asc(systemSignReward.days), asc(systemSignReward.id))
    .limit(MAX_REWARD_RULES_PER_TYPE);
  const [continuous, cumulative] = await Promise.all([selectType(0), selectType(1)]);
  return [...continuous, ...cumulative];
}

async function accountForUser(db: DbClient, uid: number): Promise<Account> {
  const rows = await db
    .select({
      uid: userTable.uid,
      nickname: userTable.nickname,
      phone: userTable.phone,
      nowMoney: userTable.nowMoney,
      integral: userTable.integral,
      isPromoter: userTable.isPromoter,
      signNum: userTable.signNum,
      signRemind: userTable.signRemind,
      isMoneyLevel: userTable.isMoneyLevel,
      isEverLevel: userTable.isEverLevel,
      overdueTime: userTable.overdueTime,
    })
    .from(userTable)
    .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
    .limit(1);
  if (!rows[0]) throw new NotFoundException("数据不存在");
  return rows[0];
}

async function signPointMultiplier(
  db: DbClient,
  account: Account,
  config: CompatConfig,
  now: number,
): Promise<number> {
  const activeSvip = account.isEverLevel > 0
    || (account.isMoneyLevel > 0 && account.overdueTime > now);
  if (!config.memberCardEnabled || !activeSvip) return 1;
  const rows = await db
    .select({ number: memberRight.number })
    .from(memberRight)
    .where(and(eq(memberRight.rightType, "sign"), eq(memberRight.status, 1)))
    .orderBy(asc(memberRight.id))
    .limit(1);
  const value = rows[0]?.number ?? 1;
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function nextRewardDays(current: number, rules: readonly { days: number }[]): number {
  const rule = rules.find((item) => item.days > current);
  return rule ? Math.max(1, rule.days - current) : 0;
}

function displayPoint(point: number, multiplier: number): number {
  const value = point * multiplier;
  if (!Number.isSafeInteger(value) || value < 0 || value > POSTGRES_INT_MAX) {
    throw new ValidateException("签到积分超出安全范围");
  }
  return value;
}

async function calendarData(
  db: DbClient,
  uid: number,
  account: Account,
  config: CompatConfig,
  window: CalendarWindow,
  multiplyPoints: boolean,
  now: number,
) {
  const today = signDayWindow(now);
  const [records, rules, totals, multiplier] = await Promise.all([
    db
      .select({ addTime: userSign.addTime })
      .from(userSign)
      .where(and(
        eq(userSign.uid, uid),
        gte(userSign.addTime, window.start),
        lt(userSign.addTime, window.end),
      )),
    displayRewardRules(db),
    db
      .select({
        cumulative: sql<number>`COUNT(*)::int`,
        today: sql<boolean>`COUNT(*) FILTER (
          WHERE ${userSign.addTime} >= ${today.todayStart}
            AND ${userSign.addTime} < ${today.tomorrowStart}
        ) > 0`,
        yesterday: sql<boolean>`COUNT(*) FILTER (
          WHERE ${userSign.addTime} >= ${today.yesterdayStart}
            AND ${userSign.addTime} < ${today.todayStart}
        ) > 0`,
      })
      .from(userSign)
      .where(eq(userSign.uid, uid)),
    multiplyPoints ? signPointMultiplier(db, account, config, now) : Promise.resolve(1),
  ]);
  const signedDates = new Set(records.map((row) => dateKey(row.addTime)));
  const continuousRules = rules.filter((rule) => rule.type === 0);
  const cumulativeRules = rules.filter((rule) => rule.type === 1);
  const cumulativeSignDays = totals[0]?.cumulative ?? 0;
  const signedToday = totals[0]?.today ?? false;
  const continuousSignDays = effectiveContinuousSignDays({
    currentDays: account.signNum,
    signedToday,
    signedYesterday: totals[0]?.yesterday ?? false,
    signMode: config.signMode,
    weekday: today.weekday,
    dayOfMonth: today.dayOfMonth,
  });
  const signList: Record<string, unknown>[] = [];
  for (let offset = 0; offset < window.days; offset++) {
    const timestamp = window.start + offset * DAY_SECONDS;
    const local = localDate(timestamp);
    const key = dateKey(timestamp);
    let point = config.basePoint;
    let days = 0;
    let signType = 0;
    if (timestamp >= today.todayStart) {
      // Use the actual distance from today, not the cell index inside this
      // window. A separately requested future month may start weeks later.
      const daysFromToday = Math.trunc((timestamp - today.todayStart) / DAY_SECONDS);
      const pendingSignOffset = daysFromToday + (signedToday ? 0 : 1);
      const continuous = continuousRules.find(
        (rule) => rule.days - continuousSignDays === pendingSignOffset,
      );
      if (continuous) {
        point = continuous.point;
        days = continuous.days;
        signType = 3;
      }
      const cumulative = cumulativeRules.find(
        (rule) => rule.days - cumulativeSignDays === pendingSignOffset,
      );
      // PHP's display loop applies cumulative after continuous, so it wins if
      // both milestones occupy the same calendar cell.
      if (cumulative) {
        point = cumulative.point;
        days = cumulative.days;
        signType = 4;
      }
    }
    signList.push({
      day: `${local.getUTCMonth() + 1}/${String(local.getUTCDate()).padStart(2, "0")}`,
      is_sign: signedDates.has(key),
      sign_day: key === dateKey(today.todayStart),
      type: config.basePoint === 0 && config.memberFunctionEnabled && config.baseExp > 0 ? 2 : 1,
      point: displayPoint(point, multiplier),
      days,
      sign_type: signType,
    });
  }
  return {
    signList,
    continuousSignDays,
    cumulativeSignDays,
    // Correct the PHP precedence bug and expose stable integer day counts.
    nextContinuousDays: nextRewardDays(continuousSignDays, continuousRules),
    nextCumulativeDays: nextRewardDays(cumulativeSignDays, cumulativeRules),
    checkSign: signedToday,
    multiplier,
  };
}

function legacySignRow(row: typeof userSign.$inferSelect) {
  return {
    id: row.id,
    uid: row.uid,
    title: row.title,
    number: row.number,
    balance: row.balance,
    exp_num: row.expNum,
    exp_balance: row.expBalance,
    add_time: row.addTime ? dateKey(row.addTime) : "",
  };
}

function periodWindow(typeValue: number, now = Math.floor(Date.now() / 1000)) {
  const nowLocal = localDate(now);
  const year = nowLocal.getUTCFullYear();
  const month = nowLocal.getUTCMonth();
  const type = typeValue === 1 || typeValue === 2 ? typeValue : 3;
  let previousStartUtc: number;
  let currentStartUtc: number;
  let clearEndUtc: number;
  if (type === 1) {
    previousStartUtc = Date.UTC(year, month - 1, 1);
    currentStartUtc = Date.UTC(year, month, 1);
    clearEndUtc = Date.UTC(year, month + 1, 0);
  } else if (type === 2) {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    previousStartUtc = Date.UTC(year, quarterStartMonth - 3, 1);
    currentStartUtc = Date.UTC(year, quarterStartMonth, 1);
    clearEndUtc = Date.UTC(year, quarterStartMonth + 3, 0);
  } else {
    previousStartUtc = Date.UTC(year - 1, 0, 1);
    currentStartUtc = Date.UTC(year, 0, 1);
    clearEndUtc = Date.UTC(year, 11, 31);
  }
  return {
    previousStart: Math.trunc(previousStartUtc / 1000) - BUSINESS_OFFSET_SECONDS,
    currentStart: Math.trunc(currentStartUtc / 1000) - BUSINESS_OFFSET_SECONDS,
    clearAt: Math.trunc(clearEndUtc / 1000) - BUSINESS_OFFSET_SECONDS,
  };
}

function wholeNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  const truncated = Math.trunc(parsed);
  if (!Number.isSafeInteger(truncated)) {
    throw new ValidateException("积分统计超出安全范围");
  }
  return truncated;
}

export class UserSignCompatibilityService {
  constructor(private readonly container: Container) {}

  /**
   * Legacy homepage widget contract (`/api/diy/sign`).  It intentionally does
   * not reuse `config()`: the old widget is always a Monday-Sunday grid, keeps
   * the base reward (no SVIP multiplier/milestone overlay), and permits uid=0.
   */
  async homeDiy(uid: number) {
    const safeUid = Number.isSafeInteger(uid) && uid > 0 ? uid : 0;
    const now = Math.floor(Date.now() / 1_000);
    const window = currentWeekWindow(now);
    const today = signDayWindow(now);
    const [config, records, rewards, todayRows] = await Promise.all([
      loadConfig(this.container.db),
      safeUid > 0
        ? this.container.db
          .select({ addTime: userSign.addTime })
          .from(userSign)
          .where(and(
            eq(userSign.uid, safeUid),
            gte(userSign.addTime, window.start),
            lt(userSign.addTime, window.end),
          ))
        : Promise.resolve([]),
      this.container.db
        .select({
          id: systemSignReward.id,
          type: systemSignReward.type,
          days: systemSignReward.days,
          point: systemSignReward.point,
          exp: systemSignReward.exp,
        })
        .from(systemSignReward)
        .where(eq(systemSignReward.type, 0))
        .orderBy(asc(systemSignReward.days), asc(systemSignReward.id))
        .limit(1),
      safeUid > 0
        ? this.container.db
          .select({ value: sql<boolean>`COUNT(*) > 0` })
          .from(userSign)
          .where(and(
            eq(userSign.uid, safeUid),
            gte(userSign.addTime, today.todayStart),
            lt(userSign.addTime, today.tomorrowStart),
          ))
        : Promise.resolve([]),
    ]);
    const signed = new Set(records.map((row) => dateKey(row.addTime)));
    const todayKey = dateKey(today.todayStart);
    const type = config.basePoint === 0 && config.memberFunctionEnabled && config.baseExp > 0 ? 2 : 1;
    const signList = Array.from({ length: 7 }, (_, offset) => {
      const timestamp = window.start + offset * DAY_SECONDS;
      const local = localDate(timestamp);
      const key = dateKey(timestamp);
      return {
        day: `${local.getUTCMonth() + 1}/${String(local.getUTCDate()).padStart(2, "0")}`,
        is_sign: signed.has(key),
        sign_day: key === todayKey,
        type,
        point: config.basePoint,
      };
    });
    return {
      signList: [signList],
      nextContinuousSignRewardList: rewards,
      checkSign: todayRows[0]?.value ?? false,
      signStatus: config.signStatus,
      sign_give_point: config.basePoint,
    };
  }

  async config(uid: number) {
    const now = Math.floor(Date.now() / 1000);
    const [account, config] = await Promise.all([
      accountForUser(this.container.db, uid),
      loadConfig(this.container.db),
    ]);
    const window = config.signMode === 1 ? currentWeekWindow(now) : monthWindow(undefined, now);
    const data = await calendarData(this.container.db, uid, account, config, window, true, now);
    const { multiplier, ...compatData } = data;
    return {
      ...compatData,
      signMode: config.signMode,
      signRemindStatus: account.signRemind,
      signRemindSwitch: config.signRemindSwitch,
      signStatus: config.signStatus,
      signData: {
        sign_point: displayPoint(config.basePoint, multiplier),
        sign_exp: config.memberFunctionEnabled ? config.baseExp : 0,
      },
    };
  }

  async calendar(uid: number, monthValue: string | undefined) {
    const now = Math.floor(Date.now() / 1000);
    const [account, config] = await Promise.all([
      accountForUser(this.container.db, uid),
      loadConfig(this.container.db),
    ]);
    const window = monthWindow(monthValue, now);
    const data = await calendarData(this.container.db, uid, account, config, window, false, now);
    return {
      today: dateKey(signDayWindow(now).todayStart),
      w: String(window.firstWeekday),
      signList: data.signList,
      continuousSignDays: data.continuousSignDays,
      cumulativeSignDays: data.cumulativeSignDays,
      nextContinuousDays: data.nextContinuousDays,
      nextCumulativeDays: data.nextCumulativeDays,
      checkSign: data.checkSign,
    };
  }

  async list(uid: number, pageValue: unknown, limitValue: unknown) {
    const limit = boundedInteger(limitValue, 0, 0, MAX_PAGE_SIZE, "每页数量");
    if (limit === 0) return [];
    const page = boundedInteger(pageValue, 1, 1, 1_000_000, "页码");
    const rows = await this.container.db
      .select()
      .from(userSign)
      .where(eq(userSign.uid, uid))
      .orderBy(desc(userSign.id))
      .limit(limit)
      .offset((page - 1) * limit);
    return rows.map(legacySignRow);
  }

  async month(uid: number, pageValue: unknown, limitValue: unknown) {
    const page = boundedInteger(pageValue, 1, 1, 1_000_000, "页码");
    const limit = boundedInteger(limitValue, 8, 1, MAX_PAGE_SIZE, "每页数量");
    const expression = sql<string>`to_char(
      to_timestamp(${userSign.addTime}) AT TIME ZONE 'Asia/Shanghai',
      'YYYY-MM'
    )`;
    const latestExpression = sql<number>`MAX(${userSign.addTime})::int`;
    const groups = await this.container.db
      .select({ month: expression, latest: latestExpression })
      .from(userSign)
      .where(eq(userSign.uid, uid))
      .groupBy(expression)
      .orderBy(desc(latestExpression))
      .limit(limit)
      .offset((page - 1) * limit);
    if (!groups.length) return [];
    const months = groups.map((group) => group.month);
    const selected = new Set(months);
    const oldest = monthWindow(months.at(-1));
    const newest = monthWindow(months[0]);
    const rows = await this.container.db
      .select()
      .from(userSign)
      .where(and(
        eq(userSign.uid, uid),
        gte(userSign.addTime, oldest.start),
        lt(userSign.addTime, newest.end),
      ))
      .orderBy(desc(userSign.id));
    return months.map((month) => ({
      month,
      list: rows
        .filter((row) => selected.has(monthKey(row.addTime)) && monthKey(row.addTime) === month)
        .map((row) => ({
          add_time: dateKey(row.addTime),
          title: row.title,
          number: row.number,
          exp_num: row.expNum,
          id: row.id,
          uid: row.uid,
        })),
    }));
  }

  async user(uid: number, flags: { sign: boolean; integral: boolean; all: boolean }) {
    const now = Math.floor(Date.now() / 1000);
    const day = signDayWindow(now);
    const [account, config, signStats] = await Promise.all([
      accountForUser(this.container.db, uid),
      loadConfig(this.container.db),
      this.container.db
        .select({
          total: sql<number>`COUNT(*)::int`,
          today: sql<boolean>`COUNT(*) FILTER (
            WHERE ${userSign.addTime} >= ${day.todayStart}
              AND ${userSign.addTime} < ${day.tomorrowStart}
          ) > 0`,
          yesterday: sql<boolean>`COUNT(*) FILTER (
            WHERE ${userSign.addTime} >= ${day.yesterdayStart}
              AND ${userSign.addTime} < ${day.todayStart}
          ) > 0`,
        })
        .from(userSign)
        .where(eq(userSign.uid, uid)),
    ]);
    let clearIntegral = 0;
    let clearTime = 0;
    let clearEnd = "";
    if (config.integralEffectiveStatus) {
      const period = periodWindow(config.integralEffectiveTime, now);
      const rows = await this.container.db
        .select({
          income: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (
            WHERE ${userBill.pm} = 1
          ), 0)::text`,
          expense: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (
            WHERE ${userBill.pm} = 0
          ), 0)::text`,
        })
        .from(userBill)
        .where(and(
          eq(userBill.uid, uid),
          eq(userBill.category, "integral"),
          eq(userBill.status, 1),
          gte(userBill.addTime, period.previousStart),
          lt(userBill.addTime, period.currentStart),
        ));
      clearIntegral = Math.min(
        account.integral,
        Math.max(0, wholeNumber(rows[0]?.income) - wholeNumber(rows[0]?.expense)),
      );
      clearTime = period.clearAt;
      clearEnd = dateKey(period.clearAt);
    }
    const result: Record<string, unknown> = {
      uid: account.uid,
      nickname: account.nickname,
      phone: account.phone,
      now_money: account.nowMoney,
      integral: account.integral,
      is_promoter: account.isPromoter || config.brokerageStatus === 2,
      clear_integral: clearIntegral,
      clear_time: clearTime,
    };
    const stats = signStats[0] ?? { total: 0, today: false, yesterday: false };
    if (flags.sign || flags.all) {
      result.sum_sgin_day = stats.total;
      result.is_day_sgin = stats.today;
      result.is_YesterDay_sgin = stats.yesterday;
      if (!stats.today && !stats.yesterday) result.sign_num = 0;
    }
    if (flags.integral || flags.all) {
      const rows = await this.container.db
        .select({
          income: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (
            WHERE ${userBill.pm} = 1
          ), 0)::text`,
          expense: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (
            WHERE ${userBill.pm} = 0
          ), 0)::text`,
          todayIncome: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (
            WHERE ${userBill.pm} = 1
              AND ${userBill.addTime} >= ${day.todayStart}
              AND ${userBill.addTime} < ${day.tomorrowStart}
          ), 0)::text`,
          frozen: sql<string>`COALESCE(SUM(${userBill.number}) FILTER (
            WHERE ${userBill.frozenTime} > ${now}
          ), 0)::text`,
        })
        .from(userBill)
        .where(and(
          eq(userBill.uid, uid),
          eq(userBill.category, "integral"),
          eq(userBill.status, 1),
        ));
      result.sum_integral = wholeNumber(rows[0]?.income);
      result.deduction_integral = wholeNumber(rows[0]?.expense);
      result.today_integral = wholeNumber(rows[0]?.todayIncome);
      result.frozen_integral = wholeNumber(rows[0]?.frozen);
      result.integral_effective_status = config.integralEffectiveStatus;
      result.clear_end = clearEnd;
    }
    return result;
  }

  async setRemind(uid: number, statusValue: unknown): Promise<void> {
    const status = boundedInteger(statusValue, -1, 0, 1, "提醒状态");
    const rows = await this.container.db
      .update(userTable)
      .set({ signRemind: status })
      .where(and(
        eq(userTable.uid, uid),
        eq(userTable.isDel, 0),
        eq(userTable.status, 1),
      ))
      .returning({ uid: userTable.uid });
    if (!rows[0]) throw new NotFoundException("用户不存在");
  }
}
