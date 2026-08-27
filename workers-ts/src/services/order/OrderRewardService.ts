import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  memberRight,
  storeOrder,
  storeOrderRefund,
  systemUserLevel,
  user,
  userBill,
  userLevel,
} from "@/models/schema";
import type { Container, DbClient } from "@/lib/di";
import { SystemConfigService, type SystemConfigEnv } from "@/services/system/SystemConfigService";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";

const RATE_SCALE = 10_000;
const INTEGRAL_GRANT_EVENTS = ["pay_give_integral", "order_give_integral"] as const;

export interface OrderRewardConfig {
  orderIntegralRateUnits: number;
  orderExpRateUnits: number;
  memberFunctionEnabled: boolean;
  memberCardEnabled: boolean;
  memberIntegralMultiplier: number;
}

export interface ReceiptRewardAmounts {
  productIntegral: number;
  orderIntegral: number;
  expHundredths: number;
}

/** 将非负十进制配置转为万分单位，兼容 PHP system_config 的 JSON 标量。 */
export function parseRewardRate(value: string, label: string): number {
  const normalized = normalizeConfigScalar(value) || "0";
  if (!/^\d+(?:\.\d{1,4})?$/.test(normalized)) {
    throw new Error(`${label}格式无效`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const units = BigInt(whole) * BigInt(RATE_SCALE)
    + BigInt(fraction.padEnd(4, "0"));
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}超出安全范围`);
  return Number(units);
}

/** PHP 积分字段最终按 int/BCMath scale=0 处理，统一向下截断。 */
export function decimalToWholePoints(value: string | number): number {
  const normalized = normalizeConfigScalar(String(value));
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error("积分格式无效");
  const points = BigInt(normalized.split(".")[0]);
  if (points > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("积分超出安全范围");
  return Number(points);
}

/** 商品 give_integral * 数量，等价于 PHP bcmul(..., scale=0)。 */
export function calculateProductIntegralSnapshot(
  items: Array<{ giveIntegral: string | number; quantity: number }>,
): number {
  return items.reduce((sum, item) => {
    const normalized = normalizeConfigScalar(String(item.giveIntegral));
    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("商品赠送积分格式无效");
    const [whole, fraction = ""] = normalized.split(".");
    const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    const points = exactFloorProduct([hundredths, item.quantity], 100, "商品赠送积分计算");
    const next = sum + points;
    if (!Number.isSafeInteger(next)) throw new Error("商品赠送积分超出安全范围");
    return next;
  }, 0);
}

function exactFloorProduct(factors: number[], divisor: number, label: string): number {
  if (factors.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label}参数无效`);
  }
  if (!Number.isSafeInteger(divisor) || divisor <= 0) throw new Error(`${label}除数无效`);
  const product = factors.reduce((total, value) => total * BigInt(value), 1n);
  const result = product / BigInt(divisor);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}超出安全范围`);
  return Number(result);
}

/**
 * 对应 PHP gainUserIntegral/gainUserExp：
 * - 商品赠送积分按整数快照；
 * - 实付返积分按 BCMath scale=0 截断；
 * - 经验按 BCMath scale=2 截断。
 */
export function calculateReceiptRewards(input: {
  orderType: number;
  payCents: number;
  gainIntegral: string | number;
  orderIntegralRateUnits: number;
  orderExpRateUnits: number;
  paidMember: boolean;
  memberIntegralMultiplier: number;
  memberFunctionEnabled: boolean;
  levelActive: boolean;
}): ReceiptRewardAmounts {
  const normalOrder = input.orderType === 0;
  const multiplier = input.paidMember
    ? Math.max(1, Math.trunc(input.memberIntegralMultiplier))
    : 1;
  return {
    productIntegral: normalOrder ? decimalToWholePoints(input.gainIntegral) : 0,
    orderIntegral: normalOrder
      ? exactFloorProduct(
          [input.payCents, input.orderIntegralRateUnits, multiplier],
          100 * RATE_SCALE,
          "返积分计算",
        )
      : 0,
    expHundredths: input.memberFunctionEnabled && input.levelActive
      ? exactFloorProduct(
          [input.payCents, input.orderExpRateUnits],
          RATE_SCALE,
          "经验计算",
        )
      : 0,
  };
}

/** 累计比例目标；全额退款时强制精确封顶。 */
export function targetProportionalPoints(
  totalPoints: number,
  cumulativeRefundCents: number,
  payCents: number,
): number {
  if (!Number.isSafeInteger(totalPoints) || totalPoints < 0) throw new Error("积分总额无效");
  if (!Number.isSafeInteger(cumulativeRefundCents) || cumulativeRefundCents < 0) {
    throw new Error("累计退款金额无效");
  }
  if (!Number.isSafeInteger(payCents) || payCents <= 0) throw new Error("订单实付金额无效");
  if (cumulativeRefundCents >= payCents) return totalPoints;
  return exactFloorProduct([totalPoints, cumulativeRefundCents], payCents, "退款积分计算");
}

export async function loadOrderRewardConfig(
  container: Container,
  env: SystemConfigEnv,
): Promise<OrderRewardConfig> {
  const values = await new SystemConfigService(container, env).getMany([
    "order_give_integral",
    "member_func_status",
    "order_give_exp",
    "member_card_status",
  ]);
  const memberCardEnabled = parseConfigInteger(values.member_card_status, 1) === 1;
  let memberIntegralMultiplier = 1;
  if (memberCardEnabled) {
    const rights = await container.db
      .select({ number: memberRight.number })
      .from(memberRight)
      .where(and(eq(memberRight.rightType, "integral"), eq(memberRight.status, 1)))
      .limit(1);
    if (rights[0]?.number && rights[0].number > 0) {
      memberIntegralMultiplier = rights[0].number;
    }
  }
  return {
    orderIntegralRateUnits: parseRewardRate(values.order_give_integral || "0", "下单赠送积分比例"),
    orderExpRateUnits: parseRewardRate(values.order_give_exp || "0", "下单赠送经验比例"),
    memberFunctionEnabled: parseConfigInteger(values.member_func_status, 1) === 1,
    memberCardEnabled,
    memberIntegralMultiplier,
  };
}

export async function settleOrderRewards(
  tx: DbClient,
  order: Pick<
    typeof storeOrder.$inferSelect,
    "id" | "uid" | "orderId" | "type" | "payPrice" | "gainIntegral"
  >,
  config: OrderRewardConfig,
  now: number,
): Promise<void> {
  const accounts = await tx
    .select()
    .from(user)
    .where(eq(user.uid, order.uid))
    .for("update")
    .limit(1);
  const account = accounts[0];
  if (!account) return;

  const rewards = calculateReceiptRewards({
    orderType: order.type,
    payCents: decimalToHundredths(order.payPrice),
    gainIntegral: order.gainIntegral,
    orderIntegralRateUnits: config.orderIntegralRateUnits,
    orderExpRateUnits: config.orderExpRateUnits,
    paidMember: config.memberCardEnabled && account.isMoneyLevel > 0,
    memberIntegralMultiplier: config.memberIntegralMultiplier,
    memberFunctionEnabled: config.memberFunctionEnabled,
    levelActive: account.levelStatus === 1,
  });
  const linkId = String(order.id);
  let integralBalance = account.integral;

  const addIntegral = async (eventKey: string, title: string, amount: number, mark: string) => {
    if (amount <= 0) return;
    const inserted = await tx
      .insert(userBill)
      .values({
        uid: account.uid,
        linkId,
        pm: 1,
        title,
        category: "integral",
        type: "gain",
        eventKey,
        number: String(amount),
        balance: String(integralBalance + amount),
        mark,
        status: 1,
        addTime: now,
      })
      .onConflictDoNothing()
      .returning({ id: userBill.id });
    if (!inserted[0]) return;
    integralBalance += amount;
    await tx.update(user).set({ integral: integralBalance }).where(eq(user.uid, account.uid));
  };

  await addIntegral(
    "pay_give_integral",
    "购买商品赠送积分",
    rewards.productIntegral,
    `订单 ${order.orderId} 购买商品赠送 ${rewards.productIntegral} 积分`,
  );
  await addIntegral(
    "order_give_integral",
    "下单赠送积分",
    rewards.orderIntegral,
    `订单 ${order.orderId} 实付金额赠送 ${rewards.orderIntegral} 积分`,
  );

  let expHundredths = decimalToHundredths(account.exp);
  if (rewards.expHundredths > 0) {
    const nextExp = expHundredths + rewards.expHundredths;
    const inserted = await tx
      .insert(userBill)
      .values({
        uid: account.uid,
        linkId,
        pm: 1,
        title: "下单赠送经验",
        category: "exp",
        type: "gain",
        eventKey: "order_give_exp",
        number: centsToDecimal(rewards.expHundredths),
        balance: centsToDecimal(nextExp),
        mark: `订单 ${order.orderId} 赠送 ${centsToDecimal(rewards.expHundredths)} 经验`,
        status: 1,
        addTime: now,
      })
      .onConflictDoNothing()
      .returning({ id: userBill.id });
    if (inserted[0]) {
      expHundredths = nextExp;
      await tx.update(user).set({ exp: centsToDecimal(expHundredths) }).where(eq(user.uid, account.uid));
    }
  }
  if (config.memberFunctionEnabled && account.levelStatus === 1) {
    await detectUserLevel(tx, account.uid, account.nickname, expHundredths, now);
  }
}

/**
 * 回退确认收货赠送积分，并按累计退款比例返还订单抵扣积分和积分商品必付积分。
 * 经验不回退，与 PHP regressionIntegral 行为一致。
 */
export async function reverseOrderRewards(
  tx: DbClient,
  order: Pick<
    typeof storeOrder.$inferSelect,
    "id" | "uid" | "orderId" | "payPrice" | "payIntegral" | "useIntegral" | "backIntegral" | "totalNum"
  >,
  cumulativeRefundCents: number,
  now: number,
  cumulativeRefundNum = 0,
): Promise<void> {
  const payCents = decimalToHundredths(order.payPrice);
  const pureIntegralRefund =
    payCents === 0 &&
    order.payIntegral > 0 &&
    Number.isSafeInteger(order.totalNum) &&
    order.totalNum > 0 &&
    Number.isSafeInteger(cumulativeRefundNum) &&
    cumulativeRefundNum > 0;
  if ((payCents <= 0 || cumulativeRefundCents <= 0) && !pureIntegralRefund) return;
  const accounts = await tx
    .select()
    .from(user)
    .where(eq(user.uid, order.uid))
    .for("update")
    .limit(1);
  const account = accounts[0];
  if (!account) return;
  const linkId = String(order.id);
  let integralBalance = account.integral;

  const grants = payCents > 0
    ? await tx
        .select({ number: userBill.number })
        .from(userBill)
        .where(
          and(
            eq(userBill.uid, order.uid),
            eq(userBill.linkId, linkId),
            eq(userBill.category, "integral"),
            eq(userBill.pm, 1),
            eq(userBill.status, 1),
            or(
              inArray(userBill.eventKey, [...INTEGRAL_GRANT_EVENTS]),
              and(eq(userBill.eventKey, ""), eq(userBill.type, "gain")),
            ),
          ),
        )
    : [];
  const grantedPoints = grants.reduce((sum, row) => sum + decimalToWholePoints(row.number), 0);
  if (grantedPoints > 0) {
    const previousRows = await tx
      .select({ number: userBill.number })
      .from(userBill)
      .where(
        and(
          eq(userBill.uid, order.uid),
          eq(userBill.linkId, linkId),
          eq(userBill.category, "integral"),
          eq(userBill.pm, 0),
          eq(userBill.status, 1),
          or(
            eq(userBill.eventKey, "integral_refund"),
            and(eq(userBill.eventKey, ""), eq(userBill.type, "deduction"), eq(userBill.title, "赠送积分回退")),
          ),
        ),
      );
    const previous = previousRows.reduce(
      (sum, row) => sum + decimalToWholePoints(row.number),
      0,
    );
    const target = targetProportionalPoints(grantedPoints, cumulativeRefundCents, payCents);
    const deduction = Math.min(Math.max(target - previous, 0), integralBalance);
    if (deduction > 0) {
      integralBalance -= deduction;
      await tx.update(user).set({ integral: integralBalance }).where(eq(user.uid, order.uid));
      await tx.insert(userBill).values({
        uid: order.uid,
        linkId,
        pm: 0,
        title: "赠送积分回退",
        category: "integral",
        type: "deduction",
        eventKey: "integral_refund",
        number: String(deduction),
        balance: String(integralBalance),
        mark: `订单 ${order.orderId} 累计退款，回退赠送积分 ${deduction}`,
        status: 1,
        addTime: now,
      });
    }
  }

  if (order.payIntegral > 0) {
    const returnedRows = await tx
      .select({ number: userBill.number })
      .from(userBill)
      .where(
        and(
          eq(userBill.uid, order.uid),
          eq(userBill.linkId, linkId),
          eq(userBill.category, "integral"),
          eq(userBill.type, "order_integral_refund"),
          eq(userBill.pm, 1),
          eq(userBill.status, 1),
        ),
      );
    const previousReturned = returnedRows.reduce(
      (sum, row) => sum + decimalToWholePoints(row.number),
      0,
    );
    const targetReturned = payCents > 0
      ? targetProportionalPoints(order.payIntegral, cumulativeRefundCents, payCents)
      : targetProportionalPoints(order.payIntegral, cumulativeRefundNum, order.totalNum);
    const delta = Math.max(targetReturned - previousReturned, 0);
    if (delta > 0) {
      integralBalance += delta;
      await tx.update(user).set({ integral: integralBalance }).where(eq(user.uid, order.uid));
      await tx.insert(userBill).values({
        uid: order.uid,
        linkId,
        pm: 1,
        title: "积分商品支付积分返还",
        category: "integral",
        type: "order_integral_refund",
        eventKey: "order_integral_refund",
        number: String(delta),
        balance: String(integralBalance),
        mark: `订单 ${order.orderId} 累计退款，返还支付积分 ${delta}`,
        status: 1,
        addTime: now,
      });
    }
  }

  if (payCents <= 0) return;
  const usedPoints = decimalToWholePoints(order.useIntegral);
  if (usedPoints <= 0) return;
  const completedRefunds = await tx
    .select({ orderId: storeOrderRefund.orderId })
    .from(storeOrderRefund)
    .where(
      and(
        eq(storeOrderRefund.storeOrderId, order.id),
        eq(storeOrderRefund.refundType, 6),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      ),
    );
  const compatibleLinkIds = [linkId, ...completedRefunds.map((row) => row.orderId)];
  const returnedRows = await tx
    .select({ number: userBill.number })
    .from(userBill)
    .where(
      and(
        eq(userBill.uid, order.uid),
        inArray(userBill.linkId, compatibleLinkIds),
        eq(userBill.category, "integral"),
        eq(userBill.type, "pay_product_integral_back"),
        eq(userBill.pm, 1),
        eq(userBill.status, 1),
      ),
    );
  const returnedByBills = returnedRows.reduce(
    (sum, row) => sum + decimalToWholePoints(row.number),
    0,
  );
  const previousReturned = Math.max(returnedByBills, decimalToWholePoints(order.backIntegral));
  const targetReturned = targetProportionalPoints(usedPoints, cumulativeRefundCents, payCents);
  const delta = Math.max(targetReturned - previousReturned, 0);
  if (delta > 0) {
    integralBalance += delta;
    await tx.update(user).set({ integral: integralBalance }).where(eq(user.uid, order.uid));
    await tx.insert(userBill).values({
      uid: order.uid,
      linkId,
      pm: 1,
      title: "下单抵扣积分回退",
      category: "integral",
      type: "pay_product_integral_back",
      eventKey: "pay_product_integral_back",
      number: String(delta),
      balance: String(integralBalance),
      mark: `订单 ${order.orderId} 累计退款，返还抵扣积分 ${delta}`,
      status: 1,
      addTime: now,
    });
  }
  const cumulativeReturned = Math.max(previousReturned + delta, targetReturned);
  await tx
    .update(storeOrder)
    .set({ backIntegral: String(cumulativeReturned) })
    .where(eq(storeOrder.id, order.id));
}

export async function detectUserLevel(
  tx: DbClient,
  uid: number,
  nickname: string,
  expHundredths: number,
  now: number,
): Promise<void> {
  const exp = centsToDecimal(expHundredths);
  const levels = await tx
    .select()
    .from(systemUserLevel)
    .where(
      and(
        eq(systemUserLevel.isDel, 0),
        eq(systemUserLevel.isShow, 1),
        sql`${systemUserLevel.expNum}::numeric <= ${exp}::numeric`,
      ),
    )
    .orderBy(asc(systemUserLevel.grade), asc(systemUserLevel.id));
  if (!levels.length) return;
  const existing = await tx
    .select()
    .from(userLevel)
    .where(and(eq(userLevel.uid, uid), inArray(userLevel.levelId, levels.map((level) => level.id))));
  const byLevelId = new Map(existing.map((row) => [row.levelId, row]));
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const values = {
      grade: level.grade,
      isForever: level.isForever,
      status: 1,
      isDel: 0,
      mark: `尊敬的用户${nickname}在${new Date((now + i) * 1000).toISOString()}成为了${level.name}`,
      addTime: now + i,
      discount: Math.trunc(Number(level.discount) || 0),
    };
    const record = byLevelId.get(level.id);
    if (record) {
      if (record.status !== 1 || record.isDel !== 0) {
        await tx.update(userLevel).set(values).where(eq(userLevel.id, record.id));
      }
    } else {
      await tx.insert(userLevel).values({
        uid,
        levelId: level.id,
        ...values,
      });
    }
  }
  await tx.update(user).set({ level: levels[levels.length - 1].id }).where(eq(user.uid, uid));
}

function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("数值超出安全范围");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function decimalToHundredths(value: string | number): number {
  const normalized = normalizeConfigScalar(String(value));
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("数值格式无效");
  const [whole, fraction = ""] = normalized.split(".");
  const units = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(units)) throw new Error("数值超出安全范围");
  return units;
}
