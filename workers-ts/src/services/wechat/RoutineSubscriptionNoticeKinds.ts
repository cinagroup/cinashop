/** Syntactic routing only; every producer, source and dispatch still proves its
 * own closed event/decision and actual SQL authority. */
export const routineSubscriptionDeliveryKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 128
  && /^order\.delivery\.notice:[1-9]\d*(?::city:[1-9]\d*)?$/u.test(v);
export const routineSubscriptionRefusalKey = (v: unknown): v is string => typeof v === 'string' && v.length <= 128
  && /^order\.refund\.refused\.notice:[1-9]\d*$/u.test(v);
export const routineSubscriptionNoticeKey = (v: unknown): v is string => routineSubscriptionDeliveryKey(v) || routineSubscriptionRefusalKey(v);
// Keep malformed keys in a commissioned protocol's fail-closed route rather
// than allowing them to fall back to a legacy provider path.
export const routineSubscriptionNoticePrefix = (v: string) => v.startsWith('order.delivery.notice:') || v.startsWith('order.refund.refused.notice:');
