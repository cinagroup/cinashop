/** Actual five-LOGIN Admin/JWT checkout and independently approved RSA/AES
 * callbacks. Positive paid/original/use rows come only from production paths.
 * Initial users/catalog and explicit policy authors are fixture maintenance;
 * phone continuity uses server-verified input, not a live phone HTTP claim.
 * Peer DML, owner changes and column renames below are restored SQL negatives.
 */
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { storeOrder, user } from '@/models/schema';
import { runRoutineRefundUpgrade } from '@/migrations/runRoutineRefundUpgrade';
import { runRoutineShippingUpgrade } from '@/migrations/runRoutineShippingUpgrade';
import { appendRoutineRefundAccountPolicy } from '@/services/payment/RoutineRefundAccountPolicy';
import { routinePaymentCredentialCommitment } from '@/services/payment/RoutineApprovedPaymentAccount';
import { appendRoutineShippingAccountPolicy, routineShippingAccountId, routineShippingCredentialCommitment } from '@/services/payment/RoutineShippingAccount';
import { WechatAuthService, type VerifiedSocialIdentity } from '@/services/wechat/WechatAuthService';
import { collectRoutineAccountContinuationDraft } from '../scripts/routine-ownership-inventory';
import { routineSubscriptionPinkFixture, PINK_ACCOUNTS, PINK_CURRENT_B, type PinkAccount } from './helpers/routineSubscriptionPinkFixture';

const transport = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const set = vi.fn(async (key: string, value: unknown) => { values.set(key, value); return true; });
  const remove = vi.fn(async (key: string) => values.delete(key));
  const take = vi.fn(async (key: string) => { const value = values.get(key) ?? null; values.delete(key); return value; });
  const setIfAbsent = vi.fn(async (key: string, value: unknown) => { if (values.has(key)) return false; values.set(key, value); return true; });
  const redis = { eval: vi.fn(async () => 1), get, set: vi.fn(async (key: string, value: unknown) => { await set(key, value); return 'OK'; }),
    del: vi.fn(async (key: string) => Number(await remove(key))) };
  return { values, get, set, remove, take, setIfAbsent, redis };
});
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(), getRedis: () => transport.redis,
  cacheGet: transport.get, cacheSet: transport.set, cacheDelete: transport.remove, cacheTake: transport.take,
  cacheSetIfAbsent: transport.setIfAbsent, setTokenBucket: vi.fn(async () => true), clearToken: vi.fn(async () => true) }));

type Fixture = Awaited<ReturnType<typeof routineSubscriptionPinkFixture>>;
type Network = ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
type Group = Awaited<ReturnType<Fixture['group']>>;
const KEY = '81'.repeat(32), SHIPPING_REF = 'account_draft_shipping_a', SHIPPING_SECRET = 'synthetic-account-draft-shipping-secret';
const quote = (name: string) => { if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(name)) throw Error('Unsafe owned name'); return '"' + name + '"'; };
const collect = (f: Fixture, client = f.maintenanceDb.$client as unknown as postgres.Sql) =>
  collectRoutineAccountContinuationDraft(client, f.target, KEY, { APP_KEY: f.env.APP_KEY });
const cacheCalls = () => [transport.get, transport.set, transport.remove, transport.take, transport.setIfAbsent, transport.redis.eval]
  .reduce((sum, method) => sum + method.mock.calls.length, 0);

