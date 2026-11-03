/** Synthetic independently calculated legacy-v1 vectors only. No provider,
 * database row, current policy, payment or operational authority is created. */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '../src/utils/errors';
import { parseRoutineProviderObservation, type RoutineProviderObservation } from '../src/services/payment/RoutineProviderObservation';
import { parseRoutineOriginalEvidence, parseRoutineOriginalBinding, type RoutineOriginalEvidence } from '../src/services/payment/RoutineOriginalPaymentEvidenceCodec';
import { parseRoutineApprovedAccountJournal, parseRoutineApprovedAuthorization, parseRoutineApprovedUse,
  validateRoutineApprovedAccountHistory, type RoutineApprovedScope, type RoutineApprovedAccountJournal,
  type RoutineApprovedAuthorization, type RoutineApprovedUse, type RoutineAccountQueryPlan } from '../src/services/payment/RoutineApprovedPaymentEvidenceCodec';
import { parseRoutineRefundAccountJournal, parseRoutineShippingAccountJournal, parseRoutineSubscriptionAccountJournal,
  validateRoutineRefundAccountHistory, validateRoutineShippingAccountHistory, validateRoutineSubscriptionAccountHistory,
  type RoutineRefundAccountJournal, type RoutineShippingAccountJournal, type RoutineSubscriptionAccountJournal } from '../src/services/payment/RoutinePurposeAccountEvidenceCodec';

