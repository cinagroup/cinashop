# User-level definition cache authority (2026-09-14, unpublished candidate)

## Confirmed defect

`UserLevelService.getLevel` cached a level's name, discount and grade for six
hours in CONFIG_KV under `level_<id>`. The actual admin save and soft-delete
controllers did not invalidate it. A warmed definition therefore survived a
discount/name edit, disable or deletion and continued to influence catalogue,
recommendation and product-detail quotes and user-level information. Reading a
user's current level ID did not refresh that separate definition cache.

The initial 17-case real PostgreSQL 16 test suite produced 15 failures and two
passes on the old implementation. Both admin-compatible paths were exercised
through the real save/delete handlers with synthetic rows, not production data.

[Cloudflare documents KV's eventual consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
Adding a delete call after an admin edit alone would not establish immediate
cross-location freshness; an older in-flight read can also refill a retired
value. This increment removes that application's dependency on the KV copy.

## Local change

- `getLevel` now reads the existing level DAO on each call. Missing, hidden or
  deleted definitions return null; database errors propagate rather than falling
  back to a previously cached price definition.
- Legacy KV payloads, including malformed or wrong-ID values, are neither read
  nor refilled. KV availability no longer determines whether a level can be read.
- Non-positive, fractional and unsafe/non-finite IDs return null before I/O.
- `invalidate` remains an explicit compatibility cleanup, limited to exactly one
  valid `level_<id>` key. Current reads do not depend on calling it. No production
  cache deletion was performed.
- The constructor and binding configuration are unchanged. Discount arithmetic,
  admin validation/writes, membership activation/rewards, checkout eligibility,
  stock and order state are unchanged.

The trade-off is an extra level SQL read where a KV hit previously sufficed.
The existing catalogue/recommendation paths resolve the visitor's discount once
per list and reuse it for all rows; this change does not add one read per row.
This is not a capacity optimization or an atomic multi-query snapshot. It removes
the service's KV cache; it does not bypass Hyperdrive query caching or Workers
HTTP caching. Production configuration and freshness require separate acceptance.

## Verification scope

- 18 final cases use real dedicated loopback PG16, real ORM/DAOs, level/product
  services and admin save/delete handlers, plus a stateful KV substitute.
- Covers edit/name/discount, disable/restore and soft-delete through both admin
  path shapes; physical removal; three old/malformed cache payloads; database and
  KV outages; four invalid IDs; delayed-reader refill prevention; and exact-key
  legacy cleanup preserving unrelated keys.
- Quotes are checked in product detail, catalogue and recommendations; level
  information and the grade list are also checked after edits.
- The delayed-read test controls a DAO return with a Promise barrier. It is not
  an independent-connection PostgreSQL isolation or concurrency acceptance test.
- The Hono fixture injects a real container and mounts the real controllers, but
  deliberately omits production authentication and the complete registered
  router. It is not an admin authorization/ACL test.
- Seven tables use the existing ORM-column-derived fixture, not a complete
  production migration. The helper checks dedicated database/account/PG16
  identity, owns a random test database/schema and verifies cleanup on close.
- The first type check rejected exposing Vitest Mock objects directly as a
  platform binding. Plain callable adapters now wrap those spies. This remains
  an explicitly test-only subset of Env, not a real binding implementation;
  no double-cast, ts-ignore, target change or production type change was added.

Final six-file regression: **116 passed**, zero failed/skipped, including the
18 new cases, product-detail cache isolation, level migration, checkout
membership boundaries, price arithmetic and the PC detail contract. The final
`npm run typecheck` exited zero for both unit and runtime configurations.

Commands (with the dedicated local `TEST_FINANCE_POSTGRES_URL` injected without
printing credentials):

```text
npm run test:unit -- test/user-level-cache-authority.test.ts test/product-detail-cache-isolation.test.ts test/user-level-migration.test.ts test/checkout-membership-boundary.test.ts test/price.test.ts test/pc-product-detail-contract.test.ts
npm run typecheck
```

## Remaining migration/release gates

1. The later [display arithmetic audit](member-price-truncation.md) confirmed
   PHP's contradictory zero behavior with the actual PHP methods and locally
   repaired its separate truncation migration error. The existing
   `Number(discount) || 100` behavior remains in level and checkout-related code;
   the new shop's zero semantics still require a coherent display/cart/order
   decision, not a change in only this read method.
2. PC/UniApp selected-SKU level-price presentation, labels, membership feature
   switches and paid-membership eligibility remain separate open work.
3. Measure added SQL volume/latency, review single-snapshot requirements and
   verify actual Hyperdrive/HTTP cache behavior with the release candidate.
4. The earlier Windows workerd startup access violation remains a runtime gate;
   local Node/PG results do not replace current-candidate Linux/workerd CI,
   production roles or ordinary-URL browser acceptance.
5. This branch also contains shipping work with deployment prerequisites. No
   isolated cache-fix deployment is implied. The image rollback mapping remains
   local pending its separate push authorization.

No commit, push, deployment, production database/cache operation or browser
acceptance was performed in this increment. Migration totals remain
240 checked / 164 open / 404; A3k13 and SUP-004 remain open.
