/** Independent images acceptance on actual built H5 and five PG16 LOGINs.
 * The private Map R2, login/queue/sequence adapters, qualification edit and one
 * destroyed reply are labelled local fixtures. Multipart, immutable SQL,
 * signed binary reads and App paid consumption execute production code. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { createConnection } from 'node:net';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { auditRuntimeBusinessPrivileges } from '@/migrations/auditRuntimeBusinessPrivileges';
import { storeOrderCartInfo, storeOrderOutbox, storeProduct, storeProductAttrValue, storeService, user, systemAttachment, systemFormData } from '@/models/schema';
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
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoSHD4DwAEpAIg90VMdgAAAABJRU5ErkJggg==', 'base64'));
const PNG_SHA = '6cb56a59fda4e0f66d71373c8bccbd042ec5507efd06c9a9415fb2b29b5bda50';
// Phase20 chooseImage emitter source reviewed; any changed bundle requires review.
const pickerWarningSite = { path: 'assets/index-Db0CkJqG.js', bytes: 571435,
  sha256: '59acdfb979de1b9864f0df6036edeec2c638e4a5558e4bdbb1afee4147e4196c', lineNumber: 24, columnNumber: 210882 };
const stages = ['complete-upload', 'complete-quote', 'complete-created', 'complete-paid', 'lost-upload', 'lost-recover', 'cancel-choose', 'cancel-dismiss', 'cancel-confirm', 'revoked-upload', 'revoked-home', 'revoked-recover', 'revoked-cancel', 'invalidated-upload', 'invalidated-rejected', 'invalidated-recover', 'invalidated-cancel'] as const;
type Stage = typeof stages[number];
async function bodyOf(request: IncomingMessage, maximum = 262144) {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of request) { const bytes = Buffer.from(part); size += bytes.length;
    if (size > maximum) throw Error('Cashier Browser request exceeds fixed body bound'); parts.push(bytes); }
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

describe.sequential('actual H5 Cashier images, private bytes, upload uncertainty, cancellation and owner recovery on PG16', () => {
  let f: Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>;
  let server: ReturnType<typeof createServer> | undefined, child: ChildProcess | undefined;
  let output = '', origin = '', token = '', fixtureClosed = false, serverClosed = false;
  let portRefused = false;
  let buildBefore: Origin[] = [], buildAfter: Origin[] = [];
  let storedFacts: Row;
  let session: Row, image: Row, previewUrl = "", reference = "", scenario = "complete";
  let dropStoredReply = false, droppedReplies = 0;
  let paidFacts: Row, revokedFacts: Row, creation: Row, payment: Row, orderId = 0;
  let invalidatedFacts: Row, rejectedImage: Row, invalidatedContextReads = 0;
  let creationReceipt: Row, paymentReceipt: Row, serviceBefore: Row;
  let phase = 0, driverFailure: Error | undefined, bridgeFailure: Error | undefined;
  let assertionFailure: Error | undefined;
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
  const checkpoint = (name: string, data: Row) => { const entry = { name, ...data }; checkpoints.push(entry); report('CASHIER_IMAGES_BROWSER_SQL', entry); };

  beforeAll(async () => {
    output = process.env.TEST_BROWSER_OUTPUT_DIR ?? '';
    const packageJson = process.env.TEST_BROWSER_PACKAGE_JSON, executable = process.env.TEST_BROWSER_EXECUTABLE;
    if (!output || !packageJson || !executable) throw Error('Explicit installed browser tooling and external output required');
    if (process.env.TEST_CUSTOMER_CASHIER_IMAGES_BROWSER !== '1') throw Error('Cashier Browser opt-in absent');
    expect((await stat(output)).isDirectory()).toBe(true);
    expect(await readdir(output), 'Fresh empty Browser output directory is required').toEqual([]);
    const root = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5');
    buildBefore = await tree(root); expect(buildBefore.some(row => row.path === 'index.html')).toBe(true);
    expect(buildBefore.find(row => row.path === pickerWarningSite.path)).toEqual({
      path: pickerWarningSite.path, bytes: pickerWarningSite.bytes, sha256: pickerWarningSite.sha256 });
    external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider HTTP in local Cashier Browser'));
    f = await customerCashierRuntimeHttpFixture(); f.env.CUSTOMER_CASHIER_RUNTIME_TARGET = f.commissioned.target;
    await f.reset('7.00', 'image');
    // Product catalog media is outside this private form-image acceptance; remove only the local
    // synthetic fixture image, rather than loading a fabricated public asset.
    await f.maintenanceDb.update(storeProduct).set({ image: '' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ image: '' }).where(eq(storeProductAttrValue.id, 1));
    wiring.application = createContainerFromDb(f.appRuntime.db); const application = createApp();
    token = await f.bearer(101);
    const [appIdentity] = await f.appRuntime.db.execute(sql`SELECT current_user AS role,current_database() AS database,
      (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid`);
    expect(appIdentity.database).toBe(f.commissioned.binding.database); expect(appIdentity.database_oid).toBe(f.commissioned.binding.databaseOid);
    expect(appIdentity.role).toBe(f.target.app); expect(appIdentity.role_oid).not.toBe(f.commissioned.binding.roleOid);
    checkpoint('fixture', { appIdentity, cashierBinding: f.commissioned.binding,
      login: 'local synthetic signed AppJWT; real server authentication, original UID101 and five native LOGINs',
      build_files: buildBefore.length, build_manifest_sha256: hash(Buffer.from(JSON.stringify(buildBefore))),
      build_source_join: 'Caller must bind its fresh H5 build terminal and frozen source to this physical served-file manifest.' });
    const multipartPath = (path: string) => /^\/api\/mobile\/work\/cashier\/second-card\/form-sessions\/[a-f0-9-]{36}\/images$/u.test(path);
    const allowedGet = (path: string) => ['/api/get_script', '/api/site_config', '/api/share', '/api/navigation', '/api/diy/diy_version/0',
      '/api/v2/diy/color_change/color_change', '/api/diy/get_suspended', '/api/mobile/work/context', '/api/mobile/work/overview',
      '/api/mobile/work/users', base + '/capabilities', base + '/catalog', base + '/records'].includes(path)
      || /^\/api\/mobile\/work\/users\/[1-9]\d*$/u.test(path)
      || /^\/api\/mobile\/work\/cashier\/second-card\/(?:catalog|records)\/[1-9]\d*$/u.test(path)
      || /^\/api\/mobile\/work\/cashier\/second-card\/(?:creations|payments|form-sessions|form-images)\/[a-f0-9-]{36}$/u.test(path)
      || /^\/api\/assets\/[1-9]\d*$/u.test(path);
    const allowedPost = (path: string) => [base + '/drafts', base + '/quote', base + '/orders', base + '/form-sessions'].includes(path)
      || /^\/api\/mobile\/work\/cashier\/second-card\/form-sessions\/[a-f0-9-]{36}\/(?:images|previews|cancel)$/u.test(path)
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
          const isMultipart = method === 'POST' && multipartPath(path), isAsset = /^\/api\/assets\/[1-9]\d*$/u.test(path);
          const bytes = await bodyOf(request, isMultipart ? 10485760 + 262144 : 262144), headers = new Headers();
          for (let i = 0; i < request.rawHeaders.length; i += 2) headers.append(request.rawHeaders[i]!, request.rawHeaders[i + 1]!);
          let requestData: Row | undefined, multipart: Row | undefined;
          if (isMultipart) {
            const contentType = headers.get('Content-Type') ?? ''; expect(contentType).toMatch(/^multipart\/form-data\s*;.*boundary=/iu);
            const form = await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': contentType } }).formData();
            expect([...form.keys()].sort()).toEqual(['file', 'metadata']);
            const file = form.get('file'); if (!(file instanceof File) || typeof form.get('metadata') !== 'string') throw Error('Actual multipart file/metadata absent');
            requestData = JSON.parse(form.get('metadata') as string) as Row;
            const fileBytes = new Uint8Array(await file.arrayBuffer());
            multipart = { content_type: contentType, body_size: bytes.length, body_sha256: hash(bytes), file_size: file.size,
              file_sha256: hash(fileBytes), mime: file.type, metadata: requestData };
            expect(fileBytes).toEqual(PNG); expect(requestData).toMatchObject({ sha256: PNG_SHA, size: PNG.length, field_id: 'id:"photo"' });
          } else if (bytes.length) requestData = JSON.parse(bytes.toString('utf8')) as Row;
          const pending: Promise<unknown>[] = [];
          const execution = { waitUntil: (value: Promise<unknown>) => { pending.push(value); }, passThroughOnException() {} } as ExecutionContext;
          // Preserve the original bytes, MIME boundary, JWT and UUID headers.
          // Only the exact multipart image route has the larger body budget.
          const result = await application.fetch(new Request(origin + path + url.search, { method, headers,
            ...(bytes.length ? { body: bytes as unknown as BodyInit } : {}) }), f.env, execution);
          await Promise.all(pending); const raw = Buffer.from(await result.arrayBuffer());
          const body = path === '/api/get_script' || isAsset ? null : JSON.parse(raw.toString()) as Row;
          const call: Row = { scenario, pathname: path, search: url.search, method, http: result.status, status: body?.status ?? null,
            message: body?.msg ?? null, cache_control: result.headers.get('Cache-Control'),
            ...(path.startsWith('/api/mobile/work/') ? { data: body?.data ?? null,
              same_fixture_owner_JWT: headers.get('Authori-zation') === 'Bearer ' + token } : {}),
            ...(bytes.length ? { request: requestData, request_key: headers.get('Idempotency-Key') } : {}),
            ...(multipart ? { multipart } : {}) };
          if (isAsset) {
            call.binary = { bytes: raw.length, sha256: hash(raw), type: result.headers.get('Content-Type') };
            if (result.status === 200) { expect(raw).toEqual(Buffer.from(PNG)); expect(call.cache_control).toBe('private, no-store'); expect(call.binary.type).toMatch(/^image\/png/u); }
          }
          calls.push(call);
          if (isMultipart && dropStoredReply) {
            expect(scenario).toBe('lost'); expect(result.status).toBe(200); expect(body?.data?.receipt?.state).toBe('stored');
            const [committed] = await f.maintenanceDb.execute(sql`SELECT state,sha256,size,request_key::text FROM cashier_second_card_form_upload_v1
              WHERE actor_uid=101 AND request_key=${headers.get('Idempotency-Key')}::uuid`);
            expect(committed).toMatchObject({ state: 'stored', sha256: PNG_SHA, size: PNG.length }); expect(f.put).toHaveBeenCalledTimes(1);
            dropStoredReply = false; droppedReplies++; call.reply_destroyed_after_verified_stored_commit = true;
            expect(raw.length).toBeGreaterThan(1);
            call.wire_http = result.status; call.wire_body_bytes = 1; call.wire_expected_body_bytes = raw.length;
            // Deliver genuine response headers and a genuine incomplete body,
            // then disconnect after the write callback. A preheader close can
            // be transparently replayed by the browser/network stack instead.
            response.writeHead(result.status, { ...Object.fromEntries(result.headers), 'Content-Length': raw.length });
            response.flushHeaders();
            await new Promise<void>((yes, no) => response.write(raw.subarray(0, 1), error => {
              if (error) { no(error); return; } response.destroy(); yes();
            }));
            return;
          }
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
    origin = 'http://127.0.0.1:' + address.port; report('CASHIER_IMAGES_BROWSER_HTTP', { origin });
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['path', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'localappdata', 'userprofile'].includes(name.toLowerCase())));
    environment.NODE_OPTIONS = '--max-old-space-size=2048';
    child = fork(resolve(import.meta.dirname, 'customer-cashier-images.driver.mjs'), [], { env: environment as unknown as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout?.on('data', bytes => report('CASHIER_IMAGES_BROWSER_DRIVER', { stdout: String(bytes).trim() }));
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
    const ready = awaitMessage('ready'); child.send({ type: 'start', baseUrl: origin, output, packageJson, executable, uid: 101, token, pickerWarningSite });
    await ready;
  }, 180000);

  async function resetScenario(name: string) {
    if (!child?.connected) throw Error('Owned images driver unavailable for scenario reset');
    const closed = awaitMessage('__close-context'); child.send({ type: 'close-context' }); await closed;
    // The exact prior browser context is closed before maintenance resets the
    // same owned fixture. Drain outstanding bridge work before touching rows.
    await chain; scenario = name; await f.reset('7.00', 'image');
    await f.maintenanceDb.update(storeProduct).set({ image: '' }).where(eq(storeProduct.id, 70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ image: '' }).where(eq(storeProductAttrValue.id, 1));
    session = {}; image = {}; previewUrl = ''; reference = '';
    checkpoint('scenario-reset', { scenario: name, context_closed: true, reset: 'canonical owned fixture reset only', no_source_changes: true });
  }
  async function request(path: string, value?: unknown, key?: string) {
    const response = await f.raw(path, { method: value === undefined ? 'GET' : 'POST',
      headers: { 'Authori-zation': 'Bearer ' + token, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const body = await response.json() as Row; return { response, body };
  }
  async function sessionRow() {
    const [row] = await f.maintenanceDb.execute(sql`SELECT *,request_key::text FROM cashier_second_card_form_session_v1 WHERE actor_uid=101 AND request_key=${session.request_key}::uuid`);
    return row as Row;
  }
  async function verifyStored(result: Row) {
    session = result.session; image = result.image;
    expect(session).toMatchObject({ actor_uid: 101, kind: 'session', body: { buyer_uid: 11, product_id: 70, quantity: 1, sku_unique: 'qared001' } });
    expect(image).toMatchObject({ actor_uid: 101, kind: 'image', body: { session_key: session.request_key, sha256: PNG_SHA, size: PNG.length, field_id: 'id:"photo"' } });
    expect(session.request_key).not.toBe(image.request_key);
    expect(image.request_hash).toBe(await outRequestHash(image.body)); expect(session.request_hash).toBe(await outRequestHash(session.body));
    const uploads = calls.filter(call => call.scenario === scenario && call.multipart);
    expect(uploads).toHaveLength(1); expect(uploads[0]).toMatchObject({ http: 200, status: 200, request_key: image.request_key,
      multipart: { file_size: PNG.length, file_sha256: PNG_SHA, metadata: image.body } });
    const [upload] = await f.maintenanceDb.execute(sql`SELECT *,request_key::text,session_key::text FROM cashier_second_card_form_upload_v1 WHERE actor_uid=101 AND request_key=${image.request_key}::uuid`);
    const original = await sessionRow();
    expect(original.state).toBe('active'); expect(upload).toMatchObject({ state: 'stored', sha256: PNG_SHA, size: PNG.length,
      request_key: image.request_key, session_key: session.request_key, request_hash: image.request_hash, scope_digest: original.scope_digest });
    const [attachment] = await f.maintenanceDb.select().from(systemAttachment).where(eq(systemAttachment.attId, upload.attachment_id as number));
    reference = '/api/assets/' + attachment.attId;
    expect({ ...attachment, attType: attachment.attType.trimEnd(), attSize: attachment.attSize.trimEnd() }).toMatchObject({ type: 3, relationId: 101, moduleType: 6, fileType: 1, imageType: 8,
      attType: 'image/png', attSize: String(PNG.length), attDir: reference, sattDir: reference, name: upload.object_key });
    expect(f.put).toHaveBeenCalledTimes(1); expect(f.objects.size).toBe(1);
    expect(f.objects.get(String(upload.object_key))).toEqual(PNG);
    expect(hash(f.objects.get(String(upload.object_key))!)).toBe(PNG_SHA);
    const facts = await f.facts(); expect(facts.sessions).toHaveLength(1); expect(facts.uploads).toHaveLength(1); expect(facts.attachments).toHaveLength(1);
    expect(facts.orders).toBeNull(); expect(facts.payments).toBeNull();
    if (result.preview) {
      previewUrl = result.preview.src; expect(result.preview.reference).toBe(reference);
      expect(result.preview).toMatchObject({ width: 1, height: 1, status: 200, bytes: PNG.length, sha256: PNG_SHA, cache: 'private, no-store' });
    }
    checkpoint('stored', { scenario, session_key: session.request_key, upload_key: image.request_key, reference,
      sha256: PNG_SHA, bytes: PNG.length, real_multipart: true, one_SQL_upload_one_R2_put: true });
  }
  async function assertPrivateAsset(urlValue: string) {
    const signed = new URL(urlValue, origin), path = signed.pathname + signed.search;
    // Signed asset authorization is HMAC+TTL, independently of UserJWT or
    // current customer qualification. These requests deliberately send no JWT.
    const good = await f.raw(path.slice(4)); expect(good.status).toBe(200);
    expect(good.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await good.arrayBuffer())).toEqual(PNG);
    expect((await f.raw(signed.pathname.slice(4))).status).toBe(404);
    const signature = signed.searchParams.get('signature')!;
    const changed = new URL(signed); changed.searchParams.set('signature', (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1));
    expect((await f.raw((changed.pathname + changed.search).slice(4))).status).toBe(404);
    const expired = Math.floor(Date.now() / 1000) - 1;
    const expiredSignature = createHmac('sha256', f.env.APP_KEY).update('GET\n' + signed.pathname + '\n' + expired).digest('base64url');
    expect((await f.raw(signed.pathname.slice(4) + '?expires=' + expired + '&signature=' + expiredSignature)).status).toBe(404);
    checkpoint('private-binary', { scenario, reference: signed.pathname, bytes: PNG.length, sha256: PNG_SHA,
      actual_controller: true, valid_HMAC_without_JWT: 200, unsigned: 404, wrong_HMAC: 404, correctly_signed_expired_TTL: 404 });
  }
  async function denyFrozenCancel(state: 'frozen' | 'consumed') {
    const before = await f.facts(), denied = await request('/mobile/work/cashier/second-card/form-sessions/' + session.request_key + '/cancel',
      { version: 'customer-cashier-form-session-v1', scope_key: session.body.scope_key }, session.request_key);
    expect(denied.response.status).toBe(409); expect(denied.body.status).toBe(409); expect((await sessionRow()).state).toBe(state);
    expect(await f.facts()).toEqual(before);
    checkpoint('cancel-denied', { state, http: 409, session_key: session.request_key, source: 'real route probe; UI cancel already absent', facts_unchanged: true });
  }

  it.each(stages)('real images Browser stage %s', async name => {
    if (assertionFailure) throw Error('Earlier images stage failed; continuing this stateful acceptance is forbidden: ' + assertionFailure.message);
    try {
      if (name === 'complete-upload') {
        const result = await stage(name); await verifyStored(result); const beforeAssetReads = await f.facts(); await assertPrivateAsset(previewUrl); expect(await f.facts()).toEqual(beforeAssetReads);
        const ordinary = latest('/api/mobile/work/context'), cap = latest(base + '/capabilities');
        expect(ordinary.data.data.capabilities.cashier_second_card).toBe(false); expect(cap.data.data.capabilities.cashier_form_images).toBe(true);
        expect((await auditRuntimeBusinessPrivileges(f.appRuntime.db, 'app', f.target, undefined, f.peers, f.appReaders)).ready).toBe(true);
        return;
      }
      if (name === 'complete-quote') {
        const result = await stage(name); creation = result.creation;
        expect(creation.request_key).toBe(session.request_key); expect(creation.request_hash).toBe(await outRequestHash(creation.body));
        expect(creation.body.custom_form.find((value: Row) => value.name === 'uploadPicture').value).toEqual([reference]);
        expect(JSON.stringify(creation)).not.toMatch(/blob:|\?expires=|signature=/u);
        const row = await sessionRow(); expect(row.state).toBe('frozen'); expect(row.frozen_request_hash).toBe(creation.request_hash);
        expect(latest(base + '/drafts', 'POST')).toMatchObject({ status: 200, request_key: session.request_key });
        expect((await f.facts()).orders).toBeNull(); expect(f.put).toHaveBeenCalledTimes(1); await denyFrozenCancel('frozen'); return;
      }
      if (name === 'complete-created') {
        await stage(name); const created = latest(base + '/orders', 'POST'); orderId = created.data.receipt.order_id;
        expect(created).toMatchObject({ status: 200, request_key: session.request_key });
        const row = await sessionRow(); expect(row).toMatchObject({ state: 'consumed', order_id: orderId, frozen_request_hash: creation.request_hash });
        const order = await f.order(orderId); expect(order).toMatchObject({ paid: 0, uid: 11, staffId: 101 }); expect(order.customForm).toContain(reference);
        const collections = await f.maintenanceDb.select().from(systemFormData); expect(collections).toHaveLength(1);
        expect(JSON.stringify(collections)).toContain(reference); expect(JSON.stringify(collections)).not.toMatch(/blob:|\?expires=|signature=/u);
        creationReceipt = await receipt('creations', creation.request_key); expect(creationReceipt.order_id).toBe(orderId);
        expect((await f.facts()).origins).toHaveLength(1); expect((await f.facts()).attachments).toHaveLength(1); expect(f.put).toHaveBeenCalledTimes(1);
        await denyFrozenCancel('consumed'); return;
      }
      if (name === 'complete-paid') {
        const result = await stage(name); payment = result.payment;
        expect(new Set([session.request_key, image.request_key, payment.request_key]).size).toBe(3);
        expect(payment.request_hash).toBe(await outRequestHash(payment.body));
        const cash = latest(base + '/orders/' + orderId + '/cash', 'POST'); expect(cash).toMatchObject({ http: 200, status: 200, request_key: payment.request_key });
        expect(cash.data.evidence).toMatchObject({ buyer_uid: 11, creator_uid: 101, paid: 1, amount: '7.00', origin_hash: creationReceipt.origin_hash });
        const [event] = await f.maintenanceDb.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, cash.data.outbox.id));
        expect(f.messages).toContainEqual({ action: 'processOrderPaidOutbox', outboxId: event.id, eventKey: event.eventKey });
        const consumed = await f.consume({ id: event.id, eventKey: event.eventKey });
        const order = await f.order(orderId), [item] = await f.maintenanceDb.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, orderId));
        expect(order).toMatchObject({ paid: 1, uid: 11, staffId: 101, payType: 'cash' });
        expect((await f.maintenanceDb.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(9);
        expect((await f.maintenanceDb.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0].stock).toBe(9);
        expect(item).toMatchObject({ cartNum: 1, writeTimes: 3, writeSurplusTimes: 3, writeStart: order.payTime, writeEnd: order.payTime + 10 * 86400 });
        const [account] = await f.maintenanceDb.select().from(user).where(eq(user.uid, 11)); expect(account).toMatchObject({ nowMoney: '100.00', integral: 100 });
        paymentReceipt = await receipt('payments', payment.request_key); expect(paymentReceipt.evidence).toEqual(cash.data.evidence);
        paidFacts = await f.facts(); expect(paidFacts.payments).toHaveLength(1); expect(paidFacts.outbox).toHaveLength(1);
        expect(await consumed.consumer.processMessage(consumed.message)).toBe('already-completed'); expect(await f.facts()).toEqual(paidFacts);
        expect(f.put).toHaveBeenCalledTimes(1); checkpoint('complete-flow', { session_creation_same_UUID: true, upload_payment_distinct_UUID: true,
          order_id: orderId, reference, original_payment_hash: payment.request_hash, actual_App_outbox_and_replay: true, real_image_provider: false }); return;
      }
      if (name === 'lost-upload') {
        await resetScenario('lost'); dropStoredReply = true;
        const result = await stage(name); await verifyStored(result);
        expect(droppedReplies).toBe(1); expect(dropStoredReply).toBe(false);
        expect(calls.filter(call => call.scenario === scenario && call.reply_destroyed_after_verified_stored_commit)).toHaveLength(1);
        storedFacts = await f.facts(); return;
      }
      if (name === 'lost-recover') {
        const result = await stage(name); await verifyStored(result); await assertPrivateAsset(previewUrl);
        expect(await f.facts()).toEqual(storedFacts); expect(f.put).toHaveBeenCalledTimes(1);
        expect(calls.filter(call => call.scenario === scenario && call.multipart)).toHaveLength(1);
        checkpoint('stored-reply-loss-recovered', { session_key: session.request_key, upload_key: image.request_key,
          exactly_one_multipart_one_put: true, exact_original_GET_after_reload: true, SQL_facts_unchanged_by_recovery: true }); return;
      }
      if (name === 'cancel-choose') {
        await resetScenario('cancel'); const result = await stage(name); session = result.session;
        expect((await sessionRow()).state).toBe('active'); expect((await f.facts()).sessions).toHaveLength(1);
        expect(actualCalls(base + '/form-sessions', 'POST').filter(call => call.scenario === scenario)).toHaveLength(1);
        expect(calls.filter(call => call.scenario === scenario && call.multipart)).toHaveLength(0); expect(f.put).not.toHaveBeenCalled();
        expect(result.pending).toHaveLength(1); storedFacts = await f.facts();
        checkpoint('chooser-empty', { ensureSession_POST_before_native_choice: true, one_active_session: true, zero_uploads: true }); return;
      }
      if (name === 'cancel-dismiss') {
        await stage(name); expect(await f.facts()).toEqual(storedFacts); expect((await sessionRow()).state).toBe('active');
        expect(calls.filter(call => call.scenario === scenario && call.pathname.endsWith('/cancel'))).toHaveLength(0); return;
      }
      if (name === 'cancel-confirm') {
        await stage(name); const cancel = latest(base + '/form-sessions/' + session.request_key + '/cancel', 'POST');
        expect(cancel).toMatchObject({ http: 200, status: 200, request_key: session.request_key,
          request: { version: 'customer-cashier-form-session-v1', scope_key: session.body.scope_key } });
        const row = await sessionRow(); expect(row.state).toBe('cancelled'); expect(row.cancelled_at).not.toBeNull();
        const facts = await f.facts(); expect(facts.orders).toBeNull(); expect(facts.payments).toBeNull(); expect(facts.uploads).toBeNull();
        expect(f.put).not.toHaveBeenCalled(); checkpoint('active-cancelled', { exact_original_session_UUID: session.request_key, dismissed_modal_no_POST: true,
          confirmed_cancel_status: 200, cancelled_SQL_fact: true, no_order_payment_upload: true }); return;
      }
      if (name === 'revoked-upload') {
        await resetScenario('revoked'); const result = await stage(name); await verifyStored(result); await assertPrivateAsset(previewUrl);
        const [service] = await f.maintenanceDb.select().from(storeService).where(eq(storeService.id, 1)); serviceBefore = service;
        storedFacts = await f.facts(); await f.maintenanceDb.update(storeService).set({ customer: 0 }).where(eq(storeService.id, 1));
        revokedFacts = await f.facts(); expect(revokedFacts).toEqual(storedFacts); return;
      }
      if (name === 'revoked-home') {
        await stage(name); expect(latest('/api/mobile/work/context')).toMatchObject({ http: 403, status: 403, data: null });
        expect(await f.facts()).toEqual(revokedFacts); return;
      }
      if (name === 'revoked-recover') {
        await stage(name); const sr = latest(base + '/form-sessions/' + session.request_key), ir = latest(base + '/form-images/' + image.request_key);
        expect(sr).toMatchObject({ http: 200, status: 200 }); expect(sr.data.receipt.state).toBe('active');
        expect(ir).toMatchObject({ http: 200, status: 200 }); expect(ir.data.receipt).toMatchObject({ state: 'stored', sha256: PNG_SHA, reference });
        const freshSession = await request('/mobile/work/cashier/second-card/form-sessions', session.body, randomUUID());
        expect(freshSession.response.status).toBe(403);
        const data = new FormData(); data.append('file', new File([PNG], 'owned-image.png', { type: 'image/png' })); data.append('metadata', JSON.stringify(image.body));
        const encoded = new Response(data), bytes = await encoded.arrayBuffer();
        const upload = await f.raw('/mobile/work/cashier/second-card/form-sessions/' + session.request_key + '/images', { method: 'POST', body: bytes,
          headers: { 'Authori-zation': 'Bearer ' + token, 'Content-Type': encoded.headers.get('Content-Type')!, 'Idempotency-Key': randomUUID() } });
        expect(upload.status).toBe(403);
        const draft = await request('/mobile/work/cashier/second-card/drafts', { version: 'customer-cashier-second-card-v1', scope_key: session.body.scope_key,
          buyer_uid: 11, tourist_key: '', product_id: 70, sku_unique: 'qared001', quantity: 1, real_name: '资格撤销后的禁止新作者', user_phone: '00000000000',
          mark: '', custom_form: [{ id: 'name', name: 'texts', value: '禁止' }, { id: 'photo', name: 'uploadPicture', value: [reference] }], coupon_id: 0, use_integral: false }, randomUUID());
        expect(draft.response.status).toBe(403); expect(await f.facts()).toEqual(revokedFacts); expect(f.put).toHaveBeenCalledTimes(1);
        await assertPrivateAsset(previewUrl);
        checkpoint('qualification-loss-owner-boundary', { session_GET: 200, image_GET: 200, new_session: 403, new_upload: 403, new_draft: 403,
          unchanged_SQL_and_R2_put_count: true, no_UI_new_author_or_revealed_form_PII: true,
          old_valid_signed_URL_still_200: 'HMAC+TTL remains separate from current qualification and JWT' }); return;
      }
      if (name === 'revoked-cancel') {
        await stage(name); expect((await sessionRow()).state).toBe('cancelled');
        const cancel = latest(base + '/form-sessions/' + session.request_key + '/cancel', 'POST');
        expect(cancel).toMatchObject({ http: 200, status: 200, request_key: session.request_key });
        const cancelled = await f.facts();
        for (const key of Object.keys(revokedFacts).filter(key => key !== 'sessions')) expect(cancelled[key], key).toEqual(revokedFacts[key]);
        expect(cancelled.orders).toBeNull(); expect(cancelled.payments).toBeNull();
        expect(f.put).toHaveBeenCalledTimes(1); expect(f.remove).not.toHaveBeenCalled(); expect(f.objects.size).toBe(1);
        expect(unexpected).toEqual([]); expect(driverFailure).toBeUndefined(); expect(bridgeFailure).toBeUndefined(); expect(external).not.toHaveBeenCalled();
        expect(droppedReplies).toBe(1); expect(dropStoredReply).toBe(false);
        checkpoint('owner-active-cancel-after-qualification-loss', { http: 200, same_valid_owner_JWT: true, exact_session_UUID: session.request_key,
          stored_upload_and_private_object_retained: true, no_business_order_payment_created: true }); return;
      }
      if (name === 'invalidated-upload') {
        await resetScenario('invalidated'); const result = await stage(name); await verifyStored(result);
        await assertPrivateAsset(previewUrl); storedFacts = await f.facts();
        invalidatedContextReads = actualCalls('/api/mobile/work/context').filter(call => call.scenario === scenario).length;
        expect(invalidatedContextReads).toBeGreaterThan(0);
        await f.maintenanceDb.update(storeService).set({ customer: 0 }).where(eq(storeService.id, 1));
        invalidatedFacts = await f.facts(); expect(invalidatedFacts).toEqual(storedFacts);
        checkpoint('same-page-qualification-revoked', { exact_session_UUID: session.request_key, stored_upload_UUID: image.request_key,
          maintenance_fixture_edit: 'store_service.customer=0 only; no browser reload, navigation, new token or context read',
          business_SQL_unchanged: true, one_existing_upload_attachment_R2_put: true }); return;
      }
      if (name === 'invalidated-rejected') {
        const result = await stage(name); rejectedImage = result.rejected_image;
        expect(result).toMatchObject({ live_visible_owner_rows: 3, same_document_and_JWT: true,
          author_controls_hidden: true, form_PII_and_previews_cleared: true });
        expect(result.session).toEqual(session); expect(result.image).toEqual(image);
        expect(rejectedImage).toMatchObject({ actor_uid: 101, kind: 'image', body: image.body });
        expect(new Set([session.request_key, image.request_key, rejectedImage.request_key]).size).toBe(3);
        expect(rejectedImage.request_hash).toBe(await outRequestHash(rejectedImage.body));
        expect(result.pending).toHaveLength(3);
        const multipart = calls.filter(call => call.scenario === scenario && call.multipart); expect(multipart).toHaveLength(2);
        expect(multipart[0]).toMatchObject({ http: 200, status: 200, request_key: image.request_key, same_fixture_owner_JWT: true });
        expect(multipart[1]).toMatchObject({ http: 403, status: 403, data: null, request_key: rejectedImage.request_key,
          pathname: base + '/form-sessions/' + session.request_key + '/images', same_fixture_owner_JWT: true,
          multipart: { file_size: PNG.length, file_sha256: PNG_SHA, metadata: rejectedImage.body } });
        expect(result.rejected_upload).toEqual({ path: multipart[1].pathname, http: 403,
          request_key: rejectedImage.request_key, same_owner_JWT: true });
        const [rejected] = await f.maintenanceDb.execute(sql`SELECT request_key::text FROM cashier_second_card_form_upload_v1
          WHERE actor_uid=101 AND request_key=${rejectedImage.request_key}::uuid`); expect(rejected).toBeUndefined();
        expect(await f.facts()).toEqual(invalidatedFacts); expect(f.put).toHaveBeenCalledTimes(1); expect(f.objects.size).toBe(1);
        expect(actualCalls(base + '/form-sessions', 'POST').filter(call => call.scenario === scenario)).toHaveLength(1);
        expect(actualCalls('/api/mobile/work/context').filter(call => call.scenario === scenario)).toHaveLength(invalidatedContextReads);
        checkpoint('same-page-second-multipart-denied', { original_session_UUID: session.request_key, stored_upload_UUID: image.request_key,
          rejected_client_UUID: rejectedImage.request_key, actual_second_multipart_HTTP: 403, same_original_owner_JWT: true,
          live_visible_owner_rows_before_recovery: 3, original_document_unchanged: true,
          cleared_PII_and_previews_hidden_author_controls: true, rejected_UUID_has_no_SQL_upload: true,
          existing_one_SQL_upload_one_attachment_one_R2_put_unchanged: true }); return;
      }
      if (name === 'invalidated-recover') {
        const beforeAuthorPosts = calls.filter(call => call.scenario === scenario && call.method === 'POST').length;
        const result = await stage(name);
        expect(result).toMatchObject({ live_visible_owner_rows: 3, same_document_and_JWT: true, live_row_queries_only: true,
          author_controls_hidden: true, form_PII_and_previews_cleared: true, no_new_author_POST: true });
        expect(result.session).toEqual(session); expect(result.image).toEqual(image); expect(result.rejected_image).toEqual(rejectedImage);
        const sr = latest(base + '/form-sessions/' + session.request_key), stored = latest(base + '/form-images/' + image.request_key),
          absent = latest(base + '/form-images/' + rejectedImage.request_key);
        expect(sr).toMatchObject({ scenario, http: 200, status: 200, same_fixture_owner_JWT: true });
        expect(sr.data.receipt).toMatchObject({ state: 'active', request_key: session.request_key });
        expect(stored).toMatchObject({ scenario, http: 200, status: 200, same_fixture_owner_JWT: true });
        expect(stored.data.receipt).toMatchObject({ state: 'stored', sha256: PNG_SHA, reference });
        expect(absent).toMatchObject({ scenario, http: 200, status: 200, same_fixture_owner_JWT: true });
        expect(absent.data.receipt).toBeNull();
        expect(calls.filter(call => call.scenario === scenario && call.method === 'POST')).toHaveLength(beforeAuthorPosts);
        expect(await f.facts()).toEqual(invalidatedFacts); expect(f.put).toHaveBeenCalledTimes(1);
        checkpoint('same-page-live-owner-recovery', { original_session_GET: 200, stored_upload_GET: 200,
          rejected_client_UUID_GET: 200, rejected_receipt: null, live_rows_required_before_any_recovery: 3,
          current_original_owner_JWT: true, no_new_author_POST: true, SQL_and_R2_put_count_unchanged: true }); return;
      }
      if (name === 'invalidated-cancel') {
        const result = await stage(name); expect(result).toMatchObject({ owner_cancel_after_same_page_403: true, all_three_durable_stages_released: true });
        const cancel = latest(base + '/form-sessions/' + session.request_key + '/cancel', 'POST');
        expect(cancel).toMatchObject({ scenario, http: 200, status: 200, same_fixture_owner_JWT: true, request_key: session.request_key,
          request: { version: 'customer-cashier-form-session-v1', scope_key: session.body.scope_key } });
        const row = await sessionRow(); expect(row.state).toBe('cancelled'); expect(row.cancelled_at).not.toBeNull();
        const cancelled = await f.facts();
        for (const key of Object.keys(invalidatedFacts).filter(key => key !== 'sessions')) expect(cancelled[key], key).toEqual(invalidatedFacts[key]);
        expect(cancelled.uploads).toHaveLength(1); expect(cancelled.attachments).toHaveLength(1);
        expect(cancelled.orders).toBeNull(); expect(cancelled.payments).toBeNull();
        expect(f.put).toHaveBeenCalledTimes(1); expect(f.remove).not.toHaveBeenCalled(); expect(f.objects.size).toBe(1);
        expect(hash([...f.objects.values()][0]!)).toBe(PNG_SHA);
        expect(unexpected).toEqual([]); expect(driverFailure).toBeUndefined(); expect(bridgeFailure).toBeUndefined(); expect(external).not.toHaveBeenCalled();
        expect(droppedReplies).toBe(1); expect(dropStoredReply).toBe(false);
        checkpoint('same-page-owner-cancel-after-multipart403', { exact_original_session_UUID: session.request_key,
          same_original_owner_JWT: true, actual_HTTP: 200, cancelled_SQL_fact: true, all_three_durable_stages_released: true,
          original_stored_upload_attachment_and_private_object_retained: true, no_order_or_payment: true });
        await writeFile(join(output, 'images-native-browser-result.json'), JSON.stringify({ status: 'local_real_images_browser_scenarios_passed',
          stages: [...stageResults.keys()], scenarios: ['complete', 'lost', 'cancel', 'revoked', 'invalidated'], checkpoints, calls, browser: result,
          h5_build: buildBefore, dropped_stored_reply_count: droppedReplies, provider_calls: 0, real_R2_provider_acceptance: false,
          image_device_platform_acceptance: false, production_acceptance: false, global_php_to_ts_migration_complete: false }, null, 2) + '\n', { flag: 'wx' }); return;
      }
      throw Error('Unimplemented images Browser stage');
    } catch (error) { assertionFailure = error instanceof Error ? error : Error(String(error)); throw error; }
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
    try { await chain; } catch (error) { failures.push(String(error)); }
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
    if (output && (phase !== stages.length || driverFailure || bridgeFailure || assertionFailure)) await writeFile(join(output, 'images-native-browser-failure.json'), JSON.stringify({
      stages_completed: phase, assertion_failure: assertionFailure ? String(assertionFailure) : null, driver_failure: driverFailure ? String(driverFailure) : null,
      bridge_failure: bridgeFailure ? String(bridgeFailure) : null, calls, checkpoints, unexpected,
      h5_build: buildBefore, source: 'real API bridge diagnostic evidence; no successful Browser acceptance inferred',
    }, null, 2) + '\n', { flag: 'wx' });
    if (output) await writeFile(join(output, 'images-browser-cleanup.json'), JSON.stringify({ stages_completed: phase, server_closed: serverClosed,
      fixture_closed: fixtureClosed, port_refused: portRefused, driver_exit: child?.exitCode ?? null, driver_signal: child?.signalCode ?? null,
      build_files_unchanged: JSON.stringify(buildAfter) === JSON.stringify(buildBefore), cleanup_failures: failures,
      browser_validation_scope: 'Only local real H5 images with a private Map R2 adapter; provider storage, device platforms and global migration remain unproven' }, null, 2) + '\n', { flag: 'wx' });
    vi.restoreAllMocks(); expect(failures).toEqual([]);
  }, 30000);
});
