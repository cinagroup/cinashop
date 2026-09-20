import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import type { PreparedQueryConfig } from 'drizzle-orm/pg-core';
import type { AppVariables, Env } from '../src/env';
import { orderConfirm, orderCreate } from '../src/controllers/api/v1/OrderController';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary checkout through the reviewed pricing lock capability', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
  }, 60_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 60_000);
  type Runtime = Parameters<Parameters<typeof f.withRuntime>[0]>[0];
  const readonly = <T>(run: (r: Runtime) => Promise<T>) => f.withRuntime(async r => {
    await f.exec(`REVOKE UPDATE ON public.member_right,public.system_config FROM "${r.role}";
      GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${r.role}"`);
    return run(r);
  });

  it('creates and idempotently replays a complete ordinary order without configuration DML', async () => {
    await readonly(async r => {
      const [rights] = await r.db.execute(sql`SELECT current_user=session_user AS direct_login,
        has_table_privilege(current_user,'member_right','UPDATE') AS rights_write,
        has_table_privilege(current_user,'system_config','UPDATE') AS config_write`);
      expect(rights).toEqual({ direct_login: true, rights_write: false, config_write: false });
      expect(await r.checkout()).toEqual({ orderId: 'runtime_checkout', key: 'runtime-checkout' });
      const committed = await f.state();
      expect(await r.checkout()).toEqual({ orderId: 'runtime_checkout', key: 'runtime-checkout' });
      expect(await f.state()).toEqual(committed);
      await f.exec('DROP FUNCTION public.checkout_lock_pricing_v1()');
      expect(await r.checkout()).toEqual({ orderId: 'runtime_checkout', key: 'runtime-checkout' });
      expect(await f.state()).toEqual(committed);
      for (const table of ['member_right', 'system_config']) {
        await expect(r.db.transaction(tx => tx.execute(sql.raw(`LOCK TABLE public.${table} IN SHARE MODE NOWAIT`))))
          .rejects.toMatchObject({ cause: { code: '42501' } });
        await expect(r.exec(`UPDATE public.${table} SET id=id`)).rejects.toMatchObject({ code: '42501' });
      }
    });
  }, 30_000);

  it.each(['implicit-temp', 'explicit-temp'] as const)('rejects %s pricing sources rather than locking another schema', async mode => {
    await readonly(async r => {
      await r.exec('CREATE TEMP TABLE member_right AS TABLE public.member_right');
      await r.exec(mode === 'implicit-temp' ? 'SET search_path=public' : 'SET search_path=pg_temp,public');
      const before = await f.state();
      await expect(r.checkout()).rejects.toThrow('订单计价来源与锁保护范围不一致');
      expect(await f.state()).toEqual(before);
    });
  }, 30_000);

  it.each(['stable', 'changed'] as const)('uses actual confirmation/create controllers with a readonly pricing LOGIN: %s', async mode => {
    await readonly(async r => {
      // Real Hono/controller/SQL path; synthetic uid and local KV/sequence only.
      // Authentication middleware/provider/Hyperdrive are not claimed here.
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', r.container); c.set('uid', 11); await next(); });
      app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
      app.post('/api/order/confirm', orderConfirm); app.post('/api/order/create/:key', orderCreate);
      Object.assign(f.env, { SEQUENCE: { idFromName: () => 'local', get: () => ({ fetch: async () => new Response('readonly_http_order') }) } });
      const post = async (path: string, body: object) => (await app.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }, f.env)).json<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string } }>();
      const input = { cartIds: [1, 2], addressId: 11, useIntegral: true };
      const confirmation = await post('/api/order/confirm', input);
      expect(confirmation.status, confirmation.msg).toBe(200);
      if (mode === 'changed') await f.exec("UPDATE public.system_config SET value='1' WHERE menu_name='whole_free_shipping'");
      const before = await f.state();
      const result = await post(`/api/order/create/${confirmation.data.orderKey}`, { ...input, quoteToken: confirmation.data.quoteToken });
      expect(result.status, result.msg).toBe(mode === 'stable' ? 200 : 400);
      if (mode === 'changed') {
        expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await f.state()).toEqual(before);
      }
    });
  }, 30_000);

  it('fails closed without the capability even if the caller could directly lock the tables', async () => {
    await f.withRuntime(async r => {
      await f.exec(`GRANT UPDATE ON public.member_right,public.system_config TO "${r.role}"`);
      await r.db.transaction(tx => tx.execute(sql`LOCK TABLE public.member_right,public.system_config IN SHARE MODE NOWAIT`));
      await f.exec('DROP FUNCTION public.checkout_lock_pricing_v1()');
      const before = await f.state();
      await expect(r.checkout()).rejects.toThrow('requires review');
      expect(await f.state()).toEqual(before);
    });
  }, 30_000);

  it.each(['execute', 'definition', 'public-execute', 'rls'] as const)('rolls back the entire order on %s drift', async mode => {
    await readonly(async r => {
      const changes = {
        execute: `REVOKE EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() FROM "${r.role}"`,
        definition: "CREATE OR REPLACE FUNCTION public.checkout_lock_pricing_v1() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS 'BEGIN NULL; END'",
        'public-execute': 'GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO PUBLIC',
        rls: 'ALTER TABLE public.system_config ENABLE ROW LEVEL SECURITY',
      }[mode];
      await f.exec(changes);
      const before = await f.state();
      if (mode === 'execute') await expect(r.checkout()).rejects.toMatchObject({ cause: { code: '42501', message: 'permission denied for function checkout_lock_pricing_v1' } });
      else await expect(r.checkout()).rejects.toThrow('requires review');
      expect(await f.state()).toEqual(before);
    });
  }, 30_000);

  it.each(['member_right', 'system_config'])('rejects a pre-existing %s writer, then safely retries', async table => {
    await readonly(async r => f.withPeer!(async writer => {
      const before = await f.state();
      await writer.exec(`BEGIN; UPDATE public.${table} SET id=id`);
      try {
        await expect(r.checkout()).rejects.toThrow('订单计价配置正在更新');
        expect(await f.state()).toEqual(before);
      } finally { await writer.exec('ROLLBACK'); }
      expect((await r.checkout()).orderId).toBe('runtime_checkout');
    }));
  }, 30_000);

  it.each(['commit', 'rollback'] as const)('holds the real configuration writer until checkout %s', async end => {
    await readonly(async r => f.withPeer!(writer => f.withPeer!(async observer => {
      const before = await f.state();
      let reached = false;
      let writing: ReturnType<typeof outcome> | undefined;
      const original = PostgresJsPreparedQuery.prototype.execute;
      vi.spyOn(PostgresJsPreparedQuery.prototype, 'execute').mockImplementation(async function (
        this: PostgresJsPreparedQuery<PreparedQueryConfig>, ...args
      ) {
        const result = await original.apply(this, args);
        if (!reached && this.getQuery().sql === 'SELECT "public".checkout_lock_pricing_v1()') {
          reached = true;
          writing = outcome(writer.exec("UPDATE public.system_config SET value=value WHERE menu_name='whole_free_shipping'"));
          await waitForFinanceBlock(observer.db, writer.pid, r.pid);
          if (end === 'rollback') throw Error('Forced post-lock rollback');
        }
        return result;
      });
      const result = await outcome(r.checkout());
      expect(reached).toBe(true);
      expect(result.ok).toBe(end === 'commit');
      expect((await writing)?.ok).toBe(true);
      if (end === 'rollback') expect(await f.state()).toEqual(before);
    })));
  }, 30_000);

  it('rejects a busy maintenance gate before any business writes commit', async () => {
    await readonly(async r => f.withPeer!(async maintainer => {
      const before = await f.state();
      await maintainer.exec("BEGIN; SELECT pg_advisory_xact_lock(731622,'public'::regnamespace::integer)");
      try { await expect(r.checkout()).rejects.toThrow(); expect(await f.state()).toEqual(before); }
      finally { await maintainer.exec('ROLLBACK'); }
      expect((await r.checkout()).orderId).toBe('runtime_checkout');
    }));
  }, 30_000);
});