async function identity(f: Fixture, network: Network, kind: PinkAccount) {
  const a = PINK_ACCOUNTS[kind]; await f.current(a.appId);
  network.mockImplementation(async input => {
    const url = new URL(String(input)); expect(url.origin).toBe('https://api.weixin.qq.com');
    expect(url.pathname).toBe('/sns/jscode2session'); expect(url.searchParams.get('appid')).toBe(a.appId);
    return Response.json({ openid: a.target, session_key: Buffer.from('0123456789abcdef').toString('base64') });
  });
  const auth = new WechatAuthService(f.app(), f.env), ticket = await auth.beginMiniProgramLogin({ code: randomUUID(), ip: '127.0.0.1' });
  const saved = transport.values.get('routine_login:' + ticket.key) as { identity?: VerifiedSocialIdentity } | undefined;
  if (!saved?.identity) throw Error('Actual code2Session ticket absent');
  expect(saved.identity.routineObservation).toMatchObject({ appId: a.appId, openid: a.target });
  // Actual reconciliation creates this prospective binding and both signed
  // records; no SQL-signed identity or preinserted target binding is used.
  expect(await auth.reconcileVerifiedIdentity({ ...saved.identity, phone: a.phone })).toBe(a.uid);
  await f.current(); network.mockReset().mockRejectedValue(Error('Unexpected provider transport'));
}
async function purposePolicies(f: Fixture) {
  const a = PINK_ACCOUNTS.a, now = Math.floor(Date.now() / 1000);
  await runRoutineRefundUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
  await runRoutineShippingUpgrade(f.maintenanceDb, f.target, f.peers, f.appReaders);
  // Separate runtime registry for shipping. The existing A/C merchant and
  // subscription registries are synthetic fixture inputs, never real secrets.
  f.env.ROUTINE_SHIPPING_ACCOUNT_CREDENTIALS = JSON.stringify({ format: 1,
    credentials: [{ ref: SHIPPING_REF, version: 1, appId: a.appId, secret: SHIPPING_SECRET }] });
  const refund = await appendRoutineRefundAccountPolicy(f.maintenanceDb, f.env, f.named(), {
    operationId: randomUUID(), expectedRevision: 0, data: { accountId: 'account_draft_refund_a', state: 'active',
      ...routinePaymentCredentialCommitment(f.env, a.ref, 1), credentialRef: a.ref, credentialVersion: 1,
      purposes: ['refund_notify', 'refund_query', 'refund_request'], validFrom: now - 60, validUntil: now + 7200 },
  });
  const shipping = await appendRoutineShippingAccountPolicy(f.maintenanceDb, f.env, f.named(), {
    operationId: randomUUID(), expectedRevision: 0, data: { accountId: routineShippingAccountId(f.env, a.appId, a.merchantId), state: 'active',
      appId: a.appId, merchantId: a.merchantId, credentialRef: SHIPPING_REF, credentialVersion: 1,
      credentialStamp: routineShippingCredentialCommitment(f.env, SHIPPING_REF, 1).credentialStamp,
      purposes: ['shipping_upload'], validFrom: now - 60, validUntil: now + 7200 },
  });
  expect(refund).toMatchObject({ revision: 1, replayed: false }); expect(shipping).toMatchObject({ revision: 1, replayed: false });
}
async function withFixture(work: (f: Fixture, group: Group, network: Network) => Promise<void>) {
  transport.values.clear();
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected provider transport'));
  let f: Fixture | undefined;
  try {
    f = await routineSubscriptionPinkFixture();
    await purposePolicies(f); await identity(f, network, 'a'); await identity(f, network, 'c');
    const group = await f.group({ mixed: true }); expect(group.second).toBeDefined();
    expect(new Set(await Promise.all([f.appRuntime, f.adminRuntime, f.financialRuntime, f.managerRuntime, f.cashierRuntime].map(peer => peer.verify()))).size).toBe(5);
    await work(f, group, network);
  } finally {
    try { await f?.close(); }
    finally { vi.restoreAllMocks(); transport.values.clear(); }
  }
}
async function sourceRows(f: Fixture) {
  const tables = ['user', 'wechat_user', 'store_order', 'store_order_refund', 'user_recharge', 'other_order', 'system_config',
    'routine_identity_ownership', 'routine_identity_witness', 'routine_original_payment_evidence', 'routine_payment_account_use',
    'routine_payment_account_policy', 'routine_refund_account_policy', 'routine_shipping_account_policy', 'routine_subscription_account_policy'];
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = await f.maintenanceDb.execute(sql.raw(`SELECT xmin::text AS version,to_jsonb(t)::text AS row FROM public.${quote(table)} t ORDER BY to_jsonb(t)::text`));
    result[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return result;
}
function redacted(f: Fixture, group: Group, report: unknown) {
  const text = JSON.stringify(report);
  for (const a of Object.values(PINK_ACCOUNTS)) for (const value of [a.appId, a.payer, a.target, a.phone, a.secret, a.aes]) expect(text).not.toContain(value);
  for (const value of [f.env.APP_KEY, KEY, SHIPPING_SECRET, f.keys.a.privateKey, f.keys.c.privateKey, 'BEGIN PRIVATE KEY',
    group.first.orderId, group.second!.orderId]) expect(text).not.toContain(value);
  for (const field of ['"buyerUid":', '"payerId":', '"openid":', '"signature":', '"providerBody":']) expect(text).not.toContain(field);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('combined account continuation on actual five-LOGIN checkout originals', () => {
  it('classifies two separately paid A/C checkout roots and independently authored purposes without issuing authority', async () => withFixture(async (f, group, network) => {
    const before = await sourceRows(f), calls = network.mock.calls.length, cached = cacheCalls(), messages = f.messages.length;
    const report = await collect(f);
    expect(report).toMatchObject({ purpose: 'routine_account_continuation_draft', activationAllowed: false, permitIssued: false, switchCommissioned: false });
    expect(report.identity).toMatchObject({ missingSources: [], counts: { owners: 2, witnesses: 2, ownerStates: { verified_anchor_live: 2 } } });
    expect(report.payments).toMatchObject({ missingSources: [], activationAllowed: false, permitIssued: false, switchCommissioned: false,
      refundRequestAuthorized: false, shippingUploadAuthorized: false, subscriptionSendAuthorized: false,
      credentials: 'not_evaluated', catalogCommissioning: 'not_evaluated', providerCurrentState: 'not_evaluated', dispatchAndResults: 'not_evaluated',
      identityAttribution: 'not_evaluated', externalSourcesIncluded: false,
      counts: { originals: 2, verifiedSuccesses: 2, invalidOriginals: 0, uses: 2, authenticatedUses: 2, invalidUses: 0, policies: 6, invalidPolicies: 0 } });
    expect(report.payments.originals).toHaveLength(2);
    for (const row of report.payments.originals) expect(row).toMatchObject({ authenticity: 'verified_success', binding: 'bound',
      local: 'paid_match', related: 'consistent', approvedUse: 'authenticated_scope_match', source: 'callback' });
    expect(new Set(report.payments.originals.map(row => row.accountDigest)).size).toBe(2);
    expect(new Set(report.payments.originals.map(row => row.buyerDigest)).size).toBe(2);
    for (const row of report.payments.uses) expect(row).toMatchObject({ authenticity: 'authenticated', scopeMatches: true, savedJournals: 'matched', policyChains: 'complete' });
    expect(report.payments.policies.filter(row => row.kind === 'account')).toHaveLength(2);
    expect(report.payments.policies.filter(row => row.kind === 'subscription')).toHaveLength(2);
    expect(report.payments.policies.find(row => row.kind === 'refund')?.purposes).toEqual(['refund_notify', 'refund_query', 'refund_request']);
    expect(report.payments.policies.find(row => row.kind === 'shipping')?.purposes).toEqual(['shipping_upload']);
    for (const row of report.payments.policies) expect(row).toMatchObject({ authenticity: 'authenticated', chain: 'complete', latest: true, state: 'active', interval: 'valid_at_snapshot' });
    expect(report.identity.inventorySourceDigest).toBe(report.inventory.sourceDigest);
    expect(report.payments.inventorySourceDigest).toBe(report.inventory.sourceDigest);
    expect(report.identity.sources).toHaveLength(4); expect(report.payments.sources).toHaveLength(9);
    expect(report.payments.unclassifiedRelationCount).toBe(report.inventory.relations.length - 9);
    expect(report.payments.unclassifiedRelationCount).toBeGreaterThan(200);
    expect(await sourceRows(f)).toEqual(before); expect(network.mock.calls).toHaveLength(calls); expect(cacheCalls()).toBe(cached); expect(f.messages).toHaveLength(messages);
    expect(group.first.paid).toBe(1); expect(group.second!.paid).toBe(1);
    const [current] = await f.maintenanceDb.execute<{ value: string }>(sql`SELECT value FROM public.system_config WHERE menu_name='routine_appId' ORDER BY sort DESC,id DESC LIMIT 1`);
    expect(JSON.parse(current.value)).toBe(PINK_CURRENT_B); redacted(f, group, report);
  }), 300000);

  it('binds both components to one RR snapshot while an independent peer changes an actual payment and user status', async () => withFixture(async (f, group, network) => {
    const calls = network.mock.calls.length, cached = cacheCalls();
    const [prior] = await f.maintenanceDb.select({ status: user.status }).from(user).where(eq(user.uid, 11));
    await f.withMaintenancePeer(async peer => {
      const client = f.maintenanceDb.$client as unknown as postgres.Sql; let changed = false;
      const observed = new Proxy(client, { get(target, property, receiver) {
        if (property !== 'begin') return Reflect.get(target, property, receiver);
        return (mode: string, action: (tx: postgres.TransactionSql) => Promise<unknown>) => client.begin(mode, tx => action(new Proxy(tx, {
          get(bound, key, innerReceiver) {
            if (key !== 'unsafe') return Reflect.get(bound, key, innerReceiver);
            return (text: string, ...args: unknown[]) => (async () => {
              const result = await Reflect.apply(bound.unsafe, bound, [text, ...args]);
              if (!changed && text.startsWith('SELECT pg_current_snapshot()')) {
                changed = true;
                // Explicit committed negative after the diagnostic snapshot;
                // no provider evidence, approval or paid success is authored.
                await peer.transaction(async tx => {
                  await tx.update(storeOrder).set({ tradeNo: 'owned_negative_after_rr' }).where(eq(storeOrder.id, group.first.id));
                  await tx.update(user).set({ status: 0 }).where(eq(user.uid, 11));
                });
              }
              return result;
            })();
          },
        })));
      } });
      try {
        const first = await collect(f, observed); expect(changed).toBe(true);
        expect(first.identity.counts.ownerStates.verified_anchor_live).toBe(2);
        expect(first.payments.originals.filter(row => row.local === 'paid_match')).toHaveLength(2);
        const mutated = await sourceRows(f), second = await collect(f);
        expect(second.identity.counts.ownerStates).toMatchObject({ verified_anchor_live: 1, verified_anchor_inactive: 1 });
        expect(second.payments.originals.filter(row => row.local === 'payment_changed')).toHaveLength(1);
        expect(second.payments.originals.filter(row => row.local === 'paid_match')).toHaveLength(1);
        expect(second.inventory.sourceDigest).not.toBe(first.inventory.sourceDigest);
        expect(second.identity.inventorySourceDigest).toBe(second.inventory.sourceDigest);
        expect(second.payments.inventorySourceDigest).toBe(second.inventory.sourceDigest);
        expect(await sourceRows(f)).toEqual(mutated); redacted(f, group, first); redacted(f, group, second);
      } finally {
        await peer.transaction(async tx => {
          await tx.update(storeOrder).set({ tradeNo: group.first.tradeNo }).where(eq(storeOrder.id, group.first.id));
          await tx.update(user).set({ status: prior.status }).where(eq(user.uid, 11));
        });
      }
    });
    expect(network.mock.calls).toHaveLength(calls); expect(cacheCalls()).toBe(cached);
  }), 300000);

  it('uses the actual policy table owner scope and refuses signed-layout drift and a real App LOGIN', async () => withFixture(async (f, group, network) => {
    const role = await f.createOwnedRole('account_scope'), before = await sourceRows(f), calls = network.mock.calls.length;
    const catalog = async () => Array.from(await f.maintenanceDb.execute(sql`SELECT c.relname,c.relowner::text,c.relacl::text,c.relnatts,
      ARRAY(SELECT a.attname::text||':'||a.attnum::text||':'||a.attisdropped::text FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
      FROM pg_catalog.pg_class c WHERE c.oid IN('public.routine_payment_account_policy'::regclass,'public.routine_shipping_account_policy'::regclass) ORDER BY c.relname`));
    const beforeCatalog = await catalog();
    try {
      await f.exec(`ALTER TABLE public.routine_payment_account_policy OWNER TO ${quote(role.role)}`);
      const report = await collect(f);
      expect(report.payments.sources.find(row => row.name === 'routine_payment_account_policy')?.owner).toBe(role.role);
      expect(report.payments.counts).toMatchObject({ verifiedSuccesses: 2, invalidPolicies: 2, authenticatedUses: 0, invalidUses: 2 });
      expect(report.payments.originals.every(row => row.authenticity === 'verified_success' && row.approvedUse === 'unresolved')).toBe(true);
      redacted(f, group, report);
    } finally { await f.exec(`ALTER TABLE public.routine_payment_account_policy OWNER TO ${quote(f.target.maintenance)}`); }
    try {
      await f.exec('ALTER TABLE public.routine_shipping_account_policy RENAME COLUMN signature TO owned_unreviewed_signature');
      await expect(collect(f)).rejects.toThrow('Routine ownership database inventory incomplete');
    } finally { await f.exec('ALTER TABLE public.routine_shipping_account_policy RENAME COLUMN owned_unreviewed_signature TO signature'); }
    await expect(collect(f, f.appRuntime.db.$client as unknown as postgres.Sql)).rejects.toThrow('Routine ownership database inventory incomplete');
    const restored = await collect(f); expect(restored.payments.counts.invalidPolicies).toBe(0); expect(restored.payments.counts.authenticatedUses).toBe(2);
    expect(await catalog()).toEqual(beforeCatalog); expect(await sourceRows(f)).toEqual(before); expect(network.mock.calls).toHaveLength(calls);
  }), 300000);
});
