# Paid membership savings ledger — 2026-09-19

Local candidate only. No production database access, historical import, image
change, DDL deployment, staging, commit, push or release is part of this increment.

## Observed gap and contract

The TypeScript schema and membership/customer readers already exposed
`store_order_economize`, but the actual paid-order outbox had no writer. Two
native PostgreSQL red cases completed the real balance-payment/outbox flow (or
its retry) and still found an empty ledger. An ordinary-level negative control
passed. This is a missing new-order feature, not historical MySQL reconciliation.

PHP `app/listener/order/Pay.php` dispatches `OrderJob::setEconomizeMoney`.
`app/jobs/order/OrderJob.php` records paid-member goods, freight and member-coupon
benefits. Goods count only `price_type=member`, multiplying per-unit
`vip_truePrice` by quantity. Ordinary level discounts are not paid-member savings.
The membership reader sums historical gross benefits, not refund-adjusted income.
The separate `OtherOrderJob` offline-order ledger is outside this increment.

## Implementation

- Checkout stores `checkout-member-savings-v1`, admitted `paid_member`, per-line
  `member_postage_price` and `member_coupon_price` alongside the previously added
  per-unit VIP evidence. Activity markdowns remain excluded from goods savings.
- Member freight records only the express membership reduction. Offline payment,
  threshold/package free shipping and exempt products do not invent membership
  savings. A positive freight benefit equals raw minus charged line freight.
- A member coupon is a template with `category=2`. Its classification joins both
  the confirmation fingerprint and the final locked template authority check.
  Positive coupon savings equal that line's actual coupon allocation; no second
  discount is subtracted from payment or refundable cash.
- The existing paid outbox transaction writes the payment-root ledger after
  supplier allocation, before the remaining effects and completion marker.
  All writes roll back together. Original root cart history survives splitting.
  Only the payment root is booked, never its children. The existing unique
  `(order_id, uid)` key prevents duplicates; an existing identical row is accepted
  unchanged and a conflicting row rejects the task without overwriting it.
- Readers for paid customer orders derive `memberPrice` and `postagePrice` from
  each new order's own stored rows, including supplier/refund children. This can
  display the admitted benefit before the asynchronous root ledger finishes.
  The membership homepage aggregate becomes visible after that task commits.
- New evidence validates version, SQL/snapshot identities, UID, quantity,
  eligibility, money and component consistency. Paid-writer SQL bounds rows to
  201 (rejecting over 200), individual TEXT to 64 KiB and aggregate TEXT to 8 MiB
  before transfer. Pure validation also checks those limits. This does not claim
  to harden every pre-existing customer-detail query or its full DTO.
- All-unversioned old snapshots are unknown: no current SKU/right reconstruction
  and no ledger insertion. Existing legacy ledger values remain a reader fallback.
  Mixed/damaged versioned evidence fails closed instead of silently becoming zero.

Partial splitting initially exposed a one-cent error when freight savings were
rounded independently. The corrected child benefit follows each child's already
partitioned raw-minus-charged freight. Per-unit goods savings remain unchanged
and multiply by child quantity; member coupons follow coupon-line allocation.
Small-cent property cases verify conservation across every partial quantity split
for quantities 2–9 and raw freight 1–9 cents.

The real membership homepage also uncovered a pre-existing Date serialization
failure: raw SQL placeholders bypassed the timestamp column encoder. Coupon
window predicates now use typed `lte`/`gte` with `isNull`, verified against native
PostgreSQL with active, unbounded, future, expired, ordinary, disabled and deleted
coupon issues. This changes no coupon eligibility rule.

## Verification evidence

The new `order-member-economize.test.ts` uses all 165 registered migrations /
270 tables and an independent non-owner authenticated business connection.
Payment is the actual local balance debit plus actual paid outbox; offline
payment is an explicit local service fixture, not provider verification. External
fetch and queue delivery are forbidden. Test-only grants are declared in this
suite, not added to the shared role profile or production ACLs.

Coverage includes unpaid exclusion; immutable checkout rights after SKU/config
edits; coupon classification after edits; ordinary-level and nonmember freight
exclusion; matching/legacy ledger preservation; supplier allocation plus completed
refund and child details; cross-user rejection; late audit failure with atomic
rollback/retry; missing INSERT permission; corrupt evidence; and a conflicting
ledger committed during an independently observed outbox lock wait. Refunds do
not erase historical gross savings or create extra child ledger rows.

