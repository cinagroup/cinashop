/** Synthetic codec vectors only: no actual SQL, approved ownership or provider send is claimed. */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRoutineSubscriptionPaidRequest, parseRoutineSubscriptionPaidIntent, capturePaidSubscriptionFacts, renderPaidSubscriptionData,
  type RoutineSubscriptionPaidRequest, type RoutineSubscriptionPaidIntent } from '../src/services/wechat/RoutineSubscriptionPaidEvidenceCodec';
import { parseRoutineSubscriptionNoticeIntent } from '../src/services/wechat/RoutineSubscriptionRequestEvidenceCodec';
import { parseRoutineSubscriptionAttemptForActor } from '../src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec';
import { routineSubscriptionNoticeKey, routineSubscriptionNoticePrefix } from '../src/services/wechat/RoutineSubscriptionNoticeKinds';
import type { RoutineSubscriptionAccountJournal } from '../src/services/payment/RoutinePurposeAccountEvidenceCodec';
import { routineNotificationAccumulator } from '../scripts/routine-notification-continuation';
const env = { APP_KEY: 'synthetic-paid-history-codec-key' }, now = 1700000000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { database: 'owned_paid_codec', databaseOid: '104', maintenance: 'owned_maint', maintenanceOid: '105' };
const actor = { role: 'owned_app', roleOid: '106' }, key = 'order.pay.success.notice:18';
const mac = (domain: string, value: unknown): string => createHmac('sha256', env.APP_KEY).update(`cinashop.routine.original-payment.subscription-${domain}.v1\0`)
  .update(JSON.stringify(value, (_k, row) => row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]])) : row)).digest('hex');
