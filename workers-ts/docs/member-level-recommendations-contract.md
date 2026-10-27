# Ordinary membership level recommendations

This increment restores the `商品推荐` section below the upgrade tasks of
immutable PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`, specifically
`view/uniapp/pages/users/user_vip/index.vue`, `components/recommend/index.vue`
and `components/WaterfallsFlow/WaterfallsFlowItem.vue`. The existing
`/pages/user/level` page and legacy alias remain registered as before.

## Correct catalogue and original presentation

The ordinary level page reads `GET /api/product/hot` with page size10. It does
not reuse the paid member homepage's `groom/list/5` catalogue or limit15.
Ten rows allow another page; a short page ends pagination. The section is
omitted for an empty result. Scrolling and the explicit load-more action share
one pending guard. A failed page does not advance, and retry requests that same
page. Duplicate IDs within or across pages reject the entire page instead of
silently dropping catalogue entries.

The section follows the PHP light background, ornamented heading and two-column
cards. It retains main image, activity frame, brand, visible product labels,
original price and advertised SVIP offer. `recommend_zs.png` is the already
copied original42×36 PNG,1619bytes, SHA256
`ea7291eb21857a4178478ff5c34a606bdd0240aabea8a1d8392e52733b859a5b`.
It is reused without resizing or re-encoding its stored bytes. Product prices
remain server decimal strings; an advertised `is_vip` flag does not establish
that the visitor has paid membership. Only server `price_type=member` is
labelled SVIP; an ordinary `price_type=level` offer is labelled 等级价, retaining
the exact server value. As on the PHP page's recommendation
component, no cart button, purchase or growth award is introduced.

## Additive authenticated view

Only `GET /api/product/hot?view=member_level&page=1&limit=10` selects the
new projection. In this view only single `view`, `page` and `limit` query keys
are accepted. Page is a canonical integer1..10000; limit is omitted or10.
An actual active JWT account is required. Responses use `private, no-store`.
The exact envelope is `{owner_uid,page,limit,list}`.

The default route keeps its existing array, visibility, sort, pagination,
monetary values, promotion-frame selection and legacy navigation behavior.
The new view reuses the same readers inside a single
`REPEATABLE READ READ ONLY` transaction and applies the existing strict
recommendation-owner checks to its actual activity target. Main-image authority
comes from the persisted product owner; frame authority comes from the actual
eligible platform frame. Only authorized stable references are emitted in
`image_source` and `activity_frame.image_source`, with their resolved previews
in the existing image fields. Private, foreign, inactive, malformed or
contradictory attachment metadata does not acquire a ticket. Signing occurs
after the read snapshot; it performs no SQL, R2, queue, provider, sequence-DO or
cache write. The separate native test uses the commissioned App LOGIN and
actual JWT; the interactive Browser fixture is explicitly local maintenance.

Product/activity navigation uses `recommendation_target`, including its actual
activity ID and expiry. A product ID is never substituted for an activity ID;
missing or expired authority requires a factual refresh. Native platforms map
relative signed previews to the configured API origin. Main image, frame and
label errors fall back independently. Signed-preview expiry hides the ticket;
refreshing recommendations renews only this catalogue read.

## Independent page lifetime

Recommendation reads wait for an authenticated enabled level overview, but own
their own request, page index, loading/error state and image deadline. A level
information refresh does not restart this feed; a feed refresh never invokes
level detection. The existing once-per-session detection and unknown-result
handling are unchanged.

UID, token, session version, visibility and disposal fence every response,
navigation failure and image callback. Hide, unload, logout and account
replacement abort reads and clear this document's products. Returning starts a
fresh page1 read. No confirmation dialog is added.

## Verification boundaries

The runtime suite executes the real Vue/Pinia stores, API decoder, page setup
and both composables. It checks overlapping scrolls,10/10/short pagination,
empty state, exact-page retry, duplicates, full account replacement, stale
callbacks, unsafe data, native image mapping, expiry while an append is pending,
actual projected destinations and preserved detection count. Strict Worker
checks, the existing hot-pagination/frame assertions and real commissioned App
PostgreSQL tests provide separate evidence.

The additive Browser host uses built H5, the actual registered Worker/JWT,
owned PostgreSQL and local R2 bytes. It records each actual request and response,
complete SQL/sequence snapshots, resource state and source/build hashes. Its
synthetic session bootstrap and explicit empty-catalogue SQL setup are recorded
QA controls. A truncated or held response retains the original Worker bytes;
no replacement business response is fabricated. Ordinary product navigation
may legitimately record a visit: its actual `waitUntil` work is drained and its
exact product-log/visit rows and serial effects are accounted separately from
read-only recommendations. No production login form, payment, cart action,
provider transaction or native-device playback is claimed by that Browser run.
