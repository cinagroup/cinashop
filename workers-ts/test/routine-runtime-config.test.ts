import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import { createContainerFromDb, withTx } from '@/lib/di';
import { systemConfig, user } from '@/models/schema';
import { readRoutineAppId, readRoutineCredentialPresence, readRoutineCredentials, readRoutineCredentialsInTx,
  routineCredentialCacheKey, withRoutineCredentials } from '@/services/wechat/RoutineRuntimeConfig';
import { financePostgres } from './helpers/financePostgres';

const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);
const APP = 'owned-routine-app', SECRET = 'owned-routine-secret';

describe('Mini Program fresh credential source and short commit fence', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, env: Env;
  let network: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
  beforeAll(async () => { f = await financePostgres([systemConfig, user], { namespace: 'public' }); });
  afterAll(async () => { if (f) await f.close(); });
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(systemConfig).values([
      { id: 1, menuName: 'routine_appId', value: JSON.stringify(APP), sort: 5, status: 0, configTabId: 7 },
      { id: 2, menuName: 'routine_appsecret', value: JSON.stringify(SECRET), sort: 5, status: 0, configTabId: 7 },
    ]);
    env = { APP_KEY: 'owned-routine-source-signing-key', CONFIG_KV: {
      get: vi.fn(async () => { throw Error('Stale cfg_* is not a credential authority'); }),
      put: vi.fn(), delete: vi.fn(),
    } } as unknown as Env;
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Credential primitives forbid provider I/O'));
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.get).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.put).not.toHaveBeenCalled();
    expect(env.CONFIG_KV.delete).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  const container = () => createContainerFromDb(f.db);
  const current = () => readRoutineCredentials(container(), env);
  const rows = () => f.db.select({ ...getTableColumns(systemConfig), version: sql<string>`xmin::text` })
    .from(systemConfig).orderBy(systemConfig.id);

  it('reads a fresh SQL pair without cache, environment fallback or read-side writes', async () => {
    const before = await rows();
    const first = await current();
    expect(first).toEqual({ appId: APP, secret: SECRET, stamp: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(await rows()).toEqual(before);
    await f.db.update(systemConfig).set({ value: '"rotated-routine-secret"' }).where(eq(systemConfig.id, 2));
    expect(await current()).toMatchObject({ appId: APP, secret: 'rotated-routine-secret' });
    expect((await current()).stamp).not.toBe(first.stamp);
  });

  it('keeps the legacy provider whitespace normalization while preserving stored bytes', async () => {
    await f.db.update(systemConfig).set({ value: '  legacy-id  ' }).where(eq(systemConfig.id, 1));
    await f.db.update(systemConfig).set({ value: JSON.stringify('  legacy-secret\n') }).where(eq(systemConfig.id, 2));
    const before = await rows();
    expect(await current()).toMatchObject({ appId: 'legacy-id', secret: 'legacy-secret' });
    expect(await rows()).toEqual(before);
  });

  it('uses hidden sort/id winners, includes every platform shadow and ignores other realms and stores', async () => {
    await f.db.insert(systemConfig).values([
      { id: 3, menuName: 'routine_appsecret', value: 'shadow', sort: -1 },
      { id: 4, menuName: 'routine_appsecret', value: 'hidden-winner', sort: 5, status: 0 },
      { id: 5, menuName: 'routine_appsecret', value: 'store-secret', sort: 99, isStore: 1 },
      { id: 6, menuName: 'wechat_app_appsecret', value: 'native-app-secret', sort: 99 },
      { id: 7, menuName: 'wechat_open_app_secret', value: 'website-open-secret', sort: 99 },
    ]);
    const first = await current(); expect(first.secret).toBe('hidden-winner');
    await f.db.update(systemConfig).set({ info: 'updated shadow metadata' }).where(eq(systemConfig.id, 3));
    const second = await current(); expect(second.secret).toBe(first.secret); expect(second.stamp).not.toBe(first.stamp);
    await f.db.update(systemConfig).set({ value: 'another-store-secret' }).where(eq(systemConfig.id, 5));
    await f.db.update(systemConfig).set({ value: 'another-native-secret' }).where(eq(systemConfig.id, 6));
    expect((await current()).stamp).toBe(second.stamp);
  });

  it('does not revoke a pair when name/contact/avatar or another domain changes', async () => {
    const before = await current();
    await f.db.insert(systemConfig).values([
      { id: 3, menuName: 'routine_name', value: '"name"' },
      { id: 4, menuName: 'routine_contact_type', value: '1' },
      { id: 5, menuName: 'store_user_avatar', value: '1' },
      { id: 6, menuName: 'routine_auth_type', value: '1' },
    ]);
    expect(await current()).toEqual(before);
  });

  it('uses xmin to prevent A to B to A cache resurrection and separates signing keys', async () => {
    const first = await current(), firstKey = routineCredentialCacheKey(first, 'access_token');
    await f.db.update(systemConfig).set({ value: '"account-B"' }).where(eq(systemConfig.id, 1));
    const second = await current();
    await f.db.update(systemConfig).set({ value: JSON.stringify(APP) }).where(eq(systemConfig.id, 1));
    const third = await current();
    expect(third.appId).toBe(first.appId);
    expect(new Set([first.stamp, second.stamp, third.stamp]).size).toBe(3);
    expect(routineCredentialCacheKey(third, 'access_token')).not.toBe(firstKey);
    expect((await readRoutineCredentials(container(), { APP_KEY: 'other-key' })).stamp).not.toBe(third.stamp);
    expect(firstKey).toBe(`routine:v2:access_token:${first.stamp}`);
    expect(firstKey).not.toContain(APP); expect(firstKey).not.toContain(SECRET);
    expect(() => routineCredentialCacheKey({ stamp: SECRET }, 'access_token')).toThrow('来源无效');
  });

  it('reads the public AppID without a Secret or signing key and never substitutes another realm', async () => {
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 2)); env.APP_KEY = '';
    expect(await readRoutineAppId(container())).toBe(APP);
    await expect(current()).rejects.toThrow('凭据未完整配置');
    await f.db.delete(systemConfig);
    await f.db.insert(systemConfig).values([
      { id: 10, menuName: 'wechat_appid', value: 'official-id' },
      { id: 11, menuName: 'wechat_app_appid', value: 'native-id' },
      { id: 12, menuName: 'wechat_open_app_id', value: 'open-id' },
      { id: 13, menuName: 'routine_appId', value: 'store-id', isStore: 1 },
    ]);
    expect(await readRoutineAppId(container())).toBe('');
  });

  it('projects independent SQL presence without APP_KEY, credential values, cache or read-side writes', async () => {
    env.APP_KEY = '';
    const before = await rows();
    expect(await readRoutineCredentialPresence(container())).toEqual({ appIdConfigured: true, secretConfigured: true });
    expect(await rows()).toEqual(before);
    await f.db.delete(systemConfig).where(eq(systemConfig.id, 2));
    expect(await readRoutineCredentialPresence(container())).toEqual({ appIdConfigured: true, secretConfigured: false });
    await f.db.delete(systemConfig);
    await f.db.insert(systemConfig).values([
      { id: 10, menuName: 'routine_appId', value: 'store-id', isStore: 1 },
      { id: 11, menuName: 'wechat_appid', value: 'other-realm-id' },
      { id: 12, menuName: 'routine_appsecret', value: ' secret-only ' },
    ]);
    expect(await readRoutineCredentialPresence(container())).toEqual({ appIdConfigured: false, secretConfigured: true });
  });

  it.each(['', '  ', 'null', '{}', '["secret"]', '"unterminated', '"\\ud800"'])('does not substitute a shadow for the malformed or empty presence winner %j', async raw => {
    env.APP_KEY = '';
    await f.db.insert(systemConfig).values([
      { id: 3, menuName: 'routine_appsecret', value: raw, sort: 5, status: 0 },
      { id: 4, menuName: 'routine_appsecret', value: 'store-secret', sort: 99, isStore: 1 },
    ]);
    const before = await rows();
    expect(await readRoutineCredentialPresence(container())).toEqual({ appIdConfigured: true, secretConfigured: false });
    expect(await rows()).toEqual(before);
  });

  it.each(['null', '{}', '["secret"]', '"unterminated', '"\\ud800"'])('refuses unusable stored credential %j', async raw => {
    await f.db.update(systemConfig).set({ value: raw }).where(eq(systemConfig.id, 2));
    const before = await rows();
    await expect(current()).rejects.toThrow('凭据未完整配置');
    expect(await rows()).toEqual(before);
  });

  it('rejects the 65th source row instead of truncating shadows', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 62 }, (_, i) => ({
      id: i + 3, menuName: 'routine_appsecret', value: 'shadow', sort: -1,
    })));
    expect((await current()).secret).toBe(SECRET);
    expect(await readRoutineCredentialPresence(container())).toEqual({ appIdConfigured: true, secretConfigured: true });
    await f.db.insert(systemConfig).values({ id: 65, menuName: 'routine_appsecret', value: 'last-shadow', sort: -1 });
    await expect(current()).rejects.toThrow('完整读取容量');
    await expect(readRoutineAppId(container())).rejects.toThrow('完整读取容量');
    await expect(readRoutineCredentialPresence(container())).rejects.toThrow('完整读取容量');
  });

  it('rejects an oversized complete UTF8 source even when every SQL value fits varchar5000', async () => {
    await f.db.insert(systemConfig).values(Array.from({ length: 62 }, (_, i) => ({
      id: i + 3, menuName: 'routine_appsecret', value: '😀'.repeat(4990), sort: -1,
    })));
    expect(await f.db.select({ id: systemConfig.id }).from(systemConfig)).toHaveLength(64);
    await expect(current()).rejects.toThrow('完整读取容量');
    await expect(readRoutineAppId(container())).rejects.toThrow('完整读取容量');
    await expect(readRoutineCredentialPresence(container())).rejects.toThrow('完整读取容量');
  });

  it('rejects old sources before an identity action and rolls back a post-action source mutation', async () => {
    const old = await current(), action = vi.fn();
    await f.db.update(systemConfig).set({ value: 'next-secret' }).where(eq(systemConfig.id, 2));
    await expect(withRoutineCredentials(container(), env, old.stamp, action)).rejects.toThrow('配置已变化');
    expect(action).not.toHaveBeenCalled();
    const now = await current(), before = await rows();
    await expect(withRoutineCredentials(container(), env, now.stamp, async bound => {
      await bound.db.insert(user).values({ uid: 77, account: 'owned-routine-action' });
      await bound.db.update(systemConfig).set({ value: 'in-action-rotation' }).where(eq(systemConfig.id, 2));
    })).rejects.toThrow('配置已变化');
    expect(await rows()).toEqual(before);
    expect(await f.db.select({ uid: user.uid }).from(user)).toEqual([]);
  });

  it.runIf(native)('PG16 one snapshot keeps its pair across a real independent atomic rotation', async () => {
    await withTx(container(), async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const [firstSession] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      const before = await readRoutineCredentialsInTx(tx, env);
      await withTx(container(), async peer => {
        const [secondSession] = await peer.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        expect(secondSession.pid).not.toBe(firstSession.pid);
        await peer.update(systemConfig).set({ value: '"atomic-next-id"' }).where(eq(systemConfig.id, 1));
        await peer.update(systemConfig).set({ value: '"atomic-next-secret"' }).where(eq(systemConfig.id, 2));
      });
      expect(await readRoutineCredentialsInTx(tx, env)).toEqual(before);
    });
    expect(await current()).toMatchObject({ appId: 'atomic-next-id', secret: 'atomic-next-secret' });
  });

  it.runIf(native)('PG16 shared credential gate excludes an independent author and permits unrelated Native App work', async () => {
    const before = await current();
    await withRoutineCredentials(container(), env, before.stamp, async bound => {
      const [owner] = await bound.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      await withTx(container(), async peer => {
        const [session] = await peer.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        expect(session.pid).not.toBe(owner.pid);
        const [locks] = await peer.execute(sql`SELECT pg_try_advisory_xact_lock(731666,0) AS author,
          pg_try_advisory_xact_lock_shared(731666,0) AS reader,pg_try_advisory_xact_lock(731664,0) AS native_app`);
        expect(locks).toEqual({ author: false, reader: true, native_app: true });
      });
      await withTx(bound, async nested => { await nested.insert(user).values({ uid: 77, account: 'owned-routine-commit' }); });
    });
    expect(await f.db.select({ uid: user.uid }).from(user)).toEqual([{ uid: 77 }]);
    await withTx(container(), async owner => {
      await owner.execute(sql`SELECT pg_advisory_xact_lock(731666,0)`);
      const action = vi.fn();
      await expect(withRoutineCredentials(container(), env, before.stamp, action)).rejects.toThrow('正在维护');
      expect(action).not.toHaveBeenCalled();
    });
    expect(await withRoutineCredentials(container(), env, before.stamp, async () => 'released')).toBe('released');
  });
});
