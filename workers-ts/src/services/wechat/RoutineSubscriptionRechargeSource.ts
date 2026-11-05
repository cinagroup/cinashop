/** Format-9 authenticates actual user_recharge settlement, never an ordinary order alias. */
import { Buffer } from 'node:buffer';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { storeOrderOutbox, orderNotificationDelivery } from '@/models/schema';
import { captureRechargePaidNoticeBusiness, rechargePaidNoticeEventKey, RECHARGE_PAID_NOTICE_KEYS, type RechargePaidNoticeBusiness } from '@/services/order/RechargePaidNoticeCodec';
import { readRechargePaidSettlementTx } from '@/services/order/RechargePaidNoticeSource';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { parseRoutineIdentityOwnership, parseRoutineIdentityWitness, type RoutineIdentityOwnershipRow, type RoutineIdentityWitnessRow } from './RoutineIdentityEvidenceCodec';
import { readRoutineIdentityOwnerForUidTx } from './RoutineIdentityOwnership';
import { readRoutineSubscriptionRechargeOriginalTx } from './RoutineSubscriptionOriginal';
import { assertNativeAppExcludedForRoutineRechargeSubscriptionTx } from './NativeAppRoutineSubscriptionAuthority';
import { assertRoutineSubscriptionDeliveryReadyTx } from '@/migrations/routineSubscriptionDelivery';
import { prepareRechargePaidNoticeTx } from '@/migrations/rechargePaidNotice';
import { prepareRoutineSubscriptionAccountTx, routineSubscriptionClockTx, routineSubscriptionScopeTx, freezeSubscription } from './RoutineSubscriptionAccount';
import { RECHARGE_SUBSCRIPTION_EVENT, rechargeSubscriptionMac as mac, rechargeSubscriptionSame as same,
  rechargeSubscriptionUnavailable as unavailable, parseRoutineSubscriptionRechargeRequest, parseRoutineSubscriptionRechargeIntent,
  renderRechargeSubscriptionData, type RechargeSubscriptionSelection, type RoutineSubscriptionRechargeNoticeFacts, type RechargeSubscriptionPayment } from './RoutineSubscriptionRechargeEvidenceCodec';

const bodyKeys = RECHARGE_PAID_NOTICE_KEYS;
export function captureRechargeSubscriptionBody(value: unknown): RechargePaidNoticeBusiness {
  if (!value || typeof value !== 'object' || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...bodyKeys, 'routineSubscriptionRequest'].includes(key))) return unavailable();
  const ds = Object.getOwnPropertyDescriptors(value), copy: Record<string, unknown> = {};
  for (const key of bodyKeys) { const d = ds[key]; if (!d?.enumerable || !('value' in d)) return unavailable(); copy[key] = d.value; }
  return captureRechargePaidNoticeBusiness(copy);
}
const cents = (value: string) => /^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(value) ? BigInt(value.replace('.', '')) : unavailable();
/** Candidate-only reads do not acquire lower maintenance or identity gates after settlement locks. */
export async function readRechargeSubscriptionSettlementTx(tx: DbClient, env: Pick<Env, 'APP_KEY'>, body: RechargePaidNoticeBusiness) {
  for (const table of ['user_recharge', 'user_bill', 'store_order_outbox', 'wechat_user', 'user', 'routine_identity_ownership', 'routine_identity_witness']) {
    const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.' + table}) AS ready`);
    if (r?.ready !== true) return unavailable();
  }
  const source = await readRechargePaidSettlementTx(tx, env, body), root = source.order;
  const ids = await tx.execute<{ domain: string; id: number }>(sql`SELECT 'store_order' AS domain,id FROM public.store_order
    WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo})
    UNION ALL SELECT 'recharge',id FROM public.user_recharge WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo})
    UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo}) LIMIT 66`);
  if (ids.length !== 1 || ids[0].domain !== 'recharge' || ids[0].id !== root.id) return unavailable();
  const payment = { id:root.id,uid:root.uid,orderNo:root.orderId,paid:root.paid,payType:root.rechargeType,
    payPrice:root.price,payTime:root.payTime,tradeNo:root.tradeNo,giftPrice:root.givePrice,creationTime:root.addTime };
  return { root, original: body.payType === 'weixin',
    settlementDigest: mac(env, 'recharge-notice-settlement', [source.event.id, source.event.eventKey, source.event.payload, source.event.addTime, payment]),
    paymentDigest: mac(env, 'recharge-notice-payment', payment) };
}

