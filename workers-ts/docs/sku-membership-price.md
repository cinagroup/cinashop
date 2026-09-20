# Selected-SKU membership price (2026-09-14, local candidate)

## Finding and contract

The ordinary product-detail and legacy attribute responses retained each SKU's
raw `price` and advertised `vip_price`, but did not carry that SKU's actual
current-user membership price. PC and UniApp switched the main amount to the raw
SKU price and labelled the separate discount as SVIP. Product-level metadata
cannot price a selected SKU: its minimum price or VIP amount may belong to a
different variant.

The first 10-case PostgreSQL run failed all 10 cases. With 88.50 percent stored
for an activated silver level (the existing checkout truncates it to 88 percent),
SKU prices 19.99 and 29.99 should quote 17.59 and 26.39 for an unpaid member.
A paid member instead gets 10.00 on the first SKU and still gets the cheaper
26.39 level price on the second. The initial browser reproduced raw 29.99 and
advertised SVIP 28.00 for that second SKU.

PHP `StoreProductServices::setLevelPrice` / `isPayLevelPrice` source separates
paid eligibility from an advertised offer, ignores zero paid prices and retains
the one-cent payable floor. `StoreProductAttrServices`' optional discount argument
is labelled a limited-time discount; it is **not** evidence that all SKU display
paths already implement membership. This increment deliberately follows the
existing TypeScript checkout's membership arithmetic and eligibility, not every
inconsistent historical display behavior. No PHP framework or source DB ran.

## Local implementation

- Modern detail `attr_value` for ordinary type 0, and legacy normal-product
  `productValue`, add `member_price`, `price_type` (`level`, `member`, or empty)
  and `level_name`. Raw SKU price/VIP fields retain their prior semantics.
- The new value reuses `calculateMemberUnitPriceCents` and
  `isPaidMembershipActive`. User, level and feature context is obtained once per
  response, not per SKU. Paid eligibility remains independent of level activation
  and of the level-function switch. Activity-type SKU rows do not gain this quote.
- The PC and UniApp adapters share decimal-string/range/classification validation.
  Missing metadata on older responses means the selected raw price, never a
  product-summary discount. Inconsistent supplied quotes reject the response.
- Both product pages show the current winning amount and label; PC option labels
  and the H5 specification sheet stay synchronized with the selected variant.
  A separate `SVIP专享` offer appears only if positive and cheaper than the current
  amount. It is not presented as a discount already granted to an unpaid visitor.
- Cart request bodies still contain identity, quantity and purchase mode only.
  This display quote is not a receipt, order total, coupon/shipping quote or
  client pricing authority. Checkout still recalculates/revalidates on the server.

The Workers skill informed avoiding new cross-request state/bindings and reusing
checkout policy. The frontend-testing skill required a rendered before/after
interaction check in addition to adapter and component tests. The browser fixture
was kept outside the repository and bound only to loopback, with synthetic DTOs,
no database, external API or order creation. Real SQL evidence is the separate
PostgreSQL service/controller suite, not the browser fixture.

## Verification record

- Backend: original 10 failed, then 10 passed; expanded to 14 cases for timed
  membership, product opt-out, activity isolation and the one-cent floor.
- New cross-client adapter suite: initial 38 failed / 3 passed; repaired 41 passed.
- Actual UniApp product-component reactive tests: 5 passed, including SKU label
  changes, no parent fallback, stock and quantity guards. These five overlap the
  complete toolchain run: 189 passed, zero failed/skipped.
- First broader regression: 18 files, 366 passed / 2 failed. Both failures were
  exact-object expectations missing the new additive fields. The expected
  anonymous PC price and paid/zero-price H5 fields were added explicitly;
  raw prices, stock, database snapshots and all other assertions were retained.
  The expanded run then reached 371 passed / 1 failed: its new activity fixture
  used a ten-character SKU key against the existing `char(8)` column. The test
  key was corrected to eight characters, without changing schema or assertions.
  Final rerun: **18 files / 372 passed / zero failed or skipped**, 164.69 seconds.
  This includes all 14 new backend and 41 adapter cases; the totals overlap and
  must not be added to earlier runs. No timeout or schema constraint was relaxed.
- PC build passed, including its 98 auth and 9 image tests; H5, Mini Program and
  App builds passed. Unit/runtime Workers TypeScript checks and UniApp type check
  passed. Build success is not Mini Program/App native runtime acceptance.
- Three built-artifact checks independently passed for H5 entries, Mini Program
  pages/resources and App service/view/manifest outputs. Final diff check passed.

Browser checks used the real PC/H5 applications through the installed browser
plugin, with local synthetic responses. Desktop and phone-width H5 both show
17.59/26.39 silver prices; paid-user SKU switching changes SVIP 10.00 to silver
26.39, without advertising a worse/equal VIP price. Desktop quantity 7 clamps to
2 on the lower-stock variant. Sold-out variants remain non-purchasable and zero
VIP offers are absent. The old-response PC case retains 19.99/29.99 and does not
inherit the misleading product VIP 1.00. Screenshots and DOM states confirmed
nonblank content and the expected specification overlay. PC console had no
error/warning; H5 had no error and one existing DCloud vue-router import warning.

In the earlier selected-SKU increment, directly replacing an H5 hash query on an already-mounted detail page did not
rerun `onLoad`; the independent-case check therefore explicitly reloaded the
target. This is not recorded as a passed same-component route lifecycle test.
No browser order, payment, production login or production image write occurred.
Both temporary tabs were closed, the viewport override reset, and all three
loopback test listeners (5173, 5174, 5218) stopped and independently checked closed.

## Detail lifecycle follow-up (2026-09-14, local only)

The next increment reproduced 12 failing PC component cases and 13 failing
UniApp cases: loaded prices, package choices and reviews survived identity or
page changes, and old writes could still navigate or toast after leaving.
PC now invalidates on the full route and authentication epoch, unsubscribes on
unmount, and guards every asynchronous publication by route, owner and load
generation. UniApp clears synchronously on identity/hide/unload, re-reads on
show, and handles H5 hash reuse without depending on another native `onLoad`.
Its epoch changes before token/UID publication; fresh reads therefore wait one
microtask for the complete store action. Old prices/dialogs are cleared first.
Both clients reject invalid IDs and mismatched detail identities, display load
errors with explicit retry, and ignore stale writes/reviews/finally callbacks.
UniApp additionally guards native navigation callbacks by their original owner.

