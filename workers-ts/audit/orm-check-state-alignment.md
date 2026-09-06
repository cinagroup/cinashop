# DB-009E4 — nine CHECK states

Implementation evidence, 2026-09-06. The root audit remains bound to the last
verified commit until the new committed PostgreSQL 16 CI evidence is read.
No production database, provider or deployment is accessed by this batch.

## Exact contract

The frozen manifest binds all nine changed constraint rows in b07d01e to the
last verified eebe827 / Actions34020575416 evidence. It includes old and target
Drizzle snapshots, named-table AST declarations, physical column contracts and
original external plus embedded source clauses. The pre-edit extractor is
read-only and deliberately refuses already-aligned models; it is not a
post-upgrade regeneration tool. Repeat verification uses the frozen manifest.

Eight checks retain their write predicates but become NOT VALID, matching the
original SQL paths: division application status; order division commissions and
supplier allocation status; item split state; five review scores; and user
division percentage, status and type. NOT VALID does not disable new-row checks
or remove NOT NULL constraints. It permits already-existing unvalidated rows.

The outbox check remains validated. Its nine allowed event values are unchanged;
only their order is aligned with external 0133. No event handler, column, default,
index, foreign-key action, permission or public API is changed.

## Forward migration and limits

External 0144 and embedded 0150 are exact SQL mirrors, without import-time I/O.
PostgreSQL does not support changing an existing CHECK back to NOT VALID via
ALTER CONSTRAINT. This guarded migration therefore uses same-name DROP RESTRICT
and ADD from the reviewed original clauses, in one atomic DO statement.

This intentionally changes each replaced CHECK's OID and the object ID in its
outgoing dependencies. It does not preserve target object identity as E3 did.
Comments are captured and restored exactly, including NULL, Unicode and quotes.
Other constraint metadata, column dependencies and semantic fields of the eight
original parsed check expressions must be unchanged. Parser character offsets
are the sole internal-tree exception, explained below. The outbox parsed expression changes only to the
exact canonical event order, with the same allowed values.

Six ordinary permanent tables are locked in sorted order with a two-second lock
wait. Sixteen columns must match exact types, defaults, NOT NULL, collation,
identity/generation and local inheritance state. The full nine-entry cohort is
preflighted before the first mutation. Only the precise old validated state or
the already-correct target state is accepted; missing, unknown, invalid-state,
duplicate exact aliases and unexpected metadata fail closed.

Dependency inspection permits exactly automatic and normal self-table column
references. Extra outgoing or incoming/shared dependencies and security labels
are refused. No CASCADE, system-catalog write, business DML or automatic
VALIDATE is used. Qualified table names and a pg_catalog-first search path
prevent temporary-name interception. Caller search path and lock wait settings
are restored.

The eight NOT VALID additions do not scan old rows. The validated outbox ADD
does scan old rows and holds ACCESS EXCLUSIVE until transaction end. A two-second
lock wait is not a two-second total execution guarantee. Production would require
a separately approved maintenance window, actual data/size inspection and a
caller-side statement timeout; tiny synthetic fixtures establish no throughput
or online-migration claim. Registering this manual migration does not deploy it.

## Executable verification

The independent full old-ORM path replaces only the nine current model snapshots
with their frozen old states. Both CJS and ESM generate and execute the complete
schema, then run 55 drift refusals, real raw-generator DROP/ADD probes and the
guarded upgrade. Initial local execution took 60.475 seconds in the CJS entry.

For both old and aligned states, 58 invalid INSERT/UPDATE pairs, 70 valid-boundary
INSERT/UPDATE pairs and 32 per-column NOT NULL INSERT/UPDATE pairs cover all sixteen columns
and all nine event values. Separate probes retain eight committed bad rows in
canonical NOT VALID checks, reject new invalid inserts/updates and explicit
validation, and clean up only the synthetic keys. Existing validated checks are
not represented as containing impossible bad historical rows.

Full captures compare raw catalogs, object/file identity, complete constraint,
index, trigger and function records, dependencies, comments and synthetic rows.
Expected target OID changes are explicit; unrelated objects and rows are not
waived. Assertions cover all-before-first-DROP preflight, failure after actual
DROP and ADD, rollback, repeat no-op, mixed old/target state and temporary plus
non-public schema isolation. Two-connection PostgreSQL 16 probes additionally
test the two-second lock refusal and blocked writes until transaction end.

