# Refund compensation from completed goods lines

2026-09-15. Local candidate, **not deployed**. This connects checked line
allocation to actual refund finalization and receipt-time compensation. It does
**not** create physical refund child orders or change immutable application,
operation, payment or income-ledger associations.

## Reproduced financial discrepancy

The actual checkout fixture buys two 10.00 items, each with 3.00 freight and
100 gift points, plus one 30.00 item with no freight or gift points. It spends
100 deduction points for 1.00 and pays 55.00. The first product has specified
SKU commission 0.30 per unit; the other earns 3.00 in gross-price mode. Real
receipt credits 200 product points and 3.60 commission.

Refunding one first-product unit quotes 12.80. Applying that cash fraction to
every original-order entitlement caused three different errors:

| Effect | Previous cash-ratio result | Selected-line result |
| --- | --- | --- |
| Return spent deduction points | 23 | 20 |
| Reverse product gift points | 46 | 100 |
| Reverse credited commission | 0.83 | 0.30 |

PHP `StoreOrderRefundServices::agreeRefund` first calls
`agreeSplitRefundOrder`, then performs points/coupon and brokerage reversal on
the selected order. Directly adding physical children while retaining the
original-order cash-ratio compensation could over-return or under-reverse
entitlements. This increment fixes that accounting dependency without copying
PHP's mutation of `refund.store_order_id` into the immutable TS protocol.

## Transaction and allocation contract

- `planCompletedRefundLineCompensation` shares strict v1 order/cart validation
  with the line quotation and fulfillment planners. It replays completed
  quantity reservations in application-ID order, retaining compact remaining
  quantities and financial totals, not repeated copies of product JSON.
- Each selected line uses four-place division followed by money/whole-point
  truncation. The remaining line retains residue. Spent deduction points and
  mandatory redemption points follow selected goods, not the cash refund ratio.
- Actual product-point grants use the selected product-gift fraction. Actual
  payment-earned grants use the selected allocated-payment fraction. The two
  grant types are not blended. Today's reward settings are not used to reprice
  already credited income.
- Actual credited commission uses the selected fraction of its own source
  type: self/first-level, second-level, staff, agent or division. Positive
  income without a matching positive source basis is rejected. BigInt products
  prevent floating-point overflow while calculating cumulative targets.
- An Admin cash concession consumes the selected goods allocation. Mandatory
  automatic full recovery may also return the earlier cash concession, but
  cannot invent extra goods/points/commission. Original provider cash amounts,
  trade references and `CNSR<refundId>` are unchanged.
- Finalization holds the existing refund/order locks and projects the current
  locked claim as completed for validation. It locks all cart evidence before
  activity/settlement-user locks or compensation writes. Receipt loads earlier
  completed claims before user locks. Both paths pass the same prepared plan to
  reward and brokerage reversal in the same transaction.
- At receipt, other held quantities may belong to an open application. They do
  not increase completed compensation. Counters must be in range and at least
  cover completed claims; this calculation alone does not certify every open
  reservation. Application/reservation lifecycle checks remain separate.
- Existing ledger keys and source income amounts are retained. Prior reversal
  ledgers determine only this transaction's delta. Existing available-balance
  caps remain: no negative points, negative commission or new debt is created.
  Existing full-reversal freeze clearing is retained. Experience is not reversed.

The Workers/PostgreSQL skills guided bounded deterministic work, awaited
transaction-local effects, consistent lock ordering and failure rollback. The
current official Workers guidance, installed Workers types 5.20260828.1,
Hyperdrive interface and Wrangler schema were consulted. Latest npm retrieval
was denied; no dependency, binding, DDL or configuration was changed.

## Compatibility and remaining acceptance

- At most 200 cart snapshots (64 KiB each) and 201 completed claims including
  the current finalization are accepted. Ordinary quotation still caps prior
  completed history at 200. Missing, mixed or inconsistent modern evidence is
  rejected; entirely unversioned legacy evidence retains cash-ratio behavior.
  Orders with no cart rows retain the pre-snapshot compatibility path; absence
  of cart rows is not proof of modern financial correctness.
- This is not a backfill of historical compensation or a mechanism to reclaim
  already over-returned points. Available-balance shortfalls are not converted
  into debt, and terminal replay is not a new collection attempt.
