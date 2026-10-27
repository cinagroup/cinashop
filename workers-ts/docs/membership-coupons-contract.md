# Member coupons: PHP page, authenticated claims and recovery

The immutable PHP source is `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`:
`view/uniapp/pages/annex/vip_coupon/index.vue`,
`StoreCouponIssueServices.php::issueUserCoupon` and `UserServices.php::isSvip`.
Application navigation resolves legacy `/pages/annex/vip_coupon/index` to the
registered `/pages/user/memberCoupons`. A direct H5 boot into the unregistered
legacy URL is not supported; the Browser guest phase opens the canonical route.
The real homepage legacy VIP menu exercises action-based compatibility, then
membership home's coupon preview opens the new page.
The page retains PHP's brown/black coupon faces, white details, gray owned
states, full expandable rules and 15-row pagination. The empty-state GIF is
copied without re-encoding from `public/statics/images/noCoupon.gif`:
77,648 bytes, SHA-256
`277cdfe2f58807bbdc245ade67ce04ec5603aa46c5b9b986251eb9335fa5e4d5`.

## HTTP contracts

Authenticated `GET /api/user/member/coupons/list?view=1&page=1&limit=15`
returns `{owner_uid,server_now,page,limit,next_page,eligibility,list}` with
`private, no-store`. The list uses actual category2, receiveType1, appType0,
published/nondeleted issues in their current claim windows; order is
sort/add_time/id descending. Already-owned and exhausted issues remain visible.
One extra row determines the next page. Default pagination is 15 and the
explicit limit is bounded to50. The old request without `view` or `claim`
keeps its original array DTO and behavior.

Each row includes issue ID, plaintext title and rule, exact decimal benefit and
minimum, benefit type, scope type, fixed/relative validity, claim windows,
remaining inventory, actual owned coupon or null, and a claimability reason.
Type1 is a currency reduction; type2 is a discount (`85.50` means `8.55折`).
Full plaintext rules up to64,000 UTF-16 units are returned; an oversized rule
rejects the modern page rather than silently cutting terms.

Eligibility reads platform SQL `member_card_status` (default1), actual enabled
coupon entitlement and a live account. SVIP is `is_ever_level > 0` or
`is_money_level > 0 && overdue_time > server_now`, including the positive card
activation value2. Client flags and cached projections cannot authorize a grant.
The paid-member menu gate applies to both canonical and legacy coupon routes,
independently of ordinary member levels. Direct requests still enforce their
own authentication and eligibility.

Modern `POST /api/coupon/receive` accepts exactly
`{couponId: <issue ID>, member: 1}`. It validates original UTF-8 bytes, decoded
duplicate keys, scalar types and the4KiB bound. It returns
`{owner_uid,issue_id,replayed,coupon}`, where `coupon.id` is the actual
`store_coupon_user` primary key. No UID, amount, status or expiry from the
client is accepted. Legacy `id`/`couponId` bodies retain their existing parser
and `{couponUserId}` result. Ordinary category0/1 behavior and trusted
category3/appType restrictions remain intact; legacy category2 restores PHP's
once-only paid-member eligibility.

`GET /api/user/member/coupons/list?claim=<issue ID>` accepts that sole query
key and returns `{owner_uid,issue_id,state,coupon}`. A persisted owner-bound
coupon is `received`, including after an issue is stopped or retired. Absence
is only `unknown`. Neither case writes SQL, sequences, Durable Objects or R2.
Historical duplicates resolve deterministically by receive_time/id descending.

## Transactions and uncertainty

Claims first lock the exact issue `FOR UPDATE`. An existing owned coupon is
replayed before current eligibility, stock or window checks; it creates no new
row. A historical issue log without its owned coupon is a business409 barrier.
A new grant checks actual issue admission and current eligibility, decrements
finite inventory once and inserts exactly one owned coupon and one issue log.
Projection/validation run inside the transaction before commit. There is no new
schema or Durable Object allocation.

Existing account, config and entitlement rows use `FOR SHARE NOWAIT` through
commit. NOWAIT prevents an issue-to-user wait cycle with existing user-to-issue
payment/gift transactions. PostgreSQL lock/serialization conflicts become
HTTP200/business409 and preserve uncertainty. Native tests observe actual
blocking-PID chains for same-owner replay and two owners racing the last stock.
A valid business400 refusal can clear an initial journal; transport failures,
non2xx, malformed/wrong-owner responses and409 cannot prove nonapplication.

Before a POST, the client durably stores a bounded UID/issue journal without
credentials. H5 uses an exclusive same-origin Web Lock; native platforms use
a module-local latch. Unknown results block another claim and expose explicit
read-only recovery or continuation of the same issue. Focus, timers and page
lifecycle never submit claims automatically. A confirmed owned ID stays
confirmed if later list refresh or local record cleanup fails.

UID, token, session version, persisted auth and page visibility fence all
responses and navigation. Hide/unload, logout, renewal or owner replacement
abort owned requests and clear private UI. Server-relative clocks enforce
future/expired owned-coupon states; used, failed, held and unknown statuses
cannot be used. Null historical time bounds follow the existing wallet model.

## Using a coupon and product media

Only an available actual owned ID navigates to
`/pages/user/couponProducts?couponId=<owned ID>`. This is a catalogue read;
it does not apply a coupon, create an order or submit payment.

The existing `view=search` product handler resolves persisted product-owner and
attachment tuples in the same RR READ ONLY snapshot as its result. It signs
permitted platform product images after the transaction. Existing filters,
sorting, amounts, scope and legacy/plain product DTOs remain intact. Wrong
attachment owners and nonplatform tuples cannot be signed. The client resolves
signed relative media to the configured API origin for Mini Program/App,
hides expired/ambiguous/unsafe capabilities, and shows an image fallback.

## Verification

Actual Vue/Pinia/request-layer checks cover 15/15/3 pagination, rules, exact
claim bodies, duplicate taps, definite refusal versus uncertainty, receipt
recovery, explicit continuation, owner/lifecycle fences, status/time gates and
H5/Mini Program/App behavior. Existing source-binding fixtures and audits are
retained; an exact-source bridge accepts only the reviewed complete route/page
change and its historical state. Unknown partial edits still fail those checks.

Native PG16 tests exercise registered Worker/JWT routes, real inventory and
owned rows, replay, lock conflicts, strict query/body parsing, complete SQL and
sequence state, signed local-R2 bytes and existing ordinary/scope regressions.
The paid-menu authority matrix uses its existing disposable PGlite harness.

The separate hidden Browser host serves the shipped H5, registered Worker,
owned PG16 and local R2. It checks all17 phases, three explicit real grants,
33 actual visible issues (15/15/3), the actual owned-ID product route, complete
HTTP/SQL/serial/resource state and unchanged source/build inventories. Response
loss sends a strict prefix of the real committed response with full
Content-Length. Held delivery is released after a same-document owner switch;
a destroyed socket records abort, not proof of callback delivery. Synthetic
session setup and delivery faults are explicit QA controls. A visible QA
control temporarily isolates only prior synthetic UID11/22 local claim journals
from a previous disposable fixture; original strings/nulls are restored and
confirmed after all17 phases before the host can finish. Both controls verify
unchanged complete SQL/serial/resource state and cannot prove a grant. Raw
execution receipts are kept outside the repository.

This scope does not establish production login, deployed resource behavior,
live provider settlement or completion of the whole PHP-to-TS migration.
