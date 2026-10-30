import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Env } from '../src/env';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { systemConfig, user } from '../src/models/schema';
import { readNativeAppAppId, readNativeAppCredentials, readNativeAppCredentialsInTx,
  withNativeAppCredentials } from '../src/services/wechat/NativeAppRuntimeConfig';
import { financePostgres } from './helpers/financePostgres';

const APP = 'owned-native-app-id', SECRET = 'owned-native-app-secret';
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const keys = ['wechat_app_appid', 'wechat_app_appsecret'] as const;

// Ordinary SQL cases use the owned PGlite fixture unless the native runner
// supplies its dedicated PG16 URL. Independent-session evidence is native-only;
// this suite does not claim to exercise an App OAuth or payment SDK consumer.
describe('Native App fresh SQL credentials and fenced transaction primitive', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => {
    // This fixture uses public so it can share the native contract with the commissioned-role suite.
    f = await financePostgres([systemConfig, user], { namespace: 'public' });
  });
  afterAll(async () => { if (f) await f.close(); });
  beforeEach(async () => {
    env = { APP_KEY: 'owned-native-app-runtime-key', CONFIG_KV: {
      get: vi.fn(async () => { throw Error('Native App must not read cfg_* cache'); }),
      put: vi.fn(), delete: vi.fn(),
    } } as unknown as Env;
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Runtime primitive must not contact a provider'));
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: keys[0], value: JSON.stringify(APP), sort: 5, status: 0, configTabId: 73 },
      { id: 2, menuName: keys[1], value: JSON.stringify(SECRET), sort: 5, status: 0, configTabId: 73 },
    ]);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const container = () => createContainerFromDb(f.db);
  const credentials = () => readNativeAppCredentials(container(), env);
  const rows = () => f.db.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` })
    .from(systemConfig).orderBy(asc(systemConfig.id));
  const noIo = () => {
    expect(network).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
  };
  async function nativeIdentity(tx: DbClient) {
    const [identity] = await tx.execute<{ database: string; role: string; session: string; major: number; pid: number }>(sql`
      SELECT current_database() AS database,current_user AS role,session_user AS session,
        current_setting('server_version_num')::integer / 10000 AS major,pg_backend_pid() AS pid`);
    expect(identity).toMatchObject({ role: 'finance_test', session: 'finance_test', major: 16 });
    expect(identity.database).toMatch(/^finance_fixture_[a-f0-9]{32}$/u);
    expect(Number.isSafeInteger(identity.pid)).toBe(true);
    return identity;
  }

  it('reads both JSON-normalized platform fields fresh without cache, network or read-side DML', async () => {
    const before = await rows(), first = await credentials();
    expect(first).toEqual({ appId: APP, secret: SECRET, stamp: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(await rows()).toEqual(before);
    await f.db.update(systemConfig).set({ value: JSON.stringify('next-native-secret') }).where(eq(systemConfig.id, 2));
    const second = await credentials();
    expect(second).toMatchObject({ appId: APP, secret: 'next-native-secret' });
    expect(second.stamp).not.toBe(first.stamp);
    expect((await readNativeAppCredentials(container(), { APP_KEY: 'next-owned-signing-key' })).stamp).not.toBe(second.stamp);
    noIo();
  });

  it('public AppID reads need neither an AppSecret row nor an APP_KEY and still observe fresh SQL', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 2)); env.APP_KEY = '';
    const before = await rows();
    expect(await readNativeAppAppId(container())).toBe(APP);
    expect(await rows()).toEqual(before);
    await f.db.update(systemConfig).set({ value: 'next-public-app-id' }).where(eq(systemConfig.id, 1));
    expect(await readNativeAppAppId(container())).toBe('next-public-app-id');
    await expect(credentials()).rejects.toThrow('凭据未完整配置');
    noIo();
  });

  it('does not substitute deployment, website Open, official-account, routine or store credentials', async () => {
    await f.db.delete(systemConfig);
    Object.assign(env, { WECHAT_APP_APPID: 'env-native-id', WECHAT_APP_APPSECRET: 'env-native-secret',
      WECHAT_OPEN_APP_ID: 'env-open-id', WECHAT_OPEN_APP_SECRET: 'env-open-secret',
      WECHAT_APP_ID: 'env-official-id', WECHAT_APP_SECRET: 'env-official-secret' });
    await f.db.insert(systemConfig).values([
      { id: 10, menuName: 'wechat_open_app_id', value: 'open-id' },
      { id: 11, menuName: 'wechat_open_app_secret', value: 'open-secret' },
      { id: 12, menuName: 'wechat_appid', value: 'official-id' },
      { id: 13, menuName: 'wechat_appsecret', value: 'official-secret' },
      { id: 14, menuName: 'routine_appId', value: 'routine-id' },
      { id: 15, menuName: 'routine_appsecret', value: 'routine-secret' },
      { id: 16, menuName: keys[0], value: 'store-app-id', sort: 999, isStore: 1 },
      { id: 17, menuName: keys[1], value: 'store-app-secret', sort: 999, isStore: 1 },
    ]);
    const before = await rows();
    expect(await readNativeAppAppId(container())).toBe('');
    await expect(credentials()).rejects.toThrow('凭据未完整配置');
    expect(await rows()).toEqual(before); noIo();
  });

  it('keeps bounded legacy text exactly without importing Open AppID or 256-character Secret rules', async () => {
    const appId = ' legacy optional AppID ', secret = ' s'.repeat(300) + '\n';
    await f.db.update(systemConfig).set({ value: appId }).where(eq(systemConfig.id, 1));
    await f.db.update(systemConfig).set({ value: JSON.stringify(secret) }).where(eq(systemConfig.id, 2));
    expect(await credentials()).toMatchObject({ appId, secret });
    expect(await readNativeAppAppId(container())).toBe(appId); noIo();
  });

  it('uses sort then id including hidden winners and binds every platform shadow metadata/xmin', async () => {
    await f.db.insert(systemConfig).values([
      { id: 10, menuName: keys[1], value: 'store-secret', sort: 999, isStore: 1 },
      { id: 11, menuName: keys[1], value: 'shadow-secret', sort: -1, configTabId: 99 },
      { id: 12, menuName: keys[1], value: 'hidden-id-winner', sort: 5, status: 0 },
      { id: 13, menuName: keys[1], value: 'lower-sort-higher-id', sort: 4, status: 1 },
      { id: 14, menuName: 'wechat_open_app_secret', value: 'separate-open-secret' },
    ]);
    const first = await credentials(); expect(first.secret).toBe('hidden-id-winner');
    await f.db.update(systemConfig).set({ desc: 'changed shadow metadata' }).where(eq(systemConfig.id, 11));
    const second = await credentials(); expect(second.secret).toBe(first.secret); expect(second.stamp).not.toBe(first.stamp);
    await f.db.update(systemConfig).set({ value: 'shadow-secret' }).where(eq(systemConfig.id, 11));
    const third = await credentials(); expect(third.secret).toBe(first.secret); expect(third.stamp).not.toBe(second.stamp);
    await f.db.update(systemConfig).set({ value: 'changed-store-secret' }).where(eq(systemConfig.id, 10));
    await f.db.update(systemConfig).set({ value: 'changed-open-secret' }).where(eq(systemConfig.id, 14));
    expect((await credentials()).stamp).toBe(third.stamp);
    await f.db.update(systemConfig).set({ sort: 6 }).where(eq(systemConfig.id, 2));
    expect((await credentials()).secret).toBe(SECRET); noIo();
  });

  it('accepts all 64 source rows but rejects the 65th rather than truncating either public or credential reads', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 62 }, (_, index) => ({
      id: 10 + index, menuName: keys[1], value: 'shadow', sort: -1,
    })));
    expect(await rows()).toHaveLength(64);
    expect(await credentials()).toMatchObject({ appId: APP, secret: SECRET });
    expect(await readNativeAppAppId(container())).toBe(APP);
    await f.db.insert(systemConfig).values({ id: 100, menuName: keys[1], value: '65th shadow', sort: -1 });
    expect(await rows()).toHaveLength(65);
    await expect(credentials()).rejects.toThrow('完整读取容量');
    await expect(readNativeAppAppId(container())).rejects.toThrow('完整读取容量'); noIo();
  });

  it('rejects a complete 64-row snapshot larger than 1MiB even when its two winners remain small', async () => {
    // Each value satisfies varchar(5000)'s character bound; their real complete
    // UTF-8 snapshot exceeds the runtime byte bound without fabricating rows.
    await f.db.insert(systemConfig).values(Array.from({ length: 62 }, (_, index) => ({
      id: 10 + index, menuName: keys[1], value: '😀'.repeat(5000), sort: -1,
    })));
    const complete = await rows(); expect(complete).toHaveLength(64);
    expect(new TextEncoder().encode(JSON.stringify(complete)).byteLength).toBeGreaterThan(1024 * 1024);
    await expect(credentials()).rejects.toThrow('完整读取容量');
    await expect(readNativeAppAppId(container())).rejects.toThrow('完整读取容量'); noIo();
  });

  it.each(keys)('refuses missing %s without cached or provider recovery', async key => {
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, key));
    await expect(credentials()).rejects.toThrow('凭据未完整配置');
    expect(await readNativeAppAppId(container())).toBe(key === keys[0] ? '' : APP); noIo();
  });
  it.each(keys.flatMap(key => ['', '""', '{broken', '[]', 'true', '123', '"\\ud800"'].map(value => [key, value] as const)))(
    'refuses empty or malformed %s value %j without side effects', async (key, value) => {
      await f.db.update(systemConfig).set({ value }).where(eq(systemConfig.menuName, key));
      const before = await rows(); await expect(credentials()).rejects.toThrow('凭据未完整配置');
      expect(await rows()).toEqual(before);
      expect(await readNativeAppAppId(container())).toBe(key === keys[0] ? '' : APP); noIo();
    });

  it('requires an APP_KEY only for a usable credential stamp', async () => {
    env.APP_KEY = '';
    await expect(credentials()).rejects.toThrow('运行时签名尚未配置');
    expect(await readNativeAppAppId(container())).toBe(APP); noIo();
  });
  it.each(['', '0'.repeat(63), 'A'.repeat(64), 'not-a-credential-stamp'])(
    'rejects invalid expected stamp %j before opening SQL or invoking the action', async stamp => {
      const action = vi.fn(), transaction = vi.spyOn(f.db, 'transaction');
      await expect(withNativeAppCredentials(container(), env, stamp, action)).rejects.toThrow('配置已变化');
      expect(action).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled(); noIo();
    });
  it('rejects a well-formed stale stamp before invoking any identity action', async () => {
    const first = await credentials(), action = vi.fn();
    await f.db.update(systemConfig).set({ value: 'rotated-native-secret' }).where(eq(systemConfig.id, 2));
    await expect(withNativeAppCredentials(container(), env, first.stamp, action)).rejects.toThrow('配置已变化');
    expect(action).not.toHaveBeenCalled(); expect(await f.db.select().from(user)).toEqual([]); noIo();
  });

  it('uses one outer connection and nested SAVEPOINTs so a late action failure rolls back actual DAO-visible SQL', async () => {
    const current = await credentials(), root = container(), transaction = vi.spyOn(f.db, 'transaction');
    await expect(withNativeAppCredentials(root, env, current.stamp, async (bound, pair) => {
      expect(bound.db).not.toBe(root.db); expect(pair).toEqual(current);
      const [outer] = await bound.db.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
      const nested = await withTx(bound, async tx => {
        const [identity] = await tx.execute<{ id: string }>(sql`SELECT txid_current()::text AS id`);
        await tx.insert(user).values({ uid: 77, account: 'owned-native-app-rollback' });
        return identity.id;
      });
      expect(nested).toBe(outer.id);
      expect(await bound.userDao.findForAuth(77)).toHaveProperty('uid', 77);
      throw Error('owned Native App outer rollback');
    })).rejects.toThrow('owned Native App outer rollback');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await f.db.select().from(user)).toEqual([]);
    expect((await credentials()).stamp).toBe(current.stamp); noIo();
  });

  it('rolls back only a failed nested SAVEPOINT and commits the surviving outer action with its unchanged pair', async () => {
    const current = await credentials();
    const result = await withNativeAppCredentials(container(), env, current.stamp, async bound => {
      await expect(withTx(bound, async tx => {
        await tx.insert(user).values({ uid: 77, account: 'owned-native-app-inner-rollback' });
        throw Error('owned Native App inner rollback');
      })).rejects.toThrow('owned Native App inner rollback');
      expect(await bound.userDao.findForAuth(77)).toBeNull();
      await bound.db.insert(user).values({ uid: 78, account: 'owned-native-app-committed' });
      return { uid: 78 };
    });
    expect(result).toEqual({ uid: 78 });
    expect(await f.db.select({ uid: user.uid }).from(user)).toEqual([{ uid: 78 }]);
    expect((await credentials()).stamp).toBe(current.stamp); noIo();
  });

  it.each(['winner', 'shadow'] as const)('rechecks the final stamp after an actual %s write and rolls back the source and action together', async mode => {
    if (mode === 'shadow') await f.db.insert(systemConfig).values({ id: 10, menuName: keys[1], value: 'shadow', sort: -1 });
    const before = await rows(), current = await credentials();
    await expect(withNativeAppCredentials(container(), env, current.stamp, async bound => {
      await bound.db.insert(user).values({ uid: 77, account: 'owned-native-app-post-stamp' });
      await bound.db.update(systemConfig).set(mode === 'winner' ? { value: 'in-action-rotation' } : { info: 'in-action-shadow-metadata' })
        .where(eq(systemConfig.id, mode === 'winner' ? 2 : 10));
      return 'must-not-publish';
    })).rejects.toThrow('配置已变化');
    expect(await rows()).toEqual(before); expect(await f.db.select().from(user)).toEqual([]);
    expect((await credentials()).stamp).toBe(current.stamp); noIo();
  });

  it.runIf(native)('PG16 exclusive731664 refuses the production shared gate and releases it at owner rollback', async () => {
    const current = await credentials(), action = vi.fn();
    await expect(withTx(container(), async owner => {
      const held = await nativeIdentity(owner);
      const [lock] = await owner.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(731664,0) AS locked`);
      expect(lock.locked).toBe(true);
      // A separate pool session is demonstrated while the owner transaction is
      // still active. The production wrapper must not run its action under it.
      await withTx(container(), async observer => { expect((await nativeIdentity(observer)).pid).not.toBe(held.pid); });
      await expect(withNativeAppCredentials(container(), env, current.stamp, action)).rejects.toThrow('配置正在维护');
      expect(action).not.toHaveBeenCalled();
      throw Error('owned exclusive App gate rollback');
    })).rejects.toThrow('owned exclusive App gate rollback');
    await expect(withNativeAppCredentials(container(), env, current.stamp, async () => 'after-owner-rollback')).resolves.toBe('after-owner-rollback');
    noIo();
  });

  it.runIf(native)('PG16 production shared731664 excludes an independent author but coexists with another shared reader and Open731661', async () => {
    const current = await credentials(), before = await rows();
    await withNativeAppCredentials(container(), env, current.stamp, async bound => {
      const held = await nativeIdentity(bound.db);
      await withTx(container(), async peer => {
        expect((await nativeIdentity(peer)).pid).not.toBe(held.pid);
        const [locks] = await peer.execute<{ exclusive: boolean; shared: boolean; open: boolean }>(sql`
          SELECT pg_try_advisory_xact_lock(731664,0) AS exclusive,
            pg_try_advisory_xact_lock_shared(731664,0) AS shared,
            pg_try_advisory_xact_lock(731661,0) AS open`);
        expect(locks).toEqual({ exclusive: false, shared: true, open: true });
      });
    });
    await withTx(container(), async peer => {
      const [released] = await peer.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(731664,0) AS locked`);
      expect(released.locked).toBe(true);
    });
    expect(await rows()).toEqual(before); noIo();
  });

  it.runIf(native)('PG16 Open731661 alone permits App commit; a later source change invalidates the old stamp', async () => {
    const current = await credentials(), before = await rows();
    await withTx(container(), async openOwner => {
      const held = await nativeIdentity(openOwner);
      await openOwner.execute(sql`SELECT pg_advisory_xact_lock(731661,0)`);
      await withNativeAppCredentials(container(), env, current.stamp, async bound => {
        expect((await nativeIdentity(bound.db)).pid).not.toBe(held.pid);
        await bound.db.insert(user).values({ uid: 79, account: 'owned-native-app-under-open-gate' });
      });
    });
    expect(await f.db.select({ uid: user.uid }).from(user)).toEqual([{ uid: 79 }]);
    expect(await rows()).toEqual(before);
    await f.db.update(systemConfig).set({ value: 'after-App-commit' }).where(eq(systemConfig.id, 1));
    expect(await readNativeAppAppId(container())).toBe('after-App-commit');
    const action = vi.fn();
    await expect(withNativeAppCredentials(container(), env, current.stamp, action)).rejects.toThrow('配置已变化');
    expect(action).not.toHaveBeenCalled(); noIo();
  });

  it.runIf(native)('PG16 unrelated config RowExclusive DML does not require a forbidden runtime SHARE table lock', async () => {
    await f.db.insert(systemConfig).values({ id: 90, menuName: 'site_name', value: 'old unrelated name' });
    const current = await credentials();
    await withTx(container(), async ordinaryWriter => {
      const held = await nativeIdentity(ordinaryWriter);
      await ordinaryWriter.update(systemConfig).set({ value: 'new unrelated name' }).where(eq(systemConfig.id, 90));
      const result = await withNativeAppCredentials(container(), env, current.stamp, async bound => {
        expect((await nativeIdentity(bound.db)).pid).not.toBe(held.pid);
        return 'unchanged App source';
      });
      expect(result).toBe('unchanged App source');
    });
    expect((await credentials()).stamp).toBe(current.stamp); noIo();
  });

  it.runIf(native)('PG16 InTx pair remains one repeatable-read snapshot across an independent atomic pair rotation', async () => {
    let first: Awaited<ReturnType<typeof credentials>> | undefined;
    await withTx(container(), async reader => {
      await reader.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const readSession = await nativeIdentity(reader);
      first = await readNativeAppCredentialsInTx(reader, env);
      await withTx(container(), async writer => {
        expect((await nativeIdentity(writer)).pid).not.toBe(readSession.pid);
        await writer.update(systemConfig).set({ value: 'next-atomic-app-id' }).where(eq(systemConfig.id, 1));
        await writer.update(systemConfig).set({ value: 'next-atomic-secret' }).where(eq(systemConfig.id, 2));
      });
      expect(await readNativeAppCredentialsInTx(reader, env)).toEqual(first);
      expect(first).toMatchObject({ appId: APP, secret: SECRET });
    });
    const next = await credentials(); expect(next).toMatchObject({ appId: 'next-atomic-app-id', secret: 'next-atomic-secret' });
    expect(next.stamp).not.toBe(first!.stamp); noIo();
  });
});
