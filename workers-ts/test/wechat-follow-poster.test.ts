import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { systemAttachment, systemConfig } from '../src/models/schema';
import { WechatFollowPosterService, followImportedImageUrl } from '../src/services/wechat/WechatFollowPosterService';
import { FOLLOW_BACKGROUND_BASE64, FOLLOW_BACKGROUND_SHA256 } from '../src/services/wechat/WechatFollowBackground';
import * as controller from '../src/controllers/api/v1/WechatFollowPosterController';
import { ApiException, RateLimitException } from '../src/utils/errors';
import { financePostgres } from './helpers/financePostgres';

const png = Uint8Array.from(atob(FOLLOW_BACKGROUND_BASE64), value => value.charCodeAt(0));
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16, 255, 217]);
const now = 1_800_000_000;
type Stored = { bytes: Uint8Array; httpMetadata: { contentType: string }; customMetadata?: Record<string, string> };
function resources() {
  const data = new Map<string, Stored>([['attachments/admin/1/follow.png', { bytes: png, httpMetadata: { contentType: 'image/png' } }]]);
  const operations: unknown[] = [];
  const bucket = { get: vi.fn(async (key: string) => {
    const item = data.get(key); return item ? { ...item, size: item.bytes.length, body: new Response(item.bytes).body } : null;
  }), put: vi.fn(async (key: string, bytes: Uint8Array, options: Omit<Stored, 'bytes'>) => { data.set(key, { ...options, bytes }); }) };
  const images = { info: vi.fn(async () => ({ format: 'image/png', width: 500, height: 720 })), input: vi.fn((_body: ReadableStream) => {
    const image = { transform: (value: unknown) => { operations.push(['transform', value]); return image; },
      draw: (_input: unknown, value: unknown) => { operations.push(['draw', value]); return image; },
      output: async (value: unknown) => { operations.push(['output', value]); return { response: () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } }) }; } };
    return image;
  }) };
  const env = { APP_KEY: 'owned-follow-test-key', PUBLIC_H5_ORIGIN: 'https://shop.example.com',
    ASSETS_BUCKET: bucket, IMAGES: images, TOKEN_BUCKET: { getByName: vi.fn(() => ({ consumeRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })) })) } } as unknown as Env;
  return { env, data, bucket, images, operations };
}

