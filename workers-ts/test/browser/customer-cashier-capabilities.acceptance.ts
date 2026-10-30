/** Real built H5, ordinary App JWT and five independent PG16 LOGINs. Only the
 * local login, private storage/queue/sequence adapters and qualification edit
 * are fixtures. Capability, draft, creation, cash, receipts and App paid
 * consumption execute production code. No Browser business response mocking. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { createConnection } from 'node:net';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { storeOrderCartInfo, storeOrderOutbox, storeProduct, storeProductAttrValue, storeService, user } from '@/models/schema';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { customerCashierRuntimeHttpFixture } from '../helpers/customerCashierRuntimeHttpFixture';

const wiring = vi.hoisted(() => ({ application: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.application) throw Error('Owned App Browser fixture unavailable'); return wiring.application; },
}));
type Row = Record<string, any>;
type Origin = { path: string; bytes: number; sha256: string };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const base = '/api/mobile/work/cashier/second-card';
const stages = ['home', 'quote', 'created', 'paid', 'revoked-home', 'owner-recovery'] as const;
type Stage = typeof stages[number];
async function bodyOf(request: IncomingMessage) {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) { const bytes = Buffer.from(part); size += bytes.length;
    if (size > 262144) throw Error('Cashier Browser request exceeds fixed body bound'); parts.push(bytes); }
  return Buffer.concat(parts);
}
async function tree(root: string): Promise<Origin[]> {
  const result: Origin[] = [];
  async function visit(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name); if (entry.isSymbolicLink()) throw Error('Symlink in actual H5 build');
      if (entry.isDirectory()) await visit(path);
      else { if (!entry.isFile()) throw Error('Unexpected H5 build object'); const bytes = await readFile(path);
        result.push({ path: relative(root, path), bytes: bytes.length, sha256: hash(bytes) }); }
    }
  }
  await visit(root); return result;
}

describe.sequential('actual H5 Cashier entry, cash producer and original owner recovery on PG16', () => {
  let f: Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
  let server: ReturnType<typeof createServer> | undefined, child: ChildProcess | undefined;
  let output = '', origin = '', token = '', fixtureClosed = false, serverClosed = false;
  let portRefused = false;
  let buildBefore: Origin[] = [], buildAfter: Origin[] = [];
  let baseline: Row;
  let paidFacts: Row, revokedFacts: Row, creation: Row, payment: Row, orderId = 0;
  let creationReceipt: Row, paymentReceipt: Row, serviceBefore: Row;
  let phase = 0, driverFailure: Error | undefined, bridgeFailure: Error | undefined;
  let external: ReturnType<typeof vi.spyOn>;
  const calls: Row[] = [], checkpoints: Row[] = [], unexpected: string[] = [];
  const stageResults = new Map<Stage, Row>();
  const waiting = new Map<string, { resolve: (value: Row) => void; reject: (error: Error) => void }>();
  let chain = Promise.resolve();
  function serial<T>(work: () => Promise<T>) {
    const previous = chain; let release!: () => void; chain = new Promise<void>(yes => { release = yes; });
    return previous.then(work).finally(release);
  }
  const report = (tag: string, value: unknown) => process.stdout.write(tag + ' ' + JSON.stringify(value) + '\n');
  const failDriver = (error: Error) => { driverFailure ??= error; for (const pending of waiting.values()) pending.reject(driverFailure); waiting.clear(); };
  function awaitMessage(key: string) {
    if (driverFailure) return Promise.reject(driverFailure);
    return new Promise<Row>((yes, no) => { waiting.set(key, { resolve: yes, reject: no }); });
  }
  async function stage(name: Stage) {
    expect(name).toBe(stages[phase]); if (driverFailure) throw driverFailure; if (bridgeFailure) throw bridgeFailure;
    if (!child?.connected) throw Error('Real Browser driver is not connected');
    const pending = awaitMessage(name); child.send({ type: 'stage', name });
    const result = await pending; if (driverFailure) throw driverFailure; if (bridgeFailure) throw bridgeFailure;
    stageResults.set(name, result); phase++; return result;
  }
  async function receipt(kind: 'creations' | 'payments', key: string) {
    const response = await f.raw('/mobile/work/cashier/second-card/' + kind + '/' + key,
      { headers: { 'Authori-zation': 'Bearer ' + token } });
    const body = await response.json() as Row; expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    return body.data.receipt as Row;
  }
  const actualCalls = (path: string, method = 'GET') => calls.filter(call => call.pathname === path && call.method === method);
  const latest = (path: string, method = 'GET') => actualCalls(path, method).at(-1)!;
  const checkpoint = (name: string, data: Row) => { const entry = { name, ...data }; checkpoints.push(entry); report('CASHIER_BROWSER_SQL', entry); };

  beforeAll(async () => {
    output = process.env.TEST_BROWSER_OUTPUT_DIR ?? '';
    const packageJson = process.env.TEST_BROWSER_PACKAGE_JSON, executable = process.env.TEST_BROWSER_EXECUTABLE;
    if (!output || !packageJson || !executable) throw Error('Explicit installed browser tooling and external output required');
    if (process.env.TEST_CUSTOMER_CASHIER_CAPABILITIES_BROWSER !== '1') throw Error('Cashier Browser opt-in absent');
    expect((await stat(output)).isDirectory()).toBe(true);
    expect(await readdir(output), 'Fresh empty Browser output directory is required').toEqual([]);
    const root = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5');
    buildBefore = await tree(root); expect(buildBefore.some(row => row.path === 'index.html')).toBe(true);
    external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider HTTP in local Cashier Browser'));
    f = await customerCashierRuntimeHttpFixture(); f.env.CUSTOMER_CASHIER_RUNTIME_TARGET = f.commissioned.target;
    await f.reset('7.00', 'none');
    // Product media is outside this no-form acceptance; remove only the local
    // synthetic fixture image, rather than loading a fabricated public asset.
    await f.maintenanceDb.update(storeProduct).set({ image: '' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ image: '' }).where(eq(storeProductAttrValue.id, 1));
    wiring.application = createContainerFromDb(f.appRuntime.db); const application = createApp();
    token = await f.bearer(101); baseline = await f.facts();
    const [appIdentity] = await f.appRuntime.db.execute(sql`SELECT current_user AS role,current_database() AS database,
      (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`);
    expect(appIdentity.database).toBe(f.commissioned.binding.database); expect(appIdentity.database_oid).toBe(f.commissioned.binding.databaseOid);
    expect(appIdentity.role).toBe(f.target.app); expect(appIdentity.role_oid).not.toBe(f.commissioned.binding.roleOid);
    checkpoint('fixture', { appIdentity, cashierBinding: f.commissioned.binding,
      login: 'local synthetic signed AppJWT; real server authentication, original UID101 and five native LOGINs',
      build_files: buildBefore.length, build_manifest_sha256: hash(Buffer.from(JSON.stringify(buildBefore))),
      build_source_join: 'Caller must bind its fresh H5 build terminal and frozen source to this physical served-file manifest.' });
    const allowedGet = (path: string) => ['/api/get_script', '/api/site_config', '/api/share', '/api/navigation', '/api/diy/diy_version/0',
      '/api/v2/diy/color_change/color_change', '/api/diy/get_suspended', '/api/mobile/work/context', '/api/mobile/work/overview',
      '/api/mobile/work/users', base + '/capabilities', base + '/catalog', base + '/records'].includes(path)
      || /^\/api\/mobile\/work\/users\/[1-9]\d*$/u.test(path)
      || /^\/api\/mobile\/work\/cashier\/second-card\/(?:catalog|records)\/[1-9]\d*$/u.test(path)
      || /^\/api\/mobile\/work\/cashier\/second-card\/(?:creations|payments)\/[a-f0-9-]{36}$/u.test(path);
    const allowedPost = (path: string) => [base + '/drafts', base + '/quote', base + '/orders'].includes(path)
      || /^\/api\/mobile\/work\/cashier\/second-card\/orders\/[1-9]\d*\/cash$/u.test(path);
    server = createServer((request, response) => {
      void serial(async () => {
        if (request.socket.remoteAddress !== '127.0.0.1') throw Error('Non-loopback Cashier Browser request');
        const url = new URL(request.url ?? '/', origin), path = url.pathname;
        if (request.headers.host !== new URL(origin).host) throw Error('Unexpected Cashier Browser Host');
        response.setHeader('Cache-Control', 'private, no-store');
        if (path.startsWith('/api/')) {
          const method = request.method ?? '';
          if (!(method === 'GET' && allowedGet(path) || method === 'POST' && allowedPost(path))) {
            unexpected.push(method + ' ' + path); throw Error('Unexpected actual Cashier API');
          }
          const bytes = await bodyOf(request), headers = new Headers();
          for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
          const pending: Promise<unknown>[] = [];
          const execution = { waitUntil: (value: Promise<unknown>) => { pending.push(value); }, passThroughOnException() {} } as ExecutionContext;
          const result = await application.fetch(new Request(origin + path + url.search, { method, headers,
            ...(bytes.length ? { body: bytes.toString('utf8') } : {}) }), f.env, execution);
          await Promise.all(pending); const raw = Buffer.from(await result.arrayBuffer());
          const body = path === '/api/get_script' ? null : JSON.parse(raw.toString()) as Row;
          calls.push({ pathname: path, search: url.search, method, http: result.status, status: body?.status ?? null, message: body?.msg ?? null,
            cache_control: result.headers.get('Cache-Control'),
            ...(path.startsWith('/api/mobile/work/') ? { data: body?.data ?? null } : {}),
            ...(bytes.length ? { request: JSON.parse(bytes.toString()), request_key: headers.get('Idempotency-Key') } : {}) });
          response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(raw); return;
        }
        if (request.method !== 'GET') throw Error('Unexpected static mutation');
        if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
        let file = resolve(root, '.' + decodeURIComponent(path));
        if (file !== root && !file.startsWith(root + sep)) throw Error('Static file outside actual H5 build');
        if (file === root || !extname(file)) file = join(root, 'index.html');
        const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
          '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
        response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file));
      }).catch(error => {
        bridgeFailure ??= error instanceof Error ? error : Error(String(error));
        if (!response.headersSent) response.writeHead(500); response.end('Owned Cashier Browser bridge failure');
        failDriver(bridgeFailure);
      });
    });
    await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(0, '127.0.0.1', yes); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing local Cashier Browser address');
    origin = 'http://127.0.0.1:' + address.port; report('CASHIER_BROWSER_HTTP', { origin });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['path', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'localappdata', 'userprofile'].includes(name.toLowerCase())));
    environment.NODE_OPTIONS = '--max-old-space-size=2048';
    child = fork(resolve(import.meta.dirname, 'customer-cashier-capabilities.driver.mjs'), [], { env: environment as unknown as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout?.on('data', bytes => report('CASHIER_BROWSER_DRIVER', { stdout: String(bytes).trim() }));
    child.stderr?.on('data', bytes => failDriver(Error('Browser driver stderr: ' + String(bytes).trim())));
    child.on('error', failDriver);
    child.on('exit', (code, signal) => { if (waiting.size) failDriver(Error('Browser exited before stage result: ' + code + '/' + signal)); });
    child.on('message', (value: unknown) => {
      const message = value as Row;
      if (message?.type === 'failure') { failDriver(Error(String(message.message))); return; }
      const key = message?.type === 'ready' ? 'ready' : message?.type === 'stage-result' ? message.name : undefined;
      const pending = typeof key === 'string' ? waiting.get(key) : undefined;
      if (!pending) { failDriver(Error('Unexpected Cashier Browser IPC')); return; }
      waiting.delete(key); pending.resolve(message.type === 'ready' ? message : message.data);
    });
    const ready = awaitMessage('ready'); child.send({ type: 'start', baseUrl: origin, output, packageJson, executable, uid: 101, token });
    await ready;
  }, 180000);

  it('shows actual dedicated Cashier entry while ordinary App stays false on mobile and desktop', async () => {
    await stage('home');
    const context = latest('/api/mobile/work/context'), cap = latest(base + '/capabilities');
    expect(context).toMatchObject({ http: 200, status: 200 }); expect(context.data.data.capabilities.cashier_second_card).toBe(false);
    expect(cap).toMatchObject({ http: 200, status: 200, search: '' });
    expect(cap.data.data.capabilities).toEqual({ cashier_second_card: true, cashier_form_images: true });
    expect(cap.data.actor_uid).toBe(context.data.actor_uid); expect(cap.data.principal).toEqual(context.data.principal); expect(cap.data.scope_key).toBe(context.data.scope_key);
    expect(cap.data.consistency_key).not.toBe(context.data.consistency_key);
    expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders)).ready).toBe(true);
    const [acl] = await f.appRuntime.db.execute(sql`SELECT has_table_privilege(current_user,'cashier_second_card_cart_v1','INSERT') AS draft,
      has_table_privilege(current_user,'cashier_second_card_form_session_v1','INSERT') AS image,
      has_table_privilege(current_user,'customer_city_delivery_job','SELECT') AS city`);
    expect(acl).toEqual({ draft: false, image: false, city: false }); expect(await f.facts()).toEqual(baseline);
    checkpoint('home', { App_cashier_false: true, dedicated_cashier_true: true, App_grants_unchanged: true, facts_unchanged: true });
  }, 30000);

  it('selects actual member/SKU and saves the original draft and quote through the rendered page', async () => {
    const result = await stage('quote'); creation = result.creation;
    expect(creation).toMatchObject({ actor_uid: 101, kind: 'creation', body: { product_id: 70, sku_unique: 'qared001', buyer_uid: 11, quantity: 1 } });
    expect(creation.request_hash).toBe(await outRequestHash(creation.body));
    const draft = latest(base + '/drafts', 'POST'); expect(draft).toMatchObject({ http: 200, status: 200, request_key: creation.request_key });
    expect(draft.request).toEqual(creation.body); expect(draft.data.request_hash).toBe(creation.request_hash);
    expect(latest(base + '/quote', 'POST')).toMatchObject({ http: 200, status: 200 });
    expect(actualCalls('/api/mobile/work/users').length).toBeGreaterThan(0); expect(actualCalls('/api/mobile/work/users/11').length).toBeGreaterThan(0);
    const [row] = await f.maintenanceDb.execute(sql`SELECT request_hash FROM cashier_second_card_cart_v1 WHERE actor_uid=101 AND request_key=${creation.request_key}::uuid`);
    expect(row.request_hash).toBe(creation.request_hash);
    expect((await f.facts()).orders).toBeNull(); expect((await f.facts()).payments).toBeNull();
    checkpoint('quote', { creation_key: creation.request_key, creation_hash: creation.request_hash, actual_draft: true, no_order_or_payment: true });
  }, 30000);

  it('creates the actual unpaid original order and immutable Cashier origin', async () => {
    await stage('created'); const created = latest(base + '/orders', 'POST');
    expect(created).toMatchObject({ http: 200, status: 200, request_key: creation.request_key }); orderId = created.data.receipt.order_id;
    const order = await f.order(orderId); expect(order).toMatchObject({ paid: 0, uid: 11, staffId: 101 });
    creationReceipt = await receipt('creations', creation.request_key); expect(creationReceipt).toEqual(created.data.receipt);
    const [originRow] = await f.maintenanceDb.execute(sql`SELECT request_key::text,request_hash,origin_hash FROM cashier_second_card_origin_v1 WHERE actor_uid=101 AND order_id=${orderId}`);
    expect(originRow).toMatchObject({ request_key: creation.request_key, request_hash: creation.request_hash, origin_hash: creationReceipt.origin_hash });
    expect((await f.maintenanceDb.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(9);
    expect((await f.maintenanceDb.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0].stock).toBe(9);
    expect((await f.facts()).origins).toHaveLength(1);
    expect((await f.facts()).payments).toBeNull();
    checkpoint('created', { order_id: orderId, creation_key: creation.request_key, origin_hash: originRow.origin_hash, paid: 0, stock: 9 });
  }, 30000);

  it('records actual cash then consumes its original outbox under App without duplicating facts', async () => {
    const result = await stage('paid'); payment = result.payment;
    const cash = latest(base + '/orders/' + orderId + '/cash', 'POST');
    expect(cash).toMatchObject({ http: 200, status: 200, request_key: payment.request_key });
    expect(payment.request_hash).toBe(await outRequestHash(payment.body));
    expect(payment.body).toMatchObject({ order_id: orderId, expected_amount: '7.00' });
    expect(cash.data.evidence).toMatchObject({ paid: 1, order_id: orderId, buyer_uid: 11, creator_uid: 101, amount: '7.00' });
    const [event] = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, cash.data.outbox.id));
    expect(event.eventKey).toBe(cash.data.outbox.eventKey);
    expect(f.messages).toContainEqual({ action: 'processOrderPaidOutbox', outboxId: event.id, eventKey: event.eventKey });
    const consumed = await f.consume({ id: event.id, eventKey: event.eventKey });
    expect((await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, event.id)))[0].status).toBe('COMPLETED');
    const order = await f.order(orderId), [item] = await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, orderId));
    expect(order).toMatchObject({ uid: 11, staffId: 101, paid: 1, payType: 'cash' });
    expect(item).toMatchObject({ cartNum: 1, writeTimes: 3, writeSurplusTimes: 3, writeStart: order.payTime, writeEnd: order.payTime + 10 * 86400 });
    const [account] = await f.maintenanceDb.select().from(user).where(eq(user.uid, 11));
    expect(account).toMatchObject({ nowMoney: '100.00', integral: 100 });
    creationReceipt = await receipt('creations', creation.request_key); paymentReceipt = await receipt('payments', payment.request_key);
    expect(paymentReceipt.evidence).toEqual(cash.data.evidence); paidFacts = await f.facts();
    expect(paidFacts.origins).toHaveLength(1); expect(paidFacts.payments).toHaveLength(1); expect(paidFacts.outbox).toHaveLength(1);
    expect(await consumed.consumer.processMessage(consumed.message)).toBe('already-completed');
    expect(await f.facts()).toEqual(paidFacts);
    const [service] = await f.maintenanceDb.select().from(storeService).where(eq(storeService.id, 1)); serviceBefore = service;
    await f.maintenanceDb.update(storeService).set({ customer: 0 }).where(eq(storeService.id, 1)); revokedFacts = await f.facts();
    expect(revokedFacts).toEqual(paidFacts);
    checkpoint('paid-and-qualification-revoked', { order_id: orderId, payment_key: payment.request_key,
      payment_evidence_hash: await outRequestHash(paymentReceipt.evidence), paid: 1, App_outbox_completed: true,
      write_times: 3, current_qualification: { service_id: 1, uid: 101, customer_before: serviceBefore.customer, customer_after: 0 },
      old_accounts_orders_payments_unchanged_by_qualification_edit: true });
  }, 30000);

  it('keeps the fixed rendered recovery entry on home after real context qualification403', async () => {
    await stage('revoked-home'); const context = latest('/api/mobile/work/context');
    expect(context).toMatchObject({ http: 403, status: 403, data: null });
    expect(await f.facts()).toEqual(revokedFacts);
    checkpoint('revoked-home', { actual_App_context_http: 403, status: 403, same_valid_owner_session: true, recovery_entry_visible: true });
  }, 30000);

  it('queries exact original creation and cash receipts after qualification loss and blocks fresh authors', async () => {
    const result = await stage('owner-recovery');
    const creationCall = latest(base + '/creations/' + creation.request_key), paymentCall = latest(base + '/payments/' + payment.request_key);
    expect(creationCall).toMatchObject({ http: 200, status: 200 }); expect(paymentCall).toMatchObject({ http: 200, status: 200 });
    expect(creationCall.data.receipt).toEqual(creationReceipt); expect(paymentCall.data.receipt).toEqual(paymentReceipt);
    expect(await f.facts()).toEqual(revokedFacts); expect(result.no_new_ui_author_posts_after_revocation).toBe(true);
    const denied = await f.raw('/mobile/work/cashier/second-card/drafts', { method: 'POST',
      headers: { 'Authori-zation': 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(creation.body) });
    expect(denied.status).toBe(403); expect((await denied.json() as Row).status).toBe(403); expect(await f.facts()).toEqual(revokedFacts);
    expect(unexpected).toEqual([]); expect(bridgeFailure).toBeUndefined(); expect(driverFailure).toBeUndefined(); expect(external).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
    checkpoint('owner-recovery', { order_id: orderId, creation_key: creation.request_key, payment_key: payment.request_key,
      exact_original_receipts: true, recovery_get_facts_unchanged: true, no_UI_author_dispatch: true, direct_new_author_http403: true });
    const evidence = { status: 'real_h5_native_cashier_owner_recovery_passed', stages: [...stageResults.keys()], checkpoints, calls,
      browser: result, direct_new_author_probe: { source: 'harness real same-JWT production route, not UI click', http: 403, no_business_changes: true },
      accepted_creation_hash: creation.request_hash, accepted_payment_hash: payment.request_hash,
      provider_calls: 0, image_browser_acceptance: false, production_acceptance: false,
      global_php_to_ts_migration_complete: false, h5_build: buildBefore };
    await writeFile(join(output, 'native-browser-result.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  }, 30000);

  afterAll(async () => {
    const failures: string[] = [];
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        const running = child, exited = new Promise<void>(yes => { running.once('exit', () => yes()); });
        if (running.connected) running.send({ type: 'stop' });
        await Promise.race([exited, new Promise<never>((_, no) => setTimeout(() => no(Error('Own Browser child did not close')), 5000).unref())]);
      }
      if (child && (child.exitCode !== 0 || child.signalCode !== null)) throw Error('Own Browser child terminal is not exit0');
    } catch (error) {
      failures.push(String(error));
      // This is only the ChildProcess created by this harness, never another
      // chat or a discovered PID. The driver handles SIGTERM by closing Chrome.
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    try { if (server?.listening) { server.closeAllConnections(); await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); } serverClosed = true; }
    catch (error) { failures.push(String(error)); }
    try {
      if (origin) portRefused = await new Promise<boolean>((yes, no) => {
        const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) });
        socket.once('connect', () => { socket.destroy(); yes(false); });
        socket.once('error', error => { socket.destroy(); if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') yes(true); else no(error); });
        socket.setTimeout(1000, () => { socket.destroy(); no(Error('Owned HTTP close probe timeout')); });
      });
      if (origin) expect(portRefused).toBe(true);
    } catch (error) { failures.push(String(error)); }
    try { if (f && serviceBefore) await f.maintenanceDb.update(storeService).set({ customer: serviceBefore.customer }).where(eq(storeService.id, 1)); }
    catch (error) { failures.push(String(error)); }
    try { if (f) { await f.close(); fixtureClosed = true; } } catch (error) { failures.push(String(error)); }
    wiring.application = undefined;
    try { buildAfter = await tree(resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5')); expect(buildAfter).toEqual(buildBefore); }
    catch (error) { failures.push(String(error)); }
    if (output && (phase !== stages.length || driverFailure || bridgeFailure)) await writeFile(join(output, 'native-browser-failure.json'), JSON.stringify({
      stages_completed: phase, driver_failure: driverFailure ? String(driverFailure) : null,
      bridge_failure: bridgeFailure ? String(bridgeFailure) : null, calls, checkpoints, unexpected,
      h5_build: buildBefore, source: 'real API bridge diagnostic evidence; no successful Browser acceptance inferred',
    }, null, 2) + '\n', { flag: 'wx' });
    if (output) await writeFile(join(output, 'browser-cleanup.json'), JSON.stringify({ stages_completed: phase, server_closed: serverClosed,
      fixture_closed: fixtureClosed, port_refused: portRefused, driver_exit: child?.exitCode ?? null, driver_signal: child?.signalCode ?? null,
      build_files_unchanged: JSON.stringify(buildAfter) === JSON.stringify(buildBefore), cleanup_failures: failures,
      browser_validation_scope: 'Only this local real H5/Cashier flow; global migration, image/browser and production remain unproven' }, null, 2) + '\n', { flag: 'wx' });
    vi.restoreAllMocks(); expect(failures).toEqual([]);
  }, 30000);
});
