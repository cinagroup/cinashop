# Checkout / refund / fulfillment runtime-role acceptance

2026-09-16, local candidate only. No production connection, grants, deployment,
public v2 activation or browser/image/cache rerun. The user-confirmed readable
product images remain resolved independently of this database work.

## What is now proved

`test/refund-runtime-permissions.test.ts` uses the full 165-step embedded migration
path (270 registered tables), retaining the actual constraints, indexes, triggers
and protected evidence protocols. Every case creates a fresh random database and
a separate authenticated LOGIN, not `SET ROLE` from a maintenance connection.
The maintenance connection only creates the schema, seeds synthetic data,
commissions evidence permissions, injects explicit grant/revoke faults and reads
assertion snapshots. Business service calls use the non-owner connection.

The synthetic scenario executes real services for checkout, supplier allocation
and payment recording, invoice application, atomic v2 refund, post-refund
fulfillment split, receipt confirmation and two further refunds. The initial
55.00 payment returns exactly 55.00 to the customer's synthetic balance; spent
points return to 100, active child invoices sum to 55.00, supplier refunds sum to
31.00 with zero available/pending settlement. Repeated completion changes no
business/evidence/outbox rows. Actual provider payment is **not** exercised: the
paid state is an explicit owner-seeded fixture, and external fetch is forbidden.
There is no live HTTP authentication, Hyperdrive, Queue delivery or invoice issuance.

Four targeted late permission failures (refund receipt, child invoice, fulfillment
branch and fulfillment invoice allocation INSERT) are checked against the exact
PostgreSQL 42501/table name. Each rolls back the complete synthetic row snapshot;
restoring that exact permission allows recovery. No permission is granted
automatically in response to an error. Sequence gaps after rollback remain normal.

## Exact tested authority, and its limits

The executable table-level profile in `test/helpers/refundRuntimeFixture.ts` grants
specific operations on **35 named tables**, USAGE only on **10 named sequences**,
and column UPDATE(id) on **8 named tables**. The test enumerates all public tables,
sequences and columns and requires the exact effective grant set, including the
absence of extra access to the other registered tables. It checks separate
session/current identity, no role memberships, object ownership, schema creation,
superuser, CREATEDB, CREATEROLE, inheritance, replication or BYPASSRLS authority.

| Permission boundary | Evidence and remaining qualification |
| --- | --- |
| Pricing `member_right` / `system_config` | SELECT alone fails the real late `LOCK TABLE ... IN SHARE MODE NOWAIT`; table UPDATE allows it. Existing locks are unchanged. This profile can edit pricing configuration and is **not** a checkout-only read-only policy. |
| Reference and transaction row locks | `user_address`, `city_area`, `system_user_level`, `agent_level`, `system_supplier`, `user_invoice`, `supplier_transactions`, `order_waybill_job` receive UPDATE(id), not table UPDATE. The exercised invoice/supplier/waybill paths require row locks even when not changing their contents. Membership-level branches are not comprehensively exercised. |
| Column UPDATE is still a write capability | UPDATE(id) permits primary-key changes. This acceptance does not certify a pure read-only reference role or database-enforced immutability of supplier transactions. Real production policy must explicitly review this capability or introduce a reviewed narrow lock protocol. |
| Protected evidence | Invoice history is SELECT-only, captured by the existing protected trigger; invoice allocation/refund split/fulfillment branch allow SELECT/INSERT only. UPDATE, DELETE, TRUNCATE, trigger disabling and direct history insertion are refused. Capture/guard routines are not callable by the runtime role. |
| Sequences and maintenance | Real inserts/cart identity reservation work with USAGE; setval, schema DDL, replication bypass and SET ROLE to maintenance fail. RESET ROLE preserves the original runtime LOGIN/backend. |

The profile is **test-only**, not an automatic production role installer or an
exhaustively minimal whole-application policy. No GRANT ALL, default privileges,
owner fallback, trigger disabling or schema relaxation is used to make business
paths pass. The existing `runtimeReady` result of the invoice/refund installers
still certifies only those evidence objects, not all application permissions.

PG16 documents the distinction between table locks and row-locking SELECTs:
[LOCK privileges](https://www.postgresql.org/docs/16/sql-lock.html),
[SELECT locking clauses](https://www.postgresql.org/docs/16/sql-select.html),
[GRANT](https://www.postgresql.org/docs/16/sql-grant.html).

## Test development findings

The first three complete-schema runs each failed during synthetic setup, before
business acceptance: the shared quote fixture inserted a product before its
shipping template; migration-seeded integral rights occupied fixture id 1; the
new synthetic SKU identifier exceeded CHAR(8). The fixture now inserts its
template first, moves that one local default right to id 3 without discarding its
content, and uses an eight-character SKU. No business constraint was removed.

Subsequent runs isolated real grant requirements: invoice-title FOR SHARE
(3/6 failures), supplier-transaction FOR UPDATE (5/9 failures), and waybill-job
FOR KEY SHARE (3/10 failures). These were represented as explicit column grants
in the test profile, with financial/title field updates still denied. Fault
injection was also aligned to actual writers: refund invoice lineage lives in
the refund receipt, whereas `store_order_invoice_allocation` is written by
fulfillment/supplier invoice splitting. Assertions were not weakened to accept
unrelated permission errors.

## Local verification

Trusted local PostgreSQL **16.15**; fresh owned loopback clusters only:

- Full-schema independent LOGIN: **10/10**, 85.65 seconds, no skips.
- Existing business regressions: **199/199** across six files, 213.90 seconds,
  no skips: `pc-checkout-quote-postgres`, `shipping-template-quote-postgres`,
  `checkout-pricing-config-authority`, `refund-atomic-materialization`,
  `supplier-refund-generations`, `split-invoice-allocation`.
- Local runner boundary: **17/17**, 2.15 seconds. Only the new explicit ACL suite
  was added to maintenance-mode allowlisting; unrelated suites remain refused.
- Final `npm run typecheck`: both unit and runtime TypeScript checks exit 0.

All eight newly owned clusters (`92Lzk1`, `OzPvj4`, `M9L7eu`, `FkZdOB`,
`ijSLUd`, `HJbJ5V`, `juRuRs`, `4bpO7O`) reported zero remaining fixture databases
and roles before shutdown. Independent final checks returned `pg_ctl status` 3
on every exact data directory, no PID/bootstrap-password files, no listeners on
their eight recorded ports, and zero processes using the trusted PG binary.
Stopped diagnostics are retained. All test/typecheck handles are terminal; tested
code was unchanged after its successful final run. The original nine staged
filenames and checklist **240 checked / 164 open / 404 total** remain unchanged.

Reproduction from `workers-ts` with an already trusted PG16 binary directory:

```powershell
node scripts/run-local-finance-postgres.mjs --schema-maintenance <trusted-pg16-bin> test/refund-runtime-permissions.test.ts
```

This suite requires the dedicated isolated `TEST_FINANCE_POSTGRES_URL`; without
it native-role tests are skipped, not evidence of acceptance. The recorded runs
above supplied it using the owned-cluster runner.

## Still open

Production least-privilege commissioning, read-only pricing/reference lock design,
all application roles and activity variants, current-generation readers/deletes/
reports, true provider payment/refunds and invoices, workerd/Hyperdrive/browser/
Linux CI, release/rollback and public v2 enablement remain separate gates. This
increment changes tests/documentation only, not production business code or DDL.

Workers guidance kept external I/O out of database transactions and distinguished
native PG proof from Cloudflare runtime proof. PostgreSQL guidance prompted the
exact grant census, non-owner LOGIN and explicit lock/write-capability caveats.
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
