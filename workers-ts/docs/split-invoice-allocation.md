# Invoice applications across fulfillment and supplier splits

Follow-up: [controlled invoice installation](invoice-evidence-installation.md)
now supplies a tested offline fresh/v1-to-v2 installer, catalog and role checks,
and an explicit maintenance CLI. The release-wide gates below remain open;
the run results in this document describe the preceding split increment.

2026-09-16. Local candidate; **not deployed**. The preceding message only
acknowledged the user's image acceptance. This turn resumes the full migration
checklist with actual split-service work. No production connection/write,
image/cache/browser rerun, staging, commit, push or deployment.

## Reproduced gap

The actual `SupplierFulfillmentService.splitDelivery` and
`allocatePaidOrderBySupplier` split orders and money but did not partition
invoice applications. Two native PostgreSQL red tests reproduced an active
37.00 application left on the fulfillment audit root and a 69.00 application
left on a supplier/platform audit root. Both failed in **5.89 s**; the first
implementation passed both in **6.14 s**.

The PHP `StoreOrderInvoiceServices::splitOrderInvoice` copies the original
application to children and deletes it on an initial split. This is useful
evidence of the missing workflow, but copying a full amount or issued number
is not a correct target contract.

## Candidate behavior

- Both real split entry points now prepare and materialize invoice allocation
  in the **same transaction** as physical order/cart changes, supplier accounting,
  status audit, replay and notification outbox. There is no repair job or provider
  call inside the transaction.
- Only pending or rejected **never-issued** applications are partitioned.
  Immutable source/payment-root creation and issuance history is mandatory,
  including archived/deleted records and pre-install unknown records. An empty
  current number is insufficient. `invoiceTime` is not treated as issuance:
  Out also changes it for metadata edits and rejection.
- Initial splits archive the original application, preserving its full amount,
  identity and metadata, then create applications for actual child amounts.
  Subsequent fulfillment splits keep the remaining application's ID and reduce
  its amount. No `isRefund` flag is invented by shipment or supplier allocation.
- Child amounts come from the newly stored orders, with exact cent conservation;
  there is no second invoice-specific weighting or rounding formula. Zero-cash
  allocations are retained as lineage, not permission to issue a zero-value bill.
- Metadata/rejection state is preserved. Every inserted child application obtains
  its own immutable creation evidence. Issued sibling invoices are not copied or
  altered; source/payment-root issuance still blocks new partitioning.
- Whole delivery and single-group supplier assignment make no physical invoice
  split. Committed replay is returned before new-write admission and never
  retroactively repairs older invoice state.
- The append-only `store_order_invoice_allocation` receipt stores source invoice,
  source/payment order, user, operation kind, full original application (16 KiB),
  and 2–200 child mappings (64 KiB). UPDATE/DELETE/TRUNCATE are rejected. Its model
  is intentionally not exported by the runtime schema index.
- Root/source/cart rows are held before invoice rows; supplier allocation locks
  invoices before supplier rows. Materialization takes no late invoice row locks.
  Source/child ownership, amounts, exact snapshot and immutable history are
  rechecked, including after receipt insertion. Suppressed inserts/updates and
  later failures abort the transaction; consumed sequence values are not reused.
- Receipt insertion must return exactly the proposed record. Final bounded reads
  verify the archived source and exact active child-invoice set, rejecting late
  receipt rewrites, source reactivation/amount drift and duplicate child invoices.

## Verification and scope

Tests use actual checkout and split/refund services, explicit synthetic paid
admission, dedicated loopback PostgreSQL 16.15 databases, and a forbidden external
`fetch`. They do not claim real payment/shipping/tax-provider acceptance.

The first expanded run was **129 passed / 1 failed / 0 skipped**, 3 files,
**114.35 s**. Its new supplier→fulfillment fixture omitted the required original
supplier income entry. The fixture now calls actual `recordSupplierPayment`
and installs its unique indexes; the business guard was not weakened. Both
TypeScript configurations passed before the fixture correction.

The next native run passed **12 files / 447 tests / 0 skipped**, **311.62 s**,
including the actual fulfillment→atomic-refund→remainder-fulfillment chain.
Both TypeScript configurations passed again. Subsequent hardening adds nine
late-drift/DDL boundary tests. The final immutable-code run passed **16 files /
486 tests / 0 failures / 0 skipped**, **318.02 s**. The allocation suite has 43
new cases. Both final TypeScript configurations exited 0.