const env = { APP_KEY: 'synthetic-payment-codec-legacy-key' };
const vectors = JSON.parse("{\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"observation\":{\"format\":1,\"purpose\":\"routine_provider_original\",\"source\":\"callback\",\"sourceId\":\"codec_provider_event\",\"facts\":{\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"orderNo\":\"codec_original_order\",\"transactionId\":\"codec_transaction\",\"amountCents\":1250,\"currency\":\"CNY\",\"tradeState\":\"SUCCESS\",\"tradeType\":\"JSAPI\",\"payerId\":\"codec_distinct_payer\",\"providerEventTime\":1700000000},\"verifiedAt\":1700000001,\"verifierKey\":\"codec_platform_key\",\"responseDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"signature\":\"401392899279366ba84973dbc0bdabe7de2425ab7275d20f7db4c5b86f7918bb\"},\"original\":{\"evidence_id\":\"4a82c1d7eace53b47b3b68fefb179ebb023528faf28df6ade88e6352bddb8296\",\"order_no\":\"codec_original_order\",\"transaction_id\":\"codec_transaction\",\"source\":\"callback\",\"source_id\":\"codec_provider_event\",\"format_version\":1,\"payload\":{\"format\":1,\"binding\":{\"state\":\"bound\",\"local\":{\"domain\":\"recharge\",\"orderId\":41,\"buyerUid\":11,\"orderNo\":\"codec_original_order\",\"amountCents\":1250,\"paid\":0,\"payType\":\"\",\"tradeNo\":\"\"}},\"sourceDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"observation\":{\"format\":1,\"purpose\":\"routine_provider_original\",\"source\":\"callback\",\"sourceId\":\"codec_provider_event\",\"facts\":{\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"orderNo\":\"codec_original_order\",\"transactionId\":\"codec_transaction\",\"amountCents\":1250,\"currency\":\"CNY\",\"tradeState\":\"SUCCESS\",\"tradeType\":\"JSAPI\",\"payerId\":\"codec_distinct_payer\",\"providerEventTime\":1700000000},\"verifiedAt\":1700000001,\"verifierKey\":\"codec_platform_key\",\"responseDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"signature\":\"401392899279366ba84973dbc0bdabe7de2425ab7275d20f7db4c5b86f7918bb\"}},\"created_at\":1700000002,\"signature\":\"71aa0fae2ec7a93456471ebbd5082e489b69f4aa803a78802904e2c3f16a1cc0\"},\"account\":{\"record_id\":\"11111111-2222-4333-8444-555555555555\",\"kind\":\"account\",\"subject_id\":\"codec_account\",\"revision\":1,\"payload\":{\"format\":1,\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"previousRecordId\":\"\",\"data\":{\"accountId\":\"codec_account\",\"state\":\"active\",\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"credentialRef\":\"codec_archived_merchant\",\"credentialVersion\":1,\"credentialStamp\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"purposes\":[\"notify\",\"query\"],\"validFrom\":1699999940,\"validUntil\":1700003600}},\"created_at\":1700000000,\"signature\":\"41f051902d1eb9305860ef6225358dfbfb338e818b0e8a0f4b39354cba72bdd7\"},\"query\":{\"record_id\":\"22222222-2222-4333-8444-555555555555\",\"kind\":\"query\",\"subject_id\":\"c3174d86a692e65e543c98865114af71e86b5e181299db186ee64308eb9feb55\",\"revision\":1,\"payload\":{\"format\":1,\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"previousRecordId\":\"\",\"data\":{\"state\":\"active\",\"accountId\":\"codec_account\",\"accountRevision\":1,\"request\":{\"provider\":\"wechat\",\"profile\":\"routine\",\"orderDomain\":\"recharge\",\"orderNo\":\"codec_original_order\",\"expectedAmountCents\":1250,\"currency\":\"CNY\"},\"validFrom\":1699999940,\"validUntil\":1700001800}},\"created_at\":1700000000,\"signature\":\"2f33c577ce1b819367922d086a75bc1177da293ea2a4c74de72138d6f360a2d3\"},\"authorization\":{\"format\":1,\"purpose\":\"routine_approved_provider\",\"account\":{\"record_id\":\"11111111-2222-4333-8444-555555555555\",\"kind\":\"account\",\"subject_id\":\"codec_account\",\"revision\":1,\"payload\":{\"format\":1,\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"previousRecordId\":\"\",\"data\":{\"accountId\":\"codec_account\",\"state\":\"active\",\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"credentialRef\":\"codec_archived_merchant\",\"credentialVersion\":1,\"credentialStamp\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"purposes\":[\"notify\",\"query\"],\"validFrom\":1699999940,\"validUntil\":1700003600}},\"created_at\":1700000000,\"signature\":\"41f051902d1eb9305860ef6225358dfbfb338e818b0e8a0f4b39354cba72bdd7\"},\"query\":null,\"observation\":{\"format\":1,\"purpose\":\"routine_provider_original\",\"source\":\"callback\",\"sourceId\":\"codec_provider_event\",\"facts\":{\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"orderNo\":\"codec_original_order\",\"transactionId\":\"codec_transaction\",\"amountCents\":1250,\"currency\":\"CNY\",\"tradeState\":\"SUCCESS\",\"tradeType\":\"JSAPI\",\"payerId\":\"codec_distinct_payer\",\"providerEventTime\":1700000000},\"verifiedAt\":1700000001,\"verifierKey\":\"codec_platform_key\",\"responseDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"signature\":\"401392899279366ba84973dbc0bdabe7de2425ab7275d20f7db4c5b86f7918bb\"},\"issuedAt\":1700000002,\"signature\":\"e56ed0f4e4ce3c6ee466d8f8873aab15b5112c4fd25eb081e421c9f5b3b99303\"},\"use\":{\"use_id\":\"27851bcf95a52d53ad779092ee603e1ad6956dd1af7788c881b42ec17eedf676\",\"evidence_id\":\"4a82c1d7eace53b47b3b68fefb179ebb023528faf28df6ade88e6352bddb8296\",\"payload\":{\"format\":1,\"evidenceSignature\":\"71aa0fae2ec7a93456471ebbd5082e489b69f4aa803a78802904e2c3f16a1cc0\",\"scopeMatches\":true,\"authorization\":{\"format\":1,\"purpose\":\"routine_approved_provider\",\"account\":{\"record_id\":\"11111111-2222-4333-8444-555555555555\",\"kind\":\"account\",\"subject_id\":\"codec_account\",\"revision\":1,\"payload\":{\"format\":1,\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"previousRecordId\":\"\",\"data\":{\"accountId\":\"codec_account\",\"state\":\"active\",\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"credentialRef\":\"codec_archived_merchant\",\"credentialVersion\":1,\"credentialStamp\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"purposes\":[\"notify\",\"query\"],\"validFrom\":1699999940,\"validUntil\":1700003600}},\"created_at\":1700000000,\"signature\":\"41f051902d1eb9305860ef6225358dfbfb338e818b0e8a0f4b39354cba72bdd7\"},\"query\":null,\"observation\":{\"format\":1,\"purpose\":\"routine_provider_original\",\"source\":\"callback\",\"sourceId\":\"codec_provider_event\",\"facts\":{\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"orderNo\":\"codec_original_order\",\"transactionId\":\"codec_transaction\",\"amountCents\":1250,\"currency\":\"CNY\",\"tradeState\":\"SUCCESS\",\"tradeType\":\"JSAPI\",\"payerId\":\"codec_distinct_payer\",\"providerEventTime\":1700000000},\"verifiedAt\":1700000001,\"verifierKey\":\"codec_platform_key\",\"responseDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"signature\":\"401392899279366ba84973dbc0bdabe7de2425ab7275d20f7db4c5b86f7918bb\"},\"issuedAt\":1700000002,\"signature\":\"e56ed0f4e4ce3c6ee466d8f8873aab15b5112c4fd25eb081e421c9f5b3b99303\"}},\"created_at\":1700000003,\"signature\":\"94bd9af81bab9f2af707e4df3e54cc47cb6fbc86eb7053554b048b5c76ba58e1\"},\"refund\":{\"record_id\":\"33333333-2222-4333-8444-555555555555\",\"account_id\":\"codec_refund_account\",\"revision\":1,\"payload\":{\"format\":1,\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"previousRecordId\":\"\",\"data\":{\"accountId\":\"codec_refund_account\",\"state\":\"active\",\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"credentialRef\":\"codec_archived_merchant\",\"credentialVersion\":1,\"credentialStamp\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"purposes\":[\"refund_notify\",\"refund_query\",\"refund_request\"],\"validFrom\":1699999940,\"validUntil\":1700003600},\"purpose\":\"routine_refund_account\"},\"created_at\":1700000000,\"signature\":\"ce6106afc627af171bc4c8758ad9972dbda876de3e5c552293eedc155b3af5f3\"},\"shipping\":{\"record_id\":\"44444444-2222-4333-8444-555555555555\",\"account_id\":\"d661f29bd24e0e12ea7a76ea4ea1bf4536e58afe5ccd7661a2a7d2fef6d82782\",\"revision\":1,\"payload\":{\"format\":1,\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"previousRecordId\":\"\",\"data\":{\"accountId\":\"d661f29bd24e0e12ea7a76ea4ea1bf4536e58afe5ccd7661a2a7d2fef6d82782\",\"state\":\"active\",\"appId\":\"wx_codec_old_a\",\"merchantId\":\"1234567890\",\"credentialRef\":\"codec_archived_merchant\",\"credentialVersion\":1,\"credentialStamp\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"purposes\":[\"shipping_upload\"],\"validFrom\":1699999940,\"validUntil\":1700003600}},\"created_at\":1700000000,\"signature\":\"2ed45cb3beeea7ee2a03646613ab166c6bacc552232b75bcdc20a4e0e4f24eb8\"},\"subscription\":{\"record_id\":\"55555555-2222-4333-8444-555555555555\",\"account_id\":\"7f80e4982d00ecd73f61256a2fa9c10c0abc443025a8429873c04df1855375db\",\"revision\":1,\"payload\":{\"format\":1,\"scope\":{\"database\":\"finance_fixture_codec\",\"databaseOid\":\"41000\",\"maintenance\":\"finance_test\",\"maintenanceOid\":\"10\"},\"previousRecordId\":\"\",\"data\":{\"accountId\":\"7f80e4982d00ecd73f61256a2fa9c10c0abc443025a8429873c04df1855375db\",\"state\":\"active\",\"appId\":\"wx_codec_old_a\",\"credentialRef\":\"codec_archived_merchant\",\"credentialVersion\":1,\"credentialStamp\":\"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\",\"purposes\":[\"subscription_send\"],\"validFrom\":1699999940,\"validUntil\":1700003600,\"templates\":[{\"mark\":\"3098\",\"templateId\":\"codec_template_3098\"}]}},\"created_at\":1700000000,\"signature\":\"4492d46b02f7876e6458c6dbfc4582c9d52ed7196e14569196e43d397325bcd2\"}}") as {
  scope: RoutineApprovedScope; observation: RoutineProviderObservation; original: RoutineOriginalEvidence;
  account: RoutineApprovedAccountJournal; query: RoutineApprovedAccountJournal;
  authorization: RoutineApprovedAuthorization; use: RoutineApprovedUse;
  refund: RoutineRefundAccountJournal; shipping: RoutineShippingAccountJournal; subscription: RoutineSubscriptionAccountJournal;
};
// Reference recipes duplicate the pre-extraction wire contract only for varied
// authenticated counterexamples. Fixed vectors were generated independently in
// Python; no expected signature is computed using the implementation under test.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
}
function legacyMac(domain: string, value: unknown): string {
  return createHmac('sha256', env.APP_KEY).update('cinashop.routine.original-payment.' + domain + '.v1\0').update(canonical(value)).digest('hex');
}
function resign<T extends object>(domain: string, value: T): T & { signature: string } {
  const body = { ...value }; delete (body as Record<string, unknown>).signature;
  return { ...body, signature: legacyMac(domain, body) };
}
const clone = <T>(value: T): T => structuredClone(value);
function queryProof(domain: 'store_order' | 'recharge' = 'recharge') {
  const observation = resign('provider-observation', { ...clone(vectors.observation), source: 'signed_query' as const,
    sourceId: legacyMac('query-source', vectors.observation.facts) });
  const original = resign('evidence-record', { ...clone(vectors.original), source: 'signed_query' as const,
    source_id: observation.sourceId, evidence_id: legacyMac('evidence-key', ['signed_query', observation.sourceId]),
    payload: { ...clone(vectors.original.payload), observation } });
  const data = clone(vectors.query.payload.data) as RoutineAccountQueryPlan;
  data.request.orderDomain = domain;
  const query = resign('approved-account-policy', { ...clone(vectors.query), payload: { ...clone(vectors.query.payload), data } });
  const authorization = resign('approved-account-authorization', { ...clone(vectors.authorization), observation, query });
  const use = resign('approved-account-use-record', { ...clone(vectors.use), evidence_id: original.evidence_id,
    use_id: legacyMac('approved-account-use-key', [original.evidence_id, vectors.account.record_id, query.record_id]),
    payload: { ...clone(vectors.use.payload), evidenceSignature: original.signature, authorization, scopeMatches: domain === 'recharge' } });
  return { observation, original, query, authorization, use };
}
const journals = [
  { name: 'payment account', row: () => clone(vectors.account), parse: (row: unknown) => parseRoutineApprovedAccountJournal(env, row, vectors.scope) },
  { name: 'refund', row: () => clone(vectors.refund), parse: (row: unknown) => parseRoutineRefundAccountJournal(env, row, vectors.scope) },
  { name: 'shipping', row: () => clone(vectors.shipping), parse: (row: unknown) => parseRoutineShippingAccountJournal(env, row, vectors.scope) },
  { name: 'subscription', row: () => clone(vectors.subscription), parse: (row: unknown) => parseRoutineSubscriptionAccountJournal(env, row, vectors.scope) },
];
const chains = [
  { name: 'approved', row: vectors.account, tag: 'approved-account-policy', validate: (rows: unknown[]) =>
    validateRoutineApprovedAccountHistory(rows.map(row => parseRoutineApprovedAccountJournal(env, row, vectors.scope)), 'account', vectors.account.subject_id) },
  { name: 'refund', row: vectors.refund, tag: 'routine-refund-account-policy-v1', validate: (rows: unknown[]) =>
    validateRoutineRefundAccountHistory(rows.map(row => parseRoutineRefundAccountJournal(env, row, vectors.scope)), vectors.refund.account_id) },
  { name: 'shipping', row: vectors.shipping, tag: 'shipping-account-policy', validate: (rows: unknown[]) =>
    validateRoutineShippingAccountHistory(rows.map(row => parseRoutineShippingAccountJournal(env, row, vectors.scope)), vectors.shipping.account_id) },
  { name: 'subscription', row: vectors.subscription, tag: 'subscription-account-policy', validate: (rows: unknown[]) =>
    validateRoutineSubscriptionAccountHistory(rows.map(row => parseRoutineSubscriptionAccountJournal(env, row, vectors.scope)), vectors.subscription.account_id) },
];

