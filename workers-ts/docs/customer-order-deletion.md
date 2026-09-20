# Customer order deletion and refund generations

2026-09-16, local candidate only. This records the backend extension to the
customer order read audit for `POST /api/order/del`. A subsequent increment adds
PC and UniApp list controls, explicit confirmation and page-one reconciliation;
see the latest entry in `MIGRATION_CHECKLIST.md`. The backend evidence below is
retained separately. No public-v2 activation, production database write or
deployment is included. The accepted product-image fix is unchanged.

The opt-in joined acceptance now exercises the built PC and UniApp H5 through
real loopback HTTP, the assembled Hono routes and independently authenticated
non-owner PostgreSQL sessions. It is distinct from the prior intercepted-HTTP
frontend test and from production acceptance.

## Contract and red evidence

PHP `StoreOrderServices::removeOrder` (line 1842) permits tidy states `0`, `-2`
and `4`. The same service's `tidyOrder` maps these to unpaid, fully refunded and
transaction-completed, respectively. Raw status `2` is **pending review**, while
raw `4/5` means incomplete shipping/writeoff; a numeric `status>=2` check is not
equivalent to this contract.

Six native PostgreSQL tests failed before the fix: deletion rejected a refunded
physical child and an unpaid order, accepted each of raw statuses `2/4/5`, and
accepted an order with a real pending refund but a stale summary flag. All six
original assertions passed after the implementation change.

Current admission rules:

| Order state | Deletion behavior |
| --- | --- |
| Unpaid, status 0 | Reuse the actual atomic cancellation transaction |
| Paid, fully refunded (`refundStatus=2`) | Soft-delete only; no compensation |
| Paid, completed (`status=3`, `refundStatus=0`) | Soft-delete only |
| Already cancelled, not yet hidden | Soft-delete only |
| Pending refund, review, shipping or writeoff | Reject |
| Payment audit root or allocation in progress | Reject; operate on a physical child |
| Foreign/system-hidden order | Reject |
| Already customer-deleted | Reject duplicate; no repeated effects |

Unpaid deletion records both the cancellation and `remove_order` audit events in
the **same transaction** as reservation release. This reuses existing stock,
activity quota, cart, points and coupon compensation. It does not copy PHP's
old unconditional re-compensation of already-refunded orders. Cancellation now
also rechecks system visibility after acquiring its order lock.

## Concurrency and retained records

For paid/already-cancelled orders, deletion takes the existing settlement
advisory lock and order row lock for the payment root before the physical child.
After all waits it rechecks owner, visibility, order number, parent identity,
payment and supplier/store relation, allocation and eligible terminal state.

It checks actual non-cancelled/non-deleted refunds in states `0/1/2/4/5`, not only
the order summary flag. That query deliberately takes **no refund row lock**:
refund execution already owns its refund lock before acquiring order locks.
Taking one in reverse order could deadlock. New refund applications serialize on
the order settlement boundary and recheck visibility after waiting.

The paid deletion transaction updates only `store_order.is_del` and inserts one
status row. Audit failure rolls back the visibility update. Refund applications,
cart snapshots, financial ledgers and protected generation evidence remain.
Deleting earlier completed children does not prevent the remainder's next
refund; completed finalizer replays and customer refund-history reads still work
after all three refunded children are hidden. The original payment audit root
is retained. No external I/O runs in these transactions.

## Verification and fixture corrections

`customer-order-deletion.test.ts` uses the complete 165-step / 270-table schema
and separately authenticated, non-owner runtime LOGINs. Twenty scenarios cover
the red cases, three successive real refunds, ownership/system visibility,
all five pending refund states, cancelled claims, late paid/unpaid audit failure,
duplicate deletion, observed owner/status/visibility/ancestry lock waits,
root-before-child ordering, queued refund application, and a real finalizer
paused after its refund row lock. Unpaid deletion losing to a synthetic committed
paid transition is also covered. `pg_blocking_pids` proves the relevant waits;
arbitrary delays are not treated as concurrency evidence.

Actual Hono controller requests verify `order_id` and legacy `uni`, invalid input
and missing identity. Identity headers are synthetic fixture middleware, **not
genuine production authentication**. Most paid state is synthetic. External
`fetch` is forbidden; no provider call is made. Financial/business/evidence state
is compared for unchanged rows and complete rollback where applicable.

An expanded run passed 29/30 tests; the finalizer-lock fixture alone failed
because it had changed the order to completed without settling the supplier
ledger. The fixture now retains the real unfulfilled status, fault-injecting
only the stale summary flag; the pending-claim and successful-finalizer assertions
remain unchanged.

The first activity regression had 33 passes and 8 failures. Six bargain failures
and two seckill lock-barrier failures arose from hand-inserted refunds lacking
the reservation required by checkout financial snapshots. Those tests now call
the actual v1 application/automatic-refund entrypoints and include their outbox
table. No financial check, inventory assertion, lock barrier or expected money
amount was relaxed; no production refund implementation changed for this repair.
The corrected native activity regression passed **41 tests / 3 files**, 47.61s.
The existing pink suite was not edited.

Final verification passed with no skipped tests:

