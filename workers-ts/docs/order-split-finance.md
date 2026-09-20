# Line-based fulfillment and supplier order splitting

2026-09-15. Local candidate only, **not deployed**. This continues
[checkout line evidence](checkout-line-finance.md) and the
[physical refund split prerequisites](refund-physical-split.md). It does not
implement refund child materialization or certify production settlement.

The later [refund quote/application consumer](refund-line-finance.md) now uses
the same checked financial evidence and line-cash partition, including replay
of completed quantity claims. This does not authorize physical refund children
or change the compensation/ledger gates below.

The subsequent [supplier income continuity increment](supplier-split-ledger.md)
now partitions pending supplier entitlements during fulfillment splitting and
connects child receipt/refund accounting. Original payment transactions remain
unchanged. Physical refund and other compensation-ledger gates remain open.

## Observed defects and implementation

The actual checkout -> paid-admission -> fulfillment SQL path reproduced two
defects before the implementation: a selected 10.00 item with 3.00 freight
received 1.20 freight and 11.20 payment under merchandise weighting, while its
child copied the entire order's 25.00 cost instead of 2.50. A three-unit line
with one deduction point and one gift point produced fractional 0.33-point
children. These were application failures, not hypothetical arithmetic examples.

`OrderSplitFinance.planOrderFinancialSplit` now checks v1 snapshots and aggregates
both child orders from the actual selected/remaining lines. It is invoked by
`SupplierFulfillmentService.splitDelivery` and multi-group
`OrderSupplierAllocationService.allocatePaidOrderBySupplier` before child writes.
The latter also persists enriched line evidence, so subsequent fulfillment
splits consume the retained residues instead of re-deriving them from a product.

| Evidence | Child fields |
| --- | --- |
| Unit checkout price and cost times quantity | `totalPrice`, `cost` |
| Paid and raw line freight | `payPostage`, `totalPostage` |
| Stored net merchandise plus paid line freight | Reconstructed raw `payPrice` |
| Actual admitted discount and commission line totals | Coupon, points-money, first-order and all five commission totals |
| Integer ordinary/gift point residues and per-unit activity points | `useIntegral`, `gainIntegral`, `payIntegral` |
| Stored SKU unit write-offs and validated SQL counters | Child total/remaining write-offs and timestamps |

The existing PHP-compatible partition now also partitions optional
`raw_postage_price` (money) and `gain_integral` (integer points). An absent gift
point residue is derived once from immutable `product.giveIntegral * quantity`,
truncated to integer points, then stored on the child. Unit price/cost/activity
fields remain unit values. Gift rows contribute quantity but no money; unexpected
nonzero gift financial totals are rejected rather than silently erased.

Order totals must reconcile before partitioning; `payPrice + changePrice` must
equal reconstructed raw payment. Partial manual-price allocation uses the
actual/raw ratio truncated to four places and retains exact final payment
residue. Whole-side selection keeps the entire remaining actual payment.
Order-level `giveIntegral`, `giveCoupon` and `promotionsGive` stay on the remainder
of a partial split, then on the final whole group, including zero-cash children.
This is field ownership, not invoice/promotion-record or reward-ledger migration.

## Admission, transaction and supplier boundaries

- All rows must fit the 200-row and 64-KiB-per-snapshot bounds. Values must be
  valid bounded decimal money or integer points, with matching order/user/cart
  identities, quantity and write-off counters. Missing fields, mixed versions,
  malformed JSON and aggregate mismatch fail before child ID allocation.
- Removing only the version marker cannot downgrade a row that retains modern
  raw-freight/gift-point evidence. Entirely unversioned rows without these hints
  retain the historical weight-based compatibility path; it is not certified as
  financially equivalent to v1. Malformed JSON is rejected even without a marker.
- Modern splitting refuses nonzero refund quantities, refunded money or returned
  points. This prevents this path from redistributing already-refunded quantities
  without a coordinated refund materializer; it does not fix every legacy or
  direct-delivery entry point.
- Duplicate/invalid direct-service selectors are rejected before they can be
  mistaken for whole-order delivery. Whole delivery and committed receipt replay
  retain existing identities; partial splits preserve the previously implemented
  canonical row/cart identity contract.
- The supplier checkout -> allocation -> subsequent shipping test also exposed
  a pre-existing ownership mismatch: allocation roots have supplier 0, while
  children belong to their suppliers. Read/write fulfillment now permits an
  explicitly owned child to resolve a completed (`pid=-1`, allocation status 2)
  platform audit root. Direct root and other-supplier child access remain denied.
  Root/child user identity must match, and the child is rechecked under its row
  lock. Supplier split listings never fall back to exposing a foreign audit root.
