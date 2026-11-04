# First ordinary WeChat refund-success notification

This slice connects the actual shared refund completion transaction to notification
outbox, App staging and Queue dispatch. It covers the first full refund of an
ordinary, unsplit, registered-buyer WeChat order with a complete v1 quantity
reservation. Split/materialized, customer-row, legacy no-reservation, partial,
non-WeChat, guest and activity cases remain separate migration work. Existing
completed refunds are never backfilled, even when the notice feature is later
commissioned.

## Fixed PHP contract

The local source is commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`.
No full legacy source is included in this change or uploaded by its validation.
The source completion path is `app/services/order/StoreOrderRefundServices.php`
→ `app/listener/order/Refund.php` → `NoticeService::orderRefund`.
The independent notification mark is `order_refund`.

`NoticeService.php:363–381` retains the physical order number for SMS/inbox, then
uses the refund business number for the provider templates. The Routine
`ORDER_REFUND` template is 1451 (`config/template.php:85`), with
`thing1=已成功退款`, the complete order title in `thing2`, original order
`pay_price` in `amount3`, refund business number in `character_string6`, and
`/pages/goods/order_after_details/index?order_id=<refund-number>&isReturen=1`.
It shares template 1451 with refusal, but has a separate business mark/event.
The official template is 48058, with `amount2`, `time4`, `character_string5`.

## Admission and storage

Maintenance explicitly runs `runRefundSuccessNoticeUpgrade` or the matching
`maintenance/0198_refund_success_notice.sql` in one transaction. It accepts only
the four exact existing outbox whitelist variants (base14, price15, virtual16,
virtual17), preserving that variant and adding only `order.refund.success.notice`.
Unknown CHECK definitions or catalog metadata fail closed. The installer has a
10,000-row maintenance budget, short locks and timeouts; it performs no business
DML or grants. Historical bootstrap SQL is unchanged. A known old whitelist
keeps the new author inactive until this upgrade. Exact historical 3/5/7/8/9/10/11/12/13-event generations also remain inactive for completion; they are not accepted as 0198 upgrade predecessors. No production commissioning is
performed by tests or this code commit.

On the first supported completion, `order.refund.success.notice:<refundId>` is
written atomically with refund/accounting state. Request5 records the actual
public application, full v1 quantity provenance, completed amount/time and the
actual SQL writer. Its independent request/application MAC domains preserve old
formats 2/3/4. Missing optional Mini metadata is isolated by a real SAVEPOINT and
retained as unavailable5; it never adopts current B later. Only a wholly absent
subscription delivery namespace retains a legacy payload. For this new success
author that means SMS/inbox only: generic Mini staging is disabled and Queue
refuses a success-prefix Mini claim until the original-account protocol is
commissioned. Later commissioning never adopts that committed legacy event.
The bare ORM CHECK remains base14, matching historical bootstrap; only 0198
enables the new business author.

The App and first Queue admission re-read physical order/refund fields and
quantity, exact original A payment, exact buyer UID+A ownership, and authenticated
accepted original refund SUCCESS evidence. A mutable SUCCESS field or request5
alone cannot authorize a send. Accepted refund proof survives refund-approval
retirement or merchant-material removal. Sending separately requires fresh
`subscription_send` and template1451 approval/materials. The payer is not
substituted for the buyer. Current config, bare B binding and global B template
cannot supply historical A authority.

Staging5 and the existing immutable attempt/result protocol retain replay,
revocation, no-transaction-during-provider-I/O and UNKNOWN behavior. SMS/inbox
can commit while optional Mini staging defers. The read-only history classifier
understands format5 without issuing any switch or send permit.

## Verification boundaries

Validation evidence is retained locally in `.cache/php-ts-phase61-validation`.
The new native suite uses real local PG16 LOGINs, checkout, RSA/AES payment,
authenticated buyer application, Admin request/query completion, App staging and
Queue, with controlled local HTTP/KV/Queue transports. It does not establish
real WeChat consent, deployed service state, browser coverage or production
account-switch readiness. Legacy-source upload remains stopped. Cloud CI still
needs a user-selected source supply design before its legacy-dependent gates
can pass; no source check is bypassed or marked green here.
