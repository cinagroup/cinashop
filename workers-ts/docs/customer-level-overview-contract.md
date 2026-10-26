# Customer member-level overview

Reference PHP commit: `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`,
`view/uniapp/pages/users/user_vip/index.vue` and the corresponding membership,
configuration and sign services. This increment covers the level carousel,
level steps, four privileges, three upgrade task destinations and the existing
growth-record link. The PHP product recommendation section is outside this
increment; this page does not claim that catalogue feed has been migrated.

## Explicit overview on the existing info route

`GET /api/user/level/info` retains its six existing fields and its established
queries/config priority. Only one canonical `overview=1` opts into the additional
`overview` property. Empty, repeated,0 or other values fail validation. Unknown
UID query values never select the authenticated account. Both responses are
private and non-cacheable. The default remains usable without a `user_level`
read or the additional media/task queries.

The opted response reads the original six fields and the overview in one
REPEATABLE READ / READ ONLY transaction. Media signatures are generated after
that transaction. `actor_uid` is the authenticated active account; `exp` and
`discount` preserve database numeric(12,2) strings. Visible, nondeleted levels
are ordered by grade then ID. Up to1000 complete levels are supported; overflow
fails rather than silently truncating the catalogue.

An actual current card requires all of: stored activation, the user's stored
level pointing to a visible definition, and an active, nondeleted grant for
that user and level. Without this evidence, current ID is0, current grade is
null and the first card is explicitly a preview. Unlike PHP's copied lowest
grade fallback, the preview never labels that card as an earned current grade.
Feature-off exposes no levels and no executable tasks, retaining own exp.

The overview follows the platform config winner (ascending sort/ID followed by
last-value adoption), matching eligibility detection. The legacy six fields
keep their earlier first-value behavior when duplicate feature config exists.
Task amounts decode numeric scalar config; missing/null values are empty and
the page displays0. Installation seed values10/1/25 are not runtime defaults.
The sign switch uses `sign_status` when present, with `sign_in_switch` only as
fallback. `sign_count` counts all actual own sign rows, as PHP does; it is not
a consecutive-day or distinct-day calculation.

PHP bcsub at scale0 determines `lack_exp_num`: threshold100 minus exp42.75
produces57 and PHP progress43%. The frontend retains that algorithm while
bounding a zero/negative threshold to a finite0 or100%. It does not invent a
more precise progress contract.

## Eligibility is a measured business write

On first entry for a page instance/session, the page calls the existing
`GET /api/user/level/detection`, then opted info. Eligibility detection may
insert or restore eligible own grants and update own stored level. It never
activates an account, changes exp/integral/money, creates reward bills/coupons,
or invokes R2/KV/queue/provider writes. Replay is business-state idempotent;
it can still execute an UPDATE and is not described as zero SQL writes.

A transport timeout/cancellation cannot undo a dispatched server operation.
An uncertain result is shown, followed by info only if the same page and owner
remain active. Only an explicit retry repeats detection. Refresh, return from
other pages and signed-image renewal read info only. Hide/unload/logout and
UID/token/session-version changes synchronously clear private cards, fence late
responses and prevent chaining an old owner's info after detection.

## Original visual material and navigation

Seven exact PHP PNG files are under `src/static/php-level` in UniApp. Their
fixed PHP source paths, bytes, dimensions and SHA256 values are recorded in
`scripts/fixtures/level-overview-original-assets-20261026.json`. They supply the
four privilege and three task illustrations. No replacement bitmap was
generated. The small crown is local CSS geometry, not a claim of original
PHP iconfont reuse; global PHP CSS/JavaScript is not imported.

Merchant-configured card texture/header/color remain independent real fields.
Canonical attachment slots require persisted platform ownership, module/file
and raster namespace checks before signing. Invalid/expired media has a neutral
fallback. The frontend accepts safe server-resolved image sources without CSS
URL interpolation, isolates load failures by slot, renews canonical tickets
with info only before expiry and avoids retry loops for expired tickets.

The carousel/step list supports both1–5 and6+ levels. Refresh preserves the
selected ID if it remains visible. Sign navigates to `/pages/user/sign`, buy
uses native switchTab to `/pages/goods/cate`, invite opens `/pages/user/spread`.
These actions navigate; they do not award experience or submit orders. The
literal growth navigator still opens `/pages/user/growthRecords`.

## Verification boundaries

`member-levels-runtime.test.cjs` runs actual Vue/Pinia, request scope, adapters,
composable and SFC setup with only native lifecycle/transport replaced. Its
synthetic amounts are fixtures. `user-level-overview-postgres.test.ts` exercises
registered routes, JWT/account checks and real SQL, defaults to PGlite and
supports the owned PG16 runner. Full12-table/11-sequence snapshots distinguish
read-only info from exact eligibility deltas. PG16-only peers cover concurrent
account locking and snapshot consistency across a concurrent commit. Failed
transactions may consume sequence values; this is measured rather than hidden.

The opt-in Browser host uses actual built H5, registered Worker and owned local
PG16 with synthetic accounts. Session bootstrap does not verify the login
form or an independent production LOGIN ACL. Business reads, detection writes,
fixture setup, raw responses, DOM adoption and asset HTTP receipts are recorded
separately. The sign destination may issue its existing exact read-style
`POST /api/sign/user {sign:1}`; it is not a sign award. Website QR cache generation
is explicitly prewarmed with the real service before baseline; navigation then
covers the already-ready code read, not first-time cache creation. Local rate
guard bindings advance real policy counters and record those normal guard
side effects separately from business DB/R2/queue writes. They do not prove a
production Durable Object. Toolbar returns create a fresh H5 document; same
instance hide/show behavior is covered by the actual runtime tests.

Historical growth Browser receipts retain their original bound source/build
and read-only scope; replay that host against its recorded commit, not this
new level page. They are not receipts for this new page.
