import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import {
  luckLottery,
  luckLotteryEntitlement,
  luckLotteryRecord,
  luckPrize,
  storeCouponIssue,
  storeCouponIssueUser,
  storeCouponUser,
  user as userTable,
  userBill,
  userLabelRelation,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { calculateMembershipExpiry } from "@/services/user/PaidMembershipService";
import { detectUserLevel } from "@/services/order/OrderRewardService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const TICKET_TTL_SECONDS = 120;
const CHINA_OFFSET_SECONDS = 8 * 60 * 60;
const AUTO_RECEIVE_TYPES = new Set([1, 2, 3, 5, 7, 9]);

type LotteryRow = typeof luckLottery.$inferSelect;
type PrizeRow = typeof luckPrize.$inferSelect;
type UserRow = typeof userTable.$inferSelect;
type CouponIssueRow = typeof storeCouponIssue.$inferSelect;

export interface LotteryPrizeSnapshot {
  id: number;
  type: number;
  lottery_id: number;
  name: string;
  prompt: string;
  image: string;
  chance: number;
  total: number;
  coupon_id: number;
  product_id: number;
  unique: string;
  num: string;
  sort: number;
  status: number;
  is_del: number;
  add_time: number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidateException(`${label}参数错误`);
  return parsed;
}

function safePage(value: unknown, fallback = 1): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIdList(value: string | null): number[] {
  if (!value) return [];
  let parsed: unknown = value;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value.split(",");
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toHundredths(value: string | number, label: string): number {
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new ValidateException(`${label}格式错误`);
  const [whole, fraction = ""] = normalized.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw new ValidateException(`${label}超出支持范围`);
  return result;
}

function fromHundredths(value: number): string {
  return `${Math.trunc(value / 100)}.${String(Math.abs(value % 100)).padStart(2, "0")}`;
}

function startOfChinaDay(now: number): number {
  return Math.floor((now + CHINA_OFFSET_SECONDS) / 86_400) * 86_400 - CHINA_OFFSET_SECONDS;
}

function snapshot(prize: PrizeRow): LotteryPrizeSnapshot {
  return {
    id: prize.id,
    type: prize.type,
    lottery_id: prize.lotteryId,
    name: prize.name,
    prompt: prize.prompt,
    image: prize.image,
    chance: prize.chance,
    total: prize.total,
    coupon_id: prize.couponId,
    product_id: prize.productId,
    unique: prize.unique,
    num: prize.num,
    sort: prize.sort,
    status: prize.status,
    is_del: prize.isDel,
    add_time: prize.addTime,
  };
}

function publicPrize(prize: PrizeRow | LotteryPrizeSnapshot) {
  const lotteryId = "lotteryId" in prize ? prize.lotteryId : prize.lottery_id;
  return {
    id: prize.id,
    type: prize.type,
    lottery_id: lotteryId,
    name: prize.name,
    prompt: prize.prompt,
    image: prize.image,
  };
}

function randomBelow(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x1_0000_0000) {
    throw new Error("抽奖权重超出安全范围");
  }
  const range = 0x1_0000_0000;
  const ceiling = range - (range % maxExclusive);
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= ceiling);
  return buffer[0] % maxExclusive;
}

/** Deterministic value injection is only for unit tests; production uses Web Crypto. */
export function selectWeightedPrize(
  prizes: PrizeRow[],
  injectedValue?: number,
): PrizeRow | null {
  const active = prizes.filter((prize) => prize.status === 1 && prize.isDel === 0 && prize.chance > 0);
  const total = active.reduce((sum, prize) => sum + prize.chance, 0);
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const value = injectedValue === undefined ? randomBelow(total) : injectedValue;
  if (!Number.isSafeInteger(value) || value < 0 || value >= total) {
    throw new Error("测试抽奖值超出权重范围");
  }
  let cursor = 0;
  for (const prize of active) {
    cursor += prize.chance;
    if (value < cursor) return prize;
  }
  return null;
}

