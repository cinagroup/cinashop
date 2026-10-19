/** Built Orders -> real Supplier App/JWT -> independent SELECT-only PG16 LOGIN. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { storeOrderCartInfo } from '@/models/schema';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { supplierOrderGiftIdentityFixture } from '../helpers/supplierOrderGiftIdentity';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned review Browser LOGIN'); return wiring.container;
} }));
type Row = Record<string, any>;
it('identifies protected purchase and gift rows in ordinary details, historical shipments and canceled partial selectors with zero business writes', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierOrderGiftIdentityFixture(), app = createApp(), control = '/__order_gift_identity/' + randomUUID();
  // Synthetic long display text and contrary JSON are installed before the read baseline.
  const longGiftName = '冻结赠品礼盒 ' + '礼盒说明'.repeat(14), longGiftSku = '赠品规格 ' + 'LONG-SKU-'.repeat(6);
  for (const id of [f.giftIds.gift, f.giftIds.firstGift, f.giftIds.pendingGift]) {
    const [cart] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, id));
    const snapshot = JSON.parse(cart.cartInfo!); snapshot.product.storeName = longGiftName; snapshot.sku.suk = longGiftSku; snapshot.is_gift = 0;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, id));
  }
  const [purchase] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, f.giftIds.purchased));
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ ...JSON.parse(purchase.cartInfo!), is_gift: 1 }) }).where(eq(storeOrderCartInfo.id, purchase.id));
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
      expect(url.pathname === '/api/get_script' || url.pathname === '/api/assets/31' || (url.pathname === '/supplierapi/order/list' || url.pathname === '/supplierapi/order/express_list')
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
      if (url.pathname === '/supplierapi/order/express_list') { expect(Array.isArray(envelope.data)).toBe(true); entry.company_ids = envelope.data.map((r: Row) => r.id); expect(entry.company_ids).toEqual([11,12]); expect(envelope.data.every((r: Row) => Number.isInteger(r.id) && r.id > 0 && typeof r.name === 'string' && typeof r.code === 'string')).toBe(true); }
      if (url.pathname.startsWith('/supplierapi/order/info/')) {
        const r = envelope.data.review; expect(r.version).toBe(1);
        entry.items = r.items.map((item: Row) => ({ id: item.id, is_gift: item.is_gift, quantity: item.quantity,
          product_name: item.product_name, sku: item.sku, settlement_unit: item.settlement_unit }));
        expect(r.items.every((item: Row) => item.is_gift === 0 || item.is_gift === 1)).toBe(true);
        if (url.pathname.endsWith('/100')) {
          expect(r.items.map((item: Row) => ({ id: item.id, is_gift: item.is_gift, quantity: item.quantity }))).toEqual(f.expectedGiftItems);
          expect(r.items[1]).toMatchObject({ product_name: longGiftName, sku: longGiftSku, settlement_unit: '0.00' });
          expect(r.amounts.pay_price).toBe('57.00'); expect(r.promotions.total).toBe('6.00');
          expect(r.invoice).toEqual({ state: 'recorded', reason: '', record: f.expectedInvoice });
          expect(r.settlement).toEqual({ items_total: '5.00', postage: '3.00', total: '8.00', availability: 'recorded' });
        }
        if (url.pathname.endsWith('/201')) { expect(r.original_order_id).toBe('tracking-own-200'); expect(r.items.map((item: Row) => item.is_gift)).toEqual([0,1]); }
        if (url.pathname.endsWith('/301')) { expect(r.original_order_id).toBe('tracking-own-300'); expect(r.items.map((item: Row) => item.is_gift)).toEqual([0,1]); expect(r.items[1].product_name).toBe('旧赠品礼盒'); }
        if (url.pathname.endsWith('/111')) { expect(r.items).toHaveLength(1); expect(r.items[0]).toMatchObject({ is_gift: 0, settlement_unit: '0.00', product_name: '现代零结算商品' }); }
      }
      if (url.pathname.startsWith('/supplierapi/order/split_order/')) {
        entry.shipments = envelope.data.map((order: Row) => ({ id: order.id, items: order.cart_info.map((item: Row) => ({ id: item.id, is_gift: item.is_gift, quantity: item.cart_num })) }));
        if (url.pathname.endsWith('/201')) { expect(entry.shipments.map((row: Row) => row.id)).toEqual([201,202]); expect(entry.shipments.every((row: Row) => row.items.map((item: Row) => item.is_gift).join(',') === '0,1')).toBe(true); }
      }
      if (url.pathname.startsWith('/supplierapi/order/split_cart_info/')) {
        entry.pending = envelope.data.map((item: Row) => ({ id: item.id, cart_id: item.cart_id, is_gift: item.is_gift, quantity: item.cart_num, available: item.surplus_num }));
        expect(entry.pending.map((item: Row) => item.is_gift)).toEqual([0,1]);
        if (url.pathname.endsWith('/100')) expect(entry.pending.map((item: Row) => item.id)).toEqual([f.giftIds.purchased,f.giftIds.gift]);
        if (url.pathname.endsWith('/202')) expect(entry.pending.map((item: Row) => item.id)).toEqual([2003,f.giftIds.pendingGift]);
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
        for (const box of [data.drawer,data.close,data.review,data.dialog,data.footer,...data.kind_boxes]) {
          expect(box.left).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(data.width + 1);
        }
        expect(data.close.top).toBeGreaterThanOrEqual(-1); expect(data.close.bottom).toBeLessThanOrEqual(data.height + 1);
        expect(data.footer.top).toBeGreaterThanOrEqual(-1); expect(data.footer.bottom).toBeLessThanOrEqual(data.height + 1);
        expect(data.detail_kinds).toEqual(['购买商品','赠品']); expect(data.shipment_kinds).toEqual(['购买商品','赠品']);
        expect(data.selector_kinds).toEqual(['购买商品','赠品']); expect(data.selector_checked).toEqual([false,true]);
        expect(data.selector_text).toContain(longGiftName); expect(data.selector_text).toContain(longGiftSku); expect(data.selector_text).toContain('已选 1 / 3 件');
        expect(data.content).toContain('客户已付金额'); expect(data.content).toContain('¥57.00'); expect(data.content).toContain('结算记录参考不代表已到账');
        evidence.push({ stage: name, ...data });
      } else if (name === 'finish') {
        for (const id of [100,111,201,301]) expect(paths.some(p => p.path === '/supplierapi/order/info/' + id && !p.injected_http)).toBe(true);
        for (const id of [100,202]) expect(paths.some(p => p.path === '/supplierapi/order/split_cart_info/' + id)).toBe(true);
        const failed = paths.findIndex(p => p.injected_http === 503); expect(failed).toBeGreaterThanOrEqual(0);
        expect(paths.slice(failed + 1).some(p => p.path === '/supplierapi/order/info/100' && !p.injected_http)).toBe(true);
        expect(paths.some(p => p.path === '/api/assets/31')).toBe(true); expect(f.r2Reads.length).toBeGreaterThan(0);
        expect(f.r2Reads.every(key => key === f.images.ownedKey)).toBe(true);
        expect(evidence.map(row => row.stage)).toEqual(['desktop', 'phone']);
        expect(await f.snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(baselineSequences);
        finished = true; await writeFile('/tmp/cinashop-supplier-order-gift-identity-browser-result.json', JSON.stringify({ ...state(), table_count: Object.keys(baseline).length,
          sequence_count: baselineSequences.length, provider_calls: 0, business_writes: 0, owned_r2_reads: f.r2Reads.length }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商订单赠品身份 PG16 验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:90px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:1200px;height:844px;border:1px solid #bbb}</style>
      <h1>供应商订单购买品与赠品核对</h1><button id="enter">登录并进入订单</button><button id="desktop">核对桌面详情布局</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机详情布局</button><button id="fail">下一次详情模拟503</button><button id="finish">完成验收并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier订单生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.manager)});localStorage.setItem('supplier-user',JSON.stringify({id:21,supplier_id:7,supplier_name:'本店核对'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view','supplier.order.manage']));frame.src='/orders';};
      async function report(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();document.getElementById('result').textContent=JSON.stringify({requests:value.paths.length,checked:value.evidence.map(x=>x.stage),finished:value.finished});}
      document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};document.getElementById('fail').onclick=()=>report('fail-next');
      const box=n=>{const b=n.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
      const kinds=(doc,selector)=>[...doc.querySelectorAll(selector)].map(n=>n.textContent.trim());
      for(const mode of ['desktop','phone'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument,review=doc.querySelector('.order-review'),dialog=doc.querySelector('.el-dialog'),selector=doc.querySelector('.split-picker');report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,page_client_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth,drawer:box(doc.querySelector('.el-drawer')),review:box(review.querySelector('.review-items-scroll')),close:box(doc.querySelector('.el-drawer__close-btn')),dialog:box(dialog),footer:box(dialog.querySelector('.el-dialog__footer')),kind_boxes:[...doc.querySelectorAll('.review-items .order-item-kind,.shipment-products .order-item-kind,.split-picker .order-item-kind')].map(box),detail_kinds:kinds(doc,'.review-items .order-item-kind'),shipment_kinds:kinds(doc,'.shipment-products .order-item-kind'),selector_kinds:kinds(doc,'.split-picker .order-item-kind'),selector_checked:[...selector.querySelectorAll('input[type=checkbox]')].map(n=>n.checked),selector_text:selector.innerText,content:review.innerText});};document.getElementById('finish').onclick=()=>report('finish');</script></html>`;
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
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Order gift identity must not call external services'); });
  try {
    await f.withReader(async peer => {
      runtime = peer.container; const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS whole_table_write,has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, whole_table_write: false, creates: false });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned review Browser port');
      origin = 'http://127.0.0.1:' + address.port; process.stdout.write('SUPPLIER_ORDER_GIFT_IDENTITY_BROWSER_READY ' + JSON.stringify({ control: origin + control }) + '\n');
      deadline = setTimeout(() => reject(Error('Order gift identity Browser finish not received')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled(); process.stdout.write('SUPPLIER_ORDER_GIFT_IDENTITY_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 21 * 60_000);
