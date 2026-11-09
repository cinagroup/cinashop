/** Syntactic address only, never a notice/settlement/send authorization. */
export const RECHARGE_REFUND_SUCCESS_NOTICE_PREFIX='recharge.refund.success.notice:';
export const rechargeRefundSuccessNoticeKey=(v:unknown):v is string=>typeof v==='string'
 &&v.startsWith(RECHARGE_REFUND_SUCCESS_NOTICE_PREFIX)
 &&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v.slice(RECHARGE_REFUND_SUCCESS_NOTICE_PREFIX.length));
