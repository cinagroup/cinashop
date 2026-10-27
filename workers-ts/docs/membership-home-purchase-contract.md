# Membership home: PHP appearance and recoverable purchases

The immutable PHP reference is `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`,
`view/uniapp/pages/annex/vip_paid/index.vue`. The existing legacy URL still
resolves to the registered `/pages/user/vipOpen`; no new Uni page is registered.
The page restores PHP's black/gold header, identity, horizontal rights and plans,
member coupons, recommendations, agreement and fixed purchase footer.

Four PNGs are reused byte for byte, without re-encoding: PHP's `vip-paid.png`
and three embedded PNGs from that page's CSS. Their TS paths under
`view/uniapp-ts/src/static/membership/` and SHA-256 values are:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| vip-paid.png | 33700 | `0faf52d1fb72ad5df7157a92bfd4791590773fce1d9dfda6f9f84d7683d56d92` |
| home-header.png | 86570 | `2a843208404c866fbaa3964a9144fdc269d974bfa52eab104018109c24959213` |
| coupon-unavailable.png | 1096 | `d5ebf261f71dc0f51f6687569296ce1fc3be004b72ad21a8c9b549ca5774316f` |
| coupon-footer.png | 5398 | `9ced81eee7132520d9691a32c0ea5bb8a4ad8bf43ff78bc580b7e3a176fde678` |

## Reads and purchase authority

Authenticated `GET /api/user/member/card/index?home=1` retains the original
index data and adds a fresh lowercase UUIDv4 `purchase_request_id`. The client
checks `is_get_free.user_info.uid` against the current authenticated owner.
The default index and `?rights=1` responses retain their existing keys. Member
levels greater than zero include the value `2` produced by card activation.
Used free trials are hidden; permanent members have no purchase choices.
The coupon preview links to the registered `/pages/user/memberCoupons`, which
loads full rules and the actual owned-coupon claim/use flow described in the
[member coupon contract](membership-coupons-contract.md). The existing agreement
reader supplies `payVip` content.

The existing `POST /api/user/member/card/create` optionally accepts exactly
`{member_type,from,request_id}`. Omitting `request_id` preserves the legacy body
and response behavior. Modern input validates exact original UTF-8 bytes,
duplicate decoded keys, scalar types, unknown keys and a 4 KiB limit; this is
not a streaming size bound for legacy requests. Its response remains the original
five fields `{id,order_id,pay_price,paid,overdue_time}`.

Modern order IDs are a stable SHA-256 mapping of a domain, authenticated UID
and request UUID, shortened to fit the existing 32-character column. The UUID
is an idempotency identifier, not an authorization credential. JWT owner checks
and persisted order ownership/domain enforce authority. APP_KEY rotation does
not change the mapping. Under the existing user-row lock, a matching persisted
order is recognized before current free/permanent/configuration/plan gates.
A conflicting plan, channel or row remains a business409; it cannot be treated
as an unused UUID. Modern creation makes no Durable Object sequence allocation.
Legacy creation retains its existing allocator. No schema migration is added.

Owner-bound `GET /api/user/member/card/index?purchase_request=<UUID>` returns
`{owner_uid,request_id,state,order}` with `private, no-store`. State is either
`committed` with the persisted order or `unknown` with null. Absence is never
proof of nonapplication. No client UID, amount, paid flag or expiry is trusted.
The existing `/api/order/cashier/:orderId/vip` supplies authoritative payable
state, price and method readiness. A paid plan first creates the order, then
requires a separate explicit payment action; opening the cashier never debits.

## Recovery and lifecycle

Before any write, a bounded UID-specific durable journal stores its original
UUID, plan, channel, order identity and any submitted payment method. It stores
no login token, card password or provider payment ticket. Malformed/unavailable
storage fails closed. H5 uses an exclusive same-origin Web Lock; App and Mini
Program use a module-local latch. Duplicate taps cannot overlap a write.

A transport or malformed response preserves uncertainty. Read-only recovery
can find the original order without another POST. Explicit continuation can
replay only that same creation UUID, plan and channel, or resume payment of the
same order and method after fresh receipt/cashier reads. Only a known initial
create rejection may clear its journal; later receipt/cashier failures cannot
clear a successful create or reclassify a submitted payment as unsubmitted.
No timer, focus event or lifecycle hook automatically submits a purchase.

Every request, callback, media error and navigation is fenced by UID, token,
session generation, persisted auth and page visibility. Hide/unload, renewal,
logout or owner replacement aborts owned requests and clears private view data.
A previous owner's response cannot populate the next owner's page. A confirmed
paid receipt remains confirmed if only the subsequent home refresh fails.
Signed-media error fences and expiry timers renew when an unpaid order retains
its existing home/product data.

## Provider invocation and recommendations

Purchase channels follow PHP: ordinary H5 `weixinh5`, WeChat H5 `weixin`,
MP-WEIXIN `routine`, App `weixin`. The independent existing Form-type header
remains h5/routine/app. Membership alone opts into complete WeChat SDK invocation
fields; other callers of the shared payment service retain the old DTO.
JSAPI includes the actual configured AppID. App orderInfo contains all seven
strings and a signature over the raw prepay ID, generated with the same original
configuration snapshot as provider creation. App uses orderInfo; Mini Program
uses top-level signed fields, as documented by
[uni-app App WeChat payment](https://uniapp.dcloud.net.cn/tutorial/app-payment-weixin.html)
and [uni.requestPayment](https://uniapp.dcloud.io/api/plugins/payment).

All SDK waits have a 30-second client bound. Expiry preserves an uncertain
original payment; it neither cancels the provider payment nor proves failure.
SDK success is followed by an actual server receipt and never marks an order
paid locally. H5 redirects validate exact HTTPS provider hosts. A generic
cashier WeChat readiness flag can reflect another configured profile; the
actual profile-specific pay service remains authoritative.

Explicit page/limit parameters on `/api/groom/list/5` use the existing actual
recommendation pagination, preserving visibility filters and snake-case DTOs.
The page loads 15 items, then appends the next page. The historical unpaged
limit100 behavior is unchanged. Only explicit pagination resolves permitted
primary product images in an RR READ ONLY transaction and signs them afterward;
legacy unpaged image values are preserved. Image errors and expired signatures
show a fallback instead of exposing a storage reference.

## Verification boundaries

Actual Vue/Pinia runtime checks cover purchase intent, known rejection versus
uncertainty, original-order recovery, duplicate taps, owner/lifecycle fences,
retained media, pagination and three platform SDK contracts. Separate actual
PG16 tests exercise registered routes, JWT, row locks, order replay, full SQL
and sequence state, and existing payment reconciliation/configuration authority.
The native locking test observes the actual PostgreSQL blocking-PID chain.

The separate membership-home Browser host serves the actual H5 build and
registered Worker with owned PG16 and local R2. It records full source/build
inventories, exact HTTP exchanges, complete SQL/serial snapshots and signed
asset bytes. Synthetic session bootstrap and initial permanent-member setup are
explicit QA controls. Lost delivery sends a strict prefix of the actual committed
response with its full Content-Length; held delivery is released only after an
owner switch. An already-aborted socket is recorded as such, not as proof of
callback delivery. No manufactured business response or external provider
transaction is used. Raw execution receipts remain outside the repository.

This increment does not claim production LOGIN grants, deployed Durable Object
behavior or live WeChat/Alipay settlement. The separate legacy coupon page now
has its own migration contract and verification. Whole-project PHP-to-TS
migration remains ongoing.
