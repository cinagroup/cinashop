/** Built Orders -> real Supplier App/JWT -> independent SELECT-only PG16 LOGIN. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { storeOrderCartInfo, storePromotions } from '@/models/schema';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { supplierOrderPromotionReviewFixture } from '../helpers/supplierOrderPromotionReview';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned review Browser LOGIN'); return wiring.container;
} }));
type Row = Record<string, any>;
it('reviews named promotion allocations with distinct frozen names and current PHP titles in exact physical-order read-only Supplier details, including history and recovery', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierOrderPromotionReviewFixture(), app = createApp(), control = '/__order_promotions_review/' + randomUUID();
  // Browser-only long display text is installed before the immutable read baseline.
  const longFrozenName = '下单九折活动' + '🎁'.repeat(120);
  const longCurrentTitle = '当前九折活动标题' + '当前活动说明'.repeat(8);
  await f.db.update(storePromotions).set({ title: longCurrentTitle }).where(eq(storePromotions.id, f.promotionIds.first));
  const [cart] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 100));
  const snapshot = JSON.parse(cart.cartInfo!);
  for (const item of snapshot.promotion_allocations) if (item.promotionId === f.promotionIds.first) item.name = longFrozenName;
  for (const segment of snapshot.promotion_segments) for (const item of segment.promotionAllocations)
    if (item.promotionId === f.promotionIds.first) item.name = longFrozenName;
  await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, cart.id));
  const expectedPromotions = { ...f.expectedPromotions, items: f.expectedPromotions.items.map(item => item.promotion_id === f.promotionIds.first
    ? { ...item, frozen_name: longFrozenName, current_title: longCurrentTitle } : item) };
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
      expect(url.pathname === '/api/get_script' || url.pathname === '/api/assets/31' || url.pathname === '/supplierapi/order/list'
        || /^\/supplierapi\/order\/(info|status|split_order)\/(100|110|111|117|123|201|202|301)$/.test(url.pathname)).toBe(true);
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
        const r = envelope.data.review; expect(r.version).toBe(1);
        const promotions = r.promotions; entry.promotions = promotions;
        expect(promotions.order_id).toBe(envelope.data.id);
        expect(JSON.stringify(promotions)).not.toMatch(/PRIVATE-|eligibility|promotions_give|product_id|uid/);
        if (url.pathname.endsWith('/100')) expect(promotions).toEqual(expectedPromotions);
        if (url.pathname.endsWith('/201')) expect(promotions).toMatchObject({ order_id: 201, state: 'recorded', basis: 'modern', total: '3.00', items: [
          { promotion_id: f.promotionIds.first, frozen_name: '下单九折活动', amount: '2.00', current_title: longCurrentTitle },
          { promotion_id: f.promotionIds.second, frozen_name: '下单满减活动', amount: '1.00' },
        ] });
        if (url.pathname.endsWith('/301')) expect(promotions).toMatchObject({ order_id: 301, state: 'recorded', basis: 'legacy', total: '3.00', items: [
          { promotion_id: f.promotionIds.legacy, frozen_name: null, current_title: '历史满额优惠标题', amount: '3.00' },
        ] });
        if (url.pathname.endsWith('/110')) expect(promotions).toMatchObject({ state: 'unavailable', total: null, items: [] });
        if (url.pathname.endsWith('/111')) expect(promotions).toEqual({ order_id: 111, state: 'none', reason: '', basis: null, total: null, items: [] });
        if (url.pathname.endsWith('/100')) expect(r.invoice).toEqual({ state: 'recorded', reason: '', record: f.expectedInvoice });
        entry.review = { order_kind: r.order_kind, original_order_id: r.original_order_id, recipient: r.recipient,
          amounts: r.amounts, settlement: r.settlement, items: r.items,
          form: r.form.map((field: Row) => ({ ...field, images: field.images.map((image: string) => new URL(image, origin).pathname) })) };
        if (url.pathname.endsWith('/100')) {
          expect(r.recipient).toMatchObject({ name: f.expectedReview.name, address: f.expectedReview.address, mark: f.expectedReview.mark });
          expect(r.amounts.pay_price).toBe('57.00'); expect(r.settlement).toEqual({ items_total: '5.00', postage: '3.00', total: '8.00', availability: 'recorded' });
          expect(r.items[0]).toMatchObject({ quantity: 2, settlement_unit: '2.50', settlement_subtotal: '5.00', code: 'FROZEN-CODE', bar_code: 'FROZEN-BAR' });
          expect(r.form[2].images).toHaveLength(1); expect(r.form[2].images[0]).toMatch(/^\/api\/assets\/31\?expires=/);
        }
        if (url.pathname.endsWith('/201')) { expect(r.original_order_id).toBe('tracking-own-200'); expect(r.items[0].quantity).toBe(1); expect(r.settlement.total).toBe('4.00'); }
        if (url.pathname.endsWith('/301')) expect(r.original_order_id).toBe('tracking-own-300');
        if (url.pathname.endsWith('/110')) expect(r.settlement.availability).toBe('incomplete');
        if (url.pathname.endsWith('/111')) { expect(r.settlement).toEqual({ items_total: '0.00', postage: '0.00', total: '0.00', availability: 'recorded' }); expect(r.items[0].product_name).toBe('现代零结算商品'); }
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
        for (const box of [data.drawer, data.review, data.close, data.items, data.promotions, ...data.promotions_fields]) {
          expect(box.left).toBeGreaterThanOrEqual(-1); expect(box.right).toBeLessThanOrEqual(data.width + 1);
        }
        expect(data.close.top).toBeGreaterThanOrEqual(-1); expect(data.close.bottom).toBeLessThanOrEqual(data.height + 1);
        expect(data.items.client_width).toBeGreaterThan(0); expect(data.items.scroll_width).toBeGreaterThanOrEqual(data.items.client_width);
        for (const fact of [f.expectedReview.address, f.expectedReview.mark, '冻结核对商品', 'FROZEN-CODE', 'FROZEN-BAR', '¥8.00', '¥57.00', '结算记录参考不代表已到账', '请保留原包装', '预约日期']) expect(data.content).toContain(fact);
        expect(data.images).toEqual([{ path: '/api/assets/31', complete: true, width: 1, height: 1 }]);
        for (const fact of [longFrozenName, longCurrentTitle, '下单满减活动', '当前满减活动标题', '下单快照中的活动名称', '当前活动标题', '¥4.00', '¥2.00', '¥6.00', '不用于重新计算优惠']) expect(data.promotions_content).toContain(fact);
        evidence.push({ stage: name, ...data });
      } else if (name === 'finish') {
        for (const id of [100, 110, 111, 201, 301]) expect(paths.some(p => p.path === '/supplierapi/order/info/' + id && !p.injected_http)).toBe(true);
        const failed = paths.findIndex(p => p.injected_http === 503); expect(failed).toBeGreaterThanOrEqual(0);
        expect(paths.slice(failed + 1).some(p => p.path === '/supplierapi/order/info/100' && !p.injected_http)).toBe(true);
        expect(paths.some(p => p.path === '/api/assets/31')).toBe(true); expect(f.r2Reads.length).toBeGreaterThan(0);
        expect(f.r2Reads.every(key => key === f.images.ownedKey)).toBe(true);
        expect(evidence.map(row => row.stage)).toEqual(['desktop', 'phone']);
        expect(await f.snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(baselineSequences);
        finished = true; await writeFile('/tmp/cinashop-supplier-order-promotions-review-browser-result.json', JSON.stringify({ ...state(), table_count: Object.keys(baseline).length,
          sequence_count: baselineSequences.length, provider_calls: 0, business_writes: 0, owned_r2_reads: f.r2Reads.length }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商订单促销分摊 PG16 验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:90px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:1200px;height:844px;border:1px solid #bbb}</style>
      <h1>供应商订单促销分摊核对</h1><button id="enter">登录并进入订单</button><button id="desktop">核对桌面详情布局</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机详情布局</button><button id="fail">下一次详情模拟503</button><button id="finish">完成验收并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier订单生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.viewer)});localStorage.setItem('supplier-user',JSON.stringify({id:22,supplier_id:7,supplier_name:'本店核对'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view']));frame.src='/orders';};
      async function report(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();document.getElementById('result').textContent=JSON.stringify({requests:value.paths.length,checked:value.evidence.map(x=>x.stage),finished:value.finished});}
      document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};document.getElementById('fail').onclick=()=>report('fail-next');
      const box=n=>{const b=n.getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
      for(const mode of ['desktop','phone'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument,review=doc.querySelector('.order-review'),items=review.querySelector('.review-items-scroll');report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,page_client_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth,drawer:box(doc.querySelector('.el-drawer')),review:box(review),close:box(doc.querySelector('.el-drawer__close-btn')),items:{...box(items),client_width:items.clientWidth,scroll_width:items.scrollWidth},promotions:box(review.querySelector('.promotions-review')),promotions_fields:[...review.querySelectorAll('.promotions-facts dd')].map(box),promotions_content:review.querySelector('.promotions-review').innerText,images:[...review.querySelectorAll('.review-form-images img')].map(n=>({path:new URL(n.currentSrc).pathname,complete:n.complete,width:n.naturalWidth,height:n.naturalHeight})),content:review.innerText});};document.getElementById('finish').onclick=()=>report('finish');</script></html>`;
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
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Order promotions review must not call external services'); });
  try {
    await f.withReader(async peer => {
      runtime = peer.container; const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS whole_table_write,has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, whole_table_write: false, creates: false });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned review Browser port');
      origin = 'http://127.0.0.1:' + address.port; process.stdout.write('SUPPLIER_ORDER_PROMOTIONS_REVIEW_BROWSER_READY ' + JSON.stringify({ control: origin + control }) + '\n');
      deadline = setTimeout(() => reject(Error('Order promotions Browser finish not received')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled(); process.stdout.write('SUPPLIER_ORDER_PROMOTIONS_REVIEW_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 21 * 60_000);
