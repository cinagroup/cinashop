/** Independent synthetic codec vectors only. These are not genuine App/Queue,
 * provider, approved maintenance, commissioning or ownership evidence. */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ServiceUnavailableException } from '../src/utils/errors';
import { parseRoutineSubscriptionNoticeRequest, parseRoutineSubscriptionRefusalRequest, parseRoutineSubscriptionPinkRequest,
  parseRoutineSubscriptionNoticeIntent, type RoutineSubscriptionNoticeIntent } from '../src/services/wechat/RoutineSubscriptionRequestEvidenceCodec';
import { parseRoutineSubscriptionAttempt, parseRoutineSubscriptionAttemptForActor, parseRoutineSubscriptionResult,
  validateRoutineSubscriptionAttemptChain, type RoutineSubscriptionAttempt,
  type RoutineSubscriptionResult } from '../src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec';
import type { RoutineSubscriptionAccountJournal } from '../src/services/payment/RoutinePurposeAccountEvidenceCodec';

const env = { APP_KEY: 'inert-subscription-history-fixed-key' }, old = 1700000000;
const scope = { database: 'history_fixture', databaseOid: '104', maintenance: 'history_owner', maintenanceOid: '105' };
const actor = { role: 'retired_app', roleOid: '106' }, identity = { deliveryId: 31, eventKey: 'order.delivery.notice:17' };
const message = '小程序原账号订阅通知批准、凭据或证据尚未完整就绪';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
// Independently restates the established canonical JSON and full domain. It
// never imports a production writer, capability, DB fixture or signing helper.
const mac = (domain: string, body: unknown): string => createHmac('sha256', env.APP_KEY)
  .update(`cinashop.routine.original-payment.subscription-${domain}.v1\0`)
  .update(JSON.stringify(body, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
function sign<T extends object>(domain: string, body: T): T & { signature: string } { return { ...body, signature: mac(domain, body) }; }
function resign<T extends { signature: string }>(domain: string, row: T): T {
  const { signature: _signature, ...body } = row; return { ...body, signature: mac(domain, body) } as T;
}
function policy(): RoutineSubscriptionAccountJournal {
  const accountId = mac('account-subject', ['wx_history_a']);
  return sign('account-policy', { record_id: uuid(1), account_id: accountId, revision: 1,
    payload: { format: 1 as const, scope: { ...scope }, previousRecordId: '', data: { accountId, state: 'active' as const,
      appId: 'wx_history_a', credentialRef: 'inert_history_ref', credentialVersion: 1, credentialStamp: 'a'.repeat(64),
      purposes: ['subscription_send'] as ['subscription_send'], templates: [{ mark: '1128', templateId: 'send_a' },
        { mark: '1451', templateId: 'refusal_a' }, { mark: '1458', templateId: 'express_a' }, { mark: '3098', templateId: 'group_a' }],
      validFrom: old - 120, validUntil: old + 3600 } }, created_at: old - 60 });
}
function notice() {
  return sign('notice-request', { format: 2 as const, requestId: uuid(2), scope: { ...scope }, actor: { ...actor },
    eventKey: identity.eventKey, aggregateId: 17, eventTime: old, body: { orderId: 17, orderNo: 'order17', userId: 11,
      deliveryType: 'express' as const, deliveryName: '快递', deliveryId: 'TRACK17', userAddress: '上海' }, createdAt: old });
}
function refusal() {
  return sign('refusal-notice-request', { format: 3 as const, requestId: uuid(3), scope: { ...scope }, actor: { ...actor },
    eventKey: 'order.refund.refused.notice:71', aggregateId: 17, eventTime: old,
    body: { orderId: 17, orderNo: 'order17', refundId: 71, userId: 11, payPrice: '1.00' },
    decision: { refuseReason: '已说明原因', refundedTime: old, applicationDigest: 'b'.repeat(64) }, createdAt: old });
}
function pink() {
  return sign('pink-notice-request', { format: 4 as const, requestId: uuid(4), scope: { ...scope }, actor: { ...actor },
    eventKey: 'order.pink.success.notice:17', aggregateId: 17, eventTime: old,
    body: { orderId: 17, orderNo: 'order17', userId: 11, pinkId: 81, people: 2 },
    group: { pinkId: 81, combinationId: 51, productId: 61, people: 2, completedAt: old - 5, realMembers: 1,
      virtualMembers: 1, memberIds: [81, 82], membersDigest: 'c'.repeat(64) },
    member: { id: 81, uid: 11, orderId: 17, orderNo: 'order17', orderIdKey: '17', addTime: old - 10 }, createdAt: old });
}
function intent(): RoutineSubscriptionNoticeIntent {
  return sign('notice-stage', { format: 2 as const, scope: { ...scope }, actor: { ...actor }, deliveryId: 31, outboxId: 41,
    eventKey: identity.eventKey, createdAt: old, requestSignature: notice().signature,
    source: { deliveryId: 31, outboxId: 41, eventKey: identity.eventKey, orderId: 17, rootId: 17, buyerUid: 11,
      appId: 'wx_history_a', ownershipId: 'ownership17', bindingId: 91, observationId: 'observation17', evidenceId: 'evidence17',
      evidenceSignature: 'd'.repeat(64), relatedDigest: 'e'.repeat(64), approvedUseDigest: 'f'.repeat(64), templateMark: '1458' as const, sourceDigest: 'a'.repeat(64) },
    policy: policy(), request: { touser: 'buyer_not_payer', template_id: 'express_a', page: '/pages/order?id=17', data: { thing1: { value: '原商品' } } } });
}
function attempt(ordinal = 1, previous = ''): RoutineSubscriptionAttempt {
  const staged = intent(), created = old + (ordinal - 1) * 10;
  return sign('delivery-attempt', { attempt_id: uuid(100 + ordinal), delivery_id: identity.deliveryId, attempt_no: ordinal,
    source_key: mac('delivery-source-key', [identity.eventKey, 'wechat_routine']), payload: { format: 1 as const,
      purpose: 'routine_subscription_send' as const, scope: { ...scope }, actor: { ...actor }, previousAttemptId: previous,
      intentDigest: 'b'.repeat(64), claim: { eventKey: identity.eventKey, leaseToken: uuid(200 + ordinal), attemptCount: ordinal, leaseUntil: created + 60 },
      facts: staged.source, policy: staged.policy, request: staged.request }, created_at: created });
}
function refundSuccessIntent(format: 5 | 6): RoutineSubscriptionNoticeIntent {
  const { signature: _signature, ...base } = intent(), eventKey = 'order.refund.success.notice:71';
  return sign(format === 6 ? 'materialized-refund-success-notice-stage' : 'refund-success-notice-stage', {
    ...base, format, eventKey,
    source: { ...base.source, eventKey, orderId: format === 6 ? 27 : 17, templateMark: '1451' as const },
    request: { ...base.request, template_id: 'refusal_a', page: '/pages/goods/order_after_details/index?order_id=refund71&isReturen=1',
      data: { thing1: { value: '已成功退款' }, amount3: { value: '5.00' }, character_string6: { value: 'refund71' } } },
  });
}
function receipt(a: RoutineSubscriptionAttempt, code = 0): RoutineSubscriptionResult {
  return sign('delivery-result', { result_id: mac('delivery-result-id', [a.attempt_id, a.signature]), attempt_id: a.attempt_id,
    payload: { format: 1 as const, purpose: 'routine_subscription_result' as const, scope: { ...scope }, attemptSignature: a.signature,
      result: { code, httpStatus: 200, rawDigest: 'c'.repeat(64), requestStartedAt: a.created_at + 1, verifiedAt: a.created_at + 2 } }, created_at: a.created_at + 3 });
}
function chain(count: number, finalCode = 0) {
  const attempts: RoutineSubscriptionAttempt[] = [], results: RoutineSubscriptionResult[] = [];
  for (let i = 1; i <= count; i++) { const a = attempt(i, attempts.at(-1)?.attempt_id ?? ''); attempts.push(a); results.push(receipt(a, i === count ? finalCode : 45009)); }
  return { attempts, results };
}

describe('DB-free historical subscription request and dispatch codecs', () => {
  it.each([5, 6] as const)('authenticates success staging format%s only in its distinct historical MAC domain', format => {
    const raw = refundSuccessIntent(format);
    expect(parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toEqual(raw);
    const wrongDomain = format === 6 ? 'refund-success-notice-stage' : 'materialized-refund-success-notice-stage';
    expect(() => parseRoutineSubscriptionNoticeIntent(env, resign(wrongDomain, raw), scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionNoticeIntent(env, { ...raw, format: format === 6 ? 5 : 6 }, scope)).toThrow(message);
  });
  it('preserves fixed pre-extraction HMAC vectors and canonical domains', () => {
    const a = attempt();
    expect([notice().signature, refusal().signature, pink().signature, intent().signature, a.signature, receipt(a).signature])
      .toEqual(FIXED_SIGNATURES);
    expect(parseRoutineSubscriptionNoticeRequest(env, notice(), scope)).toEqual(notice());
    expect(parseRoutineSubscriptionRefusalRequest(env, refusal(), scope)).toEqual(refusal());
    expect(parseRoutineSubscriptionPinkRequest(env, pink(), scope)).toEqual(pink());
    expect(parseRoutineSubscriptionNoticeIntent(env, intent(), scope)).toEqual(intent());
    expect(parseRoutineSubscriptionAttempt(env, a, scope)).toEqual(a);
    expect(parseRoutineSubscriptionResult(env, receipt(a), a, scope)).toEqual(receipt(a));
  });
  it('authenticates old anchors without consulting wall clock, current LOGIN or latest revocation', () => {
    const raw = intent();
    expect(old).toBeLessThan(1793602800 - 900);
    expect(parseRoutineSubscriptionNoticeIntent(env, raw, scope).createdAt).toBe(old);
    expect(parseRoutineSubscriptionAttempt(env, attempt(), scope).payload.actor).toEqual(actor);
    expect(validateRoutineSubscriptionAttemptChain(env, [attempt()], [receipt(attempt())], scope, identity).state).toBe('complete');
  });
  it('keeps current actor matching mandatory and separate from historical actor syntax', () => {
    const raw = attempt();
    expect(parseRoutineSubscriptionAttemptForActor(env, raw, scope, actor)).toEqual(raw);
    expect(() => parseRoutineSubscriptionAttemptForActor(env, raw, scope, { role: 'new_app', roleOid: '107' })).toThrow(message);
    expect(() => parseRoutineSubscriptionAttemptForActor(env, raw, scope, undefined as never)).toThrow(message);
    const changed = clone(raw); changed.payload.actor = { role: 'new_app', roleOid: '107' };
    expect(() => parseRoutineSubscriptionAttempt(env, changed, scope)).toThrow(message);
  });
  it.each([notice, refusal, pink])('rejects extra root/actor fields and preserves original exception class', factory => {
    const raw = factory(), parse = raw.format === 2 ? parseRoutineSubscriptionNoticeRequest : raw.format === 3 ? parseRoutineSubscriptionRefusalRequest : parseRoutineSubscriptionPinkRequest;
    for (const modified of [{ ...raw, extra: true }, { ...raw, actor: { ...actor, extra: true } }, { ...raw, signature: '0'.repeat(64) }]) {
      expect(() => parse(env, modified, scope)).toThrow(ServiceUnavailableException);
      expect(() => parse(env, modified, scope)).toThrow(message);
    }
  });
  it('rejects a different actual database/owner scope without trusting the row scope', () => {
    for (const actual of [{ ...scope, databaseOid: '108' }, { ...scope, maintenanceOid: '109' }]) {
      expect(() => parseRoutineSubscriptionNoticeRequest(env, notice(), actual)).toThrow(message);
      expect(() => parseRoutineSubscriptionAttempt(env, attempt(), actual)).toThrow(message);
      expect(() => parseRoutineSubscriptionResult(env, receipt(attempt()), attempt(), actual)).toThrow(message);
    }
  });
  it('preserves format2 city keys, code-point bounds and format3 decision binding', () => {
    const raw = notice(), city = resign('notice-request', { ...raw, eventKey: 'order.delivery.notice:17:city:71',
      body: { ...raw.body, deliveryType: 'city_delivery' as const, cityDeliveryJobId: 71, deliveryName: '😀'.repeat(64) } });
    expect(parseRoutineSubscriptionNoticeRequest(env, city, scope).body.deliveryName).toHaveLength(128);
    expect(() => parseRoutineSubscriptionNoticeRequest(env, resign('notice-request', { ...city, body: { ...city.body, cityDeliveryJobId: 72 } }), scope)).toThrow(message);
    const denied = refusal(); denied.decision.refundedTime--;
    expect(() => parseRoutineSubscriptionRefusalRequest(env, resign('refusal-notice-request', denied), scope)).toThrow(message);
  });
  it('preserves format4 ordered formation IDs and exact per-buyer member provenance', () => {
    const raw = pink();
    for (const mutated of [{ ...raw, group: { ...raw.group, memberIds: [82, 81] } },
      { ...raw, member: { ...raw.member, uid: 12 } }, { ...raw, group: { ...raw.group, realMembers: 2 } }])
      expect(() => parseRoutineSubscriptionPinkRequest(env, resign('pink-notice-request', mutated), scope)).toThrow(message);
    const parsed = parseRoutineSubscriptionPinkRequest(env, raw, scope);
    expect(Object.isFrozen(parsed.group.memberIds)).toBe(true); expect(Object.isFrozen(parsed.member)).toBe(true);
  });
  it('does not invoke malicious getters, prototypes, toJSON or current-actor coercion', () => {
    let calls = 0;
    const raw = attempt(); Object.defineProperty(raw.payload.actor, 'role', { enumerable: true, get() { calls++; return actor.role; } });
    expect(() => parseRoutineSubscriptionAttempt(env, raw, scope)).toThrow(message);
    const result = receipt(attempt()); Object.defineProperty(result.payload.scope, 'database', { enumerable: true, get() { calls++; return scope.database; } });
    expect(() => parseRoutineSubscriptionResult(env, result, attempt(), scope)).toThrow(message);
    const q = intent(); Object.setPrototypeOf(q.request.data, { toJSON() { calls++; return {}; } });
    expect(() => parseRoutineSubscriptionNoticeIntent(env, q, scope)).toThrow(message);
    const r = notice(); Object.defineProperty(r.actor, 'role', { enumerable: true, get() { calls++; return actor.role; } });
    expect(() => parseRoutineSubscriptionNoticeRequest(env, r, scope)).toThrow(message); expect(calls).toBe(0);
  });
  it('copies historical JSON before freezing and never freezes caller-owned input', () => {
    const raw = attempt(), parsed = parseRoutineSubscriptionAttempt(env, raw, scope);
    expect(parsed).not.toBe(raw); expect(parsed.payload.request.data).not.toBe(raw.payload.request.data);
    expect(Object.isFrozen(parsed.payload.request.data)).toBe(true); expect(Object.isFrozen(raw)).toBe(false);
    raw.payload.request.data.thing1.value = 'later'; expect(parsed.payload.request.data.thing1.value).toBe('原商品');
  });
  it('retains PostgreSQL bigint digit-string decoding for created_at', () => {
    const a = attempt(), r = receipt(a);
    expect(parseRoutineSubscriptionAttempt(env, { ...a, created_at: String(a.created_at) }, scope)).toEqual(a);
    expect(parseRoutineSubscriptionResult(env, { ...r, created_at: String(r.created_at) }, a, scope)).toEqual(r);
  });
  it.each([40001, 40014, 42001, -1, 45009, 45011, 45028])('allows a next attempt only after authenticated retryable code %s', code => {
    const { attempts, results } = chain(2); results[0] = receipt(attempts[0]!, code);
    expect(validateRoutineSubscriptionAttemptChain(env, attempts, results, scope, identity).state).toBe('complete');
  });
  it.each([0, 40003, 43101, 99999])('rejects a next attempt after success/permanent refusal %s', code => {
    const { attempts, results } = chain(2); results[0] = receipt(attempts[0]!, code);
    expect(() => validateRoutineSubscriptionAttemptChain(env, attempts, results, scope, identity)).toThrow(message);
  });
  it('sorts a complete bounded five-attempt history while preserving ordinal and previous-ID links', () => {
    const { attempts, results } = chain(5, 45009);
    const decoded = validateRoutineSubscriptionAttemptChain(env, [...attempts].reverse(), [...results].reverse(), scope, identity);
    expect(decoded.attempts.map(a => a.attempt_no)).toEqual([1, 2, 3, 4, 5]); expect(decoded.results).toEqual(results);
    expect(decoded.state).toBe('complete'); expect(Object.isFrozen(decoded.attempts)).toBe(true);
  });
  it('treats an absent last result as sticky UNKNOWN and rejects a later attempt after missing evidence', () => {
    const { attempts, results } = chain(2);
    expect(validateRoutineSubscriptionAttemptChain(env, attempts, [results[0]], scope, identity)).toMatchObject({ state: 'unknown', missingAttemptIds: [attempts[1]!.attempt_id] });
    expect(validateRoutineSubscriptionAttemptChain(env, [attempts[0]], [], scope, identity).state).toBe('unknown');
    expect(() => validateRoutineSubscriptionAttemptChain(env, attempts, [results[1]], scope, identity)).toThrow(message);
  });
  it.each(['previous', 'intent', 'request', 'ordinal', 'event', 'delivery'] as const)('rejects a fully re-signed inconsistent chain: %s', kind => {
    const { attempts, results } = chain(2), a = clone(attempts[1]!);
    if (kind === 'previous') a.payload.previousAttemptId = uuid(999);
    if (kind === 'intent') a.payload.intentDigest = 'f'.repeat(64);
    if (kind === 'request') a.payload.request = { ...a.payload.request, touser: 'another_buyer' };
    if (kind === 'ordinal') { a.attempt_no = 3; a.payload.claim.attemptCount = 3; }
    if (kind === 'event') {
      a.payload.claim.eventKey = 'order.delivery.notice:18';
      a.payload.facts = { ...a.payload.facts, eventKey: a.payload.claim.eventKey };
      a.source_key = mac('delivery-source-key', [a.payload.claim.eventKey, 'wechat_routine']);
    }
    if (kind === 'delivery') { a.delivery_id = 32; a.payload.facts = { ...a.payload.facts, deliveryId: 32 }; }
    attempts[1] = resign('delivery-attempt', a); results[1] = receipt(attempts[1]!);
    expect(() => validateRoutineSubscriptionAttemptChain(env, attempts, results, scope, identity)).toThrow(message);
  });
  it('rejects duplicate, orphan, sparse, extra-property or oversized history arrays', () => {
    const { attempts, results } = chain(2);
    expect(() => validateRoutineSubscriptionAttemptChain(env, [attempts[0], attempts[0]], results, scope, identity)).toThrow(message);
    expect(() => validateRoutineSubscriptionAttemptChain(env, attempts, [results[0], results[0]], scope, identity)).toThrow(message);
    expect(() => validateRoutineSubscriptionAttemptChain(env, [attempts[0]], [results[1]], scope, identity)).toThrow(message);
    expect(() => validateRoutineSubscriptionAttemptChain(env, new Array(1), [], scope, identity)).toThrow(message);
    expect(() => validateRoutineSubscriptionAttemptChain(env, Object.assign([], { hidden: true }), [], scope, identity)).toThrow(message);
    expect(() => validateRoutineSubscriptionAttemptChain(env, new Array(6).fill(attempts[0]), [], scope, identity)).toThrow(message);
  });
  it('rejects receipt rebinding, tampering and HTTP success contradictions', () => {
    const a = attempt(), original = receipt(a);
    for (const raw of [{ ...original, signature: 'f'.repeat(64) }, { ...original, attempt_id: uuid(999) },
      resign('delivery-result', { ...original, payload: { ...original.payload, result: { ...original.payload.result, httpStatus: 500 } } })])
      expect(() => parseRoutineSubscriptionResult(env, raw, a, scope)).toThrow(message);
  });
  it('keeps the 9-second verification and 90-second durable receipt windows exact', () => {
    const a = attempt(), r = receipt(a);
    const boundary = resign('delivery-result', { ...r, created_at: a.created_at + 90,
      payload: { ...r.payload, result: { ...r.payload.result, requestStartedAt: a.created_at + 1, verifiedAt: a.created_at + 10 } } });
    expect(parseRoutineSubscriptionResult(env, boundary, a, scope).created_at).toBe(a.created_at + 90);
    expect(() => parseRoutineSubscriptionResult(env, resign('delivery-result', { ...boundary, created_at: a.created_at + 91 }), a, scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionResult(env, resign('delivery-result', { ...boundary, payload: { ...boundary.payload,
      result: { ...boundary.payload.result, verifiedAt: a.created_at + 11 } } }), a, scope)).toThrow(message);
  });
  it('does not treat a forged nested policy or an authenticated but inapplicable historical policy as authorization', () => {
    const a = attempt(); a.payload.policy.signature = 'f'.repeat(64);
    expect(() => parseRoutineSubscriptionAttempt(env, resign('delivery-attempt', a), scope)).toThrow(message);
    const revoked = attempt(); revoked.payload.policy.payload.data.state = 'revoked';
    revoked.payload.policy = resign('account-policy', revoked.payload.policy);
    expect(() => parseRoutineSubscriptionAttempt(env, resign('delivery-attempt', revoked), scope)).toThrow(message);
    const expired = attempt(); expired.created_at = expired.payload.policy.payload.data.validUntil;
    expired.payload.claim.leaseUntil = expired.created_at + 60;
    expect(() => parseRoutineSubscriptionAttempt(env, resign('delivery-attempt', expired), scope)).toThrow(message);
  });
  it('rejects an empty signing key with the established error distinction', () => {
    expect(() => parseRoutineSubscriptionNoticeRequest({ APP_KEY: '' }, notice(), scope)).toThrow(message);
    expect(() => parseRoutineSubscriptionAttempt({ APP_KEY: '' }, attempt(), scope)).toThrow('routine_original_signing_unavailable');
  });
});

const FIXED_SIGNATURES = ['04bc6eb8d98a40ab6f018eed7fd7c9c00e42f3bc40c10d9b9ed0af96d6dd4e64', 'e6fb66e78cb1e274a2bb5b8a7883a061608b984dd7809c707fa3d8060d8bd7ed', '7e71e5a7850c65096346c0f0651ece815c22066db8fcd0f4a1d5027d55e37cd1', 'f5a36f284386fd3888a6ef88ac03b69ec6f1c8fe9883ff2ae01d80b330c4184f', 'ad21ee449baf3dee0b5ab5fd0332301a8ece0584a682972c271c795582472a4c', 'f2cdb4f6d630afaa57eb4c56aa16836d3b638ed28134aa62591905043edb7d12'];
