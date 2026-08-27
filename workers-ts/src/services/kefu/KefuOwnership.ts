import { and, eq, exists, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeServiceRecord } from "@/models/schema";
import { NotFoundException, ValidateException } from "@/utils/errors";

export const KEFU_CHAT_LOCK_NAMESPACE = 91_310_002;
export const KEFU_TRANSFER_LOCK_NAMESPACE = 91_310_003;
export const KEFU_ORDER_LOCK_NAMESPACE = 91_310_005;

function positiveIdentity(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

export function ownedKefuConversation(
  db: DbClient,
  kefuUid: number,
  customerUid: number | SQLWrapper,
) {
  return exists(db
    .select({ id: storeServiceRecord.id })
    .from(storeServiceRecord)
    .where(and(
      eq(storeServiceRecord.userId, kefuUid),
      eq(storeServiceRecord.toUid, customerUid),
      eq(storeServiceRecord.isTourist, 0),
    )));
}

export async function assertKefuConversationOwnership(
  db: DbClient,
  kefuUidValue: unknown,
  customerUidValue: unknown,
): Promise<void> {
  const kefuUid = positiveIdentity(kefuUidValue, "客服身份");
  const customerUid = positiveIdentity(customerUidValue, "客户身份");
  const rows = await db
    .select({ id: storeServiceRecord.id })
    .from(storeServiceRecord)
    .where(and(
      eq(storeServiceRecord.userId, kefuUid),
      eq(storeServiceRecord.toUid, customerUid),
      eq(storeServiceRecord.isTourist, 0),
    ))
    .limit(2);
  if (rows.length !== 1) throw new NotFoundException("订单不存在或不属于当前会话");
}

/**
 * Keep the transfer lock before the per-conversation lock. A caller must take
 * these locks before any order/settlement row lock so transfer and order writes
 * cannot deadlock or authorize an agent after ownership moved.
 */
export async function lockKefuConversationOwnership(
  db: DbClient,
  kefuUidValue: unknown,
  customerUidValue: unknown,
): Promise<void> {
  const kefuUid = positiveIdentity(kefuUidValue, "客服身份");
  const customerUid = positiveIdentity(customerUidValue, "客户身份");
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${KEFU_TRANSFER_LOCK_NAMESPACE},
      hashtext(${`kefu-transfer:user:${customerUid}`})
    )
  `);
  await db.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${KEFU_CHAT_LOCK_NAMESPACE},
      hashtext(${`kefu:${kefuUid}:user:${customerUid}`})
    )
  `);
  await assertKefuConversationOwnership(db, kefuUid, customerUid);
}
