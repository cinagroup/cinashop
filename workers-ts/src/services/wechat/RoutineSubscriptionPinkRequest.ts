import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { inspectRoutineSubscriptionDeliveryCatalog } from '@/migrations/routineSubscriptionDelivery';
import { readRoutineSubscriptionNoticeWriterTx, type RoutineSubscriptionNoticeWriterProvenance } from './RoutineSubscriptionNoticeRequest';
import { freezeSubscription, routineSubscriptionUnavailable, subscriptionEqual, subscriptionHex, subscriptionInteger,
  subscriptionMac, subscriptionObject, subscriptionSame, subscriptionUuid, type RoutineSubscriptionScope } from './RoutineSubscriptionAccount';

type Query = Pick<DbClient, 'execute'>;
type Signing = Readonly<{ APP_KEY?: string }>;
export interface RoutineSubscriptionPinkBusiness { orderId: number; orderNo: string; userId: number; pinkId: number; people: number }
export interface RoutineSubscriptionPinkGroup {
  readonly pinkId: number; readonly combinationId: number; readonly productId: number; readonly people: number;
  readonly completedAt: number; readonly realMembers: number; readonly virtualMembers: number;
  readonly memberIds: readonly number[]; readonly membersDigest: string;
}
export interface RoutineSubscriptionPinkMember {
  readonly id: number; readonly uid: number; readonly orderId: number; readonly orderNo: string;
  readonly orderIdKey: string; readonly addTime: number;
}
export interface RoutineSubscriptionPinkRequest {
  readonly format: 4; readonly requestId: string; readonly scope: Readonly<RoutineSubscriptionScope>;
  readonly actor: Readonly<{ role: string; roleOid: string }>; readonly eventKey: string; readonly aggregateId: number;
  readonly eventTime: number; readonly body: Readonly<RoutineSubscriptionPinkBusiness>; readonly group: Readonly<RoutineSubscriptionPinkGroup>;
  readonly member: Readonly<RoutineSubscriptionPinkMember>; readonly createdAt: number; readonly signature: string;
}
export interface RoutineSubscriptionPinkUnavailable { readonly format: 4; readonly unavailable: true }
export type RoutineSubscriptionPinkRequestOutcome = { readonly kind: 'legacy' } | {
  readonly kind: 'original'; readonly request: Readonly<RoutineSubscriptionPinkRequest | RoutineSubscriptionPinkUnavailable>;
};
const UNAVAILABLE = Object.freeze({ kind: 'original' as const, request: Object.freeze({ format: 4 as const, unavailable: true as const }) });
const LEGACY = Object.freeze({ kind: 'legacy' as const });
const batchSlot = Symbol('routine.subscription.pink-request-batch.v1');
export interface PreparedRoutineSubscriptionPinkRequests { readonly [batchSlot]: true }
interface MemberRow {
  id: number; uid: number; nickname: string; orderId: string; orderIdKey: string; combinationId: number; productId: number;
  kId: number; people: number; status: number; stopTime: number | null; isRefund: number; isVirtual: number; addTime: number;
}
interface OrderRow {
  id: number; orderNo: string; unique: string | null; uid: number; type: number; activityId: number; pinkId: number;
  paid: number; isDel: number; isSystemDel: number; refundStatus: number; pendingRefund: boolean;
}
type BatchState = { kind: 'legacy' } | { kind: 'unavailable' } | {
  kind: 'ready'; key: Readonly<Pick<Env, 'APP_KEY'>>; writer: Readonly<RoutineSubscriptionNoticeWriterProvenance>;
  group: Readonly<RoutineSubscriptionPinkGroup>; members: ReadonlyMap<number, { member: Readonly<RoutineSubscriptionPinkMember>; qualifies: boolean }>;
};
const batches = new WeakMap<PreparedRoutineSubscriptionPinkRequests, { tx: DbClient; pinkId: number; eventTime: number; state: BatchState }>();
const name = (v: unknown): v is string => typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/u.test(v) && !v.startsWith('pg_') && v !== 'information_schema';
const oid = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,9}$/u.test(v) && BigInt(v) <= 4294967295n;
const zero = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const people = (v: unknown): v is number => subscriptionInteger(v) && v >= 2 && v <= 500;
function text(v: unknown, max: number, nonempty = false): v is string {
  if (typeof v !== 'string' || nonempty && !v || v.length > max * 2) return false;
  let count = 0; for (const c of v) { const point = c.codePointAt(0)!; if (++count > max || point >= 0xd800 && point <= 0xdfff) return false; } return true;
}
function signing(env: Signing | undefined): Readonly<Pick<Env, 'APP_KEY'>> | undefined {
  if (!env || typeof env !== 'object') return;
  const d = Object.getOwnPropertyDescriptor(env, 'APP_KEY');
  if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string' || !d.value || d.value.length > 8192) return;
  return Object.freeze({ APP_KEY: d.value });
}
function scopeValue(raw: unknown): Readonly<RoutineSubscriptionScope> {
  const r = subscriptionObject(raw, ['database', 'databaseOid', 'maintenance', 'maintenanceOid']);
  if (!name(r.database) || !oid(r.databaseOid) || !name(r.maintenance) || !oid(r.maintenanceOid)) return routineSubscriptionUnavailable();
  return Object.freeze({ database: r.database, databaseOid: r.databaseOid, maintenance: r.maintenance, maintenanceOid: r.maintenanceOid });
}
function array(raw: unknown, max: number): readonly unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max || Reflect.ownKeys(raw).length !== raw.length + 1)
    return routineSubscriptionUnavailable();
  const values: unknown[] = [];
  for (let i = 0; i < raw.length; i++) { const d = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!d?.enumerable || !('value' in d)) return routineSubscriptionUnavailable(); values.push(d.value); }
  return values;
}
export function captureRoutineSubscriptionPinkBusiness(raw: unknown): Readonly<RoutineSubscriptionPinkBusiness> {
  const r = subscriptionObject(raw, ['orderId', 'orderNo', 'userId', 'pinkId', 'people']);
  if (!subscriptionInteger(r.orderId) || !text(r.orderNo, 32, true) || !subscriptionInteger(r.userId)
    || !subscriptionInteger(r.pinkId) || !people(r.people)) return routineSubscriptionUnavailable();
  return Object.freeze({ orderId: r.orderId, orderNo: r.orderNo, userId: r.userId, pinkId: r.pinkId, people: r.people });
}
function groupValue(raw: unknown): Readonly<RoutineSubscriptionPinkGroup> {
  const r = subscriptionObject(raw, ['pinkId', 'combinationId', 'productId', 'people', 'completedAt', 'realMembers', 'virtualMembers', 'memberIds', 'membersDigest']);
  const ids = array(r.memberIds, 500);
  if (!subscriptionInteger(r.pinkId) || !subscriptionInteger(r.combinationId) || !subscriptionInteger(r.productId) || !people(r.people)
    || !subscriptionInteger(r.completedAt) || !subscriptionInteger(r.realMembers) || !zero(r.virtualMembers)
    || r.realMembers + r.virtualMembers !== r.people || ids.length !== r.people || !subscriptionHex(r.membersDigest)
    || ids.some((id, i) => !subscriptionInteger(id) || i > 0 && (ids[i - 1] as number) >= id) || !ids.includes(r.pinkId)) return routineSubscriptionUnavailable();
  return freezeSubscription({ pinkId: r.pinkId, combinationId: r.combinationId, productId: r.productId, people: r.people,
    completedAt: r.completedAt, realMembers: r.realMembers, virtualMembers: r.virtualMembers, memberIds: ids as number[], membersDigest: r.membersDigest });
}
function memberValue(raw: unknown, body: Readonly<RoutineSubscriptionPinkBusiness>, group: Readonly<RoutineSubscriptionPinkGroup>): Readonly<RoutineSubscriptionPinkMember> {
  const r = subscriptionObject(raw, ['id', 'uid', 'orderId', 'orderNo', 'orderIdKey', 'addTime']);
  if (!subscriptionInteger(r.id) || !group.memberIds.includes(r.id) || r.uid !== body.userId || r.orderId !== body.orderId || r.orderNo !== body.orderNo
    || !text(r.orderIdKey, 32) || !subscriptionInteger(r.addTime) || r.addTime > group.completedAt) return routineSubscriptionUnavailable();
  return Object.freeze({ id: r.id, uid: body.userId, orderId: body.orderId, orderNo: body.orderNo, orderIdKey: r.orderIdKey, addTime: r.addTime });
}
function memberRow(raw: unknown): Readonly<MemberRow> {
  const r = subscriptionObject(raw, ['id', 'uid', 'nickname', 'orderId', 'orderIdKey', 'combinationId', 'productId', 'kId', 'people', 'status', 'stopTime', 'isRefund', 'isVirtual', 'addTime']);
  if (!subscriptionInteger(r.id) || !zero(r.uid) || !text(r.nickname, 64) || !text(r.orderId, 32) || !text(r.orderIdKey, 32)
    || !subscriptionInteger(r.combinationId) || !subscriptionInteger(r.productId) || !zero(r.kId) || !people(r.people)
    || !subscriptionInteger(r.status) || r.status > 3 || r.stopTime !== null && !subscriptionInteger(r.stopTime)
    || !zero(r.isRefund) || r.isVirtual !== 0 && r.isVirtual !== 1 || !subscriptionInteger(r.addTime)) return routineSubscriptionUnavailable();
  return Object.freeze(r as unknown as MemberRow);
}
function orderRow(raw: unknown): Readonly<OrderRow> {
  const r = subscriptionObject(raw, ['id', 'orderNo', 'unique', 'uid', 'type', 'activityId', 'pinkId', 'paid', 'isDel', 'isSystemDel', 'refundStatus', 'pendingRefund']);
  if (!subscriptionInteger(r.id) || !text(r.orderNo, 32, true) || r.unique !== null && !text(r.unique, 50) || !subscriptionInteger(r.uid)
    || r.type !== 3 || !subscriptionInteger(r.activityId) || !subscriptionInteger(r.pinkId) || r.paid !== 1 || r.isDel !== 0 || r.isSystemDel !== 0
    || !zero(r.refundStatus) || r.refundStatus > 3 || typeof r.pendingRefund !== 'boolean') return routineSubscriptionUnavailable();
  return Object.freeze(r as unknown as OrderRow);
}
function immutableMember(m: Readonly<MemberRow>) {
  return { id: m.id, uid: m.uid, orderId: m.orderId, orderIdKey: m.orderIdKey, combinationId: m.combinationId,
    productId: m.productId, kId: m.kId, people: m.people, isVirtual: m.isVirtual, addTime: m.addTime };
}
function matches(m: Readonly<MemberRow>, o: Readonly<OrderRow>, group: Pick<RoutineSubscriptionPinkGroup, 'pinkId' | 'combinationId'>) {
  const number = m.orderId !== '' && m.orderId !== '0', key = m.orderIdKey !== '' && m.orderIdKey !== '0';
  return m.isVirtual === 0 && m.uid > 0 && o.uid === m.uid && o.activityId === group.combinationId && o.pinkId === group.pinkId
    && (number || key) && (!number || m.orderId === o.orderNo) && (!key || m.orderIdKey === String(o.id) || m.orderIdKey === o.unique);
}
/** One bounded complete formation read. Fresh readers also include all signed
 * IDs, even if another member has since refunded; an undeclared active success
 * row cannot hide outside the signed set. The caller owns the public table
 * fences during send; no new maintenance gate or transaction setting is used. */
