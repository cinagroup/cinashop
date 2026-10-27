import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { user, userBrokerage, userSpread, systemAttachment, systemConfig } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { DistributionRankingsService } from '@/services/user/DistributionRankingsService';
import { financeRankPeriod } from '@/services/user/UserFinanceReadService';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const value = wiring.context?.getStore(); if (!value) throw Error('Owned real App LOGIN context required'); return value;
} }));
const base = 192000, first = base + 24, password = md5('synthetic-distribution-ranking');
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0sAAAAASUVORK5CYII=', 'base64'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const modern = (kind: 'promoter' | 'commission' = 'promoter', page = 1, type = 'week') =>
  `/api/${kind === 'promoter' ? 'rank' : 'brokerage_rank'}?view=leaderboard&type=${type}&page=${page}&limit=20`;
const payload = (body: Row) => body.data as Row;
const rows = (body: Row) => payload(body).list as Row[];

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('distribution leaderboards real API JWT/App LOGIN and readonly PG16', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>, tables: string[], sequences: string[], now: number, fixtureOpen = false;
  let activeProfile: Promise<void> | undefined;
  const app = createApp(), tokens = new Map<number, string>();
  const writes = { put: vi.fn(), delete: vi.fn(), head: vi.fn(), list: vi.fn(), queue: vi.fn(), sequence: vi.fn() };
  const objects = new Map<string, Uint8Array>([['attachments/user/11/rank.png', png], ['attachments/admin/1/rank-default.png', png]]);
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key); if (!bytes) throw Error('Unexpected owned R2 key');
    return { body: bytes, size: bytes.length, etag: digest(bytes), httpEtag: '"' + digest(bytes) + '"',
      httpMetadata: { contentType: 'image/png' }, writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
  });
  const resources = () => ({ writes: Object.fromEntries(Object.entries(writes).map(([key, fn]) => [key, fn.mock.calls.length])),
    gets: get.mock.calls.map(([key]) => key), objects: [...objects].map(([key, bytes]) => ({ key, bytes: bytes.length, sha256: digest(bytes) })) });
  beforeEach(async () => {
    fixtureOpen = false; f = await refundRuntimeFixture(); fixtureOpen = true;
    f.env.APP_KEY = crypto.randomUUID() + crypto.randomUUID(); now = Math.floor(Date.now() / 1000);
    wiring.context = new AsyncLocalStorage<Container>();
    await f.db.delete(userSpread); await f.db.delete(userBrokerage);
    await f.db.update(user).set({ pwd: password, nickname: '本人排行', avatar: '/api/assets/' + base, status: 1, isDel: 0 }).where(eq(user.uid, 11));
    await f.db.update(user).set({ pwd: password, nickname: '未入榜账号', avatar: '', status: 1, isDel: 0 }).where(eq(user.uid, 22));
    await f.db.insert(user).values(Array.from({ length: 24 }, (_, i) => ({ uid: base + i + 1, nickname: `真实榜单${i + 1}`, avatar: '', status: 1 })));
    await f.db.insert(user).values([{ uid: base + 30, status: 0 }, { uid: base + 31, isDel: 1 },
      { uid: base + 32, deleteTime: new Date(now * 1000) }]);
    await f.db.insert(userSpread).values([11, ...Array.from({ length: 24 }, (_, i) => base + i + 1)]
      .flatMap(uid => Array.from({ length: uid === 11 ? 1 : 2 }, (_, i) => ({ uid: 500000 + uid + i, spreadUid: uid, spreadTime: now - 1 }))));
    await f.db.insert(userBrokerage).values([11, ...Array.from({ length: 24 }, (_, i) => base + i + 1)]
      .map(uid => ({ uid, linkId: `rank-${uid}`, pm: 1, type: 'one_brokerage', number: uid === 11 ? '0.10' : '10.00', addTime: now - 1 })));
    await f.db.insert(userBrokerage).values([{ uid: first, linkId: 'rank-large-1', pm: 1, type: 'two_brokerage', number: '9999999999.99', addTime: now - 1 },
      { uid: first, linkId: 'rank-large-2', pm: 1, type: 'two_brokerage', number: '9999999999.99', addTime: now - 1 }]);
    for (const uid of [base + 30, base + 31, base + 32, base + 33]) {
      await f.db.insert(userSpread).values(Array.from({ length: 3 }, (_, i) => ({ uid: uid + i, spreadUid: uid, spreadTime: now - 1 })));
      await f.db.insert(userBrokerage).values({ uid, linkId: `excluded-${uid}`, pm: 1, type: 'one_brokerage', number: '999.00', addTime: now - 1 });
    }
    await f.db.insert(systemAttachment).values([
      { attId: base, name: 'attachments/user/11/rank.png', type: 3, relationId: 11, moduleType: 3 },
      { attId: base + 1, name: 'attachments/admin/1/rank-default.png', type: 1, relationId: 0, moduleType: 1 },
      { attId: base + 2, name: 'attachments/user/22/private.png', type: 3, relationId: 22, moduleType: 3 },
      { attId: base + 3, name: 'attachments/supplier/7/rank.png', type: 4, relationId: 7, moduleType: 1 },
      { attId: base + 4, name: 'attachments/user/11/mismatch.png', type: 3, relationId: 11, moduleType: 3, attType: 'image/jpeg' },
      { attId: base + 5, name: 'attachments/user/22/path.png', type: 3, relationId: 11, moduleType: 3 },
      { attId: base + 6, name: 'attachments/user/11/private.png', type: 3, relationId: 11, moduleType: 4 },
    ].map(row => ({ ...row, attDir: '/api/assets/' + row.attId, imageType: 8, fileType: 1, attType: row.attType ?? 'image/png' })));
    await f.db.insert(systemConfig).values({ menuName: 'h5_avatar', isStore: 0, sort: 999, value: JSON.stringify('/api/assets/' + (base + 1)) });
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const uid of [11, 22]) tokens.set(uid, (await createToken(uid, 'api', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    for (const fn of Object.values(writes)) fn.mockReset().mockImplementation(() => { throw Error('Readonly ranking may not use external resources'); });
    get.mockClear();
  });
  afterEach(async () => {
    try { await activeProfile; if (vi.isMockFunction(fetch)) expect(fetch).not.toHaveBeenCalled(); for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled(); }
    finally { wiring.context = undefined; tokens.clear(); vi.restoreAllMocks(); if (fixtureOpen) { fixtureOpen = false; await f.close(); } }
  }, 30000);
  type Peer = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (role: infer T) => unknown ? T : never;
  async function profile(run: (env: Env, application: Peer) => Promise<void>) {
    const running = f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
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
    activeProfile = running;
    try { await running; } finally { if (activeProfile === running) activeProfile = undefined; }
  }
  async function snapshot(): Promise<DiyStateSnapshot> {
    const state: DiyStateSnapshot = {};
    for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,
      COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
    state.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,
      is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
    return sortedDiyState(state);
  }
  async function readonly<T>(run: () => Promise<T>) {
    const before = await snapshot(), io = resources(), result = await run();
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(io); return result;
  }
  async function request(env: Env, db: DbClient, path = modern(), uid: number | null = 11, token?: string) {
    const headers = new Headers({ 'Form-type': 'h5' }); if (uid !== null) headers.set('Authori-zation', 'Bearer ' + (token ?? tokens.get(uid)));
    const response = await wiring.context!.run(createContainerFromDb(db), () => app.fetch(new Request('https://owned.local' + path, { headers }), env,
      { waitUntil: () => { throw Error('Rankings may not queue asynchronous work'); }, passThroughOnException: () => {} } as never));
    return { response, body: await response.json() as Row };
  }
  function ticket(value: unknown, id: number) {
    expect(typeof value).toBe('string'); const url = new URL(String(value), 'https://owned.local');
    expect(url.pathname).toBe('/api/assets/' + id); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    const expires = Number(url.searchParams.get('expires')); expect(expires).toBe(now + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update(`GET\n/api/assets/${id}\n${expires}`).digest('base64url'));
  }
  it('returns exact private DTOs, global positions, twenty-row pages and the current account beyond page one', async () => {
    await profile(async (env, peer) => readonly(async () => {
      for (const kind of ['promoter', 'commission'] as const) {
        const pages: Row[][] = [];
        for (const page of [1, 2, 3, 500]) {
          const result = await request(env, peer.db, modern(kind, page));
          expect(result.body.status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
          const data = payload(result.body); expect(Object.keys(data).sort()).toEqual(['kind','limit','list','owner_uid','page','self','type']);
          expect(data).toMatchObject({ owner_uid: 11, kind, type: 'week', page, limit: 20,
            self: { uid: 11, position: 25, value: kind === 'promoter' ? '1' : '0.10', nickname: '本人排行', avatar_source: '/api/assets/' + base } });
          ticket((data.self as Row).avatar, base); pages.push(rows(result.body));
          for (const row of [...rows(result.body), data.self as Row]) {
            expect(Object.keys(row).sort()).toEqual(['avatar','avatar_source','nickname','position','uid','value']);
            expect(row.value).toMatch(kind === 'promoter' ? /^\d+$/ : /^\d+\.\d{2}$/);
          }
        }
        expect(pages.map(page => page.length)).toEqual([20, 5, 0, 0]);
        const all = pages.flat(); expect(all.map(row => row.uid)).toEqual([...Array.from({ length: 24 }, (_, i) => first - i), 11]);
        expect(all.map(row => row.position)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
        if (kind === 'commission') expect(all[0]?.value).toBe('20000000009.98');
        else { expect(all[0]?.avatar_source).toBe('/api/assets/' + (base + 1)); ticket(all[0]?.avatar, base + 1); }
      }
    }));
  });
  it('keeps every legacy JSON field and leaves the default no-view response intact', async () => {
    await profile(async (env, peer) => readonly(async () => {
      const legacyEnv = { ...env, CONFIG_KV: { ...env.CONFIG_KV, get: async () => '/static/default-avatar.png' } } as unknown as Env;
      for (const kind of ['promoter', 'commission'] as const) {
        const path = `/api/${kind === 'promoter' ? 'rank' : 'brokerage_rank'}?type=week&page=1&limit=20`;
        const legacy = payload((await request(legacyEnv, peer.db, path)).body), modernData = payload((await request(env, peer.db, modern(kind))).body);
        expect(legacy).not.toHaveProperty('owner_uid'); expect(legacy).not.toHaveProperty('kind');
        if (kind === 'commission') {
          expect(Object.keys(legacy).sort()).toEqual(['avatar','brokerage_price','nickname','position','rank']);
          expect((legacy.rank as Row[]).map(row => [row.uid, row.brokerage_price])).toEqual((modernData.list as Row[]).map(row => [row.uid, row.value]));
          expect(legacy.position).toBe(25); expect(legacy.brokerage_price).toBe('0.10');
        } else {
          expect(Object.keys(legacy).sort()).toEqual(['avatar','end','list','month','nickname','rank','start','uid','week']);
          expect((legacy.list as Row[]).map(row => [row.spread_uid, String(row.count)])).toEqual((modernData.list as Row[]).map(row => [row.uid, row.value]));
          expect(legacy.rank).toBe(25);
        }
      }
    }));
  });
  it('separates Shanghai Monday/month boundaries and retains income exclusions and referral-event authority', async () => {
    const fixed = Date.parse('2026-10-27T04:30:00Z') / 1000, week = financeRankPeriod('week', fixed).start, month = financeRankPeriod('month', fixed).start;
    await f.db.delete(userSpread); await f.db.delete(userBrokerage);
    await f.db.insert(userSpread).values([{ uid: 22, spreadUid: 11, spreadTime: month }, { uid: 22, spreadUid: 11, spreadTime: week },
      { uid: 22, spreadUid: 11, spreadTime: week - 1 }, { uid: 22, spreadUid: 11, spreadTime: fixed },
      { uid: 22, spreadUid: 11, spreadTime: month - 1 }, { uid: 22, spreadUid: 11, spreadTime: fixed + 1 }]);
    await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
    await f.db.insert(userBrokerage).values([{ uid: 11, linkId: 'month', pm: 1, type: 'one_brokerage', number: '0.10', addTime: month },
      { uid: 11, linkId: 'week', pm: 1, type: 'one_brokerage', number: '0.20', addTime: week },
      { uid: 11, linkId: 'before-week', pm: 1, type: 'one_brokerage', number: '0.30', addTime: week - 1 },
      { uid: 11, linkId: 'now', pm: 1, type: 'one_brokerage', number: '0.40', addTime: fixed },
      { uid: 11, linkId: 'old', pm: 1, type: 'one_brokerage', number: '999.00', addTime: month - 1 },
      { uid: 11, linkId: 'future', pm: 1, type: 'one_brokerage', number: '999.00', addTime: fixed + 1 },
      { uid: 11, linkId: 'restoration', pm: 1, type: 'extract_fail', number: '999.00', addTime: week },
      { uid: 11, linkId: 'refund', pm: 1, type: 'refund', number: '999.00', addTime: week },
      { uid: 11, linkId: 'debit', pm: 0, type: 'one_brokerage', number: '999.00', addTime: week }]);
    await profile(async (env, peer) => readonly(async () => {
      const service = new DistributionRankingsService(createContainerFromDb(peer.db), env);
      for (const type of ['week', 'month'] as const) {
        expect((await service.read(11, 'promoter', { type, page: 1, limit: 20 }, fixed)).self).toMatchObject({ uid: 11, position: 1, value: type === 'week' ? '2' : '4' });
        expect((await service.read(11, 'commission', { type, page: 1, limit: 20 }, fixed)).self).toMatchObject({ uid: 11, position: 1, value: type === 'week' ? '0.60' : '1.00' });
      }
    }));
  });
  it('returns zero self values for a valid unranked owner and both empty reports without inventing a position', async () => {
    await f.db.insert(userBrokerage).values({ uid: 22, linkId: 'zero-income', pm: 1, type: 'one_brokerage', number: '0.00', addTime: now - 1 });
    await profile(async (env, peer) => {
      await readonly(async () => { for (const kind of ['promoter', 'commission'] as const) {
        expect(payload((await request(env, peer.db, modern(kind), 22)).body).self).toMatchObject({ uid: 22, position: 0, value: kind === 'promoter' ? '0' : '0.00' });
      } });
      await f.db.delete(userSpread); await f.db.delete(userBrokerage);
      await readonly(async () => { for (const kind of ['promoter', 'commission'] as const) {
        expect(payload((await request(env, peer.db, modern(kind))).body)).toMatchObject({ list: [], self: { position: 0, value: kind === 'promoter' ? '0' : '0.00' } });
      } });
    });
  });
  it('rejects unknown, duplicate, mixed and noncanonical modern queries while keeping both reports readonly', async () => {
    const invalid = ['view=leaderboard&view=leaderboard','view=','view=other','view=leaderboard&type=', 'view=leaderboard&type=year',
      'view=leaderboard&type=week&type=month','view=leaderboard&page=0','view=leaderboard&page=01','view=leaderboard&page=501',
      'view=leaderboard&page=1.5','view=leaderboard&page=1&page=2','view=leaderboard&limit=10','view=leaderboard&limit=20&limit=20',
      'view=leaderboard&limit=020','view=leaderboard&uid=22','view=leaderboard&keyword=x','view=leaderboard&start=0','view=leaderboard&kind=commission'];
    await profile(async (env, peer) => readonly(async () => {
      for (const query of invalid) for (const endpoint of ['rank','brokerage_rank']) {
        const result = await request(env, peer.db, '/api/' + endpoint + '?' + query);
        expect(result.body.status, endpoint + '?' + query).toBe(400); expect(result.response.headers.get('Cache-Control')).toBe('private, no-store');
      }
      expect(payload((await request(env, peer.db, '/api/rank?view=leaderboard')).body)).toMatchObject({ type: 'week', page: 1, limit: 20 });
    }));
  });
  it('requires actual live API JWT authority and rejects guest, expired, other-token and changed account credentials', async () => {
    await profile(async (env, peer) => {
      const expired = (await createToken(11, 'api', md5(password), env.APP_KEY, 'cinashop', now - 8 * 86400)).token;
      const other = (await createToken(11, 'admin', md5(password), env.APP_KEY)).token;
      await readonly(async () => { for (const kind of ['promoter','commission'] as const) for (const [uid, token, status] of [[null,undefined,410000],[11,'invalid',410001],[11,expired,410001],[11,other,410002]] as const) {
        expect((await request(env, peer.db, modern(kind), uid, token)).body.status).toBe(status);
      } });
      for (const [update, status] of [[{ status: 0 },410002],[{ isDel: 1 },410001],[{ deleteTime: new Date(now * 1000) },410001],[{ pwd: 'changed-ranking-password' },410001]] as const) {
        await f.db.update(user).set(update).where(eq(user.uid, 11));
        try { await readonly(async () => { for (const kind of ['promoter','commission'] as const) expect((await request(env, peer.db, modern(kind))).body.status).toBe(status); }); }
        finally { await f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null, pwd: password }).where(eq(user.uid, 11)); }
      }
    });
  });
  it('binds persisted avatar UID, exact MIME/module/path and grants only platform default images', async () => {
    await profile(async (env, peer) => {
      for (const avatar of ['/api/assets/' + (base + 2), '/api/assets/' + (base + 3), '/api/assets/' + (base + 4),
        '/api/assets/' + (base + 5), '/api/assets/' + (base + 6), '/api/assets/2147483647', 'javascript:alert(1)', '//evil.invalid/x',
        'https://user:secret@invalid.example/x.png', 'http://invalid.example/x.png', '/bad\\path.png']) {
        await f.db.update(user).set({ avatar }).where(eq(user.uid, 11));
        await readonly(async () => { for (const kind of ['promoter','commission'] as const) expect(payload((await request(env, peer.db, modern(kind))).body).self).toMatchObject({ avatar: '', avatar_source: '' }); });
      }
      await f.db.update(user).set({ avatar: '/api/assets/' + base }).where(eq(user.uid,11));
      for (const update of [{ attDir: '/api/assets/' + (base + 1) }, { fileType: 2 }, { imageType: 1 }]) {
        await f.db.update(systemAttachment).set(update).where(eq(systemAttachment.attId,base));
        try { await readonly(async () => expect(payload((await request(env,peer.db)).body).self).toMatchObject({ avatar: '', avatar_source: '' })); }
        finally { await f.db.update(systemAttachment).set({ attDir: '/api/assets/' + base, fileType: 1, imageType: 8 }).where(eq(systemAttachment.attId,base)); }
      }
      await f.db.update(user).set({ avatar: '' }).where(eq(user.uid, 11));
      for (const reference of ['/api/assets/' + base, '/api/assets/' + (base + 2), '/api/assets/' + (base + 3)]) {
        await f.db.update(systemConfig).set({ value: reference }).where(and(eq(systemConfig.menuName,'h5_avatar'),eq(systemConfig.sort,999)));
        await readonly(async () => { const data = payload((await request(env, peer.db)).body);
          for (const row of [...data.list as Row[], data.self as Row]) expect(row).toMatchObject({ avatar: '', avatar_source: '' }); });
      }
      for (const reference of ['/static/safe-rank.png', 'https://static.example.invalid/rank.png']) {
        await f.db.update(user).set({ avatar: reference }).where(eq(user.uid,11));
        await readonly(async () => expect(payload((await request(env, peer.db)).body).self).toMatchObject({ avatar_source: reference, avatar: reference }));
      }
    });
  }, 30000);
  it('serves actual authorized user/default R2 bytes and refuses forged preview signatures', async () => {
    await profile(async (env, peer) => {
      const data = payload((await readonly(() => request(env,peer.db))).body), before = await snapshot(), prior = resources();
      for (const record of [data.self as Row, (data.list as Row[])[0]!]) {
        const response = await wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request('https://owned.local' + record.avatar), env,
          { waitUntil: () => { throw Error('No async resources'); }, passThroughOnException: () => {} } as never));
        expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
        expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(png));
      }
      expect(await snapshot()).toEqual(before); expect(resources()).toEqual({ ...prior, gets: ['attachments/user/11/rank.png','attachments/admin/1/rank-default.png'] });
      const bad = String((data.self as Row).avatar).replace('signature=', 'signature=bad');
      const response = await wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request('https://owned.local' + bad), env,
        { waitUntil: () => {}, passThroughOnException: () => {} } as never));
      expect(response.status).toBe(404); expect(await snapshot()).toEqual(before); expect(get).toHaveBeenCalledTimes(2);
    });
  });
  it('keeps one repeatable snapshot through an observed ranking relation wait and concurrent avatar retirement', async () => {
    await profile(async (env, peer) => {
      const before = await snapshot(), io = resources();
      await f.withPeer!(async holder => {
        let release!: () => void, acquired!: () => void;
        const gate = new Promise<void>(yes => release = yes), ready = new Promise<void>(yes => acquired = yes);
        const lock = holder.db.transaction(async tx => { await tx.execute(sql`LOCK TABLE user_spread IN ACCESS EXCLUSIVE MODE`); acquired(); await gate; });
        await ready; const pending = request(env, peer.db);
        try {
          const end = performance.now() + 1500; let blocked = false;
          do { const [state] = await f.db.execute<{ blockers: number[]; query: string }>(sql`SELECT pg_blocking_pids(${peer.pid}) AS blockers,query FROM pg_stat_activity WHERE pid=${peer.pid}`);
            if (state?.blockers.includes(holder.pid) && /user_spread/.test(state.query)) { blocked = true; break; } await delay(20);
          } while (performance.now() < end);
          expect(blocked, 'Actual App ranking query must wait after its authenticated account snapshot').toBe(true);
          await f.db.update(systemAttachment).set({ attType: 'image/jpeg' }).where(eq(systemAttachment.attId, base));
          await f.db.update(systemConfig).set({ value: '/api/assets/' + base }).where(and(eq(systemConfig.menuName,'h5_avatar'),eq(systemConfig.sort,999)));
        } finally { release(); await lock; }
        const data = payload((await pending).body); expect(data.self).toMatchObject({ avatar_source: '/api/assets/' + base }); ticket((data.self as Row).avatar,base);
        expect((data.list as Row[])[0]).toMatchObject({ avatar_source: '/api/assets/' + (base + 1) });
        const expected = structuredClone(before); expected.system_attachment.find(row => row.att_id === base)!.att_type = 'image/jpeg'.padEnd(30,' ');
        expected.system_config.find(row => row.menu_name === 'h5_avatar' && row.sort === 999)!.value = '/api/assets/' + base;
        expect(await snapshot()).toEqual(sortedDiyState(expected)); expect(resources()).toEqual(io);
        await readonly(async () => { const latest = payload((await request(env,peer.db)).body);
          expect(latest.self).toMatchObject({ avatar: '', avatar_source: '' }); expect((latest.list as Row[])[0]).toMatchObject({ avatar: '', avatar_source: '' }); });
      });
    });
  }, 30000);
});
