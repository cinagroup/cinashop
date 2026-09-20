# Product detail cache isolation (2026-09-14, unpublished candidate)

## Confirmed defects

The old `StoreProductService.getProductDetail` saved the assembled detail for
600 seconds under `product_info_<id>` or its type suffix. It stripped uid,
collection and assurance fields, but retained `price_type`, `level_name` and
calculated prices. On a hit it did not re-read product visibility, SKU stock or
prices, or recompute the visitor's level quote. No production product writer in
`src` called `invalidateProductCache`; that helper removed only the ordinary key.

An isolated real PostgreSQL 16 run with a stateful Redis substitute produced
24 old-code failures. Concrete examples included a Gold visitor receiving Silver
level metadata, updated images/stock remaining old, hidden/deleted/missing products
still returning a cached detail, and retired SKUs staying in the payload.
The existing cold path also selected `price_type=level` but returned original
SVIP price 90.00 instead of the selected 80.00; non-SVIP level price became zero.

The local PHP reference is
`cinashop-php/app/services/product/product/StoreProductServices.php`:
`getCacheProductInfo` caches base product data; `productDetail` subsequently calls
`getMinPrice` for the current uid and merges that quote into `storeInfo`.
The old Worker shared the enriched output instead of preserving that boundary.

## Change and trade-off

- Removed cross-request Redis reads/writes for assembled detail. Each request now
  performs the existing product/SKU DAO reads and current-user enrichment. It does
  not consume old cached blobs or write a new blob after a delayed reader finishes.
- Preserved ordinary/type 0–7 SKU selection, retirement filtering, visibility
  rules, raw SKU prices and controller/adapter contracts. No purchase eligibility
  expansion, order write, price-table update or DDL was performed.
- Selected level/SVIP quote now populates `vipPrice` consistently with
  `price_type`; `level_price` is also returned. The underlying getMinPrice
  arithmetic, SVIP feature settings and eligibility policy are not redesigned.
- Positive safe-integer product IDs are required before data/cache access.
- Retained the explicit legacy-cleanup method for compatibility; it targets
  only the ordinary key plus seven type keys, not a wildcard or global flush.
  Current reads no longer depend on it. No production cleanup was executed.

This deliberately trades a Redis hit for additional product/SKU SQL reads.
Caching assembled volatile/user-specific output is not an acceptable correctness
boundary. Capacity/latency must be measured before release; a future optimization
needs a versioned, user-independent snapshot with a complete invalidation design.
This does **not** make the multiple DAO queries one atomic database snapshot and
does not bypass any independent Hyperdrive or Workers HTTP query/response cache.

## Verification

- 27 new tests with real PostgreSQL 16 on the dedicated loopback service, real
  DAOs and service code, synthetic fixture rows and stateful Redis/KV substitutes.
  Initial 24 cases were red on old code; final 27 passed.
- Covers three visitor orderings, user-level/collection changes, level-only
  pricing, all eight SKU types after product/SKU updates, three visibility/removal
  states, retired SKU ranges, poisoned legacy blobs, authoritative read failure,
  exact-key cleanup, four invalid IDs, delayed-reader stale-refill prevention,
  current assurance definitions/associations and unchanged seven-table snapshots
  during reads. The delayed-reader test controls a DAO return with a barrier; it
  is not presented as a database transaction/isolation test.
- Eight-file regression: 88 passed, zero failed/skipped, including prior HTTP
  cache policy, price arithmetic, PC adapter, UniApp SKU SQL, product assurance
  and public catalogue tests. Existing cache-implementation assertions were
  updated to assert that old cached detail is ignored, with SQL assurance coverage
  added instead of merely removing the assertion.
- Fixture creates an owned random database/schema, enforces loopback database,
  account and PG16 identity, and confirms its database removal in cleanup. The
  schema is ORM-column-derived, not a full production migration/ACL test.
- Initial type check rejected test-only Promise.withResolvers under the project's
  target library; replaced it with ordinary Promise barriers without changing the
  target. Final `npm run typecheck` completed successfully for both unit and
  runtime configurations.

No production database/cache was accessed in this increment. No commit, push,
deployment, system installation or browser acceptance was performed. The separate
HTTP workerd test remains unexecuted because the Windows runtime failed at startup
in the preceding increment; Node/PG success does not clear that runtime gate.

## Remaining release and migration work

1. The independent six-hour CONFIG_KV definition cache was subsequently removed
   in the local [level-authority increment](user-level-cache-authority.md), with
   real-PG admin-edit regression evidence. Neither increment is deployed;
   production freshness and complete price-policy parity remain open.
2. PC/UniApp pages prioritize raw selected-SKU SVIP prices and use SVIP labels;
   full per-SKU level-price presentation/feature-policy parity needs frontend
   integration and browser acceptance. This increment proves backend output,
   not complete member-price UI parity or checkout policy.
3. Production query caching, post-deploy ordinary URLs, capacity, real roles and
   current candidate Linux/workerd gates remain open. This branch also contains
   unrelated shipping changes and cannot be deployed as a standalone cache fix.
4. Existing image rollback mapping remains local pending its separate push
   authorization. No production images, prices or stocks were changed here.

Migration totals remain 240 checked / 164 open / 404; A3k13 and SUP-004 remain open.
