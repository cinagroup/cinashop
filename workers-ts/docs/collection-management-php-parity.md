# Collection management and empty-state recommendations

Frontend validation passed: 71/71 runtime tests, strict Vue TypeScript, and
H5/Weixin/App builds. The 869 frozen source/config inputs were unchanged during
the actual run, and the completed H5 output contains 520 files. Both Worker
strict TypeScript configurations, 657 unit cases, and three formal-App
PostgreSQL 16.14 scenarios also passed. An independent Python standard-library
verifier accepted 43 registered API request exchanges and their complete
database evidence. Actual Browser validation remains unexecuted. No commit,
push, deployment or migration-completion claim is included.

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
Existing `user-collections-runtime.test.cjs` (13 cases) and the reused
`member-level-recommendations-runtime.test.cjs` (30 cases) remain part of the same
test entry; the new management file contributes 28 cases. All 71 passed with
Node `--preserve-symlinks --test --test-concurrency=1`.

All memory-heavy checks must run through exactly one outer
`bash /home/cina/cinagroup/tools/validate-serial.sh ...`; Node test concurrency is
1. The completed run used one Python driver after obtaining that lock, with
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
empty state. The third full run passed all 71 cases and all four subsequent
checks. No failed receipt or log was overwritten.

## Formal-App PostgreSQL verification

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

Earlier native failures remain preserved. The first attempt stopped before
native execution because cross-frontend dependency links were missing. The
second exposed a new test assertion about an existing admission guard. The
third passed two scenarios and retained the real overflow/ambiguous-category
failure, including an actual wrong-category deletion; the two narrow input
repairs above resolved it. The fourth complete Worker run passed. The first
independent-verifier attempt expected top-level JWT `id/type`; its failed record
is retained, and the second correctly validates the existing PHP-compatible
`jti` claim object without weakening cryptographic or state assertions.

Raw synthetic JWTs, signing authority, full database snapshots and failed/success
exchange journals remain private under `/tmp`, outside the Git candidate paths.
The candidate includes source, tests and this aggregate contract; no private
runtime evidence or dependency symlink belongs in the commit.

Actual Browser acceptance still needs mobile and desktop management controls,
loaded select-all, unavailable-record cancellation, a lost true mutation reply
followed by explicit reconciliation, empty-state recommendations, real target
navigation, missing/corrupt images and account/late-response isolation. Synthetic
sessions or fixture controls are not business evidence. No new concurrent
middleware-to-mutation account-revocation contract, provider, payment, production
Hyperdrive/Redis enrollment/storage delivery or native-device validation is
claimed. This candidate has not completed Browser acceptance or been published.
