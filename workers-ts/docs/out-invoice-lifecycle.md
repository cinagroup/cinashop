# Out invoice writes during refund processing

2026-09-16. Local migration increment, not deployed. No production connection,
image/cache changes, browser rerun, staging, commit or push. The user's new-image
read confirmation remains accepted; this work does not repeat image acceptance.

Later local increment: [reported issuance evidence](invoice-issuance-evidence.md)
retains creation and each reported number in append-only same-transaction
snapshots, and rejects v2 refund admission after manual rejection/deletion or
unknown pre-install history. It addresses the mutable-history gap below, not
real fiscal issuance/credit-note validation or public rollout. Final regression
is 402 cases plus a separate 10-case role suite; this document retains its
earlier 351-case evidence.

## Implemented contract

`OutApiService.updateOrderInvoice` and `updateOrderInvoiceStatus` now share
`currentInvoiceAmount` with customer invoice application. This is a lifecycle
guard for database records, not a tax-invoice issuance or credit-note provider.

- Resolve a unique visible platform order, take the payment-root settlement
  lock and row lock before child locks, and revalidate ownership, parent,
  payment identity and visibility after waiting. A new write against an audit
  root or an allocating/cancelled order is rejected.
- Look up the original account/route/body-hash replay before new-write
  admission. A committed request returns its original invoice identity even
  during a later refund hold or after that source invoice has been archived.
  It neither reapplies old metadata nor creates a replacement child receipt.
- New writes inspect real active refund rows, including when the summary flag
  is still zero. States 0/1/2/4/5 block both metadata and processing-state writes.
  Cancelled/deleted/refused requests do not themselves retain the hold. A
  provider SUCCESS awaiting local finalization still retains the active hold.
- The shared calculation checks the current physical generation and immutable
  excluded history. Completed current-generation amounts must match the order
  aggregate and refund ownership. Previous physical generations are not
  subtracted again. Reads are bounded; marked orders require generation evidence.
- Cart/generation checks precede invoice row locks; no refund row lock is added
  after the order lock. Active source/root invoice rows are locked in ID order,
  with at most three read. Missing/duplicate/foreign/wrong-category records,
  payment/refund flag mismatches and inconsistent amounts fail closed.
- Neither Out operation recalculates or writes `invoice_amount`. It must
  already equal the evidenced current amount. Unpaid applicant metadata remains
  editable, but an unpaid application cannot be marked issued.
- Invoice changes, redacted audit and original-request receipt remain in one
  short transaction. External provider I/O is outside that transaction; the
  durable refund hold prevents intervening Out writes, not a long-lived SQL lock.

The shared helper is extracted from the previously verified customer admission
calculation. No schema, public route activation, Out authentication/permission
policy, dependency, binding or default refund version changed in this increment.
The older isolated Out harness now clones cart/refund tables and fingerprints
their public sequences because the shared calculation reads those tables.
That complete legacy harness was not executed in this increment.

## Evidence and verification

Native PostgreSQL 16.15 runs use the owned loopback runner, non-superuser
`finance_test`, random databases and schemas, and a forbidden external `fetch`.
Actual services execute against SQL; Out identities and provider responses are
synthetic. These tests do not prove deployed auth, Hyperdrive caching, workerd,
real payment-provider behavior or browser acceptance.

1. Four red regressions reproduced accepted metadata/status writes during an
   active refund with summary zero and against a mismatched amount (7.64 s).
2. First repaired batch: 3 files, 90 passed / 1 failed, zero skips (39.04 s).
   The failure matched an obsolete comment in refund code. The test now checks
   transaction-owned provider admission and original order/trade/refund/amount
   bindings; no runtime comment was added to satisfy it. Both typechecks passed.
3. Expanded batch: 12 files, 350 passed / 1 failed, zero skips (228.96 s).
   All new SQL cases passed. The remaining static assertion looked for the net
   calculation in its old file; it now checks both callers and the shared
   generation-aware helper. Both TypeScript configurations passed at this stage.
