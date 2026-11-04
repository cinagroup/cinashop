/** Membership settlement facts. orderId is explicitly other_order.id; it is
 * never an ordinary merchandise order or a virtual-shipping permission. */
export interface MembershipPaidNoticeBusiness {
  format: 1;
  domain: 'membership';
  settlementNonce: string;
  orderId: number;
  orderNo: string;
  userId: number;
  kind: 'free-claim' | 'paid-membership';
  memberType: string;
  vipDay: number;
  isPermanent: 0 | 1;
  overdueTime: number;
  payType: 'yue' | 'weixin' | 'alipay';
  payPrice: string;
  payTime: number;
  tradeNo: string;
  phone: string;
  sendName: string;
  storeName: string;
  occurredAt: number;
}
export const MEMBERSHIP_PAID_NOTICE_KEYS = Object.freeze(['format','domain','settlementNonce','orderId','orderNo','userId',
  'kind','memberType','vipDay','isPermanent','overdueTime','payType','payPrice','payTime','tradeNo','phone','sendName','storeName','occurredAt']);
const integer = (v: unknown, zero = false): v is number => Number.isSafeInteger(v) && Number(v) >= (zero ? 0 : 1) && Number(v) <= 2147483647;
export function membershipPaidNoticeObject(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    || Reflect.ownKeys(v).length !== keys.length) throw Error('会员付款通知字段无效');
  return Object.fromEntries(keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d?.enumerable || !('value' in d)) throw Error('会员付款通知字段无效');
    return [key, d.value];
  }));
}
function text(v: unknown, max: number, required = false): v is string {
  if (typeof v !== 'string' || v.length > max * 2 || required && !v) return false;
  let count = 0;
  for (const c of v) { const n = c.codePointAt(0)!; if (++count > max || n >= 0xd800 && n <= 0xdfff) return false; }
  return true;
}
export function captureMembershipPaidNoticeBusiness(value: unknown): MembershipPaidNoticeBusiness {
  const r = membershipPaidNoticeObject(value, MEMBERSHIP_PAID_NOTICE_KEYS);
  if (r.format !== 1 || r.domain !== 'membership' || typeof r.settlementNonce !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(r.settlementNonce)
    || !integer(r.orderId) || !integer(r.userId) || !integer(r.payTime) || !integer(r.occurredAt)
    || r.occurredAt < r.payTime || !integer(r.vipDay, true) || typeof r.isPermanent !== 'number' || ![0,1].includes(r.isPermanent)
    || !text(r.orderNo,50,true) || !text(r.memberType,20,true)
    || !text(r.phone,32) || r.phone.trim() !== r.phone || !text(r.sendName,60) || !text(r.tradeNo,50)
    || r.tradeNo.trim() !== r.tradeNo || typeof r.payPrice !== 'string' || !/^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(r.payPrice)
    || typeof r.payType !== 'string' || !['yue','weixin','alipay'].includes(r.payType)) throw Error('会员付款通知事实无效');
  if (r.isPermanent === 1 ? r.overdueTime !== -1 : !integer(r.overdueTime) || r.overdueTime <= r.payTime || r.vipDay === 0)
    throw Error('会员付款通知权益无效');
  if (r.payType === 'yue' ? r.tradeNo !== '' : r.tradeNo === '') throw Error('会员付款通知交易来源无效');
  if (r.kind === 'free-claim') {
    if (r.payType !== 'yue' || r.payPrice !== '0.00' || r.isPermanent !== 0 || r.storeName !== '免费领取会员卡')
      throw Error('免费会员通知来源无效');
  } else if (r.kind !== 'paid-membership' || r.payPrice === '0.00' || r.storeName !== '购买会员卡')
    throw Error('付费会员通知来源无效');
  return r as unknown as MembershipPaidNoticeBusiness;
}
export function membershipPaidNoticeEventKey(id: number): string {
  if (!integer(id)) throw Error('会员付款通知主体无效');
  return `membership.pay.success.notice:${id}`;
}
export function membershipPaidNoticeSubjectId(value:unknown):number|null {
  if (typeof value !== 'string') return null;
  const match = /^membership\.pay\.success\.notice:([1-9]\d{0,9})$/u.exec(value);
  return match && integer(Number(match[1])) ? Number(match[1]) : null;
}
export function membershipPaidSettlementKey(id: number): string {
  if (!integer(id)) throw Error('会员结算主体无效');
  return `membership.settled:${id}`;
}
export function membershipPaidNoticeBusinessFromPayload(value: unknown): MembershipPaidNoticeBusiness {
  const keys = value && typeof value === 'object' && Object.hasOwn(value,'routineSubscriptionRequest')
    ? [...MEMBERSHIP_PAID_NOTICE_KEYS,'routineSubscriptionRequest'] : MEMBERSHIP_PAID_NOTICE_KEYS;
  const r = membershipPaidNoticeObject(value,keys);
  return captureMembershipPaidNoticeBusiness(Object.fromEntries(MEMBERSHIP_PAID_NOTICE_KEYS.map(k => [k,r[k]])));
}
