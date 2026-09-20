# Modern Admin order reads across physical refund generations

Local candidate, 2026-09-16. Not deployed; no production database, provider,
image or cache operations. This advances ADM-006 / FE-001 and the remaining
staff-read gate of the customer-order generation work, not the whole migration.

## Reproduced defects

The two assembled endpoints (`/adminapi/order/list`, `/api/admin/order/list`)
previously returned the retired payment root together with its current physical
children. A genuine local checkout followed by synthetic payment and actual
partial-refund finalization returned IDs `[1,2,3]` instead of the current `[2,3]`.
The same allocation's paid amount was thus represented twice in this flat list.
This is evidence about this list, not a production financial-report finding.

Both detail aliases separately read the header and carts under READ COMMITTED.
A separately authenticated refund writer committed between those reads: the
response retained the old `pid=0` header but returned carts with consumed split
status/surplus. Two failing native PostgreSQL tests preserved these observations;
the same tests passed after the adapter was installed.

## Contract and limits

- Both aliases retain the actual Admin JWT/password digest, account type/status
  and `order.view` middleware. Customer/Supplier tokens do not become Admins.
- The **modern flat fulfillment list** returns `pid>=0`, preserving existing
  `isDel=0` visibility and additionally requiring `isSystemDel=0`. It is not a
  payment aggregation or a new financial-report definition. List, exact `total`,
  header, carts and child navigation use one short REPEATABLE READ, READ ONLY
  transaction, capped at five seconds or the caller's shorter statement timeout.
- Defaults remain page 1 / limit 10, maximum page 10,000 / limit 100. Existing
  raw stored-status, paid, UID and exact order-number filters remain. Empty
  status/paid values mean no filter; invalid numbers and duplicate query keys
  reject instead of issuing unbounded or ambiguous SQL.
- An exact payment-root number resolves to its visible current children with the
  same UID, still subject to the other filters. A child number stays exact and
  never expands to siblings. Hidden roots do not open family lookup.
- Exact root detail remains addressable and returns additive `splitOrders`
  headers, not recursive unbounded cart collections. Child detail returns its
  own current carts; `pid=-1` source carts are not relabelled as live stock.
  Completed refund history continues to use its separate immutable archive.
- Cart ownership must match the header. Hidden/deleted children and children of
  another UID are excluded. Customer deletion visibility is unchanged for the
  modern list; this work does **not** invent a deleted-order administrative view.
- At most 200 carts / 200 child headers per detail. Overflow explicitly rejects,
  never silently truncates a successful response. JSON carts must be objects;
  legacy null/empty snapshots retain null. Each cart's two TEXT fields have a
  combined 64 KiB UTF-8 limit; an order's seven TEXT fields have a combined
  256 KiB limit. SQL guards stop oversized TEXT crossing the wire before the
  application rejects. List projection does not fetch virtual-card content.
- Permission/storage errors propagate; no empty-success fallback. All response
  paths retain no-store. No new migration, ACL installer, binding or dependency.

## PHP boundary

The source is available locally under `cinashop-php`. In
`app/common/controller/Order.php`, `lst` defaults to grouped payment roots
(`pid IN (0,-1)`) for some filters, and `split_order` reads their children.
`app/model/order/StoreOrder.php::searchPidAttr(0)` instead means `pid>=0`.
The existing TypeScript `order/list` is a flat operational table with direct
shipping actions, not that PHP grouped report. This increment makes that modern
flat view coherent; it does not claim full PHP `lst`, report, export or chart
parity. Those remaining staff/report readers need independent contract work.

## Test boundary

Tests use all 165 registered schema steps / 270 tables from the existing isolated
PG16 fixture, actual checkout, refund application/materialization/finalizer SQL,
and real `createApp()` requests. Only database-binding construction is redirected
to the owned local fixture. Synthetic payment establishes the paid state; there
is no external payment request. APP_KEY and JWTs are synthetic and ephemeral.
`NODE_ENV=test` without Redis does **not** verify production token-bucket revocation.
These are actual Hono Request/Response tests, not browser or listening HTTP-server
acceptance. Global fetch is forbidden.