describe('mechanically extracted durable payment evidence codecs', () => {
  afterEach(() => vi.restoreAllMocks());
  it('authenticates fixed provider and original record signatures in their existing byte domains', () => {
    expect(vectors.observation.signature).toBe('401392899279366ba84973dbc0bdabe7de2425ab7275d20f7db4c5b86f7918bb');
    expect(vectors.original.signature).toBe('71aa0fae2ec7a93456471ebbd5082e489b69f4aa803a78802904e2c3f16a1cc0');
    expect(parseRoutineProviderObservation(env, vectors.observation)).toEqual(vectors.observation);
    expect(parseRoutineOriginalEvidence(env, vectors.original)).toEqual(vectors.original);
  });
  it('accepts a captured unpaid binding and all four genuine unresolved binding reasons', () => {
    expect(parseRoutineOriginalEvidence(env, vectors.original).payload.binding).toMatchObject({ state: 'bound', local: { paid: 0 } });
    for (const reason of ['order_missing','order_ambiguous','unsupported_order_type','local_order_invalid'])
      expect(parseRoutineOriginalBinding({ state: 'unresolved', reason })).toEqual({ state: 'unresolved', reason });
  });
  it('keeps exact old error names for invalid bindings, original records and signatures', () => {
    expect(() => parseRoutineOriginalBinding({ state: 'unresolved', reason: 'other' })).toThrow('routine_original_binding_invalid');
    expect(() => parseRoutineOriginalEvidence(env, { ...vectors.original, extra: true })).toThrow('routine_original_record_invalid');
    expect(() => parseRoutineOriginalEvidence(env, { ...vectors.original, signature: '0'.repeat(64) })).toThrow('routine_original_signature_invalid');
  });
  it('retains historical provider/original/authorization/use after the current time moves beyond their admission windows', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2000000000000);
    expect(parseRoutineOriginalEvidence(env, vectors.original)).toEqual(vectors.original);
    expect(parseRoutineApprovedAuthorization(env, vectors.authorization, vectors.scope)).toEqual(vectors.authorization);
    expect(parseRoutineApprovedUse(env, vectors.use, vectors.scope, vectors.original)).toEqual(vectors.use);
  });
  it('authenticates the fixed account, query, authorization and immutable use vectors', () => {
    expect(vectors.account.signature).toBe('41f051902d1eb9305860ef6225358dfbfb338e818b0e8a0f4b39354cba72bdd7');
    expect(vectors.query.signature).toBe('2f33c577ce1b819367922d086a75bc1177da293ea2a4c74de72138d6f360a2d3');
    expect(vectors.authorization.signature).toBe('e56ed0f4e4ce3c6ee466d8f8873aab15b5112c4fd25eb081e421c9f5b3b99303');
    expect(vectors.use.signature).toBe('94bd9af81bab9f2af707e4df3e54cc47cb6fbc86eb7053554b048b5c76ba58e1');
    expect(parseRoutineApprovedAccountJournal(env, vectors.account, vectors.scope)).toEqual(vectors.account);
    expect(parseRoutineApprovedAccountJournal(env, vectors.query, vectors.scope)).toEqual(vectors.query);
    expect(parseRoutineApprovedAuthorization(env, vectors.authorization, vectors.scope)).toEqual(vectors.authorization);
    expect(parseRoutineApprovedUse(env, vectors.use, vectors.scope, vectors.original)).toEqual(vectors.use);
  });
  it('uses the actual supplied database and owner scope rather than trusting the signed row scope', () => {
    for (const field of ['database','databaseOid','maintenance','maintenanceOid']) {
      const other = { ...vectors.scope, [field]: 'different_scope' };
      expect(() => parseRoutineApprovedAccountJournal(env, vectors.account, other)).toThrow(ServiceUnavailableException);
      expect(() => parseRoutineRefundAccountJournal(env, vectors.refund, other)).toThrow(ServiceUnavailableException);
      expect(() => parseRoutineShippingAccountJournal(env, vectors.shipping, other)).toThrow(ServiceUnavailableException);
      expect(() => parseRoutineSubscriptionAccountJournal(env, vectors.subscription, other)).toThrow(ServiceUnavailableException);
    }
  });
  it('preserves decimal-string PG timestamps and order-independent JSON object canonicalization', () => {
    const row = { ...vectors.original, created_at: String(vectors.original.created_at) };
    const reversed = Object.fromEntries(Object.entries(row).reverse());
    expect(parseRoutineOriginalEvidence(env, reversed)).toEqual(vectors.original);
    for (const entry of journals) expect(entry.parse({ ...entry.row(), created_at: String(entry.row().created_at) })).toEqual(entry.parse(entry.row()));
  });
  it('keeps original identity and immutable record MAC as independent checks', () => {
    const changed = resign('evidence-record', { ...clone(vectors.original), evidence_id: '0'.repeat(64) });
    expect(() => parseRoutineOriginalEvidence(env, changed)).toThrow('routine_original_record_invalid');
  });
  it('authenticates signed-query provenance and a matching exact query revision', () => {
    const p = queryProof();
    expect(parseRoutineProviderObservation(env, p.observation)).toEqual(p.observation);
    expect(parseRoutineApprovedAuthorization(env, p.authorization, vectors.scope)).toEqual(p.authorization);
    expect(parseRoutineApprovedUse(env, p.use, vectors.scope, p.original).payload.scopeMatches).toBe(true);
  });
  it('preserves a genuine non-authorizing scopeMatches=false sidecar instead of relabeling it as corruption', () => {
    const p = queryProof('store_order');
    expect(parseRoutineApprovedUse(env, p.use, vectors.scope, p.original).payload.scopeMatches).toBe(false);
    expect(() => parseRoutineApprovedUse(env, resign('approved-account-use-record', { ...p.use,
      payload: { ...p.use.payload, scopeMatches: true } }), vectors.scope, p.original)).toThrow(ServiceUnavailableException);
  });
  it('retains reverification metadata without rewriting the immutable first original', () => {
    const observation = resign('provider-observation', { ...clone(vectors.observation), verifiedAt: vectors.observation.verifiedAt + 20, responseDigest: 'd'.repeat(64) });
    const authorization = resign('approved-account-authorization', { ...clone(vectors.authorization), observation });
    const use = resign('approved-account-use-record', { ...clone(vectors.use), payload: { ...clone(vectors.use.payload), authorization } });
    expect(parseRoutineApprovedUse(env, use, vectors.scope, vectors.original).payload.authorization.observation.verifiedAt).toBe(observation.verifiedAt);
    expect(vectors.original.payload.observation.verifiedAt).not.toBe(observation.verifiedAt);
  });
  it.each([-60, 900])('accepts the original approved-use relative creation bound %i', offset => {
    const row = resign('approved-account-use-record', { ...clone(vectors.use), created_at: vectors.authorization.issuedAt + offset });
    expect(parseRoutineApprovedUse(env, row, vectors.scope, vectors.original).created_at).toBe(row.created_at);
  });
  it.each([-61, 901])('rejects an authenticated approved-use creation outside the original bound %i', offset => {
    const row = resign('approved-account-use-record', { ...clone(vectors.use), created_at: vectors.authorization.issuedAt + offset });
    expect(() => parseRoutineApprovedUse(env, row, vectors.scope, vectors.original)).toThrow(ServiceUnavailableException);
  });
  it('rejects an account revoked at issuance without querying any latest registry', () => {
    const data = { ...clone(vectors.account.payload.data), state: 'revoked' as const };
    const account = resign('approved-account-policy', { ...clone(vectors.account), payload: { ...clone(vectors.account.payload), data } });
    const authorization = resign('approved-account-authorization', { ...clone(vectors.authorization), account });
    expect(() => parseRoutineApprovedAuthorization(env, authorization, vectors.scope)).toThrow(ServiceUnavailableException);
  });
  it('does not admit an authorization outside the historical account interval', () => {
    const a = resign('approved-account-authorization', { ...clone(vectors.authorization), issuedAt: vectors.account.payload.data.validUntil });
    expect(() => parseRoutineApprovedAuthorization(env, a, vectors.scope)).toThrow(ServiceUnavailableException);
  });
  it.each(['evidence_id','signature'] as const)('rejects a changed original %s even when the use itself is unchanged', field => {
    expect(() => parseRoutineApprovedUse(env, vectors.use, vectors.scope, { ...vectors.original, [field]: '0'.repeat(64) })).toThrow(ServiceUnavailableException);
  });
  it('refuses a signed query authorization with the wrong account revision', () => {
    const p = queryProof(), data = clone(p.query.payload.data) as RoutineAccountQueryPlan; data.accountRevision = 2;
    const query = resign('approved-account-policy', { ...p.query, payload: { ...p.query.payload, data } });
    const auth = resign('approved-account-authorization', { ...p.authorization, query });
    expect(() => parseRoutineApprovedAuthorization(env, auth, vectors.scope)).toThrow(ServiceUnavailableException);
  });
  it('keeps signed-query source identity tied to its facts', () => {
    const p = queryProof(), changed = resign('provider-observation', { ...p.observation, sourceId: '0'.repeat(64) });
    expect(() => parseRoutineProviderObservation(env, changed)).toThrow('routine_provider_observation_invalid');
  });
  for (const entry of journals) {
    it('authenticates the independent fixed ' + entry.name + ' journal and freezes its decoded record', () => {
      const result = entry.parse(entry.row()); expect(result).toEqual(entry.row()); expect(Object.isFrozen(result)).toBe(true);
    });
    it('rejects unknown fields and wrong keys in the ' + entry.name + ' journal', () => {
      expect(() => entry.parse({ ...entry.row(), extra: true })).toThrow(ServiceUnavailableException);
      expect(() => entry.parse({ ...entry.row(), signature: '0'.repeat(64) })).toThrow(ServiceUnavailableException);
    });
    it('does not invoke an accessor or accept a foreign prototype in the ' + entry.name + ' journal', () => {
      const getter = vi.fn(() => { throw Error('getter must remain inert'); });
      const row = entry.row(); Object.defineProperty(row, 'signature', { get: getter, enumerable: true });
      expect(() => entry.parse(row)).toThrow(ServiceUnavailableException); expect(getter).not.toHaveBeenCalled();
      expect(() => entry.parse(Object.assign(Object.create({ inherited: true }), entry.row()))).toThrow(ServiceUnavailableException);
    });
  }
  it('retains all three independent purpose domains and their fixed signatures', () => {
    expect(vectors.refund.signature).toBe('ce6106afc627af171bc4c8758ad9972dbda876de3e5c552293eedc155b3af5f3');
    expect(vectors.shipping.signature).toBe('2ed45cb3beeea7ee2a03646613ab166c6bacc552232b75bcdc20a4e0e4f24eb8');
    expect(vectors.subscription.signature).toBe('4492d46b02f7876e6458c6dbfc4582c9d52ed7196e14569196e43d397325bcd2');
    expect(() => parseRoutineRefundAccountJournal(env, resign('approved-account-policy', vectors.refund), vectors.scope)).toThrow('原账号退款批准或维护权限尚未完整就绪');
    expect(() => parseRoutineShippingAccountJournal(env, vectors.subscription, vectors.scope)).toThrow('小程序原账号发货批准、凭据或证据尚未完整就绪');
    expect(() => parseRoutineSubscriptionAccountJournal(env, vectors.shipping, vectors.scope)).toThrow('小程序原账号订阅通知批准、凭据或证据尚未完整就绪');
  });
  it('does not promote query/notify into refund, shipping or subscription purposes', () => {
    const wrong = (row: typeof vectors.refund | typeof vectors.shipping | typeof vectors.subscription) => ({ ...clone(row),
      payload: { ...clone(row.payload), data: { ...clone(row.payload.data), purposes: ['query','notify'] } } });
    expect(() => parseRoutineRefundAccountJournal(env, resign('routine-refund-account-policy-v1', wrong(vectors.refund)), vectors.scope)).toThrow(ServiceUnavailableException);
    expect(() => parseRoutineShippingAccountJournal(env, resign('shipping-account-policy', wrong(vectors.shipping)), vectors.scope)).toThrow(ServiceUnavailableException);
    expect(() => parseRoutineSubscriptionAccountJournal(env, resign('subscription-account-policy', wrong(vectors.subscription)), vectors.scope)).toThrow(ServiceUnavailableException);
  });
  it('retains dense sorted unique template requirements in subscription history', () => {
    const base = clone(vectors.subscription), data = base.payload.data;
    data.templates = [{ mark: '3098', templateId: 'one' }, { mark: '1451', templateId: 'two' }];
    expect(() => parseRoutineSubscriptionAccountJournal(env, resign('subscription-account-policy', base), vectors.scope)).toThrow(ServiceUnavailableException);
  });
  for (const chain of chains) {
    it('validates a complete chained ' + chain.name + ' history including retired metadata', () => {
      const second = clone(chain.row); second.record_id = '99999999-2222-4333-8444-555555555555'; second.revision = 2;
      second.payload.previousRecordId = chain.row.record_id; second.created_at++;
      second.payload.data.state = 'revoked';
      expect(() => chain.validate([clone(chain.row), resign(chain.tag, second)])).not.toThrow();
      expect(() => chain.validate([])).not.toThrow();
    });
    it.each(['gap','previous','time','reversed'] as const)('rejects %s in the complete ' + chain.name + ' history', fault => {
      const second = clone(chain.row); second.record_id = '99999999-2222-4333-8444-555555555555'; second.revision = fault === 'gap' ? 3 : 2;
      second.payload.previousRecordId = fault === 'previous' ? '' : chain.row.record_id;
      second.created_at += fault === 'time' ? -1 : 1;
      const rows = [clone(chain.row), resign(chain.tag, second)];
      if (fault === 'reversed') rows.reverse();
      expect(() => chain.validate(rows)).toThrow(ServiceUnavailableException);
    });
  }
  it('requires the declared kind and subject on every already-authenticated history row', () => {
    const account = parseRoutineApprovedAccountJournal(env, vectors.account, vectors.scope);
    expect(() => validateRoutineApprovedAccountHistory([account], 'query', vectors.account.subject_id)).toThrow(ServiceUnavailableException);
    expect(() => validateRoutineApprovedAccountHistory([account], 'account', 'another_subject')).toThrow(ServiceUnavailableException);
    expect(() => validateRoutineRefundAccountHistory([parseRoutineRefundAccountJournal(env, vectors.refund, vectors.scope)], 'another_subject')).toThrow(ServiceUnavailableException);
    expect(() => validateRoutineShippingAccountHistory([parseRoutineShippingAccountJournal(env, vectors.shipping, vectors.scope)], 'another_subject')).toThrow(ServiceUnavailableException);
    expect(() => validateRoutineSubscriptionAccountHistory([parseRoutineSubscriptionAccountJournal(env, vectors.subscription, vectors.scope)], 'another_subject')).toThrow(ServiceUnavailableException);
  });
});
