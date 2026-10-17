/** Production Vue + actual App/JWT + independent note-only PG16 LOGIN + IAB.
 * Synthetic ledgers exercise reads/descriptions, never payment execution. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { systemRole } from '@/models/schema';
import { supplierFlowReadFixture } from '../helpers/supplierFlowRead';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned flow note LOGIN'); return wiring.container;
} }));
it('reads all105 filtered flows, writes only descriptions, recovers lost acknowledgements and isolates stale sessions through IAB', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierFlowReadFixture(), control = '/__supplier_flow_fixture/' + randomUUID(), app = createApp();
  const statisticsScript = 'globalThis.__ownedSupplierFlowStatistics = 1;';
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? statisticsScript : null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const paths: any[] = [], notes: any[] = [], downloads: any[] = [], pages = new Set<number>(), searches = new Set<string>();
  const held: Array<() => void> = []; let armRead = false, armMark = false, armDrop = false, readHeld = 0, markHeld = 0, released = 0, dropped = 0;
  let origin = '', finished = false, outbound = 0, readonlyGets = 0, viewerLogins = 0, withdrawn = false, denied = false, restored = false, scriptSeen = false;
  let chain = Promise.resolve(), deadline: ReturnType<typeof setTimeout> | undefined, finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const baseline = await f.snapshot();
  const state = () => ({ finished, readonlyGets, outbound, readHeld, markHeld, released, dropped, viewerLogins, withdrawn, denied, restored, scriptSeen,
    pages: [...pages].sort((a, b) => a - b), searches: [...searches], notes, downloads, paths });
  const canonical = (s: Record<string, any[]>) => Object.fromEntries(Object.entries(s).map(([table, rows]) => [table, rows.map(row => JSON.stringify(row)).sort()]));
  function onlyNote(before: Record<string, any[]>, after: Record<string, any[]>, id: number, expected: string) {
    const old = before.supplier_flowing_water.find(row => row.row.id === id), next = after.supplier_flowing_water.find(row => row.row.id === id);
    expect(old?.row.supplier_id).toBe(7); expect(next?.row.mark).toBe(expected);
    const normalized = structuredClone(after); normalized.supplier_flowing_water.find(row => row.row.id === id)!.row.mark = old!.row.mark;
    expect(canonical(normalized)).toEqual(canonical(before));
  }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const observer = `<script>(()=>{const control=${JSON.stringify(control)},create=URL.createObjectURL.bind(URL),click=HTMLAnchorElement.prototype.click,blobs=new Map();
    URL.createObjectURL=b=>{const u=create(b);blobs.set(u,b);return u;};HTMLAnchorElement.prototype.click=function(){const b=blobs.get(this.href),filename=this.download;click.call(this);if(b)b.text().then(csv=>fetch(control+'/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename,csv})}));};})();</script>`;
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商流水备注 PG16 验收</title><h1>供应商流水与描述字段验收</h1>
      <p>本机合成流水。业务LOGIN仅六表SELECT、流水UPDATE(mark)、权限表UPDATE(id)供行锁；禁止业务新增流水、改金额和序列。9月4日105条须读完第6页，支持Alice Buyer、UID11与A%_LITERAL字面搜索。</p>
      <p>仅给BILL-INCOME编辑两次备注：首次提交后故意丢失回执，先GET核对；第二次保存“已人工核对凭据”。扣留下一列表/备注GET后切换筛选或关闭编辑，不应显示迟到结果。</p>
      <button id="login">管理账号进入流水</button><button id="holdread">扣留下一列表回复</button><button id="holdmark">扣留下一备注回复</button><button id="release">释放已扣留回复</button><button id="dropmark">丢失下一备注提交回执</button>
      <button id="viewer">切换只读会话</button><button id="manager">切回管理会话</button><button id="withdraw">撤销夹具备注权限</button><button id="restore">恢复夹具备注权限</button><button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>
      const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
      function session(viewer){localStorage.setItem('supplier-token',viewer?tokens.denied:tokens.reader);localStorage.setItem('supplier-user',JSON.stringify({id:viewer?22:21,supplier_id:7,supplier_name:'本机流水供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(viewer?['supplier.finance.view']:['supplier.finance.view','supplier.finance.manage']));}
      document.getElementById('login').onclick=()=>{session(false);location.href='/finance/flows';};
      for(const name of ['holdread','holdmark','release','dropmark','viewer','manager','withdraw','restore','status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(control+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();if(r.ok&&(name==='viewer'||name==='manager'))session(name==='viewer');};</script></html>`);
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); await chain;
      if (path.endsWith('/download')) {
        let body = ''; for await (const chunk of req) { body += chunk.toString(); expect(body.length).toBeLessThan(128 * 1024); }
        const value = JSON.parse(body), csv = String(value.csv), lines = csv.split('\r\n'); expect(lines).toHaveLength(3);
        expect(lines[1]).toContain('MANY-104'); expect(lines[2]).toContain('MANY-103');
        downloads.push({ filename: value.filename, lines: lines.length, bytes: Buffer.byteLength(csv), sha256: createHash('sha256').update(csv).digest('hex'), first: lines[1], last: lines[2] });
      }
      if (path.endsWith('/holdread')) { expect(armRead).toBe(false); armRead = true; }
      if (path.endsWith('/holdmark')) { expect(armMark).toBe(false); armMark = true; }
      if (path.endsWith('/dropmark')) { expect(armDrop).toBe(false); armDrop = true; }
      if (path.endsWith('/release')) { expect(held.length).toBeGreaterThan(0); while (held.length) { held.shift()!(); released++; } }
      if (path.endsWith('/viewer')) viewerLogins++;
      if (path.endsWith('/withdraw')) { await f.db.update(systemRole).set({ rules: 'supplier.finance.view' }).where(eq(systemRole.id, 21)); withdrawn = true; }
      if (path.endsWith('/restore')) { expect(denied).toBe(true); await f.db.update(systemRole).set({ rules: 'supplier.finance.view,supplier.finance.manage' }).where(eq(systemRole.id, 21)); withdrawn = false; restored = true; }
      if (path.endsWith('/finish')) {
        expect(armRead || armMark || armDrop || withdrawn).toBe(false); expect(held).toHaveLength(0);
        expect(readHeld).toBe(1); expect(markHeld).toBe(1); expect(released).toBe(2); expect(dropped).toBe(1);
        expect(denied && restored && scriptSeen).toBe(true); expect(viewerLogins).toBeGreaterThanOrEqual(1);
        expect([...pages].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
        for (const term of ['Alice Buyer', '11', 'A%_LITERAL']) expect(searches.has(term)).toBe(true);
        expect(downloads).toHaveLength(1); expect(notes).toHaveLength(2); expect(notes.every(row => row.id === 1)).toBe(true);
        expect(notes.at(-1).mark).toBe('已人工核对凭据'); expect(paths.filter(row => row.method === 'POST')).toHaveLength(3); expect(outbound).toBe(0);
        const final = await f.snapshot(); onlyNote(baseline, final, 1, '已人工核对凭据'); finished = true;
        await writeFile('/tmp/cinashop-supplier-flow-browser-result.json', JSON.stringify(state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      expect(['GET', 'POST']).toContain(method); let raw = '';
      if (method === 'POST') { for await (const chunk of req) raw += chunk.toString(); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2048); }
      let release!: () => void; const previous = chain; chain = new Promise(done => { release = done; }); await previous;
      let body = '', status = 200, headers: Record<string, string> = {}, delay = false, drop = false;
      try {
        const before = await f.snapshot(), response = await app.request(path + url.search, { method, headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: raw } : {}) }, env);
        body = await response.text(); status = response.status; headers = Object.fromEntries(response.headers); const after = await f.snapshot();
        if (method === 'GET') { expect(after).toEqual(before); readonlyGets++; }
        if (path === '/api/get_script') {
          expect(status).toBe(200); expect(headers['content-type']).toBe('application/javascript; charset=utf-8');
          expect(body).toBe(statisticsScript); scriptSeen = true;
        }
        else {
          expect(headers['cache-control']).toContain('private, no-store'); const value = JSON.parse(body), q = url.searchParams;
          paths.push({ path, query: Object.fromEntries(q), method, status, envelope: value.status });
          if (method === 'POST') {
            expect(path).toBe('/supplierapi/finance/supplier_flowing_water/mark/1'); const input = JSON.parse(raw);
            expect(Object.keys(input).sort()).toEqual(['expected_revision', 'mark', 'selection']); expect(input.selection).toBe('ledger');
            if (withdrawn) { expect(value.status).toBe(400011); expect(after).toEqual(before); denied = true; }
            else {
              if (value.status !== 200) throw Error('Owned note POST rejected: ' + JSON.stringify({ input, response: value, markReads: paths.filter(row => row.path.includes('/mark/')) }));
              expect(value.status).toBe(200); onlyNote(before, after, 1, input.mark); expect(value.data).toMatchObject({ version: 'supplier-flow-mark-v1', id: 1, supplier_id: 7, mark: input.mark });
              notes.push({ id: 1, mark: input.mark, revision: value.data.revision });
              if (armDrop) { armDrop = false; dropped++; drop = true; }
            }
          } else {
            expect(value.status).toBe(200);
            if (path.endsWith('/list')) {
              expect(value.data).toMatchObject({ version: 'supplier-flow-v1', selection: 'ledger', supplier_id: 7, bounded: true });
              expect(value.data.list.every((row: any) => row.supplier_id === 7 && row.is_del === 0 && Object.keys(row).length === 20)).toBe(true);
              expect(q.has('supplier_id') || q.has('ids')).toBe(false); if (q.get('keyword')) searches.add(q.get('keyword')!);
              if (q.get('data') === '2026/09/04-2026/09/04' && !q.get('keyword') && !q.get('type')) {
                expect(value.data.count).toBe(105); pages.add(Number(q.get('page')));
                if (q.get('page') === '6') expect(value.data.list.at(-1).order_id).toBe('MANY-0');
              }
              if (q.get('keyword') === 'A%_LITERAL') expect(value.data).toMatchObject({ count: 1, list: [{ order_id: 'A%_LITERAL' }] });
              if (q.get('keyword') === 'Alice Buyer' && q.get('type') === '2') expect(value.data).toMatchObject({ count: 1, list: [{ id: 2 }] });
              if (armRead) { armRead = false; readHeld++; delay = true; }
            } else if (path.includes('/mark/')) {
              expect(value.data).toMatchObject({ version: 'supplier-flow-mark-v1', supplier_id: 7, bounded: true }); expect(Object.keys(value.data)).toHaveLength(6);
              if (armMark) { armMark = false; markHeld++; delay = true; }
            } else {
              expect(path).toBe('/supplierapi/export/financeRecord'); expect(q.get('ids')).toBe('204,203'); expect(value.data.export).toHaveLength(2);
            }
          }
        }
      } finally { release(); }
      // A reset can be replayed by transport before Axios sees a failure. Keep
      // the committed App result private and return an explicit uncertain503.
      if (drop) { send(res, JSON.stringify({ status: 503, msg: 'Owned fixture discarded committed acknowledgement', data: null }), 503, 'application/json'); return; }
      const deliver = () => { if (!res.destroyed) { res.writeHead(status, headers); res.end(body); } }; if (delay) held.push(deliver); else deliver(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    const filename = resolve(root, '.' + path), candidate = filename.startsWith(root + sep) ? filename : '';
    try { if (candidate && (await stat(candidate)).isFile()) return send(res, await readFile(candidate), 200,
      ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(candidate)] ?? 'application/octet-stream'); } catch { /* SPA path */ }
    return send(res, (await readFile(resolve(root, 'index.html'), 'utf8')).replace('</head>', observer + '</head>'));
  })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned acceptance assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Supplier flow Browser forbids outbound fetch'); });
  try {
    await f.withWriter(async runtime => {
      wiring.container = runtime.container; await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('SUPPLIER_FLOW_BROWSER_READY ' + JSON.stringify({ control: origin + control, flows: origin + '/finance/flows' }) + '\n');
      deadline = setTimeout(() => fail(Error('Supplier flow Browser finish not received')), 18 * 60_000); await completion;
      process.stdout.write('SUPPLIER_FLOW_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; while (held.length) held.shift()!();
    server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 19 * 60_000);
