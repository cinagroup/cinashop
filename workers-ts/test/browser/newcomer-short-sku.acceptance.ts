/** Actual built Admin -> H5, App/JWT and complete owned PG16 plus explicitly
 * installed cart-replay protocol. Session/navigation chrome is synthetic;
 * business outputs are real. No production commissioning or order/payment. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeCart, storeNewcomer, storeOrder, storeProduct, storeProductAttrValue, user } from '@/models/schema';
import { newcomerShortSkuFixture } from '../helpers/newcomerShortSku';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, opens: 0, closes: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned newcomer container absent'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Owned Admin session absent'); wiring.opens++;
    return { container: wiring.container, close: async () => { wiring.closes++; } }; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; expect(size).toBeLessThanOrEqual(65536); chunks.push(part); }
  return Buffer.concat(chunks);
}
it('actual Admin config saves a short base SKU and H5 recovers current newcomer prices', async () => {
  const f = await newcomerShortSkuFixture(), app = createApp();
  const roots = [resolve(import.meta.dirname, '../../../view/admin-ts/dist'), resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5')];
  const origin = 'http://127.0.0.1:40751', control = '/__newcomer_short_sku/' + randomUUID();
  const stages = ['admin-selected8', 'admin-saved8', 'admin-reloaded8', 'h5-detail8', 'h5-checkout8',
    'cleared', 'recovered8', 'admin-saved9', 'admin-reloaded9', 'h5-checkout9'];
  const traces: Row[] = [], evidence: Row[] = [], saves: Row[] = [];
  let injectFailure = false, finished = false, activityId = 0, activityUnique = '', done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Newcomer Browser forbids provider dispatch'));
  try {
    for (const root of roots) expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    // Explicit owned Browser fixture: one platform item, no shipping fee or gift.
    await f.db.update(storeProduct).set({ type: 0, relationId: 0, freight: 1, postage: '0.00', stock: 12,
      giveIntegral: '0.00', storeName: '新人短SKU样本', image: '/legacy/newcomer-short-sku.png' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ suk: '短规格', stock: 12, image: '/legacy/newcomer-short-sku.png' }).where(eq(storeProductAttrValue.id, 1));
    const [baseBefore] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    const [identity] = await f.db.execute(sql`SELECT "unique" AS raw_unique,octet_length("unique") AS bytes FROM public.store_product_attr_value WHERE id=1`);
    expect(identity).toMatchObject({ raw_unique: 'short7  ', bytes: 8 });
    wiring.container = f.container; wiring.opens = 0; wiring.closes = 0;
    await f.withInstalledReplay(async () => {
      expect(Object.keys(await f.snapshot())).toHaveLength(284); expect(await f.sequences()).toHaveLength(229);
      const result = () => ({ stages: evidence.map(row => row.stage), evidence, saves, traces, finished,
        sku_identity: identity, activity_id: activityId, activity_unique: activityUnique,
        public_table_count: 284, sequence_count: 229, explicit_owned_cart_replay_install: true,
        admin_sessions: { opened: wiring.opens, closed: wiring.closes },
        provider_calls: 0, order_creations: 0, payment_attempts: 0,
        production_grants_verified: false, php_runtime_verified: false,
        login_and_chrome: 'synthetic local session/navigation; business APIs actual App/JWT/owned maintenance SQL' });
      async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
        return serial(async () => {
          const method = req.method!, path = url.pathname;
          const quote = method === 'POST' && (path === '/api/order/confirm' || /^\/api\/order\/computed\/[A-Za-z0-9_-]+$/.test(path));
          const analytics = method === 'GET' && /^\/api\/marketing\/newcomer\/product_detail\/\d+$/.test(path);
          const save = method === 'POST' && path === '/adminapi/config/user/register';
          const add = method === 'POST' && path === '/api/cart/add/newcomer-replay';
          const read = method === 'GET' && ['/adminapi/config/user/register', '/adminapi/config/user/register/products',
            '/adminapi/config/user/register/coupons', '/api/get_script', '/api/v2/diy/color_change/color_change',
            '/api/marketing/newcomer/info', '/api/marketing/newcomer/product_list', '/api/v2/diy/product_detail',
            '/api/cart/add/newcomer-replay-key', '/api/cart/list', '/api/cart/count', '/api/address/list',
            '/api/store/list', '/api/coupons/order/0', '/api/payment/readiness'].includes(path)
            || method === 'GET' && /^\/api\/marketing\/newcomer\/product_detail\/\d+$/.test(path);
          expect(read || quote || save || add, method + ' ' + path).toBe(true);
          const before = await f.snapshot(), sequences = await f.sequences();
          const rawBody = await bytes(req), headers = new Headers();
          for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
          const pending: Promise<unknown>[] = [], context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext;
          const response = await app.fetch(new Request(origin + path + url.search, { method, headers,
            ...(rawBody.length ? { body: rawBody.toString('utf8') } : {}) }), f.env, context);
          await Promise.all(pending); const raw = Buffer.from(await response.arrayBuffer());
          expect(response.status, raw.toString()).toBe(200);
          const body = path === '/api/get_script' ? null : JSON.parse(raw.toString()); if (body) expect(body.status, body.msg).toBe(200);
          const after = await f.snapshot(), afterSequences = await f.sequences();
          const allowedTables = save ? ['system_config', 'cache', 'store_newcomer', 'store_product_attr_value']
            : add ? ['store_cart', 'newcomer_cart_add_replay'] : analytics ? ['store_product_log', 'store_visit'] : [];
          const allowedSequences = save ? ['system_config_id_seq', 'cache_id_seq', 'store_newcomer_id_seq', 'store_product_attr_value_id_seq']
            : add ? ['store_cart_id_seq'] : analytics ? ['store_product_log_id_seq', 'store_visit_id_seq'] : [];
          for (const table of Object.keys(before)) if (!allowedTables.includes(table)) expect(after[table], table).toEqual(before[table]);
          for (const entry of sequences) if (!allowedSequences.includes(entry.name)) expect(afterSequences.find(row => row.name === entry.name)).toEqual(entry);
          expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(baseBefore);
          if (save) {
            const input = JSON.parse(rawBody.toString()), price = saves.length === 0 ? '8.00' : '9.00';
            expect(saves.length).toBeLessThan(2); expect(input).toMatchObject({ newcomer_status: 1, register_price_status: 1,
              product: [{ product_id: 70, attr: [{ unique: 'short7', price }] }] });
            const selected = body.data.product.find((row: Row) => row.product_id === 70);
            expect(selected.attr).toMatchObject([{ unique: 'short7', price }]);
            const key = selected.attr[0].activity_unique; expect(key).toMatch(/^[a-zA-Z0-9]{8}$/);
            if (activityId) { expect(selected.id).toBe(activityId); expect(key).toBe(activityUnique); }
            activityId = selected.id; activityUnique = key;
            saves.push({ requested_base_unique: input.product[0].attr[0].unique, price, returned_base_unique: selected.attr[0].unique,
              activity_id: activityId, activity_unique: activityUnique });
          }
          if (add) {
            expect(evidence.map(row => row.stage)).toEqual(stages.slice(0, 4));
            const carts = await f.db.select().from(storeCart); const cart = carts.find(row => row.id > 2);
            expect(cart).toMatchObject({ uid: 11, productId: 70, productAttrUnique: 'short7', type: 7,
              activityId, cartNum: 1, isNew: 1, isPay: 0 }); expect(carts.filter(row => row.id > 2)).toHaveLength(1);
          }
          expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]);
          const quoted = quote ? body.data : null, prices = quoted ? quoted.priceGroup ?? quoted : null;
          const injected = injectFailure && quote;
          traces.push({ method, path, http: injected ? 503 : response.status, upstream_http: response.status,
            business_status: body?.status ?? null, ...(quote ? { priced: { pay_price: prices.pay_price, total_price: prices.total_price } } : {}),
            ...(allowedTables.length ? { only_allowed_tables_changed: allowedTables } : { all_public_tables_sequences_unchanged: true }) });
          if (injected) return send(res, JSON.stringify({ status: 503, msg: '新人短SKU报价读取失败，请重试', data: null }), 503, 'application/json');
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
        });
      }
      async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
        return serial(async () => {
          const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
          if (stage === 'inject503') { expect(evidence.map(row => row.stage)).toEqual(stages.slice(0, 5)); injectFailure = true; }
          else if (stage === 'finish') {
            expect(evidence.map(row => row.stage)).toEqual(stages); expect(saves).toHaveLength(2);
            expect(traces.filter(row => row.path === '/api/cart/add/newcomer-replay')).toHaveLength(1);
            for (const price of ['8.00', '9.00']) expect(traces.some(row => row.priced?.pay_price === price && row.http === 200)).toBe(true);
            expect(traces.some(row => row.http === 503)).toBe(true);
            expect(await f.db.select().from(storeOrder).where(eq(storeOrder.uid, 11))).toEqual([]);
            expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 100, isNewcomer: 0 });
            expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toMatchObject({ stock: 12, sales: 0 });
            expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(baseBefore);
            expect((await f.db.select().from(storeNewcomer).where(eq(storeNewcomer.id, activityId)))[0]).toBeDefined();
            expect(wiring.opens).toBeGreaterThan(0); expect(wiring.closes).toBe(wiring.opens); expect(external).not.toHaveBeenCalled();
            finished = true; await writeFile('/tmp/cinashop-newcomer-short-sku-browser-result.json', JSON.stringify({ ...result(),
              stock_points_and_eligibility_unchanged: true }, null, 2) + '\n');
          } else {
            expect(stage).toBe(stages[evidence.length]); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
            if (stage.startsWith('admin')) { expect(data.text).toContain('新人运营'); expect(data.text).toContain('新人短SKU样本');
              expect(data.inputs['新人专享价']).toBe(stage.endsWith('9') ? '9.00' : '8.00'); }
            else if (stage === 'h5-detail8') { expect(data.text).toContain('新人短SKU样本'); expect(data.text).toContain('新人价 ¥8.00');
              expect(data.text).toContain('短规格'); expect(data.purchase_disabled).toBe(false); }
            else if (stage === 'cleared') { expect(data.text).toContain('新人短SKU报价读取失败');
              expect(data.quoted_amount_count).toBe(0); expect(data.payable_text).toBe('待报价'); expect(data.submit_disabled).toBe(true); injectFailure = false; }
            else { const price = stage === 'h5-checkout9' ? '9.00' : '8.00';
              expect(data.text).toContain('确认订单'); expect(data.text).toContain('新人短SKU样本'); expect(data.payable_text).toContain(price);
              expect(data.quoted_amount_count).toBeGreaterThan(0); expect(data.submit_disabled).toBe(false);
              if (stage === 'h5-checkout9') expect(data.payable_text).not.toContain('8.00');
              const location = new URL(data.href); expect(location.origin).toBe(origin);
              expect(new URL(location.hash.slice(1), origin).pathname).toBe('/pages/order/confirm'); }
            evidence.push({ stage, ...data });
          }
          json(res, { checked: evidence.map(row => row.stage), activity_id: activityId, failure_pending: injectFailure, finished }); if (finished) done();
        });
      }
      const session = { userInfo: { id: f.adminId, account: '本机新人验收', head_pic: '', real_name: '本地合成数据', level: 1, roles: String(f.adminRoleId) },
        menus: [{ id: 901, pid: 0, path: '/config/newcomer', name: '新人运营', icon: '', sort: 1, type: 1, children: [] }], uniqueAuth: ['config.view', 'config.manage'] };
      const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>新人短SKU联合验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1200px;height:900px;border:1px solid #ddd}pre{max-height:70px;overflow:auto}</style><h1>新人短 SKU：后台配置与实际H5选购</h1><p>本机合成会话；仅操作自有数据库，结算停在报价。</p><button id="admin">进入实际后台</button><button id="h5">进入实际H5</button><button id="checkout">返回实际结算</button><button id="reload">重新加载实际页面</button>${[...stages, 'inject503', 'finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');let campaignId=0,checkoutHref='';document.getElementById('admin').onclick=()=>{localStorage.setItem('admin_token',${JSON.stringify(f.adminToken)});localStorage.setItem('admin_session',${JSON.stringify(JSON.stringify(session))});frame.style.width='1200px';frame.src='/config/newcomer';};document.getElementById('h5').onclick=()=>{if(!campaignId)throw Error('Actual Admin save required');localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.style.width='390px';frame.src='/__newcomer_h5#/pages/activity/newcomerDetail?id='+campaignId;};document.getElementById('checkout').onclick=()=>{if(!checkoutHref)throw Error('Actual checkout receipt absent');frame.style.width='390px';frame.src=checkoutHref;};document.getElementById('reload').onclick=()=>frame.contentWindow.location.reload();for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,b=d.querySelector('.submit-btn,.submit-row button'),p=d.querySelector('.purchase');const data={text:d.body.textContent,href:frame.contentWindow.location.href,inputs:Object.fromEntries([...d.querySelectorAll('input[aria-label]')].map(x=>[x.getAttribute('aria-label'),x.value])),submit_disabled:b?b.disabled||(b.hasAttribute('disabled')&&b.getAttribute('disabled')!=='false'):null,purchase_disabled:p?p.disabled||(p.hasAttribute('disabled')&&p.getAttribute('disabled')!=='false'):null,quoted_amount_count:d.querySelectorAll('.quote-prices,.price-row').length,payable_text:d.querySelector('.submit-row .total .price,.submit-bar .price')?.textContent.trim()??null,page_width:d.documentElement.clientWidth,page_scroll_width:d.documentElement.scrollWidth};const r=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await r.json();campaignId=result.activity_id||campaignId;if(result.checked?.includes('h5-checkout8')&&button.dataset.stage==='h5-checkout8')checkoutHref=data.href;document.getElementById('result').textContent=JSON.stringify(result);};</script></html>`;
      const server = createServer((req, res) => { void (async () => {
        if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
        const url = new URL(req.url ?? '/', origin), path = url.pathname;
        if (path === control && req.method === 'GET') return send(res, shell());
        if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
        if (['/legacy/newcomer-short-sku.png', '/logo.png', '/api/qa/image.svg'].includes(path)) return send(res, Buffer.from(f.png), 200, 'image/png');
        const chrome: Row = { '/api/site_config': { site_name: '本地新人验收', site_logo: '', record_No: '', ico_path: '' },
          '/api/share': { title: '本地新人验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] },
          '/adminapi/new_push': { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now()/1000) } };
        if (req.method === 'GET' && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
        if (path.startsWith('/api/') || path.startsWith('/adminapi/')) return api(req, res, url);
        if (path === '/favicon.ico') return send(res, '', 204);
        for (const root of roots) {
          const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
          try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
            ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* next build or SPA */ }
        }
        send(res, await readFile(resolve(roots[path === '/__newcomer_h5' ? 1 : 0]!, 'index.html')));
      })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned newcomer assertion failed: ' + String(error), 500); else res.destroy(); }); });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
        process.stdout.write('NEWCOMER_SHORT_SKU_BROWSER_READY ' + JSON.stringify({ url: origin + control }) + '\n');
        deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
        expect(external).not.toHaveBeenCalled(); process.stdout.write('NEWCOMER_SHORT_SKU_BROWSER_RESULT ' + JSON.stringify({ stages: evidence.map(row => row.stage), requests: traces.length }) + '\n');
      } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
    });
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
