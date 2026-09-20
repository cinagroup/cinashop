# Fulfillment after refund materialization

Schema follow-up: [refund split installation and registration](refund-split-installation.md)
registers both generation ledgers with explicit protection and runtime-role
commissioning. Statements below about unregistered DDL describe this earlier stage.

2026-09-16. Local candidate only; no production data, images, caches, browser
reruns, staging, commits or deployments. The user's confirmation that the new
images are readable remains recorded separately.

## Reproduced failure

Actual checkout → supplier allocation/payment ledger → refund finalization →
candidate refund materialization → `SupplierFulfillmentService.splitDelivery`
left both new fulfillment branches unable to refund. The shipped child had no
refund-generation receipt owning its ID; the retained remainder's cart partition
no longer matched its previous receipt. Two native PostgreSQL 16.15 tests failed
with `退款拆分代次证据不一致，请先核对订单`; the existing 27 tests passed.

Removing the marker would lose the retained order's exact prior-refund and
returned-point exclusions. Copying the marker cannot represent two independently
refundable children. Neither is used as a fallback.

## Representation and transaction boundary

- After the existing root → source → cart locks, validate the source's durable
  generation before any fulfillment write, including whole-order delivery via
  the split endpoint.
- True partial fulfillment of a marked remainder appends two compact records to
  candidate `store_order_fulfillment_branch`, in the same transaction as the
  child orders/carts, supplier pending-income split, status log and outbox.
- Each child gets its own random branch ID and exact source-row → child-row,
  cart-ID and quantity mapping. The ordinary line financial version remains
  intact, with a strict marker union: refund receipt ID or fulfillment branch ID.
- The retained-ID child preserves the precise validated refund ID/fingerprint
  map, the covered older receipts and returned-point bill IDs. The newly created
  child inherits none of those exclusions. An ID/time cutoff is never authority.
- Source refund/branch references are immutable and checked for ownership and
  payment-root continuity. Baselines are bounded, flattened metadata; the reader
  does not recursively fetch ancestor product/source snapshots.
- Subsequent refund materialization records its `base_branch_id`. The resolver
  accepts older receipts only when the baseline covers their exact fingerprints;
  new receipts must form the complete linked chain after that baseline. Missing,
  foreign, orphan, inconsistent or cross-child evidence is an error, not repair.
- Returned-point identities are unioned across subsequent materialization, so
  deleting a business refund row cannot silently drop previously captured IDs.
- Further fulfillment requires an unreceived source with no inherited earned
  income. Each shipped child can later earn and refund its own receipt-time
  product/payment gifts and commissions. Existing received-source propagation
  remains the refund materializer's responsibility, not the fulfillment fork's.

The branch table rejects UPDATE, DELETE and TRUNCATE. There is no runtime table
installation, migration registration or schema-index export. These owner-run
fixture triggers are not proof of production least-privilege ACLs. Ordinary
unmarked orders neither read nor write either candidate evidence table.

Bounds: 200 current cart rows; 201 covered refund receipts; 1,024 exact returned
bill IDs; 32 KiB per history/partition JSON and 16 KiB for returned bill IDs. Long
histories exceeding these limits fail explicitly; capacity beyond them remains
a release requirement. No historical ledger or refund/payment identity is
rewritten by the branch baseline.

## Verification

Initial repaired overlapping regression: **4 files / 158 passed**, zero skips,
105.07 seconds. Both TypeScript configurations passed at that stage.

Expanded supplier-generation suite: **50 passed**, zero skips, 64.05 seconds.
It exercises repeated forks interleaved with seven actual refunds, independent
receipt-time income owners (with and without payment gifts), exact 100 spent
points returned, 107.00 customer cash returned and 53.00 supplier income/expense
net zero; another test keeps a mixed-payment supplier sibling unchanged.
Original refunds, cash transactions and point/commission entries are not
rewritten by fulfillment. Late branch/status/outbox failures roll back all
children and ledger changes. Nine corrupt-evidence cases and three append-only
checks fail closed. Two independent native-connection cases observe exact
PostgreSQL blocker PIDs for cart revalidation and serialized successive forks.

Final native PostgreSQL **16.15** regression: **17 files / 395 passed**, zero
failures/skips, **244.81 seconds**. The supplier-generation suite now has 52
cases, including **25 new cases** in this increment. Final coverage additionally
confirms fulfillment replay is write-free and a missing candidate branch table
rolls back without auto-installation. Both final TypeScript configurations passed.
One extra compiler invocation from the repository root failed to locate
`node_modules/typescript`; rerunning from `workers-ts` passed. No type assertion
or business expectation was weakened to make the tests pass.

Overlapping runs (counts must not be added):

| Isolated cluster under `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-O82rQG` | 57819 | 27 passed / 2 reproduced failures |
| `finance-postgres-xHgdo5` | 53046 | Initial fix: 4 files / 158 passed |
| `finance-postgres-RgIF6n` | 61060 | Expanded branch suite: 50 passed |
| `finance-postgres-ZhJUIw` | 59698 | Final: 17 files / 395 passed |

Every runner reported zero remaining fixture databases/roles and stopped. Each
exact cluster was independently checked using `pg_ctl status` (exit 3), absent
PID/bootstrap-password files and zero listeners on the recorded port. Final
trusted PostgreSQL test-process count was zero. Stopped diagnostics are retained;
no unrelated service or directory was removed.

The original nine staged entries and checklist totals (**240 checked / 164 open
/ 404 total**) remain unchanged. This increment does not close the parent
migration/release gates. No commit, push or deployment was performed.

Reproduce from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-refund-generations.test.ts test/supplier-refund-lines.test.ts test/supplier-split-ledger.test.ts test/supplier-split-fulfillment.test.ts test/supplier.test.ts test/order-supplier-allocation.test.ts test/refund-order-materialization.test.ts test/refund-earned-income.test.ts test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/split-order-line-finance.test.ts test/admin-refund-operation-service.test.ts test/admin-refund-creation-quote.test.ts test/order-reward.test.ts test/store-order-refund-postgres-migration.test.ts test/supplier-operations-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

All tests use synthetic checkout/payment flags and test-owned PostgreSQL;
`fetch` is forbidden. They do not prove an external payment, shipment, live
Hyperdrive, workerd, CI, browser or production role acceptance.

## Remaining release gates

2026-09-16 follow-up: [atomic completion candidate](refund-atomic-materialization.md)
composes the durable server-selected v2 application with the actual financial
finalizer in one SQL transaction. The paragraph below describes this earlier
increment; default/public activation and the other release gates remain open.

Customer refund finalization and candidate physical materialization are still
separate test transactions. Atomic integration into the runtime finalizer,
guarded DDL/catalog/ACL installation, all read/delete/reporting adapters,
invoice/promotions, gift-only remainder, merchant freight and coordinated release
remain open. The new latent fulfillment path becomes relevant only to marked
orders; this is not activation or historical data repair.

Workers/PostgreSQL skills guided compact bounded evidence, existing lock order,
SQL-only transaction boundaries and lock-after-wait/rollback verification.
Current [Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html)
were retrieved. Installed Workers types 5.20260828.1 and Hyperdrive/Wrangler
definitions were checked using the documented fallback after the earlier npm
retrieval restriction. No binding, dependency or global database setting changed.
