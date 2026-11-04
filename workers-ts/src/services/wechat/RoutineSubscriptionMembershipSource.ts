/** Format-8 authenticates actual other_order settlement, never an ordinary order alias. */
import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { storeOrderOutbox, orderNotificationDelivery } from '@/models/schema';
import { captureMembershipPaidNoticeBusiness, membershipPaidNoticeEventKey, type MembershipPaidNoticeBusiness } from '@/services/order/MembershipPaidNoticeCodec';
import { readMembershipPaidSettlementTx } from '@/services/order/MembershipPaidNoticeSource';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { parseRoutineIdentityOwnership, parseRoutineIdentityWitness, type RoutineIdentityOwnershipRow, type RoutineIdentityWitnessRow } from './RoutineIdentityEvidenceCodec';
import { readRoutineIdentityOwnerForUidTx } from './RoutineIdentityOwnership';
import { readRoutineSubscriptionMembershipOriginalTx } from './RoutineSubscriptionOriginal';
import { assertNativeAppExcludedForRoutineMembershipSubscriptionTx } from './NativeAppRoutineSubscriptionAuthority';
import { assertRoutineSubscriptionDeliveryReadyTx } from '@/migrations/routineSubscriptionDelivery';
import { prepareMembershipPaidNoticeTx } from '@/migrations/membershipPaidNotice';
import { prepareRoutineSubscriptionAccountTx, routineSubscriptionClockTx, routineSubscriptionScopeTx, freezeSubscription } from './RoutineSubscriptionAccount';
import { MEMBERSHIP_SUBSCRIPTION_EVENT, membershipSubscriptionMac as mac, membershipSubscriptionSame as same,
  membershipSubscriptionUnavailable as unavailable, parseRoutineSubscriptionMembershipRequest, parseRoutineSubscriptionMembershipIntent,
  renderMembershipSubscriptionData, type MembershipSubscriptionSelection, type RoutineSubscriptionMembershipNoticeFacts, type MembershipSubscriptionPayment } from './RoutineSubscriptionMembershipEvidenceCodec';

const bodyKeys = ['format', 'domain', 'settlementNonce', 'orderId', 'orderNo', 'userId', 'kind', 'memberType', 'vipDay', 'isPermanent', 'overdueTime',
  'payType', 'payPrice', 'payTime', 'tradeNo', 'phone', 'sendName', 'storeName', 'occurredAt'];
export function captureMembershipSubscriptionBody(value: unknown): MembershipPaidNoticeBusiness {
  if (!value || typeof value !== 'object' || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...bodyKeys, 'routineSubscriptionRequest'].includes(key))) return unavailable();
  const ds = Object.getOwnPropertyDescriptors(value), copy: Record<string, unknown> = {};
  for (const key of bodyKeys) { const d = ds[key]; if (!d?.enumerable || !('value' in d)) return unavailable(); copy[key] = d.value; }
  return captureMembershipPaidNoticeBusiness(copy);
}
const cents = (value: string) => /^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(value) ? BigInt(value.replace('.', '')) : unavailable();
/** Candidate-only reads do not acquire lower maintenance or identity gates after settlement locks. */
export async function readMembershipSubscriptionSettlementTx(tx: DbClient, env: Pick<Env, 'APP_KEY'>, body: MembershipPaidNoticeBusiness) {
  for (const table of ['other_order', 'store_order_outbox', 'wechat_user', 'user', 'routine_identity_ownership', 'routine_identity_witness']) {
    const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.' + table}) AS ready`);
    if (r?.ready !== true) return unavailable();
  }
  const source = await readMembershipPaidSettlementTx(tx, env, body), root = source.order;
  const ids = await tx.execute<{ domain: string; id: number }>(sql`SELECT 'store_order' AS domain,id FROM public.store_order
    WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo})
    UNION ALL SELECT 'recharge',id FROM public.user_recharge WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo})
    UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo}) LIMIT 66`);
  if (ids.length !== 1 || ids[0].domain !== 'membership' || ids[0].id !== root.id) return unavailable();
  const payment = { id: root.id, uid: root.uid, orderNo: root.orderId, type: root.type, paid: root.paid, payType: root.payType,
    payPrice: root.payPrice, payTime: root.payTime, tradeNo: root.tradeNo, memberType: root.memberType, isFree: root.isFree,
    isPermanent: root.isPermanent, vipDay: root.vipDay, overdueTime: root.overdueTime, isDel: root.isDel };
  return { root, original: body.payType === 'weixin',
    settlementDigest: mac(env, 'membership-notice-settlement', [source.event.id, source.event.eventKey, source.event.payload, source.event.addTime, payment]),
    paymentDigest: mac(env, 'membership-notice-payment', payment) };
}

