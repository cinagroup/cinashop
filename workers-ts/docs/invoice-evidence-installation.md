# Controlled invoice evidence installation

Follow-up: [invoice evidence registration](invoice-evidence-registration.md)
records the subsequent external `0157`, embedded `0163`, full ORM registration
and explicit empty-ORM completion. The results below remain the prior stage's
installation evidence, not a claim that registration is still absent.

2026-09-16. Local candidate, not deployed or run against production.
This follows [split invoice allocation](split-invoice-allocation.md). The image
acceptance supplied by the user is unchanged; no image/browser/cache rerun.

## Implemented maintenance path

`invoice-evidence-maintenance.ts` is an explicit offline command, not a Worker
startup hook or HTTP migration endpoint. It invokes the same tested
`runInvoiceEvidence` transaction used by the native migration suite. Existing
deployments must not replay historical `MigrationService.runAll` to get this step.

- Fresh installation creates immutable issuance history/capture (v1), followed
  by allocation receipts (v2), in one transaction.
- Exact existing v1 receives only the additive v2 allocation objects. Exact v2
  is verified and preserved, including populated rows and object identities.
- Missing components, changed definitions or unsafe ACLs cause refusal; there
  is no DROP/REPLACE/repair, data rewrite, historical backfill or privilege reset.
- PG16 canonical SHA-256 catalog fingerprints cover columns/defaults/collation,
  checks/PKs, indexes and trigger definitions/states, and function definitions,
  including the SECURITY DEFINER body/search path. Ownership, ACLs, RLS,
  inheritance, storage, rules and incoming FKs are checked separately. Function
  overloads are refused. Digests are schema-version contracts, not a trust seal.
- A separate maintenance owner owns all five objects. The explicit runtime
  LOGIN cannot be that owner, inherit/SET ROLE into it, create in public, bypass
  capture through replication settings, or hold administrative role attributes.
  Transitive role memberships are inspected conservatively, including NOINHERIT.
- The only grants added are history SELECT and allocation SELECT/INSERT. Existing
  base invoice SELECT/INSERT/UPDATE/DELETE and sequence USAGE are prerequisites;
  missing rights cause transaction rollback. Table/column grant options, history
  writes, allocation mutation and non-owner function EXECUTE are rejected.
- Installation is READ COMMITTED, locks base invoice before history/allocation
  with ACCESS EXCLUSIVE NOWAIT, and shares advisory lock `(731611,0)`. It aborts
  behind active writers rather than queueing a cutover. Catalog/environment/role
  are rechecked before commit. Statement/lock/idle bounds are 30s/1s/5s and never
  relax stricter caller limits. All settings are transaction-local.
- Existing invoices are left unchanged. The report flags rows lacking captured
  creation or any `unverified` evidence. No mutable row is certified as never
  issued. A false flag still cannot prove absence of history erased before
  installation, validate a tax document, or approve a credit note.

## Operator contract (not executed on production)

Set `INVOICE_MAINTENANCE_DATABASE_URL` securely outside command history. There is
no `.env` load or fallback to runtime/DATABASE_URL credentials. Supply the exact
database and runtime-role names; do not put the URL/password on the command line.
Non-loopback connections require verified TLS; URL query options are refused.

From `workers-ts`:

```text
node node_modules/tsx/dist/cli.mjs scripts/invoice-evidence-maintenance.ts inspect <expected-database> <runtime-role>
node node_modules/tsx/dist/cli.mjs scripts/invoice-evidence-maintenance.ts install <expected-database> <runtime-role> --confirm-install
```

The command independently checks `current_database()`. Output contains only
mode, catalog version, runtime-safety/readiness booleans and the unknown-history
flag, never invoice snapshots or connection credentials. Runtime readiness here
means **invoice-object privileges only**, not all application privileges.

Exit 0 means complete v2, invoice runtime prerequisites satisfied and no observed
pre-install unknown rows. Exit 2 means inspection/install completed but at least
one of those conditions is unmet. **An install returning 2 can have committed**
the additive schema while reporting unknown history; do not automatically retry
or remove capture. Exit 1 reports a failure without dumping SQL or row values.
There is no automatic retry. A lost commit response requires inspection.

