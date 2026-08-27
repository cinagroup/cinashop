/**
 * 用户中心 Service (M5)
 * 地址 + 收藏 + 签到
 *
 * 对应 PHP:
 *   - UserAddressServices (editAddress/setDefault)
 *   - UserRelationServices (productRelation 收藏)
 *   - UserSignServices (sign 签到)
 */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  memberRight,
  systemConfig,
  systemSignReward,
  user as userTable,
  userBill,
  userSign,
} from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import { detectUserLevel } from "@/services/order/OrderRewardService";
import {
  calculateSignReward,
  type SignRewardRule,
} from "@/services/system/SystemSignRewardService";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import { ValidateException, NotFoundException } from "@/utils/errors";
import { nextContinuousSignDays, signDayWindow, type SignDayWindow } from "@/utils/sign";

const SIGN_LOCK_NAMESPACE = 731_623;
const SIGN_CONFIG_KEYS = [
  "sign_status",
  "sign_in_switch",
  "sign_mode",
  "sign_give_point",
  "sign_in_integral",
  "sign_give_exp",
  "member_func_status",
  "member_card_status",
] as const;

interface SignStats {
  signedToday: boolean;
  signedYesterday: boolean;
  cumulativeDays: number;
}

interface SignConfig {
  enabled: boolean;
  signMode: number;
  basePoint: number;
  baseExp: number;
  memberFunctionEnabled: boolean;
  memberCardEnabled: boolean;
}

function assertUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ValidateException("用户ID错误");
}

function pickConfig(
  values: Readonly<Record<string, string>>,
  primary: string,
  alias?: string,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(values, primary)) return values[primary];
  return alias && Object.prototype.hasOwnProperty.call(values, alias) ? values[alias] : undefined;
}

function nonNegativeConfig(value: string | undefined, fallback: number): number {
  const parsed = parseConfigInteger(value, fallback);
  return parsed >= 0 && parsed <= 1_000_000 ? parsed : fallback;
}

function decimalToHundredths(value: string | number): number {
  const normalized = normalizeConfigScalar(String(value));
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("用户经验格式无效");
  const [whole, fraction = ""] = normalized.split(".");
  const units = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(units)) throw new Error("用户经验超出安全范围");
  return units;
}

