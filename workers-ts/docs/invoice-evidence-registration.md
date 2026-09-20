# Invoice evidence migration registration

Follow-up: [refund split installation and registration](refund-split-installation.md)
adds the two refund-generation ledgers and their dependent guarded installer.
The 268-table results below are this prior stage's evidence, not the newer count.

2026-09-16. Local candidate only; no production database, deployment, image,
cache or browser operation. The user's confirmation that the new images are
readable remains accepted. This follows the
[controlled installation audit](invoice-evidence-installation.md).

## Registered construction contract

The immutable issuance history and split-allocation tables are now exported by
the full ORM schema. The external registry appends `0157_invoice_evidence.sql`;
the embedded registry appends step `0163`, without renumbering prior steps.
There are 164 embedded steps (`0000` through `0163`) and 159 external files.
These are different registries, not an off-by-one discrepancy.

| Construction path | State before a standalone installer | Required follow-up |
| --- | --- | --- |
| Complete numbered external SQL | `v2` | Explicit runtime-role commissioning |
| Complete embedded migration | `v2` | Explicit runtime-role commissioning |
| Full ORM tables | `orm-pending` | Explicit empty-ORM protection completion, then runtime commissioning |

The external SQL and embedded verification SQL are byte-equal after trimming to
the shared guarded installation constant. The embedded step uses its own root
transaction, not a nested generic migration transaction. This registration does
**not** make historical `MigrationService.runAll` safe for an existing database.
There is no request/startup auto-install hook.

Table DDL is separated from capture/guard DDL without changing the established
protected definitions. ORM `recorded_at` uses explicit `CURRENT_TIMESTAMP` to
match the existing SQL expression. Quoted table names also keep the repository's
deliberately narrow static registry parser accurate; that parser was not relaxed
to count arbitrary unregistered candidate definitions.

A single PG16 catalog state query is shared by raw SQL, the maintenance runner
and inspection. The existing `fresh`, `v1`, `v2` and `drift` states gain exactly
one transitional state: `orm-pending`, requiring canonical owned base/history/
allocation tables, safe ACLs and absent capture/guard functions. This state is
**not** ready for invoice writes. A normal numbered upgrade rejects it.

Explicit ORM completion locks the three tables in base/history/allocation order
with ACCESS EXCLUSIVE NOWAIT, rechecks their state, and requires all three to be
empty. Only then can it add the missing functions/triggers. Populated bare tables,
partial protection, extra function privileges or definition drift are refused,
not rewritten or repaired. The same final `v2` fingerprint/ACL checks apply to
all paths. Fresh/v1/repeat installation remains bounded, atomic and additive.

## Explicit ORM operator entry

This is an operator contract, **not a command executed against production**.
Use the maintenance-owner connection and runtime-role prerequisites documented
in the installation audit; no runtime credential or `.env` fallback is used.
Before any invoice writes on a newly ORM-created database, run from `workers-ts`:

```text
node node_modules/tsx/dist/cli.mjs scripts/invoice-evidence-maintenance.ts complete-orm <expected-database> <runtime-role> --confirm-install
node node_modules/tsx/dist/cli.mjs scripts/invoice-evidence-maintenance.ts inspect <expected-database> <runtime-role>
```

`INVOICE_MAINTENANCE_DATABASE_URL` must be supplied securely outside command
history. Exact database identity and verified TLS for non-loopback connections
remain required. `complete-orm` reuses the same guarded transaction and only the
two reviewed additive grants. Missing base-table/sequence prerequisites roll back
installation. It does not guess a runtime role or grant full application access.

Inspection reports `orm-pending` as not ready and history unknown. Exact already
protected installations can be verified repeatedly without changing identities
or rows. Existing unprotected invoice rows cannot be made historically trustworthy
by using this mode. Exit 2 can report a committed additive installation with
unresolved history; inspect instead of blindly retrying or dropping evidence.

## Native verification

All database work used fresh owned loopback PostgreSQL **16.15** clusters. No
production URL, invoice payload, secret or provider request was used in evidence
output. The new registration tests forbid main-process external `fetch`.

- Initial bare SQL/ORM probes: **2 passed**, 3.08s.
- Intermediate migration checks: **2 files / 41 passed**, 50.16s.
- Expanded registration/installation/role checks: **3 files / 72 passed**, 72.41s.
- Final maintenance regression: **10 files / 320 passed**, 270.27s, zero failures
  or skips. This includes all **19** new registration cases, the 39 installation
  cases and the 14 independent-role permission cases, plus affected refund,
  brokerage, coupon and shipping migration suites.
