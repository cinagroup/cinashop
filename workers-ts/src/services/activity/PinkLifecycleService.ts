import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  storeCombination,
  storeOrder,
  storePink,
  user,
} from "@/models/schema";
import type { DbClient } from "@/lib/di";
import { ValidateException } from "@/utils/errors";

export interface PinkReservation {
  leaderId: number;
  combinationId: number;
  requiredPeople: number;
  activePeople: number;
  reservedPeople: number;
}

interface PaidPinkOrder {
  id: number;
  uid: number;
  type: number;
  orderId: string;
  activityId: number;
  pinkId: number;
  totalNum: number;
  payPrice: string;
  unique: string | null;
}

interface RefundedPinkOrder extends PaidPinkOrder {
  refundStatus: number;
}

export async function assertPinkOrderPayable(
  db: DbClient,
  order: Pick<
    PaidPinkOrder,
    "id" | "uid" | "type" | "orderId" | "activityId" | "pinkId" | "unique"
  >,
  now = new Date(),
): Promise<void> {
  if (order.type !== 3) return;
  const combination = await db
    .select({ id: storeCombination.id })
    .from(storeCombination)
    .where(eq(storeCombination.id, order.activityId))
    .limit(1);
  if (!combination[0]) throw new ValidateException("拼团活动不存在");
  if (order.pinkId <= 0) return;
  const leaders = await db
    .select({
      uid: storePink.uid,
      orderId: storePink.orderId,
      orderIdKey: storePink.orderIdKey,
      combinationId: storePink.combinationId,
      status: storePink.status,
      isRefund: storePink.isRefund,
      kId: storePink.kId,
      stopTime: storePink.stopTime,
    })
    .from(storePink)
    .where(eq(storePink.id, order.pinkId))
    .limit(1);
  const leader = leaders[0];
  if (
    leader
    && leader.kId === 0
    && leader.combinationId === order.activityId
    && pinkBelongsToOrder(leader, order)
  ) {
    // Compatibility with the earlier Worker migration, which created the
    // leader row before payment and stored its id back on the unpaid order.
    // Payment activation will adopt or replace that row atomically.
    return;
  }
  if (
    !leader ||
    leader.kId !== 0 ||
    leader.status !== 1 ||
    leader.isRefund !== 0 ||
    (leader.stopTime !== null && leader.stopTime.getTime() <= now.getTime())
  ) {
    throw new ValidateException("该拼团已失效，请重新下单");
  }
}

/**
 * Reserve one join position with the unpaid order itself.
 *
 * PHP decrements a Redis counter at order creation and writes store_pink only
 * after payment. PostgreSQL keeps the same two phases without relying on an
 * ephemeral counter: active store_pink rows plus unpaid store_order rows are
 * serialized on the leader row and may never exceed the required group size.
 */
export async function reservePinkJoin(
  tx: DbClient,
  params: { uid: number; leaderId: number; combinationId: number; now?: Date },
): Promise<PinkReservation> {
  const now = params.now ?? new Date();
  const leaders = await tx
    .select()
    .from(storePink)
    .where(eq(storePink.id, params.leaderId))
    .limit(1)
    .for("update");
  const leader = leaders[0];
  if (
    !leader ||
    leader.kId !== 0 ||
    leader.status !== 1 ||
    leader.isRefund !== 0 ||
    (leader.stopTime !== null && leader.stopTime.getTime() <= now.getTime())
  ) {
    throw new ValidateException("该团已结束，请重新开团");
  }
  if (leader.combinationId !== params.combinationId) {
    throw new ValidateException("拼团信息不匹配");
  }

  const [activeRows, pendingRows, duplicatePink, duplicateOrder] = await Promise.all([
    tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(storePink)
      .where(
        and(
          or(eq(storePink.id, leader.id), eq(storePink.kId, leader.id)),
          eq(storePink.isRefund, 0),
          inArray(storePink.status, [1, 2]),
        ),
      ),
    tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.type, 3),
          eq(storeOrder.pinkId, leader.id),
          eq(storeOrder.paid, 0),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
        ),
      ),
    tx
      .select({ id: storePink.id })
      .from(storePink)
      .where(
        and(
          or(eq(storePink.id, leader.id), eq(storePink.kId, leader.id)),
          eq(storePink.uid, params.uid),
          eq(storePink.isRefund, 0),
          inArray(storePink.status, [1, 2]),
        ),
      )
      .limit(1),
    tx
      .select({ id: storeOrder.id })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.type, 3),
          eq(storeOrder.pinkId, leader.id),
          eq(storeOrder.uid, params.uid),
          eq(storeOrder.paid, 0),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
        ),
      )
      .limit(1),
  ]);
  if (duplicatePink[0]) throw new ValidateException("您已参加该拼团");
  if (duplicateOrder[0]) throw new ValidateException("您已有该团的待支付订单");

  const activePeople = Number(activeRows[0]?.count ?? 0);
  const reservedPeople = Number(pendingRows[0]?.count ?? 0);
  const requiredPeople = leader.people;
  if (requiredPeople <= 0) throw new ValidateException("拼团人数配置无效");
  if (activePeople + reservedPeople >= requiredPeople) {
    throw new ValidateException("该团名额已满");
  }
  return {
    leaderId: leader.id,
    combinationId: leader.combinationId,
    requiredPeople,
    activePeople,
    reservedPeople,
  };
}