The first expanded independent-role run passed 13 of 14 tests. Its sole failure
was an unordered SELECT assertion, not a permission or allocation failure. The
assertion now explicitly orders by invoice ID. No business assertion was relaxed.
The final independent-role run passed **14 tests / 0 failures / 0 skipped** in
**19.75 s**, including four new allocation permission cases. The real helper
works under a non-owner/non-superuser with allocation SELECT/INSERT but no
history INSERT or direct capture-function execution. Allocation UPDATE/DELETE/
TRUNCATE are denied. This is a separate run, not part of the 486-test total.

Kefu and Store-B isolated scenario setup now explicitly clones the base invoice
table/rebinds its serial and installs the candidate only inside the freshly owned
schema with `pg_temp` last. These are dependency updates, **not evidence that the
complete old hosted scenarios or real-role UI flows ran this turn**.

### Owned test environments and reproduction

| Cluster under `.cache` | Port | Verified result |
| --- | --- | --- |
| `finance-postgres-n1J7rK` | 59608 | Red: 2 failed |
| `finance-postgres-m5Mo26` | 58932 | First implementation: 2 passed |
| `finance-postgres-DylKqL` | 51428 | Expanded: 129 passed, 1 fixture failure |
| `finance-postgres-wn2EUH` | 62188 | 12 files, 447 passed |
| `finance-postgres-1kxLHT` | 54980 | Role suite: 13 passed, 1 unordered assertion failure |
| `finance-postgres-nVwlzl` | 58694 | Final: 16 files, 486 passed |
| `finance-postgres-FpyTvd` | 54758 | Final role suite: 14 passed |

Each runner reported zero leftover fixture databases/roles. Independent final
checks found all seven stopped (`pg_ctl` exit 3), no PID/bootstrap password/
listener, and zero processes using the trusted PostgreSQL binary. A first audit
collector mixed `pg_ctl` text into its object array and falsely failed; after
capturing that text separately, the fresh structured audit exited 0. No server
was restarted. Stopped diagnostics remain for inspection. All process/tool
handles are terminal; no test is left running.

Whitespace checks passed. The nine original staged filenames remain unchanged;
this turn did not alter the index. Checklist count remains **240 checked / 164
open / 404 total**. The user's image acceptance remains recorded and untouched.

From `workers-ts`, using the already trusted runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/split-invoice-allocation.test.ts test/split-order-line-finance.test.ts test/split-order-refund-identity.test.ts test/refund-line-finance.test.ts test/supplier-split-ledger.test.ts test/supplier-refund-lines.test.ts test/supplier-refund-generations.test.ts test/refund-order-materialization.test.ts test/refund-atomic-materialization.test.ts test/invoice-issuance-evidence.test.ts test/order-supplier-allocation.test.ts test/out-invoice-lifecycle.test.ts test/store-mobile-order-compatibility-scenario.test.ts test/store-mobile-order-migration.test.ts test/supplier-operations-migration.test.ts test/local-finance-postgres-runner.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/invoice-issuance-permissions.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Coordinated release gates (still open)

This changes the **normal physical split paths**, not an opt-in alternate API.
`invoiceEvidence.ts` now composes the allocation table with the existing history
candidate. Even a split with no current invoice requires the history/allocation
schema; missing tables do not silently authorize a legacy downgrade. A single
supplier group locks base invoice rows but needs no allocation/history admission.

Therefore this worktree must **not be deployed by itself**. Required before
release: controlled/versioned installation or upgrade of existing candidate
databases; catalog/ACL reconciliation; runtime SELECT on history and
SELECT/INSERT (not mutation) on allocation receipts; installer ownership and
runtime-role tests through the full application; reconciliation of pre-install
unverified history; coordinated writer/rollback strategy and isolated legacy
scenario execution. No runtime auto-DDL or fabricated baseline is added.

Still open: real issued-document verification and credit-note/reissue workflows,
older already-split roots whose invoice was never allocated, complete legacy
Admin/Kefu/Out/UI contracts, main Worker/Hyperdrive/provider/browser acceptance
and deployment. The checklist's broad invoice and release items remain open;
this increment does not redefine the full migration goal.

The Workers skill guided caller-owned short transactions/no outside I/O;
PostgreSQL guidance guided lock order, bounded evidence and append-only storage.
Current reference retrieval: [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html).
No platform binding or Wrangler config is changed; installed Workers type
definitions inspected were `5.20260828.1` (the previous latest-package retrieval
was permission-denied), with the bundled Hyperdrive schema.