- Native deletion and order-generation reads: **32 tests / 2 files**, 162.91s
  (20 deletion scenarios and 12 existing generation-read scenarios).
- Native bargain, seckill and pink regressions: **41 tests / 3 files**, 47.61s.
- Cancellation migration, runner, customer-list and after-sale contracts:
  **45 tests / 4 files**, 13.96s.
- Both unit and runtime TypeScript checks passed.

These are 73 native PostgreSQL tests and 45 local contract/unit tests, not a
production, browser or payment-provider acceptance result.

All six temporary PostgreSQL clusters used in this increment were independently
checked after their terminal runs:

| Cluster suffix | Port | Final independent state |
| --- | --- | --- |
| `rXIqIw` | 56414 | Stopped; no PID file, bootstrap password or listener |
| `V0dEQP` | 56045 | Stopped; no PID file, bootstrap password or listener |
| `D8mhTb` | 56886 | Stopped; no PID file, bootstrap password or listener |
| `KR3Ugw` | 52442 | Stopped; no PID file, bootstrap password or listener |
| `FGIqkx` | 55682 | Stopped; no PID file, bootstrap password or listener |
| `PSbzpy` | 55672 | Stopped; no PID file, bootstrap password or listener |

Each `pg_ctl status` returned 3. The runners reported zero remaining fixtures;
the final independent process check found zero PostgreSQL processes from the
trusted test runtime. Stopped diagnostic directories are retained.

The original nine staged paths remain untouched. Checklist counts remain
**240 checked / 164 open / 404 total**. No staging, commit, push, deployment,
production write, image change or cache operation was performed in this increment.

## Reproduction

From `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/customer-order-deletion.test.ts test/customer-order-generations.test.ts
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/bargain-inventory-compensation.test.ts test/seckill-concurrency-postgres.test.ts test/pink-refund-lock-order-postgres.test.ts
node node_modules/vitest/vitest.mjs run test/store-order-payment-cancel-migration.test.ts test/local-finance-postgres-runner.test.ts test/customer-order-list.test.ts test/api-order-after-sale-migration.test.ts --maxWorkers=2
npm run typecheck
```

## Open release gates

This is local backend evidence, not Cloudflare acceptance. Customer frontend
list controls/confirmation are now implemented and have passed local joined
browser-to-database acceptance. Native-device acceptance remains open, along
with staff deletion and reporting/export consumers, production runtime
privileges, genuine auth/provider/Hyperdrive/workerd and production-browser
testing, immutable CI and coordinated release remain open.
The broad checklist parent is not closed by this increment.

## Opt-in joined browser workflow

`test/browser/customer-order-deletion.acceptance.ts` and its permanent driver
run two full workflows, one per storefront, with the complete isolated schema.
Application SQL uses a separate LOGIN with verified `NOSUPERUSER`, `NOCREATEDB`,
`NOCREATEROLE` and `NOBYPASSRLS`. Only fixture setup/teardown holds maintenance
authority. The driver environment is allowlisted and asserts it received no
database URL, app key, Redis token or Cloudflare API token.

Seven SQL checkpoints per storefront verify cancellation without a write,
unpaid deletion and resource restoration after a committed-but-lost response,
refresh without replay, actual partial refund preparation, cancelled then
confirmed deletion of its physical child, unchanged financial/immutable
evidence and finalizer replay, retained refund-history rendering, and rejection
of a real pending refund hidden behind a stale order-summary flag. Missing,
forged and foreign JWTs and duplicate deletion are also rejected over HTTP;
all private responses remain `no-store`.

The actual JWT signature/password-digest/user-status middleware runs, but Redis
is absent under `NODE_ENV=test`. Payments are synthetic setup; the refund
application/finalizer and deletion run actual SQL. There is no provider call,
Cloudflare/workerd/Hyperdrive connection or native-device session. Site chrome,
cart badge and optional DIY navigation are shell-only stand-ins, never order,
refund or authentication response substitutes. Product media is outside scope.

Rebuild both storefronts before running against current source. From
`workers-ts`, set `TEST_BROWSER_PACKAGE_JSON` to an existing Playwright package,
`TEST_BROWSER_EXECUTABLE` to a trusted installed browser and
`TEST_BROWSER_OUTPUT_DIR` to an existing absolute directory **outside** this
repository. No dependencies are installed by the workflow:

```powershell
npm --prefix ../view/pc-ts run build
npm --prefix ../view/uniapp-ts run build:h5
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin audit:customer-order-browser
```

The exact command is admitted only in schema-maintenance mode; additional
suite arguments and repository-internal browser output are rejected before
starting a database. This is an explicit opt-in test, not a silently skipped
unit test. Screenshots and result files are written only to the supplied
external output directory. Browser, HTTP listener, runtime roles, fixture
database and owned PostgreSQL cluster are closed by their respective owners.

Workers/PostgreSQL skills guided reuse of the existing compensation transaction,
consistent lock ordering and exclusion of network I/O while holding locks.
Latest Workers-type retrieval was network-denied; installed **5.20260828.1**
Hyperdrive types and Wrangler schema were inspected using the skill fallback.
No dependency, binding or configuration was changed. References:
[PostgreSQL lock ordering](https://www.postgresql.org/docs/16/explicit-locking.html)
and [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
