import { eq, sql } from 'drizzle-orm';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import { systemAdmin } from '@/models/schema';
import { assertProductEditorOperationReady } from '@/migrations/adminProductEditorOperation';
import { ApiErrorCode, AuthException, HttpApiException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { ADMIN_LEGACY_PRODUCT_FIELDS, assertBoundedJson } from './AdminLegacyProductInput';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, assertAdminAuthoritySession, type AdminAuthorityActor } from './AdminAuthorityWriteService';

export interface ProductEditorResult { id: number; created: boolean }
export interface ProductEditorReceipt {
  operation_id: string; actor_id: number; requested_id: number | null;
  state: 'unknown' | 'committed' | 'not_applied'; result: ProductEditorResult | null;
}
export interface ProductEditorIntent { operationId: string; actorId: number; requestedId: number; requestHash: string }
interface ReceiptRow { operation_id: string; actor_id: number; requested_id: number; request_hash: string;
  state: 'committed' | 'not_applied'; result: ProductEditorResult | null; created_at: number }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const conflict = (message: string) => new HttpApiException(message, 409, 409);
export function productEditorOperationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('商品操作ID须为小写UUIDv4');
  return value;
}
export function productEditorTarget(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    throw new ValidateException('商品目标ID错误');
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidateException('商品编辑正文须为JSON对象');
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(object(value)).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key,item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  throw new ValidateException('商品编辑正文包含不能签名的数据');
}
export function prepareProductEditorSave(value: unknown, requestedId: number, actor: AdminAuthorityActor, appKey: string) {
  assertAdminAuthoritySession(actor); productEditorTarget(requestedId);
  assertBoundedJson(value);
  const row = object(value);
  if (Object.keys(row).length !== 2 || !Object.hasOwn(row, 'operation_id') || !Object.hasOwn(row, 'product'))
    throw new ValidateException('商品编辑保存仅接受操作ID与完整商品');
  const operationId = productEditorOperationId(row.operation_id), product = object(row.product);
  if (Object.keys(product).length !== ADMIN_LEGACY_PRODUCT_FIELDS.length
    || ADMIN_LEGACY_PRODUCT_FIELDS.some(field => !Object.hasOwn(product, field)))
    throw new ValidateException('完整编辑器须提交全部59字段');
  if (product.type !== 0 || product.soure_link !== '' || product.tao_words !== '')
    throw new ValidateException('普通编辑器不接受采集或复制上下文');
  if (!appKey) throw new ServiceUnavailableException('商品操作签名尚未就绪');
  const requestHash = createHmac('sha256', appKey).update('cinashop.product-editor.request.v1\0')
    .update(canonical({ actorId: actor.id, requestedId, operationId, product })).digest('hex');
  return { product, intent: { operationId, actorId: actor.id, requestedId, requestHash } satisfies ProductEditorIntent };
}
function dto(row: ReceiptRow): ProductEditorReceipt {
  return { operation_id: row.operation_id, actor_id: row.actor_id, requested_id: row.requested_id, state: row.state, result: row.result };
}
function validate(row: ReceiptRow, actorId: number) {
  if (row.actor_id !== actorId) throw new AuthException('无权读取该商品操作', ApiErrorCode.ERR_AUTH);
  const result = row.result;
  if (!UUID.test(row.operation_id) || !Number.isSafeInteger(row.created_at) || row.created_at <= 0
    || !Number.isSafeInteger(row.requested_id) || row.requested_id < 0 || row.requested_id > 2147483647
    || row.state !== 'committed' && row.state !== 'not_applied'
    || row.state === 'not_applied' && (row.request_hash !== '' || result !== null)
    || row.state === 'committed' && (!/^[a-f0-9]{64}$/.test(row.request_hash) || !result
      || !Number.isSafeInteger(result.id) || result.id <= 0 || result.id > 2147483647
      || result.created !== (row.requested_id === 0) || row.requested_id > 0 && result.id !== row.requested_id
      || Object.keys(result).length !== 2)) throw new ServiceUnavailableException('商品操作回执不完整');
}
async function read(tx: DbClient, operationId: string, actorId: number): Promise<ReceiptRow | undefined> {
  const [row] = await tx.execute(sql`SELECT operation_id::text,actor_id,requested_id,request_hash,state,result,created_at
    FROM public.admin_product_editor_operation_v1 WHERE operation_id=${operationId}::uuid`) as unknown as ReceiptRow[];
  if (row) validate(row, actorId);
  return row;
}
async function clock(tx: DbClient, actor: AdminAuthorityActor): Promise<number> {
  assertAdminAuthoritySession(actor);
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now,
    extract(epoch FROM clock_timestamp())>=${actor.expiresAt} AS expired`) as unknown as Array<{now: number; expired: boolean}>;
  if (!row || row.expired !== false) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  return row.now;
}
async function lock(tx: DbClient, operationId: string) {
  const [row] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(1095783759,hashtext(${operationId})) AS locked`);
  if (row?.locked !== true) throw conflict('该商品操作仍在处理，请稍后恢复结果');
  await assertProductEditorOperationReady(tx);
}
/** Called inside the actual full save transaction, before config/date/body
 * normalization. A committed retry returns its original result without DML. */
