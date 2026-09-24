import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const script = resolve(root, 'scripts/run-local-finance-postgres.mjs');

describe('local PostgreSQL runner command boundary', () => {
  it.each([1, 2])('admits only the complete native shard %i maintenance alias', shard => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', `audit:unit-shard-${shard}`],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT'); expect(result.stderr).not.toContain('Only explicit');
  });
  it('admits the explicit in-app Browser host without external Playwright settings',()=>{
    const result=spawnSync(process.execPath,[script,'--schema-maintenance','unused-bin','audit:admin-offline-browser'],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ENOENT');expect(result.stderr).not.toContain('TEST_BROWSER');
  });
  it.each(['bargain-cart-participation-migration', 'shipping-lifecycle-rules', 'store-order-create-scenario-postgres', 'checkout-pricing-fixture', 'checkout-marketing-scenarios-postgres', 'brokerage-paid-business-transactions', 'checkout-confirmation', 'checkout-confirmation-postgres', 'checkout-confirmation-rules', 'pc-checkout-form-postgres', 'checkout-pricing-service-runtime', 'checkout-pricing-config-authority', 'admin-config-batch-postgres', 'checkout-pricing-lock-registration', 'brokerage-paid-runtime-permissions', 'checkout-pricing-lock', 'offline-runtime-permissions', 'offline-order-registration', 'offline-order-installation', 'offline-order-payment-query', 'offline-order-query-recovery', 'offline-order-payment-dispatch', 'offline-order-payment-workerd', 'offline-order-http', 'admin-offline-order-read'])('explicitly admits %s before validating the test binary', name => {
    const result = spawnSync(process.execPath, [script, '--schema-maintenance', 'unused-bin', `test/${name}.test.ts`],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Schema maintenance accepts only'); expect(result.stderr).toContain('ENOENT');
  });
  it.each([
    { args: ['--schema-maintenance', 'audit:admin-refund-browser'] }, { args: ['--schema-maintenance', 'audit:customer-order-browser'] },
    { args: ['--schema-maintenance', 'audit:admin-order-browser'] },
  ])('rejects browser output inside the repository before opening a database: $args', ({ args }) => {
    const command = args[0] === '--schema-maintenance'
      ? [script, '--schema-maintenance', 'unused-bin', args[1]] : [script, 'unused-bin', args[0]];
    const result = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: resolve(root, 'package.json'), TEST_BROWSER_EXECUTABLE: process.execPath, TEST_BROWSER_OUTPUT_DIR: root } });
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Browser output must be outside the repository');
  });
  it.each(['invoice-evidence-migration','refund-split-migration','refund-runtime-permissions','refund-read-generations','staff-refund-history','customer-order-generations','customer-order-deletion','admin-order-generations','supplier-order-generations','supplier-split-order-reads','supplier-operational-reads','checkout-member-lifecycle','order-member-economize','offline-order-quote','offline-order-admission','offline-order-balance','offline-order-payment-selection','offline-order-external-payment','offline-order-callback-pipeline','payment-reconciliation-membership','checkout-coupon-item-authority','checkout-coupon-relations-authority'])('explicitly admits the %s suite to maintenance mode before validating its binary', name => {
    const result=spawnSync(process.execPath,[script,'--schema-maintenance','unused-bin',`test/${name}.test.ts`],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.error).toBeUndefined(); expect(result.status).not.toBe(0); expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Schema maintenance accepts only');
    expect(result.stderr).toContain('ENOENT');
  });
  it.each([
    { args: [], error: 'Usage:' },
    { args: ['unused-bin', 'audit:unit-shard-1'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-3'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-1', 'audit:unit-shard-2'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-1', '--testNamePattern=pass'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance', 'unused-bin', 'audit:unit-shard-2', 'test/price.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin', '--config=production'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin', 'test/../admin-refund-decision.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin', 'test/nonexistent-local-finance-probe.test.ts'], error: 'Test does not exist:' },
    { args: ['--schema-maintenance','unused-bin','test/admin-refund-decision.test.ts'], error: 'Schema maintenance accepts only' },
    { args: ['unused-bin','--schema-maintenance','test/admin-refund-operation-migration.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin'], error: 'Usage:' },
    { args: ['unused-bin','audit:orm'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:orm','test/admin-refund-operation-migration.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:production'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:admin-refund-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:admin-refund-browser','test/admin-refund-operation-http.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-refund-browser'], error: 'Browser acceptance requires an existing absolute TEST_BROWSER_PACKAGE_JSON' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-refund-browser','test/admin-refund-operation-http.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:customer-order-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:customer-order-browser','test/customer-order-deletion.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:customer-order-browser'], error: 'Browser acceptance requires an existing absolute TEST_BROWSER_PACKAGE_JSON' },
    { args: ['unused-bin','audit:admin-order-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['unused-bin','audit:admin-offline-browser'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-offline-browser','test/admin-offline-order-read.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-order-browser','test/admin-order-generations.test.ts'], error: 'Only explicit unit test paths are accepted' },
    { args: ['--schema-maintenance','unused-bin','audit:admin-order-browser'], error: 'Browser acceptance requires an existing absolute TEST_BROWSER_PACKAGE_JSON' },
  ])('rejects $args before runtime, port or cluster setup', ({ args, error }) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
      env: { ...process.env, TEST_BROWSER_PACKAGE_JSON: '', TEST_BROWSER_EXECUTABLE: '', TEST_BROWSER_OUTPUT_DIR: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error);
  });
  it.each(['admin-refund-operation-http','runtime-business-login','assisted-purchase-runtime-postgres','assisted-purchase-flow-postgres','admin-user-list-postgres','admin-runtime-login','presale-runtime-permissions','membership-pricing-policy','purchase-quota-refund-receipt-postgres','purchase-quota-payment-ledger-postgres','unpaid-mixed-order-cancellation-postgres','purchase-origin-evidence-postgres','purchase-origin-installation',
    'purchase-cancellation-evidence-postgres',
    'purchase-cancellation-installation',
    'finance-fixture-advisory-isolation','checkout-line-finance','checkout-coupon-template-authority','checkout-membership-boundary',
    'checkout-brokerage-boundary','checkout-brokerage-authority','checkout-brokerage-paid-authority','checkout-member-evidence',
    'checkout-catalog-management','checkout-mobile-product-concurrency','checkout-out-product-concurrency','checkout-sku-lifecycle-concurrency',
    'level-pricing-activation','pc-coupon-wallet-postgres','product-price-truncation','out-stock-candidate-boundary'])('admits the reviewed %s maintenance suite before binary validation',name=>{
    const result=spawnSync(process.execPath,[script,'--schema-maintenance','unused-bin',`test/${name}.test.ts`],
      {cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('Schema maintenance accepts only');expect(result.stderr).toContain('ENOENT');
  });
});
