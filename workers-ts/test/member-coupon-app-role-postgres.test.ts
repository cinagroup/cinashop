import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { memberRight, storeCouponIssue, storeCouponIssueUser, systemConfig, user } from '@/models/schema';
import { runRuntimeBusinessCommissioning } from '@/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { inspectCheckoutPricingLock } from '@/migrations/checkoutPricingLock';
import { protectCheckoutPricingSources } from '@/services/order/CheckoutPricingSources';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { sortedDiyState, type DiyStateSnapshot as Snapshot, type DiyStateRow as Row } from './helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const container = wiring.context?.getStore();
  if (!container) throw Error('Actual owned App LOGIN request context required');
  return container;
} }));
const issueId = 190001, rightId = 190001, password = 'synthetic-member-coupon-app-role';
const errorCodes = (error: unknown) => {
  const result: string[] = [];
  for (let cause: unknown = error, depth = 0; cause && typeof cause === 'object' && depth < 8; depth++) {
    const item = cause as { code?: unknown; cause?: unknown };
    if (typeof item.code === 'string') result.push(item.code);
    if (item.cause === cause) break;
    cause = item.cause;
  }
  return result;
};
function one(rows: Row[], key: string, value: unknown) {
  const matches = rows.filter(row => row[key] === value); expect(matches).toHaveLength(1); return matches[0]!;
}
const time = (value: unknown) => {
  expect(typeof value).toBe('string'); const raw = String(value);
  // SQL timestamp without time zone stores the UTC value supplied by Drizzle.
  const milliseconds = Date.parse(/[zZ]|[+-]\d\d:\d\d$/u.test(raw) ? raw : raw + 'Z');
  expect(Number.isFinite(milliseconds)).toBe(true); return milliseconds;
};

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('membership coupon exact commissioned App LOGIN and real HTTP/PG16 authority', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  let tables: string[], sequences: string[];
  const app = createApp(), tokens = new Map<number, string>();
  const io = { r2: vi.fn(), queue: vi.fn(), sequence: vi.fn() };
  const resources = () => ({ r2: io.r2.mock.calls.length, queue: io.queue.mock.calls.length,
    sequence: io.sequence.mock.calls.length, objects: [{ key: 'synthetic-sentinel', bytes: 3,
      sha256: createHash('sha256').update(Uint8Array.from([1, 2, 3])).digest('hex') }] });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External network forbidden'));
    f = await refundRuntimeFixture(); f.env.APP_KEY = crypto.randomUUID() + crypto.randomUUID();
    wiring.context = new AsyncLocalStorage<Container>();
    const now = Math.floor(Date.now() / 1000);
    await f.db.update(user).set({ pwd: password, status: 1, isDel: 0, isEverLevel: 1, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 11));
    await f.db.update(user).set({ pwd: password, status: 1, isDel: 0, isEverLevel: 1, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 22));
    // The registered migrations and historical quote fixture intentionally leave
    // two global candidates. Preserve both: production chooses sort DESC/id DESC.
    const candidates = await f.db.select({ id: systemConfig.id, isStore: systemConfig.isStore,
      sort: systemConfig.sort, status: systemConfig.status, value: systemConfig.value }).from(systemConfig)
      .where(eq(systemConfig.menuName, 'member_card_status')).orderBy(asc(systemConfig.id));
    expect(candidates).toEqual([{ id: 19, isStore: 0, sort: 0, status: 0, value: '0' },
      { id: 24, isStore: 0, sort: 0, status: 0, value: '0' }]);
    const config = await f.db.update(systemConfig).set({ value: '1' })
      .where(and(eq(systemConfig.menuName, 'member_card_status'), eq(systemConfig.isStore, 0))).returning({ id: systemConfig.id });
    expect(config.slice().sort((a, b) => a.id - b.id)).toEqual(candidates.map(({ id }) => ({ id })));
    await f.db.insert(memberRight).values({ id: rightId, rightType: 'coupon', status: 1 });
    await f.db.insert(storeCouponIssue).values({ id: issueId, category: 2, receiveType: 1, appType: 0,
      type: 1, couponType: 0, title: '正式App会员券', couponTitle: '正式App会员券', couponPrice: '5.00', useMinPrice: '10.00',
      day: 7, isPermanent: 0, totalCount: 3, remainCount: 3, receiveLimit: 0, status: 1, isDel: 0,
      startTime: new Date((now - 86400) * 1000), endTime: new Date((now + 86400) * 1000), addTime: now });
    tables = (await f.exec("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => String(row.name));
    sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    expect(tables).toHaveLength(283);
    for (const name of [...tables, ...sequences]) expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
    for (const uid of [11, 22]) tokens.set(uid, (await createToken(uid, 'api', md5(password), f.env.APP_KEY)).token);
    for (const spy of Object.values(io)) spy.mockReset().mockImplementation(() => { throw Error('Coupon claim must not access external resources'); });
  }, 60000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); expect(resources()).toMatchObject({ r2: 0, queue: 0, sequence: 0 }); }
    finally { wiring.context = undefined; tokens.clear(); vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  type Peer = Parameters<NonNullable<typeof f.withRuntimeRole>>[0] extends (role: infer T) => unknown ? T : never;
  async function profiles(run: (env: Env, application: Peer, names: Parameters<typeof runRuntimeBusinessCommissioning>[1]) => Promise<void>) {
    await f.withRuntimeRole!(application => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS name');
      const names = { app: application.role, admin: admin.role, maintenance: 'finance_test', database: String(identity.name), pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      expect(await auditRuntimeBusinessPrivileges(application.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      const env: Env = { ...f.env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
        HYPERDRIVE: { connectionString: application.connectionString } as Env['HYPERDRIVE'],
        HYPERDRIVE_ADMIN: { connectionString: admin.connectionString } as Env['HYPERDRIVE_ADMIN'],
        ASSETS_BUCKET: { put: io.r2, delete: io.r2, get: io.r2, head: io.r2, list: io.r2 } as unknown as Env['ASSETS_BUCKET'],
        ORDER_QUEUE: { send: io.queue, sendBatch: io.queue } as unknown as Env['ORDER_QUEUE'],
        SEQUENCE: { idFromName: io.sequence, get: io.sequence } as unknown as Env['SEQUENCE'] };
      Object.assign(env, { NODE_ENV: 'test' });
      await run(env, application, names);
    }));
  }
  async function snapshot(): Promise<Snapshot> {
    const state: Snapshot = {};
    for (const row of await f.db.execute<{ name: string; rows: Row[] }>(sql.join(tables.map(name => sql`SELECT ${name}::text AS name,
      COALESCE(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS rows FROM ${sql.identifier(name)} t`), sql` UNION ALL `))) state[row.name] = row.rows;
    state.__sequences = await f.db.execute(sql.join(sequences.map(name => sql`SELECT ${name}::text AS name,last_value::text AS last,
      is_called AS called FROM ${sql.identifier(name)}`), sql` UNION ALL `));
    return sortedDiyState(state);
  }
  async function request(env: Env, db: DbClient, uid = 11, body?: unknown, path = 'coupon/receive') {
    const headers = new Headers({ 'Authori-zation': 'Bearer ' + tokens.get(uid), 'Form-type': 'h5' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const started = Date.now();
    const response = await wiring.context!.run(createContainerFromDb(db), () => app.fetch(new Request('https://owned.local/api/' + path,
      { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never));
    const dto = await response.json() as Row;
    expect(response.status).toBe(200);
    return { dto, started, completed: Date.now() };
  }
  const claim = (env: Env, db: DbClient, uid = 11) => request(env, db, uid, { couponId: issueId, member: 1 });
  async function readonly<T>(run: () => Promise<T>) {
    const before = await snapshot(), beforeResources = resources(), result = await run();
    expect(await snapshot()).toEqual(before); expect(resources()).toEqual(beforeResources); return result;
  }
  async function grant(before: Snapshot, result: Awaited<ReturnType<typeof request>>, uid = 11, modern = true) {
    expect(result.dto.status, String(result.dto.msg)).toBe(200);
    const expected = structuredClone(before), serial = one(expected.__sequences, 'name', 'store_coupon_user_id_seq');
    const id = Number(BigInt(String(serial.last)) + (serial.called ? 1n : 0n)); serial.last = String(id); serial.called = true;
    const after = await snapshot(), actual = one(after.store_coupon_user, 'id', id), issue = one(before.store_coupon_issue, 'id', issueId);
    const start = time(actual.start_time), end = time(actual.end_time);
    expect(start).toBeGreaterThanOrEqual(result.started); expect(start).toBeLessThanOrEqual(result.completed);
    expect(end).toBe(start + 7 * 86400000);
    expect(actual.receive_time).toBeGreaterThanOrEqual(Math.floor(result.started / 1000));
    expect(actual.receive_time).toBeLessThanOrEqual(Math.floor(result.completed / 1000));
    const row = { id, uid, issue_coupon_id: issueId, coupon_title: issue.coupon_title, coupon_price: 5, use_min_price: 10,
      status: 0, start_time: actual.start_time, end_time: actual.end_time, use_time: null, type: 1,
      receive_time: actual.receive_time, receive_source: 'get', is_fail: 0 };
    expect(actual).toEqual(row); expected.store_coupon_user.push(row);
    expected.store_coupon_issue_user.push({ uid, issue_coupon_id: issueId, add_time: actual.receive_time });
    one(expected.store_coupon_issue, 'id', issueId).remain_count--;
    expect(after).toEqual(sortedDiyState(expected));
    const coupon = { id, issue_id: issueId, title: '正式App会员券', benefit_type: 1, benefit_value: '5.00', minimum: '10.00',
      status: 0, start_time: Math.floor(start / 1000), end_time: Math.floor(end / 1000), is_fail: false };
    expect(result.dto.data).toEqual(modern ? { owner_uid: uid, issue_id: issueId, replayed: false, coupon } : { couponUserId: id });
    expect(resources()).toMatchObject({ r2: 0, queue: 0, sequence: 0 }); return coupon;
  }
  async function appPeers<T>(application: Peer, run: (a: { db: DbClient; pid: number }, b: { db: DbClient; pid: number }) => Promise<T>) {
    const clients: ReturnType<typeof postgres>[] = [];
    try {
      const connect = async () => {
        const client = postgres(application.connectionString, { max: 1, prepare: false, idle_timeout: 0, max_lifetime: 0,
          connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=8000' } });
        clients.push(client);
        const [identity] = await client`SELECT current_user AS role,session_user AS session,current_database() AS database,pg_backend_pid() AS pid`;
        const [original] = await application.exec('SELECT current_database() AS database');
        expect(identity).toMatchObject({ role: application.role, session: application.role, database: original.database });
        return { db: drizzle(client) as unknown as DbClient, pid: Number(identity.pid) };
      };
      const a = await connect(), b = await connect(); expect(new Set([a.pid, b.pid, application.pid]).size).toBe(3);
      return await run(a, b);
    } finally { await Promise.all(clients.map(client => client.end({ timeout: 1 }))); }
  }
  async function paths(writers: number[], holder: number) {
    const stop = performance.now() + 4000, allowed = [...writers, holder];
    do {
      const rows = await f.db.execute<{ pid: number; blockers: number[] }>(sql.join(allowed.map(pid => sql`SELECT ${pid}::int AS pid,pg_blocking_pids(${pid}::int) AS blockers`), sql` UNION ALL `));
      for (const row of rows) expect(row.blockers.every(pid => allowed.includes(pid))).toBe(true);
      const map = new Map(rows.map(row => [row.pid, row.blockers]));
      function path(pid: number, seen: number[] = []): number[] | null {
        if (seen.includes(pid)) return null; const chain = [...seen, pid]; if (pid === holder) return chain;
        for (const next of map.get(pid) ?? []) { const found = path(next, chain); if (found) return found; } return null;
      }
      const found = writers.map(pid => path(pid));
      if (found.every(value => value !== null)) return { rows, paths: found, writers, holder };
      await delay(25);
    } while (performance.now() < stop);
    throw Error('Actual formal App writer paths to issue holder were not observed');
  }

  it('retains real42501 direct-row-lock denials while the already commissioned fixed capability succeeds without source UPDATE', async () => {
    await profiles(async (_env, application, names) => {
      const [identity] = await application.db.execute(sql`SELECT current_user AS role,session_user AS session,
        has_table_privilege(current_user,'public.system_config','SELECT') AS config_select,
        has_any_column_privilege(current_user,'public.system_config','UPDATE') AS config_update,
        has_table_privilege(current_user,'public.member_right','SELECT') AS right_select,
        has_any_column_privilege(current_user,'public.member_right','UPDATE') AS right_update,
        has_function_privilege(current_user,'public.checkout_lock_pricing_v1()','EXECUTE') AS capability_execute`);
      expect(identity).toEqual({ role: application.role, session: application.role, config_select: true, config_update: false,
        right_select: true, right_update: false, capability_execute: true });
      const catalog = await inspectCheckoutPricingLock(application.db);
      for (const table of ['system_config', 'member_right'] as const) await readonly(async () => {
        expect((await application.db.execute(sql.raw(`SELECT id FROM public."${table}" LIMIT 1`))).length).toBe(1);
        let failure: unknown;
        try { await application.db.transaction(tx => tx.execute(sql.raw(`SELECT id FROM public."${table}" LIMIT 1 FOR SHARE NOWAIT`))); }
        catch (error) { failure = error; }
        expect(errorCodes(failure)).toContain('42501');
        console.log('MEMBER_COUPON_FORMAL_ROW_LOCK_DENIED ' + JSON.stringify({ table, codes: errorCodes(failure), role: application.role }));
      });
      await readonly(() => application.db.transaction(tx => protectCheckoutPricingSources(tx as unknown as DbClient), { isolationLevel: 'read committed', accessMode: 'read write' }));
      expect(await inspectCheckoutPricingLock(application.db)).toEqual(catalog);
      expect(await auditRuntimeBusinessPrivileges(application.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
    });
  }, 90000);
  it('grants through the actual App JWT route and replays the same owned ID after capability and all eligibility withdrawal', async () => {
    await profiles(async (env, application) => {
      const before = await snapshot(), first = await claim(env, application.db), coupon = await grant(before, first);
      await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'member_card_status'));
      await f.db.update(memberRight).set({ status: 0 }).where(eq(memberRight.id, rightId));
      await f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 0 }).where(eq(user.uid, 11));
      await f.db.update(storeCouponIssue).set({ status: 0, isDel: 1, remainCount: 0 }).where(eq(storeCouponIssue.id, issueId));
      await f.exec('DROP FUNCTION public.checkout_lock_pricing_v1()');
      await readonly(async () => {
        expect((await claim(env, application.db)).dto.data).toEqual({ owner_uid: 11, issue_id: issueId, replayed: true, coupon });
        const receipt = await request(env, application.db, 11, undefined, 'user/member/coupons/list?claim=' + issueId);
        expect(receipt.dto.data).toEqual({ owner_uid: 11, issue_id: issueId, state: 'received', coupon });
        expect((await request(env, application.db, 22, undefined, 'user/member/coupons/list?claim=' + issueId)).dto.data)
          .toEqual({ owner_uid: 22, issue_id: issueId, state: 'unknown', coupon: null });
      });
    });
  }, 90000);
  it.each(['id', 'couponId'])('keeps legacy %s success/once shapes and actual JWT owner independently of the client uid', async key => {
    await profiles(async (env, application) => {
      const before = await snapshot(), result = await request(env, application.db, 11, { [key]: issueId, uid: 22 });
      await grant(before, result, 11, false);
      await readonly(async () => expect((await request(env, application.db, 11, { [key]: issueId })).dto)
        .toMatchObject({ status: 400, msg: '已领取过该优惠券，每人限领1张' }));
    });
  }, 90000);
  it.each(['config', 'right', 'account'] as const)('denies a fresh App claim when %s authority is absent without SQL or resource writes', async kind => {
    await profiles(async (env, application) => {
      if (kind === 'config') await f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'member_card_status'));
      if (kind === 'right') await f.db.update(memberRight).set({ status: 0 }).where(eq(memberRight.id, rightId));
      if (kind === 'account') await f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 0 }).where(eq(user.uid, 11));
      await readonly(async () => {
        expect((await claim(env, application.db)).dto.status).toBe(400);
        const legacy = await request(env, application.db, 11, { id: issueId }); expect(legacy.dto.status).toBe(400);
        if (kind === 'account') expect(legacy.dto.msg).toBe('该优惠券不允许手动领取');
      });
    });
  }, 90000);
  it.each(['absent', 'revoked', 'drifted'] as const)('fails closed for a %s fixed capability without runtime repair or grants', async mode => {
    await profiles(async (env, application) => {
      if (mode === 'absent') await f.exec('DROP FUNCTION public.checkout_lock_pricing_v1()');
      if (mode === 'revoked') await f.exec(`REVOKE EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() FROM "${application.role}"`);
      if (mode === 'drifted') await f.exec("ALTER FUNCTION public.checkout_lock_pricing_v1() SET search_path='public, pg_temp'");
      const catalog = await inspectCheckoutPricingLock(f.db);
      await readonly(async () => expect((await claim(env, application.db)).dto).toMatchObject({ status: 500, data: null }));
      expect(await inspectCheckoutPricingLock(f.db)).toEqual(catalog);
    });
  }, 90000);
  it('preserves orphan-log uncertainty instead of issuing a new coupon', async () => {
    await f.db.insert(storeCouponIssueUser).values({ uid: 11, issueCouponId: issueId, addTime: 1 });
    await profiles(async (env, application) => readonly(async () => expect((await claim(env, application.db)).dto)
      .toMatchObject({ status: 409, data: null })));
  }, 90000);
  it.each(['config', 'right', 'user'] as const)('returns HTTP200/business409 against a real held %s writer, then obeys committed revocation', async kind => {
    await profiles(async (env, application) => f.withPeer!(async holder => {
      let release!: () => void, ready!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<void>(resolve => { ready = resolve; });
      const lock = holder.db.transaction(async tx => {
        if (kind === 'config') await tx.execute(sql`UPDATE system_config SET value='0' WHERE menu_name='member_card_status' AND is_store=0`);
        if (kind === 'right') await tx.execute(sql`UPDATE member_right SET status=0 WHERE id=${rightId}`);
        if (kind === 'user') await tx.execute(sql`UPDATE "user" SET is_ever_level=0,is_money_level=0 WHERE uid=11`);
        ready(); await gate;
      }); await locked;
      try {
        await readonly(async () => expect((await claim(env, application.db)).dto).toMatchObject({ status: 409, data: null }));
        release(); await lock;
        await readonly(async () => expect((await claim(env, application.db)).dto.status).toBe(400));
      } finally { release(); await lock; }
    }));
  }, 90000);
  it.each(['same-owner', 'last-stock'] as const)('observes two real App LOGIN waiter paths for %s and commits exactly one complete grant', async kind => {
    if (kind === 'last-stock') await f.db.update(storeCouponIssue).set({ remainCount: 1 }).where(eq(storeCouponIssue.id, issueId));
    await profiles(async (env, application) => appPeers(application, (a, b) => f.withPeer!(async holder => {
      const before = await snapshot(); let release!: () => void, ready!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<void>(resolve => { ready = resolve; });
      const lock = holder.db.transaction(async tx => { await tx.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, issueId)).for('update'); ready(); await gate; });
      await locked;
      try {
        const first = claim(env, a.db), second = claim(env, b.db, kind === 'same-owner' ? 11 : 22);
        console.log('MEMBER_COUPON_FORMAL_APP_WAITERS ' + JSON.stringify(await paths([a.pid, b.pid], holder.pid)));
        release(); await lock; const results = await Promise.all([first, second]);
        expect(results.map(result => result.dto.status).sort()).toEqual(kind === 'same-owner' ? [200, 200] : [200, 400]);
        const created = results.find(result => result.dto.status === 200 && result.dto.data.replayed === false)!;
        const coupon = await grant(before, created, created.dto.data.owner_uid);
        if (kind === 'same-owner') expect(results.find(result => result.dto.data.replayed === true)!.dto.data.coupon).toEqual(coupon);
        else expect(results.find(result => result.dto.status === 400)!.dto.msg).toContain('领完');
      } finally { release(); await lock; }
    })));
  }, 90000);
});
