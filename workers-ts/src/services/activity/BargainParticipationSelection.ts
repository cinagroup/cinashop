import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeBargainUser, storeCart } from "@/models/schema";
import { ValidateException } from "@/utils/errors";

export interface BargainSelection {
  /** Exact participation ID, never an activity-ID alias. */
  bargainUserId?: number;
  /** Legacy activity ID; may check the cart's activity, never choose a record. */
  bargainId?: number;
}

function optionalId(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if ((typeof value !== "number" && typeof value !== "string") || !/^(?:0|[1-9]\d{0,9})$/.test(String(value))
    || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new ValidateException("砍价身份参数无效");
  }
  // Existing checkout clients send zero for unused marketing parameters.
  return Number(value) || undefined;
}

/** Do not collapse canonical identity and the historical activity namespace. */
export function parseBargainSelection(body: Record<string, unknown>): BargainSelection {
  const aliases = (camel: string, snake: string) => {
    const a = optionalId(body[camel]), b = optionalId(body[snake]);
    if (body[camel] !== undefined && body[snake] !== undefined && a !== b) throw new ValidateException("砍价身份参数冲突");
    return a ?? b;
  };
  return { bargainUserId: aliases("bargainUserId", "bargain_user_id"), bargainId: aliases("bargainId", "bargain_id") };
}

/** Explicit: exactly this owned activity record, including closed/used for display.
 * Implicit: only one live record, never "latest wins". Callers check readiness.
 * Read-only; neither a reservation nor a participation-state transition.
 */
export async function findBargainParticipation(db: DbClient, uid: number, activityId: number, participantId?: number) {
  for (const value of [uid, activityId, ...(participantId === undefined ? [] : [participantId])]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new ValidateException("砍价身份参数无效");
  }
  const rows = await db.select().from(storeBargainUser).where(and(
    eq(storeBargainUser.uid, uid), eq(storeBargainUser.bargainId, activityId), eq(storeBargainUser.isDel, 0),
    participantId === undefined ? inArray(storeBargainUser.status, [1, 3]) : eq(storeBargainUser.id, participantId),
  )).orderBy(desc(storeBargainUser.id)).limit(2);
  if (rows.length > 1) throw new ValidateException("砍价有效记录不唯一，请重新选择参与记录并加购");
  return rows[0] ?? null;
}

export async function cartBargainParticipation(
  db: DbClient, uid: number,
  cart: Pick<typeof storeCart.$inferSelect, "uid" | "type" | "activityId" | "bargainUserId">,
  selection: BargainSelection = {},
) {
  if (cart.uid !== uid || cart.type !== 2 || !Number.isSafeInteger(cart.bargainUserId)
    || cart.bargainUserId < 0 || cart.bargainUserId > 2_147_483_647) throw new ValidateException("砍价购物车参与身份无效");
  const requested = optionalId(selection.bargainUserId), activity = optionalId(selection.bargainId);
  if (activity !== undefined && activity !== cart.activityId) throw new ValidateException("砍价购物车与活动不匹配");
  if (cart.bargainUserId > 0 && requested !== undefined && requested !== cart.bargainUserId) {
    throw new ValidateException("砍价购物车参与记录不匹配，请重新加购");
  }
  // Legacy zero remains unbound and requires a sole live record even when a
  // request supplies an ID. Never rebind an old checkout by a request parameter.
  const participant = await findBargainParticipation(db, uid, cart.activityId, cart.bargainUserId || undefined);
  if (!participant || requested !== undefined && requested !== participant.id) {
    throw new ValidateException("砍价记录不存在或与购物车不匹配");
  }
  return participant;
}