const sign = <T extends object>(domain: string, value: T) => ({ ...value, signature: mac(domain, value) });
function resign<T extends { signature: string }>(domain: string, value: T): T { const { signature: _signature, ...body } = value; return sign(domain, body) as T; }
function request(): RoutineSubscriptionPaidRequest {
  return sign('paid-notice-request', { format: 7 as const, requestId: uuid(1), scope, actor, eventKey: key, aggregateId: 18, eventTime: now,
    body: { format: 1 as const, paymentEventId: 20, paymentOrderId: 17, paymentOrderNo: 'payment17', paymentAdmissionNonce: uuid(2),
      orderId: 18, orderNo: 'child18', userId: 11, payPrice: '7.00', totalNum: 2, phone: '13800000011', storeName: '快照商品😀', sendName: '原收货人', payTime: now - 2, occurredAt: now },
    selection: { mode: 'unique-owner' as const, appId: 'wx_owned_a', ownershipId: 'a'.repeat(64), bindingId: 31, observationId: uuid(3),
      openid: 'uid_owner_not_payer', ownershipDigest: 'b'.repeat(64) }, familyDigest: 'c'.repeat(64), paymentDigest: 'd'.repeat(64), createdAt: now });
}
function policy(): RoutineSubscriptionAccountJournal {
  const accountId = mac('account-subject', ['wx_owned_a']);
  return sign('account-policy', { record_id: uuid(4), account_id: accountId, revision: 1, payload: { format: 1 as const, scope,
    previousRecordId: '', data: { accountId, state: 'active' as const, appId: 'wx_owned_a', credentialRef: 'owned_reference', credentialVersion: 1,
      credentialStamp: 'e'.repeat(64), purposes: ['subscription_send'] as ['subscription_send'], templates: [{ mark: '1927', templateId: 'owned_pay_template' }],
      validFrom: now - 60, validUntil: now + 3600 } }, created_at: now - 30 });
}
function intent(): RoutineSubscriptionPaidIntent {
  const r = request();
  return sign('paid-notice-stage', { format: 7 as const, scope, actor, deliveryId: 41, outboxId: 42, eventKey: key, createdAt: now, requestSignature: r.signature,
    source: { deliveryId: 41, outboxId: 42, eventKey: key, orderId: 18, rootId: 17, buyerUid: 11, appId: r.selection.appId,
      ownershipId: r.selection.ownershipId, bindingId: r.selection.bindingId, observationId: r.selection.observationId, templateMark: '1927' as const,
      paymentEventId: 20, paymentAdmissionNonce: uuid(2), familyDigest: r.familyDigest, ownershipDigest: r.selection.ownershipDigest,
      payment: { kind: 'unique-identity' as const, payType: 'yue', paymentDigest: r.paymentDigest }, sourceDigest: 'f'.repeat(64) },
    policy: policy(), request: { touser: r.selection.openid, template_id: 'owned_pay_template', page: '/pages/goods/order_details/index?order_id=child18',
      data: Object.fromEntries(Object.entries(renderPaidSubscriptionData(r.body)).map(([k, value]) => [k, { value }])) } });
}
function attempt() {
  const staged = intent(); return sign('delivery-attempt', { attempt_id: uuid(5), delivery_id: 41, attempt_no: 1,
    source_key: mac('delivery-source-key', [key, 'wechat_routine']), payload: { format: 1 as const, purpose: 'routine_subscription_send' as const,
      scope, actor, previousAttemptId: '', intentDigest: 'a'.repeat(64), claim: { eventKey: key, leaseToken: uuid(6), attemptCount: 1, leaseUntil: now + 60 },
      facts: staged.source, policy: staged.policy, request: staged.request }, created_at: now });
}
/** Independent synthetic six-root history stream, not a database observation. */
function continuation(r = request(), staged = intent(), candidate: unknown = r) {
  const layouts: Record<string, Record<string, number>> = {
    store_order_outbox: { id: 23, event_key: 1043, aggregate_type: 1043, aggregate_id: 23, event_type: 1043, payload: 3802, status: 1043,
      dispatch_count: 23, attempt_count: 23, replay_count: 23, available_time: 23, lease_until: 23, lease_token: 1043, last_error: 1043,
      enqueued_time: 23, processed_time: 23, add_time: 23, update_time: 23 },
    order_notification_delivery: { id: 23, outbox_id: 23, event_key: 1043, order_id: 23, withdrawal_id: 23, user_id: 23, notice_mark: 1043,
      channel: 1043, target: 1043, template_code: 1043, payload: 3802, status: 1043, dispatch_count: 23, attempt_count: 23, replay_count: 23,
      available_time: 23, lease_until: 23, lease_token: 1043, provider_reference: 1043, provider_request_id: 1043, response_code: 1043,
      last_error: 1043, sent_time: 23, add_time: 23, update_time: 23 },
    routine_subscribe_attempt: { attempt_id: 2950, delivery_id: 23, attempt_no: 23, source_key: 1043, payload: 3802, created_at: 20, signature: 1043 },
    routine_subscribe_result: { result_id: 1043, attempt_id: 2950, payload: 3802, created_at: 20, signature: 1043 },
    routine_subscription_account_policy: { record_id: 2950, account_id: 1043, revision: 23, payload: 3802, created_at: 20, signature: 1043 },
    routine_original_payment_evidence: { evidence_id: 1043, order_no: 1043, transaction_id: 1043, source: 1043, source_id: 1043,
      format_version: 21, payload: 3802, created_at: 20, signature: 1043 },
  };
  const accumulator = routineNotificationAccumulator(env.APP_KEY, '43'.repeat(32));
  accumulator.context({ database: scope.database, databaseOid: scope.databaseOid, observedAt: now + 60 }, [{ oid: actor.roleOid, name: actor.role, login: true }]);
  const relations = Object.entries(layouts).map(([name, columns], index) => {
    const source = { schema: 'public', name, oid: String(201 + index), kind: 'r', owner: scope.maintenance, ownerOid: scope.maintenanceOid };
    accumulator.relation(source, Object.entries(columns).map(([name, oid]) => ({ name, oid, namespace: 'pg_catalog' })));
    return { name, schema: 'public', oid: source.oid, rowCount: '0', digest: 'a'.repeat(64) };
  });
  const add = (name: string, value: object) => accumulator.row({ schema: 'public', name }, '1:(0,1):' + JSON.stringify(value));
  const payload = { kind: 'wechat_routine', routineAppId: staged.source.appId, routineSubscriptionIntent: staged,
    data: Object.fromEntries(Object.entries(staged.request.data).map(([k, v]) => [k, v.value])), url: staged.request.page };
  const delivery = { id: 41, outboxId: 42, eventKey: key, orderId: 18, withdrawalId: null, userId: 11, noticeMark: 'order_pay_success',
    channel: 'wechat_routine', target: staged.request.touser, templateCode: staged.request.template_id, payload, addTime: now };
  const a = attempt(); a.payload.facts = staged.source; a.payload.policy = staged.policy; a.payload.request = staged.request;
  a.payload.intentDigest = mac('delivery-intent', delivery);
  add('routine_subscription_account_policy', staged.policy);
  add('store_order_outbox', { id: 42, event_key: key, aggregate_type: 'order', aggregate_id: 18, event_type: 'order.pay.success.notice',
    payload: { ...r.body, routineSubscriptionRequest: candidate }, status: 'COMPLETED', add_time: now });
  add('order_notification_delivery', { id: 41, outbox_id: 42, event_key: key, order_id: 18, withdrawal_id: null, user_id: 11,
    notice_mark: 'order_pay_success', channel: 'wechat_routine', target: delivery.target, template_code: delivery.templateCode,
    payload, status: 'UNKNOWN', add_time: now });
  add('routine_subscribe_attempt', resign('delivery-attempt', a));
  return accumulator.finish(relations, 'b'.repeat(64));
}
describe('format7 ordinary paid subscription evidence', () => {
  it('authenticates a new child notice and preserves distinct payment root, admission and owner', () => {
    const r = request(); expect(parseRoutineSubscriptionPaidRequest(env, r, scope)).toEqual(r);
    expect(r.body.orderId).not.toBe(r.body.paymentOrderId); expect(r.selection.openid).toBe('uid_owner_not_payer');
  });
  it.each(['paymentAdmissionNonce', 'paymentEventId', 'paymentOrderId', 'orderId', 'userId', 'payPrice'] as const)('rejects an unsigned body mutation of %s', field => {
    const raw = request(), body = { ...raw.body, [field]: typeof raw.body[field] === 'number' ? Number(raw.body[field]) + 1 : 'changed' };
    expect(() => parseRoutineSubscriptionPaidRequest(env, { ...raw, body }, scope)).toThrow();
  });
  it('requires its independent request HMAC domain and exact SQL scope', () => {
    expect(() => parseRoutineSubscriptionPaidRequest(env, resign('notice-request', request()), scope)).toThrow();
    expect(() => parseRoutineSubscriptionPaidRequest(env, request(), { ...scope, maintenanceOid: '107' })).toThrow();
  });
  it('does not admit a guest, extra field, wrong key or unavailable sentinel', () => {
    const r = request();
    for (const raw of [{ ...r, extra: true }, { ...r, eventKey: 'order.paid:17' }, { ...r, body: { ...r.body, userId: 0 } }, { format: 7, unavailable: true }])
      expect(() => parseRoutineSubscriptionPaidRequest(env, raw, scope)).toThrow();
  });
  it('copies and deeply freezes decoded selection and body without freezing caller input', () => {
    const raw = request(), parsed = parseRoutineSubscriptionPaidRequest(env, raw, scope);
    expect(Object.isFrozen(parsed.body)).toBe(true); expect(Object.isFrozen(parsed.selection)).toBe(true); expect(Object.isFrozen(raw)).toBe(false);
    raw.body.storeName = 'later'; expect(parsed.body.storeName).toBe('快照商品😀');
  });
  it('does not execute getters or toJSON while validating historical candidates', () => {
    let calls = 0; const raw = request(); Object.defineProperty(raw.selection, 'appId', { enumerable: true, get() { calls++; return 'wx_owned_a'; } });
    expect(() => parseRoutineSubscriptionPaidRequest(env, raw, scope)).toThrow();
    const other = intent(); Object.setPrototypeOf(other.request.data, { toJSON() { calls++; return {}; } });
    expect(() => parseRoutineSubscriptionNoticeIntent(env, other, scope)).toThrow(); expect(calls).toBe(0);
  });
  it('renders the exact 1927 fields, amount suffix and China second precision', () => {
    expect(renderPaidSubscriptionData(request().body)).toEqual({ character_string1: 'child18', amount2: '7.00元', date3: '2023-11-15 06:13:20' });
    expect(renderPaidSubscriptionData({ ...request().body, payPrice: '0.00' }).amount2).toBe('0.00元');
  });
  it('authenticates 1927 stage through both paid and shared decoders without inventing payment approval', () => {
    const raw = intent(); expect(parseRoutineSubscriptionPaidIntent(env, raw, scope)).toEqual(raw);
    expect(parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toEqual(raw);
    expect('approvedUseDigest' in raw.source.payment).toBe(false);
  });
  it('keeps real-original and unique-identity payment facts explicit and closed', () => {
    const raw = intent(), facts = { ...raw.source, payment: { kind: 'routine-original', evidenceId: 'real_original_17', evidenceSignature: 'a'.repeat(64),
      relatedDigest: 'b'.repeat(64), approvedUseDigest: 'c'.repeat(64) } };
    expect(capturePaidSubscriptionFacts(facts).payment.kind).toBe('routine-original');
    expect(() => capturePaidSubscriptionFacts({ ...raw.source, payment: { ...raw.source.payment, approvedUseDigest: 'a'.repeat(64) } })).toThrow();
  });
  it('rejects a 1458-only policy, different stage MAC or wrong template', () => {
    const raw = intent(), p = raw.policy;
    const wrongPolicy = resign('account-policy', { ...p, payload: { ...p.payload, data: { ...p.payload.data, templates: [{ mark: '1458', templateId: 'owned_pay_template' }] } } });
    expect(() => parseRoutineSubscriptionPaidIntent(env, resign('paid-notice-stage', { ...raw, policy: wrongPolicy }), scope)).toThrow();
    expect(() => parseRoutineSubscriptionPaidIntent(env, resign('notice-stage', raw), scope)).toThrow();
    expect(() => parseRoutineSubscriptionPaidIntent(env, resign('paid-notice-stage', { ...raw, request: { ...raw.request, template_id: 'unapproved' } }), scope)).toThrow();
  });
  it('admits immutable attempts through the existing dispatch codec with only key-matched 1927 facts', () => {
    const raw = attempt(); expect(parseRoutineSubscriptionAttemptForActor(env, raw, scope, actor)).toEqual(raw);
    expect(() => parseRoutineSubscriptionAttemptForActor(env, resign('delivery-attempt', { ...raw,
      payload: { ...raw.payload, facts: { ...raw.payload.facts, templateMark: '1458' } } }), scope, actor)).toThrow();
  });
  it('routes malformed paid prefixes to fail-closed authority without accepting malformed keys', () => {
    expect(routineSubscriptionNoticeKey(key)).toBe(true); expect(routineSubscriptionNoticeKey('order.pay.success.notice:0')).toBe(false);
    expect(routineSubscriptionNoticePrefix('order.pay.success.notice:bad')).toBe(true);
  });
  it('classifies authenticated balance history without fabricating an original-payment reference or send authority', () => {
    const report = continuation();
    expect(report.outboxes).toMatchObject([{ format: 7, state: 'authenticated_source_match' }]);
    expect(report.deliveries).toMatchObject([{ staging: 'authenticated_source_match', original: 'not_applicable', originalRecordDigest: null,
      dispatch: 'unknown', intentMatches: true }]);
    expect(report.attempts).toMatchObject([{ authenticity: 'authenticated', original: 'not_applicable', originalRecordDigest: null, result: 'unknown' }]);
    expect(report).toMatchObject({ activationAllowed: false, permitIssued: false, switchCommissioned: false, subscriptionSendAuthorized: false,
      currentBusinessEligibility: 'not_evaluated', credentials: 'not_evaluated', catalogCommissioning: 'not_evaluated', externalSourcesIncluded: false });
  });
  it('uses only the actual original variant reference for historical WX payment notices', () => {
    const raw = request(); raw.selection.mode = 'routine-original'; const r = resign('paid-notice-request', raw), stage = intent();
    stage.requestSignature = r.signature; stage.source.payment = { kind: 'routine-original', evidenceId: 'synthetic_missing_original',
      evidenceSignature: 'a'.repeat(64), relatedDigest: 'b'.repeat(64), approvedUseDigest: 'c'.repeat(64) };
    const report = continuation(r, resign('paid-notice-stage', stage));
    expect(report.deliveries).toMatchObject([{ staging: 'authenticated_source_match', original: 'missing', originalRecordDigest: null }]);
    expect(report.attempts).toMatchObject([{ authenticity: 'authenticated', original: 'missing', originalRecordDigest: null }]);
    expect(report.subscriptionSendAuthorized).toBe(false);
  });
  it('keeps a signed paid stage with a different frozen selection mismatched in the six-root draft', () => {
    const stage = intent(); stage.source.bindingId++;
    const report = continuation(request(), resign('paid-notice-stage', stage));
    expect(report.deliveries).toMatchObject([{ staging: 'authenticated_source_mismatch', source: 'unresolved', original: 'not_applicable' }]);
    expect(report.subscriptionSendAuthorized).toBe(false);
  });
  it('recognizes a format7 unavailable marker as unavailable rather than parsing it as a pink request', () => {
    expect(continuation(request(), intent(), { format: 7, unavailable: true }).outboxes).toMatchObject([{ format: null, state: 'unavailable' }]);
  });
});