async function readMembers(tx: Query, pinkId: number, signedIds: readonly number[] | undefined): Promise<Readonly<MemberRow>[]> {
  const predicate = signedIds === undefined
    ? sql`(p.id=${pinkId} OR p.k_id=${pinkId}) AND p.status=2 AND p.is_refund=0`
    : sql`p.id=ANY(ARRAY[${sql.join(signedIds.map(id => sql`${id}`), sql`, `)}]::integer[]) OR ((p.id=${pinkId} OR p.k_id=${pinkId}) AND p.status=2 AND p.is_refund=0)`;
  const rows = await tx.execute<{ member: unknown; resolution: boolean }>(sql`SELECT pg_catalog.jsonb_build_object(
    'id',p.id,'uid',p.uid,'nickname',p.nickname,'orderId',p.order_id,'orderIdKey',p.order_id_key,
    'combinationId',p.combination_id,'productId',p.product_id,'kId',p.k_id,'people',p.people,'status',p.status,
    'stopTime',pg_catalog.floor(EXTRACT(EPOCH FROM p.stop_time))::integer,'isRefund',p.is_refund,'isVirtual',p.is_virtual,'addTime',p.add_time) AS member,
    pg_catalog.to_regclass('store_pink')=pg_catalog.to_regclass('public.store_pink') AS resolution
    FROM public.store_pink p WHERE ${predicate} ORDER BY p.id LIMIT 501 FOR SHARE OF p NOWAIT`);
  if (!rows.length || rows.length > 500) return routineSubscriptionUnavailable();
  const members = rows.map(raw => { const r = subscriptionObject(raw, ['member', 'resolution']);
    if (r.resolution !== true) return routineSubscriptionUnavailable(); return memberRow(r.member); });
  if (members.some((m, i) => i > 0 && members[i - 1]!.id >= m.id) || Buffer.byteLength(JSON.stringify(members), 'utf8') > 1048576)
    return routineSubscriptionUnavailable();
  return members;
}
/** All real-order identities are resolved in one query for the batch. A group
 * is not one multi-buyer payment family; each order later proves its own root
 * original-payment, exact UID owner and independent 3098 policy. */