The unguarded real generator emits nine DROP and nine ADD statements. Each is
executed only inside a rolled-back fixture: it replaces the object and loses
the existing comment. The guarded migration restores comments and checks exact
pre/postconditions. Re-parsing pg_get_constraintdef can flatten nested Boolean
expressions (observed for split state); therefore migration and duplicate fixtures
use original source clauses, not a rewritten deparser expression. Raw comparison
remains exact, without a normalization waiver.

The PG16 runner adds the eighth full schema path, orm_checks, and applies a new
complete constraint-category gate to every path alongside the existing complete
column and index gates. Fresh and all upgraded catalogs must match. All eight
isolated database names retain the strict allowlist, random suffix, identity
checks and confirmed cleanup; the two separate NOT VALID generator databases
remain required. Sequence differences and categories absent from the comparator
(complete views/functions/triggers, privileges and policies) remain outside any
schema-equivalence claim.

## First PG16 failure and source-position correction

Commit 8494360 / Actions34023806931 attempt 1 failed its catalog task at
"0144 replacement postcondition failed: division_apply.da_status_ck". The prior
index/default/constraint-add/FK-rename probes had run, but no complete ORM summary
was produced and the separate generator audit was not reached. This failed run
is not acceptance evidence and is not retried unchanged.

The initial guard incorrectly required byte-identical conbin for the eight
validation-only replacements. PostgreSQL 16 stores parser character locations in
that internal tree; PostgreSQL 18's normal nodeToString path writes -1 instead.
CREATE TABLE and ALTER TABLE source offsets differ even when every semantic
field is identical. The corrected guard excludes only bounded integer :location
fields in that internal serialization, retaining all operator/function OIDs,
constants, columns, casts, tree shape and dependency checks. The raw catalog
comparison of SQL, validation flags and event order is completely unchanged.

Both engine probes exercise the exact SQL source-position comparison and seven
semantic mutations (Boolean operation, operator, function, column, constant type,
NULL flag and constant bytes) that must still differ. The PG16 report must show
exactly the eight numeric checks with location-only changes; PGlite18 must show
none. New committed PG16 execution is required to verify that this source-based
diagnosis fully resolves the failed postcondition; no production data is used.
The corrected local targeted suite passed all three files / 15 tests in 128.78
seconds, including both full-schema API children and seven semantic mutations;
both TypeScript configurations passed again.

Primary implementation evidence:
[PG16 StoreRelCheck](https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/src/backend/catalog/heap.c),
[PG16 location serialization](https://raw.githubusercontent.com/postgres/postgres/REL_16_STABLE/src/backend/nodes/outfuncs.c),
[PG18 nodeToString](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/nodes/outfuncs.c).

## CI capacity support — TEST-006

The previous combined Worker job used 18m54s of its 20-minute limit (66 seconds
remaining). Catalog execution alone took 161 seconds. This batch separates
catalog and unit/type/route execution onto independently isolated Linux jobs,
each retaining the original 20-minute limit, Node/npm and PostgreSQL versions,
commands, assertions and child-process timeouts. No Worker-unit concurrency
increase or test exclusion is introduced.

The original required-check job name is retained as an always-evaluated aggregate.
Both dependency results must be exactly success; failure, cancellation or skip
cannot produce a successful aggregate. Existing runtime/frontend/secret-scan
jobs and trigger filters are unchanged. The workflow now has ten jobs rather
than eight. A source-contract test pins this structure. Actual new run timings
must still be measured; the prior native allocator issue TEST-005 is not solved
by this capacity separation.

The first targeted local run passed both engine probes but failed a source-line
assertion: the frozen CHECK substring was inside an ALTER TABLE line and excluded
the trailing semicolon. The test now requires the exact source substring within
the frozen line range, not equality with the entire line. The source contract
and SQL were not weakened or edited to hide a mismatch. Final local full-suite
verification passed 250 files, 1,592 tests with four dedicated PG16 tests skipped
(1,596 total), in 496.14 seconds using the existing local maxWorkers=2 command.
Both 4-GiB TypeScript configurations passed. A final post-edit targeted rerun
passed three files / 15 tests in 125.29 seconds, including both network-denied
engine children. Committed CI results will be recorded in the root audit after
verification; these local results are not a PG16 or production receipt.

PostgreSQL and Workers skills influenced bounded locks, explicit transactional
effects, dependency/comment preservation, original-source SQL, isolated engine
testing and the no-I/O SQL mirror. Worker bindings, secrets and runtime API
signatures are unchanged.

Primary sources:
[PG16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html),
[pg_constraint](https://www.postgresql.org/docs/16/catalog-pg-constraint.html),
[pg_depend](https://www.postgresql.org/docs/16/catalog-pg-depend.html),
[GitHub needs and always](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds),
[Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
