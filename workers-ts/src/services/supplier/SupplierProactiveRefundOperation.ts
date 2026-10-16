import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { assertSupplierProactiveRefundReady } from '@/migrations/supplierProactiveRefund';
import { outRequestHash } from '@/services/out/OutIdempotency';
import type { SupplierVideoActor } from './SupplierVideoAuthority';
import {
  SUPPLIER_PROACTIVE_REFUND_VERSION, assertSupplierProactiveRefundCash,
  supplierProactiveRefundConflict, supplierProactiveRefundId, supplierProactiveRefundJson,
  supplierProactiveRefundMoney, supplierProactiveRefundUuid, type SupplierProactiveRefundIntent,
} from './SupplierProactiveRefundInput';

export interface SupplierProactiveRefundResult {
  readonly order_id: number;
  readonly refund_id: number | null;
  readonly amount: string;
  readonly kind: 'goods' | 'money' | 'refuse';
  readonly status: 'CASH_SUCCESS' | 'ZERO_SUCCESS' | 'BALANCE_SUCCESS' | 'REFUSED' | 'PROCESSING';
}
export interface SupplierProactiveRefundOperation {
  readonly operation_id: string;
  readonly actor_id: number;
  readonly supplier_id: number;
  readonly order_id: number;
  readonly state: 'committed' | 'not_applied';
  readonly kind: SupplierProactiveRefundResult['kind'] | null;
  readonly request_hash: string;
  readonly intent: SupplierProactiveRefundIntent | null;
  readonly intent_json: string | null;
  readonly source: Readonly<Record<string, unknown>> | null;
  readonly source_json: string | null;
  readonly source_hash: string;
  readonly result: SupplierProactiveRefundResult | null;
  readonly created_at: number;
}
export interface SupplierProactiveRefundReceipt {
  readonly operation_id: string;
  readonly actor_id: number;
  readonly supplier_id: number;
  readonly order_id: number | null;
  readonly state: 'unknown' | 'not_applied' | 'committed';
  readonly result: SupplierProactiveRefundResult | null;
}
export interface SupplierProactiveRefundDecision {
  readonly operation_id: string;
  readonly actor_id: number;
  readonly supplier_id: number;
  readonly order_id: number;
  readonly kind: SupplierProactiveRefundResult['kind'];
  readonly outcome: 'local-settled' | 'provider-admitted' | 'refused';
  readonly request_hash: string;
  readonly evidence: Readonly<{ refund_id: number | null }>;
  readonly evidence_json: string;
  readonly evidence_hash: string;
  readonly created_at: number;
}

const operationFields = ['operation_id', 'actor_id', 'supplier_id', 'order_id', 'state', 'kind', 'request_hash',
  'intent', 'intent_json', 'source', 'source_json', 'source_hash', 'result', 'created_at'] as const;
const decisionFields = ['operation_id', 'actor_id', 'supplier_id', 'order_id', 'kind', 'outcome', 'request_hash',
  'evidence', 'evidence_json', 'evidence_hash', 'created_at'] as const;
