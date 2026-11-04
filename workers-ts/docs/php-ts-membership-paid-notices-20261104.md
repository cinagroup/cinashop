# Membership settlement buyer notices

The fixed PHP authority is local commit
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`. Its actual free/payment path
reaches `OtherOrderServices::paySuccess` and `user.vipPay`, then `VipUser`
emits `order_pay_success`. The listener reads the buyer user's nickname and
phone. SMS uses `PAY_SUCCESS_CODE` with order number and price; inbox quantity
defaults to one; official template 43216 uses the membership landing page.
The actual Mini call is the generic `sendOrderSuccess` (1927), whose page is
the goods order detail link, even for membership. This observable legacy link
is preserved here. The separately named membership template helpers are not
the actual listener path and are not claimed as the source contract.

The established TS purchase contract derives free/type0 from the trusted plan
and settles it during creation. The fresh free-create winner therefore authors
the notice in that creation transaction. A priced/type1 order authors only in
its first successful payment CAS, including balance, verified callback and
verified query settlement. Existing wallet admission, bills, saved rights and
independent WeChat virtual shipping remain in their real transactions. An
already-paid callback/query/API read or UUID create replay never authors a new
settlement. Existing paid rows are not backfilled. The old UI submitted type1
even for free plans; its resulting title could be “购买会员卡”. TS retains its
already established canonical free/type0 title “免费领取会员卡”; this is not a
claim of identical historical UI titles.

The actual card `/draw` path calls `drawMemberCard` and directly grants type2
rights without `user.vipPay`. TS redemption likewise stays silent. A type2
branch in a generic PHP listener is not evidence that the registered draw path
invokes that listener. This change covers purchase settlement, not every
membership lifecycle event or admin/staff/economic auxiliary listener.

## Domain and immutable occurrence

`membership.settled:<other_order.id>` is a completed source captured in the
actual business transaction. Its signed payload binds the current database
and outbox owner OIDs, a fresh nonce, physical membership identity, saved
payment/right facts and buyer nickname/phone snapshots. The corresponding
pending `membership.pay.success.notice` shares those immutable facts. Real
INSERT errors or changed RETURNING contents abort the transaction, including
wallet, rights and status; a retry must win the actual business transition.
Neither the ordinary `order.paid` event nor an existing virtual-shipping row
is authority to create it.

Queue is an accelerator after commit. The durable scanner remains responsible
for a failed or unknown enqueue. Consumption authenticates the exact source
and physical membership, then independently stages SMS, inbox, official and
Mini according to `order_pay_success` switches. Phone/nickname/title/time are
not reloaded from a later user/plan configuration. Literal dollar characters
in inbox substitutions remain literal. A known inbox title above its existing
256-character capacity preserves the other valid channels and records a gap;
unknown SQL errors still roll back consumption.

Membership delivery uses `subject_domain=membership`,
`subject_id=other_order.id` and NULL order/withdrawal IDs. A coincident ordinary
order ID cannot borrow this authority. SMS/official Queue claims authenticate
the membership source and rendering; Mini has its own format8 signed request,
intent and fresh-source protocol immediately before any POST. The existing
formats2–7 stay separate. WeChat uses authenticated original membership
payment evidence and explicit UID ownership; free/balance/non-WeChat use a
uniquely maintained live buyer identity and never invent original payment
evidence. Current AppID B, payment approval, payer OpenID or bare bindings do
not authorize subscriber A. Independent subscription-send approval, template
1927 binding, archived credentials and immutable attempt/result admission
continue to apply. UNKNOWN never authorizes another POST.

Only a proved pre-attempt membership SQL read failure in the explicitly
enumerated contention/cancellation/serialization/deadlock classes can schedule
a retry. A fresh transaction must prove the still-owned claim, unchanged
complete immutable history and no newly admitted attempt before restoring its
claim-only counter. Token/network/admission uncertainty stays conservative;
no attempt/result is erased or rewritten to permit a resend.

## Explicit maintenance and proof scope

0201 requires the formally installed virtual subject columns/index and an
exact reviewed event generation. It commissions the source/notice pair and
delivery subject CHECK together, under bounded direct PG16 owner maintenance.
Unknown/unsafe/half-installed pairs are rejected without runtime repair or
silent deactivation. A complete old generation stays inactive. Initial runtime
catalog reads have bounded statement/lock/idle budgets and preserve stricter
callers. The new addon preserves ordinary paid/refund/writeoff/price tails and
the existing independent virtual-shipping protocol. Historical standalone SQL
artifacts remain byte-identical. No business adoption or grants are performed.

Results must be read from actual completed plans under
`.cache/php-ts-phase65-validation`; this design description is not passing
test evidence. Catalog-only specimens do not prove real payment authors or
provider authority. Business acceptance must use actual creation/settlement,
registered HTTP and independent LOGINs, with only transport boundaries local.
No old PHP upload, production maintenance, deployment or real provider request
is part of this change. Full cloud CI still depends on a separately unresolved
legacy input arrangement.
