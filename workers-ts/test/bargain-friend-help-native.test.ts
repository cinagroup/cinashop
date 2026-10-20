import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import { eq } from 'drizzle-orm';
import type { Container } from '@/lib/di';
import { storeBargain, storeBargainUser, storeProduct, user } from '@/models/schema';
import { bargainShortSkuRuntimeFixture } from './helpers/bargainShortSkuRuntime';

const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: (env: object) => {
    const value = wiring.containers.get(env); if (!value) throw Error('Owned friend App SQL missing'); return value;
  },
  createAdminDatabaseSession: (env: object) => {
    const value = wiring.containers.get(env); if (!value) throw Error('Owned friend Admin SQL missing');
    return { container: value, close: async () => {} };
  },
}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Bargain friend invitation actual App/JWT on owned PG16', () => {
  const app = createApp();
  let f: Awaited<ReturnType<typeof bargainShortSkuRuntimeFixture>> | undefined;
  beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned friend flow forbids providers')); });
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { try { await f?.close(); } finally { f = undefined; vi.restoreAllMocks(); } }
  }, 30000);
  async function request(path: string, body?: object, identity: 'buyer' | 'helper' | 'admin' | 'guest' = 'buyer') {
    if (!f) throw Error('Owned friend fixture missing');
    const env = { ...f.env, PUBLIC_H5_ORIGIN: 'https://shop.example.test',
      // Donor quote KV defaults absent keys to "0"; an unconfigured QR AppID
      // is empty in the real SQL snapshot, so declare those test keys precisely.
      CONFIG_KV: new Proxy(f.env.CONFIG_KV, { get(target, key) {
        if (key === 'get') return (name: string) => ['cfg_routine_appId', 'cfg_routine_appsecret'].includes(name) ? Promise.resolve('') : target.get(name);
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }),
      // Owned deterministic Durable Object I/O; actual controller still checks its reply.
      TOKEN_BUCKET: { getByName: () => ({ consumeRateLimit: async () => ({ allowed: true, resetAt: Date.now() + 60000 }) }) } as any };
    wiring.containers.set(env, f.container);
    const token = identity === 'admin' ? f.adminToken : identity === 'helper' ? f.helperToken : f.token;
    const response = await app.request(path, { method: body ? 'POST' : 'GET',
      headers: { ...(identity === 'guest' ? {} : { Authorization: 'Bearer ' + token }), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  async function start() {
    f = await bargainShortSkuRuntimeFixture();
    const saved = await request('/adminapi/activity/save', f.adminInput(), 'admin');
    expect(saved.body.status, saved.body.msg).toBe(200);
    const activityId = saved.body.data.id;
    const started = await request('/api/bargain/start', { bargain_id: activityId });
    expect(started.body.status, started.body.msg).toBe(200);
    return { activityId, participantId: started.body.data.id as number };
  }
  it('serves a minimal exact-participant friend view without exposing owner purchase selection or mutating any public SQL', async () => {
    const { activityId, participantId } = await start();
    const before = await f!.snapshot(), sequences = await f!.sequences();
    const reply = await request(`/api/bargain/detail/${activityId}?view=help&bargain_user_id=${participantId}`, undefined, 'helper');
    expect(await f!.snapshot()).toEqual(before); expect(await f!.sequences()).toEqual(sequences);
    expect(reply.body.status, reply.body.msg).toBe(200);
    expect(reply.body.data).toMatchObject({ help_only: true, type: 2, bargain_id: activityId,
      participant_id: participantId, is_owner: false, can_help: true, help_state: 'available' });
    expect(reply.body.data).not.toHaveProperty('skus'); expect(reply.body.data).not.toHaveProperty('can_select');
    expect(Object.keys(reply.body.data.owner).sort()).toEqual(['avatar', 'nickname']);
    expect(reply.response.headers.get('cache-control')).toBe('private, no-store');
  }, 120000);
  it('creates an exact-participant QR whose public landing retains this invitation', async () => {
    const { activityId, participantId } = await start();
    const initial = await f!.snapshot(), initialSequences = await f!.sequences();
    const reply = await request(`/api/get_qrcode/2/${activityId}?bargain_user_id=${participantId}`);
    expect(reply.body.status, reply.body.msg).toBe(200);
    const created = await f!.snapshot();
    expect(initial.cache).toEqual([]);
    expect(created.cache).toHaveLength(2);
    for (const entry of created.cache as Array<{ row: { key: string; result: string } }>) {
      expect(entry.row.key).toMatch(/^(?:lsc:|lshare:)[a-f0-9]+$/);
      expect(JSON.parse(entry.row.result).descriptor).toMatchObject({ type: 2, id: activityId, bargainUserId: participantId, bargainOwnerUid: 11 });
    }
    for (const table of Object.keys(initial)) if (table !== 'cache') expect(created[table], table).toEqual(initial[table]);
    expect(await f!.sequences()).toEqual(initialSequences);
    const token = new URL(reply.body.data.wechatUrl, 'https://owned.test').pathname.split('/')[5];
    const scene = await request('/api/share/scene/' + token, undefined, 'helper');
    expect(scene.body.status, scene.body.msg).toBe(200);
    expect(scene.body.data).toMatchObject({ type: 2, id: activityId, bargain_user_id: participantId,
      path: `/pages/activity/bargainDetail?id=${activityId}&bargainUserId=${participantId}&help=1&spid=11` });
    const before = await f!.snapshot(), sequences = await f!.sequences();
    const cached = await request(`/api/get_qrcode/2/${activityId}?bargain_user_id=${participantId}`);
    expect(cached.body.status, cached.body.msg).toBe(200);
    expect(new URL(cached.body.data.wechatUrl, 'https://owned.test').pathname).toBe(new URL(reply.body.data.wechatUrl, 'https://owned.test').pathname);
    expect(await f!.sequences()).toEqual(sequences);
    expect(await f!.snapshot()).toEqual(before);
    await f!.db.update(storeBargainUser).set({ uid: 22 }).where(eq(storeBargainUser.id, participantId));
    const changed = await request('/api/share/scene/' + token, undefined, 'helper');
    expect(changed.body.status).not.toBe(200);
  }, 120000);

  it('rejects missing, duplicate, malformed and mixed identities plus foreign owner purchase reads without SQL writes', async () => {
    const { activityId, participantId } = await start();
    const before = await f!.snapshot(), sequences = await f!.sequences();
    for (const query of ['view=help', 'view=help&bargain_user_id=0', 'view=help&bargain_user_id=0101',
      'view=help&bargain_user_id=2147483648', 'view=help&bargain_user_id=999999',
      `view=help&bargain_user_id=${participantId}&bargain_user_uid=11`,
      `view=help&bargain_user_id=${participantId}&bargain_user_id=${participantId}`,
      `view=help&view=skus&bargain_user_id=${participantId}`, `view=help&bargain_user_id=${participantId}&uid=11`,
      `view=skus&bargain_user_id=${participantId}`]) {
      const reply = await request(`/api/bargain/detail/${activityId}?${query}`, undefined, 'helper');
      expect(reply.body.status, query).not.toBe(200);
    }
    const guest = await request(`/api/bargain/detail/${activityId}?view=help&bargain_user_id=${participantId}`, undefined, 'guest');
    expect(guest.body.status).not.toBe(200);
    for (const query of [`bargain_user_id=${participantId}&bargain_user_id=${participantId}`, 'bargain_user_id=0',
      `bargain_user_id=${participantId}&uid=11`])
      expect((await request(`/api/get_qrcode/2/${activityId}?${query}`)).body.status).not.toBe(200);
    expect((await request(`/api/get_qrcode/1/${activityId}?bargain_user_id=${participantId}`)).body.status).not.toBe(200);
    expect(await f!.snapshot()).toEqual(before); expect(await f!.sequences()).toEqual(sequences);
  }, 120000);

  it('actual self and friend mutations complete the frozen participation once while read views grant no purchase authority', async () => {
    const { activityId, participantId } = await start();
    const read = async (identity: 'buyer' | 'helper' = 'helper') =>
      request(`/api/bargain/detail/${activityId}?view=help&bargain_user_id=${participantId}`, undefined, identity);
    expect((await read('buyer')).body.data).toMatchObject({ is_owner: true, can_help: false, help_state: 'owner' });
    expect((await request('/api/bargain/help', { bargain_user_id: participantId })).body.status).toBe(200);
    const intermediate = await read(); expect(intermediate.body.data).toMatchObject({ can_help: true, help_count: 1 });
    expect((await request('/api/bargain/help', { bargain_user_id: participantId }, 'helper')).body.status).toBe(200);
    const complete = await read();
    expect(complete.body.data).toMatchObject({ can_help: false, help_state: 'ready', already_helped: true, help_count: 2,
      participation: { id: participantId, state: 'ready', current_price: '2.00', remaining_cut: '0.00' } });
    const before = await f!.snapshot(), sequences = await f!.sequences();
    expect((await request('/api/bargain/help', { bargain_user_id: participantId }, 'helper')).body.status).not.toBe(200);
    expect(await f!.snapshot()).toEqual(before); expect(await f!.sequences()).toEqual(sequences);
    expect((await request(`/api/bargain/detail/${activityId}?view=skus&bargain_user_id=${participantId}`, undefined, 'helper')).body.status).not.toBe(200);
  }, 120000);

  it('legacy owner resolution rejects ambiguity and exact invitations never follow a newer participation', async () => {
    const { activityId, participantId } = await start();
    const legacy = () => request(`/api/bargain/detail/${activityId}?view=help&bargain_user_uid=11`, undefined, 'helper');
    expect((await legacy()).body.data.participant_id).toBe(participantId);
    const [record] = await f!.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId));
    const { id: _id, ...copy } = record;
    await f!.db.insert(storeBargainUser).values(copy);
    const before = await f!.snapshot(), sequences = await f!.sequences();
    expect((await legacy()).body.status).not.toBe(200);
    const exact = await request(`/api/bargain/detail/${activityId}?view=help&bargain_user_id=${participantId}`, undefined, 'helper');
    expect(exact.body.data.participant_id).toBe(participantId);
    expect(await f!.snapshot()).toEqual(before); expect(await f!.sequences()).toEqual(sequences);
  }, 120000);

  it('visibility, owner status, expiry, limits and stock are freshly validated without leaking hidden invitations', async () => {
    const { activityId, participantId } = await start();
    const read = () => request(`/api/bargain/detail/${activityId}?view=help&bargain_user_id=${participantId}`, undefined, 'helper');
    for (const patch of [{ isShow: 0 }, { isVerify: 0 }, { isDel: 1 }, { isVipProduct: 1 }]) {
      await f!.db.update(storeProduct).set(patch).where(eq(storeProduct.id, 70));
      const before = await f!.snapshot(); expect((await read()).body.status).not.toBe(200);
      expect(await f!.snapshot()).toEqual(before);
      await f!.db.update(storeProduct).set({ isShow: 1, isVerify: 1, isDel: 0, isVipProduct: 0 }).where(eq(storeProduct.id, 70));
    }
    await f!.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
    expect((await read()).body.status).not.toBe(200);
    await f!.db.update(user).set({ status: 1 }).where(eq(user.uid, 11));
    for (const [patch, state] of [[{ bargainNum: 0 }, 'limit_reached'], [{ stock: 0 }, 'sold_out'],
      [{ stopTime: new Date(Date.now() - 1000) }, 'ended']] as const) {
      await f!.db.update(storeBargain).set(patch).where(eq(storeBargain.id, activityId));
      const before = await f!.snapshot(), sequences = await f!.sequences();
      expect((await read()).body.data).toMatchObject({ can_help: false, help_state: state });
      expect(await f!.snapshot()).toEqual(before); expect(await f!.sequences()).toEqual(sequences);
      await f!.db.update(storeBargain).set({ bargainNum: 3, stock: 6, stopTime: new Date(Date.now() + 3600000) }).where(eq(storeBargain.id, activityId));
    }
  }, 120000);
});
