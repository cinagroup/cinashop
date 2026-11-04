export const routineSubscriptionPaidKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 128
  && /^order\.pay\.success\.notice:[1-9]\d*$/u.test(v);
/** Syntactic routing only; every producer, source and dispatch still proves its
 * own closed event/decision and actual SQL authority. */
export const routineSubscriptionDeliveryKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 128
  && /^order\.delivery\.notice:[1-9]\d*(?::city:[1-9]\d*)?$/u.test(v);
export const routineSubscriptionRefusalKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 128
  && /^order\.refund\.refused\.notice:[1-9]\d*$/u.test(v);
export const routineSubscriptionPinkKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 128
  && /^order\.pink\.success\.notice:[1-9]\d*$/u.test(v);
export const routineSubscriptionRefundSuccessKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 128
  && /^order\.refund\.success\.notice:[1-9]\d*$/u.test(v);
export const routineSubscriptionNoticeKey = (v: unknown): v is string => routineSubscriptionPaidKey(v) || routineSubscriptionDeliveryKey(v) || routineSubscriptionRefusalKey(v) || routineSubscriptionPinkKey(v) || routineSubscriptionRefundSuccessKey(v);
// Keep malformed keys in a commissioned protocol's fail-closed route rather
// than allowing them to fall back to a legacy provider path.
export const routineSubscriptionNoticePrefix = (v: string) => v.startsWith('order.pay.success.notice:') || v.startsWith('order.delivery.notice:') || v.startsWith('order.refund.refused.notice:') || v.startsWith('order.pink.success.notice:') || v.startsWith('order.refund.success.notice:');
