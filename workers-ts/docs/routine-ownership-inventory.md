# Routine account ownership: database inventory component

This maintenance tool collects database source fingerprints. It does **not**
attribute an old binding/payment to any AppID, classify unresolved ownership,
prove a provider payment, issue a maintenance manifest, or authorize activation.
The material AppID switch barrier remains closed. Existing users, bindings,
entitlements, payments and order state are never rewritten by this reader.

## Explicit command

Run from `workers-ts` using a dedicated PG16 maintenance LOGIN connection, not
an App/Admin/Financial runtime connection:

```text
ROUTINE_OWNERSHIP_INVENTORY_DATABASE_URL=<explicit maintenance PostgreSQL URL>
ROUTINE_OWNERSHIP_INVENTORY_FINGERPRINT_KEY=<independent random 32-byte lowercase hex key>
npx tsx scripts/inspect-routine-ownership.ts <database> <maintenance-login>
```

Supply these environment variables through the maintenance secret mechanism;
do not put real values in source, shell history, reports or tickets. The same
independent key is necessary to compare fingerprints. There is no runtime URL,
`DATABASE_URL`, current AppID, OAuth Secret or `APP_KEY` fallback. URL query
options/fragments and database/user mismatches are refused. Remote connections
require full TLS verification; loopback is available for isolated acceptance.
No production execution or deployment is implied by adding this command.

The library API is `collectRoutineOwnershipInventory(client, target, key)` in
`scripts/routine-ownership-inventory.ts`. It requires an exclusively held,
dedicated postgres.js root connection with `max:1, prepare:false`. Do not share
this client with other work, custom value transformations, or network callbacks.
Actual database/LOGIN/OIDs, PG16, primary server, superuser maintenance identity
and origin replication mode are checked. Using `SET ROLE` is insufficient.

## Snapshot and scope

Discovery includes every ordinary table and partition root in every schema
outside `pg_*` and `information_schema`, rather than a hand-picked list of
Routine tables. Live/deleted identity rows, witnesses, initiation/prepay history,
original evidence, orders/refunds, notification/job rows and newly added local
tables therefore cannot be omitted through a selective table list. Each heap
is scanned with `ONLY`; partition roots are reported with no directly stored
rows, and inheritance/partition children are each counted once.

The tool obtains nonblocking `ACCESS SHARE` locks on the discovered tables
before the first repeatable-read snapshot. It then verifies the discovered
scope again. These locks allow ordinary DML but prevent `TRUNCATE` and table
rewrites from creating a false-empty historical read. Every parsed data source
also attests its actual composite type OID, including an empty-table sentinel.
The SQL checks that OID before serializing a row. This catches a concurrent
schema rename followed by a new same-name schema/table, which explicit
repeatable-read catalog queries alone would miss.

The official PG16 documentation describes the [MVCC caveat for TRUNCATE and
rewrites](https://www.postgresql.org/docs/16/mvcc-caveats.html) and the
[transaction-local cursor semantics](https://www.postgresql.org/docs/16/sql-declare.html).
Rows stream through `NO SCROLL WITHOUT HOLD` cursors in batches of 16; no
`OFFSET`, complete result aggregation, provider call, Redis, SMS, DML, DDL,
grant, retry or historical backfill occurs. HMAC framing covers source OIDs,
physical row location, xmin and the server's JSON text, preserving numeric
precision without parsing numbers into JavaScript. Equal-value updates can
therefore invalidate the fingerprint. This is a conservative physical source
fingerprint, not a portable logical export or a stable cross-database hash.

Catalog fingerprints include non-system schemas, relations, columns/defaults,
constraints, indexes, trigger/rule/function definitions, types/collations,
policies, partition/inheritance structure, sequence definitions, roles and
memberships, default ACLs, database/role settings, extensions and event triggers.
Statistics/allocation fields are omitted. No user view query or user-defined type
output function is intentionally executed. Only the explicit built-in scalar
column allowlist is supported; custom JSON casts are refused.

Materialized views, foreign tables, custom table access methods, arrays,
domains, enums and unsupported column types cause the **whole operation** to
fail. They are never skipped. System/temporary storage, sequence `last_value`,
large objects, Redis/Queue state, external provider history and opaque external
credential references are outside this database inventory. No empty-first-install
or switch admission may be inferred from this component, even if it reports
zero business rows. Later maintenance must close and classify its entire
relevant database **and external** scope under the activation protocol.

## Resource and output boundaries

The hard limits are 2,048 source relations, 512 columns per source, 256KiB per
serialized source/catalog row, a 30-second application deadline, and 16 rows
per fetch. SQL statement/lock/idle deadlines are clamped to at most 5s/1s/5s;
existing shorter limits remain shorter. Temporary sort files are limited to at
most 64MiB without increasing a smaller existing limit. `ORDER BY ctid` can
require a server-side sort; a cursor bounds client batches, not that sort.
Catalog text such as function definitions is rendered by PostgreSQL before the
final byte check; these acceptance limits are not a backend memory quota.
This implementation does not claim production-scale throughput acceptance.

Text/bytea sizes are budgeted before full row JSON conversion. Compressed or
over-32KiB JSON documents are refused; bounded JSON numeric leaves are checked
before constructing expanded row text. A final serialized byte check remains.
Catalog fast-default values are checked before metadata conversion: JSON/JSONB
`attmissingval`, compressed missing values and missing arrays over 32KiB are
unsupported and cause whole-operation refusal. Ordinary small built-in defaults
remain fingerprinted, rather than being omitted from the catalog digest.
Oversize definitions, capacity/timeout, unsupported sources, busy DDL or source
identity drift return an error, never a successful prefix or a partial report.
The application deadline is checked between statements, so a last in-flight
statement can run up to its already bounded SQL deadline.

Only after every source completes is one report returned. It contains database,
maintenance and relation names/OIDs, snapshot/time, exact decimal-string counts
and domain-separated keyed HMAC digests. This is an operator maintenance report,
**not an anonymous public receipt**. It contains no raw business rows, payer,
openid, provider payload or credentials. SQL errors/causes are replaced by a
constant error; the CLI also suppresses raw notices and connection-close errors.
The report explicitly says `ownership: not_evaluated`,
`externalSourcesIncluded: false` and `activationAllowed: false`.

There is no stored permit or writer integration in this component. A future
single-use activation manifest must independently verify ownership evidence,
external work, declared account/merchant/credential references, current config,
the relevant source versions and all account-bound consumers in the actual
writer transaction. This report alone cannot satisfy any of those checks.
