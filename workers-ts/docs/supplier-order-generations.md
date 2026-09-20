# Supplier order list and detail across refund generations

Local candidate, 2026-09-16; not deployed. This increment covers the existing
`GET /supplierapi/order/list` and `GET /supplierapi/order/info/:id` contracts.
It does not close SUP-001 or the complete migration checklist.

Follow-on local candidate: [split-order history audit](supplier-split-order-reads.md)
covers the separate history endpoint and its joint 32-test regression with this
list/detail suite. The remaining-scope notes below describe this earlier increment.

## Evidence and scope

The original list already excluded payment roots (`pid >= 0`), so no duplicate
root bug was claimed or "fixed" here. Three native PostgreSQL 16.15 red tests
instead established:

1. A real second refund committed after the list query but before its count
   produced two old rows with a new count of three.
2. The same interleaving in detail retained the old 42.20 header and two-unit
   count but returned the later one-product cart collection for 29.40.
3. A cart with the correct order ID but a different customer UID was returned
   successfully, rather than failing the inconsistent detail.

The first run exposed defects 2/3 (one pass, two failures). Its parallel count
had already run before the writer checkpoint, so the harness was strengthened
to gate execution of the **real** count query until the independent writer
committed. The second run reproduced all three failures. Neither harness
fabricates order/count/auth responses or replaces the refund finalizer.

PHP reference: `cinashop-php/app/controller/supplier/Order.php::lst` uses the
shared grouped order service with more selectors and relations. The existing
TypeScript flat list is not that full legacy contract. This change preserves
its descending-ID order, snake-case header, `count/page/limit`, keyword
precedence and wildcard matching. It does not add root-number discovery or
claim compatibility for PHP's full `lst` output.

## Implementation

`SupplierService` delegates only these two reads to `SupplierOrderReadService`.
Actual Supplier JWT/password/active supplier/tenant-bound role middleware is
unchanged. Tenant query parameters cannot override the authenticated supplier.

- Header/list/count and detail/carts use one short `REPEATABLE READ, READ ONLY`
  transaction. Local statement timeout is at most five seconds and never
  widens a stricter session timeout. No provider calls or writes occur inside it.
- Headers select the existing bounded scalar fields, not unrelated private or
  unbounded order TEXT columns. Internal customer UID does not enter the DTO.
- Detail reads at most 201 cart rows, rejecting more than 200. Combined UTF-8
  bytes of cart JSON and promotion TEXT are capped at 64 KiB per row by SQL
  CASE before transport; overflow fails, rather than silently dropping content.
- Cart UID must match the order. Explicit supplier metadata must match the
  authenticated tenant and accepted supplier types 0/2. The existing allocation
  service's all-legacy `type=0, relationId=0` fallback is retained only when the
  entire cart collection lacks ownership metadata. Mixed/foreign/store ownership
  is rejected, without looking up mutable current products.
- Valid snapshot strings remain strings; SQL NULL and legacy empty strings stay
  unchanged. Nonempty JSON must be an object. Invalid/array/JSON-null snapshots
  produce an error, not an empty-success or made-up current-product snapshot.
- System-deleted/foreign orders are hidden. Customer-side `is_del` does not
  remove staff history, preserving this Supplier contract rather than copying
  the different Admin visibility policy.
- Page 1–10,000, limit 1–100 (default 20), paid 0/1, status 0–5; keyword and
  payment-type lengths are bounded. Duplicate supported selectors and malformed
  numeric IDs fail before a business transaction. Unrelated pagination helpers
  used by other Supplier contracts are unchanged.

Workers/PostgreSQL skills guided bounded SQL transport, consistent reads and
separate runtime authority. Current [PostgreSQL isolation documentation](https://www.postgresql.org/docs/16/transaction-iso.html)
and [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
were retrieved. Latest npm types lookup failed; the documented fallback was the
installed Workers types 5.20260828.1. No bindings, compatibility flags, credentials,
DDL, application grants or deployment configuration were changed.

## Verification

`test/supplier-order-generations.test.ts` is an explicit maintenance-runner
allowlist entry. It uses the registered 165-step/270-table schema and actual
checkout/allocation/refund services, with an explicitly synthetic paid state.
Hono routes, JWT signatures, password comparison, roles, controllers and SQL
are real. A separate LOGIN with no ownership, UPDATE, superuser, CREATEDB,
CREATEROLE or BYPASSRLS exercises successful reads and permission failures.
Provider and Redis calls are forbidden; these tests do not claim those systems
or Hyperdrive were exercised.

Commands (existing trusted Node and PG16 binaries, from `workers-ts`):

```text
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/supplier-order-generations.test.ts test/admin-order-generations.test.ts test/staff-refund-history.test.ts
node node_modules/vitest/vitest.mjs run test/supplier.test.ts test/supplier-operations-migration.test.ts test/supplier-rbac-migration.test.ts test/supplier-picking-sheet-migration.test.ts test/supplier-pages-acceptance.test.ts test/local-finance-postgres-runner.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

The final native run passed **3 files / 56 tests**, zero failures/skips (240.89 s):
22 Supplier order tests, 19 Admin order tests and 15 staff refund-history tests.
The earlier 21-test Supplier-only green run took 145.47 s; it is not added to the
final count. The final run adds the exact 200-cart / 64-KiB success boundary and
proves unused private order TEXT is not in the header SQL. The six existing
regression files passed **81 tests**, zero failures/skips (7.58 s). Both Worker
TypeScript configurations, runner syntax and scoped whitespace checks passed.

Four owned loopback clusters were used, all with PostgreSQL 16.15:

| Cluster under `.cache/` | Port | Result |
| --- | --- | --- |
| `finance-postgres-aAlKv9` | 54336 | Initial 1 pass / 2 red failures |
| `finance-postgres-eVHJPP` | 62293 | Deterministic 3 red failures |
| `finance-postgres-Q12vDQ` | 54173 | 21 passed |
| `finance-postgres-PnUnip` | 50111 | Final combined 56 passed |

Each run reported zero remaining fixture databases/roles and stopped its cluster.
Independent `pg_ctl status` checks confirmed no server running, and all four
directories lacked `postmaster.pid` and the bootstrap password file. Final
read-only OS checks found zero listeners on all four ports and zero processes
using the trusted test `postgres.exe`. Stopped diagnostics are retained; no
unrelated process, service, directory or database was stopped or removed.

## Remaining migration work

Supplier split-cart/split-order/status/picking-sheet/report/export readers,
root-family discovery, full PHP selectors/DTOs and Supplier rendered error/session
lifecycle acceptance remain separate work. This turn changes no rendered
frontend files and does not substitute the preceding production **image** check
for order-browser acceptance. Real production roles, Redis, provider, Hyperdrive,
workerd/CI and coordinated publication remain open. The original nine staged
paths are preserved; no staging, commit, push, deployment, production database,
image replacement or cache operation occurred in this increment.
