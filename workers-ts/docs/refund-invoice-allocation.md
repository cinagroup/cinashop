# Unissued invoice applications in atomic refunds

2026-09-16. Local candidate increment. No production connection or write,
image/cache change, browser rerun, staging, commit, push or deployment.

Later local increment: [Out invoice lifecycle guard](out-invoice-lifecycle.md)
now verifies Out metadata/status writes against current refund holds and amounts,
including provider-await/recovery and delayed original-request replay. It
supersedes the Out in-flight-write gap described below, not the remaining
issued-document, other-writer or rollout requirements. Its final native run is
12 files / 351 passed; this document preserves the earlier 293-case evidence.

Subsequent [reported issuance evidence](invoice-issuance-evidence.md) now also
requires durable created-unissued baselines and rejects any captured issuance
or unverified/uncaptured old source/root application, including deleted or
archived rows. Its candidate trigger DDL is composed into the explicit split
fixture only; real document/credit-note handling and controlled rollout remain
open. Final local regression: 402 cases and a separate 10-case role suite.

## Implemented contract

The actual durable v2 refund finalizer now partitions an existing **unissued
application**, not an issued invoice document, in its financial/physical SQL
transaction. Default v1 and public HTTP activation have not changed.

- Admission locks the payment root, source and carts before existing invoice
  rows; invoices precede financial user locks. It reads at most three active
  source/root records in ID order and rejects duplicates, foreign ownership,
  wrong category, unpaid/refunded records and inconsistent source amounts.
- Only pending (`0`) or rejected (`-1`) applications with an empty invoice
  number are accepted. Rejection metadata stays intact. Issued invoices and
  any existing document number still require explicit original-document and
  credit-note handling; no provider or issuance workflow is invented here.
- Invoice amount must equal the current physical source payment. Selected
  goods payment must equal requested refund cash. A discretionary smaller
  refund needs a retained-consideration allocation that is not yet implemented;
  the guard runs before both application persistence and provider admission.
- Whole refund preserves the original application ID and amount, marking it
  refunded. First partial split archives the original row without deleting its
  fields, and creates selected/refunded and remaining applications at their
  actual child prices. Subsequent partial splits keep the remaining application's
  ID while reducing its unissued amount and creating only the selected record.
- Finalization rechecks the complete locked invoice snapshot before any invoice
  allocation. It acquires no new invoice row lock after users. Actual child
  ownership, payment identity and amounts must agree and conserve the original
  application amount. A standalone legacy materializer cannot invent invoice
  preparation after a financial refund has already committed.
- The same append-only refund receipt stores the original complete application
  snapshot and selected/remaining invoice IDs, order IDs and amounts in
  `invoice_allocation`, version `refund-invoice-allocation-v1`. JSON is bounded
  to 16 KiB in code and candidate DDL. No invoice means JSON `null`. Existing
  update/delete/truncate guards protect this evidence too.
- Financial, physical, supplier, invoice and operation-receipt failure all
  roll back together. Provider SUCCESS deliberately survives local failure;
  recovery retries local finalization without requesting or querying it again.
  Terminal replay does not clone invoice records or repair missing receipts.

The candidate ORM/DDL adds a defaulted column, but no runtime installer or
catalog registration. Admission probes the column, rejecting an older candidate
schema rather than auto-upgrading or downgrading to legacy execution.

## PHP comparison

The complete local PHP `StoreOrderInvoiceServices.php` was inspected. Its
`splitOrderInvoice` copies the source record to children and deletes the root
record. This implementation preserves the root application and its immutable
pre-split evidence, and allocates amounts rather than duplicating the original
amount or treating a copied issued number as a newly issued invoice.

## Verification

Initial native PostgreSQL 16.15 regression: **3 failures / 32 passed**, zero
skips, **46.57 seconds**. All three new failures were the existing blanket
invoice gate: pending/rejected three-generation splits and whole-order refund.