async function readOrders(tx: Query, pinkId: number, ids: readonly number[]): Promise<Readonly<OrderRow>[]> {
  const rows = await tx.execute<{ order: unknown; resolution: boolean }>(sql`SELECT pg_catalog.jsonb_build_object(
    'id',o.id,'orderNo',o.order_id,'unique',o.unique,'uid',o.uid,'type',o.type,'activityId',o.activity_id,'pinkId',o.pink_id,
    'paid',o.paid,'isDel',o.is_del,'isSystemDel',o.is_system_del,'refundStatus',o.refund_status,
    'pendingRefund',EXISTS(SELECT 1 FROM public.store_order_refund r WHERE r.store_order_id=o.id AND r.is_cancel=0 AND r.is_del=0
      AND r.refund_type IN (0,1,2,4,5))) AS "order",
    pg_catalog.to_regclass('store_order')=pg_catalog.to_regclass('public.store_order')
      AND pg_catalog.to_regclass('store_order_refund')=pg_catalog.to_regclass('public.store_order_refund') AS resolution
    FROM public.store_pink p JOIN public.store_order o ON o.uid=p.uid AND o.type=3 AND o.activity_id=p.combination_id AND o.pink_id=${pinkId}
      AND (o.order_id=p.order_id OR o.unique=p.order_id_key OR o.id::text=p.order_id_key)
      AND (p.order_id IN ('','0') OR o.order_id=p.order_id)
      AND (p.order_id_key IN ('','0') OR o.unique=p.order_id_key OR o.id::text=p.order_id_key)
    WHERE p.id=ANY(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::integer[]) AND p.is_virtual=0 ORDER BY o.id LIMIT 501 FOR SHARE OF o NOWAIT`);
  if (rows.length > 500) return routineSubscriptionUnavailable();
  const orders = rows.map(raw => { const r = subscriptionObject(raw, ['order', 'resolution']);
    if (r.resolution !== true) return routineSubscriptionUnavailable(); return orderRow(r.order); });
  if (orders.some((o, i) => i > 0 && orders[i - 1]!.id >= o.id) || Buffer.byteLength(JSON.stringify(orders), 'utf8') > 1048576)
    return routineSubscriptionUnavailable();
  return orders;
}
function formation(key: Pick<Env, 'APP_KEY'>, pinkId: number, members: readonly Readonly<MemberRow>[]) {
  const leader = members.find(m => m.id === pinkId);
  if (!leader || leader.kId !== 0 || leader.status !== 2 || leader.isRefund !== 0 || leader.isVirtual !== 0 || leader.uid <= 0
    || !subscriptionInteger(leader.stopTime) || members.length !== leader.people) return routineSubscriptionUnavailable();
  if (members.some(m => (m.id === pinkId ? m.kId !== 0 : m.kId !== pinkId) || m.combinationId !== leader.combinationId
    || m.productId !== leader.productId || m.people !== leader.people || m.addTime > leader.stopTime! || m.status !== 2 || m.isRefund !== 0
    || (m.isVirtual === 1 ? m.uid !== 0 || !['', '0'].includes(m.orderId) || !['', '0'].includes(m.orderIdKey) : !subscriptionInteger(m.uid))))
    return routineSubscriptionUnavailable();
  const real = members.filter(m => m.isVirtual === 0);
  if (new Set(real.map(m => m.uid)).size !== real.length) return routineSubscriptionUnavailable();
  return groupValue({ pinkId, combinationId: leader.combinationId, productId: leader.productId, people: leader.people,
    completedAt: leader.stopTime, realMembers: real.length, virtualMembers: members.length - real.length,
    memberIds: members.map(m => m.id), membersDigest: subscriptionMac(key, 'pink-formation', members.map(immutableMember)) });
}
/** A genuine optional SAVEPOINT captures catalog, LOGIN and complete formation
 * once. A SQL failure rolls back only Mini provenance and yields unavailable4.
 * The private result is bound to the same outer transaction, not to a JSON
 * DTO or a reusable catalog/writer assertion. Locks survive SAVEPOINT release. */