4. Complete final rerun: **12 files / 351 passed**, zero failures/skips,
   **252.06 seconds**. Both final TypeScript configurations exited zero.
   Overlapping batch totals must not be added.

The Out lifecycle suite has 32 cases; the actual atomic refund suite grows from
55 to 60, and its existing known-success recovery case now also exercises Out.
Coverage includes active holds, invalid invoice evidence, unpaid behavior,
legacy partial refunds, delayed replay, duplicate public order identifiers and
late receipt rollback. Independent native backends, exact blocking PIDs and
NOWAIT probes verify root-before-child locking, reparenting/amount changes after
waits, duplicate writes, and both actual issuance-versus-refund race orderings.

Actual checkout/refund integration proves:

- Two physical refund generations leave a 29.40 invoice that Out can update
  and read, without changing amounts or subtracting an earlier generation twice.
- A committed root metadata request remains read-only and returns its original
  archived invoice ID during the hold and after physical splitting; new root
  writes and writes to refunded selected children are rejected.
- While a controlled provider response is paused after committed REQUESTING
  admission, both Out writes are rejected. Release completes one refund request
  and permits an issued state on the 42.20 remaining application.
- Known provider SUCCESS plus a failed local receipt insertion blocks both Out
  writes until recovery. Recovery makes no second provider request/query; the
  resulting remaining application can then be updated.

| Owned cluster under `.cache` | Port | Recorded result |
| --- | --- | --- |
| `finance-postgres-88WtJX` | 55361 | Four red regressions |
| `finance-postgres-E9DYle` | 63071 | 90 passed / 1 obsolete-comment assertion |
| `finance-postgres-PEqyPu` | 54837 | 350 passed / 1 extracted-helper assertion |
| `finance-postgres-SEpZsy` | 59788 | Final: 12 files / 351 passed |

All four clusters reported zero remaining fixtures and were independently
checked stopped: status exit 3, no PID/bootstrap-password/listener and no
trusted-runtime PostgreSQL process. Stopped diagnostics are retained.
No test or typecheck session remains running. Whitespace checks passed for
changed tracked code and the new helper/test/document files.

Reproduce from `workers-ts` (the runner does not install PostgreSQL):

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/out-invoice-lifecycle.test.ts test/out-api-migration.test.ts test/order-invoice-concurrency.test.ts test/refund-atomic-materialization.test.ts test/refund-order-materialization.test.ts test/supplier-refund-generations.test.ts test/refund-line-finance.test.ts test/refund-quantity-reservation.test.ts test/order-auxiliary-migration.test.ts test/v2-compatibility-migration.test.ts test/store-order-refund-postgres-migration.test.ts test/supplier-operations-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Still open

This closes only the local Out-versus-refund write race covered above. It does
not complete general invoice migration or permit public durable-v2 activation.
The existing manual record transition issued -> rejected clears the number and
is intentionally retained. It is **not** proof of a real credit note or that an
invoice has never been issued. Immutable ever-issued document lineage and its
refund admission policy must be implemented before such records can safely be
treated as unissued in public v2. Do not infer safety from current state alone.

Also outstanding: Admin/Kefu writers and lineage-aware reads/deletion/reporting,
general fulfillment/supplier invoice allocation, root invoices spanning existing
children, smaller-cash-refund retained consideration, candidate DDL/ACL and
actual roles, Hyperdrive/workerd/provider/browser acceptance and coordinated
rollout. Existing Out read methods were not redesigned; the 29.40 read test is
not a proof of complete historical invoice visibility or authorization.

Workers/PostgreSQL skills guided bounded reads, common transaction ownership,
consistent locking and provider I/O separation. Current
[Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html)
were retrieved. Installed Workers types 5.20260828.1 and the local Wrangler
Hyperdrive schema were inspected using the documented retrieval fallback.

Checklist remains **240 checked / 164 open / 404 total**. The original nine
staged entries are unchanged; no broad migration item is marked complete.
