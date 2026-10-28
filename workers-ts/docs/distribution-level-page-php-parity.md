# Distribution level page: PHP layout and recommendations

This increment completes the existing `/pages/users/user_distribution_level/index`
page. It adds no route and does not count the existing five task types as newly
migrated. The finance entry, distributor evaluator, admin configuration and
`/api/get_script` compatibility behavior remain in place.

The page now uses the PHP avatar/header badge, theme gradient, floating level
illustration, two commission uplift columns, completed-task count, narrow
progress bars and right-aligned task actions. It restores the decorated
“猜你喜欢” section, ten products per page, original prices, brand/label/frame
projections and real product/activity destinations. Each page instance owns its
recommendation requests. No shopping membership overview or detection call is
needed for distributor recommendations.

The recommendation grid contains two independently stacked columns. Long titles
and wrapped labels therefore do not create shared row gaps. The prefix alternates
columns; the final one or two products use scoped, actual card/column geometry to
choose the shorter column. Appending retains existing column assignments. Every
valid product stays rendered while measuring, and original logical indices remain
available independently of column-major DOM order. Missing native measurements
keep the initial complete layout. Resize and image callbacks only remeasure;
they never invoke an evaluator or recommendation endpoint. Visibility is reactive,
and owner/session/lifecycle revisions fence late measurement callbacks.

## Source and assets

The PHP template reference is
`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`,
`view/uniapp/pages/users/user_distribution_level/index.vue` (SHA256
`5a950f3a5ac05f3141ffadec835a0105aa8a1ceed71ba3664b07f667a68a8392`).
The task and evaluation contracts are already implemented by
`AgentLevelTaskService`. This change retains that implementation.

The five bundled `agent_level_[1-5].png` files come from the local PHP uploads
package. `/public/uploads` is ignored in the PHP repository: these bytes are
**not** tracked assets at the immutable reference. Their actual sizes,
dimensions, SHA256 hashes, source paths and destinations are recorded in
`view/uniapp-ts/src/static/php-distribution-level/provenance.json`.
Only those five exact installer display paths map to the bundled files.
Other configured `level.image` values continue using the server projection;
missing or expired signed media never falls back to an unsigned asset URL.
The tracked recommendation decoration was already present and is reused.

The PHP icon font has no local binary. The small header crown uses a Unicode
glyph; its appearance follows the device font. The explicit level selector,
safe maximum-level handling, hidden/deleted grant notices and manual retry
controls are retained from the TypeScript page. They avoid the PHP template's
out-of-bounds next-level lookup and support configurations absent from the
original screenshot. Task completion and progress come from the server.

## Business and lifecycle boundaries

`GET /api/v2/agent/level_list` and
`GET /api/v2/agent/level_task_list?id=...` intentionally perform PHP-compatible
evaluation. Depending on configuration and real relationships, they may update
`user.agent_level`, insert `agent_level_task_record` rows and consume the record
sequence for the request user and related ancestors (at most three distinct
accounts). They must not be described as read-only. Existing AND semantics,
status-zero historical evidence, gifts, hidden/deleted levels, self-buy and
binding expiry rules are preserved. A rollback of rows does not roll back
PostgreSQL serial allocation.

The recommendation projection remains
`GET /api/product/hot?view=member_level&page=N&limit=10`. It runs independently
in a read-only transaction. Its existing name does not require a shopping
membership read or mutation. Product-detail visit writes occur only on actual
navigation and are accounted for separately in acceptance evidence.

Owner UID, token, session generation, persisted session, visibility and disposal
fence both evaluator and recommendation results. Hide/unload clears private
content and aborts owned requests. Focus/storage events reconcile persisted
account changes. Old image callbacks cannot suppress a refreshed document's
images. Signed image expiry changes the display to a placeholder without
implicitly calling either evaluator GET. The user's explicit “重新读取” action
may evaluate levels again; recommendation retry/refresh only reads hot products.

## Validation record

Frontend runtime checks cover the actual SFC script, existing distributor
contracts, recommendation pagination/retry/duplicate rejection, independent
loading, account/storage/lifecycle changes, native image origins, callback
isolation, signed expiry, local provenance and real navigation targets.
The original-style template compiles, and Vue strict checking and H5, Weixin
and App builds pass. Both final Worker TypeScript configurations (unit and
runtime-test) exited 0 with their complete recorded inputs unchanged during the
checks. Existing route/history binding tests pass without changing dated
fixtures, route counts or audit baselines.

The final focused runtime run passed 78/78: 35 distributor cases, 30 existing
recommendation cases and 13 measured-layout cases. These include same-instance
hide, an actual computed read of the empty columns, and show recovery; reactive
visibility prevents the empty result from remaining cached. Scoped selector
callbacks, unequal heights, short-tail placement, append stability, resizing and
late owner/session/lifecycle callbacks are covered. Existing route/history
bindings passed 44/44, and local runner/input admission passed 637/637 in the
prior unchanged scopes. Fresh Vue strict, H5, MP-Weixin and App builds all exited
0. All 866 frontend inputs stayed unchanged during these checks; every one of
the 520 H5 output files is hash-bound to the final actual browser run.

