# Membership-card activation: PHP appearance and one-time redemption

The immutable PHP reference is `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`,
`view/uniapp/pages/annex/vip_paid_active/index.vue` and its two adjacent assets.
The TS activation page uses the same cream background, SVIP hero, outlined
inputs, black/gold button and brown success screen. `card-activation.png`
(213498 bytes, SHA-256 `100f575450d27d80ed157301bfc798570da87fb121bc42ef3b99e6bd58b0ce6b`)
and `activation-success.png` (2725 bytes, SHA-256
`c0359dffaa67d7f64b270ec43abb71da416b45d3f7b4172f5278d4f104859ed1`)
are byte-for-byte copies of PHP's `vip-paid-active.png` and `active-zs.png`.

## Entry and live authority

`/pages/annex/vip_paid_active/index` now resolves to the existing native
`/pages/annex/vip_active/index`, rather than the membership-purchase page.
The public personal-menu/poster capability filter applies the live
`member_card_status` gate to this native target and its legacy alias, just as
for membership home and rights. There is no additional registered Uni page.

The form calls the existing authenticated
`POST /api/user/member/card/draw`. Its three fields are `member_card_code`,
`member_card_pwd` and `from`; there are no UID or client-calculated expiry fields.
Code and secret are trimmed, bounded to the existing 20/12-character limits,
and control characters are refused. Historical short credentials remain valid;
the client does not impose the generated card's length or alphabet.

The body channel follows PHP: ordinary H5 and APP use `h5`, WeChat H5 uses
`weixin`, MP-WEIXIN uses `routine`. The independent existing `Form-type` header
is still `h5`, `app` or `routine`. In particular, APP's header does not change
the body to `from: app`, which the authoritative redemption service rejects.

The production redemption service is unchanged. It checks live configuration,
locks user, card and batch, checks one-time use and secret, then atomically
claims the card, increments the batch, extends membership, and appends the
zero-price membership order and status. Failed credential/used-card attempts
can consume a Sequence allocation before SQL rejects them; that is distinct
from SQL sequence advancement and persisted accounting. SQL rollback likewise
cannot undo a serial or Durable Object allocation.

The success nickname comes from the real owner-bound
`GET /api/user/info?profile=1`; both `actor_uid` and `profile.uid` must match the
current persisted customer session. There is no synthetic preview success.
The success screen stays until the user chooses “开始使用” or views rights.
“开始使用” relaunches the existing membership home and reads its actual state.

## Lifecycle and uncertain outcomes

A synchronous submission latch permits one pending POST. The password clears
when submission starts; successful and unconfirmed outcomes clear both input
fields. Every request and navigation is fenced by UID, token, session generation,
page visibility and persisted storage. H5 focus/storage events reconcile the
owner. Hide/unload or session replacement aborts owned requests and clears private
nickname, credentials and receipt; an older completion cannot display success
or navigate a new owner. Returning from rights for the same owner can retain
the confirmed success phase, with a freshly read nickname.

An explicit business rejection in an HTTP 2xx envelope permits manual correction.
A transport failure, non-2xx response or malformed success receipt is uncertain:
the form cannot submit again automatically or by repeat tapping. It offers an
explicit membership-state read and “使用其他卡密”, which clears local state and
never sends a POST. Leaving during a pending request also preserves this
uncertain barrier for the same owner. The page never retries or redirects a redemption on a timer. The server's
one-time card claim also protects against lower-level transport retransmission.

## Verification boundaries

The Vue/Pinia runtime tests use the actual request scope, API decoder and
composable with native I/O under test control. They cover the owner/visibility
fences, delayed callbacks, duplicate tapping, channel contracts, known rejection,
uncertain outcomes and explicit navigation. H5, MP-WEIXIN and APP builds remain
separate validation from a rendered browser interaction.

`membership-card-activation-postgres.test.ts` uses the registered application,
actual customer JWT middleware, SQL transactions and complete table/sequence
snapshots. Native PG16 peers observe the actual blocking PID for competing card
claims, while the memory fallback checks sequential business behavior only.
Resource spies and immutable sentinels guard R2, queues, balances, coupons,
physical orders and existing membership accounting. It does not establish
production database LOGIN grants or a deployed Durable Object instance.

The separate `membership-card-activation.acceptance.ts` host serves the real
H5 build and forwards business traffic to the registered Worker with owned PG16
and local R2. It inventories source/build bytes and all owned tables/sequences,
and records actual HTTP requests, responses and signed asset bytes. Its controls
are synthetic session bootstrap and response delivery: a lost response sends HTTP headers and a strict prefix of the real committed
Worker response, then interrupts the body (an empty reset can trigger a browser
connection retry); a held response is released after
an explicit same-document owner switch. An aborted socket is reported as such,
not as proof that its callback was delivered. These QA controls are not product
UI or fake business responses. No browser is launched by the test host and no
external provider call is permitted.

The exact-source migration bridge peels only this reviewed activation change
before the prior rights/customer/audit chain; immutable historical report and
fixture bytes are retained. Browser evidence and execution receipts are stored
outside the repository and never replace source assertions.