export async function admitProductEditorSave(tx: DbClient, intent: ProductEditorIntent, requestedId: number, actor: AdminAuthorityActor) {
  if (intent.actorId !== actor.id || intent.requestedId !== requestedId || !/^[a-f0-9]{64}$/.test(intent.requestHash))
    throw new ValidateException('商品操作上下文不一致');
  productEditorOperationId(intent.operationId); await lock(tx, intent.operationId); await clock(tx, actor);
  const row = await read(tx, intent.operationId, actor.id);
  if (!row) return;
  if (row.requested_id !== requestedId || row.state === 'not_applied') throw conflict('商品操作已封存或目标不一致，请恢复原结果');
  if (!timingSafeEqual(new TextEncoder().encode(row.request_hash), new TextEncoder().encode(intent.requestHash)))
    throw conflict('同一商品操作ID不能更改正文');
  return dto(row);
}
async function append(tx: DbClient, row: ReceiptRow) {
  const [saved] = await tx.execute(sql`INSERT INTO public.admin_product_editor_operation_v1
    (operation_id,actor_id,requested_id,request_hash,state,result,created_at)
    VALUES(${row.operation_id}::uuid,${row.actor_id},${row.requested_id},${row.request_hash},${row.state},${row.result === null ? null : JSON.stringify(row.result)}::jsonb,${row.created_at})
    RETURNING operation_id::text,actor_id,requested_id,request_hash,state,result,created_at`) as unknown as ReceiptRow[];
  if (!saved || canonical(saved) !== canonical(row)) throw conflict('商品操作回执保存不一致');
  validate(saved, row.actor_id);
  const reread = await read(tx, row.operation_id, row.actor_id);
  if (!reread || canonical(reread) !== canonical(row)) throw conflict('商品操作回执回读不一致');
  return dto(saved);
}
export async function completeProductEditorSave(tx: DbClient, intent: ProductEditorIntent, result: ProductEditorResult, actor: AdminAuthorityActor) {
  await assertProductEditorOperationReady(tx);
  return append(tx, { operation_id: intent.operationId, actor_id: actor.id, requested_id: intent.requestedId,
    request_hash: intent.requestHash, state: 'committed', result, created_at: await clock(tx, actor) });
}
export class AdminProductEditorOperationService {
  constructor(private readonly container: Container) {}
  private async recover<T>(actor: AdminAuthorityActor, callback: (tx: DbClient) => Promise<T>) {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        await acquireAdminAuthorityWriteBarrier(tx);
        const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
        if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0)
          throw new AuthException('管理员身份已禁用或变化', ApiErrorCode.ERR_BANNED);
        if (md5(live.pwd) !== actor.authVersion) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
        const result = await callback(tx); await clock(tx, actor); return result;
      });
    } catch (error) { return adminAuthorityWriteError(error); }
  }
  receipt(value: unknown, actor: AdminAuthorityActor): Promise<ProductEditorReceipt> {
    const operationId = productEditorOperationId(value);
    return this.recover(actor, async tx => {
      await lock(tx, operationId);
      const row = await read(tx, operationId, actor.id);
      return row ? dto(row) : { operation_id: operationId, actor_id: actor.id, requested_id: null, state: 'unknown', result: null };
    });
  }
  resolve(value: unknown, requestedIdInput: unknown, actor: AdminAuthorityActor): Promise<ProductEditorReceipt> {
    const operationId = productEditorOperationId(value), requestedId = productEditorTarget(requestedIdInput);
    return this.recover(actor, async tx => {
      await lock(tx, operationId);
      const row = await read(tx, operationId, actor.id);
      if (row) {
        if (row.requested_id !== requestedId) throw conflict('商品操作目标不一致');
        return dto(row);
      }
      return append(tx, { operation_id: operationId, actor_id: actor.id, requested_id: requestedId,
        request_hash: '', state: 'not_applied', result: null, created_at: await clock(tx, actor) });
    });
  }
}