Concurrency barriers execute the actual SELECT and then permit an independent
connection's real refund finalizer to commit. Results are compared against the
whole pre-split response; the next request must see the committed generation.
This is not a mocked order/refund response. The maintenance fixture owns setup,
while business execution uses independent non-owner LOGINs. One workflow grants
only SELECT on the exact order and authentication tables and checks the absence
of UPDATE, ownership, superuser, role creation, database creation and BYPASSRLS.

## Remaining gates

The Admin frontend consumes the exact count and child headers. The original
intercepted frontend verification below is distinct from the subsequent joined
browser → actual HTTP/auth → PostgreSQL regression recorded at the end.
Other staff/mobile/Supplier/Kefu/Out/report/export readers, full PHP grouped-list
parity, native devices, Redis, genuine roles/provider/Hyperdrive/workerd,
immutable Linux CI and coordinated release remain open. No parent checklist
item is closed solely on this service increment.

## Retained run history

- An initial sandboxed `pg_ctl` invocation failed to start the fresh cluster;
  no SQL assertions ran. The owned runner reported stopped. The approved local
  execution path subsequently started independent fresh clusters successfully.
- Red reproduction: 2 / 2 failed on duplicate root membership and mixed detail
  generations. After the adapter, the unchanged two scenarios passed.
- First typecheck found an overly narrow column-name generic in the bounded
  TEXT helper plus unused imports. The helper now accepts Drizzle's SQLWrapper
  interface without casts; unused imports were removed/used by expanded tests.
- First expanded native run: 43 passed / 1 failed across 3 files, 218.26 seconds.
  The failure was a malformed missing-token fixture: `Bearer ` was sent, which
  correctly failed JWT parsing rather than taking the absent-header branch.
  The fixture now omits the header; the original expected rejection code is
  unchanged. Two further combined-TEXT bounds were then added.
- Local runner and Admin contract regression: 3 files / 38 tests passed,
  final rerun 5.26 seconds, no failures/skips. These are not another browser acceptance.

Final native PostgreSQL **16.15** verification: **3 files / 46 tests passed**,
zero failures/skips, **215.13 seconds**. This consists of 19 new Admin scenarios,
12 existing customer-generation scenarios and 15 existing staff-refund-history
scenarios; the earlier reproduction/partial runs are not added again. Both Worker
unit and runtime TypeScript configurations passed. Script syntax and touched-file
whitespace checks passed. No browser run was performed in this increment.

Every successful test-host startup reported zero remaining fixture databases /
roles and stopped. Independent `pg_ctl status` returned 3 for the four approved
clusters below, with no PID/bootstrap-password files or port listeners. The
trusted test PostgreSQL executable had zero remaining processes. The initial
sandbox-owned failed-start directory was unreadable from the elevated context;
the original sandbox context separately returned `pg_ctl: no server running`.
Its chosen port also had no listener. No ACL change or unrelated service action
was used to inspect or clean it. Stopped diagnostic directories remain retained.

| Cluster under ignored `.cache` | Port | Run |
| --- | --- | --- |
| `finance-postgres-wvkTSH` | 57994 | Initial start failure, no SQL test run |
| `finance-postgres-0LFw5B` | 61071 | Two red reproduction tests |
| `finance-postgres-dxKVhc` | 56119 | Two original tests green |
| `finance-postgres-8U42Ib` | 61474 | Expanded 43 pass / 1 fixture failure |
| `finance-postgres-4rcuIp` | 60890 | Final 46 native tests passed |

The exact original nine staged paths were preserved. Checklist totals remain
**240 checked / 164 open / 404 total**. No staging, commit, push or deployment.

## Reproduction

