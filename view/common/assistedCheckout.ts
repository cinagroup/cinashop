import type { IntentStorage } from './checkoutIntent';
import { decodeAssistedFormAnswers, type AssistedFormAnswer } from './assistedForm';

export interface AssistedOwner { adminId: number; uid: number; touristUid: string }
export interface AssistedAddress { realName: string; phone: string; province: string; city: string; district: string; street: string; detail: string; cityId: number }
export interface AssistedOptions {
  addressId: number; shipping_type: 1 | 2; store_id: number; couponId: number; useIntegral: boolean;
  payType: 'weixin' | 'alipay' | 'cash'; manualAddress?: AssistedAddress;
}
export interface AssistedSubmission extends AssistedOptions {
  quoteToken: string; real_name: string; phone: string; mark: string;
  customForm?: AssistedFormAnswer[];
}
export interface AssistedIntent extends AssistedOwner {
  version: 1; key: string; cartIds: number[]; payload: AssistedSubmission; attempts: number;
  result?: { orderId: string; payPrice: string };
}
export function assistedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('代客结算数据格式错误');
  return value as Record<string, unknown>;
}
export function assistedInteger(value: unknown, min = 0, max = 2_147_483_647): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error('代客结算数值无效');
  return value;
}
export function assistedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw Error('代客结算文字无效');
  return value;
}
export function assistedMoney(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,10}\.\d{2}$/.test(value)) throw Error('代客报价金额无效');
  return value;
}
export function assistedIds(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw Error('请选择有效的代客商品');
  const ids = value.map(id => assistedInteger(id, 1));
  if (new Set(ids).size !== ids.length) throw Error('代客商品重复');
  return ids;
}
export function assistedOwner(value: unknown): AssistedOwner {
  const row = assistedObject(value), adminId = assistedInteger(row.adminId, 1), uid = assistedInteger(row.uid);
  const touristUid = assistedText(row.touristUid, 50);
  if (uid === 0 ? !/^[A-Za-z0-9_-]+$/.test(touristUid) : touristUid !== '') throw Error('代客买家标识无效');
  return { adminId, uid, touristUid };
}
export function assistedKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw Error('代客报价凭证无效');
  return value;
}
export function assistedAddress(value: unknown): AssistedAddress {
  const row = assistedObject(value);
  const result = { realName: assistedText(row.realName, 32).trim(), phone: assistedText(row.phone, 16).trim(),
    province: assistedText(row.province, 64).trim(), city: assistedText(row.city, 64).trim(), district: assistedText(row.district, 64).trim(),
    street: assistedText(row.street ?? '', 100).trim(), detail: assistedText(row.detail, 256).trim(), cityId: assistedInteger(row.cityId, 1) };
  if (['realName', 'phone', 'province', 'city', 'district', 'detail'].some(key => !result[key as keyof AssistedAddress])) throw Error('请填写完整的收货信息');
  if ([...[result.province, result.city, result.district, result.street, result.detail].filter(Boolean).join(' ')].length > 100) throw Error('收货地址超过订单长度限制');
  return result;
}
export function assistedOptions(value: unknown): AssistedOptions {
  const row = assistedObject(value), addressId = assistedInteger(row.addressId), store = assistedInteger(row.store_id);
  if (![1, 2].includes(Number(row.shipping_type)) || typeof row.shipping_type !== 'number'
    || typeof row.useIntegral !== 'boolean' || typeof row.payType !== 'string' || !['weixin', 'alipay', 'cash'].includes(row.payType)) throw Error('代客结算选择无效');
  const manualAddress = row.manualAddress === undefined ? undefined : assistedAddress(row.manualAddress);
  if (manualAddress && addressId) throw Error('不能同时选择保存地址和手填地址');
  if (row.shipping_type === 1 ? store !== 0 : addressId !== 0 || !!manualAddress || store === 0) throw Error('配送或门店选择不匹配');
  return { addressId, shipping_type: row.shipping_type as 1 | 2, store_id: store, couponId: assistedInteger(row.couponId),
    useIntegral: row.useIntegral, payType: row.payType as AssistedOptions['payType'], ...(manualAddress ? { manualAddress } : {}) };
}
export const assistedIntentKey = (adminId: number) => `cinashop_assisted_pending_v1_${assistedInteger(adminId, 1)}`;
function decode(value: unknown, adminId: number): AssistedIntent {
  if (typeof value !== 'string' || value.length > 1_050_000 || new TextEncoder().encode(value).length > 1_050_000) throw Error('本机代客待确认记录不可读，请先核对原订单');
  let row: Record<string, unknown>;
  try { row = assistedObject(JSON.parse(value)); } catch { throw Error('本机代客待确认记录已损坏，请先核对原订单'); }
  const owner = assistedOwner(row), raw = assistedObject(row.payload), options = assistedOptions(raw);
  const allowed = ['addressId','shipping_type','store_id','couponId','useIntegral','payType','manualAddress','quoteToken','real_name','phone','mark','customForm'];
  if (row.version !== 1 || owner.adminId !== adminId || Object.keys(raw).some(key => !allowed.includes(key))) throw Error('本机代客待确认记录范围无效');
  const payload = { ...options, quoteToken: assistedKey(raw.quoteToken), real_name: assistedText(raw.real_name, 32),
    phone: assistedText(raw.phone, 18), mark: assistedText(raw.mark, 512),
    ...(raw.customForm === undefined ? {} : { customForm: decodeAssistedFormAnswers(raw.customForm) }) };
  if (options.shipping_type === 2 && (!payload.real_name.trim() || !payload.phone.trim())) throw Error('请填写自提联系人及电话');
  let result: AssistedIntent['result'];
  if (row.result !== undefined) {
    const settled = assistedObject(row.result), orderId = assistedText(settled.orderId, 32);
    if (!/^[A-Za-z0-9_-]+$/.test(orderId)) throw Error('代客订单结果标识无效');
    result = { orderId, payPrice: assistedMoney(settled.payPrice) };
  }
  return { version: 1, ...owner, key: assistedKey(row.key), cartIds: assistedIds(row.cartIds), payload,
    attempts: assistedInteger(row.attempts, 0, 100000), ...(result ? { result } : {}) };
}

