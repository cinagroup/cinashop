# Membership coupon claims under the commissioned App LOGIN

The PHP-compatible member coupon flow permits a qualified member to claim an
ordinary, visible `category=2` issue once. PR190 restored that behavior, but its
new eligibility check used `SELECT ... FOR SHARE NOWAIT` on `system_config`
and `member_right`. The reviewed App profile intentionally grants those tables
SELECT only. PostgreSQL requires UPDATE authority for that row-lock operation,
so an otherwise valid request could fail with a generic HTTP business500.

The unchanged formal-profile HTTP case reproduced that failure on native PG16.
The actual server log records SQLSTATE42501, permission denied for
`system_config`; the following query observes the aborted transaction. The
baseline and its actual nonzero exit are retained separately from fixed runs.
The first diagnostic wrapper stopped before obtaining a business result and
is not counted as a reproduction.

## Fixed existing capability

The claim uses the already commissioned `checkout_lock_pricing_v1()` capability
through `protectCheckoutPricingSources`. That helper verifies READ COMMITTED,
the exact source namespace and the reviewed function installation before
acquiring the fixed SHARE locks. Ordinary SELECTs then read the current
membership setting and coupon right. The same transaction holds the existing
issue and user locks through the actual stock, owned-coupon and issue-log
writes. Its SHARE locks also protect against inserted configuration winners,
renames and absent-key inserts until commit.

The App LOGIN still has no configuration UPDATE or other DML authority. No
schema, role plan, grant, lock-function definition or runtime installer changes.
A missing, revoked or drifted capability fails closed. Lock contention retains
the explicit unknown-result/refetch response and never triggers an automatic
write retry. This deliberately broad fixed lock can refuse a claim while an
Admin configuration writer or conflicting maintenance operation holds a lock.

An already-owned modern request returns the same actual owned ID before
re-evaluating a retired issue or membership policy. It does not grant again.
A legacy repeated claim remains a once-limit refusal. An ineligible legacy
member request retains its original generic refusal text; modern eligibility
reads keep their detailed reason. Nonmanual receive modes and non-App issues
remain closed. The previously blanket category2 assertion is narrowed only
for a coupon that the same real API user already owns; all no-write checks
remain in place.

## Evidence boundaries

Native tests use independently authenticated App/Admin LOGINs and the actual
full commissioning/profile audits. A negative control must still show that
ordinary configuration SELECT works while direct FOR SHARE is denied42501.
Successful claims, exact owned-ID replay, configuration concurrency and missing
capability refusal are checked against actual SQL rows and sequences.

The lightweight member-coupon fixture acquires the existing capability through
an explicit additive wrapper that validates its owned PG16 endpoint. It does
not change the historical fixture bytes, install anything at request time or
prove the full application-role profile. That role proof comes from the
separate formal native HTTP tests.

Hidden Browser acceptance exercises the shipped PHP-parity UI against the
actual Worker/JWT, owned native PG16 and local R2. It retains seventeen ordered
phases, three real claims, actual owned-ID navigation, paging, rule display,
lost-response receipt reconciliation and old-owner fencing. The independent
verifier retains the original complete SQL/sequence/resource and transport
oracles, binds the new candidate and restores the two synthetic local journals.
Synthetic sessions and delivery controls are not production-login proof.
Shipped frontend source and original assets are unchanged in this repair.

The prior Supplier cart-count CI failure occurred while creating its paid-order
fixture, before the intended read-limit assertion. The server reported an
actual pricing-lock NOWAIT refusal. A single native rerun with independent
before/after lock observations passed; no conflicting holder was observed.
That result does not identify or fix the historical blocker. The original test
is restored byte for byte; production retries, lock behavior, grants and fixture
maintenance scheduling are unchanged. Its original business400 and full-state
assertions remain required in later CI.

## Live advisory source replacement

The PR192 UniApp job passed its runtime and34 scoped advisory/package tests,
then its live npm gate refused an unknown numeric source1243432. The actual npm
receipt and [the Vite maintainer advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
identify the same already backported Windows alternate-path advisory,
GHSA-fx2h-pf6j-xcff, under source1243432/moderate instead of1123525/high. Its
URL and affected range<=6.4.2 are unchanged. The existing reversible source
patch and official commit96b0c10162e9c55485d922db2cfc6b8227cbc176 stay fixed.

The exact previous baseline is preserved in a new immutable snapshot. Only
that direct advisory source/severity and the Vite entry's corresponding source
ID change; a complete transformation test checks every other baseline tuple,
node, forward edge, chain and package severity. The retired source is forbidden
on reappearance. Negative cases reject a different source, URL, severity, range
or missing record. The original body-parser historical graph assertion reads
its original frozen baseline. No gate implementation, dependency, lock, vendor
archive or shipped UI code changes. The review receipt is
`workers-ts/audit/uni-d3-vite-source-replacement-20261027.json`.

## Executed repair validation

The native union contains125 distinct full-name cases across five files:
16 new formal App cases,57 existing membership-coupon cases,38 commerce cases,
8 template HTTP cases and6 issuer HTTP cases. Runner572 execution entries
and both Worker TypeScript configurations passed. New fixture/oracle/type-only
errors are retained separately; the complete union shows a later same-name pass
for every failed native case. The final type adapter emits identical JavaScript.

The advisory/package union has41 passing cases. Six unchanged Vite checks first
refused the local shared `node_modules` symlink path before exercising their
behavior; those six passed with Node's `--preserve-symlinks`, without changing
an assertion, dependency or archive. The other35 passing cases were retained.
Both the saved actual npm receipt and a new live npm gate execution passed.
Remote CI and the still-unattributed Supplier historical lock failure are
separate evidence; these targeted passes do not assert full CI completion.
