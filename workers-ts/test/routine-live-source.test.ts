import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, ScheduledMaintenanceMessage } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { liveAnchor, liveGoods, liveRoom, liveRoomGoods, systemConfig, systemLog } from '@/models/schema';
import { WechatLiveService } from '@/services/wechat/WechatLiveService';
import { readRoutineCredentials, routineCredentialCacheKey } from '@/services/wechat/RoutineRuntimeConfig';
import { createScheduledRunMessages, isScheduledMaintenanceMessage, ScheduledMaintenanceService } from '@/services/order/ScheduledMaintenanceService';
import { financePostgres } from './helpers/financePostgres';
import { withFinancePeers } from './helpers/financePeers';

const io = vi.hoisted(() => {
  const state = { available: true, depth: 0, violations: [] as string[], values: new Map<string, unknown>(),
    getHook: undefined as undefined | (() => Promise<void>), setHook: undefined as undefined | (() => Promise<void>) };
  const outside = (operation: string) => {
    if (state.depth !== 0) { state.violations.push(operation); throw Error('Live external I/O inside SQL: ' + operation); }
  };
  const redis = {
    get: vi.fn(async (key: string) => { outside('Redis GET'); const value = state.values.get(key) ?? null; await state.getHook?.(); return value; }),
    set: vi.fn(async (key: string, value: unknown, _options: { pxat: number }) => {
      outside('Redis SET'); state.values.set(key, value); await state.setHook?.(); return 'OK';
    }),
    del: vi.fn(async (key: string) => { outside('Redis DEL'); return Number(state.values.delete(key)); }),
  };
  return { state, outside, redis };
});
vi.mock('@/utils/cache', async original => ({
  ...await original<typeof import('@/utils/cache')>(), getRedis: () => io.state.available ? io.redis : null,
}));

const APP = 'owned-live-app', SECRET = 'owned-live-secret';
const actor = { id: 71, name: 'Owned live admin', ip: '127.0.0.1' };
type Kind = 'room' | 'goods' | 'anchor';
const jobs = { room: 'live_room_sync', goods: 'live_goods_sync', anchor: 'live_anchor_sync' } as const;
const oldCache = new Map([
  ['routine_access_token', 'old-global-token'], ['routine_access_token:' + APP, 'old-app-id-token'],
  ['wechat_access_token', 'official-token'], ['native_app_access_token:' + APP, 'native-token'],
]);

/** Actual SQL snapshots, row writes, triggers and the production source fence.
 * Only provider/Redis/queue transports are controlled. Memory proves atomic
 * business behavior; the independent backend lock case runs only on native PG. */