- No physical refund children are created. Child/root/remaining ownership of
  invoices, promotions, coupons, income ledgers and immutable operation/payment
  references, plus later fulfillment, still require coordinated implementation.
- These are synthetic service/SQL fixtures. Checkout, delivery/receipt,
  applications, ledger changes and rollback run the real services; `paid=1` is
  fixture setup, not a verified initial customer payment. Shipping is not sent.
  WeChat transport is mocked. No live payment, production role/catalog,
  Hyperdrive, workerd, browser or deployment acceptance is claimed.

User confirmation that the new images are readable is retained. No production,
image/cache, staging, commit, push or deployment action is part of this increment.

## Verification

Final native PostgreSQL **16.15** regression passed **11 files / 228 tests**,
zero failures/skips, in 174.53 seconds, using non-superuser `finance_test`.
The new suite has **27 cases**: 26 service/SQL cases and one arithmetic assertion
case. It covers the three reproduced discrepancies, three complete selection
orders, fractional product gifts and point residue, cash concessions and full
recovery, separate credited grant types, later configuration changes, receipt
before/after another open claim, eight corrupt-evidence/history cases, three
late SQL rollbacks, available-balance caps, duplicate finalization and mocked
provider UNKNOWN recovery. Both independent-backend races prove the exact
blocker with `pg_blocking_pids`; the cart-lock test also acquires both users
with `FOR UPDATE NOWAIT` while finalization is waiting on an unselected cart.

Other files cover line quotation, supplier split income, physical fulfillment
line amounts and cart/refund identity, legacy rewards/commission, reservation
lifecycle, paid-order migration, immutable Admin refund operations and static
transaction contracts. This is an overlapping regression, not a repository-wide
or production run. The PHP source was read; the earlier arithmetic oracle was
not rerun in this increment.

Failure history is retained, not counted as extra passes:

- First focused run: three failures; two exposed actual point errors, while
  the third initially used an incorrect 3.54 original commission expectation.
  Gross-price mode correctly produces 3.60. With that setup corrected, the
  second run reproduced all three actual errors listed above.
- Initial implementation: 6 files / 82 passed. This preceded the final shared
  plan/lock placement and is not final acceptance of that placement.
- Expanded 26-case run: 23 passed; three end-to-end permutations incorrectly
  expected original income freeze timestamps to remain after full reversal.
  Assertions now retain the existing freeze-clearing rule while still checking
  every other original income field. Production freeze behavior was not changed.
- Next 9-file run: 191 passed / one static failure, because its source-text
  assertion expected the old reversal signature. It now checks the shared plan
  argument and validates planning precedes user locks and completion writes.
  The final 11-file batch above reruns that contract and every affected suite.

Both TypeScript configurations passed. The final `tsc --noEmit` also includes
the expanded top-level tests; the runtime-test configuration covers its own
runtime scope and is not counted as compiling all top-level Vitest tests.
Tracked and new candidate files passed whitespace checks.

All six temporary clusters were independently verified stopped with
`pg_ctl status` exit 3, no PID/bootstrap-password files and no listeners:

| Cluster suffix | Port | Run |
| --- | --- | --- |
| DTlwrO | 50136 | Initial red test and fixture correction |
| DFdi6J | 61457 | Three confirmed financial discrepancies |
| D513ZF | 49770 | Initial 82-test overlap |
| 7fYV4e | 51439 | Expanded 26-case run |
| T5zpOu | 56139 | 192-test overlap and static signature failure |
| EZ8Cqk | 54442 | Final 228-test acceptance |

Each runner confirmed zero remaining fixture databases/roles. Final independent
process inspection found zero instances of the trusted test PostgreSQL binary.
An initial unprivileged attempt to inspect the private test log/processes was
denied; the narrow read-only shutdown audits used approved access. No runtime
or stopped diagnostic directory was deleted. Original nine staged files and
checklist counts **240 checked / 164 open / 404 total** are unchanged.

Reproduce the final batch from `workers-ts` using the trusted local runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/supplier-split-ledger.test.ts test/split-order-refund-identity.test.ts test/order-reward.test.ts test/store-order-refund-postgres-migration.test.ts test/split-order-line-finance.test.ts test/brokerage-paid-order-migration.test.ts test/refund-quantity-reservation.test.ts test/order-brokerage.test.ts test/admin-refund-operation-service.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```
