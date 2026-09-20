# Physical refund split: calculation core and integration audit

Latest adapter increment: [refund history and returned-point generations](refund-order-generations.md)
distinguishes successive financial scopes on a retained remaining-order ID.
Real applications/finalization now exclude only proven materialized claims and
exact prior return-bill identities. This does not activate physical writes or
complete earned-income/ledger/lifecycle ownership and coordinated finalization.

Latest structural increment: [physical refund order persistence](refund-order-materialization.md)
now performs actual first/later/whole order/cart writes in isolated SQL, with
durable source/child evidence and native lock/replay/rollback tests. It remains
**unwired**: the finalizer, historical compensation/ledger ownership, related
readers, invoice/promotions and guarded schema installation are not integrated.
The historical "not implemented" statements below describe their earlier
stages; the runtime physical-refund requirement still remains open.

Latest compensation prerequisite: [completed-goods line compensation](refund-line-compensation.md)
replaces original-order cash-ratio point/commission targets for checked v1
orders. Refund finalization and receipt share a locked cumulative line plan;
original refund/payment/income identities remain unchanged. This still does not
materialize refund children or close their ownership/immutable-association gates.

Latest prerequisite: [checkout line financial evidence](checkout-line-finance.md)
now supplies the eleven legacy line totals, actual raw postage, unit cost,
activity redemption points and second-card unit entitlements for newly created
orders. [Line-based fulfillment and supplier splitting](order-split-finance.md)
now consumes the checked partition in those two local runtime paths, including
child aggregation and raw-postage/integer-point handling. Physical refund child
materialization and settlement/operation/ledger associations remain open; a
version label or complete source snapshot alone does not authorize them.

The subsequent [refund line-quotation increment](refund-line-finance.md) also
connects actual quote/application cash amounts to that checked line partition,
including completed-claim residue replay and explicit Admin-concession versus
automatic-full-recovery behavior. It leaves physical child/ledger integration
open; it does not move existing refund or immutable operation identities.

The later [supplier income continuity increment](supplier-split-ledger.md)
preserves pending supplier income through fulfillment child creation and fixes
pending-versus-settled refund offsets. This resolves that specific fulfillment
ledger dependency, not physical refund materialization or reward/brokerage and
immutable refund-operation associations.

## Calculation increment (2026-09-15, local and unwired)

`RefundSplitAllocation.ts` now implements the arithmetic/entitlement dependency
for physical refund splitting. At that initial stage no execution endpoint
called it; the later fulfillment/supplier consumers above are separate.
**No physical refund children are created by this increment.** This is progress toward, not
acceptance of, the still-open physical split requirements below.

- Eleven line-total fields use bounded decimal parsing and BigInt arithmetic:
  divide by the source quantity at four decimal places, then multiply and
  truncate money to two places or points to zero places. In particular,
  `1.00 / 6 * 3` allocates `0.49`, leaving `0.51`, not `0.50` each.
- Whole lines retain their source values; partial gift lines are zeroed as in
  PHP. Subsequent splitting uses the remaining snapshot, retaining its residue.
  Unit prices, SKU details and activity provenance are not re-priced or changed.
- Missing/null line totals are returned in `missingFields`. PHP-compatible zero
  placeholders in the output are **not financial evidence**. The future
  materializer must reconcile missing fields from authoritative checkout/order
  data before persistence, including before reusing any generated snapshot.
- Write-off partitioning takes unredeemed entitlements into the selected child
  first, preserves consumed/remaining totals, resets timestamps only for entirely
  unused children, and rejects contradictory source counters. Unit entitlements
  must be obtained from the stored snapshot or exact SQL quantity quotient, not
  a mutable current SKU. This function does not establish refund eligibility.
- Whole-order and unshipped gift-only remainder decisions are distinct results;
  neither expands a reviewed selector or authorizes additional compensation.
- Changed-price allocation reconstructs actual/raw ratio at four places and
  preserves the remainder even when the selected child receives zero cash.

### Actual PHP comparison and intentional defect correction