describe('legacy WeChat follow raster poster', () => {
  let fixture: Awaited<ReturnType<typeof financePostgres>>;
  let resource: ReturnType<typeof resources>;
  let service: WechatFollowPosterService;
  beforeAll(async () => { fixture = await financePostgres([systemConfig, systemAttachment]); });
  afterAll(async () => { await fixture.close(); });
  beforeEach(async () => {
    resource = resources(); service = new WechatFollowPosterService(createContainerFromDb(fixture.db), resource.env, vi.fn(), () => now);
    await fixture.db.delete(systemConfig); await fixture.db.delete(systemAttachment);
    await fixture.db.insert(systemConfig).values({ id: 1, menuName: 'wechat_qrcode', value: '"/api/assets/41"', status: 0 });
    await fixture.db.insert(systemAttachment).values({ attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1,
      imageType: 8, name: 'attachments/admin/1/follow.png', attDir: '/api/assets/41', attType: 'image/png', time: 10 });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('preserves the original 500×720 PHP background bytes and exact raster geometry', async () => {
    expect(png.length).toBe(31828);
    expect(FOLLOW_BACKGROUND_SHA256).toBe('a7b8bbfa8d35939d4042be2086113d293775dad60b208347371dc17b560a52c1');
    expect(Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString('hex')).toBe(FOLLOW_BACKGROUND_SHA256);
    expect(new DataView(png.buffer).getUint32(16)).toBe(500); expect(new DataView(png.buffer).getUint32(20)).toBe(720);
    const snapshot = async () => ({ config: await fixture.db.select().from(systemConfig).orderBy(systemConfig.id), attachments: await fixture.db.select().from(systemAttachment).orderBy(systemAttachment.attId) });
    const before = await snapshot(), result = await service.follow('https://api.example.com/api/wechat/follow');
    expect(Object.keys(result)).toEqual(['path']); const url = new URL(result.path);
    expect(url.origin).toBe('https://api.example.com'); expect(url.pathname).toMatch(/^\/api\/wechat\/follow\/image\/[a-f0-9]{64}$/);
    expect(resource.operations).toEqual([['transform', { width: 344, height: 344, fit: 'squeeze' }], ['draw', { left: 76, top: 76 }], ['output', { format: 'image/jpeg', quality: 90 }]]);
    const response = await service.read(url.pathname.split('/').at(-1)!, url.searchParams.get('expires')!, url.searchParams.get('signature')!);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg'); expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff'); expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    expect(resource.images.info).toHaveBeenCalledTimes(1); expect(resource.bucket.put).toHaveBeenCalledTimes(1);
    expect(await snapshot()).toEqual(before);
  });

  it('uses the platform sort/id winner even when hidden, and never uses a store configuration', async () => {
    await fixture.db.insert(systemConfig).values([{ id: 2, menuName: 'wechat_qrcode', value: 'https://evil.example.com/uploads/x.png', sort: 100, isStore: 1 },
      { id: 3, menuName: 'wechat_qrcode', value: 'https://evil.example.com/uploads/x.png', sort: -1 },
      { id: 4, menuName: 'wechat_qrcode', value: '"/api/assets/41"', sort: 0, status: 0 }]);
    await expect(service.follow('https://api.example.com/api/wechat/follow')).resolves.toHaveProperty('path');
  });

  it.each([{ type: 4, relationId: 9 }, { type: 3, relationId: 11 }, { moduleType: 2 }, { imageType: 1 },
    { fileType: 2 }, { name: 'attachments/admin/0/follow.png' }, { attDir: '/api/assets/42' }, { attType: 'image/jpeg' }, { name: 'attachments/admin/1/../follow.png' }])
    ('rejects an attachment outside the real platform raster scope before storage I/O: %j', async change => {
      await fixture.db.update(systemAttachment).set(change).where(eq(systemAttachment.attId, 41));
      await expect(service.follow('https://api.example.com/api/wechat/follow')).rejects.toThrow('附件无效');
      expect(resource.bucket.get).not.toHaveBeenCalled(); expect(resource.images.input).not.toHaveBeenCalled();
    });

  it('rejects forged, duplicate-style, expired and excessively future capabilities before SQL, quota or storage', async () => {
    const result = await service.follow('https://api.example.com/api/wechat/follow'), url = new URL(result.path), revision = url.pathname.split('/').at(-1)!;
    resource.bucket.get.mockClear(); const beforeRead = vi.fn(), transaction = vi.spyOn(fixture.db, 'transaction');
    for (const [rev, expires, signature] of [[revision, String(now + 900), 'a'.repeat(64)], [revision, String(now), url.searchParams.get('signature')!],
      [revision, String(now + 901), url.searchParams.get('signature')!], ['0', String(now + 900), 'a'.repeat(64)], [revision, '01', 'a'.repeat(64)]]) {
      await expect(service.read(rev, expires, signature, beforeRead)).rejects.toThrow('链接无效');
    }
    expect(resource.bucket.get).not.toHaveBeenCalled(); expect(beforeRead).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
  });

  it('revokes an old URL when configuration, attachment owner or source bytes change', async () => {
    const url = new URL((await service.follow('https://api.example.com/api/wechat/follow')).path);
    const read = () => service.read(url.pathname.split('/').at(-1)!, url.searchParams.get('expires')!, url.searchParams.get('signature')!);
    const updated = png.slice(); updated[30] ^= 1;
    resource.data.set('attachments/admin/1/follow.png', { bytes: updated, httpMetadata: { contentType: 'image/png' } });
    await expect(read()).rejects.toThrow('已更新');
    resource.data.set('attachments/admin/1/follow.png', { bytes: png, httpMetadata: { contentType: 'image/png' } });
    await fixture.db.update(systemAttachment).set({ relationId: 22 }).where(eq(systemAttachment.attId, 41));
    await expect(read()).rejects.toThrow('附件无效');
  });

  it('never saves a derivative if the platform configuration changes during the Images call', async () => {
    resource.images.info.mockImplementation(async () => { await fixture.db.update(systemConfig).set({ value: '' }).where(eq(systemConfig.id, 1)); return { format: 'image/png', width: 500, height: 720 }; });
    await expect(service.follow('https://api.example.com/api/wechat/follow')).rejects.toThrow('请上传二维码');
    expect(resource.bucket.put).not.toHaveBeenCalled();
  });

  it('rejects declared/streamed overflow, mismatched magic and excessive dimensions', async () => {
    resource.data.set('attachments/admin/1/follow.png', { bytes: new Uint8Array(3 * 1024 * 1024 + 1), httpMetadata: { contentType: 'image/png' } });
    await expect(service.follow('https://api.example.com/api/wechat/follow')).rejects.toThrow('容量');
    resource.data.set('attachments/admin/1/follow.png', { bytes: new TextEncoder().encode('<script>bad</script>'), httpMetadata: { contentType: 'image/png' } });
    await expect(service.follow('https://api.example.com/api/wechat/follow')).rejects.toThrow('格式');
    resource.data.set('attachments/admin/1/follow.png', { bytes: png, httpMetadata: { contentType: 'image/png' } });
    resource.images.info.mockResolvedValue({ format: 'image/png', width: 8192, height: 8192 });
    await expect(service.follow('https://api.example.com/api/wechat/follow')).rejects.toThrow('尺寸');
    expect(resource.bucket.put).not.toHaveBeenCalled();
  });

  it('supports explicitly pinned legacy uploads without forwarding user credentials and rejects redirects', async () => {
    await fixture.db.update(systemConfig).set({ value: '"https://media.example.com/uploads/2026/follow.png"' }).where(eq(systemConfig.id, 1));
    resource.env.WECHAT_FOLLOW_IMAGE_ORIGINS = 'https://media.example.com';
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toEqual({ Accept: 'image/png,image/jpeg,image/webp,image/gif' }); return new Response(png, { headers: { 'Content-Type': 'image/png' } }); });
    const remote = new WechatFollowPosterService(createContainerFromDb(fixture.db), resource.env, fetcher, () => now);
    await remote.follow('https://api.example.com/api/wechat/follow'); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => { throw Error('PRIVATE-provider-secret'); });
    await expect(remote.follow('https://api.example.com/api/wechat/follow')).rejects.toThrow('暂时不可用');
  });

  it('public controller fails closed on malformed or denied budget before raster I/O', async () => {
    const app = new Hono(); app.use('*', async (c, next) => { c.set('container' as never, createContainerFromDb(fixture.db) as never); await next(); });
    app.get('/api/wechat/follow', controller.follow as never); app.get('/api/wechat/follow/image/:revision', controller.image as never);
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message }, error instanceof RateLimitException ? 429 : 200));
    resource.env.TOKEN_BUCKET = { getByName: () => ({ consumeRateLimit: async () => ({ allowed: false, resetAt: Date.now() + 30_000 }) }) } as unknown as Env['TOKEN_BUCKET'];
    expect((await app.request('/api/wechat/follow', {}, resource.env)).status).toBe(429); expect(resource.bucket.get).not.toHaveBeenCalled();
    resource.env.TOKEN_BUCKET = { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true }) }) } as unknown as Env['TOKEN_BUCKET'];
    const bad = await app.request('/api/wechat/follow', {}, resource.env); expect(await bad.json()).toMatchObject({ status: 503 });
    const invalid = await app.request('/api/wechat/follow/image/' + 'a'.repeat(64) + '?expires=1&signature=' + 'b'.repeat(64), {}, resource.env);
    expect(await invalid.json()).toMatchObject({ status: 404 }); expect(resource.bucket.get).not.toHaveBeenCalled();
  });
});

