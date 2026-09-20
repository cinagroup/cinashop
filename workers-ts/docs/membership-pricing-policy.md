# Membership pricing policy audit (2026-09-14, unpublished candidate)

## Reproduced mismatch

Product detail, catalogue, recommendations and legacy attribute responses did not
check the membership feature switches. The legacy V2 cart used CONFIG_KV-backed
configuration, whereas confirmation and creation already read PostgreSQL. A
committed SQL disable could therefore leave an advertised or cart discount active;
an enable could leave the cart discount missing when KV retained the opposite value.

The initial 15-case real-PG suite failed all 15 cases before the repair and passed
all 15 after it. It covers SQL disable/re-enable with stale opposite KV values,
paid-price right removal/disable/zero/duplicate precedence, anonymous display,
global configuration precedence, malformed flags and absent/empty defaults.

Source references are the local PHP checkout's
`app/services/product/product/StoreProductServices.php`: catalogue processing near
1350, detail quote merging near 1965, and `getMinPrice` near 2133. PHP checks the
member-function switch and the paid-price feature. Its catalogue/detail compare
the prices before zeroing a disabled SVIP winner. This candidate deliberately
filters out the disabled SVIP option **before** comparison, allowing a valid level
discount to win. It does not reproduce that source display inconsistency or change
the existing checkout arithmetic. PHP framework/configuration was not executed in
these tests; the earlier arithmetic oracle is documented separately.

## Candidate repair

- `CheckoutPricingSources` shares one bounded scalar SQL projection. Checkout
  still reads the same 11 keys and two rights. The new membership reader selects
  only `member_func_status`, `member_card_status`, `svip_price_status` and the
  `vip_price` right in one statement/snapshot.
- Preserve global `is_store=0`, descending sort/id configuration precedence,
  normalized JSON-string scalar values, and the lowest-id right even when disabled.
  Config `status` controls field visibility and is not treated as the switch.
- `MembershipPricingPolicy` matches checkout: missing/empty flags default to one;
  only integer one enables; malformed/unsafe integers fail explicitly. The SVIP
  flag is short-circuited when paid membership is disabled, as in checkout.
- Product lists resolve policy once per list, not per row. Product and legacy
  attribute detail apply it to selected quotes and advertised SKU VIP fields.
  Disabled paid-price fields return the existing zero sentinel. The legacy
  attribute response now copies selected quote value/name/level fields, rather
  than copying only `price_type` and retaining a different raw price.
- Legacy V2 cart `truePrice` uses the same SQL policy. Its paid-account validity
  and level calculations remain in place. The no-environment/no-account fallback
  is unchanged. No global KV reads/refills or invalidation dependency is introduced.
- Product/SKU database prices, quantities, order mutation logic, confirmation's
  revalidation fence, bindings and production configuration are not changed.

Workers KV is eventually consistent; a cached switch is not proof of current SQL
pricing policy. See [Cloudflare KV consistency documentation](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
The Workers best-practices skill guided the no-cross-request-cache review and the
separation of local Node/PG results from Workers runtime acceptance. No credentials,
binding definitions, deployment settings or platform APIs were added or changed.

## Verification and limits

`membership-pricing-policy.test.ts` was expanded from 15 to 26 cases: all three
flags reject malformed values, the membership source returns only its three keys
and one right via one SELECT, unavailable KV does not block reads, business/policy
rows remain unchanged, and a simulated policy-reader failure propagates through
all five display/cart surfaces. The fault-injection case is a reader rejection,
not a real network-partition test.

The fixture uses actual service/DAO code and PostgreSQL 16 with ORM-derived column
tables in owned random local databases. It verifies the dedicated loopback
role/database identity and checks database removal on close. Confirmation and
creation execute real controllers and persist unpaid synthetic orders; identity,
KV receipts and sequence allocation are explicit test substitutes. These are not
full authentication, production role, provider, HTTP edge-cache or browser tests.

Existing detail/level-cache fixtures now include the two policy tables and an
enabled paid-price right; their business assertions are retained. The PC adapter's
isolated-DAO case explicitly stubs only its new policy dependency. Real PG policy
and detail suites do not stub that dependency except for the labelled failure case.

The shared reader's complete-ORM checkout authority suite passed **20 cases**,
including re-confirmation, replay, source insert/delete/rename, losing duplicates,
snapshot and transaction-fence concurrency. The first 12-file regression completed
with 184 passed and one mobile-SKU test hitting its existing 5-second timeout.
The same 12 files, including the expanded 26-case policy suite, then completed
with **196 passed, zero failed/skipped** using two workers (67.85 seconds). The
mobile-SKU test passed without changing its timeout or assertions. This supersedes
the earlier failed run; the old and new counts overlap and must not be added.
Final `npm run typecheck` exited zero for both unit and runtime configurations,
including the expanded tests. `git diff --check` also passed.

```text
npm run test:unit -- --maxWorkers=2 test/membership-pricing-policy.test.ts test/product-detail-cache-isolation.test.ts test/user-level-cache-authority.test.ts test/product-price-truncation.test.ts test/price.test.ts test/pc-product-detail-contract.test.ts test/uniapp-product-sku-postgres.test.ts test/v2-cart-compatibility-migration.test.ts test/checkout-membership-boundary.test.ts test/paid-membership-migration.test.ts test/product-experience-migration.test.ts test/product-sku-retirement.test.ts
npm run test:unit -- test/checkout-pricing-config-authority.test.ts
npm run typecheck
```

## Still open

1. This switch increment did not change level activation. A subsequent local
   repair now gates pricing and checkout admission by `levelStatus`; see
   [activation audit](level-pricing-activation.md) for its evidence and still-open
   registration lifecycle. Paid prices shown to visitors remain advertised offers,
   not proof of their eligibility to pay that price.
2. Zero-level-discount policy is still awaiting the user's choice; neither the
   zero normalization nor checkout's one-cent floor was changed.
3. Legacy V2 cart nested `productInfo.vip_price` / `attrInfo.vip_price` remain raw
   fields; only its selected `truePrice` is policy-gated. Modern cart projection,
   PC/UniApp selected-SKU level-price labels and all-client presentation parity
   require separate work. Backend SKU VIP gating is not browser acceptance.
4. One policy statement is **not** one atomic product/user/level/SKU snapshot.
   An extra policy SQL round trip is incurred per list/detail, including anonymous
   detail. Actual Hyperdrive caching, load/capacity and entire-request consistency
   still require validation. No new display locks were introduced.
5. Current-candidate Linux/workerd/CI and authorized production deployment remain
   open. Earlier Windows workerd startup failures are not converted to passing or
   skipped runtime tests. Existing checkout table-lock contention remains a
   separate deployment gate. The rollback artifact's push approval is pending.

No commit, push, deployment, production data write or cache purge was performed.
Migration totals remain 240 checked / 164 open / 404; A3k13 and SUP-004 stay open.
