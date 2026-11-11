/** Identity captured by the paid allocation author. Product label selections
 * deliberately remain live until the independent task executes, as in PHP.
 * These facts are stale/source fences, never caller authorization. */
import { PURCHASED_PRODUCT_LABEL_EVENT } from '@/migrations/purchasedProductLabelContract';
export { PURCHASED_PRODUCT_LABEL_EVENT } from '@/migrations/purchasedProductLabelContract';
export const PURCHASED_LABEL_MAX_CARTS = 200;
export const PURCHASED_LABEL_MAX_BYTES = 131072;
export interface PurchasedLabelCart {
  readonly rowId: number; readonly cartId: string; readonly productId: number;
  readonly productType: number; readonly ownerType: number; readonly ownerId: number;
  readonly skuUnique: string; readonly quantity: number; readonly isGift: number;
}
export interface PurchasedLabelIntent {
  readonly format: 1; readonly paymentEventId: number; readonly paymentOrderId: number;
  readonly paymentOrderNo: string; readonly paymentSourceHash: string;
  readonly orderId: number; readonly orderNo: string; readonly userId: number;
  readonly financialStoreId: number; readonly supplierId: number; readonly orderType: number;
  readonly activityId: number; readonly totalNum: number; readonly occurredAt: number;
  readonly carts: readonly PurchasedLabelCart[];
}
const invalid = () => Error('购买商品标签任务来源无效');
const id = (value: unknown, zero = false): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= 2147483647;
const small = (value: unknown): value is number => id(value, true) && value <= 32767;
function text(value: unknown, max: number, required = true): value is string {
  if (typeof value !== 'string' || value.length > 2 * max || required && !value) return false;
  let count = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (++count > max || point < 32 || point === 127 || point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) throw invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) throw invalid();
    result[key] = field.value;
  }
  return result;
}
function cart(value: unknown): PurchasedLabelCart {
  const r = object(value, ['rowId', 'cartId', 'productId', 'productType', 'ownerType', 'ownerId', 'skuUnique', 'quantity', 'isGift']);
  if (!id(r.rowId) || !text(r.cartId, 50) || !id(r.productId) || !small(r.productType)
    || !id(r.ownerType, true) || r.ownerType > 2 || !id(r.ownerId, true)
    || r.ownerType !== 0 && r.ownerId === 0 || !text(r.skuUnique, 255, false)
    || !id(r.quantity) || !id(r.isGift, true) || r.isGift > 1) throw invalid();
  return Object.freeze(r) as unknown as PurchasedLabelCart;
}
export function capturePurchasedLabelIntent(value: unknown): PurchasedLabelIntent {
  const r = object(value, ['format', 'paymentEventId', 'paymentOrderId', 'paymentOrderNo', 'paymentSourceHash',
    'orderId', 'orderNo', 'userId', 'financialStoreId', 'supplierId', 'orderType', 'activityId', 'totalNum', 'occurredAt', 'carts']);
  if (r.format !== 1 || !id(r.paymentEventId) || !id(r.paymentOrderId) || !text(r.paymentOrderNo, 50)
    || !id(r.orderId) || !text(r.orderNo, 50) || !id(r.userId) || !id(r.financialStoreId, true)
    || !id(r.supplierId, true) || !small(r.orderType) || !id(r.activityId, true) || !id(r.totalNum)
    || !id(r.occurredAt, true) || (r.orderId === r.paymentOrderId) !== (r.orderNo === r.paymentOrderNo)) throw invalid();
  if (typeof r.paymentSourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(r.paymentSourceHash)) throw invalid();
  if (!Array.isArray(r.carts) || Object.getPrototypeOf(r.carts) !== Array.prototype || r.carts.length < 1
    || r.carts.length > PURCHASED_LABEL_MAX_CARTS || Reflect.ownKeys(r.carts).length !== r.carts.length + 1) throw invalid();
  const carts: PurchasedLabelCart[] = [], rows = new Set<number>(), identities = new Set<string>();
  let quantity = 0;
  for (let index = 0; index < r.carts.length; index++) {
    const field = Object.getOwnPropertyDescriptor(r.carts, String(index));
    if (!field?.enumerable || !('value' in field)) throw invalid();
    const row = cart(field.value);
    if (rows.has(row.rowId) || identities.has(row.cartId)) throw invalid();
    rows.add(row.rowId); identities.add(row.cartId); quantity += row.quantity; carts.push(row);
  }
  if (quantity !== r.totalNum) throw invalid();
  const result = { ...r, paymentSourceHash: r.paymentSourceHash, carts: Object.freeze(carts) } as unknown as PurchasedLabelIntent;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PURCHASED_LABEL_MAX_BYTES) throw invalid();
  return Object.freeze(result);
}
export function purchasedProductLabelEventKey(paymentOrderId: number, orderId: number): string {
  if (!id(paymentOrderId) || !id(orderId)) throw invalid();
  return `${PURCHASED_PRODUCT_LABEL_EVENT}:${paymentOrderId}:${orderId}`;
}
export function purchasedProductLabelEventIdentity(value: unknown): Readonly<{ paymentOrderId: number; orderId: number }> | null {
  if (typeof value !== 'string') return null;
  const match = /^order\.product\.labels:([1-9]\d{0,9}):([1-9]\d{0,9})$/u.exec(value);
  if (!match || !id(Number(match[1])) || !id(Number(match[2]))) return null;
  return Object.freeze({ paymentOrderId: Number(match[1]), orderId: Number(match[2]) });
}
/** The two legacy author columns are bounded varchar CSVs. Duplicates and
 * zero/empty sentinels remain harmless; malformed positive IDs need maintenance. */
export function purchasedLabelIds(value: unknown): number[] {
  if (value === null || value === '') return [];
  if (typeof value !== 'string' || value.length > 255) throw Error('购买商品标签配置须维护核对');
  const result = new Set<number>();
  for (const token of value.split(',')) {
    if (token === '' || token === '0') continue;
    if (!/^[1-9]\d{0,9}$/u.test(token) || !id(Number(token))) throw Error('购买商品标签配置须维护核对');
    result.add(Number(token));
  }
  return [...result].sort((a, b) => a - b);
}