From `workers-ts`, using the trusted existing local PostgreSQL16 runtime:

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/admin-order-generations.test.ts test/customer-order-generations.test.ts test/staff-refund-history.test.ts
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts test/admin-frontend-api-contract.test.ts test/admin-mobile-order-read-migration.test.ts --maxWorkers=2
npm run typecheck
```

Workers and PostgreSQL skills guided bounded SQL projections, short snapshots
and separate read/maintenance authority. Current official references were read:
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL 16 transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).
The npm latest-type lookup was denied by network permissions; the documented
fallback uses installed Workers types **5.20260828.1**. No upgrade was attempted.

## Admin page integration and browser QA (2026-09-16, local)

The list now uses the server's exact `total`, including full, last and empty
beyond-last pages. Searching a payment number shows current children; the
separate **查看此单详情** action opens the exact historical root. Root detail labels
the original payment/cart snapshot as history, warns against counting it again
with child amounts, and links to each current visible child. Refund/cancelled,
pickup and partial-fulfillment labels no longer all collapse to “待发货”. Modern
`sku.suk` and checkout unit prices are projected alongside old product snapshots;
an absent price renders as unknown, not a fabricated zero.

`orderRead.ts` validates response identity, pagination, list size, unique rows,
cart ownership and child root/UID membership before the UI retains any data.
`orderRequest.ts` captures credentials synchronously and binds requests to a
sticky session scope, including A → B → A and late authentication failures.
The list/detail clear stale content on reads, errors, route changes, unmount or
session invalidation. Detail watches reused route parameters. Current permissions
control fulfillment/printing/refund entries; server authorization is unchanged.
Writeoff confirmation freezes the reviewed code/items and is invalidated by
route, refresh, changed code/quantity, dialog close, session or unmount. Queued
responses cannot enable a new page's actions. Aborting HTTP does **not** undo
an already admitted server write; no durable receipt/retry protocol for printing,
delivery or waybill creation is claimed by this page-lifecycle increment.

### Verified evidence

- Final regression: **5 files / 117 tests passed**, zero failures/skips,
  **52.24 seconds**. New actual-SFC/Vue/router/axios lifecycle tests: **41**;
  existing refund SFC/API: **60**; Admin API contract: **5**; fulfillment identity:
  **5**; mobile Admin read contract: **6**. Earlier 37-test run is not added again.
- Admin `vue-tsc -b` and Vite production build passed. Two existing VueUse
  PURE-annotation warnings were emitted by Rollup; no new dependency was installed.
  Worker unit and `tsconfig.runtime-test.json` typechecks passed. An initial
  runtime command mistakenly named nonexistent `tsconfig.runtime.json` (TS5058);
  the package script was inspected and the actual runtime configuration rerun.
- Browser skill classification: **Browser plugin not available** in this session's
  exposed skills; the frontend-testing-debugging skill selected installed
  Playwright **1.62.1** / Chrome **153.0.8010.36**. Real Vue + Element Plus + router
  ran at `http://127.0.0.1:5173`; API responses were synthetic intercepted fixtures,
  not actual authentication/SQL. Dev configuration explicitly disabled proxies.
- Desktop **1440×1000** and mobile **390×844** both passed: page identity/title,
  meaningful content, no overlay, no console warnings/errors or page errors,
  no document overflow, and actual interactions. Each performed 16 allowed GETs
  and zero business writes/external requests. Screenshots were visually inspected.
- Flow: page 1 → page 3 (one row, total still 21) → search root (two rows, total 2)
  → exact root → refunded child → back → injected read error → explicit refresh
  → delayed child response after returning to root → sticky session invalidation.
- The first rendered test **failed**: clearing total while loading caused Element
  Plus to emit page 1 immediately after page 3. The fix hides the pager during
  loading/errors and retains its last count while loading. The same browser flow
  then passed three times; the unit test also now asserts count retention. A preliminary
  Windows ESM path error in the temporary driver was fixed with `pathToFileURL`;
  no app/backend assertion was weakened.

Temporary driver, JSON results, original pagination failure and screenshots are
outside the repository, under:
`C:/Users/cina/AppData/Local/Temp/cinashop-admin-order-6f8f4a1f28ab4a2e8c5b186183067bfe`.
These are local diagnostic artifacts, not a new committed e2e workflow. The
driver closed Chrome/Vite; a separate approved read-only process/port check found
zero matching driver processes and zero listeners on 5173 (the sandbox CIM check
was denied, not treated as zero). No database server was started by this increment.

