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

## Observed issue and proposed replacement (2026-09-14)

Browser network evidence on `/goods/70`: the detail API returns HTTP 200 with
`image=https://via.placeholder.com/300` and empty slider arrays. The browser's
request for that exact image fails with `net::ERR_CONNECTION_CLOSED`. Homepage
cards use the same source. No URL-rewriting or R2-signature fault was observed in
this sampled flow; console logs alone did not report the network failure.

A read-only `/api/products?page=1&limit=100` returned all 71 public products:
34 named 测试商品A and 34 named 会员专享商品B use the exact failing URL; 3 other
products have empty images. This is a public-catalog observation, not a complete
database inventory (hidden/deleted products or other media tables are not covered).

The **not-yet-executed** proposal is to publish the two assets, verify HTTP status,
image MIME and decoded dimensions, then conditionally replace only the 68 observed
products' `image` fields. Re-read database identities and old values immediately
before writing; reject drift. Do not execute `/_seed`: it also modifies users,
balances, inventory, categories, settings and activities. Do not change slider
arrays, missing images, prices, stock, SKUs, orders or activity images. Preserve
the old value and ID mapping for conditional rollback, and account for product
detail caches before browser verification. Deployment and data mutation require
separate authorization; none was performed when preparing these assets.

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

No production data or deployment changed. The production missing-image issue
remains open until an approved replacement is executed and verified.