Observed intermediate runs (not a full-repository test result):

- Initial actual-pay red run: 2 failed / 1 passed, empty ledger reproduced.
- Initial ledger plus existing lifecycle: 6 passed.
- Expanded run: 3 failed / 13 passed, all failures were the real membership
  homepage Date serialization error; fixed in source, not hidden by mocking.
- After timestamp fix: 29 passed across economize, membership lifecycle and
  customer order-generation suites.
- Pure evidence/allocation/runner/outbox/membership regression: 185 passed before
  the final two runner allowlist cases were added.
- Broader native checkout/coupon run: 197 passed / 4 failed. One was the new
  snapshot error omitting the established word `快照` (fixed without weakening the
  test); three were fixture setup denied under the default non-superuser runner
  (`CREATE ROLE` and `session_replication_role`). These two explicit schema/ACL
  suites are now admitted to the existing isolated maintenance mode. Production
  permissions and independent business-role grants are unchanged.
- Main and runtime-test TypeScript checks passed before final assertion additions.

Final regression results:

- Checkout/member evidence/line finance/template authority: **99 passed** in four
  native PostgreSQL files, 96.47 seconds.
- Economize/lifecycle/customer generations/coupon item and relation authority:
  **133 passed** in five native PostgreSQL files, 288.30 seconds, including all
  **16 economize scenarios**. No failed or skipped tests in either final batch.
- Coupon-template suite expanded with same-price membership classification
  changes before and after receipt validation and equivalent nonmember categories:
  **30 passed**, 45.98 seconds. This overlaps the 99-test batch.
- Final pure/allocation/runner/outbox/membership batch: **190 passed** across six
  files, including **34 bounded membership evidence cases**. The last additions
  reject array-valued version/price-type fields instead of coercing them to text.
  These batches overlap; do not sum them as distinct tests or a full-repository run.
- Final Worker main and runtime-test TypeScript reruns both pass after the strict
  metadata validation and coupon-confirmation additions. Runner syntax and scoped
  tracked-file whitespace checks pass.

All eight attempted clusters (`iyXVeC`, `JQtTGl`, `Cicn6Q`, `avDYUf`, `tv40Aq`,
`1sKbiS`, `U85FjR`, `LCr65I`) reported zero remaining fixture databases/roles and
confirmed shutdown. An independent approved read-only host check found no PID or
bootstrap-password files, no listeners on their eight selected ports and no
processes from the trusted PG binary. Stopped diagnostic directories remain;
nothing was recursively deleted. The original nine staged paths remain untouched.

## Reproduction

From `workers-ts`, using the already trusted local PostgreSQL 16 binary:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/checkout-member-evidence.test.ts test/checkout-line-finance.test.ts test/split-order-line-finance.test.ts test/checkout-coupon-template-authority.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/order-member-economize.test.ts test/checkout-member-lifecycle.test.ts test/customer-order-generations.test.ts test/checkout-coupon-item-authority.test.ts test/checkout-coupon-relations-authority.test.ts
node node_modules/vitest/vitest.mjs run test/order-member-savings.test.ts test/refund-split-allocation.test.ts test/checkout-line-allocation.test.ts test/local-finance-postgres-runner.test.ts test/order-outbox.test.ts test/paid-membership-migration.test.ts --maxWorkers=2
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

The maintenance mode creates only a fresh random-port loopback cluster. Its owner
can construct schema/ACL/session counterexamples; runtime-role cases remain
separately authenticated and least-privileged. The runner checks identity,
removes fixture databases/roles and stops its own cluster, retaining diagnostics.

## Remaining boundaries

- No old benefits are invented/backfilled; offline `other_order` economize,
  historical reporting and full customer DTO auditing remain separate work.
- Old pre-rollout coupon quotes need reconfirmation because their fingerprint
  lacks member-coupon classification. Never bypass receipt admission checks.
- No browser/frontend change or production image recheck is claimed here.
- Real deployment-role INSERT/SELECT/sequence privileges, Hyperdrive behavior,
  payment providers and coordinated release remain unverified in this increment.
- Workers/PostgreSQL skills guided the awaited existing transaction, unchanged
  lock order, bounded new reads and independent role checks. No new bindings,
  runtime dependencies or remote calls were introduced.
- Broad checklist items remain open at **240 checked / 164 open / 404 total**.