export async function prepareRoutineSubscriptionPinkRequestsTx(tx: DbClient, env: Signing | undefined,
  raw: { pinkId: number; now: number }): Promise<PreparedRoutineSubscriptionPinkRequests> {
  const r = subscriptionObject(raw, ['pinkId', 'now']);
  if (!subscriptionInteger(r.pinkId) || !subscriptionInteger(r.now)) return routineSubscriptionUnavailable();
  const pinkId = r.pinkId, eventTime = r.now, key = signing(env), candidate = Object.freeze({ [batchSlot]: true as const });
  let state: BatchState = { kind: 'unavailable' };
  if (!Object.hasOwn(tx, '$client')) try {
    state = await withTx(createContainerFromDb(tx), async nested => {
      const catalog = await inspectRoutineSubscriptionDeliveryCatalog(nested), binding = catalog.binding;
      if (!catalog.present) return { kind: 'legacy' as const };
      if (!catalog.ready || !binding?.app || !binding.appOid || !key) return { kind: 'unavailable' as const };
      const writer = await readRoutineSubscriptionNoticeWriterTx(nested, binding);
      if (!writer) return { kind: 'unavailable' as const };
      const rows = await readMembers(nested, pinkId, undefined), group = formation(key, pinkId, rows);
      const real = rows.filter(m => m.isVirtual === 0), orders = await readOrders(nested, pinkId, real.map(m => m.id));
      if (orders.length !== real.length) return { kind: 'unavailable' as const };
      const selected = new Map<number, { member: Readonly<RoutineSubscriptionPinkMember>; qualifies: boolean }>();
      for (const m of real) {
        const matchesForMember = orders.filter(o => matches(m, o, group));
        if (matchesForMember.length !== 1) return { kind: 'unavailable' as const };
        const o = matchesForMember[0]!, body = captureRoutineSubscriptionPinkBusiness({ orderId: o.id, orderNo: o.orderNo, userId: o.uid, pinkId, people: group.people });
        selected.set(o.id, { member: memberValue({ id: m.id, uid: m.uid, orderId: o.id, orderNo: o.orderNo, orderIdKey: m.orderIdKey, addTime: m.addTime }, body, group),
          qualifies: !o.pendingRefund && [0, 3].includes(o.refundStatus) });
      }
      if (selected.size !== real.length) return { kind: 'unavailable' as const };
      return { kind: 'ready' as const, key, writer, group, members: selected };
    });
  } catch { state = { kind: 'unavailable' }; }
  batches.set(candidate, { tx, pinkId, eventTime, state }); return candidate;
}
/** Synchronous per-order derivation performs no SQL or group/catalog rescan.
 * Only a first-INSERT caller may retain this candidate; an existing event must
 * preserve its original format, pin, signature or historical absence. */
