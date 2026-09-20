# Refund history and returned-point generations

Follow-up: [earned-income ownership across generations](refund-earned-income.md)
addresses the ancestor gift/commission gap below. The 252-test record in this
document remains the earlier generation-adapter result, not the follow-up run.

2026-09-15. Local runtime-adapter increment, **not deployed**. The structural
materializer still has no runtime caller. These adapters prepare real refund
application, finalization and point-return services to consume its remaining
orders without changing immutable original application/payment identities.

## Reproduced failure and implemented behavior

The previous structural suite exercised two successive materializations, but
not the next refund on the retained remaining order. An added actual
checkout/application/finalizer/materializer test failed on the third application
with `历史退款商品快照无法定位`; 35 existing tests passed. Its previous completed
application referred to a source cart already consumed by physical splitting.
The order ID stayed the same while its quantities and financial totals changed.

The accepted pending-order sequence is:

| Refund | Application order before refund | Cash returned | Remaining order after materialization | Points returned this time |
| --- | --- | --- | --- | --- |
| First | Original root: 55.00, three units | 12.80 | New child: 42.20, two units | 20 |
| Second | That child: 42.20, two units | 12.80 | Same child ID: 29.40, one unit | 20 |
| Third | Same child: 29.40, one unit | 29.40 | Whole refund; no empty child | 60 |

The original refunds still bind their original source orders and cart snapshots.
The second refund's old 20-point return must not be deducted from the third
refund's new 60-point entitlement. Tests verify 55.00 cash and 100 total spent
points returned, stock restoration, original-row preservation and terminal replay.
Initial `paid=1` is fixture setup, not a verified original customer payment.

## Persistent generation contract

- Materialized child cart snapshots now use `refund-order-line-finance-v1` and
  an explicit `{ refundId, role }` marker. All active remaining carts must share
  one valid remaining-generation marker. Missing markers on this version,
  mixed/stale markers, wrong ownership/root, changed cart identity/quantity and
  incomplete generation chains are rejected.
- The candidate evidence table now has required `previous_refund_id` and
  `returned_point_bill_ids` columns. The parent ID is older than the receipt;
  exact baseline bill IDs are captured before structural mutation in the same
  transaction, not inferred from timestamps, maximum IDs or a cash ratio.
- The baseline covers existing deduction-point and redemption-point return
  bills scoped to the source owner and order/compatible refund numbers. Original
  ledger rows, amounts and associations are never rewritten. Only a retained
  same-ID remaining order inherits this exclusion baseline; a new remaining
  order does not inherit its parent's bill IDs.
- `RefundOrderGeneration` queries compact metadata and only the latest bounded
  cart partitions. It does not select or repeatedly parse the full 16 MiB source
  snapshots. A partial `(remaining_order_id, refund_id)` index supports the lookup.
- Existing completed business rows being excluded are checked against the exact
  same versioned fingerprint used by materialization replay. No ID cutoff alone
  authorizes exclusion. Missing old business rows do not erase durable evidence;
  changed surviving rows fail closed.
- The fingerprint implementation moved to `RefundOrderSplitIdentity` without
  changing its version, fields or canonical serialization. It is not a new
  receipt identity or a replacement operation key.

The schema/DDL remains a **candidate**, absent from the schema aggregate and
installation chain. This extends the previous undeployed candidate, not an
installed-table upgrade or a backfill of older child rows. Both required columns
and their constraints must be covered by the future guarded installer/catalog.
Fixture-owner corruption tests deliberately disable a local row trigger; they
do not demonstrate production least-privilege protection against an owner.

## Real service connections

1. Application/quotation still reads the complete original application list for
   idempotent replay and open-refund checks. After order/cart locks, only proven
   materialized history is removed from current cash, quantity and line pricing.
   The internal Admin quote retains its full `previousRefunds` evidence; a
   read-only quote test verifies no application, sequence or financial writes.
2. Finalization validates the generation before its cumulative amount/quantity
   totals. It excludes exact proven old claims, then validates the same current
   generation in the shared line-compensation plan before user locks or writes.
3. That plan carries exact old point-return bill IDs into reward reversal.
   Returned bills from the new generation still count normally. A multi-refund
   current-generation test and an unrelated-order bill prove this is neither
   "ignore every old bill" nor "reset all prior compensation."
4. Privileged execution checks generation evidence before new provider intent
   admission. Marked evidence corruption after application must reject before
   payment-row insertion or provider transport. Terminal original-key replay
   retains its existing path and does not re-run compensation.
5. Materialization validates the preceding generation and captures the new
   boundary together with order/cart/evidence writes. An exception rolls back
   these writes. It still runs separately from monetary finalization in fixtures;
   this does not prove a combined production commit boundary.

Unmarked existing orders do not query the candidate table. Their cash-ratio
legacy compatibility is unchanged. A marked order with a missing table, column
or record fails closed; there is no runtime installation/repair or error fallback
to the unmarked path. Tests cover both marked failure and unmarked operation
with the candidate table absent.

## Bounds, remaining work and acceptance limits

