# PHP cart/compute → TypeScript cart budget

## Original contract and first-party caller

- Source route: `../cinashop-php/route/api.php:278`, POST `cart/compute`, StationOpen and mandatory customer login.
- Source controller: `app/controller/api/v1/order/StoreCart.php:240`: `cartId`, `shipping_type` default **-1**, authenticated request UID; calls `StoreCartServices.computeUserCart`.
- Source calculation: `app/services/order/StoreCartServices.php:1122–1198`; SKU/membership/promotion/coupon admission starts in `getUserProductCartListV1` and `computedProductPromotion` in the same service. Best owned/unclaimed coupon rules are `app/services/activity/coupon/StoreCouponIssueServices.php:791`; `StorePromotionsServices.php:1387` applies coupons before gift thresholds.
- Actual old caller: `view/uniapp/api/order.js:35`; `view/uniapp/pages/order_addcart/order_addcart.vue:924` sends `{cartId: selectedIds.join(',')}` and does not select delivery. At approximately 1024 it consumes `coupon`, `deduction`, `svip_status`, `svip_price`. Its `subOrder` explicitly calls the coupon receive endpoint when `coupon.used` is absent, and then passes the actual owned coupon ID to order confirmation.
- PHP intentionally returns `promotions: []` in `computeUserCart`, even though promotions alter the quoted amounts. This is preserved; the response is not a pass-through of an order confirmation or marketing campaign list.

## Request and authorization

POST `/api/cart/compute`, JSON `{cartId:"3,1", shipping_type?:-1|1|2|3}`. Numeric strings for the shipping enum are accepted. `cartId` is the old CSV field, 1–100 distinct canonical positive int32 IDs. Unknown body fields, every query parameter (including repeated parameters), malformed JSON/UTF-8, non-JSON media, and a body larger than 4096 bytes are rejected. Omitted/-1 shipping is **unspecified**; it does not choose express, pickup, an address, or a store.

The registered customer route retains StationOpen and force-auth. The handler also requires the verified customer UID/user/expiry metadata and uses the password version that the JWT middleware actually verified. The calculation checks active, undeleted membership of that identity in a PostgreSQL repeatable-read **READ ONLY** transaction. After that snapshot ends it reads the actual account again and checks password version, status, deletion and JWT expiry before releasing the response. No Admin permission is granted or required by a customer cart read. Responses, including failures before the handler, are private/no-store with the application response-cache policy.

Every requested row must exist in the current UID's reusable cart (`isNew=0`, unpaid, undeleted, status=1, positive bounded quantity, no assisted staff/tourist/store ownership). Incomplete/cross-UID selections are rejected as a whole. Different activities or product fulfillment types cannot be mixed. Current product type and exact SKU identity/retirement/stock/verification are rechecked through the existing cart and activity admission logic; no list of already displayed prices is trusted.

## Response projection

The old top-level response remains:

```ts
{
  promotions: [],
  coupon: [] | {
    // Legacy template/scope/value projection, including:
    id, cid, coupon_title, type, coupon_type, coupon_price, use_min_price,
    product_id, category_id, brand_id, true_coupon_price,
    used?: { id: actualOwnedCouponId, cid: issueId }
  },
  deduction: {
    product_type, type, activity_id,
    promotions_price, coupon_price, first_order_price,
    sum_price, vip_price, pay_price
  },
  svip_status: boolean,
  svip_price: number,
  budget: { /* additive modern contract below */ }
}
```

All old money fields are JSON numbers. Every internal amount is an integer cent. In particular, the internal compute scope derives raw line amounts from integer unit cents × quantity, avoiding the existing display-only floating multiplication. The budget verifies `raw - membership - pricePromotions = merchandiseSubtotal`, and `pay = max(0, merchandiseSubtotal - coupon - firstOrder)`. The UI independently validates that identity and the exact returned selection.

`budget` adds `requiresCouponClaim`, `couponIssueId`, `couponUserId`, exact `selection` (id/productId/cartNum/unique/type/activityId, requested order), coupon-adjusted `gifts`, `requiredIntegral` for an actual type4 redemption, decimal `hypotheticalPaidMemberPayPrice|null`, `excludes:["shipping","integral","payment"]`, and `needsCheckoutRequote:true`. The exclusion refers to optional cash-budget points deduction; a real redemption still checks and displays its required points using the existing order quote's balance admission. Gift product/coupon/integral projections are expected benefits, not awarded rows. `couponUserId=0` with a selected coupon means there is **no owned coupon yet**. No synthetic ID is exposed as an owned coupon; the internal hypothetical claim only supplies timing/value facts to the unchanged evaluator.

