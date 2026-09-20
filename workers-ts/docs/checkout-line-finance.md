# Checkout line financial evidence

2026-09-15. Local candidate only, **not deployed**. This supplies the new-order
evidence needed by the still-open [physical refund split](refund-physical-split.md).
It does not create refund children, reconcile older snapshots, or certify
already-split orders.

Latest consumer: [line-based fulfillment and supplier splitting](order-split-finance.md)
now validates and aggregates v1 child totals, preserves raw freight and integer
point residues, and partitions write-off counters in those two local paths.
Physical refund materialization and ledger/operation associations remain open.

## Persisted contract

The actual order-creation transaction now writes
`financial_version: checkout-line-finance-v1`, the original cart identity and
quantity, and the following evidence into each `store_order_cart_info.cart_info`:

| Source | Stored fields |
| --- | --- |
| Actual checkout unit price and guarded base/activity cost | `sum_price`, `costPrice` |
| Admitted ordinary membership benefit (2026-09-19 addition) | per-unit `vip_truePrice`, and `price_type` (`level`, `member`, or empty) |
| Final admitted coupon, first-order and points discounts | `coupon_price`, `first_order_price`, `integral_price`, `sum_true_price` |
| Actual fixed/template/free shipping calculation | `raw_postage_price`, `postage_price` |
| Final admitted ordinary points deduction | `use_integral` |
| Actual specified-SKU/percentage/profit commission calculation | `one_brokerage`, `two_brokerage`, and the three `division_*brokerage` fields |
| Integral-product activity SKU and second-card base SKU | per-unit `integral` and `sku.write_times` |

`promotions_true_price` is explicitly `0.00`, matching this creator's current
zero promotion total; this is **not** implementation of promotion discounts.
Activity points required for redemption (`payIntegral`) remain distinct from
ordinary discount points (`useIntegral`). Saving redemption evidence does not
deduct those points early or trigger payment. Existing activity provenance,
gift-integral source and per-unit settlement price remain intact.

The eleven fields required by `partitionRefundCartSnapshot` are present even
when zero. Their values are captured while creating the order, not invented
later from mutable product settings or an order-total weight allocation.
HTTP client-supplied financial fields are not used as sources.

## Allocation and deliberate rounding corrections

- Shipping retains each fixed charge, free item and winning template's
  contribution. Within a template it uses quantity, weight or volume as
  configured. Equal-price candidates retain the first candidate in the existing
  iteration order. An admitted first fee at zero weight/volume is distributed
  by quantity. Whole-order/package waivers still check delivery eligibility.
- Template allocation truncates its ratio to six places and rounds cents;
  ordinary points use a four-place ratio and truncate integer points. The last
  positive-weight row receives residue; zero-weight rows do not acquire it.
- An already admitted discounted-postage total is distributed across those raw
  line charges with exact integer ratios. This preserves the charged total:
  two one-cent raw fees at a 50% member discount produce one paid cent, not zero
  after separately truncating each line.
- Coupon, first-order and points-money allocations retain the existing PHP
  shares wherever they fit. Only a rounding overflow is moved to a line with
  remaining merchandise capacity. For prices `2.00 + 0.01`, first-order discount
  `1.00` and points discount `1.01`, the old independent allocations would
  over-discount the cheap line. The new line discounts remain nonnegative and
  sum to the admitted totals, with both merchandise net amounts exactly zero.
- Rounded template shares are capped at the unallocated total. Four equal
  items sharing two cents must not become four cents after independent rounding.

These are explicit cent-conservation corrections, not claims of byte-for-byte
PHP rounding parity. This increment reads the actual legacy computation source;
it does not re-run the previous refund calculator's PHP oracle as checkout
acceptance. Existing price-only shipping callers retain their total API.

## Transaction and authority boundary

No new query, binding, migration, external call or lock order was introduced.
The new bounded BigInt arithmetic and JSON writes run within the existing
awaited order transaction, after final user/discount admission. Commission line
values are observed directly from the same calculation that produces order
totals, including disabled recipients and specified-SKU division exclusions.

Second-card per-unit entitlements are part of the confirmation fingerprint.
A change after confirmation requires a fresh quote. The stock UPDATE also
checks the originally read `write_times`, including after PostgreSQL waits for
another writer. This protects the stored unit count; it is not a claim that all
other second-card validity rules have been audited in this increment.

