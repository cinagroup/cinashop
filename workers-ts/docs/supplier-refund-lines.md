# Supplier refunds: line settlement instead of customer-cash proportion

2026-09-15. Local implementation, **not deployed**. This is a prerequisite for
supplier income ownership across physical refund generations, not completion
of that ownership or activation of the physical materializer.

Follow-up: [supplier finance concurrency](supplier-finance-concurrency.md)
records the later common-mutex/admission-isolation implementation and native
regressions. Counts and remaining-work statements below describe this earlier
line-settlement increment.

[Supplier refund generations](supplier-refund-generations.md) records the
subsequent candidate income/expense partitioning work and its remaining release
gates; it does not activate the runtime materializer.

## Source contract and reproduced defect

The PHP source derives supplier refund settlement from the selected order's
stored per-unit settlement prices times quantities, plus allocated postage
(excluding shipping types 2/4):

- [StoreOrderCartInfoServices::getOrderCartInfoSettlePrice](/C:/cinagroup/cinashop-php/app/services/order/StoreOrderCartInfoServices.php:92)
- [SupplierFlowingWaterServices::setSupplierFinance](/C:/cinagroup/cinashop-php/app/services/supplier/finance/SupplierFlowingWaterServices.php:128)
- [Refund listener supplier dispatch](/C:/cinagroup/cinashop-php/app/listener/order/Refund.php:47)

This was source inspection, not a claim of running the full PHP application.
The migrated refund function instead used the customer's cash-refund fraction
of the complete supplier entitlement. That is wrong for unequal item margins.

Actual TypeScript checkout, supplier allocation, payment accounting, receipt
and refund services reproduced the defect on native PostgreSQL 16.15:

| Selected goods | Customer amount | Supplier goods | Supplier freight | Correct supplier reversal |
| --- | --- | --- | --- | --- |
| First unit of product A | 13.00 | 2.50 | 3.00 | 5.50 |
| Second unit of product A | 13.00 | 2.50 | 3.00 | 5.50 |
| Product B | 30.00 | 20.00 | 0.00 | 20.00 |

Order totals are 56.00 customer payment and 31.00 supplier entitlement. The
old first-refund calculation returned 7.20 instead of 5.50. Both pending and
already-received source tests failed on this exact assertion before the fix.
The synthetic paid flag does not represent a real customer debit/provider call;
the subsequent allocation, accounting and refund operations are actual SQL.

## Implemented behavior

The existing locked, validated refund-line plan now includes an independent
supplier settlement basis for versioned supplier-owned orders. It multiplies
the persisted `store_order_cart_info.settle_price` by each completed claimed
quantity and adds that claim's previously validated postage allocation. It
never reads today's SKU/product settlement price to reprice the refund.

BigInt arithmetic bounds aggregate settlement to the supported decimal range.
Completed quantities, not open quantity holds, determine both the cumulative
target and whether all goods are refunded. This also avoids prematurely
recognizing a zero-value entitlement after only one partial refund.

The finalizer passes the same plan to supplier accounting. The original active
income is locked and checked against supplier scope, buyer, payment method,
stored payment/goods/postage snapshots and exact original line entitlement.
Missing, duplicate or inconsistent income is not silently treated as zero.
Previous active pending/settled reversals must be nonnegative and cannot
already exceed the current cumulative goods target. Only the new delta is
inserted, using the existing original refund-derived transaction identity.

Modern previous reversals must also match buyer and payment method. A separate
four-case red run proved that foreign historical ownership and conflicting
refund-flow/cash-transaction identities previously returned `completed`.
Modern inserts now reject either identity collision instead of suppressing it
with `ON CONFLICT DO NOTHING`; the caller's normal terminal replay still returns
before accounting, with no new effects. Both ledgers and the customer refund
roll back together on a collision. The legacy compatibility branch is unchanged.

Pending partial refund expenses remain pending against their own income.
Receipt recognizes that income and its pending reversals together. Once all
goods are refunded, they are recognized together at net zero, even if the
administrator approved less cash than the customer originally paid. Customer
cash transactions still retain the actual cash amounts; they are not rewritten
to supplier settlement amounts.

Entirely unversioned legacy orders retain the existing cumulative nearest-cent
cash-ratio compatibility path. Old wrong amounts are not backfilled, erased or
quietly rewritten. This is not authorization to run a production correction.

## Verification