async function activeLottery(db: DbClient, factor: number, now: number): Promise<LotteryRow | null> {
  const rows = await db
    .select()
    .from(luckLottery)
    .where(
      and(
        eq(luckLottery.factor, factor),
        eq(luckLottery.status, 1),
        eq(luckLottery.isDel, 0),
        lte(luckLottery.startTime, now),
        gte(luckLottery.endTime, now),
      ),
    )
    .orderBy(desc(luckLottery.id))
    .limit(1);
  return rows[0] ?? null;
}

async function assertUserEligible(db: DbClient, account: UserRow, lottery: LotteryRow): Promise<void> {
  if (lottery.attendsUser !== 2) return;
  const levels = parseIdList(lottery.userLevel);
  if (levels.length && !levels.includes(account.level)) {
    throw new ValidateException("当前用户等级不能参与该活动");
  }
  const labels = parseIdList(lottery.userLabel);
  if (labels.length) {
    const assigned = await db
      .select({ labelId: userLabelRelation.labelId })
      .from(userLabelRelation)
      .where(
        and(
          eq(userLabelRelation.uid, account.uid),
          eq(userLabelRelation.type, 0),
          eq(userLabelRelation.relationId, 0),
          inArray(userLabelRelation.labelId, labels),
        ),
      )
      .limit(1);
    if (!assigned[0]) throw new ValidateException("当前用户标签不能参与该活动");
  }
  if (lottery.isSvip === 1 && account.isMoneyLevel <= 0) {
    throw new ValidateException("该活动仅限付费会员参与");
  }
  if (lottery.isSvip === 0 && account.isMoneyLevel > 0) {
    throw new ValidateException("付费会员不能参与该活动");
  }
}

async function entitlementSummary(db: DbClient, uid: number, factor: number, now: number) {
  const rows = await db
    .select({
      remaining: sql<number>`COALESCE(SUM(${luckLotteryEntitlement.remaining}), 0)::int`,
      expiresAt: sql<number>`COALESCE(MAX(${luckLotteryEntitlement.expiresAt}), 0)::int`,
    })
    .from(luckLotteryEntitlement)
    .where(
      and(
        eq(luckLotteryEntitlement.uid, uid),
        eq(luckLotteryEntitlement.factor, factor),
        gt(luckLotteryEntitlement.remaining, 0),
        gt(luckLotteryEntitlement.expiresAt, now),
      ),
    );
  return rows[0] ?? { remaining: 0, expiresAt: 0 };
}

async function drawCounts(db: DbClient, uid: number, lotteryId: number, now: number) {
  const rows = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      today: sql<number>`COUNT(*) FILTER (WHERE ${luckLotteryRecord.addTime} >= ${startOfChinaDay(now)})::int`,
    })
    .from(luckLotteryRecord)
    .where(and(eq(luckLotteryRecord.uid, uid), eq(luckLotteryRecord.lotteryId, lotteryId)));
  return rows[0] ?? { total: 0, today: 0 };
}

async function availableDraws(
  db: DbClient,
  account: UserRow,
  lottery: LotteryRow,
  now: number,
): Promise<{ lotteryNum: number; cacheTime: number }> {
  const factorNum = Math.max(1, lottery.factorNum);
  switch (lottery.factor) {
    case 1:
      return { lotteryNum: Math.floor(account.integral / factorNum), cacheTime: 0 };
    case 2:
      return {
        lotteryNum: Math.floor(toHundredths(account.nowMoney, "用户余额") / (factorNum * 100)),
        cacheTime: 0,
      };
    case 3:
    case 4: {
      const summary = await entitlementSummary(db, account.uid, lottery.factor, now);
      return { lotteryNum: summary.remaining, cacheTime: summary.expiresAt };
    }
    case 5:
      return { lotteryNum: Math.max(0, account.spreadLottery), cacheTime: 0 };
    default:
      throw new ValidateException("暂未有该类型活动");
  }
}

