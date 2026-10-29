/** Actual built H5 + registered Worker + JWT + full PG16. QA sessions and finite
 * fixture controls are explicit nonproof; business requests always hit createApp. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { spreadPosterFixture, SPREAD_POSTER as ids, assertSpreadPosterQrDelta, type SpreadPosterScenario } from '../helpers/spreadPosterFixture';
import { stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';
const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const container = wiring.context?.getStore(); if (!container) throw Error('Owned spread-poster App LOGIN required'); return container;
} }));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown) => hash(stableDiyState(value));
export const spreadPosterBrowserPlans = [
  { name: 'guest', kind: 'guest', owner: 0, width: 375 },
  { name: 'owner-a-ready', kind: 'ready', owner: ids.a, width: 375, selected: 0 },
  { name: 'template-two', kind: 'ready', owner: ids.a, width: 375, selected: 1 },
  { name: 'preview-open', kind: 'ready', owner: ids.a, width: 375, selected: 1 },
  { name: 'preview-closed', kind: 'ready', owner: ids.a, width: 375, selected: 1 },
  { name: 'reread', kind: 'ready', owner: ids.a, width: 375, selected: 0 },
  { name: 'empty-templates', kind: 'error', owner: ids.a, width: 375, scenario: 'empty-templates' },
  { name: 'templates-reconfigured', kind: 'ready', owner: ids.a, width: 375, scenario: 'normal', selected: 0 },
  { name: 'missing-template', kind: 'error', owner: ids.a, width: 375, scenario: 'missing-template' },
  { name: 'corrupt-template', kind: 'error', owner: ids.a, width: 375, scenario: 'corrupt-template' },
  { name: 'template-restored', kind: 'ready', owner: ids.a, width: 375, scenario: 'restore-template', selected: 0 },
  { name: 'missing-avatar', kind: 'error', owner: ids.a, width: 375, scenario: 'missing-avatar' },
  { name: 'corrupt-avatar', kind: 'error', owner: ids.a, width: 375, scenario: 'corrupt-avatar' },
  { name: 'avatar-restored', kind: 'ready', owner: ids.a, width: 375, scenario: 'restore-avatar', selected: 0 },
  { name: 'password-revoked', kind: 'revoked', owner: ids.a, width: 375, scenario: 'password-revoked' },
  { name: 'account-restored', kind: 'ready', owner: ids.a, width: 375, scenario: 'restore-account', selected: 0 },
  { name: 'status-revoked', kind: 'revoked', owner: ids.a, width: 375, scenario: 'status-revoked' },
  { name: 'status-restored', kind: 'ready', owner: ids.a, width: 375, scenario: 'restore-account', selected: 0 },
  { name: 'late-held', kind: 'held', owner: ids.a, width: 375 },
  { name: 'new-owner', kind: 'ready', owner: ids.b, width: 375, selected: 0 },
  { name: 'new-owner-released', kind: 'ready', owner: ids.b, width: 375, selected: 0 },
  { name: 'finance-navigation', kind: 'finance', owner: ids.b, width: 375 },
  { name: 'desktop', kind: 'ready', owner: ids.b, width: 1000, selected: 0 },
  { name: 'logout', kind: 'guest', owner: 0, width: 375 },
  { name: 'finished', kind: 'guest', owner: 0, width: 375 },
] as const;
async function files(root: string): Promise<string[]> { return (await Promise.all((await readdir(root, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(resolve(root, entry.name)) : [resolve(root, entry.name)]))).flat().sort(); }
async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let count = 0; for await (const part of req) { const value = Buffer.from(part); count += value.length; expect(count).toBeLessThanOrEqual(4 * 1024 * 1024); chunks.push(value); } return Buffer.concat(chunks); }

it('accepts real poster generation/display/selection/media failures and account lifecycle without provider or business-authority substitution', async () => {
  const repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/uniapp-ts/dist/build/h5');
  const prefix = '/tmp/cinashop-spread-poster-browser-', runId = randomUUID(), control = '/__spread_poster/' + runId;
  for (const suffix of ['ready.json', 'progress.json', 'evidence.json', 'failed.json', 'cleanup.json']) expect(await stat(prefix + suffix).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; }), 'Archive prior owned spread-poster Browser receipt: ' + suffix).toBe(false);
  const f = await spreadPosterFixture(), app = createApp();
  const traces: Row[] = [], controls: Row[] = [], evidence: Row[] = [], statics: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {};
  let expected = await f.snapshot(), actor = 0, lastAck: string | null = null, pending = 0, queued = 0, queue = Promise.resolve(), nextHold = false;
  let held: { res: ServerResponse; bytes: Buffer; status: number; headers: Record<string, string>; trace: Row } | undefined;
  let server: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined, origin = '', failure: unknown, cleanupFailure: unknown, fixtureClosed = false;
  let done!: () => void, fail!: (error: unknown) => void; const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const phase = () => spreadPosterBrowserPlans[evidence.length];
  const remember = (value: DiyStateSnapshot) => { const key = digest(value); snapshots[key] ??= structuredClone(value); return key; };
  const serial = <T>(run: () => Promise<T>): Promise<T> => { queued++; const value = queue.then(run).finally(() => { queued--; }); queue = value.then(() => {}, error => { failure ??= error; fail(error); }); return value; };
  const json = (res: ServerResponse, value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const persist = () => writeFile(prefix + 'progress.json', JSON.stringify({ status: 'running', run_id: runId, control, phase: phase()?.name, last_ack: lastAck, pending, queued, held: !!held, next_hold: nextHold,
    evidence, traces, controls, statics, snapshots_by_sha256: snapshots, resources: f.resources(), r2_reads: f.assetReads, kv_reads: f.kvReads, budget_calls: f.budgetCalls }, null, 2) + '\n', { mode: 0o600 });
  async function manifest(paths: string[]) { return Promise.all([...new Set(paths)].sort().map(async path => { const value = await readFile(path); return { path: path.slice(repository.length + 1), bytes: value.length, sha256: hash(value) }; })); }
  const sources = async () => manifest([...(await files(resolve(repository, 'workers-ts/src'))), ...(await files(resolve(repository, 'workers-ts/test/helpers'))), ...(await files(resolve(repository, 'view/uniapp-ts/src'))), ...(await files(resolve(repository, 'view/common'))),
    ...['workers-ts/test/browser/spread-poster.acceptance.ts', 'workers-ts/test/browser/spread-poster.shell.html', 'workers-ts/test/spread-poster-page-postgres.test.ts', 'workers-ts/vitest.spread-poster-browser.config.ts', 'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/package.json', 'workers-ts/package-lock.json', 'view/uniapp-ts/package.json', 'view/uniapp-ts/package-lock.json', 'view/uniapp-ts/scripts/spread-poster-runtime.test.cjs', 'view/uniapp-ts/scripts/uni-store-runtime.cjs'].map(path => resolve(repository, path))]);
  const builds = async () => manifest(await files(dist));
  let sourceBefore: Row[] = [], buildBefore: Row[] = [];
  try {
    wiring.context = new AsyncLocalStorage<Container>(); sourceBefore = await sources(); buildBefore = await builds(); expect(buildBefore.length).toBeGreaterThan(300);
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Spread-poster Browser prohibits outbound network'));
    await f.withApplication(async runtime => {
      remember(f.setup.before); remember(expected);
      async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer) {
        pending++;
        try {
          expect(['GET', 'HEAD']).toContain(req.method); expect(raw.length).toBe(0);
          const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && !['host', 'connection', 'content-length'].includes(key)) headers.set(key, value);
          const authorization = String(req.headers['authori-zation'] ?? req.headers.authorization ?? ''), owner = [ids.a, ids.b].find(uid => authorization === 'Bearer ' + f.tokens.get(uid)) ?? 0;
          if (authorization) expect(owner).toBeGreaterThan(0);
          const delivery = await serial(async () => {
            const before = await f.snapshot(), resources = f.resources(), r2Before = f.assetReads.length, start = Date.now(), jobs: Promise<unknown>[] = [];
            expect(before).toEqual(expected);
            const response = await wiring.context!.run(runtime.container, () => app.fetch(new Request(origin + url.pathname + url.search, { method: req.method, headers }), runtime.env,
              { waitUntil: (job: Promise<unknown>) => jobs.push(job), passThroughOnException: () => {} } as never));
            const bytes = Buffer.from(await response.arrayBuffer()); expect(await Promise.allSettled(jobs)).toEqual([]);
            const end = Date.now(), after = await f.snapshot(); let dto: Row | null = null; try { dto = JSON.parse(bytes.toString()) as Row; } catch {}
            let classification: Row = { kind: 'actual-read' };
            if (/^\/api\/get_qrcode\/-1\/\d+$/.test(url.pathname) && dto?.status === 200 && digest(before) !== digest(after)) classification = assertSpreadPosterQrDelta(before, after, owner, start, end, f.appKey);
            else expect(after).toEqual(before);
            if (url.pathname === '/api/user/spread_info' && dto?.status === 200) {
              expect(owner).toBeGreaterThan(0); expect(dto.data.nickname).toBe(owner === ids.a ? 'PHP海报本人甲' : 'PHP海报本人乙');
              const empty = phase()?.name === 'empty-templates'; expect(dto.data.spread).toHaveLength(empty ? 0 : 2); expect(dto.data.avatar).toMatch(new RegExp('^/api/assets/' + (owner === ids.a ? ids.avatarA : ids.avatarB) + '\\?'));
              expect(dto.data.spread.map((row: Row) => row.pic.split('?')[0])).toEqual(empty ? [] : ['/api/assets/' + ids.template1, '/api/assets/' + ids.template2]);
              expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0'); expect(f.assetReads).toHaveLength(r2Before);
            }
            expect(f.resources()).toEqual(resources); expect(f.forbidden).not.toHaveBeenCalled(); expected = after;
            const trace: Row = { index: traces.length, run_id: runId, phase: phase()?.name, owner, method: req.method, path: url.pathname, query: url.search,
              raw_headers: req.rawHeaders, authorization, request_body_base64: Buffer.from(raw).toString('base64'), request_body_sha256: hash(raw), request_body_bytes: raw.length,
              status: response.status, headers: Object.fromEntries(response.headers), body_base64: bytes.toString('base64'), sha256: hash(bytes), bytes: bytes.length, dto,
              started_at_ms: start, completed_at_ms: end, before_sha256: remember(before), after_sha256: remember(after), classification, r2_reads: f.assetReads.length - r2Before, wait_until_count: jobs.length, delivery: 'complete-worker-response' };
            traces.push(trace); return { trace, bytes, headers: Object.fromEntries(response.headers), status: response.status };
          });
          if (nextHold && url.pathname === '/api/user/spread_info') { expect(phase()?.name).toBe('late-held'); nextHold = false; delivery.trace.delivery = 'held-real-response'; held = { ...delivery, res }; }
          else { res.writeHead(delivery.status, delivery.headers); res.end(delivery.bytes); }
          await persist();
        } finally { pending--; }
      }
      async function capture(name: string, data: Row) {
        const plan = phase() as Row; expect(name).toBe(plan.name); expect(data.run_id).toBe(runId); expect(data.previous_ack ?? null).toBe(lastAck);
        expect(data.captured_at_ms).toBeGreaterThan(Number(evidence.at(-1)?.captured_at_ms ?? 0)); expect(actor).toBe(plan.owner);
        expect(data.errors).toEqual([]); expect(data.width).toBe(plan.width); expect(data.viewportWidth).toBe(plan.width); expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth); expect(new URL(data.href).origin).toBe(origin);
        const current = traces.slice(Number(evidence.at(-1)?.trace_count ?? 0));
        if (plan.kind === 'guest') { expect(data.text).toContain('登录后生成海报'); expect(data.generated_images).toEqual([]); }
        else if (plan.kind === 'revoked') { expect(data.text).toContain('登录后生成海报'); expect(data.generated_images).toEqual([]); expect(current.some(trace => trace.path === '/api/user/spread_info' && trace.owner === plan.owner && trace.dto?.status !== 200)).toBe(true); }
        else if (plan.kind === 'finance') { expect(data.href).toContain('/pages/user/finance'); expect(current.some(trace => trace.path === '/api/commission' && trace.dto?.status === 200)).toBe(true); }
        else {
          expect(data.href).toContain('/pages/user/spread');
          if (plan.kind === 'held') { expect(held).toBeDefined(); expect(data.loading).toBe(true); expect(data.generated_images).toEqual([]); }
          else if (plan.kind === 'error') { expect(data.alerts.length).toBeGreaterThan(0); expect(data.generated_images).toEqual([]); }
          else {
            expect(data.owner).toBe(plan.owner); expect(data.selected).toBe(plan.selected); expect(data.loading).toBe(false); expect(data.alerts).toEqual([]); expect(data.generated_images.length).toBeGreaterThan(0);
            for(const key of ['tip','retry','actions']){const control=data.poster_controls[key],box=data.poster_controls.swiper;expect(control.height).toBeGreaterThan(0);expect(control.top).toBeGreaterThanOrEqual(box.top);expect(control.bottom).toBeLessThanOrEqual(box.bottom+1);}
            for (const image of data.generated_images) {
              expect(image.complete).toBe(true); expect(image.naturalWidth).toBe(610); expect(image.naturalHeight).toBe(946); expect(image.src).toMatch(/^data:image\/png;base64,/);
              const png = Buffer.from(image.src.slice(image.src.indexOf(',') + 1), 'base64'); expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
              expect(png.readUInt32BE(16)).toBe(610); expect(png.readUInt32BE(20)).toBe(946); image.sha256 = hash(png); image.bytes = png.length;
            }
          }
        }
        if (name === 'owner-a-ready') expect(current.some(trace => trace.classification.kind === 'local-h5-qr-cache')).toBe(true);
        const mediaProof: Record<string, {id:number;status:number;payload?:string}> = {
          'missing-template':{id:ids.template2,status:404},'corrupt-template':{id:ids.template2,status:200,payload:'corrupt-template-payload'},
          'missing-avatar':{id:ids.avatarA,status:404},'corrupt-avatar':{id:ids.avatarA,status:200,payload:'corrupt-avatar-payload'},
        };
        const media=mediaProof[name];if(media)expect(current.some(trace=>trace.path==='/api/assets/'+media.id&&trace.status===media.status&&(!media.payload||Buffer.from(trace.body_base64,'base64').toString()===media.payload))).toBe(true);
        if(['reread','empty-templates','templates-reconfigured','template-restored','avatar-restored','account-restored','status-restored'].includes(name))expect(current.some(trace=>trace.path==='/api/user/spread_info'&&trace.dto?.status===200)).toBe(true);

        if (['template-two', 'preview-open', 'preview-closed'].includes(name)) expect(current.filter(trace => trace.path === '/api/user/spread_info')).toEqual([]);
        if (name === 'preview-open') expect(data.preview_open).toBe(true);
        if (name === 'preview-closed') expect(data.preview_open).toBe(false);
        if (name === 'new-owner-released') { expect(held).toBeUndefined(); expect(current.filter(trace => trace.path === '/api/user/spread_info')).toEqual([]); }
        if (name === 'finished') { expect(nextHold || !!held).toBe(false); expect(await sources()).toEqual(sourceBefore); expect(await builds()).toEqual(buildBefore); expect(outbound).not.toHaveBeenCalled(); }
        expect(await f.snapshot()).toEqual(expected); const ack = randomUUID(); evidence.push({ name, ...data, ack, trace_count: traces.length, snapshot_sha256: remember(expected), resources: f.resources() }); lastAck = ack; await persist();
        return { accepted: true, run_id: runId, name, ack, next: phase()?.name ?? null, complete: evidence.length === spreadPosterBrowserPlans.length };
      }
      const observer = '<script>window.__spreadQa={errors:[],resourceErrors:[]};addEventListener("error",e=>{const q=window.__spreadQa;if(e.target&&["IMG","VIDEO","SOURCE"].includes(e.target.tagName))q.resourceErrors.push({src:e.target.getAttribute("src"),at:Date.now()});else q.errors.push({message:e.message||"unknown",at:Date.now()})},true);addEventListener("unhandledrejection",e=>window.__spreadQa.errors.push({message:String(e.reason),at:Date.now()}));</script>';
      const shell = (await readFile(resolve(import.meta.dirname, 'spread-poster.shell.html'), 'utf8')).replaceAll('__CONTROL__', JSON.stringify(control)).replaceAll('__RUN_ID__', JSON.stringify(runId)).replaceAll('__PLANS__', JSON.stringify(spreadPosterBrowserPlans));
      server = createServer((req, res) => { void (async () => {
        expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe(new URL(origin).host);
        req.on('error', (error: Error & { code?: string }) => { controls.push({ kind: 'incoming-transport-error', message: error.message, code: error.code ?? '', phase: phase()?.name }); if (error.message !== 'aborted' || error.code !== 'ECONNRESET') { failure ??= error; fail(error); } });
        const url = new URL(req.url ?? '/', origin), raw = await body(req);
        if (url.pathname.startsWith(control)) {
          expect(req.method).toBe('POST'); controls.push({ kind: 'qa-control', nonproof: true, path: url.pathname, query: url.search, body_sha256: hash(raw), phase: phase()?.name, at_ms: Date.now() });
          if (url.pathname === control + '/session') { const uid = Number(url.searchParams.get('owner')); expect([0, ids.a, ids.b]).toContain(uid); expect(uid).toBe(phase()?.owner); actor = uid; json(res, { uid, token: uid ? f.tokens.get(uid) : '' }); return; }
          if (url.pathname === control + '/fixture') { const scenario = url.searchParams.get('name') as SpreadPosterScenario; expect((phase() as Row).scenario).toBe(scenario); expect(pending + queued).toBe(0);
            json(res, await serial(async () => { expect(await f.snapshot()).toEqual(expected); const result = await f.control(scenario); expect(result.before).toEqual(expected); expected = result.after; controls.push({ ...result, before_sha256: remember(result.before), after_sha256: remember(result.after), at_ms: Date.now() }); await persist(); return { accepted: true, scenario }; })); return; }
          if (url.pathname === control + '/hold') { expect(phase()?.name).toBe('late-held'); nextHold = true; json(res, { accepted: true }); return; }
          if (url.pathname === control + '/release') { expect(phase()?.name).toBe('new-owner-released'); expect(held).toBeDefined(); const previous = held!; held = undefined;
            previous.trace.release = { at_ms: Date.now(), client_socket_destroyed: previous.res.destroyed || previous.res.socket?.destroyed, bytes: previous.bytes.length, sha256: hash(previous.bytes), kind: 'writer-attempt-after-document-replacement' }; previous.res.writeHead(previous.status, previous.headers); previous.res.end(previous.bytes); await persist(); json(res, { accepted: true }); return; }
          if (url.pathname.startsWith(control + '/phase/')) { if (pending + queued) { json(res, { accepted: false, reason: 'pending-business', pending, queued }); return; }
            const result = await serial(() => capture(url.pathname.slice((control + '/phase/').length), JSON.parse(raw.toString()))); if (result.complete) res.once('finish', done); json(res, result); return; }
          throw Error('Unknown finite spread-poster control');
        }
        if (url.pathname.startsWith('/api/')) { await dispatch(req, res, url, raw); return; }
        expect(req.method).toBe('GET'); if (url.pathname === '/') { const resumed=shell.replaceAll('__INITIAL_ACK__',JSON.stringify(lastAck)).replaceAll('__INITIAL_INDEX__',String(evidence.length)); controls.push({kind:'qa-controller-document',nonproof:true,index:evidence.length,previous_ack:lastAck,source_sha256:hash(shell),served_sha256:hash(resumed),at_ms:Date.now()}); res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(resumed); return; } if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        const target = url.pathname === '/__h5' ? resolve(dist, 'index.html') : resolve(dist, '.' + decodeURIComponent(url.pathname)); expect(target.startsWith(dist + sep)).toBe(true);
        const original = await readFile(target), index = target === resolve(dist, 'index.html'), bytes = index ? Buffer.from(original.toString().replace('<head>', '<head><link rel="icon" href="data:,">' + observer)) : original;
        statics.push({ path: url.pathname, file: target.slice(repository.length + 1), source_sha256: hash(original), served_sha256: hash(bytes), source_bytes: original.length, bytes: bytes.length, index_observer: index });
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
        res.writeHead(200, { 'Content-Type': mime[extname(target)] ?? 'application/octet-stream' }); res.end(bytes);
      })().catch(error => { failure ??= error; controls.push({ kind: 'server-error', path: req.url, error: String(error), phase: phase()?.name }); void persist().then(() => fail(error), fail); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }); });
      server.on('upgrade', (_req, socket) => { const error = Error('Unexpected spread-poster websocket'); failure ??= error; fail(error); socket.destroy(); });
      timer = setTimeout(() => fail(Error('Spread-poster Browser deadline')), 55 * 60000);
      await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(0, '127.0.0.1', yes); }); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing kernel port'); origin = 'http://127.0.0.1:' + address.port;
      await writeFile(prefix + 'ready.json', JSON.stringify({ status: 'ready', run_id: runId, origin, prefix, control, pid: process.pid, plans: spreadPosterBrowserPlans, tables: f.tables, sequences: f.sequences,
        identities: runtime.identities, setup: f.setup, synthetic_authority: { app_key_base64: Buffer.from(f.appKey).toString('base64'), tokens: [...f.tokens] }, baseline_sha256: remember(expected), source_manifest: sourceBefore, build_manifest: buildBefore,
        boundary: 'Actual H5/createApp/JWT/independent PG16 LOGIN. Only first localH5 QR cache two-row DML is allowed; all poster/media/theme/finance/cached QR reads conserve283tables229sequences. Finite QA session/fixture controls are nonproof. PNG export/decode recorded; separate offline bitmap/QR verification needed. No provider/device/production-login/naturalexpiry/same-instanceABA claim.' }, null, 2) + '\n', { mode: 0o600 });
      console.log('SPREAD_POSTER_BROWSER_READY ' + origin); await completion; await queue;
      if (server) { server.closeAllConnections(); await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); }
      await writeFile(prefix + 'evidence.json', JSON.stringify({ status: 'passed', run_id: runId, control, plans: spreadPosterBrowserPlans, evidence, traces, controls, statics, snapshots_by_sha256: snapshots,
        setup: f.setup, final_sha256: remember(await f.snapshot()), resources: f.resources(), r2_reads: f.assetReads, kv_reads: f.kvReads, budget_calls: f.budgetCalls, identities: runtime.identities, source_manifest: sourceBefore, build_manifest: buildBefore }, null, 2) + '\n', { mode: 0o600 });
    }, { shareWrites: true });
  } catch (error) { failure ??= error; await writeFile(prefix + 'failed.json', JSON.stringify({ status: 'failed', run_id: runId, error: String(error), stack: error instanceof Error ? error.stack : null, evidence, traces, controls, statics, snapshots_by_sha256: snapshots, expected, actual: await f.snapshot().catch(() => null) }, null, 2) + '\n', { mode: 0o600 }); throw error; }
  finally {
    clearTimeout(timer); try { if (server?.listening) { server.closeAllConnections(); await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); } } catch (error) { cleanupFailure ??= error; }
    try { await f.close(); fixtureClosed = true; } catch (error) { cleanupFailure ??= error; } wiring.context = undefined; vi.restoreAllMocks();
    await writeFile(prefix + 'cleanup.json', JSON.stringify({ run_id: runId, server_closed: !server?.listening, fixture_closed: fixtureClosed, pending, queued, failure: failure ? String(failure) : null, cleanup_failure: cleanupFailure ? String(cleanupFailure) : null }) + '\n', { mode: 0o600 }); if (cleanupFailure) throw cleanupFailure;
  }
}, 57 * 60000);
