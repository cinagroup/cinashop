/** Real production Vue, actual App/JWT, independent SELECT-only PG16 LOGIN,
 * installed IAB and native CSV downloads. All ledger inputs are synthetic. */
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
import { supplierBillExportFixture } from '../helpers/supplierBillExport';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned Supplier bill export SELECT-only LOGIN'); return wiring.container;
} }));
it('downloads complete scoped period CSV through IAB and suppresses held exports after filter/session changes', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist');
  expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierBillExportFixture(), control = '/__supplier_bill_export_fixture/' + randomUUID();
  const env = { ...f.env, NODE_ENV: 'test', CONFIG_KV: { get: async () => null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const app = createApp(), paths: any[] = [], downloads: any[] = [], manifests: any[] = [];
  const held: Array<() => void> = []; let arm = false, heldCount = 0, released = 0, outbound = 0, finished = false, origin = '', viewerLogins = 0;
  let withdrawn = false, denied = false, restored = false, readonlyGets = 0, scriptSeen = false;
  let chain = Promise.resolve(), deadline: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const baseline = await f.snapshot();
  const state = () => ({ finished, readonlyGets, outbound, heldCount, released, viewerLogins, withdrawn, denied, restored, scriptSeen, downloads, manifests, paths });
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  // Instrument native download APIs while retaining their original behavior.
  // The test observer sends only a local synthetic CSV back to this owned host.
  const observer = `<script>(()=>{const control=${JSON.stringify(control)},create=URL.createObjectURL.bind(URL),click=HTMLAnchorElement.prototype.click,blobs=new Map();
    URL.createObjectURL=b=>{const u=create(b);blobs.set(u,b);return u;};
    HTMLAnchorElement.prototype.click=function(){const b=blobs.get(this.href),filename=this.download;click.call(this);if(b)b.text().then(csv=>fetch(control+'/download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename,csv})}));};})();</script>`;
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商账期下载 PG16 验收</title><h1>供应商完整账期下载验收</h1>
      <p>本机合成流水；真实页面和原生CSV下载，数据库业务账号仅SELECT。日账单2026-09-04应下载105条；可核对周/月和已结算日期。</p>
      <button id="login">管理账号进入账单</button><button id="hold">扣留下一导出回复</button><button id="release">释放导出回复</button>
      <button id="viewer">切换只读会话</button><button id="manager">切回管理会话</button>
      <button id="withdraw">撤销夹具导出权限</button><button id="restore">恢复夹具导出权限</button>
      <button id="status">读取验收状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>
      const control=${JSON.stringify(control)},tokens=${JSON.stringify(f.tokens)};
      function session(viewer){localStorage.setItem('supplier-token',viewer?tokens.denied:tokens.reader);localStorage.setItem('supplier-user',JSON.stringify({id:viewer?22:21,supplier_id:7,supplier_name:'本机下载供应商'}));localStorage.setItem('supplier-permissions',JSON.stringify(viewer?['supplier.finance.view']:['supplier.finance.view','supplier.finance.manage']));}
      document.getElementById('login').onclick=()=>{session(false);location.href='/finance/bills';};
      for(const name of ['hold','release','viewer','manager','withdraw','restore','status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(control+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();if(r.ok&&(name==='viewer'||name==='manager'))session(name==='viewer');};</script></html>`);
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin); await chain;
      if (path.endsWith('/download')) {
        let body = ''; for await (const chunk of req) { body += chunk.toString(); expect(body.length).toBeLessThan(2 * 1024 * 1024); }
        const value = JSON.parse(body), filename = value.filename as string, csv = value.csv as string;
        const manifest = manifests.find(row => filename === row.filename + '.csv'); expect(manifest).toBeDefined();
        const lines = csv.split('\r\n'); expect(lines).toHaveLength(manifest.count + 1);
        expect(lines[0]).toBe('"交易单号","关联订单","交易时间","交易金额","支出收入","交易人","交易类型","支付方式"');
        if (manifest.period === '2026-09-04') { expect(manifest.count).toBe(105); expect(lines[1]).toContain('MANY-104'); expect(lines.at(-1)).toContain('MANY-0'); }
        downloads.push({ filename, lines: lines.length, bytes: Buffer.byteLength(csv), sha256: createHash('sha256').update(csv).digest('hex'), first: lines[1], last: lines.at(-1) });
      }
      if (path.endsWith('/hold')) { expect(arm).toBe(false); arm = true; }
      if (path.endsWith('/release')) { expect(held.length).toBeGreaterThan(0); while (held.length) { held.shift()!(); released++; } }
      if (path.endsWith('/viewer')) viewerLogins++;
      if (path.endsWith('/withdraw')) { await f.db.update(systemRole).set({ rules: 'supplier.finance.view' }).where(eq(systemRole.id, 21)); withdrawn = true; }
      if (path.endsWith('/restore')) { expect(denied).toBe(true); await f.db.update(systemRole).set({ rules: 'supplier.finance.view,supplier.finance.manage' }).where(eq(systemRole.id, 21)); withdrawn = false; restored = true; }
      if (path.endsWith('/finish')) {
        expect(heldCount).toBe(2); expect(released).toBe(heldCount); expect(held).toHaveLength(0); expect(arm || withdrawn).toBe(false);
        expect(denied && restored && scriptSeen).toBe(true); expect(viewerLogins).toBeGreaterThanOrEqual(1);
        expect(downloads).toHaveLength(4); expect(new Set(downloads.map(row => row.filename)).size).toBe(4);
        for (const type of ['day', 'week', 'month']) expect(manifests.some(row => row.timeType === type)).toBe(true);
        expect(manifests.some(row => row.status === '1' && row.period === '2026-09-02' && row.count === 1 && row.entry_num === '-3.00')).toBe(true);
        expect(outbound).toBe(0); expect(paths.every(row => row.method === 'GET')).toBe(true); expect(await f.snapshot()).toEqual(baseline);
        finished = true; await writeFile('/tmp/cinashop-supplier-bill-export-browser-result.json', JSON.stringify(state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      expect(method).toBe('GET'); let release!: () => void; const previous = chain; chain = new Promise(done => { release = done; }); await previous;
      let body = '', status = 200, headers: Record<string, string> = {}, delay = false;
      try {
        const before = await f.snapshot(), response = await app.request(path + url.search, { method, headers: { ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) } }, env);
        body = await response.text(); status = response.status; headers = Object.fromEntries(response.headers); expect(await f.snapshot()).toEqual(before); readonlyGets++;
        if (path === '/api/get_script') { expect(status).toBe(200); scriptSeen = true; }
        else {
          expect(headers['cache-control']).toContain('private, no-store'); const value = JSON.parse(body);
          paths.push({ path, query: Object.fromEntries(url.searchParams), method, status, envelope: value.status });
          if (withdrawn && path.endsWith('/financeRecord')) { expect(value.status).toBe(400011); denied = true; }
          else {
            expect(value.status).toBe(200); expect(value.data.supplier_id).toBe(7);
            if (path.endsWith('/financeRecord')) {
              expect(Object.keys(Object.fromEntries(url.searchParams)).sort()).toEqual(['data', 'period', 'selection', 'status', 'timeType']);
              expect(value.data).toMatchObject({ version: 'supplier-bill-export-v1', complete: true, bounded: true });
              expect(value.data.export.length).toBe(value.data.count);
              manifests.push({ filename: value.data.filename, timeType: value.data.timeType, status: value.data.status, period: value.data.period, count: value.data.count, entry_num: value.data.entry_num });
              if (arm) { arm = false; heldCount++; delay = true; }
            }
          }
        }
      } finally { release(); }
      const deliver = () => { if (!res.destroyed) { res.writeHead(status, headers); res.end(body); } }; if (delay) held.push(deliver); else deliver(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    const filename = resolve(root, '.' + path), candidate = filename.startsWith(root + sep) ? filename : '';
    try { if (candidate && (await stat(candidate)).isFile()) return send(res, await readFile(candidate), 200,
      ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(candidate)] ?? 'application/octet-stream'); } catch { /* SPA path */ }
    return send(res, (await readFile(resolve(root, 'index.html'), 'utf8')).replace('</head>', observer + '</head>'));
  })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned acceptance assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('Supplier bill export forbids outbound fetch'); });
  try {
    await f.withReader(async runtime => {
      wiring.container = runtime.container; await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('SUPPLIER_BILL_EXPORT_BROWSER_READY ' + JSON.stringify({ control: origin + control, bills: origin + '/finance/bills' }) + '\n');
      deadline = setTimeout(() => fail(Error('Supplier bill export Browser finish not received')), 18 * 60_000); await completion;
      process.stdout.write('SUPPLIER_BILL_EXPORT_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    while (held.length) held.shift()!(); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 19 * 60_000);