function hundredthsToDecimal(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("用户经验超出安全范围");
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

async function getSignStats(db: DbClient, uid: number, window: SignDayWindow): Promise<SignStats> {
  const rows = await db
    .select({
      signedToday: sql<boolean>`COUNT(*) FILTER (
        WHERE ${userSign.addTime} >= ${window.todayStart}
          AND ${userSign.addTime} < ${window.tomorrowStart}
      ) > 0`,
      signedYesterday: sql<boolean>`COUNT(*) FILTER (
        WHERE ${userSign.addTime} >= ${window.yesterdayStart}
          AND ${userSign.addTime} < ${window.todayStart}
      ) > 0`,
      cumulativeDays: sql<number>`COUNT(*)::int`,
    })
    .from(userSign)
    .where(eq(userSign.uid, uid));
  return rows[0] ?? { signedToday: false, signedYesterday: false, cumulativeDays: 0 };
}

async function loadSignConfig(db: DbClient): Promise<SignConfig> {
  const rows = await db
    .select({ menuName: systemConfig.menuName, value: systemConfig.value })
    .from(systemConfig)
    .where(
      and(
        eq(systemConfig.isStore, 0),
        inArray(systemConfig.menuName, [...SIGN_CONFIG_KEYS]),
      ),
    )
    .orderBy(asc(systemConfig.id));
  const values: Record<string, string> = {};
  for (const row of rows) values[row.menuName] = row.value;
  const rawMode = parseConfigInteger(values.sign_mode, -1);
  return {
    enabled: parseConfigInteger(pickConfig(values, "sign_status", "sign_in_switch"), 1) !== 0,
    signMode: rawMode === 0 || rawMode === 1 ? rawMode : -1,
    basePoint: nonNegativeConfig(
      pickConfig(values, "sign_give_point", "sign_in_integral"),
      0,
    ),
    baseExp: nonNegativeConfig(values.sign_give_exp, 0),
    memberFunctionEnabled: parseConfigInteger(values.member_func_status, 1) === 1,
    memberCardEnabled: parseConfigInteger(values.member_card_status, 1) === 1,
  };
}

async function calculateConfiguredSignReward(
  db: DbClient,
  account: Pick<typeof userTable.$inferSelect, "isMoneyLevel" | "levelStatus">,
  config: SignConfig,
  continuousDays: number,
  cumulativeDays: number,
) {
  const rules = await db
    .select()
    .from(systemSignReward)
    .where(
      or(
        and(eq(systemSignReward.type, 0), eq(systemSignReward.days, continuousDays)),
        and(eq(systemSignReward.type, 1), eq(systemSignReward.days, cumulativeDays)),
      ),
    )
    .orderBy(asc(systemSignReward.id));
  let pointMultiplier = 1;
  if (config.memberCardEnabled && account.isMoneyLevel > 0) {
    const rights = await db
      .select({ number: memberRight.number })
      .from(memberRight)
      .where(and(eq(memberRight.rightType, "sign"), eq(memberRight.status, 1)))
      .orderBy(asc(memberRight.id))
      .limit(1);
    if (rights[0]?.number && rights[0].number > 0) pointMultiplier = rights[0].number;
  }
  return calculateSignReward({
    basePoint: config.basePoint,
    baseExp: config.baseExp,
    continuousDays,
    cumulativeDays,
    rules: rules as SignRewardRule[],
    memberFunctionEnabled: config.memberFunctionEnabled,
    levelActive: account.levelStatus === 1,
    pointMultiplier,
  });
}

export class UserCenterService {
  constructor(private readonly container: Container) {}

  // ─── 地址 ─────────────────────────────────────────────────

  /** 地址列表 */
  async addressList(uid: number) {
    return this.container.userAddressDao.listByUid(uid);
  }

  /** 默认地址 */
  async addressDefault(uid: number) {
    return this.container.userAddressDao.getDefault(uid);
  }

  /** 新增/编辑地址 (对应 PHP editAddress) */
  async addressSave(uid: number, params: {
    id?: number;
    realName: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
    isDefault?: number;
  }) {
    if (!params.realName || !params.phone || !params.detail) {
      throw new ValidateException("收货人、电话、详细地址不能为空");
    }
    const c = this.container;
    if (params.id) {
      // 编辑
      const existing = await c.userAddressDao.get(params.id);
      if (!existing || existing.uid !== uid || existing.isDel) {
        throw new NotFoundException("地址不存在");
      }
      await c.userAddressDao.update(params.id, {
        realName: params.realName,
        phone: params.phone,
        province: params.province,
        city: params.city,
        district: params.district,
        detail: params.detail,
      });
      if (params.isDefault) await c.userAddressDao.setDefault(uid, params.id);
      return params.id;
    }
    // 新增
    const row = await c.userAddressDao.save({
      uid,
      realName: params.realName,
      phone: params.phone,
      province: params.province,
      city: params.city,
      district: params.district,
      detail: params.detail,
      isDefault: params.isDefault ?? 0,
      addTime: Math.floor(Date.now() / 1000),
    });
    if (params.isDefault) await c.userAddressDao.setDefault(uid, row.id);
    return row.id;
  }

  /** 删除地址 (软删) */
  async addressDel(uid: number, id: number) {
    const c = this.container;
    const addr = await c.userAddressDao.get(id);
    if (!addr || addr.uid !== uid) throw new NotFoundException("地址不存在");
    await c.userAddressDao.update(id, { isDel: 1 });
  }

  // ─── 收藏 ─────────────────────────────────────────────────

  /** 收藏商品 (对应 PHP productRelation) */
  async collectAdd(uid: number, productIds: number[]): Promise<number> {
    if (!productIds.length) throw new ValidateException("请选择商品");
    return this.container.userRelationDao.addCollect(uid, productIds);
  }

  /** 取消收藏 */
  async collectDel(uid: number, productIds: number[]): Promise<void> {
    await this.container.userRelationDao.removeCollect(uid, productIds);
  }

  /** 收藏列表 (返回商品 ID, 前端再查商品详情) */
  async collectList(uid: number): Promise<number[]> {
    return this.container.userRelationDao.getCollectIds(uid);
  }

  /** 是否收藏 */
  async isCollected(uid: number, productId: number): Promise<boolean> {
    return this.container.userRelationDao.isCollected(uid, productId);
  }

  // ─── 签到 ─────────────────────────────────────────────────

  /**
   * 签到 (对应 PHP UserSignServices::sign)
   *
   * 逻辑:
   *   1. 今日已签到 → 拒绝
   *   2. 昨日未签到 → sign_num 重置为 0
   *   3. sign_num++
   *   4. 基础积分 + 连续/累计奖励 (从 system_config 读)
   *   5. 记 sign 流水 + 加积分
   */
  async sign(uid: number): Promise<{
    point: number;
    exp: number;
    sign_point: number;
    sign_exp: number;
    continuousDays: number;
    cumulativeDays: number;
  }> {
    assertUid(uid);
    const now = Math.floor(Date.now() / 1000);
    const window = signDayWindow(now);
    return withTx(this.container, async (tx) => {
      // The source has no one-sign-per-day unique key. Serialize per user and
      // then lock the account row so concurrent requests cannot double-award.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SIGN_LOCK_NAMESPACE}, ${uid})`);
      const accounts = await tx
        .select()
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.isDel, 0)))
        .limit(1)
        .for("update");
      const account = accounts[0];
      if (!account) throw new NotFoundException("用户不存在");

      const stats = await getSignStats(tx, uid, window);
      if (stats.signedToday) throw new ValidateException("今日已签到");
      const config = await loadSignConfig(tx);
      if (!config.enabled) throw new ValidateException("签到功能未开启");
      const continuousDays = nextContinuousSignDays({
        currentDays: account.signNum,
        signedYesterday: stats.signedYesterday,
        signMode: config.signMode,
        weekday: window.weekday,
        dayOfMonth: window.dayOfMonth,
      });
      // The PHP service queried the pre-insert count and was off by one. Use
      // the day being awarded so a configured day-1 cumulative reward fires.
      const cumulativeDays = stats.cumulativeDays + 1;
      const reward = await calculateConfiguredSignReward(
        tx,
        account,
        config,
        continuousDays,
        cumulativeDays,
      );
      const nextIntegral = account.integral + reward.point;
      if (!Number.isSafeInteger(nextIntegral)) throw new ValidateException("用户积分超出安全范围");
      const currentExp = decimalToHundredths(account.exp);
      const nextExp = currentExp + reward.exp * 100;
      if (!Number.isSafeInteger(nextExp)) throw new ValidateException("用户经验超出安全范围");
      const expBalance = hundredthsToDecimal(nextExp);
      const title = "签到奖励";

      await tx.insert(userSign).values({
        uid,
        title,
        number: reward.point,
        balance: nextIntegral,
        expNum: reward.exp,
        expBalance: Math.trunc(nextExp / 100),
        addTime: now,
      });
      const billRows: Array<typeof userBill.$inferInsert> = [];
      if (reward.point > 0) {
        billRows.push({
          uid,
          linkId: "0",
          pm: 1,
          title,
          category: "integral",
          type: "sign",
          eventKey: "sign",
          number: String(reward.point),
          balance: String(nextIntegral),
          mark: title,
          status: 1,
          addTime: now,
        });
      }
      if (reward.exp > 0) {
        billRows.push({
          uid,
          linkId: "0",
          pm: 1,
          title,
          category: "exp",
          type: "sign",
          eventKey: "sign",
          number: String(reward.exp),
          balance: expBalance,
          mark: title,
          status: 1,
          addTime: now,
        });
      }
      if (billRows.length) await tx.insert(userBill).values(billRows);
      await tx
        .update(userTable)
        .set(reward.exp > 0
          ? { integral: nextIntegral, exp: expBalance, signNum: continuousDays }
          : { integral: nextIntegral, signNum: continuousDays })
        .where(eq(userTable.uid, uid));
      if (reward.exp > 0) {
        await detectUserLevel(tx, uid, account.nickname, nextExp, now);
      }
      return {
        point: reward.point,
        exp: reward.exp,
        sign_point: reward.point,
        sign_exp: reward.exp,
        continuousDays,
        cumulativeDays,
      };
    });
  }

  /** 签到状态 (今日是否签、连续天数) */
  async signStatus(uid: number): Promise<{
    signedToday: boolean;
    continuousDays: number;
    cumulativeDays: number;
    integral: number;
    exp: number;
    enabled: boolean;
  }> {
    assertUid(uid);
    const account = await this.container.userDao.findForAuth(uid);
    if (!account) throw new NotFoundException("用户不存在");
    const window = signDayWindow();
    const [stats, config] = await Promise.all([
      getSignStats(this.container.db, uid, window),
      loadSignConfig(this.container.db),
    ]);
    const continuousDays = stats.signedToday
      ? account.signNum
      : nextContinuousSignDays({
          currentDays: account.signNum,
          signedYesterday: stats.signedYesterday,
          signMode: config.signMode,
          weekday: window.weekday,
          dayOfMonth: window.dayOfMonth,
        });
    const cumulativeDays = stats.signedToday
      ? stats.cumulativeDays
      : stats.cumulativeDays + 1;
    const reward = await calculateConfiguredSignReward(
      this.container.db,
      account,
      config,
      continuousDays,
      cumulativeDays,
    );
    return {
      signedToday: stats.signedToday,
      continuousDays: account.signNum,
      cumulativeDays: stats.cumulativeDays,
      integral: reward.point,
      exp: reward.exp,
      enabled: config.enabled,
    };
  }
}
