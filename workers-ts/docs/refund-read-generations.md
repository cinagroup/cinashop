# Refund history across physical order generations

2026-09-16, local candidate. Customer history is extended below to Admin and
Supplier details. This is not activation of public materialization v2 or
acceptance of all order readers. No production connection, production-data
change, deployment or image/cache rerun. The user's confirmation that the new
product image can be read remains accepted; local refund UI QA is separate.

## Reproduced defects

The real checkout/application/finalizer scenario exposed two failures in the
previous customer detail reader:

1. A second partial refund consumes its original cart row in a retained-ID
   remainder. Reading that completed refund failed to find its product.
2. The first completed refund was rendered from mutable source carts, so later
   changes to those carts replaced the historical product name.

Both tests failed before the initial fix and passed afterward. The expanded
18-case suite then found four further failures: shared selected/remainder target
rows, a mismatched unselected quantity, a split relabelled as a whole refund, and
invalid nested cart JSON aborting the SQL transaction. These assertions were
retained while the validation and guarded JSON parsing were corrected.

## Read contract

`CustomerRefundReadService.detail` authorizes the original refund against its
original order and customer before consulting history. All detail queries use
one `REPEATABLE READ, READ ONLY` transaction. The statement timeout is capped
at five seconds without relaxing a stricter existing value, and is local to the
transaction. No external request, row lock or business write is introduced.

For a completed, non-cancelled materialization-v2 application,
`RefundReadSnapshot` projects the protected `store_order_refund_split` receipt.
It matches the application fingerprint, customer, supplier/store, source order,
completed amount, reservation, payment parent, source cart identities and
partition quantities. It validates target uniqueness and the different mapping
rules for whole refunds, first splits and retained-ID splits. Current remaining
carts and mutable current catalog data are not a history fallback.

- Existing `storeOrderId`, `orderId`, refund number and item source identities
  keep their application meaning. The original refund and payment are not
  repointed to the newly materialized child.
- A nullable `physicalOrderId` separately identifies the receipt's selected
  order. Existing PC/UniApp parsing accepts the additive response field; no new
  navigation or frontend workflow is claimed here.
- Invalid or absent receipt data produces empty items, null physical order and
  a bounded `itemsError`, preserving the readable refund summary.
- A missing relation or SELECT permission remains a database failure, not a
  silent downgrade to live carts. Legacy and nonterminal reads do not require
  the candidate evidence relation.
- Soft-deleted refunds and foreign customers remain hidden before archive access.
- Customer list links continue to refer to the application source order. This
  change does not redefine general order-list, statistics or deletion semantics.

## Bounded projection and privacy

The receipt is located by its refund primary key. Its archive (maximum 16 MiB)
is parsed inside PostgreSQL, not transferred wholesale to the Worker. The query
returns only compact identities/partitions and selected public product scalars:

| Data crossing the database boundary | Limit |
| --- | --- |
| Selected public items | 100 items, 512 KiB aggregate |
| Source cart identity projection | 200 rows, 64 KiB aggregate |
| Partition mappings | 128 KiB |
| Selected nested cart JSON parsed in PostgreSQL | 64 KiB each |
| Public name/SKU/image scalar | 4 KiB UTF-8 each |

PostgreSQL 16 `pg_input_is_valid` guards malformed nested JSON before casting.
No address, trade number, payment-provider payload, supplier ledger, private
archive padding or financial cart snapshot is included in the customer DTO.
The larger archive bound is not a permission to return it to an HTTP client.

The fingerprint authenticates application identity, not a cryptographic hash of
every archived product field. Protection against ordinary runtime mutation comes
from the existing separately commissioned append-only evidence protocol. This
reader does not claim protection against a maintenance owner rewriting an entire
self-consistent archive, and does not re-audit all financial archive fields.

## Verification scope

`test/refund-read-generations.test.ts` uses the full registered schema (165 steps,
270 tables) and real independently authenticated non-owner runtime accounts from
`refundRuntimeFixture`. Actual checkout, supplier allocation, refund finalization
and fulfillment services produce the historical records. Paid state remains a
synthetic fixture: these tests do not call a real payment provider.

Coverage includes three successive refunds, later source-name mutation, whole
refunds following fulfillment forks, list identity and PC/UniApp DTO parsing,
ten explicit evidence faults, bounded public projection, foreign/deleted rows,
revoked SELECT, absent relation and pending/legacy compatibility. A two-LOGIN
interleaving completes the second refund between detail queries: the in-flight
reader sees the original pending state and original cart together; a subsequent
request sees the completed receipt. The test spy schedules that real competing
transaction but does not replace business queries or their return values.

Each successful/error read is checked against synthetic business/evidence state
where applicable. External `fetch` is forbidden. The concurrency test also checks
transaction isolation, read-only mode, timeout restoration and a stricter timeout.