describe('Live read-only provider operations bound to one routine SQL source', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
  let respond: undefined | ((url: URL, init?: RequestInit) => Promise<Response | undefined>);
  let queueHook: undefined | (() => Promise<void>);
  const sent: ScheduledMaintenanceMessage[] = [];

  function observed(db: DbClient): DbClient {
    return new Proxy(db, { get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function') return method;
      if (property !== 'transaction') return method.bind(target);
      return (...args: unknown[]) => {
        const callback = args[0]; if (typeof callback !== 'function') throw Error('Real SQL callback required');
        return Reflect.apply(method, target, [async (tx: DbClient) => {
          io.state.depth++;
          try { return await callback(observed(tx)); } finally { io.state.depth--; }
        }, ...args.slice(1)]);
      };
    } });
  }
  const container = () => createContainerFromDb(observed(f.db));
  const service = () => new WechatLiveService(container(), env, fetcher);
  const current = () => readRoutineCredentials(container(), env);
  const rotate = () => f.db.update(systemConfig).set({ value: JSON.stringify('rotated-live-secret') }).where(eq(systemConfig.id, 2));
  const snapshot = async () => ({ rooms: await f.db.select().from(liveRoom).orderBy(liveRoom.id, liveRoom.phone),
    goods: await f.db.select().from(liveGoods).orderBy(liveGoods.id), anchors: await f.db.select().from(liveAnchor).orderBy(liveAnchor.id),
    links: await f.db.select().from(liveRoomGoods), logs: await f.db.select().from(systemLog).orderBy(systemLog.id) });
  const message = async (kind: Kind): Promise<ScheduledMaintenanceMessage> => ({ action: 'runScheduledMaintenance', job: jobs[kind],
    runId: 'scheduled:1800000000000', scheduledAt: 1800000000000, cursor: 0, threshold: null, routineStamp: (await current()).stamp });
  const sync = (kind: Kind, input: ScheduledMaintenanceMessage) => {
    const live = service();
    return kind === 'room' ? live.syncRooms(input) : kind === 'goods' ? live.syncGoods(input) : live.syncAnchors(input);
  };
  const urls = () => fetcher.mock.calls.map(([input]) => new URL(String(input)));

  beforeAll(async () => {
    f = await financePostgres([systemConfig, liveRoom, liveGoods, liveAnchor, liveRoomGoods, systemLog], { namespace: 'public' });
  }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    vi.clearAllMocks(); io.state.available = true; io.state.depth = 0; io.state.violations.length = 0;
    io.state.values.clear(); io.state.getHook = undefined; io.state.setHook = undefined; sent.length = 0; respond = undefined; queueHook = undefined;
    for (const [key, value] of oldCache) io.state.values.set(key, value);
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: JSON.stringify(APP), sort: 5 },
      { id: 2, menuName: 'routine_appsecret', value: JSON.stringify(SECRET), sort: 5 },
      { id: 3, menuName: 'routine_appsecret', value: 'unselected-shadow', sort: -1 },
      { id: 4, menuName: 'wechat_app_appsecret', value: 'native-secret' },
      { id: 5, menuName: 'wechat_appsecret', value: 'official-secret' },
    ]);
    await f.db.insert(liveRoom).values({ id: 7, roomId: 701, name: 'Local room', phone: '13800000001', anchorWechat: 'owned-anchor', isShow: 0, sort: 9 });
    await f.db.insert(liveGoods).values({ id: 11, goodsId: 801, name: 'Local goods', price: '9.50', auditStatus: 0, isShow: 0 });
    await f.db.insert(liveAnchor).values({ id: 17, wechat: 'owned-anchor', name: 'Local anchor', phone: '13800000002', isShow: 0 });
    await f.db.insert(liveRoomGoods).values({ liveRoomId: 7, liveGoodsId: 11 });
    env = { APP_KEY: 'owned-live-source-signing-key', CONFIG_KV: {
      get: vi.fn(async () => { io.outside('KV GET'); throw Error('No credential KV authority'); }), put: vi.fn(), delete: vi.fn(),
    }, ORDER_QUEUE: {
      send: vi.fn(async (body: ScheduledMaintenanceMessage) => { io.outside('queue send'); sent.push(body); await queueHook?.(); }),
      sendBatch: vi.fn(async (batch: { body: ScheduledMaintenanceMessage }[]) => {
        io.outside('queue batch'); sent.push(...batch.map(row => row.body)); await queueHook?.();
      }),
    } } as unknown as Env;
    fetcher = vi.fn<typeof fetch>(async (input, init) => {
      io.outside('provider'); const url = new URL(String(input));
      expect(url.origin).toBe('https://api.weixin.qq.com');
      const override = await respond?.(url, init); if (override) return override;
      if (url.pathname === '/cgi-bin/token') return Response.json({ access_token: 'fresh-live-token', expires_in: 7200 });
      if (url.pathname === '/wxa/business/getliveinfo') {
        if (JSON.parse(String(init?.body)).action === 'get_replay') return Response.json({ live_replay: [{ media_url: 'owned-replay' }], total: 1 });
        return Response.json({ room_info: [{ roomid: 701, name: 'Remote room', live_status: 101 }], total: 1 });
      }
      if (url.pathname === '/wxa/business/getgoodswarehouse') return Response.json({ goods: [{ goods_id: 801, audit_status: 2 }] });
      if (url.pathname === '/wxaapi/broadcast/role/getrolelist') return Response.json({ list: [{ username: 'owned-anchor', nickname: 'Remote anchor', headingimg: '/remote-anchor.jpg' }] });
      throw Error('Unexpected live provider path');
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned live transport must be injected'));
  });
  afterEach(() => {
    try {
      expect(io.state.depth).toBe(0); expect(io.state.violations).toEqual([]); expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(env.CONFIG_KV.get).not.toHaveBeenCalled(); expect(env.CONFIG_KV.put).not.toHaveBeenCalled(); expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
      for (const [key, value] of oldCache) expect(io.state.values.get(key)).toBe(value);
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['room', 'goods', 'anchor'] as const)('applies a current %s response through real SQL while retaining source-shaped local state', async kind => {
    const credentials = await current(), before = await snapshot();
    expect(await sync(kind, await message(kind))).toMatchObject({ event: `wechat_live_${kind}_sync`, updated: 1, hasMore: false });
    const after = await snapshot();
    if (kind === 'room') { expect(after.rooms[0]).toMatchObject({ name: 'Remote room', liveStatus: 101, phone: '13800000001', isShow: 0, sort: 9 }); expect(after.goods).toEqual(before.goods); }
    if (kind === 'goods') { expect(after.goods[0]).toMatchObject({ auditStatus: 2, price: '9.50', isShow: 0 }); expect(after.rooms).toEqual(before.rooms); }
    if (kind === 'anchor') { expect(after.anchors[0]).toMatchObject({ name: 'Remote anchor', phone: '13800000002', isShow: 0 }); expect(after.rooms).toEqual(before.rooms); }
    expect(after.links).toEqual(before.links); expect(sent).toEqual([]);
    const token = urls().find(url => url.pathname === '/cgi-bin/token')!;
    expect(token.searchParams.get('appid')).toBe(APP); expect(token.searchParams.get('secret')).toBe(SECRET);
    const key = routineCredentialCacheKey(credentials, 'access_token');
    expect(io.redis.get.mock.calls).toEqual([[key]]); expect(io.redis.set.mock.calls.map(([written]) => written)).toEqual([key]);
    expect(key).not.toContain(APP); expect(key).not.toContain(SECRET);
  });

  it('keeps Redis optional and reads a new source for each operation even on a reused service', async () => {
    io.state.available = false; const live = service(), first = await message('room');
    await live.syncRooms(first); await rotate(); await live.syncRooms(await message('room'));
    expect(urls().filter(url => url.pathname === '/cgi-bin/token').map(url => url.searchParams.get('secret'))).toEqual([SECRET, 'rotated-live-secret']);
    expect(io.redis.get).not.toHaveBeenCalled(); expect(io.redis.set).not.toHaveBeenCalled();
  });

  it.each(['room', 'goods', 'anchor'] as const)('terminates old/malformed/rotated %s queue work without adopting current credentials or doing I/O', async kind => {
    const original = await message(kind), before = await snapshot();
    for (const stamp of [undefined, '', 'A'.repeat(64), 'a'.repeat(64)]) {
      const result = await sync(kind, { ...original, routineStamp: stamp });
      expect(result).toMatchObject({ ignored: true, reauthorization_required: true, reason: stamp === 'a'.repeat(64) ? 'source_changed' : 'source_missing' });
    }
    await rotate(); expect(await sync(kind, original)).toMatchObject({ ignored: true, reason: 'source_changed' });
    expect(await snapshot()).toEqual(before); expect(fetcher).not.toHaveBeenCalled(); expect(io.redis.get).not.toHaveBeenCalled(); expect(sent).toEqual([]);
  });

  it.each(['room', 'goods', 'anchor'] as const)('does not apply a %s response that returns after source rotation', async kind => {
    const input = await message(kind), before = await snapshot();
    respond = async url => { if (url.pathname !== '/cgi-bin/token') await rotate(); return undefined; };
    expect(await sync(kind, input)).toMatchObject({ ignored: true, reason: 'source_changed' });
    expect(await snapshot()).toEqual(before); expect(sent).toEqual([]);
  });

  it.each([40001, 40014, 42001])('refreshes invalid token %s exactly once within the same source and leaves every other namespace alone', async code => {
    const credentials = await current(); let liveRequests = 0;
    respond = async url => url.pathname !== '/cgi-bin/token' && liveRequests++ === 0 ? Response.json({ errcode: code, errmsg: 'expired' }) : undefined;
    expect(await sync('room', await message('room'))).toMatchObject({ updated: 1 });
    expect(io.redis.del.mock.calls).toEqual([[routineCredentialCacheKey(credentials, 'access_token')]]);
    expect(urls().filter(url => url.pathname === '/cgi-bin/token')).toHaveLength(2);
    expect(urls().filter(url => url.pathname !== '/cgi-bin/token')).toHaveLength(2);
  });

  it('never refreshes or retries an invalid-token response under a different source', async () => {
    const input = await message('room'), before = await snapshot();
    respond = async url => { if (url.pathname === '/cgi-bin/token') return undefined; await rotate(); return Response.json({ errcode: 40014 }); };
    expect(await sync('room', input)).toMatchObject({ ignored: true, reason: 'source_changed' });
    expect(urls()).toHaveLength(2); expect(io.redis.del).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  });

  it.each(['get', 'set'] as const)('rejects a %s token-cache I/O crossing rotation without sending a live request', async operation => {
    const credentials = await current(), input = await message('room'), key = routineCredentialCacheKey(credentials, 'access_token'), before = await snapshot();
    if (operation === 'get') {
      io.state.values.set(key, { version: 1, token: 'old-source-live-token', expiresAt: Date.now() + 3600000 }); io.state.getHook = async () => { await rotate(); };
    } else io.state.setHook = async () => { await rotate(); };
    expect(await sync('room', input)).toMatchObject({ ignored: true, reason: 'source_changed' });
    expect(urls().filter(url => url.pathname !== '/cgi-bin/token')).toEqual([]); expect(await snapshot()).toEqual(before);
    expect(io.state.values.has(routineCredentialCacheKey(await current(), 'access_token'))).toBe(false);
    expect(io.redis.get.mock.calls).toEqual([[key]]);
  });

  it('publishes only source-bound root and continuation messages without holding SQL during queue I/O', async () => {
    const credentials = await current();
    expect(await service().enqueueSync(1800000000000)).toMatchObject({ jobs: ['live_room_sync', 'live_goods_sync', 'live_anchor_sync'] });
    expect(sent.map(row => [row.job, row.routineStamp, row.cursor])).toEqual(Object.values(jobs).map(job => [job, credentials.stamp, 0]));
    const input = sent[0]; sent.length = 0;
    respond = async url => url.pathname === '/wxa/business/getliveinfo'
      ? Response.json({ room_info: [{ roomid: 701, name: 'Remote first page' }], total: 2 }) : undefined;
    expect(await service().syncRooms(input)).toMatchObject({ nextCursor: 1, hasMore: true });
    expect(sent).toEqual([{ ...input, cursor: 1 }]);
    await rotate(); fetcher.mockClear();
    expect(await service().syncRooms(sent[0])).toMatchObject({ ignored: true, reason: 'source_changed' }); expect(fetcher).not.toHaveBeenCalled();
  });

  it('consumes the production cron dispatch as a new request and creates three fresh-source page jobs with the original run identity', async () => {
    const dispatch = createScheduledRunMessages(1800000000000).find(row => row.job === 'live_sync_dispatch')!;
    expect(dispatch).toBeDefined(); expect(dispatch.routineStamp).toBeUndefined(); expect(isScheduledMaintenanceMessage(dispatch)).toBe(true);
    // The off-DB root was created before rotation and contains no old result or
    // credential claim. Dispatch deliberately starts a new current-source run.
    await rotate(); const credentials = await current();
    const maintenance = new ScheduledMaintenanceService(container(), env);
    expect(await maintenance.processMaintenance(dispatch)).toMatchObject({ event: 'wechat_live_sync_dispatched', runId: dispatch.runId, run_id: dispatch.runId });
    expect(sent).toHaveLength(3);
    for (const child of sent) {
      expect(child).toMatchObject({ scheduledAt: dispatch.scheduledAt, runId: dispatch.runId, routineStamp: credentials.stamp, cursor: 0, threshold: null });
      expect(isScheduledMaintenanceMessage(child)).toBe(true);
      const unbound = { ...child, routineStamp: undefined };
      expect(isScheduledMaintenanceMessage(unbound)).toBe(true);
      expect(await maintenance.processMaintenance(unbound)).toMatchObject({ ignored: true, reason: 'source_missing' });
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(io.redis.get).not.toHaveBeenCalled();
  });

  it('keeps missing configuration disabled for cron dispatch but does not disguise signing failures as a disabled run', async () => {
    const dispatch = createScheduledRunMessages(1800000000000).find(row => row.job === 'live_sync_dispatch')!;
    await f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.id, 2));
    expect(await new ScheduledMaintenanceService(container(), env).processMaintenance(dispatch)).toMatchObject({ event: 'wechat_live_sync_dispatch_disabled' });
    await expect(service().enqueueSync()).rejects.toThrow('未配置'); expect(sent).toEqual([]);
    await f.db.update(systemConfig).set({ value: JSON.stringify(SECRET) }).where(eq(systemConfig.id, 2));
    env.APP_KEY = '';
    await expect(new ScheduledMaintenanceService(container(), env).processMaintenance(dispatch)).rejects.toThrow('签名');
    expect(sent).toEqual([]); expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps a committed page in its own source but cannot silently switch a continuation after queue publication rotation', async () => {
    const input = await message('room');
    respond = async url => url.pathname === '/wxa/business/getliveinfo'
      ? Response.json({ room_info: [{ roomid: 701, name: 'Committed old-source page' }], total: 2 }) : undefined;
    queueHook = async () => { await rotate(); };
    expect(await service().syncRooms(input)).toMatchObject({ ignored: true, reason: 'source_changed' });
    expect((await f.db.select().from(liveRoom))[0].name).toBe('Committed old-source page');
    expect(sent).toEqual([{ ...input, cursor: 1 }]);
    fetcher.mockClear(); expect(await service().syncRooms(sent[0])).toMatchObject({ ignored: true }); expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns current replay data without a local mutation and rejects a stale replay response', async () => {
    const before = await snapshot();
    expect(await service().playbacks('7', {})).toEqual({ list: [{ media_url: 'owned-replay' }], total: 1, room_id: 701, runtime_authority: 'wechat_read_only' });
    respond = async url => { if (url.pathname !== '/cgi-bin/token') await rotate(); return undefined; };
    await expect(service().playbacks('7', {})).rejects.toThrow(/配置已变化/u); expect(await snapshot()).toEqual(before);
  });

  it('saves an actually verified anchor and audit in the same current-source SQL commit', async () => {
    const input = { id: 17, name: 'Edited anchor', wechat: 'owned-anchor', phone: '13800000002', cover_img: '/edited-anchor.jpg' };
    expect(await service().saveAnchor(input, actor)).toMatchObject({ role_verified: true, verified: true, anchor: { id: 17, name: 'Edited anchor' } });
    expect((await f.db.select().from(systemLog))).toMatchObject([{ adminId: actor.id, type: 'wechat_live', action: 'live.anchor.update;id=17;role=verified' }]);
    const before = await snapshot();
    respond = async url => { if (url.pathname !== '/cgi-bin/token') await rotate(); return undefined; };
    await expect(service().saveAnchor({ ...input, name: 'Stale role edit' }, actor)).rejects.toThrow(/配置已变化/u);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back both an anchor/audit and a late SQL source fault under the final source check', async () => {
    const before = await snapshot(), config = await f.db.select().from(systemConfig).orderBy(systemConfig.id);
    // Fault after the local write and audit INSERT proves the final source read
    // uses that same SQL commit; no production writer is replaced or bypassed.
    await f.exec(`CREATE FUNCTION public.routine_owned_live_source_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE public.system_config SET value='"late-owned-live-source"' WHERE id=2; RETURN NEW; END $$;
      CREATE TRIGGER routine_owned_live_source_fault AFTER INSERT ON public.system_log
        FOR EACH ROW EXECUTE FUNCTION public.routine_owned_live_source_fault()`);
    try {
      await expect(service().saveAnchor({ id: 17, name: 'Never committed', wechat: 'owned-anchor', phone: '13800000002', cover_img: '/never.jpg' }, actor))
        .rejects.toThrow(/配置已变化/u);
      expect(await snapshot()).toEqual(before); expect(await f.db.select().from(systemConfig).orderBy(systemConfig.id)).toEqual(config);
    } finally { await f.exec('DROP TRIGGER routine_owned_live_source_fault ON public.system_log; DROP FUNCTION public.routine_owned_live_source_fault()'); }
  });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 refuses live work while an independent owned backend holds the real routine maintenance gate', async () => {
    const input = await message('room'), before = await snapshot();
    await withFinancePeers(f.db, async ([owner]) => owner.db.transaction(async tx => {
      const [held] = await tx.execute<{ locked: boolean; pid: number }>(sql`SELECT pg_try_advisory_xact_lock(731666,0) AS locked,pg_backend_pid() AS pid`);
      expect(held).toEqual({ locked: true, pid: owner.pid });
      await expect(service().syncRooms(input)).rejects.toThrow(/正在维护/u);
    }));
    expect(await snapshot()).toEqual(before); expect(fetcher).not.toHaveBeenCalled(); expect(sent).toEqual([]);
    expect(await service().syncRooms(input)).toMatchObject({ updated: 1 });
  });
});
