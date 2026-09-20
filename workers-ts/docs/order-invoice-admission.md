# Invoice application, refund and split-order admission

Later increment: [unissued invoice allocation in actual atomic refunds](refund-invoice-allocation.md).
The blanket invoice gate described below is historical; supported unissued
applications now have a same-transaction allocation adapter. Issued invoices,
general fulfillment allocation and coordinated public rollout remain open.

2026-09-16. Local migration increment; no production connection/write, image or
cache maintenance, browser rerun, staging, commit, push or deployment.

## Findings reproduced with native PostgreSQL

Three red tests confirmed that the actual customer invoice application service
created an invoice when it should have refused:

1. A numeric input matched both an internal ID and another public order number;
   `limit(1)` silently selected one order.
2. An actual refund application could exist while `store_order.refund_status`
   remained zero (the existing PHP-compatible application behavior).
3. An order had become the payment/audit root after physical splitting.

The original advisory key also hashed the caller's reference string. An order
number and its numeric ID therefore did not serialize as one resource. The
service did not lock the order or invoice template before copying their fields.

## Implemented contract

- Resolve at most two own, visible matches and reject ambiguity. Use the shared
  settlement advisory plus row locks in payment-root → source → carts order,
  not an input-string hash. Recheck identity, ownership, visibility, parent,
  payment and supplier/store relationship after waiting.
- Preserve unpaid applications and the existing `is_pay` snapshot contract;
  prevent new applications on audit roots, cancelled orders or orders still
  undergoing supplier allocation. Existing root documents are not deleted or
  silently hidden merely because their order is now a parent.
- Inspect bounded refund history under the order lock. All five open states
  block a new invoice even if the order summary flag is zero. Cancelled, deleted
  and refused applications do not retain that hold. Do not acquire a refund-row
  lock after the order lock, which would invert the finalizer's order.
- Validate current-generation immutable receipts for marked physical remainders.
  Earlier materialized refunds are excluded only by exact durable evidence, not
  ID/time cutoffs. Missing evidence/table fails; nothing is automatically repaired.
- New invoice amount is current order payment minus its validated completed
  refunds. Completed refund identity, amount and the order aggregate must agree.
  This changes only a new application; existing/issued invoice amounts, document
  numbers and histories are never rewritten. It prevents a legacy partial-refund
  order from requesting its already returned cash again and avoids double
  subtracting older generations from a materialized remainder.
- Hold a SHARE lock on the owned, undeleted template through insertion. Reject
  duplicate or incorrectly associated existing invoice records. Snapshot fields
  remain independent of subsequent template edits.
- A still-active payment-root invoice prevents another independent child
  application until explicit invoice allocation is available. Existing parent
  records are neither edited nor cloned by this guard. An already soft-deleted
  parent document follows the existing reapplication contract; a new child
  application remains pending, not falsely issued.
- Customer list retains active original parent documents and filters foreign
  ownership, non-order categories, deleted/system-deleted orders and refunded
  orders. No API response shape or v1/v2 route is replaced.

## Verification

Initial native PG16.15 run: **3 reproduced failures**, all three calls wrongly
resolved with a created invoice. First repaired regression: **3 files / 42
passed**, zero skips, **24.42 seconds**. Both TypeScript configurations passed
at that stage. Expanded native regression passed **10 files / 268 tests**, zero
failures/skips, **181.99 seconds**, and both type configurations passed. Final
verification after the ancestor-document guard passed **10 files / 270 tests**,
zero failures/skips, **178.24 seconds**. Both final TypeScript configurations
reported exit code zero. Overlapping run counts must not be added.

The new tests exercise the actual service and controllers with synthetic
identities, not a replacement invoice implementation. Real independent backend
connections and exact `pg_blocking_pids` prove alias serialization, template
deletion visibility, parent-before-child ordering and locked current amount.
NOWAIT verifies a parent waiter has not acquired its child/template early.
Late insert failure rolls back all state. Synthetic v1/v2 HTTP checks use the
actual controller with fixture authentication; they do not prove live role or
middleware acceptance.

Additional real checkout/refund tests cover a 55.00 payment, 12.80 legacy partial
refund yielding a 42.20 new invoice; two atomic refunds yielding a 29.40 invoice
for the current remainder; cancellation releasing invoice eligibility; missing
generation evidence; and both orderings of actual invoice/atomic-refund
application races. External `fetch` is forbidden throughout.

| Isolated cluster under `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-6Fo5kg` | 60289 | 3 reproduced failures |
| `finance-postgres-DunisC` | 55613 | 3 files / 42 passed |
| `finance-postgres-b5fPdy` | 51514 | Expanded: 10 files / 268 passed |
| `finance-postgres-gGFQmo` | 60550 | Final: 10 files / 270 passed |

All four runners reported zero remaining fixtures and shutdown. Each exact
directory/port was independently audited: `pg_ctl status` exit 3, no PID or
bootstrap-password file, and zero listeners. Final trusted PostgreSQL test
process count was zero. Stopped diagnostic files are kept.

Reproduce the ten-file batch from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/order-invoice-concurrency.test.ts test/refund-atomic-materialization.test.ts test/refund-order-materialization.test.ts test/supplier-refund-generations.test.ts test/refund-line-finance.test.ts test/refund-quantity-reservation.test.ts test/order-auxiliary-migration.test.ts test/v2-compatibility-migration.test.ts test/store-order-refund-postgres-migration.test.ts test/supplier-operations-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## PHP comparison and remaining work

The local PHP source `app/services/order/StoreOrderInvoiceServices.php` was read
in full. Its `splitOrderInvoice` copies the source invoice to child orders and
deletes the original root record. The TypeScript refund/fulfillment/supplier
split pipelines do not yet provide the corresponding durable document lineage
and amount allocation. This increment repairs application admission and current
generation pricing; it does **not** claim that cloning issued invoice records,
external issuance/red-letter workflows, or Out/Admin/Kefu invoice adapters are
complete. Those require coherent document identity, read/write/replay and
transaction rules before the atomic invoice gate can be removed.

The explicit v2 atomic refund invoice gate remains in place. Public/default
atomic rollout, DDL/ACL, real Hyperdrive/workerd/provider/role/browser acceptance
and coordinated deployment remain open. Checklist totals remain **240 checked /
164 open / 404 total** and the nine pre-existing staged entries are unchanged.

Workers/PostgreSQL skills guided bounded reads, a shared short SQL transaction,
consistent locks and post-wait/rollback evidence. Current
[Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html)
were retrieved. Installed Workers types 5.20260828.1 and the local Wrangler
Hyperdrive schema were inspected using the earlier documented retrieval fallback.
No binding, dependency or database-global setting changed.