## Pricing authority and narrow shared diffs

- `StoreCartService`: new **internal** `mode:"compute"` selected-ID scope; exact reusable subset and requested order; `hypotheticalPaidMember` used only internally, never accepted by existing cart/list HTTP parameters; skip cart-list gift previews because computation re-quotes gifts after its best coupon. Raw subtotals in cart/buy/compute and unscoped reads now all use the existing integer-cent unit price multiplied by quantity, with the same safe-integer guard. This fixes a real schema-valid SKU (`9999999900.79` × `3478`) whose binary-float raw subtotal was one cent higher than the mature confirmation and was rejected by `normalizeCartList`. DTO and activity/eligibility/write behavior remain the same.
- `OrderCouponService`: only `export { evaluateCoupon as evaluateOrderCoupon }` was added. No existing picker, explicit owned-coupon resolution, order quote, create or coupon rule semantics changed. `prepareCouponScope` already exports canonical product IDs + relational references, category/brand ancestor scopes and exact promotion coupon-eligible amounts.
- `V2CouponCompatibilityService`: `legacyCouponProjection` was already exported; the new budget reuses it, with owned snapshot amount/title and compact `used` evidence. No new export or existing query behavior change was necessary.
- Membership uses existing `calculateMemberUnitPriceCents` and fresh SQL membership policy/rights, including each unit's PHP-compatible truncation and the cheaper valid level/SVIP winner.
- First-order uses existing `quoteFirstOrderDiscount`; eligibility excludes normal coupons and price/gift promotions, including a zero-value eligible first-order policy. Price promotions use existing `quoteOrderPromotions`, including caps, segments, chosen rule and overlay eligibility. Coupon fixed/rate discounts use the same `evaluateOrderCoupon` + integer scope/discount helpers as order quote. Percentage values retain the mature PHP `bcdiv(...,100,2)` whole-percent truncation.
- Gift eligibility uses existing `quoteOrderPromotionGifts`, with exact post-promotion line cents and coupon allocation via `allocateLegacyDiscountCents` + `fitCheckoutLineCapacities`, and the real explicit delivery enum only when one was supplied.

The budget scans at most 1000 currently valid owned coupons and 1000 current manual templates; overflow rejects rather than claiming an incomplete maximum. A best equal-value owned coupon wins over an unclaimed one. Missing/used/reserved/expired/revoked owned rows are not candidates. Owned coupon rules follow the mature checkout resolver; template status or title alone is not invented as a new owned-coupon rejection rule.

Unlike PHP's unconditional exclusion of a template with any currently valid owned coupon, the modern budget also compares a second currently permitted manual claim when `receiveLimit` and actual receipt counts allow it. This matters for imported historical owned snapshots with a different face value/threshold from the current template. It does not mutate the old snapshot or grant a second coupon; equal-value owned coupons still win.

Unclaimed templates additionally mirror the existing manual receive writer: receiveType1, category0/1, appType0, issuance window, stock/permanent policy, all-state received counts, legacy receiveLimit0=>one and historical receive evidence, realizable use dates and owned title column length. These are offers only: a concurrent claim, limit or inventory change can still cause actual receiving to fail.

### Compatibility boundaries

1. **SVIP membership coupons:** PHP removes the template category filter for actual/hypothetical SVIP. The current migrated manual receive writer deliberately refuses category2/appType1 until its entitlement flow is implemented. Consequently this budget does not promise that an unclaimed membership-only template can be manually received. Existing valid owned coupons remain evaluated by mature checkout. SVIP saving assumes paid membership **prices**, re-evaluates the full same selection/promotions/first-order/best permitted coupon budget, and does not activate membership or award member coupons.
2. **Purchase modes:** the real old compute endpoint uses `new=false`. Direct-buy rows stay outside this endpoint. Modern presale/type6 and newcomer/type7 admissions require immediate purchase in their existing contracts, so their invalid reusable representations are refused explicitly. Qualified reusable activity rows (including current seckill/bargain) are priced through existing paired SKU/participation/schedule rules, with additional once/lifetime quota checks; packages use the existing full package resolver. Activity pricing does not acquire ordinary coupon/first-order discounts merely because it appears in the cart. Unsupported/mixed fulfillment choices fail closed; no fake pickup store/address or a payment capability is created.
3. **No reservation:** READ ONLY protects internal consistency, not future stock/coupon/price entitlement. No cart cleanup, grant, stock decrement, order, ledger, KV checkout key, quoteToken, payment readiness query or external provider call occurs. Checkout has the original full address/store/integral/payment/form and transactional final verification.

