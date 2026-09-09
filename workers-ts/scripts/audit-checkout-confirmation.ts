/**
 * FE-003L-A3k11c executable gap audit, NOT a passing-regression test.
 * Runs actual HTTP controllers/core against disposable in-memory SQL only.
 * Exit 1 means a required confirmation invariant remains unproven/violated.
 * No environment bindings, network, production database or payment allowed.
 */
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createPcCheckoutQuoteFixture } from '../test/helpers/pcCheckoutQuoteFixture';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { storeCart, storeProductAttrValue, shippingTemplatesRegion, userAddress,
  storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';

type Fixture = Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
type Body = Record<string, unknown>;
type Envelope = { status: number; msg?: string; data: Body | null };
type Scenario = { name: string; control?: boolean; withoutConfirm?: boolean;
  mutate?: (f: Fixture, key: string) => Promise<void>; body?: Body; replay?: boolean };

// The test helper supports dedicated PG16, but this audit intentionally cannot.
if (process.env.TEST_FINANCE_POSTGRES_URL) throw new Error('This probe requires in-memory SQL; unset TEST_FINANCE_POSTGRES_URL');
const originalFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network is forbidden in the confirmation audit'); };
const scenarios: Scenario[] = [
  { name: 'unchanged confirmation creates exactly its quoted order', control: true },
  { name: 'postage rule changed after confirmation', mutate: async f => {
    await f.db.update(shippingTemplatesRegion).set({ firstPrice: '9.00' }).where(eq(shippingTemplatesRegion.id, 1));
  } },
  { name: 'SKU price changed after confirmation', mutate: async f => {
    await f.db.update(storeProductAttrValue).set({ price: '12.00' }).where(eq(storeProductAttrValue.id, 1));
  } },
  { name: 'cart quantity changed after confirmation', mutate: async f => {
    await f.db.update(storeCart).set({ cartNum: 3 }).where(eq(storeCart.id, 1));
  } },
  { name: 'saved address content changed at the same ID', mutate: async f => {
    await f.db.update(userAddress).set({ detail: '确认后变更的隔离地址' }).where(eq(userAddress.id, 11));
  } },
  { name: 'another address submitted without a new quote', body: { cartIds: [1], addressId: 12 } },
  { name: 'another owned cart submitted with the same confirmation key', mutate: async f => {
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 1, isNew: 1, status: 1 });
  }, body: { cartIds: [2], addressId: 11 } },
  { name: 'unissued key with explicit cart IDs', withoutConfirm: true },
  { name: 'expired confirmation with explicit cart IDs', mutate: async f => { f.cache.clear(); } },
  { name: 'existing order replays after confirmation expires', control: true, replay: true },
];

const results: Body[] = [];
try {
  for (const scenario of scenarios) {
    const f = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderStatus, printDocument]);
    try {
      for (const key of Object.keys(f.config)) f.config[key] = '0';
      let sequences = 0;
      Object.assign(f.env, { SEQUENCE: { idFromName: () => 'local', get: () => ({
        fetch: async () => new Response(`confirmation_audit_${++sequences}`),
      }) } });
      f.app.post('/api/order/create/:key', orderCreate);
      const request = async (path: string, body: Body): Promise<Envelope> => {
        const response = await f.app.request(path, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
        assert.equal(response.status, 200, 'Unexpected HTTP failure must not count as a quote rejection');
        return await response.json() as Envelope;
      };
      const body = { cartIds: [1], addressId: 11, shippingType: 1 };
      const confirmed = scenario.withoutConfirm ? null : await request('/api/order/confirm', body);
      if (confirmed) assert.equal(confirmed.status, 200, 'Baseline confirmation failed');
      const key = confirmed ? String(confirmed.data?.orderKey) : 'unissued_confirmation_audit';
      assert.match(key, /^[A-Za-z0-9_-]{8,64}$/);
      const quoted = confirmed?.data?.priceGroup as Body | undefined;
      if (confirmed) assert.equal(quoted?.pay_price, '26.00');
      const cached = f.cache.get(`order:confirm:11:${key}`);
      await scenario.mutate?.(f, key);
      const before = await f.snapshot();
      const created = await request(`/api/order/create/${key}`, { ...body, ...scenario.body });
      let after = await f.snapshot();
      if (scenario.replay) {
        assert.equal(created.status, 200);
        f.cache.clear();
        await f.db.update(userAddress).set({ isDel: 1 });
        const replayBefore = await f.snapshot();
        const replay = await request(`/api/order/create/${key}`, {});
        assert.equal(replay.status, 200);
        assert.equal(replay.data?.orderId, created.data?.orderId);
        assert.deepEqual(await f.snapshot(), replayBefore);
        after = await f.snapshot();
      }
      let verdict: string;
      if (scenario.control) {
        assert.equal(created.status, 200);
        assert.equal(after.orders.length, 1);
        assert.equal(after.orders[0].payPrice, '26.00');
        verdict = 'control_passed';
      } else if (created.status === 200 && after.orders.length === 1) {
        verdict = 'gap_reproduced';
      } else if (created.status === 400 && created.data?.errorCode === 'ORDER_QUOTE_RECONFIRM_REQUIRED'
        && created.data.orderKey === key) {
        assert.deepEqual(after, before, 'Rejected quote must not change order, inventory, user, cart or bill');
        verdict = 'confirmation_invariant_passed';
      } else {
        // A SQL/auth/unknown failure cannot masquerade as a verified quote guard.
        verdict = 'unproven_rejection';
      }
      for (const order of after.orders) assert.equal(order.paid, 0, 'Audit must never pay an order');
      results.push({ scenario: scenario.name, verdict, cachedFields: cached ? Object.keys(JSON.parse(cached)).sort() : [],
        confirmedPayable: quoted?.pay_price ?? null, createStatus: created.status,
        errorCode: created.data?.errorCode ?? null, orders: after.orders.length,
        persistedPayable: after.orders[0]?.payPrice ?? null, persistedPostage: after.orders[0]?.payPostage ?? null,
        addressChanged: !!after.orders[0] && after.orders[0].userAddress !== '本地省 测试甲市 测试甲区 隔离样本一号',
        persistedQuantity: after.orders[0]?.totalNum ?? null });
    } finally { await f.close(); }
  }
  assert.equal(networkAttempts, 0);
  const gaps = results.filter(r => r.verdict === 'gap_reproduced').length;
  const unproven = results.filter(r => r.verdict === 'unproven_rejection').length;
  console.log(JSON.stringify({ audit: 'FE-003L-A3k11c', runtime: 'in-memory PGlite',
    synthetic: ['authenticated identity', 'KV', 'sequence'], productionWrites: false, networkAttempts,
    confirmationInvariantsComplete: gaps === 0 && unproven === 0, gaps, unproven, results }, null, 2));
  if (gaps || unproven) process.exitCode = 1;
} finally { globalThis.fetch = originalFetch; }
