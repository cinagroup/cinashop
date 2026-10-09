import { vi } from 'vitest';
import type { Env } from '../../src/env';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { systemAttachment, systemAttachmentCategory } from '../../src/models/schema';
import { AttachmentService } from '../../src/services/system/AttachmentService';
import { financePostgres } from './financePostgres';

export function pngFile(name = 'owned.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
}

type StoredImage = {
  bytes: Uint8Array;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
};
type PutOptions = Pick<StoredImage, 'httpMetadata' | 'customMetadata'>;

/** Actual SQL and, when selected by the caller, independent native PG16 peers.
 * Only the object/queue boundary is synthetic; it records real streamed bytes. */
export async function attachmentUploadCategoryFixture() {
  const f = await financePostgres([systemAttachment, systemAttachmentCategory]);
  const objects = new Map<string, StoredImage>();
  const unrelatedKey = 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000001.png';
  let afterPut: ((key: string) => Promise<void>) | undefined;
  const writeObject = async (key: string, body: ReadableStream<Uint8Array>, options?: PutOptions) => {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    objects.set(key, { bytes, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    await afterPut?.(key);
    return { key, size: bytes.byteLength, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata };
  };
  const deleteObject = async (keys: string | string[]) => {
    for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key);
  };
  const getObject = async (key: string) => {
    const object = objects.get(key);
    return object ? { key, size: object.bytes.byteLength, body: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(object.bytes); controller.close(); },
    }),
      httpMetadata: object.httpMetadata, customMetadata: object.customMetadata } : null;
  };
  const bucket = {
    put: vi.fn(writeObject), delete: vi.fn(deleteObject), get: vi.fn(getObject),
    head: vi.fn(async (key: string) => objects.has(key) ? { key, size: objects.get(key)!.bytes.byteLength } : null),
    list: vi.fn(async () => ({ objects: [...objects].map(([key, value]) => ({ key, size: value.bytes.byteLength })), truncated: false })),
  };
  const queue = { send: vi.fn(async (_message: unknown) => undefined) };
  const env = { APP_KEY: 'owned-attachment-upload-fixture', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    ASSETS_BUCKET: bucket, ORDER_QUEUE: queue } as unknown as Env;
  const serviceFor = (db: DbClient = f.db) => new AttachmentService(createContainerFromDb(db), env);
  const seedCategory = (row: typeof systemAttachmentCategory.$inferInsert) => f.db.insert(systemAttachmentCategory).values(row).returning();
  const seedAttachment = (row: typeof systemAttachment.$inferInsert) => f.db.insert(systemAttachment).values(row).returning();
  const snapshot = async () => ({
    attachments: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId),
    categories: await f.db.select().from(systemAttachmentCategory).orderBy(systemAttachmentCategory.id),
  });
  const requireNative = () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 is required for metadata trigger tests');
  };
  const dropMetadataTriggers = async () => {
    await f.exec(`DROP TRIGGER IF EXISTS attachment_upload_failure ON system_attachment;
      DROP TRIGGER IF EXISTS attachment_upload_barrier ON system_attachment;
      DROP TRIGGER IF EXISTS attachment_upload_mutation ON system_attachment;
      DROP FUNCTION IF EXISTS attachment_upload_failure();
      DROP FUNCTION IF EXISTS attachment_upload_barrier();
      DROP FUNCTION IF EXISTS attachment_upload_mutation();`);
  };
  const installMetadataFailure = async (phase: 'insert' | 'canonical-update', code = 'P0001') => {
    requireNative();
    if (!['P0001', '23514', '42501'].includes(code)) throw Error('Unreviewed metadata failure code');
    await f.exec(`CREATE FUNCTION attachment_upload_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='${code}', MESSAGE='owned metadata ${phase} rejection'; END; $$;
      CREATE TRIGGER attachment_upload_failure BEFORE ${phase === 'insert' ? 'INSERT' : 'UPDATE OF att_dir, satt_dir'}
      ON system_attachment FOR EACH ROW EXECUTE FUNCTION attachment_upload_failure();`);
  };
  const installInsertBarrier = async (namespace = 505699, key = 0) => {
    requireNative();
    if (namespace !== 505699 || key !== 0) throw Error('Unreviewed insert barrier');
    await f.exec(`CREATE FUNCTION attachment_upload_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(505699,0); RETURN NEW; END; $$;
      CREATE TRIGGER attachment_upload_barrier BEFORE INSERT ON system_attachment
      FOR EACH ROW EXECUTE FUNCTION attachment_upload_barrier();`);
  };
  const installMetadataMutation = async (kind: 'insert-pid' | 'insert-owner' | 'insert-key' | 'insert-null'
    | 'update-null' | 'update-canonical') => {
    requireNative();
    const statements = {
      'insert-pid': 'NEW.pid := 12; RETURN NEW;',
      'insert-owner': 'NEW.relation_id := 7; RETURN NEW;',
      'insert-key': `NEW.name := '${unrelatedKey}'; RETURN NEW;`,
      'insert-null': 'RETURN NULL;',
      'update-null': 'RETURN NULL;',
      'update-canonical': "NEW.att_dir := '/api/assets/1'; RETURN NEW;",
    };
    const statement = statements[kind];
    if (!statement) throw Error('Unreviewed metadata mutation');
    await f.exec(`CREATE FUNCTION attachment_upload_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${statement} END; $$;
      CREATE TRIGGER attachment_upload_mutation BEFORE ${kind.startsWith('insert-') ? 'INSERT' : 'UPDATE OF att_dir, satt_dir'}
      ON system_attachment FOR EACH ROW EXECUTE FUNCTION attachment_upload_mutation();`);
  };
  const reset = async () => {
    await dropMetadataTriggers();
    await f.reset();
    await f.db.insert(systemAttachmentCategory).values([
      { id: 12, type: 1, relationId: 0, fileType: 1, name: 'upload-target' },
      { id: 20, type: 1, relationId: 0, fileType: 2, name: 'video-only' },
      { id: 30, type: 4, relationId: 9, fileType: 1, name: 'supplier-owned' },
      { id: 40, type: 1, relationId: 7, fileType: 1, name: 'other-owner' },
    ]);
    await f.db.insert(systemAttachment).values({ attId: 1, type: 1, relationId: 0, moduleType: 1, fileType: 1,
      pid: 0, name: unrelatedKey, attDir: '/api/assets/1', sattDir: '/api/assets/1', imageType: 8,
      attSize: '8', attType: 'image/png', realName: 'existing.png' });
    // Explicit fixture IDs must not collide with the first real upload INSERT.
    await f.exec("SELECT setval(pg_get_serial_sequence('system_attachment','att_id'),1,true)");
    afterPut = undefined;
    objects.clear();
    objects.set(unrelatedKey, { bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) });
    bucket.put.mockReset().mockImplementation(writeObject);
    bucket.delete.mockReset().mockImplementation(deleteObject);
    bucket.get.mockReset().mockImplementation(getObject);
    bucket.head.mockClear(); bucket.list.mockClear();
    queue.send.mockReset().mockResolvedValue(undefined);
  };
  try {
    await reset();
    return { ...f, env, objects, bucket, queue, unrelatedKey, serviceFor, seedCategory, seedAttachment,
      snapshot, reset, pngFile, onPut: (handler?: (key: string) => Promise<void>) => { afterPut = handler; },
      installMetadataFailure, installInsertBarrier, installMetadataMutation,
      put: bucket.put, remove: bucket.delete, send: queue.send };
  } catch (error) { await f.close(); throw error; }
}
