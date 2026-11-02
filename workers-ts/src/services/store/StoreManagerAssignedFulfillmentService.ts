import { and, asc, eq, sql } from 'drizzle-orm';
import { withTx, createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrderOutbox, expressCompany } from '@/models/schema';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import type { AssignmentRuntimeDeclaration } from '@/migrations/fulfillmentAssignmentRuntimeDeclaration';
import { captureManagerAssignedRuntime, assertManagerAssignedTx, lockManagerAssignedWaybill } from '@/migrations/managerAssignedFulfillmentReady';
import { acquireManagerCarrierLock } from '@/migrations/runManagerScopeLock';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { readChain, orderSnapshot, currentSource, cartsSnapshot, assignmentSourceSnapshot,
  type AssignmentCurrentSource } from '@/services/order/FulfillmentAssignmentSource';
import { assignmentId, assignmentOperationId, assignmentRouteId, assignmentNoQuery, assignmentSame,
  type AssignmentEvent } from '@/services/order/FulfillmentAssignmentProtocol';
import { assertOrderNotificationPayload, ORDER_DELIVERY_NOTICE_EVENT } from '@/services/order/OrderNotificationOutboxService';
import { SupplierFulfillmentService } from '@/services/supplier/SupplierFulfillmentService';
import { authorizeManagerOperationOwner, authorizeManagerOperationOwnerReadTx,
  type ManagerOperationContext, type ManagerOrderActor } from './ManagerOrderOperationRequest';
import { requireStoreManagerScope, merchantOrderRevision, type StoreManagerScope } from './StoreManagerScope';
import { captureAssignedActor, captureAssignedFulfillmentInput, assignedFulfillmentHash,
  decodeAssignedFulfillmentRecord, assignedFulfillmentReceipt, assertAssignedSameRequest,
  type AssignedFulfillmentInput, type AssignedFulfillmentRecord, type AssignedFulfillmentReceipt } from './ManagerAssignedFulfillmentInput';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';

const unavailable = (m = '分配单履约原证或运行合同不完整，请保留原请求核对') => new ServiceUnavailableException(m);
const conflict = (m: string) => new HttpApiException(m, 409, 409);
const stale = (m: string) => new HttpApiException(m, 412, 412);
const COLUMNS = sql.raw(`actor_uid,request_key::text AS request_key,format_version,kind,outcome,request_hash,target_store_id,
  staff_id,scope_key,root_order_id,order_id,customer_uid,financial_store_id,supplier_id,assignment_operation_id::text AS assignment_operation_id,
  assignment_ordinal,assignment_payload_hash,assignment_source_hash,assignment_order_revision,expected_order_revision,post_order_revision,
  delivery_outbox_id,delivery_event_key,delivery_payload_hash,intent,created_at::text AS created_at`);