First integrated regression: **3 files / 149 passed**, zero skips,
**97.51 seconds**. TypeScript separately found that the financial plan's
`payPrice` property was optional in its declared type. Admission now validates
the string explicitly; no assertion or unsafe cast was added.

Expanded tests cover actual checkout, invoice application and refund services,
not a replacement invoice implementation. They test exact snapshots and
55.00 = 12.80 + 12.80 + 29.40 conservation, original and retained identities,
archive behavior, no-invoice/deleted records, customer list filtering, immutable
evidence and replay; invalid/issued/duplicate/root-only records; admission and
provider cash-concession guards; older schema; late invoice insert/update/drift
and receipt failures; known-success recovery; and independent backend races.
External fetch is forbidden. Exact PostgreSQL blocking PIDs and NOWAIT checks
prove invoices precede users and changed issuance is revalidated after waiting.

First expanded run: **10 files / 287 passed / 4 failed**, zero skips,
**199.67 seconds**. All four failures were message assertions: issued-state
cases correctly rejected with `已开票…`, but the test expected the substring
`发票`. Assertions now distinguish issuance from association rejection and
still require unchanged complete business state. Both TypeScript configurations
passed at this stage. Added a suppressed-update trigger case (zero updated rows
must roll back) and a standalone legacy-completion case (no post-financial
invoice retrofit). Final complete rerun: **10 files / 293 passed**, zero
failures/skips, **195.65 seconds**. The atomic suite now has **55 cases**, 23
more than the preceding invoice-admission increment, and existing failure and
provider-recovery scenarios also now include an invoice. Both final TypeScript
configurations exited zero. Overlapping run totals must not be added.

| Isolated cluster under `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-84q1nc` | 65411 | Red: 3 failed / 32 passed |
| `finance-postgres-g1ZMPY` | 49628 | First integrated: 3 files / 149 passed |
| `finance-postgres-w997lm` | 50230 | Expanded: 287 passed / 4 message assertions failed |
| `finance-postgres-9Mij2F` | 54672 | Final: 10 files / 293 passed |

All four runners reported zero remaining fixtures and shutdown. Their exact
cluster paths/ports were independently checked: status exit 3, no PID/bootstrap
password, no listener and no trusted-runtime PostgreSQL process. Stopped
diagnostic files remain available. No running test or typecheck session remains.

Reproduce from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/order-invoice-concurrency.test.ts test/refund-atomic-materialization.test.ts test/refund-order-materialization.test.ts test/supplier-refund-generations.test.ts test/refund-line-finance.test.ts test/refund-quantity-reservation.test.ts test/order-auxiliary-migration.test.ts test/v2-compatibility-migration.test.ts test/store-order-refund-postgres-migration.test.ts test/supplier-operations-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Remaining migration requirements

This is not complete invoice migration. General fulfillment/supplier splitting
with an existing invoice, active payment-root invoice allocation across already
existing children, issued-document/credit-note handling, retained consideration,
and Out/Admin/Kefu lineage-aware reads/writes/replay remain open. In particular,
Out invoice-status writes currently share a payment-root advisory lock but do
not freeze issuance throughout an admitted asynchronous provider refund. That
cross-transaction lifecycle adapter must land before public activation; this
finalizer rechecks and refuses changed issuance, which is not a substitute for
preventing the race. Do not activate public v2 refunds on the strength of this
isolated adapter.
Candidate schema registration/ACL, actual roles, Hyperdrive/workerd/provider,
joined browser acceptance and coordinated rollout still need verification.

Checklist totals remain **240 checked / 164 open / 404 total**; the nine existing
staged entries are preserved. No broad migration item is closed by these tests.

Workers/PostgreSQL skills guided bounded SQL, shared transaction ownership,
consistent lock order and external I/O separation. Current
[Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html)
were retrieved. Installed Workers types 5.20260828.1 and the bundled Wrangler
Hyperdrive schema were inspected using the previously documented retrieval
fallback; bindings and dependencies are unchanged.
