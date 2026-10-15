# Independent review addendum: fixes and POST controller

Date: 2026-10-15. This addendum preserves the original `independent-review.md` unchanged. Read-only source review only; no tests, typechecks, builds, providers or migrations were executed by this reviewer. The parent reports save-expanded validation running; no running result is counted as passed here.

## Result

No additional P0–P2 defect was confirmed in the reviewed fixes or POST controller. Both findings from the original report are resolved in the current source, subject to final validation.

## Fixes inspected

- The legacy create branch now obtains its actual inserted product ID, takes product/card TRY fences, and issues a single `SELECT EXISTS` over all 14 captured child table groups before any association, SKU, description, card or coupon replacement. Any result other than explicit `occupied=false` rejects the transaction. The coordinator uses a typed empty create baseline rather than reading product_id=0. The existing true table barriers remain held, so ordinary direct writers cannot insert an absent child between this check and replacement. This closes the reported orphan adoption/deletion path.
- The SQL regression source now covers orphan description, dimension and relation rows at the actual allocated ID, expects rejection, and compares the complete fixture snapshot (including parent, audit and outbox). A separate case proves unrelated product_id=0 description data is retained. These tests were inspected, not run by this reviewer.
- Historical SKU uniqueness proof now compares an existing identity byte-for-byte. Only newly allocated identities are required to match the actual allocator hex-8 syntax. The actual `old-sku1` SQL test was inspected.
- Inventory-card preflight checks active ordinary inventory-backed SKU stock against uid=0 card count and refuses disagreement before business writes; the drift refusal snapshot test was inspected.

## POST controller inspected

- The exact POST `/product/product/:id` route is registered with the existing Admin runtime authentication boundary. The service still independently validates live `product.manage` authority and password/session claims inside the transaction. Existing seed105 binds to manage; read seed620 and product.view do not become writers.
- Canonical decimal path IDs allow zero for create and reject negatives, leading-zero forms and out-of-range values. Query parameters are refused. The strict existing bounded UTF-8/duplicate-aware JSON body reader is used. Body `id` cannot override the URL target.
- Success returns the PHP source message and `data: []`, without manufacturing a new ID response contract. Classified transaction 409/503 refusals become HTTP200/body400 so the genuine old Axios consumer rejects them. Other failures are rethrown and retain the existing unknown-outcome behavior. Dispatch remains after the service transaction and best effort; durable outbox intent is already committed before provider work.
- The inspected HTTP regression bundles the real old productAddApi and request interceptor, uses real Axios, App/JWT and fixture SQL, and checks create/edit envelopes, exact seed105 authority, read-only/unauthenticated/revoked refusal, malformed/duplicate/oversized body, path/query refusal, and scraped-import refusal. This establishes intended coverage in source, not a passed runtime result.

## Scope remains open

GET editor DTO, full editor/copy UI and trusted local-copy HTTP flow remain unconnected. This addendum does not certify complete editor migration or the full migration goal. Real providers and encrypted PHP AutoConfig remain the same external verification limits as the original report.

## Reviewed source SHA-256

- `workers-ts/src/services/product/ProductAssociationService.ts`: `4e313af527821e22b6a237e2d41970640320a05e5ba5506bae03296ea73e99e2`
- `workers-ts/src/services/admin/AdminLegacyProductSaveService.ts`: `56f358877f36d8f3425c89adf54a984c1e4dba1bb362d837291eb227361ee279`
- `workers-ts/src/services/admin/AdminLegacyProductSaveState.ts`: `90ce9f463fe4372c3c90357e511c7dfdc91f54bdf00ed068e2b96f844aba7fcf`
- `workers-ts/src/services/admin/AdminLegacyProductSaveProof.ts`: `1b126c47e0a7ea820cced2029533fdbbea6ff3321c1f54f1df1b7a20ddf861e7`
- `workers-ts/src/controllers/api/v1/AdminLegacyProductSaveController.ts`: `7f4cc2b11c8f942f0a2ad406d47278e04b29b365f040a7c4993850c1d59a9fb6`
- `workers-ts/src/routes/adminapi.ts`: `f9be89ad94dd632a948c5ba035840ba74aa6624c76301f92250ef90469ef2deb`
- `workers-ts/test/admin-legacy-product-save.test.ts`: `ef4065d949cf82c929bf5d081054a455bbae436c0f8721bde46fd2c5e0bbaac2`
- `workers-ts/test/admin-legacy-product-save-http.test.ts`: `54f4a31234a051b9da0caf0aa74f86d490ec8ac8c8a5fc8818c6487255278b21`
