/** Actual paid-order/UID authority for format 7. No current Mini configuration is read. */
import { Buffer } from 'node:buffer';
import { asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, orderNotificationDelivery } from '@/models/schema';
import { capturePaidNoticeAdmission, capturePaidNoticeBusiness, paidNoticeEventKey, type PaidNoticeBusiness } from '@/services/order/OrderPaidNoticeCodec';
import { parseRoutineOriginalEvidence } from '@/services/payment/RoutineOriginalPaymentEvidence';
import { parseRoutineIdentityOwnership, parseRoutineIdentityWitness, type RoutineIdentityOwnershipRow, type RoutineIdentityWitnessRow } from './RoutineIdentityEvidenceCodec';
import { readRoutineIdentityOwnerForUidTx } from './RoutineIdentityOwnership';
import { readRoutineSubscriptionOriginalTx } from './RoutineSubscriptionOriginal';
import { assertNativeAppExcludedForRoutineSubscriptionTx } from './NativeAppRoutineSubscriptionAuthority';
import { assertRoutineSubscriptionDeliveryReadyTx } from '@/migrations/routineSubscriptionDelivery';
import { prepareRoutineSubscriptionAccountTx, routineSubscriptionClockTx, routineSubscriptionScopeTx, freezeSubscription } from './RoutineSubscriptionAccount';
import { PAID_SUBSCRIPTION_EVENT, paidSubscriptionMac as mac, paidSubscriptionSame as same,
  paidSubscriptionUnavailable as unavailable, parseRoutineSubscriptionPaidRequest, parseRoutineSubscriptionPaidIntent,
  renderPaidSubscriptionData, type PaidSubscriptionSelection, type RoutineSubscriptionPaidNoticeFacts, type PaidSubscriptionPayment } from './RoutineSubscriptionPaidEvidenceCodec';

const bodyKeys = ['format', 'paymentEventId', 'paymentOrderId', 'paymentOrderNo', 'paymentAdmissionNonce', 'orderId', 'orderNo', 'userId',
  'payPrice', 'totalNum', 'phone', 'storeName', 'sendName', 'payTime', 'occurredAt'];
