import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { memberRight, storeBargain, storeProduct, storePromotions, systemAttachment, systemConfig,
  systemSupplier, systemUserLevel, user } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const value = wiring.context?.getStore(); if (!value) throw Error('Owned real App LOGIN context required'); return value;
} }));
const base = 191000, top = base + 20, password = md5('synthetic-member-level-recommendations');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0sAAAAASUVORK5CYII=', 'base64'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const modern = (page = 1) => `/api/product/hot?view=member_level&page=${page}&limit=10`;
const rows = (body: Row): Row[] => (body.data as Row).list as Row[];

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary membership hot recommendations real JWT/App LOGIN and RR readonly PG16', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>, tables: string[], sequences: string[], now: number;
  let fixtureOpen = false;
  const app = createApp(), tokens = new Map<number, string>();
  const writes = { put: vi.fn(), delete: vi.fn(), head: vi.fn(), list: vi.fn(), queue: vi.fn(), sequence: vi.fn() };
  const objects = new Map<string, Uint8Array>([['attachments/admin/1/member-hot.png', png], ['attachments/admin/1/member-frame.png', png], ['attachments/supplier/7/member-hot.png', png]]);
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key); if (!bytes) throw Error('Unexpected owned R2 key');
    return { body: bytes, size: bytes.length, etag: digest(bytes), httpEtag: '"' + digest(bytes) + '"',
      httpMetadata: { contentType: 'image/png' }, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
  });
  const resources = () => ({ writes: Object.fromEntries(Object.entries(writes).map(([key, fn]) => [key, fn.mock.calls.length])),
    gets: get.mock.calls.map(([key]) => key), objects: [...objects].map(([key, bytes]) => ({ key, bytes: bytes.length, sha256: digest(bytes) })) });
  beforeEach(async () => {
    fixtureOpen = false;
    f = await refundRuntimeFixture(); fixtureOpen = true; f.env.APP_KEY = crypto.randomUUID() + crypto.randomUUID(); now = Math.floor(Date.now() / 1000);
    wiring.context = new AsyncLocalStorage<Container>();
    await f.db.update(user).set({ pwd: password, status: 1, isDel: 0, level: 0, levelStatus: 0, isMoneyLevel: 0, isEverLevel: 0, overdueTime: 0 }).where(inArray(user.uid, [11, 22]));
    // refundRuntimeFixture intentionally exposes only the complete owned DB
    // and explicit peers, not its internal quote helper's setConfig method.
    for (const key of ['member_func_status', 'member_card_status', 'svip_price_status']) {
      const changed = await f.db.update(systemConfig).set({ value: '1' })
        .where(and(eq(systemConfig.menuName, key), eq(systemConfig.isStore, 0))).returning({ id: systemConfig.id });
      expect(changed.length, key + ' actual installed candidates').toBeGreaterThan(0);
    }
    await f.db.update(memberRight).set({ status: 1, number: 1 }).where(eq(memberRight.rightType, 'vip_price'));
    await f.db.insert(storeProduct).values(Array.from({ length: 21 }, (_, i) => ({ id: base + i, storeName: `会员热门${i}`, image: '/api/assets/' + (base + 1),
      price: '12.30', vipPrice: '9.90', isVip: 1, stock: 5, isHot: 1, isShow: 1, isVerify: 1, sort: 1234, activity: '0,1,2,3' })));
    await f.db.insert(storePromotions).values({ id: base, promotionsType: 5, productPartakeType: 1, name: '会员推荐边框', image: '/api/assets/' + (base + 2),
      startTime: now - 86400, stopTime: now + 86400, updateTime: now });
    await f.db.insert(systemAttachment).values([
      { attId: base + 1, name: 'attachments/admin/1/member-hot.png', type: 1, relationId: 0 },
      { attId: base + 2, name: 'attachments/admin/1/member-frame.png', type: 1, relationId: 0 },
      { attId: base + 3, name: 'attachments/supplier/7/member-hot.png', type: 4, relationId: 7 },
      { attId: base + 4, name: 'attachments/supplier/8/foreign.png', type: 4, relationId: 8 },
      { attId: base + 5, name: 'attachments/admin/1/bad.png', type: 1, relationId: 0, attType: 'image/jpeg' },
      { attId: base + 6, name: 'attachments/user/11/private.png', type: 3, relationId: 11, moduleType: 3 },
      { attId: base + 7, name: 'attachments/admin/0/bad.png', type: 1, relationId: 0 },
    ].map(row => ({ ...row, attDir: '/api/assets/' + row.attId, imageType: 8, moduleType: row.moduleType ?? 1, fileType: 1, attType: row.attType ?? 'image/png' })));
    await f.db.insert(systemUserLevel).values({ id: base, name: '普通等级九折', isShow: 1, discount: '90.00', grade: 1 });
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const uid of [11, 22]) tokens.set(uid, (await createToken(uid, 'api', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    for (const fn of Object.values(writes)) fn.mockReset().mockImplementation(() => { throw Error('Read-only recommendations may not write external resources'); });
    get.mockClear();
  });
  afterEach(async () => {
    try {
      if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled();
      for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled();
    } finally {
      wiring.context = undefined; tokens.clear(); vi.restoreAllMocks();
      if (fixtureOpen) { fixtureOpen = false; await f.close(); }
    }
  }, 30000);
  type Peer = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (role: infer T) => unknown ? T : never;
  async function profile(run: (env: Env, application: Peer) => Promise<void>) {
    await f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS name');
      const names = { app: application.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(application.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      const env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', HYPERDRIVE: { connectionString: application.connectionString },
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString }, ASSETS_BUCKET: { ...writes, get },
        CONFIG_KV: { get: writes.head, put: writes.put, delete: writes.delete, list: writes.list },
        ORDER_QUEUE: { send: writes.queue, sendBatch: writes.queue }, SEQUENCE: { idFromName: writes.sequence, get: writes.sequence } } as unknown as Env;
      Object.assign(env, { NODE_ENV: 'test' }); await run(env, application);
    }));
  }
  async function snapshot(): Promise<DiyStateSnapshot> {
    const state: DiyStateSnapshot = {};
    for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,
      COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
    state.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,
      is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
    return sortedDiyState(state);
  }
  async function request(env: Env, db: DbClient, path = modern(), uid: number | null = 11, token?: string) {
    const headers = new Headers({ 'Form-type': 'h5' }); if (uid !== null) headers.set('Authori-zation', 'Bearer ' + (token ?? tokens.get(uid)));
    const response = await wiring.context!.run(createContainerFromDb(db), () => app.fetch(new Request('https://owned.local' + path, { headers }), env,
      { waitUntil: () => { throw Error('Recommendations may not queue asynchronous work'); }, passThroughOnException: () => {} } as never));
    return { response, body: await response.json() as Row };
  }
  async function readonly<T>(run: () => Promise<T>) {
    const before = await snapshot(), io = resources(), result = await run();
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(io); return result;
  }
  function ticket(value: unknown, id: number) {
    expect(typeof value).toBe('string'); const url = new URL(String(value), 'https://owned.local');
    expect(url.pathname).toBe('/api/assets/' + id); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    const expires = Number(url.searchParams.get('expires')); expect(expires).toBe(now + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update(`GET\n/api/assets/${id}\n${expires}`).digest('base64url'));
  }
  it('keeps the complete legacy row and exact page/price/frame/navigation values while opting into owner-bound media', async () => {
    await profile(async (env, peer) => readonly(async () => {
      const original = await request(env, peer.db, '/api/product/hot?page=1&limit=10');
      const result = await request(env, peer.db); expect(result.response.status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(result.body.status).toBe(200); expect(Object.keys(result.body.data as Row).sort()).toEqual(['limit', 'list', 'owner_uid', 'page']);
      expect(result.body.data).toMatchObject({ owner_uid: 11, page: 1, limit: 10 });
      expect(rows(result.body).map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => top - i));
      const normalized = rows(result.body).map(row => { ticket(row.image, base + 1); expect(row.image_source).toBe('/api/assets/' + (base + 1));
        const frame = row.activity_frame as Row; ticket(frame.image, base + 2); expect(frame.image_source).toBe('/api/assets/' + (base + 2));
        const { image_source: _source, ...rest } = row, { image_source: _frameSource, ...frameRest } = frame;
        return { ...rest, image: row.image_source, activity_frame: { ...frameRest, image: frame.image_source } };
      });
      expect(normalized).toEqual(original.body.data);
      expect(rows(result.body)[0]).toMatchObject({ price: '12.30', is_vip: 1, vip_price: '9.90', price_type: 'member',
        recommendation_target: { version: 1, product_id: top, kind: 'product', id: top, ends_at: null } });
    }));
  });
  it('preserves offset pages10/10/1/0 and binds both real API owners without trusting query UID', async () => {
    await profile(async (env, peer) => readonly(async () => {
      for (const uid of [11, 22]) {
        const pages = [];
        for (const page of [1, 2, 3, 4, 10000]) { const result = await request(env, peer.db, modern(page), uid); expect(result.body.status).toBe(200);
          expect(result.body.data).toMatchObject({ owner_uid: uid, page, limit: 10 }); pages.push(rows(result.body)); }
        expect(pages.map(page => page.length)).toEqual([10, 10, 1, 0, 0]);
        expect(pages.slice(0, 3).flat().map(row => row.id)).toEqual(Array.from({ length: 21 }, (_, i) => top - i));
      }
      expect((await request(env, peer.db, modern() + '&uid=22')).body.status).toBe(400);
    }));
  });
  it.each(['view=member_level&view=member_level','view=','view=other','view=member_level&page=01','view=member_level&page=0',
    'view=member_level&page=10001','view=member_level&page=1.5','view=member_level&page=1&page=2','view=member_level&limit=20',
    'view=member_level&limit=10&limit=10','view=member_level&keyword=x','view=member_level&overview=1'])('rejects exact invalid modern query %s without any business/resource mutation', async query => {
    await profile(async (env, peer) => readonly(async () => { const result = await request(env, peer.db, '/api/product/hot?' + query);
      expect(result.response.status).toBe(200); expect(result.body.status).toBe(400); expect(result.response.headers.get('Cache-Control')).toBe('private, no-store'); }));
  });
  it('requires actual API JWT/account authority while leaving anonymous legacy hot access available', async () => {
    await profile(async (env, peer) => {
      const wrongType = (await createToken(11, 'admin', md5(password), f.env.APP_KEY)).token;
      await readonly(async () => { for (const [uid, token] of [[null, undefined], [11, 'invalid'], [11, wrongType]] as const) {
        const result = await request(env, peer.db, modern(), uid, token); expect(result.body.status).toBe(410000); }
        expect((await request(env, peer.db, '/api/product/hot', null)).body.status).toBe(200); });
      await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
      try { await readonly(async () => expect((await request(env, peer.db)).body.status).toBe(410000)); }
      finally { await f.db.update(user).set({ status: 1 }).where(eq(user.uid, 11)); }
      await f.db.update(user).set({ pwd: 'changed-synthetic-password' }).where(eq(user.uid, 11));
      try { await readonly(async () => expect((await request(env, peer.db)).body.status).toBe(410000)); }
      finally { await f.db.update(user).set({ pwd: password }).where(eq(user.uid, 11)); }
    });
  });
  it('refuses foreign/private/contradictory main and frame assets without losing the valid product/offer', async () => {
    await profile(async (env, peer) => {
      for (const image of ['/api/assets/' + (base + 4), '/api/assets/' + (base + 5), '/api/assets/' + (base + 6), '/api/assets/' + (base + 7), '/api/assets/2147483000', 'javascript:alert(1)']) {
        await f.db.update(storeProduct).set({ image }).where(eq(storeProduct.id, top));
        await f.db.update(storePromotions).set({ image }).where(eq(storePromotions.id, base));
        try { await readonly(async () => { const row = rows((await request(env, peer.db)).body)[0]!; expect(row).toMatchObject({ id: top, price: '12.30', image: '', image_source: '' });
          expect(row.activity_frame).toEqual({ id: base, name: '会员推荐边框', image: '', image_source: '' }); }); }
        finally { await f.db.update(storeProduct).set({ image: '/api/assets/' + (base + 1) }).where(eq(storeProduct.id, top));
          await f.db.update(storePromotions).set({ image: '/api/assets/' + (base + 2) }).where(eq(storePromotions.id, base)); }
      }
    });
  });
  it('uses the real persisted supplier tuple and never authorizes a frame through that supplier', async () => {
    await profile(async (env, peer) => {
      await f.db.update(storeProduct).set({ type: 2, relationId: 7, image: '/api/assets/' + (base + 3) }).where(eq(storeProduct.id, top));
      await f.db.update(storePromotions).set({ image: '/api/assets/' + (base + 3) }).where(eq(storePromotions.id, base));
      try { await readonly(async () => { const row = rows((await request(env, peer.db)).body)[0]!; ticket(row.image, base + 3);
        expect(row.image_source).toBe('/api/assets/' + (base + 3)); expect(row.activity_frame).toMatchObject({ image: '', image_source: '' }); });
        await f.db.update(systemSupplier).set({ isShow: 0 }).where(eq(systemSupplier.id, 7));
        await readonly(async () => expect(rows((await request(env, peer.db)).body).some(row => row.id === top)).toBe(false));
      } finally { await f.db.update(systemSupplier).set({ isShow: 1 }).where(eq(systemSupplier.id, 7));
        await f.db.update(storeProduct).set({ type: 0, relationId: 0, image: '/api/assets/' + (base + 1) }).where(eq(storeProduct.id, top));
        await f.db.update(storePromotions).set({ image: '/api/assets/' + (base + 2) }).where(eq(storePromotions.id, base)); }
    });
  });
  it('retains exact account level price policy and excludes later hidden/nonhot/deleted/unverified products', async () => {
    await profile(async (env, peer) => {
      await f.db.update(user).set({ level: base, levelStatus: 1 }).where(eq(user.uid, 11));
      try { await readonly(async () => { const result = await request(env, peer.db); expect(rows(result.body)[0]).toMatchObject({ price: '12.30', vip_price: '9.90', price_type: 'member' }); });
        await f.db.update(memberRight).set({ status: 0 }).where(eq(memberRight.rightType, 'vip_price'));
        await readonly(async () => { const row = rows((await request(env, peer.db)).body)[0]!; expect(row).toMatchObject({ price: '12.30', vip_price: '11.07', price_type: 'level', level_name: '普通等级九折' }); });
      } finally { await f.db.update(memberRight).set({ status: 1 }).where(eq(memberRight.rightType, 'vip_price'));
        await f.db.update(user).set({ level: 0, levelStatus: 0 }).where(eq(user.uid, 11)); }
      for (const update of [{ isHot: 0 }, { isShow: 0 }, { isDel: 1 }, { isVerify: 0 }]) {
        await f.db.update(storeProduct).set(update).where(eq(storeProduct.id, top));
        try { await readonly(async () => expect(rows((await request(env, peer.db)).body).some(row => row.id === top)).toBe(false)); }
        finally { await f.db.update(storeProduct).set({ isHot: 1, isShow: 1, isDel: 0, isVerify: 1 }).where(eq(storeProduct.id, top)); }
      }
    });
  });
  it('uses actual activity IDs and excludes foreign-owner activity associations only in the strict modern target', async () => {
    await profile(async (env, peer) => {
      await f.db.update(storeProduct).set({ activity: '2,0' }).where(eq(storeProduct.id, top));
      await f.db.insert(storeBargain).values({ id: base, productId: top, type: 0, relationId: 0, status: 1, isDel: 0,
        startTime: new Date((now - 3600) * 1000), stopTime: new Date((now + 3600) * 1000) });
      try { await readonly(async () => expect(rows((await request(env, peer.db)).body)[0]?.recommendation_target).toMatchObject({ kind: 'bargain', id: base, product_id: top }));
        await f.db.update(storeBargain).set({ type: 2, relationId: 7 }).where(eq(storeBargain.id, base));
        await readonly(async () => { expect(rows((await request(env, peer.db)).body)[0]?.recommendation_target).toMatchObject({ kind: 'product', id: top });
          expect(((await request(env, peer.db, '/api/product/hot')).body.data as Row[])[0]?.recommendation_target).toMatchObject({ kind: 'bargain', id: base }); });
      } finally { await f.db.delete(storeBargain).where(eq(storeBargain.id, base)); await f.db.update(storeProduct).set({ activity: '0,1,2,3' }).where(eq(storeProduct.id, top)); }
    });
  });
  it('delivers both signed preview objects from actual R2 bytes and rejects altered signatures without any mutation', async () => {
    await profile(async (env, peer) => {
      const result = await readonly(() => request(env, peer.db)); const row = rows(result.body)[0]!, frame = row.activity_frame as Row;
      const before = await snapshot(), prior = resources();
      for (const image of [row.image, frame.image]) {
        const response = await wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request('https://owned.local' + image), env,
          { waitUntil: () => {}, passThroughOnException: () => {} } as never));
        expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png'); expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(png));
      }
      expect(await snapshot()).toEqual(before); expect(resources()).toEqual({ ...prior, gets: ['attachments/admin/1/member-hot.png', 'attachments/admin/1/member-frame.png'] });
      const bad = String(row.image).replace('signature=', 'signature=bad');
      const response = await wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request('https://owned.local' + bad), env,
        { waitUntil: () => {}, passThroughOnException: () => {} } as never));
      expect(response.status).toBe(404); expect(await snapshot()).toEqual(before); expect(get).toHaveBeenCalledTimes(2);
    });
  });
  it('uses one readonly repeatable snapshot across observed catalogue wait and concurrent attachment/config retirement', async () => {
    await profile(async (env, peer) => {
      const before = await snapshot(), io = resources();
      await f.withPeer!(async holder => {
        let release!: () => void, acquired!: () => void;
        const gate = new Promise<void>(yes => release = yes), ready = new Promise<void>(yes => acquired = yes);
        const lock = holder.db.transaction(async tx => { await tx.execute(sql`LOCK TABLE store_product IN ACCESS EXCLUSIVE MODE`); acquired(); await gate; });
        await ready; const pending = request(env, peer.db);
        try {
          const end = performance.now() + 1500; let blocked = false;
          do { const [state] = await f.db.execute<{ blockers: number[]; query: string }>(sql`SELECT pg_blocking_pids(${peer.pid}) AS blockers,query FROM pg_stat_activity WHERE pid=${peer.pid}`);
            if (state?.blockers.includes(holder.pid) && /store_product/.test(state.query)) { blocked = true; break; } await delay(20);
          } while (performance.now() < end);
          expect(blocked, 'Actual App catalogue query must wait after its account snapshot').toBe(true);
          await f.db.update(systemAttachment).set({ attType: 'image/jpeg' }).where(eq(systemAttachment.attId, base + 1));
          await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'svip_price_status'));
        } finally { release(); await lock; }
        try {
          const result = await pending; expect(result.body.status).toBe(200); ticket(rows(result.body)[0]?.image, base + 1);
          expect(rows(result.body)[0]).toMatchObject({ vip_price: '9.90', image_source: '/api/assets/' + (base + 1) });
          const expected = structuredClone(before);
          expected.system_attachment.find(row => row.att_id === base + 1)!.att_type = 'image/jpeg'.padEnd(30, ' ');
          for (const row of expected.system_config.filter(row => row.menu_name === 'svip_price_status')) row.value = '0';
          expect(await snapshot()).toEqual(sortedDiyState(expected)); expect(resources()).toEqual(io);
          await readonly(async () => expect(rows((await request(env, peer.db)).body)[0]).toMatchObject({ vip_price: '0', image: '', image_source: '' }));
        } finally { await f.db.update(systemAttachment).set({ attType: 'image/png' }).where(eq(systemAttachment.attId, base + 1));
          await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'svip_price_status')); }
      });
    });
  }, 30000);
});
