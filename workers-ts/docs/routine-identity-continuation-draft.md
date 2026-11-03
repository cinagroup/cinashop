# Routine identity continuation maintenance draft

This read-only diagnostic authenticates stored prospective identity mappings
and their original code2Session witness anchors. It helps an operator locate
missing, corrupt, inactive and conflicting identity evidence before account
maintenance. It does not assign an AppID to an unmapped legacy binding.

Run from `workers-ts` with a dedicated, exclusively held PG16 maintenance LOGIN
connection (`max:1`, `prepare:false`), using the maintenance secret mechanism:

```text
ROUTINE_IDENTITY_DRAFT_DATABASE_URL=<explicit maintenance PostgreSQL URL>
ROUTINE_IDENTITY_DRAFT_FINGERPRINT_KEY=<independent random 32-byte lowercase hex key>
ROUTINE_IDENTITY_DRAFT_AUTHENTICATOR=<authenticator used by the stored identity records>
npx tsx scripts/inspect-routine-identity-continuation.ts <database> <maintenance-login>
```

Never place actual values in source, shell history, reports or tickets. These
three variables are mandatory; there is no `DATABASE_URL`, `APP_KEY`, inventory
variable, current AppID or OAuth Secret fallback. The fingerprint key must be
distinct from the record authenticator. Remote URLs require full TLS verification;
query options, fragments and database/user mismatches are refused. The CLI has
not been run against production by adding this implementation.
The record authenticator is limited to 4KiB of UTF-8. Durable future-time
checks retain the runtime decoder's local process clock semantics.

The library entry is `collectRoutineIdentityContinuationDraft(client, target,
fingerprintKey, { APP_KEY })` in `scripts/routine-ownership-inventory.ts`. The
authenticator stays in the local process for HMAC verification; it is not sent
to SQL and is never an activation capability. Do not share this connection,
install custom value transformations or supply connection/network callbacks.
Actual LOGIN, database/role OIDs, PG16, primary server and origin mode are checked.
An App LOGIN or `SET ROLE` cannot stand in for maintenance.

## One snapshot, two explicit scopes

The complete [database inventory](routine-ownership-inventory.md) still scans
all supported non-system heap sources and commits every physical row, including
soft-deleted rows and newly added tables, without attributing ownership. The
new classifier consumes rows during that same locked, repeatable-read, read-only
transaction. It does not run a second identity query after the inventory ends.
Both results are returned together only after the entire scan and classification
complete. `identity.inventorySourceDigest` binds the classification commitment
to the inventory source commitment.

Identity classification is deliberately limited to `ONLY public.user`,
`ONLY public.wechat_user`, `ONLY public.routine_identity_ownership` and
`ONLY public.routine_identity_witness`. Required built-in column types are
checked; signed record layouts reject extra columns. A wrong layout or partition
root causes whole-operation failure. Absent tables appear in `missingSources`;
they never count as evidence of a safe first install. Other schemas, inherited
children and newly added sources remain visible in the complete inventory and
`unclassifiedRelationCount`; their identities are not inferred from their names.
Non-Routine channel bindings are counted separately and not adopted.

The classifier retains at most 16,384 rows / 8MiB of selected identity fields,
across all four sources. It otherwise inherits the inventory's page, row,
relation, SQL timeout and 30-second whole-operation limits. Capacity, malformed
input, unsupported layouts, timeout or source drift never return a successful
prefix. The deadline is checked again after synchronous classification.

## What the classifications establish

The runtime services and maintenance classifier share pure closed-record HMAC
decoders. HMAC domains, fixed field order and existing durable time rules are
unchanged. The decoders perform no SQL, registry lookup or credential read.
Runtime LOGIN/catalog/transaction checks, fresh observation admission, live row
locks and current configuration checks remain in their original services.

Each stored owner is authenticated and joined to its exact physical binding,
UID and original `observation_id`, including observed timestamp, AppID and
openid equality. A newer valid witness cannot replace a missing first anchor.
An old original witness is checked with `allowExpired:true`; the fresh login
observation's 900-second limit does not expire durable evidence. The owner
creation interval remains observed time minus 60 to plus 900 seconds; the
witness retains its different original creation interval. Future bounds remain.