A separate red request-layer test found that Axios's default asynchronous request
interceptor could attach a new account to an already-invoked old-view write.
The existing synchronous interceptor now declares `synchronous: true`, with a
throwing rejection handler. The request captures its original identity before
a same-turn account change and its response is rejected after that change.
This follows the installed Axios implementation and the
[official interceptor documentation](https://axios.rest/pages/advanced/interceptors).
It does not cancel or roll back a write already dispatched to the server.

Final local evidence:

- 14 new PC lifecycle cases, one dispatch identity case and 15 UniApp lifecycle
  cases pass. They are included in **113 PC auth/component** and **204 UniApp
  toolchain** tests, not additional totals. All have zero failures/skips.
- Full PC run initially exposed shared test-location leakage: the new memory
  router changed `search`/`hash` but suite setup reset only `pathname`. Setup now
  restores all three before each test; the original full-return-URL assertion
  remains unchanged. A targeted malformed-query case also failed because
  `split('?')` silently discarded a second question mark in an ID; parsing now
  retains the entire query and rejects the malformed ID without I/O.
- PC's 9 image tests, the shared quote adapter's 41 tests, both frontend type
  checks, PC/H5/Weixin/App builds, and 3 artifact checks pass. No new backend SQL
  or workerd run is claimed in this follow-up. Existing Rollup annotation and
  Weixin empty-chunk build warnings were not treated as failures or hidden.
- Installed-browser verification used actual PC at `127.0.0.1:5293` (default
  desktop viewport) and H5 at `127.0.0.1:5294` (390 by 844), with a synthetic
  loopback API at port 5298. No production database, external identity provider,
  production image update, cart creation or order/payment request was involved.
- PC: anonymous blue SKU 29.99 -> normal password-login UI -> return to the
  explicit SKU URL at silver price 26.39 -> logout to home -> browser back at
  anonymous 29.99. Login return never automatically adds the product.
- H5: anonymous 19.99 -> login UI -> native return at silver 17.59 -> open SKU
  sheet/select blue at 26.39. Changing a hash ID while the sheet is open clears
  the sheet and old content. Simulated detail failure exposes an error, explicit
  retry loads product 72. Slow product 71 followed immediately by product 70
  leaves product 70 displayed even after 71 completes. Malformed ID shows a
  link error; browser back restores valid detail. Final code was reloaded.
- URL/title, meaningful DOM, absence of framework overlays, interactions and
  consecutive desktop/mobile screenshot evidence were checked. PC console was
  clean; H5 only logged the existing DCloud vue-router import deprecation (again
  on reload), with no application error. Both tabs closed, viewport reset, and
  all three owned servers stopped; `netstat` confirmed no remaining listeners.

The frontend-testing skill required rendered identity-return and route-reuse
checks, beyond passing builds. These are synthetic-API browser checks and actual
component lifecycle tests, not native-device or production acceptance. OnShow
and hash events can initiate overlapping reads; obsolete results are rejected,
but this patch does not promise request cancellation or optimal read count.

## Follow-up: modern cart prices and state (2026-09-14, local only)

The modern `OrderController.cartList` instantiated `StoreCartService` without
Worker bindings and returned raw SKU subtotal only. The old PC/UniApp cart stores
summed raw prices; mobile read errors were swallowed into an empty cart.

- `StoreCartService.list` adds `truePrice`, `trueSumPrice`, `priceType` and
  `levelName`. Ordinary type-0/no-activity rows reuse the actual checkout helper
  and SQL membership authority once per response. SQL pricing no longer depends
  on an optional `Env`. Activity rows retain their existing resolved price and
  do not receive ordinary membership discounts. This is not a full activity
  availability audit.
- Existing `productInfo.price` and `sumPrice` retain their raw-price semantics,
  including for legacy projection and confirmation adapters. No client price is
  sent as authority, no price is locked, and no coupon/shipping calculation is
  inferred from this catalogue estimate.
- `view/common/cartPrice.ts` validates owner-scoped reusable rows, additive
  quote completeness, unit-times-quantity equality, optional activity/participant
  IDs and current stock. Invalid rows expose no payable quote or selection;
  malformed allegedly valid rows fail explicitly. Totals use integer cents.
  Older responses without any of the four added fields display raw amounts without
  inventing membership labels.
- Shared per-store actions clear pending display while reading, preserve only
  explicit valid selections, separate loading/error/empty states, serialize
  updates, and discard late results after identity or view-generation changes.
  Uncertain writes offer a fresh read, never automatic write replay. Hidden
  pages retain owner-local selected IDs/rows for checkout handoff, but mark them
  not ready; they do not claim cancellation of already-dispatched server writes.
- PC and UniApp show the resolved SKU amount and membership label, disable
  invalid selections, and refresh before enabling checkout. Mobile auth-store
  reset is synchronously bound once at app startup, outside the request/cart/auth
  import graph. An initial direct auth-to-cart import produced Weixin circular
  chunk warnings; moving this binding to `stores/session.ts` removed them.
- Rendered PC QA exposed `ElInputNumber min=1/max=0` on an invalid row, causing
  incomplete table rendering. Invalid rows now render a plain quantity. Two
  actual-template tests cover invalid-row controls and selection/navigation;
  Element Plus and native image behavior are separately checked in the browser.

Verification evidence:

- The initial 13-case real PostgreSQL modern-cart suite failed 12 cases and
  passed one; all 13 passed after implementation. It exercises the actual HTTP
  controller, per-SKU paid/level winners, activation/configuration changes,
  missing level eligibility, other owners, direct-buy scope, actual server
  confirmation equality, invalid SKU rows, one membership read and unchanged
  business-row snapshots. It uses disposable loopback PG16, not production.
- The broader initial regression run passed 365/368. Three direct-purchase
  tests failed because their fixture omitted the newly required SQL user/config/
  right tables. Those tables and an explicit non-member were added; no SQL or
  pricing guard was bypassed. The rerun passed 368/368 before two final shared
  adapter cases were added. The final run passes all 370 tests in 15 files,
  including the 22 adapter cases, with zero failures/skips; both Workers
  TypeScript configurations also pass. This is not a workerd runtime result.
- PC passes 125 auth/store/component tests (including 10 new cart-state and two
  template cases), nine image tests, type checking and the full production build.
  UniApp passes 212 toolchain tests (including eight cart lifecycle cases), type
  checking, H5/Weixin/App production builds and three artifact checks. Existing
  Rollup annotation and Weixin empty-chunk warnings remain documented, not hidden.
- Installed browser: PC `127.0.0.1:5313` at the default desktop viewport and H5
  `127.0.0.1:5314` at 390 x 844, both routed solely to a disposable in-memory
  API on loopback port 5318. Normal login UI used synthetic local credentials;
  no provider, production DB, production image or order/payment call was made.
- PC: valid-only all-select shows 114.35; blue quantity 3 -> 2 shows 87.96;
  red quantity 2 -> 3 shows 105.55. A controlled failure at red quantity 4
  displays the explicit error; read retry restores quantity 3 and total 105.55.
  Fixture write logs show exactly the three explicit writes, with no retry write.
  Signing in as the other local non-member shows 19.99/29.99, no silver label,
  no selected rows and total 0.00.
- H5: anonymous cart shows a login requirement, not successful empty state.
  Login returns with 17.59/26.39 silver prices. All-select excludes the invalid
  row and totals 105.55; blue quantity 2 -> 1 refreshes it to 79.16. The initial
  screenshot exposed that the new H5 tab had retained desktop width despite an
  earlier viewport request. The override was reapplied to the existing tab;
  DOM dimensions then confirmed 390 x 844, and blue 1 -> 2 was exercised again,
  restoring 105.55 with the checkout bar above the bottom tabs. URL/title,
  meaningful DOM, absence of framework overlays and controls were checked.
  Post-fix PC logs have no new application errors; H5 has only the existing
  DCloud vue-router import deprecation. Screenshots are in the conversation,
  not committed QA artifacts. Both temporary tabs were closed, the viewport
  restored, all three owned servers stopped, and zero listeners remained on
  ports 5313/5314/5318. No repository screenshot or temporary server was added.

The Workers skill guided reuse of SQL authority and request-local state instead
of global mutable price context; current official best-practices documentation
and the installed Hyperdrive interface were reviewed. Registry retrieval of the
latest Workers type version did not complete, so installed 5.20260828.1 was the
fallback; no latest-version or configuration-schema validation is claimed.
No binding/configuration/dependency version was changed. The frontend-testing
skill required actual rendered checks and caught the invalid quantity widget
that passing builds/store tests did not detect.

## Follow-up: acknowledged cart navigation recovery (2026-09-14, local only)

The next audit found a separate gap: after an ordinary or package cart had
successfully been created, failed checkout navigation discarded the only UI
recovery path. Clicking purchase again issued another cart creation. Four new
actual-component tests (PC ordinary/package and UniApp ordinary/package) all
failed with two writes instead of one before the patch; all four now pass.

- `view/common/preparedProductCart.ts` validates the acknowledged ID or exact
  package ID count, positive bounded integer IDs, uniqueness and any supplied
  legacy `cartId` alias. It copies/freezes the IDs and never accepts a response
  URL, price or order/payment identity as a navigation instruction.
- Both product pages keep these acknowledged IDs only in the current
  owner/page generation. They render an explicit `继续结算` action, which only
  navigates with the same IDs; ordinary/package writes and selection changes
  share one busy gate. PC also handles Vue Router's resolved navigation-failure
  result, not only rejected promises. UniApp keeps the gate until native hide or
  failure and gives each navigation attempt a generation, so an old callback
  cannot unlock a newer attempt on the same page.
- Malformed, failed or unconfirmed cart responses cannot become a prepared
  record. They block further purchase actions until an explicit catalogue
  refresh. This does **not** prove that the previous server write rolled back,
  nor make a later new purchase idempotent. There is no automatic POST retry.
- Account renewal, product/route replacement, refresh, hide/unload or explicit
  `重新选择商品` discard the local recovery record. The latter re-reads the
  catalogue and never deletes the previously created server-side direct cart.
  Cross-refresh recovery and server acknowledgement lookup remain separate work.
- The mobile fixed action bar exposes continue/reselect as well as the banner,
  so a user at the bottom of a long product page can recover without finding a
  newly inserted banner above the gallery. This is a targeted change, not a
  redesign of the detail/checkout pages.
- Screenshot review also showed the PC banner above the current scroll
  position, leaving only disabled purchase controls in view. PC now replaces
  the original purchase buttons with continue/reselect too. Final browser QA
  reloads this code, repeats the failed navigation, and successfully uses that
  in-place button to reach the same acknowledged cart 850.

Verification:

- 18 pure acknowledgement-contract tests pass, including immutable copies,
  invalid/duplicate/out-of-range IDs, mismatched aliases and partial packages.
- Ten added PC and eleven added UniApp actual-component cases cover both cart
  types, blocked navigation/retry without a second write, duplicate pending
  navigation, uncertain responses, cross-mode overlapping writes, identity/
  route/visibility disposal and obsolete native failure callbacks. They are
  included in the final **135 PC** and **223 UniApp** suites, not added to them.
  Nine PC image tests, both frontend type checks, PC/H5/Weixin/App builds and
  three build-artifact checks pass. Both Workers TypeScript configurations also
  pass. No backend service or SQL change, real-PG rerun, provider execution or
  workerd runtime acceptance is claimed here.
- Installed-browser QA uses actual product/login pages and routers at PC
  `127.0.0.1:5333` (default desktop viewport) and H5 `127.0.0.1:5334` (DOM-confirmed
  390 x 844). All data comes from an in-memory loopback fixture at 5338.
  Repository-external temporary Vite configurations inject one failed
  navigation per cart type and replace only the destination with a clearly
  labelled navigation-check page. This is not real checkout/DB/provider/payment
  acceptance. Production application code has no injected test guards or pages.
- PC login -> ordinary purchase -> failed navigation -> continue reaches cart
  810; back -> package -> failed navigation -> continue reaches 820,821. An
  immediate click while the closing package dialog was transitioning had no
  visible effect; after observing the closed dialog, the next explicit continue
  reached the same IDs without another write.
- H5 login return does not purchase automatically. Ordinary SKU confirmation
  -> failed navigation -> bottom-bar continue reaches 830. Back -> package
  confirmation -> failed navigation -> bottom-bar continue reaches 840,841.
  The synthetic API logs exactly four initial cart writes for these scenarios.
  Final PC in-place-button revalidation creates cart 850 once and continues to
  that same ID, bringing the total to **five explicit initial cart writes**;
  every continue action issues no POST. No real cart, order or payment exists.
- URL/title, meaningful DOM, absent framework overlay, recovery controls and
  actual destination IDs were verified. PC console is clean; H5 contains only
  the existing DCloud vue-router import deprecation. Recovery-state desktop and
  mobile screenshots are provided in the conversation, not in the repository.
- Initial temporary-config launches failed on sandbox parent-directory access;
  the reviewed loopback-only launch was allowed. H5 additionally needed the
  installed plugin's CJS default export in the external ESM harness. Only the
  temporary configuration changed; repository config and dependencies did not.
- Cleanup: both temporary browser tabs are closed, the viewport override is
  reset, and the three owned loopback servers are stopped. A final listener
  check reports zero listeners on ports 5333, 5334 and 5338.

The frontend-testing skill drove the actual failure/retry loops and the mobile
fixed/PC in-place recovery controls. These checks do not establish native-device
behavior, all navigation failure modes, server-side cart idempotency or
production safety.

## Follow-up: PC order submission survives refresh (2026-09-14, local only)

The next audit followed the actual PC checkout, beyond product-to-checkout
navigation. PC previously held the order key and frozen payload only in component
refs. `loadCheckout()` and component recreation discarded them; unlike UniApp,
there was no journal to restore an uncertain submission before loading carts
that the server might already have claimed. This is an order-submission issue,
separate from the unresolved cart-creation acknowledgement work above.

- PC now reuses the existing shared `CheckoutIntentJournal`, with owner-scoped
  **sessionStorage**, not long-lived bearer/localStorage persistence. A validated
  key, quote token and copied payload must be saved and read back before a new
  create request. A storage failure cannot authorize a fresh submission.
- On reload or same-tab re-entry, pending records are read before cart, address,
  coupon or quote requests. Reconfirmation explicitly replays the original key
  and payload, even when current URL parameters or editable refs differ. It does
  not silently obtain another price or automatically issue a POST/payment.
- A validated successful result is saved with its exact order ID. Resolved
  Vue Router guard failures and navigation exceptions preserve it. `查看订单`
  only navigates; the matching record is cleared after successful navigation.
- Initial, exact-key, definitive rejection can clear the record and re-quote;
  a later rejection cannot settle a prior unknown result. Malformed storage or
  results block unsafe recovery. A write that succeeded before a read-back error
  is recovered before any new intent can be considered.
- Identity renewal clears displayed addresses, contact, remarks, custom forms,
  prices and pending state synchronously, without deleting the previous owner's
  journal. It requires explicit reload; no automatic new-user checkout request.
  Late responses cannot navigate or populate another owner/page. Ordinary
  same-page reload and duplicate clicks are blocked while submission is pending.

Verification and limits:

- The first harness omitted the required `truePrice` field and did not reach a
  valid quote. After correcting it and asserting `canSubmit`, three regression
  tests reproduced missing persistence, a write despite storage failure, and
  missing settled-result persistence. The toast-only DOM substitute was then
  added to the existing component harness so navigation really executes in Node.
- **17 new actual-component/Pinia/Axios/router tests**, included in the final
  **152 PC tests**, pass. They cover recreation, explicit reload/query changes,
  frozen replay, no pre-save dispatch, corrupt/changed/write-then-throw storage,
  late identity/unmount responses, duplicate requests, settled-only navigation,
  and invalid result keys/IDs. Existing definitive/uncertain rejection and
  shipping tests remain intact. The old identity test caught automatic reload;
  production code was changed to require explicit reload, not the assertion.
  The unmount assertion now compares the route immediately after unmount,
  because Vue Router resets the memory history to `/` when its app is removed.
- PC **9 image tests**, vue-tsc and production build pass. The existing static
  checkout wiring assertion was updated from refs to journal begin/assert/send/
  settle/read; **4 Worker/shared files / 47 tests** pass, with disposable PGlite
  where SQL is needed. **23 UniApp checkout runtime tests** and both Workers
  TypeScript configurations pass. This turn did not rerun all UniApp builds or
  the full backend suite, PG16 concurrency, workerd, CI or production checks.
- Browser skill validation used actual PC login, checkout, quote and order-create
  paths at `127.0.0.1:5343`, backed by an in-memory PGlite fixture at 5348.
  Authentication, sequence allocation and empty coupon/store lists are synthetic;
  actual Hono/DAO/order pricing, cart claiming, inventory updates and idempotent
  replay execute. No payment route/provider or production database is available.
- Initial quote: raw 19.99 x 2 = 39.98; level discount 4.80; payable **35.18**.
  First create committed `local_recovered_order_1`, then the harness deliberately
  dropped its response (the proxy presented HTTP 500). Browser refresh preserved
  the original key/receipt/body and issued no second quote. Explicit retry used
  the exact same key and JSON payload. Final state: **one quote, two create HTTP
  requests, one unpaid order, product and SKU stock 8 -> 6 once, cart claimed**.
  Subsequent view-order retries issued no further create request.
- A one-time route guard then refused opening the known order. Both unknown and
  settled states survived refresh; continued navigation reached the exact
  `/order/local_recovered_order_1` path. The destination is explicitly labelled
  as a temporary navigation-check component, not actual order-detail acceptance.
  Its initial temporary parameter label used `id`; after checking the real route
  contract it was corrected to `orderId`, and rendered again with the exact ID.
- Desktop and 390 x 844 viewport evidence is provided in the conversation.
  The first mobile screenshot had stale capture scaling; reacquiring the same
  tab and reloading produced the correctly rendered narrow page. DOM reports
  innerWidth 390, clientWidth 375 with scrollbar, height 844, no horizontal
  overflow. Page identity, meaningful content, absent framework overlay,
  recovery controls and actual interaction were checked. Final console is
  clean; the intentional first-response failure is not counted as an app defect.
- Temporary Windows harness imports required `file:///` and the real schema
  directory's `index.ts`; these were harness-only startup failures. The reviewed
  localhost-only Vite launch resolved the sandbox parent-directory read failure.
  No production config, dependency, backend service, SQL schema or price policy
  was changed by this increment.
- Cleanup: the owned browser tab is closed and viewport reset. Both server
  handles are terminal after interruption; ports 5343/5348 have zero listeners.
  Windows interruption did not emit the optional graceful-close marker, so that
  hook is not claimed as observed. The fixture was process-local, memory-only
  PGlite, not a persistent or production database. Final scoped diff check passes.

This is same-tab recovery, not durable cross-device or cross-tab coordination.
Closing/clearing the browser session can remove its journal; unresolved orders
then need order-list/result reconciliation, not blind new submission. It does
not solve unknown cart creation, native-device/provider/Hyperdrive acceptance,
capacity or release gates. No commit, push, deployment or production data/cache
mutation occurred. The migration checklist remains 240 checked / 164 open / 404.

## Follow-up: actual customer order detail lifecycle (2026-09-14, local only)

The actual PC and UniApp order-detail components retained prior private data on
failed refresh and identity/page changes. PC payment confirmation also read the
mutable current order ID after awaiting the dialog. Eight initial component
tests failed against those behaviors; all are now green without weakening them.

- Each read binds owner/session, order business ID and page revision. Old order,
  cashier, contact/virtual delivery content and PC review/QR state are cleared
  synchronously. Explicit loading/detail-error/cashier-error/retry UI replaces
  the misleading catch-all "order does not exist" state. A failed cashier keeps
  only the fresh validated order and blocks payment.
- Shared identity validation rejects foreign order/UID, malformed paid/money/
  cashier method fields, mismatched totals and incorrect payment receipts. It
  supplements, not replaces, server authorization. H5 rejects duplicate order
  query parameters and observes same-page hash changes.
- PC locks before payment confirmation, captures its order/method, closes its
  own pending confirmation on invalidation, and ignores stale result/polling/
  manual-confirm responses. Receipt and review actions capture their owner;
  the review loop stops before subsequent writes after an identity change.
- UniApp clears on hide/unload and reads on show. Native payment can hide the
  page: its attempt lock outlives that view until settlement, and a read begun
  during payment cannot unlock another payment even if it completes later.
  Unknown writes require an explicit read; no automatic payment replay or
  cancellation of already-dispatched server writes is claimed.
- Final checks: 22 PC detail tests plus 20 UniApp detail tests (42 new), PC full
  174 component/auth tests + 9 image tests, UniApp full 243 toolchain tests,
  both frontend typechecks, PC and H5/Weixin/App builds, 3 artifact checks. All
  pass with no skipped tests. Existing Rollup annotation/empty-chunk notices
  remain; no dependency upgrade was attempted.

Browser evidence uses the installed in-app browser and **actual detail views**,
not the previous increment's navigation stub. Temporary harness outside the repo:
`C:/Users/cina/AppData/Local/Temp/cinashop-order-detail-ea0d77c07d18439fa81cf3f46740f38e/server.mts`.
PC URL was `http://127.0.0.1:5343/order/local_detail_A`; H5 was
`http://127.0.0.1:5344/#/pages/order/detail?orderId=local_detail_C`.
Actual Hono detail/cashier/list services used a disposable in-memory PGlite
database, synthetic authentication/config and three explicitly seeded orders.
This run did **not** create them through checkout and is not a second proof of
the previous turn's create/replay transaction. Financial/write routes were denied.

Both pages exercised injected detail failure -> explicit retry -> injected
cashier failure with unavailable payment -> refresh -> exact 35.18 order and
100.00 balance. PC opened/cancelled confirmation without submitting and removed
private data on logout. H5 changed C to B, replaced the contact, then rejected
duplicate IDs with no old order content. Page identities, meaningful DOM, no
framework overlay, desktop/narrow screenshots and interactions were checked.
The actual narrow viewport reports innerWidth 390, client/scrollWidth 375 and
height 844, with no horizontal overflow. Creating the H5 tab initially retained
desktop dimensions; the viewport was reapplied and the correct narrow capture
was inspected, not inferred from the earlier wide screenshot.

Browser feedback found a fragment-root `orderId` attribute warning, fixed with
explicit `inheritAttrs: false` because onLoad owns validated route parameters.
After reload only DCloud's existing deprecated vue-router import warning remains.
The first harness omitted a cart GET; it was wired to the real cart controller
and the fixture restarted/retested. The GET logout endpoint remained unmounted
(405), so PC correctly reported unconfirmed server revocation while clearing
local private state; this is not a passing server-logout test. An earlier
commentary tentatively called it a response-format issue; the final HTTP event
audit establishes the missing GET route as the cause.

Final SQL/event audit: 3 seeded orders, all unpaid, order/user/SKU snapshots
unchanged and **zero transaction requests**. No production bindings, payment
providers, production data/cache writes, commit, push or deployment. This is
not native-device/provider/Hyperdrive, Linux/workerd/CI or production acceptance;
cross-page/session durable payment reconciliation and the rest of the migration
remain open. Checklist still 240 checked / 164 open / 404; A3k13/SUP-004 unchanged.

Cleanup: both owned browser tabs closed, viewport reset, all three owned server
sessions terminal after interruption, and ports 5343/5344/5348 have zero listeners.
The process-local PGlite was not persistent; its optional graceful-close hook
was not observed on Windows and is not claimed. Scoped diff check passes. The
pre-existing staged image rollback/maintenance files were left staged and unchanged.

## Follow-up: actual customer order list lifecycle (2026-09-14, local only)

The PHP PC list supports six status filters and pagination; its UniApp list
advances the page only after success. The migrated PC component read only its
first 20 rows, while UniApp advanced before requesting, skipping a failed page
on retry. Both could retain private rows after identity/page changes. Six initial
component tests reproduced these defects before implementation.

- `view/common/orderListState.ts` now owns validated page-success advancement,
  concurrent-request gating, explicit refresh/errors, duplicate rejection and
  current owner/session/filter/revision checks. Overlapping pages require a
  fresh list. A failed later page retains prior valid rows and retries exactly
  that page; a failed refresh removes the old rows. No invented total is shown.
- Actual PC and UniApp list views expose all six filters, refresh, loaded count,
  retry and end-of-list state. Route filters are strict and reject duplicates;
  H5 hash navigation retains the chosen status. Identity change, hide/unload or
  route invalidation clears old views, and late results cannot refill them.
- Navigation uses only a current validated row. PC receipt confirmation captures
  identity/order before its dialog and locks immediately; a replaced view closes
  the dialog. Unknown receipt results require explicit read-back. Actions and
  labels distinguish pending, partial, pickup/writeoff, review and completed
  orders. Server authorization remains authoritative; no provider/write flow was
  exercised through the browser harness.
- An expanded test caught `refresh(undefined)` retaining the old selected status
  through a default argument; refresh now requires an explicit filter. Another
  browser-only discovery was DCloud serializing an undefined status as `status=`:
  the actual controller converts that to zero, so "全部" showed only unpaid rows.
  A new red API test preceded the fix: omit undefined query values, retain zero.
  The real H5 request then became `?page=1&limit=10`, displaying all statuses.

Final local checks: 17 new PC component tests, 18 new UniApp component/API tests,
9 Hono/SQL/helper tests; PC full 191 component/auth + 9 image tests, UniApp full
261 toolchain tests, both frontend types and both Worker TypeScript targets.
PC and H5/Weixin/App builds and all 3 artifact checks pass. The three UniApp
builds/artifact checks were repeated after the final CSS-only change and reached
exit zero. Existing VueUse annotation, DCloud router deprecation and Weixin
empty-chunk notices remain; no dependency upgrade was made. The initial expanded
UniApp test harness used a nonexistent logout method; it was corrected to the
real auth `clear()` method, not by weakening the assertion.

Browser flow: login -> first page -> injected second-page failure -> same-page
retry -> entire list -> review/completed/all filters -> actual detail -> back.
Actual app pages used `http://127.0.0.1:5353/order` (PC desktop) and
`http://127.0.0.1:5354/#/pages/order/list` (H5, confirmed 390x844 and no horizontal
document overflow). The temporary server outside the repository was
`C:/Users/cina/AppData/Local/Temp/cinashop-order-list-9e6f7af255d54b0c82adb4295eea44b2/server.mts`,
on port 5358. It mounted actual order list/detail/cart controllers over disposable
in-memory PGlite, with synthetic login/config. The fixture seeds 34 orders:
30 visible to UID 11 plus foreign/deleted/system-deleted/split-root exclusions.
Paid states are preseeded, not real payments; the synthetic completed order has
empty payment-method metadata, so its PC detail payment-method label is not
payment acceptance evidence. No source MySQL/history reconciliation is required.

Observed PC sequence: page 1 limit 20 -> page 2 injected failure -> page 2 success,
20 -> 30 visible rows and explicit end. Fixed H5 sequence: page 1 limit 10 ->
page 2 failure -> page 2 success -> page 3 -> page 4 empty, 10 -> 20 -> 30 and end.
Review shows only `local_list_27`; completed only `local_list_28`; switching back
to all starts with row 30. Both frontends opened the actual detail for order 28
and returned to their expected list filter. H5 used the real anonymous login
entry and returned to the list. No runtime overlay or blank final page; PC
console has no errors/warnings and H5 only the existing DCloud import warning.

The final H5 screenshot exposed a long status tab overlapping its neighbor.
Wrapping/centering was fixed, then the page reloaded, filters/detail/back rerun
and a fresh 390x844 screenshot inspected: all six tabs are readable. Attempts
to apply the narrow viewport to PC still returned desktop dimensions; PC narrow
acceptance is therefore not claimed. Screenshots were emitted in the task,
not saved as repository artifacts.

Final HTTP/SQL audit: order/user/product/SKU/cart/bill snapshots are unchanged,
34 seeded orders remain, bills remain empty, and zero non-GET transaction requests
were made (the two synthetic login requests are not business transactions).
No production data/cache writes, commit, push or deployment. Separate ordinary
production-page image revalidation now passes homepage and details 70/71; see
`view/pc-ts/docs/test-media.md` for its narrower scope.

Offset paging is still not a stable cross-request snapshot/cursor: duplicate
overlap is detected, but concurrent deletion can create undetected offset gaps.
Live roles, native-device/provider, PG16/Hyperdrive, Linux/workerd/CI, capacity and
release acceptance remain open. Checklist stays 240 checked / 164 open / 404;
A3k13 and SUP-004 remain open.

Cleanup: the three owned tabs (two local, one production read-only) were closed
and the viewport override reset. All three owned server sessions reached terminal
state after interruption; ports 5353/5354/5358 were independently checked and
have zero listeners. The SQL fixture was process-local, not a persistent database.
Scoped diff checks pass; HEAD remains `58ec07b18bade136cead91e3c080c2181ea5f788`
on `codex/shipping-create-http-20260914`. Existing staged rollback/maintenance
artifacts and their index state were not modified.

## Follow-up: authoritative customer payment result (2026-09-14, local only)

The PHP `pages/goods/order_pay_status/index.vue` calls `getOrderDetail` on show
and uses the returned paid/offline state. The migrated UniApp `payResult.vue`
instead initialized success to true, treated every URL status except `fail` as
successful, and displayed a caller-supplied amount without an order read. Three
new tests failed against that behavior before the change.

The real result component now reads the existing authenticated detail API and
validates owner, business order ID, paid flag, money and state fields. Only a
minimal result projection is retained, not contact/virtual delivery content.
URL `status`/`amount` are ignored, and the detail-page success redirect now sends
only the validated order ID. Explicit states distinguish checking, login,
unconfirmed, unpaid, offline confirmation, cancelled, refunding, refunded and
confirmed paid. An unconfirmed read does not claim the provider failed or invite
blind repayment. Fulfillment is not promised merely because payment is recorded.

Reads and navigation bind the current UID/token/session, validated ID, H5 hash
and page generation. Identity changes, hide/unload, same-page route changes and
invalid/duplicate IDs clear prior state; late reads/callbacks cannot restore it.
Reentry re-reads; duplicate retries are serialized, navigation failure can retry
without any payment call. Login is explicit and no anonymous private read is
sent. A first TypeScript check rejected the overloaded `uni[kind]` union call;
the implementation now explicitly dispatches the three supported navigation
methods without an unsafe type cast, then typecheck passed.

Verification:

- 29 new actual-SFC/API tests cover forged/absent return parameters, paid/unpaid/
  offline/cancelled/refund states, malformed or foreign results, no pre-response
  success, failed refresh, minimal retained data, repeated reads, identity/
  hide/unload/route late responses, anonymous login return, fresh onShow reads,
  native navigation callbacks and H5 duplicate IDs/listener cleanup.
- Those 29 plus the existing 20 detail lifecycle tests pass (49 total). The
  final full UniApp toolchain is 290 passed, zero failures/skips; vue-tsc,
  H5/Weixin/App builds and 3 artifact checks pass. Existing DCloud router/CJS
  Vite deprecation and Weixin empty-chunk notices remain. No dependency changes.
  The new server-confirmed result text was also located in the actual H5 page
  chunk, Weixin payResult.js and App app-service.js outputs.
- The first full toolchain run did not finish: its live Node test child was
  identified as `dev-server-security.test.cjs`, with a live esbuild service and
  no listening test server; it remained idle across repeated observations well
  past the test's 90-second scope. After recording this, the owned session was
  interrupted (not passed). The unmodified security file alone passed 8 tests.
  With both browser fixture servers closed, the original complete test command
  passed, followed by all builds. Final command set CI=1 to suppress vendor
  update telemetry; the security test already sets/restores CI itself. Neither
  concurrency limits nor test assertions/timeouts were weakened. This does not
  establish a root cause or a general toolchain-stability fix.

Actual browser flow at `http://127.0.0.1:5364/#/pages/order/payResult`:

1. Open order 24 with `status=ok&amount=99999.00`: anonymous login prompt, no
   successful result or private amount. Real local login returns to the page.
2. Inject one authenticated detail-read failure: "支付结果暂未确认", no old
   amount. Click "重新核对支付结果": the actual SQL row is unpaid, amount 10.00.
3. Open order 28 with `status=fail&amount=0.01`: the server-paid row produces
   "支付成功" and 10.00; reload at 390x844 preserves the correct result. "查看订单"
   enters the actual detail for `local_list_28`.
4. Duplicate order IDs are refused without a detail request/retained amount;
   foreign order 31 returns the actual owner-scoped "订单不存在" and no success.

Meaningful DOM, correct URL/title, no framework overlay, screenshots and real
interaction checks pass at desktop 1280x720 and H5 390x844 (client/scrollWidth
both 390). Console has no app errors and only the existing DCloud router import
warning. Screenshots were emitted in the task. The Node/Hono server used actual
detail controllers and process-local PGlite, synthetic authentication/config,
and blocked every non-GET route except synthetic login. All payment flags were
preseeded, not produced by a payment provider or checkout transaction. The local
paid sample's payment-method metadata was set before the initial snapshot.
Six detail requests were observed (including one injected failure), zero
transaction requests, and all order/user/product/SKU/cart/bill snapshots remained
identical with 34 seeded orders. No production binding or data/cache operation.

Temporary harness (outside the repository):
`C:/Users/cina/AppData/Local/Temp/cinashop-payment-result-3cf6201c36094ce284310bca4a0519db/server.mts`.
The owned tab was closed and viewport reset; both owned server sessions reached
terminal state after interruption. Native `netstat` confirmed no listeners on
5364/5368, and also reconfirmed the previous increment's 5353/5354/5358 cleanup.
An earlier restricted CIM/Get-NetTCPConnection query could not supply reliable
listener evidence; the successful native netstat observation is the evidence
used here. No existing background service was stopped.
The four identified interrupted test/esbuild process IDs were independently
confirmed absent after cleanup; no test fixture directory remained in UniApp.

This is server-record display acceptance, not provider payment/callback, original
PHP payment gifts/lottery/coupon features, every historical deep link, native
device, Hyperdrive/workerd/CI or production rollout acceptance. PC/Worker business
code was not changed or rebuilt in this increment. No commit/push/deployment;
FE-003F and A3k13/SUP-004 remain open; totals stay 240 checked / 164 open / 404.

## Follow-up: customer refund application lifecycle (2026-09-14, local only)

The user reconfirmed that the new product images can be read. No production
images, data or cache were changed again. This increment continues the already
unfinished PC/UniApp refund application work, without a commit, push or rollout.

The original pages retained form/order state across identity or route changes
and could dispatch duplicate applications. UniApp also typed the actual
`{ refundId }` receipt as `{ id }` and used an unscoped delayed back navigation.
The six initial regression cases failed on the original implementations. One
UniApp duplicate-request test initially hit a test-harness Vue Proxy cloning
limitation; stripping only proxy wrappers before observation reproduced the
actual two requests. Undefined native request keys remain preserved, and the
full existing suite was rerun after that harness correction.

The shared controller binds detail reads, selected lines, immutable request
contents and callbacks to the active user/order/revision. It validates order
identity, money shape, cart ownership/duplicates/quantities, refund eligibility,
application type and text lengths before a write. Selected lines request their
remaining refundable quantities; displayed order quantity is not a promised
refund quantity or client-calculated settlement amount. The server remains the
refund-price and eligibility authority. Submit is locked before dispatch;
successful receipts remain visible and navigation failure only retries viewing.
Unknown outcomes remain locked across the page's explicit read refresh, and
UniApp hide during dispatch retains uncertainty on return. A first definitive
business rejection can be corrected and retried. Account/route replacement and
unload discard old form data and late callbacks rather than publishing them in
another user's view. There is no automatic delayed navigation or refund payout.

Crucially, the actual application transaction inserts `store_order_refund` and
`store_order_status` but does not update `store_order.refund_status`. Refreshing
order detail is therefore not evidence that a timed-out application was absent.
Unknown-result navigation goes to existing UniApp refund history; PC currently
only offers order navigation and still lacks the equivalent history surface.
This is a same-page/session improvement, not durable idempotency: full reload,
component teardown, token/account cycling, another tab/device or HMR can discard
the outcome. The backend rejects an already-active application, but that is not
an exact-payload replay contract. Do not close the recovery/idempotency gate.

Verification:

- 21 PC and 27 UniApp actual-SFC/API/lifecycle tests passed, including foreign
  responses, current selections, virtual type restrictions, immutable payloads,
  duplicate clicks, malformed receipts, unknown/definitive failure distinctions,
  auth/route/hide/unload isolation and navigation-only recovery.
- Four actual Hono controller/disposable SQL tests passed: canonical selected
  cart IDs, real `refundId`, active-application rejection, owner-only history/
  detail and refusal of foreign/duplicate selections or privileged apply types.
  The first SQL assertion mistakenly expected a bare ID array; inspection of
  the actual write confirmed the existing `{ cartIds: [...] }` shape, which the
  corrected assertion now checks exactly. No business implementation changed.
- Worker unit-project typecheck and the four SQL tests passed on final rerun.
  The first typecheck caught the test's nullable `cartInfo`; an explicit null
  rejection was added before parsing, without a cast or a schema relaxation.
- Final PC build passed 212 auth/component tests, 9 image tests, vue-tsc and Vite.
  UniApp passed all 317 toolchain tests, vue-tsc, H5/Weixin/App builds and all three
  artifact checks, with CI telemetry disabled and owned UI servers stopped.
  Vendor pure-annotation/empty-chunk notices were nonfatal, not hidden failures.
- Installed browser/CUA, no Playwright fallback: PC at
  `http://127.0.0.1:5393/refund/local_refund_3` (1280×720), H5 at
  `http://127.0.0.1:5394/#/pages/order/refundApply?orderId=local_refund_2`
  (actual 390×844), proxied only to the disposable API at 127.0.0.1:5398.
  Page URL/title, meaningful DOM, no error overlay, target controls, screenshots
  and console output were checked. PC real success visibly retained the receipt
  and disabled the form. Browser testing found an explicit checkbox disabled
  prop overriding the parent form and an H5 card-width collision; both were
  fixed and reloaded. Final mobile card width was about 369 px within a 390 px
  viewport; scrollWidth was 390, with no horizontal overflow.
- H5 final independent fixture run deliberately lost the response after SQL
  committed the application. The page showed uncertainty, explicit order reload
  kept submission disabled, and “核对退款记录” opened real history followed by
  actual refund detail showing pending review and 10.00. Exactly one application
  POST, one application row and one status row existed; orders/users/stock/cart/
  bills were unchanged. The earlier PC fixture run also left these six business
  snapshots unchanged. Resetting the disposable API for final style validation
  is not production cleanup or a persistent recovery test.
- Application pages had no new app console errors; the H5 dependency router
  deprecation remains. Navigating to the unchanged refund-detail page exposed
  its existing fragment-root `id` attribute warning; that downstream lifecycle
  is not claimed fixed. No approval, payout or provider route was mounted.

The owned browser tabs were closed and viewport reset; all three owned UI/API
servers were stopped. Native `netstat` succeeded and showed no listeners on
5393/5394/5398 (only closing TIME_WAIT sockets). Existing local services were
untouched. No staging changes were made to the prior nine staged files.

Refund image upload/partial-quantity UI, complete refund list/detail lifecycle,
PC history, durable acknowledgement lookup/replay, provider approval/payout,
native-device and production/Hyperdrive/workerd/CI acceptance remain open.
Checklist remains 240 checked / 164 open / 404; FE-003F, A3k13 and SUP-004 stay open.

## Follow-up: customer refund history and detail (2026-09-14, local only)

The user confirmed that the new production images can be read. This increment
does not replace them again, mutate production, stage files, commit, push or
deploy. The preceding refund-application section describes its own earlier
acceptance; its open PC-history/detail items are superseded only to the extent
documented here.

### Contract and visible changes

- Compared the PHP PC refund list and UniApp return-list pages with the new
  clients. The old new-client list had no bounded pagination; the detail read
  exposed raw cart selections rather than usable selected-product rows, allowed
  deleted records, and retained private detail across mobile identity/hide
  changes. A cancelled record with refund type 6 also claimed money was returned.
  Three initial SQL-contract and three actual UniApp-component tests reproduced
  those issues before the corresponding fixes.
- Added opt-in `view=customer` on existing refund list/detail GET routes. Legacy
  response shapes remain unchanged. The customer projection includes explicit
  public fields, joins the owned order, excludes deleted/foreign records, limits
  pages to 1–50 rows, and uses descending `(addTime,id)` keyset pagination.
  Cursor context includes account, filter, literal order/refund-number search
  and page size. Duplicate/unsupported query keys and malformed identities fail.
  Search does not yet match product names.
- Customer detail resolves only selected order-cart snapshots with bounded JSON
  and row counts. Explicit quantities are validated; a uniquely inferable total
  can be recovered, but genuinely ambiguous old partial multi-line quantities
  remain unknown. Invalid snapshots display a warning, never fabricated goods.
  Internal remarks and raw snapshots are excluded. Return contact is displayed
  only for a current non-cancelled return/transit record.
- PC now has `/user/refunds` and `/user/refunds/:id`, account/order-list entries,
  and an application-result history link. Both clients have seven filters,
  number search, bounded loading, exact failed-page retry and explicit errors.
  Current account, route and request revision scope all reads and navigation;
  mobile hide/unload and identity changes clear prior private detail.
- Cancellation is locked before confirmation and requires an exact null receipt.
  A late confirmation does not send a write. Success rereads the server;
  transport/malformed receipts block repeats until an authoritative cancelled
  detail is observed. An unchanged read does not unlock an unknown result,
  including after mobile hide/show. Explicit rejection allows a new confirmation.
  The UI distinguishes requested/refunded amounts and gives cancellation
  precedence; application status is not a guarantee of channel settlement.

### Verification and observed fixes

- 16 new PC and 28 new UniApp actual-component tests passed (44 total), covering
  account/route/hide isolation, delayed reads, invalid payloads, pagination,
  confirmation cancellation, receipt uncertainty and image-error identity.
- Final full PC: 228 auth/component tests plus 9 image tests; typecheck and build
  passed. Final full UniApp: 345 toolchain tests; typecheck, H5/Weixin/App builds
  and all 3 build-artifact tests passed.
- Refund Worker suite: 27 passed in 2 files, comprising 18 actual-controller/SQL
  cases and 9 product-projection cases. Worker unit/runtime typechecks passed
  after adding an explicit record type for legacy selection aliases; the first
  typecheck failure is not presented as a successful run. This is local SQL and
  type verification, not a Linux/workerd/provider-runtime acceptance.
- Browser plugin, no Playwright-process fallback: PC at 1081×792 and 390×844;
  H5 at 1280×720 and 390×844. The target flow was refund history → failed next
  page → exact retry → number search → owned detail → cancellation → read-back.
  PC loaded 20→26 visible records; H5 loaded 10→20→26. Both first append failures
  were injected 503s, and fixture logs confirm retries kept the same cursor.
- PC sample 26: cancel confirmation sent no write; a subsequent confirmation
  changed only the synthetic cancellation/status records. H5 sample 25: the
  server committed cancellation but returned an injected 502; the visible action
  stayed disabled until a read-only refresh showed cancellation. Returning to
  history and choosing cancelled showed samples 26/25 and preseeded sample 21.
- Browser testing found an unresolved PC-only `ProductImage` tag in the new H5
  detail. Replaced it with the UniApp image control and a scoped failure state,
  localized the modal cancel button, reloaded and confirmed image decoding
  (400×400 synthetic fixture image). A fresh final tab showed the cancelled
  detail with ¥0.00 refunded and no unresolved-component/route-attribute warning.
  Only the existing DCloud vue-router import deprecation remained. Page identity,
  meaningful content, absence of a framework error overlay, console inspection,
  screenshots and interactions were checked; 390px DOM width did not overflow.
- Disposable in-memory PGlite fixture final: 28 preseeded refund rows, 26 visible
  owned/non-deleted rows, exactly 2 cancellation POSTs, and 2 new status rows.
  All six order/account/stock/cart/bill snapshots remained unchanged. No approval,
  payout, logistics or other business write route was allowed by the local HTTP
  wrapper. Temporary UI/API listeners were stopped, browser tabs closed and the
  viewport override reset; prior services and nine staged files were untouched.

The frontend testing skill's rendered-validation loop caught the missing mobile
image component beyond passing SFC tests. Workers guidance informed bounded
public projections and request-local state (see the
[official Workers practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)).
The attempted latest workers-types lookup was socket-blocked; installed
`5.20260828.1` declarations were inspected instead. No runtime/binding configuration
or package version was changed.

Still open: return-logistics submission UI, product-name search, refused-record
reapplication/deletion flows, partial-quantity/image-upload application UI,
durable recovery across full reload/page destruction, provider settlement,
native-device behavior, production roles/Hyperdrive/capacity, Linux CI and rollout.
The detail's multiple reads are not claimed to be one atomic business snapshot.
Checklist remains 240 checked / 164 open / 404; FE-003F, A3k13 and SUP-004 stay open.

## Follow-up: customer return logistics and evidence (2026-09-14, local only)

The user confirmed that the new production product images are readable. No image
maintenance, production data/cache writes or rollout was repeated in this turn.
This increment completes the local customer-side express-return submission flow,
not merchant acceptance, refund settlement or the entire migration.

### Source contract and implementation

- Read the PHP PC `refund_goods.vue` and UniApp `order_refund_goods/index.vue`
  carrier, tracking, remark and three-image upload contracts. The PHP client sends
  `refund_explain`; the previous TS express controller ignored that field.
- Added a focused return payload parser: actual UTF-8 request bytes are capped at
  32 KiB, IDs and field types are checked, conflicting aliases are rejected, and
  legacy array/JSON/comma image references are bounded to three. Tracking is
  required and limited to 100 characters; phone 32, company/remark 255. Control
  characters, duplicate images, active schemes and persisted signed asset URLs
  are rejected. Public legacy HTTPS references remain accepted; HTTP references
  are not newly enabled. This follows the body-bounding guidance in the
  [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#stream-request-and-response-bodies).
- Canonical `/api/assets/:id` references must match the authenticated user's
  attachment metadata (type 3, module 3, image file, R2 image type 8), before
  submission and again before customer-detail preview signing. No caller-supplied
  foreign attachment is signed. Persistence uses canonical references, while
  previews use short-lived signatures. Invalid legacy evidence returns a warning
  and no image instead of preventing access to the whole refund detail.
- This reuses the existing transaction/row-lock/state predicate for type 4 -> 5
  and its single `refund_express` status row; it adds no payment, balance, stock,
  fulfillment-provider or approval side effects. The attachment ownership lookup
  itself is not in that business transaction; no atomic cross-read guarantee is
  claimed. No schema, binding or deployed configuration was changed.
- PC and UniApp use the existing enabled-visible carrier endpoint and actual
  authenticated multipart image upload. Phone is optional, matching the current
  backend/mobile contract rather than the old PC's mainland-only requirement.
  Remarks use the existing backend's 255-character ceiling, not the old UI's 100.
- Shared state freezes the submitted body, serializes upload/return/cancel actions,
  and rejects late account/route/lifecycle callbacks. Native image selection is
  checked again before upload; upload callbacks cannot clear a replacement login.
  Explicit rejection retains the editable form. Transport or malformed-receipt
  uncertainty locks return and cancellation until a read matches status and all
  submitted fields, including canonical evidence references. Reads never resend.
- Browser QA found the uncertainty message was too far from the form; an inline
  explanation and read-back action were added. Confirmation copy defers to the
  current refund status, so it does not imply pending processing or money arrival
  after a concurrent cancellation/completion. Unsubmitted forms clear on refresh;
  removing an image detaches it from this form and does not delete stored objects.

### Verification and evidence boundaries

- New tests: 11 PC and 13 UniApp actual component/API lifecycle cases; 17 Worker
  cases (six controller/SQL cases and eleven payload cases). The SQL cases include
  real upload metadata/signature/asset reads, foreign-owner rejection, strict body
  parsing, legacy remark preservation, replay rejection, and a last-write CHECK
  failure proving the return transition rolls back before an explicit retry.
- Final targeted Worker run: 59/59 across refund application/read/return, legacy
  route and attachment tests. This includes 44 refund cases (24 actual
  controller/SQL and 20 pure projections/parsers). An existing attachment config
  test initially failed solely on Windows CRLF; its two newline assertions now
  accept LF/CRLF without weakening binding values or changing `wrangler.toml`.
- PC: 239 auth/component tests plus nine image tests, type checking and build.
  UniApp: 358 toolchain tests, type checking, H5/Weixin/App builds and three build
  artifact tests. Worker unit and runtime type checking passed. An initial direct
  default-heap `tsc` attempt exhausted 2 GiB; the repository's normal 4-GiB scripts
  passed. This is not a successful workerd runtime run. Latest types retrieval was
  unavailable under socket restrictions; installed workers-types 5.20260828.1
  and current official documentation were inspected; no dependency was installed.
- Browser plugin, no Playwright fallback: PC at
  `http://127.0.0.1:5393/user/refunds/25` (1280x720), H5 at
  `http://127.0.0.1:5394/#/pages/order/refundDetail?id=32` (390x844). Meaningful
  DOM/title/URL, no framework overlay, screenshots, carrier selection, upload,
  acknowledgement, submission and read-back were checked. Public repository
  `logo.png` was used as a local test-only evidence file and decoded at 256x256.
  H5 POST committed in SQL but returned injected HTTP 502; disabled controls and
  the inline read-back action were verified, then the exact fields/image matched.
  Final wording and failure recovery were repeated after reload on a fresh fixture.
- First disposable browser fixture: two return POSTs, two status rows, two memory
  objects. Final fresh fixture: two return POSTs, two status rows, one H5 evidence
  object; PC also verified submission with optional evidence/phone omitted. Both
  fixtures retained identical six-category non-refund snapshots. All fixtures
  used synthetic authentication, process-local PGlite and an in-memory R2 subset,
  not real R2, production PostgreSQL, provider callbacks or Hyperdrive.
- PC console error/warn empty; H5 has the existing dependency-level deprecated
  `vue-router/dist/vue-router.esm-bundler.js` import warning, no new application
  error. Browser tabs and temporary viewport overrides were cleaned up; owned
  development/fixture servers were stopped. No staging, commit, push or deployment.

Remaining: merchant-side evidence display and receipt/approval acceptance,
in-person store returns, refund-application evidence/partial quantities, product
name search, reapplication/deletion, durable intent recovery across page teardown,
native picker/hide behavior, expired-image UX, orphan upload cleanup, real
roles/R2/Hyperdrive/capacity, Linux/workerd/CI and coordinated rollout. Customer
detail's multiple reads remain non-atomic. Checklist stays 240 checked / 164 open
/ 404; FE-003F, A3k13 and SUP-004 remain open.

## Supplier return evidence and detail/action lifecycle (2026-09-15)

Status: local candidate only, not deployed. The previous goal turn only
acknowledged that new product images were readable; this turn revalidated the
dirty worktree and made the supplier merchant-side increment below. It does not
close the overall refund migration or the Admin counterpart.

### Source and missing behavior

- PHP supplier `view/supplier/src/pages/order/refund/index.vue:133-154` displays
  `refund_explain`, `refund_goods_explain` and `refund_goods_img`. Some old blocks
  use `v-html`; the migrated supplier UI deliberately renders user remarks as
  escaped text. Customer return submission already persists those fields.
- Current Supplier detail dropped the submitted carrier, tracking, phone,
  explanation and evidence. Its page retained previous detail during reads and
  used `current.value.id` after awaiting the monetary confirmation dialog. An
  intervening selection could therefore change the requested target.
- Supplier Pages had only a `/supplierapi/*` proxy, so canonical signed
  `/api/assets/:id` previews also needed a same-origin asset route.

### Implemented boundaries

- `SupplierAfterSaleService.detail` uses a read-only repeatable-read database
  transaction for refund/order selection and attachment-owner checks. Both
  refund and original order must belong to the authenticated supplier, both
  must be visible, and their customer UIDs must agree. The same UID equality
  predicate is now on the list. Cancelled historical details remain readable
  but explicitly carry `is_cancel`; the frontend blocks writes for them.
- Return evidence is capped in the SQL projection at 8 KiB before parsing,
  with at most three distinct canonical or safe legacy HTTPS references. The
  reused attachment reader checks upload type/module, image purpose and owning
  customer before HMAC signing. Invalid, foreign or wrong-purpose images return
  an empty collection plus a neutral warning, never a foreign signed URL. Cart
  JSON is bounded at 64 KiB. Full legacy order projection/other merchant detail
  consumers still need separate minimization review.
- Added detail fields: `refund_explain`, `refund_express`,
  `refund_express_name`, `refund_phone`, `refund_goods_explain`, `is_cancel`,
  `returnImages` and `returnImagesError`. The actual auth and refund-view
  middleware remain in place, including existing private/no-store headers.
- Supplier detail receipts are checked for exact ID, supported states, bounded
  fields, monetary format and safe evidence previews. Missing new contract
  fields fail explicitly, not as fabricated empty evidence or actionable rows.
  Deploy the backend and Supplier frontend/Functions in coordination.
- New `functions/api/assets/[id].ts` accepts GET/HEAD only, streams through the
  existing Worker mapping, forwards no merchant bearer/cookies, does not follow
  upstream redirects, strips Set-Cookie and forces private/no-store. Vite now
  proxies `/api/assets/` to the same configured local API target.
- The drawer displays submitted carrier/tracking/phone, escaped remarks,
  clickable evidence with no-referrer, empty/error states and an explicit
  read-only refresh. It labels customer submission as distinct from merchant
  receipt or refund settlement. Image decode failures offer refresh instead
  of leaving an unexplained broken thumbnail.
- Account/permission scope, route and opening-generation guards clear old
  details, notes and evidence synchronously. A -> B -> A cannot revive an old
  request/confirmation. Each operation captures its refund ID, amount/text and
  opening; duplicate operations are blocked, queued requests are cancellable,
  late responses cannot replace another detail, and a refresh failure clears
  actionable content. Only explicit valid completion receipts say completed;
  PROCESSING remains awaiting channel confirmation. Unknown mutation results
  lock that refund for read-only checking within this mounted page. This lock
  is not durable across page teardown and must not be represented as durable
  idempotency or complete recovery.

### Verification and exact limits

- Added `supplier-refund-evidence.test.ts`: 12 tests using actual customer
  upload/submission, Supplier JWT auth/role permissions/controller/service,
  process-local PGlite and the Pages proxy. Cases include owned signed bytes,
  read-only role success/write denial, no permission, foreign supplier, role
  revocation, six ownership/visibility inconsistencies, cancellation, invalid/
  oversized/foreign/wrong-purpose images, private proxy streaming and rejection
  of mutation paths. Test object storage is memory only; no provider route is
  mounted by `supplierRefundEvidenceFixture`.
- Added `supplier-refund-frontend.test.ts`: 21 tests bundling the actual SFC
  script, Axios, Pinia, router and session scope. Dialogs/transport are controlled
  only by the test harness. Covers stale A/B reads, failure/invalid receipts,
  four confirmation invalidations, exact single dispatch, PROCESSING wording,
  malformed acknowledgements, cancelled/read-only action blocking, late note
  response, queued cancellation, stale/failed list, failed read-back and manual
  versus automatic retry. Rendered template behavior is verified separately in
  the browser, not inferred from these script tests.
- Final `vitest run` passed **162 tests in 11 files**: the two new suites plus
  supplier-refund-migration, supplier-shipping-session, customer-refund-return,
  customer-refund-read, customer-refund-application, attachment-storage-migration,
  order-legacy-migration, supplier-rbac-migration and supplier-pages-acceptance.
  Final `npm run typecheck` passed both Worker unit/runtime type projects;
  Supplier `npm run build` passed typecheck and Vite build. A test tuple initially
  inferred method as string|number; narrowed it with `as const` and reran.
  Existing VueUse annotation and large-chunk build warnings remain.
- Browser plugin, `http://127.0.0.1:5393/refunds`, desktop 1280×800 and mobile
  390×844: real page identity/title, meaningful DOM, no error overlay, console
  warnings/errors empty. Synthetic merchant login -> returned record25 ->
  256×256 logo decoded through the signed canonical asset route -> save one
  note -> record32 injected read failure with no old content -> read-only retry
  showing its invalid evidence warning, with zero native image elements.
  Logout and synthetic read-only role login -> evidence visible, note save
  disabled, refusal absent. Reloaded final code and repeated valid/invalid
  detail checks; mobile document width equals viewport390 and remarks wrap.
- Browser fixture final state: **16 supplier reads, 1 note PUT**, six business
  snapshots unchanged (orders/users/bills/products/SKUs/carts), monetary routes
  absent. Setup used one local upload and one actual customer return submission
  to seed the returned record; these are not production writes. Dev servers
  and browser viewport/tab are cleaned up after verification.
- Workers skill references retrieved from the current
  [best-practices page](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
  Latest npm types metadata retrieval was blocked by socket permissions;
  installed workers-types **5.20260828.1**, local schema and binding types were
  used as the documented fallback. No dependency/config binding change.
- Current [Hyperdrive query-caching guidance](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
  recommends a cache-disabled binding for fresh reads and says writes do not
  invalidate cached reads. This turn did **not** verify deployed cache behavior;
  the local transaction is not evidence that Hyperdrive caching is bypassed.
  Auth/permission freshness, concurrent reassignment, real PostgreSQL/Hyperdrive
  isolation, real R2, Linux/workerd/CI and coordinated rollout remain gates.

Admin merchant evidence display and its detail/action lifecycle, refund goods
and application evidence display, complete receipt/approval acceptance,
in-person returns and the other customer/refund gates above remain unfinished.
No commit, push, deploy or production DB/R2/cache mutations in this turn. The
existing nine staged files were preserved. Checklist remains **240 checked /
164 open / 404**; FE-003F, A3k13 and SUP-004 remain open.

## Admin return evidence, reviewed decisions and lifecycle (2026-09-15)

Local candidate only; supersedes the Admin detail/display gap noted in the
preceding Supplier increment, not the full migration/release gates.

### PHP contract and implementation

- Re-read PHP Admin `order/orderList/handle/orderDetails.vue:329`: carrier,
  tracking, return explanation and evidence are part of the original detail
  flow (phone is retained in the schema though commented out in that template).
  PHP `order/refund/index.vue` permits in-person type3 refunds at state4;
  `StoreOrderRefundServices::agreeRefundProdcut` separately approves a return
  at state4 without issuing a monetary refund. The TS page now preserves that
  distinction; express type2 needs state5, in-person type3 accepts state4/5,
  both with explicit manual receipt acknowledgement before the refund button.
- Added a focused Admin read service. Modern list `view=admin` uses descending
  ID cursors, 20 default/100 maximum rows, optional status and literal order
  number search; the older bare-array list is retained for other consumers.
  Detail/list join the original order and reject UID, supplier/store or deletion
  inconsistencies. Cancelled history remains readable and non-actionable.
- Detail/contact/attachment ownership use one read-only repeatable database
  snapshot with a 5-second statement timeout. Only needed order/payment fields
  are selected; legacy cart JSON is bounded to 64 KiB and return image data to
  8 KiB before materialization. At most three validated images are signed only
  after uploader/purpose checks. Invalid/foreign/malformed references produce
  a neutral warning, no signature and no previous-row image. User text is
  interpolated as text, never HTML. Application evidence/goods presentation is
  still a separate unfinished surface.
- Both Admin decision URLs now require a bounded 4 KiB JSON body containing
  `review` (original refund/order/customer/store/supplier and reviewed amount).
  Agreement additionally requires explicit `action: return | refund`.
  The core repeats expected identity/amount/paid/visibility checks under its
  existing locks. This is a coordinated API + Admin frontend contract change:
  **old ID-only Admin callers are rejected; do not deploy the Worker alone**.
  The rest of the legacy decision routes were not changed in this increment.
- Unexpected execution exceptions are no longer flattened into a business
  rejection. The page validates null return/refusal receipts and exact
  completed/processing monetary receipts; PROCESSING is never described as
  completed. No actual gateway call or balance payout was exercised here.
- Refund-specific Axios transport captures credentials synchronously and cancels
  on session generation changes, including A -> B -> A. Detail/list generations,
  route/close invalidation and owned confirmation closure prevent old identity
  or old refund content from repopulating the view. Read failures clear the
  detail, do not fall back to the list row, and expose read-only retry.
- Before dispatch, per-admin pending refund IDs are stored locally. Duplicate
  clicks and remount/reload after an unknown outcome do not resubmit. Known
  receipts require matching fresh detail state before clearing that guard.
  This is **not** a full durable idempotency/recovery protocol: cross-tab atomic
  coordination, operation-key/payload persistence, and a safe workflow to
  resolve/discard pending guards after independent verification remain open.
- New Pages `/api/assets/[id]` proxy streams GET/HEAD only, forwards the signature
  but no admin credentials/cookies, does not follow redirects and forces private
  no-store responses. Existing Admin Vite `/api` proxy handles local images.

### Verification and limits

- New actual JWT/role/controller/SQL/proxy suite: **20 tests**. New actual
  SFC/Axios/router/session suite: **25 tests**. Final regression set: **165
  tests across 11 files, zero failures/skips**, including Admin shipping-session
  and permission, Supplier refund/evidence/frontend, customer refund return/read,
  attachment and order legacy suites. Exact return-approval checks permit only
  order28 refundStatus/type and refund28 type changes plus one status record;
  all six business snapshots otherwise match. An initial strengthened assertion
  failed on unspecified SQL row order; sorting by primary key fixed the test
  comparison while retaining every field check.
- Worker unit/runtime typechecks, Admin production build and a separate
  workers-types compile of the new Pages Function passed. Existing VueUse
  annotation build warnings remain. No packages or binding config changed.
- Browser plugin at `http://127.0.0.1:5393/refund`, desktop1280x720/mobile390x844:
  login -> 20-row first page -> 7-row second page -> detail25 -> signed 256x256
  image decoded and HTML-looking remark rendered literally -> detail32 injected
  failure -> retry shows only its own warning, zero native image elements.
  An Admin approval of return28 committed in isolated SQL then received an
  injected error envelope. Buttons stayed disabled; read-only refresh showed
  state4 and a full browser reload preserved the pending guard. Only one
  approval POST was observed in that fixture (13 Admin reads); monetary dispatch
  was explicitly denied by the local server. Its aggregate whole-business
  snapshot was not identical because the approval changes order state; exact
  permitted field changes are proven by the separate SQL test above, not by
  claiming the browser fixture was entirely read-only.
- Logout -> real read-only platform role -> detail25 kept evidence visible
  with no decision buttons. Mobile image decoded at256x256; document and
  scroll widths both390, no horizontal overflow. Browser error/warn logs empty,
  meaningful DOM/title and screenshots checked. The temporary server does not
  implement the unrelated Admin notification WebSocket: Vite recorded proxy
  ECONNRESETs on that channel. This is not acceptance of notifications or of
  the full Admin application. Some locator-scoped read evaluations timed out;
  fresh DOM/global read-only evaluation and screenshots verified the state.
- A separate final-code fixture checked in-person record39 at state4: actual
  store1 return contact rendered, the refund button was disabled until manual
  receipt acknowledgement, and refreshing detail cleared that acknowledgement
  and disabled it again. No refund button was clicked. Final state: **4 reads,
  0 decision writes, six business snapshots unchanged**. Initial fixture startup
  hit an already-preseeded store1; changed only the fixture setup to update that
  synthetic store, then started the successful independent instance. Browser
  fixture login and R2 are synthetic, SQL is process-local PGlite and the host
  is Node, not workerd/Hyperdrive/production Redis or R2. Test accounts logged
  out, owned tabs closed, viewport reset, and both local servers stopped.
- Current Workers best-practice and Hyperdrive caching references were retrieved.
  Latest npm workers-types metadata was blocked by local socket permissions;
  installed5.20260828.1 and bundled Wrangler schema were used as fallback.
  No local transaction test establishes deployed Hyperdrive cache bypass.

No production DB/R2/cache writes, commit, stage, push or deployment. Existing
nine staged files preserved. Checklist **240 checked / 164 open / 404** remains
unchanged. Remaining work includes application/goods evidence, decision-time
role freshness, full receipt/recovery/concurrency, actual financial/provider
acceptance, current-candidate Linux/workerd/CI and coordinated rollout.

## Admin pending-intent recovery (2026-09-15)

Local candidate only. This increment supersedes the ID-only/cross-tab/recovery
limitations of the immediately preceding Admin increment **only within one
cooperating browser origin**. It does not establish server-side idempotency.

### Implementation

- `view/admin-ts/src/utils/refundIntent.ts` validates a bounded version2 record
  per administrator and refund. It preserves the original action, reviewed
  customer/order/store/supplier/amount, application type and initial state,
  normalized refusal reason, receipt acknowledgement, creation time and UUID.
  The exact record is written and read back before HTTP dispatch. Legacy v1
  ID-only pending records remain blocked; no operation is inferred from them.
- Exclusive entity Web Locks use `ifAvailable: true` and remain held through
  persistence, dispatch and read-back. Unsupported browsers or unavailable
  locks fail before a write is sent; there is no unsafe fallback. The callback
  lifetime follows the [MDN LockManager.request contract](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request).
  Compare-and-set raw record checks are performed under that lock; these are
  not a claim that localStorage itself offers atomic multi-client transactions.
- Accepted details are bracketed by original-record reads. Changed storage,
  route/selection/session changes and stale confirmations invalidate the view.
  Resolved records are retained rather than deleted, so a tab which reviewed
  an older null snapshot cannot overwrite a later operation or resolution.
  A subsequent legitimate decision must first read the resolved record and
  current detail, confirm anew, and persist its own new nonce.
- `RefundList.vue` displays the original action and provides **GET-only**
  reconciliation. The row identity/application type/amount must match. Return
  approval requires state4/5/6; refusal requires state3, exact original reason
  and no active provider; monetary refund requires state6, exact settled amount
  and absent/SUCCESS provider. Cancelled/deleted or mismatched rows remain
  pending. The message says the server **has reached the original goal**, not
  that this browser request was proven to have caused the transition.
- Reconciliation cannot clear a newer nonce, does not send a financial request,
  and does not automatically retry a failed/unknown request. Records are scoped
  by actor, not global account data. Session invalidation clears visible detail
  and the current in-memory original operation, leaving durable guards intact.

### Verification and remaining limits

- Added **14 actual SFC/Axios/router tests** and **15 protocol tests**: persistence,
  legal receipt stages, legacy/corrupt/unwritable storage, held/unsupported locks,
  stale two-view confirmations, resolved tombstones, superseding nonces during
  reads, session changes, exact rejection reason, unsettled/mismatched money,
  reload -> GET-only recovery and a new reviewed action after resolution.
  Final regression: **194 tests / 12 files, zero failures/skips** (39 Admin
  frontend, 15 intent, 20 Admin backend plus the prior regression suites).
- Worker unit/runtime typechecks and Admin production build passed. The first
  full typecheck exposed Workers' narrower Navigator type and unused test
  arguments; a structural browser lock interface and underscored arguments
  fixed these, with the final tests and typechecks rerun. Existing VueUse build
  annotation warnings remain. No dependencies or Worker application code changed
  in this increment.
- Browser plugin, `http://127.0.0.1:5394/refund`, desktop1280x720 and mobile390x844:
  two tabs read pending refund28 and open return approvals. One confirmation
  sends exactly one non-monetary approval to actual local JWT/controller/SQL;
  the other tab's old confirmation closes and its old detail is removed on the
  storage event. The fixture commits state4 but intentionally returns an error.
  Both tabs are reloaded with final code; the original action and amount remain
  visible and financial/approval resubmission is disabled. Mobile GET-only
  reconciliation reaches the goal, retains a resolved record and invalidates
  the other tab again. That tab refreshes to state4 with return and monetary
  buttons still disabled. No monetary button was clicked.
- Final fixture counters: **12 Admin reads / 1 approval POST / monetary dispatch
  disabled**, refund28 state4. Whole-business snapshot is intentionally changed
  by that approval; the existing SQL suite proves the exact permitted business
  field/status changes. Node/PGlite and in-memory attachments are not deployed
  workerd/Hyperdrive/R2. Both page titles, meaningful DOM, absence of framework
  overlays, empty browser error/warn logs and screenshots were checked; mobile
  document/scroll widths were both390. Viewport overrides apply to the selected
  tab, so the initial primary-tab capture remained desktop; the second-tab
  actual width390 and screenshot supply mobile evidence. The unrelated fixture
  notification WebSocket is still unimplemented, causing Vite proxy ECONNRESETs.
- This is **not a durable server receipt**, not cross-device/cross-origin
  coordination, and not concurrency protection against old clients or cleared
  local storage. The nonce is not transmitted to or persisted by the backend.
  Unconfirmed/legacy records have no arbitrary clear/retry affordance. Reliable
  server operation receipts, operation/role freshness across administrators,
  retention policy, gateway/reconciliation acceptance, Linux/workerd/CI and
  coordinated API/Admin rollout remain open. No local test proves fresh reads
  through deployed Hyperdrive query caching.

No production DB/R2/cache/image writes, stage, commit, push or deployment.
Existing nine staged files preserved. Owned temporary tabs/servers cleaned up;
viewport reset. Checklist remains **240 checked / 164 open / 404**.

## Admin locked decision admission (2026-09-15)

Local candidate only. This supersedes the preceding Admin decision-state and
SQL-backed role-freshness gaps for the modern Admin decision endpoints, not all
session revocation, legacy callers, distributed concurrency or provider gates.

### Implementation

- Three initial real-controller/SQL tests were red: disabling the administrator
  after middleware authentication, changing refund state0 to state1 after the
  user reviewed it, and omitting the decision snapshot all returned status200.
  `AdminRefundDecisionService` now rejects each before the business decision.
- Modern approval/refusal requests include an immutable `decision` snapshot:
  application type, reviewed refund state and receipt acknowledgement. Identity
  and amount remain in the existing `review` contract. Return approval accepts
  only return applications in state0/1/2; monetary type2 requires state5 and
  acknowledgement, and type3 requires state4/5 and acknowledgement. Receipt
  acknowledgement is an operator assertion, not independent proof of delivery.
- After refund/order locks, the SQL-only hook checks the trusted authenticated
  actor again: current platform-admin type, enabled/not-deleted state, constant-
  time password-version comparison, token expiry, and current `refund.manage`
  role/menu grants. Super-admin handling follows existing level0 semantics.
  Actor and decision values are copied before callbacks; request JSON cannot
  supply an authorization callback. Exact application type and state must still
  match the user's reviewed snapshot, even when both states permit approval.
- Authorization rows use `FOR SHARE NOWAIT`; granted roles and legacy numeric
  menu rows are ordered by ID and remain locked through commit. A competing
  authority writer produces a bounded refresh/reconfirm error, not a wait cycle.
  Ordinary permission reads retain their previous nonlocking behavior. There is
  no Redis/provider/network call inside this SQL authorization hook. This design
  follows the short-transaction/consistent-lock guidance in the PostgreSQL
  skill and [PostgreSQL explicit locking reference](https://www.postgresql.org/docs/current/explicit-locking.html).
- The hook repeats before balance settlement, provider admission and the
  QUERY -> NOT_FOUND request reclaim. Once a provider operation has been
  admitted, successful provider reconciliation/callback finalization remains
  unscoped by the initiating administrator: later revocation must not strand
  a payment already accepted. Revocation after admission is not cancellation
  of that admitted external operation. Legacy callers without this hook retain
  their existing behavior.
- Admin sends the frozen receipt acknowledgement with the frozen request.
  Missing snapshots and old state replays are rejected; API and Admin must be
  deployed together. No server operation receipt exists to distinguish a retry
  of an accepted operation from a new stale decision. The browser conservatively
  retains a pending guard after a rejected/unknown write and only reads back;
  a mismatch cannot be arbitrarily cleared or automatically resubmitted.

### Verification and limits

- **29 new tests** use the real JWT/controller/SQL fixture or targeted core
  phase tests: status/type/delete/password/expiry drift, role disable/removal/
  reassignment, legacy menu changes, immutable snapshots, receipt stages,
  real refusal persistence/outbox, pre-balance/pre-provider reauthorization and
  NOT_FOUND reclaim. The provider-SUCCESS-after-revocation case mocks final
  settlement and proves routing only; it is not a real settlement acceptance.
- **5 additional PostgreSQL tests are skipped**, not passed. They require
  `TEST_FINANCE_POSTGRES_URL` and the existing explicitly dedicated PostgreSQL16
  fixture. Independent connections and observed blocking barriers cover a
  waiting refund decision followed by account/state changes and concurrent
  admin/role/menu row locks. Neither process nor user environment had that URL;
  no dedicated local server/runtime was found. No unrelated or production
  database was substituted. PGlite tests do not prove multi-connection locking.
- Final regression: **243 passed / 5 skipped, 17 passed files / 1 skipped file**,
  including Admin decision/evidence/frontend/intent/permission, legacy Admin
  mobile paths, core refund, provider, Supplier, customer and attachment suites.
  Worker unit/runtime typechecks and Admin production build passed; existing
  VueUse annotation warnings remain. Current Workers guidance and bundled
  Wrangler schema were inspected; latest npm types metadata was unavailable
  due to socket permissions, so installed5.20260828.1 was the fallback. No
  dependencies or Wrangler configuration changed. Reference:
  [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
- Browser plugin on `http://127.0.0.1:5395/refund`, final-code reload, desktop
  viewport setting1280x720 and actual mobile390x844: refund28 approval reaches
  state4 and resolves the local intent; refund35 changes from0 to1 after entry
  auth and its stale request is rejected, GET-only reconciliation shows the
  mismatch and keeps submission disabled; refund42 disables the administrator
  after entry auth and the request is rejected, detail/session are cleared and
  the UI returns to login. No monetary button was clicked.
- Final fixture: **10 Admin reads / 3 approval POST attempts / 1 accepted
  approval**, monetary dispatch disabled. Refund28 is state4, refund35 is state1
  from the explicit drift injection, refund42 remains state0; all three refunded
  amounts are0.00. One approval status was added, alongside the initial fixture's
  customer-logistics status. Whole-business snapshot is intentionally changed
  by the permitted approval/test injections, not claimed unchanged. Fixtures use
  process-local PGlite and in-memory R2 under Node, not workerd/Hyperdrive/R2.
  Meaningful DOM, titles, screenshots and empty browser error/warn logs checked;
  mobile document/scroll widths both390 and no Vite overlay. The unrelated
  fixture notification WebSocket still causes Vite proxy ECONNRESETs.
- Remaining gates: actual PostgreSQL connection/lock execution; atomic Redis
  logout/revocation handling during SQL waits; durable server operation nonce/
  receipt and cross-actor/device recovery; old decision clients; real provider
  settlement/Hyperdrive freshness; Linux/workerd/CI and coordinated rollout.
  No local transaction is evidence of deployed Hyperdrive query-cache bypass.

No production DB/R2/cache/image writes, stage, commit, push or deployment.
Original nine staged files preserved. Account invalidation returned to login;
owned browser tab closed, viewport reset, both local servers stopped. Checklist
remains **240 checked / 164 open / 404**; full financial migration remains open.

## Native PostgreSQL decision verification (2026-09-15)

This local follow-up supersedes the preceding **5 skipped native PostgreSQL
decision tests** and the missing-local-runtime limitation. It does not supersede
Linux/workerd/Hyperdrive, real provider or production acceptance gates.

### Dedicated runtime and reproducible entry point

- Downloaded the Windows16.15-3 portable archive linked from PostgreSQL's
  [Windows downloads](https://www.postgresql.org/download/windows/) to
  [EDB binaries](https://www.enterprisedb.com/download-postgresql-binaries).
  The binary reports PostgreSQL16.15. Archive size333048048 bytes; local SHA256
  `5e8afffe67daf949aeeb03b74951f1ec2324e1888f73fbd036ab0e567ab004d9`.
  This hash is a recorded local fingerprint, not a separately published vendor
  attestation. The executable's Windows Authenticode status is `NotSigned`;
  source provenance is the official linked HTTPS distribution.
- Runtime resides in ignored
  `.cache/postgres16-20260915/runtime/pgsql/bin`. No installer/system service,
  global PATH, user environment, production URL or new package dependency was
  added. `scripts/run-local-finance-postgres.mjs` accepts an already trusted
  PostgreSQL16 binary directory and explicit existing `test/name.test.ts` files;
  option injection, path traversal and missing files fail before startup.
- Each run creates a new private `.cache/finance-postgres-*` cluster, random
  loopback port and random bootstrap/test passwords. Windows permissions are
  narrowed only on that new directory to the current user. Authentication is
  SCRAM, not trust; the short-lived bootstrap password file is removed in
  `finally`. The test role has LOGIN/CREATEDB but is neither SUPERUSER nor
  CREATEROLE/REPLICATION. Tests receive the URL only in their child environment.
  The runner verifies server data-directory identity, version, host/port and
  test database/role before dispatch. Each finance fixture still creates its own
  owned random database and schema; its existing production-URL guard remains.
- Normal completion and caught failure both check fixture leftovers and stop
  only that owned cluster. Startup observation failure still checks `pg_ctl
  status`; it is not assumed stopped merely because the command timed out.
  Logs and stopped cluster data remain for diagnosis, without automatic broad
  deletion. A forcibly killed runner/host still requires checking the logged
  cluster path with `pg_ctl status -D <exact-owned-data-dir>` and, if live,
  stopping that exact instance; this is not an OS service supervisor.
- Setup exposed three Windows wrapper issues before the successful runs:
  `initdb --pwfile=-` treats `-` as a filename; detached server children can keep
  output pipes open after successful `pg_ctl start`; and empty `PGSERVICEFILE`
  is not equivalent to an unset variable. Fixed with the private temporary
  password file, owned log plus non-piped startup, and removing inherited PG
  environment overrides for explicit administrative probes. Failed instances
  were stopped, not restarted under an unverified live handle. References:
  [initdb](https://www.postgresql.org/docs/16/app-initdb.html),
  [pg_ctl](https://www.postgresql.org/docs/16/app-pg-ctl.html).

Example from `workers-ts` after obtaining the trusted runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/admin-refund-decision-postgres.test.ts
```

### Executed evidence

- The original two wait-then-change tests now assert the exact AuthException/
  ValidateException and business code/message, not merely any rejection. The
  original three authority-row NOWAIT cases passed unchanged on independent
  native PostgreSQL backends.
- Added three reverse-direction tests: after the actual authorization acquires
  admin/role/menu locks, a test-only barrier pauses the decision. An independent
  writer attempts revocation; `pg_blocking_pids` identifies the decision backend
  as its actual blocker. Decision commit succeeds, revocation then succeeds,
  and a fresh decision on a different refund is denied with the expected auth
  code. Exactly one approval/status is recorded. The barrier is test-only, not
  an external wait added to production transactions. Four distinct backend IDs
  and unchanged connection identities are enforced by `withFinancePeers`.
- Initial native smoke: **8/8 passed**, then included again in the final broader
  regression below; do not add the smoke count a second time.

| Final batch | Files | Passed | Skipped |
| --- | ---: | ---: | ---: |
| Admin/Supplier/customer refund, permission, provider and core regression with native PG configured | 18 | 251 | 0 |
| Finance peer boundary, cross-fixture advisory isolation, pink refund lock ordering, cancellation authorization and refund recovery | 5 | 90 | 0 |
| Local runner pre-start CLI boundary checks | 1 | 4 | 0 |
| Total, without repeated smoke | 24 | 345 | 0 |

The 341 tests in PG-configured batches include frontend/mocked/unit assertions;
not every assertion executes SQL or represents an independent concurrent
scenario. The eight Admin native tests explicitly establish independent-backend
locking; the real SQL fixture suites use PostgreSQL instead of PGlite. Existing
gateway mocks are not real provider settlement. Worker unit/runtime typechecks
and runner syntax passed; unit types were rerun after the final runner tests.
No frontend/app logic changed in this follow-up, so the prior browser evidence
is retained rather than presented as a new UI run.

Every successful run reported zero remaining `finance_fixture_*` databases.
Final independent inspection of the five clusters that had started returned
`pg_ctl status` exit3, no postmaster PID files, no bootstrap password files, and
zero processes from this downloaded PostgreSQL runtime. The first failed
initialization produced no initialized cluster. Binary cache and stopped
diagnostic data remain on disk; nothing is running or registered as a service.

No production DB/R2/cache/image writes, stage, commit, push or deployment.
Original nine staged files preserved. This closes the scoped native-PostgreSQL
verification gap; Redis logout/revocation atomicity, durable server operation
receipts, old clients, real provider/Hyperdrive behavior, current-candidate
Linux/workerd/CI and coordinated rollout still need evidence. Checklist remains
**240 checked / 164 open / 404**.

## Durable Admin refund operation service candidate (2026-09-15)

This is a **local SQL/service candidate, not an enabled HTTP/UI feature**. It
supersedes the statement that no server-side implementation exists, but does
not close the server-receipt rollout/recovery gate. Existing Admin controllers
and browser intents still do not send or consume this protocol.

### Implemented boundaries

- `AdminRefundOperationLedger` stores a content-free immutable receipt keyed by
  trusted administrator ID and UUIDv4. Its hash binds the normalized refund ID,
  action, reviewed order/user/store/supplier/amount, original application type
  and state, receipt acknowledgement and refusal reason. Session tokens and
  raw reasons are not stored. There is no TTL, update, deletion or business-row
  cascade. A reused key with different content fails with409.
- `AdminRefundOperationService` checks current SQL account/password/expiry and
  `refund.manage` authority for execution, owner lookup and abandonment. It
  copies the actor and normalized input before the first asynchronous hash.
  Terminal receipt replay does not require the mutable business row still to
  exist; provider settlement replay additionally checks persisted confirmation
  identity, amount and success status.
- Core SQL-only hooks append return approval/refusal/local settlement evidence
  in the same transaction as their actual status/outbox/balance/bill/inventory
  changes. Provider admission shares the payment-intent commit **before** any
  gateway call. `provider-admitted` is not proof of settlement. The existing
  core uses `BALANCE_SUCCESS` for its balance/zero-cash finalization branch;
  the candidate `balance-settled` outcome follows that internal branch and
  must not be rendered as a promise of a nonzero balance credit.
- A missing lookup is not proof that a delayed sender cannot arrive. Explicit
  abandonment records a permanent `abandoned` fence under the same key lock;
  an already admitted/accepted operation wins unchanged. Late senders inspect
  the fence before business writes. GET-style lookup never dispatches, and an
  explicit same-key retry retains the existing `CNSR<refundId>` payment number,
  lease and query-before-retry behavior. Abandonment is not provider cancellation.
- Native regression exposed an outer-transaction hazard: nested `withTx`
  savepoints would allow the gateway call before the outer caller committed
  admission. The execution entry now requires a root database client before
  any work. The red test actually reached the synthetic provider before this
  fix; it now rejects without any provider call/payment/receipt. No real payment
  provider was contacted.

### Executed evidence and limits

- **24 executor tests and15 ledger tests** cover actual return/refusal
  persistence and replay after business-row deletion, normalized immutable
  inputs, stale/revoked/read-only actor rejection, missing-receipt abandonment,
  balance credit/bill/stock/order/refund atomicity and rollback on receipt
  insertion failure. Money tests restore an actual unshipped SKU, not a stubbed
  finalizer. Payment adapters alone are mocked and fail closed by default.
- Provider-path tests assert committed receipt plus REQUESTING/attempt evidence
  through root SQL reads at gateway entry, PROCESSING and active-lease duplicate
  behavior, lost response -> UNKNOWN -> same-number query/SUCCESS, explicit
  NOT_FOUND redispatch, revocation before redispatch, and Alipay terminal replay.
  A verified synthetic WeChat notification invokes the real SQL finalizer after
  administrator revocation. A corrupted settled payment amount fails closed.
  These prove local state-machine/SQL behavior, **not actual provider acceptance**.
- Five new independent-backend cases span ledger and executor: concurrent
  same-key approvals, abandonment winning a waiting sender, and a real executor
  commit winning a competing duplicate or abandonment. Test-only SQL barriers
  use `pg_blocking_pids` for the exact wait edges, never delays as lock evidence.
- Focused final run: **96 passed,5 files,0 skipped** on isolated PostgreSQL16.15,
  including the39 receipt tests and existing Admin decision/evidence tests.
  The initial32-test run had31 passes and the expected outer-transaction
  regression failure; it is not reported as a passing batch. Worker unit/runtime
  typechecks pass after the fix. Native receipt tests were rerun after the prior
  ledger root-client guard changed to `Object.hasOwn`.
- Broader final regression: **355 passed,22 files,0 skipped**, covering these
  five files again plus Admin frontend/intent/permission and legacy mobile,
  customer/Supplier refund, payment protocol, attachment and pink cancellation/
  refund-lock suites. Do not add the focused96 a second time. PG configuration
  does not turn frontend/source assertions or gateway mocks into real SQL or
  provider scenarios. Each owned test cluster reported zero fixture databases
  and a verified stopped status on exit.
  Independent final inspection of this increment's three clusters plus the
  preceding ledger-only cluster confirmed `pg_ctl status` exit3, no postmaster
  PID/bootstrap-password files and zero processes from the portable runtime.
  Stopped diagnostic directories remain in ignored `.cache`; no service was
  installed or running.
- The Workers/PostgreSQL skills preserve request-local state, short SQL phases
  and no gateway I/O under SQL locks. Current [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
  and [PostgreSQL16 transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html)
  were inspected; npm metadata retrieval was denied by socket permissions, so
  installed Workers types5.20260828.1 remained the fallback. No dependencies,
  configuration or frontend files changed in this increment; no new rendered
  browser acceptance is claimed.

### Integration gates

1. Guarded PG16 catalog/ACL installer, external SQL and embedded migration
   registration, schema export and candidate inventory audit: implemented locally
   in the follow-up below, **not applied to production**. Raw canonical DDL alone
   remains unsuitable as a deployment installer.
2. Bounded authenticated HTTP execution/receipt/abandonment endpoints, with the
   original idempotency key and immutable request preserved across retries:
   implemented locally in [the HTTP candidate](admin-refund-operation-http.md),
   not deployed or consumed by the Admin UI yet.
3. Versioned Admin browser intent/API integration and final browser tests.
   Existing v2 nonces were never transmitted, so legacy pending intents must
   not be treated as protected by a new server fence or automatically resent.
4. Real runtime-role grants, Redis logout/revocation semantics, Linux/workerd/CI,
   Hyperdrive/provider verification and coordinated migration/API/Admin release.

No production DB/R2/cache/image writes, stage, commit, push or deployment.
Original nine staged files preserved; full migration remains
**240 checked / 164 open / 404**.

## Guarded Admin refund receipt migration candidate (2026-09-15)

The durable receipt now has an explicit maintenance-owner installation path.
This is still **local candidate code, not an enabled HTTP/UI feature or a
production migration**. It supersedes the earlier unimplemented installer and
registration statements, not the open API, browser and rollout gates.

- External `0155_admin_refund_operation.sql` is byte-equal to the installer
  constant. Embedded step0161 calls the standalone root transaction, after the
  existing shipping receipt step0160. All earlier migration numbers remain
  unchanged:157 external files,162 embedded steps. Fresh ORM exports the same
  table. Candidate inventory is265 tables; the historical2026-09-04 production
  snapshot remains263 and is **not a new production measurement**.
- The PG16 installer requires public, read-write READ COMMITTED and a root
  database client. It preserves stricter timeouts and bounds statement/lock/
  idle-in-transaction limits to30s/1s/5s, rejects replication bypass and enabled
  DDL event hooks, and uses a dedicated nonwaiting transaction advisory lock.
  Existing compatible tables are locked NOWAIT and checked again. Missing
  tables are created and checked in the same transaction; unsafe inherited
  default privileges or index-name collisions roll the creation back.
- Catalog checks cover seven exact columns, four validated CHECKs, the primary
  key and two exact indexes including validity/readiness flags, plus owner,
  persistence, heap access method, RLS, partition/inheritance, triggers, rules,
  policies and incoming foreign keys. Non-owner direct relation/column ACLs may
  allow SELECT/INSERT only, never PUBLIC, grant options or mutable privileges.
  There is no silent repair, backfill, replacement, grant or startup hook.
- A real separate restricted LOGIN successfully appends and reads a receipt,
  while UPDATE, DELETE, TRUNCATE, ALTER TABLE and SET ROLE to the maintenance
  owner fail. RESET ROLE cannot recover maintenance authority. This is a local
  direct-ACL test, **not a complete effective-role-membership audit or proof of
  deployed runtime permissions**. Existing deployments must use the single
  guarded upgrade; never replay historical `MigrationService.runAll()` to add
  this table.

### Audit fixture correction

The first full nine-path audit failed in the existing old-sequence helper,
before the final cross-path gate. Its snapshot predated temporary namesake
fixtures, while `pg_shdepend` was deliberately captured database-wide. The new
local maintenance role is not the initdb bootstrap role, so PostgreSQL records
two temporary-object owner dependencies and three quoted-schema fixture owner
dependencies. This exposed a baseline defect that a pinned bootstrap owner
does not expose. See the [PostgreSQL16 shared-dependency catalog](https://www.postgresql.org/docs/16/catalog-pg-shdepend.html).

The helper now snapshots after fixture setup and before the migration, with
the same public search_path at both comparison points. A first correction
exposed a second comparison artifact: the namesake schema changed how
`pg_get_expr` printed a regclass default. The search_path is now changed only
after the baseline capture. **No dependency field, row, constraint, timeout or
drift assertion was removed or normalized away.** Full-database shared
dependencies are still compared exactly across the real operation, and outer
rollback is still compared to the original pre-fixture state.

The old-sequence path has1093 generated statements, versus1094 for fresh
aligned ORM, which additionally emits sequence ownership. A transient1094
old-path expectation failed1/11 after all SQL audit invariants passed; it was
corrected to the actual old-model contract. Failed runs are retained as failed
evidence, not counted as passing tests.

### Local execution boundary

The portable runner's default stays a fresh loopback PG16 cluster with
`finance_test NOSUPERUSER NOCREATEROLE`. An explicit `--schema-maintenance`
mode is restricted to named schema suites or the single `audit:orm` command;
only that fresh disposable cluster receives a maintenance superuser. The
runner rejects business suites in maintenance mode, production/remote test
URLs, arbitrary commands and mixed audit/test arguments before creating a
cluster. It does not upgrade an existing server or install a system service.

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin audit:orm
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/admin-refund-operation-service.test.ts test/admin-refund-operation-ledger.test.ts
```

The complete audit log remains in the uniquely owned private `.cache` cluster
directory with generated passwords redacted. The runner verifies that all
fixture databases and custom test roles are gone, then verifies the cluster
stopped even on failure. Stopped diagnostics are retained, not deleted.

### Executed regression evidence

Latest results per suite, **not one combined all-tests run**:

| Scope | Files | Passed | Skipped |
| --- | ---: | ---: | ---: |
| Admin receipt installer41 and shipping receipt installer37; real PG16 schema/ACL fixtures | 2 | 78 | 0 |
| Existing brokerage, coupon and three shipping migration suites | 5 | 158 | 0 |
| Corrected full old-sequence/root-runner native regression | 1 | 11 | 0 |
| Receipt executor and ledger on the default non-superuser local role | 2 | 39 | 0 |
| Runner command boundary, migration registration, inventory and table gate | 5 | 102 | 0 |
| Sequence contract plus actual network-denied CJS/ESM PGlite paths | 1 | 5 | 0 |
| Total, counting each suite's final result once | 16 | 393 | 0 |

The first six-suite native regression had158 passes and11 skipped because the
sequence suite's setup failed. Its next run had10 passes and1 count-assertion
failure. Neither run is relabeled as successful: the table uses the final11/11
sequence rerun and does not add repeated attempts. The earlier37-test installer
smoke is included in, not added to, the final78. Worker unit/runtime typechecks
and runner/helper syntax checks passed. PG-configured source assertions and
mock payment adapters are not native database or real-provider evidence.

The final **native PG16.15 nine-path catalog audit passed**. External SQL,
embedded migrations, fresh ORM and six old-ORM upgrade variants each contain
exactly265 tables,3715 columns,582 constraints,1024 indexes and227 sequences.
All compared fields in these five catalog categories match: no omissions,
additions, definition changes or rename allowances. The Admin receipt is
complete on each path **before** any standalone repeat; two repeat installs
preserve its table/index OIDs and storage files. Shipping protocol/index/receipt
checks and the existing upgrade drift, rollback and concurrent-sequence gates
also pass. This is not complete equivalence for all functions, triggers,
privileges or policies, and is not a production measurement.

The audit executed157 external files,162 embedded steps and1094 fresh ORM
statements. Its old-sequence path uses1093 initial statements plus one guarded
alignment. Do not infer external file count from the highest numeric prefix.
Input SHA256 values:

- External names and SQL: `cb53642f09cd40175f4e65e068aab610f197f956bf92765e7923744c76253911`
- Generated fresh ORM SQL: `edc58da8a0ebb2d7b0bc5efb00d9a3f24683d3f99221aa2f036f3497c79b4563`

The final log is retained under `.cache/finance-postgres-HDTqZo/catalog-audit.log`.
It reports cleanupConfirmed=true and zero fixture databases/roles remaining.
Independent inspection of all eight clusters used in this increment confirmed
`pg_ctl status` exit3, no postmaster PID/bootstrap-password files and zero
remaining processes from the downloaded runtime. The runner installed no system
service; stopped diagnostic clusters and their control databases are retained.

The Workers/PostgreSQL skills informed the explicit bounded transaction and
strict catalog/ACL refusal behavior; no dependency or platform configuration
change was needed. Production permissions, Hyperdrive/provider behavior,
Redis revocation, HTTP endpoints, versioned Admin intents, Linux/workerd/CI,
browser acceptance and coordinated release remain open. Existing browser v2
nonces were not sent to the server and must not be automatically resent as
if protected by this new ledger. User feedback confirms new images are readable;
this increment performs no further image/cache writes and no new browser test.

No production DB/R2/cache/image writes, stage, commit, push or deployment.
Original nine staged files remain preserved; checklist remains
**240 checked / 164 open / 404**.

## Remaining gates

- The durable Admin receipt service, guarded installer and HTTP adapter now
  exist locally. [HTTP evidence and protocol](admin-refund-operation-http.md)
  supersede the earlier missing-adapter statements. The v3 Admin intent/API/UI
  candidate now passes89 local tests and isolated desktop/mobile browser checks
  documented there. Joined local rendered Admin/real HTTP/native PG16 acceptance
  now also passes with canonical receipt constraints, actual balance/bill/stock
  checks and a late request blocked by its committed abandonment fence. The
  five-file104-test increment, two deliberate browser fault errors and cleanup
  are documented in that follow-up; real providers, production/runtime roles,
  legacy-client cutover and coordinated release remain open. A later local
  [seven-route retirement guard and rollout policy](admin-refund-legacy-retirement.md)
  now rejects unkeyed Admin POSTs, including three embedded/mobile entry points.
  It does not claim old in-flight requests are fenced, and proactive/split
  refunds still need a versioned replacement or explicit availability decision.
- The local detail lifecycle increment above does not establish actual Weixin/
  App hide/show behavior, all browser/provider paths or production acceptance.
  H5 resets old SKU/quantity choices on lifecycle refresh rather than silently
  reusing them; PC only restores selection explicitly carried by its route.
  Known successful ordinary/package writes now have same-page navigation
  recovery. Acknowledgement lookup after an unknown response or browser refresh,
  persistence across page teardown and server-side cart-write idempotency remain
  unimplemented; local recovery is not a substitute for those guarantees.
- Modern ordinary-cart display is now covered by the local follow-up above;
  raw nested legacy VIP fields, all other clients and full activity/promotion
  availability/presentation still require separate acceptance. Cross-refresh
  and unknown-result cart creation recovery remain open.
- Display policy/user/level/product/SKU reads are not one transaction snapshot;
  membership may expire/change before checkout. This quote is not price locking.
- The zero-discount policy question remains pending. Existing zero normalization
  and the one-cent checkout floor were not changed.
- Current-candidate production roles, Hyperdrive behavior, load/capacity,
  Linux/workerd, CI and rollout acceptance remain open. Known Windows workerd
  startup failure was not retried unchanged or treated as a passing runtime test.
- No commit, push, deployment or production data/cache mutation. The image rollback
  artifact's pending push permission remains respected.

Checklist remains **240 checked / 164 open / 404**. A3k13 and SUP-004 remain open.