export async function grantLotteryEntitlement(
  tx: DbClient,
  input: {
    uid: number;
    factor: 3 | 4;
    sourceType: "order" | "comment";
    sourceId: number | string;
    now?: number;
  },
): Promise<{ granted: boolean; activityId: number; amount: number; expiresAt: number }> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const lottery = await activeLottery(tx, input.factor, now);
  if (!lottery || lottery.factorNum <= 0) {
    return { granted: false, activityId: 0, amount: 0, expiresAt: 0 };
  }
  const sourceId = String(input.sourceId);
  if (!sourceId || sourceId.length > 64) throw new Error("抽奖权益来源标识无效");
  const sourceKey = `${input.sourceType}:${sourceId}`;
  const expiresAt = now + TICKET_TTL_SECONDS;
  const inserted = await tx
    .insert(luckLotteryEntitlement)
    .values({
      uid: input.uid,
      factor: input.factor,
      sourceType: input.sourceType,
      sourceId,
      sourceKey,
      amount: lottery.factorNum,
      remaining: lottery.factorNum,
      expiresAt,
      addTime: now,
      updateTime: now,
    })
    .onConflictDoNothing({ target: luckLotteryEntitlement.sourceKey })
    .returning({ id: luckLotteryEntitlement.id });
  return {
    granted: Boolean(inserted[0]),
    activityId: lottery.id,
    amount: lottery.factorNum,
    expiresAt,
  };
}

export function shouldGrantReferralChance(
  referralCount: number,
  spreadNum: number,
  lotteryNum: number,
): boolean {
  if (
    !Number.isSafeInteger(referralCount) || referralCount <= 0 ||
    !Number.isSafeInteger(spreadNum) || spreadNum <= 0 ||
    !Number.isSafeInteger(lotteryNum) || lotteryNum <= 0
  ) return false;
  // The relation has already been inserted, so this is the 1-based referral
  // count. Grant the final partial increment and clamp it to the configured cap.
  return referralCount <= Math.ceil(lotteryNum / spreadNum);
}

/** Apply the source referral cap after a new permanent spread relation is inserted. */
export async function grantReferralLotteryChance(
  tx: DbClient,
  spreadUid: number,
  now: number,
): Promise<boolean> {
  const lottery = await activeLottery(tx, 5, now);
  if (!lottery || lottery.spreadNum <= 0 || lottery.lotteryNum <= 0) return false;
  const timeCondition = lottery.lotteryNumTerm === 1
    ? gte(userTable.spreadTime, startOfChinaDay(now))
    : undefined;
  const countRows = await tx
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(userTable)
    .where(
      and(
        eq(userTable.spreadUid, spreadUid),
        eq(userTable.isDel, 0),
        timeCondition,
      ),
    );
  const referralCount = countRows[0]?.count ?? 0;
  if (!shouldGrantReferralChance(referralCount, lottery.spreadNum, lottery.lotteryNum)) return false;
  const updated = await tx
    .update(userTable)
    .set({
      spreadLottery: sql`LEAST(${lottery.lotteryNum}, ${userTable.spreadLottery} + ${lottery.spreadNum})`,
    })
    .where(and(eq(userTable.uid, spreadUid), sql`${userTable.spreadLottery} < ${lottery.lotteryNum}`))
    .returning({ uid: userTable.uid });
  return Boolean(updated[0]);
}