/** Frozen submission only, never Admin/shopper tokens. Contains delivery/form PII:
 * UI must disclose device storage and clear it only after a verified outcome.
 * Storage is not encryption or a cross-tab transaction/authorization boundary. */
export class AssistedIntentJournal {
  constructor(private readonly storage: IntentStorage) {}
  read(adminId: number): AssistedIntent | null {
    const raw = this.storage.get(assistedIntentKey(adminId));
    return raw === null || raw === undefined || raw === '' ? null : decode(raw, adminId);
  }
  private save(intent: AssistedIntent) {
    const canonical = decode(JSON.stringify(intent), intent.adminId), json = JSON.stringify(canonical), key = assistedIntentKey(intent.adminId);
    this.storage.set(key, json);
    if (this.storage.get(key) !== json) throw Error('无法核验本机待确认记录，未发送新请求');
    return decode(json, intent.adminId);
  }
  begin(owner: AssistedOwner, key: string, cartIds: number[], payload: AssistedSubmission) {
    if (this.read(owner.adminId)) throw Error('已有待确认代客订单，请先恢复原订单');
    return this.save({ version: 1, ...owner, key, cartIds, payload, attempts: 0 });
  }
  current(intent: AssistedIntent) {
    const value = this.read(intent.adminId);
    if (!value || value.key !== intent.key || JSON.stringify(value.payload) !== JSON.stringify(intent.payload)
      || value.uid !== intent.uid || value.touristUid !== intent.touristUid || JSON.stringify(value.cartIds) !== JSON.stringify(intent.cartIds)) throw Error('代客待确认记录已变化，请重新打开恢复页面');
    return value;
  }
  attempt(intent: AssistedIntent) {
    const current = this.current(intent);
    if (current.result) throw Error('订单已确认，不应重新提交');
    return this.save({ ...current, attempts: current.attempts + 1 });
  }
  settle(intent: AssistedIntent, result: { orderId: string; payPrice: string }) {
    const current = this.current(intent);
    if (current.result && JSON.stringify(current.result) !== JSON.stringify(result)) throw Error('订单结果冲突，请人工核对');
    return this.save({ ...current, result });
  }
  clear(intent: AssistedIntent, definitiveFirstRejection = false) {
    const current = this.current(intent);
    if (!current.result && !(definitiveFirstRejection && current.attempts === 1 && intent.attempts === 1)) throw Error('结果仍不确定，不能清除原订单记录');
    this.storage.remove(assistedIntentKey(intent.adminId));
    if (this.read(intent.adminId)) throw Error('本机待确认记录尚未清除');
  }
}
