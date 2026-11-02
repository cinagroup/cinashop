/** Controlled Admin assignment author. The receipt does not change financial
 * ownership or independently authorize a Manager fulfillment request. */
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemStore } from '@/models/schema';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { acquireAdminAuthorityWriteBarrier, loadAdminAuthorityLiveActor, assertAdminAuthoritySession,
  type AdminAuthorityActor } from './AdminAuthorityWriteService';
import { loadAdminProfileActor } from './AdminProfileService';
import { authorizeAdminLegacyProductRead, assertAdminLegacyProductReadDeadline } from './AdminLegacyProductReadAuthority';
import { captureAssignmentRuntimeDeclaration, assertAssignmentAdminTx,
  type AssignmentRuntimeDeclaration } from '@/migrations/storeOrderFulfillmentAssignmentAdminReady';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
import { HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { ASSIGNMENT_CHAIN_LIMIT, assignmentHash, assignmentId,
  assignmentNoQuery, assignmentOperationId, assignmentReceipt, assignmentRequestHash, assignmentRouteId, assignmentSame,
  captureAssignmentActor, captureAssignmentRequest,
  type AssignmentEvent, type AssignmentRequest, type AssignmentSource } from './AdminOrderFulfillmentAssignmentInput';
import { readOperation, readChain, orderSnapshot, currentSource, ASSIGNMENT_EVENT_COLUMNS as EVENT_COLUMNS, decodeStoredAssignment as decoded } from '@/services/order/FulfillmentAssignmentSource';

const conflict = (m: string) => new HttpApiException(m, 409, 409);
const stale = (m: string) => new HttpApiException(m, 412, 412);
const unavailable = (m = '分配账本或订单来源尚未完整就绪，请保留原请求核对') => new ServiceUnavailableException(m);
function safeCount(v: unknown): number {
  const n = typeof v === 'string' && /^(0|[1-9][0-9]{0,15})$/u.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || Number(n) < 0) throw unavailable();
  return Number(n);
}
function databaseError(error: unknown): never {
  let e = error;
  for (let i = 0; i < 6 && e && typeof e === 'object'; i++) {
    const c = 'code' in e ? String(e.code) : '';
    if (['55P03', '40P01', '40001', '23505'].includes(c)) throw Object.assign(conflict('分配、履约或来源正在变更，请先查原回执'), { cause: error });
    if (['42501', '42P01', '42883', '57014'].includes(c)) throw Object.assign(unavailable(), { cause: error });
    e = 'cause' in e ? e.cause : undefined;
  }
  throw error;
}
function sameRequest(prior: AssignmentEvent, a: AssignmentRequest, actorId: number, hash: string): void {
  if (prior.actor_id !== actorId || prior.operation_id !== a.operation_id || prior.payload_hash !== hash
    || prior.kind !== a.kind || prior.order_id !== a.order_id || prior.target_store_id !== a.target_store_id
    || prior.previous_ref !== a.expected_head.operation_id || prior.ordinal !== a.expected_head.ordinal + 1
    || prior.order_revision !== a.expected_order_revision || prior.source_hash !== a.expected_source_hash)
    throw conflict('原分配请求标识已绑定其他内容，不能更换请求或目标');
}
async function validatePrior(tx: DbClient, prior: AssignmentEvent): Promise<void> {
  const chain = await readChain(tx, prior.order_id), found = chain.find(r => r.operation_id === prior.operation_id);
  if (!found || !assignmentSame(found, prior)) throw unavailable();
}
async function requestMutex(tx: DbClient, operationId: string): Promise<void> {
  // Text-domain 64-bit lock, independent of the installer two-int namespace.
  // A hash collision can only serialize unrelated requests, never authorize one.
  const [r] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(${'cinashop.fulfillment-assignment.operation.v1:' + operationId},0)) AS locked`);
  if (r?.locked !== true) throw conflict('原分配请求正在处理，请先查回执');
}
async function sqlClock(tx: DbClient): Promise<number> {
  const [r] = await tx.execute<{ value: string }>(sql`SELECT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint::text AS value`);
  const n = safeCount(r?.value);
  if (!n) throw unavailable();
  return n;
}
async function rootIdentity(tx: DbClient, id: number, lock: boolean) {
  if (lock) {
    const [hint] = await tx.execute<{ id: number; pid: number }>(sql`SELECT id,pid FROM public.store_order WHERE id=${id}`);
    if (!hint) throw new NotFoundException('订单不存在');
    const resource = hint.pid > 0 ? assignmentId(hint.pid) : id;
    await lockOrderSettlement(tx, resource);
    const [row] = await tx.execute<{ id: number; pid: number; uid: number; storeId: number }>(sql`SELECT
      id,pid,uid,store_id AS "storeId" FROM public.store_order WHERE id=${id} FOR UPDATE NOWAIT`);
    if (!row || (row.pid > 0 ? row.pid : row.id) !== resource) throw conflict('订单根身份已变化，请重新核对');
    return row;
  }
  const [row] = await tx.execute<{ id: number; pid: number; uid: number; storeId: number }>(sql`SELECT
    id,pid,uid,store_id AS "storeId" FROM public.store_order WHERE id=${id}`);
  if (!row) throw new NotFoundException('订单不存在');
  return row;
}
async function targetStore(tx: DbClient, id: number, lock: boolean) {
  const q = tx.select({ id: systemStore.id, name: systemStore.name, isStore: systemStore.isStore,
    isShow: systemStore.isShow, isDel: systemStore.isDel }).from(systemStore).where(eq(systemStore.id, id)).limit(2);
  const rows = await (lock ? q.for('share', { noWait: true }) : q);
  if (rows.length !== 1 || rows[0].isStore !== 1 || rows[0].isShow !== 1 || rows[0].isDel !== 0) throw new ValidateException('履约目标门店已停用或不存在');
  return { id: rows[0].id, name: rows[0].name };
}

export class AdminOrderFulfillmentAssignmentService {
  private readonly declaration: AssignmentRuntimeDeclaration;
  constructor(private readonly container: Container, declaration: RuntimeGiftPeerDeclarations) {
    // Trusted explicit configuration only. A missing declaration must close the
    // route in future composition; never discover desired roles from SQL ACLs.
    this.declaration = captureAssignmentRuntimeDeclaration(declaration);
    if (!Object.hasOwn(container.db, '$client') || !container.db.$client) throw Error('Root Admin connection required');
  }
  private transaction<T>(actor: Readonly<AdminAuthorityActor>, mode: 'view' | 'manage-read' | 'owner' | 'write', work: (tx: DbClient) => Promise<T>): Promise<T> {
    return withTx(this.container, async tx => {
      if (mode === 'write') {
        await acquireAdminAuthorityWriteBarrier(tx);
        // An exact successful replay is owner recovery. Fresh decisions below
        // separately require live order.manage, both before work and at the tail.
        await loadAdminProfileActor(tx, actor);
      } else {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        await tx.execute(sql`SELECT pg_catalog.set_config('statement_timeout','5s',true),pg_catalog.set_config('lock_timeout','1s',true),
          pg_catalog.set_config('idle_in_transaction_session_timeout','5s',true)`);
        if (mode === 'owner') await loadAdminProfileActor(tx, actor);
        else await authorizeAdminLegacyProductRead(tx, actor, mode === 'manage-read' ? 'order.manage' : 'order.view');
      }
      const binding = await assertAssignmentAdminTx(tx, this.declaration, mode === 'write');
      const result = await work(tx);
      const after = await assertAssignmentAdminTx(tx, this.declaration, mode === 'write');
      if (!assignmentSame(binding, after)) throw unavailable('分配运行绑定在事务内发生变化');
      if (mode === 'owner' || mode === 'write') await loadAdminProfileActor(tx, actor);
      await assertAdminLegacyProductReadDeadline(tx, actor);
      const [deadline] = await tx.execute<{ ready: boolean }>(sql`SELECT
        pg_catalog.clock_timestamp()<=pg_catalog.transaction_timestamp()+interval '8 seconds' AS ready`);
      if (deadline?.ready !== true) throw unavailable('分配事务已超出短时边界，请先查原回执');
      assertAdminAuthoritySession(actor);
      return result;
    }).catch(databaseError);
  }
  review(idValue: unknown, q: URLSearchParams, actorValue: AdminAuthorityActor) {
    assignmentNoQuery(q);
    const id = assignmentRouteId(idValue), actor = captureAssignmentActor(actorValue);
    return this.transaction(actor, 'view', async tx => {
      const identity = await rootIdentity(tx, id, false), chain = await readChain(tx, id), head = chain.at(-1);
      if (![0, -1].includes(identity.pid) || identity.storeId !== 0 || identity.uid <= 0
        || head && head.customer_uid !== identity.uid) throw unavailable('分配付款根或买家身份已变化');
      let grant: { order_no: string; order_revision: string; source_hash: string; source: AssignmentSource } | null = null;
      let grantReason = '';
      try {
        const order = await orderSnapshot(tx, id), s = await currentSource(tx, order, false);
        grant = { order_no: order.orderId, order_revision: s.orderRevision, source_hash: s.sourceHash, source: s.source };
      } catch (error) {
        // A changed/unsupported delivery state does not hide the old approval
        // from an authorized reviewer who needs to withdraw it. SQL or contract
        // failures remain failures; no catch turns them into a usable grant.
        if (!(error instanceof ValidateException)) throw error;
        grantReason = error.message;
      }
      return { format_version: 1 as const, order_id: id, customer_uid: identity.uid, financial_store_id: 0 as const,
        current_head: head ? assignmentReceipt(head) : null, expected_head: { ordinal: head?.ordinal ?? 0, operation_id: head?.operation_id ?? null },
        grant, grant_reason: grantReason, revoke: head?.kind === 'grant' ? { target_store_id: head.target_store_id,
          order_revision: head.order_revision, source_hash: head.source_hash } : null,
        // The city conflict port requires the real root lock in an RC/RW tx.
        // This RR/RO review is NEVER a promise of final grant availability.
        admission: 'requires_locked_commit' as const, can_append: chain.length < ASSIGNMENT_CHAIN_LIMIT };
    });
  }
  stores(q: URLSearchParams, actorValue: AdminAuthorityActor) {
    const entries = [...q.entries()];
    if (entries.length > 1 || entries.some(([key, value]) => key !== 'after' || !/^[1-9][0-9]{0,9}$/u.test(value)))
      throw new ValidateException('目标门店查询参数无效');
    const after = entries.length ? assignmentId(Number(entries[0]![1])) : 0, actor = captureAssignmentActor(actorValue);
    return this.transaction(actor, 'manage-read', async tx => {
      const rows = await tx.select({ id: systemStore.id, name: systemStore.name }).from(systemStore)
        .where(and(eq(systemStore.isStore, 1), eq(systemStore.isShow, 1), eq(systemStore.isDel, 0), sql`${systemStore.id}>${after}`))
        .orderBy(asc(systemStore.id)).limit(51);
      const list = rows.slice(0, 50);
      return { list, next_after: rows.length > 50 ? list.at(-1)!.id : null };
    });
  }
  /** Only minimal original-owner recovery. No current order/source/target read
   * or appended outcome. Null means unknown/absent, never "not applied". */
  receipt(idValue: unknown, q: URLSearchParams, actorValue: AdminAuthorityActor) {
    assignmentNoQuery(q);
    const id = assignmentOperationId(idValue), actor = captureAssignmentActor(actorValue);
    return this.transaction(actor, 'owner', async tx => {
      const prior = await readOperation(tx, id);
      if (!prior || prior.actor_id !== actor.id) return { state: 'unknown' as const, receipt: null };
      await validatePrior(tx, prior);
      return { state: 'recorded' as const, receipt: assignmentReceipt(prior) };
    });
  }
  commit(value: unknown, actorValue: AdminAuthorityActor) {
    const a = captureAssignmentRequest(value), actor = captureAssignmentActor(actorValue);
    return this.commitCaptured(a, actor);
  }
  private async commitCaptured(a: AssignmentRequest, actor: Readonly<AdminAuthorityActor>) {
    const requestHash = await assignmentRequestHash(a, actor.id);
    return this.transaction(actor, 'write', async tx => {
      await requestMutex(tx, a.operation_id);
      const prior = await readOperation(tx, a.operation_id);
      if (prior) {
        sameRequest(prior, a, actor.id, requestHash); await validatePrior(tx, prior);
        return { receipt: assignmentReceipt(prior), replayed: true };
      }
      await loadAdminAuthorityLiveActor(tx, actor, 'order.manage');
      const identity = await rootIdentity(tx, a.order_id, true), chain = await readChain(tx, a.order_id), head = chain.at(-1);
      if ((head?.ordinal ?? 0) !== a.expected_head.ordinal || (head?.operation_id ?? null) !== a.expected_head.operation_id)
        throw stale('分配批准链已变化，请核对最新回执');
      if (chain.length >= ASSIGNMENT_CHAIN_LIMIT) throw unavailable('分配历史达到容量上限，请人工维护');
      if (identity.id !== a.order_id || ![0, -1].includes(identity.pid) || identity.storeId !== 0 || identity.uid <= 0
        || head && head.customer_uid !== identity.uid) throw conflict('分配付款根或买家身份已变化，不能代修归属');
      let source: AssignmentSource, revision: string, sourceHash: string;
      if (a.kind === 'revoke') {
        if (!head || head.kind !== 'grant' || head.target_store_id !== a.target_store_id) throw conflict('只能撤销当前实际批准，不能替换撤销目标');
        // Withdrawal preserves the exact old approval. It neither requires a
        // still-deliverable order nor reverses any completed fulfillment.
        source = head.source; revision = head.order_revision; sourceHash = head.source_hash;
      } else {
        if (head?.kind === 'grant' && head.target_store_id === a.target_store_id) throw conflict('该门店已持有当前批准，请核对原操作');
        await targetStore(tx, a.target_store_id, true);
        // rootIdentity already holds the actual63842 and physical root row.
        const order = await orderSnapshot(tx, a.order_id);
        const current = await currentSource(tx, order, true);
        source = current.source; revision = current.orderRevision; sourceHash = current.sourceHash;
      }
      if (revision !== a.expected_order_revision || sourceHash !== a.expected_source_hash) throw stale('原批准或订单商品来源已变化，请重新核对');
      assignmentHash(revision); assignmentHash(sourceHash);
      const [json] = await tx.execute<{ ready: boolean }>(sql`SELECT pg_catalog.octet_length(${JSON.stringify(source)}::jsonb::text)<=65536 AS ready`);
      if (json?.ready !== true) throw new ValidateException('分配来源超过数据库容量');
      const now = await sqlClock(tx);
      if (head && now < head.created_at) throw unavailable('SQL时钟早于原分配回执，请人工核对');
      const rows = await tx.execute(sql`INSERT INTO public.store_order_fulfillment_assignment(operation_id,format_version,kind,actor_id,
        root_order_id,order_id,target_store_id,customer_uid,financial_store_id,ordinal,previous_ref,order_revision,payload_hash,source_hash,source)
        VALUES(${a.operation_id}::uuid,1,${a.kind},${actor.id},${identity.id},${identity.id},${a.target_store_id},${identity.uid},0,
          ${(head?.ordinal ?? 0) + 1},${head?.operation_id ?? null}::uuid,${revision},${requestHash},${sourceHash},${JSON.stringify(source)}::jsonb)
        RETURNING ${EVENT_COLUMNS}`);
      if (rows.length !== 1) throw unavailable();
      const saved = await decoded(rows[0]);
      sameRequest(saved, a, actor.id, requestHash);
      if (saved.root_order_id !== identity.id || saved.customer_uid !== identity.uid || saved.financial_store_id !== 0
        || !assignmentSame(saved.source, source) || saved.created_at < now || head && saved.created_at < head.created_at) throw unavailable('分配写后回读不一致');
      const after = await readChain(tx, identity.id);
      if (after.length !== chain.length + 1 || !assignmentSame(after.at(-1), saved)) throw unavailable('分配写后完整链不一致');
      await loadAdminAuthorityLiveActor(tx, actor, 'order.manage');
      return { receipt: assignmentReceipt(saved), replayed: false };
    });
  }
}
