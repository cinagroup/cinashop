# Materialized refund-success notifications

This successor connects the existing mature physical refund completion author
to `order.refund.success.notice`. It uses the actual `selectedOrderId` returned
by `materializeCompletedRefundOrder` in that same transaction. The original
refund and refund-payment rows retain their application source order identity;
the append-only materialization receipt identifies source, selected entity,
remainder and original payment root. Completed history is never backfilled.

## Fixed local PHP contract

The source remains local fixed commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`.
`StoreOrderRefundServices::agreeRefund` first obtains the selected physical
refund order through `agreeSplitRefundOrder`, then emits `order.refund` with
that order. `NoticeService::orderRefund` uses its product title and physical
order number for SMS/inbox, and the actual `refund_price` for cash values.
Provider template display then uses the refund business number instead.

Routine 1451 `amount3` is the selected entity's `pay_price`. Official 48058
`amount2`, SMS `refund_price` and inbox placeholders use actual refunded cash.
These amounts may differ: the actual Financial author can quote/select goods
worth 5.00 while refunding 3.00. Its current `apply_price` is also 3.00; this
change does not rewrite that existing product behavior.

## Evidence and execution

New payloads carry explicit `materializedRefund` source/payment IDs and cash
amount alongside the selected entity ID and price. Request/staging format6
uses distinct application, request and staging MAC domains. Format5's first
ordinary full-refund contract and its bytes/domains are preserved.

The candidate writer reads only bounded public application fields, existing
receipt/partition evidence and physical rows. It signs receipt and selected
entity digests without treating them as provider or recipient authority. Full
archives stay in PostgreSQL; only scalar summaries and hashes cross the wire.
The shared mature history reader independently checks the v2/v3 application,
partitions and selected row mapping. Physical cart quantities, product/SKU
identity and terminal state must match the receipt. Further refunds may change
the remainder while the earlier selected entity remains independently bound.
Receipt reads use ACCESS SHARE and the exact existing append-only catalog.
This conflicts with the published maintenance paths' ACCESS EXCLUSIVE locks
and TRUNCATE; arbitrary privileged owner guard changes are outside that protocol.
Financial/App retain no UPDATE, DELETE or TRUNCATE authority on receipts.
Mutable application, order and cart rows retain separate row locks.

App staging and first Queue admission separately require original A payment,
authenticated accepted refund SUCCESS for the original application source,
exact buyer+A ownership, and fresh independent subscription/template1451
approval. A mutable payment SUCCESS projection, public receipt or format6
request alone never authorizes a send. Current B configuration cannot provide
historical A authority. Request/staging versions must match; old formats2–5
retain their original interpretation. The read-only history classifier accepts6
without issuing a switch/send permit.

The existing explicit 0198 event commissioning remains required. Bare ORM and
historical outbox CHECK domains are unchanged. A wholly absent Mini protocol
retains legacy SMS/inbox behavior with generic success Mini staging closed;
present-but-unready metadata retains unavailable6. Provider I/O remains outside
SQL, and UNKNOWN keeps the existing immutable no-repeat behavior.

## Verification boundaries

Local evidence is retained under `.cache/php-ts-phase62-validation`. The new
native chain uses actual Financial quote/create/request/query writers, real
PG16 LOGINs and generated RSA/AES observations, with controlled local HTTP,
KV and Queue transports. Ordinary physical refund examples are distinguished
from shared code eligibility; unexecuted activity/other-actor cases are not
claimed as new end-to-end acceptance. Guest, non-WeChat, zero-cash and legacy
unreserved notifications remain separate work. Full migration and account
switch readiness remain incomplete. Legacy upload stays stopped; CI source
supply is unchanged. No production commissioning, deployment, real WeChat or
browser/device acceptance is performed by this code change.
