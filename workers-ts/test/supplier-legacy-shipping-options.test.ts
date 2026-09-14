import { Hono } from 'hono';
import type { ExecutionContext } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { supplierapiRoutes } from '../src/routes/supplierapi';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5 } from '../src/utils/jwt';
import * as cache from '../src/utils/cache';
import { openLegacyShippingOptions } from '../src/services/supplier/SupplierLegacyShippingOptionsStream';

const path = '/supplierapi/product/product/get_template';
type Option = { id: number; name: string };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy Supplier get_template full array on PG16', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let env: Env, bearer: string;
  let buckets: Map<string, cache.TokenBucket>;
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const kit = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
    await f.exec((await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson(schema))).join('\n'));
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    buckets = new Map();
    env = { APP_KEY: crypto.randomUUID(), NODE_ENV: 'production', UPSTASH_REDIS_URL: 'https://isolated.invalid', UPSTASH_REDIS_TOKEN: 'fixture-only' } as Env;
    vi.spyOn(cache, 'getTokenBucket').mockImplementation(async key => buckets.get(key) ?? null);
    vi.spyOn(cache, 'clearToken').mockImplementation(async key => buckets.delete(key));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External I/O forbidden'); }));
    await f.exec(`DELETE FROM shipping_templates; DELETE FROM system_admin; DELETE FROM system_role; DELETE FROM system_supplier;
      INSERT INTO system_role(id,type,relation_id,rules,status) VALUES(2,4,20,'supplier.product.view',1);
      INSERT INTO system_admin(id,account,admin_type,relation_id,roles,level) VALUES(27,'fixture-child',4,20,'2',1);
      INSERT INTO system_supplier(id,admin_id,supplier_name) VALUES(20,28,'own'),(30,38,'other');
      INSERT INTO shipping_templates(id,name,owner_type,relation_id,is_del) VALUES
        (1,'platform',0,0,0),(101,'foreign',2,30,0),(102,'store',1,20,0),(103,'retired',2,20,1)`);
    const issued = await createToken(27, 'supplier', md5(''), env.APP_KEY);
    bearer = issued.token; buckets.set(md5(bearer), { ...issued, uid: 27, type: 'supplier' });
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function seed(count: number) {
    await f.exec(`INSERT INTO shipping_templates(id,name,owner_type,relation_id,sort)
      SELECT 200+n,'template-'||n,2,20,0 FROM generate_series(1,${count}) n`);
  }
  async function withApp(work: (request: (url?: string, init?: RequestInit) => Promise<Response>, runtime: SequenceRunnerPeer & { role: string }, tasks: Promise<unknown>[]) => Promise<void>) {
    await f.withRuntimeRole!(async runtime => {
      env.HYPERDRIVE = { connectionString: runtime.connectionString } as Env['HYPERDRIVE'];
      await f.exec(`GRANT SELECT ON public.shipping_templates,public.system_admin,public.system_supplier,public.system_role TO "${runtime.role}"`);
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.use('*', async (c, next) => { c.set('container', createContainerFromDb(runtime.db)); await next(); });
      app.onError(errorHandler); app.route('/supplierapi', supplierapiRoutes);
      const tasks: Promise<unknown>[] = [], responses: Response[] = [];
      const ctx: ExecutionContext = { waitUntil: task => { tasks.push(task); }, passThroughOnException() {}, props: {} };
      const request = async (url = path, init: RequestInit = {}) => {
        const res = await app.request(url, { ...init, headers: { Authorization: `Bearer ${bearer}`, ...init.headers } }, env, ctx);
        responses.push(res); return res;
      };
      try { await work(request, runtime, tasks); }
      finally {
        for (const res of responses) if (res.body && !res.bodyUsed) await res.body.cancel();
        await Promise.all(tasks);
        // pg_cursors on the authentication connection cannot prove cleanup of
        // the separate streaming socket. Observe all sessions for this role.
        await expect.poll(async () => await f.exec(`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname=current_database() AND usename='${runtime.role}'
          AND application_name='cinashop_legacy_shipping_options'`), { timeout: 2000 }).toEqual([{count:0}]);
      }
    });
  }
  it.each([0,1,128,129,1025])('returns the complete array of %s rows, including batch boundaries', async count => {
    await seed(count);
    await withApp(async (request, runtime, tasks) => {
      const res = await request(path+'?limit=1&page=999&name=nomatch&supplierId=30&relation_id=30&owner_type=0');
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('content-type')).toContain('application/json');
      const body: { status: number; data: Option[] } = await res.json();
      expect(body.status).toBe(200); expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toEqual(Array.from({length:count},(_,i)=>({id:200+count-i,name:`template-${count-i}`})));
      await Promise.all(tasks);
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
      expect(await runtime.exec("SELECT current_setting('transaction_read_only') AS read_only")).toEqual([{read_only:'off'}]);
    });
  });
  it('preserves descending sort/id, disabled templates and JSON string escaping', async () => {
    await seed(3);
    await f.exec(`UPDATE shipping_templates SET sort=10,status=0,name='"quoted"\\slash 中文' WHERE id=201`);
    await withApp(async request => {
      const body: {status:number;data:Option[]} = await (await request()).json();
      expect(body.status).toBe(200); expect(body.data.map(row=>row.id)).toEqual([201,203,202]);
      expect(body.data[0].name).toBe('"quoted"\\slash 中文');
      expect(body.data.every(row=>Object.keys(row).sort().join(',')==='id,name')).toBe(true);
    });
  });
  it('requires product permission and authentication before creating a cursor', async () => {
    await withApp(async (request, _runtime, tasks) => {
      let res = await request(path,{headers:{Authorization:''}});
      expect(await res.json()).toMatchObject({status:410000,data:null});
      expect(res.headers.get('cache-control')).toContain('no-store');
      await f.exec("UPDATE system_role SET rules='supplier.shipping.manage' WHERE id=2");
      res = await request(); expect(await res.json()).toMatchObject({status:400011,data:null});
      expect(tasks).toHaveLength(0);
    });
  });
  it('streams one snapshot in bounded batches despite independent inserts, renames, retirement and reassignment', async () => {
    await seed(1025);
    await withApp(async (request, runtime, tasks) => {
      const response = await request(), reader = response.body!.getReader(), decoder = new TextDecoder();
      const first = await reader.read(); expect(first.done).toBe(false);
      const initial = decoder.decode(first.value);
      expect((JSON.parse(initial+']}') as {data:Option[]}).data).toHaveLength(128);
      await f.exec(`INSERT INTO shipping_templates(id,name,owner_type,relation_id) VALUES(2000,'late',2,20);
        UPDATE shipping_templates SET name='changed',relation_id=30 WHERE id=201;
        UPDATE shipping_templates SET is_del=1 WHERE id=202;
        UPDATE shipping_templates SET sort=100 WHERE id=203`);
      let text = initial, chunks = 1;
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        expect(next.value.byteLength).toBeLessThan(50_000); chunks++; text += decoder.decode(next.value);
      }
      const body = JSON.parse(text) as {status:number;data:Option[]};
      expect(body.data).toEqual(Array.from({length:1025},(_,i)=>({id:1225-i,name:`template-${1025-i}`})));
      expect(chunks).toBe(9); await Promise.all(tasks);
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
    });
  });
  it.each(['before read','after first batch'])('consumer cancellation %s rolls back and releases the reserved socket', async when => {
    await seed(300);
    await withApp(async (request, runtime, tasks) => {
      const response = await request();
      if (when === 'before read') await response.body!.cancel();
      else { const reader = response.body!.getReader(); await reader.read(); await reader.cancel(); }
      await Promise.all(tasks);
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
      expect(await runtime.exec("SELECT current_setting('transaction_read_only') AS read_only")).toEqual([{read_only:'off'}]);
    });
  });
  it('request abort errors a partially consumed body and releases the transaction', async () => {
    await seed(300);
    await withApp(async (request, runtime, tasks) => {
      const abort = new AbortController(), response = await request(path,{signal:abort.signal});
      const reader = response.body!.getReader(); await reader.read(); abort.abort();
      await expect(reader.read()).rejects.toThrow('完整列表读取失败');
      await Promise.all(tasks);
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
    });
  });
  it('deadline releases an unread stream instead of holding the database connection indefinitely', async () => {
    await seed(300);
    await withApp(async (_request, runtime, tasks) => {
      const stream = await openLegacyShippingOptions(env.HYPERDRIVE.connectionString,20,new AbortController().signal,{deadlineMs:150});
      tasks.push(stream.completion); await stream.completion;
      await expect(new Response(stream.body).json()).rejects.toThrow('完整列表读取失败');
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
      expect(await runtime.exec("SELECT current_setting('transaction_read_only') AS read_only")).toEqual([{read_only:'off'}]);
    });
  });
  it('database termination between batches cannot become a valid shortened success array', async () => {
    await seed(300);
    await withApp(async (request, runtime, tasks) => {
      const response = await request(), reader = response.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      const active = (await f.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND usename='${runtime.role}' AND application_name='cinashop_legacy_shipping_options'`)).rows;
      expect(active).toHaveLength(1);
      const row: unknown = active[0];
      const pid = Number(row && typeof row === 'object' && 'pid' in row ? row.pid : NaN);
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(pid).not.toBe(runtime.pid);
      expect(await f.exec(`SELECT pg_terminate_backend(${pid}) AS terminated`)).toEqual([{terminated:true}]);
      await expect(reader.read()).rejects.toThrow('完整列表读取失败');
      expect(()=>JSON.parse(first)).toThrow(); await Promise.all(tasks);
      expect(await runtime.exec('SELECT pg_backend_pid() AS pid')).toEqual([{pid:runtime.pid}]);
    });
  });
  it('a deadline during blocked initial SQL closes only the streaming connection', async () => {
    await seed(300);
    await withApp(async (_request, runtime) => {
      await f.exec('BEGIN; LOCK TABLE shipping_templates IN ACCESS EXCLUSIVE MODE');
      try {
        await expect(openLegacyShippingOptions(env.HYPERDRIVE.connectionString,20,new AbortController().signal,
          {deadlineMs:150})).rejects.toThrow();
        expect(await runtime.exec('SELECT pg_backend_pid() AS pid')).toEqual([{pid:runtime.pid}]);
      } finally { await f.exec('ROLLBACK'); }
    });
  });
  it('an already aborted request opens no streaming connection', async () => {
    await withApp(async () => {
      const abort = new AbortController(); abort.abort();
      await expect(openLegacyShippingOptions(env.HYPERDRIVE.connectionString,20,abort.signal)).rejects.toThrow();
    });
  });
  it('invalid row in a later batch errors the whole body rather than reporting truncated success', async () => {
    await seed(300);
    await f.exec("INSERT INTO shipping_templates(id,name,owner_type,relation_id) VALUES(-9,'invalid identity',2,20)");
    await withApp(async (request, runtime, tasks) => {
      await expect((await request()).json()).rejects.toThrow('完整列表读取失败');
      await Promise.all(tasks);
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
    });
  });
  it('HEAD does not open a cursor or leave an unread response transaction', async () => {
    await withApp(async (request, runtime, tasks) => {
      const response = await request(path,{method:'HEAD'});
      expect(response.status).toBe(200); expect(await response.text()).toBe(''); expect(tasks).toHaveLength(0);
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
    });
  });
  it('missing table permission fails before streaming starts and returns the socket', async () => {
    await withApp(async (request, runtime, tasks) => {
      await f.exec(`REVOKE SELECT ON shipping_templates FROM "${runtime.role}"`);
      const response = await request(), body: {status:number;data:unknown} = await response.json();
      expect(body.status).not.toBe(200); expect(body.data).toBeNull(); expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      expect(await runtime.exec('SELECT count(*)::int AS count FROM pg_cursors')).toEqual([{count:0}]);
      expect(await runtime.exec("SELECT current_setting('transaction_read_only') AS read_only")).toEqual([{read_only:'off'}]);
    });
  });
});
