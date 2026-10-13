import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAttachment, systemConfig, systemGroup, systemGroupData, user } from '@/models/schema';
import { authMiddleware } from '@/middleware/auth';
import { errorHandler } from '@/middleware/error';
import { createToken, md5 } from '@/utils/jwt';
import { AttachmentService, signAttachmentReferences } from '@/services/system/AttachmentService';
import { UserSpreadPosterDataService } from '@/services/user/UserSpreadPosterDataService';
import * as controller from '@/controllers/api/v1/UserProfileController';
import { financePostgres } from './helpers/financePostgres';

const TABLES = [user, systemAttachment, systemConfig, systemGroup, systemGroupData];
const actor = (uid = 11) => ({ uid, authVersion: md5('owned-poster-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
const env = { APP_KEY: 'owned-poster-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as unknown as Env;

function observedDb(db: DbClient, active: { count: number }, settings: Array<{ readonly: string; isolation: string }>): DbClient {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== 'transaction') return Reflect.get(target, key, receiver);
    return (read: (tx: DbClient) => Promise<unknown>) => target.transaction(async inner => {
      active.count++;
      const tx = inner as unknown as DbClient;
      let first = true;
      const observed = new Proxy(tx, { get(transaction, property, transactionReceiver) {
        if (property !== 'execute') return Reflect.get(transaction, property, transactionReceiver);
        return async (query: Parameters<DbClient['execute']>[0]) => {
          const value = await transaction.execute(query);
          if (first) {
            first = false;
            const [state] = await transaction.execute<{ readonly: string; isolation: string }>(sql`
              SELECT current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
            settings.push(state);
          }
          return value;
        };
      } });
      try { return await read(observed); } finally { active.count--; }
    });
  } });
}

describe('owner poster data current SQL authority and signed media', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => { f = await financePostgres(TABLES, { namespace: 'public' }); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(user).values([{ uid: 11, pwd: 'owned-poster-password', nickname: '海报本人', avatar: '/api/assets/41' },
      { uid: 12, pwd: 'owned-poster-password', nickname: '其他用户', avatar: '/api/assets/43' }]);
    await f.db.insert(systemConfig).values([{ id: 1, menuName: 'spread_banner', value: '["/api/assets/42"]' },
      { id: 2, menuName: 'site_name', value: '"当前商店"' }, { id: 3, menuName: 'site_url', value: '"https://legacy.example.test/"' }]);
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: 8,
        name: 'attachments/user/11/avatar.png', attDir: '/api/assets/41', attType: 'image/png' },
      { attId: 42, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
        name: 'attachments/admin/1/poster.jpg', attDir: '/api/assets/42', attType: 'image/jpeg' },
      { attId: 43, type: 3, relationId: 12, moduleType: 3, fileType: 1, imageType: 8,
        name: 'attachments/user/12/avatar.png', attDir: '/api/assets/43', attType: 'image/png' },
      { attId: 44, type: 4, relationId: 7, moduleType: 1, fileType: 1, imageType: 8,
        name: 'attachments/supplier/7/poster.jpg', attDir: '/api/assets/44', attType: 'image/jpeg' },
    ]);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });
  const service = (db = f.db, signer = signAttachmentReferences) => new UserSpreadPosterDataService(createContainerFromDb(db), env, signer);
  const complete = async () => ({ users: await f.db.select().from(user).orderBy(user.uid),
    config: await f.db.select().from(systemConfig).orderBy(systemConfig.id),
    media: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId),
    group: await f.db.select().from(systemGroup), groupData: await f.db.select().from(systemGroupData) });

  it('signs owner avatar and platform template outside actual RR READ ONLY snapshots with no DML or external fetch', async () => {
    const before = await complete(), active = { count: 0 }, settings: Array<{ readonly: string; isolation: string }> = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Poster data forbids server image fetch'));
    const signer = vi.fn(async (...args: Parameters<typeof signAttachmentReferences>) => {
      expect(active.count).toBe(0); return signAttachmentReferences(...args);
    });
    const result = await service(observedDb(f.db, active, settings), signer).read(actor());
    expect(result).toMatchObject({ nickname: '海报本人', site_name: '当前商店', qrcode: '' });
    expect(result.avatar).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=[A-Za-z0-9_-]{43}$/);
    expect(result.spread).toHaveLength(1); expect(result.spread[0].pic).toMatch(/^\/api\/assets\/42\?expires=\d+&signature=/);
    expect(settings).toEqual([{ readonly: 'on', isolation: 'repeatable read' }, { readonly: 'on', isolation: 'repeatable read' }]);
    expect(signer).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled(); expect(await complete()).toEqual(before);
  });
  it('refreshes legal stored signed references and supports a platform-owned default avatar', async () => {
    const [stored] = await signAttachmentReferences(env.APP_KEY, ['/api/assets/41']);
    await f.db.update(user).set({ avatar: stored }).where(eq(user.uid, 11));
    expect((await service().read(actor())).avatar).toMatch(/^\/api\/assets\/41\?expires=/);
    await f.db.update(user).set({ avatar: '/api/assets/42' }).where(eq(user.uid, 11));
    expect((await service().read(actor())).avatar).toMatch(/^\/api\/assets\/42\?expires=/);
  });
  it('uses the returned real HMAC ticket with mature SQL/R2 reading while an unsigned avatar cannot be read', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JqkAAAAASUVORK5CYII=', 'base64');
    const get = vi.fn(async (key: string) => {
      expect(key).toBe('attachments/user/11/avatar.png');
      return { body: new Response(png).body, size: png.length, httpEtag: '"owned-poster-avatar"',
        writeHttpMetadata: (headers: Headers) => { headers.set('Content-Type', 'image/png'); } };
    });
    const reader = new AttachmentService(createContainerFromDb(f.db), { ...env, ASSETS_BUCKET: { get } } as unknown as Env);
    const signed = new URL((await service().read(actor())).avatar, 'https://api.example.test');
    const result = await reader.getSignedAsset(41, signed.searchParams.get('expires'), signed.searchParams.get('signature'));
    expect(result.response.headers.get('Content-Type')).toBe('image/png'); expect(Buffer.from(await result.response.arrayBuffer())).toEqual(png);
    await expect(reader.getSignedAsset(41, undefined, undefined)).rejects.toThrow(/链接无效/); expect(get).toHaveBeenCalledOnce();
  });
  it.each(['/api/assets/43', '/api/assets/44', '/api/assets/41?owner=12', '/api/assets/41?expires=1&signature=bad', '/api/assets/041', '/%61pi/assets/41'])('rejects foreign/malformed avatar authority %s', async avatar => {
    await f.db.update(user).set({ avatar }).where(eq(user.uid, 11));
    await expect(service().read(actor())).rejects.toThrow();
  });
  it.each(['/api/assets/41', '/api/assets/43', '/api/assets/44'])('never signs a user/supplier asset as a platform poster template %s', async pic => {
    await f.db.update(systemConfig).set({ value: JSON.stringify([pic]) }).where(eq(systemConfig.id, 1));
    await expect(service().read(actor())).rejects.toThrow(/允许范围/);
  });
  it.each([{ name: 'attachments/user/12/avatar.png' }, { moduleType: 4 }, { fileType: 2 }, { imageType: 1 },
    { attDir: '/api/assets/43' }, { attType: 'image/jpeg' }, { name: 'attachments/user/11/../other.png' }])('rejects contradictory avatar metadata %j', async metadata => {
    await f.db.update(systemAttachment).set(metadata).where(eq(systemAttachment.attId, 41));
    await expect(service().read(actor())).rejects.toThrow();
  });
  it('selects the current platform sort/id winner while ignoring foreign-store and shadowed malformed history', async () => {
    await f.db.insert(systemConfig).values([
      { id: 4, menuName: 'spread_banner', sort: 10, value: '["https://cdn.example.test/winner.png"]' },
      { id: 5, menuName: 'spread_banner', sort: 10, status: 0, value: '["https://cdn.example.test/newest.png"]' },
      { id: 6, menuName: 'spread_banner', sort: 99, isStore: 1, value: '["/api/assets/43"]' },
      { id: 7, menuName: 'spread_banner', sort: -1, value: 'malformed-shadowed-history' },
    ]);
    expect((await service().read(actor())).spread).toEqual([{ pic: 'https://cdn.example.test/newest.png' }]);
  });
  it('uses a unique active group fallback with stable PHP sort/id order and wrapped pic values', async () => {
    await f.db.update(systemConfig).set({ value: '[]' }).where(eq(systemConfig.id, 1));
    await f.db.insert(systemGroup).values({ id: 1, configName: 'routine_spread_banner' });
    await f.db.insert(systemGroupData).values([
      { id: 1, gid: 1, sort: 8, value: '{"pic":{"value":"/api/assets/42"}}' },
      { id: 2, gid: 1, sort: 8, value: '{"pic":"https://cdn.example.test/second.png"}' },
      { id: 3, gid: 1, sort: 99, status: 0, value: '{"pic":"/api/assets/43"}' },
    ]);
    const result = await service().read(actor());
    expect(result.spread[0].pic).toMatch(/^\/api\/assets\/42\?/); expect(result.spread[1].pic).toBe('https://cdn.example.test/second.png');
    await f.db.insert(systemGroup).values({ id: 2, configName: 'routine_spread_banner' });
    await expect(service().read(actor())).rejects.toThrow(/身份重复/);
  });
  it('returns all thirty configured templates and rejects a thirty-first without truncation', async () => {
    const pics = Array.from({ length: 30 }, (_, i) => `https://cdn.example.test/${i}.png`);
    await f.db.update(systemConfig).set({ value: JSON.stringify(pics) }).where(eq(systemConfig.id, 1));
    expect((await service().read(actor())).spread).toEqual(pics.map(pic => ({ pic })));
    await f.db.update(systemConfig).set({ value: JSON.stringify([...pics, 'https://cdn.example.test/31.png']) }).where(eq(systemConfig.id, 1));
    await expect(service().read(actor())).rejects.toThrow(/最多30/);
  });
  it('matches the client text capacity exactly and rejects a longer site label without truncation', async () => {
    await f.db.update(systemConfig).set({ value: JSON.stringify('s'.repeat(255)) }).where(eq(systemConfig.id, 2));
    expect((await service().read(actor())).site_name).toBe('s'.repeat(255));
    await f.db.update(systemConfig).set({ value: JSON.stringify('s'.repeat(256)) }).where(eq(systemConfig.id, 2));
    await expect(service().read(actor())).rejects.toThrow(/文字超过/);
  });
  it('rejects a thirty-first active group template instead of losing a fallback row', async () => {
    await f.db.update(systemConfig).set({ value: '[]' }).where(eq(systemConfig.id, 1));
    await f.db.insert(systemGroup).values({ id: 1, configName: 'routine_spread_banner' });
    await f.db.insert(systemGroupData).values(Array.from({ length: 31 }, (_, i) => ({ id: i + 1, gid: 1,
      value: JSON.stringify({ pic: `https://cdn.example.test/${i}.png` }) })));
    await expect(service().read(actor())).rejects.toThrow(/分组超过/);
  });
  it.each(['not-json', '{}', '[null]', '["/api/assets/42",null]'])('rejects malformed complete configured JSON', async value => {
    await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.id, 1));
    await expect(service().read(actor())).rejects.toThrow();
  });
  it('honors the actual config varchar budget and bounds real text group JSON before projection', async () => {
    await expect(f.db.update(systemConfig).set({ value: 'x'.repeat(5001) }).where(eq(systemConfig.id, 1))).rejects.toMatchObject({ cause: { code: '22001' } });
    await f.db.update(systemConfig).set({ value: '[]' }).where(eq(systemConfig.id, 1));
    await f.db.insert(systemGroup).values({ id: 1, configName: 'routine_spread_banner' });
    await f.db.insert(systemGroupData).values({ id: 1, gid: 1, value: JSON.stringify({ pic: '/api/assets/42', note: 'x'.repeat(65537) }) });
    await expect(service().read(actor())).rejects.toThrow(/分组超过/);
  });
  it('maps legacy uploads only to the explicitly configured platform HTTPS origin and preserves absolute external avatars without fetch', async () => {
    await f.db.update(user).set({ avatar: 'https://thirdwx.qlogo.cn/mmopen/owned/132' }).where(eq(user.uid, 11));
    await f.db.update(systemConfig).set({ value: '["/uploads/posters/one.png","uploads/posters/two.jpg"]' }).where(eq(systemConfig.id, 1));
    const result = await service().read(actor());
    expect(result.avatar).toBe('https://thirdwx.qlogo.cn/mmopen/owned/132');
    expect(result.spread).toEqual([{ pic: 'https://legacy.example.test/uploads/posters/one.png' }, { pic: 'https://legacy.example.test/uploads/posters/two.jpg' }]);
    await f.db.update(systemConfig).set({ value: '' }).where(eq(systemConfig.id, 3));
    await expect(service().read(actor())).rejects.toThrow(/HTTPS源/);
  });
  it.each(['/uploads/../secret.png', '/uploads/%2e%2e/secret.png', '/uploads/a\\b.png', 'http://cdn.example.test/x.png', 'https://name:pass@cdn.example.test/a.png', '/statics/avatar.png'])('rejects unapproved legacy address %s', async pic => {
    await f.db.update(systemConfig).set({ value: JSON.stringify([pic]) }).where(eq(systemConfig.id, 1));
    await expect(service().read(actor())).rejects.toThrow();
  });
  it.each([{ uid: 0 }, { authVersion: md5('old-password') }, { expiresAt: 1 }])('requires actual current actor claims %j', async fields => {
    await expect(service().read({ ...actor(), ...fields })).rejects.toThrow(/登录|账户/);
  });
  it.each([{ status: 0 }, { isDel: 1 }, { deleteTime: new Date() }])('rejects a currently inactive owner %j', async state => {
    await f.db.update(user).set(state).where(eq(user.uid, 11));
    await expect(service().read(actor())).rejects.toThrow(/账户/);
  });
  it.each(['account', 'config', 'metadata'] as const)('rejects committed %s replacement during outside-snapshot signing', async changed => {
    const signer = async (...args: Parameters<typeof signAttachmentReferences>) => {
      if (changed === 'account') await f.db.update(user).set({ pwd: 'changed-password' }).where(eq(user.uid, 11));
      else if (changed === 'config') await f.db.update(systemConfig).set({ value: '["https://cdn.example.test/new.png"]' }).where(eq(systemConfig.id, 1));
      else await f.db.update(systemAttachment).set({ name: 'attachments/user/11/new-avatar.png' }).where(eq(systemAttachment.attId, 41));
      return signAttachmentReferences(...args);
    };
    await expect(service(f.db, signer).read(actor())).rejects.toThrow(/变化/);
  });
  it('assembles the original endpoint from genuine UserJWT claims and refuses unauthenticated or injected identities', async () => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.onError(errorHandler); app.use('*', async (c, next) => { c.set('container', createContainerFromDb(f.db)); await next(); });
    app.get('/api/user/spread_info', authMiddleware({ force: true }), controller.spreadInfo);
    const jwt = await createToken(11, 'api', actor().authVersion, env.APP_KEY);
    const result = await app.request('/api/user/spread_info', { headers: { Authorization: `Bearer ${jwt.token}` } }, env);
    const body = await result.json<{ status: number; data: Record<string, unknown> }>();
    expect(body.status).toBe(200); expect(Object.keys(body.data).sort()).toEqual(['avatar', 'nickname', 'qrcode', 'site_name', 'spread']);
    expect(body.data.avatar).toMatch(/^\/api\/assets\/41\?expires=/); expect(result.headers.get('Cache-Control')).toContain('no-store');
    expect((await (await app.request('/api/user/spread_info', {}, env)).json<{ status: number }>()).status).not.toBe(200);
    expect((await (await app.request('/api/user/spread_info?uid=12', { headers: { Authorization: `Bearer ${jwt.token}` } }, env)).json<{ status: number }>()).status).not.toBe(200);
    await f.db.update(user).set({ pwd: 'revoked-password' }).where(eq(user.uid, 11));
    expect((await (await app.request('/api/user/spread_info', { headers: { Authorization: `Bearer ${jwt.token}` } }, env)).json<{ status: number }>()).status).not.toBe(200);
  });
});
