# DB-009E2A — NOT VALID generation prerequisite

Status: candidate implementation; Linux PostgreSQL 16 evidence pending. This
does **not** close DB-009E2: none of its 39 CHECKs or two foreign keys are added
to business models or deployment migrations in this batch. No production access.

## Contract

- `notValid(check(...))` and `notValid(foreignKey(...))` decorate a local builder
  without changing its original object or Drizzle prototypes. Fluent FK actions
  and typed column references remain available.
- The existing install hook verifies the original SHA-256 of **all three**
  drizzle-kit 0.31.10 bundles before writing any. It accepts pristine upstream,
  the exact previously audited ordering-only patch, or the complete current patch.
  Partial edits, unknown versions and changed generated code fail closed. No
  dependency version or secret-scan allowlist changes are made.
- PostgreSQL snapshot CHECK/FK objects can carry `notValid: true`; other values
  are rejected. Persisted snapshots retain the flag. Only marked constraints use
  a versioned JSON squash transport; ordinary transport remains unchanged.
- Fresh marked CHECKs are emitted as `ALTER TABLE ADD CONSTRAINT ... NOT VALID`
  after `CREATE TABLE`, because inline CREATE TABLE does not accept that clause.
  Marked FKs remain after referenced unique indexes. Existing-table additions
  retain NOT VALID. Public and explicitly named schemas are exercised.
- PostgreSQL still checks subsequent writes. Existing invalid rows are not
  repaired or deleted; explicit VALIDATE fails until their violations are resolved.
  This distinction follows [PostgreSQL 16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html)
  and [CREATE TABLE](https://www.postgresql.org/docs/16/sql-createtable.html).

## Deliberate limits

- This extension requires the pinned install hook. An install with scripts
  disabled, an unpatched upstream generator or another version is unsupported.
- `push`/`pull` introspection cannot round-trip this extension into generated
  TypeScript. The common PostgreSQL introspector checks selected table metadata
  read-only and refuses any unvalidated CHECK/FK, with a constant diagnostic.
  Upstream's progress renderer may exit the process with code 1 on that refusal.
  This is an explicit unsupported-operation gate, not implemented pull support.
- Raw snapshot differences can still propose DROP/ADD for changed definitions
  or a removed flag; those are **not safe upgrades to auto-apply**. A reviewed
  forward migration must preserve dependencies and choose validation deliberately.
  The legacy `alter_reference` converter refuses marked FKs; the tested snapshot
  differ uses separate drop/add statements. Business upgrade guards are DB-009E2B.
- Unmarked upstream CHECK squash transport still mishandles semicolons. The
  marked JSON transport preserves them, but this patch does not claim a general
  upstream serializer repair. MySQL/SQLite ordinary generation is regression-tested.
- No privilege, RLS, concurrent-DDL, production, full introspection or complete
  database-equivalence claim follows from these fixture tests.

## Verification design

`test/drizzle-not-valid.test.ts` exercises model typing/runtime boundaries,
forged/partial patch rejection, both real API entry points and actual CLI
generate/upgrade/export. Subprocesses have a small environment allowlist and a
socket-denying preload; artifacts are self-created temporary files only.

Each API probe checks five marked constraints across two schemas, persisted
snapshots/no-op, eight malformed metadata cases, initial and additive DDL,
retention of four invalid old rows, table/index and original constraint identity,
SQL NULL CHECK semantics, strict new INSERT/UPDATE errors, composite-FK tenant
isolation, update/delete cascades, five explicit validation refusals, failure
rollback, and refusal of unsupported read-only introspection. Independent
PostgreSQL 16 CI probes use the same assertions on two randomly named disposable
databases. Identity is verified before creation and again after connection;
cleanup only drops exact recorded database names, without FORCE.

The existing full-model CLI/API tests and five-path 263-table catalog audit remain
unchanged gates. Their SQL digest and every raw difference must remain equal to
the previous verified run before this prerequisite is marked complete.
