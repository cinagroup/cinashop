# Physical refund order persistence candidate

2026-09-15. Local structural component, **unwired and not deployed**. This
increment writes actual selected/remaining orders and carts in isolated SQL
tests. It does **not** complete physical refund migration: refund finalization,
financial ownership and the readers/writers below still need joint integration.

Subsequent increment: [refund history and returned-point generations](refund-order-generations.md)
connects remaining-generation evidence to actual quote/application, finalizer
totals and spent-point return calculations. It adds compact generation columns,
an indexed lookup and an explicit child snapshot version/marker. The initial
35-case/201-test results below remain historical; physical writes themselves
are still unwired, and earned-income/ledger/lifecycle ownership remains open.

## Implemented boundary

`RefundOrderMaterialization.materializeCompletedRefundOrder` requires a
caller-owned transaction, the original refund identity and a completed refund.
The caller must authorize the operation. The component neither pays nor settles
users, stock or supplier balances, and never rewrites the original refund,
provider payment, Admin creation receipt or Admin operation receipt.

- First split: create selected and remaining children, retire the root with
  `pid=-1`, retain its payment/financial snapshot and retire its cart rows from
  further splitting. Audit root rows are not additional fulfillable goods.
- Later split: create the selected child but retain the remaining order's ID,
  public number and unique key. Surviving remaining carts retain their row/cart
  identities. Only fully consumed source carts are deleted; their complete
  pre-split snapshots and selected-child mappings are stored in the evidence.
- Whole refund: retain the existing order, clear completed cart refund counters
  and create no new order/cart identities or empty remaining child.
- Child totals use the checked modern line allocation, including four-place
  arithmetic, money/whole-point truncation, freight charged to the customer,
  commission bases, residue and write-off counters. Received remaining orders
  retain received status; they are not reset to unshipped. New carts use the
  existing owned sequence, synchronized numeric cart IDs and embedded IDs.
- Fresh remaining pickup codes are generated on the first split when needed;
  the selected refund child cannot retain an active pickup code.

The original 55.00 fixture partitions one selected unit into 12.80 and 42.20,
spent points into 20/80, product gift points into 100/100 and commission bases
into 0.30/3.30. These are child allocations, **not another payment or reward
settlement**. Tests compare finance/stock state before and after materialization.

## Durable identity and concurrency

The candidate `store_order_refund_split` table records the original refund,
source order and payment root, selected/remaining order IDs, full pre-split
evidence and per-cart quantity/identity mappings. A versioned SHA-256 fingerprint
binds the original owner, refund amount/number and canonical quantity reservation.
Same-identity replay returns the original committed result, even if source
business rows were later removed; it does not reconstruct missing business rows
or certify their current existence. A changed identity fails closed.

Lock order is refund advisory/row, payment root, source child, then cart rows in
ascending ID order. Parentage and ownership are checked again after waiting.
The helper must not be called after user/cart settlement locks: its hierarchy
must be integrated at the beginning of the real finalization transaction.
No provider or other external network calls occur in this component.

It rejects incomplete/malformed modern financial or quantity evidence,
contradictory counters, mismatched compensation, unresolved other applications,
changed owners and missing sequence ownership. It validates terminal provider
evidence against the original source and payment-root amount. It never repairs
schema, sequences or unexplained financial counters at runtime.

Bounds include 200 source carts, 100 selected lines via the reservation
contract, 1,000 existing children, 64 KiB per cart snapshot, a 16 MiB source
snapshot and 128 KiB partition/fingerprint inputs. These are safety limits,
not capacity acceptance or proof that every valid large order is supported.

The new schema is deliberately **not exported by the schema aggregate**, and
the candidate DDL is **not registered in MigrationService or an installation
chain**. Tests explicitly install that DDL in isolated fixtures. Checks enforce
identity/fingerprint/disposition and bounded JSON shape; triggers reject row
updates, deletes and table truncation. These owner-created fixture protections
are not proof of production least-privilege ACLs or protection against an owner
altering/dropping triggers. No foreign keys tie durable evidence to deletable
business rows. Production catalog, guard and role acceptance remain required.

## Why runtime activation remains open

PHP first creates physical children and changes `refund.store_order_id`. The
TypeScript Admin/provider protocols instead preserve reviewed original identity.
Directly moving that association, or simply shrinking an existing remaining
order, can invalidate completed-claim replay, compensation and income ownership.
The new record preserves the information needed by adapters; it is not those
adapters. The following work remains necessary:

1. Compose physical writes, compensation and terminal evidence in one correct
   finalizer transaction/recovery protocol, including root-before-child locks.
   Current fixtures finalize first, then call this component in a separate
   transaction; they do not prove that joint atomic boundary.
