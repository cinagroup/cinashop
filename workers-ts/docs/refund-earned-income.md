# Earned income across refund-order generations

2026-09-15. Local candidate; **not deployed**. Physical refund materialization
remains unwired. This increment adapts the existing financial services to its
remaining orders; it does not activate physical splitting or install its table.

## Failure reproduced

Two new actual checkout/receipt/refund/materialization tests failed on native
PostgreSQL before the fix (59 existing cases passed):

- Receipt before the first split: the second refund left 140 buyer points,
  instead of 40. The original 200-point grant belonged to the root, not to the
  newly created remaining child, so the second 100-point reversal was missing.
- Receipt between the first and second splits: the third refund failed with
  `拆单财务快照不一致`. Its grant still belonged to the retained child ID, but
  the child's gift/commission/payment totals had already shrunk again.

The same identity distinction applies to earned brokerage. The provider
payment root, the current application order and the actual income owner are
not necessarily the same order.

## Implemented contract

The append-only candidate evidence now has a bounded (2 KiB)
`earned_income_scope` column. It is explicitly JSON `null` for a source not yet
received. At the first split of a received source, it freezes that source's
order ID, buyer UID, originating refund ID, product gift total, payment total
and each commission-type total **before any shrinking**. Subsequent records
retain the same scope; they must not silently replace or clear it.

The generation reader checks strict keys, types, bounds, originating record
and source identity, chain continuity, received status, and that current
amounts do not exceed the original bases. Reads project the compact column,
not every archived full source snapshot. Ordinary unmarked orders still do
not require the candidate table. Invalid marked evidence is rejected, not
repaired or downgraded to a legacy calculation.

For each earned-income kind:

```
cumulative refunded basis = original basis - current generation total
                         + refunded basis inside the current generation
reversal target = floor(actual credited income * refunded basis / original basis)
```

This preserves allocated goods/payment residues, including the existing cash
concession policy. It does not recalculate an old grant from today's reward
settings. Product gifts, payment gifts and all six commission types keep
separate bases. Full allocation returns the exact final residual unit.

Only earned-income lookup, cumulative reversal and new reversal ledger links
use the frozen income owner. Original grant IDs, link IDs, amounts and event
keys are not repointed. Existing commission full-reversal freeze clearing is
retained. Spent points, returned-point exclusions, `backIntegral` and cash
continue to use their **current-generation** scope.

The user pre-lock step includes actual original brokerage recipients, which
can differ from a child's current attribution. It uses the existing indexed
`link_id` lookup, bounds the recipient evidence, then acquires the union of
buyer/current/historical recipients in ascending UID order. The receipt and
refund finalizer pass the prepared income owner through this step. All new
queries are awaited inside the existing transaction, without provider I/O.

## Verification

Expanded native PostgreSQL **16.15** regression: **11 files / 286 tests passed**,
zero failures/skips, 200.75 seconds, using the isolated non-superuser
`finance_test` role. The materialization suite has 76 cases (17 added here),
and the new pure income-scope suite has 17. These are selected regression
suites, not the whole repository, Workers runtime or production acceptance.

Both final TypeScript configurations passed. The main configuration includes
top-level test files; the runtime configuration has its distinct runtime
scope. Whitespace checks passed without changing Windows line-ending settings.

The cases added in this increment cover original receipt, receipt between
refunds, payment-gift rounding and later configuration changes, a received
fulfillment child distinct from its payment root, sibling income isolation,
immutable grants, exact terminal replay, malformed/changed scope evidence,
DDL bounds, late rollback and a native lower-UID recipient lock race. Pure
tests separately exercise all six per-type bases and malformed inputs.

The native recipient race proves the exact blocker using `pg_blocking_pids`:
while finalization waits on the original recipient (UID 5), a separate holder
can still lock buyer/current-recipient UIDs 11 and 22 with `NOWAIT`. The
original recipient then loses exactly the next 0.30 commission, not the new
attribution recipient. The other five existing native lock cases also passed.

Accepted no-payment-gift receipt sequence: buyer points 120 -> 40 -> 100,
commission balance 3.30 -> 3.00 -> 0.00. Actual payment grants at rate 3 produce
second-refund buyer balances of 129 (root received) or 128 (receipt between
splits); both reach 100 at the final refund even after configuration changes.
Original grant rows remain identical, except for the existing commission
freeze-clearing rule at full reversal. Terminal replays do not write again.

Retained run history (overlapping runs, not additive counts):

| Local cluster under `.cache` | Port | Result |
| --- | --- | --- |
| `finance-postgres-Up2vth` | 64968 | Red reproduction: 59 passed / 2 failed |
| `finance-postgres-MYKJIE` | 52883 | Initial adapter: 97 passed / 2 stale static-signature assertions failed |
| `finance-postgres-NaE70G` | 58106 | Expanded 286 passed |

The static assertions now match the income-owner argument while retaining
their activity/cart-plan-before-user-lock checks. Development type checks
also caught a multiline assertion syntax error, a string-index type mismatch,
and a widened shipping fixture literal. These were fixed without `any`, double
casts, relaxed compiler settings or weakened behavior assertions. The final
shipping-literal narrowing is type-only; both type checks passed afterward.

All three runners reported zero remaining fixture databases/roles and stopped.
Independent read-only audits confirmed `pg_ctl status` exit 3, no PID or
bootstrap-password file and no listener at each exact test port. Final
inspection found zero trusted test PostgreSQL processes. Stopped diagnostic
directories are retained; no unrelated service was stopped or deleted.

Reproduce from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/refund-order-materialization.test.ts test/refund-earned-income.test.ts test/refund-line-compensation.test.ts test/refund-line-finance.test.ts test/split-order-refund-identity.test.ts test/split-order-line-finance.test.ts test/supplier-split-ledger.test.ts test/admin-refund-operation-service.test.ts test/admin-refund-creation-quote.test.ts test/order-reward.test.ts test/store-order-refund-postgres-migration.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Release boundaries

This is not acceptance of supplier pending/settled-income ownership,
fulfillment splitting after refund generations, general receipt/read/delete
propagation, invoice/promotion ownership, unshipped gift-only remainder or
independent merchant freight allocation. These remain open, together with
root-before-child atomic financial/materialization integration, guarded
DDL/catalog/ACL installation, coordinated writers, Hyperdrive/workerd/provider
and browser acceptance, capacity/CI checks and deployment.

The candidate schema/DDL is intentionally not exported/installed by the live
migration chain. This added column is not a production upgrade script, and no
missing-column repair is performed at runtime.

Workers and PostgreSQL skills guided bounded evidence, awaited transaction
work and consistent locking. The
[current official Workers guidance](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/),
installed Workers types (5.20260828.1), complete Hyperdrive interface and local
Wrangler Hyperdrive schema were consulted; no dependency or binding changed.

The user's confirmation that new images load remains accepted. This increment
does not change production, images or caches, repeat browser tests, stage,
commit, push or deploy. No production connection fallback is used by tests.
The original nine staged files and checklist totals **240 checked / 164 open /
404 total** remain unchanged; this does not close the overall physical refund
split requirement.