Final native verification on PostgreSQL **16.15**, no failed or skipped tests:

- Historical reads plus existing independent-runtime permissions: **2 files /
  28 tests**, 155.22 seconds.
- Existing customer read/application/return, Admin/supplier evidence and atomic
  materialization regression: **6 files / 146 tests**, 108.10 seconds.
- Runner admission/argument boundary: **18 tests**, 4.02 seconds. The new suite
  is explicitly allowlisted; maintenance mode is not enabled for arbitrary tests.
- Both unit and runtime TypeScript configurations passed.
- Default PGlite customer read/application/return compatibility: **3 files /
  44 tests**, 9.64 seconds, no skips. This overlaps the native customer regression
  and is not added to its count as independent functional coverage.

Current official Workers/PG16 references were retrieved. The npm latest-type
lookup was denied by the local network policy; the skill's documented fallback
used installed Workers types **5.20260828.1**, including its Hyperdrive interface.
No binding, dependency or Wrangler configuration was changed.

Run history is not cumulative independent coverage: the original two red tests
passed in the initial two-case green run; the subsequent 18-case red run had
14 passes and the four diagnosed failures above, before the final 28-test run.

All five native runners reported zero remaining fixture databases/roles and
stopped. Independent read-only verification confirmed `pg_ctl status` exit 3,
no PID/bootstrap-password file and no listener for every owned cluster:

| Cluster under ignored `.cache` | Port | Purpose |
| --- | --- | --- |
| `finance-postgres-WQNtgN` | 60108 | Original two-defect reproduction |
| `finance-postgres-OhjZs5` | 62649 | Initial two-case green run |
| `finance-postgres-ZiGN7Q` | 65386 | Expanded 18-case red run |
| `finance-postgres-rbNGgY` | 61054 | Final 28 history/permission tests |
| `finance-postgres-ugn37B` | 61805 | Final 146 existing regression tests |

No trusted test PostgreSQL process remains. Stopped diagnostic directories are
retained; no unrelated service or broad directory was removed. Existing nine
staged paths are preserved, and checklist totals remain **240 checked / 164 open
/ 404 total**. No staging, commit, push or deployment was performed.

## Admin and Supplier extension

Two real-database red tests first showed that both staff details returned only
the application reservation, without historical products. Both services now
reuse `readStaffRefundHistory`, which delegates to the same protected bounded
projector as the customer reader. The additive `refundHistory` contract contains
version, refund ID, original source order ID, physical selected order ID, public
items and an explicit error. Pending/legacy rows return null. Only a validation
failure becomes an empty history with an error; database failures propagate.

Original application, review and payment identities are unchanged. Authorization
precedes archive access. Supplier list and detail also require matching order
and refund store IDs, alongside existing supplier/customer/deletion checks.
Both details retain a single repeatable-read, read-only transaction and now cap
the statement timeout without relaxing a stricter session value.

This does **not** narrow the entire existing Supplier response: its legacy
`cartInfo`, whole current `orderInfo`, and provider fields remain. The privacy
and historical immutability claims apply to the new projection, not those
unchanged fields. No new action capability or refund execution path is added.

Admin `RefundList.vue` and Supplier `Refunds.vue` display the archived product
name, SKU, quantity and distinct source/physical order IDs. A shared parser binds
history to the outer refund identity, terminal status and quantity, enforces
bounds/unique item identities, and retains only the public whitelist. Names and
SKUs are plain text; the image scalar is not rendered. Invalid responses clear
the detail instead of leaving another record's history visible. Missing history
is compatible with older servers and produces no invented archive section.

Final extension verification, all tests passed with no skips:

- Native PG16.15: **33 tests / 2 files**, 165.66 seconds, comprising 15 new staff
  scenarios and the existing 18 customer history scenarios. Actual service
  finalization produces three successive archives; faults, tenant/store/owner
  visibility, deletion, permissions, legacy/pending compatibility and two
  independent-LOGIN completion/read interleavings are covered. The latter prove
  consistent state, read-only mode and preservation/restoration of a 3s timeout.
- Native existing Admin/Supplier evidence, customer read and atomic materialization
  regression: **125 tests / 4 files**, 85.14 seconds. These are service/database
  tests, not authenticated HTTP or real-provider tests.
- Shared history contract, existing Admin/Supplier frontend lifecycle and runner
  boundary: **116 tests / 4 files**, 52.56 seconds. The staff suite is explicitly
  admitted to schema-maintenance mode, without allowing arbitrary paths.
- Both Worker TypeScript configurations and both frontend production builds
  passed. Builds still report dependency annotation warnings; Supplier also
  reports a large-chunk advisory. No dependency/configuration change was needed.