2. Resolve historical/current claim ownership for quotation, later refunds,
   rewards, brokerage, supplier income and receipt/fulfillment readers. Preserve
   original Admin/provider receipts while resolving new physical associations.
3. Partition invoice/promotion records, coupon/gift ownership and remaining
   lifecycle fields with dedicated acceptance. Copying the source order is not
   acceptance of these business associations.
4. Settle an unshipped gift-only remainder with its stock and entitlements. The
   candidate currently rejects it; it does not expand the reviewed selector.
5. Allocate nonzero merchant shipping expense (`freightPrice`) from independent
   evidence. Partial materialization currently rejects it, rather than deriving
   merchant expense from customer postage. Whole refunds preserve that expense.
6. Add guarded installation/catalog/ACL coverage, then runtime, Hyperdrive,
   provider, browser, capacity, CI and deployment acceptance. No new endpoint or
   feature activation is included here.

These are dependencies toward the original migration outcome, not alternate
definitions of completion. The broad physical-split checklist stays open.

## Verification scope

The focused suite contains 35 cases covering first/later/whole and received
orders, fractional point/gift residue, retained cart identities, pickup codes,
write-off partitioning, changed replay identities, corrupt evidence, missing
sequences, three late-write rollback points, durable replay and append-only DDL.
Gift-only remainder and merchant expense are explicitly tested refusal gates.

Three native independent-connection cases use `pg_blocking_pids` to prove the
actual blocker: duplicate materializers, a cart-evidence change during a lock
wait, and root-before-child acquisition with changed parentage after waiting.
The last test also proves the waiting materializer has not taken the child lock
by acquiring it from the root-lock holder with `FOR UPDATE NOWAIT`.

Checkout, applications, completion and selected receipt paths use actual
services and native SQL. Initial `paid=1` and write-off counters are fixture
setup, not an initial payment or real write-off endpoint test. WeChat
UNKNOWN-to-SUCCESS transport is mocked; provider replay after structural
materialization retains the original refund/payment row without another write.
Global fetch is forbidden. A static test verifies intentional nonactivation;
it is not a runtime integration test. No live provider was contacted.

Workers/PostgreSQL skills guided awaited bounded transaction-local writes,
durable evidence and lock-order verification. Current official Workers guidance,
installed Workers types 5.20260828.1, the Hyperdrive interface and local Wrangler
schema were consulted; latest npm retrieval was denied. No dependency, binding
or configuration changed. User confirmation that new images load is retained;
there were no image/cache or production writes and no browser rerun.

## Results and reproducibility

Final native PostgreSQL **16.15** regression: **7 files / 201 tests passed**,
zero failures/skips, 149.47 seconds, using the isolated non-superuser
`finance_test` role. Overlaps cover line compensation, line quotation,
fulfillment cart/refund identity and financial partitioning, supplier ledgers
and immutable Admin refund operations. This is not a repository-wide run or
acceptance of physical materialization through those existing runtime paths.

Run history is retained without adding overlapping passes together:

- Initial focused structural suite: 28/28 passed.
- Expanded suite and six overlaps: 201/201 passed in 138.83 seconds.
- Both initial typechecks found the same unused `Order` type alias (TS6196).
  Removing that alias changed no runtime behavior. Both final TypeScript
  configurations and the final 201-test batch above passed after the removal.

The main TypeScript configuration includes source, scripts and top-level tests;
the runtime-test configuration covers its separate runtime scope. Touched tracked
files and all five new source/test/doc files passed whitespace checks. Windows
Git emitted its existing LF/CRLF warning; line-ending configuration was unchanged.

Every runner reported zero remaining fixture databases/roles. Independent
read-only shutdown checks found `pg_ctl status` exit 3, no postmaster PID or
bootstrap-password file, and zero listeners for all three clusters:

| Cluster under ignored `.cache` | Port | Run |
| --- | --- | --- |
| `finance-postgres-Ubdc6N` | 60648 | Initial 28 cases |
| `finance-postgres-565Dx0` | 58747 | Expanded 201 cases |
| `finance-postgres-pRUIXE` | 59120 | Final 201 cases |

Final independent process inspection found zero instances of the trusted test
PostgreSQL executable. The read-only audits used narrowly approved access to
private test-cluster state. Stopped diagnostic directories were retained; no
filesystem deletion or unrelated PostgreSQL service action occurred.

No staging, commit, push or deployment was performed. The original nine staged
files and checklist totals **240 checked / 164 open / 404 total** are unchanged.
Reproduce from `workers-ts` with the trusted local runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-order-materialization.test.ts test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/split-order-line-finance.test.ts test/supplier-split-ledger.test.ts test/admin-refund-operation-service.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```
