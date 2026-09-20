# Supplier split-order history audit

Local candidate, 2026-09-16; not deployed. Scope is only
`GET /supplierapi/order/split_order/:id`. It does not close SUP-001.
The user's confirmation that new product images are readable is already
recorded separately; no image replacement or cache operation was repeated.

## Reproduction and change

Native PostgreSQL 16.15, real Hono Supplier routes/JWT/role middleware and the
actual checkout/allocation/refund finalizer reproduced:

- A partial refund leaves multiple status-zero children. The original history
  reader reused pending-delivery resolution and rejected a root history request.
- A second refund committed between child-header and cart reads mixed old
  42.20/two-item headers with current 29.40/one-item carts.
- Child selection lacked customer/store scope; cart reads did not check customer
  ownership, permitting inconsistent snapshots to be returned.

The initial four-case run had three business failures and one **fixture**
failure: cloned order headers reused the `(unique, uid)` key. Giving the two
synthetic rows independent unique keys allowed the repeat four-case red run.
No fabricated SQL result or mocked refund result was used. Only the request's
container factory selects the isolated database; external fetch is forbidden.

`SupplierFulfillmentService.splitOrders` now delegates to
`SupplierSplitOrderReadService`. Delivery, split-delivery, receipt, refund,
invoice and ledger write bodies were not changed.

- Reference/root/child headers and carts are read in one `REPEATABLE READ,
  READ ONLY` transaction. The local statement timeout is at most five seconds,
  preserving stricter session timeouts and restoring settings afterward.
- History does not require a unique pending child. Three genuine refund stages
  retain the same 55.00 family total, without including the payment root twice.
- The requested order is supplier-scoped. Root UID must match; supplier-owned
  roots must also match store. Completed platform-owned allocation roots can be
  resolved only through an owned child, never requested directly. Child rows
  match supplier, UID, store and non-system-deleted scope.
- Existing ascending ordering, snake-case fields, parsed cart DTO and
  customer-deleted staff history remain. The existing no-visible-children
  historical root fallback is retained only for an owned root. This is a
  history response, not a guarantee that the root remains deliverable.
- Cart UID and explicit supplier/type metadata are validated. Each order may
  independently use the legacy all-zero ownership fallback; mixed metadata
  within one order, store carts and foreign metadata fail explicitly.
- SQL selects only used scalar fields and at most 201 headers/201 carts. More
  than 200 children or **200 carts across the whole response** is rejected, not
  silently truncated. Cart JSON is limited to 64 KiB UTF-8 before SQL transport;
  unrelated promotion/private order TEXT is not selected. Nonempty snapshots
  must be valid JSON objects; SQL NULL/empty strings retain legacy null display.
- Numeric service identities must be positive PostgreSQL int32 values. This
  increment does not change the shared controller's textual ID normalization.

The PHP controller at `C:\cinagroup\cinashop-php\app\controller\supplier\Order.php`
is a sibling-checkout reference, not a repository dependency: its
`Order::split_order` reads history without a pending-delivery prerequisite.
The broader PHP relations/DTO are **not** claimed as fully migrated.

Workers and PostgreSQL skills guided bounded transport, snapshot consistency
and isolated least-privilege verification. References:
[PostgreSQL 16 isolation](https://www.postgresql.org/docs/16/transaction-iso.html)
and [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
Existing installed Workers types 5.20260828.1 were used after the previously
failed latest-types lookup. No binding, DDL, production ACL or configuration
was changed.

## Verification

The explicit maintenance-runner allowlist contains
`test/supplier-split-order-reads.test.ts`. Its first green run passed all ten
tests in 76.24 seconds. The suite covers concurrency, history, ownership,
allocation roots, legacy DTOs, exact and overflow row/byte boundaries, private
TEXT exclusion, actual auth and an independent SELECT-only LOGIN with no table
ownership, UPDATE, superuser, CREATEDB, CREATEROLE or BYPASSRLS privileges.
Revoked SELECT raises PostgreSQL 42501, not empty success.

Final commands, using the existing trusted Node and PostgreSQL16 binaries from
`workers-ts`:

```text
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-split-order-reads.test.ts test/supplier-order-generations.test.ts
node node_modules/vitest/vitest.mjs run test/supplier-split-fulfillment.test.ts test/supplier.test.ts test/supplier-operations-migration.test.ts test/supplier-rbac-migration.test.ts test/supplier-picking-sheet-migration.test.ts test/local-finance-postgres-runner.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

The final joint run passed **2 files / 32 tests** (10 split-history and 22
existing Supplier list/detail), zero failures/skips, in **158.56 seconds**.
The final six-file regression passed **64 tests**, zero failures/skips, in
**7.83 seconds**. Both TypeScript configurations and runner syntax passed.
Early checks found unused imports while the tests/extraction were being
assembled; these were corrected before the final checks. Intermediate red or
green runs are not added to the final test counts.

| Owned cluster under `.cache/` | Port | Run |
| --- | --- | --- |
| `finance-postgres-5yAWbb` | 56791 | 3 business failures and 1 fixture failure |
| `finance-postgres-WQbup2` | 56142 | Corrected fixture, 4 red cases |
| `finance-postgres-H2CHYC` | 54573 | First 10-test green run |
| `finance-postgres-fKR420` | 63660 | Final joint 32-test run |

Every runner reported zero remaining fixture databases/roles and a stopped
cluster. Independent verification with the owning Windows identity confirmed
`pg_ctl status` exit 3 for all four, no PID/bootstrap password files, no listeners
on the four ports and zero processes using the trusted test `postgres.exe`.
The initial sandbox-only status probes were denied by those private directory
ACLs and were **not** taken as shutdown evidence. Stopped diagnostic directories
are retained; no unrelated service or directory was stopped or removed.

## Remaining work

Picking sheets, split-cart active selection, status logs, reports/exports,
full legacy contracts and Supplier page/session lifecycle acceptance remain
open. No rendered frontend was changed or tested in this increment. Real
production roles, Redis/provider/Hyperdrive, workerd/Linux CI and coordinated
deployment are not covered by the local Node/PG tests. Existing staged work
is preserved; no staging, commit, push or production deployment occurred.
