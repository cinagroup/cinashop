/** Dependency-free closed membership addon and delivery subject contract. */
export const MEMBERSHIP_PAID_NOTICE_EVENT = 'membership.pay.success.notice';
export const MEMBERSHIP_SETTLED_EVENT = 'membership.settled';
export const MEMBERSHIP_PAID_EVENTS:readonly string[] = Object.freeze([MEMBERSHIP_SETTLED_EVENT,MEMBERSHIP_PAID_NOTICE_EVENT]);
const and = (...parts: string[]) => '(' + parts.join(' AND ') + ')';
const or = (...parts: string[]) => '(' + parts.join(' OR ') + ')';
export const MEMBERSHIP_PAID_SUBJECT_DEFINITION = 'CHECK (' + or(
  and('(subject_domain IS NULL)','(subject_id IS NULL)',"((event_key)::text !~~ 'membership.pay.success.notice:%'::text)",or(
    and('(withdrawal_id IS NULL)','(order_id IS NOT NULL)'),
    and('(withdrawal_id IS NOT NULL)','(withdrawal_id > 0)','(order_id IS NULL)'))),
  and('(subject_domain IS NOT NULL)','(subject_id IS NOT NULL)',
    "((subject_domain)::text = ANY ((ARRAY['recharge'::character varying, 'membership'::character varying])::text[]))",
    '(subject_id > 0)','(order_id IS NULL)','(withdrawal_id IS NULL)',
    "((channel)::text = 'wechat_shipping'::text)","((notice_mark)::text = 'paid_virtual_shipping'::text)",
    "((event_key)::text = (((subject_domain)::text || '.paid.shipping:'::text) || (subject_id)::text))"),
  and('(subject_domain IS NOT NULL)',"((subject_domain)::text = 'membership'::text)",'(subject_id IS NOT NULL)','(subject_id > 0)',
    '(order_id IS NULL)','(withdrawal_id IS NULL)',
    "((channel)::text = ANY ((ARRAY['sms'::character varying, 'wechat_official'::character varying, 'wechat_routine'::character varying])::text[]))",
    "((notice_mark)::text = 'order_pay_success'::text)",
    "((event_key)::text = ('membership.pay.success.notice:'::text || (subject_id)::text))")) + ')';
export const MEMBERSHIP_PAID_SUBJECT_CHECK_SQL = `CHECK (
 (subject_domain IS NULL AND subject_id IS NULL AND event_key NOT LIKE 'membership.pay.success.notice:%' AND
   ((withdrawal_id IS NULL AND order_id IS NOT NULL) OR (withdrawal_id IS NOT NULL AND withdrawal_id>0 AND order_id IS NULL)))
 OR (subject_domain IS NOT NULL AND subject_id IS NOT NULL AND subject_domain IN ('recharge','membership')
   AND subject_id>0 AND order_id IS NULL AND withdrawal_id IS NULL AND channel='wechat_shipping' AND notice_mark='paid_virtual_shipping'
   AND event_key=subject_domain::text || '.paid.shipping:'::text || subject_id::text)
 OR (subject_domain IS NOT NULL AND subject_domain='membership' AND subject_id IS NOT NULL AND subject_id>0 AND order_id IS NULL AND withdrawal_id IS NULL
   AND channel IN ('sms','wechat_official','wechat_routine') AND notice_mark='order_pay_success'
   AND event_key='membership.pay.success.notice:'::text || subject_id::text)
)`;