function pinkBelongsToOrder(
  pink: { uid: number; orderId: string; orderIdKey: string },
  order: Pick<PaidPinkOrder, "id" | "uid" | "orderId" | "unique">,
): boolean {
  return pink.uid === order.uid
    && (
      (pink.orderId !== "" && pink.orderId === order.orderId)
      || pink.orderIdKey === String(order.id)
      || (pink.orderIdKey !== "" && order.unique !== null && pink.orderIdKey === order.unique)
    );
}

/** Create the public group/member row in the same transaction as paid=0 -> 1. */
export async function activatePaidPink(
  tx: DbClient,
  order: PaidPinkOrder,
  now = Math.floor(Date.now() / 1000),
): Promise<{ pinkId: number; completed: boolean } | null> {
  if (order.type !== 3 || order.activityId <= 0) return null;
  const combinations = await tx
    .select()
    .from(storeCombination)
    .where(eq(storeCombination.id, order.activityId))
    .limit(1)
    .for("key share");
  const combination = combinations[0];
  if (!combination) throw new ValidateException("拼团活动不存在");
  if (combination.people <= 0) throw new ValidateException("拼团人数配置无效");

  const users = await tx
    .select({ nickname: user.nickname, avatar: user.avatar })
    .from(user)
    .where(eq(user.uid, order.uid))
    .limit(1);
  const buyer = users[0];
  if (!buyer) throw new ValidateException("拼团用户不存在");
  const paidAt = new Date(now * 1000);

  if (order.pinkId <= 0) {
    return createPaidPinkLeader(tx, order, combination, buyer, now);
  }

  const leaders = await tx
    .select()
    .from(storePink)
    .where(eq(storePink.id, order.pinkId))
    .limit(1)
    .for("update");
  const leader = leaders[0];
  const legacyOwnLeader = leader
    && leader.kId === 0
    && leader.combinationId === combination.id
    && pinkBelongsToOrder(leader, order);
  if (
    legacyOwnLeader
    && leader.isRefund === 0
    && [1, 2].includes(leader.status)
    && (leader.stopTime === null || leader.stopTime.getTime() > paidAt.getTime())
  ) {
    const completed = combination.people <= 1;
    const stopTime = completed
      ? paidAt
      : new Date((now + Math.max(0, combination.effectiveTime) * 3600) * 1000);
    await tx
      .update(storePink)
      .set({
        uid: order.uid,
        nickname: buyer.nickname,
        avatar: buyer.avatar,
        orderId: order.orderId,
        orderIdKey: String(order.id),
        totalNum: order.totalNum,
        totalPrice: order.payPrice,
        combinationId: combination.id,
        productId: combination.productId,
        people: combination.people,
        memberCount: 1,
        price: combination.price,
        status: completed ? 2 : 1,
        stopTime,
        addTime: now,
      })
      .where(eq(storePink.id, leader.id));
    return { pinkId: leader.id, completed };
  }
  if (
    !leader ||
    leader.kId !== 0 ||
    leader.status !== 1 ||
    leader.isRefund !== 0 ||
    (leader.stopTime !== null && leader.stopTime.getTime() <= paidAt.getTime())
  ) {
    // Payment callbacks can arrive after the selected group expires or its
    // leader is refunded. The money has already moved at that point, so never
    // strand a charged order as unpaid: transparently open a fresh group.
    return createPaidPinkLeader(tx, order, combination, buyer, now);
  }
  if (leader.combinationId !== combination.id) throw new ValidateException("拼团信息不匹配");

  const duplicate = await tx
    .select({ id: storePink.id })
    .from(storePink)
    .where(
      and(
        or(eq(storePink.id, leader.id), eq(storePink.kId, leader.id)),
        eq(storePink.uid, order.uid),
        eq(storePink.isRefund, 0),
      ),
    )
    .limit(1);
  if (duplicate[0]) throw new ValidateException("您已参加该拼团");

  const activeRows = await tx
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(storePink)
    .where(
      and(
        or(eq(storePink.id, leader.id), eq(storePink.kId, leader.id)),
        eq(storePink.isRefund, 0),
        inArray(storePink.status, [1, 2]),
      ),
    );
  const people = Number(activeRows[0]?.count ?? 0) + 1;
  const requiredPeople = leader.people > 0 ? leader.people : combination.people;
  if (people > requiredPeople) throw new ValidateException("该团人数已满");
  const completed = people >= requiredPeople;
  await tx.insert(storePink).values({
    uid: order.uid,
    nickname: buyer.nickname,
    avatar: buyer.avatar,
    orderId: order.orderId,
    orderIdKey: String(order.id),
    totalNum: order.totalNum,
    totalPrice: order.payPrice,
    combinationId: combination.id,
    productId: combination.productId,
    kId: leader.id,
    people: requiredPeople,
    memberCount: 0,
    price: combination.price,
    status: completed ? 2 : 1,
    stopTime: completed ? paidAt : null,
    addTime: now,
  });
  await tx
    .update(storePink)
    .set({
      memberCount: people,
      status: completed ? 2 : 1,
      ...(completed ? { stopTime: paidAt } : {}),
    })
    .where(eq(storePink.id, leader.id));
  if (completed) {
    await tx
      .update(storePink)
      .set({ status: 2, stopTime: paidAt })
      .where(eq(storePink.kId, leader.id));
  }
  return { pinkId: leader.id, completed };
}

