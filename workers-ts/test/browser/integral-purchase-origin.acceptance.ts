/** Real App/JWT direct exchange, then production PC/H5 order detail readback.
 * The exchange author is HTTP preflight, not an invented storefront control. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { storeIntegral, storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, user } from '@/models/schema';
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

it.each(['pc', 'mobile'] as const)('actual %s paid direct integral order retains origin across detail read failure and retry', async kind => {
  const f = await refundRuntimeFixture(), r2 = refundEvidenceR2(), app = createApp();
  const root = resolve(import.meta.dirname, '../../../view', kind === 'pc' ? 'pc-ts/dist' : 'uniapp-ts/dist/build/h5');
  const control = '/__integral_origin/' + randomUUID(), origin = 'http://127.0.0.1:40751';
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
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Integral acceptance forbids provider dispatch'));
  try {
    expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    // Owned display inventory; author, point debit, origin and paid outbox all
    // execute through the real registered App, without synthetic paid admission.
    await f.db.insert(storeProduct).values({ id: 170, productType: 2, storeName: '积分原购样本',
      stock: 12, price: '0.00', isVerify: 1, isShow: 1, freight: 1, image: '/api/qa/image.svg' });
    await f.db.insert(storeIntegral).values({ id: 170, productId: 170, productType: 2, storeName: '积分原购样本',
      image: '/api/qa/image.svg', price: '0.00', integral: 10, stock: 12, quota: 12, status: 1, isShow: 1 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 170, productId: 170, productType: 2, unique: 'ints0170', suk: '默认', stock: 12, price: '0.00', cost: '2.00' },
      { id: 171, productId: 170, productType: 2, type: 4, unique: 'inta0170', suk: '默认', stock: 12,
        quota: 12, price: '0.00', cost: '2.00', integral: 10, image: '/api/qa/image.svg' },
    ]);
    const password = 'owned-integral-origin-account', key = 'owned-integral-origin-app-key';
    await f.db.update(user).set({ pwd: password, integral: 100 }).where(eq(user.uid, 11));
    const token = (await createToken(11, 'api', md5(password), key)).token;
    // Generated bindings fix production; this owned fixture explicitly tests test mode.
    const env: typeof f.env = { ...f.env, APP_KEY: key, NODE_ENV: 'test' as typeof f.env.NODE_ENV, ASSETS_BUCKET: r2.bucket };
    wiring.container = createContainerFromDb(f.db);
    async function exchange() {
      const response = await app.request('/api/store_integral/exchange/170', { method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ num: 2, unique: 'inta0170', key: 'owned-browser-integral-origin' }) }, env);
      const body = await response.json<Row>(); expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
      authors.push({ method: 'POST', path: '/api/store_integral/exchange/170', http: response.status,
        status: body.status, order_id: body.data.orderId, boundary: 'real_App_JWT_owned_maintenance_SQL' });
      return body.data.orderId as string;
    }
    const orderId = await exchange();
    const beforeReplay = await refundEvidenceSnapshot(f.db), beforeReplaySequences = await refundEvidenceSequences(f.db);
    expect(await exchange()).toBe(orderId);
    expect(await refundEvidenceSnapshot(f.db)).toEqual(beforeReplay); expect(await refundEvidenceSequences(f.db)).toEqual(beforeReplaySequences);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderId));
    expect(order).toMatchObject({ uid: 11, type: 4, productType: 2, paid: 1, payType: 'integral', payIntegral: 20, payPrice: '0.00', totalNum: 2 });
    expect(Number(order.useIntegral)).toBe(0);
    const [line] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id));
    expect(line).toMatchObject({ cartId: String(line.id), productId: 170, skuUnique: 'ints0170', cartNum: 2 });
    expect(order.cartId).toBe(String(line.id));
    const origins = await f.db.execute(sql`SELECT order_id,buyer_id,version,order_type,total_num,used_points,lines FROM public.store_order_purchase_origin`);
    expect(origins).toHaveLength(1); expect(origins[0]).toMatchObject({ order_id: order.id, buyer_id: 11, version: 'purchase-origin-v1', order_type: 4, total_num: 2 });
    expect(Number(origins[0].used_points)).toBe(0);
    expect(origins[0].lines).toEqual([{ rowId: line.id, cartId: String(line.id), productId: 170, skuId: 170, skuUnique: 'ints0170', quantity: 2, usedPoints: 0 }]);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(80);
    const sourcePath = kind === 'pc' ? '/order/' + orderId : '/#/pages/order/detail?orderId=' + orderId;
    const result = () => ({ kind, source_order: orderId, order_row_id: order.id, authors, traces, evidence, required_stages: stages,
      finished, original_units: 2, points_paid: 20, offset_points: 0, origins: [...origins],
      author_replay_all_public_tables_sequences_unchanged: true, history_coverage_complete: false,
      provider_calls: 0, r2_reads: r2.r2Reads.length, r2_puts: r2.r2Writes.length, r2_deletes: r2.r2Deletes.length, fixture_thumbnail_reads: thumbnailReads });

    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const path = url.pathname, detail = path === '/api/order/detail/' + orderId;
        expect(req.method).toBe('GET');
        expect(detail || ['/api/cart/list', '/api/cart/count', '/api/get_script', '/api/v2/diy/color_change/color_change'].includes(path), 'Unexpected business read: ' + path).toBe(true);
        const before = await refundEvidenceSnapshot(f.db), sequences = await refundEvidenceSequences(f.db);
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const response = await app.fetch(new Request(origin + path + url.search, { method: req.method, headers }), env);
        const raw = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
        const body = path === '/api/get_script' ? null : JSON.parse(raw.toString()); if (body) expect(body.status, body.msg).toBe(200);
        if (detail) {
          expect(body.data).toMatchObject({ orderId, paid: 1, type: 4, payType: 'integral', payIntegral: 20, payPrice: '0.00' });
          expect(body.data.cartInfo).toHaveLength(1); expect(body.data.cartInfo[0].cartNum).toBe(2);
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
          finished = true; await writeFile('/tmp/cinashop-integral-purchase-origin-browser-' + kind + '-result.json', JSON.stringify({ ...result(),
            public_table_count: Object.keys(await refundEvidenceSnapshot(f.db)).length, sequence_count: (await refundEvidenceSequences(f.db)).length }, null, 2) + '\n');
        } else {
          expect(stages[evidence.length]).toBe(name); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
          if (name === 'cleared') { expect(data.text).not.toContain(orderId); expect(data.text).toContain('重新加载订单'); }
          else {
            expect(data.text).toContain(orderId); expect(data.text).toContain('积分原购样本'); expect(data.text).toContain('已付积分');
            expect(data.text).toMatch(/20\s*积分/); expect(data.text).toContain('0.00'); expect(data.text).not.toContain('未支付');
            if (kind === 'pc') expect(data.text).toContain('积分支付');
          }
          expect(data.cashier_cards).toBe(0); expect(data.repurchase_buttons).toBe(0); evidence.push({ stage: name, ...data });
        }
        send(res, JSON.stringify(result()), 200, 'application/json'); if (finished) done();
      });
    }
    const enter = kind === 'pc' ? `sessionStorage.setItem('pc_token',${JSON.stringify(token)});sessionStorage.setItem('pc_uid','11');`
      : `localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));`;
    function shell() { return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${kind}积分原购验收</title><style>body{font:14px sans-serif;margin:12px}button{margin:4px}pre{max-height:60px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:${kind === 'pc' ? 1200 : 390}px;height:844px;border:1px solid #ccc}</style><h1>${kind} 实际积分订单读取验收</h1><p>真实 App/JWT 已兑换 2 件、扣 20 积分；下方为现有生产订单页。</p><button id="enter">进入实际订单</button>${[...stages, 'arm-read-failure', 'finish'].map(name => `<button data-stage="${name}">${name}</button>`).join('')}<pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{${enter}frame.src=${JSON.stringify(sourcePath)};};for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const doc=frame.contentDocument;const data={text:doc.body.textContent,href:frame.contentWindow.location.href,cashier_cards:doc.querySelectorAll('.cashier-card').length,repurchase_buttons:doc.querySelectorAll('.repurchase-button').length,page_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth};const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();document.getElementById('result').textContent=JSON.stringify({kind:value.kind,checked:value.evidence.map(row=>row.stage),finished:value.finished});};</script></html>`; }
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (path === '/api/qa/image.svg' && req.method === 'GET') { thumbnailReads++; return send(res, Buffer.from(r2.png), 200, 'image/png'); }
      const chrome: Row = { '/api/site_config': { site_name: '本地积分验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地积分验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] } };
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
      process.stdout.write('INTEGRAL_ORIGIN_BROWSER_READY ' + JSON.stringify({ kind, url: origin + control, source_order: orderId }) + '\n');
      deadline = setTimeout(() => fail(Error('Integral origin Browser completion absent')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled();
      process.stdout.write('INTEGRAL_ORIGIN_BROWSER_RESULT ' + JSON.stringify({ kind, stages: evidence.map(row => row.stage), business_reads: traces.length, actual_HTTP_authors: authors.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