Before a real cutover, coordinate all maintenance/DDL/role writers and application
invoice writers. This is not protection against a malicious maintenance owner or
superuser, and the inspector is an observation, not a durable admission token.
Post-install rollback must preserve capture/history and account for old-writer
compatibility; dropping the ledgers would erase evidence and is not a rollback.

## Verification

Native PostgreSQL 16.15 only, dedicated loopback clusters and random owned
databases. The first canonical probe ran twice (1 case per run); the first console
capture was suppressed by the test runner, so the second emitted catalog metadata
directly. The first substantive suite passed 33 tests in 25.52s.

The first expanded installation/permission run passed 50 of 51 tests in 54.84s.
Its new complete-ORM order fixture copied an empty unique order key into two
children and was correctly rejected by `so_unique_uid_uq`. The fixture requires
distinct child keys; neither business logic nor the database constraint is relaxed.
The initial TypeScript check also caught an overly broad root-connection type on
private query helpers; these now require only `execute`, with no assertion cast.

Final installation/permission verification passed **2 files / 53 tests / zero
failures or skips**, **57.72s**: 39 installation cases and the 14 existing
independent-role permission cases. Coverage includes fresh/repeat/v1 upgrade,
19 catalog/ACL mutations, partial installations, lock contention, atomic rollback,
unknown pre-install history, temporary shadows, transitive NOINHERIT authority,
session-setting restoration and the actual CLI's confirmation/identity/error
boundaries. Both complete external and embedded fresh-schema paths passed before
standalone installation; the base-table ORM path is used in every fixture.

After installation, a separate LOGIN performed the real invoice preparation and
materialization: 10.00 was preserved on the archived source and allocated to
3.33/6.67 children, with three creation snapshots and one immutable allocation
receipt. This tests the real allocation helper, **not the complete HTTP/checkout
flow under a production role**. The CLI was executed as a child process against
only its explicitly named random owned database. Main-process external `fetch`
was forbidden; no provider scenario or production connection was attempted.

Business regression passed **5 files / 187 tests / zero failures or skips** in
**130.45s**, covering real split allocation, issuance history, atomic refund,
Out lifecycle and the runner command boundary. This includes one new runner
allowlist test. Both final TypeScript configurations exited 0. No tested code
was changed after these final runs (only audit documentation).

| Owned cluster under `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-mFlyrm` | 52601 | Canonical probe, 1 passed |
| `finance-postgres-ELxPLB` | 58348 | Canonical metadata output, 1 passed |
| `finance-postgres-U8wmXO` | 53434 | First substantive suite, 33 passed |
| `finance-postgres-3B6ybb` | 49519 | Expanded, 50 passed / 1 fixture failure |
| `finance-postgres-bafbVP` | 63047 | Business regression, 187 passed |
| `finance-postgres-MlcpSd` | 56084 | Final installation/permission, 53 passed |

Every runner confirmed zero leftover fixture databases/roles. Independent final
inspection confirmed all six clusters stopped (`pg_ctl` exit 3), no PID or
bootstrap-password files, zero listeners on these ports and zero processes using
the trusted PostgreSQL binary. Stopped diagnostics are retained; no broad folder
cleanup was performed. All test/typecheck handles are terminal. Checklist counts
remain **240 checked / 164 open / 404 total**, and the original nine staged
filenames are unchanged. There was no staging, commit, push or deployment.

## Remaining release work

This closes the missing **explicit local installation path**, not the broad
invoice or migration checklist item. Numbered external/embedded/ORM registration
of the coordinated candidate schemas, full application least-privilege roles,
older candidate variants, unknown-history reconciliation, release/rollback
coordination, Hyperdrive/workerd/provider/browser acceptance and production
deployment remain open. Issued-document/credit-note workflows are separate and
unfinished. The command deliberately cannot repair already-split legacy roots.

The Workers skill guided separation from request/startup execution; PostgreSQL
guidance guided transaction-local bounds, lock order and least privilege. See
[Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
[PG16 locks](https://www.postgresql.org/docs/16/explicit-locking.html), and
[function security](https://www.postgresql.org/docs/16/sql-createfunction.html).
No Worker binding/configuration or dependency changed; installed Workers types
remain 5.20260828.1.
