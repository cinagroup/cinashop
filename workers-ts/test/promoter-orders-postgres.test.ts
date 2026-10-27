import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { user, userBrokerage, storeOrder, storeOrderCartInfo, storeProduct, userAddress, storeSeckill, storeBargain, storeCombination, systemAttachment } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const value = wiring.context?.getStore(); if (!value) throw Error('Owned real App LOGIN context required'); return value;
} }));
const base = 203000, password = md5('synthetic-promoter-orders');
const september = Date.parse('2026-08-31T16:00:00Z') / 1000, october = Date.parse('2026-09-30T16:00:00Z') / 1000;
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH0sAAAAASUVORK5CYII=', 'base64'));
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const modern = '/api/spread/order?view=promoter_orders';
const payload = (body: Row) => body.data as Row;
const rows = (body: Row) => payload(body).list as Row[];
const input = (extra: Row = {}) => ({ page: 1, limit: 10, start: 0, stop: 0, keyword: '', ...extra });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('promoter orders real API JWT/App LOGIN and readonly PG16', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>, tables: string[], sequences: string[], now: number, fixtureOpen = false;
  let activeProfile: Promise<void> | undefined;
  const app = createApp(), tokens = new Map<number, string>();
  const writes = { put: vi.fn(), delete: vi.fn(), head: vi.fn(), list: vi.fn(), queue: vi.fn(), sequence: vi.fn() };
  const objects = new Map<string, Uint8Array>([['attachments/user/22/orders.png', png]]);
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
    await f.db.delete(userBrokerage);
    await f.db.update(user).set({ pwd: password, nickname: '推广人', avatar: '', status: 1, isDel: 0 }).where(eq(user.uid, 11));
    await f.db.update(user).set({ pwd: password, nickname: '订单买家', avatar: '/api/assets/' + base, status: 1, isDel: 0 }).where(eq(user.uid, 22));
    await f.db.insert(storeOrder).values(Array.from({ length: 13 }, (_, index) => {
      const n = index + 1; return { id: base + n, unique: `promoter-base-${n}`, orderId: `PROMOTER-${n}`, uid: 22, paid: 1, spreadUid: 11,
        oneBrokerage: '1.01', payPrice: '10.10', addTime: n % 3 === 1 ? september : october,
        payTime: n === 1 ? now + 100 : now - 100 + n, status: n === 1 ? 2 : 0 };
    }));
    await f.db.insert(storeOrderCartInfo).values([' 甲 ', '', '乙'].map((store_name, index) => ({ unique: `snapshot-${index}`, oid: base + 1, uid: 22, productId: 70,
      cartInfo: JSON.stringify({ productInfo: { store_name } }) })));
    await f.db.insert(userBrokerage).values([
      { uid: 22, linkId: String(base + 1), pm: 1, type: 'one_brokerage', addTime: 1 },
      { uid: 11, linkId: String(base + 1), pm: 0, type: 'refund', status: 0, addTime: now - 60, frozenTime: now + 1 },
      { uid: 11, linkId: String(base + 1), pm: 1, type: 'one_brokerage', status: 1, addTime: 1, frozenTime: 0 },
    ]);
    await f.db.insert(systemAttachment).values([
      { attId: base, name: 'attachments/user/22/orders.png', type: 3, relationId: 22, moduleType: 3 },
      { attId: base + 1, name: 'attachments/user/11/private.png', type: 3, relationId: 11, moduleType: 3 },
      { attId: base + 2, name: 'attachments/supplier/7/orders.png', type: 4, relationId: 7, moduleType: 1 },
      { attId: base + 3, name: 'attachments/user/22/mismatch.png', type: 3, relationId: 22, moduleType: 3, attType: 'image/jpeg' },
      { attId: base + 4, name: 'attachments/user/11/path.png', type: 3, relationId: 22, moduleType: 3 },
      { attId: base + 5, name: 'attachments/user/22/module.png', type: 3, relationId: 22, moduleType: 4 },
    ].map(row => ({ ...row, attDir: '/api/assets/' + row.attId, imageType: 8, fileType: 1, attType: row.attType ?? 'image/png' })));
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283); for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const uid of [11, 22]) tokens.set(uid, (await createToken(uid, 'api', md5(password), f.env.APP_KEY)).token);
  }, 60000);
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    for (const fn of Object.values(writes)) fn.mockReset().mockImplementation(() => { throw Error('Readonly promoter-order query may not use external resources'); });
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
  async function request(env: Env, db: DbClient, body: unknown = input(), uid: number | null = 11, token?: string,
    path = modern, contentType = 'application/json') {
    const headers = new Headers({ 'Form-type': 'h5', 'Content-Type': contentType });
    if (uid !== null) headers.set('Authori-zation', 'Bearer ' + (token ?? tokens.get(uid)));
    const response = await wiring.context!.run(createContainerFromDb(db), () => app.fetch(new Request('https://owned.local' + path,
      { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), env,
      { waitUntil: () => { throw Error('Promoter orders may not queue asynchronous work'); }, passThroughOnException: () => {} } as never));
    return { response, body: await response.json() as Row };
  }
  function ticket(value: unknown, id: number) {
    expect(typeof value).toBe('string'); const url = new URL(String(value), 'https://owned.local');
    expect(url.pathname).toBe('/api/assets/' + id); expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'signature']);
    const expires = Number(url.searchParams.get('expires')); expect(expires).toBe(now + 900);
    expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update(`GET\n/api/assets/${id}\n${expires}`).digest('base64url'));
  }
  it('returns the exact projection, payment-ordered pages, first-seen months and full month totals without changing legacy fields', async () => {
    await profile(async (env, peer) => readonly(async () => {
      const first = await request(env, peer.db), second = await request(env, peer.db, input({ page: 2 }));
      expect(first.body.status).toBe(200); expect(first.response.headers.get('Cache-Control')).toBe('private, no-store');
      const data = payload(first.body); expect(Object.keys(data).sort()).toEqual(['count','list','months','owner_uid','query','sum_brokerage']);
      expect(data).toMatchObject({ owner_uid: 11, query: input(), count: 13, sum_brokerage: '13.13',
        months: [{ month: '2026-09', count: 5, pay_price: '50.50' }, { month: '2026-10', count: 8, pay_price: '80.80' }] });
      expect(rows(first.body).map(row => row.id)).toEqual([base + 1, ...Array.from({ length: 9 }, (_, i) => base + 13 - i)]);
      expect(rows(second.body).map(row => row.id)).toEqual([base + 4, base + 3, base + 2]);
      expect(payload(second.body)).toMatchObject({ count: 13, sum_brokerage: '13.13', months: data.months });
      for (const row of [...rows(first.body), ...rows(second.body)]) {
        expect(Object.keys(row).sort()).toEqual(['add_time','avatar','avatar_source','id','is_frozen','nickname','number','order_id','paid_at','store_name','time','time_key','type','uid']);
        expect(row.number).toMatch(/^-?\d+\.\d{2}$/); expect(row.avatar_source).toBe('/api/assets/' + base); ticket(row.avatar, base);
      }
      expect(rows(first.body)[0]).toMatchObject({ type: 'brokerage', is_frozen: 1, paid_at: now + 100, store_name: ' 甲 ||乙' });
      const expectedTime = new Date((now - 60 + 28800) * 1000).toISOString().slice(0,16).replace('T',' ');
      expect(rows(first.body)[0]?.time).toBe(expectedTime);
      expect(payload((await request(env, peer.db, {})).body).query).toEqual(input());
      expect(payload((await request(env, peer.db, input({ page: 1000 }))).body)).toMatchObject({ list: [], months: [], count: 13, sum_brokerage: '13.13' });
      const legacy = payload((await request(env, peer.db, { page: 1, limit: 10, uid: 22 }, 11, undefined, '/api/spread/order')).body);
      expect(Object.keys(legacy).sort()).toEqual(['count','list','sum_brokerage','time']);
      expect((legacy.list as Row[]).map(row => row.id)).toEqual(rows(first.body).map(row => row.id));
      expect((legacy.time as Row[]).map(month => month.time)).toEqual(['2026-09','2026-10']);
      expect((legacy.list as Row[])[0]).not.toHaveProperty('paid_at'); expect((legacy.list as Row[])[0]).not.toHaveProperty('pay_time');
      expect((legacy.list as Row[])[0]).not.toHaveProperty('__position');
    }));
  }, 20000);

  it('includes split children and refund status three while excluding roots, unpaid, other types, owners and deleted orders', async () => {
    await f.db.delete(storeOrder);
    await f.db.insert(storeOrder).values([
      { pid: 0 }, { pid: base + 1, refundStatus: 3 }, { pid: -1 }, { paid: 0 }, { type: 1 },
      { refundStatus: 1 }, { refundStatus: 2 }, { refundStatus: 4 }, { isDel: 1 }, { isSystemDel: 1 }, { spreadUid: 22 },
    ].map((extra, index) => ({ id: base + index + 1, unique: `visibility-${index}`, orderId: `VISIBILITY-${index}`, uid: 22, paid: 1, spreadUid: 11,
      oneBrokerage: '2.00', payPrice: '3.00', addTime: october, payTime: index, ...extra })));
    await profile(async (env, peer) => readonly(async () => {
      const data = payload((await request(env, peer.db)).body);
      expect(data).toMatchObject({ count: 2, sum_brokerage: '4.00', months: [{ month: '2026-10', count: 2, pay_price: '6.00' }] });
      expect((data.list as Row[]).map(row => row.id)).toEqual([base + 2, base + 1]);
    }));
  });

  it('keeps five-role row precedence, keyword-independent additive totals and exact signed money beyond a row precision', async () => {
    await f.db.delete(storeOrder);
    await f.db.insert(storeOrder).values([
      { orderId: 'OVERLAP', spreadUid: 11, spreadTwoUid: 11, divisionId: 11, divisionAgentId: 11, divisionStaffId: 11,
        oneBrokerage: '1.01', twoBrokerage: '2.02', divisionBrokerage: '3.03', divisionAgentBrokerage: '4.04', divisionStaffBrokerage: '5.05', payPrice: '1.00' },
      { orderId: 'NEGATIVE', spreadTwoUid: 11, twoBrokerage: '-0.25', payPrice: '-0.50' },
      { orderId: 'LARGE-1', spreadUid: 11, oneBrokerage: '9999999999.99', payPrice: '9999999999.99' },
      { orderId: 'LARGE-2', spreadUid: 11, oneBrokerage: '9999999999.99', payPrice: '9999999999.99' },
      { orderId: 'DIVISION', divisionId: 11, divisionBrokerage: '0.10', payPrice: '0.10' },
      { orderId: 'AGENT', divisionAgentId: 11, divisionAgentBrokerage: '0.20', payPrice: '0.20' },
      { orderId: 'STAFF', divisionStaffId: 11, divisionStaffBrokerage: '0.30', payPrice: '0.30' },
    ].map((extra, index) => ({ id: base + index + 1, unique: `money-${index}`, uid: 22, paid: 1, addTime: october, ...extra })));
    await profile(async (env, peer) => readonly(async () => {
      const all = payload((await request(env,peer.db)).body); expect(all.sum_brokerage).toBe('20000000015.48');
      expect((all.months as Row[])[0]?.pay_price).toBe('20000000001.08');
      const selected = payload((await request(env,peer.db,input({ keyword: 'OVERLAP' }))).body);
      expect(selected).toMatchObject({ count: 1, sum_brokerage: all.sum_brokerage, list: [{ number: '5.05' }] });
      expect(payload((await request(env,peer.db,input({ keyword: 'NEGATIVE' }))).body)).toMatchObject({ count: 1, sum_brokerage: all.sum_brokerage, list: [{ number: '-0.25' }] });
      expect(payload((await request(env,peer.db,input({ keyword: 'missing-query' }))).body)).toMatchObject({ count: 0, list: [], months: [], sum_brokerage: all.sum_brokerage });
    }));
  });

  it('searches actual buyer, address, current product and all activity sources while displaying purchase snapshots and never exposing contacts', async () => {
    await f.db.update(user).set({ nickname: '唯一买家昵称', phone: '13800138099' }).where(eq(user.uid,22));
    await f.db.update(storeOrder).set({ realName: '唯一收件人', userPhone: '13900139099', activityId: base + 70 }).where(eq(storeOrder.id,base + 1));
    await f.db.insert(userAddress).values({ uid: 22, realName: '唯一地址收件人', phone: '13700137099' });
    await f.db.update(storeProduct).set({ storeName: '唯一当前商品', keyword: '唯一商品标签' }).where(eq(storeProduct.id,70));
    await f.db.insert(storeSeckill).values({ id: base + 70, storeName: '唯一秒杀标题', info: '唯一秒杀说明' });
    await f.db.insert(storeBargain).values({ id: base + 70, title: '唯一砍价标题', info: '唯一砍价说明' });
    await f.db.insert(storeCombination).values({ id: base + 70, storeName: '唯一拼团标题', info: '唯一拼团说明' });
    await profile(async (env, peer) => readonly(async () => {
      for (const keyword of ['PROMOTER-1', '唯一收件人', '13900139099', '唯一当前商品', '唯一商品标签', '唯一秒杀标题', '唯一秒杀说明',
        '唯一砍价标题', '唯一砍价说明', '唯一拼团标题', '唯一拼团说明']) {
        const data = payload((await request(env,peer.db,input({ keyword }))).body);
        expect(data.count,keyword).toBe(keyword === 'PROMOTER-1' ? 5 : 1); expect(data.sum_brokerage).toBe('13.13');
        for (const row of data.list as Row[]) { expect(row).not.toHaveProperty('real_name'); expect(row).not.toHaveProperty('user_phone'); expect(row).not.toHaveProperty('user_address'); }
      }
      for (const keyword of ['唯一买家昵称', '13800138099', '22', '唯一地址收件人', '13700137099']) expect(payload((await request(env,peer.db,input({ keyword }))).body).count,keyword).toBe(13);
      for (const keyword of [' 甲 ', '%', '_', "%' OR true --"]) expect(payload((await request(env,peer.db,input({ keyword }))).body).count,keyword).toBe(0);
      expect(rows((await request(env,peer.db,input({ keyword: '唯一当前商品' }))).body)[0]?.store_name).toBe(' 甲 ||乙');
    }));
  }, 20000);

  it('uses inclusive Shanghai complete-day filters and preserves empty month keys for zero creation time', async () => {
    await f.db.delete(storeOrder);
    await f.db.insert(storeOrder).values([october - 1, october, october + 86399, october + 86400, 0]
      .map((addTime, index) => ({ id: base + index + 1, unique: `boundary-${index}`, orderId: `BOUNDARY-${index}`, uid: 22, paid: 1, spreadUid: 11,
        oneBrokerage: '0.10', payPrice: '0.20', addTime, payTime: index })));
    await profile(async (env,peer) => readonly(async () => {
      const data = payload((await request(env,peer.db,input({ start: october, stop: october + 86399 }))).body);
      expect(data).toMatchObject({ count: 2, sum_brokerage: '0.20', months: [{ month: '2026-10', count: 2, pay_price: '0.40' }] });
      expect((data.list as Row[]).map(row => row.id)).toEqual([base + 3, base + 2]);
      const all = payload((await request(env,peer.db)).body); expect((all.list as Row[])[0]).toMatchObject({ add_time: 0, time_key: '', time: '' });
      expect((all.months as Row[])[0]).toEqual({ month: '', count: 1, pay_price: '0.20' });
    }));
  });

  it('rejects duplicate JSON keys, invalid scalars, unknown fields, partial days, excess keywords and ambiguous URL controls', async () => {
    const invalid: unknown[] = [null, [], 1, 'null', '{', '{"page":1,"page":2}', '{"page":1,"pa\\u0067e":2}',
      { page: '1' }, { page: 0 }, { page: 1001 }, { page: 1.5 }, { limit: 20 }, { limit: '10' }, { uid: 22 }, { start: october },
      { start: october, stop: october + 86400 }, { start: october + 1, stop: october + 86399 }, { start: october + 86400, stop: october + 86399 },
      { start: 2147483648, stop: 2147483648 }, { start: -1 }, { keyword: 1 }, { keyword: '字'.repeat(65) }, { keyword: '\u0000' },
      { keyword: '\ud800' }, { keyword: 'x'.repeat(4097) }, '{"page":-0}' ];
    await profile(async (env,peer) => readonly(async () => {
      for (const body of invalid) { const result = await request(env,peer.db,body); expect(result.body.status, JSON.stringify(body)).toBe(400);
        expect(result.response.headers.get('Cache-Control')).toBe('private, no-store'); }
      for (const query of ['view=', 'view=other', 'view=promoter_orders&view=promoter_orders', 'view=promoter_orders&page=1', 'view=promoter_orders&uid=22', 'view=promoter_orders&limit=10']) {
        expect((await request(env,peer.db,input(),11,undefined,'/api/spread/order?' + query)).body.status,query).toBe(400);
      }
      expect((await request(env,peer.db,input(),11,undefined,modern,'text/plain')).body.status).toBe(400);
      expect(payload((await request(env,peer.db,input({ keyword: '😀'.repeat(64) }))).body).query).toEqual(input({ keyword: '😀'.repeat(64) }));
      expect(payload((await request(env,peer.db,input({ keyword: '  PROMOTER-2  ' }))).body).query).toEqual(input({ keyword: 'PROMOTER-2' }));
    }));
  }, 20000);

  it('requires live API JWT authority, rejecting guests, expired or wrong-token types and changed account credentials', async () => {
    await profile(async (env,peer) => {
      const expired = (await createToken(11,'api',md5(password),env.APP_KEY,'cinashop',now - 8 * 86400)).token;
      const other = (await createToken(11,'admin',md5(password),env.APP_KEY)).token;
      await readonly(async () => { for (const [uid, token, status] of [[null,undefined,410000],[11,'invalid',410001],[11,expired,410001],[11,other,410002]] as const)
        expect((await request(env,peer.db,input(),uid,token)).body.status).toBe(status); });
      for (const [update,status] of [[{ status: 0 },410002],[{ isDel: 1 },410001],[{ deleteTime: new Date(now * 1000) },410001],[{ pwd: 'changed-order-password' },410001]] as const) {
        await f.db.update(user).set(update).where(eq(user.uid,11));
        try { await readonly(async () => expect((await request(env,peer.db)).body.status).toBe(status)); }
        finally { await f.db.update(user).set({ status: 1, isDel: 0, deleteTime: null, pwd: password }).where(eq(user.uid,11)); }
      }
      await readonly(async () => { const peerData=payload((await request(env,peer.db,input(),22)).body); expect(peerData).toMatchObject({ owner_uid:22,count:0,list:[],months:[],sum_brokerage:'0.00' }); });
    });
  }, 20000);

  it('authorizes buyer avatars by persisted UID, MIME, module and path and retains orders without deleted buyer identity', async () => {
    await profile(async (env,peer) => {
      for (const avatar of [1,2,3,4,5].map(i => '/api/assets/' + (base+i)).concat(['/api/assets/2147483647','javascript:alert(1)','//evil.invalid/x','https://user:secret@invalid.example/x.png','http://invalid.example/x.png','/bad\\path.png'])) {
        await f.db.update(user).set({ avatar }).where(eq(user.uid,22));
        await readonly(async () => { for (const row of rows((await request(env,peer.db)).body)) expect(row).toMatchObject({ uid:22,avatar:'',avatar_source:'' }); });
      }
      await f.db.update(user).set({ avatar: '/api/assets/' + base }).where(eq(user.uid,22));
      for (const update of [{ attDir:'/api/assets/' + (base+1) },{ fileType:2 },{ imageType:0 }]) {
        await f.db.update(systemAttachment).set(update).where(eq(systemAttachment.attId,base));
        try { await readonly(async () => expect(rows((await request(env,peer.db)).body)[0]).toMatchObject({ avatar:'',avatar_source:'' })); }
        finally { await f.db.update(systemAttachment).set({ attDir:'/api/assets/' + base,fileType:1,imageType:8 }).where(eq(systemAttachment.attId,base)); }
      }
      for (const update of [{ isDel:1 },{ deleteTime:new Date(now * 1000) }]) {
        await f.db.update(user).set(update).where(eq(user.uid,22));
        try { await readonly(async () => { const data=payload((await request(env,peer.db)).body); expect(data.count).toBe(13);
          for (const row of data.list as Row[]) expect(row).toMatchObject({ uid:22,nickname:'',avatar:'',avatar_source:'' }); }); }
        finally { await f.db.update(user).set({ isDel:0,deleteTime:null }).where(eq(user.uid,22)); }
      }
      // The paid-order fence legitimately permits a zero-value order without a buyer row.
      await f.db.update(storeOrder).set({ uid: 999999, payPrice: '0.00' }).where(eq(storeOrder.id,base + 1));
      try { await readonly(async () => { const data=payload((await request(env,peer.db)).body);expect(data.count).toBe(13);
        expect((data.list as Row[])[0]).toMatchObject({ uid:999999,nickname:'',avatar:'',avatar_source:'' }); }); }
      finally { await f.db.update(storeOrder).set({ uid:22, payPrice:'10.10' }).where(eq(storeOrder.id,base + 1)); }
      for (const avatar of ['/static/safe-orders.png','https://static.example.invalid/orders.png']) {
        await f.db.update(user).set({ avatar }).where(eq(user.uid,22));
        await readonly(async () => expect(rows((await request(env,peer.db)).body)[0]).toMatchObject({ avatar,avatar_source:avatar }));
      }
    });
  }, 30000);

  it('serves real authorized R2 bytes and refuses forged signatures without writes', async () => {
    await profile(async (env,peer) => {
      const data=payload((await readonly(() => request(env,peer.db))).body), row=(data.list as Row[])[0]!, before=await snapshot(), io=resources();
      const asset = (url:string) => wiring.context!.run(createContainerFromDb(peer.db), () => app.fetch(new Request('https://owned.local' + url),env,
        { waitUntil:()=>{throw Error('No asynchronous reads');},passThroughOnException:()=>{} } as never));
      const response=await asset(String(row.avatar)); expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(digest(png));
      expect((await asset(String(row.avatar).replace('signature=','signature=bad'))).status).toBe(404);
      expect(await snapshot()).toEqual(before); expect(resources()).toEqual({ ...io,gets:['attachments/user/22/orders.png'] });
    });
  });

  it('keeps account, report, payment timestamps and avatar metadata in one repeatable readonly snapshot', async () => {
    await profile(async (env,peer) => {
      const before=await snapshot(),io=resources();
      await f.withPeer!(async holder => {
        let release!:()=>void,acquired!:()=>void; const gate=new Promise<void>(yes=>release=yes),ready=new Promise<void>(yes=>acquired=yes);
        const lock=holder.db.transaction(async tx=>{await tx.execute(sql`LOCK TABLE store_order IN ACCESS EXCLUSIVE MODE`);
          await tx.update(storeOrder).set({payTime:now+500}).where(eq(storeOrder.id,base+1));acquired();await gate;});
        await ready; const pending=request(env,peer.db);
        try {
          const end=performance.now()+1500;let blocked=false;
          do {const [state]=await f.db.execute<{blockers:number[];query:string}>(sql`SELECT pg_blocking_pids(${peer.pid}) AS blockers,query FROM pg_stat_activity WHERE pid=${peer.pid}`);
            if(state?.blockers.includes(holder.pid)&&/store_order/.test(state.query)){blocked=true;break;}await delay(20);
          } while(performance.now()<end);
          expect(blocked,'Actual App report must wait after its account RR snapshot').toBe(true);
          await f.db.update(systemAttachment).set({attType:'image/jpeg'}).where(eq(systemAttachment.attId,base));
        } finally {release();await lock;}
        const data=payload((await pending).body);expect((data.list as Row[])[0]).toMatchObject({avatar_source:'/api/assets/'+base,paid_at:now+100});
        ticket((data.list as Row[])[0]?.avatar,base);
        const expected=structuredClone(before);expected.store_order.find(row=>row.id===base+1)!.pay_time=now+500;expected.system_attachment.find(row=>row.att_id===base)!.att_type='image/jpeg'.padEnd(30,' ');
        expect(await snapshot()).toEqual(sortedDiyState(expected));expect(resources()).toEqual(io);
        await readonly(async()=>expect(rows((await request(env,peer.db)).body)[0]).toMatchObject({avatar:'',avatar_source:''}));
      });
    });
  },20000);
});
