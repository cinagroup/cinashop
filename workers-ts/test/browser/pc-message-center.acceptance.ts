/** Production PC bundle -> actual App/JWT -> commissioned restricted PG16
 * LOGIN. Controls only select synthetic accounts and finite transport/visibility
 * faults; they never supply a business DTO or mark a message read themselves. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { systemConfig, systemMessage } from '@/models/schema';
import { messageCenterFixture, IDS as ids, messageVisibleRows, messageUnreadCount, assertMessageReadConsumption } from '../helpers/messageCenterFixture';
import { stableDiyState, type DiyStateSnapshot, type DiyStateRow as Row } from '../helpers/diyStateFixture';

const wiring = vi.hoisted(() => ({ context: undefined as AsyncLocalStorage<Container> | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  const value = wiring.context?.getStore(); if (!value) throw Error('PC message App LOGIN required'); return value;
} }));
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const digest = (v: unknown) => hash(stableDiyState(v));
const prefix = '/tmp/cinashop-pc-message-center-browser-';
export const pcMessageBrowserPlans = [
  { name: 'guest', owner: 0, width: 1280, kind: 'guest' },
  { name: 'first', owner: ids.a, width: 1280, kind: 'page', page: 1 },
  { name: 'detail', owner: ids.a, width: 1280, kind: 'detail', page: 1 },
  { name: 'collapsed', owner: ids.a, width: 1280, kind: 'collapsed', page: 1 },
  { name: 'detail-error', owner: ids.a, width: 1280, kind: 'detail-error', page: 1 },
  { name: 'detail-retried', owner: ids.a, width: 1280, kind: 'detail', page: 1 },
  { name: 'detail-null', owner: ids.a, width: 1280, kind: 'missing', page: 1 },
  { name: 'page2-lost', owner: ids.a, width: 1280, kind: 'lost', page: 1 },
  { name: 'summary-recovered', owner: ids.a, width: 1280, kind: 'summary', page: 1 },
  { name: 'page2-retried', owner: ids.a, width: 1280, kind: 'page', page: 2 },
  { name: 'page3', owner: ids.a, width: 1280, kind: 'page', page: 3 },
  { name: 'page4', owner: ids.a, width: 1280, kind: 'page', page: 4 },
  { name: 'owner-b', owner: ids.b, width: 1280, kind: 'page', page: 1 },
  { name: 'mobile-a', owner: ids.a, width: 375, kind: 'detail', page: 1 },
] as const;
async function files(root: string): Promise<string[]> {
  return (await Promise.all((await readdir(root, { withFileTypes: true })).map(e => e.isDirectory() ? files(resolve(root, e.name)) : [resolve(root, e.name)]))).flat().sort();
}
async function requestBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; expect(size).toBeLessThanOrEqual(131072); chunks.push(bytes); }
  return Buffer.concat(chunks);
}

it('accepts PC seven-per-page messages, exact receipts, lost acknowledgement recovery and account isolation', async () => {
  for (const name of ['ready', 'progress', 'result', 'failed', 'cleanup']) expect(await stat(prefix + name + '.json').then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return false; throw e;
  }), 'Archive previous owned PC message browser attempt').toBe(false);
  const repository = resolve(import.meta.dirname, '../../..'), dist = resolve(repository, 'view/pc-ts/dist');
  const runId = randomUUID(), control = '/__pc_message_center/' + runId, f = await messageCenterFixture(), app = createApp();
  const longContent = '本人原始正文 <img src=x onerror="globalThis.__messageUnsafe=1">\n' + '完整多行正文，保留普通文字与 Unicode 😀。\n'.repeat(200);
  let expected = await f.snapshot(), server: ReturnType<typeof createServer> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let origin = '', actor = 0, pending = 0, queued = 0, finished = false, closed = false, failure: unknown, cleanupFailure: unknown;
  let nextLost = false, nextDetailError = false, nextNull = false, queue = Promise.resolve();
  const traces: Row[] = [], evidence: Row[] = [], controls: Row[] = [], snapshots: Record<string, DiyStateSnapshot> = {}, statics: Row[] = [];
  const remember = (value: DiyStateSnapshot) => { const key = digest(value); snapshots[key] ??= structuredClone(value); return key; };
  const stage = () => pcMessageBrowserPlans[evidence.length];
  const activity = () => ({ pending, queued, nextLost, nextDetailError, nextNull });
  let done!: () => void, fail!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; }); completion.catch(() => {});
  const serial = <T>(run: () => Promise<T>) => {
    queued++; const value = queue.then(run).finally(() => { queued--; });
    queue = value.then(() => {}, error => { failure ??= error; fail(error); }); return value;
  };
  const send = (res: ServerResponse, bytes: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(bytes);
  };
  const state = () => ({ status: finished ? 'passed' : 'running', run_id: runId, control, origin, next: stage()?.name ?? null,
    activity: activity(), actor, plans: pcMessageBrowserPlans, evidence, traces, controls, statics, snapshots_by_sha256: snapshots, resources: f.resources() });
  const persist = () => writeFile(prefix + 'progress.json', JSON.stringify(state(), null, 2) + '\n', { mode: 0o600 });
  const sourcePaths = ['workers-ts/test/browser/pc-message-center.acceptance.ts', 'workers-ts/vitest.pc-message-center-browser.config.ts',
    'workers-ts/scripts/run-local-finance-postgres.mjs', 'workers-ts/test/local-finance-postgres-runner.test.ts', 'view/pc-ts/package.json', 'view/pc-ts/package-lock.json'];
  const manifest = async (paths: string[]) => Promise.all([...new Set(paths)].sort().map(async path => {
    const bytes = await readFile(path); return { path: path.slice(repository.length + 1), bytes: bytes.length, sha256: hash(bytes) };
  }));
  const sources = () => Promise.all([files(resolve(repository, 'workers-ts/src')), files(resolve(repository, 'workers-ts/test/helpers')),
    files(resolve(repository, 'view/pc-ts/src')), files(resolve(repository, 'view/common'))]).then(groups => manifest([...groups.flat(), ...sourcePaths.map(p => resolve(repository, p))]));
  const builds = () => files(dist).then(manifest);
  let sourceBefore: Row[] = [], buildBefore: Row[] = [];
  try {
    await f.db.update(systemMessage).set({ content: longContent }).where(eq(systemMessage.id, ids.ownMessage));
    // Only owned public media references are cleared. Real configuration APIs
    // still answer the app; no remote image/provider is needed by this flow.
    for (const key of ['pc_logo', 'site_logo', 'site_logo_square', 'login_logo', 'ico_path']) await f.db.update(systemConfig).set({ value: '""' }).where(eq(systemConfig.menuName, key));
    expected = await f.snapshot();
    wiring.context = new AsyncLocalStorage<Container>(); sourceBefore = await sources(); buildBefore = await builds();
    expect(buildBefore.length).toBeGreaterThan(20); expect((await stat(resolve(dist, 'index.html'))).isFile()).toBe(true);
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('PC message browser prohibits outbound network'); });
    await f.withApplication(async runtime => {
      remember(expected); const resourcesBefore = f.resources();
      async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer) {
        pending++;
        try {
          expect(req.method).toBe('GET'); expect(raw).toHaveLength(0);
          const summary = url.pathname === '/api/user/message', list = url.pathname === '/api/user/message_system/list';
          const detail = /^\/api\/user\/message_system\/detail\/([1-9]\d*)$/.exec(url.pathname);
          const allowed = new Set(['/api/cart/count', '/api/cart/list', '/api/site_config', '/api/share', '/api/pc/get_company_info', '/api/pc/get_appid']);
          expect(summary || list || !!detail || allowed.has(url.pathname), 'Finite actual GET: ' + url.pathname).toBe(true);
          if (summary) expect([...url.searchParams]).toEqual([['view', 'pc_message_summary']]);
          if (list) { expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'page', 'view']); expect(url.searchParams.get('view')).toBe('pc_system_messages'); expect(url.searchParams.get('limit')).toBe('7'); expect(['1', '2', '3', '4']).toContain(url.searchParams.get('page')); }
          if (detail) { expect([ids.ownMessage, ids.broadcast]).toContain(Number(detail[1])); expect([...url.searchParams]).toEqual([['view', 'system_message_detail']]); }
          const authorization = String(req.headers['authori-zation'] ?? req.headers.authorization ?? '');
          const owner = [ids.a, ids.b].find(uid => authorization === 'Bearer ' + f.tokens.get(uid)) ?? 0;
          if (authorization) expect(owner).toBeGreaterThan(0); if (summary || list || detail) expect(owner).toBe(actor);
          const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) if (!['host', 'connection', 'content-length'].includes(req.rawHeaders[i]!.toLowerCase())) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
          await serial(async () => {
            expect(await f.snapshot()).toEqual(expected);
            const nullFault = !!detail && nextNull;
            if (nullFault) { expect(stage()?.name).toBe('detail-null'); expect(Number(detail![1])).toBe(ids.broadcast); nextNull = false;
              const changed = await f.control('hide-broadcast'); expect(changed.before).toEqual(expected); expected = changed.after;
              controls.push({ kind: 'finite-visibility-fixture', nonproof: true, name: 'hide-broadcast', before: remember(changed.before), after: remember(changed.after) }); }
            const before = await f.snapshot(), start = Date.now(), jobs: Promise<unknown>[] = [];
            const response = await wiring.context!.run(runtime.container, () => app.fetch(new Request(origin + url.pathname + url.search, { method: 'GET', headers }), runtime.env,
              { waitUntil: (job: Promise<unknown>) => jobs.push(job), passThroughOnException: () => {} } as never));
            const bytes = Buffer.from(await response.arrayBuffer()); expect((await Promise.allSettled(jobs)).every(result => result.status === 'fulfilled')).toBe(true);
            const end = Date.now(), after = await f.snapshot(); let dto: Row | null = null; try { dto = JSON.parse(bytes.toString()) as Row; } catch {}
            let classification: Row = { kind: 'actual-read-only', all_283_tables_229_sequences_unchanged: true };
            if (summary || list || detail) {
              expect(owner).toBeGreaterThan(0); expect(dto?.status, dto?.msg).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(jobs).toEqual([]);
              const visible = messageVisibleRows(before, owner), selected = list ? visible.slice((Number(url.searchParams.get('page')) - 1) * 7, Number(url.searchParams.get('page')) * 7) : detail ? visible.filter(row => row.id === Number(detail[1])) : [];
              if (list || detail) classification = assertMessageReadConsumption(before, after, owner, selected.map(row => row.id), Math.floor(start / 1000), Math.floor(end / 1000));
              else expect(after).toEqual(before);
              if (summary) expect(dto!.data).toEqual({ version: 1, owner_uid: owner, unread: messageUnreadCount(before, owner) });
              if (list) {
                expect(dto!.data).toMatchObject({ version: 1, owner_uid: owner, query: { page: Number(url.searchParams.get('page')), limit: 7 }, count: visible.length,
                  page_count: Math.ceil(visible.length / 7), unread_before: messageUnreadCount(before, owner), unread_after: messageUnreadCount(after, owner) });
                expect(dto!.data.list.map((row: Row) => row.id)).toEqual(selected.map(row => row.id));
                for (const row of dto!.data.list) { const original = selected.find(value => value.id === row.id)!;
                  expect(row.read_before).toBe(original.look === 1 || before.user_message.some(receipt => receipt.uid === owner && receipt.message_id === original.id && receipt.is_read === 1)); }
              }
              if (detail) { expect(dto!.data).toMatchObject({ owner_uid: owner, id: Number(detail[1]), service_num: messageUnreadCount(after, owner) });
                expect(dto!.data.message?.id ?? null).toBe(selected[0]?.id ?? null); if (nullFault) expect(dto!.data.message).toBeNull(); }
            } else expect(after).toEqual(before);
            expected = after; expect(f.resources()).toEqual(resourcesBefore); expect(f.assetReads).toEqual([]); expect(f.forbidden).not.toHaveBeenCalled();
            let status = response.status, outgoing = bytes, delivery = 'complete-worker-response';
            if (list && nextLost) { expect(stage()?.name).toBe('page2-lost'); expect(url.searchParams.get('page')).toBe('2'); nextLost = false; status = 503;
              delivery = 'actual-success-receipts-committed-response-replaced-503'; outgoing = Buffer.from(JSON.stringify({ status: 503, msg: '本机验收：该页已实际读取，回执丢失，请只读核对后重试', data: null })); }
            if (detail && nextDetailError) { expect(stage()?.name).toBe('detail-error'); nextDetailError = false; status = 503;
              delivery = 'actual-success-detail-ack-replaced-503'; outgoing = Buffer.from(JSON.stringify({ status: 503, msg: '本机验收：详情回执暂不可用，请显式重试', data: null })); }
            traces.push({ index: traces.length, phase: stage()?.name, method: 'GET', path: url.pathname, query: url.search, owner, status: response.status, delivered_status: status, delivery,
              started_at_ms: start, ended_at_ms: end, before_sha256: remember(before), after_sha256: remember(after), dto, response_sha256: hash(bytes), classification, wait_until_count: jobs.length });
            if (nullFault) { const changed = await f.control('restore-broadcast'); expect(changed.before).toEqual(expected); expected = changed.after;
              controls.push({ kind: 'finite-visibility-fixture', nonproof: true, name: 'restore-broadcast', before: remember(changed.before), after: remember(changed.after) }); }
            await persist(); const responseHeaders = Object.fromEntries(response.headers); delete responseHeaders['content-length'];
            res.writeHead(status, responseHeaders); res.end(outgoing);
          });
        } finally { pending--; }
      }
      async function capture(data: Row) {
        const plan = stage(); expect(plan).toBeDefined(); expect(data.name).toBe(plan!.name); expect(data.run_id).toBe(runId); expect(actor).toBe(plan!.owner);
        expect(data.width).toBe(plan!.width); expect(data.scrollWidth).toBeLessThanOrEqual(data.clientWidth); expect(data.outerScrollWidth).toBeLessThanOrEqual(data.width);
        expect(data.errors).toEqual([]); expect(data.overlay).toBe(false); expect(data.unsafe_markup).toBe(false); expect(String(data.text).length).toBeGreaterThan(100);
        expect(new URL(data.href).origin).toBe(origin); expect(data.title.length).toBeGreaterThan(0);
        const current = traces.slice(Number(evidence.at(-1)?.trace_count ?? 0)), text = String(data.text);
        expect(text).not.toMatch(/员工私密提醒|普通会员不得读取|停用消息|已删消息/);
        if (plan!.kind === 'guest') { const destination = new URL(data.href); expect(destination.pathname).toBe('/login'); expect(destination.searchParams.get('redirect')).toBe('/user/messageCenter');
          expect(data.ids).toEqual([]); expect(current.filter(trace => trace.path.startsWith('/api/user/'))).toEqual([]); }
        else {
          expect(new URL(data.href).pathname).toBe('/user/messages'); const page = 'page' in plan! ? plan!.page : 1;
          const visible = messageVisibleRows(expected, actor), selected = visible.slice((page - 1) * 7, page * 7);
          expect(data.ids).toEqual(selected.map(row => row.id)); expect(data.total).toContain('共 ' + visible.length + ' 条站内信'); expect(data.total).toContain('第 ' + page + ' 页');
          expect(data.nav_href).toBe('/user/messages'); expect(data.loading).toBe(false);
          if (actor === ids.a) expect(text).not.toContain('B本人消息'); else { expect(data.ids).toEqual([ids.foreignMessage, ids.broadcast]); expect(text).toContain('B本人消息'); expect(text).not.toContain('本人最新通知'); }
          if (plan!.kind === 'lost') { expect(data.alerts.join(' ')).toContain('第 2 页读取未确认'); expect(text).toContain('仍显示上次成功读取的第 1 页'); expect(text).toContain('未读数待核对');
            expect(current.filter(trace => trace.path === '/api/user/message_system/list' && trace.query.includes('page=2'))).toHaveLength(1); }
          else if (plan!.kind === 'summary') { expect(data.alerts.join(' ')).toContain('第 2 页读取未确认'); expect(text).toContain('当前未读 ' + messageUnreadCount(expected, actor) + ' 条');
            expect(current.filter(trace => trace.path === '/api/user/message_system/list')).toEqual([]); expect(current.filter(trace => trace.path === '/api/user/message')).toHaveLength(1); }
          else if (plan!.kind === 'detail-error') expect(data.alerts.join(' ')).toContain('Request failed');
          else { expect(data.alerts).toEqual([]); expect(text).toContain('当前未读 ' + messageUnreadCount(expected, actor) + ' 条'); }
          if (plan!.kind === 'detail') { expect(data.detail_id).toBe(ids.ownMessage); expect(data.content).toBe(longContent); expect(data.content).toContain('<img src=x onerror="globalThis.__messageUnsafe=1">'); }
          if (plan!.kind === 'collapsed') { expect(data.detail_id).toBe(0); expect(current.filter(trace => trace.path.startsWith('/api/user/message_system/detail/'))).toEqual([]); }
          if (plan!.kind === 'missing') { expect(data.detail_id).toBe(ids.broadcast); expect(text).toContain('消息不存在或已不可查看'); expect(current.some(trace => trace.dto?.data?.message === null)).toBe(true); }
          if (plan!.name === 'page2-retried') { const read = current.filter(trace => trace.path === '/api/user/message_system/list'); expect(read).toHaveLength(1); expect(read[0]!.classification.serial_allocations).toBe(0); expect(read[0]!.classification.updated_receipt_ids).toEqual([]); }
        }
        expect(await f.snapshot()).toEqual(expected); expect(f.forbidden).not.toHaveBeenCalled();
        evidence.push({ ...data, trace_count: traces.length, snapshot_sha256: remember(expected) }); await persist(); return { accepted: true, name: plan!.name, next: stage()?.name ?? null };
      }
      const observer = '<script>window.__pcMessageQa={errors:[]};addEventListener("error",e=>{if(e.message)window.__pcMessageQa.errors.push(e.message)},true);addEventListener("unhandledrejection",e=>window.__pcMessageQa.errors.push(String(e.reason)));</script>';
      const shell = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>PC站内信真实链验收</title><style>body{margin:0;font:13px sans-serif;background:#edf0f4}nav{display:flex;gap:5px;flex-wrap:wrap;padding:5px}button{padding:5px}iframe{display:block;border:0;width:100%;height:calc(100vh - 100px)}pre{margin:0;font-size:11px;max-height:35px;overflow:auto;white-space:pre-wrap}</style><nav>${['guest', 'ownerA', 'ownerB', 'losePage2', 'detailError', 'nullDetail', 'capture', 'state', 'finish'].map(name => '<button id="' + name + '">' + name + '</button>').join('')}</nav><pre id="snapshot">按 ready.json plans 逐项操作真实 UI，再点 capture。</pre><iframe id="app" title="PC正式站内信"></iframe><script>
      const base=${JSON.stringify(control)},runId=${JSON.stringify(runId)};let next=${JSON.stringify(pcMessageBrowserPlans[0].name)};
      const report=v=>document.getElementById('snapshot').textContent=JSON.stringify(v);
      for(const entry of ['guest','ownerA','ownerB'])document.getElementById(entry).onclick=()=>document.getElementById('app').src=base+'/bootstrap?entry='+entry;
      for(const action of ['losePage2','detailError','nullDetail','state','finish'])document.getElementById(action).onclick=async()=>report(await(await fetch(base+'/'+action,{method:'POST'})).json());
      document.getElementById('capture').onclick=async()=>{try{const w=document.getElementById('app').contentWindow,d=w.document,q=s=>d.querySelector(s),all=s=>[...d.querySelectorAll(s)],body=d.body,main=q('[data-pc-message-center]'),expanded=q('[data-message-id] button[aria-expanded="true"]');
       const data={name:next,run_id:runId,width:innerWidth,href:w.location.href,title:d.title,clientWidth:d.documentElement.clientWidth,scrollWidth:d.documentElement.scrollWidth,outerScrollWidth:document.documentElement.scrollWidth,text:body.innerText,ids:all('[data-message-id]').map(n=>Number(n.dataset.messageId)),total:q('[data-message-total]')?.textContent||'',nav_href:q('.message-nav a')?.getAttribute('href')||'',detail_id:expanded?Number(expanded.closest('[data-message-id]').dataset.messageId):0,content:q('.message-content')?.textContent||'',alerts:all('[role="alert"]').map(n=>n.innerText),loading:!!main&&main.innerText.includes('正在读取'),errors:w.__pcMessageQa?.errors||[],unsafe_markup:!!w.__messageUnsafe||!!q('.message-content img'),overlay:!!q('vite-error-overlay')};
       const r=await(await fetch(base+'/capture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)})).json();if(r.accepted)next=r.next;report(r);}catch(e){report({error:String(e)})}};
      </script>`;
      server = createServer((req, res) => { void (async () => {
        expect(req.socket.remoteAddress).toBe('127.0.0.1'); expect(req.headers.host).toBe(new URL(origin).host);
        const url = new URL(req.url ?? '/', origin), raw = await requestBody(req);
        if (url.pathname === control) { expect(req.method).toBe('GET'); return send(res, shell); }
        if (url.pathname === control + '/bootstrap') {
          expect(req.method).toBe('GET'); expect([...url.searchParams.keys()]).toEqual(['entry']); const entry = url.searchParams.get('entry'); expect(['guest', 'ownerA', 'ownerB']).toContain(entry);
          actor = entry === 'guest' ? 0 : entry === 'ownerA' ? ids.a : ids.b; controls.push({ kind: 'synthetic-document-account', nonproof: true, actor, phase: stage()?.name });
          const token = actor ? f.tokens.get(actor) : '', target = actor ? '/user/messages' : '/user/messageCenter';
          return send(res, '<!doctype html><meta charset="utf-8"><script>sessionStorage.setItem("pc_token",' + JSON.stringify(token) + ');sessionStorage.setItem("pc_uid",' + JSON.stringify(String(actor)) + ');location.replace(' + JSON.stringify(target) + ');</script>');
        }
        if (url.pathname.startsWith(control + '/')) {
          expect(req.method).toBe('POST'); expect(req.headers.origin).toBe(origin); expect(url.search).toBe(''); const action = url.pathname.slice(control.length + 1);
          expect(['losePage2', 'detailError', 'nullDetail', 'capture', 'state', 'finish']).toContain(action);
          if (pending || queued) return send(res, JSON.stringify({ accepted: false, reason: 'business request pending', activity: activity() }), 200, 'application/json');
          const result = await serial(async () => {
            expect(await f.snapshot()).toEqual(expected);
            if (action === 'losePage2') { expect(stage()?.name).toBe('page2-lost'); expect(nextLost).toBe(false); nextLost = true; }
            if (action === 'detailError') { expect(stage()?.name).toBe('detail-error'); expect(nextDetailError).toBe(false); nextDetailError = true; }
            if (action === 'nullDetail') { expect(stage()?.name).toBe('detail-null'); expect(nextNull).toBe(false); nextNull = true; }
            if (action === 'capture') return capture(JSON.parse(raw.toString()) as Row);
            if (action === 'finish') {
              expect(evidence.map(item => item.name)).toEqual(pcMessageBrowserPlans.map(plan => plan.name)); expect(nextLost || nextDetailError || nextNull).toBe(false);
              expect(traces.filter(trace => trace.delivery === 'actual-success-receipts-committed-response-replaced-503')).toHaveLength(1);
              expect(traces.filter(trace => trace.delivery === 'actual-success-detail-ack-replaced-503')).toHaveLength(1);
              expect(messageUnreadCount(expected, ids.a)).toBe(0); expect(messageUnreadCount(expected, ids.b)).toBe(0);
              expect(traces.reduce((sum, trace) => sum + Number(trace.classification.serial_allocations ?? 0), 0)).toBe(22);
              expect(traces.flatMap(trace => trace.classification.updated_receipt_ids ?? [])).toEqual([9001, 9002]);
              expect(expected.user_message).toHaveLength(26);
              expect(await sources()).toEqual(sourceBefore); expect(await builds()).toEqual(buildBefore); expect(outbound).not.toHaveBeenCalled();
              finished = true; await writeFile(prefix + 'result.json', JSON.stringify({ ...state(), source_manifest: sourceBefore, build_manifest: buildBefore, identities: runtime.identities,
                full_business_tables: f.tables.length, full_sequences: f.sequences.length, final_snapshot_sha256: remember(expected) }, null, 2) + '\n', { mode: 0o600 });
            }
            await persist(); return { accepted: true, action, next: stage()?.name ?? null, activity: activity(), finished };
          }); send(res, JSON.stringify(result), 200, 'application/json'); if (finished) done(); return;
        }
        if (url.pathname.startsWith('/api/')) return dispatch(req, res, url, raw);
        expect(req.method).toBe('GET'); if (url.pathname === '/favicon.ico') return send(res, '', 204);
        const target = resolve(dist, '.' + decodeURIComponent(url.pathname)); expect(target === dist || target.startsWith(dist + sep)).toBe(true);
        const selected = (await stat(target).catch(() => null))?.isFile() ? target : resolve(dist, 'index.html');
        const original = await readFile(selected), bytes = selected === resolve(dist, 'index.html') ? Buffer.from(original.toString().replace('<head>', '<head><link rel="icon" href="data:,">' + observer)) : original;
        statics.push({ path: url.pathname, source: selected.slice(repository.length + 1), sha256: hash(original), served_sha256: hash(bytes) });
        return send(res, bytes, 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' } as Record<string, string>)[extname(selected)] ?? 'text/html; charset=utf-8');
      })().catch(error => { failure ??= error; fail(error); if (!res.headersSent) send(res, JSON.stringify({ error: String(error) }), 500, 'application/json'); else res.end(); }); });
      timer = setTimeout(() => fail(Error('PC message browser finish deadline')), 90 * 60000);
      await new Promise<void>((yes, no) => { server!.once('error', no); server!.listen(0, '127.0.0.1', yes); });
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Owned PC message listener missing'); origin = 'http://127.0.0.1:' + address.port;
      await writeFile(prefix + 'ready.json', JSON.stringify({ status: 'ready', run_id: runId, url: origin + control, origin, control, prefix, pid: process.pid, plans: pcMessageBrowserPlans,
        full_business_tables: f.tables.length, full_sequences: f.sequences.length, identities: runtime.identities, source_manifest: sourceBefore, build_manifest: buildBefore,
        boundary: 'Real PC bundle/App/JWT/restricted PG16. Page/detail receipts proved by independent raw-state oracle. Controls select local synthetic accounts or finite transport/visibility faults only. No real login/provider/Queue/send.' }, null, 2) + '\n', { mode: 0o600 });
      process.stdout.write('PC_MESSAGE_CENTER_BROWSER_READY ' + origin + control + '\n'); await completion; await queue;
    });
  } catch (error) { failure ??= error; await writeFile(prefix + 'failed.json', JSON.stringify({ ...state(), error: String(error), stack: error instanceof Error ? error.stack : null,
    actual: await f.snapshot().catch(() => null) }, null, 2) + '\n', { mode: 0o600 }); throw error;
  } finally {
    clearTimeout(timer);
    try { if (server?.listening) { server.closeAllConnections(); await new Promise<void>((yes, no) => server!.close(error => error ? no(error) : yes())); } } catch (error) { cleanupFailure ??= error; }
    try { await f.close(); closed = true; } catch (error) { cleanupFailure ??= error; }
    wiring.context = undefined; vi.restoreAllMocks(); await writeFile(prefix + 'cleanup.json', JSON.stringify({ run_id: runId, finished, server_closed: !server?.listening, fixture_closed: closed,
      pending, queued, fault_flags_cleared: !nextLost && !nextDetailError && !nextNull, failure: failure ? String(failure) : null, cleanup_failure: cleanupFailure ? String(cleanupFailure) : null }, null, 2) + '\n', { mode: 0o600 });
    if (cleanupFailure) throw cleanupFailure;
  }
}, 92 * 60000);