```powershell
# From workers-ts
node node_modules/vitest/vitest.mjs run test/admin-order-frontend.test.ts test/admin-refund-frontend.test.ts test/admin-frontend-api-contract.test.ts test/store-fulfillment-identity-migration.test.ts test/admin-mobile-order-read-migration.test.ts --maxWorkers=2
# From view/admin-ts
node node_modules/vue-tsc/bin/vue-tsc.js -b
node node_modules/vite/bin/vite.js build --logLevel warn
node C:/Users/cina/AppData/Local/Temp/cinashop-admin-order-6f8f4a1f28ab4a2e8c5b186183067bfe/browser.mjs
```

At this earlier stage, joined browser/backend/SQL acceptance remained open; it is
now covered by the next increment. Still open: real mutation/provider and
permission scenarios, other readers/grouped PHP reports/exports, production
Hyperdrive/roles, CI and coordinated deployment. This does not close ADM-006 or
FE-001 as a whole. No production data/image/cache changes, staging, commit, push
or deployment; original nine staged paths and 240/164/404 checklist totals remain.

## Joined Admin browser regression (2026-09-16)

This opt-in workflow serves the **actual built Admin** through a local HTTP
listener and the assembled Hono app. Only DB-binding construction is replaced.
Both Admin route aliases use real JWT signatures, stored password digests,
account types/statuses, role resolution, controllers and PostgreSQL **16.15**.
Stored frontend session metadata and signed fixture JWTs bootstrap the session;
the login form's credential submission is not exercised. Login branding alone
is a shell fixture. Order, authorization, permission and pending-count responses
are not synthesized. Browser environment allowlisting excludes database URLs,
APP_KEY and host/provider credentials.

The SQL reader is an independently authenticated LOGIN, distinct from the
checkout/refund writer: no superuser, CREATEDB, CREATEROLE, BYPASSRLS, table
ownership or order UPDATE permission. Explicit SELECT grants cover the order
and authentication tables plus the tables referenced by the real pending-count
query. Maintenance creates only the owned isolated database/roles; it is not the
application connection. The PostgreSQL skill guided this separation and short
read transactions; no production privilege installer was altered.

### Scenarios and corrections

- Actual checkout, synthetic payment activation and two real refund
  finalizations create the generations. Nineteen clearly marked unpaid,
  list-only fixture rows exercise real total/offset SQL: 21 rows, then page 3
  containing one row. Exact root search initially returns its two children.
- The root retains 55.00 and original carts. First refunded child is 12.80;
  remainder is 42.20. While an old successful remainder response is held,
  another refund is finalized by the writer. The root then has three children;
  the same remaining order ID now has one cart and **29.40**. Returning to that
  ID and releasing the old response must not restore 42.20 or the old cart.
- Nine SQL checkpoints per viewport verify no business-row effects from reads
  or denied writes, both refund generations and terminal refund replay. Real
  role revocation and cart-table SELECT revocation produce visible errors with
  old detail removed; restoring each permits explicit refresh. Changing the
  stored password digest expires the old token and redirects to login.
- Both aliases reject missing/invalid JWT, unprivileged Admin, Supplier and
  customer tokens. Two explicit writeoff requests per viewport are rejected by
  `order.manage` admission; no browser-originated business write succeeds.
- Real snapshots exposed **two UI defects**: `userAddress` already includes the
  province, so prefixing `province` duplicated it; and `payIntegral` is integral-
  product payment, not ordinary points deducted. Detail now uses the full address
  and separately renders `deductionPrice`, `useIntegral`, and `payIntegral`.
  Root shows 1.00 / 100 points; current remainder 0.60 / 60 points. Missing
  deduction fields reject instead of inventing zero. Financial SQL was unchanged.

### Results, retained failures and limits

