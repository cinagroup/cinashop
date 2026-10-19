/** Built Orders -> real Supplier App/JWT -> independent SELECT-only PG16 LOGIN. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { storeOrder, storeOrderCartInfo, storeProductVirtual } from '@/models/schema';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { supplierOrderVirtualReviewFixture } from '../helpers/supplierOrderVirtualReview';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned review Browser LOGIN'); return wiring.container;
} }));
type Row = Record<string, any>;
it('reviews actual private card and frozen content records through a read-only Supplier production page with zero business writes', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierOrderVirtualReviewFixture(), app = createApp(), control = '/__order_virtual_review/' + randomUUID();
  const longPassword = '本机验收口令_' + '🔑'.repeat(180) + '\n  ', longContent = '<img src="https://example.invalid/do-not-fetch">\n'
    + '冻结固定交付内容'.repeat(65) + '\nhttps://example.invalid/plain-text-only\n末行内容';
  const cards = f.expectedVirtual.get(100)!; if (cards.entries[0].kind !== 'card') throw Error('Missing owned card');
  const previousPassword = cards.entries[0].card_pwd; cards.entries[0].card_pwd = longPassword;
  await f.db.update(storeProductVirtual).set({ cardPwd: longPassword }).where(eq(storeProductVirtual.id, 10001));
  const [cardOrder] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
  const cardPayload = JSON.parse(cardOrder.virtualInfo!); cardPayload[0].card_pwd = longPassword;
  expect(previousPassword).not.toBe(longPassword); await f.db.update(storeOrder).set({ virtualInfo: JSON.stringify(cardPayload) }).where(eq(storeOrder.id, 100));
  const contentReview = f.expectedVirtual.get(111)!; if (contentReview.entries[0].kind !== 'content') throw Error('Missing owned content');
  contentReview.entries[0].content = longContent;
  const [cart] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1111));
  const snapshot = JSON.parse(cart.cartInfo!); snapshot.sku.disk_info = longContent;
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, cart.id));
  await f.db.update(storeOrder).set({ virtualInfo: JSON.stringify([{ disk_info: longContent, product_id: cart.productId, sku_unique: cart.skuUnique, quantity: cart.cartNum }]) }).where(eq(storeOrder.id, 111));
  function redacted(raw: unknown) {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw as Row | null;
    if (!value) return;
    for (const attr of [value.sku, value.attrInfo, value.productInfo?.attrInfo]) if (attr) expect(Object.hasOwn(attr, 'disk_info')).toBe(false);
  }
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
      expect(url.pathname === '/api/get_script' || url.pathname === '/api/assets/31' || (url.pathname === '/supplierapi/order/list')
        || /^\/supplierapi\/order\/(info|status|split_order|split_cart_info)\/(100|111|201|202|301)$/.test(url.pathname)).toBe(true);
      const before = await f.snapshot(), sequences = await f.sequences(), headers = new Headers();
      for (const name of ['authorization', 'authori-zation']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      wiring.container = runtime; const response = await app.request(url.pathname + url.search, { headers }, f.env);
      const bytes = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
      const envelope = url.pathname === '/api/get_script' || url.pathname.startsWith('/api/assets/') ? null : JSON.parse(bytes.toString()); if (envelope) expect(envelope.status, envelope.msg).toBe(200);
      if (url.pathname.startsWith('/supplierapi/')) expect(response.headers.get('Cache-Control')).toContain('no-store');
      if (url.pathname.startsWith('/api/assets/')) expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
      const entry: Row = { method: req.method, path: url.pathname, query: url.pathname.startsWith('/api/assets/') ? { signed_image: true } : Object.fromEntries(url.searchParams), http: 200, sql_and_sequences_unchanged: true };
      if (url.pathname === '/supplierapi/order/list') { entry.ids = envelope.data.list.map((r: Row) => r.id); entry.count = envelope.data.count; }
      if (url.pathname.startsWith('/supplierapi/order/info/')) {
        const review = envelope.data.review; expect(review.version).toBe(1); const delivery = review.virtual_delivery;
        entry.delivery = { state: delivery.state, basis: delivery.basis, count: delivery.entries.length };
        expect(envelope.data).not.toHaveProperty('virtual_info'); expect(envelope.data).not.toHaveProperty('virtualInfo');
        const id = Number(url.pathname.split('/').at(-1));
        if (f.expectedVirtual.has(id)) expect(delivery).toEqual(f.expectedVirtual.get(id));
        if (id === 202) expect(delivery).toMatchObject({ order_id: 202, state: 'not_delivered', basis: null, entries: [] });
        for (const row of envelope.data.cart_info) if (row.productType === 1) redacted(row.cartInfo);
      }
      if (url.pathname.startsWith('/supplierapi/order/split_order/')) {
        entry.shipment_ids = envelope.data.map((order: Row) => order.id);
        for (const order of envelope.data) if (order.product_type === 1) for (const item of order.cart_info) redacted(item.cart_info);
      }
      if (failNext && url.pathname === '/supplierapi/order/info/100') {
        failNext = false; entry.injected_http = 503; paths.push(entry);
        return send(res, JSON.stringify({ status: 503, msg: '本机验收模拟详情读取失败', data: null }), 503, 'application/json');
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
        expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_client_width + 1);
        for (const box of [data.drawer,data.close,data.panel,...data.secret_boxes]) {
          expect(box.left).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(data.width + 1);
        }
        expect(data.close.top).toBeGreaterThanOrEqual(-1); expect(data.close.bottom).toBeLessThanOrEqual(data.height + 1);
        expect(data.panel.top).toBeLessThan(data.height); expect(data.panel.bottom).toBeGreaterThan(0); expect(data.executable_children).toBe(0);
        expect(data.panel_text).toContain('卡密与固定内容交付记录'); expect(data.panel_text).toContain(name === 'desktop' ? longPassword : longContent);
        const { panel_text, ...layout } = data;
        evidence.push({ stage: name, ...layout, panel_text_sha256: createHash('sha256').update(panel_text).digest('hex'), exact_secret_text_matches: true });
      } else if (name === 'finish') {
        for (const id of [100,111,201,301,202]) expect(paths.some(p => p.path === '/supplierapi/order/info/' + id && !p.injected_http)).toBe(true);
        const failed = paths.findIndex(p => p.injected_http === 503); expect(failed).toBeGreaterThanOrEqual(0);
        expect(paths.slice(failed + 1).some(p => p.path === '/supplierapi/order/info/100' && !p.injected_http)).toBe(true);
        expect(paths.some(p => p.path === '/api/assets/31')).toBe(true); expect(f.r2Reads.length).toBeGreaterThan(0);
        expect(f.r2Reads.every(key => key === f.images.ownedKey)).toBe(true);
        expect(evidence.map(row => row.stage)).toEqual(['desktop', 'phone']);
        expect(await f.snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(baselineSequences);
        finished = true; await writeFile('/tmp/cinashop-supplier-order-virtual-review-browser-result.json', JSON.stringify({ ...state(), table_count: Object.keys(baseline).length,
          sequence_count: baselineSequences.length, provider_calls: 0, business_writes: 0, owned_r2_reads: f.r2Reads.length }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商卡密交付记录 PG16 验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:90px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:1200px;height:844px;border:1px solid #bbb}</style>
      <h1>供应商卡密与固定内容核对</h1><button id="enter">登录并进入订单</button><button id="desktop">核对桌面详情布局</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机详情布局</button><button id="fail">下一次详情模拟503</button><button id="finish">完成验收并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier订单生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.viewer)});localStorage.setItem('supplier-user',JSON.stringify({id:22,supplier_id:7,supplier_name:'本店只读核对'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view']));frame.src='/orders';};
      async function report(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();document.getElementById('result').textContent=JSON.stringify({requests:value.paths.length,checked:value.evidence.map(x=>x.stage),finished:value.finished});}
      document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};document.getElementById('fail').onclick=()=>report('fail-next');
      const box=n=>{const b=n.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
      for(const mode of ['desktop','phone'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument,panel=doc.querySelector('.virtual-delivery-review');report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,page_client_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth,drawer:box(doc.querySelector('.el-drawer')),close:box(doc.querySelector('.el-drawer__close-btn')),panel:box(panel),secret_boxes:[...panel.querySelectorAll('dd')].map(box),executable_children:panel.querySelectorAll('img,a,script,iframe').length,panel_text:panel.textContent});};document.getElementById('finish').onclick=()=>report('finish');</script></html>`;
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
  })().catch(cause => { reject(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned review assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Order virtual review must not call external services'); });
  try {
    await f.withReader(async peer => {
      runtime = peer.container; const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS whole_table_write,has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, whole_table_write: false, creates: false });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned review Browser port');
      origin = 'http://127.0.0.1:' + address.port; process.stdout.write('SUPPLIER_ORDER_VIRTUAL_REVIEW_BROWSER_READY ' + JSON.stringify({ control: origin + control }) + '\n');
      deadline = setTimeout(() => reject(Error('Order virtual review Browser finish not received')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled(); process.stdout.write('SUPPLIER_ORDER_VIRTUAL_REVIEW_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 21 * 60_000);
