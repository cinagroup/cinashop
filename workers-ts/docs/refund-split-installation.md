# Refund split evidence installation and registration

2026-09-16. Local candidate only. No production connection, public refund-v2
activation, image/cache/browser rerun, staging, commit, push or deployment.
This follows [invoice evidence registration](invoice-evidence-registration.md)
and [atomic refund materialization](refund-atomic-materialization.md).

## Closed construction gap

The actual refund and further-fulfillment paths already use immutable
`store_order_refund_split` and `store_order_fulfillment_branch` records, but their
installation previously existed only as fixture DDL. Both models now belong to
the full ORM export. External migration `0158_refund_order_split.sql` and embedded
step `0164` use the same guarded SQL; prior numbering is unchanged. Complete
external/embedded construction requires invoice protection first. Existing
databases must use the specific maintenance command, never replay the historical
`MigrationService.runAll` registry as an upgrade.

There are 165 embedded steps (`0000` through `0164`), 160 external SQL files, and
270 candidate tables. The older 263-table production/repository snapshots remain
unchanged; 270 is not a new measurement of production.

The legacy `REFUND_ORDER_SPLIT_SQL` export remains a disposable-fixture composition
of invoice protection, refund tables and refund guards. It is not called by the
registered installer. Table and guard definitions are separately reusable, and
the guard function now explicitly revokes its default PUBLIC EXECUTE privilege.
No financial state, order identity, receipt body, stored version or public
refund-creation selector is changed by this increment.

## Installation contract

The single catalog state machine is used by numbered SQL, root-transaction
execution, read-only inspection and the explicit CLI:

- `fresh`: both refund tables and the guard function are absent.
- `v1`: both complete guarded tables and the function have exact reviewed PG16
  definitions, maintenance ownership and allowed ACLs.
- `orm-pending`: exact bare ORM tables, safe ACLs and no guard function. This is
  **not runtime-ready** and ordinary installation refuses it.
- `drift`: anything else, including partial/older candidates, function overloads,
  different checks/defaults/indexes/triggers, RLS/rules, wrong ownership, incoming
  foreign keys, dropped columns and unsafe table/column/function privileges.

Shape fingerprints cover full columns/defaults/collations, constraints, indexes,
trigger definitions/enabled states and guard-function definition/search path.
Owners and ACLs are evaluated separately so safe runtime grants survive repeats.
Digests encode reviewed version contracts, not historical truth or a security seal.

Installation requires complete, owned invoice protection `v2`; it cannot repair
or silently install that prerequisite. A shared advisory lock `(731611,0)` and
ACCESS EXCLUSIVE NOWAIT locks follow the dependency order: invoice base, issuance
history, invoice allocation, refund split, fulfillment branch. Missing new tables
are created only from `fresh`. Exact `v1` is preserved. Explicit ORM completion
requires **both refund ledgers empty**, then adds only their protection. Protected
invoice tables need not be empty. Missing or changed evidence is never inferred
from mutable business rows.

The transaction is PG16, read-write READ COMMITTED, pinned to public with pg_temp
last, row security off and origin replication. Enabled DDL event triggers are
refused. Statement/lock/idle limits are 30s/1s/5s or stricter caller limits.
Catalog/dependency state is rechecked under locks and before commit. Name
collisions, unsafe default privileges or any failed check roll back all additions;
there is no DROP/REPLACE, existing-ACL repair, history backfill or automatic retry.
Maintenance/role/DDL writers must still be coordinated; this is not protection
against a malicious owner or superuser.

Runtime commissioning requires an explicit separate LOGIN with no ownership,
administrative role attributes, public-schema CREATE, replication-setting bypass,
or transitive SET ROLE route to such authority. Invoice-object privileges must
already be commissioned. The only new grants are SELECT/INSERT on the two refund
ledgers; no UPDATE/DELETE/TRUNCATE or function EXECUTE is granted. Trigger guards
also reject mutation when a maintenance owner accidentally attempts row writes.
`runtimeReady` describes **these evidence/invoice objects**, not all application
privileges, real historical validity or approval to enable public refund v2.

## Explicit operator entry

These commands were tested only against random owned local fixture databases.
They are a release contract, not authorization or a record of production execution.
Set `REFUND_SPLIT_MAINTENANCE_DATABASE_URL` securely outside shell history; the
script does not load `.env` or fall back to runtime/DATABASE_URL credentials.
Exact database identity and an explicit role are required; remote connections
require verified TLS and URL query options/fragments are refused.

From `workers-ts`, after the invoice installer/commissioning step:

```text
node node_modules/tsx/dist/cli.mjs scripts/refund-split-maintenance.ts inspect <expected-database> <runtime-role>
node node_modules/tsx/dist/cli.mjs scripts/refund-split-maintenance.ts install <expected-database> <runtime-role> --confirm-install
```

For newly ORM-created tables, complete invoice protection first, then explicitly
replace `install` with `complete-orm` before any refund-ledger write. Populated
unprotected ledgers cannot be upgraded by this mode. Older candidate definitions
or the old PUBLIC-executable guard require a separately reviewed disposition;
this command intentionally refuses them without changing rights or evidence.