const validatedOperations = new WeakSet<object>();
const validatedDecisions = new WeakSet<object>();
const fact = (condition: unknown): void => {
  if (!condition) throw supplierProactiveRefundConflict('原主动退款操作、完整来源或不可变决策凭据不一致');
};
function record(value: unknown): Record<string, unknown> {
  fact(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const own = Reflect.ownKeys(value);
  fact(own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')));
}
function id(value: unknown): number {
  fact(typeof value === 'number'); return supplierProactiveRefundId(value);
}
function now(value: unknown): number { return id(value); }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function amount(value: unknown): string {
  fact(typeof value === 'string'); const result = supplierProactiveRefundMoney(value); fact(result === value); return result;
}

/** Detach before any await, reject getters, cycles and non-JSON values, and
 * retain the exact canonical bytes rather than trusting jsonb's key order. */
function detached(value: unknown, limit: number): { value: unknown; json: string } {
  const visiting = new Set<object>(); let nodes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    fact(++nodes <= 1_000_000 && depth <= 100);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { fact(Number.isFinite(item)); return item; }
    fact(typeof item === 'object' && item !== null && !visiting.has(item));
    const object = item as object; visiting.add(object);
    let result: unknown;
    if (Array.isArray(item)) {
      fact(Reflect.ownKeys(item).length === item.length + 1);
      result = Array.from({ length: item.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        fact(property && Object.hasOwn(property, 'value'));
        return copy(property!.value, depth + 1);
      });
    } else {
      const input = record(item), output: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(input)) {
        const property = Object.getOwnPropertyDescriptor(input, key);
        fact(typeof key === 'string' && property && Object.hasOwn(property, 'value') && property.enumerable);
        output[key as string] = copy(property!.value, depth + 1);
      }
      result = output;
    }
    visiting.delete(object); return Object.freeze(result);
  };
  const snapshot = copy(value, 0), json = supplierProactiveRefundJson(snapshot);
  fact(typeof json === 'string' && new TextEncoder().encode(json).length <= limit);
  return { value: snapshot, json };
}
function jsonRecord(text: unknown, limit: number): { value: Record<string, unknown>; json: string } {
  fact(typeof text === 'string' && new TextEncoder().encode(text as string).length <= limit);
  let parsed: unknown;
  try { parsed = JSON.parse(text as string); } catch { throw supplierProactiveRefundConflict('原主动退款凭据不是完整JSON'); }
  const snapshot = detached(parsed, limit); fact(snapshot.json === text);
  return { value: record(snapshot.value), json: snapshot.json };
}
function intentFromStored(value: unknown, operationId: string, actorId: number, supplierId: number, orderId: number): SupplierProactiveRefundIntent {
  const row = record(value), cash = Object.hasOwn(row, 'cash_returned');
  exact(row, ['version', 'operation_id', 'actor_id', 'supplier_id', 'order_id', 'revision', 'refund_price', 'type', ...(cash ? ['cash_returned'] : [])]);
  fact(row.version === SUPPLIER_PROACTIVE_REFUND_VERSION && row.operation_id === operationId && row.actor_id === actorId
    && row.supplier_id === supplierId && row.order_id === orderId && hash(row.revision) && [1, 2].includes(Number(row.type))
    && typeof row.type === 'number');
  const price = amount(row.refund_price);
  fact(!cash || row.cash_returned === true && row.type === 1 && price !== '0.00');
  // Historical syntax and identity are checked without fabricating a live
  // Supplier actor or re-evaluating an old authVersion-bound revision MAC.
  return Object.freeze({ version: SUPPLIER_PROACTIVE_REFUND_VERSION, operation_id: operationId, actor_id: actorId,
    supplier_id: supplierId, order_id: orderId, revision: row.revision as string, refund_price: price, type: row.type as 1 | 2,
    ...(cash ? { cash_returned: true as const } : {}) });
}
function sourceAndResult(sourceValue: unknown, resultValue: unknown, intent: SupplierProactiveRefundIntent): {
  source: Readonly<Record<string, unknown>>; result: SupplierProactiveRefundResult;
} {
  const source = record(sourceValue), result = record(resultValue);
  exact(source, ['version', 'order', 'carts', 'payment', 'refunds', 'refund_payments', 'invoices', 'promotion_rows']);
  exact(result, ['order_id', 'refund_id', 'amount', 'kind', 'status']);
  const order = record(source.order), payment = record(source.payment);
  fact(source.version === 'supplier-proactive-refund-source-v1' && order.id === intent.order_id
    && order.supplierId === intent.supplier_id && order.paid === 1 && Number.isSafeInteger(order.uid) && Number(order.uid) >= 0
    && Number.isSafeInteger(order.pid) && Number(order.pid) >= 0 && Number(order.pid) <= 2_147_483_647
    && ['cash', 'offline', 'yue', 'weixin', 'alipay', 'integral'].includes(String(order.payType)));
  const paid = amount(order.payPrice), price = amount(result.amount);
  fact(price === intent.refund_price && BigInt(price.replace('.', '')) <= BigInt(paid.replace('.', ''))
    && result.order_id === intent.order_id && ['goods', 'money', 'refuse'].includes(String(result.kind)));
  fact(id(payment.root_id) === (order.pid || order.id));
  if (['cash', 'offline'].includes(String(order.payType))) {
    fact(payment.pay_type === order.payType && payment.buyer_uid === order.uid && payment.pay_time === order.payTime
      && BigInt(amount(payment.amount).replace('.', '')) >= BigInt(paid.replace('.', '')));
  } else {
    const root = record(payment.root);
    fact(root.id === payment.root_id && root.uid === order.uid && root.payType === order.payType && root.payTime === order.payTime
      && root.paid === 1 && BigInt(amount(root.payPrice).replace('.', '')) >= BigInt(paid.replace('.', '')));
  }
  for (const key of ['carts', 'refunds', 'refund_payments', 'invoices', 'promotion_rows']) {
    fact(Array.isArray(source[key]) && (source[key] as unknown[]).length <= 200);
  }
  const carts = source.carts as unknown[], seen = new Set<number>(), seenCarts = new Set<string>();
  let quantity = 0, cartBytes = 0;
  fact(carts.length > 0);
  for (const item of carts) {
    const row = record(item), rowId = id(row.id); quantity += id(row.cartNum);
    const size = new TextEncoder().encode(typeof row.cartInfo === 'string' ? row.cartInfo : '').length;
    fact(!seen.has(rowId) && row.oid === intent.order_id && row.uid === order.uid && typeof row.cartId === 'string'
      && row.cartId.length > 0 && row.cartId.length <= 50 && !seenCarts.has(row.cartId) && size <= 65_536);
    seen.add(rowId); seenCarts.add(row.cartId as string); cartBytes += size;
  }
  fact(quantity === id(order.totalNum) && cartBytes <= 8_388_608);
  if (result.kind === 'refuse') {
    fact(intent.type === 2 && result.refund_id === null && result.status === 'REFUSED');
  } else {
    fact(intent.type === 1);
    if (result.kind === 'goods') id(result.refund_id);
    else if (result.refund_id !== null) id(result.refund_id);
    if (price === '0.00') fact(result.kind === 'goods' && paid === '0.00' && result.status === 'ZERO_SUCCESS');
    else fact(result.status === (['cash', 'offline'].includes(String(order.payType)) ? 'CASH_SUCCESS'
      : order.payType === 'yue' ? 'BALANCE_SUCCESS' : ['weixin', 'alipay'].includes(String(order.payType)) ? 'PROCESSING' : ''));
  }
  assertSupplierProactiveRefundCash(intent, price === '0.00' ? 'zero'
    : ['cash', 'offline'].includes(String(order.payType)) ? 'cash' : order.payType === 'yue' ? 'balance'
      : order.payType === 'integral' ? 'zero' : 'provider');
  return { source, result: result as unknown as SupplierProactiveRefundResult };
}
function transaction(tx: DbClient): void { fact(!Object.hasOwn(tx, '$client')); }

