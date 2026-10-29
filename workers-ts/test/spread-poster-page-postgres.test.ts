/** Complete-schema proof for current-owner poster reads and genuine local H5
 * QR cache writes. Provider/native-device/bitmap-decode claims are out of scope. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { assertSpreadPosterQrDelta, spreadPosterFixture, SPREAD_POSTER as ids } from './helpers/spreadPosterFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const container = wiring.context?.getStore(); if (!container) throw Error('Owned spread-poster App LOGIN required'); return container;
} }));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('spread poster full283tables229sequences registered JWT contract', () => {
  let f: Awaited<ReturnType<typeof spreadPosterFixture>>;
  beforeAll(async () => { f = await spreadPosterFixture(); wiring.context = new AsyncLocalStorage<Container>(); }, 60000);
  afterAll(async () => { wiring.context = undefined; await f?.close(); vi.restoreAllMocks(); }, 30000);

  it('keeps own metadata, template authority, signed-media reads and every failure SQL-readonly on an independent SELECT-only LOGIN', async () => {
    const app = createApp(), forbiddenFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external provider'));
    try { await f.withApplication(async runtime => {
      expect(runtime.shareWrites).toBe(false);
      const request = async (path: string, uid: number = ids.a, token?: string) => {
        const headers = new Headers({ 'Form-type': 'h5' }); if (uid) headers.set('Authori-zation', 'Bearer ' + (token ?? f.tokens.get(uid)));
        const before = await f.snapshot(), resources = f.resources(), jobs: Promise<unknown>[] = [];
        const response = await wiring.context!.run(runtime.container, () => app.fetch(new Request('https://spread-poster-proof.test' + path, { headers }), runtime.env,
          { waitUntil: (job: Promise<unknown>) => jobs.push(job), passThroughOnException: () => {} } as never));
        const bytes = Buffer.from(await response.arrayBuffer()); expect(await Promise.allSettled(jobs)).toEqual([]);
        expect(await f.snapshot()).toEqual(before); expect(f.resources()).toEqual(resources);
        return { response, bytes, json: () => JSON.parse(bytes.toString('utf8')) as Record<string, any> };
      };
      const owner = await request('/api/user/spread_info');
      expect(owner.json()).toMatchObject({ status: 200, data: { nickname: 'PHP海报本人甲', site_name: 'PHP推广海报验收', qrcode: '' } });
      expect(owner.response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      const data = owner.json().data; expect(data.spread).toHaveLength(2);
      for (const [path, imageId, expected] of [[data.avatar, ids.avatarA, f.avatar], [data.spread[0].pic, ids.template1, f.template], [data.spread[1].pic, ids.template2, f.template]] as const) {
        expect(path).toMatch(new RegExp('^/api/assets/' + imageId + '\\?expires=\\d+&signature='));
        const image = await request(path, 0); expect(image.response.status).toBe(200); expect(image.bytes).toEqual(expected);
      }
      const other = (await request('/api/user/spread_info', ids.b)).json(); expect(other).toMatchObject({ status: 200, data: { nickname: 'PHP海报本人乙' } });
      expect(other.data.avatar).toMatch(new RegExp('^/api/assets/' + ids.avatarB + '\\?'));
      for (const [uid, token] of [[0, undefined], [ids.a, 'invalid']] as const) expect((await request('/api/user/spread_info', uid, token)).json().status).not.toBe(200);
      expect((await request('/api/user/spread_info?uid=' + ids.b)).json().status).not.toBe(200);
      for (const scenario of ['avatar-relative', 'avatar-foreign', 'template-relative', 'template-foreign'] as const) {
        await f.control(scenario); const result = (await request('/api/user/spread_info')).json(); expect(result.status).toBe(400);
        if (scenario === 'avatar-relative' || scenario === 'template-relative') expect(result.msg).toMatch(/相对图片尚无受控映射/);
        await f.control('normal');
      }
      await f.control('avatar-empty'); expect((await request('/api/user/spread_info')).json().data.avatar).toBe(''); await f.control('normal');
      await f.control('empty-templates'); expect((await request('/api/user/spread_info')).json().data.spread).toEqual([]); await f.control('normal');
      for (const scenario of ['password-revoked', 'status-revoked', 'deleted'] as const) {
        await f.control(scenario); expect((await request('/api/user/spread_info')).json().status).not.toBe(200); await f.control('restore-account');
      }
      await f.control('missing-template'); expect((await request(data.spread[1].pic, 0)).response.status).toBe(404); await f.control('restore-template');
      await f.control('corrupt-template'); const corrupt = await request(data.spread[1].pic, 0);
      // The object endpoint preserves stored bytes. Actual browser decoding is
      // required to prove the image error affordance, not a fake backend failure.
      expect(corrupt.response.status).toBe(200); expect(corrupt.bytes.toString('utf8')).toBe('corrupt-template-payload'); await f.control('restore-template');
      await f.control('missing-avatar'); expect((await request(data.avatar, 0)).response.status).toBe(404); await f.control('restore-avatar');
      await f.control('corrupt-avatar'); expect((await request(data.avatar, 0)).bytes.toString('utf8')).toBe('corrupt-avatar-payload'); await f.control('restore-avatar');
      for (const path of ['/api/assets/' + ids.template1, data.spread[0].pic.replace(/signature=[^&]+/, 'signature=invalid'),
        data.spread[0].pic.replace(/expires=\d+/, 'expires=1')]) expect((await request(path, 0)).response.status).toBe(404);
      const finance = (await request('/api/commission')).json(); expect(finance).toMatchObject({ status: 200, data: { uid: ids.a, withdrawable: '0.00' } });
      expect(f.forbidden).not.toHaveBeenCalled(); expect(forbiddenFetch).not.toHaveBeenCalled();
    }); } finally { forbiddenFetch.mockRestore(); }
  }, 120000);

  it('accounts for the genuine H5 QR two-record cache write, cached repeat, signed image and owner-specific landing without provider calls or serial use', async () => {
    const app = createApp(), forbiddenFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external provider'));
    try { await f.withApplication(async runtime => {
      expect(runtime.shareWrites).toBe(true);
      const request = async (path: string, uid: number = ids.a) => {
        const headers = new Headers({ 'Form-type': 'h5' }); if (uid) headers.set('Authori-zation', 'Bearer ' + f.tokens.get(uid));
        const jobs: Promise<unknown>[] = [], response = await wiring.context!.run(runtime.container, () => app.fetch(new Request('https://spread-poster-proof.test' + path, { headers }), runtime.env,
          { waitUntil: (job: Promise<unknown>) => jobs.push(job), passThroughOnException: () => {} } as never));
        const bytes = Buffer.from(await response.arrayBuffer()); expect(await Promise.allSettled(jobs)).toEqual([]);
        return { response, bytes, json: () => JSON.parse(bytes.toString('utf8')) as Record<string, any> };
      };
      for (const uid of [ids.a, ids.b]) {
        const before = await f.snapshot(), resources = f.resources(), budgets = f.budgetCalls.length, start = Date.now();
        const generated = await request('/api/get_qrcode/-1/' + uid, uid), end = Date.now(), after = await f.snapshot();
        expect(generated.json().status, generated.bytes.toString('utf8')).toBe(200);
        const delta = assertSpreadPosterQrDelta(before, after, uid, start, end, f.appKey);
        expect(f.resources()).toEqual(resources); expect(f.budgetCalls.length - budgets).toBe(2);
        const code = generated.json().data; expect(code.routineUrl).toBe(''); expect(code.nickname).toBe(uid === ids.a ? 'PHP海报本人甲' : 'PHP海报本人乙');
        expect(code.wechatUrl).toMatch(new RegExp('^/api/share/code/image/' + delta.token + '/wechat\\?expires=\\d+&signature=[a-f0-9]{64}$'));
        const cached = await request('/api/get_qrcode/-1/' + uid, uid); expect(cached.json().status).toBe(200); expect(await f.snapshot()).toEqual(after);
        const picture = await request(code.wechatUrl, 0); expect(picture.response.status).toBe(200); expect(picture.response.headers.get('content-type')).toBe('image/gif');
        expect(picture.bytes.subarray(0, 6).toString('ascii')).toMatch(/^GIF8[79]a$/); expect(await f.snapshot()).toEqual(after);
        const landing = (await request('/api/share/scene/' + delta.token, 0)).json();
        expect(landing).toMatchObject({ status: 200, data: { type: -1, id: 0, spid: uid, path: '/pages/index/index?spid=' + uid } }); expect(await f.snapshot()).toEqual(after);
        const wrong = await request(code.wechatUrl.replace(/signature=[^&]+/, 'signature=invalid'), 0); expect(wrong.json().status).not.toBe(200); expect(await f.snapshot()).toEqual(after);
      }
      const before = await f.snapshot(); await f.control('password-revoked'); const revoked = await f.snapshot();
      expect((await request('/api/get_qrcode/-1/' + ids.a)).json().status).not.toBe(200); expect(await f.snapshot()).toEqual(revoked);
      await f.control('restore-account'); expect(await f.snapshot()).toEqual(before);
      expect(f.forbidden).not.toHaveBeenCalled(); expect(forbiddenFetch).not.toHaveBeenCalled();
    }, { shareWrites: true }); } finally { forbiddenFetch.mockRestore(); }
  }, 120000);
});