export function capturePaidSubscriptionBody(value: unknown): PaidNoticeBusiness {
  if (!value || typeof value !== 'object' || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...bodyKeys, 'routineSubscriptionRequest'].includes(key))) return unavailable();
  const ds = Object.getOwnPropertyDescriptors(value), copy: Record<string, unknown> = {};
  for (const key of bodyKeys) { const d = ds[key]; if (!d?.enumerable || !('value' in d)) return unavailable(); copy[key] = d.value; }
  return capturePaidNoticeBusiness(copy);
}
const cents = (value: string) => /^(?:0|[1-9]\d{0,9})\.\d{2}$/u.test(value) ? BigInt(value.replace('.', '')) : unavailable();
function paidOrder(row: typeof storeOrder.$inferSelect) {
  return { id: row.id, pid: row.pid, orderId: row.orderId, uid: row.uid, paid: row.paid, payType: row.payType,
    payPrice: row.payPrice, payTime: row.payTime, tradeNo: row.tradeNo, totalNum: row.totalNum,
    supplierId: row.supplierId };
}
export async function readPaidSubscriptionFamilyTx(tx: DbClient, env: Pick<Env, 'APP_KEY'>, body: PaidNoticeBusiness, fresh = false) {
  for (const table of ['store_order', 'store_order_cart_info', 'store_order_outbox', 'wechat_user', 'user', 'routine_identity_ownership', 'routine_identity_witness']) {
    const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.to_regclass(${table})=pg_catalog.to_regclass(${'public.' + table}) AS ready`);
    if (r?.ready !== true) return unavailable();
  }
  const query = tx.select().from(storeOrder).where(or(eq(storeOrder.id, body.paymentOrderId), eq(storeOrder.pid, body.paymentOrderId)))
    .orderBy(asc(storeOrder.id)).limit(66);
  const family = fresh ? await query.for('share', { noWait: true }) : await query;
  if (!family.length || family.length > 65 || Buffer.byteLength(JSON.stringify(family), 'utf8') > 1048576) return unavailable();
  const root = family.find(row => row.id === body.paymentOrderId), child = family.find(row => row.id === body.orderId);
  if (!root || !child || ![0, -1].includes(root.pid) || root.supplierAllocationStatus !== 2 || root.uid !== body.userId
    || root.orderId !== body.paymentOrderNo || root.paid !== 1 || root.payTime !== body.payTime || root.payTime <= 0) return unavailable();
  const leaves = root.pid === -1 ? family.filter(row => row.pid === root.id) : [root];
  if (root.pid === -1 ? leaves.length < 2 || child.pid !== root.id || family.length !== leaves.length + 1 : family.length !== 1 || child.id !== root.id) return unavailable();
  if (family.some(row => row.uid !== root.uid || row.paid !== 1 || row.payType !== root.payType || row.payTime !== root.payTime || row.tradeNo !== root.tradeNo
    || row.isDel !== 0 || row.isSystemDel !== 0 || row.supplierAllocationStatus === 1)) return unavailable();
  if (leaves.reduce((sum, row) => sum + cents(row.payPrice), 0n) !== cents(root.payPrice)
    || child.orderId !== body.orderNo || child.payPrice !== body.payPrice || child.totalNum !== body.totalNum
    || child.userPhone.trim() !== body.phone || child.realName !== body.sendName || child.payTime !== body.payTime) return unavailable();
  const cartQuery = tx.select().from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.oid, leaves.map(row => row.id))).orderBy(asc(storeOrderCartInfo.id)).limit(501);
  const carts = fresh ? await cartQuery.for('share', { noWait: true }) : await cartQuery;
  if (!carts.length || carts.length > 500 || Buffer.byteLength(JSON.stringify(carts), 'utf8') > 1048576) return unavailable();
  const names: string[] = [];
  for (const row of carts.filter(row => row.oid === child.id)) {
    if (!row.cartInfo) return unavailable();
    let value: unknown; try { value = JSON.parse(row.cartInfo); } catch { return unavailable(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
    const snapshot = value as Record<string, unknown>, product = snapshot.product ?? snapshot.productInfo;
    if (!product || typeof product !== 'object' || Array.isArray(product)) return unavailable();
    const title = (product as Record<string, unknown>).storeName ?? (product as Record<string, unknown>).store_name;
    if (typeof title !== 'string') return unavailable();
    names.push(title);
  }
  if (Array.from(names.join('|')).slice(0, 20).join('') !== body.storeName) return unavailable();
  const [paid] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, body.paymentEventId)).limit(1);
  if (!paid || paid.eventType !== 'order.paid' || paid.eventKey !== `order.paid:${root.id}` || paid.aggregateType !== 'order' || paid.aggregateId !== root.id
    || (fresh ? paid.status !== 'COMPLETED' : !['PROCESSING', 'COMPLETED'].includes(paid.status)) || paid.addTime > body.occurredAt) return unavailable();
  const p = paid.payload as unknown as Record<string, unknown>;
  if (!p || Reflect.ownKeys(p).length !== 3 || p.orderId !== root.id || p.orderNo !== root.orderId
    || capturePaidNoticeAdmission(p.payNoticeAdmission).nonce !== body.paymentAdmissionNonce) return unavailable();
  const ids = await tx.execute<{ domain: string; id: number }>(sql`SELECT 'store_order' AS domain,id FROM public.store_order
    WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo})
    UNION ALL SELECT 'recharge',id FROM public.user_recharge WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo})
    UNION ALL SELECT 'membership',id FROM public.other_order WHERE order_id=${root.orderId} OR (${root.tradeNo !== ''} AND trade_no=${root.tradeNo}) LIMIT 66`);
  if (!ids.length || ids.length > 65 || ids.some(r => r.domain !== 'store_order' || !family.some(order => order.id === r.id))
    || new Set(family.map(r => r.orderId)).size !== family.length) return unavailable();
  const familyDigest = mac(env, 'paid-notice-family', [family.map(paidOrder), carts.map(row => ({ id: row.id, oid: row.oid, cartId: row.cartId, cartNum: row.cartNum, cartInfo: row.cartInfo }))]);
  const paymentDigest = mac(env, 'paid-notice-payment', { id: paid.id, key: paid.eventKey, payload: paid.payload, addTime: paid.addTime, root: paidOrder(root) });
  return { root, child, familyDigest, paymentDigest, original: root.payType === 'weixin' && cents(root.payPrice) > 0n };
}

/** Candidate-only SELECTs authenticate signed ownership/witness bytes without
 * acquiring a lower maintenance gate after payment locks. Fresh send below
 * independently uses the commissioned identity reader and current live locks. */
export async function selectPaidSubscriptionOwnerTx(tx: DbClient, env: Pick<Env, 'APP_KEY'>,
  source: Awaited<ReturnType<typeof readPaidSubscriptionFamilyTx>>, fresh = false): Promise<PaidSubscriptionSelection> {
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
      if (binding.state !== 'bound' || binding.local.domain !== 'store_order' || binding.local.orderId !== root.id || binding.local.buyerUid !== root.uid
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
    ownershipDigest: mac(env, 'paid-notice-owner', [selected.raw, witnessRows[0]]) });
}
function immutableDelivery(row: typeof orderNotificationDelivery.$inferSelect) {
  return { id: row.id, outboxId: row.outboxId, eventKey: row.eventKey, orderId: row.orderId, withdrawalId: row.withdrawalId,
    userId: row.userId, noticeMark: row.noticeMark, channel: row.channel, target: row.target, templateCode: row.templateCode, payload: row.payload, addTime: row.addTime };
}
/** Caller first acquires the existing subscription/source maintenance gates. */
export async function readRoutineSubscriptionPaidNoticeSourceTx(tx: DbClient, env: Env,
  expected: Readonly<{ outboxId: number; eventKey: string }> | Readonly<{ deliveryId: number; eventKey: string }>) {
  if (!await assertRoutineSubscriptionDeliveryReadyTx(tx)) return unavailable();
  const author = 'outboxId' in expected;
  // Fence new bare/owned live bindings while proving whole-UID uniqueness.
  // Existing App UPDATE authority suffices; immutable ownership ACLs stay intact.
  await tx.execute(sql`LOCK TABLE ONLY public.wechat_user IN SHARE MODE NOWAIT`);
  await tx.execute(sql`LOCK TABLE ONLY public.store_order, ONLY public.store_order_cart_info, ONLY public.user_recharge, ONLY public.other_order,
    ONLY public.store_order_outbox, ONLY public.order_notification_delivery IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  const delivery = author ? undefined : (await tx.select().from(orderNotificationDelivery).where(eq(orderNotificationDelivery.id, expected.deliveryId)).limit(1).for('share', { noWait: true }))[0];
  const [event] = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, author ? expected.outboxId : delivery?.outboxId ?? 0)).limit(1).for('share', { noWait: true });
  if (!event || event.eventType !== PAID_SUBSCRIPTION_EVENT || event.aggregateType !== 'order' || event.eventKey !== expected.eventKey) return unavailable();
  const body = capturePaidSubscriptionBody(event.payload);
  if (event.eventKey !== paidNoticeEventKey(body.orderId) || event.aggregateId !== body.orderId || event.addTime !== body.occurredAt || body.userId === 0) return unavailable();
  const requestProof = parseRoutineSubscriptionPaidRequest(env, (event.payload as unknown as { routineSubscriptionRequest?: unknown }).routineSubscriptionRequest, await routineSubscriptionScopeTx(tx));
  if (!same(requestProof.body, body) || requestProof.eventKey !== event.eventKey || requestProof.eventTime !== event.addTime) return unavailable();
  const source = await readPaidSubscriptionFamilyTx(tx, env, body, true), selection = await selectPaidSubscriptionOwnerTx(tx, env, source, true);
  if (!same(selection, requestProof.selection) || source.familyDigest !== requestProof.familyDigest || source.paymentDigest !== requestProof.paymentDigest) return unavailable();
  let payment: PaidSubscriptionPayment;
  if (source.original) {
    const proof = await readRoutineSubscriptionOriginalTx(tx, env, { rootId: source.root.id, buyerUid: body.userId, orderNo: source.root.orderId,
      transactionId: source.root.tradeNo, totalAmount: Number(cents(source.root.payPrice)) });
    await assertNativeAppExcludedForRoutineSubscriptionTx(tx, env, proof);
    if (proof.evidence.payload.observation.facts.appId !== selection.appId) return unavailable();
    payment = { kind: 'routine-original', evidenceId: proof.evidence.evidence_id, evidenceSignature: proof.evidence.signature,
      relatedDigest: proof.relatedDigest, approvedUseDigest: proof.approvedUseDigest };
  } else payment = { kind: 'unique-identity', payType: source.root.payType, paymentDigest: source.paymentDigest };
  const account = await prepareRoutineSubscriptionAccountTx(tx, env, selection.appId, '1927');
  if (account.template.templateId.length > 100) return unavailable();
  const renderedAt = author ? await routineSubscriptionClockTx(tx) : delivery!.addTime, data = renderPaidSubscriptionData(body);
  const request = freezeSubscription({ touser: selection.openid, template_id: account.template.templateId, page: '/pages/goods/order_details/index?order_id=' + body.orderNo,
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { value }])) });
  if (!author) {
    if (!delivery || delivery.channel !== 'wechat_routine' || delivery.eventKey !== event.eventKey || delivery.orderId !== body.orderId || delivery.userId !== body.userId
      || delivery.withdrawalId !== null || delivery.noticeMark !== 'order_pay_success' || delivery.target !== selection.openid || delivery.templateCode !== account.template.templateId
      || !['PENDING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'].includes(delivery.status) || delivery.payload.kind !== 'wechat_routine'
      || !same(delivery.payload.data, data) || delivery.payload.url !== request.page || delivery.payload.routineAppId !== selection.appId) return unavailable();
    const intent = parseRoutineSubscriptionPaidIntent(env, delivery.payload.routineSubscriptionIntent, await routineSubscriptionScopeTx(tx));
    if (intent.deliveryId !== delivery.id || intent.outboxId !== event.id || intent.requestSignature !== requestProof.signature
      || intent.createdAt !== delivery.addTime || !same(intent.request, request) || intent.source.familyDigest !== source.familyDigest
      || intent.source.ownershipDigest !== selection.ownershipDigest || intent.source.paymentAdmissionNonce !== body.paymentAdmissionNonce
      || intent.source.paymentEventId !== body.paymentEventId || !same(intent.source.payment, payment)) return unavailable();
  }
  const facts: RoutineSubscriptionPaidNoticeFacts = { deliveryId: delivery?.id ?? 0, outboxId: event.id, eventKey: event.eventKey, orderId: body.orderId,
    rootId: body.paymentOrderId, buyerUid: body.userId, appId: selection.appId, ownershipId: selection.ownershipId, bindingId: selection.bindingId,
    observationId: selection.observationId, templateMark: '1927', paymentEventId: body.paymentEventId, paymentAdmissionNonce: body.paymentAdmissionNonce,
    familyDigest: source.familyDigest, ownershipDigest: selection.ownershipDigest, payment, sourceDigest: '' };
  facts.sourceDigest = mac(env, author ? 'paid-notice-author-source' : 'paid-notice-delivery-source', [facts, body, event.payload, delivery ? immutableDelivery(delivery) : null, selection, account.account, request]);
  const [tail] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '5 seconds'
    AND pg_catalog.clock_timestamp()<pg_catalog.to_timestamp(${account.account.payload.data.validUntil}) AS ready`);
  if (tail?.ready !== true) return unavailable();
  return { facts: freezeSubscription(facts), account, request, renderedAt, requestSignature: requestProof.signature };
}