Final joined run: **2 viewport scenarios passed**, zero failures/skips,
**36.20 seconds**. Desktop **1440×1000**, mobile **390×844**, installed Playwright
**1.62.1**, Chrome **153.0.8010.36**. Browser classification remains **Browser plugin
not available** in the exposed skills, so frontend-testing-debugging selected
the existing Playwright workflow; no dependency installation. URL/title, nonblank
screen, absence of overlays, interactions and geometry passed. Screenshots of
root, current remainder and SQL denial were visually inspected. Both runs had
zero console errors/warnings, page exceptions or external requests, and exactly
one expected ERR_ABORTED for the deliberately obsolete remainder request.

Final unit/runtime regression: **3 files / 80 tests passed**, zero failures/skips,
**15.46 seconds** (44 actual Admin SFC/API tests, 31 runner boundaries, 5 API
contracts). Admin typecheck/build and both Worker TypeScript configurations
passed; driver/runner syntax and changed-file whitespace checks passed. Two
existing VueUse PURE-annotation build warnings remain. Earlier 31-, 77-test and
intermediate browser runs are not added again.

The first joined run failed both cases at the second-refund checkpoint: its
new test expectation incorrectly used the remaining item's 30.00 gross price,
ignoring the already documented 0.60 point deduction. Existing financial contract
and actual SQL both give 29.40; the exact assertion was corrected, with added
12.80 child / unchanged 55.00 root assertions. No business expectation was
weakened into an inequality. An initial typecheck rejected an Object.fromEntries
environment because ambient ProcessEnv requires fields; the driver now uses the
existing copy-then-delete whitelist pattern without unsafe type assertions.
Subsequent 36.23- and 36.10-second joined runs passed; the final run additionally
checks the corrected point display. The initial failure screenshots remain.

Browser output is outside the repo at
`C:/Users/cina/AppData/Local/Temp/cinashop-admin-order-sql-6e324ce8c5bc42df9d1efbb75321a1ab`.
Final listeners were `127.0.0.1:54490` (desktop) and `127.0.0.1:51066` (mobile).
All owned fixture databases/roles were removed and the four clusters stopped.
Independent checks returned pg_ctl status 3 for every cluster, no PID/bootstrap
password files, no listeners on any test PG/HTTP port, and zero trusted test PG
or driver processes. Stopped diagnostic directories were retained:

| Owned cluster in `.cache` | PG port | Run |
| --- | --- | --- |
| `finance-postgres-9dGgYB` | 58744 | Initial incorrect gross-price expectation |
| `finance-postgres-IxtDKk` | 61111 | Corrected price and full-address check |
| `finance-postgres-eXQ6NI` | 58074 | Exact console/network assertions |
| `finance-postgres-ofnvbo` | 49931 | Final point-display assertions |

Reproduce using existing dependencies, an **existing absolute output directory
outside the checkout**, and the trusted local PG16 binary directory:

```powershell
# Build the current Admin first, from view/admin-ts:
node node_modules/vue-tsc/bin/vue-tsc.js -b
node node_modules/vite/bin/vite.js build --logLevel warn
# From workers-ts; paths below are examples from the verified host:
$env:TEST_BROWSER_PACKAGE_JSON = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'
$env:TEST_BROWSER_EXECUTABLE = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:TEST_BROWSER_OUTPUT_DIR = 'C:/Users/cina/AppData/Local/Temp/cinashop-admin-order-sql-6e324ce8c5bc42df9d1efbb75321a1ab'
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin audit:admin-order-browser
node node_modules/vitest/vitest.mjs run test/admin-order-frontend.test.ts test/local-finance-postgres-runner.test.ts test/admin-frontend-api-contract.test.ts --maxWorkers=2
```

This is **local joined read acceptance**, not production Hyperdrive/workerd,
Redis, real payment/provider, administrator write-workflow, login-form or native
device acceptance. Other readers, PHP grouped reports/exports, durable write
recovery, CI and coordinated release still need their own gates. No production
data/image/cache operation or staging/commit/push/deployment. The exact original
nine staged paths and **240 checked / 164 open / 404 total** remain unchanged.