async function consumeFactor(
  tx: DbClient,
  account: UserRow,
  lottery: LotteryRow,
  now: number,
): Promise<void> {
  const linkId = String(lottery.id);
  if (lottery.factor === 1) {
    const cost = Math.max(1, lottery.factorNum);
    if (account.integral < cost) throw new ValidateException("积分不足，没有更多抽奖次数");
    const balance = account.integral - cost;
    await tx.update(userTable).set({ integral: balance }).where(eq(userTable.uid, account.uid));
    await tx.insert(userBill).values({
      uid: account.uid,
      linkId,
      pm: 0,
      title: "抽奖使用积分",
      category: "integral",
      type: "lottery_use_integral",
      eventKey: "lottery_use_integral",
      number: String(cost),
      balance: String(balance),
      mark: `参与抽奖活动 ${lottery.name}`,
      status: 1,
      addTime: now,
    });
    return;
  }
  if (lottery.factor === 2) {
    const cost = Math.max(1, lottery.factorNum) * 100;
    const current = toHundredths(account.nowMoney, "用户余额");
    if (current < cost) throw new ValidateException("余额不足，没有更多抽奖次数");
    const balance = current - cost;
    await tx.update(userTable).set({ nowMoney: fromHundredths(balance) }).where(eq(userTable.uid, account.uid));
    await tx.insert(userBill).values({
      uid: account.uid,
      linkId,
      pm: 0,
      title: "抽奖使用余额",
      category: "now_money",
      type: "lottery_use_money",
      eventKey: "lottery_use_money",
      number: fromHundredths(cost),
      balance: fromHundredths(balance),
      mark: `参与抽奖活动 ${lottery.name}`,
      status: 1,
      addTime: now,
    });
    return;
  }
  if (lottery.factor === 3 || lottery.factor === 4) {
    const rows = await tx
      .select()
      .from(luckLotteryEntitlement)
      .where(
        and(
          eq(luckLotteryEntitlement.uid, account.uid),
          eq(luckLotteryEntitlement.factor, lottery.factor),
          gt(luckLotteryEntitlement.remaining, 0),
          gt(luckLotteryEntitlement.expiresAt, now),
        ),
      )
      .orderBy(asc(luckLotteryEntitlement.expiresAt), asc(luckLotteryEntitlement.id))
      .limit(1)
      .for("update");
    if (!rows[0]) {
      throw new ValidateException(lottery.factor === 3
        ? "购买商品之后获得更多抽奖次数"
        : "订单完成评价之后获得更多抽奖次数");
    }
    const consumed = await tx
      .update(luckLotteryEntitlement)
      .set({ remaining: sql`${luckLotteryEntitlement.remaining} - 1`, updateTime: now })
      .where(and(eq(luckLotteryEntitlement.id, rows[0].id), gt(luckLotteryEntitlement.remaining, 0)))
      .returning({ id: luckLotteryEntitlement.id });
    if (!consumed[0]) throw new ValidateException("抽奖次数已被使用");
    return;
  }
  if (lottery.factor === 5) {
    const consumed = await tx
      .update(userTable)
      .set({ spreadLottery: sql`GREATEST(${userTable.spreadLottery} - 1, 0)` })
      .where(and(eq(userTable.uid, account.uid), gt(userTable.spreadLottery, 0)))
      .returning({ uid: userTable.uid });
    if (!consumed[0]) throw new ValidateException("邀请更多好友获取抽奖次数");
    return;
  }
  throw new ValidateException("暂未有该类型活动");
}

async function lockCouponAward(
  tx: DbClient,
  uid: number,
  issueId: number,
  now: number,
): Promise<CouponIssueRow | null> {
  const rows = await tx
    .select()
    .from(storeCouponIssue)
    .where(eq(storeCouponIssue.id, issueId))
    .limit(1)
    .for("update");
  const issue = rows[0];
  const date = new Date(now * 1000);
  if (
    !issue || issue.status !== 1 || issue.isDel !== 0 ||
    (issue.startTime && issue.startTime > date) ||
    (issue.endTime && issue.endTime < date) ||
    (!issue.isPermanent && issue.remainCount <= 0)
  ) return null;
  if (issue.receiveLimit > 0) {
    const counts = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(storeCouponUser)
      .where(and(eq(storeCouponUser.uid, uid), eq(storeCouponUser.issueCouponId, issueId)));
    if ((counts[0]?.count ?? 0) >= issue.receiveLimit) return null;
  }
  return issue;
}

async function issueCouponAward(
  tx: DbClient,
  uid: number,
  issue: CouponIssueRow,
  now: number,
): Promise<void> {
  if (!issue.isPermanent) {
    const updated = await tx
      .update(storeCouponIssue)
      .set({ remainCount: sql`${storeCouponIssue.remainCount} - 1` })
      .where(and(eq(storeCouponIssue.id, issue.id), gt(storeCouponIssue.remainCount, 0)))
      .returning({ id: storeCouponIssue.id });
    if (!updated[0]) throw new ValidateException("优惠券已领完");
  }
  const start = new Date(now * 1000);
  const end = issue.day > 0
    ? new Date((now + issue.day * 86_400) * 1000)
    : issue.useEndTime;
  if (!end) throw new ValidateException("优惠券固定有效期未配置");
  await tx.insert(storeCouponUser).values({
    uid,
    issueCouponId: issue.id,
    couponTitle: issue.couponTitle || issue.title,
    couponPrice: issue.couponPrice,
    useMinPrice: issue.useMinPrice,
    status: 0,
    startTime: issue.day > 0 ? start : (issue.useStartTime ?? start),
    endTime: end,
    type: issue.type,
    receiveTime: now,
    receiveSource: "luck_lottery",
    isFail: 0,
  });
  if (issue.category !== 2) {
    await tx.insert(storeCouponIssueUser).values({ uid, issueCouponId: issue.id, addTime: now });
  }
}

