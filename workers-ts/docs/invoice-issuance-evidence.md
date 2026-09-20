# Durable evidence of reported invoice issuance

Latest follow-up: [controlled invoice installation](invoice-evidence-installation.md)
adds the explicit local upgrade/CLI and catalog/ACL verification. Production
commissioning and the coordinated release are still open.

Later local increment: [fulfillment/supplier invoice allocation](split-invoice-allocation.md)
now integrates never-issued application partitioning into both actual physical
split paths and extends this candidate DDL with an append-only allocation table.
The earlier 402/10 results below remain historical, not the later run's totals.
Issued-document workflows and production installation/release remain open.

2026-09-16. Local candidate work; not installed or deployed. No production
connection/write, image/cache work, browser rerun, staging, commit or push.
The previous goal turn made verified progress on Out/refund write coordination;
this increment addresses the remaining loss of previously reported issuance.

## Reproduced failure and writer inventory

Three native PostgreSQL regressions call actual checkout, customer invoice,
Out status and atomic refund application services. After issued -> rejected
clears the mutable invoice number, the refund was incorrectly accepted with
the invoice retained, soft-deleted or physically deleted. The red run had
**3 failed / 60 passed**, zero skips, **66.20 s**.

Current source inventory finds processing-state/number writes in Out; customer
application creates records, payment marks them paid, legacy refund marks them
refunded, and candidate refund allocation archives/clones/reduces applications.
Kefu and customer/Out order details read invoices. No direct Admin/Kefu issuance
writer was found in the current TypeScript source search. This is a code
inventory, not proof of complete legacy endpoint migration or deployed roles.

## Implemented evidence contract

- A candidate `store_order_invoice_evidence` table retains full, versioned SQL
  row snapshots bounded to 16 KiB. A composite key identifies creation,
  unverified observation, and each reported document number per invoice.
- A same-transaction trigger records a baseline only on actual INSERT. On
  UPDATE/DELETE without such a baseline, it records an **unverified** old row;
  it never manufactures a created-unissued history from current mutable state.
- OLD issuance is captured before NEW issuance. Either state `1` or a nonempty
  number counts as reported issuance. Each number's first snapshot is retained
  across rejection, later numbers, edits and deletion of the application.
- Invoice ID, UID, order ID and category cannot be repointed after insertion.
  Reusing a deleted invoice ID cannot overwrite its creation evidence. There
  is deliberately no cascading foreign key to the deletable business record.
- Evidence UPDATE/DELETE/TRUNCATE is rejected. Truncating the invoice table is
  also rejected because it would bypass per-row observation of unknown history.
  Suppressed evidence insertion or later business failure aborts the transaction.
- The capture function uses SECURITY DEFINER, a fixed `pg_catalog, pg_temp`
  search path, and the trigger's explicitly quoted source schema. PUBLIC cannot
  execute either function. Runtime roles need invoice DML and evidence SELECT,
  not evidence INSERT or direct capture-function execution.
- Durable-v2 admission checks source/payment-root reported or unverified
  histories, including deleted application records, and requires a matching
  created-unissued baseline for the current application. Current rejected state
  or an empty number is not sufficient. The financial finalizer checks history
  again after preparation, without taking late invoice/refund row locks.
- Evidence and invoice allocation share the actual financial/physical refund
  transaction. New child applications get new creation snapshots; retained
  application identity and original snapshots survive later amount reductions.
  Late issue-then-clear, even when the mutable row is restored exactly, causes
  complete financial/physical/evidence rollback.

The DDL is composed into the explicit refund-split candidate fixture only.
Neither schema/index nor the runtime migrator/catalog registers it. Missing
candidate evidence fails admission, even with no active application. No
runtime repair, existing-schema upgrade, default-v1 change or public-v2
activation is performed. The legacy Out manual state transition remains valid
as a record operation, but cannot erase captured issuance for v2 admission.

The review follow-up also checks pre-install archived rows with no creation
evidence, including replacement by a newly captured active application. One
statement snapshot tests for reported/unverified events OR an uncaptured
source/root invoice row without filtering soft deletion; a concurrent deletion
cannot fall between two separate READ COMMITTED statements. Its two new
boundary tests are included in the final rerun.

## Verification

Native PostgreSQL 16.15, owned loopback clusters and randomly owned databases
are used. Ordinary SQL runs use a non-superuser. A separate maintenance-only
cluster creates short-lived NOLOGIN/NOSUPERUSER application roles, exercises
actual SET LOCAL ROLE operations and drops their grants/roles afterward.
Maintenance privilege belongs only to the disposable test setup; it is not a
production grant or proof of production minimum privileges.

