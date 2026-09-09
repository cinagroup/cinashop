import type { CheckoutQuoteOptions } from "./checkoutQuote";

export interface CheckoutSubmission extends CheckoutQuoteOptions {
  /** Optional only when decoding an old unresolved submission for idempotent replay. */
  quoteToken?: string;
  cartIds: number[];
  realName?: string;
  userPhone?: string;
  mark: string;
  customForm: unknown[];
}
export interface CheckoutIntent { version: 1; uid: number; key: string; payload: CheckoutSubmission; orderId?: string }
export interface IntentStorage { get(key: string): unknown; set(key: string, value: string): void; remove(key: string): void }
export const checkoutIntentStorageKey = (uid: number) => `cinashop_checkout_pending_v1_${uid}`;
const keyPattern = /^[A-Za-z0-9_-]{8,64}$/;
const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegative = (value: unknown) => value === 0 || positive(value);

/** Invalid saved data is a blocker, never permission to create a second intent. */
export function decodeCheckoutIntent(value: unknown, uid: number): CheckoutIntent {
  if (typeof value !== "string" || value.length > 1_100_000) throw new Error("待确认订单记录不可读，请先核对订单列表");
  let record: CheckoutIntent;
  try { record = JSON.parse(value) as CheckoutIntent; }
  catch { throw new Error("待确认订单记录不可读，请先核对订单列表"); }
  const p = record?.payload;
  const fields = ["quoteToken", "cartIds", "addressId", "shippingType", "storeId", "couponId", "useIntegral", "type", "pinkId", "combinationId", "seckillId", "bargainUserId", "realName", "userPhone", "mark", "customForm"];
  if (record?.version !== 1 || !positive(uid) || record.uid !== uid || typeof record.key !== "string" || !keyPattern.test(record.key)
    || !p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((field) => !fields.includes(field))
    || !Array.isArray(p.cartIds) || !p.cartIds.length || p.cartIds.length > 100 || !p.cartIds.every(positive)
    || new Set(p.cartIds).size !== p.cartIds.length || ![1, 2].includes(p.shippingType)
    || !nonnegative(p.addressId) || !nonnegative(p.storeId) || !nonnegative(p.couponId) || !nonnegative(p.type)
    || typeof p.useIntegral !== "boolean" || typeof p.mark !== "string" || p.mark.length > 200 || !Array.isArray(p.customForm) || p.customForm.length > 100
    || [p.pinkId, p.combinationId, p.seckillId, p.bargainUserId].some((id) => id !== undefined && !nonnegative(id))
    || [p.realName, p.userPhone].some((v) => v !== undefined && typeof v !== "string")
    || (p.quoteToken !== undefined && (typeof p.quoteToken !== 'string' || !/^[a-f0-9]{32}$/.test(p.quoteToken)))
    || (record.orderId !== undefined && (typeof record.orderId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(record.orderId)))) {
    throw new Error("待确认订单记录无效，请先核对订单列表");
  }
  return record;
}

export class CheckoutIntentJournal {
  constructor(private readonly storage: IntentStorage) {}
  read(uid: number): CheckoutIntent | null {
    if (!positive(uid)) throw new Error("请先登录");
    const raw = this.storage.get(checkoutIntentStorageKey(uid));
    return raw === undefined || raw === null || raw === "" ? null : decodeCheckoutIntent(raw, uid);
  }
  private save(intent: CheckoutIntent) {
    const json = JSON.stringify(intent);
    decodeCheckoutIntent(json, intent.uid);
    const key = checkoutIntentStorageKey(intent.uid);
    this.storage.set(key, json);
    if (this.storage.get(key) !== json) throw new Error("无法保存待确认订单，尚未发送新请求");
    return decodeCheckoutIntent(json, intent.uid);
  }
  begin(uid: number, key: string, payload: CheckoutSubmission) {
    if (this.read(uid)) throw new Error("已有待确认订单，请先确认结果");
    return this.save({ version: 1, uid, key, payload });
  }
  assertCurrent(intent: CheckoutIntent) {
    const current = this.read(intent.uid);
    if (!current || current.key !== intent.key || JSON.stringify(current.payload) !== JSON.stringify(intent.payload)) throw new Error("待确认订单已变化，请重新打开结算页");
    return current;
  }
  settled(intent: CheckoutIntent, result: unknown) {
    const current = this.assertCurrent(intent);
    const value = result as { orderId?: unknown; key?: unknown } | null;
    if (!value || value.key !== intent.key || typeof value.orderId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(value.orderId)) throw new Error("订单结果无效，请重试确认");
    return this.save({ ...current, orderId: value.orderId });
  }
  /** Caller must have either a validated order result or a definitive first-attempt rejection. */
  clear(intent: CheckoutIntent) {
    this.assertCurrent(intent);
    this.storage.remove(checkoutIntentStorageKey(intent.uid));
    if (this.read(intent.uid)) throw new Error("待确认订单记录未能清除");
  }
}
