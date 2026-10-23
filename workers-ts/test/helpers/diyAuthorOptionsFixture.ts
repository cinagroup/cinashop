import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { vi } from 'vitest';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProduct, storeProductWords, storeSeckill, systemArticle, systemAttachmentCategory, systemDise } from '@/models/schema';
import { AdminDiyAuthorOptionsService } from '@/services/admin/AdminDiyAuthorOptionsService';
import { AttachmentService, adminAttachmentScope, supplierAttachmentScope, userAttachmentScope } from '@/services/system/AttachmentService';
import { fabLinkCatalogFixture } from './fabLinkCatalogFixture';

/** Dedicated owned native database, actual app/Admin LOGIN grants and real
 * AttachmentService uploads. Older FAB fixture defaults are unchanged. */
export async function diyAuthorOptionsFixture() {
  const f = await fabLinkCatalogFixture([storeProductWords, systemAttachmentCategory]);
  try {
    const objects = new Map<string, { bytes: Uint8Array; type: string }>(), cache = new Map<string, string>();
    const bucket = {
      put: vi.fn(async (key: string, body: BodyInit, options?: R2PutOptions) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        objects.set(key, { bytes, type: (options?.httpMetadata as R2HTTPMetadata | undefined)?.contentType ?? '' }); return { key, size: bytes.length };
      }),
      get: vi.fn(async (key: string) => {
        const value = objects.get(key); if (!value) return null;
        return { key, size: value.bytes.length, body: value.bytes.slice(), httpMetadata: { contentType: value.type }, httpEtag: '"owned-author-png"',
          writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', value.type) };
      }),
      delete: vi.fn(async (key: string) => { objects.delete(key); }),
    };
    const env = { ...f.env, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', ASSETS_BUCKET: bucket,
      ORDER_QUEUE: { send: vi.fn(async () => {}) },
      CONFIG_KV: { get: vi.fn(async (key: string) => cache.get(key) ?? null), put: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
        delete: vi.fn(async (key: string) => { cache.delete(key); }) },
      IMAGES: { info: vi.fn(), input: vi.fn() },
    } as unknown as Env;
    const container = createContainerFromDb(f.db), attachments = new AttachmentService(container, env);
    const png = new Uint8Array(await readFile(resolve(import.meta.dirname, '../fixtures/community-blue.png')));
    const upload = (scope: Parameters<AttachmentService['uploadImage']>[0], name: string) => attachments.uploadImage(scope, new File([png], name, { type: 'image/png' }), 0);
    const platformImage = await upload(adminAttachmentScope(), 'author-platform.png');
    const supplierImage = await upload(supplierAttachmentScope(77), 'author-supplier.png');
    const privateImage = await upload(userAttachmentScope(11), 'author-private.png');
    await f.db.update(storeProduct).set({ image: platformImage.url }).where(eq(storeProduct.id, 21));
    await f.db.update(storeProduct).set({ image: supplierImage.url }).where(eq(storeProduct.id, 23));
    await f.db.update(storeSeckill).set({ image: platformImage.url }).where(eq(storeSeckill.id, 31));
    await f.db.update(systemArticle).set({ imageInput: platformImage.url }).where(eq(systemArticle.id, 81));
    await f.db.update(systemDise).set({ coverImage: platformImage.url }).where(eq(systemDise.id, 91));
    await f.db.insert(storeProductWords).values([
      ...Array.from({ length: 25 }, (_, index) => ({ id: 100 + index, name: `作者完整热词${index}`, type: 0, relationId: 0, isShow: 1,
        isSearch: index % 2, isHot: index % 2, sort: index % 3, icon: 'javascript:private', color: 'private-style' })),
      { id: 201, name: 'hidden-word', isShow: 0 }, { id: 202, name: 'deleted-word', isShow: 1, isDel: 1 },
      { id: 203, name: 'supplier-word', type: 2, relationId: 77, isShow: 1 }, { id: 204, name: 'foreign-platform-word', type: 0, relationId: 77, isShow: 1 },
    ]);
    await f.db.insert(systemDise).values([
      { id: 101, name: 'DIY微页一', type: 2, isDiy: 1, status: 1, isShow: 0, value: '[]', coverImage: platformImage.url, content: 'never expose independent content', version: 'untouched-v1' },
      { id: 102, name: 'DIY首页类型', type: 1, isDiy: 1, status: 1, value: '[]' },
      { id: 103, name: 'DIY草稿', type: 2, isDiy: 1, status: 0, value: '[]' },
      { id: 104, name: 'DIY损坏微页', type: 2, isDiy: 1, status: 1, value: '{"private":' },
      { id: 105, name: 'DIY已删微页', type: 2, isDiy: 1, status: 1, isDel: 1, value: '[]' },
      { id: 106, name: '非DIY高排序', type: 2, isDiy: 0, status: 1, value: '[]' },
      { id: 107, name: 'DIY非页面配置', type: 3, isDiy: 1, status: 1, value: '{}' },
      { id: 108, name: 'DIY私有封面', type: 2, isDiy: 1, status: 1, value: '[]', coverImage: privateImage.url },
      { id: 109, name: 'DIY错所有者封面', type: 2, isDiy: 1, status: 1, value: '[]', coverImage: supplierImage.url },
    ]);
    const tables = (await f.exec('SELECT tablename AS name FROM pg_tables WHERE schemaname=\'public\' ORDER BY tablename')).map(row => String(row.name));
    const sequences = (await f.exec('SELECT sequencename AS name FROM pg_sequences WHERE schemaname=\'public\' ORDER BY sequencename')).map(row => String(row.name));
    const snapshot = async () => ({
      tables: await f.db.execute(sql.join(tables.map(name => sql`SELECT ${name}::text AS name, COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `)),
      sequences: await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `)),
    });
    const resources = () => ({ puts: bucket.put.mock.calls.length, deletes: bucket.delete.mock.calls.length,
      queue: vi.mocked(env.ORDER_QUEUE.send).mock.calls.length, kvPut: vi.mocked(env.CONFIG_KV.put).mock.calls.length,
      kvDelete: vi.mocked(env.CONFIG_KV.delete).mock.calls.length, cache: [...cache].sort(),
      images: { info: vi.mocked(env.IMAGES!.info).mock.calls.length, input: vi.mocked(env.IMAGES!.input).mock.calls.length },
      objects: [...objects].map(([key, value]) => ({ key, type: value.type, sha256: createHash('sha256').update(value.bytes).digest('hex') })).sort((a, b) => a.key.localeCompare(b.key)) });
    return { ...f, env, container, bucket, objects, png, platformImage, supplierImage, privateImage, tables, sequences, snapshot, resources,
      authorFor: (db: DbClient = f.db) => new AdminDiyAuthorOptionsService(createContainerFromDb(db), env) };
  } catch (reason) { await f.close(); throw reason; }
}