async function validateOperation(value: unknown): Promise<SupplierProactiveRefundOperation> {
  // jsonb and its canonical text duplicate the same bounded source here;
  // escaping the text can increase the aggregate row size independently.
  const row = record(detached(value, 100_800_768).value); exact(row, operationFields);
  const operationId = supplierProactiveRefundUuid(row.operation_id), actorId = id(row.actor_id),
    supplierId = id(row.supplier_id), orderId = id(row.order_id), createdAt = now(row.created_at);
  if (row.state === 'not_applied') {
    fact(row.kind === null && row.request_hash === '' && row.source_hash === '' && row.intent === null
      && row.intent_json === null && row.source === null && row.source_json === null && row.result === null);
  } else {
    fact(row.state === 'committed' && hash(row.request_hash) && hash(row.source_hash));
    const storedIntent = jsonRecord(row.intent_json, 16_384), storedSource = jsonRecord(row.source_json, 16_777_216);
    const intent = intentFromStored(storedIntent.value, operationId, actorId, supplierId, orderId);
    fact(storedIntent.json === supplierProactiveRefundJson(row.intent) && storedIntent.json === supplierProactiveRefundJson(intent)
      && storedSource.json === supplierProactiveRefundJson(row.source)
      && await outRequestHash(intent) === row.request_hash && await outRequestHash(storedSource.value) === row.source_hash);
    const bound = sourceAndResult(storedSource.value, row.result, intent);
    fact(row.kind === bound.result.kind); detached(bound.result, 65_536);
  }
  const operation = Object.freeze({ ...row, operation_id: operationId, actor_id: actorId, supplier_id: supplierId,
    order_id: orderId, created_at: createdAt }) as unknown as SupplierProactiveRefundOperation;
  validatedOperations.add(operation); return operation;
}
function validOperation(operation: SupplierProactiveRefundOperation): void { fact(validatedOperations.has(operation)); }