- Final static registry/data-scope/catalog/runner checks: **5 files / 115 passed**,
  6.21s. The first run caught the unquoted table declarations; declarations were
  fixed without widening the parser or waiving table membership.
- Both main and runtime-test TypeScript checks exited **0**. An initial new-test
  helper signature was corrected from `object` to `Record<string, unknown>`.
- Final business regression: **4 files / 172 passed**, 129.72s, zero failures or
  skips, covering issuance history, actual split allocation, atomic refund and
  Out invoice lifecycle under the ordinary non-superuser fixture runner.

The 19 registration cases cover actual complete external/embedded/ORM builds,
canonical bare definitions, durable issued-then-cleared history, append-only
denial, populated ORM refusal, definition/ACL drift, inherited default function
EXECUTE rollback, all three held-table locks, incompatible transactions, root
connection enforcement, and a real child CLI commissioning a separate LOGIN.
Repeated standard/raw installation preserves populated evidence and the complete
fixture's public relation/function identities. This is not a complete production
HTTP or application-role acceptance test.

The full catalog audit passed all **nine paths**: external, embedded, ORM, and
six ORM index/default/constraint/FK-name/CHECK/sequence reconciliation variants.
Every path has **268 tables, 3,738 columns, 594 constraints, 1,030 indexes and
227 sequences**, with no differences waived. External/embedded protection is
required to be `v2` before any standalone installer, so missing registration cannot
be hidden by repair. All seven ORM paths explicitly transition from `orm-pending`
before test writes. Every path verifies repeated invoice installation preserves
table/index OIDs and files and capture/guard function OIDs.

Audit input SHA-256:

```text
external: dee636077fff972f51e122fc76ee332c0b833a5a7f591cdc52bf2dfdc13457e7
ORM SQL:  bb25f2d36d80b9e0f4ff4ba2fad16288fdd6d71f91baee7796cc968119f02455
```

This establishes the five catalog categories plus the specific invoice protocol,
not general equivalence of every function, trigger, policy, grant or view. The
candidate count is updated to 268; the historical repository/production snapshots
remain **263**, and are not presented as freshly measured production state.

### Terminal handles and local cleanup

| Owned cluster under `.cache` | Port | Completed work |
| --- | --- | --- |
| `finance-postgres-tY9ubK` | 52096 | Bare SQL/ORM probes, 2 passed |
| `finance-postgres-658qPV` | 51023 | Intermediate migration checks, 41 passed |
| `finance-postgres-IbWSbY` | 59744 | Expanded checks, 72 passed |
| `finance-postgres-3mYv8L` | 58601 | Full nine-path catalog audit |
| `finance-postgres-5y7TBr` | 53660 | Final maintenance regression, 320 passed |
| `finance-postgres-6KNJIE` | 54490 | Final business regression, 172 passed |

Every runner reported zero remaining fixture databases/roles. Independent final
inspection confirmed all six `pg_ctl status` calls exited 3, no PID or bootstrap
password files, zero listeners on these exact ports, and zero processes using
the trusted PostgreSQL binary. Stopped diagnostics are retained; no broad folder
deletion was performed. All test/typecheck handles are terminal. No tested code
changed after the final runs, only these audit records. The 30 touched audit-scope
files passed whitespace checks; the original nine staged filenames are unchanged.

## Release boundary

Invoice evidence registration is complete locally, but the whole dirty worktree
is not release-ready. Coordinated candidate schemas, including the refund physical
split receipt model, still need their own registration/upgrade review. Full
application least-privilege roles, prior candidate variants, unknown-history
decisions, issued-document/credit-note workflows, coordinated rollback, real
Hyperdrive/workerd/provider/browser acceptance and deployment remain open.

No broad checklist item is checked by this structural increment. Counts remain
**240 checked / 164 open / 404 total**. No staging, commit, push or deployment is
part of this verification.

The Workers skill kept installation outside request/startup paths; PostgreSQL
guidance informed explicit transaction boundaries, lock order and privilege
separation. References:
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
and [PG16 function security](https://www.postgresql.org/docs/16/sql-createfunction.html).
No Worker binding/configuration or dependency changed.
