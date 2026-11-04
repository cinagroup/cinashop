/** Synthetic codec vectors only: no actual SQL, approved ownership or provider send is claimed. */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRoutineSubscriptionMembershipRequest, parseRoutineSubscriptionMembershipIntent, captureMembershipSubscriptionFacts, renderMembershipSubscriptionData, membershipSubscriptionTransientSqlState,
  type RoutineSubscriptionMembershipRequest, type RoutineSubscriptionMembershipIntent } from '../src/services/wechat/RoutineSubscriptionMembershipEvidenceCodec';
import { parseRoutineSubscriptionNoticeIntent } from '../src/services/wechat/RoutineSubscriptionRequestEvidenceCodec';
import { parseRoutineSubscriptionAttemptForActor } from '../src/services/wechat/RoutineSubscriptionDispatchEvidenceCodec';
import { routineSubscriptionNoticeKey, routineSubscriptionNoticePrefix } from '../src/services/wechat/RoutineSubscriptionNoticeKinds';
import type { RoutineSubscriptionAccountJournal } from '../src/services/payment/RoutinePurposeAccountEvidenceCodec';
import type { RoutineOriginalEvidence } from '../src/services/payment/RoutineOriginalPaymentEvidenceCodec';
import { routineNotificationAccumulator } from '../scripts/routine-notification-continuation';
const env = { APP_KEY: 'synthetic-membership-history-codec-key' }, now = 1700000000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { database: 'owned_membership_codec', databaseOid: '104', maintenance: 'owned_maint', maintenanceOid: '105' };
const actor = { role: 'owned_app', roleOid: '106' }, key = 'membership.pay.success.notice:18';
const mac = (domain: string, value: unknown): string => createHmac('sha256', env.APP_KEY).update(`cinashop.routine.original-payment.subscription-${domain}.v1\0`)
  .update(JSON.stringify(value, (_k, row) => row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]])) : row)).digest('hex');
