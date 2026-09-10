import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { adminConfigSave } from '../src/controllers/api/v1/AdminCrudController';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { adminAuthMiddleware } from '../src/middleware/admin-auth';
import { createToken, md5 } from '../src/utils/jwt';
import { systemConfig, systemAdmin, systemRole, storeOrderCartInfo, storeOrderStatus, printDocument } from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { withFinancePeers, waitForFinanceBlock, type FinancePeer } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['columns', 'orm'] as const)('admin config batch through real auth/SQL (%s)', mode => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>> | undefined;
  let token: string;
  let deletes: string[];
  const input = { cartIds: [1], addressId: 11, type: 0 };
  const app = (db: DbClient) => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', createContainerFromDb(db)); c.set('uid', 11); await next(); });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.post('/api/admin/config/save', adminAuthMiddleware(), adminConfigSave);
    app.post('/api/order/create/:key', orderCreate);
    return app;
  };
  const save = async (body: unknown, db = f.db, jwt = token, raw = false) => {
    const response = await app(db).request('/api/admin/config/save', { method: 'POST', headers: {
      'content-type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    }, body: raw ? String(body) : JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string }>;
  };
  const snapshot = async () => ({ configs: await f.db.select().from(systemConfig).orderBy(systemConfig.id), ...await f.snapshot() });
  const quote = async () => {
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-fixture-user': '11',
    }, body: JSON.stringify(input) }, f.env);
    const result = await response.json<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; priceGroup: { pay_postage: string } } }>();
    expect(result.status, result.msg).toBe(200); return result.data;
  };
  const buy = async (db: DbClient, receipt: Awaited<ReturnType<typeof quote>>) => {
    const response = await app(db).request(`/api/order/create/${receipt.orderKey}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, quoteToken: receipt.quoteToken }) }, f.env);
    return response.json() as Promise<{ status: number; msg: string }>;
  };
  const peers = async (run: (peers: [FinancePeer, FinancePeer, FinancePeer]) => Promise<void>) => {
    if (!owned) return withFinancePeers(f.db, run);
    const connect = owned.withPeer!;
    await connect(a => connect(b => connect(c => run([a, b, c]))));
  };
  beforeEach(async () => {
    owned = undefined; deletes = [];
    f = await createPcCheckoutQuoteFixture([systemAdmin, systemRole, storeOrderCartInfo, storeOrderStatus, printDocument], mode === 'orm' ? async () => {
      const db = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
        await db.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
        owned = db; return db;
      } catch (error) { await db.close(); throw error; }
    } : undefined);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    f.env.APP_KEY = 'isolated-admin-config-test-key-not-production';
    f.env.CONFIG_KV.delete = async key => { deletes.push(key); };
    // Real middleware/JWT/account checks, but synthetic identities and local KV;
    // no password-login endpoint, Redis token bucket or production role claim.
    await f.db.insert(systemAdmin).values({ id: 1, account: 'isolated-config-admin', pwd: 'fixture-hash', level: 0, status: 1, adminType: 1 });
    token = (await createToken(1, 'admin', md5('fixture-hash'), f.env.APP_KEY)).token;
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('config_batch_order') }) } });
  }, 120_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 120_000);

  it('does not commit the first value when a later value exceeds the PostgreSQL limit', async () => {
    const before = await snapshot();
    expect((await save({ whole_free_shipping: '1', store_free_postage: '1'.repeat(5001) })).status).toBe(400);
    expect(await snapshot()).toEqual(before); expect(deletes).toEqual([]);
  });
  it('rolls back every value on a real late database failure without invalidating KV', async () => {
    await f.exec("CREATE FUNCTION reject_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.menu_name='store_free_postage' THEN RAISE EXCEPTION 'synthetic config failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_config BEFORE UPDATE ON system_config FOR EACH ROW EXECUTE FUNCTION reject_config()");
    const before = await snapshot();
    expect((await save({ whole_free_shipping: '1', store_free_postage: '50' })).status).toBe(400);
    expect(await snapshot()).toEqual(before); expect(deletes).toEqual([]);
  });
  it('updates the effective global winner without changing losers, store rows or metadata', async () => {
    await f.db.insert(systemConfig).values([
      { id: 100, menuName: 'whole_free_shipping', value: '0', sort: 10, status: 0, info: 'retained' },
      { id: 101, menuName: 'whole_free_shipping', value: '0', sort: 10, status: 0, info: 'winner' },
      { id: 102, menuName: 'whole_free_shipping', value: 'store-value', isStore: 1, sort: 999 },
    ]);
    const before = await snapshot(); expect((await save({ whole_free_shipping: '1' })).status).toBe(200);
    const after = await snapshot(); expect(after.configs).toEqual(before.configs.map(row => row.id === 101 ? { ...row, value: '1' } : row));
    expect(await f.container.systemConfigDao.getValue('whole_free_shipping')).toBe('1');
  });
  it('inserts a missing global key even if only a store-scoped key exists', async () => {
    await f.db.insert(systemConfig).values({ menuName: 'isolated_key', isStore: 1, value: 'store' });
    expect((await save({ isolated_key: 'global' })).status).toBe(200);
    expect(await f.container.systemConfigDao.getValue('isolated_key')).toBe('global');
    expect(await f.container.systemConfigDao.getValue('isolated_key', 1)).toBe('store');
  });
  it.each(['null', '[]', '{', '{"whole_free_shipping":true}', '{"whole_free_shipping":null}', '{"": "x"}'])(
    'rejects invalid flat-string payload before writing (%s)', async raw => {
      const before = await snapshot(); expect((await save(raw, f.db, token, true)).status).toBe(400);
      expect(await snapshot()).toEqual(before); expect(deletes).toEqual([]);
    });
  it('invalidates all keys only after the full SQL batch has committed', async () => {
    f.env.CONFIG_KV.delete = async key => {
      expect(await f.container.systemConfigDao.getValue('whole_free_shipping')).toBe('1');
      expect(await f.container.systemConfigDao.getValue('store_free_postage')).toBe('50'); deletes.push(key);
    };
    expect((await save({ whole_free_shipping: '1', store_free_postage: '50' })).status).toBe(200);
    expect(deletes.sort()).toEqual(['cfg_store_free_postage', 'cfg_whole_free_shipping']);
  });
  it('reports committed SQL explicitly and attempts every invalidation after a KV failure', async () => {
    f.env.CONFIG_KV.delete = async key => { deletes.push(key); if (key === 'cfg_whole_free_shipping') throw new Error('local KV failure'); };
    const result = await save({ whole_free_shipping: '1', store_free_postage: '50' });
    expect(result).toMatchObject({ status: 400 }); expect(result.msg).toContain('配置已保存');
    expect(await f.container.systemConfigDao.getValue('whole_free_shipping')).toBe('1');
    expect(await f.container.systemConfigDao.getValue('store_free_postage')).toBe('50'); expect(deletes).toHaveLength(2);
  });
  it('allows 5000 Unicode characters and refuses 101 keys atomically', async () => {
    expect((await save({ isolated_unicode: '😀'.repeat(5000) })).status).toBe(200);
    expect(await f.container.systemConfigDao.getValue('isolated_unicode')).toBe('😀'.repeat(5000));
    const before = await snapshot(); deletes = [];
    expect((await save(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k_${i}`, '0'])))).status).toBe(400);
    expect(await snapshot()).toEqual(before); expect(deletes).toEqual([]);
  });
  it('refuses an oversized request body without SQL or KV changes', async () => {
    const before = await snapshot(); expect((await save(' '.repeat(128 * 1024) + '{}', f.db, token, true)).status).toBe(400);
    expect(await snapshot()).toEqual(before); expect(deletes).toEqual([]);
  });
  it('respects the prefixed KV key byte limit before committing SQL', async () => {
    const key = '界'.repeat(169) + 'a';
    expect((await save({ [key]: 'valid' })).status).toBe(200);
    const before = await snapshot(); deletes = [];
    expect((await save({ [key + 'b']: 'invalid' })).status).toBe(400);
    expect(await snapshot()).toEqual(before); expect(deletes).toEqual([]);
  });
  it('writes 100 keys with two client DML statements and at most 100 readback rows', async () => {
    const body = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`batch_${i}`, String(i)]));
    const execute = PostgresJsPreparedQuery.prototype.execute;
    let writes = 0, readbackRows = -1;
    vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function (this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args) {
      const statement = this.getQuery().sql, result = await execute.apply(this, args);
      if (/\b(?:UPDATE|INSERT INTO) "system_config"/.test(statement)) writes++;
      if (statement.startsWith('select distinct on') && statement.includes('"system_config"') && Array.isArray(result)) readbackRows = result.length;
      return result;
    });
    try { expect((await save(body)).status).toBe(200); } finally { vi.restoreAllMocks(); }
    expect(writes).toBe(2); expect(readbackRows).toBe(100); expect(deletes).toHaveLength(100);
    expect(await f.container.systemConfigDao.getValues(Object.keys(body))).toEqual(body);
  });
  it('rolls back trigger-induced readback drift before any cache invalidation', async () => {
    await f.exec("CREATE FUNCTION drift_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.value='drift'; RETURN NEW; END $$; CREATE TRIGGER drift_config BEFORE UPDATE ON system_config FOR EACH ROW EXECUTE FUNCTION drift_config()");
    const before = await snapshot(); expect(await save({ whole_free_shipping: '1' })).toMatchObject({ status: 400, msg: '配置回读不一致' });
    expect(await snapshot()).toEqual(before); expect(deletes).toEqual([]);
  });
  it('serializes concurrent insertion of a missing key without duplicate winners', async () => {
    await f.exec("CREATE FUNCTION pause_insert_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(981234,2); RETURN NEW; END $$; CREATE TRIGGER pause_insert_config BEFORE INSERT ON system_config FOR EACH ROW EXECUTE FUNCTION pause_insert_config()");
    await peers(async ([holder, first, second]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(981234,2)');
      const a = save({ new_concurrent_key: 'first' }, first.db);
      await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const b = save({ new_concurrent_key: 'second' }, second.db);
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await holder.exec('COMMIT'); expect((await a).status).toBe(200); expect((await b).status).toBe(200);
    });
    expect(await f.db.select({ value: systemConfig.value }).from(systemConfig).where(eq(systemConfig.menuName, 'new_concurrent_key'))).toEqual([{ value: 'second' }]);
  }, 15_000);
  it('keeps real anonymous and view-only admin authorization before writes', async () => {
    const before = await snapshot(); expect((await save({ whole_free_shipping: '1' }, f.db, '')).status).toBe(400);
    await f.db.insert(systemRole).values({ id: 1, rules: 'config.view', status: 1 });
    await f.db.update(systemAdmin).set({ level: 1, roles: '1' }).where(eq(systemAdmin.id, 1));
    expect((await save({ whole_free_shipping: '1' })).status).toBe(400); expect(await snapshot()).toEqual(before);
    await f.db.update(systemRole).set({ rules: 'config.manage' }).where(eq(systemRole.id, 1));
    expect((await save({ whole_free_shipping: '1' })).status).toBe(200);
  });
  it('rejects an old checkout receipt after a real committed admin policy change', async () => {
    const receipt = await quote(); expect((await save({ whole_free_shipping: '1' })).status).toBe(200);
    const before = await snapshot(); expect((await buy(f.db, receipt)).status).toBe(400); expect(await snapshot()).toEqual(before);
  });
  it('holds the whole batch uncommitted while blocked and rejects concurrent checkout', async () => {
    const receipt = await quote();
    await f.exec("CREATE FUNCTION pause_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(981234,1); RETURN NEW; END $$; CREATE TRIGGER pause_config BEFORE UPDATE ON system_config FOR EACH ROW EXECUTE FUNCTION pause_config()");
    await peers(async ([holder, writer, buyer]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(981234,1)');
      const saving = save({ whole_free_shipping: '1', store_free_postage: '50' }, writer.db);
      await waitForFinanceBlock(f.db, writer.pid, holder.pid);
      expect(await f.container.systemConfigDao.getValue('whole_free_shipping')).toBe('0'); expect(deletes).toEqual([]);
      expect((await buy(buyer.db, receipt)).status).toBe(400); expect((await f.snapshot()).orders).toHaveLength(0);
      await holder.exec('COMMIT'); expect((await saving).status).toBe(200);
    });
  }, 15_000);
  it.each(['commit', 'rollback'] as const)('waits for checkout %s before atomically saving the actual admin batch', async ending => {
    const receipt = await quote(); let saving: ReturnType<typeof save> | undefined;
    const before = await f.snapshot();
    await peers(async ([buyer, writer, observer]) => {
      let fenced = false; const execute = PostgresJsPreparedQuery.prototype.execute;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function (this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args) {
        const statement = this.getQuery().sql, result = await execute.apply(this, args);
        if (!fenced && statement.startsWith('LOCK TABLE "member_right", "system_config"')) {
          fenced = true; saving = save({ whole_free_shipping: '1', store_free_postage: '50' }, writer.db);
          await waitForFinanceBlock(observer.db, writer.pid, buyer.pid); expect(deletes).toEqual([]);
          if (ending === 'rollback') throw new Error('synthetic failure after pricing fence');
        }
        return result;
      });
      try { const result = await buy(buyer.db, receipt); expect(result.status, result.msg).toBe(ending === 'commit' ? 200 : 400); } finally { vi.restoreAllMocks(); }
      expect(fenced).toBe(true); expect((await saving)?.status).toBe(200);
    });
    if (ending === 'commit') expect((await f.snapshot()).orders[0].payPostage).toBe('6.00');
    else expect(await f.snapshot()).toEqual(before);
    expect(await f.container.systemConfigDao.getValue('whole_free_shipping')).toBe('1');
  }, 15_000);
});
