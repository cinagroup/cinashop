import { timingSafeEqual } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import firstOrder from './integration/FirstOrderDiscountAuditWorker';
import packages from './integration/DiscountPackageAuditWorker';
import paymentCancel from './integration/StoreOrderPaymentCancelAuditWorker';
import afterSale from './integration/ApiOrderAfterSaleAuditWorker';
import { requireCheckoutScenarioPricingOwner } from './integration/CheckoutScenarioPricing';

const mocks = vi.hoisted(() => ({ db: vi.fn(), end: vi.fn(), query: vi.fn(),
  first: vi.fn(), package: vi.fn(), create: vi.fn(), payment: vi.fn(), refund: vi.fn() }));
vi.mock('@/lib/di', () => ({ createDbFromConnectionString: mocks.db, createContainerFromDb: vi.fn() }));
vi.mock('@/services/MigrationService', () => ({ MigrationService: vi.fn() }));
vi.mock('./integration/FirstOrderDiscountPostgresScenario', () => ({ runFirstOrderDiscountPostgresScenario: mocks.first }));
vi.mock('./integration/DiscountPackagePostgresScenario', () => ({ runDiscountPackagePostgresScenario: mocks.package }));
vi.mock('./integration/StoreOrderCreatePostgresScenario', () => ({ runStoreOrderCreatePostgresScenario: mocks.create }));
vi.mock('./integration/StoreOrderPaymentCancelPostgresScenario', () => ({ runStoreOrderPaymentCancelPostgresScenario: mocks.payment }));
vi.mock('./integration/StoreOrderRefundPostgresScenario', () => ({ runStoreOrderRefundPostgresScenario: mocks.refund }));

const token = 'local-synthetic-audit-token';
const owner = 'isolated_pricing_owner';
const url = 'postgresql://synthetic.invalid/not-a-real-database';
let env: Parameters<typeof firstOrder.fetch>[1];
beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
  // Node adapter only: workerd keeps its own native Web Crypto implementation.
  // Both environments use real SHA-256 and constant-time byte comparison.
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  if (typeof crypto.subtle.timingSafeEqual !== 'function') {
    vi.stubGlobal('crypto', { subtle: { digest,
      timingSafeEqual: (left: ArrayBuffer, right: ArrayBuffer) => timingSafeEqual(new Uint8Array(left), new Uint8Array(right)),
    }, randomUUID: crypto.randomUUID.bind(crypto) });
  }
  const hash = await digest('SHA-256', new TextEncoder().encode(token));
  env = { HYPERDRIVE: { connectionString: url } as Hyperdrive,
    AUDIT_TOKEN_SHA256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  mocks.query.mockResolvedValue([]); mocks.end.mockResolvedValue(undefined);
  mocks.db.mockReturnValue({ $client: Object.assign(mocks.query, { end: mocks.end }) });
  for (const name of ['first', 'package', 'create', 'payment', 'refund'] as const)
    mocks[name].mockResolvedValue({ verified: name });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const entries = [
  { name: 'first-order', handler: firstOrder, path: '/run', scenario: 'first' },
  { name: 'package', handler: packages, path: '/run', scenario: 'package' },
  { name: 'payment/cancel', handler: paymentCancel, path: '/run', scenario: 'create' },
  { name: 'after-sale', handler: afterSale, path: '/isolated', scenario: 'create' },
] as const;

describe.each(entries)('$name audit maintenance owner boundary (mocked SQL/scenarios)', ({ handler, path, scenario }) => {
  const request = (value?: string, credential = token, method = 'POST') => new Request(`https://audit.invalid${path}`, {
    method, headers: { 'X-Audit-Token': credential, ...(value === undefined ? {} : { 'X-Audit-Pricing-Owner': value }) },
  });
  const noSql = () => {
    expect(mocks.db).not.toHaveBeenCalled();
    for (const name of ['first', 'package', 'create', 'payment', 'refund'] as const) expect(mocks[name]).not.toHaveBeenCalled();
  };
  it('rejects a missing owner before reading public or opening any scenario', async () => {
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Checkout scenario requires an explicit clone pricing owner' });
    noSql();
  });
  it.each(['pg_catalog', 'public,pg_temp', 'owner;DROP ROLE other'])('rejects unsafe owner %s before SQL', async value => {
    const response = await handler.fetch(request(value), env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Invalid explicit pricing capability identifier' });
    noSql();
  });
  it('retains authentication and method checks before owner validation', async () => {
    expect((await handler.fetch(request(owner, 'wrong-token'), env)).status).toBe(403);
    expect((await handler.fetch(request(owner, token, 'GET'), env)).status).toBe(404);
    noSql();
  });
  it('passes exactly the explicit owner and existing Hyperdrive connection to the scenario', async () => {
    const response = await handler.fetch(request(owner), env);
    expect(response.status).toBe(200);
    expect(mocks[scenario]).toHaveBeenCalledExactlyOnceWith(url, owner);
    expect(mocks.end).toHaveBeenCalledTimes(scenario === 'create' ? 0 : 1);
  });
  it('does not run later payment/refund scenarios after pricing scenario refusal', async () => {
    mocks[scenario].mockRejectedValue(Error('Pricing capability owner must be a separate restricted NOLOGIN role'));
    expect((await handler.fetch(request(owner), env)).status).toBe(500);
    expect(mocks.payment).not.toHaveBeenCalled(); expect(mocks.refund).not.toHaveBeenCalled();
  });
});

it('accepts only an exact safe identifier; syntax alone never asserts catalog trust', () => {
  expect(requireCheckoutScenarioPricingOwner(owner)).toBe(owner);
  for (const value of [undefined, null, '']) expect(() => requireCheckoutScenarioPricingOwner(value)).toThrow('explicit clone pricing owner');
  for (const value of ['Owner', ' owner ', '"owner"', 'a'.repeat(64), 'information_schema'])
    expect(() => requireCheckoutScenarioPricingOwner(value)).toThrow('Invalid explicit pricing capability identifier');
});
