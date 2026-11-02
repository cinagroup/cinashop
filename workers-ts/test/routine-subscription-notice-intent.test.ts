/** Pure authenticated JSON codec tests only. These signed structural fixtures
 * are not real App source/admission, ownership, producer or POST evidence. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRoutineSubscriptionNoticeIntent, type RoutineSubscriptionNoticeIntent } from '@/services/wechat/RoutineSubscriptionNoticeIntent';
import { routineSubscriptionAccountId, subscriptionMac } from '@/services/wechat/RoutineSubscriptionAccount';

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
});
