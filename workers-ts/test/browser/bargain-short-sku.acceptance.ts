/** Built Admin/PC/H5, actual App/JWT, owned PG16. The absent friend UI is
 * explicitly bridged by helper22's actual JWT API; no SQL ready-state stub.
 * Quotes only: Browser does not create orders or invoke providers. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeBargain, storeBargainUser, storeBargainUserHelp, storeCart, storeOrder,
  storeProduct, storeProductAttrValue, user } from '@/models/schema';
import { bargainShortSkuRuntimeFixture } from '../helpers/bargainShortSkuRuntime';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, opens: 0, closes: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned bargain App absent'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Owned bargain Admin absent'); wiring.opens++;
    return { container: wiring.container, close: async () => { wiring.closes++; } }; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const part = Buffer.from(chunk); size += part.length; expect(size).toBeLessThanOrEqual(768000); chunks.push(part); }
  return Buffer.concat(chunks);
}
it('actual Admin short base bargain, PC start, H5 self-help and disclosed friend API preserve frozen quotes', async () => {
  const f = await bargainShortSkuRuntimeFixture(), app = createApp();
  const roots = [resolve(import.meta.dirname, '../../../view/admin-ts/dist'), resolve(import.meta.dirname, '../../../view/pc-ts/dist'),
    resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5')];
  const origin = 'http://127.0.0.1:40751', control = '/__bargain_short_sku/' + randomUUID();
  const stages = ['admin-selected10', 'admin-saved10', 'admin-reloaded10', 'pc-unjoined', 'pc-started', 'h5-self-cut',
    'helper-api-ready', 'pc-ready2', 'pc-checkout2', 'pc-cleared', 'pc-recovered2', 'h5-ready2', 'h5-checkout2',
    'h5-cleared', 'h5-recovered2', 'admin-saved20', 'admin-reloaded20', 'pc-still2', 'h5-still2'];
  const traces: Row[] = [], evidence: Row[] = [], saves: Row[] = [];
  let injectFailure = false, finished = false, activityId = 0, participantId = 0, activityUnique = '';
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Bargain Browser forbids providers'));
  try {
    for (const root of roots) expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    await f.db.update(storeProduct).set({ storeName: '砍价短SKU样本' }).where(eq(storeProduct.id, 70));
    const [baseBefore] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    const [identity] = await f.db.execute(sql`SELECT "unique" AS raw_unique,octet_length("unique") AS bytes FROM store_product_attr_value WHERE id=1`);
    expect(identity).toMatchObject({ raw_unique: 'short7  ', bytes: 8 });
    wiring.container = f.container; wiring.opens = 0; wiring.closes = 0;
    expect(Object.keys(await f.snapshot())).toHaveLength(283); expect(await f.sequences()).toHaveLength(229);
    const result = () => ({ stages: evidence.map(row => row.stage), evidence, saves, traces, finished,
      sku_identity: identity, activity_id: activityId, participant_id: participantId, activity_unique: activityUnique,
      public_table_count: 283, sequence_count: 229, admin_sessions: { opened: wiring.opens, closed: wiring.closes },
      provider_calls: 0, order_creations: 0, payment_attempts: 0, production_grants_verified: false, php_runtime_verified: false,
      friend_ui_verified: false, friend_help_bridge: 'actual createApp/JWT helper22 API, not friend UI',
      authority: 'actual createApp/JWT injected owned maintenance SQL; synthetic navigation/session chrome; no LOGIN claim for Browser' });
    async function dispatch(method: string, path: string, search: string, rawBody: Awaited<ReturnType<typeof bytes>>, headers: Headers, bridge = false) {
      const quote = method === 'POST' && (path === '/api/order/confirm' || /^\/api\/order\/computed\/[A-Za-z0-9_-]+$/.test(path));
      const shippingRead = method === 'POST' && path === '/api/order/check_shipping';
      if (shippingRead) expect(JSON.parse(rawBody.toString())).toMatchObject({ view: 'bargain', cartIds: [expect.any(Number)] });
      const save = method === 'POST' && path === '/adminapi/activity/save';
      const add = method === 'POST' && path === '/api/cart/add';
      const start = method === 'POST' && path === '/api/bargain/start';
      const help = method === 'POST' && path === '/api/bargain/help';
      const read = method === 'GET' && (['/adminapi/activity/bargain', '/adminapi/activity/bargain/sku-options',
        '/api/get_script', '/api/v2/diy/color_change/color_change', '/api/v2/diy/product_detail', '/api/cart/list',
        '/api/cart/count', '/api/address/list', '/api/store/list', '/api/coupons/order/0', '/api/payment/readiness'].includes(path) ||
        /^\/api\/bargain\/detail\/[1-9]\d*$/.test(path) && new URLSearchParams(search).get('view') === 'skus');
      expect(read || shippingRead || quote || save || add || start || help, method + ' ' + path).toBe(true);
      const before = await f.snapshot(), sequences = await f.sequences(), pending: Promise<unknown>[] = [];
      const context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext;
      const response = await app.fetch(new Request(origin + path + search, { method, headers,
        ...(rawBody.length ? { body: rawBody.toString('utf8') } : {}) }), f.env, context);
      await Promise.all(pending); const raw = Buffer.from(await response.arrayBuffer()); expect(response.status, raw.toString()).toBe(200);
      const body = path === '/api/get_script' ? null : JSON.parse(raw.toString()); if (body) expect(body.status, body.msg).toBe(200);
      const after = await f.snapshot(), afterSequences = await f.sequences();
      const allowedTables = save ? ['store_bargain', 'store_product_attr_value', 'store_product_attr', 'store_product_attr_result',
        'store_product_description', 'system_log'] : add ? ['store_cart'] : start ? ['store_bargain_user'] : help ? ['store_bargain_user', 'store_bargain_user_help'] : [];
      const allowedSequences = save ? allowedTables.map(table => table + '_id_seq') : add ? ['store_cart_id_seq'] :
        start ? ['store_bargain_user_id_seq'] : help ? ['store_bargain_user_help_id_seq'] : [];
      for (const table of Object.keys(before)) if (!allowedTables.includes(table)) expect(after[table], table).toEqual(before[table]);
      for (const entry of sequences) if (!allowedSequences.includes(entry.name)) expect(afterSequences.find(row => row.name === entry.name)).toEqual(entry);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(baseBefore);
      if (save) {
        const input = JSON.parse(rawBody.toString()), price = saves.length === 0 ? '10.00' : '20.00'; expect(saves.length).toBeLessThan(2);
        expect(input).toMatchObject({ type: 'bargain', price, sku: { baseUnique: 'short7' } });
        const id = Number(body.data.id), [activity] = await f.db.select().from(storeBargain).where(eq(storeBargain.id, id));
        expect(activity).toMatchObject({ productId: 70, status: 1, stock: 6, quota: 5, price, minPrice: saves.length ? '5.00' : '2.00', people: 2 });
        const skus = await f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 2)));
        expect(skus).toHaveLength(1); const key = skus[0]!.unique; expect(key).toMatch(/^[a-f0-9]{8}$/); expect(key).not.toBe('short7');
        if (activityId) { expect(id).toBe(activityId); expect(key).toBe(activityUnique); }
        activityId = id; activityUnique = key; saves.push({ method, requested_base_unique: input.sku.baseUnique, price, activity_id: id, activity_unique: key });
      }
      if (start) { participantId = Number(body.data.id); expect(participantId).toBeGreaterThan(100); expect(participantId).not.toBe(activityId); }
      if (add) {
        expect(JSON.parse(rawBody.toString())).toMatchObject({ productId: 70, unique: activityUnique, cartNum: 1, activityId, type: 2, bargainUserId: participantId });
        expect((await f.db.select().from(storeCart).where(eq(storeCart.id, body.data.cartId)))[0]).toMatchObject({ uid: 11, productId: 70,
          productAttrUnique: 'short7  ', type: 2, activityId, bargainUserId: participantId, cartNum: 1, isNew: 1, isPay: 0 });
      }
      expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]);
      const prices = quote ? body.data.priceGroup ?? body.data : null, injected = injectFailure && quote;
      if (quote) expect(prices).toMatchObject({ pay_price: '2.00', total_price: '2.00' });
      traces.push({ method, path, http: injected ? 503 : response.status, upstream_http: response.status, business_status: body?.status ?? null,
        ...(bridge ? { disclosed_friend_api_bridge: true } : {}), ...(quote ? { priced: { pay_price: prices.pay_price, total_price: prices.total_price } } : {}),
        ...(allowedTables.length ? { only_allowed_tables_changed: allowedTables } : { all_public_tables_sequences_unchanged: true }) });
      return { response, raw, injected };
    }
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const { response, raw, injected } = await dispatch(req.method!, url.pathname, url.search, await bytes(req), headers);
        if (injected) return send(res, JSON.stringify({ status: 503, msg: '砍价短SKU报价读取失败，请重试', data: null }), 503, 'application/json');
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        if (stage === 'inject503') { expect(['pc-checkout2', 'h5-checkout2']).toContain(evidence.at(-1)?.stage); injectFailure = true; }
        else if (stage === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages); expect(saves).toHaveLength(2);
          expect(traces.filter(row => row.path === '/api/cart/add')).toHaveLength(2);
          expect(traces.filter(row => row.path === '/api/bargain/start')).toHaveLength(1);
          expect(traces.filter(row => row.path === '/api/bargain/help')).toHaveLength(2);
          expect(traces.filter(row => row.disclosed_friend_api_bridge)).toHaveLength(1);
          expect(traces.filter(row => row.http === 503).length).toBeGreaterThanOrEqual(2);
          expect(await f.db.select().from(storeOrder).where(eq(storeOrder.uid, 11))).toEqual([]);
          expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 100 });
          expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toMatchObject({ stock: 12, sales: 0 });
          expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId)))[0])
            .toMatchObject({ uid: 11, bargainId: activityId, status: 3, bargainPrice: '10.00', bargainPriceMin: '2.00', price: '8.00' });
          const helps = await f.db.select().from(storeBargainUserHelp).where(eq(storeBargainUserHelp.bargainUserId, participantId)).orderBy(storeBargainUserHelp.id);
          expect(helps).toHaveLength(2); expect(helps[0]).toMatchObject({ uid: 11, type: 1 }); expect(helps[1]).toMatchObject({ uid: 22, type: 0 });
          expect(wiring.opens).toBeGreaterThan(0); expect(wiring.closes).toBe(wiring.opens); expect(external).not.toHaveBeenCalled();
          finished = true; await writeFile('/tmp/cinashop-bargain-short-sku-browser-result.json', JSON.stringify(result(), null, 2) + '\n');
        } else {
          expect(stage).toBe(stages[evidence.length]); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
          if (stage === 'helper-api-ready') {
            const [record] = await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId)); expect(record.status).toBe(1);
            await dispatch('POST', '/api/bargain/help', '', Buffer.from(JSON.stringify({ bargain_user_id: participantId })),
              new Headers({ Authorization: 'Bearer ' + f.helperToken, 'Content-Type': 'application/json' }), true);
            expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId)))[0]).toMatchObject({ status: 3, price: '8.00' });
          } else if (stage.startsWith('admin')) {
            expect(data.text).toContain('营销活动');
            if (stage.includes('selected') || stage.includes('reloaded')) {
              expect(data.input_values).toContain('砍价短SKU样本');
              expect(data.input_values).toContain(stage.endsWith('20') ? '20.00' : '10.00');
            } else expect(data.text).toContain('砍价短SKU样本');
          } else if (stage === 'pc-unjoined' || stage === 'pc-started' || stage === 'h5-self-cut') {
            expect(data.text).toContain('砍价短SKU样本'); expect(data.purchase_disabled).toBe(true);
            if (stage === 'pc-unjoined') expect(data.text).toContain('发起砍价');
            else { expect(participantId).toBeGreaterThan(100); expect(data.text).toContain('砍价中'); }
          } else if (stage.includes('ready')) {
            expect(data.text).toContain('砍价短SKU样本'); expect(data.text).toContain('短规格'); expect(data.text).toContain('2.00');
            expect(data.purchase_disabled).toBe(false); expect(data.selected_skus).toBe(1);
          } else if (stage.endsWith('cleared')) {
            expect(data.text).toContain(stage.startsWith('pc') ? 'Request failed with status code 503' : '砍价短SKU报价读取失败');
            expect(data.quoted_amount_count).toBe(0); expect(data.payable_text).toBe('待报价'); expect(data.submit_disabled).toBe(true); injectFailure = false;
          } else {
            expect(data.text).toContain('确认订单'); expect(data.text).toContain('砍价短SKU样本'); expect(data.payable_text).toContain('2.00');
            expect(data.quoted_amount_count).toBeGreaterThan(0); expect(data.submit_disabled).toBe(false);
            const location = new URL(data.href); expect(location.origin).toBe(origin);
            if (stage.startsWith('h5')) expect(new URL(location.hash.slice(1), origin).pathname).toBe('/pages/order/confirm'); else expect(location.pathname).toBe('/checkout');
          }
          evidence.push({ stage, ...data });
        }
        json(res, { checked: evidence.map(row => row.stage), activity_id: activityId, participant_id: participantId, failure_pending: injectFailure, finished }); if (finished) done();
      });
    }
    const session = { userInfo: { id: f.adminId, account: '本机砍价验收', head_pic: '', real_name: '本地合成数据', level: 1, roles: String(f.adminRoleId) },
      menus: [{ id: 901, pid: 0, path: '/activity?tab=bargain', name: '营销活动', icon: '', sort: 1, type: 1, children: [] }], uniqueAuth: ['activity.view', 'activity.manage'] };
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>砍价短SKU联合验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1200px;height:600px;border:1px solid #ddd}pre{max-height:45px;overflow:auto}</style><h1>砍价短 SKU：实际后台、PC、H5</h1><p>本机合成会话；朋友 UI 缺口使用真实 helper22 JWT API 桥接；结算停在报价。</p><button id="admin">进入实际后台</button><button id="pc">进入实际PC</button><button id="h5">进入实际H5</button><button id="pcCheckout">返回PC结算</button><button id="h5Checkout">返回H5结算</button><button id="reload">重新加载实际页面</button>${[...stages, 'inject503', 'finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');let campaignId=0,recordId=0,pcCheckout='',h5Checkout='';document.getElementById('admin').onclick=()=>{localStorage.setItem('admin_token',${JSON.stringify(f.adminToken)});localStorage.setItem('admin_session',${JSON.stringify(JSON.stringify(session))});frame.style.width='1200px';frame.src='/activity?tab=bargain';};document.getElementById('pc').onclick=()=>{if(!campaignId)throw Error('Actual Admin save required');sessionStorage.setItem('pc_token',${JSON.stringify(f.token)});sessionStorage.setItem('pc_uid','11');frame.style.width='1200px';frame.src='/bargain/'+campaignId+(recordId?'?bargainUserId='+recordId:'');};document.getElementById('h5').onclick=()=>{if(!campaignId)throw Error('Actual Admin save required');localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.style.width='390px';frame.src='/__bargain_h5#/pages/activity/bargainDetail?id='+campaignId+'&bargainUserId='+recordId;};document.getElementById('pcCheckout').onclick=()=>{frame.style.width='1200px';frame.src=pcCheckout;};document.getElementById('h5Checkout').onclick=()=>{frame.style.width='390px';frame.src=h5Checkout;};document.getElementById('reload').onclick=()=>frame.contentWindow.location.reload();for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,b=d.querySelector('.submit-btn,.submit-row button'),p=d.querySelector('.buy-btn')??[...d.querySelectorAll('button')].find(x=>['用本条参与购买','继续结算'].includes(x.textContent.trim()));const data={text:d.body.textContent,href:frame.contentWindow.location.href,input_values:[...d.querySelectorAll('input')].map(x=>x.value),submit_disabled:b?b.disabled||(b.hasAttribute('disabled')&&b.getAttribute('disabled')!=='false'):null,purchase_disabled:p?p.disabled||(p.hasAttribute('disabled')&&p.getAttribute('disabled')!=='false'):null,selected_skus:d.querySelectorAll('.sku[aria-pressed="true"],.sku.selected').length,quoted_amount_count:d.querySelectorAll('.quote-prices,.price-row').length,payable_text:d.querySelector('.submit-row .total .price,.submit-bar .price')?.textContent.trim()??null,page_width:d.documentElement.clientWidth,page_scroll_width:d.documentElement.scrollWidth};const r=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),result=await r.json();campaignId=result.activity_id||campaignId;recordId=result.participant_id||recordId;if(button.dataset.stage==='pc-checkout2')pcCheckout=data.href;if(button.dataset.stage==='h5-checkout2')h5Checkout=data.href;document.getElementById('result').textContent=JSON.stringify(result);};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (['/legacy/bargain-short-sku.png', '/logo.png', '/api/qa/image.svg'].includes(path)) return send(res, Buffer.from(f.png), 200, 'image/png');
      const chrome: Row = { '/api/site_config': { site_name: '本地砍价验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地砍价验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] },
        '/adminapi/new_push': { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now()/1000) } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
      if (path.startsWith('/api/') || path.startsWith('/adminapi/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      for (const root of roots) {
        const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
        try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
          ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* next build or SPA */ }
      }
      send(res, await readFile(resolve(roots[path === '/__bargain_h5' ? 2 : path === '/activity' ? 0 : 1]!, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned bargain assertion failed: ' + String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('BARGAIN_SHORT_SKU_BROWSER_READY ' + JSON.stringify({ url: origin + control }) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
      expect(external).not.toHaveBeenCalled(); process.stdout.write('BARGAIN_SHORT_SKU_BROWSER_RESULT ' + JSON.stringify({ stages: evidence.map(row => row.stage), requests: traces.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
