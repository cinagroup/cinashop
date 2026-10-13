import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb } from '@/lib/di';
import type { Env } from '@/env';
import { systemConfig, systemGroup, systemGroupData, systemAttachment, systemLog, storeProduct, systemStore, memberRight } from '@/models/schema';
import { PublicCatalogService } from '@/services/product/PublicCatalogService';
import { operationalTables, seedOperationalGroups, operationalStored } from './helpers/adminOperationalGroupData';
import { financePostgres } from './helpers/financePostgres';
const wiring = vi.hoisted(() => ({ open: vi.fn(), failure: undefined as Error | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
vi.mock('@/middleware/error', async original => {
  const actual = await original<typeof import('@/middleware/error')>();
  return { ...actual, errorHandler: (error: Error, context: Parameters<typeof actual.errorHandler>[1]) => {
    wiring.failure = error; return actual.errorHandler(error, context);
  } };
});
const names = ['routine_home_bast_banner', 'combination_banner', 'routine_home_hot_banner', 'routine_home_new_banner', 'routine_home_benefit_banner', 'integral_shop_banner'];
const gids = [51, 52, 57, 58, 59, 68], key = 'operational-public-fixture';
const env = { APP_KEY: key, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
describe('actual public operational-group consumers with owned canonical media', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>, catalog: PublicCatalogService;
  const app = createApp();
  beforeAll(async () => {
    fixture = await financePostgres([...operationalTables, systemConfig, storeProduct, systemStore, memberRight], { namespace: 'public' });
    const container = createContainerFromDb(fixture.db); wiring.open.mockImplementation(() => container); catalog = new PublicCatalogService(container, env);
  }, 30_000);
  beforeEach(async () => {
    wiring.failure = undefined; await fixture.reset(); await seedOperationalGroups(fixture.db);
    await fixture.db.update(systemAttachment).set({ attDir: '/api/assets/71' }).where(eq(systemAttachment.attId, 71));
    await fixture.db.update(systemAttachment).set({ attDir: '/api/assets/72' }).where(eq(systemAttachment.attId, 72));
    await fixture.db.insert(systemGroupData).values(gids.map((gid, index) => ({ id: 100 + index, gid, value: operationalStored({ img: { type: 'upload', value: '/api/assets/71' } }), sort: 5 })));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Public groups forbid external image reads'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await fixture?.close(); }, 30_000);
  function signed(value: unknown) {
    const url = new URL(String(value), 'https://fixture.invalid'); expect(url.pathname).toBe('/api/assets/71');
    const expires = Number(url.searchParams.get('expires')); expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', key).update(`GET\n/api/assets/71\n${expires}`).digest('base64url'));
  }
  it('signs all six commissioned groups after the real read transaction and preserves persisted raw values', async () => {
    const before = await fixture.db.select().from(systemGroupData).orderBy(systemGroupData.id), result = await catalog.groupDataMany(names);
    for (let index = 0; index < names.length; index++) { expect(result[names[index]][0].id).toBe(100 + index); signed(result[names[index]][0].img); }
    expect(await fixture.db.select().from(systemGroupData).orderBy(systemGroupData.id)).toEqual(before);
    expect(await fixture.db.select().from(systemLog)).toEqual([]);
  });
  it('exposes the same fresh image through the four genuine registered groom-list routes', async () => {
    for (const [type, index] of [[1, 0], [2, 2], [3, 3], [4, 4]]) {
      const response = await app.request(`/api/groom/list/${type}`, {}, env), body = await response.json<{ status: number; msg: string; data: any }>();
      expect(body.status, wiring.failure?.cause instanceof Error ? wiring.failure.cause.message : wiring.failure?.message ?? body.msg).toBe(200); expect(body.data.list).toEqual([]);
      expect(body.data.banner[0].id).toBe(100 + index); signed(body.data.banner[0].img);
    }
  });
  it('does not mint a platform signature for foreign, missing, reclassified or malformed attachment rows', async () => {
    await fixture.db.update(systemGroupData).set({ value: operationalStored({ img: { type: 'upload', value: '/api/assets/72' } }) }).where(eq(systemGroupData.id, 100));
    expect((await catalog.groupDataMany([names[0]]))[names[0]][0].img).toBe('');
    await fixture.db.update(systemGroupData).set({ value: operationalStored({ img: { type: 'upload', value: '/api/assets/9999' } }) }).where(eq(systemGroupData.id, 100));
    expect((await catalog.groupDataMany([names[0]]))[names[0]][0].img).toBe('');
    await fixture.db.update(systemAttachment).set({ name: 'attachments/supplier/77/stolen.jpg' }).where(eq(systemAttachment.attId, 71));
    expect((await catalog.groupDataMany([names[2]]))[names[2]][0].img).toBe('');
  });
  it('retains public HTTPS images and other group behavior, while six-group ties follow PHP descending IDs', async () => {
    await fixture.db.insert(systemGroup).values({ id: 500, configName: 'unrelated_group', fields: '[]' });
    await fixture.db.insert(systemGroupData).values([{ id: 201, gid: 500, value: operationalStored(), sort: 5 }, { id: 202, gid: 500, value: operationalStored(), sort: 5 }]);
    const result = await catalog.groupDataMany([names[0], 'unrelated_group']);
    expect(result[names[0]].map(row => row.id)).toEqual([100, 1]); expect(result[names[0]][1].img).toBe('https://images.example.test/banner.jpg');
    expect(result.unrelated_group.map(row => row.id)).toEqual([201, 202]);
  });
  it('uses current group status and current attachment authority on each complete reread', async () => {
    signed((await catalog.groupDataMany([names[0]]))[names[0]][0].img);
    await fixture.db.update(systemAttachment).set({ fileType: 2 }).where(eq(systemAttachment.attId, 71));
    expect((await catalog.groupDataMany([names[0]]))[names[0]][0].img).toBe('');
    await fixture.db.update(systemGroupData).set({ status: 0 }).where(eq(systemGroupData.id, 100));
    expect((await catalog.groupDataMany([names[0]]))[names[0]].map(row => row.id)).toEqual([1]);
  });
});