The native distribution fixture passed 1/1 against PostgreSQL 16 with the full
185-migration schema (283 tables and 229 sequences). The unchanged existing
consumer cases passed 18/18 in the earlier run and are reused by input digest.
A separate maintenance observer checked the application LOGIN's exact 55-table
SELECT closure and restricted column/table/sequence writes. The independent
raw-row oracle derived exactly nine initial task records (request user 5,
parent 3, grandparent 1) and only the request user's rank upgrade. Later evaluator
GETs had zero row and serial deltas. The rollback case separately retains a
serial gap after row rollback. Hot-product and signed-media reads conserve all
283 tables and 229 sequences; ordinary product navigation has its own exact
visit/log rows and two serial allocations.

The final hidden-browser run passed all 31 ordered, fresh ACK stages and 123
actual HTTP traces using the frozen built H5, registered Worker routes, real
JWT verification, signed original PNG bytes and independent database LOGIN.
It covered natural upgrade, repeat evaluation, five completed tasks, two partial
tasks, 10/10/3 pagination, a truncated real JSON response and explicit retry,
terminal scrolling, ordinary and bargain navigation and real returns, invitation
navigation, hidden/deleted/maximum/zero-task configurations, signed-image 404,
truncated PNG and explicit media recovery. Both empty and restored recommendation
states were read in fresh ownerB documents after separately recorded finite
fixture controls; this is not a claim of a manual refresh button in the empty
state. Layouts at 375 and 1000 pixels kept two recommendation/commission columns
and no horizontal overflow. Actual column/card rectangles additionally prove
unequal heights, tight per-column stacking, complete logical-index order and
placement of both final cards against the shorter measured prefix. The long
card's brand and wrapped labels are checked against raw persisted rows. Both
mobile and desktop screenshots show this difference from a shared-row grid.

The delayed-response check holds an actual ownerA evaluator response, replaces
the document with ownerB, then releases ownerA's response after ownerB's ACK.
OwnerB remains unchanged and release causes no new business request. This proves
cross-document replacement; in-instance lifecycle and account fences are covered
by runtime tests. It does not claim actual-browser same-instance ABA, natural
900-second expiry, authentication-provider success, awards, poster or QR creation.
The invitation destination is verified only as navigation: its synthetic
spread-info response reports a controlled-media mapping error (400), and its
QR request returns the deliberately unavailable synthetic budget (503). Session, fixture and transport controls are explicitly
nonproof and their finite deltas are recorded separately.

A separate builtins-only verifier passed 17/17 groups against the recorded raw
rows, JWTs, signed PNG bytes, every request delta, fresh ACK chain, actual source
and all 520 H5 output hashes. Its ordinary-product predicate matches the complete
numeric detail route; the activity subroute is independently checked as a zero-write
read. Earlier private verifier failures are retained and are not counted as passes.
The accepted-capture binding requires exactly one complete payload match for
each phase, including the exact field set, UUID, preceding ACK and timestamps.
The 40 phase-capture requests contain 31 accepted requests and nine earlier
unaccepted captures, explicitly quarantined as nonproof. Their complete request
bodies are hashed; this is not a claim that separate response bodies for all nine
were recorded. The prior verifier's incorrect one-request-per-phase assumption
was repaired, and its failed execution remains preserved.

The actual browser runner and outer serial wrapper both exited 0, source/build
manifests remained unchanged, and the PostgreSQL fixtures reported remaining=0
and STOPPED. HTTP and PostgreSQL ports refused connections after cleanup. The
owned browser tab was closed and its viewport reset. Failed orchestration attempts
are retained privately and are not counted as passes. Private run archives, JWTs
and full database snapshots stay outside the public repository. The immediately
preceding attempt passed the first 24 stages but failed the held-response loading
assertion after a QA control-reply race exceeded the client timeout. That failed
run was preserved and cleaned, then all 31 stages were rerun; it is not counted
as a pass. The final run records no uncaught page errors. The bundled router's
existing deprecated import-path warnings are recorded separately from the
intentional media and synthetic QR fault cases.

The parent PR202 UniApp CI failed at the unchanged dependency audit gate with
`unknown direct advisory 1243505 on deepmerge`. This page change does not
waive the advisory or change the dependency graph. Its latest parent run also
failed both Worker unit-test shards and their aggregate gate (seven successful
checks and four failed checks in total). Step metadata identifies the unit-test
step; the complete failure causes are separate from this page's local validation.
The first published PR203 head also failed that same unchanged advisory gate;
its complete UniApp log confirms the exact diagnostic. Parent Worker logs identify
one committed Admin inventory drift (142/27 recorded versus 140/25 actual page
and unrouted counts, missing `AdminExtractList.vue` and `ExtractReview.vue`). A
second, incomplete log contains at least three 5000ms test timeouts; it is not a
complete failure inventory or proof of their environmental cause. None of these
checks is waived or repaired by this page increment. Local builds and acceptance
do not imply a green remote CI run.
