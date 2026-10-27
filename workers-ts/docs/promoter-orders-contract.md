# Promoter orders: PHP consumer parity

The finance page exposes 分销订单 at `/pages/user/promoterOrders`. Client navigation and Worker FAB both resolve `/pages/users/promoter-order/index` to this registered page. The grey background, search pill, 全部/今日/昨日/近7日/custom dates, rounded white buyer cards, circular avatars, frozen badge, commission/pending text and snapshot product titles follow immutable PHP commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`, `view/uniapp/pages/users/promoter-order/index.vue` and `components/timeSlot/index.vue`. The existing copied PHP empty-order asset is reused. This restores the source design; it does not claim pixel equality against a running PHP deployment.

## Business authority and corrected legacy query

PHP `UserBrokerageServices::spread_order`, `StoreOrderDao::getList`, `StoreOrder::searchPidAttr`, `ModelTrait::searchTimeAttr` and the cart-info title helper are authoritative. Ordinary, paid, nondeleted orders with refund status0/3 are eligible when any of the five commission roles belongs to the authenticated caller. PHP's `pid=0` accessor means **pid>=0**, including physical split children and excluding pid=-1 payment headers. Pagination is **pay_time DESC,id DESC**, rather than id alone. Both corrections apply to the legacy response and the additive view.

Per-order commission selects staff, then agent, division, first-level, second-level. The report total sums **every matching role column**; it obeys the selected order-add-time interval but ignores keyword. Search matches order/buyer/address/current-product/activity fields as PHP does, without returning contact information. The UI explicitly explains the distinct count/commission scope when a keyword is applied. The PHP false value `"0"` keeps its legacy no-keyword-filter behavior.

Month keys derive from order `add_time` in Asia/Shanghai. Returned months preserve first appearance in the payment-ordered page; dates and months need not be contiguous. Month count/payment totals cover the full keyword-matched month, not just the current page. The client merges repeated months by key without duplicating headers or totals. Product display titles come from cart purchase snapshots joined with `|`, preserving spaces and empty segments. Current product text remains a search source, not a replacement display title.

The PHP brokerage relation filters only caller UID and order link ID. The migrated query now considers that same candidate set, including outgoing/nonincome records. PHP leaves relation ordering unspecified; TS chooses the lowest ledger ID deterministically. Snapshot titles similarly use ascending cart-info ID; the existing camelCase title fallback remains compatible. These are explicit deterministic extensions, not claims about an unspecified PHP database iteration order. Order status2/3 determines the 返佣 label independently from the selected ledger's frozen timestamp.

Legacy time arrays use inclusive `between`; equal endpoints or a Shanghai-midnight stop add86400 seconds, and a single zero endpoint is an actual bound. The existing legacy parser still clamps negative timestamps and oversized integers. An add_time0 order has an empty month key; TS explicitly aggregates those rows together instead of reproducing PHP's failed parsing of an empty month string.

## Additive bounded read projection

Only a URL with one `view=promoter_orders` opts into the new contract: `POST /api/spread/order?view=promoter_orders`. The sole URL key is `view`. A bounded UTF-8 JSON object may contain only page1..1000 (default1), fixed numeric limit10, start/stop (default0/0), keyword (defaultempty, maximum64 Unicode code points, trimmed). Duplicate JSON keys, noncanonical numbers, unknown keys, control characters, malformed Unicode and invalid types are rejected. Date bounds are both0, or a positive int32 complete Shanghai calendar-day interval from00:00:00 through23:59:59. The original device-local timezone and pagination reset bugs are not carried into the new page.

```
{owner_uid,query:{page,limit:10,start,stop,keyword},count,sum_brokerage,list,months}
// list record:
{id,order_id,uid,nickname,avatar_source,avatar,paid_at,add_time,time_key,
 type:'brokerage'|'number',time,is_frozen:0|1,store_name,number}
// month record:
{month,count,pay_price}
```

Commission and payment amounts remain signed two-place decimal strings throughout SQL, transport and rendering. Negative values are retained, and aggregates are not narrowed back to an individual decimal column's range. The client never converts money through Number. The legacy response shape does not acquire `paid_at`, owner metadata or modern media fields.

The modern report performs active-caller validation, legacy business query, payment-timestamp lookup and persisted buyer/avatar authorization inside one repeatable-read, read-only transaction with deadlines. Signing is disabled during the reused legacy call; only references authorized against the buyer's persisted UID and attachment metadata receive a preview after the transaction. Missing/deleted buyers keep their genuine order with an empty identity/media fallback. No caller-supplied buyer ID grants access. A private no-store response does not contain address, telephone or full order detail.

## Page lifecycle and side-effect boundary

Search and date changes reset to page1 and invalidate old reads even while loading. Date changes preserve the applied keyword. Full-day custom dates use native pickers; invalid ranges leave accepted results intact. Failed append retains accepted cards/summary and retries the same next page. Duplicate IDs, inverted payment order, changed count/total or changed previously-seen month aggregates reject an append. Independent requests do not promise one permanent snapshot while orders change. At most10000 orders are displayed.

The visible page/account/session generation owns requests, image errors and preview leases. At the earliest signed-avatar deadline, all signed slots in that page fall back until refresh; static/HTTPS images remain. Applied custom-date captions come from the accepted interval, never unsubmitted picker drafts. Hide, unload, logout, renewal and account changes invalidate old callbacks and clear private rows. Guests make no report read and have an explicit login button. No confirmation dialog or order-detail action is introduced. The business POST is a **read**: no commission, withdrawal, cart, database, sequence, KV, R2 or queue mutation is required; PHP's title-cache write is deliberately unnecessary.

## Validation scope

The actual Vue/Pinia page runtime suite covers pagination/termination, retry, Shanghai boundaries, retained keyword/custom dates, invalid filters, rapid queries, account/session lifecycle, strict response integrity, signed exact amounts, media failures and expiry. H5, Weixin and App builds validate compiled resources and component bindings; these do not claim a native-device release.

The isolated native PG16 suite uses real JWT authentication and separately commissioned App LOGIN roles. It validates both legacy and modern contracts, physical split children, five-role precedence/additive totals, payment ordering/months, full search paths, Shanghai stop seconds, ledger selection, large/negative money, missing/deleted buyers, media authority and read-only repeatable snapshots across every migrated table and sequence.

The opt-in `audit:promoter-orders-browser` host serves the actual built H5 and registered Worker using a complete283-table PG16 fixture. Hidden Browser traverses the finance entry, real POST report, truncated page2/retry/termination, keyword, all preset/custom date filters, unmatched-query empty state, account replacement and desktop width. QA session controls replace iframe documents; they are separate from business reads and do not by themselves prove a same-instance stale JavaScript callback (covered by the runtime suite). A held response retains actual Worker bytes. Business fixture rows never change during the flow. Full source/build manifests, requests/responses, SQL/sequence snapshots, R2 byte identity and host cleanup are retained outside the repository. No live provider, production deployment or native-device behavior is claimed.
