import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { storeOrderCartInfo, storeServiceLog, storeServiceSpeechcraft, systemMessage } from '@/models/schema';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { kefuOrderMediaFixture } from '../helpers/kefuOrderMediaFixture';

// Only the external Redis SDK transport is local. Application login, dedicated
// JWTs, ordinary SQL privileges, historical media owner checks and HMAC are real.
const redis = vi.hoisted(() => new Map<string, { value: unknown; until: number }>());
vi.mock('@upstash/redis/cloudflare', () => ({ Redis: class {
  async set(key: string, value: unknown, options: { ex?: number } = {}) { redis.set(key, { value: structuredClone(value), until: Date.now() + (options.ex ?? 3600) * 1000 }); return 'OK'; }
  async get(key: string) { const row = redis.get(key); return row && row.until > Date.now() ? structuredClone(row.value) : null; }
  async del(key: string) { return Number(redis.delete(key)); }
} }));
const identifier = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned order media browser identifier'); return `"${name}"`; };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyStaticReference = '/kefuapi/legacy/order-media.png';
const redactedPath = (path: string) => path.replace(/signature=[^&]+/g, 'signature=REDACTED');

it('serves real Kefu order/refund snapshots, PNG tickets and actual transfer for interactive Browser acceptance', async () => {
  const directory = process.env.TEST_KEFU_ORDER_MEDIA_BROWSER_OUTPUT;
  // Test-only login details are written solely inside the caller's owned /tmp
  // evidence folder. Never publish them as a response or source artifact.
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory || !directory.startsWith('/tmp/') || directory.includes('ci-readonly-key')) {
    throw Error('Owned canonical absolute /tmp order media browser output directory required');
  }
  const artifact = (name: string) => {
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw Error('Invalid owned browser artifact name');
    const path = join(directory, name); if (path.includes('ci-readonly-key')) throw Error('Forbidden browser artifact path'); return path;
  };
  const f = await kefuOrderMediaFixture(), requests: Record<string, unknown>[] = [], adapterErrors: string[] = [];
  try {
    // The historical order fixture already owns refund/invoice/promotion tables.
    // Only these two real adjacent workbench tables are additionally required.
    const extra = [storeServiceSpeechcraft, systemMessage], dialect = new PgDialect();
    for (const table of extra) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const initial = column.default;
        const value = initial === undefined ? '' : ` DEFAULT ${initial instanceof SQL
          ? dialect.sqlToQuery(initial).sql : dialect.sqlToQuery(sql`${initial}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${value}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}${column.isUnique ? ' UNIQUE' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
    }

    // Replace only this fresh browser database's external legacy fixture value.
    // The safe root URL follows the same existing /kefuapi Vite proxy and is
    // served below as full local PNG bytes, without signing or an R2 read.
    const [legacyRow] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, f.ids.carts.legacy));
    const legacySnapshot = JSON.parse(legacyRow.cartInfo!);
    if (legacySnapshot.sku?.image !== 'https://legacy.example.test/order-snapshot.png?v=1&x=2') throw Error('Unexpected original browser legacy snapshot');
    legacySnapshot.sku.image = legacyStaticReference;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(legacySnapshot) }).where(eq(storeOrderCartInfo.id, f.ids.carts.legacy));
    // Actual stored rich-message types drive the normal frontend preview loader.
    // Both previews must fetch the real authorized detail route to get a ticket.
    await f.db.insert(storeServiceLog).values([
      { id: 1901, uid: 201, toUid: 101, isTourist: 0, msnType: 6, msn: '7201', addTime: 1_700_000_040 },
      { id: 1902, uid: 201, toUid: 101, isTourist: 0, msnType: 7, msn: '9201', addTime: 1_700_000_041 },
    ]);

    // Real config reads can populate this local infrastructure cache during
    // login/identity initialization. Protected order/asset GETs still write none.
    const cache = new Map<string, string>(), cacheCounters = { get: 0, put: 0, delete: 0 };
    f.env.CONFIG_KV = {
      get: async (key: string) => { cacheCounters.get++; return cache.get(key) ?? null; },
      put: async (key: string, value: string) => { cacheCounters.put++; cache.set(key, value); },
      delete: async (key: string) => { cacheCounters.delete++; cache.delete(key); },
    } as unknown as typeof f.env.CONFIG_KV;
    const staticCounters = { get: 0, head: 0 };
    const resourcesNow = () => ({ ...f.resources(), browserConfigCache: { ...cacheCounters },
      cacheValues: [...cache].sort(), legacyStatic: { ...staticCounters } });
    const snapshot = () => f.snapshot();
    const { tables, sequences } = await f.inventory();
    expect(tables).toHaveLength(25); expect(sequences).toHaveLength(23);
    const observedEntrances = new Set<string>();
    let successfulTransfers = 0;

    await f.withRuntimeRole(async peer => {
      await f.installPlan(peer); const plan = runtimeBusinessPrivilegePlan('app');
      for (const table of extra) {
        const definition = getTableConfig(table), privileges = plan.tables[definition.name];
        if (!privileges?.includes('SELECT')) throw Error('Missing actual adjacent order workbench app privilege');
        await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        const columns = plan.updateColumns[definition.name];
        if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
        if (privileges.includes('INSERT')) for (const column of definition.columns) {
          if (column.getSQLType() === 'serial') await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(`${definition.name}_${column.name}_seq`)} TO ${identifier(peer.role)}`);
        }
      }
      const [identity] = await peer.exec("SELECT current_database() AS database,current_user AS role,session_user AS session,pg_backend_pid() AS pid,current_setting('server_version_num') AS version,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated");
      expect(identity.role).toBe(peer.role); expect(identity.session).toBe(peer.role); expect(identity.elevated).toBe(false);
      const app = f.appFor(peer.db); let chain = Promise.resolve();
      const server = createServer((req, res) => { chain = chain.then(async () => {
        const path = req.url ?? '/', url = new URL(path, 'http://127.0.0.1');
        if (url.pathname === '/__owned/status' && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ requests: requests.length, observedEntrances: [...observedEntrances].sort(), successfulTransfers,
            resources: resourcesNow(), stateSha256: sha(await snapshot()), inventory: await f.inventory() })); return;
        }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, values] of Object.entries(req.headers)) if (values !== undefined) headers.set(name, Array.isArray(values) ? values.join(',') : values);
        const before = await snapshot(), resources = resourcesNow();
        const legacyStaticGet = req.method === 'GET' && url.pathname === legacyStaticReference;
        const legacyStaticHead = req.method === 'HEAD' && url.pathname === legacyStaticReference;
        const response = legacyStaticGet || legacyStaticHead ? (() => {
          if (legacyStaticGet) staticCounters.get++; else staticCounters.head++;
          return new Response(legacyStaticGet ? f.png : null, { status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(f.png.length) } });
        })() : await app.request('http://127.0.0.1' + path, { method: req.method, headers, ...(body.length ? { body } : {}) }, f.env);
        const bytes = new Uint8Array(await response.arrayBuffer()), after = await snapshot(), end = resourcesNow();
        const orderMediaGet = req.method === 'GET' && /^\/kefuapi\/(?:order\/(?:list|info)\/[^/]+|order\/refund\/detail\/[^/]+|refund\/list)$/.test(url.pathname);
        const assetGet = req.method === 'GET' && /^\/kefuapi\/assets\/[1-9]\d*$/.test(url.pathname);
        const protectedGet = orderMediaGet || assetGet || legacyStaticGet;
        if (protectedGet) {
          expect(after).toEqual(before);
          expect(end.browserConfigCache.put).toBe(resources.browserConfigCache.put);
          expect(end.browserConfigCache.delete).toBe(resources.browserConfigCache.delete);
          expect(end.cacheValues).toEqual(resources.cacheValues);
          const original = f.resources();
          for (const name of Object.keys(original) as (keyof typeof original)[]) {
            if (name === 'objects') expect(end.objects).toEqual(resources.objects);
            else expect(end[name] - resources[name], name).toBe(name === 'r2Get' && assetGet && response.status === 200 ? 1 : 0);
          }
          expect(end.legacyStatic.get - resources.legacyStatic.get).toBe(legacyStaticGet ? 1 : 0);
          expect(end.legacyStatic.head).toBe(resources.legacyStatic.head);
          if ((assetGet || legacyStaticGet) && response.status === 200) expect(bytes).toEqual(f.png);
        }
        let entrance: string | null = null;
        if (orderMediaGet) {
          if (/\/order\/list\//.test(url.pathname)) entrance = url.searchParams.get('type') === '-1' ? 'customer-active-refunds' : 'customer-orders';
          else if (/\/order\/info\//.test(url.pathname)) entrance = 'order-detail';
          else if (/\/order\/refund\/detail\//.test(url.pathname)) entrance = 'refund-detail';
          else entrance = 'global-refund-list';
          observedEntrances.add(entrance);
        }
        const json = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) : null;
        const intentionalTransferPost = req.method === 'POST' && url.pathname === '/kefuapi/service/transfer';
        if (intentionalTransferPost && json?.status === 200) successfulTransfers++;
        const realtimeExcluded = ['/kefuapi/ws', '/kefuapi/messages/socket'].includes(url.pathname);
        const row: Record<string, unknown> = {
          path: redactedPath(path), method: req.method, http: response.status, before: sha(before), after: sha(after),
          orderMediaGet, assetGet, legacyStaticGet, protectedGet, entrance, intentionalTransferPost, realtimeExcluded,
          snapshotTables: Object.keys(before).filter(name => name !== '__sequences'), snapshotSequences: before.__sequences.map(sequence => sequence.name),
          resourcesBefore: resources, resourcesAfter: end,
          ...(json ? { payload: json } : { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }),
        };
        // Bearer tokens stay in the real response to the browser, never in logs.
        if (json?.data?.token) row.payload = { ...json, data: { ...json.data, token: 'REDACTED' } };
        if (intentionalTransferPost) row.intentionalBody = JSON.parse(body.toString('utf8'));
        requests.push(row);
        await writeFile(artifact('request-records.json'), JSON.stringify(requests, null, 2) + '\n');
        res.statusCode = response.status; response.headers.forEach((value, name) => res.setHeader(name, value)); res.end(bytes);
      }).catch(error => {
        const message = String(error); adapterErrors.push(message);
        if (!res.headersSent) res.statusCode = 500;
        res.end('Owned order media fixture error: ' + message);
        requests.push({ path: redactedPath(req.url ?? '/'), method: req.method, adapterError: message });
      }); });
      try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned local order media listener');
        await writeFile(artifact('ready.json'), JSON.stringify({
        apiOrigin: `http://127.0.0.1:${address.port}`, tables, sequences, sqlIdentity: identity,
        account: 'actual-kefu-one', password: f.password, targetAccount: 'actual-kefu-two',
        customer: { uid: 201, search: '唯一客户搜索', targetKefuUid: 102 },
        ids: f.ids,
        suggestedUi: { page: '/workbench', inspector: '订单 / 售后',
          order: { id: 7201, number: 'kefu-order-media-history', listIds: f.seeds.expectedCustomerOrderIds },
          refund: { id: 9201, number: 'kefu-refund-media-selected', listIds: f.seeds.expectedCustomerActiveRefundIds },
          richMessages: [{ logId: 1901, type: 6, id: 7201 }, { logId: 1902, type: 7, id: 9201 }] },
        expectedImages: {
          listCardsAreTextOnly: true, imageDecodingProofIsInRichPreviewsAndDetailDialogs: true,
          pngBytes: f.png.length, pngSha256: createHash('sha256').update(f.png).digest('hex'), naturalWidth: 1, naturalHeight: 1,
          customerOrderList: { cards: 4, signedFirstCartImagesInJson: 4 },
          historyOrderDetail: { rows: 10, signedImages: 5, legacyStaticImages: 1, blankImages: 4,
            platformCartIds: [8301, 8303, 8308, 8310], supplierCartIds: [8302], legacyCartIds: [8306], blankCartIds: [8304, 8305, 8307, 8309] },
          customerActiveRefundList: { cards: 5, signedFirstCartImagesInJson: 5 },
          selectedRefundDetail: { rows: 2, signedImages: 2, cartIds: [8302, 8303] },
          richPreviews: { signedOrderImage: '/api/assets/9101', signedRefundImage: '/api/assets/9102' },
          legacyStatic: { reference: legacyStaticReference, signing: false, r2Reads: 0 },
        },
        globalRefundList: { route: '/kefuapi/refund/list', expectedIds: f.seeds.expectedRefundListIds,
          browserUiAvailable: false, note: 'Current frontend has no global refund-list page; any extra HTTP request must be reported separately from GUI coverage.' },
        onlyActualTransferPost: '/kefuapi/service/transfer; no fixture ownership-mutation endpoint',
        realtimeWebSocketNotProvidedByNodeFixture: true,
        }, null, 2) + '\n');
        console.info('KEFU_ORDER_MEDIA_BROWSER_READY', JSON.stringify({ directory, apiPort: address.port }));
        let done = false;
        for (let elapsed = 0; elapsed < 17 * 60 && !done; elapsed++) {
          try { done = (await readFile(artifact('finish'), 'utf8')).trim() === 'done'; } catch { /* Explicit owned completion marker is pending. */ }
          if (!done) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        expect(done, 'Browser must write its explicit completion marker').toBe(true); await chain;
        expect(adapterErrors).toEqual([]);
        for (const entrance of ['customer-orders', 'customer-active-refunds', 'order-detail', 'refund-detail']) expect(observedEntrances.has(entrance), entrance).toBe(true);
        expect(requests.some(row => row.assetGet && row.http === 200)).toBe(true);
        expect(staticCounters.get).toBeGreaterThan(0);
        expect(successfulTransfers, 'Use the real UI transfer POST before finishing').toBeGreaterThan(0);
      } finally {
        await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); await chain;
        await writeFile(artifact('server-execution.json'), JSON.stringify({
          tables, sequences, finalInventory: await f.inventory(), sqlIdentity: identity, requests, adapterErrors,
          observedEntrances: [...observedEntrances].sort(), successfulTransfers, resources: resourcesNow(), finalStateSha256: sha(await snapshot()),
          legacyStatic: { reference: legacyStaticReference, bytes: f.png.length, sha256: createHash('sha256').update(f.png).digest('hex'), ...staticCounters, r2Reads: 0 },
          realtimeScope: 'Node transport fixture does not provide Cloudflare WebSocket upgrade; no realtime acceptance claimed',
          guiAcceptanceIsSeparateEvidence: true, globalRefundListHasNoCurrentFrontendPage: true,
        }, null, 2) + '\n');
      }
    });
  } finally { await f.close(); }
});