export async function lockSupplierProactiveRefundOperation(tx: DbClient, operationId: string): Promise<void> {
  transaction(tx); const uuid = supplierProactiveRefundUuid(operationId);
  const [held] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731628,hashtext(${'supplier-proactive-refund:' + uuid})) AS held`);
  fact(held?.held === true); await assertSupplierProactiveRefundReady(tx);
}
/** Global lookup is intentional: another identity's UUID cannot be reused as
 * a new operation. No mutation or not_applied fence is created by a read. */
export async function readSupplierProactiveRefundOperation(tx: DbClient, operationId: string): Promise<SupplierProactiveRefundOperation | undefined> {
  transaction(tx); const uuid = supplierProactiveRefundUuid(operationId); await assertSupplierProactiveRefundReady(tx, 'read');
  const rows = await tx.execute<Record<string, unknown>>(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,state,kind,request_hash,
    intent,intent_json,source,source_json,source_hash,result,created_at FROM public.supplier_proactive_refund_operation_v1
    WHERE operation_id=${uuid}::uuid LIMIT 2`);
  fact(rows.length <= 1); return rows[0] ? validateOperation(rows[0]) : undefined;
}
export function unknownSupplierProactiveRefund(operationId: string, actor: SupplierVideoActor): SupplierProactiveRefundReceipt {
  return Object.freeze({ operation_id: supplierProactiveRefundUuid(operationId), actor_id: id(actor.id),
    supplier_id: id(actor.supplierId), order_id: null, state: 'unknown', result: null });
}
/** A caller publishing a committed receipt must first read its decision.
 * Operation-only reads remain available while the same transaction executes
 * its first goods effects and the whole-invoice adapter loads the admission. */
export function supplierProactiveRefundReceipt(operation: SupplierProactiveRefundOperation, actor: SupplierVideoActor): SupplierProactiveRefundReceipt {
  validOperation(operation);
  fact(operation.actor_id === actor.id && operation.supplier_id === actor.supplierId);
  fact(operation.state !== 'committed' || validatedDecisions.has(operation));
  return Object.freeze({ operation_id: operation.operation_id, actor_id: operation.actor_id, supplier_id: operation.supplier_id,
    order_id: operation.order_id, state: operation.state, result: operation.result });
}

export async function appendSupplierProactiveRefundOperation(tx: DbClient, input: {
  operationId: string; orderId: number; actor: SupplierVideoActor; now: number;
  intent: SupplierProactiveRefundIntent | null; requestHash: string; source: unknown; result: SupplierProactiveRefundResult | null;
}): Promise<SupplierProactiveRefundOperation> {
  transaction(tx);
  const operationId = supplierProactiveRefundUuid(input.operationId), actorId = id(input.actor.id), supplierId = id(input.actor.supplierId),
    orderId = id(input.orderId), createdAt = now(input.now), requestHash = input.requestHash;
  const intent = input.intent === null ? null : detached(input.intent, 16_384),
    source = input.source === null ? null : detached(input.source, 16_777_216),
    result = input.result === null ? null : detached(input.result, 65_536);
  fact((intent === null && source === null && result === null && requestHash === '') || (intent && source && result && hash(requestHash)));
  const resultValue = result ? record(result.value) : null;
  // The money-only executor requires a separately verified completion chain;
  // this first-generation writer cannot admit it through a goods source.
  fact(resultValue?.kind !== 'money');
  const expected = await validateOperation({ operation_id: operationId, actor_id: actorId, supplier_id: supplierId,
    order_id: orderId, state: result ? 'committed' : 'not_applied', kind: resultValue?.kind ?? null, request_hash: requestHash,
    intent: intent?.value ?? null, intent_json: intent?.json ?? null, source: source?.value ?? null,
    source_json: source?.json ?? null, source_hash: source ? await outRequestHash(source.value) : '',
    result: result?.value ?? null, created_at: createdAt });
  await lockSupplierProactiveRefundOperation(tx, operationId);
  // The coordinator must rule out orphan financial/business evidence before
  // appending not_applied. This low-level append never infers absence from an
  // absent operation row and never rewrites a previous immutable admission.
  await tx.execute(sql`INSERT INTO public.supplier_proactive_refund_operation_v1
    (operation_id,actor_id,supplier_id,order_id,state,kind,request_hash,intent,intent_json,source,source_json,source_hash,result,created_at)
    VALUES(${operationId}::uuid,${actorId},${supplierId},${orderId},${expected.state},${expected.kind},${requestHash},
      ${intent?.json ?? null}::jsonb,${intent?.json ?? null},${source?.json ?? null}::jsonb,${source?.json ?? null},${expected.source_hash},
      ${result?.json ?? null}::jsonb,${createdAt})`);
  const saved = await readSupplierProactiveRefundOperation(tx, operationId);
  fact(saved && supplierProactiveRefundJson(saved) === supplierProactiveRefundJson(expected)); return saved!;
}