async function applyAward(
  tx: DbClient,
  account: UserRow,
  prize: PrizeRow | LotteryPrizeSnapshot,
  recordId: number,
  now: number,
  couponIssue: CouponIssueRow | null,
): Promise<void> {
  const amount = "num" in prize ? prize.num : "0.00";
  const linkId = String(recordId);
  if (prize.type === 1) return;
  if (prize.type === 2) {
    const points = Math.trunc(Number(amount));
    if (!Number.isSafeInteger(points) || points <= 0) throw new ValidateException("积分奖品配置错误");
    const updated = await tx
      .update(userTable)
      .set({ integral: sql`${userTable.integral} + ${points}` })
      .where(eq(userTable.uid, account.uid))
      .returning({ balance: userTable.integral });
    if (!updated[0]) throw new NotFoundException("用户不存在");
    await tx.insert(userBill).values({
      uid: account.uid, linkId, pm: 1, title: "抽奖获得积分", category: "integral",
      type: "lottery_give_integral", eventKey: "lottery_give_integral", number: String(points),
      balance: String(updated[0].balance), mark: "抽奖奖品自动到账", status: 1, addTime: now,
    });
    return;
  }
  if (prize.type === 3) {
    const cents = toHundredths(amount, "余额奖品");
    if (cents <= 0) throw new ValidateException("余额奖品配置错误");
    const updated = await tx
      .update(userTable)
      .set({ nowMoney: sql`${userTable.nowMoney} + ${fromHundredths(cents)}` })
      .where(eq(userTable.uid, account.uid))
      .returning({ balance: userTable.nowMoney });
    if (!updated[0]) throw new NotFoundException("用户不存在");
    await tx.insert(userBill).values({
      uid: account.uid, linkId, pm: 1, title: "抽奖获得余额", category: "now_money",
      type: "lottery_give_money", eventKey: "lottery_give_money", number: fromHundredths(cents),
      balance: updated[0].balance, mark: "抽奖奖品自动到账", status: 1, addTime: now,
    });
    return;
  }
  if (prize.type === 5) {
    if (!couponIssue) throw new ValidateException("优惠券奖品已不可领取");
    await issueCouponAward(tx, account.uid, couponIssue, now);
    return;
  }
  if (prize.type === 7) {
    const cents = toHundredths(amount, "经验奖品");
    if (cents <= 0) throw new ValidateException("经验奖品配置错误");
    const updated = await tx
      .update(userTable)
      .set({ exp: sql`${userTable.exp} + ${fromHundredths(cents)}` })
      .where(eq(userTable.uid, account.uid))
      .returning({ exp: userTable.exp });
    if (!updated[0]) throw new NotFoundException("用户不存在");
    await tx.insert(userBill).values({
      uid: account.uid, linkId, pm: 1, title: "抽奖获得经验", category: "exp",
      type: "lottery_give_exp", eventKey: "lottery_give_exp", number: fromHundredths(cents),
      balance: updated[0].exp, mark: "抽奖奖品自动到账", status: 1, addTime: now,
    });
    await detectUserLevel(tx, account.uid, account.nickname, toHundredths(updated[0].exp, "用户经验"), now);
    return;
  }
  if (prize.type === 9) {
    const days = Math.trunc(Number(amount));
    if (!Number.isSafeInteger(days) || days <= 0) throw new ValidateException("会员天数奖品配置错误");
    const overdueTime = calculateMembershipExpiry(days, account.isMoneyLevel, account.overdueTime, now);
    await tx.update(userTable).set({ isMoneyLevel: 2, isEverLevel: 0, overdueTime }).where(eq(userTable.uid, account.uid));
    return;
  }
  throw new ValidateException(
    prize.type === 4 ? "微信红包奖品尚未接入可靠付款通道" : "该奖品类型暂不支持自动领取",
  );
}

