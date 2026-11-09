/** Closed storage subject only. Neither refund approval nor send authority. */
import { RECHARGE_PAID_SUBJECT_CHECK_SQL, RECHARGE_PAID_SUBJECT_DEFINITION } from './rechargePaidNoticeContract';

export const RECHARGE_REFUND_NOTICE_EVENT = 'recharge.refund.success.notice';
export const RECHARGE_REFUND_NOTICE_MARK = 'recharge_order_refund_status';
export const RECHARGE_REFUND_NOTICE_KEY_PREFIX = RECHARGE_REFUND_NOTICE_EVENT + ':';
export const RECHARGE_REFUND_NOTICE_KEY_LENGTH = RECHARGE_REFUND_NOTICE_KEY_PREFIX.length + 36;
export const RECHARGE_REFUND_NOTICE_KEY_PATTERN = '^recharge[.]refund[.]success[.]notice:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';

const neutral = "((event_key)::text !~~ 'recharge.pay.success.notice:%'::text)";
const branch = "((subject_domain IS NOT NULL) AND ((subject_domain)::text = 'recharge'::text) AND (subject_id IS NOT NULL) AND (subject_id > 0) AND (order_id IS NULL) AND (withdrawal_id IS NULL) AND ((channel)::text = ANY ((ARRAY['sms'::character varying, 'wechat_routine'::character varying])::text[])) AND ((notice_mark)::text = 'recharge_order_refund_status'::text) AND (char_length((event_key)::text) = " + RECHARGE_REFUND_NOTICE_KEY_LENGTH + ") AND ((event_key)::text ~ '" + RECHARGE_REFUND_NOTICE_KEY_PATTERN + "'::text))";
export const RECHARGE_REFUND_NOTICE_SUBJECT_DEFINITION = RECHARGE_PAID_SUBJECT_DEFINITION
  .replace(neutral, neutral + " AND ((event_key)::text !~~ 'recharge.refund.success.notice:%'::text)")
  .slice(0, -2) + ' OR ' + branch + '))';
export const RECHARGE_REFUND_NOTICE_SUBJECT_CHECK_SQL = RECHARGE_PAID_SUBJECT_CHECK_SQL
  .replace("event_key NOT LIKE 'recharge.pay.success.notice:%'", "event_key NOT LIKE 'recharge.pay.success.notice:%' AND event_key NOT LIKE 'recharge.refund.success.notice:%'")
  .replace(/\n\)$/u, () => `
 OR (subject_domain IS NOT NULL AND subject_domain='recharge' AND subject_id IS NOT NULL AND subject_id>0
   AND order_id IS NULL AND withdrawal_id IS NULL AND channel IN ('sms','wechat_routine')
   AND notice_mark='recharge_order_refund_status' AND char_length(event_key)=${RECHARGE_REFUND_NOTICE_KEY_LENGTH}
   AND event_key ~ '${RECHARGE_REFUND_NOTICE_KEY_PATTERN}')
)`);