async function validateDecision(value: unknown, operation: SupplierProactiveRefundOperation): Promise<SupplierProactiveRefundDecision> {
  validOperation(operation); fact(operation.state === 'committed' && operation.result);
  const row = record(detached(value, 33_570_816).value); exact(row, decisionFields);
  const evidence = jsonRecord(row.evidence_json, 16_777_216); exact(evidence.value, ['refund_id']);
  const expectedOutcome = operation.kind === 'refuse' ? 'refused'
    : operation.result!.status === 'PROCESSING' ? 'provider-admitted' : 'local-settled';
  fact(row.operation_id === operation.operation_id && row.actor_id === operation.actor_id && row.supplier_id === operation.supplier_id
    && row.order_id === operation.order_id && row.kind === operation.kind && row.outcome === expectedOutcome
    && row.request_hash === operation.request_hash && evidence.value.refund_id === operation.result!.refund_id
    && evidence.json === supplierProactiveRefundJson(row.evidence) && hash(row.evidence_hash)
    && await outRequestHash(evidence.value) === row.evidence_hash);
  fact(now(row.created_at) >= operation.created_at);
  return Object.freeze(row) as unknown as SupplierProactiveRefundDecision;
}
export async function readSupplierProactiveRefundDecision(tx: DbClient, operation: SupplierProactiveRefundOperation): Promise<SupplierProactiveRefundDecision | undefined> {
  transaction(tx); validOperation(operation); await assertSupplierProactiveRefundReady(tx, 'read');
  const rows = await tx.execute<Record<string, unknown>>(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,kind,outcome,request_hash,
    evidence,evidence_json,evidence_hash,created_at FROM public.supplier_proactive_refund_decision_v1
    WHERE operation_id=${operation.operation_id}::uuid LIMIT 2`);
  fact(rows.length <= 1);
  if (!rows[0]) return;
  const decision = await validateDecision(rows[0], operation); validatedDecisions.add(operation); return decision;
}
export async function appendSupplierProactiveRefundDecision(tx: DbClient, operation: SupplierProactiveRefundOperation, input: {
  outcome: SupplierProactiveRefundDecision['outcome']; evidence: Readonly<{ refund_id: number | null }>; now: number;
}): Promise<SupplierProactiveRefundDecision> {
  transaction(tx); validOperation(operation);
  const evidence = detached(input.evidence, 16_777_216), outcome = input.outcome, createdAt = now(input.now);
  const expected = await validateDecision({ operation_id: operation.operation_id, actor_id: operation.actor_id,
    supplier_id: operation.supplier_id, order_id: operation.order_id, kind: operation.kind, outcome,
    request_hash: operation.request_hash, evidence: evidence.value, evidence_json: evidence.json,
    evidence_hash: await outRequestHash(evidence.value), created_at: createdAt }, operation);
  await lockSupplierProactiveRefundOperation(tx, operation.operation_id);
  const prior = await readSupplierProactiveRefundDecision(tx, operation);
  if (prior) {
    fact(prior.outcome === expected.outcome && prior.evidence_json === expected.evidence_json
      && prior.evidence_hash === expected.evidence_hash); return prior;
  }
  await tx.execute(sql`INSERT INTO public.supplier_proactive_refund_decision_v1
    (operation_id,actor_id,supplier_id,order_id,kind,outcome,request_hash,evidence,evidence_json,evidence_hash,created_at)
    VALUES(${operation.operation_id}::uuid,${operation.actor_id},${operation.supplier_id},${operation.order_id},${operation.kind},${outcome},
      ${operation.request_hash},${evidence.json}::jsonb,${evidence.json},${expected.evidence_hash},${createdAt})`);
  const saved = await readSupplierProactiveRefundDecision(tx, operation);
  fact(saved && supplierProactiveRefundJson(saved) === supplierProactiveRefundJson(expected)); return saved!;
}
export async function replaySupplierProactiveRefundOperation(tx: DbClient, input: {
  orderId: number; actor: SupplierVideoActor; intent: SupplierProactiveRefundIntent; requestHash: string;
}): Promise<SupplierProactiveRefundReceipt | undefined> {
  const orderId = id(input.orderId), actor = Object.freeze({ ...input.actor }),
    intent = detached(input.intent, 16_384), requestHash = input.requestHash;
  const parsed = intentFromStored(intent.value, supplierProactiveRefundUuid(record(intent.value).operation_id), id(actor.id), id(actor.supplierId), orderId);
  fact(hash(requestHash) && await outRequestHash(parsed) === requestHash);
  await lockSupplierProactiveRefundOperation(tx, parsed.operation_id);
  const operation = await readSupplierProactiveRefundOperation(tx, parsed.operation_id); if (!operation) return;
  fact(operation.state === 'committed' && operation.actor_id === actor.id && operation.supplier_id === actor.supplierId
    && operation.order_id === orderId && operation.request_hash === requestHash && operation.intent_json === intent.json);
  fact(await readSupplierProactiveRefundDecision(tx, operation)); return supplierProactiveRefundReceipt(operation, actor);
}
