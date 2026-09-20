# Explicit synthetic product images

The self-contained 600×600 SVG files in `public/test-media/` are test data, not automatic fallbacks and
not real product photographs. Each image is labelled TEST and NOT A PRODUCT PHOTO.
Do not rewrite real product media or hide failed media requests with these files.

| File | Intended synthetic fixture |
| --- | --- |
| product-a.svg | 测试商品A |
| product-b.svg | 会员专享商品B |

Vite copies these files unchanged into `dist/test-media/`. After an approved PC
Pages deployment, their intended public URLs are under
`https://shop.cinaseek.ai/test-media/`. Use absolute URLs for cross-origin consumers;
do not persist localhost URLs. Native app / mini-program SVG support is not yet
verified. These assets are not a substitute for the production R2 media pipeline.

## User confirmation (2026-09-14)

The user reports that the new images can now be read. This is recorded as user
confirmation, not a new independent all-pages browser acceptance run. The sampled
07:18 UTC browser results below remain historical evidence; they do not imply
that detail 70 is still failing at the time of the user's later observation.
No image replacement, production cache purge or redeployment was repeated in
response to this feedback. Remaining cache-policy work is tracked separately.

## Latest ordinary-page browser recheck: sampled flow PASS (12:19 UTC)

A fresh Codex in-app tab exercised the ordinary production homepage -> first A
card -> `/goods/70` -> homepage -> first B card -> `/goods/71`, with no query
parameters, request interception, cache-setting change or production mutation.
All eight recommendation images and both detail images decoded at 600x600,
`complete=true`, using the correct `shop.cinaseek.ai/test-media/product-a.svg`
or `product-b.svg` URLs. Thus detail 70's earlier failure below is historical,
not the current sampled result. URL/title, meaningful DOM, no framework overlay,
empty error/warn console and the A-detail screenshot were checked at 1280x720.
This is desktop sampled-flow evidence, not all-products/mobile/native acceptance.
Both details still have stock zero and no valid SKU; disabled purchase controls
are unchanged. No cache purge, image rewrite or redeployment was repeated.

## Observed issue and replacement (2026-09-14, historical)

Browser network evidence on `/goods/70`: the detail API returns HTTP 200 with
`image=https://via.placeholder.com/300` and empty slider arrays. The browser's
request for that exact image fails with `net::ERR_CONNECTION_CLOSED`. Homepage
cards use the same source. No URL-rewriting or R2-signature fault was observed in
this sampled flow; console logs alone did not report the network failure.

A read-only `/api/products?page=1&limit=100` returned all 71 public products:
34 named 测试商品A and 34 named 会员专享商品B use the exact failing URL; 3 other
products have empty images. This is a public-catalog observation, not a complete
database inventory (hidden/deleted products or other media tables are not covered).

The user subsequently explicitly authorized publication and replacement of only
the 68 observed products' `image` fields. Database identities and old values were
re-read immediately before writing, with fingerprint-based drift rejection.
Do not execute `/_seed`: it also modifies users,
balances, inventory, categories, settings and activities. Do not change slider
arrays, missing images, prices, stock, SKUs, orders or activity images. Preserve
the old value and ID mapping for conditional rollback, and account for product
detail caches before browser verification. No deployment or mutation occurred
at the earlier asset-preparation stage; the authorized operation below is separate.

The development seed still references the external placeholder. Updating that
source and fixing its repeated-product behavior is a separate unfinished task;
adding these assets does not repair existing data or change seeding behavior.

## Verification

- `npm run test:images`: 9 passed, zero failures/skips; actual ProductImage
  component lifecycle tests remain in place, plus two self-contained-asset tests.
- `npm run build`: authentication tests, image tests, vue-tsc and Vite passed.
- Source and built hashes match:
  A `88cbb4a4c97a7234bc8af9d50753f81e8cf83ab9b81ed5982aba2cbc7bb898d0`;
  B `227561979c6bc80e188182236647282267e246648f20a934a39e17c23c8e4681`.
- Browser plugin at `http://127.0.0.1:5177`: actual PC homepage and detail views,
  synthetic read-only HTTP fixture (no database or outbound I/O), both images
  `complete=true`, `naturalWidth=600`, `naturalHeight=600`. Homepage→product70
  detail, meaningful DOM, no framework overlay and empty error/warn console.
  Screenshots were emitted in the task. Desktop only; not production/native QA.

## Authorized production operation

- PC-only deployment `c224e558-7b50-4070-a706-cd7cc0fce35f`, asset source
  `58ec07b18bade136cead91e3c080c2181ea5f788`. Existing business source and both
  Pages proxy Functions are unchanged from `9fb7d27`; upload reused 86 assets
  and added only the two SVG files. Both public URLs returned HTTP 200,
  `image/svg+xml`, and byte-identical SHA-256 hashes.
- Previous PC deployment `941337f1-d136-42b2-b925-fbbe816de05b` is retained.
  API and Admin/H5/Supplier/Kefu deployments remain at `9fb7d27`.
- At 2026-09-14 06:52 UTC, a fixed-ID, token-hash protected, expiring temporary
  Hyperdrive maintenance Worker updated exactly 68 `store_product.image` fields.
  Names determine A/B mapping (not ID parity). It rejects old-value/fingerprint
  drift, active image update triggers and rules, and uses row locks plus bounded
  statement/lock timeouts. Other-column hashes matched within the transaction;
  an independent post-commit re-read matched the returned after fingerprint.
