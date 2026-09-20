# Customer orders across refund generations

2026-09-16, local candidate only. This increment covers modern customer order
lists/details, the legacy PC list envelope and customer order counters. It does
not activate public materialization v2 or complete all order/reporting gates.
The user's confirmation that the new product image is readable remains accepted;
no production image/cache work or production connection was repeated.

## PHP contract and reproduced defect

The authoritative PHP `StoreOrder::searchPidAttr` (model line 370) expands the
integer `pid=0` search to SQL `pid>=0`. `StoreOrderServices::getOrderData` (line
280) and the PC order controller (line 62) rely on that expansion. A literal
TypeScript `pid=0` predicate therefore wrongly removes materialized child orders.

Two initial native PG16 tests reproduced the error after a real partial-refund
finalization: the PC list was empty instead of containing two children, and
order count, paid value and pending-shipment count were `0/0/0` instead of
`2/55.00/1`. Both original assertions passed after the fix.

The ordinary PC list now uses `pid>=0`. Its existing negative refund-status
exception (`-1/-2/-3` have no pid predicate) is retained, matching the PHP
controller. Modern lists still exclude `pid=-1` payment audit roots.

Customer counters use current non-deleted physical orders, excluding audit
roots. This includes the pickup badge so a retired root is not counted again.
`order_count` is a physical-order count, not a logical-payment count;
`sum_price` remains the PHP sum of paid order allocations, **not net revenue
after refunds**. Three completed refund generations conserve the original
55.00 as 12.80 + 12.80 + 29.40 without adding the payment root a second time.

Refund counters join the original order ID and customer identity, excluding
orphaned/wrong-owner applications. Legitimate refund history remains countable
after the original order is soft/system-deleted, as with customer refund reads.
Cancelled/deleted refund rows remain excluded. Existing refund status categories
and response keys are unchanged.

## Snapshot consistency

Modern lists, PC list/count envelopes and customer details each use one
`REPEATABLE READ, READ ONLY` transaction. Headers, current carts, split children
and detail auxiliary reads cannot mix generations when another connection
finishes a refund. The statement timeout is capped at 5 seconds, preserving a
stricter existing value, and is transaction-local. This is a per-statement cap,
not a total request deadline. Child details now also exclude system-deleted
orders. Existing customer ownership checks remain in force.

Order and refund aggregates are combined in one SQL statement with two aggregate
CTEs, hence one database snapshot. Payment-readiness configuration stays outside
the read transaction/statement because it may use KV. Detail attachment signing
uses local Web Crypto; no external service call or write is introduced into the
snapshot transaction. Cart reads remain batched, not per-order queries.

These changes preserve the existing broad order DTO. They do not claim the
bounded public-only projection provided by the separate refund-history reader,
nor a new privacy review of every legacy field.

## Verification

`test/customer-order-generations.test.ts` uses the complete registered schema
(165 steps / 270 tables), real checkout/refund services and independently
authenticated non-owner runtime accounts. Paid state is synthetic; no payment
provider is contacted. Four extra detail-table SELECT grants are limited to
the disposable scenario role, not changes to production permissions.

The twelve scenarios cover original red assertions, three successive refunds,
pagination and retired-root exclusion, status/pickup badges, ownership and
deletion, refund-counter identity, database permission failures, timeout limits
and restoration, and six independent-LOGIN interleavings (first/later split ×
modern list/PC envelope/detail). A scheduling spy runs the real order SELECT
before allowing the real competing finalizer to commit; SQL and result values
are not replaced. The in-flight response remains equal to its pre-commit state,
including PC count, while the next read observes the new generation.

Reads are checked for unchanged synthetic business/evidence state; external
`fetch` is forbidden. The first expanded run had ten passes and one fixture
failure: synthetic status orders reused an empty idempotency key. The fixture
now supplies distinct keys; the unique constraint and business assertions were
not relaxed. A test-spy `this` annotation was also corrected for typechecking.

Final verification passed without failures or skips:

- Native PostgreSQL **16.15**: **30 tests / 2 files**, 132.85 seconds (12 new
  customer-order scenarios and 18 existing refund-history scenarios).
- Local order list, legacy/auxiliary/PC contracts and runner boundary:
  **41 tests / 5 files**, 6.63 seconds.
- Local virtual-product, integral-order, custom-form and after-sale regression:
  **42 tests / 6 files**, 8.76 seconds. These include PGlite/unit contracts, not
  another native PostgreSQL or production-platform run.
- Both Worker unit and runtime TypeScript configurations passed.

The native runner explicitly admits this suite to schema-maintenance mode; it
does not allow arbitrary maintenance tests. Every native run reported zero
remaining fixture databases/roles and stopped. Independent `pg_ctl status`
returned 3 for all four clusters; no PID/bootstrap-password file or listener
remained. The trusted test PostgreSQL process count was zero.

| Cluster under ignored `.cache` | Port | Purpose |
| --- | --- | --- |
| `finance-postgres-Y5iRYe` | 59119 | Original two-defect reproduction |
| `finance-postgres-Rrkt8m` | 59400 | Initial two-case green run |
| `finance-postgres-iFaDs7` | 52698 | Expanded run; one fixture constraint failure |
| `finance-postgres-EcDwxQ` | 51735 | Final 30-test native verification |

Stopped diagnostic directories are retained. No staging, commit, push or
deployment occurred. The original nine staged paths and checklist totals of
**240 checked / 164 open / 404 total** remain unchanged. Current official
references were retrieved; latest Workers-type lookup was network-denied, so
installed types **5.20260828.1** were used as the skill fallback. No dependency,
binding or Wrangler configuration changed.

## Remaining scope

Customer backend delete eligibility/locking now has a separate local increment
in [customer order deletion](customer-order-deletion.md). PC/UniApp list deletion
controls have since passed local joined browser-to-HTTP-to-PostgreSQL acceptance.
Modern Admin list/detail now have a separate local increment in
[Admin order generations](admin-order-generations.md). Native-device acceptance,
the Admin rendered consumer and other staff/report/export readers,
production runtime privileges, genuine authentication/provider/Hyperdrive/workerd
and production-browser acceptance, immutable CI, public-v2 activation and
coordinated deployment remain open. No frontend was changed in this increment.
Local service/database evidence is not production acceptance.

Workers/PostgreSQL skills guided short consistent reads, batched queries and
separation of external configuration I/O. Official references:
[PostgreSQL repeatable read](https://www.postgresql.org/docs/16/transaction-iso.html)
and [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).

## Reproduction

From `workers-ts`, using the trusted local runtime:

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/customer-order-generations.test.ts test/refund-read-generations.test.ts
node node_modules/vitest/vitest.mjs run test/customer-order-list.test.ts test/order-legacy-migration.test.ts test/order-auxiliary-migration.test.ts test/pc-compatibility-migration.test.ts test/local-finance-postgres-runner.test.ts --maxWorkers=2
node node_modules/vitest/vitest.mjs run test/manual-virtual-product.test.ts test/virtual-product-delivery.test.ts test/integral-order-migration.test.ts test/system-form-migration.test.ts test/pc-checkout-form-postgres.test.ts test/api-order-after-sale-migration.test.ts --maxWorkers=2
npm run typecheck
```