export function createRoutineSubscriptionPinkRequestTx(tx: DbClient, candidate: PreparedRoutineSubscriptionPinkRequests | undefined,
  raw: { eventKey: string; aggregateId: number; payload: RoutineSubscriptionPinkBusiness; now: number }): RoutineSubscriptionPinkRequestOutcome {
  const r = subscriptionObject(raw, ['eventKey', 'aggregateId', 'payload', 'now']), body = captureRoutineSubscriptionPinkBusiness(r.payload);
  if (r.eventKey !== `order.pink.success.notice:${body.orderId}` || r.aggregateId !== body.orderId || !subscriptionInteger(r.now)) return routineSubscriptionUnavailable();
  const batch = candidate && batches.get(candidate);
  if (!batch || batch.tx !== tx || batch.pinkId !== body.pinkId || batch.eventTime !== r.now) return UNAVAILABLE;
  if (batch.state.kind === 'legacy') return LEGACY;
  if (batch.state.kind !== 'ready') return UNAVAILABLE;
  const { key, writer, group } = batch.state, selected = batch.state.members.get(body.orderId);
  if (!selected || !selected.qualifies || body.people !== group.people || selected.member.uid !== body.userId || selected.member.orderNo !== body.orderNo) return UNAVAILABLE;
  const unsigned = { format: 4 as const, requestId: randomUUID(), scope: writer.scope, actor: writer.actor,
    eventKey: r.eventKey as string, aggregateId: body.orderId, eventTime: r.now, body, group, member: selected.member, createdAt: writer.createdAt };
  return Object.freeze({ kind: 'original' as const, request: freezeSubscription({ ...unsigned, signature: subscriptionMac(key, 'pink-notice-request', unsigned) }) });
}
/** Historical formation provenance only. Current owner, independent 3098
 * approval and each buyer's original payment remain fresh App/Queue checks. */