Final native PostgreSQL **16.15** regression: **15 files / 326 tests passed**,
zero failures/skips, 206.93 seconds, using the isolated non-superuser
`finance_test` role. The new supplier line suite has **22 cases**. These are
selected overlapping regressions, not the whole repository or live production
acceptance. The initial adapter had passed four files / 72 tests.

Both final TypeScript configurations passed, including the main configuration's
top-level tests and the separate runtime scope. Whitespace checks passed without
changing Windows line-ending settings.

The new native suite covers both receipt states, both refund orders for unequal
margins, full goods with cash concessions, receipt between refunds, changed
current SKU prices, shared freight residue, genuine zero settlement, nine
inconsistent-evidence cases, two identity-collision cases, late transaction rollback and a real independent
flow-row lock wait. On that wait the original income changes after the operation
has started; the locked reread rejects and all uncommitted refund side effects
roll back. Existing overlapping supplier split tests retain their receipt,
withdrawal-admission and native concurrency coverage.

Retained run history (overlapping suites, not additive counts):

| Cluster under ignored `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-ePLnaJ` | 54927 | Original amount defect: 2 failed |
| `finance-postgres-g6bwJA` | 52758 | Initial adapter: 4 files / 72 passed |
| `finance-postgres-Hl5LSy` | 53577 | Expanded: 321 passed / 1 fixture ownership failure |
| `finance-postgres-wbIR3X` | 61311 | Corrected fixture and conflict reproduction: 18 passed / 4 failed |
| `finance-postgres-uG6gEe` | 55606 | Final: 15 files / 326 passed |

The freight test initially used a platform-owned shipping template for a
supplier-owned product. The fixture now explicitly owns that template as
supplier 7; the shipping ownership guard was not changed or weakened. The
corrected test passes the exact 2.50, 2.50, 2.51, 20.00 settlement sequence.
The zero-entitlement case also passes without division or early recognition.
The existing static finalizer assertion was updated to require the shared
line-plan argument, not removed.

All five runners reported zero remaining fixture databases/roles and stopped.
Independent read-only checks confirmed `pg_ctl status` exit 3, no PID or
bootstrap-password file and no listeners at all five exact cluster ports.
The final trusted PostgreSQL process count is zero. Stopped diagnostic
directories were retained; no unrelated service or data was deleted.

Reproduce from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-refund-lines.test.ts test/supplier-split-ledger.test.ts test/supplier-split-fulfillment.test.ts test/supplier.test.ts test/order-supplier-allocation.test.ts test/refund-order-materialization.test.ts test/refund-earned-income.test.ts test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/split-order-line-finance.test.ts test/admin-refund-operation-service.test.ts test/admin-refund-creation-quote.test.ts test/order-reward.test.ts test/store-order-refund-postgres-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

No schema, binding, configuration or dependency changed. Workers/PostgreSQL
skills guided bounded integer calculations, using existing locked cart evidence,
awaited SQL-only transaction work and fresh validation after a row-lock wait.
The [current Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
installed Workers types 5.20260828.1, complete Hyperdrive interface and local
Wrangler binding schema were consulted.

## Remaining work — not closed by this increment

- Physical refund descendants still need durable supplier-income/expense
  ownership. Their source income cannot simply be looked up by the new/shrunken
  order, and cash-proportion rebasing would preserve the defect fixed here.
- Pending and settled source income, receipt between generations, immutable
  refund/payment transaction keys, historical expenses, reporting and subsequent
  fulfillment splits must be coordinated. A single-chain ancestor shortcut must
  not be generalized to independently refundable fulfillment siblings.
- The sequential extraction checks do not prove concurrent withdrawal/refund
  admission isolation. Supplier-wide serialization must be audited before
  declaring the complete finance flow accepted.
- The candidate materializer is still not called by the runtime finalizer. Its
  supplier-descendant amount/identity gap is not made functional by this patch;
  inconsistent/missing modern income is rejected rather than recorded as zero.
- Gift-only remainder, merchant freight, invoice/promotion ownership, atomic
  financial/materialization locks, guarded candidate DDL/ACL installation,
  all-reader/writer coordination and production/Hyperdrive/provider/browser
  acceptance remain release gates.

No production, image or cache writes, browser reruns, staging, commit, push or
deployment occurred. The confirmed new images are left alone. The active
checklist goal is unchanged and remains open.
Original nine staged files and checklist totals **240 checked / 164 open /
404 total** are unchanged.
