import type { storeOrder, storePink } from '@/models/schema';

export const MAX_PINK_PEOPLE = 500;

export function validPinkPeople(people: number): boolean {
  return Number.isSafeInteger(people) && people >= 2 && people <= MAX_PINK_PEOPLE;
}

/** PHP bcdiv(count, people, 2) * 100 truncates, rather than rounds. New
 * configurations require 1..100; invalid legacy values never authorize success. */
export function reachesPinkVirtualThreshold(realPeople: number, people: number, virtual: number): boolean {
  return validPinkPeople(people) && Number.isSafeInteger(realPeople) && realPeople > 0 && realPeople <= people
    && Number.isSafeInteger(virtual) && virtual >= 1 && virtual <= 100
    && Math.floor(realPeople * 100 / people) >= virtual;
}

/** Both populated legacy identity fields must agree. An OR-only join can bind
 * one member to multiple orders or count a conflicting historical identity. */
export function validPinkPaidIdentity(
  member: typeof storePink.$inferSelect,
  order: typeof storeOrder.$inferSelect,
  leader: typeof storePink.$inferSelect,
): boolean {
  const numberPresent = member.orderId !== '' && member.orderId !== '0';
  const keyPresent = member.orderIdKey !== '' && member.orderIdKey !== '0';
  return member.uid > 0 && member.isVirtual === 0 && member.isRefund === 0 && member.status === 1
    && member.combinationId === leader.combinationId && member.productId === leader.productId
    && member.people === leader.people && (member.id === leader.id || member.kId === leader.id)
    && order.uid === member.uid && order.type === 3 && order.activityId === leader.combinationId
    && order.pinkId === leader.id && order.paid === 1 && order.isDel === 0 && order.isSystemDel === 0
    && [0, 3].includes(order.refundStatus)
    && (numberPresent || keyPresent)
    && (!numberPresent || member.orderId === order.orderId)
    && (!keyPresent || member.orderIdKey === String(order.id) || member.orderIdKey === order.unique);
}
