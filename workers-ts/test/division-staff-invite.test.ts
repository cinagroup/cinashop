import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import { createToken, md5 } from '@/utils/jwt';
import { qrcode, systemConfig, user } from '@/models/schema';
import { WechatMiniProgramCodeService } from '@/services/wechat/WechatMiniProgramCodeService';
import { DIVISION_STAFF_INVITE_PAGE } from '@/services/division/DivisionStaffInvitePolicy';
import { divisionStaffFixture } from './helpers/divisionStaffFixture';

const state = vi.hoisted(() => ({ container: vi.fn(), cache: new Map<string, unknown>() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: state.container }));
vi.mock('@/utils/cache', async original => ({ ...await original<typeof import('@/utils/cache')>(),
  cacheGet: vi.fn(async (key: string) => state.cache.get(key) ?? null),
  cacheSet: vi.fn(async (key: string, value: unknown) => { state.cache.set(key, value); return true; }),
  cacheDelete: vi.fn(async (key: string) => { state.cache.delete(key); return true; }) }));
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64'));
describe('actual employee invite routes, real QR identity and isolated provider transport', () => {
  let f: Awaited<ReturnType<typeof divisionStaffFixture>>, token: string;
  const app = createApp();
  const calls: Array<{ url: URL; body: unknown }> = [];
  beforeAll(async () => { f = await divisionStaffFixture(); state.container.mockImplementation(() => f.container);
    token = (await createToken(22, 'api', md5(f.password), f.env.APP_KEY)).token; }, 30000);
  beforeEach(async () => {
    await f.seed(); state.cache.clear(); calls.length = 0;
    await f.db.insert(systemConfig).values([{ menuName: 'routine_appId', value: 'wx0000000000000001' }, { menuName: 'routine_appsecret', value: 'synthetic-employee-secret' }]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input)); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.origin !== 'https://api.weixin.qq.com') throw Error('Fixture forbids every other provider/production endpoint');
      if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: 'synthetic-access-token', expires_in: 7200 });
      if (url.pathname === '/wxa/getwxacodeunlimit') return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      throw Error('Uncommissioned provider endpoint');
    });
  });
  afterEach(() => { vi.restoreAllMocks(); }); afterAll(async () => { await f?.close(); }, 30000);
  async function create(uid = 22) {
    const t = uid === 22 ? token : (await createToken(uid, 'api', md5(f.password), f.env.APP_KEY)).token;
    const response = await app.request('/api/division/agent/spread/code', { headers: { 'Authori-zation': `Bearer ${t}` } }, f.env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  it('uses QRid901!=uid22, bounded fixed provider/page/a scene, signed old shape and genuine raster image with no identity/history changes', async () => {
    const before = await f.snapshot(), result = await create(); expect(result.body.status, result.body.msg).toBe(200);
    expect(Object.keys(result.body.data).sort()).toEqual(['expires', 'url']);
    const provider = calls.find(call => call.url.pathname === '/wxa/getwxacodeunlimit')!;
    expect(provider.body).toMatchObject({ page: DIVISION_STAFF_INVITE_PAGE, scene: 'a=901', check_path: true, width: 430 });
    const image = await app.request(result.body.data.url, {}, f.env); expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png'); expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
    expect(image.headers.get('cache-control')).toContain('private, no-store');
    expect(calls.filter(call => call.url.pathname === '/wxa/getwxacodeunlimit')).toHaveLength(1);
    expect([...state.cache.keys()].some(key => key.startsWith('division_staff_invite:v2:'))).toBe(true);
    expect([...state.cache.keys()].some(key => key.startsWith('routine_code:division_agent:'))).toBe(false);
    expect(await f.snapshot()).toEqual(before);
  });
  it('creates only one real catalogue row for a live uncoded agent and never reuses UID as a missing QR fallback', async () => {
    await f.db.insert(user).values({ uid: 88, account: 'uncoded-test-agent', pwd: f.password, divisionType: 2,
      divisionStatus: 1, divisionId: 10, agentId: 88, divisionPercent: 20, divisionEndTime: f.now + 86400 });
    const before = await f.snapshot(); expect((await create(88)).body.status).toBe(200); expect((await create(88)).body.status).toBe(200);
    const after = await f.snapshot(), rows = after.qr.filter(row => row.thirdId === 88 && row.thirdType === 'division_agent');
    expect(rows).toHaveLength(1); expect(rows[0].id).not.toBe(88); expect(rows[0].status).toBe(1);
    expect(after.users).toEqual(before.users); expect(after.orders).toEqual(before.orders); expect(after.brokerage).toEqual(before.brokerage);
    expect(calls.find(call => call.url.pathname === '/wxa/getwxacodeunlimit')!.body).toMatchObject({ scene: `a=${rows[0].id}` });
  });
  it.each([0, 2])('does not reactivate a revoked/non-active existing catalogue status %i', async status => {
    await f.db.update(qrcode).set({ status }).where(eq(qrcode.id, 901)); const before = await f.snapshot();
    expect((await create()).body.status).not.toBe(200); expect(calls).toEqual([]); expect(await f.snapshot()).toEqual(before);
  });
  it('returns actual503 for missing SQL credentials despite any stale config cache and makes no provider call', async () => {
    await f.db.delete(systemConfig); state.cache.set('cfg_routine_appId', 'cached-app'); state.cache.set('cfg_routine_appsecret', 'cached-secret');
    const before = await f.snapshot(), result = await create(); expect(result.response.status).toBe(503); expect(result.body.status).toBe(503);
    expect(calls).toEqual([]); expect(await f.snapshot()).toEqual(before);
  });
  it('rejects image expiry, malformed query and forged signature without provider calls', async () => {
    const created = await create(), original = new URL(created.body.data.url); calls.length = 0;
    for (const query of ['expires=1&signature=' + 'a'.repeat(64), original.search.slice(1) + '&expires=2',
      `expires=${created.body.data.expires}&signature=${'a'.repeat(64)}`, original.search.slice(1) + '&arbitrary_url=https://other.test']) {
      const response = await app.request(`${original.origin}${original.pathname}?${query}`, {}, f.env);
      expect((await response.json<{ status: number }>()).status).not.toBe(200);
    }
    expect(calls).toEqual([]);
  });
  it.each([{ divisionStatus: 0 }, { divisionType: 0 }, { status: 0 }, { pwd: 'new-password' }, { divisionEndTime: 1 }])('withdraws a signed/cached image immediately after current agent change %j', async change => {
    const created = await create(); await f.db.update(user).set(change).where(eq(user.uid, 22)); calls.length = 0;
    const response = await app.request(created.body.data.url, {}, f.env); expect((await response.json<{ status: number }>()).status).not.toBe(200);
    expect(calls).toEqual([]);
  });
  it('rejects old image after SQL AppID or secret rotation and checks provider expected AppID directly', async () => {
    const created = await create(); await f.db.update(systemConfig).set({ value: 'wx0000000000000002' }).where(eq(systemConfig.menuName, 'routine_appId'));
    calls.length = 0; expect((await (await app.request(created.body.data.url, {}, f.env)).json<{ status: number }>()).status).not.toBe(200); expect(calls).toEqual([]);
    await expect(new WechatMiniProgramCodeService(f.container, f.env).createDivisionStaffInviteDataUrl(901, 'wx0000000000000001')).rejects.toThrow('账户已变化');
  });
  it('does not hold any SQL transaction during provider I/O and refuses provider success after real authority withdrawal', async () => {
    let inside = 0; const original = f.db.transaction.bind(f.db);
    vi.spyOn(f.db, 'transaction').mockImplementation((fn, ...options) => original(async tx => { inside++; try { return await fn(tx); } finally { inside--; } }, ...options));
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      expect(inside).toBe(0);
      if (String(input).includes('/cgi-bin/token')) return Response.json({ access_token: 'synthetic-token', expires_in: 7200 });
      expect(JSON.parse(String(init?.body))).toMatchObject({ scene: 'a=901' });
      await f.db.update(user).set({ divisionStatus: 0 }).where(eq(user.uid, 22));
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    });
    const result = await create(); expect(result.body.status).not.toBe(200);
    expect([...state.cache.keys()].some(key => key.startsWith('division_staff_invite:v2:'))).toBe(false);
  });
  it('cannot serve tampered cache bytes or MIME even after genuine provider creation', async () => {
    const created = await create(), key = [...state.cache.keys()].find(key => key.startsWith('division_staff_invite:v2:'))!;
    const record = state.cache.get(key) as { image: { mime: string; base64: string } };
    record.image.base64 = Buffer.from('<svg/onload=alert(1)>').toString('base64'); record.image.mime = 'image/svg+xml'; calls.length = 0;
    const response = await app.request(created.body.data.url, {}, f.env);
    expect((await response.json<{ status: number }>()).status).not.toBe(200); expect(calls).toEqual([]);
  });
  it.each(['malformed raster', 'oversized stream', 'provider leaked secret'])('returns bounded safe errors for %s with no key or arbitrary URL in response', async scenario => {
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).includes('/cgi-bin/token')) return Response.json({ access_token: 'synthetic-token', expires_in: 7200 });
      if (scenario === 'provider leaked secret') throw Error('secret=synthetic-employee-secret https://untrusted.test');
      return new Response(scenario === 'malformed raster' ? '<svg/>' : new Uint8Array(1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } });
    });
    const result = await create(); expect(result.response.status).toBe(503); expect(result.body.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('synthetic-employee-secret'); expect(JSON.stringify(result.body)).not.toContain('untrusted.test');
  });
  it('uses the mature single invalid-token refresh and still emits the employee scene', async () => {
    let attempt = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input)); calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: `synthetic-token-${attempt}`, expires_in: 7200 });
      return ++attempt === 1 ? Response.json({ errcode: 40001, errmsg: 'synthetic expired token' }) : new Response(png, { headers: { 'Content-Type': 'image/png' } });
    });
    expect((await create()).body.status).toBe(200);
    expect(calls.filter(call => call.url.pathname === '/cgi-bin/token')).toHaveLength(2);
    expect(calls.filter(call => call.url.pathname === '/wxa/getwxacodeunlimit').map(call => call.body)).toEqual([
      expect.objectContaining({ scene: 'a=901', page: DIVISION_STAFF_INVITE_PAGE }), expect.objectContaining({ scene: 'a=901', page: DIVISION_STAFF_INVITE_PAGE })]);
  });
  it.each(['suppress', 'rewrite', 'after'])('rolls back a genuine %s QR insertion trigger before exposing a signed invite', async mode => {
    await f.db.delete(qrcode).where(eq(qrcode.id, 901));
    const action = mode === 'suppress' ? 'RETURN NULL;' : mode === 'rewrite' ? "NEW.third_id=777; RETURN NEW;" : "UPDATE qrcode SET status=0 WHERE id=NEW.id; RETURN NEW;";
    await f.exec(`CREATE FUNCTION division_staff_qr_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${action} END $$`);
    await f.exec(`CREATE TRIGGER division_staff_qr_failure ${mode === 'after' ? 'AFTER' : 'BEFORE'} INSERT ON qrcode FOR EACH ROW EXECUTE FUNCTION division_staff_qr_failure()`);
    try { const before = await f.snapshot(); expect((await create()).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before); expect(calls).toEqual([]); }
    finally { await f.exec('DROP TRIGGER division_staff_qr_failure ON qrcode'); await f.exec('DROP FUNCTION division_staff_qr_failure()'); }
  });
  it('rolls back a genuine QR AFTER trigger that preserves QR fields but changes the locked agent balance/phone', async () => {
    await f.db.delete(qrcode).where(eq(qrcode.id, 901));
    await f.exec('CREATE FUNCTION division_staff_qr_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE "user" SET now_money=now_money+1,phone=\'13900000022\' WHERE uid=NEW.third_id; RETURN NEW; END $$');
    await f.exec('CREATE TRIGGER division_staff_qr_failure AFTER INSERT ON qrcode FOR EACH ROW EXECUTE FUNCTION division_staff_qr_failure()');
    try { const before = await f.snapshot(); expect((await create()).body.status).not.toBe(200); expect(await f.snapshot()).toEqual(before); expect(calls).toEqual([]); }
    finally { await f.exec('DROP TRIGGER division_staff_qr_failure ON qrcode'); await f.exec('DROP FUNCTION division_staff_qr_failure()'); }
  });
});