type Result = { receipt: AssignedFulfillmentReceipt; replayed: boolean };
type Proof = { scope: StoreManagerScope; grant: AssignmentEvent; source: AssignmentCurrentSource };
function databaseError(error: unknown): never {
  let e = error;
  for (let i = 0; i < 6 && e && typeof e === 'object'; i++) {
    const code = 'code' in e ? String(e.code) : '';
    if (['55P03','40P01','40001','23505'].includes(code)) throw Object.assign(conflict('分配或履约来源正在变更，请先查原回执'), { cause: error });
    if (['42501','42P01','42883','57014'].includes(code)) throw Object.assign(unavailable(), { cause: error });
    e = 'cause' in e ? e.cause : undefined;
  }
  throw error;
}
async function decode(value: unknown): Promise<AssignedFulfillmentRecord> {
  try { return await decodeAssignedFulfillmentRecord(value); }
  catch (cause) { throw Object.assign(unavailable('原分配履约回执不符合封闭合同，请人工核对'), { cause }); }
}
async function prior(tx: DbClient, uid: number, key: string): Promise<AssignedFulfillmentRecord | null> {
  const rows = await tx.execute(sql`SELECT ${COLUMNS} FROM public.manager_assigned_fulfillment_request
    WHERE actor_uid=${uid} AND request_key=${key}::uuid LIMIT 2`);
  if (rows.length > 1) throw unavailable();
  return rows.length ? decode(rows[0]) : null;
}
async function requestLock(tx: DbClient, uid: number, key: string): Promise<void> {
  const [r] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(${'cinashop.manager-assigned-whole-express.v1:' + uid + ':' + key},0)) AS ready`);
  if (r?.ready !== true) throw conflict('原分配履约请求正在处理，请先查回执');
}
async function lockRoot(tx: DbClient, id: number): Promise<void> {
  await lockOrderSettlement(tx, id);
  const [r] = await tx.execute<{ id: number; pid: number }>(sql`SELECT id,pid FROM public.store_order WHERE id=${id} FOR UPDATE NOWAIT`);
  if (!r) throw new NotFoundException('分配订单不存在');
  if (r.id !== id || r.pid !== 0) throw stale('分配付款根已变化，不能沿用原批准');
}
function grantInput(grant: AssignmentEvent, input: AssignedFulfillmentInput): void {
  if (grant.kind !== 'grant' || grant.target_store_id !== input.store_id || grant.operation_id !== input.assignment_operation_id
    || grant.ordinal !== input.assignment_ordinal || grant.payload_hash !== input.assignment_payload_hash
    || grant.source_hash !== input.expected_assignment_source_hash || grant.order_revision !== input.expected_order_revision)
    throw stale('后台批准已撤销、改派或内容已变化，请重新核对');
}
async function prove(tx: DbClient, actor: ManagerOrderActor, id: number, storeId: number, lock: boolean,
  input?: AssignedFulfillmentInput): Promise<Proof> {
  if (lock) await authorizeManagerOperationOwner(tx, actor);
  else await authorizeManagerOperationOwnerReadTx(tx, actor);
  const scope = await requireStoreManagerScope(tx, actor.uid, storeId, { lock,
    ...(input ? { expectedScopeKey: input.scope_key } : {}) });
  const chain = await readChain(tx, id), grant = chain.at(-1);
  if (!grant || grant.kind !== 'grant' || grant.target_store_id !== scope.store_id)
    throw new NotFoundException('订单当前没有分配给该门店的有效批准');
  if (input) grantInput(grant, input);
  // No order/address/cart disclosure occurs until the actual live staff and
  // current immutable grant agree on the target store.
  const order = await orderSnapshot(tx, id);
  if (order.id !== id || order.uid !== grant.customer_uid || order.storeId !== 0 || grant.financial_store_id !== 0)
    throw stale('批准的付款根或买家归属已变化');
  const source = await currentSource(tx, order, lock, { waybillFence: lockManagerAssignedWaybill });
  if (source.orderRevision !== grant.order_revision || source.sourceHash !== grant.source_hash
    || !assignmentSame(source.source, grant.source)) throw stale('后台批准的订单或商品来源已变化，请重新维护分配');
  return { scope, grant, source };
}
async function carrier(tx: DbClient, input: AssignedFulfillmentInput): Promise<void> {
  await acquireManagerCarrierLock(tx, input.payload.delivery_code);
  const rows = await tx.select({ name: expressCompany.name }).from(expressCompany)
    .where(and(eq(expressCompany.code, input.payload.delivery_code), eq(expressCompany.status, 1), eq(expressCompany.isShow, 1))).limit(2);
  if (rows.length !== 1 || rows[0].name !== input.payload.delivery_name) throw new ValidateException('快递公司已停用、重复或名称编码不匹配');
}

export class StoreManagerAssignedFulfillmentService {
  private readonly declaration: AssignmentRuntimeDeclaration;
  constructor(private readonly container: Container, private readonly env: Env, declaration: RuntimeGiftPeerDeclarations) {
    this.declaration = captureManagerAssignedRuntime(declaration);
    if (!Object.hasOwn(container.db, '$client') || !container.db.$client) throw Error('Root Manager connection required');
  }
  private transaction<T>(actor: ManagerOrderActor, write: boolean, work: (tx: DbClient) => Promise<T>): Promise<T> {
    return withTx(this.container, async tx => {
      if (write) await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE`);
      else await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout','5s',true),pg_catalog.set_config('lock_timeout','1s',true),
        pg_catalog.set_config('idle_in_transaction_session_timeout','5s',true)`);
      const binding = await assertManagerAssignedTx(tx, this.declaration, write);
      const value = await work(tx);
      const after = await assertManagerAssignedTx(tx, this.declaration, write);
      if (!assignmentSame(binding, after)) throw unavailable('分配履约运行绑定在事务内发生变化');
      if (write) await authorizeManagerOperationOwner(tx, actor);
      else await authorizeManagerOperationOwnerReadTx(tx, actor);
      const [clock] = await tx.execute<{ ready: boolean }>(sql`SELECT
        pg_catalog.date_part('epoch',pg_catalog.clock_timestamp())<${actor.expiresAt}
        AND pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '8 seconds' AS ready`);
      if (clock?.ready !== true || actor.expiresAt <= Math.floor(Date.now()/1000)) throw unavailable('分配履约事务或登录会话已超时，请先查原回执');
      return value;
    }).catch(databaseError);
  }
  review(idValue: unknown, query: URLSearchParams, actorValue: ManagerOrderActor) {
    const entries = [...query.entries()];
    if (entries.length !== 1 || entries[0][0] !== 'store_id' || !/^[1-9][0-9]{0,9}$/u.test(entries[0][1]))
      throw new ValidateException('分配单核对需要唯一的目标门店参数');
    const id = assignmentRouteId(idValue), storeId = assignmentId(Number(entries[0][1])), actor = captureAssignedActor(actorValue);
    return this.transaction(actor, false, async tx => {
      const proof = await prove(tx, actor, id, storeId, false), { order } = proof.source;
      const rows = await tx.select({ name: expressCompany.name, code: expressCompany.code }).from(expressCompany)
        .where(and(eq(expressCompany.status, 1), eq(expressCompany.isShow, 1))).orderBy(asc(expressCompany.id)).limit(201);
      if (rows.length > 200) throw unavailable('承运商目录超过当前分配履约读取容量');
      const counts = new Map<string, number>(); for (const r of rows) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
      return { version: 'merchant-assigned-whole-express-v1' as const, order_id: id, order_no: order.orderId,
        store_id: proof.scope.store_id, fulfillment_store_id: proof.scope.store_id, financial_store_id: 0 as const,
        scope_key: proof.scope.scope_key, order_revision: proof.source.orderRevision,
        grant: { operation_id: proof.grant.operation_id, ordinal: proof.grant.ordinal, payload_hash: proof.grant.payload_hash,
          source_hash: proof.grant.source_hash, order_revision: proof.grant.order_revision },
        source: proof.source.source, recipient: { name: order.realName, phone: order.userPhone, address: order.userAddress },
        carriers: rows.filter(r => counts.get(r.code) === 1), admission: 'requires_locked_commit' as const };
    });
  }
  receipt(keyValue: unknown, query: URLSearchParams, actorValue: ManagerOrderActor) {
    assignmentNoQuery(query); const key = assignmentOperationId(keyValue), actor = captureAssignedActor(actorValue);
    return this.transaction(actor, false, async tx => {
      await authorizeManagerOperationOwnerReadTx(tx, actor);
      const record = await prior(tx, actor.uid, key);
      return record ? { state: 'recorded' as const, receipt: assignedFulfillmentReceipt(record) }
        : { state: 'unknown' as const, receipt: null };
    });
  }
  commit(value: unknown, context: ManagerOperationContext): Promise<Result> {
    const input = captureAssignedFulfillmentInput(value), key = assignmentOperationId(context.request_key), actor = captureAssignedActor(context.actor);
    return this.commitCaptured(input, key, actor);
  }
  private async commitCaptured(input: AssignedFulfillmentInput, key: string, actor: ManagerOrderActor): Promise<Result> {
    const hash = await assignedFulfillmentHash(actor.uid, key, input);
    return this.transaction(actor, true, async tx => {
      await requestLock(tx, actor.uid, key);
      const previous = await prior(tx, actor.uid, key);
      if (previous) {
        await authorizeManagerOperationOwner(tx, actor);
        await requireStoreManagerScope(tx, actor.uid, input.store_id, { lock: true });
        if (!assertAssignedSameRequest(previous, actor.uid, key, input, hash)) throw conflict('原请求标识已绑定其他分配履约内容');
        return { receipt: assignedFulfillmentReceipt(previous), replayed: true };
      }
      await lockRoot(tx, input.order_id);
      const proof = await prove(tx, actor, input.order_id, input.store_id, true, input);
      await carrier(tx, input);
      let saved: AssignedFulfillmentRecord | undefined;
      const service = new SupplierFulfillmentService(createContainerFromDb(tx), this.env);
      await service.deliver(0, input.order_id, { deliveryType: 'express', deliveryName: input.payload.delivery_name,
        deliveryCode: input.payload.delivery_code, deliveryId: input.payload.delivery_id, deliveryUid: 0, fictitiousContent: '' }, {
        expectedStoreId: 0, expectedRootStoreId: 0, waybillFence: lockManagerAssignedWaybill,
        audit: { changeType: 'manager_assigned_whole_express', changeMessage:
          `店长用户 ${actor.uid}，店员 ${proof.scope.staff_id}，履约门店 ${proof.scope.store_id}，后台批准 ${proof.grant.operation_id}` },
        trustedReplay: {
          find: async (nested, identity) => {
            if (identity.requestedOrderId !== input.order_id || identity.rootOrderId !== input.order_id
              || identity.customerUid !== proof.source.order.uid || identity.supplierId !== 0) throw stale('分配履约根身份已变化');
            const locked = await prove(nested, actor, input.order_id, input.store_id, true, input);
            if (locked.scope.staff_id !== proof.scope.staff_id || !assignmentSame(locked.grant, proof.grant)) throw stale('后台批准或店员身份已变化');
            return undefined;
          },
          record: async (nested, result) => {
            if (result.split || result.order_id !== input.order_id || result.remaining_order_id !== null) throw unavailable('整单履约返回了拆单结果');
            saved = await this.record(nested, actor, key, input, hash, proof);
          },
        },
      });
      if (!saved) throw unavailable('整单履约缺少同事务回执');
      const scope = await requireStoreManagerScope(tx, actor.uid, input.store_id, { lock: true, expectedScopeKey: input.scope_key });
      if (scope.staff_id !== proof.scope.staff_id) throw stale('当前店员身份已变化');
      return { receipt: assignedFulfillmentReceipt(saved), replayed: false };
    });
  }
  private async record(tx: DbClient, actor: ManagerOrderActor, key: string, input: AssignedFulfillmentInput, hash: string, proof: Proof) {
    const post = await orderSnapshot(tx, input.order_id), before = proof.source.order;
    const expected = { ...before, status: 1, deliveryType: 'express', deliveryName: input.payload.delivery_name,
      deliveryCode: input.payload.delivery_code, deliveryId: input.payload.delivery_id, deliveryUid: 0, fictitiousContent: '' };
    if (await outRequestHash(post) !== await outRequestHash(expected)) throw unavailable('整单履约写后的付款或订单事实不一致');
    const carts = await cartsSnapshot(tx, before, true), captured = await assignmentSourceSnapshot(before, carts);
    if (captured.sourceHash !== proof.grant.source_hash || !assignmentSame(captured.source, proof.grant.source)) throw unavailable('整单履约修改了原批准商品来源');
    const events = await tx.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId, input.order_id),
      eq(storeOrderOutbox.eventType, ORDER_DELIVERY_NOTICE_EVENT))).limit(2);
    if (events.length !== 1) throw unavailable('整单履约缺少唯一真实发货通知');
    const event = events[0]; assertOrderNotificationPayload(event.payload, event.eventType, event.aggregateId);
    if (event.aggregateType !== 'order' || event.eventKey !== 'order.delivery.notice:' + input.order_id || event.status !== 'PENDING'
      || !('deliveryType' in event.payload) || event.payload.deliveryType !== 'express' || event.payload.orderNo !== before.orderId
      || event.payload.userId !== before.uid || event.payload.deliveryName !== input.payload.delivery_name
      || event.payload.deliveryId !== input.payload.delivery_id || event.payload.userAddress !== before.userAddress) throw unavailable('实际发货通知与整单履约不符');
    const payloadHash = await outRequestHash(event.payload), revision = await merchantOrderRevision(post);
    const result = await tx.execute(sql`INSERT INTO public.manager_assigned_fulfillment_request(actor_uid,request_key,format_version,kind,outcome,
      request_hash,target_store_id,staff_id,scope_key,root_order_id,order_id,customer_uid,financial_store_id,supplier_id,
      assignment_operation_id,assignment_ordinal,assignment_payload_hash,assignment_source_hash,assignment_order_revision,expected_order_revision,
      post_order_revision,delivery_outbox_id,delivery_event_key,delivery_payload_hash,intent)
      VALUES(${actor.uid},${key}::uuid,1,'assigned_whole_express','delivery-recorded',${hash},${input.store_id},${proof.scope.staff_id},${input.scope_key},
        ${input.order_id},${input.order_id},${before.uid},0,0,${proof.grant.operation_id}::uuid,${proof.grant.ordinal},${proof.grant.payload_hash},
        ${proof.grant.source_hash},${proof.grant.order_revision},${input.expected_order_revision},${revision},${event.id},${event.eventKey},${payloadHash},${JSON.stringify(input)}::jsonb)
      RETURNING ${COLUMNS}`);
    if (result.length !== 1) throw unavailable();
    const saved = await decode(result[0]), read = await prior(tx, actor.uid, key);
    if (!read || !assignmentSame(saved, read) || !assertAssignedSameRequest(saved, actor.uid, key, input, hash)
      || saved.staff_id !== proof.scope.staff_id || saved.customer_uid !== before.uid || saved.post_order_revision !== revision
      || saved.delivery_outbox_id !== event.id || saved.delivery_payload_hash !== payloadHash) throw unavailable('分配履约回执写后回读不一致');
    return saved;
  }
}
