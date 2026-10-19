/** Production Refunds -> actual Supplier App/JWT -> independent SELECT-only PG16. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { storeOrderCartInfo, storeOrderRefund } from '@/models/schema';
import type { Container } from '@/lib/di';
import { supplierRefundApplicationReviewFixture } from '../helpers/supplierRefundApplicationReview';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned refund review LOGIN'); return wiring.container;
} }));
type Row = Record<string, any>;
it('reviews pending selected goods, PHP snapshots and completed history through the real Supplier production page with zero business writes', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierRefundApplicationReviewFixture(), app = createApp(), control = '/__refund_application_review/' + randomUUID();
  // Owned maintenance-only presentation variants, before the zero-write baseline.
  const [modern] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1001));
  const modernSnapshot = JSON.parse(modern.cartInfo!);
  modernSnapshot.product.storeName = '<img src="https://example.invalid/no-fetch"> 申请商品';
  modernSnapshot.sku.suk = '历史规格'.repeat(40); modernSnapshot.sku.code = 'LONG-CODE-' + 'X'.repeat(140);
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(modernSnapshot) }).where(eq(storeOrderCartInfo.id, modern.id));
  const [legacy] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, 201));
  const legacySnapshot = JSON.parse(legacy.cartInfo!);
  legacySnapshot[0].productInfo.store_name = '<script>不会执行</script> 旧PHP申请商品';
  legacySnapshot[0].productInfo.attrInfo.suk = '旧规格与长文本'.repeat(25);
  await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify(legacySnapshot) }).where(eq(storeOrderRefund.id, legacy.id));
  const baseline = await f.snapshot(), baselineSequences = await f.sequences(), paths: Row[] = [], evidence: Row[] = [], details = new Map<string, Row>();
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
      expect(['/api/get_script', '/supplierapi/refund/list', '/supplierapi/refund/reason'].includes(url.pathname)
        || /^\/supplierapi\/refund\/detail\/(100|201|202|301)$/.test(url.pathname)).toBe(true);
      const before = await f.snapshot(), sequences = await f.sequences(), headers = new Headers();
      for (const name of ['authorization', 'authori-zation']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      wiring.container = runtime; const response = await app.request(url.pathname + url.search, { headers }, f.env);
      const bytes = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
      const envelope = url.pathname === '/api/get_script' ? null : JSON.parse(bytes.toString()); if (envelope) expect(envelope.status, envelope.msg).toBe(200);
      if (url.pathname.startsWith('/supplierapi/')) expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
      const entry: Row = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), http: 200, sql_and_sequences_unchanged: true };
      if (url.pathname === '/supplierapi/refund/list') { entry.ids = envelope.data.list.map((r: Row) => r.id); entry.count = envelope.data.count; }
      if (url.pathname.startsWith('/supplierapi/refund/detail/')) {
        const detail = envelope.data, review = detail.application_review; expect(review.version).toBe(1);
        expect(detail.cartInfo).toBeNull(); expect(detail.orderInfo).toBeNull();
        entry.refund_id = detail.id; entry.review = { state: review.state, basis: review.basis, quantities: review.items.map((r: Row) => r.quantity) };
        expect(review.refund_id).toBe(detail.id); expect(review.source_order_id).toBe(detail.store_order_id);
        if (detail.id === 100) expect(review).toMatchObject({ state: 'recorded', basis: 'quantity_claim', items: [{ quantity: 1 }] });
        if (detail.id === 201) expect(review).toMatchObject({ state: 'recorded', basis: 'php_legacy_snapshot' });
        if (detail.id === 202) expect(review).toMatchObject({ state: 'unavailable', basis: null, items: [] });
        if (detail.id === 301) { expect(review).toMatchObject({ state: 'archived', basis: null, items: [] }); expect(detail.refundHistory.itemsError).toBe(''); }
        details.set(detail.refund_order_id, detail);
      }
      if (failNext && url.pathname === '/supplierapi/refund/detail/100') {
        failNext = false; entry.injected_http = 503; paths.push(entry);
        return send(res, JSON.stringify({ status: 503, msg: '本机验收模拟申请详情读取失败', data: null }), 503, 'application/json');
      }
      paths.push(entry); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    });
  }
  async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      const name = url.pathname.slice(control.length + 1);
      if (name === 'fail-next') failNext = true;
      else if (['modern', 'legacy', 'unavailable', 'completed', 'desktop', 'phone', 'error'].includes(name)) {
        const data = JSON.parse(await body(req));
        if (name === 'error') { expect(data.panel_count).toBe(0); expect(data.refund_order_id).toBe(''); expect(data.body_text).toContain('503'); expect(data.body_text).not.toContain('关联订单记录'); }
        else {
          const detail = details.get(data.refund_order_id); expect(detail).toBeTruthy();
          expect(data.panel_text).toContain('申请商品核对'); expect(data.executable_children).toBe(0); expect(data.write_buttons_enabled).toBe(0);
          for (const item of detail!.application_review.items) for (const key of ['product_name', 'sku', 'code']) if (item[key]) expect(data.panel_text).toContain(item[key]);
          if (name === 'modern' || name === 'desktop') expect(detail!.id).toBe(100);
          if (name === 'legacy' || name === 'phone') expect(detail!.id).toBe(201);
          if (name === 'unavailable') { expect(detail!.id).toBe(202); expect(data.body_text).toContain(detail!.application_review.error); expect(data.panel_text).not.toContain('申请冻结旧商品'); }
          if (name === 'completed') { expect(detail!.id).toBe(301); expect(data.history_text).toContain(detail!.refundHistory.items[0].name); }
          if (name === 'desktop' || name === 'phone') {
            expect(data.width).toBe(name === 'phone' ? 390 : 1200); expect(data.height).toBe(844);
            expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_client_width + 1);
            for (const box of [data.drawer, data.close, data.panel, ...data.item_boxes]) { expect(box.left).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(data.width + 1); }
            expect(data.close.top).toBeGreaterThanOrEqual(-1); expect(data.close.bottom).toBeLessThanOrEqual(data.height + 1);
            expect(data.panel.top).toBeLessThan(data.height); expect(data.panel.bottom).toBeGreaterThan(0);
          }
        }
        const { panel_text, history_text, body_text, ...layout } = data;
        evidence.push({ stage: name, ...layout, rendered_text_sha256: createHash('sha256').update([panel_text, history_text, body_text].join('\n')).digest('hex') });
      } else if (name === 'finish') {
        for (const id of [100,201,202,301]) expect(paths.some(p => p.path === '/supplierapi/refund/detail/' + id && !p.injected_http)).toBe(true);
        const failed = paths.findIndex(p => p.injected_http === 503); expect(failed).toBeGreaterThanOrEqual(0);
        expect(paths.slice(failed + 1).some(p => p.path === '/supplierapi/refund/detail/100' && !p.injected_http)).toBe(true);
        for (const stage of ['modern', 'legacy', 'unavailable', 'completed', 'desktop', 'phone', 'error']) expect(evidence.some(row => row.stage === stage)).toBe(true);
        expect(await f.snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(baselineSequences);
        finished = true; await writeFile('/tmp/cinashop-supplier-refund-application-review-browser-result.json', JSON.stringify({ ...state(), table_count: Object.keys(baseline).length,
          sequence_count: baselineSequences.length, provider_calls: 0, business_writes: 0 }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商退款申请核对 PG16 验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:60px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:1200px;height:844px;border:1px solid #bbb}</style>
      <h1>供应商退款申请商品核对</h1><button id="enter">登录并进入售后</button><button id="modern">核对现代申请</button><button id="legacy">核对旧PHP申请</button><button id="completed">核对完成归档</button><button id="unavailable">核对失联申请</button><button id="desktop">核对桌面布局</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机布局</button><button id="fail">下一次详情模拟503</button><button id="error">核对错误清空</button><button id="finish">完成验收并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier售后生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.viewer)});localStorage.setItem('supplier-user',JSON.stringify({id:22,supplier_id:7,supplier_name:'本店售后只读核对'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.refund.view']));frame.src='/refunds';};
      async function report(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();document.getElementById('result').textContent=JSON.stringify({requests:value.paths.length,checked:value.evidence.map(x=>x.stage),finished:value.finished});}
      document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};document.getElementById('fail').onclick=()=>report('fail-next');
      const box=n=>{const b=n.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
      for(const mode of ['modern','legacy','unavailable','completed','desktop','phone','error'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument,panel=doc.querySelector('.refund-application-review');report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,page_client_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth,refund_order_id:doc.querySelector('.detail-order-id')?.textContent.trim()??'',panel_count:doc.querySelectorAll('.refund-application-review').length,panel_text:panel?.textContent??'',history_text:doc.querySelector('.refund-history')?.textContent??'',body_text:['error','unavailable'].includes(mode)?doc.querySelector('.el-drawer')?.textContent??'':'',drawer:panel?box(doc.querySelector('.el-drawer')):null,close:panel?box(doc.querySelector('.el-drawer__close-btn')):null,panel:panel?box(panel):null,item_boxes:panel?[...panel.querySelectorAll('li,dd')].map(box):[],executable_children:panel?.querySelectorAll('img,a,script,iframe').length??0,write_buttons_enabled:[...doc.querySelectorAll('.drawer-actions button')].filter(b=>!b.disabled).length});};document.getElementById('finish').onclick=()=>report('finish');</script></html>`;
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
  })().catch(cause => { reject(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned refund review assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Refund application review must not call external services'); });
  try {
    await f.withReader(async peer => {
      runtime = peer.container; const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS whole_table_write,has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, whole_table_write: false, creates: false });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned refund review Browser port');
      origin = 'http://127.0.0.1:' + address.port; process.stdout.write('SUPPLIER_REFUND_APPLICATION_REVIEW_BROWSER_READY ' + JSON.stringify({ control: origin + control }) + '\n');
      deadline = setTimeout(() => reject(Error('Refund application review Browser finish not received')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled(); process.stdout.write('SUPPLIER_REFUND_APPLICATION_REVIEW_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 21 * 60_000);