describe('follow imported-source boundary', () => {
  it('accepts legacy relative uploads only on the pinned H5 origin', () => {
    expect(followImportedImageUrl('uploads/2026/follow.png', { PUBLIC_H5_ORIGIN: 'https://shop.example.com' })).toBe('https://shop.example.com/uploads/2026/follow.png');
    expect(followImportedImageUrl('https://media.example.com/bucket/2026/follow.png', { WECHAT_FOLLOW_IMAGE_ORIGINS: 'https://media.example.com' })).toBe('https://media.example.com/bucket/2026/follow.png');
    expect(followImportedImageUrl('https://media.example.com/bucket/follow.png', { WECHAT_FOLLOW_IMAGE_ORIGINS: 'https://MEDIA.example.com/' })).toBe('https://media.example.com/bucket/follow.png');
    for (const value of ['https://evil.example.com/uploads/a.png', '//evil.example.com/uploads/a.png', 'https://shop.example.com/secret/a.png',
      'https://shop.example.com/uploads/a.svg', 'https://shop.example.com/uploads/a.png?token=secret', 'https://shop.example.com/uploads/%2e%2e/a.png',
      'https://user:secret@shop.example.com/uploads/a.png', 'http://shop.example.com/uploads/a.png']) expect(() => followImportedImageUrl(value, { PUBLIC_H5_ORIGIN: 'https://shop.example.com' })).toThrow();
    for (const origin of ['https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://x.local', 'https://shop.example.com:8443', 'https://shop.example.com/path']) expect(() => followImportedImageUrl('/uploads/a.png', { WECHAT_FOLLOW_IMAGE_ORIGINS: origin })).toThrow();
  });

  it('cancels a stalled stream at the overall deadline rather than returning a late provider body', async () => {
    vi.useFakeTimers(); let cancelled = false;
    const resource = resources(); const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(png.subarray(0, 24)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'image/png' } }));
    const service = new WechatFollowPosterService({} as never, resource.env, fetcher);
    const work = Reflect.get(service, 'load').call(service, { identity: 'owned', kind: 'https', url: 'https://shop.example.com/uploads/follow.png' });
    const result = expect(work).rejects.toThrow('暂时不可用');
    await vi.advanceTimersByTimeAsync(8001); await result; expect(cancelled).toBe(true); vi.useRealTimers();
  });
});