- First implemented run: **2 files / 85 passed**, zero skips, **82.94 s**.
  Both TypeScript configurations passed.
- Expanded evidence/atomic/runner run: **3 files / 108 passed**, zero skips,
  **90.48 s**. Separate first permissions run: **8 passed**, **10.79 s**.
  Both TypeScript configurations passed.
- Final permissions run after truncation/type-shadow checks: **10 passed**,
  zero skips, **12.98 s**. This includes a fresh independent PostgreSQL backend
  where a temporary `regclass` composite type is created before first invocation.
- First full regression: **14 files / 400 passed**, zero skips, **245.96 s**.
  Both TypeScript configurations passed. Complete review-follow-up rerun:
  **14 files / 402 passed**, zero failures/skips, **274.27 s**. Both final
  TypeScript configurations passed. The atomic suite now has 70 cases; the
  evidence suite has 27. These overlapping runs must not be added together.

Tests cover real service red regressions, each-number first snapshots,
creation/unknown observation, nonempty-number anomalies, immutable identities,
append-only guards, suppressed capture and late rollback, malformed/null/oversized
JSON, source-schema qualification, denied runtime-role insert/update/delete/
truncate/trigger-disable/function-call, and temporary relation/type shadowing.
Existing actual generation, provider-await/recovery and concurrency tests remain
in the regression scope. Provider responses and identities are synthetic;
external fetch is forbidden in the financial fixtures.

| Owned cluster under `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-LlSSuN` | 61211 | Red: 3 failed / 60 passed |
| `finance-postgres-4jsYQq` | 57162 | First: 85 passed |
| `finance-postgres-0SOja9` | 56724 | Expanded: 108 passed |
| `finance-postgres-DrDFbJ` | 57303 | First permissions: 8 passed |
| `finance-postgres-qZO9c7` | 57305 | First full regression: 400 passed |
| `finance-postgres-Nz6pFB` | 58019 | Final permissions: 10 passed |
| `finance-postgres-bQ6C16` | 57121 | Final full regression: 402 passed |

All seven clusters were independently checked stopped, with status exit 3,
no PID/bootstrap password/listener and no trusted-runtime PostgreSQL process.
All runners reported zero remaining test databases/roles. Stopped diagnostics
are retained; no test/typecheck session is still running. Whitespace checks
passed. The nine original staged entries were checked unchanged by name and
were not staged, unstaged or rewritten by this increment.

Reproduce from `workers-ts` using the already installed trusted runtime:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/invoice-issuance-evidence.test.ts test/out-invoice-lifecycle.test.ts test/out-api-migration.test.ts test/order-invoice-concurrency.test.ts test/refund-atomic-materialization.test.ts test/refund-order-materialization.test.ts test/supplier-refund-generations.test.ts test/refund-line-finance.test.ts test/refund-quantity-reservation.test.ts test/order-auxiliary-migration.test.ts test/v2-compatibility-migration.test.ts test/store-order-refund-postgres-migration.test.ts test/supplier-operations-migration.test.ts test/local-finance-postgres-runner.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/invoice-issuance-permissions.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Still required before release

This records **reported issuance**, not a tax authority/provider attestation or
a valid credit note. Issued-document/credit-note identity, amount allocation,
verified external results and supported refund policy still require their full
workflow. A manual rejected state does not establish cancellation of a real
document. General fulfillment/supplier invoice allocation and other legacy
adapters/read/delete/reporting contracts remain open.

Installation must be transactional with reviewed ownership/ACL and reconciliation
of pre-install data. History erased before installation cannot be reconstructed
from current rows. No old-data 'never issued' attestation or automatic historical
cleanup is introduced. Existing candidate schemas need an explicit reviewed
migration, not a retry of fresh-create DDL. Runtime must not own tables/functions
or be able to disable triggers; maintenance/superuser tampering is not prevented
by application-level append-only guards.

Real Hyperdrive/workerd/provider/role/browser acceptance, operational retention,
catalog/controlled installation and coordinated rollout remain open. No broad
checklist item is closed: **240 checked / 164 open / 404 total**; the original
nine staged entries are preserved.

Workers/PostgreSQL skills guided bounded evidence, transaction boundaries,
ordered locks and least-privilege capture. Current
[Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[PostgreSQL trigger semantics](https://www.postgresql.org/docs/16/sql-createtrigger.html)
and [SECURITY DEFINER guidance](https://www.postgresql.org/docs/16/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)
were consulted. Installed Workers types 5.20260828.1 and bundled Wrangler
Hyperdrive definitions were inspected using the documented retrieval fallback;
bindings and dependencies are unchanged.
