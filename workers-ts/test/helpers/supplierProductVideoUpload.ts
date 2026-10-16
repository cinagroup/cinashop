import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemSupplier, systemAdmin, systemRole, systemMenus, systemAttachment, systemAttachmentCategory } from '@/models/schema';
import { installSupplierVideoUpload } from '@/migrations/supplierProductVideoUpload';
import { SupplierProductVideoUploadService, normalizeProductVideoManifest, PRODUCT_VIDEO_TTL } from '@/services/supplier/SupplierProductVideoUploadService';
import { createToken, md5, verifyToken } from '@/utils/jwt';
import { financePostgres } from './financePostgres';

export const videoSha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Format marker only. Decode/playback is deliberately outside this SQL suite. */
export function videoBytes(length = 43): Uint8Array {
  const bytes = Uint8Array.from({ length }, (_, index) => index % 251);
  bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]); return bytes;
}
export function videoManifest(bytes: Uint8Array, chunkSize = 16, pid = 20) {
  const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) => bytes.slice(index * chunkSize, (index + 1) * chunkSize));
  return { manifest: { filename: 'owned.mp4', total_size: bytes.length, chunk_size: chunkSize, sha256: chunks.map(videoSha), pid }, chunks };
}
export class OwnedFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number) {
    let count = 0;
    super({ transform(bytes, controller) { count += bytes.byteLength; if (count > length) throw Error('Owned fixed stream overflow'); controller.enqueue(bytes); },
      flush() { if (count !== length) throw Error('Owned fixed stream length mismatch'); } });
  }
}
type Stored = { bytes: Uint8Array; httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> };
export async function productVideoFixture(options: { install?: boolean } = {}) {
  const f = await financePostgres([systemSupplier, systemAdmin, systemRole, systemMenus, systemAttachment, systemAttachmentCategory], { namespace: 'public' });
  try {
    if (options.install !== false) await f.db.transaction(tx => installSupplierVideoUpload(tx));
    await f.db.insert(systemRole).values({ id: 1, roleName: 'Owned video uploader', rules: 'supplier.attachment.manage', type: 4, relationId: 7, level: 1 });
    await f.db.insert(systemRole).values({ id: 2, roleName: 'Other Supplier uploader', rules: 'supplier.attachment.manage', type: 4, relationId: 8 });
    await f.db.insert(systemSupplier).values([{ id: 7, adminId: 99, supplierName: 'Owned Supplier', isShow: 1 }, { id: 8, adminId: 98, supplierName: 'Other Supplier', isShow: 1 }]);
    await f.db.insert(systemAdmin).values([1, 2, 3].map(id => ({ id, account: 'owned-video-' + id,
      pwd: 'owned-video-password', roles: id === 3 ? '2' : '1', level: 1, adminType: 4, relationId: id === 3 ? 8 : 7, status: 1 })));
    await f.db.insert(systemAttachmentCategory).values([
      { id: 20, type: 4, relationId: 7, fileType: 2, name: 'Platform video' },
      { id: 21, type: 4, relationId: 7, fileType: 1, name: 'Image only' },
      { id: 22, type: 4, relationId: 8, fileType: 2, name: 'Supplier video' },
    ]);
    const objects = new Map<string, Stored>();
    let afterPut: ((key: string) => Promise<void>) | undefined;
    const write = async (key: string, body: Uint8Array | ReadableStream<Uint8Array>, options?: R2PutOptions) => {
      const bytes = body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(await new Response(body).arrayBuffer());
      const object = { bytes, httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined, customMetadata: options?.customMetadata };
      objects.set(key, object); await afterPut?.(key); return { key, size: bytes.length, ...object };
    };
    const bucket = { put: vi.fn(write), get: vi.fn(async (key: string) => {
      const value = objects.get(key); if (!value) return null; const bytes = new Uint8Array(value.bytes), middle = Math.ceil(bytes.length / 2);
      return { key, size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(bytes.subarray(0, middle)); controller.enqueue(bytes.subarray(middle)); controller.close();
      } }), httpMetadata: value.httpMetadata, customMetadata: value.customMetadata };
    }), delete: vi.fn(async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key); }) };
    const queue = { send: vi.fn(async (_message: unknown, _options?: { delaySeconds?: number }) => undefined) };
    const env = { APP_KEY: 'owned-product-video-native-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
      ASSETS_BUCKET: bucket, ORDER_QUEUE: queue } as unknown as Env;
    const container = createContainerFromDb(f.db);
    const tokens: Record<number, string> = {}, actors: Record<number, { id: number; supplierId: number; authVersion: string; expiresAt: number }> = {};
    for (const id of [1, 2, 3]) {
      tokens[id] = (await createToken(id, 'supplier', md5('owned-video-password'), env.APP_KEY)).token;
      const claims = await verifyToken(tokens[id], env.APP_KEY);
      if (claims.type !== 'supplier' || !claims.auth) throw Error('Missing actual owned JWT claims');
      actors[id] = { id: claims.id, supplierId: id === 3 ? 8 : 7, authVersion: claims.auth, expiresAt: claims.exp };
    }
    const serviceFor = (db: DbClient = f.db) => new SupplierProductVideoUploadService(createContainerFromDb(db), env);
    const rows = () => f.db.execute(sql`SELECT * FROM public.supplier_product_video_upload_v1 ORDER BY upload_id`);
    const snapshot = async () => ({ uploads: await rows(), attachments: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId) });
    const seedExpired = async () => {
      const id = crypto.randomUUID(), intent = normalizeProductVideoManifest(videoManifest(videoBytes(12), 12).manifest);
      const [clock] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
      const created = Number(clock.now) - PRODUCT_VIDEO_TTL - 60, date = new Date(created * 1000);
      const key = `attachments/supplier/7/${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${id}.mp4`;
      // An owner-seeded expired fact exercises the real database wall clock;
      // no guard is disabled and no production clock override is introduced.
      await f.db.execute(sql`INSERT INTO public.supplier_product_video_upload_v1
        (upload_id,actor_id,supplier_id,request_hash,intent,object_key,state,parts,confirmed,attachment_id,created_at,updated_at,expires_at)
        VALUES(${id}::uuid,1,7,${'a'.repeat(64)},${JSON.stringify(intent)}::jsonb,${key},'active','{}'::jsonb,'[]'::jsonb,NULL,
          ${created},${created},${created + PRODUCT_VIDEO_TTL})`);
      return { id, key };
    };
    return { ...f, container, env, objects, bucket, queue, write, actors, tokens, serviceFor, rows, snapshot, seedExpired,
      onPut: (hook?: (key: string) => Promise<void>) => { afterPut = hook; } };
  } catch (error) { await f.close(); throw error; }
}
