import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  agentLevel,
  storeOrder,
  storeOrderStatus,
  user,
  userBrokerage,
} from "@/models/schema";
import { withTx, type Container, type DbClient } from "@/lib/di";
import { SystemConfigService, type SystemConfigEnv } from "@/services/system/SystemConfigService";
import { settleSupplierPayment } from "@/services/supplier/SupplierFinanceService";
import { normalizeConfigScalar, parseConfigInteger } from "@/utils/config";
import {
  loadOrderRewardConfig,
  reverseOrderRewards,
  settleOrderRewards,
  type OrderRewardConfig,
} from "@/services/order/OrderRewardService";

const ORDER_SETTLEMENT_LOCK_NAMESPACE = 63842;

const BROKERAGE_CONFIG_KEYS = [
  "brokerage_func_status",
  "store_brokerage_statu",
  "store_brokerage_price",
  "store_brokerage_ratio",
  "store_brokerage_two",
  "brokerage_level",
  "brokerage_compute_type",
  "is_self_brokerage",
  "division_status",
] as const;

export interface BrokerageOrderItem {
  grossCents: number;
  costCents: number;
  quantity: number;
  specified: boolean;
  specifiedOneCents: number;
  specifiedTwoCents: number;
}

export interface OrderBrokerageSnapshot {
  spreadUid: number;
  spreadTwoUid: number;
  oneBrokerageCents: number;
  twoBrokerageCents: number;
  divisionId: number;
  divisionBrokerageCents: number;
  divisionAgentId: number;
  divisionAgentBrokerageCents: number;
  divisionStaffId: number;
  divisionStaffBrokerageCents: number;
}

export interface DivisionBrokerageRates {
  oneBasisPoints: number;
  twoBasisPoints: number;
  staffBasisPoints: number;
  agentBasisPoints: number;
  divisionBasisPoints: number;
}

type DivisionAccount = Pick<
  typeof user.$inferSelect,
  | "uid"
  | "spreadUid"
  | "divisionType"
  | "divisionStatus"
  | "divisionId"
  | "agentId"
  | "staffId"
  | "divisionPercent"
  | "divisionEndTime"
>;

export interface BrokerageSettlementConfig {
  enabled: boolean;
  mode: number;
  thresholdCents: number;
  frozenDays: number;
}

export interface OrderReceiptSettlementContext {
  brokerage: BrokerageSettlementConfig;
  rewards: OrderRewardConfig;
}