function recordPrize(record: { prizeInfo: string | null }, fallback?: PrizeRow | null) {
  const raw = parseJsonObject(record.prizeInfo);
  if (Object.keys(raw).length) return raw as unknown as LotteryPrizeSnapshot;
  return fallback ? snapshot(fallback) : null;
}

export class LotteryService {
  constructor(private readonly container: Container) {}

  async info(uid: number, factorValue: unknown): Promise<Record<string, unknown> | []> {
    const factor = positiveInteger(factorValue ?? 1, "抽奖类型");
    if (factor > 5) throw new ValidateException("抽奖类型参数错误");
    const now = Math.floor(Date.now() / 1000);
    const [account] = await this.container.db
      .select()
      .from(userTable)
      .where(and(eq(userTable.uid, uid), eq(userTable.status, 1), eq(userTable.isDel, 0)))
      .limit(1);
    if (!account) throw new NotFoundException("用户不存在");
    const lottery = await activeLottery(this.container.db, factor, now);
    if (!lottery) throw new NotFoundException("暂无可参与的抽奖活动");
    await assertUserEligible(this.container.db, account, lottery);
    const availability = await availableDraws(this.container.db, account, lottery, now);
    if (factor === 3 && availability.lotteryNum < 1) return [];
    const [prizes, counts, allRecords, userRecords] = await Promise.all([
      this.container.db
        .select()
        .from(luckPrize)
        .where(and(eq(luckPrize.lotteryId, lottery.id), eq(luckPrize.status, 1), eq(luckPrize.isDel, 0)))
        .orderBy(asc(luckPrize.sort), asc(luckPrize.id)),
      drawCounts(this.container.db, uid, lottery.id, now),
      lottery.isAllRecord === 1 ? this.winRecords(lottery.id, undefined, 10) : Promise.resolve([]),
      lottery.isPersonalRecord === 1 ? this.winRecords(lottery.id, uid, 10) : Promise.resolve([]),
    ]);
    const todayCount = lottery.factor === 1
      ? Math.max(0, lottery.lotteryNum - counts.today)
      : availability.lotteryNum;
    const totalCount = lottery.factor === 1
      ? Math.max(0, lottery.totalLotteryNum - counts.total)
      : availability.lotteryNum;
    return {
      ...lottery,
      factor_num: lottery.factorNum,
      attends_user: lottery.attendsUser,
      user_level: parseIdList(lottery.userLevel),
      user_label: parseIdList(lottery.userLabel),
      is_svip: lottery.isSvip,
      start_time: lottery.startTime,
      end_time: lottery.endTime,
      lottery_num_term: lottery.lotteryNumTerm,
      lottery_num: availability.lotteryNum,
      total_lottery_num: lottery.totalLotteryNum,
      spread_num: lottery.spreadNum,
      is_all_record: lottery.isAllRecord,
      is_personal_record: lottery.isPersonalRecord,
      is_content: lottery.isContent,
      prize: prizes.map(publicPrize),
      todayCount,
      totalCount,
      all_record: allRecords,
      user_record: userRecords,
      cache_time: availability.cacheTime,
    };
  }

