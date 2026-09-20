# Supplier income continuity through fulfillment splits

Follow-up: [supplier refund line settlement](supplier-refund-lines.md) replaces
the cash-proportion calculation described below for versioned supplier orders.
The original tests and compatibility behavior below remain historical evidence;
neither increment completes supplier ownership across physical refund splits.

2026-09-15. Local implementation, **not deployed**. This follows
[line-based order splitting](order-split-finance.md) and
[refund line quotation](refund-line-finance.md). It fixes supplier accounting
for fulfillment children; it does **not** materialize physical refund children.

## Reproduced problems

Actual checkout, supplier allocation, payment-accounting and fulfillment services
were executed on disposable PostgreSQL 16.15 databases. A three-unit supplier
item costs the customer 39.00 (10.00 + 3.00 freight per unit). Its supplier
settlement is 16.50 (2.50 + 3.00 per unit).

- First fulfillment split left the only 16.50 income linked to the original
  order. The 13.00 and 26.00 children had no matching 5.50 / 11.00 income.
- When the source was already a supplier-allocation child, its remaining order
  retained the same ID but changed to 26.00; the linked income still said 39.00
  payment / 16.50 settlement. A subsequent refund used the wrong denominator
  and settlement basis.
- A pending-child refund posted a settled expense without recognizing the
  corresponding income. With 5.50 earned by a different received child, a full
  pending-child refund incorrectly reduced available money to 0.00. A partial
  refund also left pending settlement overstated at 11.00 instead of 5.50.

The first two SQL cases failed on the actual unpartitioned income rows. The
expanded suite then reproduced both pending-balance defects with separate
failing assertions; they were not inferred solely from code inspection.

## Accounting contract

`SupplierSplitFinance.splitSupplierPendingPayment` runs inside the existing
fulfillment transaction, after both child orders and carts exist and before
status/notification/replay writes commit.

1. Check source/child supplier, buyer, parent, payment method, delivery type and
   exact payment/goods/freight conservation. Require one matching pending source
   income, not a settled, missing, duplicate, foreign or inconsistent row.
2. Compute each child's supplier entitlement from its stored cart settlement
   unit price times quantity, plus its own postage (excluding postage for the
   existing shipping types 2/4). Use bounded decimal parsing and BigInt cents.
   Entitlements must exactly sum to the original income. Do not allocate them
   by customer-payment weights or current product prices.
3. Retire the pending source flow with status -1, preserving its amount and
   payment snapshots. Create two pending income flows with IDs
   `S<source-flow-id>-<child-order-id>` and versioned source-flow/order lineage
   in `remark`. Repeated splits therefore retain the prior income chain even
   when the remaining order ID is unchanged.
4. Do not create, rewrite or remove a `supplier_transactions` payment row.
   These are reallocations of supplier entitlements, not additional payments.
   A conflicting derived ID aborts the complete transaction rather than being
   suppressed as a successful replay.

Platform-owned orders skip supplier accounting. Whole-order delivery and a
recognized fulfillment replay do not replace income. A zero-cash selected
child can still carry its genuine supplier entitlement; this is not permission
to execute an unsupported zero-cash refund.

`recordSupplierRefund` now selects only the active income, ignoring retired
split predecessors, and refuses multiple active income rows. Its existing
cumulative nearest-cent refund allocation remains unchanged. Both pending and
settled previous refunds count toward that cumulative target.

- A completed cash refund against pending supplier income remains a pending
  accounting expense. The cash refund transaction is still recorded immediately.
- Receipt settles that order's pending income **and** matching pending refund
  expenses together. They do not affect another received order's balance.
- Full refund before receipt recognizes the original income and all its
  reversal expenses together, net zero, in the same transaction. It no longer
  cancels an income while deducting its expense from unrelated balances.
- The summary reports pending settlement net of pending refunds; cumulative
  refunds include both pending and settled accounting expenses. Available
  money still depends only on settled income/expense and reserved extractions.

Status 0 describes accounting settlement, not payment-provider progress. The
existing Supplier finance screen already labels it “待结算”. No API fields,
database columns, enum values, migrations, bindings or dependencies were added.

## Concurrency, failure and scope

