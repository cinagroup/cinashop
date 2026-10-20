/** Actual production PC/H5, App/JWT and owned complete PG16. Synthetic login
 * and navigation chrome are labelled; no order, payment or provider dispatch. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { storeCart, storeOrder, storeProduct, storeProductAttrValue, user, userAddress } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from '../helpers/refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from '../helpers/refundApplicationEvidence';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned presale container absent'); return wiring.container; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; expect(size).toBeLessThanOrEqual(65536); chunks.push(part); }
  return Buffer.concat(chunks);
}
it.each(['pc', 'mobile'] as const)('actual %s selects a short presale SKU and recovers current checkout prices', async kind => {
  const f = await refundRuntimeFixture(), app = createApp(), r2 = refundEvidenceR2();
  const root = resolve(import.meta.dirname, kind === 'pc' ? '../../../view/pc-ts/dist' : '../../../view/uniapp-ts/dist/build/h5');
  const buyerUid = 1_000_000 + parseInt(randomUUID().slice(0, 6), 16);
  const origin = 'http://127.0.0.1:40751', control = '/__presale_short_sku/' + randomUUID();
  const stages = ['detail1888', 'checkout3776', 'cleared', 'recovered3776', 'checkout4250'];
  const traces: Row[] = [], evidence: Row[] = [], fixtureEdits: Row[] = [];
  let injectFailure = false, finished = false, done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Presale Browser forbids provider dispatch'));
  try {
    expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    const stamp = Math.floor(Date.now() / 1000);
    await f.db.insert(storeProduct).values({ id: 170, productType: 0, storeName: '预售短SKU样本', stock: 12,
      price: '17.00', isVerify: 1, isShow: 1, freight: 1, deliveryType: '1,2,3', isPresaleProduct: 1,
      presaleStartTime: stamp - 3600, presaleEndTime: stamp + 3600, presaleDay: 7,
      image: '/legacy/presale-short-sku.png' });
    await f.db.insert(storeProductAttrValue).values({ id: 170, productId: 170, productType: 0,
      unique: 'short7', suk: '短规格', stock: 12, price: '18.88', cost: '2.00', image: '/legacy/presale-short-sku.png' });
    const password = 'owned-presale-browser-account', appKey = 'owned-presale-browser-key';
    const [templateUser] = await f.db.select().from(user).where(eq(user.uid, 11));
    await f.db.insert(user).values({ ...templateUser, uid: buyerUid, account: 'owned-presale-' + buyerUid, pwd: password, integral: 100 });
    const [templateAddress] = await f.db.select().from(userAddress).where(eq(userAddress.id, 11));
    await f.db.insert(userAddress).values({ ...templateAddress, id: buyerUid, uid: buyerUid });
    const token = (await createToken(buyerUid, 'api', md5(password), appKey)).token;
    const env: typeof f.env = { ...f.env, APP_KEY: appKey, NODE_ENV: 'test' as typeof f.env.NODE_ENV, ASSETS_BUCKET: r2.bucket };
    wiring.container = createContainerFromDb(f.db);
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('public.store_cart','id'),(SELECT max(id) FROM public.store_cart),true)`);
    const [identity] = await f.db.execute(sql`SELECT "unique" AS raw_unique,octet_length("unique") AS bytes FROM public.store_product_attr_value WHERE id=170`);
    expect(identity).toMatchObject({ raw_unique: 'short7  ', bytes: 8 });
    expect(Object.keys(await refundEvidenceSnapshot(f.db))).toHaveLength(283); expect(await refundEvidenceSequences(f.db)).toHaveLength(229);
    const result = () => ({ kind, stages: evidence.map(row => row.stage), evidence, fixtureEdits, traces, finished,
      sku_identity: identity, buyer_uid: buyerUid, provider_calls: 0, order_creations: 0,
      production_grants_verified: false, login_and_chrome: 'synthetic local session/navigation; business APIs actual App/JWT/maintenance SQL' });
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const method = req.method!, path = url.pathname;
        const quote = method === 'POST' && (path === '/api/order/confirm' || /^\/api\/order\/computed\/[A-Za-z0-9_-]+$/.test(path));
        const read = method === 'GET' && ['/api/get_script', '/api/v2/diy/color_change/color_change', '/api/product/detail/170',
          '/api/cart/list', '/api/cart/count', '/api/address/list', '/api/store/list', '/api/coupons/order/0', '/api/payment/readiness'].includes(path);
        const add = method === 'POST' && path === '/api/cart/add';
        expect(read || quote || add, method + ' ' + path).toBe(true);
        if (path === '/api/product/detail/170') expect(url.searchParams.get('view')).toBe('presale');
        const before = await refundEvidenceSnapshot(f.db), sequences = await refundEvidenceSequences(f.db);
        const rawBody = await bytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const pending: Promise<unknown>[] = [];
        const context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext;
        const response = await app.fetch(new Request(origin + path + url.search, { method, headers,
          ...(rawBody.length ? { body: rawBody.toString('utf8') } : {}) }), env, context);
        await Promise.all(pending); const raw = Buffer.from(await response.arrayBuffer());
        expect(response.status, raw.toString()).toBe(200);
        const body = path === '/api/get_script' ? null : JSON.parse(raw.toString()); if (body) expect(body.status, body.msg).toBe(200);
        if (!add) { expect(await refundEvidenceSnapshot(f.db)).toEqual(before); expect(await refundEvidenceSequences(f.db)).toEqual(sequences); }
        else {
          expect(JSON.parse(rawBody.toString())).toMatchObject({ productId: 170, type: 6, unique: 'short7', cartNum: 2, new: 1 });
          const after = await refundEvidenceSnapshot(f.db), afterSequences = await refundEvidenceSequences(f.db);
          for (const table of Object.keys(before)) if (table !== 'store_cart') expect(after[table], table).toEqual(before[table]);
          for (const entry of sequences) if (entry.name !== 'store_cart_id_seq') expect(afterSequences.find(row => row.name === entry.name)).toEqual(entry);
          const [cart] = await f.db.select().from(storeCart).where(eq(storeCart.id, body.data.id));
          expect(cart).toMatchObject({ uid: buyerUid, productId: 170, productAttrUnique: 'short7', type: 6,
            activityId: 0, cartNum: 2, isNew: 1, isPay: 0 });
        }
        if (path === '/api/product/detail/170') expect(body.data.skus).toMatchObject([{ unique: 'short7', base_unique: 'short7', catalog_price: '18.88' }]);
        expect(r2.r2Reads).toEqual([]); expect(r2.r2Writes).toEqual([]); expect(r2.r2Deletes).toEqual([]);
        const quoted = quote ? body.data : null, prices = quoted ? quoted.priceGroup ?? quoted : null;
        const injected = injectFailure && quote;
        traces.push({ method, path, search: url.search, http: injected ? 503 : response.status, upstream_http: response.status,
          business_status: body?.status ?? null, ...(quote ? { priced: { priceGroup: { pay_price: prices.pay_price, total_price: prices.total_price },
            lines: quoted.cartInfo?.map((row: Row) => ({ productId: row.productId ?? row.product_id, cartNum: row.cartNum ?? row.cart_num })) } } : {}),
          ...(!add ? { all_public_tables_sequences_unchanged: true } : { only_new_cart_and_cart_sequence_changed: true }) });
        if (injected) return send(res, JSON.stringify({ status: 503, msg: '预售短SKU报价读取失败，请重试', data: null }), 503, 'application/json');
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        if (stage === 'inject503') { expect(evidence.map(row => row.stage)).toEqual(stages.slice(0, 2)); injectFailure = true; }
        else if (stage === 'price2125') {
          expect(evidence.map(row => row.stage)).toEqual(stages.slice(0, 4));
          await f.db.update(storeProductAttrValue).set({ price: '21.25' }).where(eq(storeProductAttrValue.id, 170));
          fixtureEdits.push({ source: 'owned maintenance price edit, not Admin UI', sku_id: 170, price: '21.25' });
        } else if (stage === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages); expect(fixtureEdits).toHaveLength(1);
          expect(traces.filter(row => row.path === '/api/cart/add')).toHaveLength(1);
          const quotes = traces.filter(row => row.priced);
          for (const price of ['37.76', '42.50']) expect(quotes.some(row => row.http === 200
            && row.priced.priceGroup.pay_price === price && row.priced.lines?.some((line: Row) => line.productId === 170 && line.cartNum === 2))).toBe(true);
          // Initial PC option watchers may overlap quote requests. Keep one
          // explicit outage phase until its failed DOM has been acknowledged.
          expect(quotes.filter(row => row.http === 503).length).toBeGreaterThanOrEqual(1);
          expect(await f.db.select().from(storeOrder).where(eq(storeOrder.uid, buyerUid))).toEqual([]);
          const [account] = await f.db.select().from(user).where(eq(user.uid, buyerUid)); expect(account.integral).toBe(100);
          const [product] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 170)); expect(product).toMatchObject({ stock: 12, sales: 0 });
          const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 170)); expect(sku).toMatchObject({ stock: 12, sales: 0 });
          finished = true; await writeFile('/tmp/cinashop-presale-short-sku-browser-' + kind + '-result.json', JSON.stringify({ ...result(),
            stock_and_points_unchanged: true, table_count: 283, sequence_count: 229 }, null, 2) + '\n');
        } else {
          expect(stage).toBe(stages[evidence.length]); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
          if (stage !== 'cleared') expect(data.text).toContain('预售短SKU样本');
          if (stage === 'detail1888') { expect(data.text).toContain('全款预售'); expect(data.text).toContain('18.88'); expect(data.text).toContain('短规格'); }
          else if (stage === 'cleared') {
            expect(data.text).toContain(kind === 'pc' ? '503' : '预售短SKU报价读取失败');
            expect(data.quoted_amount_count).toBe(0); expect(data.payable_text).toBe('待报价'); expect(data.submit_disabled).toBe(true);
            expect(traces.filter(row => row.http === 503).length).toBeGreaterThanOrEqual(1);
            injectFailure = false;
          } else {
            expect(data.text).toContain('确认订单'); expect(data.text).toContain(stage === 'checkout4250' ? '42.50' : '37.76');
            expect(data.quoted_amount_count).toBeGreaterThan(0); expect(data.payable_text).toContain(stage === 'checkout4250' ? '42.50' : '37.76');
            expect(data.submit_disabled).toBe(false); if (stage === 'checkout4250') expect(data.text).not.toContain('37.76');
            const location = new URL(data.href), route = kind === 'pc' ? location : new URL(location.hash.slice(1), origin);
            expect(route.pathname).toBe(kind === 'pc' ? '/checkout' : '/pages/order/confirm'); expect(route.searchParams.get('mode')).toBe('buy');
          }
          evidence.push({ stage, ...data });
        }
        json(res, { checked: evidence.map(row => row.stage), failure_pending: injectFailure,
          failed_quotes: traces.filter(row => row.http === 503).length, price_edits: fixtureEdits.length, finished }); if (finished) done();
      });
    }
    const enter = kind === 'pc' ? `sessionStorage.setItem('pc_token',${JSON.stringify(token)});sessionStorage.setItem('pc_uid','${buyerUid}');`
      : `localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:${buyerUid}}));`;
    const route = kind === 'pc' ? '/presale/170' : '/__presale_short_h5#/pages/activity/presaleDetail?id=170';
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${kind}预售短规格验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:${kind === 'pc' ? 1200 : 390}px;height:900px;border:1px solid #ddd}pre{max-height:45px;overflow:auto}</style><h1>${kind} 预售短 SKU：实际选购与报价</h1><p>本机合成会话；价格按钮仅修改本次自有数据库，不创建或支付订单。</p><button id="enter">进入实际预售</button><button id="reload">重新加载实际页面</button>${[...stages, 'inject503', 'price2125', 'finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{${enter}frame.src=${JSON.stringify(route)};};document.getElementById('reload').onclick=()=>frame.contentWindow.location.reload();for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,b=d.querySelector('.submit-btn,.submit-row button');const data={text:d.body.textContent,href:frame.contentWindow.location.href,submit_disabled:b?b.disabled||(b.hasAttribute('disabled')&&b.getAttribute('disabled')!=='false'):null,quoted_amount_count:d.querySelectorAll('.quote-prices,.price-row').length,payable_text:d.querySelector('.submit-row .total .price,.submit-bar .price')?.textContent.trim()??null,page_width:d.documentElement.clientWidth,page_scroll_width:d.documentElement.scrollWidth};const r=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=await r.text();};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (path === '/legacy/presale-short-sku.png' || path === '/logo.png') return send(res, Buffer.from(r2.png), 200, 'image/png');
      const chrome: Row = { '/api/site_config': { site_name: '本地预售验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地预售验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
        ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* SPA route */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned presale assertion failed: ' + String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('PRESALE_SHORT_SKU_BROWSER_READY ' + JSON.stringify({ kind, url: origin + control }) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
      expect(external).not.toHaveBeenCalled(); process.stdout.write('PRESALE_SHORT_SKU_BROWSER_RESULT ' + JSON.stringify({ kind, stages: evidence.map(row => row.stage), requests: traces.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
