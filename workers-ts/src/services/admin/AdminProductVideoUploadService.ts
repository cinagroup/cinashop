import { and, eq, sql } from 'drizzle-orm';
import { createHash, createHmac } from 'node:crypto';
import { withTx, type Container, type DbClient } from '@/lib/di';
import type { Env, ProductVideoCleanupMessage } from '@/env';
import { systemAdmin, systemAttachment, systemAttachmentCategory } from '@/models/schema';
import { assertProductVideoUploadReady } from '@/migrations/adminProductVideoUpload';
import { ApiErrorCode, AuthException, HttpApiException, NotFoundException, ServiceUnavailableException, ValidateException } from '@/utils/errors';
import { md5 } from '@/utils/jwt';
import { composeProductVideo } from '@/services/system/ProductVideoCompose';
import { canonicalAttachmentPath, detectMp4Type, normalizeExternalVideoCoverUrl, normalizeExternalVideoUrl, signAttachmentReferences } from '@/services/system/AttachmentService';
import { acquireAdminAuthorityWriteBarrier, adminAuthorityWriteError, assertAdminAuthoritySession, loadAdminAuthorityLiveActor, type AdminAuthorityActor } from './AdminAuthorityWriteService';

export const PRODUCT_VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const PRODUCT_VIDEO_CHUNK_BYTES = 5 * 1024 * 1024;
export const PRODUCT_VIDEO_TTL = 12 * 3600;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const conflict = (message: string) => new HttpApiException(message, 409, 409);
const unavailable = () => new ServiceUnavailableException('视频上传会话资料不完整，请查询原结果');
type Part = { sha256: string; size: number };
export interface ProductVideoIntent {
  version: 1; mode: 'manifest' | 'legacy'; filename: string; total_size: number | null;
  chunk_size: number; total_chunks: number; sha256: string[] | null; pid: number; client_md5: string | null;
}
interface UploadRow {
  upload_id: string; actor_id: number; request_hash: string; intent: ProductVideoIntent | null; object_key: string | null;
  state: 'active' | 'cancelled' | 'committed'; parts: Record<string, Part>; confirmed: number[];
  attachment_id: number | null; created_at: number; updated_at: number; expires_at: number;
}
export interface ProductVideoReceipt {
  upload_id: string; actor_id: number; state: 'unknown' | 'active' | 'expired' | 'cancelled' | 'committed';
  manifest: ProductVideoIntent | null; confirmed: number[];
  result: { id: number; url: string; size: number } | null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidateException('视频参数须为对象');
  return value as Record<string, unknown>;
}
function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new ValidateException(`${label}无效`);
  return value;
}
function filename(value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || [...value].length > 255
    || /[\\/\u0000-\u001f\u007f]/u.test(value) || !/\.mp4$/i.test(value)) throw new ValidateException('视频文件名须为MP4，最多255字符');
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(object(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
}
export function productVideoUploadId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidateException('视频上传ID须为小写UUIDv4');
  return value;
}
export function normalizeProductVideoManifest(value: unknown): ProductVideoIntent {
  const row = object(value), fields = ['filename', 'total_size', 'chunk_size', 'sha256', 'pid'];
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) throw new ValidateException('视频初始化参数不完整');
  const total = integer(row.total_size, 12, PRODUCT_VIDEO_MAX_BYTES, '视频大小'), chunk = integer(row.chunk_size, 12, PRODUCT_VIDEO_CHUNK_BYTES, '视频分片大小');
  const count = Math.ceil(total / chunk);
  if (count > 100 || !Array.isArray(row.sha256) || row.sha256.length !== count || row.sha256.some(hash => typeof hash !== 'string' || !SHA.test(hash)))
    throw new ValidateException('视频须提供每片SHA256摘要，最多100片');
  return { version: 1, mode: 'manifest', filename: filename(row.filename), total_size: total, chunk_size: chunk,
    total_chunks: count, sha256: [...row.sha256], pid: integer(row.pid, 0, 2147483647, '视频分类'), client_md5: null };
}
export function normalizeLegacyVideoManifest(value: Record<string, unknown>): ProductVideoIntent {
  const number = (v: unknown, min: number, max: number, label: string) => {
    if (typeof v !== 'string' || !/^(?:0|[1-9]\d*)$/.test(v)) throw new ValidateException(`${label}无效`);
    return integer(Number(v), min, max, label);
  };
  const count = number(value.totalChunks, 1, 100, '视频分片数量'), chunk = number(value.chunkSize, 12, PRODUCT_VIDEO_CHUNK_BYTES, '视频分片大小');
  if ((count - 1) * chunk + 1 > PRODUCT_VIDEO_MAX_BYTES) throw new ValidateException('视频不能超过100 MiB');
  const digest = typeof value.md5 === 'string' ? value.md5.toLowerCase() : '';
  if (!/^[a-f0-9]{32}$/.test(digest)) throw new ValidateException('旧视频上传标识无效');
  return { version: 1, mode: 'legacy', filename: filename(value.filename), total_size: null, chunk_size: chunk,
    // PHP's product editor appends an omitted pid as the literal "undefined";
    // its server casts that legacy value to the root category.
    total_chunks: count, sha256: null, pid: value.pid === null || value.pid === 'undefined' ? 0 : number(value.pid, 0, 2147483647, '视频分类'), client_md5: digest };
}
function validateIntent(value: unknown): ProductVideoIntent {
  const row = object(value);
  if (row.version !== 1 || Object.keys(row).length !== 9) throw unavailable();
  const normalized = row.mode === 'manifest' ? normalizeProductVideoManifest({ filename: row.filename, total_size: row.total_size,
    chunk_size: row.chunk_size, sha256: row.sha256, pid: row.pid }) : row.mode === 'legacy' ? normalizeLegacyVideoManifest({
    filename: row.filename, totalChunks: String(row.total_chunks), chunkSize: String(row.chunk_size), pid: String(row.pid), md5: row.client_md5 }) : null;
  if (!normalized || canonical(normalized) !== canonical(row)) throw unavailable();
  return normalized;
}
function finalKey(uploadId: string, createdAt: number): string {
  const date = new Date(createdAt * 1000);
  return `attachments/admin/1/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${uploadId}.mp4`;
}
const partKey = (row: UploadRow, index: number) => `attachments/tmp/admin/${row.actor_id}/${row.upload_id}/${index}.part`;
const sizeOf = (row: UploadRow) => Object.values(row.parts).reduce((sum, part) => sum + part.size, 0);
function validateRow(row: UploadRow): void {
  try {
    productVideoUploadId(row.upload_id); integer(row.actor_id, 1, 2147483647, '视频账号');
    integer(row.created_at, 1, 2147483647 - PRODUCT_VIDEO_TTL, '视频创建时间');
    integer(row.updated_at, row.created_at, 2147483647, '视频更新时间');
    if (row.expires_at !== row.created_at + PRODUCT_VIDEO_TTL || !['active', 'cancelled', 'committed'].includes(row.state)) throw unavailable();
    const parts = object(row.parts);
    if (!Array.isArray(row.confirmed) || row.confirmed.length > 100 || new Set(row.confirmed).size !== row.confirmed.length) throw unavailable();
    if (row.intent === null) {
      if (row.state !== 'cancelled' || row.object_key !== null || row.attachment_id !== null || row.request_hash !== '' || Object.keys(parts).length || row.confirmed.length) throw unavailable();
      return;
    }
    const intent = validateIntent(row.intent);
    if (!SHA.test(row.request_hash) || row.object_key !== finalKey(row.upload_id, row.created_at) || Object.keys(parts).length > intent.total_chunks) throw unavailable();
    for (const [key, value] of Object.entries(parts)) {
      if (!/^[1-9]\d*$/.test(key)) throw unavailable();
      const index = integer(Number(key), 1, intent.total_chunks, '视频片号'), part = object(value);
      if (Object.keys(part).length !== 2 || typeof part.sha256 !== 'string' || !SHA.test(part.sha256)) throw unavailable();
      const size = integer(part.size, 1, intent.chunk_size, '视频片长');
      if (index < intent.total_chunks && size !== intent.chunk_size || index === 1 && size < 12
        || intent.mode === 'manifest' && (intent.sha256![index - 1] !== part.sha256 || size !== Math.min(intent.chunk_size, intent.total_size! - (index - 1) * intent.chunk_size))) throw unavailable();
    }
    if (sizeOf(row) > PRODUCT_VIDEO_MAX_BYTES || row.confirmed.some(index => !Number.isSafeInteger(index) || !Object.hasOwn(parts, String(index)))) throw unavailable();
    if (row.state === 'committed') {
      integer(row.attachment_id, 1, 2147483647, '视频素材ID');
      if (row.confirmed.length !== intent.total_chunks || Object.keys(parts).length !== intent.total_chunks) throw unavailable();
    } else if (row.attachment_id !== null) throw unavailable();
  } catch { throw unavailable(); }
}
function receipt(row: UploadRow, now: number): ProductVideoReceipt {
  return { upload_id: row.upload_id, actor_id: row.actor_id, state: row.state === 'active' && now >= row.expires_at ? 'expired' : row.state,
    manifest: row.intent, confirmed: [...row.confirmed].sort((a, b) => a - b), result: row.state === 'committed'
      ? { id: row.attachment_id!, url: canonicalAttachmentPath(row.attachment_id!), size: sizeOf(row) } : null };
}
async function clock(tx: DbClient, actor?: AdminAuthorityActor): Promise<number> {
  const [row] = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
  const now = Number(row?.now); integer(now, 1, 2147483647 - PRODUCT_VIDEO_TTL, '数据库时间');
  if (actor && now >= actor.expiresAt) throw new AuthException('登录已过期', ApiErrorCode.ERR_EXPIRED);
  return now;
}
async function lock(tx: DbClient, id: string): Promise<void> {
  const [row] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,hashtext(${id})) AS locked`);
  if (row?.locked !== true) throw conflict('该视频会话仍在处理，请先查询原结果');
  await assertProductVideoUploadReady(tx);
  await tx.execute(sql`LOCK TABLE ONLY public.admin_product_video_upload_v1 IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
}
async function read(tx: DbClient, id: string, actorId?: number): Promise<UploadRow | undefined> {
  const [row] = await tx.execute(sql`SELECT upload_id::text,actor_id,request_hash,
    CASE WHEN intent IS NULL OR octet_length(intent::text)<=16384 THEN intent ELSE NULL END AS intent,
    object_key,state,parts,CASE WHEN octet_length(confirmed::text)<=1024 THEN confirmed ELSE NULL END AS confirmed,
    attachment_id,created_at,updated_at,expires_at FROM public.admin_product_video_upload_v1 WHERE upload_id=${id}::uuid`) as unknown as UploadRow[];
  if (row) { validateRow(row); if (actorId !== undefined && row.actor_id !== actorId) throw new AuthException('无权读取该视频上传', ApiErrorCode.ERR_AUTH); }
  return row;
}
async function prove(tx: DbClient, expected: UploadRow): Promise<UploadRow> {
  const row = await read(tx, expected.upload_id, expected.actor_id);
  if (!row || canonical(row) !== canonical(expected)) throw conflict('视频会话回读不一致');
  return row;
}
async function insert(tx: DbClient, row: UploadRow): Promise<UploadRow> {
  const [saved] = await tx.execute(sql`INSERT INTO public.admin_product_video_upload_v1
    (upload_id,actor_id,request_hash,intent,object_key,state,parts,confirmed,attachment_id,created_at,updated_at,expires_at)
    VALUES(${row.upload_id}::uuid,${row.actor_id},${row.request_hash},${row.intent === null ? null : JSON.stringify(row.intent)}::jsonb,
      ${row.object_key},${row.state},${JSON.stringify(row.parts)}::jsonb,${JSON.stringify(row.confirmed)}::jsonb,
      ${row.attachment_id},${row.created_at},${row.updated_at},${row.expires_at})
    RETURNING upload_id::text,actor_id,request_hash,intent,object_key,state,parts,confirmed,attachment_id,created_at,updated_at,expires_at`) as unknown as UploadRow[];
  if (!saved || canonical(saved) !== canonical(row)) throw conflict('视频会话未完整保存');
  return prove(tx, row);
}
async function update(tx: DbClient, row: UploadRow, change: Pick<UploadRow, 'state' | 'parts' | 'confirmed' | 'attachment_id' | 'updated_at'>): Promise<UploadRow> {
  const expected = { ...row, ...change };
  const rows = await tx.execute(sql`UPDATE public.admin_product_video_upload_v1 SET state=${change.state},parts=${JSON.stringify(change.parts)}::jsonb,
    confirmed=${JSON.stringify(change.confirmed)}::jsonb,attachment_id=${change.attachment_id},updated_at=${change.updated_at}
    WHERE upload_id=${row.upload_id}::uuid AND state='active'
    RETURNING upload_id::text,actor_id,request_hash,intent,object_key,state,parts,confirmed,attachment_id,created_at,updated_at,expires_at`) as unknown as UploadRow[];
  if (rows.length !== 1 || canonical(rows[0]) !== canonical(expected)) throw conflict('视频会话未完整更新');
  return prove(tx, expected);
}
async function lockLibrary(tx: DbClient, pid: number): Promise<void> {
  await tx.execute(sql`LOCK TABLE ONLY public.system_attachment_category, ONLY public.system_attachment IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
  if (pid) {
    const rows = await tx.select().from(systemAttachmentCategory).where(and(eq(systemAttachmentCategory.id, pid),
      eq(systemAttachmentCategory.type, 1), eq(systemAttachmentCategory.relationId, 0), eq(systemAttachmentCategory.fileType, 2))).limit(1);
    if (rows.length !== 1) throw new NotFoundException('视频分类不存在或不属于平台');
  }
}
const active = (row: UploadRow, now: number) => {
  if (row.state !== 'active' || now >= row.expires_at) throw conflict('视频会话已取消、过期或提交，请先查询原结果');
};
export function isProductVideoCleanupMessage(value: unknown): value is ProductVideoCleanupMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && row.action === 'cleanupProductVideoUpload' && typeof row.uploadId === 'string' && UUID.test(row.uploadId);
}

/** SQL reservations and terminal facts surround R2 I/O. No transaction stays
 * open during upload/composition, and uncertain commits never authorize delete. */
export class AdminProductVideoUploadService {
  constructor(private readonly container: Container, private readonly env: Env) {}
  private hash(row: Pick<UploadRow, 'upload_id' | 'actor_id' | 'intent' | 'object_key'>): string {
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('视频会话签名未配置');
    return createHmac('sha256', this.env.APP_KEY).update('cinashop.product-video.upload.v1\0').update(canonical(row)).digest('hex');
  }
  private verify(row: UploadRow): void {
    if (row.request_hash !== this.hash({ upload_id: row.upload_id, actor_id: row.actor_id, intent: row.intent, object_key: row.object_key }))
      throw conflict('视频会话签名已变化，请取消原会话后重新选择文件');
  }
  private async transaction<T>(actor: AdminAuthorityActor, capability: string | null, callback: (tx: DbClient, now: number) => Promise<T>): Promise<T> {
    assertAdminAuthoritySession(actor);
    try {
      return await withTx(this.container, async tx => {
        await acquireAdminAuthorityWriteBarrier(tx);
        if (capability) await loadAdminAuthorityLiveActor(tx, actor, capability);
        else {
          const [live] = await tx.select().from(systemAdmin).where(eq(systemAdmin.id, actor.id)).limit(1);
          if (!live || live.adminType !== 1 || live.relationId !== 0 || live.status !== 1 || live.isDel !== 0)
            throw new AuthException('管理员身份已变化', ApiErrorCode.ERR_BANNED);
          if (md5(live.pwd) !== actor.authVersion) throw new AuthException('登录凭据已变化', ApiErrorCode.ERR_EXPIRED);
        }
        const result = await callback(tx, await clock(tx, actor));
        if (capability) await loadAdminAuthorityLiveActor(tx, actor, capability);
        await clock(tx, actor); return result;
      });
    } catch (error) { return adminAuthorityWriteError(error); }
  }
  private async enqueue(id: string, delaySeconds = PRODUCT_VIDEO_TTL): Promise<void> {
    // Enqueue BEFORE every provider write; failure leaves only a resumable SQL
    // reservation. The consumer rereads durable state instead of trusting keys.
    await this.env.ORDER_QUEUE.send({ action: 'cleanupProductVideoUpload', uploadId: id }, { delaySeconds });
  }
  async initialize(value: unknown, manifest: unknown, actor: AdminAuthorityActor): Promise<ProductVideoReceipt> {
    const id = productVideoUploadId(value), intent = normalizeProductVideoManifest(manifest);
    return this.initializeIntent(id, intent, actor);
  }
  private async initializeIntent(id: string, intent: ProductVideoIntent, actor: AdminAuthorityActor, mustExist = false): Promise<ProductVideoReceipt> {
    return this.transaction(actor, 'attachment.manage', async (tx, now) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      if (row) {
        if (row.intent === null || canonical(row.intent) !== canonical(intent)) throw conflict('同一视频上传ID不能更改文件或分类');
        if (row.state === 'active') { active(row, now); this.verify(row); }
        return receipt(row, now);
      }
      if (mustExist) throw conflict('请从视频第一片开始上传');
      await lockLibrary(tx, intent.pid);
      const next: UploadRow = { upload_id: id, actor_id: actor.id, intent, object_key: finalKey(id, now), request_hash: '',
        state: 'active', parts: {}, confirmed: [], attachment_id: null, created_at: now, updated_at: now, expires_at: now + PRODUCT_VIDEO_TTL };
      next.request_hash = this.hash({ upload_id: id, actor_id: actor.id, intent, object_key: next.object_key });
      return receipt(await insert(tx, next), now);
    });
  }
  query(value: unknown, actor: AdminAuthorityActor): Promise<ProductVideoReceipt> {
    const id = productVideoUploadId(value);
    return this.transaction(actor, null, async (tx, now) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      return row ? receipt(row, now) : { upload_id: id, actor_id: actor.id, state: 'unknown', manifest: null, confirmed: [], result: null };
    });
  }
  async cancel(value: unknown, actor: AdminAuthorityActor): Promise<ProductVideoReceipt> {
    const id = productVideoUploadId(value);
    const result = await this.transaction(actor, null, async (tx, now) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      if (row) return receipt(row.state === 'active' ? await update(tx, row, { state: 'cancelled', parts: row.parts,
        confirmed: row.confirmed, attachment_id: null, updated_at: Math.max(now, row.updated_at) }) : row, now);
      return receipt(await insert(tx, { upload_id: id, actor_id: actor.id, request_hash: '', intent: null, object_key: null,
        state: 'cancelled', parts: {}, confirmed: [], attachment_id: null, created_at: now, updated_at: now, expires_at: now + PRODUCT_VIDEO_TTL }), now);
    });
    if (result.manifest) await this.enqueue(id); return result;
  }
  /** Controller can check admission before buffering a raw chunk. The final
   * reservation and metadata transaction still recheck current authority. */
  authorizeChunk(value: unknown, actor: AdminAuthorityActor): Promise<void> {
    const id = productVideoUploadId(value);
    return this.transaction(actor, 'attachment.manage', async (tx, now) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      if (!row) throw new NotFoundException('视频上传会话不存在');
      if (row.state !== 'committed') { active(row, now); this.verify(row); }
    });
  }
  async putPart(value: unknown, indexValue: unknown, bytes: Uint8Array, actor: AdminAuthorityActor): Promise<ProductVideoReceipt> {
    const id = productVideoUploadId(value), index = integer(indexValue, 1, 100, '视频片号');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PRODUCT_VIDEO_CHUNK_BYTES) throw new ValidateException('视频分片须在5 MiB以内');
    const digest = createHash('sha256').update(bytes).digest('hex'), part: Part = { sha256: digest, size: bytes.length };
    const reservation = await this.transaction(actor, 'attachment.manage', async (tx, now) => {
      await lock(tx, id); let row = await read(tx, id, actor.id);
      if (!row || !row.intent) throw new NotFoundException('视频上传会话不存在');
      const intent = row.intent;
      if (index > intent.total_chunks || bytes.length > intent.chunk_size || index < intent.total_chunks && bytes.length !== intent.chunk_size
        || (intent.mode === 'manifest' && (intent.sha256![index - 1] !== digest
          || bytes.length !== Math.min(intent.chunk_size, intent.total_size! - (index - 1) * intent.chunk_size)))) throw conflict('视频分片与原文件摘要或大小不一致');
      if (index === 1 && !detectMp4Type(bytes)) throw new ValidateException('视频内容不是MP4');
      const previous = row.parts[String(index)];
      if (previous && canonical(previous) !== canonical(part)) throw conflict('同一视频片号不能替换内容');
      if (row.state === 'committed') return { row, now, write: false };
      active(row, now); this.verify(row);
      await lockLibrary(tx, intent.pid);
      if (!previous) row = await update(tx, row, { state: 'active', parts: { ...row.parts, [index]: part }, confirmed: row.confirmed,
        attachment_id: null, updated_at: Math.max(now, row.updated_at) });
      return { row, now, write: true };
    });
    if (!reservation.write) return receipt(reservation.row, reservation.now);
    await this.enqueue(id);
    const stored = await this.env.ASSETS_BUCKET.put(partKey(reservation.row, index), bytes, {
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
      customMetadata: { uploadId: id, part: String(index), sha256: digest } });
    // A cancellation/expiry cleanup can run while the provider write is in
    // flight. A fresh message after the write also covers that late object.
    await this.enqueue(id);
    if (!stored || stored.size !== bytes.length) throw conflict('视频分片存储结果未确认，请查询后重试原分片');
    return this.transaction(actor, 'attachment.manage', async (tx, now) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      if (!row || canonical(row.parts[String(index)]) !== canonical(part)) throw unavailable();
      if (row.state === 'committed') return receipt(row, now);
      active(row, now); this.verify(row); await lockLibrary(tx, row.intent!.pid);
      if (row.confirmed.includes(index)) return receipt(row, now);
      return receipt(await update(tx, row, { state: 'active', parts: row.parts, confirmed: [...row.confirmed, index].sort((a, b) => a - b),
        attachment_id: null, updated_at: Math.max(now, row.updated_at) }), now);
    });
  }
  private async compose(row: UploadRow): Promise<void> {
    await composeProductVideo(this.env.ASSETS_BUCKET, { destination: row.object_key!,
      parts: Array.from({ length: row.intent!.total_chunks }, (_, index) => ({ key: partKey(row, index + 1), ...row.parts[String(index + 1)] })) });
  }
  async complete(value: unknown, actor: AdminAuthorityActor): Promise<ProductVideoReceipt> {
    const id = productVideoUploadId(value);
    const prepared = await this.transaction(actor, 'attachment.manage', async (tx, now) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      if (!row || !row.intent) throw new NotFoundException('视频上传会话不存在');
      if (row.state === 'committed') return { row, now };
      active(row, now); this.verify(row); await lockLibrary(tx, row.intent.pid);
      if (row.confirmed.length !== row.intent.total_chunks || Object.keys(row.parts).length !== row.intent.total_chunks) throw conflict('视频分片尚未全部确认，请查询原结果');
      return { row, now };
    });
    if (prepared.row.state === 'committed') return receipt(prepared.row, prepared.now);
    await this.enqueue(id); await this.compose(prepared.row); await this.enqueue(id);
    // Keep final objects on every failure, including definite SQL rejections:
    // another identical finalizer may already have committed this same key.
    return this.transaction(actor, 'attachment.manage', async (tx, now) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      if (!row || !row.intent) throw unavailable();
      if (row.state === 'committed') return receipt(row, now);
      active(row, now); this.verify(row);
      if (canonical(row.parts) !== canonical(prepared.row.parts) || canonical(row.confirmed) !== canonical(prepared.row.confirmed)) throw conflict('视频分片集合已变化');
      await lockLibrary(tx, row.intent.pid);
      const metadata = { type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: 8,
        name: row.object_key!, attDir: '', sattDir: '', attSize: String(sizeOf(row)), attType: 'video/mp4',
        realName: row.intent.filename, pid: row.intent.pid, time: now, scanToken: '' };
      const matches = (found: typeof systemAttachment.$inferSelect | undefined, expected: typeof metadata) => found
        && Object.entries(expected).every(([key, value]) => {
          const actual = found[key as keyof typeof metadata]; return ['attSize', 'attType'].includes(key)
            && typeof actual === 'string' ? actual.replace(/ +$/, '') === value : actual === value;
        });
      const inserted = await tx.insert(systemAttachment).values(metadata).returning(), insertedId = inserted[0]?.attId;
      if (inserted.length !== 1 || !Number.isSafeInteger(insertedId) || insertedId! <= 0 || !matches(inserted[0], metadata)) throw conflict('视频素材未完整保存');
      const canonicalPath = canonicalAttachmentPath(insertedId!), expected = { ...metadata, attDir: canonicalPath };
      const updated = await tx.update(systemAttachment).set({ attDir: canonicalPath }).where(eq(systemAttachment.attId, insertedId!)).returning();
      if (updated.length !== 1 || updated[0]?.attId !== insertedId || !matches(updated[0], expected)) throw conflict('视频素材稳定地址未完整保存');
      const committed = await update(tx, row, { state: 'committed', parts: row.parts, confirmed: row.confirmed,
        attachment_id: insertedId!, updated_at: Math.max(now, row.updated_at) });
      const [reread] = await tx.select().from(systemAttachment).where(eq(systemAttachment.attId, insertedId!)).limit(1);
      if (!matches(reread, expected)) throw conflict('视频素材最终回读不一致');
      await assertProductVideoUploadReady(tx); return receipt(committed, now);
    });
  }
  async preview(value: unknown, actor: AdminAuthorityActor): Promise<{ url: string; src: string }> {
    const id = productVideoUploadId(value);
    const url = await this.transaction(actor, 'attachment.view', async (tx) => {
      await lock(tx, id); const row = await read(tx, id, actor.id);
      if (!row || row.state !== 'committed') throw new NotFoundException('视频尚未提交');
      await lockLibrary(tx, 0);
      const [asset] = await tx.select().from(systemAttachment).where(eq(systemAttachment.attId, row.attachment_id!)).limit(1);
      const reference = canonicalAttachmentPath(row.attachment_id!);
      if (!asset || asset.type !== 1 || asset.relationId !== 0 || asset.moduleType !== 1 || asset.fileType !== 2 || asset.imageType !== 8
        || asset.name !== row.object_key || asset.attDir !== reference || asset.attType.trim() !== 'video/mp4') throw new NotFoundException('视频素材已不存在或已变化');
      return reference;
    });
    return { url, src: (await signAttachmentReferences(this.env.APP_KEY, [url]))[0] };
  }
  async legacyUpload(input: Record<string, unknown> & { file: File }, actor: AdminAuthorityActor) {
    const intent = normalizeLegacyVideoManifest(input), number = (value: unknown) => {
      if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new ValidateException('旧视频分片信息无效'); return Number(value);
    }, index = integer(number(input.chunkNumber), 1, intent.total_chunks, '视频片号');
    if (!(input.file instanceof File) || input.file.size !== number(input.currentChunkSize) || input.file.size > PRODUCT_VIDEO_CHUNK_BYTES
      || !['', 'video/mp4', 'application/octet-stream'].includes(input.file.type.toLowerCase())) throw new ValidateException('视频分片大小或类型无效');
    if (!this.env.APP_KEY) throw new ServiceUnavailableException('视频会话签名未配置');
    const digest = createHmac('sha256', this.env.APP_KEY).update('cinashop.product-video.legacy.v1\0')
      .update(canonical({ actor: actor.id, filename: intent.filename, md5: intent.client_md5 })).digest();
    digest[6] = (digest[6] & 15) | 64; digest[8] = (digest[8] & 63) | 128;
    const hex = Buffer.from(digest.subarray(0, 16)).toString('hex'), id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    await this.initializeIntent(id, intent, actor, index !== 1);
    await this.putPart(id, index, new Uint8Array(await input.file.arrayBuffer()), actor);
    if (index < intent.total_chunks) return { code: 1, msg: 'waiting', file_path: '', name: '', dir: '', chunk: index, total_chunks: intent.total_chunks };
    const completed = await this.complete(id, actor), result = completed.result!, playback = await this.preview(id, actor);
    return { code: 2, msg: 'success', att_id: result.id, name: result.url, dir: result.url, canonical_url: result.url,
      file_path: playback.src, src: playback.src, size: result.size, type: 'video/mp4' };
  }
  /** Legacy cloud-upload registration is metadata only. Deterministic bounded
   * name plus a real table fence lets a lost COMMIT retry find the same row;
   * a 200-character URL never overflows the legacy name(100) column. */
  async registerExternal(value: unknown, actor: AdminAuthorityActor): Promise<true> {
    const input = object(value);
    if (!Object.hasOwn(input, 'path') || Object.keys(input).some(key => !['path', 'cover_image', 'pid', 'upload_type'].includes(key)))
      throw new ValidateException('视频素材登记参数无效');
    const path = normalizeExternalVideoUrl(input.path), cover = normalizeExternalVideoCoverUrl(input.cover_image);
    if (path.length > 200 || cover.length > 200) throw new ValidateException('规范化后的视频或封面地址不能超过200字符');
    const rawPid = input.pid ?? 0, pid = integer(typeof rawPid === 'string' && /^(?:0|[1-9]\d*)$/.test(rawPid) ? Number(rawPid) : rawPid, 0, 2147483647, '视频分类');
    const name = `external-video-${createHash('sha256').update(canonical({ path, cover, pid })).digest('hex').slice(0, 32)}.mp4`;
    let realName = 'video.mp4';
    try { const decoded = decodeURIComponent(new URL(path).pathname.split('/').at(-1) ?? ''); realName = filename(decoded); } catch { /* URL identity remains the exact validated path. */ }
    return this.transaction<true>(actor, 'attachment.manage', async (tx, now) => {
      await lockLibrary(tx, pid);
      const metadata = { type: 1, relationId: 0, moduleType: 1, fileType: 2, imageType: 0, name, attDir: path,
        sattDir: cover, attSize: '0', attType: 'video/mp4', pid, realName, scanToken: '' };
      const matches = (row: typeof systemAttachment.$inferSelect | undefined) => row && Object.entries(metadata).every(([key, expected]) => {
        const actual = row[key as keyof typeof metadata]; return ['attSize', 'attType'].includes(key) && typeof actual === 'string'
          ? actual.trimEnd() === expected : actual === expected;
      });
      const existing = await tx.select().from(systemAttachment).where(and(eq(systemAttachment.type, 1), eq(systemAttachment.relationId, 0),
        eq(systemAttachment.moduleType, 1), eq(systemAttachment.name, name))).limit(2);
      if (existing.length) { if (existing.length !== 1 || !matches(existing[0])) throw conflict('视频素材登记身份已变化'); return true; }
      const inserted = await tx.insert(systemAttachment).values({ ...metadata, time: now }).returning();
      if (inserted.length !== 1 || !Number.isSafeInteger(inserted[0]?.attId) || inserted[0].attId <= 0 || !matches(inserted[0]) || inserted[0].time !== now)
        throw conflict('视频素材登记未完整保存');
      const [saved] = await tx.select().from(systemAttachment).where(eq(systemAttachment.attId, inserted[0].attId)).limit(1);
      if (!matches(saved) || saved.time !== now) throw conflict('视频素材登记回读不一致');
      return true;
    });
  }
  async cleanup(message: ProductVideoCleanupMessage): Promise<{ deleted: number; deferred: boolean }> {
    if (!isProductVideoCleanupMessage(message)) throw new ValidateException('视频会话清理消息无效');
    const plan = await withTx(this.container, async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await lock(tx, message.uploadId); let row = await read(tx, message.uploadId); const now = await clock(tx);
      if (!row || !row.intent) return { keys: [], delay: 0 };
      if (row.state === 'active' && row.expires_at > now) return { keys: [], delay: row.expires_at - now };
      if (row.state === 'active') row = await update(tx, row, { state: 'cancelled', parts: row.parts, confirmed: row.confirmed,
        attachment_id: null, updated_at: Math.max(now, row.updated_at) });
      const keys = Array.from({ length: row.intent!.total_chunks }, (_, index) => partKey(row!, index + 1));
      // Terminal roots cannot publish new metadata. A late duplicate composer
      // may still rewrite a final key after library deletion; only collect it
      // after checking every library owner under the same real table fence.
      if (row.state === 'cancelled') keys.push(row.object_key!);
      else if (row.state === 'committed') {
        await lockLibrary(tx, 0);
        const references = await tx.select({ id: systemAttachment.attId }).from(systemAttachment)
          .where(eq(systemAttachment.name, row.object_key!)).limit(1);
        if (references.length === 0) keys.push(row.object_key!);
      }
      return { keys, delay: 0 };
    });
    if (plan.delay) { await this.enqueue(message.uploadId, plan.delay); return { deleted: 0, deferred: true }; }
    if (plan.keys.length) await this.env.ASSETS_BUCKET.delete(plan.keys);
    return { deleted: plan.keys.length, deferred: false };
  }
}
