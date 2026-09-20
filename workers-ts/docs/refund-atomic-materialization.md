# Atomic refund completion candidate

Schema follow-up: [refund split installation and registration](refund-split-installation.md)
adds the controlled maintenance/ORM completion path and numbered registries.
The public v2 creator and the remaining business/release gates are not activated.

Latest invoice increment: [unissued application allocation](refund-invoice-allocation.md).
Supported pending/rejected applications now follow actual atomic refunds;
issued invoices and the broader rollout gates below remain unresolved.

2026-09-16. Local candidate only. No production connection, image/cache change,
browser rerun, staging, commit, push or deployment. The user's confirmation that
the new product images are readable remains recorded separately.

## Reproduced gap and execution contract

Two initial native PostgreSQL tests showed that the actual financial finalizer
did not append a physical split receipt, and a failing split-receipt insertion
could not roll back the already committed financial refund. The standalone
materializer was not an atomic integration.

The server-only `applyOrderRefundWithMaterialization` creator now reserves exact
quantities with durable version `refund-quantity-materialization-v2`. It requires
explicit selections and validates modern line finance, supported lifecycle,
ownership, absence of prior unmaterialized completed claims, and candidate table
availability. It never installs missing tables or falls back to v1. No HTTP
controller, route, request-body flag or runtime configuration selects this
creator. The ordinary creator still writes v1.

Once admitted, the stored version determines execution through the actual
balance finalizer, provider response, callback and reconciliation. A fresh
service instance does not need the original invocation's options. Existing v1
applications cannot be upgraded by replaying them through the candidate creator.

## Transaction and recovery

- Execution locks the refund, then the original payment root, then the source
  order and carts, before users and financial writes. The root/source association
  and source type are rechecked after waiting. The materializer's later locks
  are reentrant locks already owned by the same transaction.
- The real finalizer performs its existing wallet, points, earned income,
  brokerage, stock, refund/status and supplier refund writes, then physical
  order/cart and supplier-ledger partitioning, then the locked operation receipt.
  A failure at any tested stage rolls back the entire local business completion.
- A terminal v2 refund must already have its immutable receipt with the exact
  fingerprint and source ID. Replay cannot repair missing evidence or create
  physical orders after money was committed.
- Original application replay remains valid after first materialization turns
  its source into an audit root, but new applications on that root and replay
  with changed selections are rejected.
- A persisted provider `SUCCESS` with an unfinished local refund is now eligible
  for scheduled recovery. It validates the immutable amount/identity and retries
  only local finalization: no second provider request or query. The provider
  result deliberately survives local rollback; it cannot be downgraded to
  `UNKNOWN` by a failed recovery. Query cooldown/claiming remains in place.
- `UNKNOWN` still uses the existing query path and the original payment-root
  order number, transaction ID, total amount and refund number, including refunds
  of a physically materialized remainder.
- Refusal/cancellation release their exact holds without requiring physical
  materialization eligibility. For example, a newly added invoice can prevent
  payout admission without preventing rejection of that application.

This is a local SQL atomicity guarantee, not a distributed transaction with a
payment provider. External success and local failure are an explicitly tested
recoverable state.

## Verification

Initial two tests failed as expected before integration. The first overlapping
five-file run then reported **118 passed / 12 failed**. All failures came from
the existing pink lock suite directly inserting unversioned refund rows for
modern real-checkout orders. The suite now invokes the actual automatic refund
application service, preserving its real order/payment/concurrency assertions.
No production evidence validator was relaxed to accept incomplete snapshots.

The next native run passed **2 files / 33 tests**, zero skips, **31.68 seconds**.
It included 21 new atomic tests and all 12 pink lock-order tests. Both TypeScript
configurations passed at this stage. Expanded final native regression passed
**21 files / 473 tests**, zero failures/skips, **305.00 seconds**. The atomic
suite now has **26 tests**. Both final TypeScript configurations passed with
explicit exit codes zero. Overlapping run counts must not be added.

Coverage includes successive refunds before/after receipt, exact customer cash
55.00 and 100 spent points returned, supplier 31.00 income/expense conservation,
independent platform orders, further fulfillment forks, original application
replay, provider-success/local-failure recovery by a fresh service instance,
unknown-result recovery, duplicate callbacks and terminal replay, unsupported
admission, missing schema/receipt, and rollback on order/cart/supplier/receipt and
late operation-audit failures. Independent connections observe exact PostgreSQL
blocker PIDs; NOWAIT verifies a root waiter has not already locked the child or
users, changed parent association is rejected, and duplicate actual finalizers
settle once. Provider adapters are mocks and all external `fetch` is forbidden.

Isolated native PostgreSQL 16.15 runs (non-superuser `finance_test`):

| Cluster under `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-3IS8Sx` | 57427 | Initial 2 reproduced failures |
| `finance-postgres-cmvbuY` | 55491 | 118 passed / 12 fixture failures |
| `finance-postgres-EAsiNb` | 53694 | 2 files / 33 passed |
| `finance-postgres-m6CRR6` | 61677 | Final: 21 files / 473 passed |

All four runners reported remaining fixture count zero and shutdown. Every
exact directory was independently audited: `pg_ctl status` exit 3, no PID or
bootstrap-password file, and no listener on its recorded port. Final process
count for the trusted PostgreSQL test binary was zero. Stopped local diagnostics
are retained, not broadly deleted.

The final batch includes all 17 files listed in the preceding
[fulfillment-branch regression](refund-fulfillment-branches.md#verification),
plus `refund-atomic-materialization`, `refund-quantity-reservation`,
`pink-refund-lock-order-postgres` and `scheduled-maintenance` test files.

Reproduce the focused candidate and compatibility checks from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-atomic-materialization.test.ts test/pink-refund-lock-order-postgres.test.ts test/refund-quantity-reservation.test.ts test/scheduled-maintenance.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Remaining release gates

2026-09-16 follow-up: [invoice admission and concurrency](order-invoice-admission.md)
repairs the actual customer invoice writer's locks, refund eligibility and
current-generation amount. It does not remove the existing invoice gate or
claim that document cloning and issued-invoice lineage are implemented.

Default/public creation and coordinated rollout are **not activated**. Guarded
DDL/catalog/least-privilege installation, current-generation read/delete/reporting
adapters, invoice/promotional ownership, gift-only remainders, merchant freight,
and pink group-member/physical-child identity remain open. Pink is explicitly
rejected by v2 admission before its different inventory/group lock graph is
entered; its existing v1 path and lock adapter are preserved. This increment
does not claim that the new candidate is a complete PHP migration or safe for
unrestricted production activation.

Workerd, live Hyperdrive cache/freshness, genuine provider integration, production
roles, browser acceptance and CI remain separate acceptance requirements.
The original nine staged entries and checklist totals (**240 checked / 164 open
/ 404 total**) remain unchanged. Parent migration/release gates are not closed.

Workers and PostgreSQL skills guided durable bounded evidence, root-first lock
ordering, SQL-only short transaction boundaries and real rollback/wait tests.
Current [Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PostgreSQL 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html)
were retrieved. The installed Workers types 5.20260828.1 and local Wrangler
Hyperdrive definitions were used after the documented npm retrieval restriction.
No dependency, binding or global database configuration was changed.
