import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { UserDao } from '../src/dao/user/UserDao';
import { apiRoutes } from '../src/routes';
import { errorHandler } from '../src/middleware/error';
import { responseCacheMiddleware } from '../src/middleware/response-cache';
import { createToken, md5 } from '../src/utils/jwt';
import { memberRight, systemConfig, user } from '../src/models/schema';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

describe('offline consumption quote, actual auth/HTTP and independent read-only PG role', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  // Hono's test request accepts partial bindings. Generated deployment bindings
  // deliberately fix NODE_ENV to production; never assert this fixture as Env.
  const env = { NODE_ENV: 'test', APP_KEY: 'offline-quote-local-test-signing-key', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' };
  let token: string;
  beforeAll(async () => {
    if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 is required');
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
    token = (await createToken(11, 'api', md5('local-only-password-hash'), env.APP_KEY)).token;
  }, 60_000);
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    await f.db.delete(user); await f.db.delete(systemConfig); await f.db.delete(memberRight);
    await f.db.insert(user).values({ uid: 11, account: 'local-offline-member', pwd: 'local-only-password-hash', isEverLevel: 1 });
    await f.db.insert(systemConfig).values({ id: 1, isStore: 0, menuName: 'member_card_status', value: '1' });
    await f.db.insert(memberRight).values({ id: 1, rightType: 'offline', status: 1, number: 80 });
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
  afterAll(async () => { await f?.close(); });
  const app = (db: DbClient) => {
    const result = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    result.onError(errorHandler); result.use('*', responseCacheMiddleware);
    result.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); await next(); });
    result.route('/api', apiRoutes); return result;
  };
  const raw = async (db: DbClient, body: string, bearer = token, query = '') => {
    const response = await app(db).request(`/api/order/offline/check/price${query}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body,
    }, env);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.status).toBe(200);
    return await response.json() as { status: number; data: unknown };
  };
  const read = (db: DbClient, body: unknown, bearer = token) => raw(db, JSON.stringify(body), bearer);
  const withReader = <T>(work: (db: DbClient) => Promise<T>) => f.withRuntimeRole!(async r => {
    await f.exec(`GRANT SELECT ON "user", system_config, member_right TO "${r.role}"`);
    await r.exec('SET default_transaction_read_only = on');
    const [identity] = await r.exec(`SELECT current_user = session_user AS login,
      current_setting('transaction_read_only') AS readonly, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
      FROM pg_roles WHERE rolname = current_user`);
    expect(identity).toMatchObject({ login: true, readonly: 'on', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    return work(r.db);
  });
  it('returns an exact member preview through the production route assembly', async () => {
    await withReader(async db => { expect(await read(db, { pay_price: '10.01' })).toMatchObject({ status: 200, data: { pay_price: '8.00' } }); });
  });
  it('retains numeric zero as the legacy no-member-quote sentinel', async () => {
    await f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 0 }).where(eq(user.uid, 11));
    await withReader(async db => { expect(await read(db, { pay_price: '10.01' })).toMatchObject({ status: 200, data: { pay_price: 0 } }); });
  });
  it('requires actual customer authentication before exposing a quote', async () => {
    await withReader(async db => { expect(await read(db, { pay_price: '10.01' }, '')).toMatchObject({ status: 410000 }); });
  });
  it.each([
    ['0.02', '0.01'], ['1', '0.80'], [10.01, '8.00'], ['99999999.99', '79999999.99'],
  ])('truncates exact cents for %s, without treating a string zero quote as the sentinel', async (amount, expected) => {
    await withReader(async db => { expect(await read(db, { pay_price: amount })).toMatchObject({ status: 200, data: { pay_price: expected } }); });
  });
  it('rejects a discounted sub-cent quote instead of rounding up or offering free payment', async () => {
    await withReader(async db => {
      expect(await read(db, { pay_price: '0.01' })).toMatchObject({ status: 400, data: null,
        msg: expect.stringContaining('至少为0.01元') });
    });
  });
  it.each(['', '0', '0.00', -1, '-0.01', '1.001', '100000000', '1e2', ' 1', '1 ', '+1', '.5', '01', 'NaN', 'Infinity', true, null, {}, []])(
    'rejects malformed/out-of-range amount %j', async amount => {
      await withReader(async db => { expect(await read(db, { pay_price: amount })).toMatchObject({ status: 400, data: null }); });
    },
  );
  it.each(['{}', 'null', '[]', '"10.01"', '{', '{"pay_price":"' + '1'.repeat(1100) + '"}'])('bounds and validates JSON input %s', async body => {
    await withReader(async db => { expect(await raw(db, body)).toMatchObject({ status: 400, data: null }); });
  });
  it('does not merge query prices, identity or claimed discounts into the request', async () => {
    await withReader(async db => {
      expect(await raw(db, '{}', token, '?pay_price=10&uid=11')).toMatchObject({ status: 400 });
      expect(await raw(db, '{"pay_price":"10"}', token, '?pay_price=100&uid=99')).toMatchObject({ status: 200, data: { pay_price: '8.00' } });
      for (const key of ['uid', 'price', 'discount', 'is_ever_level', 'type', '__proto__']) {
        expect(await read(db, { pay_price: '10', [key]: 1 })).toMatchObject({ status: 400, data: null });
      }
    });
  });
  it('quotes only the authenticated account when another member exists', async () => {
    await f.db.insert(user).values({ uid: 12, account: 'nonmember', pwd: 'local-second-password-hash' });
    const otherToken = (await createToken(12, 'api', md5('local-second-password-hash'), env.APP_KEY)).token;
    await withReader(async db => {
      expect(await raw(db, '{"pay_price":"10"}', otherToken, '?uid=11')).toMatchObject({ status: 200, data: { pay_price: 0 } });
      expect(await read(db, { pay_price: '10' })).toMatchObject({ status: 200, data: { pay_price: '8.00' } });
    });
  });
  it.each([
    { permanent: 0, level: 1, remaining: 3600, expected: '8.00' },
    { permanent: 0, level: 1, remaining: 0, expected: 0 },
    { permanent: 0, level: 1, remaining: -3600, expected: 0 },
    { permanent: 0, level: 0, remaining: 3600, expected: 0 },
    { permanent: 1, level: 0, remaining: -3600, expected: '8.00' },
  ])('checks current SQL membership $permanent/$level/$remaining', async ({ permanent, level, remaining, expected }) => {
    await f.exec(`UPDATE "user" SET is_ever_level=${permanent},is_money_level=${level},
      overdue_time=floor(extract(epoch FROM clock_timestamp()))::int + ${remaining} WHERE uid=11`);
    await withReader(async db => { expect(await read(db, { pay_price: '10.01' })).toMatchObject({ status: 200, data: { pay_price: expected } }); });
  });
  it.each([
    { value: '', expected: '8.00' }, { value: '"1"', expected: '8.00' },
    { value: '0', expected: 0 }, { value: '2', expected: 0 }, { value: '-1', expected: 0 },
  ])('normalizes the global switch $value', async ({ value, expected }) => {
    await f.db.update(systemConfig).set({ value });
    await withReader(async db => { expect(await read(db, { pay_price: '10.01' })).toMatchObject({ status: 200, data: { pay_price: expected } }); });
  });
  it.each(['true', '1.0', '[]', '9007199254740992'])('rejects malformed switch %s rather than granting a quote', async value => {
    await f.db.update(systemConfig).set({ value });
    await withReader(async db => { expect(await read(db, { pay_price: '10.01' })).toMatchObject({ status: 400, data: null }); });
  });
  it('uses missing-switch default, global sort/id precedence, and not config visibility or store scope', async () => {
    await f.db.delete(systemConfig);
    await withReader(async db => {
      expect(await read(db, { pay_price: '10.01' })).toMatchObject({ data: { pay_price: '8.00' } });
      await f.db.insert(systemConfig).values([
        { id: 1, menuName: 'member_card_status', value: '0', sort: 1 },
        { id: 2, menuName: 'member_card_status', value: '1', sort: 2, status: 0 },
        { id: 3, menuName: 'member_card_status', value: '0', sort: 99, isStore: 1 },
      ]);
      expect(await read(db, { pay_price: '10.01' })).toMatchObject({ data: { pay_price: '8.00' } });
      await f.db.insert(systemConfig).values({ id: 4, menuName: 'member_card_status', value: '0', sort: 2 });
      expect(await read(db, { pay_price: '10.01' })).toMatchObject({ data: { pay_price: 0 } });
    });
  });
  it.each([
    { status: 0, number: 80, expected: 0 }, { status: 1, number: 0, expected: 0 },
    { status: 1, number: 1, expected: '0.10' }, { status: 1, number: 100, expected: '10.01' },
  ])('applies right $status/$number', async ({ status, number, expected }) => {
    await f.db.update(memberRight).set({ status, number });
    await withReader(async db => { expect(await read(db, { pay_price: '10.01' })).toMatchObject({ status: 200, data: { pay_price: expected } }); });
  });
  it('rejects a percentage over 100 and keeps the lowest-id right even if disabled', async () => {
    await f.db.update(memberRight).set({ number: 101 });
    await withReader(async db => {
      expect(await read(db, { pay_price: '10' })).toMatchObject({ status: 400, data: null });
      await f.db.update(memberRight).set({ number: 80, status: 0 });
      await f.db.insert(memberRight).values({ id: 2, rightType: 'offline', status: 1, number: 50 });
      expect(await read(db, { pay_price: '10' })).toMatchObject({ data: { pay_price: 0 } });
      await f.db.delete(memberRight);
      expect(await read(db, { pay_price: '10' })).toMatchObject({ data: { pay_price: 0 } });
    });
  });
  it.each(['banned', 'deleted', 'missing', 'password', 'wrong-actor', 'invalid-signature'])('rejects %s authentication', async state => {
    let bearer = token;
    if (state === 'banned') await f.db.update(user).set({ status: 0 });
    if (state === 'deleted') await f.db.update(user).set({ isDel: 1 });
    if (state === 'missing') await f.db.delete(user);
    if (state === 'password') await f.db.update(user).set({ pwd: 'changed-password-hash' });
    if (state === 'wrong-actor') bearer = (await createToken(11, 'admin', md5('local-only-password-hash'), env.APP_KEY)).token;
    if (state === 'invalid-signature') bearer = (await createToken(11, 'api', md5('local-only-password-hash'), 'different-test-key')).token;
    await withReader(async db => { expect((await read(db, { pay_price: '10' }, bearer)).status).toBeGreaterThanOrEqual(410000); });
  });
  it.each(['membership', 'banned', 'deleted'])('re-reads %s changed after real authentication', async state => {
    const original = UserDao.prototype.findForAuth;
    let changed = false;
    vi.spyOn(UserDao.prototype, 'findForAuth').mockImplementation(async function (this: UserDao, uid) {
      const result = await original.call(this, uid);
      await f.withPeer!(async peer => {
        const column = state === 'membership' ? 'is_ever_level=0' : state === 'banned' ? 'status=0' : 'is_del=1';
        await peer.exec(`UPDATE "user" SET ${column} WHERE uid=11`);
      });
      changed = true;
      return result;
    });
    await withReader(async db => {
      expect(await read(db, { pay_price: '10' })).toMatchObject(state === 'membership'
        ? { status: 200, data: { pay_price: 0 } } : { status: 410001, data: null });
    });
    expect(changed).toBe(true);
  });
  it('reads account, config and right in one SQL statement and sees only committed changes on later requests', async () => {
    await withReader(async db => {
      const preparedSql: string[] = [];
      const original = PostgresJsSession.prototype.prepareQuery;
      const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
        preparedSql.push(args[0].sql);
        return original.apply(this, args);
      });
      expect(await read(db, { pay_price: '10.01' })).toMatchObject({ data: { pay_price: '8.00' } });
      spy.mockRestore();
      expect(preparedSql).toHaveLength(2); // Actual auth SELECT plus one quote SELECT.
      expect(preparedSql[1]).toContain('"user"');
      expect(preparedSql[1]).toContain('"system_config"');
      expect(preparedSql[1]).toContain('"member_right"');
      expect(preparedSql[1]).toContain('statement_timestamp()');
      await f.withPeer!(async writer => {
        await writer.exec('BEGIN');
        let committed = false;
        try {
          await writer.exec(`UPDATE "user" SET is_ever_level=0,is_money_level=1,overdue_time=2147483647 WHERE uid=11;
            UPDATE system_config SET value='0'; UPDATE member_right SET number=50;`);
          expect(await read(db, { pay_price: '10.01' })).toMatchObject({ data: { pay_price: '8.00' } });
          await writer.exec('COMMIT');
          committed = true;
        } finally { if (!committed) await writer.exec('ROLLBACK'); }
      });
      expect(await read(db, { pay_price: '10.01' })).toMatchObject({ data: { pay_price: 0 } });
      await f.db.update(systemConfig).set({ value: '1' });
      expect(await read(db, { pay_price: '10.01' })).toMatchObject({ data: { pay_price: '5.00' } });
    });
  });
  it('does not hide SQL permission failures as a no-member quote', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await f.withRuntimeRole!(async r => {
      await f.exec(`GRANT SELECT ON "user", system_config TO "${r.role}"`);
      expect(await read(r.db, { pay_price: '10' })).toMatchObject({ status: 500, data: null });
    });
    log.mockRestore();
  });
  it('keeps quotes and method discovery read-only and rejects incomplete admission through registered routes', async () => {
    const snapshot = () => f.query(`SELECT
      (SELECT row_to_json(u) FROM "user" u WHERE uid=11) AS account,
      (SELECT count(*) FROM other_order) AS orders,
      (SELECT count(*) FROM store_order_economize) AS savings,
      (SELECT count(*) FROM user_bill) AS bills`);
    const before = await snapshot();
    await withReader(async db => {
      expect(await read(db, { pay_price: '10' })).toMatchObject({ status: 200 });
      // These routes are now registered. Check their actual contracts rather
      // than preserving the old pre-admission 404 assertion. Full write/ACL
      // rejection and protected admission are covered by offline-order-http.
      const incomplete = await app(db).request('/api/order/offline/create', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
      }, env);
      expect(incomplete.status).toBe(200);
      expect(await incomplete.json()).toMatchObject({ status: 400, data: null });
      const methods = await app(db).request('/api/order/offline/pay/type', { headers: { Authorization: `Bearer ${token}` } }, env);
      expect(methods.status).toBe(200);
      expect(await methods.json()).toMatchObject({ status: 200, data: { now_money: '0.00',
        yue_pay_status: 0, pay_weixin_open: 0, ali_pay_status: 0,
        methods: { yue: 'disabled', weixin: 'disabled', alipay: 'disabled' } } });
      for (const result of [incomplete, methods]) {
        expect(result.headers.get('Cache-Control')).toContain('no-store');
      }
    });
    expect(await snapshot()).toEqual(before);
  });
});