Rendered QA used existing Playwright 1.62.1 and installed headless Chrome.
Browser availability classification: **Browser plugin not available** for the
skill's specific routing contract, because no `browser` skill was listed in this
session. This is not a claim that all browser/computer-use tools were absent.
The frontend testing skill's Playwright fallback was used without installing a
new dependency. Programmatic Vite used `configFile:false`, no environment files
or production proxy; isolated contexts used synthetic local credentials/data.
Every non-GET request and every external request was blocked by the test harness.

Both full apps ran sequentially at `http://127.0.0.1:5173/refund` and
`http://127.0.0.1:5173/refunds`, at **1440x1000** and **390x844**. Checks covered
URL/title, meaningful initial content, no framework overlay, zero console errors
or warnings, and screenshot inspection. Interactions opened a successful detail,
checked literal markup/name/SKU/quantity/IDs, switched to explicit evidence-error
and legacy records, rejected a cross-refund payload, refreshed to recover, then
reopened after page reload. Mobile archive sections fit their viewport without
horizontal overflow. Each app issued 12 synthetic GETs, zero writes and zero
external requests. Read-only roles were used; real permissions and write buttons
were not end-to-end validated by this browser run.

The initial harness incorrectly expected the Admin page label to be a heading;
the observed DOM showed it was text, and the harness was corrected to use the
existing recovery button. Screenshot capture was rerun with animations disabled
after an early frame caught a dialog transition. These were harness fixes, not
application failures. Final screenshots were visually inspected for both sizes.
The script and four screenshots stay outside the repository in the local temp
directory `cinashop-staff-history-137ce4c431ae43e5a9355199c0ef3984`.

All three extension runners reported zero remaining fixture databases/roles and
stopped. Independent `pg_ctl status` returned 3; no PID/bootstrap-password file,
listener or trusted test PostgreSQL process remained:

| Cluster under ignored `.cache` | Port | Purpose |
| --- | --- | --- |
| `finance-postgres-8bGwW0` | 58319 | Two staff-history red tests |
| `finance-postgres-m19bF7` | 56565 | Final 33 history tests |
| `finance-postgres-2HAf8R` | 61598 | Final 125 regression tests |

Browser contexts, Chrome and local Vite servers were closed in `finally`.
Workers/PostgreSQL skills guided reuse of bounded projections and short consistent
reads; the frontend testing skill required the rendered interaction/visual loop.
No staging, commit, push, deployment or production write was performed. The
original nine staged files and checklist **240 checked / 164 open / 404 total**
remain unchanged; this increment does not close the broader parent gate.

## Remaining gates

Customer order list/detail/counter integration now has a separate local increment
in [customer order generations](customer-order-generations.md), extended to
[customer backend deletion](customer-order-deletion.md). PC/UniApp list deletion
controls are implemented and have passed local joined browser-to-HTTP-to-PostgreSQL
acceptance. Modern Admin order list/detail now have a separate local increment
in [Admin order generations](admin-order-generations.md). Native-device acceptance,
the Admin rendered consumer, other staff/report/export integration across generations, unsupported
business contracts, full application production permissions, public-v2 activation,
genuine authentication, provider, Hyperdrive/workerd and production-browser
verification, immutable CI and coordinated deployment remain open. Admin/Supplier
history projection and isolated rendered checks now have local proof only.
These native PG16 and synthetic-browser results are not Cloudflare production
acceptance.

Workers and PostgreSQL skills guided the bounded public projection, short
read-only transaction and explicit separation of native versus platform proof.
References: [PostgreSQL repeatable read](https://www.postgresql.org/docs/16/transaction-iso.html),
[input validation](https://www.postgresql.org/docs/16/functions-info.html#FUNCTIONS-INFO-VALIDITY),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Reproduction

From `workers-ts`, with the trusted local PG16 runtime:

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-read-generations.test.ts test/refund-runtime-permissions.test.ts
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/customer-refund-read.test.ts test/customer-refund-return.test.ts test/customer-refund-application.test.ts test/admin-refund-evidence.test.ts test/supplier-refund-evidence.test.ts test/refund-atomic-materialization.test.ts
node node_modules/vitest/vitest.mjs run test/local-finance-postgres-runner.test.ts --maxWorkers=1
npm run typecheck
```

Staff extension commands, from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/staff-refund-history.test.ts test/refund-read-generations.test.ts
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/admin-refund-evidence.test.ts test/supplier-refund-evidence.test.ts test/customer-refund-read.test.ts test/refund-atomic-materialization.test.ts
node node_modules/vitest/vitest.mjs run test/staff-refund-history-contract.test.ts test/admin-refund-frontend.test.ts test/supplier-refund-frontend.test.ts test/local-finance-postgres-runner.test.ts --maxWorkers=2
```

Both frontend roots also ran `npm run build`. The temporary browser driver was
executed with the bundled Node runtime; no new repository test configuration or
standalone HTML report was created.
