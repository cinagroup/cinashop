# Member display-price truncation audit (2026-09-14, unpublished candidate)

## Source and reproduced defect

The legacy `StoreProductServices::getMinPrice` uses
`bcmul(bcdiv(discount, '100', 2), price, 2)`: truncate the ratio to two decimal
places, then truncate the resulting price to two places. The Worker instead used
`toFixed(2)` for both operations, rounding each stage. This affected amounts and
which discount won, not merely the displayed decimal formatting.

| Base / discount / SVIP price | Old Worker display | PHP expected display |
| --- | --- | --- |
| 100.01 / 88 / none | 88.01 | 88.00 |
| 99.99 / 88.99 / none | 88.99 | 87.99 |
| 10000.01 / 88.50 / none | 8900.01 | 8800.00 |
| 99.99 / 88.99 / 88.50 | member, 88.50 | level, 87.99 |

Evidence was obtained by executing the **actual local PHP methods**, not just a
reimplementation of BCMath. `audit/verify-php-member-price.php` loads the source
class and its real OptionTrait with an inert BaseServices stand-in, bypasses the
constructor and invokes getMinPrice/setLevelPrice with explicit synthetic inputs.
It does not boot the framework, load app configuration, connect to a database or
use production credentials. This is a pure arithmetic oracle, not PHP application
or database acceptance.

- Runtime: existing PHP 8.4.25 CLI, `-n`, built-in BCMath available. No installation
  or runtime/configuration change was made.
- Source: `cinashop-php/app/services/product/product/StoreProductServices.php`.
- Source SHA-256: `edf89202f65c2f6b161dbbccdb7cc68ef6270ae31c11afe91ab26aa285722943`.
- All 14 fixed cases in `test/fixtures/member-price-bcmath.json` matched both PHP
  display and payment results. CI can run the TypeScript vectors without the
  external PHP checkout; that does not imply CI executes this PHP oracle.
- The old TypeScript pure-function suite failed nine of those 14 new cases.
  Six actual PostgreSQL pipeline cases then failed five cases (13 display
  assertions), while their cart quote, confirmation and order creation checks
  still ran and passed. Soft assertions in that suite enabled this distinction.

## Local repair

Only the display arithmetic in `StoreProductService.getMinPrice` changed:

- Parse non-negative two-decimal money into integer cents, with bounded input
  length and safe-cent range checks. Malformed/unsafe values fail explicitly.
- Truncate the percent before multiplication, then use BigInt integer division
  for the cent result. No floating-point multiplication or rounding is used.
- Preserve the existing output field names, raw base/SKU prices, no-discount
  sentinel, SVIP tie behavior and level/SVIP selection branches.
- No changes to configuration, eligibility, activation, cart/order arithmetic,
  stock mutation, payment initiation or order replay logic.

The six real-PG scenarios use an active level and paid membership, enabled pricing
rights, one ordinary SKU, quantity two and free shipping. They check product
detail, catalogue, recommendations, legacy V2 cart projection, real confirmation
and create controllers, the persisted unpaid order total, stock decrement and
unchanged raw product/SKU prices. They are synthetic local orders, not production
orders or a payment-provider test. Identity, KV receipts and sequence allocation
are explicit substitutes; full registered auth/ACL and browser/UI are not covered.
The existing fixture uses ORM-derived columns in owned random PG16 databases,
verifies the dedicated loopback role/database identity and confirms cleanup.

## Verification

Seven-file regression: 142 passed, zero failed/skipped, including the six new
real-PG pipeline cases, 14 new PHP display vectors, existing price tests, product
and level cache repairs, PC detail contract, checkout membership boundaries and
order/after-sale contracts. Eight additional invalid-money cases brought the
standalone price suite to 29 passing cases; this is not a second disjoint set of
29 tests. Final exact-string price assertions plus all six real-PG pipeline cases
were rerun together: **35 passed**, zero failed/skipped. `npm run typecheck`
completed with exit zero for both unit and runtime configurations. Test targets,
timeouts, source arithmetic and production types were not weakened to pass.

```text
php -n audit/verify-php-member-price.php
npm run test:unit -- test/price.test.ts test/product-price-truncation.test.ts test/product-detail-cache-isolation.test.ts test/user-level-cache-authority.test.ts test/checkout-membership-boundary.test.ts test/pc-product-detail-contract.test.ts test/api-order-after-sale-migration.test.ts
npm run typecheck
```

The unit run used the dedicated local TEST_FINANCE_POSTGRES_URL without printing
its credentials. Windows workerd's earlier startup access violation remains an
open runtime gate; Node, PG and PHP success do not replace runtime acceptance.

## Unresolved policy and migration work

1. **Zero discount is contradictory in PHP.** The admin form permits zero;
   getMinPrice displays zero, but isPayLevelPrice treats ratio `0.00` as no level
   discount. This was confirmed by the actual 100.00/0 oracle case: display 0.00,
   payment 100.00. Current Worker level reads normalize zero to 100. The user was
   asked which rule the new shop should adopt; no response has been applied.
2. **Sub-cent discounted prices:** PHP display can be 0.00 while setLevelPrice
   floors a positive base's payable price to 0.01. The 0.01/50 oracle case proves
   this. This repair preserves the distinct source arithmetic; it is not a claim
   that every displayed zero is a free order. Final payable-price UI needs to
   express the checkout floor consistently with the chosen zero policy.
3. **Eligibility and configuration:** PHP getDiscount checks level activation;
   product display and checkout have different member-function/paid-membership
   checks. Full feature-switch, activation and paid-status parity remains open.
4. **All clients/SKUs:** modern cart raw-price projection, PC/UniApp selected-SKU
   level-price presentation/labels and actual browser acceptance are not completed
   by these backend tests. The legacy V2 cart projection is specifically covered,
   not every cart frontend.
5. Current-candidate Linux/workerd CI, production roles, Hyperdrive/HTTP cache
   freshness, capacity and deployment remain separate gates. This branch also
   contains shipping prerequisites. The production image rollback record still
   awaits its separate push authorization.

No commit, push, deployment or production data/cache operation was performed.
Migration totals remain 240 checked / 164 open / 404; A3k13 and SUP-004 stay open.