export function parseRoutineSubscriptionPinkRequest(env: Pick<Env, 'APP_KEY'>, raw: unknown,
  expectedScope: RoutineSubscriptionScope): Readonly<RoutineSubscriptionPinkRequest> {
  const key = signing(env); if (!key) return routineSubscriptionUnavailable();
  const r = subscriptionObject(raw, ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'group', 'member', 'createdAt', 'signature']);
  const scope = scopeValue(r.scope), expected = scopeValue(expectedScope), actor = subscriptionObject(r.actor, ['role', 'roleOid']);
  const body = captureRoutineSubscriptionPinkBusiness(r.body), group = groupValue(r.group), member = memberValue(r.member, body, group);
  if (r.format !== 4 || !subscriptionUuid(r.requestId) || !subscriptionSame(scope, expected) || !name(actor.role) || !oid(actor.roleOid)
    || actor.role === scope.maintenance || actor.roleOid === scope.maintenanceOid || r.eventKey !== `order.pink.success.notice:${body.orderId}`
    || r.aggregateId !== body.orderId || !subscriptionInteger(r.eventTime) || !subscriptionInteger(r.createdAt)
    || group.pinkId !== body.pinkId || group.people !== body.people) return routineSubscriptionUnavailable();
  const unsigned = { format: 4 as const, requestId: r.requestId, scope, actor: Object.freeze({ role: actor.role, roleOid: actor.roleOid }),
    eventKey: r.eventKey as string, aggregateId: body.orderId, eventTime: r.eventTime, body, group, member, createdAt: r.createdAt };
  if (!subscriptionEqual(r.signature, subscriptionMac(key, 'pink-notice-request', unsigned))) return routineSubscriptionUnavailable();
  return freezeSubscription({ ...unsigned, signature: r.signature as string });
}
/** Caller authenticates request against its actual database scope first and
 * owns public table fences. Other signed members may later refund; only this
 * target and its leader must still qualify. Identity, set and digest stay exact. */
export async function readRoutineSubscriptionPinkTargetTx(tx: Query, env: Pick<Env, 'APP_KEY'>,
  request: Readonly<RoutineSubscriptionPinkRequest>) {
  const key = signing(env); if (!key) return routineSubscriptionUnavailable();
  const described = subscriptionObject(request, ['format', 'requestId', 'scope', 'actor', 'eventKey', 'aggregateId', 'eventTime', 'body', 'group', 'member', 'createdAt', 'signature']);
  const parsed = parseRoutineSubscriptionPinkRequest(key, described, scopeValue(described.scope)), group = parsed.group;
  const rows = await readMembers(tx, group.pinkId, group.memberIds);
  if (rows.length !== group.memberIds.length || rows.some((m, i) => m.id !== group.memberIds[i])
    || !subscriptionEqual(group.membersDigest, subscriptionMac(key, 'pink-formation', rows.map(immutableMember)))) return routineSubscriptionUnavailable();
  const leader = rows.find(m => m.id === group.pinkId), member = rows.find(m => m.id === parsed.member.id);
  if (!leader || !member || leader.kId !== 0 || leader.status !== 2 || leader.isRefund !== 0 || leader.isVirtual !== 0 || !subscriptionInteger(leader.uid)
    || leader.combinationId !== group.combinationId || leader.productId !== group.productId || leader.people !== group.people || leader.stopTime !== group.completedAt
    || member.status !== 2 || member.isRefund !== 0 || member.isVirtual !== 0 || member.uid !== parsed.body.userId) return routineSubscriptionUnavailable();
  const orders = await readOrders(tx, group.pinkId, [member.id]);
  if (orders.length !== 1 || orders[0]!.pendingRefund || ![0, 3].includes(orders[0]!.refundStatus) || !matches(member, orders[0]!, group)) return routineSubscriptionUnavailable();
  const o = orders[0]!, actual = memberValue({ id: member.id, uid: member.uid, orderId: o.id, orderNo: o.orderNo, orderIdKey: member.orderIdKey, addTime: member.addTime }, parsed.body, group);
  if (!subscriptionSame(actual, parsed.member)) return routineSubscriptionUnavailable();
  return freezeSubscription({ group, member: actual, leaderNickname: leader.nickname, memberAddTime: member.addTime });
}
