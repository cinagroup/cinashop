/** Actual production Supplier, Hono/JWT and independent SELECT-only PG16 LOGIN.
 * Interactions run in the connected Codex Browser; only the carrier is controlled. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { supplierOrderTrackingFixture } from '../helpers/supplierOrderTracking';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned tracking Browser LOGIN'); return wiring.container;
} }));
type Row = Record<string, any>;
it('reads a single order and each selected split shipment with genuine carrier/cache states and no SQL or sequence writes', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierOrderTrackingFixture(), app = createApp(), control = '/__tracking/' + randomUUID();
  await f.provider(true);
  const baseline = await f.snapshot(), sequences = await f.sequences(), paths: Row[] = [], evidence: Row[] = [], provider: string[] = [];
  let origin = '', finished = false, chain = Promise.resolve(), reader: Container;
  let complete!: () => void, reject!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { complete = yes; reject = no; });
  const state = () => ({ paths, evidence, provider, cache_writes: f.cacheWrites.length,
    tracking_cache_writes: f.cacheWrites.filter(row => row.key.startsWith('tracking_v1_')).length,
    config_cache_writes: f.cacheWrites.filter(row => row.key === 'cfg_system_statistics').length, finished });
  async function serial<T>(work: () => Promise<T>) { const before = chain; let release!: () => void; chain = new Promise<void>(yes => { release = yes; }); await before; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, data: string | Buffer, status = 200, type = 'text/html; charset=utf-8') { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(data); } }
  async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; expect(size).toBeLessThan(65536); chunks.push(bytes); } return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Row; }
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      expect(req.method).toBe('GET'); expect(url.pathname === '/api/get_script' || url.pathname === '/supplierapi/order/list'
        || /^\/supplierapi\/order\/(info|status|split_order|express)\/(100|201|202|301)$/.test(url.pathname)).toBe(true);
      const before = await f.snapshot(), seq = await f.sequences(); wiring.container = reader;
      const headers = new Headers(); for (const name of ['authorization', 'authori-zation']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      const response = await app.request(url.pathname + url.search, { method: 'GET', headers }, f.env);
      const bytes = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
      const entry: Row = { path: url.pathname, method: req.method, http: response.status, sql_read_only: true };
      if (url.pathname !== '/api/get_script') {
        expect(response.headers.get('Cache-Control')).toContain('private, no-store'); const envelope = JSON.parse(bytes.toString()); expect(envelope.status, envelope.msg).toBe(200);
        if (url.pathname.includes('/express/')) { expect(envelope.data.packages).toHaveLength(1); entry.order = envelope.data.orderId; entry.source = envelope.data.trackingSource; entry.number = envelope.data.expressNo; }
      }
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); paths.push(entry);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    });
  }
  async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      const name = url.pathname.slice(control.length + 1);
      if (name === 'desktop' || name === 'phone') {
        const data = await body(req); expect(data.width).toBe(name === 'phone' ? 390 : 1200); expect(data.height).toBe(844);
        expect(data.dialog.left).toBeGreaterThanOrEqual(0); expect(data.dialog.right).toBeLessThanOrEqual(data.width);
        expect(data.dialog.top).toBeGreaterThanOrEqual(0); expect(data.dialog.bottom).toBeLessThanOrEqual(844);
        expect(data.footer_visible).toBe(true); expect(data.unobscured).toBe(true); expect(data.content).toContain('本机承运商节点'); evidence.push({ stage: name, ...data });
      } else if (name === 'finish') {
        const tracking = paths.filter(row => row.source); expect(tracking.map(row => row.number)).toEqual(['OWN-100', 'OWN-100', 'CHILD-201', 'CHILD-202']);
        expect(tracking.map(row => row.source)).toEqual(['carrier', 'cache', 'carrier', 'carrier']);
        expect(provider).toEqual(['OWN-100', 'CHILD-201', 'CHILD-202']); expect(state().tracking_cache_writes).toBe(3);
        expect(state().config_cache_writes).toBe(1); expect(f.cacheWrites).toHaveLength(4);
        expect(evidence.map(row => row.stage)).toEqual(['desktop', 'phone']); expect(await f.snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(sequences);
        finished = true; await writeFile('/tmp/cinashop-supplier-order-tracking-browser-result.json', JSON.stringify({ ...state(), table_count: Object.keys(baseline).length, sequence_count: sequences.length, sql_rows_and_sequences_unchanged: true, kv_cache_writes_are_expected: true }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商物流真实 PG16 验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:90px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}iframe{display:block;width:1200px;height:844px;border:1px solid #bbb}</style>
      <h1>供应商单单与拆单物流查询</h1><button id="enter">登录并进入订单</button><button id="desktop">核对桌面物流弹窗</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机物流弹窗</button><button id="finish">完成验收并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier订单生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.viewer)});localStorage.setItem('supplier-user',JSON.stringify({id:22,supplier_id:7,supplier_name:'本店物流'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view']));frame.src='/orders';};
      async function report(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=await r.text();}
      document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};
      for(const mode of ['desktop','phone'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument,dialog=doc.querySelector('.supplier-tracking-dialog'),r=dialog.getBoundingClientRect(),footer=dialog.querySelector('.el-dialog__footer').getBoundingClientRect(),buttons=[...dialog.querySelectorAll('.el-dialog__footer button')];report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,dialog:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},footer_visible:footer.bottom<=844,unobscured:buttons.every(n=>{const b=n.getBoundingClientRect(),top=doc.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return top===n||n.contains(top);}),content:dialog.innerText});};document.getElementById('finish').onclick=()=>report('finish');</script></html>`;
  }
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname;
    if (path === control && req.method === 'GET') return send(res, shell());
    if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
    if (path.startsWith('/supplierapi/') || path.startsWith('/api/')) return api(req, res, url);
    if (path === '/favicon.ico') return send(res, '', 204);
    const target = resolve(root, '.' + path);
    try { if (target.startsWith(root + sep) && (await stat(target)).isFile()) return send(res, await readFile(target), 200, ({ '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[extname(target)] ?? 'application/octet-stream'); } catch { /* production SPA */ }
    send(res, await readFile(resolve(root, 'index.html')));
  })().catch(cause => { reject(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned tracking assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input)); expect(url.origin + url.pathname).toBe('https://wuliu.market.alicloudapi.com/kdi');
    expect(new Headers(init?.headers).get('Authorization')).toBe('APPCODE OWNED-PROVIDER-KEY'); const number = url.searchParams.get('no')!;
    expect(['OWN-100', 'CHILD-201', 'CHILD-202']).toContain(number); provider.push(number);
    return Response.json({ status: 0, result: { deliverystatus: 1, list: [{ time: '2026-10-19 00:00:00', status: '本机承运商节点：' + number }] } });
  });
  try {
    await f.withReader(async runtime => {
      reader = runtime.container; const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
        has_table_privilege(current_user,'store_order','UPDATE') AS writes,has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, writes: false, creates: false });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned Browser port');
      origin = 'http://127.0.0.1:' + address.port; process.stdout.write('SUPPLIER_ORDER_TRACKING_BROWSER_READY ' + JSON.stringify({ control: origin + control }) + '\n');
      deadline = setTimeout(() => reject(Error('Tracking Browser finish not received')), 20 * 60_000);
      await completion; process.stdout.write('SUPPLIER_ORDER_TRACKING_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 21 * 60_000);