export async function selectMembershipSubscriptionOwnerTx(tx: DbClient, env: Pick<Env, 'APP_KEY'>,
  source: Awaited<ReturnType<typeof readMembershipSubscriptionSettlementTx>>, fresh = false): Promise<MembershipSubscriptionSelection> {
  const { root, original } = source;
  const rows = await tx.execute<RoutineIdentityOwnershipRow>(sql`SELECT ownership_id,app_id,openid,uid,binding_id,observation_id,format_version,observed_at,created_at,signature
    FROM public.routine_identity_ownership WHERE uid=${root.uid} ORDER BY ownership_id LIMIT 65`);
  if (!rows.length || rows.length > 64 || Buffer.byteLength(JSON.stringify(rows), 'utf8') > 1048576) return unavailable();
  const owners = rows.map(row => ({ raw: row, owner: parseRoutineIdentityOwnership(env, row) }));
  let appId: string | undefined;
  if (original) {
    const evidence = await tx.execute(sql`SELECT * FROM public.routine_original_payment_evidence WHERE order_no=${root.orderId} OR transaction_id=${root.tradeNo} ORDER BY evidence_id LIMIT 65`);
    if (!evidence.length || evidence.length > 64 || Buffer.byteLength(JSON.stringify(evidence), 'utf8') > 1048576) return unavailable();
    const decoded = Array.from(evidence, row => parseRoutineOriginalEvidence(env, row));
    for (const row of decoded) {
      const binding = row.payload.binding, facts = row.payload.observation.facts;
      if (binding.state !== 'bound' || binding.local.domain !== 'membership' || binding.local.orderId !== root.id || binding.local.buyerUid !== root.uid
        || facts.orderNo !== root.orderId || facts.transactionId !== root.tradeNo || facts.tradeState !== 'SUCCESS' || facts.tradeType !== 'JSAPI'
        || BigInt(facts.amountCents) !== cents(root.payPrice) || appId !== undefined && appId !== facts.appId) return unavailable();
      appId = facts.appId;
    }
  }
  const bindings = await tx.execute<{ id: number; uid: number; openid: string }>(sql`SELECT id,uid,openid FROM public.wechat_user
    WHERE uid=${root.uid} AND user_type='routine' AND is_del=0 ORDER BY id LIMIT 65`);
  if (!bindings.length || bindings.length > 64 || Buffer.byteLength(JSON.stringify(bindings), 'utf8') > 1048576) return unavailable();
  const active = owners.filter(({ owner }) => bindings.some(binding => binding.id === owner.bindingId && binding.uid === owner.uid && binding.openid === owner.openid));
  // A non-provider payment has no intended AppID witness: every live binding
  // must be explicitly mapped and there must be exactly one active subject.
  const eligible = original ? active.filter(({ owner }) => owner.appId === appId) : active;
  if (eligible.length !== 1 || !original && (bindings.length !== 1 || active.length !== bindings.length)) return unavailable();
  const selected = eligible[0], owner = selected.owner;
  const witnessRows = await tx.execute<RoutineIdentityWitnessRow>(sql`SELECT observation_id,uid,binding_id,format_version,observation,created_at,signature
    FROM public.routine_identity_witness WHERE observation_id=${owner.observationId}::uuid LIMIT 2`);
  if (witnessRows.length !== 1) return unavailable();
  const witness = parseRoutineIdentityWitness(env, witnessRows[0]);
  if (witness.uid !== owner.uid || witness.bindingId !== owner.bindingId || witness.observation.appId !== owner.appId
    || witness.observation.openid !== owner.openid || witness.observation.observedAt !== owner.observedAt) return unavailable();
  if (fresh) {
    const live = await readRoutineIdentityOwnerForUidTx(tx, env, { uid: root.uid, appId: owner.appId });
    if (!live || !same(live.owner, owner) || !same(live.witness, witness)) return unavailable();
  }
  return freezeSubscription({ mode: original ? 'routine-original' as const : 'unique-owner' as const, appId: owner.appId,
    ownershipId: owner.ownershipId, bindingId: owner.bindingId, observationId: owner.observationId, openid: owner.openid,
    ownershipDigest: mac(env, 'membership-notice-owner', [selected.raw, witnessRows[0]]) });
}
export type RoutineSubscriptionMembershipDelivery = typeof orderNotificationDelivery.$inferSelect & { subjectDomain: 'membership'; subjectId: number };
export async function readRoutineSubscriptionMembershipDeliveryTx(tx: DbClient, id: number): Promise<RoutineSubscriptionMembershipDelivery | undefined> {
  const [row] = await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, id)).limit(1).for('share', { noWait: true });
  if (!row) return;
  const rows = await tx.execute<{ subjectDomain: string; subjectId: number }>(sql`SELECT subject_domain AS "subjectDomain",subject_id AS "subjectId"
    FROM public.order_notification_delivery WHERE id=${id} LIMIT 2`);
  const subject = rows[0];
  if (rows.length !== 1 || subject.subjectDomain !== 'membership' || row.orderId !== null || row.withdrawalId !== null
    || !Number.isSafeInteger(subject.subjectId) || subject.subjectId <= 0) return unavailable();
  return { ...row, subjectDomain: 'membership', subjectId: subject.subjectId };
}
function immutableDelivery(row: RoutineSubscriptionMembershipDelivery) {
  return { id: row.id, outboxId: row.outboxId, eventKey: row.eventKey, orderId: row.orderId, withdrawalId: row.withdrawalId,
    subjectDomain: row.subjectDomain, subjectId: row.subjectId, userId: row.userId, noticeMark: row.noticeMark, channel: row.channel,
    target: row.target, templateCode: row.templateCode, payload: row.payload, addTime: row.addTime };
}
/** Outer caller stabilizes maintenance gates before all physical source and identity locks. */
export async function readRoutineSubscriptionMembershipNoticeSourceTx(tx: DbClient, env: Env,
  expected: Readonly<{ outboxId: number; eventKey: string }> | Readonly<{ deliveryId: number; eventKey: string }>) {
  if (!await prepareMembershipPaidNoticeTx(tx) || !await assertRoutineSubscriptionDeliveryReadyTx(tx)) return unavailable();
  const author = 'outboxId' in expected;
  await tx.execute(sql`LOCK TABLE ONLY public.wechat_user IN SHARE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.other_order, ONLY public.store_order, ONLY public.user_recharge,
    ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const delivery = author ? undefined : await readRoutineSubscriptionMembershipDeliveryTx(tx, expected.deliveryId);
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, author ? expected.outboxId : delivery?.outboxId ?? 0)).limit(1).for('share', { noWait: true });
  if (!event || event.eventType !== MEMBERSHIP_SUBSCRIPTION_EVENT || event.aggregateType !== 'membership' || event.eventKey !== expected.eventKey) return unavailable();
  const body = captureMembershipSubscriptionBody(event.payload);
  if (event.eventKey !== membershipPaidNoticeEventKey(body.orderId) || event.aggregateId !== body.orderId || event.addTime !== body.occurredAt) return unavailable();
  const requestProof = parseRoutineSubscriptionMembershipRequest(env, (event.payload as unknown as { routineSubscriptionRequest?: unknown }).routineSubscriptionRequest, await routineSubscriptionScopeTx(tx));
  if (!same(requestProof.body, body) || requestProof.eventKey !== event.eventKey || requestProof.eventTime !== event.addTime) return unavailable();
  const source = await readMembershipSubscriptionSettlementTx(tx, env, body), selection = await selectMembershipSubscriptionOwnerTx(tx, env, source, true);
  if (!same(selection, requestProof.selection) || source.settlementDigest !== requestProof.settlementDigest || source.paymentDigest !== requestProof.paymentDigest) return unavailable();
  let payment: MembershipSubscriptionPayment;
  if (source.original) {
    const proof = await readRoutineSubscriptionMembershipOriginalTx(tx, env, { rootId: source.root.id, buyerUid: body.userId, orderNo: source.root.orderId,
      transactionId: source.root.tradeNo, totalAmount: Number(cents(source.root.payPrice)) });
    await assertNativeAppExcludedForRoutineMembershipSubscriptionTx(tx, env, proof);
    if (proof.evidence.payload.observation.facts.appId !== selection.appId) return unavailable();
    payment = { kind: 'routine-original', evidenceId: proof.evidence.evidence_id, evidenceSignature: proof.evidence.signature,
      relatedDigest: proof.relatedDigest, approvedUseDigest: proof.approvedUseDigest };
  } else {
    if (body.payType !== 'yue' && body.payType !== 'alipay') return unavailable();
    payment = { kind: 'unique-identity', payType: body.payType, paymentDigest: source.paymentDigest };
  }
  const account = await prepareRoutineSubscriptionAccountTx(tx, env, selection.appId, '1927');
  if (account.template.templateId.length > 100) return unavailable();
  const renderedAt = author ? await routineSubscriptionClockTx(tx) : delivery!.addTime, data = renderMembershipSubscriptionData(body);
  // Retain the actual VipUser -> sendOrderSuccess legacy link; the dedicated member helper is not called by PHP.
  const request = freezeSubscription({ touser: selection.openid, template_id: account.template.templateId,
    page: '/pages/goods/order_details/index?order_id=' + body.orderNo,
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { value }])) });
  if (!author) {
    if (!delivery || delivery.channel !== 'wechat_routine' || delivery.eventKey !== event.eventKey || delivery.subjectId !== body.orderId || delivery.userId !== body.userId
      || delivery.noticeMark !== 'order_pay_success' || delivery.target !== selection.openid || delivery.templateCode !== account.template.templateId
      || !['PENDING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'].includes(delivery.status) || delivery.payload.kind !== 'wechat_routine'
      || !same(delivery.payload.data, data) || delivery.payload.url !== request.page || delivery.payload.routineAppId !== selection.appId) return unavailable();
    const intent = parseRoutineSubscriptionMembershipIntent(env, delivery.payload.routineSubscriptionIntent, await routineSubscriptionScopeTx(tx));
    if (intent.deliveryId !== delivery.id || intent.outboxId !== event.id || intent.requestSignature !== requestProof.signature
      || intent.createdAt !== delivery.addTime || !same(intent.request, request) || intent.source.settlementDigest !== source.settlementDigest
      || intent.source.ownershipDigest !== selection.ownershipDigest || intent.source.settlementNonce !== body.settlementNonce
      || !same(intent.source.payment, payment)) return unavailable();
  }
  const facts: RoutineSubscriptionMembershipNoticeFacts = { deliveryId: delivery?.id ?? 0, outboxId: event.id, eventKey: event.eventKey, orderId: body.orderId,
    rootId: body.orderId, buyerUid: body.userId, subjectDomain: 'membership', appId: selection.appId, ownershipId: selection.ownershipId,
    bindingId: selection.bindingId, observationId: selection.observationId, templateMark: '1927', settlementNonce: body.settlementNonce,
    settlementDigest: source.settlementDigest, ownershipDigest: selection.ownershipDigest, payment, sourceDigest: '' };
  facts.sourceDigest = mac(env, author ? 'membership-notice-author-source' : 'membership-notice-delivery-source',
    [facts, body, event.payload, delivery ? immutableDelivery(delivery) : null, selection, account.account, request]);
  const [tail] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
    AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${account.account.payload.data.validUntil}) AS ready`);
  if (tail?.ready !== true) return unavailable();
  return { facts: freezeSubscription(facts), account, request, renderedAt, requestSignature: requestProof.signature };
}
