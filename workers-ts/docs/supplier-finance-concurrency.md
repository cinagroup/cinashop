# Supplier finance transaction ordering

2026-09-15. Local implementation, **not deployed**. Follow-up to
[line-based supplier refunds](supplier-refund-lines.md). This does not activate
physical refund materialization or complete cross-generation income ownership.

Follow-up: [supplier refund generations](supplier-refund-generations.md)
adds candidate materializer ledger replacement under the same supplier mutex.
This page retains the verification counts for the preceding concurrency increment.

## Scope and reproduced coordination gap

Withdrawal admission already used a supplier-specific PostgreSQL transaction
advisory lock, but refunds, receipt recognition and administrator rejection of
withdrawals did not participate. Independent native connections reproduced four
missing wait relationships: refund → withdrawal, withdrawal → refund, receipt →
withdrawal and rejection → withdrawal. The existing withdrawal → withdrawal
case passed. Initial run: **23 passed / 4 failed**, with both operations drained
before each assertion; failures were not mocked scheduling or leaked promises.

An overlapping withdrawal and refund can legitimately be ordered either way.
This change establishes a common decision boundary; it does **not** promise that
a supplier can never owe money after a previously admitted withdrawal.

| First finance operation | Waiting operation | Required result in the local 31.00 fixture |
| --- | --- | --- |
| Refund supplier expense 5.50 | Withdraw 31.00 | Reject; only 25.50 remains |
| Admit withdrawal 31.00 | Customer refund 13.00 / supplier expense 5.50 | Refund completes; withdrawal remains reserved |
| Recognize pending 31.00 income and 5.50 refund | Withdraw 25.50 | Admit exactly the net 25.50 |
| Reject old 31.00 withdrawal | New withdrawal 31.00 | Reuse released balance exactly once |

The withdrawal-first case keeps a supplier accounting deficit of 5.50 while
displayed availability clamps to zero. It does not cancel the old withdrawal,
erase the expense, cap customer refunds to supplier funds, or authorize an
external payout. A subsequent 0.01 withdrawal is refused.

## Writer inventory and lock order

`SupplierFinanceLock.ts` centralizes the **existing single-bigint supplier-ID
key**, not a new unrelated lock namespace. It is transaction-scoped and used by:

- `applyExtract`: before eligibility/balance reads and reservation insertion.
- `recordSupplierRefund`: before the original income row lock and history reads.
- `settleSupplierPayment`: before pending income/expense status changes.
- `AdminSupplierFinanceService.review`: lookup immutable supplier identity without
  a row lock, then supplier mutex, then conditional pending-status update.

Admin review is now one SQL transaction. The conditional update includes the
discovered supplier identity and rechecks `status = 0` after waiting. Conflicting
approve/reject decisions cannot both succeed or release the same reservation
twice. Missing/repeated-record behavior is retained.

Existing payment recording and fulfillment split allocation only create/replace
**pending** income; they do not alter admitted funds. They retain their existing
order/cart/flow locking. Flow and withdrawal mark edits are metadata-only. Admin
transfer changes payment metadata after approval but does not release the
reservation (`status <> -1` remains deducted); it retains its conditional update.
No other runtime balance writer was found by schema-symbol/raw-table searches.
Arbitrary SQL maintenance or older deployed writers are not covered by an
application-level advisory protocol.

Order/cart locks and ordered settlement-user locks precede the supplier mutex;
supplier flow/extract row locks follow it. The withdrawal/review branches never
then seek order/user locks. Existing user-lock reacquisition within settlement
is on the already locked set. Full pending refunds reacquire the same supplier
mutex inside the same transaction when recognizing net income/expense.

All new critical-section work is awaited SQL. Withdrawal limits/configuration
and receipt configuration are loaded before these service transactions. No
provider, browser, production database or cache operation is introduced.

## Isolation level is part of admission correctness

The lock alone is insufficient if a connection inherits `REPEATABLE READ`.
Its lock-acquisition SELECT can establish a snapshot before the preceding
transaction commits. An additional native red test set that default on two
temporary peer connections: **both 31.00 withdrawals succeeded**, despite their
proven mutex wait, against only 31.00 income. That run had 34 passed / 1 failed.

