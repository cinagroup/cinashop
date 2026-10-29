# Collection management and empty-state recommendations

The current post-recovery runtime entry passed all 72 cases. The canonical
admin inventory and 161 capability/inventory cases also passed against the frozen
source. Earlier strict Vue/Worker checks, H5/Weixin/App builds, 657 Worker unit
cases and three formal-App PostgreSQL scenarios are historical results described
below; their aggregate receipts were recovered after the reboot, but their
original full raw logs and 43-exchange database journal were not recovered.

The fresh post-recovery local Browser acceptance completed all 35 phases in one
V12 run. The supplemental independent data and strict native-image/actual
operator-review gates exited 0. The original V12 driver and outer exits remain 1
because the first offline verifier compared a raw PostgreSQL CHAR(30) MIME value
with an unpadded string; the exact correction and retained failure are recorded
below. Earlier attempts are retained separately and are not added to this run.

This slice does not establish completion of the repository-wide migration.

## Authoritative source and remaining parity

The PHP reference is immutable commit
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`,
`view/uniapp/pages/users/user_goods_collection/index.vue`:

- Lines 7–68 and 182–244 expose management, row selection, select-all and one
  cancellation of the checked product IDs. The existing TypeScript page already
  implemented product/video lists, pagination and single cancellation.
- Lines 71–74 and 294–304 render the real hot product catalogue when empty.
  Recommendations are product links and do not add anything to the cart.

## Resulting behavior

`/pages/user/collect` keeps its product/video tabs and the old
`/pages/users/user_goods_collection/index` navigation alias. Management switches
card taps into selection, including unavailable records that remain cancellable.
Before router creation, the H5 entry maps exactly the legacy collection hash
to `/pages/user/collect` while preserving its raw query suffix. Explicit
`work_oauth=1` entries retain the existing OAuth flow. The PHP page's JavaScript
truthiness of the delivered `active` value selects the video category: a
nonempty query string such as `0` or `false` remains truthy, while an omitted or
empty value selects products. The resulting API category remains the literal
`product` or `video`.
The footer identifies selection as loaded records and shows the exact cancellation
count. Select-all takes at most the first 100 loaded identities; loading another
page does not silently select it. Exiting, refreshing, changing category, hiding,
unloading or changing account clears the selection and playback state.

The explicit cancellation button submits one existing `POST /api/collect/del`
with `{id: [...selectedProductOrVideoIds], category}`. Empty, duplicate, forged or
more than 100 IDs are refused locally. Pending writes prevent duplicate submits
and category/refresh actions. The existing Worker service validates the IDs and
category, runs a transaction, deletes only current `uid` + category + `collect`
relations, and synchronizes existing counters. Native validation exposed two
existing input bugs, repaired with narrow Worker runtime changes:

- The local `collectIds` helper now rejects values above PostgreSQL int4 maximum
  `2,147,483,647` before database casts. Existing positive number/string parsing,
  server-side duplicate-ID deduplication and the 100 distinct-ID limit remain.
  This shared helper also serves the existing collection-add paths; no valid
  persisted product/video ID is excluded.
- `collectDel` now rejects an explicitly present non-string `category`, including
  arrays, repeated form fields, null, booleans and numbers. Omitted or empty
  string categories retain the product default; valid string trimming and
  lowercase normalization remain. Category parsing for add and GET is unchanged.

No route, schema, privilege, UID authority, lock or counter-recomputation policy
is added or broadened. The front end already sends a bounded array of unique
accepted numeric product/video IDs and the exact string category. The server
continues to accept legacy duplicate IDs and compatible numeric-string/CSV forms;
these compatibility inputs are not a requirement for front-end selection.

Only a confirmed `null` receipt triggers the fresh first-page read. A lost or
malformed receipt retains accepted records and the selection, blocks replay and
asks the user to refresh. The refreshed server state decides whether the original
write succeeded. No speculative bulk removal is used.

A successful zero-count collection response enables recommendations for either
category. A missing-object page with a positive relation count continues the
existing pagination and does not claim the collection is empty. Guest, invalid
route, loading and error states do not start recommendations.

Recommendations reuse the **existing** `GET /api/product/hot` opt-in
`{view: 'member_level', page, limit: 10}`. That name identifies an existing DTO;
no membership level detection, activation, award or mutation is invoked. The
underlying hot catalogue remains the real product selection used by the PHP
empty state. Its existing owner/page/limit envelope is validated, and source
references stay separate from metadata-authorized image previews. Main images,
activity frames and label icons retain signed capability expiry and per-render
native error fences. Missing, unsafe, expired or mismatched media becomes a
readable placeholder. Price/brand/labels are server data; member prices are
marked as reference prices. Ordinary, presale and activity destinations use
existing projected identities, and expired or malformed targets do not fall
back to an invented product identity.

The recommendation state machine already provides bounded pagination, rejection
of duplicate appends, manual retry of a failed page, media expiry, independent
refresh and disposal. The collection page supplies a current owner/persisted
storage/lifecycle enable condition. Its own requests now use the same persisted
owner guard, with storage synchronization on return. Late old requests cannot
clear a replacement account or repopulate its collection.

## Frontend validation and remaining acceptance

`view/uniapp-ts/scripts/collection-management-runtime.test.cjs` executes the real
Vue/Pinia page and composables with controlled native I/O, including H5, Weixin
and App source guards. It covers selection and the 100-ID bound; existing
category/ID authority; loaded-page select-all; double submit; uncertain receipt
and explicit reconciliation; owner/storage replacement; hide/unload fences;
strict hot projections; bounded paging/retry; real activity targets; source and
preview mismatch; stale image events; and no unexpected business mutation.
Existing `user-collections-runtime.test.cjs` (14 cases) and the reused
`member-level-recommendations-runtime.test.cjs` (30 cases) remain part of the same
test entry; the management file contributes 28 cases. All 72 passed with
Node `--preserve-symlinks --test --test-concurrency=1`.

All memory-heavy checks must run through exactly one outer
`bash /home/cina/cinagroup/tools/validate-serial.sh ...`; Node test concurrency is
1. The historical frontend run used one Python driver after obtaining that lock, with
actual exit code 0 for runtime, strict types and each of the three builds.
Inherited static-resource warnings for other existing pages remain visible in
the build logs. These frontend results do not substantiate actual browser or
native-device claims; database validation is described separately below.

The first run preserved 68/70 passes with two new test errors: an unexported SFC
field assertion and an inconsistent activity fixture. The corrected second run
preserved 69/70 and exposed a real synchronous reactivity boundary: clearing
rows/count before invalidating `ready` briefly enabled an immediately aborted
hot request. `clear()` now invalidates `ready` first. A dedicated regression
verifies nonempty and failed refreshes never create that transient confirmed
empty state. The third pre-reboot full run passed all 71 then-current cases and all four subsequent
checks. These attempts remain identified separately in the recovered aggregate
receipts; their original full logs are unavailable after the reboot. The current
72-case entry adds the cold legacy route/query regression and passed after recovery.

## Formal-App PostgreSQL verification

This section records the pre-reboot verification. Recovered aggregate receipts
retain the actual exits and counts; the original full 43-exchange journal and raw
logs are unavailable. Current Browser evidence is accounted for separately below.

The completed Worker validation used one outer serial wrapper, one Vitest worker
and no file parallelism. Both strict TypeScript configurations exited 0, all
657 unit cases passed, and all three local PostgreSQL 16.14 scenarios passed.
The 1,707 frozen Worker inputs stayed unchanged. Temporary fixtures were removed
and PostgreSQL was stopped; zero fixture directories remained.

The native cases use the existing complete runtime fixture and all 185 registered
migrations. Formal restricted App/Admin LOGIN identities are independently
commissioned and audited. Actual registered `createApp().fetch(Request)` calls
perform authentication and controller dispatch, and business SQL uses only the
formal App container over local TCP PostgreSQL. Maintenance is confined to
fixture/oracle setup; this is not a browser or production-network run.

The three scenarios exercise:

1. Product/video category and current-JWT-UID isolation, unavailable and missing
   objects, duplicate compatibility IDs, replay, 100 distinct IDs, real counters,
   and the existing read-only hot catalogue for two owners.
2. Malformed, noncanonical, fractional, nonpositive, oversized and wrong-category
   input, plus rejected anonymous/wrong-token/wrong-token-type requests and real
   account status, deletion and password-version revocation before requests.
3. PostgreSQL int4 overflow and ambiguous duplicate/non-string category rejection
   before any collection mutation.

An independent Python standard-library verifier accepted all 43 recorded API
exchanges: 10 successful cancellation calls, eight read-only calls and 25
rejections. The cancellation set includes one 100-ID call and two replay or
foreign-only calls with zero state delta. The read-only set includes two owners'
hot-catalogue metadata/source previews with independently checked 900-second HMAC
capabilities. The verifier checks raw request/response and JWT evidence,
independent expected relation deletion and counter recomputation, every row of
all 283 tables, and every state of all 229 sequences. All unrelated table rows
and serial states must match. Replay means zero resulting state change and no
serial allocation; the existing counter code may still execute a same-value SQL
`UPDATE`. Zero physical SQL writes or zero SQL execution is not claimed.

Earlier native failures remain recorded in the recovered aggregates. The first attempt stopped before
native execution because cross-frontend dependency links were missing. The
second exposed a new test assertion about an existing admission guard. The
third passed two scenarios and retained the real overflow/ambiguous-category
failure, including an actual wrong-category deletion; the two narrow input
repairs above resolved it. The fourth complete Worker run passed. The first
independent-verifier attempt expected top-level JWT `id/type`; its failed record
is identified in the recovered aggregate, and the second correctly validates the existing PHP-compatible
`jti` claim object without weakening cryptographic or state assertions.

Private synthetic JWTs, signing authority, raw snapshots and exchange journals
are excluded from Git candidate paths. The source, tests and this aggregate
contract do not embed private runtime evidence or dependency symlinks.

## Current Browser verification

On 2026-10-28, run `ab7f978f-6f4e-4b92-bc27-3072c4aaf847`
completed all 35 ordered phases against the actual frozen H5 build and registered
Worker, using independent restricted App/Admin PostgreSQL 16.14 identities.
The private host strict TypeScript check exited 0. The host test itself exited 0;
its first independent offline verifier failed as described below.

The actual same-run evidence contains 137 Worker exchanges, three cancellation
POSTs, one normal-product visit, 13 hot metadata reads, 19 asset reads and two
authorization revocations. Independent raw verification checks all 283 tables,
229 sequences, selected IDs/category/current owner, counters, raw HTTP/JWT bytes
and 900-second signed image capabilities. The 37 configuration reads cover only
finite synthetic cache hits derived from missing baseline rows, not cache misses
or production KV behavior.

The phases cover loaded-page selection and append; the real committed deletion
whose response is truncated; replay blocking and refresh reconciliation; final
product/video cancellation and recommendations; missing, corrupt and restored
media; normal and bargain-detail navigation; password/status revocation; a second
owner; desktop/mobile selection layout; a positive relation count with its object
missing; the unchanged PHP legacy hash as a cold guest and owner entry; and final
guest clearing. The legacy entry is canonicalized by the product entry code,
without a QA hash rewrite. No purchase or bargain-participation action is used.

The original independent verifier failed on attachment authority because the
formal schema declares `att_type CHAR(30)`, the fixture writes `image/png`, and
raw `to_jsonb` snapshots retain its 21 trailing ASCII spaces. Production media
policy already trims this field. A separate supplemental verifier changes only
its frozen planning-directory binding and the expected raw MIME literal to
exactly `image/png` padded to 30 characters. Reversing those two changes recovers
the original verifier byte for byte; no normalization, assertion removal, raw
journal edit or product change is made. Independent review reproduced the old
failure with the actual signed URL, accepted the corrected positive case and
rejected 33 authority/MIME/signature/TTL variants. Original private files,
failed log, driver exit 1 and outer exit 1 remain unchanged. The supplemental
complete data and visual checks both exited 0.

All 35 original native JPEGs were recovered by exact printed SHA, actual ACK and
raw screenshot metadata, with no missing or substituted image and no re-encoding.
Each was actually visually reviewed, then strictly decoded against the pinned
Python/Pillow/Node/JPEG decoder identities. The complete visual receipt passed;
its SHA-256 is `78c3a1d51772f08d41c74c76ccecb9aba5c5bf46d334002b16473be0b44804de`.
The raw evidence SHA-256 is
`055b675a50f4c1951429844c1b3a5065f08d3e8a9aacb9c24c4b8ed77aca6567`;
the supplemental verifier SHA-256 is
`e38d2d2d2bc6ddb44a9674f1b6b47d01aab9f9f6ca12ca08b693852a25d0c3cb`.

The owned HTTP and PostgreSQL ports refused connections after normal cleanup,
all owned host/launcher processes exited, zero fixtures remained and PostgreSQL
stopped. The actual test tab was closed and its viewport override reset. All
5,116 frozen source inputs, 37 private inputs, 520 H5 files, HEAD and index
remained unchanged through verification. The run binds to pre-follow-up HEAD
`e8bb45c1744f14277d666cbcd726ff7acef3f30b`; the subsequent documentation/commit
operation is not relabeled as a new test run.

The retained V8, V9, V10 and V11 attempts are actual failures, with respectively
6, 20, 30 and 1 accepted phases. They are not combined with a later run to claim
35 accepted phases. V8 exposed a checkbox observation error, V9 exposed a
missing finite configuration-cache key, and V10 exposed an integer-versus-double
viewport measurement mismatch. V11 accepted the guest phase, then failed at
products20 because its new root-width check used the integer viewport width as
the rounding reference. The actual frame/viewport width was 375, while the root
DOMRect, clientWidth and scrollWidth were all 360: the rendered vertical scrollbar
accounted for the 15-pixel difference, with no integer horizontal overflow.

The V11 failed driver and outer exits remain 1. Its cleanup closed the owned
HTTP server and fixture, removed all PostgreSQL fixtures and stopped PostgreSQL;
both owned ports refused connections and the source/private/H5/HEAD/index
bindings remained unchanged. Native-byte recovery retained one accepted guest
JPEG and one separate failed products20 diagnostic JPEG with exact printed SHA
matches and no missing images. An earlier recovery-parser failure is preserved;
the corrected exact-marker reader did not alter the raw image bytes. This
restoration does not establish strict full-image validation, operator visual
acceptance or 35-phase success; the strict image decoder was not run for V11.

V12 changes only the rounding reference from viewport_width to client_width in
the private host and independent verifier. Its 375/1000 CSS-pixel profiles at the
observed DPR 1.25 retain exact frame/viewport width, the original integer range
viewport_width - 20 <= client_width <= viewport_width, and scroll_width <=
client_width. The raw root DOMRect must remain within 0.5/DPR of client_width,
with finite exact root geometry; footer edges must stay inside that same raw
root rectangle with zero added epsilon. The 20-pixel scrollbar allowance does
not become a footer tolerance: even a 0.01-pixel footer overrun remains rejected.
This is a bounded test policy, not a general CSSOM rounding guarantee. Product
CSS is unchanged; the actual V12 acceptance above covers only these finite
profiles and the recorded original/supplemental verifier distinction.

Synthetic session and finite fixture controls alone are not business evidence.
The late-response check concerns a replaced document, and does not establish a
same-instance Pinia transition race or a new concurrent middleware-to-mutation
account-revocation contract. Provider/payment integration, production
Hyperdrive/Redis enrollment/storage delivery and native-device validation remain
outside this local acceptance scope.