Committed-order replay returns the stored order without re-pricing or rewriting
its snapshots. A later transaction failure rolls back snapshots, stock, first
order eligibility, points and bills together. Sequence gaps after an aborted
transaction remain normal and are not reset.

Workers and PostgreSQL skills guided deterministic bounded computation, retained
transaction boundaries and unchanged lock ordering. The current Workers guide,
installed types (5.20260828.1), Hyperdrive interface and local Wrangler schema
were consulted; latest npm types retrieval was denied. Dependencies and
deployment configuration did not change.

## Still required before coordinated rollout

- Fulfillment and multi-supplier child aggregation, changed-price allocation and
  entitlement partitioning now have a local implementation; coordinate rollout
  and original ledger ownership before treating this as settlement acceptance.
- Integrate refund/root/child locks, reservations, original payment/operation
  associations, inventory, rewards, brokerage and supplier-finance recovery.
- The shipping and multi-supplier writers now use the checked line planner; the
  shared partition also handles raw postage and integer gift-point residue.
  Audit remaining refund and legacy writers and coordinate their upgrade.
  Presence of `financial_version` alone must never authorize settlement.
- Preserve or explicitly reconcile old/missing snapshots; no backfill occurs.
- Verify promotion/invoice/gift ownership, later fulfillment, real deployed
  roles/Hyperdrive/provider behavior and coordinated publication separately.

The broad migration checkboxes remain open. No production data, image/cache,
staging, commit, push, branch cleanup or deployment is part of this increment.

## Verification

New coverage comprises **21 pure calculation cases** and **13 actual SQL cases**.
The SQL suite checks every stored line aggregate against the order, ordinary
and zero-cash redemption orders, specified/percentage commission separation,
mixed freight, cent-capacity correction, actual confirm/create HTTP handling,
read-only quoting, immutable replay, a late real SQL trigger failure, valid
second-card pickup, stale receipt rejection, and source edits before and during
a PostgreSQL SKU lock wait. The independent wait is proved with
`pg_blocking_pids`, not elapsed time. External fetch is forbidden in the fixture.

The expanded **12-file / 644-test** batch passed on PostgreSQL **16.15** as the
non-superuser `finance_test`. It includes activity/coupon/package confirmation
rules, brokerage boundary/participant/paid-authority tests, checkout quotes,
member price truncation, shipping and refund allocation. Another **4-file /
68-test** run includes the latest second-card fingerprint addition and all
13 new SQL cases, plus allocation, confirmation and second-card validity.
Both runs have zero skips/failures; they overlap and are **not** added together
as distinct tests or presented as a single repository-wide run.

Initial SQL runs were 9/11 and then 138/141: the second-card fixture initially
selected express shipping, then lacked `system_store.is_store=1`. Those checks
correctly rejected the fixture before the intended stock boundary. The fixture
was repaired to use an enabled pickup store and a positive admission case was
added; the application delivery guards and independent-lock assertions were
not relaxed. Three nullable snapshot-text TypeScript errors were corrected with
explicit runtime string validation. Final source and runtime-test TypeScript
checks pass after the last source change.

All four fresh clusters reported zero remaining fixture databases/roles and
were independently checked with `pg_ctl status` (exit 3). Their PID and temporary
bootstrap-password files are absent, with zero listeners on ports 50932, 52775,
59984 and 53508 and zero processes from the trusted PG runtime. Stopped logs/data
remain in ignored `.cache/finance-postgres-{Iea1mX,amBOSN,crelpf,ePUDKn}` for
diagnostics; no directory was recursively deleted. The original nine staged
files remain staged and unchanged by this increment. Checklist: **240 checked /
164 open / 404 total**.

