import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import { drizzle, PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, storeOrder, systemConfig, user, userFriends, userSpread } from '../src/models/schema';
import { levelList, levelTaskList } from '../src/controllers/api/v1/AgentLevelController';
import { asset } from '../src/controllers/system/AttachmentController';
import { buildOrderBrokerageSnapshot } from '../src/services/order/OrderBrokerageService';
import { assertCheckoutBrokerageAuthority } from '../src/services/order/CheckoutBrokerageAuthority';
import { LoginService } from '../src/services/user/LoginService';
import { UserFinanceService } from '../src/services/user/UserFinanceService';
import { evaluateAgentLevelsAfterRegistration } from '../src/services/agent/AgentLevelRegistrationEffects';
import { AgentLevelTaskInvalidException } from '../src/services/agent/AgentLevelTaskService';
import { setTokenBucket, type TokenBucket } from '../src/utils/cache';
import { md5, verifyToken } from '../src/utils/jwt';
import { agentLevelConsumerFixture } from './helpers/agentLevelConsumerFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

// No network calls. Only the external bearer store is stubbed; real Login,
// relationship writes, config SQL, catalog guard and upgrade service execute.
vi.mock('../src/utils/cache', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/cache')>(),
  setTokenBucket: vi.fn(async () => true),
}));
const native = describe.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL);
native('distributor upgrade consumer: native SQL and real current runtime slice', () => {
  let f: Awaited<ReturnType<typeof agentLevelConsumerFixture>>;
  beforeEach(async () => { f = await agentLevelConsumerFixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const config = async (id: number, value: string) => { await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.id, id)); };
  const order = async (id: number, uid: number, payPrice: string, extra: Partial<typeof storeOrder.$inferInsert> = {}) => {
    await f.db.insert(storeOrder).values({ id, uid, orderId: `agent-native-${id}`, unique: `agent-native-${id}`,
      payPrice, paid: 1, pid: 0, refundStatus: 0, isDel: 0, isSystemDel: 0, ...extra });
  };
  const runtime = async <T,>(run: (app: Parameters<typeof f.installSlice>[0], admin: Parameters<typeof f.installSlice>[1]) => Promise<T>) =>
    f.withRuntimeRole(app => f.withRuntimeRole(async admin => { await f.installSlice(app, admin); return run(app, admin); }));
  const authEnv = () => ({ ...f.env, UPSTASH_REDIS_URL: 'https://isolated-token-store.example', UPSTASH_REDIS_TOKEN: 'local-stub',
    CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } }) as unknown as Env;
  const sibling = async <T,>(app: Parameters<typeof f.installSlice>[0], run: (peer: typeof app) => Promise<T>) => {
    const connection = postgres(app.connectionString, { max: 1, prepare: false, connect_timeout: 5,
      idle_timeout: 0, max_lifetime: 0, connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=8000' } });
    try {
      const [identity] = await connection`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`;
      expect(identity).toMatchObject({ role: app.role, session: app.role });
      const peer = { ...app, db: drizzle(connection) as unknown as typeof app.db, pid: Number(identity.pid),
        exec: async (query: string) => Array.from(await connection.unsafe(query)) };
      expect(peer.pid).not.toBe(app.pid);
      const result = await run(peer);
      expect(Number((await connection`SELECT pg_backend_pid() AS pid`)[0].pid)).toBe(peer.pid);
      return result;
    } finally { await connection.end({ timeout: 1 }); }
  };
  const sqlState = (error: unknown): string | undefined => {
    for (let i = 0; i < 8 && error && typeof error === 'object'; i++) {
      if ('code' in error && typeof error.code === 'string') return error.code;
      error = 'cause' in error ? error.cause : undefined;
    }
  };

  it.each([{ status: 0, isDel: 0 }, { status: 1, isDel: 1 }])('retains gifted rank for hidden/deleted assigned level %j without downgrading or inventing records', async state => {
    await f.db.insert(agentLevel).values({ id: 50, grade: 10, name: '历史已授予', ...state });
    await f.db.update(user).set({ agentLevel: 50 }).where(eq(user.uid, 30));
    await f.db.insert(agentLevelTask).values({ id: 21, levelId: 2, type: 2, number: 100 });
    const result = await f.upgradeFor(30);
    expect(result.upgraded.some(row => row.uid === 30)).toBe(false);
    const levels = await f.serviceFor().userLevelList(30);
    expect(levels).toMatchObject({ user: { agent_level: 50 }, current_grade: 10, next_level: null });
    const tasks = await f.serviceFor().userTaskList(30, 2);
    expect(tasks).toMatchObject({ speedAll: 100, list: [{ finish: 1, speed: 100, new_number: 100 }] });
    expect((await f.snapshot()).records.filter(row => row.uid === 30)).toEqual([]);
    expect((await f.snapshot()).users.find(row => row.uid === 30)?.agentLevel).toBe(50);
    if (state.isDel === 1) expect(levels).toMatchObject({ level_info: { sum_task: 0, finish_task: 0 } });
    else expect(levels).toMatchObject({ level_info: { id: 50 } });
  });

  it('uses all five exact legacy metrics with paid root/refund filters and stops at the first unfinished higher level', async () => {
    await f.db.update(agentLevelTask).set({ status: 0 }).where(eq(agentLevelTask.id, 11));
    await f.db.insert(user).values([{ uid: 31, spreadUid: 30 }, { uid: 32, spreadUid: 30 }]);
    await f.db.insert(agentLevel).values({ id: 3, name: '更高级', grade: 3 });
    await f.db.insert(agentLevelTask).values([
      ...[1, 2, 3, 4, 5].map((type, index) => ({ id: 201 + index, levelId: 1, type,
        number: [2, 100, 2, 50, 2][index], isMust: 0, sort: 50 - index })),
      { id: 211, levelId: 2, type: 2, number: 101 }, { id: 311, levelId: 3, type: 1, number: 1 },
    ]);
    await order(1, 30, '99.99'); await order(2, 30, '0.01', { refundStatus: 3 });
    await order(3, 31, '25.01'); await order(4, 32, '24.99', { refundStatus: 3 });
    await order(5, 30, '999.00', { paid: 0 }); await order(6, 30, '999.00', { refundStatus: 1 });
    await order(7, 30, '999.00', { pid: 1 }); await order(8, 30, '999.00', { isDel: 1 });
    await order(9, 30, '999.00', { isSystemDel: 1 }); await order(10, 31, '999.00', { pid: 3 });
    await f.upgradeFor(30);
    const snapshot = await f.snapshot();
    expect(snapshot.users.find(row => row.uid === 30)?.agentLevel).toBe(1);
    expect(snapshot.records.filter(row => row.uid === 30).map(row => row.taskId).sort()).toEqual([201, 202, 203, 204, 205]);
    expect(snapshot.records.filter(row => row.uid === 30).map(row => row.status)).toEqual([0, 0, 0, 0, 0]);
    expect(snapshot.records.some(row => row.uid === 30 && [211, 311].includes(row.taskId))).toBe(false);
    const level2 = await f.serviceFor().userTaskList(30, 2);
    expect(level2).toMatchObject({ list: [{ finish: 0, new_number: 100, task_type_title: '还需自身消费满1.00元', speed: 99 }] });
  });

  it('persists only completed tasks, requires every active is_must=0 task, and does not skip an unfinished rank', async () => {
    await f.db.insert(user).values({ uid: 31, spreadUid: 30 });
    await f.db.insert(agentLevelTask).values([
      { id: 12, levelId: 1, type: 2, number: 100, isMust: 0 },
      { id: 21, levelId: 2, type: 1, number: 1, isMust: 0 },
    ]);
    await f.upgradeFor(30); await f.upgradeFor(30);
    expect((await f.snapshot()).users.find(row => row.uid === 30)?.agentLevel).toBe(0);
    expect((await f.snapshot()).records.filter(row => row.uid === 30).map(row => row.taskId)).toEqual([11]);
    await order(1, 30, '100.00'); await f.upgradeFor(30);
    expect((await f.snapshot()).users.find(row => row.uid === 30)?.agentLevel).toBe(2);
    expect((await f.snapshot()).records.filter(row => row.uid === 30).map(row => row.taskId).sort()).toEqual([11, 12, 21]);
  });

  it('matches PHP percentage truncation instead of rounding the task mean', async () => {
    await f.db.insert(user).values({ uid: 31, spreadUid: 30 });
    await f.db.insert(agentLevelTask).values([
      { id: 12, levelId: 1, type: 2, number: 100 }, { id: 13, levelId: 1, type: 3, number: 3 },
    ]);
    await order(1, 30, '100.00');
    const tasks = await f.serviceFor().userTaskList(30, 1);
    expect(tasks).toMatchObject({ speedAll: 77.66 });
    expect('list' in tasks && tasks.list.map(task => task.speed).sort((a, b) => a - b)).toEqual([33, 100, 100]);
  });

  it('preserves duplicate status=0 completion evidence and skips a no-task level without granting it', async () => {
    await f.db.update(agentLevelTask).set({ type: 2, number: 100 }).where(eq(agentLevelTask.id, 11));
    await f.db.insert(agentLevelTaskRecord).values([
      { id: 101, uid: 30, levelId: 1, taskId: 11, status: 0, addTime: 100 },
      { id: 102, uid: 30, levelId: 1, taskId: 11, status: 0, addTime: 101 },
    ]);
    await f.db.insert(agentLevel).values({ id: 3, name: '有任务更高级', grade: 3 });
    await f.db.insert(agentLevelTask).values({ id: 31, levelId: 3, type: 2, number: 200 });
    const before = (await f.snapshot()).records;
    await f.upgradeFor(30); await f.upgradeFor(30);
    expect((await f.snapshot()).records).toEqual(before);
    expect((await f.snapshot()).users.find(row => row.uid === 30)?.agentLevel).toBe(1);
  });

  it('uses SQL sort/id authority, excludes store config, and honors ordinary/self-buy and expiry traversal', async () => {
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'brokerage_func_status', value: '0', sort: 99 },
      { id: 101, menuName: 'brokerage_func_status', value: '0', sort: 999, isStore: 1 },
      { id: 102, menuName: 'is_self_brokerage', value: '1', sort: 99 },
    ]);
    expect((await f.upgradeFor(30)).evaluatedUids).toEqual([10, 20, 30]);
    await f.db.insert(systemConfig).values({ id: 103, menuName: 'is_self_brokerage', value: '1', sort: 100 });
    expect((await f.upgradeFor(30)).evaluatedUids).toEqual([20, 30]);
    await config(3, '2'); await config(4, '0');
    expect((await f.upgradeFor(30)).evaluatedUids).toEqual([30]);
    await f.db.insert(systemConfig).values({ id: 104, menuName: 'brokerage_func_status', value: '0', sort: 100 });
    expect(await f.upgradeFor(30)).toEqual({ enabled: false, evaluatedUids: [], upgraded: [] });
    expect(await f.serviceFor().userLevelList(30)).toEqual([]);
    expect(await f.serviceFor().userTaskList(30, 1)).toEqual([]);
  });

  it('fails missing assigned references and ambiguous grades atomically without speculative completion records', async () => {
    await f.db.update(user).set({ agentLevel: 999 }).where(eq(user.uid, 30));
    const before = await f.snapshot();
    await expect(f.upgradeFor(30)).rejects.toThrow('引用缺失');
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(user).set({ agentLevel: 0 }).where(eq(user.uid, 30));
    await f.db.insert(agentLevel).values({ id: 99, grade: 1, name: '历史重复' });
    const ambiguous = await f.snapshot();
    await expect(f.upgradeFor(30)).rejects.toThrow('重复分销级别');
    expect(await f.snapshot()).toEqual(ambiguous);
  });

  it('rolls back already executed upgrades for multiple users when a later new invalid task fails, and logs a stable PII-free category', async () => {
    await f.db.insert(user).values([{ uid: 31, spreadUid: 30 }, { uid: 32, spreadUid: 30 }]);
    await f.db.insert(agentLevel).values({ id: 3, grade: 3, name: '导入异常等级' });
    await f.db.insert(agentLevelTask).values([
      { id: 21, levelId: 2, type: 1, number: 2 }, { id: 31, levelId: 3, type: 2, number: 0 },
    ]);
    await runtime(async app => {
      const before = await f.snapshot(), execute = PostgresJsPreparedQuery.prototype.execute;
      let inserts = 0, updates = 0;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function(this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args) {
        const query = this.getQuery().sql, result = await execute.apply(this, args);
        if (query.startsWith('insert into "agent_level_task_record"')) inserts++;
        if (query.startsWith('update "user"')) updates++;
        return result;
      });
      try { await expect(f.upgradeFor(30, app.db)).rejects.toBeInstanceOf(AgentLevelTaskInvalidException); }
      finally { vi.restoreAllMocks(); }
      expect(inserts).toBeGreaterThanOrEqual(2); expect(updates).toBeGreaterThanOrEqual(2);
      expect(await f.snapshot()).toEqual(before);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await evaluateAgentLevelsAfterRegistration(createContainerFromDb(app.db), 30);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0][0]).toEqual({ schema: 'cinashop_operational_v1', event: 'agent_level_registration_upgrade_failed',
        component: 'login', operation: 'agent_level_upgrade', outcome: 'failure', errorCode: 'agent_level_task_invalid_exception' });
      expect(await f.snapshot()).toEqual(before);
    });
  });

  it('preserves duplicate status=0 invalid-task evidence and gifted rank while only adding a new valid task completion', async () => {
    await config(2, '1'); await config(3, '2'); await config(4, '0');
    await f.db.insert(user).values({ uid: 31, spreadUid: 30 });
    await f.db.insert(agentLevelTask).values({ id: 12, levelId: 1, type: 0, number: -1 });
    await f.db.insert(agentLevelTaskRecord).values([
      { id: 101, uid: 30, levelId: 1, taskId: 12, status: 0, addTime: 100 },
      { id: 102, uid: 30, levelId: 1, taskId: 12, status: 0, addTime: 101 },
    ]);
    await runtime(async app => {
      const historical = (await f.snapshot()).records;
      await f.upgradeFor(30, app.db); await f.upgradeFor(30, app.db);
      const snapshot = await f.snapshot();
      expect(snapshot.users.find(row => row.uid === 30)?.agentLevel).toBe(1);
      expect(snapshot.records.filter(row => row.id >= 101)).toEqual(historical);
      expect(snapshot.records.filter(row => row.taskId === 11)).toMatchObject([{ uid: 30, levelId: 1, taskId: 11, status: 0 }]);
      await f.db.insert(agentLevel).values({ id: 50, grade: 10, name: '已赠予隐藏等级', status: 0 });
      await f.db.insert(agentLevelTask).values({ id: 21, levelId: 2, type: 0, number: -1 });
      await f.db.update(user).set({ agentLevel: 50 }).where(eq(user.uid, 30));
      const gifted = await f.snapshot();
      await f.upgradeFor(30, app.db);
      expect(await f.snapshot()).toEqual(gifted);
    });
  });

  it('changes actual commission quote uplift after automatic upstream upgrade and rejects the stale create authority', async () => {
    const container = createContainerFromDb(f.db), env = authEnv();
    const [buyer] = await f.db.select().from(user).where(eq(user.uid, 30));
    const input = { orderType: 0, buyer, actualProductCents: 10000,
      items: [{ grossCents: 10000, costCents: 0, quantity: 1, specified: false, specifiedOneCents: 0, specifiedTwoCents: 0 }] };
    const before = await buildOrderBrokerageSnapshot(container, env, input);
    expect(before).toMatchObject({ spreadUid: 20, spreadTwoUid: 10, oneBrokerageCents: 500, twoBrokerageCents: 300 });
    await f.upgradeFor(30);
    const after = await buildOrderBrokerageSnapshot(container, env, input);
    expect(after).toMatchObject({ oneBrokerageCents: 600, twoBrokerageCents: 330 });
    await expect(withTx(container, tx => assertCheckoutBrokerageAuthority(tx, before.authority!))).rejects.toThrow('已变化');
    await expect(withTx(container, tx => assertCheckoutBrokerageAuthority(tx, after.authority!))).resolves.toBeUndefined();
  });

  it('executes both authenticated public prefixes and signed image HTTP using a real non-owner app LOGIN profile slice', async () => {
    await f.db.insert(user).values({ uid: 31, spreadUid: 30 });
    await f.db.update(agentLevel).set({ image: '/api/assets/42' }).where(eq(agentLevel.id, 2));
    await runtime(async appPeer => {
      const [identity] = await appPeer.exec('SELECT current_user AS role, session_user AS session, pg_backend_pid() AS pid');
      expect(identity).toMatchObject({ role: appPeer.role, session: appPeer.role, pid: appPeer.pid });
      await expect(appPeer.exec("UPDATE agent_level SET name='forbidden' WHERE id=1")).rejects.toMatchObject({ code: '42501' });
      await expect(appPeer.exec('DELETE FROM agent_level_task_record WHERE uid=30')).rejects.toMatchObject({ code: '42501' });
      const gets: string[] = [], env = { ...authEnv(), ASSETS_BUCKET: { get: async (key: string) => {
        gets.push(key); return { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }),
          size: 3, httpEtag: '"distributor"', writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', 'image/png') };
      } } } as unknown as Env;
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', createContainerFromDb(appPeer.db)); c.set('uid', 30); await next(); });
      for (const prefix of ['/api', '/api/v2']) { app.get(`${prefix}/agent/level_list`, levelList); app.get(`${prefix}/agent/level_task_list`, levelTaskList); }
      app.get('/api/assets/:id', asset);
      let signed = '';
      for (const prefix of ['/api', '/api/v2']) {
        const response = await app.request(`${prefix}/agent/level_list`, undefined, env);
        expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        const body = await response.json() as any;
        expect(body).toMatchObject({ status: 200, data: { user: { agent_level: 1 }, current_grade: 1 } });
        signed = body.data.level_list[0].image;
        expect(signed).toMatch(/^\/api\/assets\/41\?expires=\d+&signature=/);
        expect(body.data.level_list[1].image).toBe('');
        expect((await (await app.request(`${prefix}/agent/level_task_list?id=1`, undefined, env)).json() as any).data)
          .toMatchObject({ speedAll: 100, list: [{ level_id: 1, is_must: 0, finish: 1, new_number: 1 }] });
      }
      expect(gets).toEqual([]);
      const response = await app.request(signed, undefined, env);
      expect(response.status).toBe(200); expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
      expect((await app.request('/api/assets/41?expires=1&signature=invalid', undefined, env)).status).toBe(404);
      expect(gets).toEqual(['attachments/admin/1/distributor.png']);
      expect((await f.snapshot()).records.filter(row => row.uid === 30 && row.taskId === 11)).toHaveLength(1);
    });
  });

  it('holds the installed shared catalog fence through commit against a raw Admin UPDATE, with independent PID proof', async () => {
    await f.db.insert(user).values({ uid: 31, spreadUid: 30 });
    await runtime((app, admin) => f.withPeer(async observer => {
      expect(new Set([app.pid, admin.pid, observer.pid]).size).toBe(3);
      let writing: ReturnType<typeof outcome> | undefined, fenced = false;
      const execute = PostgresJsPreparedQuery.prototype.execute;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function(this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args) {
        const query = this.getQuery().sql, value = await execute.apply(this, args);
        if (!fenced && query.startsWith('insert into "agent_level_task_record"')) {
          fenced = true; writing = outcome(admin.exec("UPDATE agent_level_task SET number=2 WHERE id=11"));
          await waitForFinanceBlock(observer.db, admin.pid, app.pid);
        }
        return value;
      });
      try { await f.upgradeFor(30, app.db); } finally { vi.restoreAllMocks(); }
      expect(fenced).toBe(true); expect((await writing)?.ok).toBe(true);
      expect((await f.snapshot()).records.filter(row => row.uid === 30 && row.taskId === 11)).toHaveLength(1);
    }));
  }, 20000);

  it('serializes two real app evaluations for one uid and preserves historical idempotency without new uniqueness', async () => {
    await f.db.insert(user).values({ uid: 31, spreadUid: 30 });
    await runtime(app => sibling(app, peer => f.withPeer(async observer => {
      expect(new Set([app.pid, peer.pid, observer.pid]).size).toBe(3);
      let competing: ReturnType<typeof outcome> | undefined, seen = false;
      const execute = PostgresJsPreparedQuery.prototype.execute;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function(this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args) {
        const query = this.getQuery().sql, value = await execute.apply(this, args);
        if (!seen && query.startsWith('insert into "agent_level_task_record"')) {
          seen = true; competing = outcome(f.upgradeFor(30, peer.db));
          await waitForFinanceBlock(observer.db, peer.pid, app.pid);
        }
        return value;
      });
      try { await f.upgradeFor(30, app.db); } finally { vi.restoreAllMocks(); }
      expect(seen).toBe(true); expect((await competing)?.ok).toBe(true);
      expect((await f.snapshot()).records.filter(row => row.uid === 30 && row.taskId === 11)).toHaveLength(1);
    })));
  }, 20000);

  it('rejects the actual binding transaction row locks with 55P03 and no partial rank/records, then succeeds after its commit', async () => {
    await f.db.insert(user).values({ uid: 40, nickname: '未绑定' });
    await runtime(app => sibling(app, async consumer => {
      const before = await f.snapshot();
      let rejected = false;
      const execute = PostgresJsPreparedQuery.prototype.execute;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function(this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args) {
        const query = this.getQuery().sql, value = await execute.apply(this, args);
        if (!rejected && query.startsWith('insert into "user_spread"')) {
          rejected = true;
          const result = await outcome(f.upgradeFor(30, consumer.db));
          expect(result.ok).toBe(false);
          if (!result.ok) expect(sqlState(result.error)).toBe('55P03');
          // The independent observer sees only the pre-binding committed state.
          expect(await f.snapshot()).toEqual(before);
        }
        return value;
      });
      try { await new UserFinanceService(createContainerFromDb(app.db)).bindSpread(40, 20); }
      finally { vi.restoreAllMocks(); }
      expect(rejected).toBe(true);
      expect((await f.snapshot()).users.find(row => row.uid === 40)?.spreadUid).toBe(20);
      await f.upgradeFor(30, consumer.db);
      expect((await f.snapshot()).records.filter(row => row.uid === 20 && row.taskId === 11)).toHaveLength(1);
    }));
  }, 20000);

  it('repairs missed rank through actual password, mobile and QR verified-uid login entries, while each still rejects a forbidden identity', async () => {
    const phone = '13800000992', password = 'owned-login-password';
    await f.db.update(user).set({ account: phone, phone, pwd: md5(password) }).where(eq(user.uid, 30));
    await f.db.insert(user).values({ uid: 31, spreadUid: 30 });
    const buckets = new Map<string, TokenBucket>(), store = vi.mocked(setTokenBucket);
    store.mockImplementation(async (key, bucket) => { buckets.set(key, bucket); return true; });
    try {
      await runtime(async app => {
        const login = new LoginService(createContainerFromDb(app.db), authEnv());
        // The QR protocol has already established uid before this real entry.
        // No provider/challenge traffic is imitated by the database proof.
        const entries = [
          { channel: 'password', run: () => login.loginByPassword(phone, password, 0, '127.0.0.2') },
          { channel: 'mobile', run: () => login.loginByMobile(phone, 0, '127.0.0.2') },
          { channel: 'qr_verified_uid', run: () => login.loginByVerifiedUid(30, '127.0.0.2') },
        ];
        for (const entry of entries) {
          // Maintenance reset before EACH channel proves the result cannot be
          // a rank/record left by registration or the preceding login channel.
          await f.db.update(user).set({ agentLevel: 0 });
          await f.db.delete(agentLevelTaskRecord);
          await f.db.update(user).set({ status: 1 }).where(eq(user.uid, 30));
          buckets.clear(); store.mockClear();
          const before = await f.snapshot();
          expect(before.users.find(row => row.uid === 30)?.agentLevel, entry.channel).toBe(0);
          expect(before.records, entry.channel).toEqual([]);
          const response = await entry.run();
          expect(await verifyToken(response.token, f.env.APP_KEY), entry.channel).toMatchObject({
            id: 30, type: 'api', auth: md5(md5(password)), exp: response.expires_time,
          });
          expect(buckets.get(md5(response.token)), entry.channel).toMatchObject({ uid: 30, type: 'api', token: response.token });
          const repaired = await f.snapshot();
          expect(repaired.users.find(row => row.uid === 30), entry.channel).toMatchObject({ agentLevel: 1, lastIp: '127.0.0.2' });
          expect(repaired.records.filter(row => row.uid === 30), entry.channel).toMatchObject([{ levelId: 1, taskId: 11, status: 0 }]);
          await entry.run();
          expect((await f.snapshot()).records, entry.channel).toEqual(repaired.records);

          await f.db.update(user).set({ agentLevel: 0 });
          await f.db.delete(agentLevelTaskRecord);
          await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 30));
          buckets.clear(); store.mockClear();
          const forbidden = await f.snapshot();
          await expect(entry.run()).rejects.toThrow('已被禁止');
          expect(store, entry.channel).not.toHaveBeenCalled();
          expect(buckets.size, entry.channel).toBe(0);
          expect(await f.snapshot(), entry.channel).toEqual(forbidden);
        }
      });
    } finally { store.mockImplementation(async () => true); }
  });

  it.each([false, true])('runs actual registration and relationship hooks after commit, with upgrade failure=%s leaving durable identity and a PII-free diagnostic', async fail => {
    if (fail) await f.db.insert(agentLevel).values({ id: 99, grade: 1, name: '历史重复' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runtime(async app => {
      const container = createContainerFromDb(app.db), login = new LoginService(container, authEnv());
      const response = await login.register('13800000991', 'strong-password', 30, '127.0.0.1');
      expect(response.token).toBeTruthy();
      const [registered] = await f.db.select().from(user).where(eq(user.phone, '13800000991'));
      expect(registered.spreadUid).toBe(30);
      expect(await f.db.select().from(userSpread).where(eq(userSpread.uid, registered.uid))).toHaveLength(1);
      expect(await f.db.select().from(userFriends).where(eq(userFriends.uid, registered.uid))).toHaveLength(1);
      const [parent] = await f.db.select().from(user).where(eq(user.uid, 30));
      expect(parent.agentLevel).toBe(fail ? 0 : 1);
      // Direct existing-user bind uses the same committed relationship entry.
      await f.db.insert(user).values({ uid: 40, nickname: '既有未绑定用户' });
      await new UserFinanceService(container).bindSpread(40, 30);
      expect((await f.db.select().from(user).where(eq(user.uid, 40)))[0].spreadUid).toBe(30);
      if (fail) {
        expect(errors.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const [event] of errors.mock.calls) {
          expect(event).toMatchObject({ event: 'agent_level_registration_upgrade_failed', operation: 'agent_level_upgrade', outcome: 'failure' });
          expect(event).not.toHaveProperty('uid'); expect(event).not.toHaveProperty('phone');
          expect(JSON.stringify(event)).not.toContain('13800000991');
        }
      } else expect(errors).not.toHaveBeenCalled();
    });
  });
});
