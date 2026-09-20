# Supplier operational reads and refund-to-shipment audit

Local candidate, 2026-09-19; not deployed. This increment covers the existing
Supplier `distribution_info`, `split_cart_info/:id`, and `status/:id` routes,
plus their connection to actual whole/split shipment after a partial refund.
It does **not** complete SUP-001 or the full PHP order contract. The user has
already confirmed the new product images are readable; no image/cache work
was repeated.

## Reproduced defects and implementation

The native PostgreSQL 16.15 fixture runs the complete 165 migrations / 270
tables, real checkout/allocation/refund services, Hono routes, JWT/password/
role middleware, and independent authenticated database sessions. Only the
request container selects the owned fixture; external fetch is prohibited.

The original seven cases failed for real behavior, not substituted SQL:

- After a partial refund, the completed-refund child still has `status=0`.
  The old cart reader counted it as pending and rejected a legitimate remainder.
- A second session could commit a refund between reading order headers and
  carts, producing a pre-refund header with post-refund items in picking/cart
  responses. A status read could also include a log committed after an
  ownership change.
- Wrong-customer cart rows were returned. Damaged picking JSON was silently
  turned into a printable fallback.

The read fixes initially passed all seven. Adding an actual root shipment then
reproduced the same ambiguous-pending-child defect in the **write** resolver.
After that fix, the 60-test joint read/runtime run passed. A stronger direct-ID
test subsequently proved a separate defect: the cart reader rejected a
wrong-store child, but `deliver` committed a shipment for that child. Its red
run was 17 passed / 1 failed, with an actual successful shipment result where
rejection was required. The final candidate fixes both write entry points via
their shared resolver, without changing financial allocation policies.

### Reads

`SupplierService.pickingSheets` delegates to `SupplierPickingSheetReadService`;
the cart and status methods delegate to `SupplierOperationalReadService`.
`SupplierReadSupport` supplies bounded cart projection and the common snapshot.

- Every request's headers, items, supplier profile or logs come from one
  `REPEATABLE READ, READ ONLY` transaction. Its transaction-local statement
  timeout is at most five seconds and never relaxes a stricter session limit.
  Settings are restored after success and SQL failure.
- IDs must be positive safe PostgreSQL int32 values. Picking accepts 1–10
  distinct IDs and preserves requested order; any foreign/missing ID rejects
  the entire batch. Textual controller normalization is not redesigned here.
- Active cart selection excludes completed-refund children, but retains
  in-progress/unknown refunds so they fail explicitly. Candidates match
  supplier, customer, store and visibility. More than one actual pending child
  still fails. No active child returns an empty list; an explicitly requested
  completed-refund child is not silently treated as deliverable.
- Paid/state/quantity checks and an actual open-refund query protect cart
  availability, including when the summary refund flag is incorrectly clear.
  Viewing availability neither locks nor reserves a shipment.
- Child access validates the root customer and, for supplier-owned roots,
  store. Completed platform-owned allocation roots are reachable only via an
  owned child, never by directly requesting the platform root.
- Cart ownership is validated before filtering/projecting any returned row.
  All-zero legacy metadata is allowed per order; mixed or foreign metadata is
  rejected. Modern and legacy snapshot/display field names remain supported.
- SQL returns at most 201 cart rows; more than **200 across the whole response**
  fails instead of silently truncating. Snapshot bytes are checked in SQL
  before transport: 64 KiB for active carts, the existing 256 KiB for picking,
  and 8 MiB aggregate. Over-budget JSON is replaced with NULL plus an error flag
  in SQL, not downloaded and discarded afterward. Promotion/private order TEXT
  is not read. Nonempty snapshots must be JSON objects.
- Picking uses integer cents for unit price, quantity subtotals and VIP
  discounts, including legacy snapshot quantities when row quantity is zero.
  Settlement cost is not a fallback retail price. Missing/invalid/negative/
  overprecision prices and boolean quantities fail rather than print misleading
  money. The existing bounded plain-text presentation is retained.
- Status DTO fields remain unchanged, sorted by time then ID descending.
  Exactly 500 rows is accepted; 501 rejects. Customer-deleted staff history
  remains visible; system-deleted orders do not.

Picking is explicit-ID print/history preview, **not** shipping authorization.
The sibling PHP `SupplierOrderServices::getDistribution` uses customer
`sum_price` and BCMath and additionally exposes fields such as `bar_code`,
`code`, and `trade_no`; this increment does not claim the complete old DTO.

### Writes

`resolveLockedOrder` retains settlement-root-first locking and existing
authorization, replay, waybill, refund, invoice and ledger checks.

- Root-driven pending selection now matches customer/store and excludes
  completed refunds. Actual duplicate candidates still reject.
- Direct child references include store ID. Supplier-owned roots must match
  that store, and the requested child is reselected with its original store
  after the root lock. Store changes between reference selection and locked
  revalidation fail for both whole and split delivery.
- The completed platform-allocation exception remains for explicitly scoped
  children, even when their store differs from the platform payment root.
  Incomplete allocation and direct supplier access to that root still fail.

Actual partial refund → whole shipment and partial refund → split shipment →
whole remainder paths are covered. Synthetic totals remain 55.00 across the
family; the 12.80 / 42.20 and subsequent 12.80 / 29.40 partitions are checked.
Whole shipment does not change refund, invoice, user, inventory or ledger rows.
These are real local service transactions with synthetic payment admission,
not payment-provider or production acceptance.