Exit 0 means guarded v1 plus checked object-level runtime readiness. Inspection
can return 2 when incomplete; failures return 1 with sanitized text and no SQL,
snapshot or credential output. A lost commit response requires inspection, not
blind retry. Do not drop the ledgers for rollback: that destroys immutable
generation evidence. Public-v2 activation and old-writer compatibility remain
separate release decisions.

## Verification scope

Native PostgreSQL 16.15 SQL and independently generated ORM probes produced the
same bare and guarded definitions: **2 passed**, 3.20s. The first installation
suite then passed **41 tests**, 49.46s, zero failures/skips. An initial typecheck
caught an unused raw-ORM SQL import; the expanded suite now exercises that entry.
No business assertion or catalog difference was waived.

The new suite exercises fresh and exact populated repeat installation, explicit
empty-ORM completion, populated bare refusal, 17 definition/ACL mutations,
partial schemas, late index-name collision rollback, invoice dependency refusal,
all five table locks and the shared installer lock, inherited default function
EXECUTE rollback, real LOGIN read/append and mutation/DDL denial, missing invoice
privileges, unsafe grants and NOINHERIT SET ROLE authority, transaction modes,
session-setting restoration, DDL triggers, temporary shadows, role injection and
actual child CLI confirmation/identity/secret-output boundaries.

Full external/embedded construction must already be protected before any
standalone runner can mask missing registration. Full ORM construction must
explicitly complete invoice then refund protection. The nine-path audit checks
that ordering and repeat OID/file preservation in addition to the five general
catalog categories. These are not general function/trigger/policy/privilege
equivalence or complete production-role HTTP tests.

### Final results

- Maintenance/registration regression: **11 files / 365 passed**, zero failures
  or skips, **357.71s**. The new refund-split suite has **45 cases**, including
  complete external, embedded and ORM builds. Invoice/refund-admin/brokerage/
  coupon/shipping migration checks also passed with the appended registry.
- Business regression: **6 files / 300 passed**, zero failures or skips,
  **283.98s**. Covers actual refund materialization, atomic completion, successive
  supplier fulfillment/refund generations, split invoices, issuance evidence and
  Out invoice lifecycle. These use the ordinary non-superuser fixture runner,
  not a complete separate production application role.
- Static registry/data-scope/catalog/runner checks: **5 files / 120 passed**,
  **4.32s**. New root-dispatch success/failure/predecessor checks and the runner
  allowlist check passed. Both final TypeScript configurations exited **0**.
- The full **nine-path** catalog audit passed: **270 tables, 3,770 columns,
  608 constraints, 1,036 indexes and 227 sequences** on every path, with no
  differences waived. External/embedded refund protection starts at `v1`;
  all seven ORM variants start at `orm-pending` and explicitly complete it.
  All invoice/refund protocol repeats preserve their table/index OIDs/files and
  function OIDs. The audit confirms its temporary databases were removed.

Audit input SHA-256:

```text
external: 216df60ed4b469af4d572acbb2229f1c3b5680870f1919f11afc709b33424126
ORM SQL:  5574cdf3817702de8fe53e61b37a9e150b4536add1f6d9bc224f0725ad98cc76
```

| Owned cluster under `.cache` | Port | Completed work |
| --- | --- | --- |
| `finance-postgres-h1KDCW` | 55989 | Bare/guarded SQL and ORM probes, 2 passed |
| `finance-postgres-OIpEfk` | 57673 | Initial installation suite, 41 passed |
| `finance-postgres-YSj0NO` | 65187 | Final maintenance regression, 365 passed |
| `finance-postgres-NaWanX` | 65188 | Full nine-path catalog audit |
| `finance-postgres-PscG46` | 55008 | Final business regression, 300 passed |

All five runners reported zero remaining fixture databases/roles and stopped.
Independent final inspection found `pg_ctl status` exit 3 on each exact cluster,
no PID/bootstrap-password files, zero listeners on the five recorded ports and
zero processes using the trusted PostgreSQL binary. Stopped diagnostic files are
retained; no broad directory deletion was performed. All test/typecheck handles
are terminal, and tested code stayed unchanged after the final runs. The original
nine staged filenames remain unchanged. Checklist counts are still **240 checked /
164 open / 404 total**; this is a local structural increment, not release approval.

## Remaining release work

The subsequent [independent runtime-role acceptance](refund-runtime-permissions.md)
now covers one complete-schema checkout/refund/fulfillment service scenario. It
does not close whole-application or production least-privilege commissioning;
pricing table-lock and reference row-lock write capabilities are explicit there.

The registered structure does not enable the public v2 refund creator. Complete
application least-privilege role tests, current-generation read/delete/reporting
adapters, promotional/gift-only/freight/pink compatibility, old candidate upgrade
decisions, real document/credit-note workflows, coordinated rollout/rollback,
workerd/Hyperdrive/provider/browser/CI acceptance and production deployment remain
open. No broad parent checklist item is closed by this increment.

Workers guidance kept DDL outside business-request/startup paths and preserved SQL-only
transaction boundaries. PostgreSQL guidance informed explicit lock ordering,
least privilege and refusal of unsafe upgrades. References:
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PG16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html).
The installed Workers types are 5.20260828.1; no Worker binding, dependency or
global database configuration changed.