`verified_anchor_live` means these captured bytes and the live physical
user/binding matched in this snapshot. `verified_anchor_inactive` preserves
authenticated history for disabled/deleted users or bindings. Neither state
grants login, payment, notification or account-switch authority. Duplicate
subjects/bindings and multiple authenticated live subjects for one UID+AppID
are marked as conflicts rather than choosing a row by order. Different AppIDs
for the same UID retain distinct account commitments.

Every owner and witness receives a keyed record digest and a classification;
every Routine binding receives a keyed subject digest and state. Missing,
invalid, mismatched and unowned records remain counted. Corrupt mappings do not
turn their physical binding into an apparently clean unmapped record. Witness
`verified_linked` only means an authenticated same-subject mapping exists; it
does not mean the witness is that mapping's original anchor or authorizes use.
Unmapped bindings never acquire an account commitment from current config.

The report contains maintenance database/relation names and OIDs, counts,
snapshot/time, keyed identity/account/record digests and state labels. It
contains no raw UID, AppID, openid, phone, signed observation, record signature,
user entitlement, provider payload or secret. It is an operator diagnostic,
not an anonymous public receipt. A wrong authenticator and damaged signatures
can both produce invalid-record states; the diagnostic does not guess which
occurred. SQL errors/notices and CLI failures are redacted. Exit zero means
the complete diagnostic ran, not that its records are eligible for activation.

## Remaining account-switch work

`activationAllowed`, `permitIssued` and `switchCommissioned` are always false.
Catalog commissioning, payment originals and approved uses, separate refund /
shipping / subscription policies, other identity realms and external sources
are explicitly not evaluated. Full catalog fingerprints are observations,
not proof of commissioned runtime privileges or safe consumers. This is not a
global writer fence; transactions can change state after the snapshot ends.

No user, binding, entitlement, old order, payment, configuration, grant or
immutable evidence row is written. No provider, Redis, SMS, Queue or credential
registry is consulted. A complete account maintenance manifest, external work
closure, source/consumer verification, a one-use permit and atomic switch /
receipt recovery in the real configuration writer remain necessary. The
material AppID switch barrier remains closed. This draft must not be submitted
as a permit to that writer.

## Local acceptance

Phase57 accepted 162 actual PG16 cases and 156 pure cases, including 76 new
cases (52 codec, 6 classifier, 13 CLI, 5 native). Both complete Worker type
configurations passed. The initial whole identity file had 19 passes and one
fixture-cleanup failure: adding then dropping a column leaves a dropped
attribute slot, so the existing strict runtime catalog audit correctly refused
the altered layout. The only successor changed those two SQL fragments to
rename/rename-back. The current literal case passed; the other 19 case bodies,
helpers and production inputs were unchanged and their original results were
reused. The final identity file was not rerun as a whole; its 19 unselected
cases in the literal run were not added to the success count. The 14 inventory,
128 existing PG and five pure files were run in full, with no skips.

The new native positives use actual App LOGINs, code2Session/reconciliation
services, stored signed rows and a dedicated maintenance connection. Provider,
cache and phone continuity remain controlled fixtures; the new cases pass
server-verified phone input and do not claim live WeChat/phone acceptance.
The actual CLI also ran in a separate process against the owned loopback DB.
Checks cover aging, corrupt owner/anchor, missing first anchor with a valid
newest witness, multiple AppIDs per UID, same-account ambiguity, inactive and
unmapped deleted bindings, independent-peer RR drift/new source, App refusal
and signed-layout drift. User/rights/order/evidence snapshots remain unchanged
by classification. All four PG runs, including the failed initial run, recorded
zero remaining fixtures and stopped owned clusters.

Sources were frozen during every batch. The initial failed whole-file batch
took 385.84s, the corrected native/pure batch 494.13s and types 336.16s, each
within the existing 600s command / 1200s group budgets. Current source hashes,
the exact two-fragment successor, logs, results and read-only cross-review are
retained locally under `.cache/php-ts-phase57-validation`. Final documentation
was added after validation; it does not represent an independent rerun, full
CI, production-scale, Workerd/Hyperdrive or live-provider acceptance. Remote
operations remain deferred under the user's instruction.
