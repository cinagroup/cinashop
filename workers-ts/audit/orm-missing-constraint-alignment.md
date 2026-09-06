# DB-009E2B: restore the 41 genuinely missing constraints

This is the implementation-time audit design. Final tested commit/run and acceptance
are recorded in the root MIGRATION_CHECKLIST.md and MIGRATION_SCHEMA_AUDIT.json.
Do not interpret this document as production deployment approval.

## Scope and provenance

The immutable baseline identifies 41 reference-only constraints after excluding the
12 possible FK aliases: 39 CHECK and 2 FK. The manifest binds the complete original
catalog rows, all original external/embedded SQL clauses, typed model declarations,
actual generator snapshots and the 96 referenced columns across 17 tables.
The reviewed starting point is 1641e65 / Actions 34013882048. No historical business
data is imported: this deployment is a fresh system, with PHP as a contract reference.

The seven NOT VALID CHECKs and spr_order_cart_info_fk retain their unvalidated
catalog state. wco_event_id_fk retains ON DELETE CASCADE; the nullable reply FK uses
NO ACTION. The other 32 CHECKs and the callback outbox FK remain validated.
Models use the separately tested local notValid builder; no new global patch or
dependency version change is introduced here.

## Additive upgrade and refusal policy

External 0142 and embedded 0148 use the same single DO statement:

- Capture current_schema, lock the exact 17 permanent ordinary tables in name order,
  reject inheritance/partition drift, and check column type/nullability/identity/
  generation/collation. Lock wait is bounded at two seconds.
- Preflight every constraint name and both referenced primary keys before adding
  anything. A wrong definition, validation state, parent, deferred state, disabled
  FK trigger or equivalent constraint under an unreviewed name is refused.
- Add only missing constraints. Use the original CHECK SQL, not pg_get_constraintdef
  text as executable input: reparsing the latter can change Boolean parse-tree
  grouping. Compare the resulting expression and validation metadata exactly.
- CHECK conkey is compared as a column set because PostgreSQL records expression
  encounter order; FK order remains ordered. No SQL expression is normalized away.
- Resolve built-ins before user schemas, put pg_temp last, explicitly qualify both
  FK tables and restore the caller's search_path.
- Never DROP, rename, VALIDATE, repair data or weaken a constraint. Any bad existing
  row under a validated addition aborts the statement/transaction.

This is deliberately not an online/zero-lock migration. Validated additions scan
existing rows while locks are held. The isolated PG16 runner supplies an outer
30-second statement timeout. A production application still needs explicit approval,
a bounded maintenance plan and current-data readiness checks. Column defaults and
unrelated schema objects are not individually preflighted by this DO; the complete
column/index catalog gates remain separate.

## Independent executable verification

The CJS and ESM unit children deny all sockets and retain only a small environment
allowlist. Each builds the complete old ORM snapshot by removing exactly these 41
entries from the current model snapshot, then verifies:

- 41 exact ADD proposals; generated proposal and guarded result have the same
  full catalog, with no non-target catalog changes.
- 33 independently bad existing-row failures and 8 NOT VALID cases preserving
  bad old rows while rejecting new bad INSERT/UPDATE and explicit validation.
- A separate committed-row fixture: 8 bad rows are committed before constraint
  installation, the installation is committed, and all 8 new bad inserts, changed
  bad-key updates and explicit validations fail while 8 valid new inserts succeed.
  An unchanged FK key on a committed historical orphan can still be updated; this
  legitimate PostgreSQL behavior is explicitly tested, not confused with validation.
- Every target name and validation status rejects drift; additional column,
  schema, inheritance, parent-key, FK-trigger, deferred and wrong-parent failures.
- 41 invalid INSERT and UPDATE contracts, plus 16 edge cases (JSON null/array/
  scalar, bounds, hashes, control characters, UUID and state/risk combinations).
- Existing rows, relation/constraint/trigger identities, files and dependencies;
  real view, user-trigger and dependent-FK fixtures; injected first-ADD failure;
  no-op identity; mixed present/missing constraints; temp and non-public isolation.
- Nullable reply FK, soft-deleted referencing rows, parent NO ACTION, callback
  CASCADE, and a user function shadowing jsonb_typeof with pg_catalog last.

The new child has its own 180-second bound; the older six-stage index child keeps
its original 90-second bound and all assertions. The PG16 catalog runner adds one
sixth full-schema database, orm_constraints, using the same helper. Its random name
is checked against an exact prefix/UUID pattern and PostgreSQL's 63-byte limit;
only names created by that run are eligible for cleanup, without FORCE.
All six paths retain the complete 3,700-column and 1,006-index gates, existing
default write probes and the 41 exact constraint contracts. Fresh vs upgraded
catalogs must match across all five compared catalog categories.

The historical manifests are unchanged. Source line shifts are handled by exact
AST declaration binding within the unique named pgTable; comments, wrong tables,
duplicate declarations and changed syntax are rejected, not accepted by a global
substring search.

## Limits and remaining audit work

This batch does not waive the 12 FK aliases, 9 same-name constraint differences or
the integer/ownership sequence difference. It does not certify full views,
functions, privileges, policies or triggers beyond the explicit test fixtures.
Real-role flows, providers, production application and release remain open.

Read-only model/index inspection found that spr_active_cart_uq covers only active
non-null reply references. No full child index on order_cart_info_id is present in
the current model's complete reply index set. The FK is correct for soft-deleted
rows (tested), but parent checks may scan them. This is a separate performance
review, not permission to add an unreviewed index or break the parity gate.

## Why the PostgreSQL guidance matters

The PostgreSQL skill's short-lock and FK-reference guidance shaped the guard and
rollback tests. PostgreSQL explicitly distinguishes NOT VALID from disabled
enforcement, and does not automatically create child-side FK indexes:
[ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html),
[pg_constraint](https://www.postgresql.org/docs/16/catalog-pg-constraint.html),
[foreign keys](https://www.postgresql.org/docs/16/ddl-constraints.html#DDL-CONSTRAINTS-FK).
