/** Built Orders -> real Supplier App/JWT -> independent SELECT-only PG16 LOGIN. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { supplierOrderFiltersFixture } from '../helpers/supplierOrderFilters';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned filter Browser LOGIN'); return wiring.container;
} }));
type Row = Record<string, any>;
it('filters real order facts, discovers coherent owned packages and recovers failed reads at desktop and phone widths without writes', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierOrderFiltersFixture(), app = createApp(), control = '/__order_filters/' + randomUUID();
  const baseline = await f.snapshot(), baselineSequences = await f.sequences(), paths: Row[] = [], evidence: Row[] = [];
  let origin = '', finished = false, failNext = false, chain = Promise.resolve(), runtime: Container;
  let complete!: () => void, reject!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { complete = yes; reject = no; });
  const state = () => ({ paths, evidence, finished });
  async function serial<T>(work: () => Promise<T>) { const before = chain; let release!: () => void; chain = new Promise<void>(yes => { release = yes; }); await before; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, data: string | Buffer, status = 200, type = 'text/html; charset=utf-8') { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(data); } }
  async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; expect(size).toBeLessThan(65536); chunks.push(bytes); } return Buffer.concat(chunks).toString(); }
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      expect(req.method).toBe('GET');
      expect(url.pathname === '/api/get_script' || url.pathname === '/supplierapi/order/list'
        || /^\/supplierapi\/order\/(info|status|split_order)\/(100|110|117|123|201|202|301)$/.test(url.pathname)).toBe(true);
      const before = await f.snapshot(), sequences = await f.sequences(), headers = new Headers();
      for (const name of ['authorization', 'authori-zation']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      wiring.container = runtime; const response = await app.request(url.pathname + url.search, { headers }, f.env);
      const bytes = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
      const envelope = url.pathname === '/api/get_script' ? null : JSON.parse(bytes.toString()); if (envelope) expect(envelope.status, envelope.msg).toBe(200);
      if (url.pathname !== '/api/get_script') expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
      const entry: Row = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), http: 200, sql_and_sequences_unchanged: true };
      if (url.pathname === '/supplierapi/order/list') { entry.ids = envelope.data.list.map((r: Row) => r.id); entry.count = envelope.data.count; }
      if (failNext && url.pathname === '/supplierapi/order/list') {
        failNext = false; entry.injected_http = 503; paths.push(entry);
        return send(res, JSON.stringify({ status: 503, msg: '本机验收模拟列表读取失败，请重新查询', data: null }), 503, 'application/json');
      }
      paths.push(entry); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    });
  }
  async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      const name = url.pathname.slice(control.length + 1);
      if (name === 'fail-next') failNext = true;
      else if (name === 'desktop' || name === 'phone') {
        const data = JSON.parse(await body(req)); expect(data.width).toBe(name === 'phone' ? 390 : 1200); expect(data.height).toBe(844);
        expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_client_width + 1); expect(data.controls.length).toBeGreaterThanOrEqual(8);
        for (const input of data.controls) { expect(input.left).toBeGreaterThanOrEqual(-1); expect(input.right).toBeLessThanOrEqual(data.width + 1); }
        expect(data.content).toContain('搜索字段'); expect(data.content).toContain('重置'); evidence.push({ stage: name, ...data });
      } else if (name === 'finish') {
        const lists = paths.filter(p => p.path === '/supplierapi/order/list' && !p.injected_http);
        const has = (query: Row, ids?: number[], count?: number) => {
          const matches = lists.filter(p => Object.entries(query).every(([key, value]) => p.query[key] === value));
          expect(matches.length, JSON.stringify(query)).toBeGreaterThan(0);
          if (ids) expect(matches.some(p => JSON.stringify(p.ids) === JSON.stringify(ids)), JSON.stringify(query)).toBe(true);
          if (count !== undefined) expect(matches.some(p => p.count === count)).toBe(true);
        };
        has({ field_key: 'order_id', order: f.expected.rootNumber }, [202, 201], 2);
        has({ field_key: 'order_id', order: f.expected.platformNumber }, [301], 1);
        has({ field_key: 'order_id', order: 'tracking-own-900' }, [], 0);
        has({ field_key: 'title', order: f.expected.currentTitle }, [110, 100], 2);
        has({ field_key: 'all', order: '当前秒杀活动' }, [111], 1);
        has({ field_key: 'all', order: f.expected.userNickname }, undefined, f.visibleIds.length);
        has({ field_key: 'uid', order: '11' }, undefined, f.visibleIds.length);
        has({ field_key: 'total_num', order: '8' }, [117], 1);
        has({ field_key: 'real_name', order: '筛选客户7' }, [117], 1);
        has({ business_status: '-4' }, [123], 1);
        has({ order: 'NO-MATCH-BROWSER' }, [], 0);
        has({ page: '2', order: '', business_status: '', type: '', pay_type: '' }, f.visibleIds.slice(20), f.visibleIds.length);
        const combo = lists.find(p => p.query.type === '7' && p.query.business_status === '1' && p.query.pay_type === 'offline'
          && p.query.start_time === '1700000700' && p.query.end_time === '1700000700');
        expect(combo).toBeTruthy(); expect(combo!.ids).toEqual([117]); expect(combo!.count).toBe(1);
        const failed = paths.findIndex(p => p.injected_http === 503); expect(failed).toBeGreaterThanOrEqual(0);
        expect(paths.slice(failed + 1).some(p => p.path === '/supplierapi/order/list' && !p.injected_http)).toBe(true);
        expect(evidence.map(row => row.stage)).toEqual(['desktop', 'phone']);
        expect(await f.snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(baselineSequences);
        finished = true; await writeFile('/tmp/cinashop-supplier-order-filters-browser-result.json', JSON.stringify({ ...state(), table_count: Object.keys(baseline).length,
          sequence_count: baselineSequences.length, provider_calls: 0, business_writes: 0 }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商订单筛选真实 PG16 验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:90px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:1200px;height:844px;border:1px solid #bbb}</style>
      <h1>供应商订单完整筛选</h1><button id="enter">登录并进入订单</button><button id="desktop">核对桌面筛选布局</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机筛选布局</button><button id="fail">下一次查询模拟503</button><button id="finish">完成验收并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier订单生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.viewer)});localStorage.setItem('supplier-user',JSON.stringify({id:22,supplier_id:7,supplier_name:'本店筛选'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view']));frame.src='/orders';};
      async function report(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();document.getElementById('result').textContent=JSON.stringify({requests:value.paths.length,checked:value.evidence.map(x=>x.stage),finished:value.finished});}
      document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};document.getElementById('fail').onclick=()=>report('fail-next');
      for(const mode of ['desktop','phone'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument;report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,page_client_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth,controls:[...doc.querySelectorAll('.order-filter-control')].map(n=>{const b=n.getBoundingClientRect();return{label:n.innerText,left:b.left,right:b.right};}),content:doc.querySelector('.order-filter-row').innerText});};document.getElementById('finish').onclick=()=>report('finish');</script></html>`;
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
  })().catch(cause => { reject(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned filter assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Order filtering must not call external services'); });
  try {
    await f.withReader(async peer => {
      runtime = peer.container; const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS whole_table_write,has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, whole_table_write: false, creates: false });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned filter Browser port');
      origin = 'http://127.0.0.1:' + address.port; process.stdout.write('SUPPLIER_ORDER_FILTERS_BROWSER_READY ' + JSON.stringify({ control: origin + control }) + '\n');
      deadline = setTimeout(() => reject(Error('Order filter Browser finish not received')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled(); process.stdout.write('SUPPLIER_ORDER_FILTERS_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 21 * 60_000);
