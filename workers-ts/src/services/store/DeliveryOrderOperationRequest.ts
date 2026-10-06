import { eq, sql } from 'drizzle-orm';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { storeOrder } from '@/models/schema';
import { HttpApiException, NotFoundException, ValidateException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { assertDeliveryOrderOperationCatalog, deliveryOperationReadiness } from '@/migrations/runDeliveryOrderOperation';
import { freezeManagerJson } from './ManagerOrderOperationRequest';
import { deliveryActor, deliveryId, deliveryOrderRevision, requireDeliveryScope, requireFreshDeliveryActor, type DeliveryActor, type DeliveryScope } from './DeliveryPrincipalScope';
import { DELIVERY_OPERATION_VERSION, type DeliveryOperationInput, type DeliveryOperationJson, type DeliveryOperationOutcome, type DeliveryOperationReceipt, type DeliveryOperationResult } from '../../../../view/common/deliveryWriteoff';

export type { DeliveryOperationInput, DeliveryOperationReceipt, DeliveryOperationResult } from '../../../../view/common/deliveryWriteoff';
export interface DeliveryOperationContext { readonly actor: DeliveryActor; readonly request_key: string }
export interface PreparedDeliveryOperation { readonly actor: DeliveryActor; readonly key: string; readonly hash: string; readonly input: DeliveryOperationInput }
type Order = typeof storeOrder.$inferSelect;
const hashPattern = /^[a-f0-9]{64}$/;
const outcomes = new Set<DeliveryOperationOutcome>(['partial-delivered', 'delivered', 'abandoned', 'rollback-rejected']);

/** Only the pure bounded JSON copier is shared with the manager protocol;
 * identities, ledger, namespace, scope and receipts are separate. */
function deliveryInput(value: unknown): DeliveryOperationInput {
  const body = freezeManagerJson(value) as unknown as Record<string, unknown>;
  if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'delivery_id,expected_order_revision,order_id,payload,scope_key,scope_kind,store_id,version'
    || body.version !== DELIVERY_OPERATION_VERSION || typeof body.scope_kind !== 'string' || !['platform', 'store'].includes(body.scope_kind)
    || typeof body.delivery_id !== 'number' || typeof body.store_id !== 'number' || typeof body.order_id !== 'number'
    || !Number.isSafeInteger(body.store_id) || body.store_id < 0 || body.store_id > 2147483647
    || (body.scope_kind === 'platform' ? body.store_id !== 0 : body.store_id === 0)
    || typeof body.scope_key !== 'string' || !hashPattern.test(body.scope_key)
    || typeof body.expected_order_revision !== 'string' || !hashPattern.test(body.expected_order_revision)) throw new ValidateException('原配送操作合同无效');
  return Object.freeze({ version: DELIVERY_OPERATION_VERSION, scope_kind: body.scope_kind as 'platform' | 'store',
    delivery_id: deliveryId(body.delivery_id, '配送身份'), store_id: body.store_id, scope_key: body.scope_key,
    order_id: deliveryId(body.order_id, '订单'), expected_order_revision: body.expected_order_revision, payload: body.payload as DeliveryOperationJson });
}
export async function prepareDeliveryOperation(ctx: DeliveryOperationContext, value: unknown): Promise<PreparedDeliveryOperation> {
  const actor = Object.freeze(deliveryActor(ctx.actor)), key = normalizeOutRequestKey(ctx.request_key), input = deliveryInput(value);
  return Object.freeze({ actor, key, input, hash: await outRequestHash({ version: DELIVERY_OPERATION_VERSION, actor_uid: actor.uid, kind: 'delivery_writeoff', input }) });
}
async function admissionLock(tx: DbClient, uid: number, key: string, write = true) {
  if (Object.hasOwn(tx, '$client')) throw Error('Delivery request requires a caller-owned transaction');
  await tx.execute(sql`SET LOCAL search_path=public,pg_temp`);
  await assertDeliveryOrderOperationCatalog(tx);
  if (write && !(await deliveryOperationReadiness(tx)).ready) throw new HttpApiException('配送操作台账权限未验收，请保留原请求核对', 503, 503);
  await tx.execute(sql`LOCK TABLE public.delivery_order_operation_request IN ROW SHARE MODE NOWAIT`);
  await tx.execute(sql`SET LOCAL row_security=off`);
  await tx.execute(sql`SELECT set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),10000)::text||'ms',true),set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1500)::text||'ms',true)`);
  const hash = await outRequestHash([uid, key]);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(742025::int,${parseInt(hash.slice(0, 8), 16) | 0}::int)`);
}
const receiptColumns = { actor_uid: sql<number>`actor_uid`, request_key: sql<string>`request_key::text`, scope_kind: sql<string>`scope_kind`, delivery_id: sql<number>`delivery_id`,
  store_id: sql<number>`store_id`, order_id: sql<number>`order_id`, request_hash: sql<string>`request_hash`, outcome: sql<string>`outcome`, scope_key: sql<string>`scope_key`,
  expected_revision: sql<string>`expected_revision`, intent: sql<unknown>`intent`, evidence: sql<Record<string, DeliveryOperationJson>>`evidence` };
type StoredReceipt = { [K in keyof typeof receiptColumns]: typeof receiptColumns[K] extends import('drizzle-orm').SQL<infer T> ? T : never };
async function validateStoredReceipt(row: StoredReceipt, uid: number): Promise<DeliveryOperationReceipt> {
  try {
    const key = normalizeOutRequestKey(row.request_key), input = deliveryInput(row.intent), success = ['partial-delivered', 'delivered'].includes(row.outcome);
    if (row.actor_uid !== uid || !hashPattern.test(row.request_hash) || !outcomes.has(row.outcome as DeliveryOperationOutcome)
      || row.scope_kind !== input.scope_kind || row.order_id !== input.order_id || row.store_id !== input.store_id
      || row.scope_key !== input.scope_key || row.expected_revision !== input.expected_order_revision
      || row.delivery_id !== (success ? input.delivery_id : 0)
      || row.request_hash !== await outRequestHash({ version: DELIVERY_OPERATION_VERSION, actor_uid: uid, kind: 'delivery_writeoff', input })) throw Error('Stored delivery intent differs');
    const evidence = freezeManagerJson(row.evidence) as Readonly<Record<string, DeliveryOperationJson>>;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw Error('Invalid delivery evidence');
    if (success) {
      const ids = evidence.writeoff_row_ids, quantities = evidence.quantities, payload = input.payload as Record<string, DeliveryOperationJson>;
      if (Object.keys(evidence).sort().join(',') !== 'completed,quantities,status,writeoff_row_ids'
        || evidence.completed !== (row.outcome === 'delivered') || evidence.status !== (row.outcome === 'delivered' ? 2 : 5)
        || !Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) || new Set(ids).size !== ids.length
        || !Array.isArray(quantities) || quantities.length !== ids.length || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).sort().join(',') !== 'code,items' || typeof payload.code !== 'string' || !/^\d{12}$/.test(payload.code)
        || JSON.stringify(quantities) !== JSON.stringify(payload.items)) throw Error('Invalid delivery success evidence');
      const seen = new Set<number>();
      for (const value of quantities) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'order_cart_id,quantity') throw Error('Invalid delivery quantity evidence');
        for (const id of [value.order_cart_id, value.quantity]) if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw Error('Invalid delivery quantity');
        if (seen.has(value.order_cart_id as number)) throw Error('Repeated delivery cart'); seen.add(value.order_cart_id as number);
      }
    } else if (row.outcome === 'abandoned' ? Object.keys(evidence).length !== 0 : Object.keys(evidence).join(',') !== 'code' || typeof evidence.code !== 'string' || !/^\d{3,5}$/.test(evidence.code)) throw Error('Invalid non-mutation evidence');
    return Object.freeze({ version: DELIVERY_OPERATION_VERSION, request_key: key, actor_uid: uid, request_hash: row.request_hash, scope_kind: input.scope_kind,
      delivery_id: row.delivery_id, store_id: row.store_id, order_id: row.order_id, outcome: row.outcome as DeliveryOperationOutcome, evidence });
  } catch { throw new HttpApiException('原配送回执异常，请人工核对', 503, 503); }
}
async function readReceipt(tx: DbClient, uid: number, key: string): Promise<DeliveryOperationReceipt | null> {
  const rows = await tx.select(receiptColumns).from(sql`public.delivery_order_operation_request`).where(sql`actor_uid=${uid} AND request_key=${key}::uuid`).limit(2);
  if (!rows.length) return null; if (rows.length !== 1) throw new HttpApiException('原配送回执不唯一，请人工核对', 503, 503);
  return validateStoredReceipt(rows[0], uid);
}
/** Internal verified history; no stored intent leaves the service boundary. */
export async function readDeliveryOperationHistory(db: DbClient, uid: number, orderId: number) {
  const rows = await db.select(receiptColumns).from(sql`public.delivery_order_operation_request`).where(sql`actor_uid=${uid} AND order_id=${orderId} AND outcome IN('partial-delivered','delivered')`).orderBy(sql`created_at,request_key`).limit(1001);
  if (rows.length > 1000) throw new ValidateException('配送回执历史超过完整读取容量');
  const receipts: DeliveryOperationReceipt[] = []; for (const row of rows) receipts.push(await validateStoredReceipt(row, uid)); return receipts;
}
function same(prior: DeliveryOperationReceipt, p: PreparedDeliveryOperation) {
  if (prior.request_hash !== p.hash || prior.order_id !== p.input.order_id || prior.store_id !== p.input.store_id || prior.scope_kind !== p.input.scope_kind
    || (['delivered', 'partial-delivered'].includes(prior.outcome) && prior.delivery_id !== p.input.delivery_id)) throw new HttpApiException('原请求标识已绑定不同配送操作，不能更换原内容', 409, 409);
}
async function check(tx: DbClient, p: PreparedDeliveryOperation) {
  await admissionLock(tx, p.actor.uid, p.key);
  const prior = await readReceipt(tx, p.actor.uid, p.key); if (prior) same(prior, p); return prior;
}
export async function appendDeliveryOperation(tx: DbClient, p: PreparedDeliveryOperation, deliveryIdentity: number, outcome: DeliveryOperationOutcome, evidence: Record<string, DeliveryOperationJson> = {}) {
  if (!outcomes.has(outcome) || (['partial-delivered', 'delivered'].includes(outcome) ? deliveryIdentity !== p.input.delivery_id : deliveryIdentity !== 0)) throw new ValidateException('配送回执结果无效');
  const safe = freezeManagerJson(evidence); if (new TextEncoder().encode(JSON.stringify(safe)).length > 16384) throw new ValidateException('配送回执证据超过容量');
  const prior = await check(tx, p); if (prior) { if (prior.outcome !== outcome) throw new HttpApiException('原配送操作已有确定回执，不能覆盖', 409, 409); return prior; }
  await tx.execute(sql`INSERT INTO public.delivery_order_operation_request(actor_uid,request_key,request_hash,scope_kind,delivery_id,store_id,order_id,outcome,scope_key,expected_revision,intent,evidence)
    VALUES(${p.actor.uid},${p.key}::uuid,${p.hash},${p.input.scope_kind},${deliveryIdentity},${p.input.store_id},${p.input.order_id},${outcome},${p.input.scope_key},${p.input.expected_order_revision},${JSON.stringify(p.input)}::jsonb,${JSON.stringify(safe)}::jsonb)`);
  const result = await readReceipt(tx, p.actor.uid, p.key); if (!result) throw Error('Delivery receipt did not persist'); same(result, p); return result;
}
/** Parent settlement/order resources precede user and role locks. The caller
 * additionally protects cart/refund/code authorities before fresh scope. */
export async function lockDeliveryOrder(tx: DbClient, p: PreparedDeliveryOperation): Promise<Order> {
  const [candidate] = await tx.select({ id: storeOrder.id, pid: storeOrder.pid }).from(storeOrder).where(eq(storeOrder.id, p.input.order_id)).limit(1);
  if (!candidate) throw new NotFoundException('配送订单不存在');
  const rootId = candidate.pid > 0 ? candidate.pid : candidate.id;
  await lockOrderSettlement(tx, rootId);
  const [root] = await tx.select().from(storeOrder).where(eq(storeOrder.id, rootId)).limit(1).for('update');
  if (rootId !== candidate.id) await lockOrderSettlement(tx, candidate.id);
  const [order] = rootId === candidate.id ? [root] : await tx.select().from(storeOrder).where(eq(storeOrder.id, candidate.id)).limit(1).for('update');
  if (!root || !order || order.pid !== candidate.pid || order.uid !== root.uid || root.isSystemDel || order.pid < 0 || order.isDel || order.isSystemDel
    || order.supplierAllocationStatus === 1 || order.deliveryType !== 'send' || order.deliveryUid !== p.actor.uid
    || (p.input.scope_kind === 'store' && order.storeId !== p.input.store_id)) throw new NotFoundException('订单不属于当前配送范围或状态已变化');
  return order;
}
export async function authorizeLockedDeliveryOperation(tx: DbClient, p: PreparedDeliveryOperation, order: Order, carts: Parameters<typeof deliveryOrderRevision>[1]): Promise<DeliveryScope> {
  const scope = await requireDeliveryScope(tx, p.actor, { kind: p.input.scope_kind, delivery_id: p.input.delivery_id, store_id: p.input.store_id }, { lock: true, expectedScopeKey: p.input.scope_key });
  if (order.id !== p.input.order_id || order.deliveryUid !== scope.actor_uid || order.deliveryType !== 'send' || order.isDel || order.isSystemDel || order.pid < 0
    || order.supplierAllocationStatus === 1 || (scope.kind === 'store' && order.storeId !== scope.store_id)) throw new NotFoundException('订单不属于当前配送身份');
  if (await deliveryOrderRevision(order, carts) !== p.input.expected_order_revision) throw new HttpApiException('配送订单已变化，请核对原请求与最新订单', 412, 412);
  return scope;
}
export class DeliveryOrderOperationRequest {
  constructor(readonly container: Container) {}
  async getOutcome(actorInput: DeliveryActor, keyInput: unknown) {
    const actor = deliveryActor(actorInput), key = normalizeOutRequestKey(keyInput);
    return withTx(this.container, async tx => { await admissionLock(tx, actor.uid, key, false); await requireFreshDeliveryActor(tx, actor, true); return readReceipt(tx, actor.uid, key); });
  }
  async abandon(ctx: DeliveryOperationContext, value: unknown) {
    const p = await prepareDeliveryOperation(ctx, value);
    return withTx(this.container, async tx => { const prior = await check(tx, p); await requireFreshDeliveryActor(tx, p.actor, true); return prior ?? appendDeliveryOperation(tx, p, 0, 'abandoned'); });
  }
  async localRejection(p: PreparedDeliveryOperation, error: unknown): Promise<DeliveryOperationResult | null> {
    if (!(error instanceof ValidateException || error instanceof NotFoundException || error instanceof HttpApiException && [403, 412].includes(error.httpStatus))) return null;
    // Called after the entire business transaction has actually rolled back.
    // SQL, lock, timeout, transport and commit ambiguity never prove rejection.
    return withTx(this.container, async tx => { const prior = await check(tx, p); await requireFreshDeliveryActor(tx, p.actor, true); return { receipt: prior ?? await appendDeliveryOperation(tx, p, 0, 'rollback-rejected', { code: error instanceof HttpApiException ? String(error.httpStatus) : String(error.code) }), replayed: Boolean(prior) }; });
  }
  async execute(ctx: DeliveryOperationContext, value: unknown, run: (tx: DbClient, p: PreparedDeliveryOperation) => Promise<DeliveryOperationReceipt>): Promise<DeliveryOperationResult> {
    const p = await prepareDeliveryOperation(ctx, value);
    try { return await withTx(this.container, async tx => {
      const prior = await check(tx, p); if (prior) { await requireFreshDeliveryActor(tx, p.actor, true); return { receipt: prior, replayed: true }; }
      return { receipt: await run(tx, p), replayed: false };
    }); } catch (error) { const rejected = await this.localRejection(p, error); if (rejected) return rejected; throw error; }
  }
}