`audit/verify-php-refund-split.php` invokes the actual local
`StoreOrderSplitServices::slpitComputeOrderCart` and `splitComputeOrder` methods
using PHP **8.4.25**, `-n`, built-in BCMath, a constructor-free service and an
in-memory capture DAO. No framework boot, app settings, database or network
access occurs. This is an arithmetic oracle, not a PHP application/SQL test.
Source SHA-256:
`9f9cb5201ec0b71543d61e6cd8699d12231938cde72d33869778a1e540b46594`.

All **12 line cases / 93 field pairs** and **8 payment cases** matched the
recorded PHP results. Two payment cases also reproduce PHP's zero-selected-price
defect: its falsey `pre_pay_price` branch re-applies the ratio to the remaining
child instead of subtracting the first allocation. The new calculator preserves
the original total deliberately rather than copying that loss:

| Actual / raw / selected raw | Selected | PHP remainder | New remainder |
| --- | --- | --- | --- |
| `0.01 / 10000.00 / 5000.00` | `0.00` | `0.00` | `0.01` |
| `2.00 / 6.00 / 0.00` | `0.00` | `1.99` | `2.00` |

Gift-coupon/bonus ownership must likewise follow child role, not whether its
price is truthy. The calculator does not yet write those ownership fields.

### Evidence and next required integration

The new pure-function suite passes **86/86**, no skips. It covers every allocated
field, invalid amounts/identities/quantities, modern missing fields, gifts,
repeated residue allocation, changed/zero/large payments, and an exhaustive small
counter matrix checking entitlement conservation. The first run was 71/72:
the invalid-selector table was accidentally spread into positional arguments by
`it.each`; wrapping rows as `{ selected }` corrected the test input, with no
relaxation of the assertion. Initial sandbox access to the existing PHP binary
was denied; the same read-only oracle then ran with approved access.
The Worker source and runtime-test TypeScript checks pass. No prior SQL or
browser result is counted as acceptance of this new calculation module.

The Workers skill guided bounded deterministic helpers with no request state,
database/provider I/O or detached promises. Current official Workers guidance
was retrieved; latest npm types retrieval was denied, so the installed Workers
types (5.20260828.1), Hyperdrive interface and local Wrangler schema were read.
No binding/configuration/dependency changed. PostgreSQL lock/short-transaction
guidance remains an integration constraint; no SQL transaction was changed or
tested in this increment.

Next work must first supply/reconcile the modern checkout's missing per-line
postage, points and commission evidence, then aggregate child order amounts and
materialize orders/carts/claims under a consistent refund/root/child lock order.
Immutable operation/payment associations and original reward/brokerage/supplier
ledger ownership must be integrated in the same settlement/recovery protocol.
Invoice/promotions, gift ownership and all later fulfillment paths still require
their own SQL acceptance. Do not connect this calculator by simply changing a
refund's `store_order_id` or by calling the shipping splitter.

No production database/image/cache change, browser test, PostgreSQL cluster,
staging, commit, push or deployment in this increment. The nine staged files and
the migration checkboxes are retained. Reproduce from `workers-ts`:

```powershell
node node_modules/vitest/vitest.mjs run test/refund-split-allocation.test.ts
& 'C:/Users/cina/AppData/Local/Programs/CinaShopTools/php/php.exe' -n audit/verify-php-refund-split.php
```

## Previous increment: cart identity

2026-09-15. Local migration work, **not deployed**. The previous increment
implemented [application quantity reservations](refund-quantity-reservation.md).
This increment fixes a reproduced incompatibility between actual fulfillment
splits and refund creation. **It does not implement physical refund splitting.**

## Reproduced blocker and implemented fix

`SupplierFulfillmentService.splitDelivery` previously generated hexadecimal
UUID-derived `cart_id` values for new child carts. The refund preparation core
requires a positive integer canonical cart ID, and the Admin quote contract
requires that actual canonical ID rather than a row-ID alias. Both the delivered
and remaining child failed real SQL-backed quotation with
`订单退款商品标识无效`. The old embedded snapshot also retained its source ID.