/** 同一订单的收货结算与退款/退佣必须串行化。 */
export async function lockOrderSettlement(tx: DbClient, orderId: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${ORDER_SETTLEMENT_LOCK_NAMESPACE}, ${orderId})`);
}

/** 买家与两级佣金接收人统一按 uid 升序加锁，避免跨订单角色交叉时死锁。 */
export async function lockOrderSettlementUsers(
  tx: DbClient,
  order: Pick<
    typeof storeOrder.$inferSelect,
    "uid" | "spreadUid" | "spreadTwoUid" | "divisionId" | "divisionAgentId" | "divisionStaffId"
  >,
): Promise<void> {
  const userIds = [...new Set([
    order.uid,
    order.spreadUid,
    order.spreadTwoUid,
    order.divisionId,
    order.divisionAgentId,
    order.divisionStaffId,
  ].filter((uid) => uid > 0))]
    .sort((a, b) => a - b);
  if (!userIds.length) return;
  await tx
    .select({ uid: user.uid })
    .from(user)
    .where(inArray(user.uid, userIds))
    .orderBy(asc(user.uid))
    .for("update");
}

export function parsePercentBasisPoints(value: string, label: string): number {
  const normalized = normalizeConfigScalar(value) || "0";
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error(`${label}格式无效`);
  const [whole, fraction = ""] = normalized.split(".");
  const basisPoints = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new Error(`${label}必须在 0 到 100 之间`);
  }
  return basisPoints;
}

export function applyBrokerageUplift(baseBasisPoints: number, upliftPercent: number): number {
  if (!Number.isSafeInteger(baseBasisPoints) || baseBasisPoints < 0 || baseBasisPoints > 10_000) {
    throw new Error("基础返佣比例无效");
  }
  if (!Number.isSafeInteger(upliftPercent) || upliftPercent < 0 || upliftPercent > 1000) {
    throw new Error("等级返佣上浮无效");
  }
  return baseBasisPoints + Math.floor((baseBasisPoints * upliftPercent) / 100);
}

/** 对应 BCMath scale=2：向下截断到分，不使用二进制浮点金额。 */
export function brokerageFromBasisPoints(amountCents: number, basisPoints: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error("返佣基数无效");
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) throw new Error("返佣比例无效");
  const product = amountCents * basisPoints;
  if (!Number.isSafeInteger(product)) throw new Error("返佣计算超出安全范围");
  const result = Math.floor(product / 10_000);
  if (!Number.isSafeInteger(result)) throw new Error("返佣金额超出安全范围");
  return result;
}

/** 按商品金额比例分摊实付额，余数按原顺序补齐，分摊和严格等于 totalCents。 */
export function allocateCents(totalCents: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error("待分摊金额无效");
  if (weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new Error("分摊权重无效");
  }
  const totalWeight = weights.reduce((sum, weight) => {
    const next = sum + weight;
    if (!Number.isSafeInteger(next)) throw new Error("分摊权重超出安全范围");
    return next;
  }, 0);
  if (totalWeight <= 0) return weights.map(() => 0);
  const allocations = weights.map((weight) => {
    const product = totalCents * weight;
    if (!Number.isSafeInteger(product)) throw new Error("分摊计算超出安全范围");
    return Math.floor(product / totalWeight);
  });
  let remainder = totalCents - allocations.reduce((sum, value) => sum + value, 0);
  for (let i = 0; remainder > 0 && i < allocations.length; i++, remainder--) allocations[i] += 1;
  return allocations;
}

export function calculateOrderBrokerage(input: {
  items: BrokerageOrderItem[];
  actualProductCents: number;
  computeType: 1 | 2 | 3;
  oneBasisPoints: number;
  twoBasisPoints: number;
  staffBasisPoints?: number;
  agentBasisPoints?: number;
  divisionBasisPoints?: number;
  oneEligible: boolean;
  twoEligible: boolean;
}): {
  oneCents: number;
  twoCents: number;
  staffCents: number;
  agentCents: number;
  divisionCents: number;
} {
  const allocations = allocateCents(input.actualProductCents, input.items.map((item) => item.grossCents));
  let oneCents = 0;
  let twoCents = 0;
  let staffCents = 0;
  let agentCents = 0;
  let divisionCents = 0;
  for (let i = 0; i < input.items.length; i++) {
    const item = input.items[i];
    if (item.specified) {
      const specifiedOne = item.specifiedOneCents * item.quantity;
      const specifiedTwo = item.specifiedTwoCents * item.quantity;
      if (!Number.isSafeInteger(specifiedOne) || !Number.isSafeInteger(specifiedTwo)) {
        throw new Error("指定 SKU 返佣超出安全范围");
      }
      if (input.oneEligible) oneCents += specifiedOne;
      if (input.twoEligible) twoCents += specifiedTwo;
      continue;
    }
    const base = input.computeType === 1
      ? item.grossCents
      : input.computeType === 2
        ? allocations[i]
        : Math.max(allocations[i] - item.costCents, 0);
    if (input.oneEligible) oneCents += brokerageFromBasisPoints(base, input.oneBasisPoints);
    if (input.twoEligible) twoCents += brokerageFromBasisPoints(base, input.twoBasisPoints);
    staffCents += brokerageFromBasisPoints(base, input.staffBasisPoints ?? 0);
    agentCents += brokerageFromBasisPoints(base, input.agentBasisPoints ?? 0);
    divisionCents += brokerageFromBasisPoints(base, input.divisionBasisPoints ?? 0);
  }
  if (
    !Number.isSafeInteger(oneCents)
    || !Number.isSafeInteger(twoCents)
    || !Number.isSafeInteger(staffCents)
    || !Number.isSafeInteger(agentCents)
    || !Number.isSafeInteger(divisionCents)
  ) {
    throw new Error("订单返佣金额超出安全范围");
  }
  return { oneCents, twoCents, staffCents, agentCents, divisionCents };
}

/** 对应 PHP DivisionServices::divisionBrokerage 的层级差额与推荐关系重叠规则。 */
export function calculateDivisionBrokerageRates(input: {
  enabled: boolean;
  selfBrokerage: boolean;
  now: number;
  baseOneBasisPoints: number;
  baseTwoBasisPoints: number;
  buyer: DivisionAccount;
  firstSpreadParentUid: number;
  staff: DivisionAccount | null;
  agent: DivisionAccount | null;
  division: DivisionAccount | null;
}): DivisionBrokerageRates {
  if (!input.enabled) {
    return {
      oneBasisPoints: input.baseOneBasisPoints,
      twoBasisPoints: input.baseTwoBasisPoints,
      staffBasisPoints: 0,
      agentBasisPoints: 0,
      divisionBasisPoints: 0,
    };
  }
  const activeRate = (account: DivisionAccount | null): number => {
    if (!account || account.divisionStatus !== 1 || account.divisionEndTime <= input.now) return 0;
    if (!Number.isSafeInteger(account.divisionPercent) || account.divisionPercent < 0 || account.divisionPercent > 100) {
      throw new Error(`用户 ${account.uid} 的事业部分佣比例无效`);
    }
    return account.divisionPercent * 100;
  };
  let one = input.baseOneBasisPoints;
  let two = input.baseTwoBasisPoints;
  let staff = 0;
  let agent = 0;
  let division = 0;
  const buyer = input.buyer;

  if (buyer.divisionType === 1) {
    one = 0;
    two = 0;
    division = input.selfBrokerage ? activeRate(buyer) : 0;
  } else if (buyer.divisionType === 2) {
    one = 0;
    two = 0;
    agent = input.selfBrokerage ? activeRate(buyer) : 0;
    division = activeRate(input.division) - agent;
  } else if (buyer.divisionType === 3) {
    one = 0;
    two = 0;
    staff = input.selfBrokerage ? activeRate(buyer) : 0;
    agent = activeRate(input.agent) - staff;
    division = activeRate(input.division) - staff - agent;
  } else if (buyer.staffId > 0) {
    if (buyer.staffId === buyer.spreadUid) {
      one = input.selfBrokerage ? input.baseOneBasisPoints : 0;
      two = 0;
    } else {
      one = input.baseOneBasisPoints;
      two = input.firstSpreadParentUid === buyer.staffId && !input.selfBrokerage
        ? 0
        : input.baseTwoBasisPoints;
    }
    const storeRates = one + two;
    staff = activeRate(input.staff) - storeRates;
    agent = activeRate(input.agent) - storeRates - staff;
    division = activeRate(input.division) - storeRates - staff - agent;
  } else if (buyer.agentId > 0) {
    if (buyer.agentId === buyer.spreadUid) {
      one = input.selfBrokerage ? input.baseOneBasisPoints : 0;
      two = 0;
    } else {
      one = input.baseOneBasisPoints;
      two = input.firstSpreadParentUid === buyer.agentId && !input.selfBrokerage
        ? 0
        : input.baseTwoBasisPoints;
    }
    const storeRates = one + two;
    agent = activeRate(input.agent) - storeRates;
    division = activeRate(input.division) - storeRates - agent;
  } else if (buyer.divisionId > 0) {
    if (buyer.divisionId === buyer.spreadUid) {
      one = input.selfBrokerage ? input.baseOneBasisPoints : 0;
      two = 0;
    } else {
      one = input.baseOneBasisPoints;
      two = input.firstSpreadParentUid === buyer.divisionId && !input.selfBrokerage
        ? 0
        : input.baseTwoBasisPoints;
    }
    division = activeRate(input.division) - one - two;
  }
  return {
    oneBasisPoints: Math.max(one, 0),
    twoBasisPoints: Math.max(two, 0),
    staffBasisPoints: Math.max(staff, 0),
    agentBasisPoints: Math.max(agent, 0),
    divisionBasisPoints: Math.max(division, 0),
  };
}

export async function buildOrderBrokerageSnapshot(
  container: Container,
  env: SystemConfigEnv,
  input: {
    orderType: number;
    buyer: typeof user.$inferSelect;
    items: BrokerageOrderItem[];
    actualProductCents: number;
  },
): Promise<OrderBrokerageSnapshot> {
  const empty = {
    spreadUid: 0,
    spreadTwoUid: 0,
    oneBrokerageCents: 0,
    twoBrokerageCents: 0,
    divisionId: input.buyer.divisionId,
    divisionBrokerageCents: 0,
    divisionAgentId: input.buyer.agentId,
    divisionAgentBrokerageCents: 0,
    divisionStaffId: input.buyer.staffId,
    divisionStaffBrokerageCents: 0,
  };
  if (input.orderType !== 0) return empty;
  const values = await new SystemConfigService(container, env).getMany([...BROKERAGE_CONFIG_KEYS]);
  if (parseConfigInteger(values.brokerage_func_status, 0) !== 1) return empty;

  const selfBrokerage = parseConfigInteger(values.is_self_brokerage, 0) === 1;
  const spreadCandidate = selfBrokerage ? input.buyer.uid : input.buyer.spreadUid;
  const first = spreadCandidate <= 0 || (!selfBrokerage && spreadCandidate === input.buyer.uid)
    ? null
    : spreadCandidate === input.buyer.uid
    ? input.buyer
    : await loadUser(container, spreadCandidate);
  const spreadUid = first?.uid ?? 0;

  const twoLevels = parseConfigInteger(values.brokerage_level, 2) === 2;
  const spreadTwoUid = twoLevels ? (first?.spreadUid ?? 0) : 0;
  const second = spreadTwoUid > 0 && ![input.buyer.uid, first?.uid ?? 0].includes(spreadTwoUid)
    ? await loadUser(container, spreadTwoUid)
    : null;
  const normalizedTwoUid = second?.uid ?? 0;
  const mode = parseConfigInteger(values.store_brokerage_statu, 1);
  const thresholdCents = decimalToCents(values.store_brokerage_price || "0");
  const [oneEligible, twoEligible] = await Promise.all([
    first ? isEligiblePromoter(container.db, first, mode, thresholdCents) : false,
    second ? isEligiblePromoter(container.db, second, mode, thresholdCents) : false,
  ]);

  const [firstLevel, secondLevel] = await Promise.all([
    first ? loadLevel(container, first.agentLevel) : null,
    second ? loadLevel(container, second.agentLevel) : null,
  ]);
  const oneBasisPoints = applyBrokerageUplift(
    parsePercentBasisPoints(values.store_brokerage_ratio || "0", "一级返佣比例"),
    firstLevel?.oneBrokerage ?? 0,
  );
  const twoBasisPoints = applyBrokerageUplift(
    parsePercentBasisPoints(values.store_brokerage_two || "0", "二级返佣比例"),
    secondLevel?.twoBrokerage ?? 0,
  );
  const rawComputeType = parseConfigInteger(values.brokerage_compute_type, 1);
  const computeType: 1 | 2 | 3 = rawComputeType === 2 || rawComputeType === 3 ? rawComputeType : 1;
  const relationIds = [...new Set([
    input.buyer.staffId,
    input.buyer.agentId,
    input.buyer.divisionId,
  ].filter((uid) => uid > 0 && uid !== input.buyer.uid))];
  const relationAccounts = relationIds.length
    ? await container.db.select().from(user).where(inArray(user.uid, relationIds))
    : [];
  const relationById = new Map(relationAccounts.map((account) => [account.uid, account]));
  const getRelation = (uid: number): DivisionAccount | null => {
    if (uid <= 0) return null;
    if (uid === input.buyer.uid) return input.buyer;
    return relationById.get(uid) ?? null;
  };
  const divisionRates = calculateDivisionBrokerageRates({
    enabled: parseConfigInteger(values.division_status, 1) === 1,
    selfBrokerage,
    now: Math.floor(Date.now() / 1000),
    baseOneBasisPoints: oneBasisPoints,
    baseTwoBasisPoints: twoBasisPoints,
    buyer: input.buyer,
    firstSpreadParentUid: first?.spreadUid ?? 0,
    staff: getRelation(input.buyer.staffId),
    agent: getRelation(input.buyer.agentId),
    division: getRelation(input.buyer.divisionId),
  });
  const brokerage = calculateOrderBrokerage({
    items: input.items,
    actualProductCents: input.actualProductCents,
    computeType,
    oneBasisPoints: divisionRates.oneBasisPoints,
    twoBasisPoints: divisionRates.twoBasisPoints,
    staffBasisPoints: divisionRates.staffBasisPoints,
    agentBasisPoints: divisionRates.agentBasisPoints,
    divisionBasisPoints: divisionRates.divisionBasisPoints,
    oneEligible,
    twoEligible,
  });
  return {
    spreadUid,
    spreadTwoUid: normalizedTwoUid,
    oneBrokerageCents: brokerage.oneCents,
    twoBrokerageCents: brokerage.twoCents,
    divisionId: input.buyer.divisionId,
    divisionBrokerageCents: brokerage.divisionCents,
    divisionAgentId: input.buyer.agentId,
    divisionAgentBrokerageCents: brokerage.agentCents,
    divisionStaffId: input.buyer.staffId,
    divisionStaffBrokerageCents: brokerage.staffCents,
  };
}

export async function settleOrderBrokerage(
  tx: DbClient,
  order: Pick<
    typeof storeOrder.$inferSelect,
    | "id"
    | "uid"
    | "orderId"
    | "type"
    | "payPrice"
    | "spreadUid"
    | "spreadTwoUid"
    | "oneBrokerage"
    | "twoBrokerage"
    | "divisionId"
    | "divisionBrokerage"
    | "divisionAgentId"
    | "divisionAgentBrokerage"
    | "divisionStaffId"
    | "divisionStaffBrokerage"
  >,
  now: number,
  settlementConfig: BrokerageSettlementConfig,
): Promise<void> {
  if (order.type !== 0 || !settlementConfig.enabled) return;
  const receivers = [
    order.spreadUid > 0 && decimalToCents(order.oneBrokerage) > 0
      ? {
          uid: order.spreadUid,
          cents: decimalToCents(order.oneBrokerage),
          type: order.spreadUid === order.uid ? "self_brokerage" : "one_brokerage",
          title: order.spreadUid === order.uid ? "获得自购订单佣金" : "获得下级推广订单佣金",
          requiresPromoter: true,
        }
      : null,
    order.spreadTwoUid > 0 && decimalToCents(order.twoBrokerage) > 0
      ? { uid: order.spreadTwoUid, cents: decimalToCents(order.twoBrokerage), type: "two_brokerage", title: "获得推广订单佣金", requiresPromoter: true }
      : null,
    order.divisionStaffId > 0 && decimalToCents(order.divisionStaffBrokerage) > 0
      ? { uid: order.divisionStaffId, cents: decimalToCents(order.divisionStaffBrokerage), type: "staff_brokerage", title: "获得员工推广订单佣金", requiresPromoter: false }
      : null,
    order.divisionAgentId > 0 && decimalToCents(order.divisionAgentBrokerage) > 0
      ? { uid: order.divisionAgentId, cents: decimalToCents(order.divisionAgentBrokerage), type: "agent_brokerage", title: "获得代理推广订单佣金", requiresPromoter: false }
      : null,
    order.divisionId > 0 && decimalToCents(order.divisionBrokerage) > 0
      ? { uid: order.divisionId, cents: decimalToCents(order.divisionBrokerage), type: "division_brokerage", title: "获得区域代理推广订单佣金", requiresPromoter: false }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);
  if (!receivers.length) return;

  const userIds = [...new Set(receivers.map((item) => item.uid))].sort((a, b) => a - b);
  const accounts = await tx
    .select()
    .from(user)
    .where(inArray(user.uid, userIds))
    .orderBy(asc(user.uid))
    .for("update");
  const byId = new Map(accounts.map((account) => [account.uid, account]));
  const currentBalance = new Map(accounts.map((account) => [account.uid, decimalToCents(account.brokeragePrice)]));
  const eligibility = new Map<number, boolean>();
  const normalizedDays = Math.max(0, Math.min(Math.trunc(settlementConfig.frozenDays), 180));
  for (const receiver of receivers) {
    const account = byId.get(receiver.uid);
    if (!account) continue;
    if (receiver.requiresPromoter) {
      let eligible = eligibility.get(receiver.uid);
      if (eligible === undefined) {
        eligible = await isEligiblePromoter(
          tx,
          account,
          settlementConfig.mode,
          settlementConfig.thresholdCents,
        );
        eligibility.set(receiver.uid, eligible);
      }
      if (!eligible) continue;
    }
    const balanceCents = (currentBalance.get(receiver.uid) ?? 0) + receiver.cents;
    const inserted = await tx
      .insert(userBrokerage)
      .values({
        uid: receiver.uid,
        linkId: String(order.id),
        pm: 1,
        title: receiver.title,
        category: receiver.type,
        type: receiver.type,
        number: centsToDecimal(receiver.cents),
        balance: centsToDecimal(balanceCents),
        mark: `订单 ${order.orderId} 确认收货，返佣 ${centsToDecimal(receiver.cents)} 元`,
        status: 1,
        take: 1,
        frozenTime: now + normalizedDays * 86400,
        addTime: now,
      })
      .onConflictDoNothing()
      .returning({ id: userBrokerage.id });
    if (!inserted[0]) continue;
    await tx
      .update(user)
      .set({ brokeragePrice: sql`${user.brokeragePrice} + ${centsToDecimal(receiver.cents)}` })
      .where(eq(user.uid, receiver.uid));
    currentBalance.set(receiver.uid, balanceCents);
  }
}

export function targetBrokerageReversal(
  incomeCents: number,
  cumulativeRefundCents: number,
  payCents: number,
): number {
  if (!Number.isSafeInteger(incomeCents) || incomeCents < 0) throw new Error("入账佣金无效");
  if (!Number.isSafeInteger(cumulativeRefundCents) || cumulativeRefundCents < 0) {
    throw new Error("累计退款金额无效");
  }
  if (!Number.isSafeInteger(payCents) || payCents <= 0) throw new Error("订单实付金额无效");
  if (cumulativeRefundCents >= payCents) return incomeCents;
  const product = incomeCents * cumulativeRefundCents;
  if (!Number.isSafeInteger(product)) throw new Error("退佣计算超出安全范围");
  return Math.floor(product / payCents);
}

/** 按累计退款比例回退已入账佣金；多次部分退款只扣本次增量。 */
export async function reverseOrderBrokerage(
  tx: DbClient,
  order: Pick<typeof storeOrder.$inferSelect, "id" | "orderId" | "payPrice">,
  cumulativeRefundCents: number,
  now: number,
): Promise<void> {
  const payCents = decimalToCents(order.payPrice);
  if (payCents <= 0 || cumulativeRefundCents <= 0) return;
  const linkId = String(order.id);
  const incomeTypes = [
    "self_brokerage",
    "one_brokerage",
    "two_brokerage",
    "staff_brokerage",
    "agent_brokerage",
    "division_brokerage",
  ];
  const incomes = await tx
    .select()
    .from(userBrokerage)
    .where(
      and(
        eq(userBrokerage.linkId, linkId),
        eq(userBrokerage.pm, 1),
        inArray(userBrokerage.type, incomeTypes),
        eq(userBrokerage.status, 1),
      ),
    )
    .orderBy(asc(userBrokerage.uid), asc(userBrokerage.id));
  if (!incomes.length) return;
  const refunds = await tx
    .select({
      uid: userBrokerage.uid,
      number: userBrokerage.number,
      sourceType: userBrokerage.sourceType,
    })
    .from(userBrokerage)
    .where(
      and(
        eq(userBrokerage.linkId, linkId),
        eq(userBrokerage.pm, 0),
        eq(userBrokerage.type, "refund"),
        eq(userBrokerage.status, 1),
      ),
    );
  const reversedByKey = new Map<string, number>();
  const legacyReversedByUid = new Map<number, number>();
  for (const refund of refunds) {
    const cents = decimalToCents(refund.number);
    if (refund.sourceType) {
      const key = `${refund.uid}:${refund.sourceType}`;
      reversedByKey.set(key, (reversedByKey.get(key) ?? 0) + cents);
    } else {
      legacyReversedByUid.set(
        refund.uid,
        (legacyReversedByUid.get(refund.uid) ?? 0) + cents,
      );
    }
  }
  const userIds = [...new Set(incomes.map((income) => income.uid))].sort((a, b) => a - b);
  const accounts = await tx
    .select()
    .from(user)
    .where(inArray(user.uid, userIds))
    .orderBy(asc(user.uid))
    .for("update");
  const byId = new Map(accounts.map((account) => [account.uid, account]));
  const currentBalance = new Map(accounts.map((account) => [account.uid, decimalToCents(account.brokeragePrice)]));
  for (const income of incomes) {
    const incomeCents = decimalToCents(income.number);
    const target = targetBrokerageReversal(incomeCents, cumulativeRefundCents, payCents);
    const key = `${income.uid}:${income.type}`;
    const explicitPrevious = reversedByKey.get(key) ?? 0;
    const legacyAvailable = legacyReversedByUid.get(income.uid) ?? 0;
    const legacyPrevious = Math.min(legacyAvailable, Math.max(incomeCents - explicitPrevious, 0));
    if (legacyPrevious > 0) {
      legacyReversedByUid.set(income.uid, legacyAvailable - legacyPrevious);
    }
    const previous = explicitPrevious + legacyPrevious;
    const delta = Math.max(target - previous, 0);
    const account = byId.get(income.uid);
    if (!account || delta <= 0) continue;
    const available = currentBalance.get(income.uid) ?? 0;
    const deduction = Math.min(delta, available);
    if (deduction <= 0) continue;
    const balance = available - deduction;
    await tx.update(user).set({ brokeragePrice: centsToDecimal(balance) }).where(eq(user.uid, income.uid));
    await tx.insert(userBrokerage).values({
      uid: income.uid,
      linkId,
      pm: 0,
      title: "退款退佣金",
      category: "refund",
      type: "refund",
      sourceType: income.type,
      number: centsToDecimal(deduction),
      balance: centsToDecimal(balance),
      mark: `订单 ${order.orderId} 累计退款，扣除佣金 ${centsToDecimal(deduction)} 元`,
      status: 1,
      take: 1,
      frozenTime: 0,
      addTime: now,
    });
    currentBalance.set(income.uid, balance);
    reversedByKey.set(key, explicitPrevious + deduction);
    if (target >= incomeCents) {
      await tx.update(userBrokerage).set({ frozenTime: 0 }).where(eq(userBrokerage.id, income.id));
    }
  }
}

export async function loadOrderReceiptSettlementContext(
  container: Container,
  env: SystemConfigEnv,
  frozenDays?: number,
): Promise<OrderReceiptSettlementContext> {
  const [values, rewardConfig] = await Promise.all([
    new SystemConfigService(container, env).getMany([
      "extract_time",
      "brokerage_func_status",
      "store_brokerage_statu",
      "store_brokerage_price",
    ]),
    loadOrderRewardConfig(container, env),
  ]);
  const mode = parseConfigInteger(values.store_brokerage_statu, 1);
  return {
    brokerage: {
      enabled: parseConfigInteger(values.brokerage_func_status, 0) === 1,
      mode,
      thresholdCents: mode === 3 ? decimalToCents(values.store_brokerage_price || "0") : 0,
      frozenDays: frozenDays ?? parseConfigInteger(values.extract_time, 0),
    },
    rewards: rewardConfig,
  };
}

/**
 * Finalize a row that has already been changed to status=2 inside the caller's transaction.
 * The caller must hold lockOrderSettlement() and must pass the locked, post-update row.
 */
export async function settleCompletedOrderInTx(
  tx: DbClient,
  order: typeof storeOrder.$inferSelect,
  context: OrderReceiptSettlementContext,
  now: number,
  message: string,
): Promise<void> {
  await lockOrderSettlementUsers(tx, order);
  await settleSupplierPayment(tx, order.supplierId, order.orderId, now);
  await settleOrderRewards(tx, order, context.rewards, now);
  await settleOrderBrokerage(tx, order, now, context.brokerage);
  const cumulativeRefundCents = decimalToCents(order.refundPrice);
  if (cumulativeRefundCents > 0) {
    await reverseOrderRewards(tx, order, cumulativeRefundCents, now);
    await reverseOrderBrokerage(tx, order, cumulativeRefundCents, now);
  }
  await tx.insert(storeOrderStatus).values({
    oid: order.id,
    changeType: "take_delivery",
    changeMessage: message,
    changeTime: now,
  });
}

export async function completeOrderReceipt(
  container: Container,
  env: SystemConfigEnv,
  input: {
    orderId: number;
    actor: "user" | "supplier" | "scheduled";
    actorId?: number;
    expectedStoreId?: number;
    requireSystemVisible?: boolean;
    message: string;
    frozenDays?: number;
  },
): Promise<boolean> {
  const settlementContext = await loadOrderReceiptSettlementContext(
    container,
    env,
    input.frozenDays,
  );
  return withTx(container, async (tx) => {
    await lockOrderSettlement(tx, input.orderId);
    const conditions: SQL[] = [
      eq(storeOrder.id, input.orderId),
      eq(storeOrder.paid, 1),
      eq(storeOrder.status, 1),
      sql`${storeOrder.pid} <> -1`,
      sql`${storeOrder.supplierAllocationStatus} <> 1`,
      ne(storeOrder.shippingType, 2),
      ne(storeOrder.deliveryType, "send"),
      inArray(storeOrder.refundStatus, [0, 3]),
    ];
    if (input.actor === "user") {
      conditions.push(eq(storeOrder.uid, input.actorId ?? 0), eq(storeOrder.isDel, 0));
    } else if (input.actor === "supplier") {
      conditions.push(eq(storeOrder.supplierId, input.actorId ?? 0), eq(storeOrder.isSystemDel, 0));
    } else {
      conditions.push(eq(storeOrder.isDel, 0));
    }
    if (input.expectedStoreId !== undefined) {
      conditions.push(eq(storeOrder.storeId, input.expectedStoreId));
    }
    if (input.requireSystemVisible) {
      conditions.push(eq(storeOrder.isSystemDel, 0));
    }
    const updated = await tx
      .update(storeOrder)
      .set({ status: 2 })
      .where(and(...conditions))
      .returning();
    const order = updated[0];
    if (!order) return false;
    const now = Math.floor(Date.now() / 1000);
    await settleCompletedOrderInTx(tx, order, settlementContext, now, input.message);
    return true;
  });
}

async function loadUser(container: Container, uid: number) {
  const rows = await container.db.select().from(user).where(eq(user.uid, uid)).limit(1);
  return rows[0] ?? null;
}

async function loadLevel(container: Container, id: number) {
  if (id <= 0) return null;
  const rows = await container.db
    .select()
    .from(agentLevel)
    .where(and(eq(agentLevel.id, id), eq(agentLevel.status, 1), eq(agentLevel.isDel, 0)))
    .limit(1);
  return rows[0] ?? null;
}

async function isEligiblePromoter(
  db: DbClient,
  candidate: typeof user.$inferSelect,
  mode: number,
  thresholdCents: number,
): Promise<boolean> {
  if (candidate.status !== 1 || candidate.spreadOpen !== 1) return false;
  if (candidate.isPromoter === 1 || mode === 2) return true;
  if (mode !== 3) return false;
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${storeOrder.payPrice}), 0)::numeric(14,2)` })
    .from(storeOrder)
    .where(
      and(
        eq(storeOrder.uid, candidate.uid),
        sql`${storeOrder.pid} <> -1`,
        eq(storeOrder.paid, 1),
        eq(storeOrder.isDel, 0),
        inArray(storeOrder.refundStatus, [0, 3]),
      ),
    );
  return decimalToCents(rows[0]?.total ?? "0") > thresholdCents;
}

export function decimalToCents(value: string | number): number {
  const normalized = normalizeConfigScalar(String(value));
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error("金额格式无效");
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("金额超出安全范围");
  return cents;
}

export function centsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("金额分值无效");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