const sign = <T extends object>(domain: string, value: T) => ({ ...value, signature: mac(domain, value) });
function resign<T extends { signature: string }>(domain: string, value: T): T { const { signature: _signature, ...body } = value; return sign(domain, body) as T; }
function request(): RoutineSubscriptionMembershipRequest {
  return sign('membership-notice-request', { format: 8 as const, requestId: uuid(1), scope, actor, eventKey: key, aggregateId: 18, eventTime: now,
    body: { format: 1 as const, domain: 'membership' as const, settlementNonce: uuid(2), orderId: 18, orderNo: 'hy_membership18', userId: 11,
      kind: 'paid-membership' as const, memberType: '12', vipDay: 30, isPermanent: 0 as const, overdueTime: now + 30 * 86400,
      payType: 'yue' as const, payPrice: '7.00', payTime: now - 2, tradeNo: '', phone: '13800000011', sendName: '会员昵称', storeName: '购买会员卡', occurredAt: now },
    selection: { mode: 'unique-owner' as const, appId: 'wx_owned_a', ownershipId: 'a'.repeat(64), bindingId: 31, observationId: uuid(3),
      openid: 'uid_owner_not_payer', ownershipDigest: 'b'.repeat(64) }, settlementDigest: 'c'.repeat(64), paymentDigest: 'd'.repeat(64), createdAt: now });
}
function policy(): RoutineSubscriptionAccountJournal {
  const accountId = mac('account-subject', ['wx_owned_a']);
  return sign('account-policy', { record_id: uuid(4), account_id: accountId, revision: 1, payload: { format: 1 as const, scope,
    previousRecordId: '', data: { accountId, state: 'active' as const, appId: 'wx_owned_a', credentialRef: 'owned_reference', credentialVersion: 1,
      credentialStamp: 'e'.repeat(64), purposes: ['subscription_send'] as ['subscription_send'], templates: [{ mark: '1927', templateId: 'owned_pay_template' }],
      validFrom: now - 60, validUntil: now + 3600 } }, created_at: now - 30 });
}
function intent(): RoutineSubscriptionMembershipIntent {
  const r = request();
  return sign('membership-notice-stage', { format: 8 as const, scope, actor, deliveryId: 41, outboxId: 42, eventKey: key, createdAt: now, requestSignature: r.signature,
    source: { deliveryId: 41, outboxId: 42, eventKey: key, orderId: 18, rootId: 18, buyerUid: 11, subjectDomain: 'membership' as const, appId: r.selection.appId,
      ownershipId: r.selection.ownershipId, bindingId: r.selection.bindingId, observationId: r.selection.observationId, templateMark: '1927' as const,
      settlementNonce: uuid(2), settlementDigest: r.settlementDigest, ownershipDigest: r.selection.ownershipDigest,
      payment: { kind: 'unique-identity' as const, payType: 'yue' as const, paymentDigest: r.paymentDigest }, sourceDigest: 'f'.repeat(64) },
    policy: policy(), request: { touser: r.selection.openid, template_id: 'owned_pay_template', page: '/pages/goods/order_details/index?order_id=hy_membership18',
      data: Object.fromEntries(Object.entries(renderMembershipSubscriptionData(r.body)).map(([k, value]) => [k, { value }])) } });
}
function attempt() {
  const staged = intent(); return sign('delivery-attempt', { attempt_id: uuid(5), delivery_id: 41, attempt_no: 1,
    source_key: mac('delivery-source-key', [key, 'wechat_routine']), payload: { format: 1 as const, purpose: 'routine_subscription_send' as const,
      scope, actor, previousAttemptId: '', intentDigest: 'a'.repeat(64), claim: { eventKey: key, leaseToken: uuid(6), attemptCount: 1, leaseUntil: now + 60 },
      facts: staged.source, policy: staged.policy, request: staged.request }, created_at: now });
}
/** Independent synthetic six-root history stream, not a database observation. */
function continuation(r = request(), staged = intent(), candidate: unknown = r, options: { original?: RoutineOriginalEvidence; row?: Record<string, unknown>; legacyLayout?: boolean; resultCode?: number } = {}) {
  const layouts: Record<string, Record<string, number>> = {
    store_order_outbox: { id: 23, event_key: 1043, aggregate_type: 1043, aggregate_id: 23, event_type: 1043, payload: 3802, status: 1043,
      dispatch_count: 23, attempt_count: 23, replay_count: 23, available_time: 23, lease_until: 23, lease_token: 1043, last_error: 1043,
      enqueued_time: 23, processed_time: 23, add_time: 23, update_time: 23 },
    order_notification_delivery: { id: 23, outbox_id: 23, event_key: 1043, order_id: 23, withdrawal_id: 23, user_id: 23, notice_mark: 1043,
      channel: 1043, target: 1043, template_code: 1043, payload: 3802, status: 1043, dispatch_count: 23, attempt_count: 23, replay_count: 23,
      available_time: 23, lease_until: 23, lease_token: 1043, provider_reference: 1043, provider_request_id: 1043, response_code: 1043,
      last_error: 1043, sent_time: 23, add_time: 23, update_time: 23, subject_domain: 1043, subject_id: 23 },
    routine_subscribe_attempt: { attempt_id: 2950, delivery_id: 23, attempt_no: 23, source_key: 1043, payload: 3802, created_at: 20, signature: 1043 },
    routine_subscribe_result: { result_id: 1043, attempt_id: 2950, payload: 3802, created_at: 20, signature: 1043 },
    routine_subscription_account_policy: { record_id: 2950, account_id: 1043, revision: 23, payload: 3802, created_at: 20, signature: 1043 },
    routine_original_payment_evidence: { evidence_id: 1043, order_no: 1043, transaction_id: 1043, source: 1043, source_id: 1043,
      format_version: 21, payload: 3802, created_at: 20, signature: 1043 },
  };
  if (options.legacyLayout) { delete layouts.order_notification_delivery!.subject_domain; delete layouts.order_notification_delivery!.subject_id; }
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
  const delivery = { id: 41, outboxId: 42, eventKey: key, orderId: null, withdrawalId: null, subjectDomain: 'membership', subjectId: 18, userId: 11, noticeMark: 'order_pay_success',
    channel: 'wechat_routine', target: staged.request.touser, templateCode: staged.request.template_id, payload, addTime: now };
  const a = attempt(); a.payload.facts = staged.source; a.payload.policy = staged.policy; a.payload.request = staged.request;
  a.payload.intentDigest = mac('delivery-intent', delivery);
  add('routine_subscription_account_policy', staged.policy);
  if (options.original) add('routine_original_payment_evidence', options.original);
  add('store_order_outbox', { id: 42, event_key: key, aggregate_type: 'membership', aggregate_id: 18, event_type: 'membership.pay.success.notice',
    payload: { ...r.body, routineSubscriptionRequest: candidate }, status: 'COMPLETED', add_time: now });
  add('order_notification_delivery', { id: 41, outbox_id: 42, event_key: key, order_id: null, withdrawal_id: null, subject_domain: 'membership', subject_id: 18, user_id: 11,
    notice_mark: 'order_pay_success', channel: 'wechat_routine', target: delivery.target, template_code: delivery.templateCode,
    payload, status: 'UNKNOWN', add_time: now, ...options.row });
  const admitted = resign('delivery-attempt', a);
  add('routine_subscribe_attempt', admitted);
  if (options.resultCode !== undefined) add('routine_subscribe_result', sign('delivery-result', {
    result_id: mac('delivery-result-id', [admitted.attempt_id, admitted.signature]), attempt_id: admitted.attempt_id,
    payload: { format: 1 as const, purpose: 'routine_subscription_result' as const, scope, attemptSignature: admitted.signature,
      result: { code: options.resultCode, httpStatus: 200, rawDigest: 'a'.repeat(64), requestStartedAt: now + 1, verifiedAt: now + 2 } }, created_at: now + 3 }));
  return accumulator.finish(relations, 'b'.repeat(64));
}
function original(domain: 'store_order' | 'membership'): RoutineOriginalEvidence {
  const digest = (purpose: string, value: unknown) => createHmac('sha256', env.APP_KEY)
    .update(`cinashop.routine.original-payment.${purpose}.v1\0`)
    .update(JSON.stringify(value, (_k, row) => row && typeof row === 'object' && !Array.isArray(row)
      ? Object.fromEntries(Object.keys(row).sort().map(k => [k, row[k]])) : row)).digest('hex');
  const observationBody = { format: 1 as const, purpose: 'routine_provider_original' as const, source: 'callback' as const,
    sourceId: 'synthetic_membership_notice_callback', facts: { appId: 'wx_owned_a', merchantId: '12345', orderNo: 'hy_membership18',
      transactionId: 'wx_member_transaction', amountCents: 700, currency: 'CNY' as const, tradeState: 'SUCCESS' as const,
      tradeType: 'JSAPI' as const, payerId: 'different_payment_payer', providerEventTime: now - 2 },
    verifiedAt: now - 1, verifierKey: 'synthetic_local_codec', responseDigest: 'a'.repeat(64) };
  const observation = { ...observationBody, signature: digest('provider-observation', observationBody) };
  const body = { evidence_id: digest('evidence-key', [observation.source, observation.sourceId]), order_no: observation.facts.orderNo,
    transaction_id: observation.facts.transactionId, source: observation.source, source_id: observation.sourceId, format_version: 1 as const,
    payload: { format: 1 as const, binding: { state: 'bound' as const, local: { domain, orderId: 18, buyerUid: 11, orderNo: 'hy_membership18',
      amountCents: 700, paid: 1, payType: 'weixin', tradeNo: 'wx_member_transaction' } }, sourceDigest: 'b'.repeat(64), observation }, created_at: now - 1 };
  return { ...body, signature: digest('evidence-record', body) };
}
describe('format8 membership settled subscription evidence', () => {
  it('authenticates a distinct membership subject, fresh settlement nonce and owner', () => {
    const r = request(); expect(parseRoutineSubscriptionMembershipRequest(env, r, scope)).toEqual(r);
    expect(r.body.domain).toBe('membership'); expect(r.body.settlementNonce).toBe(uuid(2)); expect(r.selection.openid).toBe('uid_owner_not_payer');
  });
  it.each(['settlementNonce', 'vipDay', 'overdueTime', 'orderId', 'userId', 'payPrice'] as const)('rejects an unsigned body mutation of %s', field => {
    const raw = request(), body = { ...raw.body, [field]: typeof raw.body[field] === 'number' ? Number(raw.body[field]) + 1 : 'changed' };
    expect(() => parseRoutineSubscriptionMembershipRequest(env, { ...raw, body }, scope)).toThrow();
  });
  it('requires its independent request HMAC domain and exact SQL scope', () => {
    expect(() => parseRoutineSubscriptionMembershipRequest(env, resign('notice-request', request()), scope)).toThrow();
    expect(() => parseRoutineSubscriptionMembershipRequest(env, request(), { ...scope, maintenanceOid: '107' })).toThrow();
  });
  it('does not admit extra fields, ordinary keys, guests or an unavailable sentinel', () => {
    const r = request();
    for (const raw of [{ ...r, extra: true }, { ...r, eventKey: 'order.pay.success.notice:18' }, { ...r, body: { ...r.body, userId: 0 } }, { format: 8, unavailable: true }])
      expect(() => parseRoutineSubscriptionMembershipRequest(env, raw, scope)).toThrow();
  });
  it('copies and deeply freezes decoded selection and body without freezing caller input', () => {
    const raw = request(), parsed = parseRoutineSubscriptionMembershipRequest(env, raw, scope);
    expect(Object.isFrozen(parsed.body)).toBe(true); expect(Object.isFrozen(parsed.selection)).toBe(true); expect(Object.isFrozen(raw)).toBe(false);
    raw.body.storeName = 'later'; expect(parsed.body.storeName).toBe('购买会员卡');
  });
  it('does not execute getters or toJSON while validating historical candidates', () => {
    let calls = 0; const raw = request(); Object.defineProperty(raw.selection, 'appId', { enumerable: true, get() { calls++; return 'wx_owned_a'; } });
    expect(() => parseRoutineSubscriptionMembershipRequest(env, raw, scope)).toThrow();
    const other = intent(); Object.setPrototypeOf(other.request.data, { toJSON() { calls++; return {}; } });
    expect(() => parseRoutineSubscriptionNoticeIntent(env, other, scope)).toThrow(); expect(calls).toBe(0);
  });
  it('renders the exact 1927 fields, amount suffix and China second precision', () => {
    expect(renderMembershipSubscriptionData(request().body)).toEqual({ character_string1: 'hy_membership18', amount2: '7.00元', date3: '2023-11-15 06:13:20' });
    expect(renderMembershipSubscriptionData({ ...request().body, kind: 'free-claim', storeName: '免费领取会员卡', payPrice: '0.00' }).amount2).toBe('0.00元');
  });
  it('authenticates membership 1927 stage through both membership and shared decoders without inventing payment approval', () => {
    const raw = intent(); expect(parseRoutineSubscriptionMembershipIntent(env, raw, scope)).toEqual(raw);
    expect(parseRoutineSubscriptionNoticeIntent(env, raw, scope)).toEqual(raw);
    expect('approvedUseDigest' in raw.source.payment).toBe(false);
  });
  it('keeps real-original and unique-identity payment facts explicit and closed', () => {
    const raw = intent(), facts = { ...raw.source, payment: { kind: 'routine-original', evidenceId: 'real_original_17', evidenceSignature: 'a'.repeat(64),
      relatedDigest: 'b'.repeat(64), approvedUseDigest: 'c'.repeat(64) } };
    expect(captureMembershipSubscriptionFacts(facts).payment.kind).toBe('routine-original');
    expect(() => captureMembershipSubscriptionFacts({ ...raw.source, payment: { ...raw.source.payment, approvedUseDigest: 'a'.repeat(64) } })).toThrow();
  });
  it('rejects a 1458-only policy, different stage MAC or wrong template', () => {
    const raw = intent(), p = raw.policy;
    const wrongPolicy = resign('account-policy', { ...p, payload: { ...p.payload, data: { ...p.payload.data, templates: [{ mark: '1458', templateId: 'owned_pay_template' }] } } });
    expect(() => parseRoutineSubscriptionMembershipIntent(env, resign('membership-notice-stage', { ...raw, policy: wrongPolicy }), scope)).toThrow();
    expect(() => parseRoutineSubscriptionMembershipIntent(env, resign('notice-stage', raw), scope)).toThrow();
    expect(() => parseRoutineSubscriptionMembershipIntent(env, resign('membership-notice-stage', { ...raw, request: { ...raw.request, template_id: 'unapproved' } }), scope)).toThrow();
  });
  it('admits immutable attempts through the existing dispatch codec with only key-matched 1927 facts', () => {
    const raw = attempt(); expect(parseRoutineSubscriptionAttemptForActor(env, raw, scope, actor)).toEqual(raw);
    expect(() => parseRoutineSubscriptionAttemptForActor(env, resign('delivery-attempt', { ...raw,
      payload: { ...raw.payload, facts: { ...raw.payload.facts, templateMark: '1458' } } }), scope, actor)).toThrow();
  });
  it('routes malformed paid prefixes to fail-closed authority without accepting malformed keys', () => {
    expect(routineSubscriptionNoticeKey(key)).toBe(true); expect(routineSubscriptionNoticeKey('membership.pay.success.notice:0')).toBe(false);
    expect(routineSubscriptionNoticePrefix('membership.pay.success.notice:bad')).toBe(true);
  });
  it('classifies authenticated membership balance history without fabricating an original-payment reference or send authority', () => {
    const report = continuation();
    expect(report.outboxes).toMatchObject([{ format: 8, state: 'authenticated_source_match' }]);
    expect(report.deliveries).toMatchObject([{ staging: 'authenticated_source_match', original: 'not_applicable', originalRecordDigest: null,
      dispatch: 'unknown', intentMatches: true }]);
    expect(report.attempts).toMatchObject([{ authenticity: 'authenticated', original: 'not_applicable', originalRecordDigest: null, result: 'unknown' }]);
    expect(report).toMatchObject({ activationAllowed: false, permitIssued: false, switchCommissioned: false, subscriptionSendAuthorized: false,
      currentBusinessEligibility: 'not_evaluated', credentials: 'not_evaluated', catalogCommissioning: 'not_evaluated', externalSourcesIncluded: false });
  });
  it('uses only the actual original variant reference for historical WX payment notices', () => {
    const raw = request(); raw.selection.mode = 'routine-original'; raw.body.payType = 'weixin'; raw.body.tradeNo = 'wx_member_transaction'; const r = resign('membership-notice-request', raw), stage = intent();
    stage.requestSignature = r.signature; stage.source.payment = { kind: 'routine-original', evidenceId: 'synthetic_missing_original',
      evidenceSignature: 'a'.repeat(64), relatedDigest: 'b'.repeat(64), approvedUseDigest: 'c'.repeat(64) };
    const report = continuation(r, resign('membership-notice-stage', stage));
    expect(report.deliveries).toMatchObject([{ staging: 'authenticated_source_match', original: 'missing', originalRecordDigest: null }]);
    expect(report.attempts).toMatchObject([{ authenticity: 'authenticated', original: 'missing', originalRecordDigest: null }]);
    expect(report.subscriptionSendAuthorized).toBe(false);
  });
  it('keeps a signed paid stage with a different frozen selection mismatched in the six-root draft', () => {
    const stage = intent(); stage.source.bindingId++;
    const report = continuation(request(), resign('membership-notice-stage', stage));
    expect(report.deliveries).toMatchObject([{ staging: 'authenticated_source_mismatch', source: 'unresolved', original: 'not_applicable' }]);
    expect(report.subscriptionSendAuthorized).toBe(false);
  });
  it('requires canonical free versus priced membership snapshots and explicit payment selection', () => {
    const original = request(), free = { ...original, body: { ...original.body, kind: 'free-claim', storeName: '免费领取会员卡', payPrice: '0.00' } };
    expect(parseRoutineSubscriptionMembershipRequest(env, resign('membership-notice-request', free), scope).body.kind).toBe('free-claim');
    for (const body of [{ ...free.body, kind: 'card-redeem' }, { ...free.body, domain: 'store_order' }, { ...free.body, tradeNo: 'invented' },
      { ...request().body, payPrice: '0.00' }, { ...request().body, storeName: '卡密领取会员卡' }])
      expect(() => parseRoutineSubscriptionMembershipRequest(env, resign('membership-notice-request', { ...request(), body }), scope)).toThrow();
    const wx = request(); wx.body.payType = 'weixin'; wx.body.tradeNo = 'wx_member_transaction';
    expect(() => parseRoutineSubscriptionMembershipRequest(env, resign('membership-notice-request', wx), scope)).toThrow();
  });
  it('requires explicit membership facts and refuses ordinary original root or fake unique Weixin facts', () => {
    const f = intent().source;
    for (const facts of [{ ...f, subjectDomain: 'store_order' }, { ...f, rootId: 17 }, { ...f, payment: { kind: 'unique-identity', payType: 'weixin', paymentDigest: 'd'.repeat(64) } }])
      expect(() => captureMembershipSubscriptionFacts(facts)).toThrow();
  });
  it('references a membership original only, even when an ordinary original has the same numeric subject', () => {
    const raw = request(); raw.body.payType = 'weixin'; raw.body.tradeNo = 'wx_member_transaction'; raw.selection.mode = 'routine-original';
    const r = resign('membership-notice-request', raw);
    for (const domain of ['membership', 'store_order'] as const) {
      const provider = original(domain), staged = intent(); staged.requestSignature = r.signature;
      staged.source.payment = { kind: 'routine-original', evidenceId: provider.evidence_id, evidenceSignature: provider.signature,
        relatedDigest: 'b'.repeat(64), approvedUseDigest: 'c'.repeat(64) };
      const report = continuation(r, resign('membership-notice-stage', staged), r, { original: provider });
      expect(report.deliveries[0]!.original).toBe(domain === 'membership' ? 'matched' : 'mismatch');
      expect(report.attempts[0]!.original).toBe(domain === 'membership' ? 'matched' : 'mismatch');
      expect(report.subscriptionSendAuthorized).toBe(false);
    }
  });
  it.each([{ subject_domain: 'order' }, { subject_id: 19 }, { order_id: 18 }])('keeps a valid signed membership stage mismatched for wrong physical subject %j', row => {
    expect(continuation(request(), intent(), request(), { row }).deliveries[0]!.staging).toBe('authenticated_source_mismatch');
  });
  it('does not treat a legacy delivery layout as commissioned membership subject metadata', () => {
    expect(continuation(request(), intent(), request(), { legacyLayout: true }).deliveries[0]!.staging).toBe('authenticated_source_mismatch');
  });
  it('retains an authenticated accepted membership result when mutable status still says UNKNOWN', () => {
    const report = continuation(request(), intent(), request(), { resultCode: 0 });
    expect(report.results).toMatchObject([{ state: 'verified_accepted' }]);
    expect(report.deliveries).toMatchObject([{ dispatch: 'accepted', currentProjection: 'drifted', intentMatches: true }]);
    expect(report.subscriptionSendAuthorized).toBe(false);
  });
  it.each(['55P03', '57014', '40001', '40P01'] as const)('recognizes only bounded pre-attempt database state %s for a separately proved safe retry', code => {
    expect(membershipSubscriptionTransientSqlState(Object.assign(Error('synthetic SQL failure'), { code }))).toBe(code);
    expect(membershipSubscriptionTransientSqlState(Error('synthetic query wrapper', { cause: Object.assign(Error('database'), { code }) }))).toBe(code);
  });
  it('does not grant a SQL retry for permissions, unknown errors, getter state, cycles or excess cause depth', () => {
    for (const error of [Object.assign(Error('permission'), { code: '42501' }), Object.assign(Error('unique'), { code: '23505' }),
      Error('no code'), { code: 'ECONNRESET', cause: { code: '55P03' } }, { code: 57014 }, { code: '55P03;anything' }])
      expect(membershipSubscriptionTransientSqlState(error)).toBeNull();
    let calls = 0; const getter = Object.defineProperty({}, 'code', { get() { calls++; return '55P03'; } });
    expect(membershipSubscriptionTransientSqlState(getter)).toBeNull(); expect(calls).toBe(0);
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle; expect(membershipSubscriptionTransientSqlState(cycle)).toBeNull();
    let deep: unknown = { code: '55P03' }; for (let i = 0; i < 6; i++) deep = { cause: deep };
    expect(membershipSubscriptionTransientSqlState(deep)).toBeNull();
  });
  it('recognizes a format8 unavailable marker without misclassifying it as another notice', () => {
    expect(continuation(request(), intent(), { format: 8, unavailable: true }).outboxes).toMatchObject([{ format: null, state: 'unavailable' }]);
  });
});