async function createPaidPinkLeader(
  tx: DbClient,
  order: PaidPinkOrder,
  combination: typeof storeCombination.$inferSelect,
  buyer: { nickname: string; avatar: string },
  now: number,
): Promise<{ pinkId: number; completed: boolean }> {
  const paidAt = new Date(now * 1000);
  const stopTime = new Date((now + Math.max(0, combination.effectiveTime) * 3600) * 1000);
  const completed = combination.people <= 1;
  const inserted = await tx
    .insert(storePink)
    .values({
      uid: order.uid,
      nickname: buyer.nickname,
      avatar: buyer.avatar,
      orderId: order.orderId,
      orderIdKey: String(order.id),
      totalNum: order.totalNum,
      totalPrice: order.payPrice,
      combinationId: combination.id,
      productId: combination.productId,
      kId: 0,
      people: combination.people,
      memberCount: 1,
      price: combination.price,
      status: completed ? 2 : 1,
      stopTime: completed ? paidAt : stopTime,
      addTime: now,
    })
    .returning({ id: storePink.id });
  if (!inserted[0]) throw new Error("拼团团长记录创建失败");
  await tx
    .update(storeOrder)
    .set({ pinkId: inserted[0].id })
    .where(eq(storeOrder.id, order.id));
  return { pinkId: inserted[0].id, completed };
}

/** Keep store_pink and store_order.pink_id coherent after a full paid-order refund. */
export async function reconcileRefundedPink(
  tx: DbClient,
  order: RefundedPinkOrder,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (order.type !== 3 || order.pinkId <= 0 || order.refundStatus !== 2) return;
  const rows = await tx
    .select()
    .from(storePink)
    .where(
      and(
        or(eq(storePink.id, order.pinkId), eq(storePink.kId, order.pinkId)),
        eq(storePink.uid, order.uid),
        eq(storePink.orderIdKey, String(order.id)),
      ),
    )
    .orderBy(asc(storePink.id))
    .limit(1)
    .for("update");
  const participant = rows[0];
  if (!participant || participant.isRefund !== 0) return;
  const endedAt = new Date(now * 1000);

  if (participant.kId !== 0) {
    const leaderRows = await tx
      .select()
      .from(storePink)
      .where(eq(storePink.id, participant.kId))
      .limit(1)
      .for("update");
    const leader = leaderRows[0];
    await tx
      .update(storePink)
      .set({ isRefund: participant.kId, status: 3, stopTime: endedAt })
      .where(eq(storePink.id, participant.id));
    if (leader) {
      const active = await tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(storePink)
        .where(
          and(
            or(eq(storePink.id, leader.id), eq(storePink.kId, leader.id)),
            eq(storePink.isRefund, 0),
            inArray(storePink.status, [1, 2]),
          ),
        );
      await tx
        .update(storePink)
        .set({ memberCount: Number(active[0]?.count ?? 1) })
        .where(eq(storePink.id, leader.id));
    }
    return;
  }

  // A failed/expired group stays failed; promotion only applies to a live or
  // successfully completed group whose leader voluntarily refunds.
  const members = await tx
    .select()
    .from(storePink)
    .where(and(eq(storePink.kId, participant.id), eq(storePink.isRefund, 0)))
    .orderBy(asc(storePink.addTime), asc(storePink.id))
    .for("update");
  await tx
    .update(storePink)
    .set({ isRefund: participant.id, status: 3, stopTime: endedAt })
    .where(eq(storePink.id, participant.id));
  if (participant.status === 3 || !members[0]) return;

  const nextLeader = members[0];
  const nextStatus = participant.status === 2 ? 2 : 1;
  await tx
    .update(storePink)
    .set({
      kId: 0,
      status: nextStatus,
      stopTime: participant.stopTime,
      memberCount: members.length,
    })
    .where(eq(storePink.id, nextLeader.id));
  if (members.length > 1) {
    await tx
      .update(storePink)
      .set({ kId: nextLeader.id, status: nextStatus })
      .where(
        and(
          eq(storePink.kId, participant.id),
          ne(storePink.id, nextLeader.id),
          eq(storePink.isRefund, 0),
        ),
      );
  }
  await tx
    .update(storeOrder)
    .set({ pinkId: nextLeader.id })
    .where(
      and(
        eq(storeOrder.type, 3),
        eq(storeOrder.pinkId, participant.id),
        ne(storeOrder.id, order.id),
        eq(storeOrder.isDel, 0),
      ),
    );
}
