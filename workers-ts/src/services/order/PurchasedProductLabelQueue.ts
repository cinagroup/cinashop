import { purchasedProductLabelEventIdentity } from './PurchasedProductLabelCodec';
export interface PurchasedProductLabelMessage { action: 'processPurchasedProductLabels'; taskId: string; eventKey: string }
export interface PurchasedProductLabelDispatch { action: 'dispatchPurchasedProductLabels' }
export const purchasedLabelUuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
function data(value: unknown, keys: string[]) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length)
    throw Error('购买标签 Queue 引用无效');
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !('value' in d)) throw Error('购买标签 Queue 引用无效'); r[key] = d.value;
  }
  return r;
}
export function capturePurchasedProductLabelMessage(input: unknown): Readonly<PurchasedProductLabelMessage> {
  const r = data(input, ['action', 'taskId', 'eventKey']);
  if (r.action !== 'processPurchasedProductLabels' || !purchasedLabelUuid(r.taskId) || !purchasedProductLabelEventIdentity(r.eventKey))
    throw Error('购买标签 Queue 引用无效');
  return Object.freeze(r) as unknown as Readonly<PurchasedProductLabelMessage>;
}
export function capturePurchasedProductLabelDispatch(input: unknown): Readonly<PurchasedProductLabelDispatch> {
  const r = data(input, ['action']);
  if (r.action !== 'dispatchPurchasedProductLabels') throw Error('购买标签补偿消息无效');
  return Object.freeze({ action: 'dispatchPurchasedProductLabels' });
}
export function isPurchasedProductLabelMessage(input: unknown): input is PurchasedProductLabelMessage {
  try { capturePurchasedProductLabelMessage(input); return true; } catch { return false; }
}
export function isPurchasedProductLabelDispatch(input: unknown): input is PurchasedProductLabelDispatch {
  try { capturePurchasedProductLabelDispatch(input); return true; } catch { return false; }
}
