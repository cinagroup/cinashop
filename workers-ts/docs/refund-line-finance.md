# Refund quotation from checked line evidence

2026-09-15. Local candidate, **not deployed**. This connects the shared refund
quote/application path to [line-based financial splitting](order-split-finance.md).
It is another prerequisite to [physical refund children](refund-physical-split.md),
not a substitute for that still-open implementation.

Subsequent increment: [completed-goods line compensation](refund-line-compensation.md)
now connects these line entitlements to reward/commission reversal. The original
quotation-only acceptance below remains historical; physical child/ledger
ownership and immutable association integration are still open.

## Reproduced discrepancy

The actual checkout creates two 10.00 units with 3.00 freight per unit and one
30.00 free-freight item, for total payment 56.00. The previous refund quote
distributed that entire payment using merchandise-only weights. Native SQL
reproduced both wrong amounts:

| Selection | Previous quote | Checked line quote |
| --- | --- | --- |
| One 10.00 unit with 3.00 freight | 11.20 | 13.00 |
| The 30.00 free-freight item | 33.60 | 30.00 |

This also conflicted with the corresponding fulfillment child's newly corrected
payment amount. The source must be the stored net merchandise and paid postage,
not the current product configuration or a new share of aggregate freight.

## Implementation and history contract

`OrderSplitFinance` shares strict order/line financial validation between its
fulfillment planner and `quoteOrderRefundLineFinance`. Lifecycle requirements
remain separate: a delivered row may be refundable, whereas it cannot be
selected for fresh delivery. Financial validation alone authorizes neither.

The quotation replays completed quantity reservations by application ID, which
is serialized by the existing one-open-refund/order lock protocol. Each step
uses PHP-compatible four-place line division followed by cent truncation, then
the actual/raw payment ratio and exact remaining payment. Only compact net,
postage and remaining quantity values are retained during replay; full product
JSON is validated once rather than repeatedly copied for each historical claim.

An Admin concession consumes the selected goods' full allocated entitlement,
even if the agreed cash refund is lower. That difference is not transferred to
other goods. The existing mandatory automatic full-recovery path explicitly
retains its ability to refund all remaining cash; it is not ordinary user/Admin
selection pricing. Provider recovery still uses the already-admitted amount and
original refund/order identifiers, without re-quoting or replacing keys.

Completed v1 history must include a valid existing quantity-reservation record,
matching row/cart/order/user/owner, original quantity and prior consumed count.
Refunded cash must match the refund request; only Admin type 4 may be below that
goods allocation. Aggregate refunded cash and current cart counters must match
the completed records. Missing/inconsistent modern evidence fails explicitly;
the quote never silently falls back to merchandise weighting. Entirely legacy
snapshots without modern evidence retain their prior compatibility calculation.

Quotation now locks the ordered cart rows under the existing order lock, before
reading their financial evidence. Quote remains read-only: no temporary refund,
quantity update, sequence allocation, business rollback or provider call is used
to simulate it. Application uses the same preparation, then reserves quantities
and records the application/audit in its existing transaction. Cancellation,
terminal replay and admitted UNKNOWN recovery keep their existing protocols.

Workers/PostgreSQL skills guided deterministic bounded computation, compact
history replay, awaited transaction-local work and order-before-cart locking.
Current official Workers guidance, installed types 5.20260828.1, Hyperdrive
interface and local Wrangler schema were consulted; latest npm retrieval was
denied. No dependency, binding, DDL or production configuration changed.

## Limits and remaining requirements

- At most 200 line snapshots, 64 KiB each, and 200 completed applications are
  processed by the checked calculator. Larger/missing modern histories require
  explicit reconciliation, not a guessed fallback or rewritten original record.
- Existing legacy or inconsistent previously priced applications are not
  backfilled. Full and partial quotes both require coherent modern evidence.
- Existing admission still rejects zero-cash ordinary selections; pure
  integral-order rules remain separate. Positive actual payment on zero raw
  payment has no invented partial-allocation basis.
- This computes cash quotation, not compensation entitlements. Existing
  cumulative point/brokerage/reward behavior, financial-ledger ownership,
  physical child materialization, refund/root/child lock integration, immutable
  operation associations, invoices/promotions and post-refund fulfillment still
  require coordinated work and acceptance.
- Local service/SQL tests do not establish browser, real payment, production
  role/catalog, Hyperdrive or deployment acceptance. No production/image/cache
  writes, staging, commit, push or deployment are part of this increment.

## Verification

The initial two native SQL cases failed at the exact amounts above. The first
corrected focused run passed 4 files / 69 tests with no failures/skips; this
overlaps subsequent expanded coverage and is not an additional distinct count.
The expanded native PostgreSQL **16.15** batch passed **8 files / 259 tests**,
zero failures/skips, as non-superuser `finance_test`. Its **24 new SQL cases**
cover actual checkout -> quotation -> application -> balance finalization,
Admin creation receipt replay, delivered children, cancellation, corrupt current
and completed evidence, late SQL rollback and two independent connection races.

The seven-unit discounted line verifies successive refunds of **0.14, 0.42,
0.44**, totaling 1.00, plus all five originally deducted points returned through
the existing compensation service. A 5.00 Admin concession against a 13.00 goods
allocation leaves an ordinary remaining quote of **43.00**, not 51.00; mandatory
automatic recovery still refunds the remaining 51.00 explicitly. Both paths use
actual application/finalization services and assert wallet totals. A synthetic
WeChat timeout/recovery preserves 13.00 requested refund against the original
56.00 payment and the same `CNSR<refundId>`, with one request and no repeated
settlement. Only the transport is mocked; no live provider was contacted.

The additional files retain existing Admin quote/creation, customer application,
quantity-reservation, split/refund identity, fulfillment line-finance and PHP
arithmetic regression coverage. These synthetic service/SQL tests are not a
repository-wide run, provider certification or fresh browser acceptance. The
original PHP oracle was not re-executed this turn. The first two failures are
the actual application pricing defects above; the expanded batch needed no
weakened assertion or corrected production guard to pass.
Payment admission in the new fixture is an explicit synthetic `paid=1` flag;
no purchase payment or real cash movement is performed. Both Worker source and
runtime-test TypeScript checks passed after the final source change. Targeted
`git diff --check` and new-file trailing-whitespace checks are clean (repository
CRLF conversion warnings only).

All three runners reported zero remaining fixture databases/roles. Independent
`pg_ctl status` returned exit 3 for each stopped cluster, with no postmaster PID,
temporary bootstrap-password file, listeners on 57120/49884/56310 or processes
from the trusted PostgreSQL runtime. Stopped diagnostics remain in ignored
`.cache/finance-postgres-{7zkDyk,WaNc7p,jcL6d1}`; no directory was deleted.
The original nine staged files were not restaged or committed. Checklist remains
**240 checked / 164 open / 404 total**.

Reproduce the expanded batch from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-line-finance.test.ts test/split-order-line-finance.test.ts test/admin-refund-creation-quote.test.ts test/admin-refund-creation.test.ts test/customer-refund-application.test.ts test/refund-quantity-reservation.test.ts test/refund-split-allocation.test.ts test/split-order-refund-identity.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```
