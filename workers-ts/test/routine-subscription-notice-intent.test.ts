/** Pure authenticated JSON codec tests only. These signed structural fixtures
 * are not real App source/admission, ownership, producer or POST evidence. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRoutineSubscriptionNoticeIntent, type RoutineSubscriptionNoticeIntent } from '@/services/wechat/RoutineSubscriptionNoticeIntent';
import { routineSubscriptionAccountId, subscriptionMac } from '@/services/wechat/RoutineSubscriptionAccount';
import { routineSubscriptionDeliveryKey, routineSubscriptionRefusalKey, routineSubscriptionNoticeKey,
  routineSubscriptionNoticePrefix } from '@/services/wechat/RoutineSubscriptionNoticeKinds';

const env = { APP_KEY: 'inert-notice-intent-codec-key' }, now = 1793602800;
const scope = { database: 'notice_intent_fixture', databaseOid: '102', maintenance: 'notice_owner', maintenanceOid: '103' };
const message = '小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
const clone = <T>(raw: T): T => JSON.parse(JSON.stringify(raw)) as T;
function fixture(): RoutineSubscriptionNoticeIntent {
  const localScope = { ...scope };
  const accountId = routineSubscriptionAccountId(env, 'wx_notice_intent_a');
  const unsignedPolicy = { record_id: randomUUID(), account_id: accountId, revision: 1,
    payload: { format: 1 as const, scope: localScope, previousRecordId: '', data: { accountId, state: 'active' as const, appId: 'wx_notice_intent_a',
      credentialRef: 'notice_secret_ref', credentialVersion: 1, credentialStamp: 'c'.repeat(64), purposes: ['subscription_send'] as ['subscription_send'],
      templates: [{ mark: '1128', templateId: 'notice_send_a' }, { mark: '1458', templateId: 'notice_express_a' }], validFrom: now - 60, validUntil: now + 3600 } },
    created_at: now };
  const policy = { ...unsignedPolicy, signature: subscriptionMac(env, 'account-policy', unsignedPolicy) };
  const body: Omit<RoutineSubscriptionNoticeIntent, 'signature'> = { format: 2, scope: localScope, actor: { role: 'notice_app', roleOid: '104' },
    deliveryId: 31, outboxId: 41, eventKey: 'order.delivery.notice:17', createdAt: now, requestSignature: 'd'.repeat(64),
    source: { deliveryId: 31, outboxId: 41, eventKey: 'order.delivery.notice:17', orderId: 17, rootId: 17, buyerUid: 11,
      appId: 'wx_notice_intent_a', ownershipId: 'ownership_structural_a', bindingId: 61, observationId: 'observation_structural_a',
      evidenceId: 'evidence_structural_a', evidenceSignature: 'e'.repeat(64), relatedDigest: 'a'.repeat(64), approvedUseDigest: 'b'.repeat(64),
      templateMark: '1458', sourceDigest: 'f'.repeat(64) }, policy,
    request: { touser: 'owned_buyer_a_not_payer', template_id: 'notice_express_a', page: '/pages/goods/order_details/index?order_id=order17',
      data: { thing1: { value: '中文 😀 商品' }, character_string2: { value: 'TRACK-17' } } } };
  return { ...body, signature: subscriptionMac(env, 'notice-stage', body) };
}
function resign(raw: RoutineSubscriptionNoticeIntent): RoutineSubscriptionNoticeIntent {
  const { signature: _signature, ...body } = raw; return { ...body, signature: subscriptionMac(env, 'notice-stage', body) };
}
function refusalFixture(): RoutineSubscriptionNoticeIntent {
  const original = fixture(), { signature: _originalSignature, ...base } = original,
    { signature: _policySignature, ...policy } = original.policy;
  const unsignedPolicy = { ...policy, payload: { ...policy.payload, data: { ...policy.payload.data,
    templates: [{ mark: '1451', templateId: 'notice_refusal_a' }] } } };
  const body: Omit<RoutineSubscriptionNoticeIntent, 'signature'> = { ...base, format: 3,
    eventKey: 'order.refund.refused.notice:71', source: { ...original.source,
      eventKey: 'order.refund.refused.notice:71', templateMark: '1451' },
    policy: { ...unsignedPolicy, signature: subscriptionMac(env, 'account-policy', unsignedPolicy) },
    request: { touser: original.request.touser, template_id: 'notice_refusal_a',
      page: '/pages/goods/order_after_details/index?order_id=order17&isReturen=1',
      data: { thing1: { value: '退款失败' }, thing2: { value: '中文 😀 商品' },
        amount3: { value: '5.00' }, character_string6: { value: 'order17' } } } };
  return { ...body, signature: subscriptionMac(env, 'refusal-notice-stage', body) };
}
function signWith(raw: RoutineSubscriptionNoticeIntent, domain: string): RoutineSubscriptionNoticeIntent {
  const { signature: _signature, ...body } = raw; return { ...body, signature: subscriptionMac(env, domain, body) };
}

describe('bounded descriptor-only subscription staging intent codec', () => {
  it('authenticates valid JSON and shared acyclic subtrees, returns a frozen independent snapshot', () => {
    const raw = fixture(), parsed = parseRoutineSubscriptionNoticeIntent(env, raw, scope);
    expect(raw.scope).toBe(raw.policy.payload.scope); expect(parsed).toEqual(raw); expect(parsed).not.toBe(raw);
    expect(parsed.scope).not.toBe(raw.scope); expect(parsed.request.data).not.toBe(raw.request.data);
    expect(parseRoutineSubscriptionNoticeIntent(env, clone(raw), scope)).toEqual(raw);
    for (const value of [parsed, parsed.scope, parsed.actor, parsed.source, parsed.policy.payload.data.templates, parsed.request.data.thing1]) expect(Object.isFrozen(value)).toBe(true);
    raw.request.data.thing1.value = 'changed after parse'; expect(parsed.request.data.thing1.value).toBe('中文 😀 商品');
    expect(Object.isFrozen(raw)).toBe(false);
  });

  it('rejects nested scope, data and policy getters before calling them', () => {
    for (const location of ['scope', 'data', 'policy']) {
      const raw = fixture(); let reads = 0;
      if (location === 'scope') Object.defineProperty(raw.scope, 'database', { enumerable: true, get() { reads++; return scope.database; } });
      if (location === 'data') Object.defineProperty(raw.request.data, 'thing1', { enumerable: true, get() { reads++; return { value: 'unexpected' }; } });
      if (location === 'policy') Object.defineProperty(raw.policy.payload.data, 'appId', { enumerable: true, get() { reads++; return 'wx_notice_intent_a'; } });
      expect(() => parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toThrow(message); expect(reads).toBe(0);
    }
  });

  it('never invokes toJSON, templateMark coercion or a custom data prototype', () => {
    let reads = 0;
    const json = fixture(); Object.defineProperty(json.request.data, 'toJSON', { enumerable: true, value() { reads++; return {}; } });
    expect(() => parseRoutineSubscriptionNoticeIntent(env, json, scope)).toThrow(message);
    const mark = fixture(); (mark.source as unknown as Record<string, unknown>).templateMark = { toString() { reads++; return '1458'; } };
    expect(() => parseRoutineSubscriptionNoticeIntent(env, mark, scope)).toThrow(message);
    const prototype = fixture(); Object.setPrototypeOf(prototype.request.data, { toJSON() { reads++; return {}; } });
    expect(() => parseRoutineSubscriptionNoticeIntent(env, prototype, scope)).toThrow(message); expect(reads).toBe(0);
  });

  it('rejects symbols, nonenumerable extras, functions, BigInt and undefined even if JSON would omit them', () => {
    for (const extra of [Symbol('extra'), 'hidden', 'function', 'bigint', 'undefined']) {
      const raw = fixture();
      if (typeof extra === 'symbol') Object.defineProperty(raw.request.data, extra, { enumerable: true, value: true });
      else if (extra === 'hidden') Object.defineProperty(raw.request.data.thing1, 'hidden', { enumerable: false, value: 'not-JSON' });
      else Object.defineProperty(raw.request.data.thing1, extra, { enumerable: true,
        value: extra === 'function' ? () => 'not-JSON' : extra === 'bigint' ? 1n : undefined });
      expect(() => parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toThrow(message);
    }
  });

  it('rejects cycles and bounds depth, object nodes, and raw UTF8 before serialization', () => {
    const cycle = fixture(); (cycle.request.data as unknown as Record<string, unknown>).cycle = cycle;
    expect(() => parseRoutineSubscriptionNoticeIntent(env, cycle, scope)).toThrow(message);
    const deep = fixture(); let nested: unknown = 'leaf'; for (let i = 0; i < 18; i++) nested = { child: nested };
    (deep.request.data as unknown as Record<string, unknown>).deep = nested;
    expect(() => parseRoutineSubscriptionNoticeIntent(env, deep, scope)).toThrow(message);
    const nodes = fixture(); (nodes.request.data as unknown as Record<string, unknown>).many = Array.from({ length: 4095 }, () => null);
    expect(() => parseRoutineSubscriptionNoticeIntent(env, nodes, scope)).toThrow(message);
    const bytes = fixture(); bytes.request.data.thing1.value = '界'.repeat(22000);
    expect(() => parseRoutineSubscriptionNoticeIntent(env, bytes, scope)).toThrow(message);
    const escapes = fixture(); escapes.request.data.thing1.value = '\0'.repeat(12000);
    expect(() => parseRoutineSubscriptionNoticeIntent(env, escapes, scope)).toThrow(message);
  });

  it('refuses sparse or exotic arrays, non-finite numbers and malformed Unicode', () => {
    for (const kind of ['hole', 'array-extra', 'array-prototype', 'non-finite', 'unicode']) {
      const raw = fixture();
      if (kind === 'hole') delete (raw.policy.payload.data.templates as unknown[])[0];
      if (kind === 'array-extra') Object.defineProperty(raw.policy.payload.data.templates, 'extra', { value: 1, enumerable: true });
      if (kind === 'array-prototype') Object.setPrototypeOf(raw.policy.payload.data.templates, null);
      if (kind === 'non-finite') raw.createdAt = Infinity;
      if (kind === 'unicode') raw.request.data.thing1.value = '\ud800';
      expect(() => parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toThrow(message);
    }
  });

  it('uses closed scope and canonical PG names/OIDs rather than serializing arbitrary expected-scope values', () => {
    let reads = 0; const expected = { ...scope, get database() { reads++; return scope.database; } };
    expect(() => parseRoutineSubscriptionNoticeIntent(env, fixture(), expected)).toThrow(message); expect(reads).toBe(0);
    for (const patch of [{ databaseOid: '0102' }, { maintenanceOid: '4294967296' }, { maintenance: 'pg_owner' }, { extra: 'foreign' }]) {
      const raw = fixture(); raw.scope = { ...raw.scope, ...patch };
      expect(() => parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toThrow(message);
    }
  });

  it('rejects numeric template marks, foreign scope, modified bytes, wrong key/domain and closed-shape extras', () => {
    const raw = fixture();
    for (const patch of [{ scope: { ...scope, databaseOid: '999' } }, { extra: true }, { signature: '0'.repeat(64) }, { createdAt: now + 1 }])
      expect(() => parseRoutineSubscriptionNoticeIntent(env, { ...raw, ...patch }, scope)).toThrow(message);
    const mark = fixture(); (mark.source as unknown as Record<string, unknown>).templateMark = 1458;
    expect(() => parseRoutineSubscriptionNoticeIntent(env, resign(mark), scope)).toThrow(message);
    const { signature: _signature, ...body } = raw;
    expect(() => parseRoutineSubscriptionNoticeIntent(env, { ...body, signature: subscriptionMac(env, 'shipping-stage', body) }, scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionNoticeIntent({ APP_KEY: 'wrong-codec-key' }, raw, scope)).toThrow(message);
  });

  it('authenticates only a format3/refund/1451 intent with its independent refusal MAC and frozen snapshot', () => {
    const raw = refusalFixture(), parsed = parseRoutineSubscriptionNoticeIntent(env, clone(raw), scope);
    expect(parsed).toEqual(raw); expect(parsed).toMatchObject({ format: 3, eventKey: 'order.refund.refused.notice:71',
      source: { orderId: 17, templateMark: '1451' }, request: { template_id: 'notice_refusal_a' } });
    for (const object of [parsed, parsed.scope, parsed.source, parsed.policy, parsed.request, parsed.request.data.thing1]) expect(Object.isFrozen(object)).toBe(true);
    raw.request.data.thing1.value = 'changed later'; expect(parsed.request.data.thing1.value).toBe('退款失败');
    const { signature: _signature, ...body } = parsed;
    expect(parsed.signature).toBe(subscriptionMac(env, 'refusal-notice-stage', body));
    expect(parsed.signature).not.toBe(subscriptionMac(env, 'notice-stage', body));
    // Existing delivery format2 and the old MAC remain independently accepted.
    const old = fixture(); expect(parseRoutineSubscriptionNoticeIntent(env, clone(old), scope)).toEqual(old);
  });

  it.each(['refusal-old-domain', 'delivery-refusal-domain', 'refusal-format2', 'delivery-format3',
    'refusal-delivery-prefix', 'delivery-refusal-prefix', 'refusal-delivery-mark', 'delivery-refusal-mark',
    'refusal-pink-prefix', 'refusal-source-key-mismatch'])('rejects cross-version/prefix/mark/domain substitution %s', kind => {
    let raw = kind.startsWith('delivery-') ? fixture() : refusalFixture();
    if (kind === 'refusal-old-domain') raw = signWith(raw, 'notice-stage');
    else if (kind === 'delivery-refusal-domain') raw = signWith(raw, 'refusal-notice-stage');
    else {
      if (kind === 'refusal-format2') raw.format = 2;
      if (kind === 'delivery-format3') raw.format = 3;
      if (kind === 'refusal-delivery-prefix') raw = { ...raw, eventKey: 'order.delivery.notice:17', source: { ...raw.source, eventKey: 'order.delivery.notice:17' } };
      if (kind === 'delivery-refusal-prefix') raw = { ...raw, eventKey: 'order.refund.refused.notice:71', source: { ...raw.source, eventKey: 'order.refund.refused.notice:71' } };
      if (kind === 'refusal-delivery-mark') raw = { ...raw, source: { ...raw.source, templateMark: '1458' } };
      if (kind === 'delivery-refusal-mark') raw = { ...raw, source: { ...raw.source, templateMark: '1451' } };
      if (kind === 'refusal-pink-prefix') raw = { ...raw, eventKey: 'order.pink.success.notice:71', source: { ...raw.source, eventKey: 'order.pink.success.notice:71' } };
      if (kind === 'refusal-source-key-mismatch') raw = { ...raw, source: { ...raw.source, eventKey: 'order.refund.refused.notice:72' } };
      raw = signWith(raw, raw.format === 3 ? 'refusal-notice-stage' : 'notice-stage');
    }
    expect(() => parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toThrow(message);
  });

  it('requires the exact A1451 template approval inside an otherwise MAC-valid refusal intent', () => {
    for (const templates of [[{ mark: '1458', templateId: 'notice_refusal_a' }], [{ mark: '1451', templateId: 'different_refusal_template' }]]) {
      const raw = refusalFixture(), { signature: _signature, ...body } = raw.policy;
      const unsigned = { ...body, payload: { ...body.payload, data: { ...body.payload.data, templates } } };
      raw.policy = { ...unsigned, signature: subscriptionMac(env, 'account-policy', unsigned) };
      expect(() => parseRoutineSubscriptionNoticeIntent(env, signWith(raw, 'refusal-notice-stage'), scope)).toThrow(message);
    }
  });

  it.each(['order.delivery.notice:1', 'order.delivery.notice:2147483647', 'order.delivery.notice:17:city:71',
    'order.refund.refused.notice:1', 'order.refund.refused.notice:71'])('routes an exact syntactic notice key %s into only its own kind', key => {
    const refusal = key.startsWith('order.refund.');
    expect(routineSubscriptionNoticePrefix(key)).toBe(true); expect(routineSubscriptionNoticeKey(key)).toBe(true);
    expect(routineSubscriptionRefusalKey(key)).toBe(refusal); expect(routineSubscriptionDeliveryKey(key)).toBe(!refusal);
  });

  it.each(['order.delivery.notice:', 'order.delivery.notice:0', 'order.delivery.notice:01', 'order.delivery.notice:-1',
    'order.delivery.notice:1:city:0', 'order.delivery.notice:1:city:2:extra', 'order.delivery.notice:1/extra',
    'order.refund.refused.notice:', 'order.refund.refused.notice:0', 'order.refund.refused.notice:01',
    'order.refund.refused.notice:1.0', 'order.refund.refused.notice:71:city:2', 'order.refund.refused.notice:NaN',
    'order.refund.refused.notice:' + '1'.repeat(129)])('keeps malformed %s on broad protocol routing while denying exact admission', key => {
    expect(routineSubscriptionNoticePrefix(key)).toBe(true); expect(routineSubscriptionNoticeKey(key)).toBe(false);
    expect(routineSubscriptionDeliveryKey(key)).toBe(false); expect(routineSubscriptionRefusalKey(key)).toBe(false);
  });

  it('keeps unrelated event families and non-string exact-key values outside the protocol', () => {
    for (const key of ['order.pink.success.notice:71', 'order.refund.approved.notice:71', 'order.delivery.notice', 'xorder.delivery.notice:1', '']) {
      expect(routineSubscriptionNoticePrefix(key)).toBe(false); expect(routineSubscriptionNoticeKey(key)).toBe(false);
    }
    for (const key of [null, undefined, 71, {}, [], true]) {
      expect(routineSubscriptionNoticeKey(key)).toBe(false); expect(routineSubscriptionDeliveryKey(key)).toBe(false); expect(routineSubscriptionRefusalKey(key)).toBe(false);
    }
  });
});