  async draw(uid: number, input: { id?: unknown; type?: unknown }) {
    const lotteryId = positiveInteger(input.id, "活动");
    const requestedType = input.type === undefined ? 0 : Number(input.type);
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      const users = await tx
        .select()
        .from(userTable)
        .where(and(eq(userTable.uid, uid), eq(userTable.status, 1), eq(userTable.isDel, 0)))
        .limit(1)
        .for("update");
      const account = users[0];
      if (!account) throw new NotFoundException("用户不存在");
      const lotteryRows = await tx
        .select()
        .from(luckLottery)
        .where(eq(luckLottery.id, lotteryId))
        .limit(1)
        .for("update");
      const lottery = lotteryRows[0];
      if (
        !lottery || lottery.status !== 1 || lottery.isDel !== 0 ||
        lottery.startTime > now || lottery.endTime < now
      ) throw new ValidateException("该活动已经下架，请持续关注");
      if (requestedType && requestedType !== lottery.type) throw new ValidateException("抽奖活动类型不匹配");
      await assertUserEligible(tx, account, lottery);
      if (lottery.factor === 1) {
        const counts = await drawCounts(tx, uid, lottery.id, now);
        if (counts.today >= lottery.lotteryNum) throw new ValidateException("本次活动当天抽奖次数已用完");
        if (counts.total >= lottery.totalLotteryNum) throw new ValidateException("本次活动总抽奖次数已用完");
      }

      const prizes = await tx
        .select()
        .from(luckPrize)
        .where(and(eq(luckPrize.lotteryId, lottery.id), eq(luckPrize.status, 1), eq(luckPrize.isDel, 0)))
        .orderBy(asc(luckPrize.id))
        .for("update");
      let prize = selectWeightedPrize(prizes);
      if (!prize) throw new ValidateException("该活动奖品配置有误，请联系管理员");
      const losingPrize = prizes.find((item) => item.type === 1 && item.chance > 0) ?? null;
      if (prize.type !== 1 && prize.total !== -1 && prize.total <= 0) prize = losingPrize;
      let couponIssue: CouponIssueRow | null = null;
      if (prize?.type === 5) {
        couponIssue = await lockCouponAward(tx, uid, prize.couponId, now);
        if (!couponIssue) prize = losingPrize;
      }
      if (!prize) throw new ValidateException("奖品库存不足且未配置未中奖项");

      await consumeFactor(tx, account, lottery, now);
      if (prize.type !== 1 && prize.total >= 1) {
        const updated = await tx
          .update(luckPrize)
          .set({ total: sql`${luckPrize.total} - 1` })
          .where(and(eq(luckPrize.id, prize.id), gt(luckPrize.total, 0)))
          .returning({ total: luckPrize.total });
        if (!updated[0]) throw new ValidateException("奖品库存已被领取");
        prize = { ...prize, total: updated[0].total };
      }
      const serialized = JSON.stringify(snapshot(prize));
      const records = await tx
        .insert(luckLotteryRecord)
        .values({
          uid,
          lotteryId: lottery.id,
          prizeId: prize.id,
          type: prize.type,
          prizeInfo: serialized,
          addTime: now,
        })
        .returning({ id: luckLotteryRecord.id });
      const record = records[0];
      if (!record) throw new Error("抽奖记录创建失败");
      if (AUTO_RECEIVE_TYPES.has(prize.type)) {
        await applyAward(tx, account, prize, record.id, now, couponIssue);
        await tx
          .update(luckLotteryRecord)
          .set({ isReceive: 1, receiveTime: now, receiveInfo: "{}" })
          .where(eq(luckLotteryRecord.id, record.id));
      }
      return { ...publicPrize(prize), lottery_record_id: record.id, is_receive: AUTO_RECEIVE_TYPES.has(prize.type) ? 1 : 0 };
    });
  }

  async receive(
    uid: number,
    input: { id?: unknown; name?: unknown; phone?: unknown; address?: unknown; mark?: unknown },
  ): Promise<void> {
    const recordId = positiveInteger(input.id, "中奖记录");
    const now = Math.floor(Date.now() / 1000);
    await withTx(this.container, async (tx) => {
      const rows = await tx
        .select()
        .from(luckLotteryRecord)
        .where(and(eq(luckLotteryRecord.id, recordId), eq(luckLotteryRecord.uid, uid)))
        .limit(1)
        .for("update");
      const record = rows[0];
      if (!record) throw new NotFoundException("中奖记录不存在");
      if (record.isReceive === 1) throw new ValidateException("已经领取成功");
      const prizeRows = await tx.select().from(luckPrize).where(eq(luckPrize.id, record.prizeId)).limit(1);
      const prize = recordPrize(record, prizeRows[0] ?? null);
      if (!prize) throw new ValidateException("奖品快照不存在");
      if (prize.type === 4) throw new ValidateException("微信红包奖品尚未接入可靠付款通道，请联系管理员");
      if (prize.type === 8) throw new ValidateException("用户等级奖品缺少明确等级配置，请联系管理员");
      let receiveInfo: Record<string, string> = {};
      if (prize.type === 6) {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        const phone = typeof input.phone === "string" ? input.phone.trim() : "";
        const address = typeof input.address === "string" ? input.address.trim() : "";
        const mark = typeof input.mark === "string" ? input.mark.trim() : "";
        if (!name || !phone || !address) throw new ValidateException("请输入收货人信息");
        if (!/^1\d{10}$/.test(phone)) throw new ValidateException("请输入正确的收货人电话");
        if (name.length > 64 || address.length > 255 || mark.length > 255) {
          throw new ValidateException("收货信息过长");
        }
        receiveInfo = { name, phone, address, mark };
      } else {
        const users = await tx.select().from(userTable).where(eq(userTable.uid, uid)).limit(1).for("update");
        const account = users[0];
        if (!account) throw new NotFoundException("用户不存在");
        let couponIssue: CouponIssueRow | null = null;
        if (prize.type === 5) couponIssue = await lockCouponAward(tx, uid, prize.coupon_id, now);
        await applyAward(tx, account, prize, record.id, now, couponIssue);
      }
      await tx
        .update(luckLotteryRecord)
        .set({ isReceive: 1, receiveTime: now, receiveInfo: JSON.stringify(receiveInfo) })
        .where(and(eq(luckLotteryRecord.id, record.id), eq(luckLotteryRecord.uid, uid), eq(luckLotteryRecord.isReceive, 0)));
    });
  }

  async records(uid: number, query: Record<string, string | undefined>) {
    const page = safePage(query.page);
    const limit = Math.min(100, safePage(query.limit, 10));
    const rows = await this.container.db
      .select({ record: luckLotteryRecord, prize: luckPrize })
      .from(luckLotteryRecord)
      .leftJoin(luckPrize, eq(luckPrize.id, luckLotteryRecord.prizeId))
      .where(and(eq(luckLotteryRecord.uid, uid), ne(luckLotteryRecord.type, 1)))
      .orderBy(desc(luckLotteryRecord.id))
      .limit(limit)
      .offset((page - 1) * limit);
    return rows.map(({ record, prize }) => ({
      ...record,
      prize_info: recordPrize(record, prize),
      prize: recordPrize(record, prize),
      receive_info: parseJsonObject(record.receiveInfo),
      deliver_info: parseJsonObject(record.deliverInfo),
    }));
  }

  private async winRecords(lotteryId: number, uid?: number, limit = 10) {
    const conditions = [eq(luckLotteryRecord.lotteryId, lotteryId), ne(luckLotteryRecord.type, 1)];
    if (uid) conditions.push(eq(luckLotteryRecord.uid, uid));
    const rows = await this.container.db
      .select({
        record: luckLotteryRecord,
        prize: luckPrize,
        nickname: userTable.nickname,
        avatar: userTable.avatar,
      })
      .from(luckLotteryRecord)
      .leftJoin(luckPrize, eq(luckPrize.id, luckLotteryRecord.prizeId))
      .leftJoin(userTable, eq(userTable.uid, luckLotteryRecord.uid))
      .where(and(...conditions))
      .orderBy(desc(luckLotteryRecord.id))
      .limit(limit);
    return rows.map(({ record, prize, nickname, avatar }) => {
      const storedPrize = recordPrize(record, prize);
      return {
        id: record.id,
        uid: record.uid,
        add_time: record.addTime,
        receive_time: record.receiveTime,
        user: { nickname: nickname || "用户已注销", avatar: avatar || "" },
        prize: storedPrize
          ? publicPrize(storedPrize)
          : { id: record.prizeId, type: record.type, lottery_id: record.lotteryId, name: "历史奖品", prompt: "", image: "" },
      };
    });
  }
}