export async function selectRechargeSubscriptionOwnerTx(tx: DbClient, env: Pick<Env, 'APP_KEY'>,
  source: Awaited<ReturnType<typeof readRechargeSubscriptionSettlementTx>>, fresh = false): Promise<RechargeSubscriptionSelection> {
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
      if (binding.state !== 'bound' || binding.local.domain !== 'recharge' || binding.local.orderId !== root.id || binding.local.buyerUid !== root.uid
        || facts.orderNo !== root.orderId || facts.transactionId !== root.tradeNo || facts.tradeState !== 'SUCCESS' || facts.tradeType !== 'JSAPI'
        || BigInt(facts.amountCents) !== cents(root.price) || appId !== undefined && appId !== facts.appId) return unavailable();
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
    ownershipDigest: mac(env, 'recharge-notice-owner', [selected.raw, witnessRows[0]]) });
}
export type RoutineSubscriptionRechargeDelivery = typeof orderNotificationDelivery.$inferSelect & { subjectDomain: 'recharge'; subjectId: number };
export async function readRoutineSubscriptionRechargeDeliveryTx(tx: DbClient, id: number): Promise<RoutineSubscriptionRechargeDelivery | undefined> {
  const [row] = await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, id)).limit(1).for('share', { noWait: true });
  if (!row) return;
  const rows = await tx.execute<{ subjectDomain: string; subjectId: number }>(sql`SELECT subject_domain AS "subjectDomain",subject_id AS "subjectId"
    FROM public.order_notification_delivery WHERE id=${id} LIMIT 2`);
  const subject = rows[0];
  if (rows.length !== 1 || subject.subjectDomain !== 'recharge' || row.orderId !== null || row.withdrawalId !== null
    || !Number.isSafeInteger(subject.subjectId) || subject.subjectId <= 0) return unavailable();
  return { ...row, subjectDomain: 'recharge', subjectId: subject.subjectId };
}
function immutableDelivery(row: RoutineSubscriptionRechargeDelivery) {
  return { id: row.id, outboxId: row.outboxId, eventKey: row.eventKey, orderId: row.orderId, withdrawalId: row.withdrawalId,
    subjectDomain: row.subjectDomain, subjectId: row.subjectId, userId: row.userId, noticeMark: row.noticeMark, channel: row.channel,
    target: row.target, templateCode: row.templateCode, payload: row.payload, addTime: row.addTime };
}
/** Outer caller stabilizes maintenance gates before all physical source and identity locks. */
export async function readRoutineSubscriptionRechargeNoticeSourceTx(tx: DbClient, env: Env,
  expected: Readonly<{ outboxId: number; eventKey: string }> | Readonly<{ deliveryId: number; eventKey: string }>) {
  if (!await prepareRechargePaidNoticeTx(tx) || !await assertRoutineSubscriptionDeliveryReadyTx(tx)) return unavailable();
  const author = 'outboxId' in expected;
  await tx.execute(sql`LOCK TABLE ONLY public.wechat_user IN SHARE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.other_order, ONLY public.store_order, ONLY public.user_recharge,
    ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const delivery = author ? undefined : await readRoutineSubscriptionRechargeDeliveryTx(tx, expected.deliveryId);
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, author ? expected.outboxId : delivery?.outboxId ?? 0)).limit(1).for('share', { noWait: true });
  if (!event || event.eventType !== RECHARGE_SUBSCRIPTION_EVENT || event.aggregateType !== 'recharge' || event.eventKey !== expected.eventKey) return unavailable();
  const body = captureRechargeSubscriptionBody(event.payload);
  if (event.eventKey !== rechargePaidNoticeEventKey(body.orderId) || event.aggregateId !== body.orderId || event.addTime !== body.occurredAt) return unavailable();
  const requestProof = parseRoutineSubscriptionRechargeRequest(env, (event.payload as unknown as { routineSubscriptionRequest?: unknown }).routineSubscriptionRequest, await routineSubscriptionScopeTx(tx));
  if (!same(requestProof.body, body) || requestProof.eventKey !== event.eventKey || requestProof.eventTime !== event.addTime) return unavailable();
  const source = await readRechargeSubscriptionSettlementTx(tx, env, body), selection = await selectRechargeSubscriptionOwnerTx(tx, env, source, true);
  if (!same(selection, requestProof.selection) || source.settlementDigest !== requestProof.settlementDigest || source.paymentDigest !== requestProof.paymentDigest) return unavailable();
  let payment: RechargeSubscriptionPayment;
  if (source.original) {
    const proof = await readRoutineSubscriptionRechargeOriginalTx(tx, env, { rootId: source.root.id, buyerUid: body.userId, orderNo: source.root.orderId,
      transactionId: source.root.tradeNo, totalAmount: Number(cents(source.root.price)) });
    await assertNativeAppExcludedForRoutineRechargeSubscriptionTx(tx, env, proof);
    if (proof.evidence.payload.observation.facts.appId !== selection.appId) return unavailable();
    payment = { kind: 'routine-original', evidenceId: proof.evidence.evidence_id, evidenceSignature: proof.evidence.signature,
      relatedDigest: proof.relatedDigest, approvedUseDigest: proof.approvedUseDigest };
  } else {
    if (body.payType !== 'alipay') return unavailable();
    payment = { kind: 'unique-identity', payType: body.payType, paymentDigest: source.paymentDigest };
  }
  const account = await prepareRoutineSubscriptionAccountTx(tx, env, selection.appId, '755');
  if (account.template.templateId.length > 100) return unavailable();
  const renderedAt = author ? await routineSubscriptionClockTx(tx) : delivery!.addTime, data = renderRechargeSubscriptionData(body);
  // PHP recharge-success is the bill page; date5 remains the captured author occurrence.
  const request = freezeSubscription({ touser: selection.openid, template_id: account.template.templateId,
    page: '/pages/users/user_bill/index?type=2',
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { value }])) });
  if (!author) {
    if (!delivery || delivery.channel !== 'wechat_routine' || delivery.eventKey !== event.eventKey || delivery.subjectId !== body.orderId || delivery.userId !== body.userId
      || delivery.noticeMark !== 'recharge_success' || delivery.target !== selection.openid || delivery.templateCode !== account.template.templateId
      || !['PENDING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'].includes(delivery.status) || delivery.payload.kind !== 'wechat_routine'
      || !same(delivery.payload.data, data) || delivery.payload.url !== request.page || delivery.payload.routineAppId !== selection.appId) return unavailable();
    const intent = parseRoutineSubscriptionRechargeIntent(env, delivery.payload.routineSubscriptionIntent, await routineSubscriptionScopeTx(tx));
    if (intent.deliveryId !== delivery.id || intent.outboxId !== event.id || intent.requestSignature !== requestProof.signature
      || intent.createdAt !== delivery.addTime || !same(intent.request, request) || intent.source.settlementDigest !== source.settlementDigest
      || intent.source.ownershipDigest !== selection.ownershipDigest || intent.source.settlementNonce !== body.settlementNonce
      || !same(intent.source.payment, payment)) return unavailable();
  }
  const facts: RoutineSubscriptionRechargeNoticeFacts = { deliveryId: delivery?.id ?? 0, outboxId: event.id, eventKey: event.eventKey, orderId: body.orderId,
    rootId: body.orderId, buyerUid: body.userId, subjectDomain: 'recharge', appId: selection.appId, ownershipId: selection.ownershipId,
    bindingId: selection.bindingId, observationId: selection.observationId, templateMark: '755', settlementNonce: body.settlementNonce,
    settlementDigest: source.settlementDigest, ownershipDigest: selection.ownershipDigest, payment, sourceDigest: '' };
  facts.sourceDigest = mac(env, author ? 'recharge-notice-author-source' : 'recharge-notice-delivery-source',
    [facts, body, event.payload, delivery ? immutableDelivery(delivery) : null, selection, account.account, request]);
  const [tail] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
    AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${account.account.payload.data.validUntil}) AS ready`);
  if (tail?.ready !== true) return unavailable();
  return { facts: freezeSubscription(facts), account, request, renderedAt, requestSignature: requestProof.signature };
}