New child cart rows now reserve their primary keys from the existing, **owned**
`store_order_cart_info.id` sequence. Each newly created row uses that same
integer as `cart_id`; the parent order's child-cart list and embedded snapshot
`id` use the same value. Its `old_cart_id` lineage remains intact. The UUID-based
`unique` keys are unchanged; cart IDs are identifiers, not authentication secrets.

On later splits the remaining order/cart retain their primary keys and cart
IDs; only newly created rows consume sequence values. An acknowledged replay
or whole-order delivery consumes no new cart ID. Sequence gaps after rollback
are expected and are not reclaimed. No `MAX+1`, sequence reset or runtime
schema repair is performed. The bounded helper supports 1–400 new rows, uses
the transaction-local search path and rejects missing sequence ownership.

The existing customer/Admin refund contracts remain numeric and unchanged.
Previously stored hexadecimal IDs are **not batch rewritten**. A legacy
remaining row keeps its original identity and may still require reconciliation;
this is not a claim to have repaired every previously deployed child order.

The Workers/PostgreSQL skills guided awaited database-only work inside the
existing short order transaction and retaining the existing lock order.
Latest Workers-types retrieval was denied by local network policy; review used
installed `@cloudflare/workers-types` 5.20260828.1, its Hyperdrive interface and
the local Wrangler schema. No configuration, dependency or binding changed.

## PHP physical-split contract still to implement

The behavior reference is the sibling PHP source, not historical MySQL rows.
The relevant source methods were read directly in this audit:

| Required behavior | PHP source | Current TypeScript status |
| --- | --- | --- |
| First split creates selected and remaining orders; root becomes `pid=-1`; later split keeps the remaining order | `StoreOrderSplitServices.php:80,198` | Fulfillment already has this structure. Refund settlement does not invoke it. |
| Refund quantities move to the selected child; remaining quantities exclude the selection | `StoreOrderSplitServices.php:198` (`splitV2`) | Application holds now exist, but refund child redistribution is not implemented. |
| Per-line cash/points/coupon/postage/brokerage allocation, truncation and remainder handling | `StoreOrderSplitServices.php:425,505` | Existing fulfillment uses order-weight allocation. It is not proof of the PHP refund allocation contract. |
| Gift-only remainder handling and partial write-off counts/status | `StoreOrderSplitServices.php:119,319,425` | Not accepted for the future refund split flow. |
| Invoice and promotion records follow the split | `StoreOrderSplitServices.php:171` | No refund split integration yet. |
| Refund association moves to selected child; full refund resets cart counter | `StoreOrderRefundServices.php:698` | Refund currently stays on its original application order; marked settlement retains the counter. |
| Original payment is used for refunding a child | `StoreOrderRefundServices.php:618` | Existing TS provider preparation follows `pid` to the payment root; synthetic acceptance is documented below. |

These are implementation dependencies, not alternatives to the target outcome.
The new ID allocator is reusable by the future refund splitter, without copying
the incompatible hexadecimal generation from fulfillment.

## Integration boundaries that must not be skipped

1. **Lock hierarchy.** Fulfillment resolves/locks the root before the active
   child. Refund execution currently locks the refund and application order.
   A future refund split must coordinate root/child locks without introducing
   a cycle or accepting changed ownership while waiting.
2. **Financial and durable identity.** Admin creation and operation receipts
   bind the original reviewed order/refund identity. Provider-admitted recovery
   also checks the payment row's order association. Moving `store_order_id`
   alone can break same-key recovery. Preserve immutable original evidence and
   validate physical associations explicitly; never rewrite the reviewed body
   or generate a replacement operation key.
3. **Compensation.** Existing finalization adjusts stock, wallet, rewards,
   brokerage, invoice and group state against the application order. Splitting
   cannot duplicate those effects across a parent and children. Partial refund
   followed by fulfillment still needs dedicated acceptance: current shipping
   clones reset `refundNum` and use `splitSurplusNum`, so the ID fix is not proof
   that previously refunded quantities are excluded from future fulfillment.