## Modern first-party flow

UniApp cart uses the actual selected-ID budget, not the price of the full cart. The panel separately displays membership, promotions, first-order, coupon and SVIP hypothesis, with explicit exclusions and no stock/gift reservation. A selected unclaimed coupon changes the CTA to **“领券并去结算”**; that explicit action invokes the existing receive endpoint, accepts only a real positive owned receipt ID, reads a fresh budget, then navigates to confirmation with the owned ID. A rejected/uncertain receipt keeps the user on the cart and re-reads ownership, never creates an optimistic coupon ID or repeats a grant automatically. Epoch/UID/token/session-version/exact-selection checks discard old reads and receipts after edits, hide or identity replacement.

`useCheckout` adds only a one-time cart `couponId` suggestion. It is rejected for immediate purchase or activity rows, consumed only after the current owner’s real eligible owned order-picker response returns that ID as available, and withdrawn on scope/delivery/identity/hide changes. Up to 50 actual 20-candidate pages can be read to find an owned ID beyond the first page; no acceptance is based solely on the query. Final order quote/create still independently validate the selected coupon under the existing transaction.

## Validation

New suites:

- `test/cart-computation-input.test.ts`
- `test/cart-computation-http.test.ts`: actual `createApp`, registered route, genuine signed customer JWT, disposable SQL (PGlite or explicit owned loopback PG16), no external fetch; snapshots include cart/products/SKUs/accounts/orders/bills/coupon templates/ownership/evidence. Includes schema-valid high-value cent precision, selected-only threshold, owned/unclaimed percent truncation, real manual claim→actual quote comparison, membership/first-order, historical claim limits, scope reconciliation, activity admission, cache, stale identity and request bounds.
- `test/cart-computation-frontend.test.ts`: strict numeric/selection/claim DTO and epoch state, real compiled cart SFC + template check, actual Pinia cart/request/API modules and actual `useCheckout` consumer with isolated native I/O/auth store/page hooks.

Parent runner owns final ordinary/native/type/build/browser and immutable-input verification. Early and final results will be recorded in the main migration report; this document does not claim tests have passed before that evidence is available. No production/provider execution is performed.

## Other API10 gaps reviewed at slice selection

These were read-only candidates, not guessed retirements or new coverage credits:

| Legacy route | Evidence / boundary |
| --- | --- |
| `/division/agent/del_staff/:uid` | Readable Division controller and DivisionServices mutation of own staff’s division fields. Commission identity needs its complete locking/audit/consumer slice. |
| `/upload/video` | Readable PublicController multipart upload + attachment metadata and daily quota. Requires owner-scoped R2/media lifecycle and bounded video flow. |
| `/image_base64` | Readable legacy image/code fetch and domain/extensions. A migrated route requires explicit authorized public media reads, not an arbitrary URL proxy. |
| `/get_qrcode/:type/:id` | Readable Qrcode controller across many commerce/identity types with H5 + official ticket + mini-program outputs. H5-only alias is incomplete. |
| `/switch_h5` | Readable Login controller delegates account-source switching. Requires the real identity/provider/binding chain, not trust in client `from`. |
| `/cancel/user` | Readable event → CancelUser listener/service; clears spread, balance/integral, work/WeChat bindings and soft-deletes, while legacy swallows errors. Destructive/financial cancellation cannot be copied as a success-only GET. |
| `/wechat/app_auth` | Readable raw client openid/unionid/profile legacy flow. Requires current provider-verified authorization and identity binding; coordinated with WeChat owner. |
| `/wechat/follow` | Readable controller/service delegation; separate WeChat owner handles provider protocol. |
| `/coupon/receive/batch` | Route target is absent in the readable, non-inheriting StoreCoupons controller. Still unresolved until first-party/runtime evidence supports replacement or retirement; absence alone earns no migration credit. |