Generation history is bounded at 201 receipts per retained order, 200 active
cart snapshots, 1,024 baseline return-bill IDs and 16 KiB baseline JSON. The
return-bill capture reads at most 201 completed source applications; cancelled
applications do not consume that limit. Line compensation permits the bounded
combination of archived generations and current completed claims before its
existing 200-prior/201-projected calculation limit. These rejection bounds are
not a large-order capacity benchmark.

This increment resolves current cash/quantity history and returned spent-point
boundaries. It does **not** resolve already-earned product/payment gift points,
experience or brokerage income whose original ledger still belongs to an
ancestor order. Supplier-income ownership, receipt-time awards, propagation
through later fulfillment/supplier splits, customer/Admin/supplier physical
read associations and terminal deletion behavior also still require integration.
In particular, an inherited cart marker is not automatically evidence that a
later fulfillment child owns the recorded remaining order.

Physical writes must still be composed with finalization under one coordinated
refund/root/child/cart/user lock hierarchy and commit/recovery protocol.
Invoice/promotion/coupon ownership, gift-only remainder, independently evidenced
merchant freight and guarded DDL/ACL/catalog installation remain open. Do not
activate the materializer based on these passing cash/point tests alone.

Native SQL and actual services are used locally. WeChat transport is mocked,
including UNKNOWN recovery with the original root total 55.00 for all three
refunds. Global fetch is forbidden. No live provider, initial payment, workerd,
Hyperdrive, production role/catalog, browser, capacity, CI or deployment
acceptance is claimed. The PHP source was read; no historical MySQL copy or
row reconciliation is required for this new system.

The Workers/PostgreSQL skills guided awaited bounded work, compact indexed
history reads, consistent pre-user-lock validation and rollback tests. The
[official Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
installed Workers types 5.20260828.1, complete Hyperdrive interface and local
Wrangler schema were consulted. Latest npm retrieval was denied (`EACCES`);
no dependency, binding or configuration was changed. The user's confirmation
that new images load is retained, without further image/cache or production
writes, browser reruns, staging, commits, pushes or deployment.

## Verification and retained run history

Final native PostgreSQL **16.15** run: **10 files / 252 tests passed**, zero
failures/skips, 180.56 seconds, under the isolated non-superuser `finance_test`
role. The materialization suite is now **59 cases**, including **24 added in
this increment**. The new cases cover the three-refund sequence, read-only
Admin quote evidence, nine corrupt-generation cases, missing-table behavior,
four DDL metadata bounds, removed old business history, multiple returns within
one generation, unrelated bills, late finalizer rollback, provider pre-admission
rejection, original-channel recovery and two native lock races.

Both new independent-connection races prove the exact blocker with
`pg_blocking_pids`: one during application, one during finalization. While the
worker waits for the cart row, the holder acquires both settlement users with
`FOR UPDATE NOWAIT`, changes the marker and commits. The waiting operation
rejects without application, cash, point or stock side effects. These are in
addition to the original three structural-materialization races.

The nine other files cover line compensation/quotation, physical fulfillment
identity and line finances, supplier ledgers, immutable Admin operations and
creation quotation, rewards and static refund transaction contracts. Passing
these overlaps is not acceptance of physical materialization through all those
runtime paths or of earned-income ownership across ancestors.

Run history, not cumulative independent passes:

- First reproduction: 35 passed / one failed on the third application's
  missing historical cart. No assertion was weakened to accept that failure.
- Initial adapter: 4 files / 111 passed, before compact generation columns and
  the later provider-admission/bounds changes.
- Expanded adapter: 10 files / 244 passed, 161.71 seconds.
- Final run above adds eight admission, DDL, rollback and lock cases. Both final
  TypeScript configurations passed; the main configuration includes expanded
  top-level tests, and the runtime configuration has its separate runtime scope.

Touched tracked files and candidate source/test/docs passed whitespace checks.
Existing Windows Git LF/CRLF warnings did not change line-ending settings.
All four runners reported zero remaining fixture databases/roles and stopped.
Independent read-only checks confirmed `pg_ctl status` exit 3, no PID or
bootstrap-password file and no listeners for each cluster:

| Cluster under ignored `.cache` | Port | Run |
| --- | --- | --- |
| `finance-postgres-wpkOet` | 50784 | Reproduced third-application failure |
| `finance-postgres-TGtmpC` | 64564 | Initial 111 tests |
| `finance-postgres-vFVpXB` | 57213 | Expanded 244 tests |
| `finance-postgres-2B8MOq` | 53359 | Final 252 tests |

Final independent process inspection found zero instances of the trusted test
PostgreSQL executable. Private cluster inspection used narrowly approved
read-only access. Stopped diagnostic directories were retained, with no broad
deletion or unrelated service action. Original nine staged files and checklist
totals **240 checked / 164 open / 404 total** remain unchanged.

Reproduce from `workers-ts` using the trusted local runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-order-materialization.test.ts test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/split-order-line-finance.test.ts test/supplier-split-ledger.test.ts test/admin-refund-operation-service.test.ts test/admin-refund-creation-quote.test.ts test/order-reward.test.ts test/store-order-refund-postgres-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```
