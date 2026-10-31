/** Authenticator wire tests only. Real provider RSA/AES and database/settlement
 * acceptance live in routine-original-payment-evidence-native.test.ts. */
import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachRoutineProviderObservation, captureRoutineProviderObservation, parseRoutineProviderObservation,
  routineProviderObservationOf, type RoutineProviderFacts } from '@/services/payment/RoutineProviderObservation';

const env = { APP_KEY: 'owned-original-observation-test-key' }, now = 1800000000;
const facts = (): RoutineProviderFacts => ({ appId: 'wx_original_a', merchantId: '1900000109', orderNo: 'original_order_01',
  transactionId: 'original_transaction_01', amountCents: 1250, currency: 'CNY', tradeState: 'SUCCESS', tradeType: 'JSAPI',
  payerId: 'provider_payer_separate_from_local_uid', providerEventTime: now - 50 });
const input = () => ({ source: 'callback' as const, providerEventId: 'original_callback_01', facts: facts(),
  verifiedBody: '{"owned":"verified-provider-body"}', verifierKey: 'OWNED_PLATFORM_KEY' });
// Independent canonical/HMAC implementation. Signed malformed envelopes below
// distinguish structural rejection from a merely invalid authentication code.
const canonical = (v: unknown): string => v && typeof v === 'object'
  ? Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
    : '{' + Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, value]) => JSON.stringify(k) + ':' + canonical(value)).join(',') + '}' : JSON.stringify(v);
const mac = (domain: string, v: unknown) => createHmac('sha256', env.APP_KEY)
  .update(`cinashop.routine.original-payment.${domain}.v1\0`).update(canonical(v)).digest('hex');
const capture = () => { vi.spyOn(Date, 'now').mockReturnValue(now * 1000); return captureRoutineProviderObservation(env, input()); };
afterEach(() => vi.restoreAllMocks());

describe('Routine original provider observation authenticator', () => {
  it('authenticates exact detached facts and the digest of the verified bytes under a separate domain', () => {
    const observation = capture(), { signature, ...unsigned } = observation;
    expect(signature).toBe(mac('provider-observation', unsigned));
    expect(observation.responseDigest).toBe(createHash('sha256').update(input().verifiedBody).digest('hex'));
    expect(observation).toMatchObject({ format: 1, purpose: 'routine_provider_original', source: 'callback', verifiedAt: now });
    const parsed = parseRoutineProviderObservation(env, observation);
    parsed.facts.payerId = 'caller-mutated-copy'; expect(observation.facts.payerId).toBe(facts().payerId);
    expect(() => parseRoutineProviderObservation(env, { ...observation, signature: mac('evidence-record', unsigned) })).toThrow();
    expect(JSON.stringify(observation)).not.toContain(input().verifiedBody); expect(JSON.stringify(observation)).not.toContain(env.APP_KEY);
  });

  it.each(['appId','merchantId','orderNo','transactionId','amountCents','currency','tradeState','tradeType','payerId','providerEventTime'] as const)(
    'rejects changed provider fact %s even when all scalar callback fields look successful', field => {
      const observation = capture();
      const value = typeof observation.facts[field] === 'number' ? Number(observation.facts[field]) + 1 : 'substituted_value';
      expect(() => parseRoutineProviderObservation(env, { ...observation, facts: { ...observation.facts, [field]: value } })).toThrow();
    });

  it('does not substitute an account label, witness, initiation or PREPAY for an authenticated observation', () => {
    const observation = capture();
    for (const purpose of ['routine_code2session','routine_payment_attempt','PREPAY','current_config']) {
      const { signature: _signature, ...unsigned } = { ...observation, purpose };
      expect(() => parseRoutineProviderObservation(env, { ...unsigned, signature: mac('provider-observation', unsigned) })).toThrow();
    }
    expect(() => parseRoutineProviderObservation({ APP_KEY: 'different-server-key' }, observation)).toThrow();
    expect(() => captureRoutineProviderObservation({ APP_KEY: '' }, input())).toThrow();
  });

  it('uses stable query source identity for the same facts while retaining each actual response digest', () => {
    capture();
    const { providerEventId: _event, ...source } = input();
    const a = captureRoutineProviderObservation(env, { ...source, source: 'signed_query' });
    const b = captureRoutineProviderObservation(env, { ...source, source: 'signed_query', verifiedBody: '{"retry":true}' });
    expect(a.sourceId).toBe(mac('query-source', facts())); expect(b.sourceId).toBe(a.sourceId);
    expect(b.responseDigest).not.toBe(a.responseDigest); expect(parseRoutineProviderObservation(env, b)).toEqual(b);
    const { signature: _signature, ...wrong } = { ...b, sourceId: 'a'.repeat(64) };
    expect(() => parseRoutineProviderObservation(env, { ...wrong, signature: mac('provider-observation', wrong) })).toThrow();
  });

  it('keeps the capability frozen, request-local and absent from spreads, JSON and inherited objects', () => {
    const observation = capture(), result = attachRoutineProviderObservation({ status: 'SUCCESS' }, observation);
    observation.facts.payerId = 'later-mutation';
    expect(Object.keys(result)).toEqual(['status']); expect(JSON.stringify(result)).toBe('{"status":"SUCCESS"}');
    const proof = routineProviderObservationOf(result);
    expect(proof).toMatchObject({ facts: facts() }); expect(Object.isFrozen(proof)).toBe(true);
    expect(routineProviderObservationOf({ ...result })).toBeUndefined();
    expect(routineProviderObservationOf(Object.create(result))).toBeUndefined();
    expect(routineProviderObservationOf(JSON.parse(JSON.stringify(result)))).toBeUndefined();
    expect(() => attachRoutineProviderObservation(result, observation)).toThrow();
  });

  it('rejects accessors, symbols, extra fields and coercible source objects without invoking them', () => {
    const observation = capture(), invoked = vi.fn(() => 'callback');
    const getter = { ...observation }; Object.defineProperty(getter, 'source', { enumerable: true, get: invoked });
    for (const bad of [getter, { ...observation, source: { toString: invoked } }, { ...observation, [Symbol('extra')]: 1 },
      { ...observation, rawBody: 'must-not-be-stored' }, { ...observation, facts: { ...facts(), secret: 'must-not-be-stored' } }])
      expect(() => parseRoutineProviderObservation(env, bad)).toThrow('routine_provider_observation_invalid');
    expect(invoked).not.toHaveBeenCalled();
  });

  it.each([{ payerId: '' }, { payerId: 'x'.repeat(129) }, { amountCents: 0 }, { amountCents: 2147483648 },
    { tradeType: 'APP' }, { tradeState: 'NOTPAY' }, { providerEventTime: 0 }, { currency: 'USD' }])(
    'refuses incomplete or non-Mini-success provider facts %# before authentication', extra => {
      expect(() => captureRoutineProviderObservation(env, { ...input(), facts: { ...facts(), ...extra } as RoutineProviderFacts })).toThrow();
    });
});
