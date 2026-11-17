import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeOrderRefund, systemMessage, storeServiceRecord, storeServiceSpeechcraft } from '@/models/schema';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { kefuProductMediaFixture } from '../helpers/kefuProductMediaFixture';

const redis = vi.hoisted(() => new Map<string, { value: unknown; until: number }>());
vi.mock('@upstash/redis/cloudflare', () => ({ Redis: class {
  async set(key: string, value: unknown, options: { ex?: number } = {}) { redis.set(key, { value: structuredClone(value), until: Date.now() + (options.ex ?? 3600) * 1000 }); return 'OK'; }
  async get(key: string) { const row = redis.get(key); return row && row.until > Date.now() ? structuredClone(row.value) : null; }
  async del(key: string) { return Number(redis.delete(key)); }
} }));
const ident = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned browser identifier'); return `"${name}"`; };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('serves real Kefu login, current SQL grants and signed product images for interactive Browser acceptance', async () => {
  const directory = process.env.TEST_KEFU_MEDIA_BROWSER_OUTPUT;
  if (!directory || !isAbsolute(directory) || directory.includes('ci-readonly-key')) throw Error('Owned absolute browser output directory required');
  const f = await kefuProductMediaFixture(); const requests: Record<string, unknown>[] = [];
  try {
    // Adjacent workbench panels use their real empty tables and app grants.
    // This adds no fake product response or auth shortcut to the browser flow.
    const extra = [storeServiceSpeechcraft, storeOrderRefund, systemMessage], dialect = new PgDialect();
    for (const table of extra) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => { const initial = column.default; const value = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${ident(column.name)} ${column.getSQLType()}${value}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}${column.isUnique ? ' UNIQUE' : ''}`; });
      await f.exec(`CREATE TABLE public.${ident(definition.name)} (${columns.join(',')})`);
    }
    // Real system-config reads may fill the local infrastructure cache during
    // login/identity initialization. Product GETs must still make zero writes.
    const cache = new Map<string, string>(), cacheCounters = { get: 0, put: 0, delete: 0 };
    f.env.CONFIG_KV = { get: async (key: string) => { cacheCounters.get++; return cache.get(key) ?? null; },
      put: async (key: string, value: string) => { cacheCounters.put++; cache.set(key, value); },
      delete: async (key: string) => { cacheCounters.delete++; cache.delete(key); } } as unknown as typeof f.env.CONFIG_KV;
    const resourcesNow = () => ({ ...f.resources(), browserConfigCache: { ...cacheCounters }, cacheValues: [...cache].sort() });
    const tables = [...f.tables, ...extra.map(table => getTableConfig(table).name)].sort();
    const sequences = (await f.exec("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => String(row.name));
    const snapshot = async () => { const result: Record<string, unknown> = {};
      for (const name of tables) result[name] = (await f.exec(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public.${ident(name)} t`))[0].rows;
      result.__sequences = await f.exec(sequences.map(name => `SELECT '${name}'::text AS name,last_value::text AS last_value,is_called FROM public.${ident(name)}`).join(' UNION ALL ') + ' ORDER BY name'); return result;
    };
    await f.withRuntimeRole(async peer => {
      await f.installPlan(peer); const plan = runtimeBusinessPrivilegePlan('app');
      for (const table of extra) { const definition = getTableConfig(table), privileges = plan.tables[definition.name]; if (!privileges?.includes('SELECT')) throw Error('Missing actual adjacent workbench app privilege');
        await f.exec(`GRANT ${privileges.join(',')} ON public.${ident(definition.name)} TO ${ident(peer.role)}`);
        const columns = plan.updateColumns[definition.name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(ident).join(',')}) ON public.${ident(definition.name)} TO ${ident(peer.role)}`);
        if (privileges.includes('INSERT')) for (const column of definition.columns) if (column.getSQLType() === 'serial') await f.exec(`GRANT USAGE ON SEQUENCE public.${ident(`${definition.name}_${column.name}_seq`)} TO ${ident(peer.role)}`);
      }
      const app = f.appFor(peer.db); let chain = Promise.resolve();
      const server = createServer((req, res) => { chain = chain.then(async () => {
        const path = req.url ?? '/';
        if (path === '/__owned/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ requests: requests.length, resources: resourcesNow(), stateSha256: sha(await snapshot()) })); return; }
        if (path === '/__owned/transfer' && req.method === 'POST') { await f.db.update(storeServiceRecord).set({ userId: 102 }).where(eq(storeServiceRecord.id, 1)); res.end('owned fixture transferred'); return; }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
        const headers = new Headers(); for (const [name, values] of Object.entries(req.headers)) if (values !== undefined) headers.set(name, Array.isArray(values) ? values.join(',') : values);
        const before = await snapshot(), resources = resourcesNow();
        const response = await app.request('http://127.0.0.1' + path, { method: req.method, headers, ...(body.length ? { body } : {}) }, f.env);
        const bytes = new Uint8Array(await response.arrayBuffer()), after = await snapshot(), end = resourcesNow();
        const productGet = req.method === 'GET' && /^\/kefuapi\/(?:product\/(?:cart|visit|hot|info)\/|assets\/|tourist\/product\/)/.test(path);
        if (productGet) { expect(after).toEqual(before); expect(end.browserConfigCache.put).toBe(resources.browserConfigCache.put); expect(end.browserConfigCache.delete).toBe(resources.browserConfigCache.delete); expect(end.cacheValues).toEqual(resources.cacheValues); for (const name of ['kvPut', 'kvDelete', 'r2Put', 'r2Delete', 'queueSend', 'queueSendBatch', 'sequence', 'chatTransfer', 'chatDisconnect'] as const) expect(end[name]).toBe(resources[name]); }
        requests.push({ path: path.replace(/signature=[^&]+/, 'signature=REDACTED'), method: req.method, http: response.status, before: sha(before), after: sha(after), productGet, resourcesBefore: resources, resourcesAfter: end,
          ...(response.headers.get('Content-Type')?.includes('application/json') ? { payload: JSON.parse(new TextDecoder().decode(bytes)) } : { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) });
        // Do not persist login bearer tokens in the diagnostic request evidence.
        const row = requests.at(-1)!; const payload = row.payload as any; if (payload?.data?.token) row.payload = { ...payload, data: { ...payload.data, token: 'REDACTED' } };
        await writeFile(join(directory, 'request-records.json'), JSON.stringify(requests, null, 2) + '\n');
        res.statusCode = response.status; response.headers.forEach((value, name) => res.setHeader(name, value)); res.end(bytes);
      }).catch(error => { res.statusCode = 500; res.end('Owned fixture error: ' + String(error)); requests.push({ path: req.url, error: String(error) }); }); });
      server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned local listener');
      await writeFile(join(directory, 'ready.json'), JSON.stringify({ apiOrigin: `http://127.0.0.1:${address.port}`, tables, sequences, role: peer.role,
        account: 'actual-kefu-one', password: f.password, realtimeWebSocketNotProvidedByNodeFixture: true }) + '\n');
      console.info('KEFU_MEDIA_BROWSER_READY', JSON.stringify({ directory, apiPort: address.port }));
      try { let done = false; for (let elapsed = 0; elapsed < 17 * 60 && !done; elapsed++) { try { done = (await readFile(join(directory, 'finish'), 'utf8')).trim() === 'done'; } catch { /* owned completion marker is pending */ } if (!done) await new Promise(resolve => setTimeout(resolve, 1000)); }
        expect(done, 'Browser must write its explicit completion marker').toBe(true); await chain;
      } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await chain;
        await writeFile(join(directory, 'server-execution.json'), JSON.stringify({ tables, sequences, requests, resources: resourcesNow(), finalStateSha256: sha(await snapshot()), realtimeScope: 'Node transport fixture does not provide Cloudflare WebSocket upgrade; no realtime acceptance claimed' }, null, 2) + '\n'); }
    });
  } finally { await f.close(); }
});
