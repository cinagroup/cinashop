# Writeoff batch SMS and inbox

The fixed local PHP input remains commit
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. Its `order/Writeoff` listener
emits `reminder_verification_status` after each successful batch, including
partial completion. There is no product-type restriction at this trigger.
`NoticeService::reminderVerificationStatus` sends SMS to the order's phone
and inbox to its buyer UID. It invokes neither official-account nor Mini
notifications. The logical SMS template `REMINDER_VERIFICATION_STATUS`
resolves to the notification configuration's `sms_id`.

For explicit selected carts, the PHP listener visits cart order, reads each
current product name, calls `substrUTf8(name,10,'UTF-8','')` and joins with
spaces. The TS author uses a ten-code-point UTF-8 prefix, retaining repeated
products on separate selected rows. The legacy helper's implementation was
not found in the inspected fixed source; no independent PHP execution of that
helper is claimed. An implicit all-items request still emits the batch with
an empty title, matching the listener's empty selection behavior.

This trigger belongs to the newer `order/store/WriteOffOrderServices` path.
The old Kefu `GET order/verific/:id` invokes the older
`StoreOrderWriteOffServices`, which emits no `order.writeoff` event. Its trusted
TS caller skips both the new notification and its commissioning probe. Kefu
`PUT order/write_update/:order_id` retains the newer batch notification,
including implicit all-items requests; HTTP fields cannot select the old path.
Likewise, PHP Admin's old `POST order/write` is distinct from its newer
`write_update`/`write/form` writers. The TS `/admin/order/writeoff` author tested
here does not expose an alias for that old PHP writer.

## Author and occurrence

The actual core inserts `store_order_writeoff` rows, updates partial state or
completes settlement, and creates one `order.writeoff.notice` in the same
transaction. Its key uses the first generated record ID and its payload binds
every record ID plus a digest of the exact public batch facts. Same-second
batches and later partials remain distinct. A real failed or changed event
INSERT rolls back the entire local writeoff. Existing UUID recovery and
abandonment semantics stay in the Customer/Delivery protocols; the new author
does not invent receipts for raw SQL exceptions.

The event captures the order phone, buyer UID, live product title and actual
batch timestamp. Rendering uses the existing China-time minute convention.
Delayed consumption does not reread today's product name, phone, remaining
quantity or changed verify code. The consumer checks the actual recorded batch
and original order identity before staging. A public record digest alone is
not provider or historical account authority.

An order's existing detail capacity of 500 rows bounds one notification batch;
larger batches are refused, never truncated. Empty phone produces no SMS;
UID zero produces no shared inbox. Channel switches are independent, and
WeChat switches cannot add channels to this event. SMS variables are exactly
`store_name` and `write_time`; only this event accepts the bounded larger batch
title, while other notification variable limits retain their old values.
The existing immutable delivery and provider UNKNOWN handling remain in use.
Template replacement preserves literal dollar characters. A rendered inbox
title exceeding its existing 256-character column capacity is not truncated
or inserted: the valid SMS intent remains, and an operational gap is logged
after commit. This matches PHP's independent SMS dispatch and inbox failure
handling for this known capacity boundary; other SQL or identity errors still
abort the consumer transaction.

## Explicit commissioning

The historical ORM CHECK and prior SQL files remain fixed. New maintenance
0199 accepts only closed reviewed event generations and appends this event.
Known historical generations stay inactive; absent, partial, unsafe or unknown
catalogs cannot authorize the new author. Public PG16 runtime and actual
unchanged role grants are required. Private cloned-schema integration fixtures
do not establish production notice commissioning.

Refund-success, virtual-subject, Supplier price and withdrawal readers recognize
only the exact new successors. Independent addons and their installation order
are retained on reviewed wrapper replays; no substring parser, business-row
adoption or runtime repair is introduced. Existing completed history is never
backfilled.

## Verification scope

Local plans and results are kept in `.cache/php-ts-phase63-validation`.
The native business suite uses production UserJWT HTTP checkout/payment and
Admin and Kefu HTTP writeoff. Kefu cases use locally created tokens through the
real realm/account/password/conversation middleware on App LOGIN; they do not
claim login issuance or Redis token persistence. Customer writeoff and UUID recovery use the real service
on the already commissioned independent Cashier LOGIN, including production
actor authorization. App Queue consumption and the SMS sender use local
Queue/KV and controlled transport. This is not Customer writeoff HTTP/session
commissioning: the current App profile lacks that ledger and complete payment
source reader capability, which remains an existing migration boundary. Maintenance tests separately check exact event families, addon
ordering, drift, budgets and locks. Results must be read from completed runs;
this document is not itself a passing test record. No old PHP upload, production
maintenance, deployment or real SMS is performed by this code change.