## Test-driver defect, not a production workaround

An expanded ten-file regression initially had 78 failures, 99 passes and nine
native-only skips. A focused rerun reproduced `rows.map is not a function` in
`OrderCartIdentity` and direct raw-result indexing failures in tests. The
fixture cast a PGlite database to the application's postgres.js contract, but
PGlite raw execution returns an object containing `rows`, not a row array.

`financePostgres` now adapts raw execute results on its **memory-only** branch
and recursively on its transactions/savepoints. It derives rows and counts
from actual SQL results, preserves parameters/options/errors, and does not
alter mapped query builders. No application query, production driver, money
assertion or sequence allocator was weakened. The test boundary still does
not emulate the complete postgres.js protocol or concurrency semantics.

Four new contract tests exercise raw parameters/counts, mapped builders, real
sequence reservation, rejection outside a transaction, outer/nested rollback,
and SQL-error propagation. The focused previously failing financial test and
all four new tests passed. The expanded memory regression then passed **11
files / 181 tests**, with nine native-only skips, in **161.75 seconds**.
Those nine cases are not counted as local-memory passes: the original three
financial suites passed all **114 tests** on native PG16 in **95.16 seconds**
before the final store-scope refinement, including the concurrency cases.

## Verification record

Final candidate verification completed. Commands use the already trusted Node and PostgreSQL16 binaries from
`workers-ts`, not a production URL or an installed system database service:

```text
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-operational-reads.test.ts test/supplier-split-order-reads.test.ts test/supplier-order-generations.test.ts test/refund-runtime-permissions.test.ts
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/finance-fixture-results.test.ts test/split-order-line-finance.test.ts test/split-invoice-allocation.test.ts test/supplier-split-ledger.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

The final joint read/runtime run passed **4 files / 63 tests** (21 operational,
10 split-history, 22 Supplier list/detail, 10 runtime-permission), zero failures
or skips, in **329.03 seconds**. The final native finance/driver run passed
**4 files / 118 tests**, zero failures/skips, in **131.71 seconds**. These are
separate suites, not duplicate retries added together. The final seven-file
static/unit regression passed **72 tests** in **22.76 seconds**.

Both TypeScript configurations passed. The first main typecheck hit Node's
default approximately 2 GiB heap limit (not a TypeScript diagnostic); the
subsequent complete check passed with the previously used 4 GiB allowance.
Runner syntax and scoped whitespace checks passed. The earlier 181-test memory
run preceded the final store-scope refinement; the final 118-test native run
retested those affected financial suites on the resulting candidate.

The operational suite includes exact/overflow row and byte boundaries,
independent concurrent commits, actual authentication failures and scoped
responses, and separate SELECT-only LOGINs. These reader roles own no tables
and have no UPDATE, superuser, CREATEDB, CREATEROLE or BYPASSRLS authority.
Revoking data SELECT raises PostgreSQL 42501 rather than empty success.

Earlier owned cluster evidence (directories retained under `.cache/`):

| Cluster | Port | Evidence |
| --- | --- | --- |
| `finance-postgres-Y1hIQu` | 61984 | Original seven red cases |
| `finance-postgres-kphdcf` | 53069 | Seven read cases green |
| `finance-postgres-LsksQC` | 52078 | Seven green / root-write case red |
| `finance-postgres-jtIWrw` | 60044 | Output handle lost; no pass claim; stopped independently |
| `finance-postgres-gNro37` | 60120 | Joint 60 passed, 337.45 s; runner fixture cleanup/stopped |
| `finance-postgres-HDO4Oj` | 64301 | Native financial 114 passed; runner cleanup/stopped |
| `finance-postgres-w6nV4l` | 58651 | Direct wrong-store shipment red; runner cleanup/stopped |
| `finance-postgres-ftLlTu` | 58747 | Final joint 63 passed; runner cleanup/stopped |
| `finance-postgres-vSm08H` | 58755 | Final finance/driver 118 passed; runner cleanup/stopped |

All nine clusters were independently confirmed stopped under the owning
Windows account (`pg_ctl status` exit 3), without PID/password files. The final
check found zero listeners on the nine ports and zero processes using the
trusted test PostgreSQL binary. Each recovered runner also reported zero
remaining fixture databases/roles. A missing test-output handle is not evidence of test success. The
lost run's diagnostic log confirms shutdown but not its business assertions or
fixture-role cleanup, so it is not part of the passing counts.

## Remaining gates and sources

Supplier page/session lifecycle remains open: `Orders.vue` assigns the result
of a multi-request detail load without a request-generation guard;
`PickingSheets.vue` currently loads only on mount and does not clear old data
on reload failure. This backend increment does not resolve or browser-test
those paths. Full PHP fields, reports/exports, the broader 30-route order gap,
real roles, Redis/provider/Hyperdrive, workerd/Linux CI and coordinated release
remain open. No production data, DDL, ACL, bindings, deployment or image/cache
operation occurred; no staging, commit or push was performed. The original
nine staged paths are preserved.

Workers/PostgreSQL skills guided bounded transport, consistent short read
transactions, and separate least-privilege verification. Current official
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
were retrieved on 2026-09-19; Firecrawl CLI was unavailable, so the existing web
tool was used. Latest npm type retrieval failed; the installed Workers types
**5.20260828.1** and actual Hyperdrive declaration/config schema were inspected.
See also [PostgreSQL 16 transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).
No binding or compatibility configuration was changed.