The existing order/cart lock sequence is retained. The replacement helper locks
matching active income rows in ascending ID order after order/cart locks and
performs awaited database work only. Reads are bounded to two children, three
candidate active flows and 401 cart rows (400 accepted). No external call or
background promise runs in these transactions.

Late status-write failure rolls back child orders/carts, source-flow retirement,
new income, notices and replay. Late refund-transaction failure also rolls back
income recognition, reversal, customer balance, stock and refund status. Sequence
gaps after rollback are normal; no sequence is reset or reclaimed.

The Workers and PostgreSQL skills guided full-file review, bounded arithmetic,
short database-only transactions and the existing consistent lock order.
[Current Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
was retrieved. Latest npm types retrieval was denied by local network policy;
review used installed Workers types 5.20260828.1, the complete Hyperdrive binding
interface and the local Wrangler Hyperdrive schema. No configuration changed.

## Verification

`test/supplier-split-ledger.test.ts` executes real SQL and service methods, with
synthetic paid admission only. No customer payment debit, payment provider,
shipment, bank transfer, full payment outbox or production database is exercised.
The test-only extraction case creates a pending application, not a transfer.
All `fetch` calls are forbidden. Fixtures install the actual unique-key shapes
needed by the payment, transaction and outbox paths; they are not a complete
production schema/privilege migration test.

The suite covers direct and supplier-allocated source orders, repeated splitting,
receipt/refund/replay, zero-cash allocation, eight inconsistent-evidence cases,
late split/refund rollback, successive pending refunds, unrelated extraction
admission and three independently connected concurrency scenarios. Concurrency
is observed using `pg_blocking_pids`, not assumed from elapsed delays.

Final result: **24 new SQL cases; eight regression files / 138 passed, zero
failed or skipped**. The two Worker source/runtime-test TypeScript checks also
passed. The runtime-test configuration does not typecheck every top-level
Vitest file; those cases were executed by Vitest. No browser acceptance is
counted as part of this backend increment.

Run history (overlapping runs, **not additive**):

| Owned cluster suffix | Loopback port | Result |
| --- | --- | --- |
| `slHjmr` | 52821 | Initial two missing-allocation cases failed |
| `QdMSFF` | 54301 | Both allocation cases passed after implementation |
| `gh3zH1` | 64339 | 65/67 passed; two pending-balance defects reproduced |
| `VTvLvB` | 51801 | Eight files / 134 passed after pending-accounting fix |
| `TABY4s` | 55642 | Final eight files / 138 passed with added boundary cases |

Every runner reported zero remaining fixture databases/roles. Independent
read-only checks of all five exact cluster directories confirmed `pg_ctl
status` exit 3, no `postmaster.pid`, no bootstrap-password file, no port listener
and zero processes from the trusted PostgreSQL executable. Stopped diagnostic
directories remain under ignored `.cache`; none were deleted.

The existing nine staged files remain unchanged in the index. Checklist count:
240 checked / 164 open / 404 total. This does not close physical refund splitting.

Reproduce from `workers-ts` with the trusted local test runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-split-ledger.test.ts test/split-order-line-finance.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/supplier-split-fulfillment.test.ts test/store-order-refund-postgres-migration.test.ts test/order-supplier-allocation.test.ts test/supplier.test.ts
```

## Still open

- Physical refund child creation, immutable application/operation/provider
  associations, and invoice/promotion ownership remain open. This helper is
  wired only into **fulfillment** splitting; do not call it blindly from the
  refund finalizer or change a refund's `storeOrderId`.
- Original reward/brokerage/coupon ownership across refund splits requires its
  own integration and tests. Supplier accounting is not proof of those ledgers.
- Previously persisted broken child income, duplicate/missing income, or old
  cancelled-income/settled-expense combinations are not automatically repaired.
  No migration or production backfill was run. Missing income now prevents a
  supplier partial fulfillment split; payment post-processing must finish first.
- The existing refund path's missing-income compatibility and unsupported
  zero-cash supplier refund cases are not generalized by this change. Broader
  withdrawal/refund concurrency, production roles/index plans, Hyperdrive,
  real providers, browser acceptance and coordinated release remain separate.
- No production image/cache/data writes, staging, commit, push or deployment.
  The user's successful new-image read remains recorded; no new browser result
  is claimed. Overall migration checkboxes remain open where acceptance is not
  complete.
