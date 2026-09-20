# Supplier accounting across physical refund generations

2026-09-15. Local candidate, **unwired from the runtime refund finalizer and not
deployed**. Follow-up to [line settlement](supplier-refund-lines.md) and
[finance concurrency](supplier-finance-concurrency.md). No production data,
images, caches or browser state are changed by this work.

## Reproduced failure

Actual checkout, supplier allocation, payment accounting, refund finalization
and candidate physical splitting reproduced the next-refund failure in both
pending and received orders. The second refund threw
`供应商退款原结算账本与商品证据不一致`: the remaining order had smaller financial
totals while its effective supplier income still described the pre-split order
or belonged to a different order number. Both initial cases failed on native
PostgreSQL 16.15; this was not a mocked adapter result.

## Accounting representation

The existing fulfillment splitter already retains original income rows with
`status = -1` and derives child incomes. The candidate refund materializer now
has an explicit supplier counterpart for its completed refund:

- Lock the supplier mutex after the materializer's order/cart locks, then lock
  original active income and expense rows in ID order.
- Validate exactly one income and the exact current refund expense against
  the pre-split order, the shared completed-goods settlement basis, buyer,
  payment snapshots, expected pending/settled state and original refund key.
- Validate the corresponding immutable supplier cash transaction as well.
- Validate the actual persisted child orders/carts, including quantity,
  ownership, lifecycle and exact goods/postage/payment conservation.
- Reject unrelated active flows already claiming either child's order number;
  only the retained remainder may still own the verified source pair.
- Retain original income/expense IDs, amounts, financial fields and timestamps;
  change **only their active-representation status to -1**.
- Insert independent selected/remaining income rows plus the selected child's
  completed expense. No conflict suppression is permitted.
- Persist the pre-retirement income/expense/cash-transaction snapshots and
  exact derived row IDs inside the existing append-only materialization record.

For the 31.00 supplier entitlement after returning the first 5.50 item:

| Effective child | Income | Refund expense | Pending source | Received source |
| --- | --- | --- | --- | --- |
| Completed refunded child | 5.50 | 5.50 | Both recognized, net zero | Both remain recognized |
| Remaining child | 25.50 | 0.00 | Pending until receipt | Recognized |

The original 31.00 income and 5.50 expense remain inspectable but are excluded
from effective totals. The original supplier payment/refund **transactions**
are not reassigned, retired or duplicated. Customer cash remains 13.00 in this
example, not the supplier settlement amount. Old source transaction numbers
and all original refund/payment records remain unchanged.

Derived income IDs use the existing `S<sourceFlowId>-<childId>` convention;
derived completed expenses use `D<sourceExpenseId>-<selectedChildId>`. Remarks
record version `supplier-refund-split-v1`, refund ID, source order/flow and child
role. Dates remain tied to their source entries. Remaining-order ID reuse is
supported: its old effective representation is retired before the new smaller
one is inserted in the same transaction.

The next actual refund uses the remaining child's own active income and current
financial basis, not an unallocated ancestor's entire entitlement. Retired
earlier expenses cannot be deducted twice. Whole-order materialization verifies
the already completed net-zero accounting but creates no extra supplier rows.

For pending sources, recognizing the completed child's equal income/expense
does not consume another received order's available balance. For received
sources, replacing the representation preserves settled availability exactly.
The common supplier mutex prevents withdrawal admission from observing the
temporary retirement/insertion gap. A previously admitted withdrawal never
causes a later valid customer refund to be refused.

## Verification record

Initial fixed regression: **2 files / 78 passed**, followed by **4 files / 158
passed**. The expanded supplier suite
adds real multi-generation refunds, independent mixed-payment suppliers,
receipt/withdrawal between generations, original amount/key preservation,
cash concessions, zero settlement, inconsistent ledger evidence, late
transaction failure/retry and native lock-wait cases.

Final native PostgreSQL **16.15** regression: **17 files / 370 tests passed**,
zero failures/skips, **243.86 seconds**. The new supplier-generation suite has
**27 cases**. Both final TypeScript configurations passed. New/changed-file
whitespace checks passed without changing line-ending settings. These are
selected overlapping regressions, not a whole-repository or live acceptance
claim.

