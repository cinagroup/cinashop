/** Actual full-gift creation service and protected physical receipt, then
 * actual H5 App/JWT readback. Owned synthetic session, no payment/provider. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeCart, storeProduct, storeProductAttrValue, user } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { AdminFullGiftService } from '@/services/admin/AdminFullGiftService';
import { readPurchaseQuotaHistory } from '@/services/order/PurchaseQuotaHistory';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from '../helpers/refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from '../helpers/refundApplicationEvidence';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned integral App boundary absent'); return wiring.container;
} }));
type Row = Record<string, any>;
const stages = ['loaded', 'cleared', 'recovered'];
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of req) { const part = Buffer.from(chunk); total += part.length; expect(total).toBeLessThanOrEqual(65536); chunks.push(part); }
  return Buffer.concat(chunks);
}

it('actual H5 reads the charged and gift rows of a final physical origin and recovers from a detail failure', async () => {
  const kind: string = 'mobile';
  const f = await refundRuntimeFixture(), r2 = refundEvidenceR2(), app = createApp();
  const root = resolve(import.meta.dirname, '../../../view', kind === 'pc' ? 'pc-ts/dist' : 'uniapp-ts/dist/build/h5');
  const control = '/__physical_origin/' + randomUUID(), origin = 'http://127.0.0.1:40751';
  const traces: Row[] = [], evidence: Row[] = [], authors: Row[] = [];
  let finished = false, failDetail = false, thumbnailReads = 0;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  }
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Physical origin acceptance forbids provider dispatch'));
  try {
    expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    await f.db.insert(storeProduct).values([
      { id: 170, productType: 0, storeName: '实物原购收费商品', stock: 12, price: '10.00', isVerify: 1, isShow: 1, freight: 1, deliveryType: '1', image: '/api/qa/image.svg' },
      { id: 171, productType: 0, storeName: '实物原购满送礼盒', stock: 12, price: '5.00', isVerify: 1, isShow: 1, freight: 1, deliveryType: '1', image: '/api/qa/image.svg' },
    ]);
    await f.db.insert(storeProductAttrValue).values([
      { id: 170, productId: 170, unique: 'paid0170', suk: '标准', stock: 12, price: '10.00', cost: '2.00' },
      { id: 171, productId: 171, unique: 'gift0171', suk: '礼盒', stock: 12, price: '5.00', cost: '1.00' },
    ]);
    const shanghai = (hours: number) => { const date = new Date(Date.now() + (hours + 8) * 3600000);
      return date.toISOString().slice(0, 19).replace('T', ' '); };
    await new AdminFullGiftService(createContainerFromDb(f.db)).mutate('create', 0, {
      name: '实物原购满送', section_time: [shanghai(-1), shanghai(24)], promotions_cate: 2, threshold_type: 1,
      promotions: [{ threshold: 10, give_integral: 0, give_coupon_id: [],
        give_product_id: [{ give_product_id: 171, unique: 'gift0171', give_product_num: 10 }] }],
      is_label: 0, label_id: [], product_partake_type: 2, product_id: [{ product_id: 170, unique: ['paid0170'] }],
      brand_id: [], store_label_id: [], status: 1, sort: 0, request_id: randomUUID(),
    }, { id: 9 });
    await f.db.insert(storeCart).values({ id: 170, uid: 11, productId: 170, productAttrUnique: 'paid0170', cartNum: 2, status: 1, isNew: 1 });
    const password = 'owned-integral-origin-account', key = 'owned-integral-origin-app-key';
    await f.db.update(user).set({ pwd: password, integral: 100 }).where(eq(user.uid, 11));
    const token = (await createToken(11, 'api', md5(password), key)).token;
    // Generated bindings fix production; this owned fixture explicitly tests test mode.
    const env: typeof f.env = { ...f.env, APP_KEY: key, NODE_ENV: 'test' as typeof f.env.NODE_ENV, ASSETS_BUCKET: r2.bucket };
    wiring.container = createContainerFromDb(f.db);
    const params = { uid: 11, cartIds: [170], key: 'owned-physical-origin-browser', addressId: 11,
      shippingType: 1, useIntegral: false, userIp: '127.0.0.1' };
    const runtime = { CONFIG_KV: env.CONFIG_KV, requirePurchaseOrigin: true as const,
      nextOrderId: async () => 'owned_physical_origin_browser' };
    // Actual production creation service on owned SQL. Browser login and the
    // preflight author are explicitly local; no payment/provider is invoked.
    const made = await StoreOrderCreateService.createWithRuntime(wiring.container, runtime, params);
    const orderId = made.orderId;
    const beforeReplay = await refundEvidenceSnapshot(f.db), beforeReplaySequences = await refundEvidenceSequences(f.db);
    expect(await StoreOrderCreateService.createWithRuntime(wiring.container, runtime, params)).toEqual(made);
    expect(await refundEvidenceSnapshot(f.db)).toEqual(beforeReplay); expect(await refundEvidenceSequences(f.db)).toEqual(beforeReplaySequences);
    authors.push({ author: 'actual StoreOrderCreateService.createWithRuntime', boundary: 'owned fixture maintenance SQL, local number, no App/JWT author claim', order_id: orderId, replay_unchanged: true });
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderId));
    expect(order).toMatchObject({ uid: 11, type: 0, paid: 0, payPrice: '20.00', totalNum: 4 });
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(lines).toHaveLength(2); expect(lines.map(line => line.cartNum)).toEqual([2, 2]);
    const origins = await f.db.execute(sql`SELECT total_num,lines FROM public.store_order_purchase_origin WHERE order_id=${order.id}`);
    const physical = await f.db.execute(sql`SELECT total_num,lines FROM public.store_order_purchase_physical_origin WHERE order_id=${order.id}`);
    expect(origins[0].total_num).toBe(2); expect(physical[0].total_num).toBe(4);
    const history = await f.db.transaction(tx => readPurchaseQuotaHistory(tx, 11), { isolationLevel: 'repeatable read', accessMode: 'read only' });
    expect(history).toMatchObject({ status: 'verified_retained_roots', incomplete: true, products: [
      { productId: 170, activeUnpaid: 2 }, { productId: 171, activeUnpaid: 2 },
    ] });
    const sourcePath = kind === 'pc' ? '/order/' + orderId : '/#/pages/order/detail?orderId=' + orderId;
    const result = () => ({ kind, source_order: orderId, order_row_id: order.id, authors, traces, evidence, required_stages: stages,
      finished, charged_units: 2, gift_units: 2, physical_units: 4, points_paid: 0, origins: [...origins], physical: [...physical], history,
      author_replay_all_public_tables_sequences_unchanged: true, history_coverage_complete: false,
      provider_calls: 0, r2_reads: r2.r2Reads.length, r2_puts: r2.r2Writes.length, r2_deletes: r2.r2Deletes.length, fixture_thumbnail_reads: thumbnailReads });

    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const path = url.pathname, detail = path === '/api/order/detail/' + orderId;
        expect(req.method).toBe('GET');
        expect(detail || path === '/api/order/cashier/' + orderId + '/order' || ['/api/cart/list', '/api/cart/count', '/api/get_script', '/api/v2/diy/color_change/color_change'].includes(path), 'Unexpected business read: ' + path).toBe(true);
        const before = await refundEvidenceSnapshot(f.db), sequences = await refundEvidenceSequences(f.db);
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const response = await app.fetch(new Request(origin + path + url.search, { method: req.method, headers }), env);
        const raw = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
        const body = path === '/api/get_script' ? null : JSON.parse(raw.toString()); if (body) expect(body.status, body.msg).toBe(200);
        if (detail) {
          expect(body.data).toMatchObject({ orderId, paid: 0, type: 0, totalNum: 4, payPrice: '20.00' });
          expect(body.data.cartInfo).toHaveLength(2); expect(body.data.cartInfo.map((line: Row) => line.cartNum)).toEqual([2, 2]);
        }
        expect(await refundEvidenceSnapshot(f.db)).toEqual(before); expect(await refundEvidenceSequences(f.db)).toEqual(sequences);
        expect(r2.r2Reads).toEqual([]); expect(r2.r2Writes).toEqual([]); expect(r2.r2Deletes).toEqual([]);
        const trace: Row = { method: req.method, path, http: response.status, all_public_tables_sequences_unchanged: true };
        if (detail && failDetail) { failDetail = false; trace.injected_http = 503; traces.push(trace); return send(res, 'Owned detail read failure after backend200', 503, 'text/plain'); }
        traces.push(trace); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const name = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString() || '{}');
        if (name === 'arm-read-failure') { expect(evidence.map(row => row.stage)).toEqual(['loaded']); failDetail = true; }
        else if (name === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages); expect(traces.filter(row => row.injected_http === 503)).toHaveLength(1);
          expect(traces.filter(row => row.path === '/api/order/detail/' + orderId)).toHaveLength(3);
          finished = true; await writeFile('/tmp/cinashop-physical-origin-browser-result.json', JSON.stringify({ ...result(),
            public_table_count: Object.keys(await refundEvidenceSnapshot(f.db)).length, sequence_count: (await refundEvidenceSequences(f.db)).length }, null, 2) + '\n');
        } else {
          expect(stages[evidence.length]).toBe(name); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
          if (name === 'cleared') { expect(data.text).not.toContain(orderId); expect(data.text).toContain('重新加载订单'); }
          else {
            expect(data.text).toContain(orderId); expect(data.text).toContain('实物原购收费商品');
            expect(data.text).toContain('实物原购满送礼盒'); expect(data.text).toContain('待支付');
            expect(data.text).toContain('20.00'); expect(data.cart_lines).toBe(2);
          }
          evidence.push({ stage: name, ...data });
        }
        send(res, JSON.stringify(result()), 200, 'application/json'); if (finished) done();
      });
    }
    const enter = kind === 'pc' ? `sessionStorage.setItem('pc_token',${JSON.stringify(token)});sessionStorage.setItem('pc_uid','11');`
      : `localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));`;
    function shell() { return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${kind}实物原购验收</title><style>body{font:14px sans-serif;margin:12px}button{margin:4px}pre{max-height:60px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:${kind === 'pc' ? 1200 : 390}px;height:844px;border:1px solid #ccc}</style><h1>${kind} 实际满送订单读取验收</h1><p>实际创建服务已保存收费 2 件、满送 2 件；下方为现有 H5 订单页，无付款。</p><button id="enter">进入实际订单</button>${[...stages, 'arm-read-failure', 'finish'].map(name => `<button data-stage="${name}">${name}</button>`).join('')}<pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{${enter}frame.src=${JSON.stringify(sourcePath)};};for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const doc=frame.contentDocument;const data={text:doc.body.textContent,href:frame.contentWindow.location.href,cart_lines:doc.querySelectorAll('.cart-line').length,page_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth};const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();document.getElementById('result').textContent=JSON.stringify({kind:value.kind,checked:value.evidence.map(row=>row.stage),finished:value.finished});};</script></html>`; }
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (path === '/api/qa/image.svg' && req.method === 'GET') { thumbnailReads++; return send(res, Buffer.from(r2.png), 200, 'image/png'); }
      const chrome: Row = { '/api/site_config': { site_name: '本地实物原购验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地实物原购验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return send(res, JSON.stringify({ status: 200, data: chrome[path], msg: 'Owned shell only' }), 200, 'application/json');
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
        ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* SPA route */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned acceptance assertion failed', 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('PHYSICAL_ORIGIN_BROWSER_READY ' + JSON.stringify({ kind, url: origin + control, source_order: orderId }) + '\n');
      deadline = setTimeout(() => fail(Error('Physical origin Browser completion absent')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled();
      process.stdout.write('PHYSICAL_ORIGIN_BROWSER_RESULT ' + JSON.stringify({ kind, stages: evidence.map(row => row.stage), business_reads: traces.length, actual_service_authors: authors.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
