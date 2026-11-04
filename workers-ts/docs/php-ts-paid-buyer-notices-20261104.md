# Ordinary merchandise payment buyer notifications

Fixed local PHP input: `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`.
`Pay -> ShareOrderJob -> SpliteStoreOrderJob::splitAfter` invokes
`order_pay_success` after allocation, once for each fulfillment order. A split
payment root is an audit record, not another buyer notification. The independent
VIP payment author is outside this merchandise implementation.

`NoticeService::orderPaySuccess` sends SMS (`PAY_SUCCESS_CODE`, order number and
price), inbox (order number, quantity, price), official template43216 and Mini
template1927. The product title is the ordered cart snapshot names joined by
`|`, followed by a twenty-code-point prefix. The legacy `substrUTf8` helper's
implementation has not been independently executed; Unicode equivalence is not
claimed beyond the inspected call contract.

## Actual author and durable occurrence

Explicit maintenance0200 enables a new closed event generation. Only a newly
inserted `order.paid` winner records a fresh admission nonce. An existing winner
keeps its original payload; old pending/completed payments and presale financial
recovery do not acquire new notices. No historical backfill is performed.

The paid consumer completes its real supplier allocation and financial effects
and writes one `order.pay.success.notice:<fulfillment-id>` per fulfillment order
in that same transaction. It captures the actual payment-event identity and
admission nonce, payment root and fulfillment identity, buyer, order phone,
amount, quantity, product snapshot title, recipient name, payment time and notice
time. A failed or changed notice INSERT rolls back those post-payment effects.
The earlier payment transaction remains durable and the failed paid event can
be retried. Queue acceleration occurs after commit, with durable scanners for
pending work; replay never creates a second notice or provider attempt.
A completed admitted supplier split can acknowledge a duplicate only after a
bounded read of its complete, non-refunded family and exactly one matching
atomic notice per fulfillment order, with no root notice. That path does not
repeat the earlier distributor upgrade or financial effects. Initial/retrying
payments, old unadmitted archived roots and the separate presale recovery keep
their existing guards.

SMS and official/inbox channels render those captured facts. Official template
time is the payment time; Mini time is the notification occurrence time, both
in China time. Template replacement preserves literal dollar characters.
Guests receive no shared account inbox or WeChat recipient. Empty phone omits
SMS. A known inbox title-capacity failure leaves independent channels intact;
unknown SQL or immutable identity errors still abort staging.

## Independent Mini1927 authority

Format7 uses a separate signed request and intent domain. It binds the actual
paid event/admission, closed payment-root/fulfillment family and exact buyer
identity. Positive WeChat payments require the original JSAPI payment AppID,
its real bound payment evidence and NativeApp exclusion. Non-WeChat and zero
payments use a distinct source variant: every active Mini binding for the UID
must resolve to one explicit signed ownership/witness. An ambiguous account,
bare binding or absent ownership cannot select an AppID.

The writer freezes that choice, or an unavailable sentinel. Subsequent staging
and provider dispatch recheck the same source and independent subscription
policy, archived credential and template1927 binding. Current configuration,
payment approval alone, a payer openid, or later identity repair cannot adopt
an unavailable historical request. Existing formats2..6 retain their contracts.
Real provider rejection/UNKNOWN and immutable attempt/result handling remain in
the shared dispatcher. No provider or cache I/O holds the SQL source transaction.

## Commissioning and evidence

The historical ORM CHECK and prior standalone SQL remain fixed. Maintenance0200
accepts only forty exact reviewed generations (twenty predecessors and their
single paid-notice successors). Explicit writeoff/refund/price/virtual wrapper
replays preserve the new independent addon and its existing sibling order.
Owner wrappers apply the existing bounded maintenance budgets before their
first catalog-routing query, including the older writeoff/refund/price entry
points. Stricter caller budgets remain in force. Unknown activated catalogs cannot authorize a new payment admission. An absent
public catalog or an exact pre0200 generation is inactive; private legacy
schemas are not production notification commissioning.

Completed local results, frozen input manifests and retained failed attempts
are under `.cache/php-ts-phase64-validation`. The native suite uses real
UserJWT checkout, balance payments, signed/encrypted WeChat callbacks, supplier
allocation, App LOGIN Queue staging and the real SMS/official/Mini senders.
Only catalog/user setup, explicit maintenance approvals and local transports
are controlled fixtures. Phone continuity uses server-verified fixture input;
it is not a real phone-provider integration. This document is not itself a
passing test record. This change performs no old PHP upload, production DDL,
deployment or real provider operation. Overall migration and cloud legacy-input
availability remain unfinished.
