# DB-009E3 — twelve foreign-key names

Implementation-stage evidence, 2026-09-06. Exact committed Linux/PG16 results
will be recorded in the root audit after CI. This is not a production receipt.

## Contract and source

orm-foreign-key-name-reconciliation.json binds twelve alias pairs to the fixed
b07d01e catalog and the last verified 70103a0 / Actions34017020788 baseline. Each
entry includes complete old/target catalog rows, real Drizzle snapshots, typed
column/parent declarations, and original external plus embedded SQL. The
pre-edit extractor is read-only and requires the unrenamed models; repeatable
verification uses the frozen manifest, source-binding tests and engine probes.

Six models replace twelve inline references with explicitly named foreignKey
declarations. Columns, defaults, indexes and referential actions do not change.
Eleven references retain ON DELETE RESTRICT; the migration checkpoint retains
ON DELETE CASCADE. All twelve retain NO ACTION updates and validated,
nondeferrable state; two optional references remain nullable. Inspected
application constraint-name handling concerns other user unique indexes, not
these twelve FK names. Database error names are still tested individually.

## Forward migration

External 0143 and embedded 0149 are exact SQL mirrors. Only a reviewed old name
can become the deployed name. There is no constraint ADD/DROP/VALIDATE or
business DML. Exactly one old-or-new object per pair must exist; missing/both
names, unknown equivalent aliases and all checked metadata drift are refused.

Seventeen ordinary permanent parent/child tables are locked in deterministic
order with a two-second lock wait. Nineteen referenced columns retain exact
type/length, nullability, identity/generation, collation and inheritance state.
The parent PK/index, referenced columns and builtin equality operator must be
exact. Each FK needs four distinct, enabled, nondeferred internal RI triggers
with the correct builtin functions and parent/child roles. FK conindid refers
to the parent index, not a child-owned index. Rename must keep full constraint
metadata except conname, and keep all four trigger records/OIDs. Search path is
restored; explicitly qualified tables prevent temporary-name interception.

ACCESS EXCLUSIVE is not a lock-free online change. Child-side index performance
remains separate: no index is added by this name-only batch, and existing full
index gates remain intact. No latency claim relies on small synthetic data.

Read-only model inspection found ten of these references have a nonpartial
leading-column index and the checkpoint uses the leading column of its composite
PK. payment_reconciliation_case.callback_event_id has neither. Together with
the previously noted active-row-only reply reference index, this is recorded as
DB-009G for measured query/parent-check review. It is not a claim about a fresh
production inspection or an observed slow query, and is not fixed by renaming.

## Executable evidence

An independent full-ORM probe reconstructs the twelve old snapshots and runs
the full 1,068-statement schema. It compares catalogs, table/index/view/sequence
OIDs and file identifiers, complete constraint/trigger and pg_index metadata,
dependencies and original synthetic rows. Two views and a user trigger serve as
dependency fixtures. Only-name changes, no-op, mixed state, temp/nonpublic
isolation, failure after the first real rename and full rollback are asserted.

141 drift refusals cover eleven cases per FK: missing, both names, unknown
alias, validation, kind, delete action, deferral, child/parent disabled triggers,
one ALWAYS trigger and wrong parent; nine further column/table/schema/PK-shape
cases are tested. Twelve independent row cases exercise exact invalid
INSERT/UPDATE error names and NO ACTION parent updates, eleven RESTRICT deletes,
one real CASCADE and two allowed NULL references. PG16 and PGlite18 have separate
exact expected RESTRICT-delete SQLSTATEs, not interchangeable accepted errors.

The generator emits twelve DROP and twelve ADD statements. A first probe
incorrectly expected nine long-name DROP statements to fail. Actual execution
confirmed the same 63-byte identifier truncation applies to both the statements
and existing objects; that wrong expectation was corrected. All twelve raw
DROP/ADD proposals now run only in rollback fixtures and demonstrably replace
each constraint and its four RI trigger OIDs. That identity loss is the reason
they are not used as the forward migration, not an invented missing-name bug.

Final CJS/ESM plus existing source-binding tests passed: four files, 23 tests,
194.38 seconds. Full local maxWorkers=2 regression passed all 248 files with
1,585 passing and four dedicated PG16 tests skipped (1,589 total), 512.67 seconds;
both final TypeScript configurations passed. Exact-commit PG16 CI is pending. The
new child has its own 180-second limit; existing index (90-second) and constraint
addition probes, concurrency and workflow limits are not altered.

The first committed CI run, 9fba575 / Actions34020071977 attempt 1, failed
before unit tests or PG16: the TypeScript process exhausted its approximately
2-GiB default V8 heap and exited 134. Seven other jobs passed. This confirmed
compiler heap exhaustion is separate from the unresolved TEST-005 native
allocator crash. Both typecheck scripts now invoke the pinned local TypeScript
compiler with an explicit 4,096-MiB old-space limit; both pass locally with
NODE_OPTIONS removed. This does not enlarge Worker runtime memory or change
dependencies, checking scope, assertions, concurrency or time limits. A new
committed SHA must pass the entire CI; the failed run is not acceptance evidence.

The PG16 runner adds the seventh full path, orm_fk_names, using the dedicated
loopback service and precise randomly named database cleanup guard. All paths
retain complete column/index gates and the previous 41 constraints, and add
twelve exact FK contracts plus obsolete-name/duplicate-alias rejection. Fresh
ORM and every upgraded catalog must match. Root JSON keeps the previous verified
source until new complete evidence has actually been read.

No production database, provider or deployment is accessed. PostgreSQL and
Workers skills influenced lock bounds, schema qualification, RI protocol tests,
awaited transactional registration and the no-import-time-I/O SQL mirror.
Bindings, Worker API signatures and secrets are unchanged.

Primary sources: [PG16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html),
[pg_constraint](https://www.postgresql.org/docs/16/catalog-pg-constraint.html),
[pg_trigger](https://www.postgresql.org/docs/16/catalog-pg-trigger.html),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
