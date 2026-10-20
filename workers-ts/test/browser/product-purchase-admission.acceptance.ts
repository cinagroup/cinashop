/** Background installed-browser acceptance: actual H5 bundle, App/JWT and owned
 * complete PG16 schema. Fixture login/chrome and rule controls are labelled.
 * No order creation, payment, provider, production grants or lifetime coverage. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { storeCart, storeOrder, storeProduct, storeProductAttrValue, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from '../helpers/refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from '../helpers/refundApplicationEvidence';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned product container absent'); return wiring.container; },
}));
type Row = Record<string, any>;
async function requestBytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; expect(size).toBeLessThanOrEqual(65536); chunks.push(bytes); }
  return Buffer.concat(chunks);
}
it('actual H5 invalidates an old quote when the base-product cap changes and recovers through reselection', async () => {
  const f = await refundRuntimeFixture(), app = createApp(), r2 = refundEvidenceR2();
  const root = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5');
  const origin = 'http://127.0.0.1:40751', control = '/__product_limits/' + randomUUID();
  const stages = ['checkout-two', 'quote-invalid', 'checkout-one', 'cumulative-blocked'];
  const traces: Row[] = [], evidence: Row[] = [], ruleEdits: Row[] = [];
  let finished = false, complete!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { complete = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider dispatch in local product limits Browser'));
  try {
    expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    await f.db.insert(storeProduct).values({ id: 170, productType: 0, storeName: '基础商品限购样本', stock: 12,
      price: '10.00', isVerify: 1, isShow: 1, freight: 1, isLimit: 1, limitType: 1, limitNum: 2,
      image: '/legacy/product-limits.png' });
    await f.db.insert(storeProductAttrValue).values({ id: 170, productId: 170, productType: 0,
      unique: 'limp0170', suk: '默认', stock: 12, price: '10.00', cost: '2.00', image: '/legacy/product-limits.png' });
    const password = 'owned-product-limits-account', appKey = 'owned-product-limits-key';
    await f.db.update(user).set({ pwd: password, integral: 100 }).where(eq(user.uid, 11));
    // refundRuntimeFixture already installs its explicit zero-discount pricing
    // configuration and enabled pickup. Use its actual exposed env unchanged.
    const buyerToken = (await createToken(11, 'api', md5(password), appKey)).token;
    const env: typeof f.env = { ...f.env, APP_KEY: appKey, NODE_ENV: 'test' as typeof f.env.NODE_ENV, ASSETS_BUCKET: r2.bucket };
    wiring.container = createContainerFromDb(f.db);
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('public.store_cart','id'),(SELECT MAX(id) FROM public.store_cart),true)`);
    const rules = async () => { const [row] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 170)); return { isLimit: row.isLimit, limitType: row.limitType, limitNum: row.limitNum }; };
    const result = () => ({ stages: evidence.map(row => row.stage), evidence, ruleEdits, traces, finished,
      provider_calls: 0, payment_attempts: 0, historical_coverage_complete: false, production_grants_verified: false,
      login_and_chrome: 'synthetic local session/navigation; business APIs actual App/JWT/maintenance SQL' });
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const method = req.method!, path = url.pathname;
        const getPaths = ['/api/get_script', '/api/v2/diy/color_change/color_change', '/api/product/detail/170',
          '/api/cart/list', '/api/cart/count', '/api/address/list', '/api/store/list', '/api/coupons/order/0',
          '/api/store_discounts/list/170', '/api/reply/config/170', '/api/reply/list/170', '/api/product/detail/activity/170'];
        expect(method === 'GET' && getPaths.includes(path) || method === 'POST' && ['/api/cart/add', '/api/order/confirm'].includes(path)
          || method === 'POST' && /^\/api\/order\/computed\/[A-Za-z0-9_-]+$/.test(path), method + ' ' + path).toBe(true);
        const before = await refundEvidenceSnapshot(f.db), sequences = await refundEvidenceSequences(f.db);
        const bytes = await requestBytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const pending: Promise<unknown>[] = [];
        const context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext;
        const response = await app.fetch(new Request(origin + path + url.search, { method, headers,
          ...(bytes.length ? { body: bytes.toString('utf8') } : {}) }), env, context);
        await Promise.all(pending); const raw = Buffer.from(await response.arrayBuffer());
        expect(response.status, raw.toString()).toBe(200);
        const body = path === '/api/get_script' ? null : JSON.parse(raw.toString());
        if (body?.status !== 200 && body) {
          expect(body.status).toBe(400);
          expect(path === '/api/order/confirm' || path.startsWith('/api/order/computed/') || path === '/api/coupons/order/0').toBe(true);
          expect(body.msg).toMatch(/单次购买不能超过1件|累计限购历史尚无法完整核验/);
        }
        const analytics = path === '/api/product/detail/170';
        const readonly = method === 'GET' && !analytics || path === '/api/order/confirm' || path.startsWith('/api/order/computed/');
        if (readonly) { expect(await refundEvidenceSnapshot(f.db)).toEqual(before); expect(await refundEvidenceSequences(f.db)).toEqual(sequences); }
        if (analytics) {
          const after = await refundEvidenceSnapshot(f.db), afterSequences = await refundEvidenceSequences(f.db);
          for (const table of Object.keys(before)) if (!['store_product_log', 'store_visit'].includes(table)) expect(after[table]).toEqual(before[table]);
          expect(afterSequences.filter(row => !/store_product_log|store_visit/.test(row.name))).toEqual(sequences.filter(row => !/store_product_log|store_visit/.test(row.name)));
        }
        if (path === '/api/cart/add') {
          expect(body.status).toBe(200); const input = JSON.parse(bytes.toString());
          expect(input).toMatchObject({ productId: 170, cartNum: traces.some(row => row.path === path) ? 1 : 2, new: 1 });
          const [cart] = await f.db.select().from(storeCart).where(eq(storeCart.id, body.data.id));
          expect(cart).toMatchObject({ uid: 11, productId: 170, type: 0, cartNum: input.cartNum, isNew: 1, isPay: 0 });
        }
        expect(r2.r2Reads).toEqual([]); expect(r2.r2Writes).toEqual([]); expect(r2.r2Deletes).toEqual([]);
        const quote = (path === '/api/order/confirm' || path.startsWith('/api/order/computed/')) && body?.status === 200 ? body.data : null;
        traces.push({ method, path, http: response.status, business_status: body?.status ?? null, message: body?.msg ?? null,
          ...(quote ? { priced: { priceGroup: { pay_price: (quote.priceGroup ?? quote).pay_price, total_price: (quote.priceGroup ?? quote).total_price },
            lines: quote.cartInfo?.map((row: Row) => ({ productId: row.productId ?? row.product_id, cartNum: row.cartNum ?? row.cart_num })) } } : {}),
          ...(readonly ? { all_public_tables_sequences_unchanged: true } : analytics ? { expected_analytics_tables: ['store_product_log', 'store_visit'] } : {}) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await requestBytes(req)).toString());
        if (stage === 'cap-one' || stage === 'cumulative') {
          expect(evidence.map(row => row.stage)).toEqual(stages.slice(0, stage === 'cap-one' ? 1 : 3));
          const patch = { isLimit: 1, limitType: stage === 'cap-one' ? 1 : 2, limitNum: stage === 'cap-one' ? 1 : 2 };
          await f.db.update(storeProduct).set(patch).where(eq(storeProduct.id, 170));
          ruleEdits.push({ source: 'labelled fixture rule edit, not Admin HTTP acceptance', ...patch });
        } else if (stage === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages); expect(ruleEdits).toHaveLength(2);
          expect(traces.filter(row => row.path === '/api/cart/add')).toHaveLength(2);
          const quotes = traces.filter(row => row.path === '/api/order/confirm' || row.path.startsWith('/api/order/computed/'));
          for (const quantity of [2, 1]) expect(quotes.some(row => row.business_status === 200 && row.priced?.priceGroup?.pay_price === (quantity * 10).toFixed(2) && row.priced?.lines?.some((line: Row) => line.productId === 170 && line.cartNum === quantity))).toBe(true);
          for (const error of ['该商品单次购买不能超过1件', '累计限购历史尚无法完整核验'])
            expect(quotes.some(row => row.business_status === 400 && row.message?.includes(error))).toBe(true);
          expect(await f.db.select().from(storeOrder).where(eq(storeOrder.uid, 11))).toEqual([]);
          const [account] = await f.db.select().from(user).where(eq(user.uid, 11)); expect(account.integral).toBe(100);
          const [product] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 170)); expect(product).toMatchObject({ stock: 12, sales: 0 });
          const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 170)); expect(sku).toMatchObject({ stock: 12, sales: 0 });
          expect(external).not.toHaveBeenCalled(); finished = true;
          await writeFile('/tmp/cinashop-product-limits-browser-result.json', JSON.stringify({ ...result(), stock_and_points_unchanged: true,
            public_table_count: Object.keys(await refundEvidenceSnapshot(f.db)).length,
            sequence_count: (await refundEvidenceSequences(f.db)).length }, null, 2) + '\n');
        } else {
          expect(stage).toBe(stages[evidence.length]); expect(data.href).toContain('/pages/order/confirm');
          expect(data.text).toContain('确认订单'); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
          if (stage === 'checkout-two' || stage === 'checkout-one') {
            expect(data.text).toContain('基础商品限购样本'); expect(data.text).toContain(stage === 'checkout-two' ? '¥20.00' : '¥10.00'); expect(data.submit_disabled).toBe(false);
          } else {
            expect(data.text).toContain(stage === 'quote-invalid' ? '该商品单次购买不能超过1件' : '累计限购历史尚无法完整核验');
            expect(data.text).not.toContain('¥20.00'); expect(data.text).not.toContain('¥10.00'); expect(data.submit_disabled).toBe(true);
          }
          evidence.push({ stage, ...data, persisted_rules: await rules() });
        }
        json(res, { checked: evidence.map(row => row.stage), edits: ruleEdits, finished }); if (finished) complete();
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>基础商品限购验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:900px;border:1px solid #ddd}pre{max-height:45px;overflow:auto}</style><h1>基础商品限购：实际 H5 选购与报价</h1><p>本机合成会话；限额按钮只修改专属测试数据库。</p><button id="h5">进入实际H5</button><button id="reload">重新加载实际页面</button>${['checkout-two','cap-one','quote-invalid','checkout-one','cumulative','cumulative-blocked','finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('h5').onclick=()=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(buyerToken)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.src='/__product_h5#/pages/goods/detail?id=170';};document.getElementById('reload').onclick=()=>frame.contentWindow.location.reload();for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,b=d.querySelector('.submit-btn');const data={text:d.body.textContent,href:frame.contentWindow.location.href,submit_disabled:b?b.disabled||b.getAttribute('disabled')!==null:null,page_width:d.documentElement.clientWidth,page_scroll_width:d.documentElement.scrollWidth};const r=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=await r.text();};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (path === '/legacy/product-limits.png' || path === '/logo.png') return send(res, Buffer.from(r2.png), 200, 'image/png');
      const chrome: Row = { '/api/site_config': { site_name: '本地基础限购验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地基础限购验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
        ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* SPA */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned Browser assertion failed: ' + String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('PRODUCT_LIMITS_BROWSER_READY ' + JSON.stringify({ url: origin + control }) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
      expect(external).not.toHaveBeenCalled(); process.stdout.write('PRODUCT_LIMITS_BROWSER_RESULT ' + JSON.stringify(result()) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