`applyExtract` now explicitly requests `READ COMMITTED` through the installed
Drizzle transaction API. The existing mutex prevents participating writers from
changing admitted funds while the following income/expense/reservation queries
run, and each query reads a post-wait committed snapshot. This is scoped to
withdrawal admission; no database, role, session-pool or user environment default
is changed. It does not weaken or rewrite other financial transactions.

## Verification

Initial fixed regression: **3 files / 64 passed**, including the expanded
34-case supplier-line suite, existing supplier split ledger and helper tests.
Coverage includes both transaction orderings, pending net recognition,
simultaneous withdrawals, two opposing review orders, different suppliers,
late refund/extract insert failures, rollback/retry, retained paid reservations,
and customer-refund replay after a withdrawal.

The native harness uses actual checkout/allocation/receipt/refund/finance
services with synthetic local balances, independent non-expiring connections
and exact `pg_blocking_pids` barriers. Table/row gates and failure triggers exist
only in disposable fixture schemas. No timing-based assertion or live provider
claim is used; `fetch` is asserted unused.

Final expanded native PostgreSQL **16.15** regression: **16 files / 343 tests
passed**, zero failures/skips, **213.55 seconds**. The supplier-line suite now
contains **35 cases**, including **13 new** concurrency/admission/review cases.
The Repeatable Read regression passes after explicitly pinning admission
isolation. Both final TypeScript configurations passed, as did tracked diff
and new-file whitespace checks. These are selected overlapping regressions,
not a full repository or production acceptance claim.

Retained isolated run history (overlapping counts, not additive):

| Cluster under ignored `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-VMr1Ua` | 57517 | Four missing wait relationships: 23 passed / 4 failed |
| `finance-postgres-Ea8rAk` | 60636 | Initial fix: 3 files / 64 passed |
| `finance-postgres-IHg1Ej` | 59344 | Repeatable Read stale admission: 34 passed / 1 failed |
| `finance-postgres-OPGhGm` | 56476 | Final: 16 files / 343 passed |

All four runners reported zero remaining fixture databases/roles and stopped.
Each exact cluster independently returned `pg_ctl status` exit 3, with no
PID/bootstrap-password file and zero listeners at its recorded port. The final
trusted PostgreSQL runtime process count was zero. Stopped diagnostic
directories were retained, not deleted.

Reproduce from `workers-ts` using the already trusted local runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-refund-lines.test.ts test/supplier-split-ledger.test.ts test/supplier-split-fulfillment.test.ts test/supplier.test.ts test/order-supplier-allocation.test.ts test/refund-order-materialization.test.ts test/refund-earned-income.test.ts test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/split-order-line-finance.test.ts test/admin-refund-operation-service.test.ts test/admin-refund-creation-quote.test.ts test/order-reward.test.ts test/store-order-refund-postgres-migration.test.ts test/supplier-operations-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Limits and references

- Physical refund descendants still need supplier income/expense ownership,
  immutable identity mapping, and subsequent fulfillment/receipt coordination.
- The candidate materializer remains unwired; atomic financial/materialization
  writes and guarded DDL/ACL installation are separate release gates.
- Summary/list reads remain observational, not locked admission quotes. Only
  actual withdrawal admission reserves funds.
- Real deployment roles, Hyperdrive/workerd, providers, capacity, CI and production
  acceptance remain unverified. Deploying one writer alone while old versions
  continue running cannot establish the common-lock guarantee.

Workers/PostgreSQL skills guided transaction-scoped coordination, consistent
lock order, fresh post-lock reads and rollback verification. References:
[PostgreSQL 16 explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
Installed Workers types **5.20260828.1**, full Hyperdrive interface and local
Wrangler binding schema were read; dependency/binding configuration is unchanged.
The first web reference fetch failed; retry retrieved both official references.

No production/image/cache writes, browser reruns, staging, commit, push or
deployment occurred. The original nine staged entries remain unchanged.
Checklist totals remain **240 checked / 164 open / 404 total**. The broader
checklist goal is still active.
