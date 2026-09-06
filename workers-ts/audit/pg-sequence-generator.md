# DB-009E5A — Typed sequence generator prerequisite

Status: local candidate verified; Linux PostgreSQL 16 evidence pending. Local
regression passed 251 files / 1,599 tests with four dedicated PostgreSQL tests
skipped (1,603 total), in 522.26s; both TypeScript configurations passed. The
four-file generator/legacy-ordering/NOT VALID/capacity group passed 18 tests.
This is the prerequisite for DB-009E5B, not a completed business sequence upgrade.
The business model, external/embedded migrations and existing eight full-catalog
paths remain unchanged. No production access is required or permitted by the test runner.

## Contract

- `withSequenceState(sequence, { dataType, ownedBy })` makes a local descriptor
  copy of a real Drizzle sequence. It does not mutate the original object or
  package prototypes. A lazy, typed PostgreSQL-column callback resolves ownership
  after the owning table is declared; the table and sequence must share a schema.
- The pinned drizzle-kit 0.31.10 CLI, CJS and ESM bundles carry the explicit
  `smallint`/`integer`/`bigint` and owning-column/NONE metadata through persisted
  snapshots. Strict, versioned JSON transport preserves quotes and semicolons.
- Marked sequences use explicit type, increment, bounds, start, cache and
  CYCLE/NO CYCLE. BigInt validation preserves exact numeric strings beyond
  JavaScript's safe-number range and refuses unsafe numeric inputs before string
  conversion. Ascending/descending defaults follow the declared physical type.
- Sequence creation precedes table defaults; ownership statements follow table,
  column and view changes. The entire previously frozen foreign-key ordering
  block and NOT VALID introspection guard remain byte-contiguous and tested.
- Every installed entry point must reconstruct to its unchanged public upstream
  SHA-256 before any write. Pristine, ordering-only, prior NOT VALID and complete
  current variants are accepted; unknown/partial edits and other versions fail
  closed. Cached variants are derived only from checksum-verified originals;
  every later input still needs a full digest and byte-for-byte match. A forged
  first input cannot seed this cache. No dependency or scanner exception changes.
- Removing metadata or dropping, renaming or moving a marked sequence is refused
  rather than silently proposing a destructive replacement. Unsupported custom
  sequence introspection fails before proposed SQL; ordinary SERIAL, IDENTITY
  and unowned bigint introspection remain supported and actually exercised.

## PostgreSQL semantics and limits

[PostgreSQL 16 ALTER SEQUENCE](https://www.postgresql.org/docs/16/sql-altersequence.html)
distinguishes START (recorded restart start) from RESTART (current value), requires
the same schema and role for an owning column, and documents blocking of concurrent
sequence operations. OWNED BY makes a column/table deletion also delete its
sequence; NONE removes that dependency. This extension does not grant ownership
privileges or claim that generated ALTER statements are safe online migrations.

[PostgreSQL 16 sequence functions](https://www.postgresql.org/docs/16/functions-sequence.html)
document that nextval allocation is not reclaimed by transaction rollback.
Fixture tests explicitly verify that behavior; this is not a gapless-ID mechanism.
Generated SQL contains no RESTART, setval or DROP SEQUENCE. Test-only setval is
used in an isolated fixture to force exhaustion, never to repair business data.
ALTER proposals may rewrite sequence storage; preserving an OID/current counter
does not prove relfilenode preservation or concurrent-use safety.

The extension is not a new general-purpose pull printer or automatic business
migration mechanism. Complete old-ORM upgrade, exact current-counter/owning
column/default/ACL/dependency guards, PostgreSQL 16 peer-lock/concurrent allocation
and all-path catalog equality remain DB-009E5B. The one existing raw business
sequence difference must remain visible until those requirements are verified.

## Verification design

- Three independent source-contract tests retain each CLI/CJS/ESM mutation and
  cold-cache refusal, with the existing default five-second per-test limit.
  Existing DB-008/NOT VALID tests, timeouts and CI concurrency remain unchanged.
- Actual CLI generate, incremental upgrade, export, persisted snapshots and
  byte-identical repeated no-op are executed in disposable local databases.
- Both actual APIs execute four sequences across two schemas, all three types,
  quoted identifiers, 22 malformed/unsafe-transition refusals and 20 unsafe
  numeric-input refusals. Assertions cover fresh/upgrade equality, original OIDs,
  comments, rows and counters, committed continuation, DDL rollback, owned-column
  deletion rollback, detach, NO CYCLE, descending defaults, exact bigint values,
  nextval rollback gaps and SQLSTATE 2200H exhaustion. Custom read-only
  introspection refusal and ordinary introspection no-op both use real APIs.
- Local child processes strip unrelated environment values and deny sockets.
  `audit:orm:sequences` separately checks the exact dedicated loopback
  `finance_test/cinashop_finance_test` identity and PostgreSQL major 16, then
  creates two random `seq_audit_(cjs|esm)_...` databases. Statement/lock timeouts
  are 30s/2s; cleanup validates and drops only exact recorded fixture names,
  without FORCE, and verifies absence before reporting success.
- The full eight-path 263-table audit, original two NOT VALID fixture databases,
  all earlier proof reports, SQL hashes and raw business differences must remain
  identical to the previous verified baseline. Two new fixture databases are
  not counted as additional full business-schema upgrade paths.