4. **Commit boundary.** Keep provider calls outside SQL transactions. Split
   rows, cart redistribution, business compensation and terminal evidence must
   commit together or have an explicit durable recovery protocol. PHP's
   provider-call-inside-transaction pattern is not copied into Workers.
5. **Release.** Application writers, executors and callbacks must coordinate
   deployment with the reservation version. Real production catalog/roles,
   Hyperdrive, live providers and browser acceptance remain separate gates.

No production database/image/cache change, staging, commit, push or deployment
was performed in this increment. The migration checklist remains
240 checked / 164 open / 404 total.

## Verification and retained failures

Final local PostgreSQL **16.15** batch: **10 files / 160 tests passed**, zero
failures or skips, 79.22 seconds. The batch includes SQL-backed lifecycle tests
as well as pure-function and static route contracts; it is not 160 separate
end-to-end production cases. The new `split-order-refund-identity.test.ts`
contains **20** tests against the actual split/refund code and isolated SQL.

Coverage includes both children through quote → application → cancellation →
new application → one balance settlement; synchronized IDs and unchanged root
identity; repeated/multi-line splits; replay and whole-order delivery without
new IDs; late failure rollback; sequence gaps, invalid bounds and the 400-ID
bound; missing ownership rejection; an alternate transaction-local schema with
a deliberately different sequence name; and independent native connections
allocating alongside an ordinary default-ID insert without collisions.

Two original-channel tests replace only WeChat/Alipay transport: a 5.00 child
refund uses the original root payment total of 20.00, original order/trade ID
and the same `CNSR<refundId>` on UNKNOWN recovery. One synthetic WeChat callback
test checks retained child association and no repeated settlement. All global
fetch calls are forbidden in this fixture. These tests do not contact live
providers, process real callbacks or establish live payment acceptance.

Failure history:

- Initial SQL reproduction: both child cases failed on invalid canonical ID.
- First ID-fix run: quote succeeded, then both tests failed because their new
  application inputs omitted required `refundExplain`. The typecheck found the
  same omission. The tests were corrected; no production validation relaxed.
- Expanded batch: 153/154 passed. An existing static route assertion assumed
  LF while the Windows source used CRLF. The routes and middleware were present;
  only line-ending normalization was added to that test. No route changed.
- Next batch passed 157/157; the final batch above adds the three provider/
  callback tests. Both Worker source and runtime-test TypeScript checks passed.

The older Kefu scenario's local clone setup now attaches its replacement
sequences with `OWNED BY`, matching the other native clone fixtures and allowing
the allocator to discover the clone's own sequence. The complete Kefu scenario
was not executed this turn; this fixture correction is not new production or
browser acceptance.

Each runner reported zero remaining fixture databases/roles. All five owned
clusters were independently checked with `pg_ctl` (exit 3), no postmaster PID
or bootstrap-password file, zero processes from the trusted runtime and no
listeners on their ports:

| Cluster under ignored `.cache` | Port | Run |
| --- | --- | --- |
| `finance-postgres-bExHZZ` | 52189 | Original two-case failure |
| `finance-postgres-pBQ6O9` | 64543 | Missing test argument |
| `finance-postgres-sIrZOj` | 55965 | Static CRLF failure |
| `finance-postgres-8OqQGR` | 50178 | 157 passing tests |
| `finance-postgres-YK21BR` | 59590 | Final 160 passing tests |

Stopped cluster directories were retained; no broad filesystem deletion was
performed. No browser or deployed Hyperdrive test was rerun. Original nine
staged files were left unchanged. Reproduce the final batch from `workers-ts`:

```powershell
node scripts/run-local-finance-postgres.mjs ../.cache/postgres16-20260915/runtime/pgsql/bin test/split-order-refund-identity.test.ts test/supplier-split-fulfillment.test.ts test/refund-quantity-reservation.test.ts test/admin-refund-creation.test.ts test/admin-refund-creation-quote.test.ts test/customer-refund-application.test.ts test/customer-refund-read.test.ts test/customer-refund-return.test.ts test/store-mobile-order-compatibility-scenario.test.ts test/store-mobile-order-migration.test.ts
```
