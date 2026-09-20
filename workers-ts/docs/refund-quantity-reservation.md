# Refund quantity reservation candidate

2026-09-15. Local implementation; **not deployed**. New customer, Admin and
automatic refund applications now reserve selected cart quantities in the
application transaction. This is a prerequisite to PHP refund splitting, not
completion of physical split/order/allocation parity.

The subsequent [physical-split audit and cart-identity increment](refund-physical-split.md)
fixes new fulfillment children being rejected by refund creation, and records
the remaining physical refund integration requirements separately.

## Source reference and current contract

The sibling PHP `app/services/order/StoreOrderRefundServices.php` reserves
`store_order_cart_info.refund_num` within `applyRefund` (lines 267, 340–406),
and `cancelOrderRefundCartInfo` releases selected quantities on refusal or
cancellation (lines 449–521). `agreeSplitRefundOrder` (line 698) calls the
physical split service and changes refund/order associations. That last part
is not implemented by this increment.

`RefundQuantityReservation.ts` stores a server-generated versioned claim in
the existing refund `cart_info` JSON; no new table, migration, binding or
dependency is introduced. Each claim fixes the order/user, exact cart primary
key and canonical cart ID, quantity, prior counter and original cart total.
Selectors are explicit even when the caller requested all remaining goods.
The parser rejects unknown fields/versions, duplicate or mismatched selectors,
identity drift, non-integer quantities and oversized snapshots.

| Event | Cart quantity counter | Financial effect of this stage |
| --- | --- | --- |
| Read-only quote | Unchanged | None |
| Application commits | Prior counter + selected quantity | None |
| Application transaction fails | Entire reservation rolls back | None |
| Return approved / goods returned / provider UNKNOWN | Hold remains | Not evidence of settlement |
| Active application cancelled or refused | Release only its own held quantity | No new refund payment |
| Marked application settles | Retain counter; do not increment twice | Existing settlement and receipt transaction |
| Settlement fails after application committed | Hold remains for explicit recovery | Settlement effects roll back |

Current TypeScript counters therefore include settled quantities and a current
active hold. This does **not** claim PHP's full-refund counter reset or physical
selected/remainder-child redistribution. The before-counter is preserved as
observed; this code does not repair or backfill historical counters.

## Transaction and recovery boundaries

Application eligibility, quote reauthorization, reservation, application and
audit commit together; versioned Admin creation also records its creation
receipt in that transaction. Quote returns before reservation. Existing
matching creation receipts are recovered without adding a second hold.

Reservation locks cart rows in primary-key order after the shared order lock.
Cancellation/refusal/execution keep the refund → order → cart ordering (and
the existing activity/actor locks where applicable). Cancellation rereads the
refund under lock and checks current order ownership after acquiring the
order lock; the initial read is not authority to release quantities.

Release requires an active-state transition and exact current claim ownership,
identity, cart total and counter. A stale or edited claim fails closed; it does
not subtract an estimated amount or fix data. An audit failure rolls back both
the transition and release. An unknown/admitted provider result cannot be
cancelled or refused merely to free quantities.

The Workers and PostgreSQL skills guided short, awaited database transactions,
consistent lock ordering and keeping provider I/O outside reservation work.
No new external request or shared mutable request state was added.

## Legacy and rollout limits

- An existing unmarked application keeps the old settlement-time increment
  path. Its cancellation/refusal never decrements a counter it did not reserve.
  A present but invalid reservation marker cannot fall back to that path.
- Claims are internal trusted database records, not client-supplied request
  fields or a new independent immutable ledger. Direct administrative data
  edits still require reconciliation; removing a marker is not a repair.
- Upgrade **all application writers, decision executors and callbacks
  together**. Old executors do not understand the marker and could increment
  again at settlement. Do not roll back to them with marked work outstanding.
- Physical refund splitting, cart/order identity changes, postage/rounding,
  promotion/reward/supplier allocations, actual production roles, Hyperdrive
  and live payment-provider acceptance remain open. Original creation/financial
  receipt identities must remain recoverable across any future physical split.
- No production data/cache/image change, source MySQL reconciliation, commit,
  push or deployment was performed for this increment. Existing local staged
  files are not part of this change's publication.

See [Admin proactive creation](admin-refund-creation.md) for the separate
creation-versus-financial receipt protocol and earlier browser acceptance.

## Local verification (2026-09-15)

Final native PostgreSQL **16.15** regression: **11 files / 232 tests passed,
zero failures or skips**, 132.31 seconds. The new reservation suite contributes
32 cases, including four independent-backend lock-wait cases. These cover
competing applications, release followed by a queued new application,
settlement winning over cancellation, and order ownership changing while
cancellation waits. The other suites exercise Admin creation/quote/HTTP and
decisions, customer application/read/return, group cancellation recovery and
bargain inventory compensation. Both Worker source and runtime-test TypeScript
checks passed. Synthetic payment responses are not provider acceptance.

Failure history is retained rather than counted as passing evidence:

1. Initial six-file run: 142/143 passed. An invalid marked selector was rejected
   first by the legacy selection parser with a different error. Marked claim
   validation now precedes that parser; the assertion was not weakened.
2. Expanded eleven-file run: 228/229 passed. The group-cancellation fault test
   expected the pre-application cart counter after failed financial execution.
   The application had already committed its hold. The test now checks that
   exact claim/counter while preserving all balance/stock/group rollback
   assertions, repeats the failure without further changes, then verifies one
   recovered payment and no second quantity increment.
3. Final run above also adds legacy cancellation preserving prior settled
   quantities, direct root-client rejection and the ownership lock-wait case.

All tests use newly created loopback-only synthetic databases and a non-superuser
fixture identity (with database-creation permission for fixture isolation), not
production connections or a production least-privilege certification. Each
runner reported zero remaining fixture databases/roles. Independent `pg_ctl`
checks returned exit 3 for all three owned clusters: `finance-postgres-e8n4hg`
(port 62960), `finance-postgres-BFu4rZ` (59588), and `finance-postgres-eGzOVN`
(62331). No postmaster PID/bootstrap-password files, trusted-runtime processes
or listeners on those ports remained. Stopped ignored cluster directories were
retained; no broad filesystem deletion was performed.

This increment did not rerun a browser, the nine-path schema audit, deployed
Workers or Hyperdrive. The earlier browser result remains evidence of its own
tested revision, not a claim that the new backend was browser-tested. Migration
checkboxes remain **240 checked / 164 open / 404 total**.

Reproduce from `workers-ts` with the already installed local runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-quantity-reservation.test.ts test/admin-refund-creation.test.ts test/admin-refund-creation-quote.test.ts test/admin-refund-creation-http.test.ts test/customer-refund-application.test.ts test/customer-refund-read.test.ts test/pink-cancellation-refund-recovery-postgres.test.ts test/bargain-inventory-compensation.test.ts test/admin-refund-operation-http.test.ts test/admin-refund-decision-postgres.test.ts test/customer-refund-return.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```
