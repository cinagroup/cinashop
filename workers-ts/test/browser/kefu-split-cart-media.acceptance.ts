import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, createHmac } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { SQL, eq, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { deliveryService, expressCompany, storeOrderCartInfo, storeServiceLog, storeServiceSpeechcraft, systemMessage } from '@/models/schema';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { verifyToken } from '@/utils/jwt';
import { kefuSplitCartMediaFixture } from '../helpers/kefuSplitCartMediaFixture';

// Only the external Redis SDK transport is local. Application login, dedicated
// JWTs, ordinary SQL privileges, historical media owner checks and HMAC are real.
const redis = vi.hoisted(() => new Map<string, { value: unknown; until: number }>());
vi.mock('@upstash/redis/cloudflare', () => ({ Redis: class {
  async set(key: string, value: unknown, options: { ex?: number } = {}) { redis.set(key, { value: structuredClone(value), until: Date.now() + (options.ex ?? 3600) * 1000 }); return 'OK'; }
  async get(key: string) { const row = redis.get(key); return row && row.until > Date.now() ? structuredClone(row.value) : null; }
  async del(key: string) { return Number(redis.delete(key)); }
} }));
const identifier = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned split-cart media browser identifier'); return `"${name}"`; };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyStaticReference = '/kefuapi/legacy/split-cart-media.png';
const redactedPath = (path: string) => path.replace(/signature=[^&]+/g, 'signature=REDACTED');
const GUI_OR_DEFAULT_ORIGIN = 'browser-or-unlabeled';
const SUPPLEMENTAL_ORIGIN = 'supplemental-http';
const fixtureCustomers = new Set(['201', '369']);
type QueryRule = { required?: boolean; valid: (value: string) => boolean };
const exact = (value: string, required = false): QueryRule => ({ required, valid: input => input === value });
const oneOf = (...values: string[]): QueryRule => ({ valid: input => values.includes(input) });
const shortSearch: QueryRule = { valid: input => input.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(input) };
const noQuery = {};
/** Fixture-specific read allowlist, evaluated before the real application.
 * GET is not itself a read-only guarantee: verific/temp and every unlisted
 * method/path/query are rejected without entering production/provider code. */
function allowOwnedRead(method: string | undefined, url: URL): boolean {
  if (method !== 'GET') return false;
  let rules: Record<string, QueryRule> | undefined;
  switch (url.pathname) {
    case '/kefuapi/config': case '/kefuapi/service/info': case '/kefuapi/user/group':
    case '/kefuapi/messages/socket': case legacyStaticReference:
      rules = noQuery; break;
    case '/kefuapi/messages': rules = { limit: exact('1', true) }; break;
    case '/kefuapi/service/cate': rules = { type: exact('0', true) }; break;
    case '/kefuapi/service/speechcraft': rules = { type: exact('0', true), limit: exact('100', true) }; break;
    case '/kefuapi/service/transfer_list': rules = { limit: exact('100', true), nickname: shortSearch }; break;
    case '/kefuapi/user/record':
      rules = { is_tourist: { ...oneOf('0', '1'), required: true }, limit: exact('60', true), nickname: shortSearch,
        cursor: { valid: value => /^[A-Za-z0-9_-]{1,1024}$/.test(value) } }; break;
    case '/kefuapi/service/list':
      rules = { uid: { required: true, valid: value => fixtureCustomers.has(value) }, is_tourist: exact('0', true),
        limit: exact('60', true), upperId: { valid: value => /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2_147_483_647 } }; break;
    case '/kefuapi/ws': rules = { is_tourist: exact('0', true), to_uid: { valid: value => fixtureCustomers.has(value) } }; break;
    case '/kefuapi/order/info/7501': case '/kefuapi/order/split_cart_info/7501': rules = noQuery; break;
    case '/kefuapi/order/export': rules = { status: exact('1', true) }; break;
    case '/kefuapi/order/delivery_all': rules = { limit: exact('100', true) }; break;
    // 9103 is the existing purchased-product card's current-catalog picture;
    // it never satisfies either split-issued platform/supplier PNG finish gate.
    case '/kefuapi/assets/9101': case '/kefuapi/assets/9102': case '/kefuapi/assets/9103':
      rules = { expires: { required: true, valid: value => /^[1-9]\d{9}$/.test(value) },
        signature: { required: true, valid: value => /^[A-Za-z0-9_-]{43}$/.test(value) } }; break;
    default: {
      const customer = /^\/kefuapi\/(?:user\/(?:info|label)|product\/cart|order\/list)\/(201|369)$/.exec(url.pathname);
      if (!customer) return false;
      if (/\/user\//.test(url.pathname)) rules = noQuery;
      else if (/\/product\/cart\//.test(url.pathname)) rules = { limit: exact('20', true) };
      else rules = { limit: exact('20', true) };
    }
  }
  if (!rules) return false;
  for (const [name, value] of url.searchParams) if (!rules[name]?.valid(value) || url.searchParams.getAll(name).length !== 1) return false;
  return Object.entries(rules).every(([name, rule]) => !rule.required || url.searchParams.has(name));
}
function exactBodyKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

/** Observe the actual submitted SELECT builders and transaction commands.
 * Nothing substitutes query results or takes over transaction completion. */
function traceDatabase(client: DbClient, statements: string[]): DbClient {
  const dialect = new PgDialect();
  const query = (builder: any): any => new Proxy(builder, { get(target, name) {
    if (name === 'then') return (resolveValue: any, rejectValue: any) => target.then((rows: unknown) => {
      statements.push(target.toSQL().sql); return rows;
    }).then(resolveValue, rejectValue);
    const value = Reflect.get(target, name, target);
    return typeof value === 'function' ? (...args: unknown[]) => {
      const next = value.apply(target, args);
      return next && typeof next === 'object' && typeof next.toSQL === 'function' ? query(next) : next;
    } : value;
  } });
  return new Proxy(client, { get(target, name) {
    if (name === 'select') return (...args: unknown[]) => query((target.select as any)(...args));
    if (name === 'execute') return (statement: SQL) => { statements.push(dialect.sqlToQuery(statement).sql); return target.execute(statement); };
    if (name === 'transaction') return (work: any, ...args: unknown[]) => (target.transaction as any)((tx: DbClient) => work(traceDatabase(tx, statements)), ...args);
    const value = Reflect.get(target, name, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

it('serves real Kefu split-cart snapshots, PNG tickets and actual transfer for interactive Browser acceptance', async () => {
  const directory = process.env.TEST_KEFU_SPLIT_CART_MEDIA_BROWSER_OUTPUT;
  // Test-only login details are written solely inside the caller's owned /tmp
  // evidence folder. Never publish them as a response or source artifact.
  if (!directory || !isAbsolute(directory) || resolve(directory) !== directory || !directory.startsWith('/tmp/') || directory.includes('ci-readonly-key')) {
    throw Error('Owned canonical absolute /tmp split-cart media browser output directory required');
  }
  const artifact = (name: string) => {
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw Error('Invalid owned browser artifact name');
    const path = join(directory, name); if (path.includes('ci-readonly-key')) throw Error('Forbidden browser artifact path'); return path;
  };
  const outputStat = await lstat(directory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || await realpath(directory) !== directory) {
    throw Error('Browser output must be a fresh real runner-owned directory');
  }
  for (const name of ['ready.json', 'request-records.json', 'server-execution.json', 'finish', 'states']) {
    const existing = await lstat(artifact(name)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (existing) throw Error('Browser output contains an existing acceptance artifact: ' + name);
  }
  const f = await kefuSplitCartMediaFixture(), requests: Record<string, unknown>[] = [], adapterErrors: string[] = [];
  const retained = new Set<string>();
  await mkdir(join(directory, 'states'), { recursive: true });
  const retain = async (state: Awaited<ReturnType<typeof f.snapshot>>) => {
    const content = JSON.stringify(state), sha256 = createHash('sha256').update(content).digest('hex');
    const name = `states/${sha256}.json`, path = join(directory, name);
    if (path.includes('ci-readonly-key')) throw Error('Forbidden owned state artifact');
    if (!retained.has(name)) { await writeFile(path, content); retained.add(name); }
    return { path: name, sha256, bytes: Buffer.byteLength(content) };
  };
  try {
    // The historical order fixture already owns refund/invoice/promotion tables.
    // These four real adjacent tables support ordinary workbench and fulfillment
    // option reads. They are also included in every complete state snapshot.
    const extra = [storeServiceSpeechcraft, systemMessage, expressCompany, deliveryService], dialect = new PgDialect();
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
    await f.db.insert(expressCompany).values({ id: 1, name: '顺丰速运', code: 'SF', status: 1, isShow: 1, sort: 10 });

    // Replace only this fresh browser database's external legacy fixture value.
    // The safe root URL follows the same existing /kefuapi Vite proxy and is
    // served below as full local PNG bytes, without signing or an R2 read.
    const [legacyRow] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, f.ids.carts.legacy));
    const legacySnapshot = JSON.parse(legacyRow.cartInfo!);
    if (legacySnapshot.product?.image !== 'https://legacy.example.test/split-main.png?v=1&x=2') throw Error('Unexpected original browser legacy snapshot');
    legacySnapshot.product.image = legacyStaticReference;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(legacySnapshot) }).where(eq(storeOrderCartInfo.id, f.ids.carts.legacy));
    // Actual stored rich-message types drive the normal frontend preview loader.
    // The order preview fetches the real authorized detail route for its image.
    await f.db.insert(storeServiceLog).values([
      { id: 1901, uid: 201, toUid: 101, isTourist: 0, msnType: 6, msn: String(f.ids.order), addTime: 1_700_000_040 },
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
    expect(tables).toHaveLength(27); expect(sequences).toHaveLength(25);
    const observedEntrances = new Set<string>();
    const issuedLogins = new Map<string, { account: string; authId: number; principalUid: number; issuedBeforeTransfer: boolean }>();
    const splitTickets = new Map<string, { sourceSplitRequestIndex: number; reference: string; cartId: number; slot: string }>();
    let successfulGuiSplitIndex: number | null = null;
    const finishGates: Record<string, boolean> = {};
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
      const statements: string[] = [];
      const app = f.appFor(traceDatabase(peer.db, statements)); let chain = Promise.resolve();
      const server = createServer((req, res) => { chain = chain.then(async () => {
        const path = req.url ?? '/', url = new URL(path, 'http://127.0.0.1');
        if (url.pathname === '/__owned/status' && req.method === 'GET' && url.search === '') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ requests: requests.length, observedEntrances: [...observedEntrances].sort(), successfulTransfers,
            resources: resourcesNow(), stateSha256: sha(await snapshot()), inventory: await f.inventory() })); return;
        }
        const fixturePost = req.method === 'POST' && url.search === '' && ['/kefuapi/login', '/kefuapi/service/transfer'].includes(url.pathname);
        if (!fixturePost && !allowOwnedRead(req.method, url)) {
          throw Error('Unlisted browser acceptance method/path/query rejected before application execution');
        }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks);
        let intentionalBody: Record<string, unknown> | null = null;
        if (req.method === 'POST' && url.search === '' && ['/kefuapi/login', '/kefuapi/service/transfer'].includes(url.pathname)) {
          const parsed: unknown = JSON.parse(body.toString('utf8'));
          if (url.pathname === '/kefuapi/login') {
            if (!exactBodyKeys(parsed, ['account', 'password'])
              || !['actual-kefu-one', 'actual-kefu-two'].includes(String(parsed.account)) || parsed.password !== f.password) {
              throw Error('Browser harness forwards only its owned dedicated login accounts');
            }
            intentionalBody = parsed;
          } else {
            if (!exactBodyKeys(parsed, ['uid', 'kefuToUid', 'is_tourist', 'request_key']) || parsed.uid !== 201 || parsed.kefuToUid !== 102
              || parsed.is_tourist !== 0 || typeof parsed.request_key !== 'string'
              || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(parsed.request_key)
              || (req.headers['idempotency-key'] !== undefined && req.headers['idempotency-key'] !== parsed.request_key)) {
              throw Error('Browser harness forwards only registered fixture customer201 transfer to Kefu102');
            }
            intentionalBody = parsed;
          }
        } else if (body.length) {
          throw Error('Owned read requests must not contain an application body');
        }
        const headers = new Headers();
        for (const [name, values] of Object.entries(req.headers)) if (values !== undefined) headers.set(name, Array.isArray(values) ? values.join(',') : values);
        const observationOrigin = headers.get('x-owned-acceptance-origin') ?? GUI_OR_DEFAULT_ORIGIN;
        if (![GUI_OR_DEFAULT_ORIGIN, SUPPLEMENTAL_ORIGIN].includes(observationOrigin)
          || (req.method === 'POST' && url.pathname === '/kefuapi/service/transfer' && observationOrigin !== GUI_OR_DEFAULT_ORIGIN)) {
          throw Error('Browser transfer must retain the GUI/default origin; supplemental requests must identify themselves');
        }
        // Observation is not authorization: the real router still verifies the
        // same bearer, cache, dedicated account and current SQL permissions.
        let observedCaller: Record<string, unknown> | null = null;
        const authorization = headers.get('Authori-zation') || headers.get('Authorization');
        const bearer = authorization ? authorization.replace(/^Bearer\s+/, '').trim() : null;
        if (bearer) {
          const tokenSha256 = createHash('sha256').update(bearer).digest('hex');
          try {
            const token = await verifyToken(bearer, f.env.APP_KEY), issued = issuedLogins.get(tokenSha256);
            observedCaller = { jwtVerifiedForObservation: true, authId: token.id, type: token.type,
              tokenSha256, ...(issued ? { dedicatedLogin: issued } : {}) };
          } catch { observedCaller = { jwtVerifiedForObservation: false, tokenSha256 }; }
        }
        const before = await snapshot(), resources = resourcesNow(), afterTransfer = successfulTransfers > 0;
        statements.length = 0;
        const legacyStaticGet = req.method === 'GET' && url.pathname === legacyStaticReference;
        const legacyStaticHead = req.method === 'HEAD' && url.pathname === legacyStaticReference;
        const response = legacyStaticGet || legacyStaticHead ? (() => {
          if (legacyStaticGet) staticCounters.get++; else staticCounters.head++;
          return new Response(legacyStaticGet ? f.png : null, { status: 200,
            headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': String(f.png.length) } });
        })() : await app.request('http://127.0.0.1' + path, { method: req.method, headers, ...(body.length ? { body } : {}) }, f.env);
        const bytes = new Uint8Array(await response.arrayBuffer()), after = await snapshot(), end = resourcesNow();
        const splitCartGet = req.method === 'GET' && /^\/kefuapi\/order\/split_cart_info\/[^/]+$/.test(url.pathname);
        const orderMediaGet = req.method === 'GET' && /^\/kefuapi\/order\/(?:list|info)\/[^/]+$/.test(url.pathname);
        const fulfillmentOptionGet = req.method === 'GET' && ['/kefuapi/order/export', '/kefuapi/order/delivery_all'].includes(url.pathname);
        const assetGet = req.method === 'GET' && /^\/kefuapi\/assets\/[1-9]\d*$/.test(url.pathname);
        const protectedGet = splitCartGet || orderMediaGet || fulfillmentOptionGet || assetGet || legacyStaticGet;
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
        if (splitCartGet) entrance = 'split-cart-preview';
        else if (orderMediaGet) {
          if (/\/order\/list\//.test(url.pathname)) entrance = url.searchParams.get('type') === '-1' ? 'customer-active-refunds' : 'customer-orders';
          else if (/\/order\/info\//.test(url.pathname)) entrance = 'order-detail';
          else if (/\/order\/refund\/detail\//.test(url.pathname)) entrance = 'refund-detail';
          else entrance = 'global-refund-list';
        }
        const json = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(new TextDecoder().decode(bytes)) : null;
        const requestIndex = requests.length;
        const callerIsOldDedicatedKefu = observedCaller?.jwtVerifiedForObservation === true && observedCaller.authId === 1
          && observedCaller.type === 'kefu'
          && (observedCaller.dedicatedLogin as { account?: string; principalUid?: number } | undefined)?.account === 'actual-kefu-one'
          && (observedCaller.dedicatedLogin as { principalUid?: number } | undefined)?.principalUid === 101;
        if (response.status === 200 && json?.status === 200 && entrance) observedEntrances.add(entrance);
        let loginIdentity: Record<string, unknown> | null = null;
        if (req.method === 'POST' && url.pathname === '/kefuapi/login' && json?.status === 200) {
          const actual = await verifyToken(json.data.token, f.env.APP_KEY), account = String(intentionalBody?.account);
          const principalUid = Number(json.data.kefuInfo.uid);
          expect(actual.type).toBe('kefu'); expect(actual.id).toBe(account === 'actual-kefu-one' ? 1 : 2);
          expect(principalUid).toBe(account === 'actual-kefu-one' ? 101 : 102);
          const identity = { account, authId: actual.id, principalUid, issuedBeforeTransfer: !afterTransfer };
          issuedLogins.set(createHash('sha256').update(json.data.token).digest('hex'), identity); loginIdentity = identity;
        }
        const intentionalTransferPost = req.method === 'POST' && url.pathname === '/kefuapi/service/transfer';
        if (intentionalTransferPost && json?.status === 200) {
          expect(callerIsOldDedicatedKefu).toBe(true); expect(observationOrigin).toBe(GUI_OR_DEFAULT_ORIGIN); successfulTransfers++;
        }
        const mediaTickets: Record<string, unknown>[] = [];
        if (splitCartGet && json?.status === 200) {
          expect(json.data.map((cart: { id: number }) => cart.id)).toEqual(f.expectedCartIds);
          for (const cart of json.data) for (const [slot, image] of [
            ['image', cart.image], ['cart_info.product.image', cart.cart_info?.product?.image],
            ['cart_info.product.attrInfo.image', cart.cart_info?.product?.attrInfo?.image],
            ['cart_info.productInfo.image', cart.cart_info?.productInfo?.image],
            ['cart_info.productInfo.attrInfo.image', cart.cart_info?.productInfo?.attrInfo?.image],
            ['cart_info.sku.image', cart.cart_info?.sku?.image],
          ]) {
            if (typeof image !== 'string' || !image.startsWith('/api/assets/')) continue;
            const ticket = new URL(image, 'https://owned-kefu-split-media.local');
            const expires = Number(ticket.searchParams.get('expires'));
            const expected = createHmac('sha256', f.env.APP_KEY).update(`GET\n${ticket.pathname}\n${expires}`).digest('base64url');
            expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
            expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 900);
            expect(ticket.searchParams.get('signature')).toBe(expected);
            mediaTickets.push({ cartId: cart.id, slot, reference: ticket.pathname, expires,
              signature: ticket.searchParams.get('signature'), expected });
            if (response.status === 200 && !afterTransfer && callerIsOldDedicatedKefu) {
              const assetPath = ticket.pathname.replace(/^\/api\//, '/kefuapi/');
              const identity = JSON.stringify([assetPath, ticket.searchParams.get('expires'), ticket.searchParams.get('signature')]);
              splitTickets.set(identity, { sourceSplitRequestIndex: requestIndex, reference: ticket.pathname, cartId: cart.id, slot });
            }
          }
          if (response.status === 200 && !afterTransfer && callerIsOldDedicatedKefu && observationOrigin === GUI_OR_DEFAULT_ORIGIN) {
            successfulGuiSplitIndex ??= requestIndex;
          }
        }
        const splitIssuedTicket = assetGet ? splitTickets.get(JSON.stringify([url.pathname, url.searchParams.get('expires'), url.searchParams.get('signature')])) ?? null : null;
        const realtimeExcluded = ['/kefuapi/ws', '/kefuapi/messages/socket'].includes(url.pathname);
        const row: Record<string, unknown> = {
          path: redactedPath(path), method: req.method, http: response.status, before: sha(before), after: sha(after),
          splitCartGet, orderMediaGet, assetGet, legacyStaticGet, protectedGet, entrance, intentionalTransferPost, realtimeExcluded,
          requestIndex, query: Object.fromEntries(url.searchParams), observationOrigin, observedCaller, loginIdentity,
          afterTransfer, beforeState: await retain(before), afterState: await retain(after), statements: [...statements], mediaTickets, splitIssuedTicket,
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
        res.end('Owned split-cart media fixture error: ' + message);
        requests.push({ path: redactedPath(req.url ?? '/'), method: req.method, adapterError: message });
      }); });
      try {
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned local split-cart media listener');
        await writeFile(artifact('ready.json'), JSON.stringify({
        apiOrigin: `http://127.0.0.1:${address.port}`, tables, sequences, sqlIdentity: identity,
        account: 'actual-kefu-one', password: f.password, targetAccount: 'actual-kefu-two',
        customer: { uid: 201, search: '唯一客户搜索', targetKefuUid: 102 },
        ids: f.ids,
        suggestedUi: { page: '/workbench', inspector: '订单',
          order: { id: f.ids.order, number: `owned-split-preview-${f.ids.order}` },
          action: '订单履约', splitToggle: '仅发本次选中的商品（拆单发货）',
          selectionRows: f.expectedCartIds, selectionInputs: 7, perRowSurplus: 2,
          submitIsOutsideAcceptance: true,
          richMessages: [{ logId: 1901, type: 6, id: f.ids.order }] },
        expectedImages: {
          splitDialogIsTextOnly: true, splitGuiThumbnails: 0,
          detailOrRichImageDecodingIsExistingUiAndDoesNotProveSplitGuiThumbnails: true,
          pngBytes: f.png.length, pngSha256: createHash('sha256').update(f.png).digest('hex'), naturalWidth: 1, naturalHeight: 1,
          splitPreviewJson: { route: `/kefuapi/order/split_cart_info/${f.ids.order}`, cartIds: f.expectedCartIds,
            topPlatformCartIds: [f.ids.carts.platform, f.ids.carts.supplier, f.ids.carts.store, f.ids.carts.array],
            topBlankCartIds: [f.ids.carts.forged, f.ids.carts.empty], legacyCartIds: [f.ids.carts.legacy],
            supplierRawPath: { cartId: f.ids.carts.supplier, path: 'cart_info.product.attrInfo.image', reference: '/api/assets/9102' },
            rawArrayPreserved: { cartId: f.ids.carts.array, path: 'cart_info.product.image', value: ['/api/assets/9101'] } },
          supplementalDecode: { source: 'actual split GET response, not invented URLs',
            signedPaths: ['image', 'cart_info.product.attrInfo.image'],
            signedReferences: ['/api/assets/9101', '/api/assets/9102'],
            frontendAssetsProxyPrefix: '/kefuapi/assets/',
            note: 'Supplementary JSON/asset requests and decoded image checks must be reported separately from GUI text-only split selection.' },
          legacyStatic: { reference: legacyStaticReference, signing: false, r2Reads: 0 },
        },
        postTransferProbe: { route: `/kefuapi/order/split_cart_info/${f.ids.order}`, oldAccountExpectedStatus: 404,
          requiredOrigin: SUPPLEMENTAL_ORIGIN, dedicatedAuthId: 1, dedicatedPrincipalUid: 101, tokenMustHaveBeenIssuedBeforeTransfer: true,
          note: 'Keep a real actual-kefu-one token issued before transfer for this supplemental HTTP probe. Cleared GUI does not automatically call this endpoint.' },
        forwardingBoundary: { fixtureCustomers: [...fixtureCustomers], reads: 'exact fixture path, method and query allowlist in harness source',
          postLogin: 'only two owned dedicated accounts/password', postTransfer: 'only registered customer201 to Kefu102 with valid request_key and GUI/default origin',
          statusEndpoint: 'GET /__owned/status without query only', headsOrOtherMethodsAllowed: false,
          guiOriginLabelAloneDoesNotProveGuiExecution: true },
        onlyActualTransferPost: '/kefuapi/service/transfer; no fixture ownership-mutation endpoint',
        realtimeWebSocketNotProvidedByNodeFixture: true,
        }, null, 2) + '\n');
        console.info('KEFU_SPLIT_CART_MEDIA_BROWSER_READY', JSON.stringify({ directory, apiPort: address.port }));
        let done = false;
        for (let elapsed = 0; elapsed < 90 * 60 && !done; elapsed++) {
          try { done = (await readFile(artifact('finish'), 'utf8')).trim() === 'done'; } catch { /* Explicit owned completion marker is pending. */ }
          if (!done) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        expect(done, 'Browser must write its explicit completion marker').toBe(true); await chain;
        expect(adapterErrors).toEqual([]);
        const oldCaller = (row: Record<string, unknown>) => {
          const caller = row.observedCaller as { jwtVerifiedForObservation?: boolean; authId?: number; type?: string;
            dedicatedLogin?: { account?: string; principalUid?: number; issuedBeforeTransfer?: boolean } } | null;
          return caller?.jwtVerifiedForObservation === true && caller.authId === 1 && caller.type === 'kefu'
            && caller.dedicatedLogin?.account === 'actual-kefu-one' && caller.dedicatedLogin.principalUid === 101;
        };
        const success = (row: Record<string, unknown>) => row.http === 200 && (row.payload as { status?: number } | undefined)?.status === 200;
        const guiRead = (path: string, query: Record<string, string>) => requests.some(row => row.method === 'GET'
          && String(row.path).split('?')[0] === path && !row.afterTransfer && row.observationOrigin === GUI_OR_DEFAULT_ORIGIN
          && oldCaller(row) && success(row) && JSON.stringify(row.query) === JSON.stringify(query));
        finishGates.successfulGuiDefaultList201 = guiRead('/kefuapi/order/list/201', { limit: '20' });
        finishGates.successfulGuiDefaultDetail7501 = guiRead('/kefuapi/order/info/7501', {});
        finishGates.successfulGuiDefaultSplit7501 = guiRead('/kefuapi/order/split_cart_info/7501', {});
        finishGates.successfulGuiDefaultExpressOptions = guiRead('/kefuapi/order/export', { status: '1' });
        finishGates.successfulGuiDefaultDeliveryAgents = guiRead('/kefuapi/order/delivery_all', { limit: '100' });
        for (const reference of ['/kefuapi/assets/9101', '/kefuapi/assets/9102']) {
          finishGates['splitIssuedPng' + reference.split('/').at(-1)] = requests.some(row => {
            if (!row.assetGet || row.http !== 200 || String(row.path).split('?')[0] !== reference) return false;
            const binding = row.splitIssuedTicket as { sourceSplitRequestIndex: number; reference: string; cartId: number; slot: string } | null;
            if (!binding || binding.sourceSplitRequestIndex >= Number(row.requestIndex)) return false;
            const source = requests[binding.sourceSplitRequestIndex], query = row.query as Record<string, string>;
            return source?.splitCartGet === true && !source.afterTransfer && success(source) && oldCaller(source)
              && (source.mediaTickets as { reference: string; expires: number; signature: string; cartId: number; slot: string }[]).some(ticket =>
                ticket.reference === binding.reference && ticket.reference.replace(/^\/api\//, '/kefuapi/') === reference
                && String(ticket.expires) === query.expires && ticket.signature === query.signature
                && ticket.cartId === binding.cartId && ticket.slot === binding.slot);
          });
        }
        finishGates.actualLegacyPngAfterSuccessfulGuiSplit = successfulGuiSplitIndex !== null && requests.some(row => row.legacyStaticGet
          && row.http === 200 && Number(row.requestIndex) > successfulGuiSplitIndex!);
        finishGates.registered201To102TransferBySameDedicatedActorWithGuiDefaultOrigin = requests.some(row => row.intentionalTransferPost
          && row.observationOrigin === GUI_OR_DEFAULT_ORIGIN && oldCaller(row) && success(row)
          && exactBodyKeys(row.intentionalBody, ['uid', 'kefuToUid', 'is_tourist', 'request_key'])
          && row.intentionalBody.uid === 201 && row.intentionalBody.kefuToUid === 102 && row.intentionalBody.is_tourist === 0);
        finishGates.oldDedicatedCallerSupplementalSplit404AfterTransfer = requests.some(row => row.splitCartGet && row.afterTransfer
          && row.observationOrigin === SUPPLEMENTAL_ORIGIN && row.http === 200 && oldCaller(row)
          && ((row.observedCaller as { dedicatedLogin?: { issuedBeforeTransfer?: boolean } }).dedicatedLogin?.issuedBeforeTransfer === true)
          && (row.payload as { status?: number } | undefined)?.status === 404);
        for (const [gate, passed] of Object.entries(finishGates)) expect(passed, gate).toBe(true);
      } finally {
        await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); await chain;
        await writeFile(artifact('server-execution.json'), JSON.stringify({
          tables, sequences, finalInventory: await f.inventory(), sqlIdentity: identity, requests, adapterErrors,
          observedEntrances: [...observedEntrances].sort(), successfulTransfers, resources: resourcesNow(), finalStateSha256: sha(await snapshot()),
          finalState: await retain(await snapshot()), completeSnapshotFiles: [...retained].sort(),
          finishGates, successfulGuiSplitIndex,
          legacyStatic: { reference: legacyStaticReference, bytes: f.png.length, sha256: createHash('sha256').update(f.png).digest('hex'), ...staticCounters, r2Reads: 0 },
          realtimeScope: 'Node transport fixture does not provide Cloudflare WebSocket upgrade; no realtime acceptance claimed',
          guiAcceptanceIsSeparateEvidence: true, splitDialogIsTextOnly: true, splitGuiThumbnails: 0,
        }, null, 2) + '\n');
      }
    });
  } finally { await f.close(); }
});
