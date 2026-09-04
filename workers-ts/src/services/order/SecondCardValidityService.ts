import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "@/lib/di";
import { storeOrderCartInfo } from "@/models/schema";

const SECOND_CARD_PRODUCT_TYPE = 4;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const SECONDS_PER_DAY = 86_400;

export interface SecondCardValiditySnapshot {
  writeValid: 1 | 2 | 3;
  writeDays: number;
  writeStart: number;
  writeEnd: number;
}

export interface SecondCardValidityWindow {
  writeStart: number;
  writeEnd: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function firstInteger(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    return integer(source[key]);
  }
  return null;
}

/**
 * Read both the current Worker snapshot and the historical PHP order snapshot.
 * Returning null is deliberate: old rows without enough immutable evidence must
 * keep their already-persisted window instead of consulting a mutable live SKU.
 */
export function parseSecondCardValiditySnapshot(value: string | null): SecondCardValiditySnapshot | null {
  if (!value) return null;
  let root: Record<string, unknown> | null;
  try {
    root = record(JSON.parse(value));
  } catch {
    return null;
  }
  if (!root) return null;
  const current = record(root.sku);
  const productInfo = record(root.productInfo ?? root.product_info);
  const legacy = productInfo ? record(productInfo.attrInfo ?? productInfo.attr_info) : null;
  const source = current ?? legacy;
  if (!source) return null;

  const writeValid = firstInteger(source, "write_valid", "writeValid");
  const writeDays = firstInteger(source, "write_days", "writeDays", "days") ?? 0;
  const writeStart = firstInteger(source, "write_start", "writeStart") ?? 0;
  const writeEnd = firstInteger(source, "write_end", "writeEnd") ?? 0;
  if (writeValid !== 1 && writeValid !== 2 && writeValid !== 3) return null;
  if (writeDays < 0 || writeStart < 0 || writeEnd < 0) return null;
  return { writeValid, writeDays, writeStart, writeEnd };
}

export function resolveSecondCardValidityAtCheckout(
  snapshot: SecondCardValiditySnapshot,
): SecondCardValidityWindow {
  if (snapshot.writeValid === 1) return { writeStart: 0, writeEnd: 0 };
  if (snapshot.writeValid === 2) {
    if (snapshot.writeDays <= 0) throw new Error("次卡购买后有效天数无效");
    return { writeStart: 0, writeEnd: 0 };
  }
  if (
    snapshot.writeStart <= 0
    || snapshot.writeEnd <= snapshot.writeStart
    || snapshot.writeEnd > MAX_POSTGRES_INTEGER
  ) {
    throw new Error("次卡固定有效期无效");
  }
  return { writeStart: snapshot.writeStart, writeEnd: snapshot.writeEnd };
}

export function resolveSecondCardValidityAtPayment(
  snapshot: SecondCardValiditySnapshot | null,
  paidAt: number,
  persisted: SecondCardValidityWindow,
): SecondCardValidityWindow {
  if (!Number.isSafeInteger(paidAt) || paidAt <= 0 || paidAt > MAX_POSTGRES_INTEGER) {
    throw new Error("次卡支付时间无效");
  }
  if (
    persisted.writeStart < 0
    || persisted.writeEnd < 0
    || (persisted.writeStart === 0) !== (persisted.writeEnd === 0)
  ) {
    throw new Error("次卡历史有效期无效");
  }
  if (!snapshot) {
    if (persisted.writeStart > 0 && persisted.writeEnd <= persisted.writeStart) {
      throw new Error("次卡历史有效期无效");
    }
    return persisted;
  }
  if (snapshot.writeValid === 1) return { writeStart: 0, writeEnd: 0 };
  if (snapshot.writeValid === 3) return resolveSecondCardValidityAtCheckout(snapshot);
  if (persisted.writeStart > 0) {
    if (persisted.writeEnd <= persisted.writeStart) throw new Error("次卡历史有效期无效");
    return persisted;
  }
  if (snapshot.writeDays <= 0) throw new Error("次卡购买后有效天数无效");
  const writeEnd = paidAt + snapshot.writeDays * SECONDS_PER_DAY;
  if (!Number.isSafeInteger(writeEnd) || writeEnd > MAX_POSTGRES_INTEGER) {
    throw new Error("次卡有效期超过安全范围");
  }
  return { writeStart: paidAt, writeEnd };
}

/** Activate every second-card line after Supplier allocation, in the paid outbox transaction. */
export async function activatePaidSecondCardValidity(
  tx: DbClient,
  fulfillmentOrders: readonly { id: number; paid: number }[],
  paidAt: number,
): Promise<{ matched: number; changed: number }> {
  const orderIds = [...new Set(fulfillmentOrders.map((order) => order.id))].sort((a, b) => a - b);
  if (!orderIds.length) return { matched: 0, changed: 0 };
  if (fulfillmentOrders.some((order) => order.paid !== 1)) {
    throw new Error("次卡有效期只能在已支付履约订单上激活");
  }
  const rows = await tx
    .select({
      id: storeOrderCartInfo.id,
      cartInfo: storeOrderCartInfo.cartInfo,
      writeStart: storeOrderCartInfo.writeStart,
      writeEnd: storeOrderCartInfo.writeEnd,
    })
    .from(storeOrderCartInfo)
    .where(and(
      inArray(storeOrderCartInfo.oid, orderIds),
      eq(storeOrderCartInfo.productType, SECOND_CARD_PRODUCT_TYPE),
    ))
    .orderBy(asc(storeOrderCartInfo.id))
    .for("update");

  let changed = 0;
  for (const row of rows) {
    const window = resolveSecondCardValidityAtPayment(
      parseSecondCardValiditySnapshot(row.cartInfo),
      paidAt,
      { writeStart: row.writeStart, writeEnd: row.writeEnd },
    );
    if (window.writeStart === row.writeStart && window.writeEnd === row.writeEnd) continue;
    const updated = await tx
      .update(storeOrderCartInfo)
      .set(window)
      .where(and(
        eq(storeOrderCartInfo.id, row.id),
        eq(storeOrderCartInfo.productType, SECOND_CARD_PRODUCT_TYPE),
        eq(storeOrderCartInfo.writeStart, row.writeStart),
        eq(storeOrderCartInfo.writeEnd, row.writeEnd),
      ))
      .returning({ id: storeOrderCartInfo.id });
    if (!updated[0]) throw new Error("次卡有效期发生并发变化");
    changed += 1;
  }
  return { matched: rows.length, changed };
}