- Existing settlement/root/child/cart and allocation lock ordering is retained.
  No new remote I/O, background promises, bindings, migrations or backfill were
  introduced. All writes are awaited in the existing transaction; later failures
  roll back rows/markers/notices, with normal non-transactional sequence gaps.

Workers and PostgreSQL skills guided bounded deterministic BigInt computation,
unchanged lock ordering and transaction-local writes. This is not a new locking
protocol or an exhaustive concurrency audit of every order mutation.

## Remaining rollout gates

1. Physical refund children, selected/refundable quantity redistribution,
   reservations, immutable admin operation/request associations, original payment
   recovery, inventory, brokerage/reward/supplier-ledger compensation, invoices
   and promotion/gift records still require coordinated integration.
2. `freightPrice` has no authoritative line source here and retains the existing
   merchandise-weight split. It is distinct from customer paid/raw postage.
3. Positive actual payment on zero reconstructed raw payment is rejected for
   partial splits; the implementation does not invent an allocation basis.
4. Old/missing snapshots and previously split records are not repaired. Single
   supplier allocation does not create new financial children and retains its
   existing no-split behavior. Presence of a v1 marker is never sufficient to
   authorize payment, refund or reward execution.
5. These local changes must be rolled out together with the checkout writer and
   all relevant readers/executors. Real roles, production schema, Hyperdrive,
   providers, browser flows and deployment remain separate acceptance work.

No production, image or cache writes; no staging, commit, push, branch cleanup
or deployment. The user's readable-image confirmation remains recorded separately
in the PC test-media document.

## Verification

Final expanded acceptance: **9 files / 190 tests passed**, zero skips/failures,
on native PostgreSQL **16.15**, loopback only, as non-superuser `finance_test`.
The new SQL suite contains **47 cases**, including actual checkout, actual admin
repricing, unequal freight/cost/commission, repeated integer-point splits,
whole-side bonuses, rejected/corrupted evidence, supplier allocation and child
fulfillment, isolated read/write ownership, immutable replay, late SQL-trigger
rollback and four independent-backend lock scenarios. Lock waits are established
with `pg_blocking_pids`, not elapsed time. External fetch is forbidden.

Other files cover the 86-case PHP arithmetic corpus, 20 split/refund identity
cases, 13 checkout financial cases, supplier allocation/fulfillment contracts
and paid/notification outbox helpers. Earlier focused runs of 107 and 157 tests
overlap with the final run and are not added as distinct tests. The actual PHP
oracle was not re-run in this increment.

Failure history is retained: the initial two red SQL cases reproduced the
freight/cost and fractional-point defects above. The first expanded supplier
run was **164/171**: all seven new supplier cases still carried the base
fixture's platform template and failed actual checkout ownership admission.
The fixed-freight supplier fixture was corrected to have no template, without
weakening the guard. The next run was **170/171**, exposing the real platform
root/supplier child fulfillment mismatch. The scoped root correction and seven
read/write/concurrency isolation tests produced the final 190/190 batch.

Both Worker source and runtime-test TypeScript checks passed after the final
source change. `git diff --check` passed (repository CRLF warnings only). No
repository-wide, browser, workerd, provider, actual payment settlement or
Hyperdrive acceptance is claimed: the suite calls actual services against
synthetic SQL data with in-memory configuration KV, then sets a synthetic paid
flag. Supplier-ledger posting and external notifications are not executed here.

All six runners reported zero leftover fixture databases/roles. Independent
`pg_ctl status` returned exit 3 for each stopped cluster, with no PID/bootstrap
password files, no listeners on 51706, 59937, 50931, 58592, 53250 or 63391, and
zero processes from the trusted PostgreSQL runtime. Stopped diagnostics remain
in ignored `.cache/finance-postgres-{UjfS6Z,MO9Feg,j2nmpn,mjftOc,Kw4Lzv,pm02Qo}`;
no directory was recursively deleted. The original nine staged files were not
restaged or committed. Checklist remains **240 checked / 164 open / 404 total**.

Reproduce from `workers-ts` using the existing verified local runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/split-order-line-finance.test.ts test/refund-split-allocation.test.ts test/split-order-refund-identity.test.ts test/supplier-split-fulfillment.test.ts test/checkout-line-finance.test.ts test/order-supplier-allocation.test.ts test/order-outbox.test.ts test/order-notification-outbox.test.ts test/order-paid-outbox-queue-consumer.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```