These are local Node/Vitest HTTP and native SQL tests using synthetic data and
an in-memory KV adapter, not browser, workerd, production schema/role, provider
or Hyperdrive acceptance. Reproduce the latest focused batch from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/checkout-line-finance.test.ts test/checkout-line-allocation.test.ts test/checkout-confirmation.test.ts test/second-card-validity.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit
node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.runtime-test.json --noEmit
```

## Membership evidence increment — 2026-09-19 (local, not deployed)

Four native-PG red cases exposed two gaps: newly created cart snapshots omitted
the already-calculated membership benefit, and activity price reductions were
included in membership quote totals even when no membership price was used.
The local PHP `StoreCartServices` contract distinguishes those sources.

Checkout now carries the admitted membership calculator's integer-cent unit
benefit through the existing pricing/stock/rights guards into the same order
transaction. It writes `vip_truePrice` as a two-place **per-unit** decimal and
`price_type` as `level`, `member`, or empty. Disabled/ineligible memberships and
activity pricing record `0.00` and empty, not the retail/activity-price gap.
The quote's item and aggregate membership savings use that same source.
No query, schema, binding, dependency or lock-order change was needed.

`sum_price` and `sku.price` already contain the membership-discounted unit sale
price. **Do not subtract `vip_truePrice` again** from paid or refundable money.
Existing quantity partitioning copies the per-unit benefit unchanged; each
child export/picking total multiplies it by that child's own quantity. Actual
successive refund, shipment and supplier-allocation paths verify conservation,
including points deductions, late transaction rollback and committed replay.

Verification after the source change:

- Initial seven-file pricing/membership regression: **147 passed**.
- Expanded checkout evidence, line finance and split finance: **74 passed**,
  including **14 membership evidence cases** (HTTP untrusted fields, minimum
  cent/truncation, eligibility, replay, late SQL rollback and activity pricing).
- Complete registered schema, separately authenticated non-owner business
  connection: **3 lifecycle cases passed**. Payment state is synthetic, not a
  payment provider test. Supplier export and picking reads do not mutate rows.
- Activity/confirmation compatibility: **292 passed** on native PG16.15,
  including coupon, package, bargain, seckill, combination, integral and newcomer
  rules. A final lifecycle rerun retains **3 passed**, now also asserting the
  source payment explicitly: `48.00` merchandise + `3.00` discounted freight
  minus `1.00` ordinary points = `50.00`, with no second membership deduction.
- Allocation/runner contracts: **142 passed**. Worker main and runtime-test
  TypeScript checks pass. These batches overlap; do not sum them as distinct
  tests or label them a full-repository run.

The initial fixture incorrectly retained a platform shipping template after
moving its product to a supplier; correcting the fixture ownership exposed all
four intended red cases without weakening shipping checks. Two later sandbox
PG startup failures ran no assertions; the approved isolated reruns passed.
An extra compatibility command was rejected before cluster creation because
of a nonexistent test filename, then corrected to existing explicit paths.

Workers/PostgreSQL skills guided reuse of the existing admission/transaction
boundary and isolated-role verification. The current official Workers guide
was read through the available Firecrawl connector (CLI unavailable); latest
Workers types `5.20260919.1`, Hyperdrive interface and local Wrangler schema
were inspected read-only. Nothing was installed or deployed.

All nine attempted clusters have been independently checked: no PID or bootstrap
password files, no listeners on their nine chosen ports, and no processes from
the trusted PG runtime. Completed test runners reported zero remaining fixture
databases/roles. The two sandbox startup failures created no running server.
An initial sandbox process query was denied; its apparent zero was not accepted
as evidence. The approved read-only host check succeeded. Stopped diagnostic
directories remain in ignored `.cache`; none was recursively deleted. The final
main TypeScript rerun passes after the strengthened test assertions, and the
original nine staged files remain untouched.

Remaining boundaries:

- No old snapshot is backfilled or reconstructed from today's SKU/rights.
  Already committed replay remains unchanged, even if old evidence is missing.
- Customer-detail `memberPrice`/the economize ledger and other historical
  reports remain a separate audit; this is not complete membership reporting.
- Activity confirmation fingerprints can change because the membership total
  is corrected. Reconfirm pre-rollout activity quotes; never bypass receipt
  validation. Actual charged item prices are unchanged by this correction.
- Real production roles, Hyperdrive/provider behavior, UI display of every
  activity discount and coordinated deployment remain unverified here.

Reproduce the new evidence from `workers-ts` with the trusted local PG16 binary:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/checkout-member-evidence.test.ts test/split-order-line-finance.test.ts test/checkout-line-finance.test.ts
node scripts/run-local-finance-postgres.mjs --schema-maintenance ../.cache/postgres16-20260915/runtime/pgsql/bin test/checkout-member-lifecycle.test.ts
```

The maintenance flag initializes only a fresh loopback cluster for registered
schema/ACL fixtures; it does not grant authority on an existing server.
Broad checklist items remain open at **240 / 164 / 404**. No production access,
image/cache operation, staging, commit, push or deployment occurred.

Subsequent local increment: the new-checkout paid-member economize writer and
customer child-benefit projection are now covered separately in
[paid membership savings ledger](order-member-economize.md). That document
supersedes only the above open ledger subtask; it does not close historical
reports, offline other-order savings, production role or release acceptance.
