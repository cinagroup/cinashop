/** Dedicated PostgreSQL16 test host. No installer, system service, production
 * URL, persistent environment edit or automatic deletion. Keep stopped cluster
 * logs under ignored .cache for diagnostics. Supply an already trusted bin dir. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync, unlinkSync, openSync, closeSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const workerRoot = resolve(import.meta.dirname, '..');
const arguments_ = process.argv.slice(2);
// Schema/ACL tests deliberately need an isolated maintenance superuser (as in
// the CI PostgreSQL service), never a privilege upgrade of an existing server.
const schemaMaintenance = arguments_[0] === '--schema-maintenance';
if (schemaMaintenance) arguments_.shift();
// Literal case names permit bounded follow-up of an already completed batch.
// They never become shell code or user-provided regular expressions.
const caseNames = [];
while (arguments_[0] === '--case') {
  arguments_.shift();
  const name = arguments_.shift();
  assert.ok(typeof name === 'string' && name.length > 0 && name.length <= 200 && name.trim() === name,
    '--case requires one nonempty literal test name of at most 200 characters');
  caseNames.push(name);
  assert.ok(caseNames.length <= 8, 'At most eight literal cases are supported');
}
// Fixed verbose reporter for reviewable per-file/case evidence. It does not
// accept arbitrary Vitest arguments or alter the explicit filename allowlist.
const verboseTests = arguments_[0] === '--verbose-tests';
if (verboseTests) arguments_.shift();
const [binArgument, ...tests] = arguments_;
assert.ok(binArgument && tests.length, 'Usage: node scripts/run-local-finance-postgres.mjs [--schema-maintenance] [--case literal-name ...] <trusted-pg16-bin-dir> test/name.test.ts [...] (or audit:orm / audit:unit-shard-1 / audit:unit-shard-2 only in schema-maintenance mode)');
const catalogAudit = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:orm';
// Exact complete CI partitions only: no filters, arbitrary command or existing
// database. The normal allowlist and ten-minute targeted-test deadline stay.
const unitShard = schemaMaintenance && tests.length === 1 && /^audit:unit-shard-[12]$/.test(tests[0])
  ? Number(tests[0].slice(-1)) : undefined;
if (caseNames.length) assert.ok(tests.every(test => /^test\/[a-z0-9-]+\.test\.ts$/.test(test)),
  'Literal cases apply only to explicit test files, never audit or browser modes');
// Interactive in-app Browser acceptance. Does not load an external browser,
// accept a production URL, or launch a Playwright driver.
const offlineAdminBrowser = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:admin-offline-browser';
// Refund fixtures now install the reviewed NOLOGIN checkout pricing owner too.
// Require explicit maintenance of a newly owned local cluster, never elevate an existing host.
const adminBrowserAcceptance = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:admin-refund-browser';
const customerBrowserAcceptance = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:customer-order-browser';
const adminOrderBrowserAcceptance = schemaMaintenance && tests.length === 1 && tests[0] === 'audit:admin-order-browser';
const browserAcceptance = adminBrowserAcceptance || customerBrowserAcceptance || adminOrderBrowserAcceptance;
if (verboseTests) assert.ok(!catalogAudit && !unitShard && !browserAcceptance && !offlineAdminBrowser,
  'Verbose reporting applies only to explicit native test files');
if (browserAcceptance) {
  for (const key of ['TEST_BROWSER_PACKAGE_JSON', 'TEST_BROWSER_EXECUTABLE', 'TEST_BROWSER_OUTPUT_DIR']) {
    assert.ok(process.env[key] && isAbsolute(process.env[key]) && existsSync(process.env[key]), `Browser acceptance requires an existing absolute ${key}`);
  }
  const output = realpathSync(process.env.TEST_BROWSER_OUTPUT_DIR);
  const checkout = realpathSync(resolve(workerRoot, '..'));
  const inside = relative(checkout, output);
  assert.ok(inside.startsWith('..') || isAbsolute(inside), 'Browser output must be outside the repository');
}
for (const test of catalogAudit || browserAcceptance || offlineAdminBrowser || unitShard ? [] : tests) {
  assert.match(test, /^test\/[a-z0-9-]+\.test\.ts$/, 'Only explicit unit test paths are accepted');
  assert.ok(existsSync(resolve(workerRoot, test)), `Test does not exist: ${test}`);
}
if (schemaMaintenance) {
  const allowed = new Set([
    'test/withdrawal-effects-upgrade.test.ts',
    'test/shipping-template-lifecycle-services.test.ts',
    'test/uniapp-product-sku-postgres.test.ts',
    'test/customer-financial-catalog-postgres.test.ts',
    'test/customer-writeoff-operation-postgres.test.ts',
    'test/cashier-second-card-origin-postgres.test.ts',
    'test/customer-work-writeoff-postgres.test.ts',
    'test/customer-cashier-second-card-postgres.test.ts',
    'test/customer-work-writeoff-mature-scenarios-postgres.test.ts',
    // Exact full consumer regressions for the independent customer writeoff
    // follow-up; maintenance still targets only this new disposable cluster.
    'test/store-order-writeoff-migration.test.ts',
    'test/store-mobile-order-migration.test.ts',
    'test/kefu-order-migration.test.ts',
    'test/admin-mobile-fulfillment-migration.test.ts',
    'test/second-card-product.test.ts',
    'test/second-card-validity.test.ts',
    'test/second-card-reminder-migration.test.ts',
    'test/admin-writeoff-order-read-postgres.test.ts',
    'test/admin-writeoff-order-read-http.test.ts',
    'test/order-brokerage.test.ts',
    'test/order-reward.test.ts',
    'test/customer-work-financial-postgres.test.ts',
    // Complete mature refund/presale regression fixtures install their reviewed
    // NOLOGIN protocols only inside this newly owned disposable PG16 cluster.
    'test/admin-refund-decision-postgres.test.ts',
    'test/refund-atomic-materialization.test.ts',
    'test/refund-order-materialization.test.ts',
    'test/presale-delivery-outbox-postgres.test.ts',
    'test/presale-fulfillment-postgres.test.ts',
    'test/customer-product-catalog-postgres.test.ts',
    'test/customer-work-product-postgres.test.ts',
    'test/customer-work-user-postgres.test.ts',
    'test/customer-user-catalog-postgres.test.ts',
    'test/customer-city-delivery-postgres.test.ts',
    'test/customer-work-fulfillment-postgres.test.ts',
    'test/customer-waybill-actor-postgres.test.ts',
    'test/customer-work-read-postgres.test.ts',
    'test/customer-work-entry-postgres.test.ts',
    'test/kefu-mobile-workbench-postgres.test.ts',
    'test/kefu-mobile-entry-postgres.test.ts',
    'test/delivery-workbench-read-postgres.test.ts',
    'test/delivery-workbench-writeoff-postgres.test.ts',
    'test/merchant-manager-fulfillment-postgres.test.ts',
    'test/merchant-manager-financial-postgres.test.ts',
    'test/store-manager-order-read-postgres.test.ts',
    // The invoice lifecycle fixture installs a NOLOGIN owner and trigger guards.
    'test/out-invoice-lifecycle.test.ts',
    // Full-profile registration and paid-outbox gift validity in owned PG16.
    'test/coupon-gift-use-window-postgres.test.ts',
    'test/registration-level-activation.test.ts',
    'test/admin-level-activation-http.test.ts',
    'test/admin-level-activation-postgres.test.ts',
    'test/admin-paid-membership-config-postgres.test.ts',
    'test/paid-membership-config-authority.test.ts',
    'test/order-reward-config-authority.test.ts',
    'test/admin-coupon-issue.test.ts',
    'test/admin-coupon-issue-postgres.test.ts',
    'test/admin-coupon-issue-http.test.ts',
    'test/coupon-issue-manual-claim.test.ts',
    'test/admin-coupon-template.test.ts',
    'test/admin-coupon-template-postgres.test.ts',
    'test/admin-coupon-template-http.test.ts',
    'test/coupon-manual-claim.test.ts',
    'test/coupon-template-catalog.test.ts',
    'test/runtime-coupon-template-privileges.test.ts',
    'test/admin-combination.test.ts',
    'test/admin-combination-postgres.test.ts',
    'test/admin-combination-http.test.ts',
    'test/admin-combination-export.test.ts',
    'test/admin-combination-statistics.test.ts',
    'test/admin-combination-statistics-postgres.test.ts',
    'test/admin-combination-statistics-http.test.ts',
    'test/pink-virtual-timeout-postgres.test.ts',
    'test/pink-success-notice-migration.test.ts',
    'test/pink-success-notice-postgres.test.ts',
    'test/combination-refund-policy-postgres.test.ts',
    'test/admin-activity-preservation.test.ts',
    'test/combination-sku-catalog-postgres.test.ts',
    'test/pink-refund-lock-order-postgres.test.ts',
    'test/pink-cancellation-payment-admission-postgres.test.ts',
    'test/pink-cancellation-authorization-postgres.test.ts',
    'test/pink-cancellation-status-postgres.test.ts',
    'test/pink-cancellation-refund-recovery-postgres.test.ts',
    'test/pink-cancellation-background-postgres.test.ts',
    'test/legacy-pink-status-postgres.test.ts',
    'test/runtime-business-login.test.ts',
    'test/seckill-runtime-login.test.ts',
    'test/seckill-product-media.test.ts',
    'test/runtime-seckill-schedule-lock.test.ts',
    'test/assisted-purchase-runtime-postgres.test.ts',
    'test/assisted-purchase-flow-postgres.test.ts',
    'test/assisted-payment-race-postgres.test.ts',
    'test/assisted-form-consumption-postgres.test.ts',
    'test/admin-user-list-postgres.test.ts',
    'test/shipping-lifecycle-route-auth.test.ts',
    'test/shipping-template-lifecycle-services.test.ts',
    'test/order-delivery-address.test.ts',
    'test/bargain-pickup-postgres.test.ts',
    'test/bargain-shipping-selection-postgres.test.ts',
    'test/bargain-pickup-admission.test.ts',
    'test/bargain-order-participation.test.ts',
    'test/brokerage-paid-order-migration.test.ts',
    'test/coupon-product-scope-migration.test.ts',
    'test/refund-line-finance.test.ts',
    'test/split-order-line-finance.test.ts',
    'test/supplier-split-ledger.test.ts',
    'test/checkout-coupon-management.test.ts',
    'test/admin-runtime-login.test.ts',
    'test/runtime-admin-boundary.test.ts',
    'test/admin-supplier-menu-write-capability.test.ts',
    'test/admin-supplier-menu-rules-native-http.test.ts',
    // These HTTP fixtures now install the real checkout NOLOGIN capability.
    'test/admin-refund-operation-http.test.ts',
    'test/admin-refund-creation-http.test.ts',
    'test/admin-refund-creation-quote.test.ts',
    'test/admin-refund-creation.test.ts',
    'test/customer-refund-application.test.ts',
    'test/refund-quantity-reservation.test.ts',
    'test/admin-refund-retirement.test.ts',
    'test/admin-runtime-auth.test.ts',
    'test/release-protocol-schema.test.ts',
    'test/shared-shop-runtime-permissions.test.ts',
    'test/release-shared-indexes.test.ts',
    'test/runtime-role-provisioning.test.ts',
    // Current checkout fixtures create a separate NOLOGIN pricing owner.
    'test/bargain-cart-binding.test.ts',
    // Read-only A3e catalog fixture commissions the checkout NOLOGIN owner.
    'test/bargain-selection-catalog.test.ts',
    // The helper-admission fixture uses the same owned checkout protocol.
    'test/bargain-help-admission.test.ts',
    'test/presale-checkout-postgres.test.ts',
    // This policy suite performs real checkout after its read-only assertions.
    'test/membership-pricing-policy.test.ts',
    // Uses the existing checkout NOLOGIN protocol before real refund materialization.
    'test/presale-refund-baseline-postgres.test.ts',
    // Full schema, atomic refunds, paid recovery and due delivery under an owned LOGIN.
    'test/presale-runtime-permissions.test.ts',
    // Immutable quota quantity receipts under the existing independent refund LOGIN.
    'test/purchase-quota-refund-receipt-postgres.test.ts',
    'test/purchase-quota-payment-ledger-postgres.test.ts',
    // Actual unpaid mixed-owner checkout cancellation using the existing refund LOGIN profile.
    'test/unpaid-mixed-order-cancellation-postgres.test.ts',
    // Registered origin protocol and real checkout in newly owned synthetic databases.
    'test/purchase-origin-evidence-postgres.test.ts',
    'test/purchase-origin-installation.test.ts',
    'test/purchase-cancellation-evidence-postgres.test.ts',
    'test/purchase-cancellation-installation.test.ts',
    // Ordinary-index catalog drift is injected only in this fresh owned PG16 cluster.
    'test/supplier-refund-lookup-indexes.test.ts',
    'test/assisted-order-list-index.test.ts',
    // Full external/bootstrap recharge seed checks use the owned checkout NOLOGIN role.
    'test/recharge-quota-seed-upgrade.test.ts',
    'test/seckill-time-reference-lock.test.ts',
    'test/seckill-time-reference-lock-upgrade.test.ts',
    'test/admin-assisted-order-cursor-postgres.test.ts',
    'test/bargain-order-concurrency-postgres.test.ts',
    'test/bargain-supplier-visibility-concurrency-postgres.test.ts',
    'test/bargain-visibility-writers-concurrency-postgres.test.ts',
    'test/bargain-participation-concurrency-postgres.test.ts',
    // A3f rule admission tests commission the same isolated checkout owner.
    'test/bargain-help-rule-concurrency-postgres.test.ts',
    'test/bargain-help-concurrency-postgres.test.ts',
    'test/bargain-admin-concurrency-postgres.test.ts',
    'test/bargain-admin-save.test.ts',
    'test/bargain-admin-dates-postgres.test.ts',
    'test/seckill-schedule-postgres.test.ts',
    'test/seckill-concurrency-postgres.test.ts',
    'test/seckill-cross-activity-compensation-postgres.test.ts',
    'test/seckill-compensation-refund-postgres.test.ts',
    'test/seckill-compensation-ordinary-order-postgres.test.ts',
    'test/seckill-sku-identity-fence-postgres.test.ts',
    'test/pc-seckill-purchase.test.ts',
    'test/admin-seckill-time.test.ts',
    'test/admin-seckill-time-postgres.test.ts',
    'test/admin-seckill-activity.test.ts',
    'test/admin-seckill-activity-postgres.test.ts',
    'test/runtime-seckill-parent-privileges.test.ts',
    'test/refund-line-compensation.test.ts',
    'test/bargain-admin-retirement.test.ts',
    'test/orphan-test-order-snapshot.test.ts',
    'test/orphan-test-order-cleanup.test.ts',
    'audit:unit-shard-1', 'audit:unit-shard-2',
    'test/admin-refund-creation-migration.test.ts',
    'test/admin-refund-operation-migration.test.ts', 'test/shipping-create-replay-migration.test.ts',
    'test/shipping-create-replay-permissions.test.ts',
    'test/brokerage-paid-order-migration.test.ts', 'test/coupon-product-scope-migration.test.ts',
    // Reviewed coupon-template consumer regression in disposable local databases.
    'test/coupon-product-scope-fence.test.ts', 'test/order-coupon-picker.test.ts',
    'test/coupon-scope-products-postgres.test.ts', 'test/coupon-scope-search-postgres.test.ts',
    'test/coupon-wallet-filters-postgres.test.ts', 'test/pc-order-coupon-postgres.test.ts',
    'test/coupon-issue-migration.test.ts', 'test/coupon-migration.test.ts',
    'test/coupon-relationship-migration.test.ts', 'test/product-coupon-migration.test.ts',
    'test/out-coupon-migration.test.ts', 'test/newcomer-migration.test.ts',
    'test/api006-newcomer-compatibility-migration.test.ts',
    'test/v2-coupon-compatibility-migration.test.ts', 'test/out-user-migration.test.ts',
    'test/bargain-cart-participation-migration.test.ts', 'test/shipping-lifecycle-rules.test.ts',
    'test/store-order-create-scenario-postgres.test.ts',
    'test/shipping-lifecycle-interactions.test.ts', 'test/shipping-lifecycle-indexes.test.ts',
    'test/shipping-lifecycle-migration.test.ts', 'test/kefu-sequence-runner.test.ts', 'audit:orm',
    'test/invoice-issuance-permissions.test.ts',
    'test/invoice-evidence-migration.test.ts',
    'test/invoice-evidence-registration.test.ts',
    'test/refund-split-migration.test.ts',
    'test/refund-runtime-permissions.test.ts',
    'test/refund-read-generations.test.ts',
    'test/staff-refund-history.test.ts',
    'test/customer-order-generations.test.ts',
    'test/admin-order-generations.test.ts',
    'test/supplier-order-generations.test.ts',
    'test/supplier-split-order-reads.test.ts',
    'test/supplier-operational-reads.test.ts',
    'test/supplier-export-history-reads.test.ts',
    'test/checkout-member-lifecycle.test.ts',
    'test/order-member-economize.test.ts',
    'test/offline-order-quote.test.ts',
    'test/offline-order-admission.test.ts',
    'test/offline-order-balance.test.ts',
    'test/offline-order-payment-selection.test.ts',
    'test/offline-order-external-payment.test.ts',
    'test/offline-order-callback-pipeline.test.ts',
    'test/offline-order-payment-query.test.ts',
    'test/offline-order-query-recovery.test.ts',
    'test/offline-order-payment-dispatch.test.ts',
    'test/offline-order-payment-workerd.test.ts',
    'test/offline-order-http.test.ts',
    'test/admin-offline-order-read.test.ts',
    'test/offline-order-installation.test.ts',
    'test/offline-order-registration.test.ts',
    'test/offline-runtime-permissions.test.ts',
    'test/checkout-pricing-lock.test.ts',
    'test/checkout-pricing-lock-registration.test.ts',
    'test/checkout-pricing-service-runtime.test.ts',
    'test/checkout-marketing-scenarios-postgres.test.ts',
    'test/checkout-pricing-fixture.test.ts',
    // These existing checkout suites now install the real public origin protocol
    // and the existing NOLOGIN pricing owner in their own disposable databases.
    'test/finance-fixture-advisory-isolation.test.ts',
    'test/checkout-line-finance.test.ts',
    'test/checkout-coupon-template-authority.test.ts',
    'test/checkout-membership-boundary.test.ts',
    'test/checkout-brokerage-boundary.test.ts',
    'test/checkout-brokerage-authority.test.ts',
    'test/checkout-brokerage-paid-authority.test.ts',
    'test/checkout-member-evidence.test.ts',
    'test/checkout-catalog-management.test.ts',
    'test/checkout-mobile-product-concurrency.test.ts',
    'test/checkout-out-product-concurrency.test.ts',
    'test/account-cancellation-order-admission-postgres.test.ts',
    'test/seckill-concurrency-postgres.test.ts',
    'test/checkout-sku-lifecycle-concurrency.test.ts',
    'test/level-pricing-activation.test.ts',
    'test/pc-coupon-wallet-postgres.test.ts',
    'test/product-price-truncation.test.ts',
    'test/out-stock-candidate-boundary.test.ts',
    'test/checkout-pricing-config-authority.test.ts',
    // Full-ORM seckill/Admin shipping race fixture installs the lifecycle protocol.
    'test/seckill-shared-rule-concurrency-postgres.test.ts',
    'test/admin-config-batch-postgres.test.ts',
    'test/brokerage-paid-business-transactions.test.ts',
    'test/checkout-confirmation.test.ts',
    'test/checkout-confirmation-postgres.test.ts',
    'test/order-time-discount-checkout.test.ts',
    'test/admin-time-discount.test.ts',
    'test/admin-time-discount-http.test.ts',
    'test/admin-full-discount.test.ts',
    'test/admin-full-discount-http.test.ts',
    'test/order-full-discount-checkout.test.ts',
    'test/admin-nth-discount.test.ts',
    'test/admin-nth-discount-http.test.ts',
    'test/order-nth-discount-checkout.test.ts',
    'test/order-nth-discount-quote.test.ts',
    // Full-gift catalog, native checkout entitlements and strict whole refund.
    'test/admin-full-gift.test.ts',
    'test/admin-full-gift-http.test.ts',
    'test/admin-integral-batch.test.ts',
    'test/admin-integral-batch-http.test.ts',
    'test/admin-integral-batch-postgres.test.ts',
    'test/runtime-integral-batch-privileges.test.ts',
    'test/admin-sign-day-config.test.ts',
    'test/admin-shipping-settings.test.ts',
    'test/admin-shipping-settings-http.test.ts',
    'test/admin-shipping-settings-postgres.test.ts',
    'test/admin-city-delivery-records.test.ts',
    'test/admin-city-delivery-records-postgres.test.ts',
    'test/admin-city-delivery-records-http.test.ts',
    'test/admin-pc-banner.test.ts',
    'test/admin-pc-banner-postgres.test.ts',
    'test/admin-pc-banner-http.test.ts',
    'test/pc-banner-read.test.ts',
    'test/admin-fab-settings.test.ts',
    'test/admin-fab-settings-postgres.test.ts',
    'test/admin-fab-settings-http.test.ts',
    'test/fab-read-postgres.test.ts',
    'test/admin-fab-permission.test.ts',
    'test/admin-fab-link-catalog.test.ts',
    'test/admin-fab-link-catalog-postgres.test.ts',
    'test/admin-fab-link-catalog-http.test.ts',
    'test/admin-fab-integral-catalog-postgres.test.ts',
    'test/admin-fab-integral-catalog-http.test.ts',
    'test/integral-product-detail.test.ts',
    'test/integral-product-detail-postgres.test.ts',
    'test/integral-product-detail-http.test.ts',
    'test/admin-theme-settings.test.ts',
    'test/admin-theme-settings-postgres.test.ts',
    'test/admin-theme-settings-http.test.ts',
    'test/theme-style-read-postgres.test.ts',
    'test/admin-city-delivery-settings.test.ts',
    'test/admin-city-delivery-settings-postgres.test.ts',
    'test/admin-city-delivery-settings-http.test.ts',
    'test/city-delivery-settings-runtime-postgres.test.ts',
    // Complete category settings and shopping projection in a newly owned PG16 fixture.
    'test/admin-product-category-style.test.ts',
    'test/admin-product-category-style-postgres.test.ts',
    'test/admin-product-category-style-http.test.ts',
    'test/product-category-style-read-postgres.test.ts',
    'test/product-category-consumer-postgres.test.ts',

    // Complete product-detail design in the same owned, finite maintenance host.

    'test/admin-product-detail-design.test.ts',

    'test/admin-product-detail-design-postgres.test.ts',

    'test/admin-product-detail-design-http.test.ts',

    'test/product-detail-design-consumers-postgres.test.ts',

    'test/admin-user-center-design.test.ts',

    'test/admin-user-center-design-postgres.test.ts',

    'test/admin-user-center-design-http.test.ts',

    'test/user-center-design-public-postgres.test.ts',

    'test/user-center-payment-code-postgres.test.ts',
    'test/product-share-code.test.ts',
    'test/product-share-code-postgres.test.ts',
    'test/seckill-sku-catalog-postgres.test.ts',
    'test/presale-sku-catalog-postgres.test.ts',
    'test/city-delivery-callback-watermark-postgres.test.ts',
    'test/city-delivery-callback-authority-postgres.test.ts',
    'test/city-delivery-callback.test.ts',
    'test/checkout-pickup-consumers.test.ts',
    'test/checkout-shipping-settings-consumer.test.ts',
    'test/checkout-pickup-policy-postgres.test.ts',
    'test/admin-sign-day-config-http.test.ts',
    'test/admin-sign-day-config-postgres.test.ts',
    'test/runtime-sign-day-config-privileges.test.ts',
    'test/runtime-sign-day-config-upgrade.test.ts',
    'test/runtime-agent-level-upgrade.test.ts',
    'test/admin-distributor-level-postgres.test.ts',
    'test/admin-distributor-level-http.test.ts',
    'test/agent-level-consumers-postgres.test.ts',
    'test/agent-level-events-postgres.test.ts',
    'test/order-full-gift-quote.test.ts',
    'test/order-full-gift-checkout.test.ts',
    'test/order-full-gift-refund.test.ts',
    'test/order-full-gift-refund-http.test.ts',
    'test/runtime-promotion-gift-refund.test.ts',
    'test/order-promotion-gift-catalog.test.ts',
    'test/runtime-promotion-gift-privileges.test.ts',
    'test/purchase-cancellation-gift-evidence.test.ts',
    'test/admin-permission.test.ts',
    'test/modern-cart-membership-price.test.ts',
    'test/order-promotion-paid-labels.test.ts',
    'test/order-promotion-quote.test.ts',
    'test/order-promotion-split-finance.test.ts',
    'test/order-promotion-ledger-split.test.ts',
    'test/checkout-confirmation-rules.test.ts',
    // End-to-end newcomer checkout fixture installs the same NOLOGIN pricing owner.
    'test/newcomer-purchase-postgres.test.ts',
    'test/newcomer-cart-add-replay-migration-postgres.test.ts',
    'test/newcomer-cart-replay-maintenance-postgres.test.ts',
    'test/pc-checkout-form-postgres.test.ts',
    'test/pc-checkout-quote-postgres.test.ts',
    'test/brokerage-paid-runtime-permissions.test.ts',
    'test/payment-reconciliation-membership.test.ts',
    'test/checkout-coupon-item-authority.test.ts',
    'test/checkout-coupon-relations-authority.test.ts',
    'test/customer-order-deletion.test.ts',
    'audit:customer-order-browser',
    'audit:admin-refund-browser',
    'audit:admin-order-browser',
    'audit:admin-offline-browser',
      // Exact existing category consumer regressions in an owned local test cluster.
    'test/product-detail-cache-isolation.test.ts',
    'test/sku-membership-price.test.ts',
    'test/user-level-cache-authority.test.ts',
    'test/public-product-catalog-promotion-slots.test.ts',
    'test/pc-product-detail-contract.test.ts',
    'test/v2-public-diy-compatibility-migration.test.ts',
  ]);
  assert.ok(tests.every(test => allowed.has(test)), 'Schema maintenance accepts only the explicit schema/ACL suites');
}
const bin = realpathSync(resolve(binArgument));
const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = name => join(bin, `${name}${suffix}`);
for (const name of ['postgres', 'initdb', 'pg_ctl', 'psql']) assert.ok(existsSync(binary(name)), `Missing ${name}`);

function command(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: workerRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${file.split(/[\\/]/).pop()} failed (${result.error?.code ?? 'exit'}; status ${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}
const version = command(binary('postgres'), ['--version']);
assert.match(version, /PostgreSQL\) 16\./, 'Only PostgreSQL16 is accepted by finance fixtures');

// Reserve an available loopback port long enough to choose it. PostgreSQL must
// still bind successfully; a port race never authorizes connecting elsewhere.
const reservation = createServer();
await new Promise((done, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', done); });
const port = reservation.address().port;
await new Promise((done, fail) => reservation.close(error => error ? fail(error) : done()));
const cache = resolve(workerRoot, '../.cache');
mkdirSync(cache, { recursive: true });
const taskRoot = mkdtempSync(join(cache, 'finance-postgres-'));
const relativeRoot = relative(cache, taskRoot);
assert.ok(relativeRoot && !relativeRoot.startsWith('..') && !isAbsolute(relativeRoot));
if (process.platform === 'win32') {
  const owner = command('whoami.exe', ['/user', '/fo', 'csv', '/nh']).match(/S-1-\d+(?:-\d+)+/);
  assert.ok(owner, 'Cannot identify current Windows account');
  // Restrict only the newly created owned directory, never an existing parent.
  command('icacls.exe', [taskRoot, '/inheritance:r', '/grant:r', `*${owner[0]}:(OI)(CI)F`]);
}
const data = join(taskRoot, 'data');
const log = join(taskRoot, 'postgres.log');
const bootstrapPassword = randomBytes(24).toString('hex');
const testPassword = randomBytes(24).toString('hex');
const safeError = error => (error instanceof Error ? error.message : String(error))
  .replaceAll(bootstrapPassword, '[redacted]').replaceAll(testPassword, '[redacted]');
const pgEnvironment = password => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG'))),
  PGHOST: '127.0.0.1', PGPORT: String(port), PGPASSWORD: password, PGCONNECT_TIMEOUT: '5',
});
const psql = (role, database, password, statement) => command(binary('psql'),
  ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', role, '-d', database, '-At'],
  { env: pgEnvironment(password), input: statement });
let initialized = false;
let started = false;
let failed = false;
console.log(JSON.stringify({ version, host: '127.0.0.1', port, taskRoot, schemaMaintenance, tests }));
try {
  const passwordFile = join(taskRoot, 'bootstrap-password');
  try {
    writeFileSync(passwordFile, `${bootstrapPassword}\n`, { flag: 'wx', mode: 0o600 });
    command(binary('initdb'), ['-D', data, '-U', 'finance_bootstrap', '--auth=scram-sha-256',
      '--encoding=UTF8', '--locale=C', '-c', 'shared_buffers=32MB', '-c', 'max_connections=40',
      `--pwfile=${passwordFile}`], { timeout: 60_000 });
  } finally { if (existsSync(passwordFile)) unlinkSync(passwordFile); }
  initialized = true;
  // On Windows a detached postgres child can retain pg_ctl's pipe handles;
  // use its owned log file and exit status, not a pipe waiting forever for EOF.
  const startupLog = join(taskRoot, 'pg-ctl-start.log');
  const startupOutput = openSync(startupLog, 'wx', 0o600);
  try {
    command(binary('pg_ctl'), ['start', '-D', data, '-l', log, '-w', '-t', '15', '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=40 -c shared_buffers=32MB`],
      { stdio: ['ignore', startupOutput, startupOutput] });
  } catch (error) {
    throw new Error(`${safeError(error)}\n${safeError(readFileSync(startupLog, 'utf8'))}`);
  } finally { closeSync(startupOutput); }
  started = true;
  const identity = JSON.parse(psql('finance_bootstrap', 'postgres', bootstrapPassword,
    "select json_build_object('data', current_setting('data_directory'), 'version', current_setting('server_version_num'), 'host', inet_server_addr(), 'port', inet_server_port());"));
  assert.equal(realpathSync(identity.data), realpathSync(data), 'Server is not the owned cluster');
  assert.equal(Math.floor(Number(identity.version) / 10_000), 16);
  assert.equal(identity.host, '127.0.0.1');
  assert.equal(identity.port, port);
  psql('finance_bootstrap', 'postgres', bootstrapPassword,
    `CREATE ROLE finance_test WITH LOGIN CREATEDB ${schemaMaintenance ? 'SUPERUSER CREATEROLE' : 'NOSUPERUSER NOCREATEROLE'} NOREPLICATION PASSWORD '${testPassword}';\nCREATE DATABASE cinashop_finance_test OWNER finance_test;`);
  const role = JSON.parse(psql('finance_test', 'cinashop_finance_test', testPassword,
    "select json_build_object('database',current_database(),'role',current_user,'superuser',rolsuper,'createdb',rolcreatedb) from pg_roles where rolname=current_user;"));
  assert.deepEqual(role, { database: 'cinashop_finance_test', role: 'finance_test', superuser: schemaMaintenance, createdb: true });
  console.log(`FINANCE_LOCAL_IDENTITY ${JSON.stringify({ ...identity, ...role })}`);
  const unitGate = unitShard ? await import('./local-finance-unit-gate.mjs') : undefined;
  const preparedUnitGate = unitGate ? await unitGate.prepareUnitGate(workerRoot, taskRoot, unitShard) : undefined;
  if (preparedUnitGate) console.log(`FINANCE_LOCAL_UNIT_INPUT ${JSON.stringify({ shard: unitShard,
    inventoryFiles: preparedUnitGate.partition.files.length, selectedFiles: preparedUnitGate.partition.shards[unitShard - 1].length,
    inventorySha256: preparedUnitGate.partition.digest, inputFiles: preparedUnitGate.inputs.files.length, inputSha256: preparedUnitGate.inputs.sha256 })}`);
  const commandArgs = unitGate ? unitGate.unitGateArguments(unitShard, taskRoot)
    : offlineAdminBrowser ? ['node_modules/tsx/dist/cli.mjs', 'scripts/admin-offline-browser.ts']
    : browserAcceptance ? ['node_modules/vitest/vitest.mjs', 'run', '--config',
    adminOrderBrowserAcceptance ? 'vitest.admin-order-browser.config.ts' : customerBrowserAcceptance ? 'vitest.customer-order-browser.config.ts' : 'vitest.admin-refund-browser.config.ts', '--maxWorkers=1']
    : catalogAudit ? ['node_modules/tsx/dist/cli.mjs', 'scripts/orm-ddl-audit.ts']
    // These complete-schema LOGIN fixtures perform their concurrency proofs
    // with independent DB sessions. Running two fixture builders at once can
    // exhaust Windows commit memory; one Vitest worker retains those proofs.
    : ['node_modules/vitest/vitest.mjs', 'run', ...tests,
      tests.some(test => new Set([
        'test/runtime-promotion-gift-privileges.test.ts',
        'test/runtime-promotion-gift-refund.test.ts',
        'test/runtime-coupon-template-privileges.test.ts',
        'test/runtime-seckill-parent-privileges.test.ts',
        'test/runtime-seckill-schedule-lock.test.ts',
        'test/runtime-business-login.test.ts',
        'test/admin-integral-batch.test.ts',
        'test/admin-integral-batch-http.test.ts',
        'test/admin-integral-batch-postgres.test.ts',
        'test/runtime-integral-batch-privileges.test.ts',
        'test/admin-sign-day-config.test.ts',
        'test/admin-shipping-settings.test.ts',
        'test/admin-shipping-settings-http.test.ts',
        'test/admin-shipping-settings-postgres.test.ts',
        'test/admin-city-delivery-records.test.ts',
        'test/admin-city-delivery-records-postgres.test.ts',
        'test/admin-city-delivery-records-http.test.ts',
        'test/admin-pc-banner.test.ts',
        'test/admin-pc-banner-postgres.test.ts',
        'test/admin-pc-banner-http.test.ts',
        'test/pc-banner-read.test.ts',
        'test/admin-fab-settings.test.ts',
        'test/admin-fab-settings-postgres.test.ts',
        'test/admin-fab-settings-http.test.ts',
        'test/fab-read-postgres.test.ts',
        'test/admin-fab-permission.test.ts',
        'test/admin-fab-link-catalog.test.ts',
        'test/admin-fab-link-catalog-postgres.test.ts',
        'test/admin-fab-link-catalog-http.test.ts',
        'test/admin-fab-integral-catalog-postgres.test.ts',
        'test/admin-fab-integral-catalog-http.test.ts',
        'test/integral-product-detail.test.ts',
        'test/integral-product-detail-postgres.test.ts',
        'test/integral-product-detail-http.test.ts',
        'test/admin-theme-settings.test.ts',
        'test/admin-theme-settings-postgres.test.ts',
        'test/admin-theme-settings-http.test.ts',
        'test/theme-style-read-postgres.test.ts',
        'test/admin-city-delivery-settings.test.ts',
        'test/admin-city-delivery-settings-postgres.test.ts',
        'test/admin-city-delivery-settings-http.test.ts',
        'test/city-delivery-settings-runtime-postgres.test.ts',
        'test/admin-product-category-style.test.ts',
        'test/admin-product-category-style-postgres.test.ts',
        'test/admin-product-category-style-http.test.ts',
        'test/product-category-style-read-postgres.test.ts',
        'test/product-category-consumer-postgres.test.ts',

        // Complete product-detail design in the same owned, finite maintenance host.

        'test/admin-product-detail-design.test.ts',

        'test/admin-product-detail-design-postgres.test.ts',

        'test/admin-product-detail-design-http.test.ts',

        'test/product-detail-design-consumers-postgres.test.ts',

        'test/admin-user-center-design.test.ts',

        'test/admin-user-center-design-postgres.test.ts',

        'test/admin-user-center-design-http.test.ts',

        'test/user-center-design-public-postgres.test.ts',

        'test/user-center-payment-code-postgres.test.ts',
    'test/product-share-code.test.ts',
    'test/product-share-code-postgres.test.ts',
    'test/seckill-sku-catalog-postgres.test.ts',
    'test/presale-sku-catalog-postgres.test.ts',
    'test/combination-sku-catalog-postgres.test.ts',
    'test/combination-refund-policy-postgres.test.ts',
        'test/city-delivery-callback-watermark-postgres.test.ts',
        'test/city-delivery-callback-authority-postgres.test.ts',
        'test/city-delivery-callback.test.ts',
        'test/checkout-pickup-consumers.test.ts',
        'test/checkout-shipping-settings-consumer.test.ts',
        'test/checkout-pickup-policy-postgres.test.ts',
        'test/checkout-pricing-config-authority.test.ts',
        'test/pc-checkout-quote-postgres.test.ts',
        'test/bargain-pickup-postgres.test.ts',
        'test/bargain-shipping-selection-postgres.test.ts',
        'test/admin-sign-day-config-http.test.ts',
        'test/admin-sign-day-config-postgres.test.ts',
        'test/runtime-sign-day-config-privileges.test.ts',
        'test/runtime-sign-day-config-upgrade.test.ts',
        'test/runtime-agent-level-upgrade.test.ts',
        'test/admin-distributor-level-postgres.test.ts',
        'test/admin-distributor-level-http.test.ts',
        'test/agent-level-consumers-postgres.test.ts',
        'test/agent-level-events-postgres.test.ts',
          // Exact existing category consumer regressions in an owned local test cluster.
    'test/product-detail-cache-isolation.test.ts',
    'test/sku-membership-price.test.ts',
    'test/level-pricing-activation.test.ts',
    'test/membership-pricing-policy.test.ts',
    'test/product-price-truncation.test.ts',
    'test/user-level-cache-authority.test.ts',
    'test/public-product-catalog-promotion-slots.test.ts',
    'test/pc-product-detail-contract.test.ts',
    'test/v2-public-diy-compatibility-migration.test.ts',
  ]).has(test)) ? '--maxWorkers=1' : '--maxWorkers=2'];
  if (verboseTests) commandArgs.push('--reporter', 'verbose');
  if (caseNames.length) {
    const regexMeta = '\\^$.*+?()[]{}|';
    const pattern = caseNames.map(name => Array.from(name,
      char => regexMeta.includes(char) ? '\\' + char : char).join('')).join('|');
    commandArgs.push('--testNamePattern', pattern);
    console.log(`FINANCE_LOCAL_LITERAL_CASES ${JSON.stringify(caseNames)}`);
  }
  const testConnection = `postgresql://finance_test:${testPassword}@127.0.0.1:${port}/cinashop_finance_test`;
  const testRun = spawnSync(process.execPath, commandArgs, {
    cwd: workerRoot, windowsHide: true, stdio: catalogAudit ? 'pipe' : 'inherit', encoding: 'utf8',
    // These complete-schema assisted suites create two independent LOGIN
    // profiles for every case. Retain every original case and allow their full
    // files to finish; the individual SQL/HTTP lock deadlines remain bounded.
    timeout: (unitShard ? 40 : tests.some(test => new Set([
      'test/assisted-purchase-flow-postgres.test.ts',
      'test/assisted-purchase-runtime-postgres.test.ts',
    ]).has(test)) ? 20 : 10) * 60_000, maxBuffer: 32 * 1024 * 1024,
    env: unitGate ? unitGate.unitGateEnvironment(process.env, testConnection, taskRoot)
      : { ...process.env, TEST_FINANCE_POSTGRES_URL: testConnection },
  });
  if (unitGate) {
    const result = await unitGate.finishUnitGate(workerRoot, taskRoot, preparedUnitGate, testRun);
    console.log(`FINANCE_LOCAL_UNIT_RESULT ${JSON.stringify(result)}`);
    assert.equal(result.accepted, true, 'Full unit shard failed coverage, assertions or unchanged-input verification');
  }
  if (catalogAudit) {
    const output = safeError(testRun.stdout ?? '');
    // The complete report stays in the newly owned private diagnostic directory.
    writeFileSync(join(taskRoot, 'catalog-audit.log'), output + safeError(testRun.stderr ?? ''), { flag: 'wx', mode: 0o600 });
    if (!testRun.error && testRun.status === 0) {
      const summaries = output.split(/\r?\n/).filter(line => line.startsWith('ORM_DDL_AUDIT '))
        .map(line => JSON.parse(line.slice('ORM_DDL_AUDIT '.length))).filter(row => row.kind === 'summary');
      assert.equal(summaries.length, 1, 'Missing or ambiguous catalog summary');
      const report = summaries[0];
      assert.equal(report.cleanupConfirmed, true, 'Catalog audit cleanup was not confirmed');
      console.log(`FINANCE_LOCAL_CATALOG ${JSON.stringify({ serverVersionNum: report.serverVersionNum,
        paths: report.paths, counts: report.counts, summary: report.summary,
        externalInputSha256: report.externalInputSha256, generatedSqlSha256: report.generatedSqlSha256,
        adminRefundOperationVerification: report.adminRefundOperationVerification,
        adminRefundCreationVerification: report.adminRefundCreationVerification,
        invoiceEvidenceVerification: report.invoiceEvidenceVerification,
        refundSplitVerification: report.refundSplitVerification, offlineOrderVerification: report.offlineOrderVerification, checkoutPricingLockVerification: report.checkoutPricingLockVerification, cleanupConfirmed: report.cleanupConfirmed })}`);
    } else console.error(`Catalog audit failed; inspect ${join(taskRoot, 'catalog-audit.log')}`);
  }
  if (testRun.error || testRun.status !== 0) throw new Error(`Finance tests failed (${testRun.status ?? testRun.error?.code})`);
} catch (error) {
  failed = true;
  console.error(safeError(error));
} finally {
  if (started) {
    try {
      const remaining = JSON.parse(psql('finance_bootstrap', 'postgres', bootstrapPassword,
        "select coalesce(json_agg(datname),'[]'::json) from pg_database where datname not in ('postgres','template0','template1','cinashop_finance_test');"));
      assert.deepEqual(remaining, [], 'Fixture database cleanup incomplete; inspect stopped cluster');
      const remainingRoles = JSON.parse(psql('finance_bootstrap', 'postgres', bootstrapPassword,
        "select coalesce(json_agg(rolname),'[]'::json) from pg_roles where rolname not in ('finance_bootstrap','finance_test') and rolname not like 'pg_%';"));
      assert.deepEqual(remainingRoles, [], 'Fixture role cleanup incomplete; inspect stopped cluster');
      console.log('FINANCE_LOCAL_FIXTURES remaining=0');
    } catch (error) { failed = true; console.error(safeError(error)); }
  }
  // Check status even when start timed out: an observation timeout is not proof
  // that the cluster stopped. pg_ctl targets only this unique owned data dir.
  if (initialized) {
    const status = spawnSync(binary('pg_ctl'), ['status', '-D', data], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    if (status.status === 0) {
      try { command(binary('pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '15']); }
      catch (error) { failed = true; console.error(safeError(error)); }
    } else if (status.status !== 3) { failed = true; console.error('Unable to verify owned cluster status'); }
    const finalStatus = spawnSync(binary('pg_ctl'), ['status', '-D', data], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    if (finalStatus.status === 3) console.log(`FINANCE_LOCAL_STOPPED ${taskRoot}`);
    else { failed = true; console.error(`Owned cluster shutdown is unconfirmed: ${taskRoot}`); }
  }
}
process.exitCode = failed ? 1 : 0;