All fixture payments are synthetic paid flags; no real customer debit or
provider call is claimed. Receipt/refund/materializer/withdrawal services use
actual SQL. Native peers are independent connections and use exact PostgreSQL
blocker PIDs, not sleep-based ordering assertions. `fetch` must remain unused.

Retained overlapping run history (counts are not additive):

| Cluster under ignored `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-ApcWcO` | 62025 | Two next-generation refunds failed |
| `finance-postgres-jxVuye` | 55474 | Initial implementation: 2 files / 78 passed |
| `finance-postgres-alQBRS` | 59095 | Expanded SQL: 4 files / 158 passed |
| `finance-postgres-5nDIaj` | 51009 | Future-child ownership: 23 passed / 2 failed |
| `finance-postgres-wIBGWf` | 62848 | Final: 17 files / 370 passed |

The initial TypeScript run flagged optional settlement-basis narrowing in the
new adapter. It was corrected with an explicit early return for missing basis,
without assertions or relaxing validation. SQL test success alone was not
treated as completion while that type check was failing.

Two additional red tests proved that a pre-existing unrelated active income or
expense using a future child order number was previously accepted. The adapter
now checks child-link ownership under the supplier mutex before retiring any
source flows. Separate unique-key collision cases cover foreign-supplier rows
claiming the exact derived income/expense IDs; errors must roll back every
structural and supplier accounting change, not be suppressed as replay.

All five runners reported zero remaining fixture databases/roles and stopped.
Every exact cluster independently returned `pg_ctl status` exit 3, no PID or
bootstrap-password file, and zero listeners at its recorded port. The final
trusted PostgreSQL runtime process count was zero. Stopped diagnostic
directories are retained; no unrelated service or data is deleted.

Reproduce from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-refund-generations.test.ts test/supplier-refund-lines.test.ts test/supplier-split-ledger.test.ts test/supplier-split-fulfillment.test.ts test/supplier.test.ts test/order-supplier-allocation.test.ts test/refund-order-materialization.test.ts test/refund-earned-income.test.ts test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/split-order-line-finance.test.ts test/admin-refund-operation-service.test.ts test/admin-refund-creation-quote.test.ts test/order-reward.test.ts test/store-order-refund-postgres-migration.test.ts test/supplier-operations-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Remaining release gates

This is **not** atomic runtime activation. Tests currently finalize customer
cash first and call the candidate materializer in a separate transaction.
Materializer failure rolls back its child orders/carts and supplier ledger
replacement, but does not undo the already committed refund. Combining both
under the correct root-before-child/user lock order, with recovery and guarded
DDL/ACL installation, remains required.

Further fulfillment splitting of a refund-generation remainder still needs
durable generation/earned-income propagation and reader coordination. This
supplier adapter does not generalize a single remaining-generation chain into
independently refundable fulfillment siblings. The 2026-09-16 local follow-up
[fulfillment branch audit](refund-fulfillment-branches.md) addresses that
specific branch propagation with separate candidate evidence; it does not
activate this materializer. Invoice/promotions, merchant
freight, gift-only remainder, all read/delete/reporting adapters, original
cash-transaction navigation and real-role/Hyperdrive/workerd/provider/capacity/
CI/production acceptance remain open. Ledger rows and ancestry snapshots alone
are not proof that every frontend/report has adopted the new representation.

No new schema column or runtime migration registration is introduced: the
candidate's existing bounded source snapshot gains `supplierLedger` evidence.
Workers/PostgreSQL skills guided bounded amounts/rows, consistent lock order,
SQL-only transactions, locked revalidation and rollback tests. Current official
[Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html),
installed Workers types 5.20260828.1, full Hyperdrive interface and local
Wrangler binding schema were consulted. Bindings and dependencies are unchanged.

No production/image/cache writes, browser reruns, staging, commit, push or
deployment occurred. The original nine staged entries remain unchanged.
Checklist totals remain **240 checked / 164 open / 404 total**, and the full
checklist goal remains active.
