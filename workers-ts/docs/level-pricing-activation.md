# Level-price activation audit (2026-09-14, unpublished candidate)

## Evidence and scope

The previous membership-switch repair did not check account `levelStatus`.
An account with an assigned 80-percent level but activation zero still received
that price in product responses, legacy V2 cart, confirmation and persisted order.
`CheckoutMembershipSnapshot` also omitted activation, so a concurrent revocation
after pricing did not stop creation.

The initial 20-case PostgreSQL suite reproduced **16 failed / 4 passed**. Failure
evidence includes 100.00 × 2 being persisted as 160.00 for an inactive account,
confirm/create accepting activation changes, and creation succeeding after a
proven SKU-lock wait during which an independent connection committed revocation.
This is not merely a display mismatch or a source-text-only finding.

PHP source inspection in the adjacent `cinashop-php` checkout establishes:

- `app/services/user/level/SystemUserLevelServices.php:getDiscount` (near 172)
  queries the database account and requires its `level_status` before loading a
  visible, non-deleted level discount.
- `app/services/order/StoreCartServices.php` (near 821) invokes that method;
  `StoreProductServices.php:setLevelPrice` (near 2213) also uses it.
- PHP `getMinPrice` (near 2133) does not enforce activation in the same way. The
  candidate intentionally aligns the **displayed level offer** with eligibility,
  instead of preserving that presentation inconsistency.
- Existing TypeScript activation, reward and detection paths use strict
  `levelStatus === 1`. This repair follows that convention; zero and other integer
  values do not grant activation. No database default or existing account is changed.

No PHP framework/database was booted for this audit. The earlier PHP arithmetic
oracle remains separate evidence; this increment does not alter discount math.

## Repair and transaction boundary

Product detail/list/recommendations/legacy attributes, legacy V2 cart and order
pricing now require both the member-function switch and account activation before
loading the level definition. Paid membership remains independently eligible;
inactive level membership does not revoke valid SVIP benefits.

The internal checkout snapshot adds `levelActive: boolean | null`: null means the
feature is disabled, false means enabled but inactive. Level ID/definition are
bound only while active. Inactive dangling/edited definitions cannot affect price
and are neither loaded nor locked. A dangling **active** definition still rejects
creation through the existing guard.

Activation is part of the confirmation fingerprint, including when a cheaper
paid-member offer keeps the total unchanged. It is revalidated by the existing
user `FOR SHARE NOWAIT` query after business writes. A changed state or lock
conflict aborts the whole transaction; the caller receives the existing
`ORDER_QUOTE_RECONFIRM_REQUIRED` flow. The acquired row lock protects the activation
field until commit. No additional query, lock class, external I/O inside the
transaction, schema migration or silent repricing is added.

This uses the existing lock boundary rather than moving locks ahead of inventory
or waiting in reverse order behind an editor. The Postgres skill's lock-order and
short-transaction guidance informed that choice. PostgreSQL documents the conflict
behavior and transaction lifetime of `FOR SHARE` in its
[row-lock reference](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS).
The Workers skill guided the no-cross-request-state/no-new-binding review and
the separation of local results from Workers runtime acceptance.

The snapshot remains internal JSON fingerprint input, not a new client-supplied
authority field. After a future deployment, outstanding pre-change receipts with
a membership snapshot will need fresh confirmation because their fingerprint did
not include activation. Existing persisted-order replay still returns the original
order before repricing, even after receipt removal or activation changes.

## Local verification

The repaired initial 20 cases plus the existing 50-case checkout membership
boundary suite passed together: **70 passed, zero failed/skipped**. Existing
detail/level-cache and membership-boundary fixtures now explicitly mark their
intended active users as active; their original price/concurrency assertions were
not weakened. Database activation defaults remain zero.

The new suite was then extended to 21 cases with the actual activation controller:
its commit changes the next quote to the level price, while repeating activation
is rejected without another business mutation. Gifts are disabled in that case;
it is not a test of reward/coupon grants. Other cases cover invalid states,
same-service deactivation/reactivation, independent paid membership, anonymous
visitors, inactive dangling references, confirm/create and late-create changes,
explicit re-confirmation recovery, irrelevant edits while inactive/disabled,
persisted-order replay, receipt-free test-core callers, two independently observed
PostgreSQL SKU waits, and lock protection until commit.

The fixture uses actual services/DAOs/controllers and owned random PostgreSQL 16
databases with ORM-derived column tables. It validates the loopback test role and
database identity, requires distinct backend PIDs for concurrency, observes exact
`pg_blocking_pids` edges rather than assuming a sleep means blocked, and verifies
owned database removal. Identity, KV receipts and sequence allocation are explicit
local substitutes; these are unpaid synthetic orders, not production writes or
full authentication/provider/browser tests. A complete-ORM pricing authority
suite is also included in the final regression, separately from these fixtures.

Final broader regression: **16 files, 251 passed, zero failed/skipped**, including
the 21-case activation suite, 50 membership-boundary cases and 20 complete-ORM
pricing-authority cases (146.63 seconds). This includes the earlier 70 passing
cases; those totals are overlapping, not additive. Final unit and runtime
TypeScript checks both completed with exit zero. `git diff --check` passed.
No test timeout, runtime target or business assertion was relaxed.

```text
npm run test:unit -- --maxWorkers=2 test/level-pricing-activation.test.ts test/membership-pricing-policy.test.ts test/checkout-membership-boundary.test.ts test/checkout-pricing-config-authority.test.ts test/product-detail-cache-isolation.test.ts test/user-level-cache-authority.test.ts test/product-price-truncation.test.ts test/price.test.ts test/pc-product-detail-contract.test.ts test/uniapp-product-sku-postgres.test.ts test/v2-cart-compatibility-migration.test.ts test/paid-membership-migration.test.ts test/product-experience-migration.test.ts test/product-sku-retirement.test.ts test/user-level-migration.test.ts test/api-order-after-sale-migration.test.ts
npm run typecheck
```

## Remaining work and deployment limits

- **Subsequent local registration repair:** the four new-user INSERT sites now
  initialize activation from current SQL policy after identity locks, with real
  PostgreSQL entry/race/rollback coverage. See
  [registration activation audit](registration-level-activation.md) for evidence
  and its precise snapshot/external-service limits. This remains unpublished and
  does not reactivate existing accounts or bypass the pricing gate.
- PHP user-profile rendering also presents activation as one when no manual
  activation is needed. That presentation is not evidence of a committed account
  update. Registration/profile consistency and changing activation mode for
  existing accounts remain distinct from this persisted-state pricing gate.
- The subsequent local [selected-SKU price increment](sku-membership-price.md)
  covers ordinary detail quotes and PC/UniApp rendering, not all-client lifecycle
  parity. Zero-discount policy, raw nested V2 cart VIP fields and modern-cart
  display still have separate open work. The one-cent payable floor is unchanged.
- Product/user/level/SKU reads do not form one atomic display snapshot. Actual
  Hyperdrive freshness, production roles, contention/capacity, current-candidate
  Linux/workerd/CI, browser flows and authorized rollout remain unverified. Earlier
  Windows workerd startup failures are not converted into passing runtime tests.
- No activation gifts, historical account backfill, production data/cache changes,
  commit, push or deployment occurred. The production image rollback artifact's
  push permission remains pending.

Migration checklist remains 240 checked / 164 open / 404. A3k13 and SUP-004 stay open.