- Before fingerprint: `2272802566d572cbabc920f343915dbe4c8bf41f9d59fee26007bbb2457ece8a`.
  After fingerprint: `6bcb9cd6528adc8fb264998f2e07a4dee1222eb14c4cb53fb5ea6feda7b8640c`.
  Durable old-value/ID/hash backup: `docs/releases/test-product-images-before-20260914.json`.
  Rollback must be conditional on each recorded ID/name and its new A/B URL;
  never overwrite subsequently edited images. No rollback was executed.
- First attempt stopped on a transient pre-write inspection 404 and was deleted.
  Second attempt committed successfully; its initial deletion check briefly
  observed propagation delay. Both control-plane settings GET and public POST
  subsequently returned 404 for `cinashop-test-images-56c6cfb3fa59`. No helper remains.
- Real isolated PG16 tests: 7 passed, 0 skipped; exact count, replay, field/name/
  image/missing-row drift, update-trigger protection and all-or-nothing constraint
  failure. Unit and runtime TypeScript checks and Wrangler dry-run passed.
- Browser acceptance is tracked separately: matching URLs can temporarily retain
  stale responses after the write. No blanket cache flush, Redis credential copy,
  Hyperdrive reconfiguration or unrelated production deployment was performed.

The maintenance runner now requires the explicit `--apply-approved-68-test-images`
flag and fresh authorization before reuse. Do not rerun it to fix stale caches.

### Browser acceptance: PARTIAL (2026-09-14 07:18 UTC)

After the user reported new images were visible, a fresh Codex in-app browser
tab exercised the ordinary homepage → A detail → homepage → B detail without
query parameters, mocks, interception or cache-setting changes. Desktop 1265×744:

| Surface | Observed result |
| --- | --- |
| `/` | All eight recommendation images decoded at 600×600; four A and four B, correct self-hosted URLs. |
| `/goods/70` | Still displays explicit image failure; no decoded product image remains in the DOM. Not passed. |
| `/goods/71` | B image decoded at 600×600 with the correct self-hosted URL. Passed. |

URLs/title and meaningful content were checked; no framework overlay and no
captured error/warn console entries. Screenshots were emitted in the task.
Both details still report no valid SKU and stock zero, with purchase buttons
disabled; those fields were deliberately not modified. Mobile/native/mini-program
acceptance remains untested. No further production write, deployment or purge was
performed during this recheck. Rollback records remain local and are not pushed.

The earlier cache diagnosis is now narrowed: the production API Worker settings
reported `cache_options.enabled=true`, `cross_version_cache=false`; a direct
ordinary Worker detail-70 response reported `CF-Cache-Status: HIT`, `Age: 2847`,
no Cache-Control and the old placeholder URL. This proves a stale response in
Workers Cache at that observation; it does not establish why another URL/edge
subsequently refreshed. [Cloudflare configuration documentation](https://developers.cloudflare.com/workers/cache/configuration/)
specifies a default 7200-second TTL for a cacheable 200 without Cache-Control.
[Workers Cache purge documentation](https://developers.cloudflare.com/workers/cache/purge/)
states zone-level purges do not affect this independent cache and runtime purge
must be performed by the owning Worker. Therefore the earlier suggestion that a
zone Cache Purge credential/session would resolve this layer is superseded.
No such credential or dashboard login is needed for this completed read-only
check. Explicit API cache policy/invalidation remains a separate open issue;
do not redeploy unrelated candidate Worker changes to clear this symptom.

### Earlier browser acceptance: NOT PASSED (2026-09-14, historical)

Codex in-app browser, desktop 1265×744: homepage → first 测试商品A card →
`/goods/70` → homepage was exercised. Meaningful page content, correct URL/title,
no framework overlay, empty error/warn console; screenshot still shows explicit
image failure. Network captured detail HTTP 200 and placeholder image
`ERR_CONNECTION_CLOSED`. Disabling the test tab's cache and reloading did not
repair it; cache setting was restored. No mobile/native/mini-program acceptance.

`/api/products?page=1&limit=100` and ordinary detail 70 retained the old URL,
while the same list with `&media_verification=20260914` returned A=34/B=34/empty=3,
and detail 70 with that query parameter returned the new A URL. Thus the
committed database change is not sufficient evidence for ordinary-page success.
At this earlier stage, the exact cache layer was not established; a URL-keyed
stale response was observed, not a proved Hyperdrive/Redis diagnosis. The later
Workers Cache evidence above supersedes that uncertainty.

Attempted a targeted Cloudflare purge of only the two list URLs (limits 8/100)
and detail 70/71. API returned authentication error 10000; no successful purge,
cache rule edit or new permission grant occurred. The then-proposed zone Cache
Purge credential/session is not a remedy for the subsequently identified Workers
Cache layer; see the current partial acceptance above.

Candidate `58ec07b` Linux CI 34814667415 and earlier `37bd78e` CI 34813283241
completed successfully. This does not cover the subsequently added maintenance
scripts; those have the local test/type/dry-run evidence above.
