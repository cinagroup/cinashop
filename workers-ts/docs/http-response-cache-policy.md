# HTTP response caching default (2026-09-14, local candidate)

## Evidence and scope

Production product image replacement exposed an independent Workers Cache HIT
returning the old detail response after the database commit. The image operation
and partial browser acceptance remain recorded in `view/pc-ts/docs/test-media.md`.
This change does not update product data, flush caches, change Cloudflare settings
or deploy any application.

The assembled app previously provided no default Cache-Control. Ordinary product
list/detail responses (including optional-auth personalization), health, unknown
routes and many HTTP-200 compatibility error envelopes were unmarked. A branding
handler set public caching before awaiting a service; a thrown service error kept
that public header even after the global handler returned a failure envelope.
All 18 newly added assembled-app regression tests failed against that old app.

[Cloudflare's Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
documents the default 7200-second TTL for eligible HTTP 200 responses lacking an
explicit policy. The platform cache is distinct from Redis/Hyperdrive and from
[zone-level cache purging](https://developers.cloudflare.com/workers/cache/purge/).
Types were checked against today's official registry version `5.20260914.1`;
no dependency versions or runtime compatibility flags were changed.

## Behavior

`responseCacheMiddleware` is the outermost app middleware, before observability,
security headers, CORS and DI. After dispatch:

- Missing/empty Cache-Control becomes `private, no-store, max-age=0`.
- A thrown exception (including HTTP-200 error envelopes) or HTTP status >=400
  cannot retain a cacheable policy. An existing explicit no-store is preserved.
- Successful explicit resource policies remain unchanged, including public
  branding TTLs and private media policies.
- Status 101 upgrades are left untouched. Bodies are not parsed, read, cloned or
  buffered; Hono updates response headers while preserving the body stream.
- Existing status codes, envelope bytes, CORS headers, redirects, cookies and
  other response headers are not redesigned.

This is a default, not a proof that every explicit public-cache declaration is
appropriate. It does not inspect business-status fields inside streaming JSON;
a handler that deliberately sets public caching and returns a non-thrown failure
must still set its own no-store. This needs endpoint review rather than buffering
all responses in a global middleware.

## Verification

- New assembled-app suite: 18 old-code failures, then 18 passing. Uses actual
  createApp, middleware ordering, registered routes, controllers and JWT auth
  (standard and legacy header), with synthetic DI/service results; no DB/Redis
  network access. Covers products limits 8/100, both detail routes, anonymous and
  authenticated users, validation, missing product, unknown exception, mandatory
  login rejection, early DI failure, five route namespaces, health, public-cache
  success/error transition and CORS preflight.
- Shared transport contract: 14 passing in Node, including open-stream completion
  only after response headers return, exact body bytes, explicit policies, failure
  policies, cookies, Vary, ETag, HEAD and redirects.
- Five-file regression: 61 passed, zero failed/skipped (the 32 new tests plus
  observability, PC detail adapter and public catalogue regression tests).
- `npm run typecheck`: unit and runtime type checks both passed. An initial
  incomplete branding fixture was rejected by TypeScript and then completed;
  assertions/types were not weakened.
- workerd suite includes the same 14 transport cases and one real WebSocketPair
  upgrade case. Both sandboxed and approved unsandboxed attempts failed **before
  executing tests** with Windows access violation `0xc0000005`; each reported
  one startup error and no tests. The first attempt also lacked log-file access;
  the unsandboxed failure disproves a log-permission-only explanation. Runtime
  acceptance is pending, not passed or skipped. No package/system repair attempted.

Commands: `npm run test:unit -- test/http-cache-policy.test.ts
test/response-cache.test.ts test/observability.test.ts
test/pc-product-detail-contract.test.ts test/api-public-catalog-migration.test.ts`,
`npm run typecheck`, and `npm run test:runtime -- test/runtime/response-cache.test.ts`.

## Remaining gates

1. Execute the new runtime suite on a functioning workerd host/Linux CI and
   review the current candidate's full CI, not an earlier commit's success.
2. The separate detail Redis audit now has a local repair and real-PG regression
   evidence in [product-detail-cache-isolation.md](product-detail-cache-isolation.md).
   It removes assembled detail caching. The subsequent local
   [level-authority repair](user-level-cache-authority.md) also removes the level
   KV read/refill path; frontend price presentation, production query caching
   and deployment gates remain open.
   This HTTP-header change alone does not establish those properties.
3. Review explicit public cache opt-ins for identity and failure-envelope handling.
4. Before any release, account for all unrelated shipping changes already on this
   candidate branch and their DB/frontend prerequisites. Do not deploy this branch
   merely as a cache purge. Deployment approval and ordinary-URL production
   verification remain separate; headers in unpublished code cannot affect an
   already-cached production response.

No commit/push/deployment was performed for this increment. The previous image
rollback mapping remains local awaiting its separate push authorization. Migration
checklist totals remain 240 checked / 164 open / 404, with A3k13 and SUP-004 open.
