/** Installed-browser interaction host: actual Admin/H5 builds and App/JWT/PG16.
 * Login/navigation chrome and a local raster are explicit fixtures. No payment,
 * production role provisioning, complete history or automated rendered claim. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { storeCart, storeIntegral, storeOrder, storeProduct, storeProductAttrValue, systemAdmin, systemRole, user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { refundRuntimeFixture } from '../helpers/refundRuntimeFixture';
import { refundEvidenceR2, refundEvidenceSequences, refundEvidenceSnapshot } from '../helpers/refundApplicationEvidence';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned integral container absent'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Owned Admin session absent'); return { container: wiring.container, close: async () => {} }; },
}));
type Row = Record<string, any>;
async function requestBytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; expect(size).toBeLessThanOrEqual(65536); chunks.push(bytes); }
  return Buffer.concat(chunks);
}
it('actual Admin signed caps reach H5 controls and real cart/checkout preview', async () => {
  const f = await refundRuntimeFixture(), app = createApp(), r2 = refundEvidenceR2();
  const roots = [resolve(import.meta.dirname, '../../../view/admin-ts/dist'), resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5')];
  const origin = 'http://127.0.0.1:40751', control = '/__integral_limits/' + randomUUID();
  const stages = ['admin-unlimited', 'h5-unlimited', 'admin-zero', 'h5-zero', 'admin-finite', 'h5-finite', 'checkout'];
  const traces: Row[] = [], evidence: Row[] = [], saves: Row[] = [];
  let finished = false, stockAndPointsVerified = false, complete!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { complete = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider dispatch in local integral limits Browser'));
  try {
    for (const root of roots) expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    await f.db.insert(storeProduct).values({ id: 170, productType: 2, storeName: '积分限购样本', stock: 12,
      price: '0.00', isVerify: 1, isShow: 1, freight: 1, image: '/legacy/integral-limits.png' });
    await f.db.insert(storeIntegral).values({ id: 170, productId: 170, productType: 2, storeName: '积分限购样本',
      image: '/legacy/integral-limits.png', price: '0.00', integral: 10, stock: 12, quota: 12, quotaShow: 12,
      onceNum: 0, num: 0, status: 1, isShow: 1 });
    await f.db.insert(storeProductAttrValue).values([
      { id: 170, productId: 170, productType: 2, unique: 'lims0170', suk: '默认', stock: 12, price: '0.00', cost: '2.00' },
      { id: 171, productId: 170, productType: 2, type: 4, unique: 'lima0170', suk: '默认', stock: 12,
        quota: 12, price: '0.00', cost: '2.00', integral: 10, image: '/legacy/integral-limits.png' },
    ]);
    const password = 'owned-integral-limits-account', appKey = 'owned-integral-limits-key';
    await f.db.update(user).set({ pwd: password, integral: 100 }).where(eq(user.uid, 11));
    await f.db.insert(systemRole).values({ id: 170, roleName: 'Owned activity editor', rules: 'activity.manage' });
    await f.db.insert(systemAdmin).values({ id: 170, account: 'owned-integral-limits-admin', pwd: password, roles: '170', level: 1 });
    const adminToken = (await createToken(170, 'admin', md5(password), appKey)).token;
    const buyerToken = (await createToken(11, 'api', md5(password), appKey)).token;
    const env: typeof f.env = { ...f.env, APP_KEY: appKey, NODE_ENV: 'test' as typeof f.env.NODE_ENV, ASSETS_BUCKET: r2.bucket };
    wiring.container = createContainerFromDb(f.db);
    // The shared quote fixture inserts carts 1/2 explicitly. Advance only its
    // owned cart sequence before the real browser add requests the next ID.
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('public.store_cart','id'),
      (SELECT MAX(id) FROM public.store_cart), true)`);
    const caps = async () => { const [row] = await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, 170)); return { onceNum: row.onceNum, num: row.num }; };
    const result = () => ({ stages: evidence.map(row => row.stage), evidence, saves, traces, finished, stock_and_points_unchanged: stockAndPointsVerified,
      provider_calls: 0, payment_attempts: 0, login_and_chrome: 'synthetic local navigation; all business APIs real App/JWT/maintenance SQL',
      historical_coverage_complete: false, production_grants_verified: false });
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const method = req.method!, path = url.pathname;
        const allowed = method === 'GET' || method === 'POST' && ['/adminapi/activity/save', '/api/cart/add', '/api/order/confirm'].includes(path)
          || method === 'POST' && /^\/api\/order\/computed\/[A-Za-z0-9_-]+$/.test(path);
        expect(allowed, method + ' ' + path).toBe(true);
        const before = await refundEvidenceSnapshot(f.db), sequences = await refundEvidenceSequences(f.db);
        const bytes = await requestBytes(req), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const pending: Promise<unknown>[] = [];
        const context = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext;
        const response = await app.fetch(new Request(origin + path + url.search, { method, headers, ...(bytes.length ? { body: bytes.toString('utf8') } : {}) }), env, context);
        await Promise.all(pending);
        const raw = Buffer.from(await response.arrayBuffer());
        expect(response.status, raw.toString()).toBe(200);
        const body = path === '/api/get_script' ? null : JSON.parse(raw.toString());
        if (body) expect(body.status, body.msg).toBe(200);
        const analytics = path === '/api/product/detail/170';
        const readonly = method === 'GET' && !analytics || path === '/api/order/confirm' || path.startsWith('/api/order/computed/');
        if (readonly) { expect(await refundEvidenceSnapshot(f.db)).toEqual(before); expect(await refundEvidenceSequences(f.db)).toEqual(sequences); }
        // Ordinary detail also loads collection state and records a real visit.
        // Await its actual waitUntil work; do not label this GET read-only.
        if (analytics) {
          const after = await refundEvidenceSnapshot(f.db), afterSequences = await refundEvidenceSequences(f.db);
          for (const table of Object.keys(before)) if (!['store_product_log', 'store_visit'].includes(table)) expect(after[table]).toEqual(before[table]);
          expect(afterSequences.filter(row => !/store_product_log|store_visit/.test(row.name))).toEqual(sequences.filter(row => !/store_product_log|store_visit/.test(row.name)));
        }
        if (path === '/adminapi/activity/save') {
          const input = JSON.parse(bytes.toString()); expect(input).toMatchObject({ type: 'integral', id: 170 });
          const expected = [{ onceNum: -1, num: -1 }, { onceNum: 0, num: -1 }, { onceNum: 1, num: 1 }][saves.length];
          expect(expected).toBeDefined(); expect(await caps()).toEqual(expected); expect(input).toMatchObject(expected!);
          saves.push({ requested: { onceNum: input.onceNum, num: input.num }, persisted: await caps() });
        }
        if (path === '/api/cart/add') {
          expect(evidence.map(row => row.stage)).toEqual(stages.slice(0, 6));
          expect(JSON.parse(bytes.toString())).toMatchObject({ type: 4, activityId: 170, cartNum: 1 });
          const [cart] = await f.db.select().from(storeCart).where(eq(storeCart.id, body.data.id));
          expect(cart).toMatchObject({ uid: 11, productId: 170, type: 4, activityId: 170, cartNum: 1, isNew: 1, isPay: 0 });
        }
        expect(r2.r2Reads).toEqual([]); expect(r2.r2Writes).toEqual([]); expect(r2.r2Deletes).toEqual([]);
        traces.push({ method, path, http: response.status, business_status: body?.status ?? null,
          ...(readonly ? { all_public_tables_sequences_unchanged: true } : analytics ? { expected_analytics_tables: ['store_product_log', 'store_visit'] } : {}) });
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await requestBytes(req)).toString());
        if (stage === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages); expect(saves).toHaveLength(3);
          expect(traces.filter(row => row.path === '/api/cart/add')).toHaveLength(1);
          expect(traces.some(row => row.path === '/api/order/confirm')).toBe(true);
          expect(await f.db.select().from(storeOrder).where(eq(storeOrder.activityId, 170))).toEqual([]);
          const [account] = await f.db.select().from(user).where(eq(user.uid, 11)); expect(account.integral).toBe(100);
          const [product] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 170)); expect(product).toMatchObject({ stock: 12, sales: 0 });
          const [activity] = await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, 170)); expect(activity).toMatchObject({ stock: 12, quota: 12, sales: 0 });
          const skus = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, 170));
          expect(skus).toHaveLength(2); expect(skus.every(row => row.stock === 12 && row.sales === 0)).toBe(true);
          stockAndPointsVerified = true;
          expect(await caps()).toEqual({ onceNum: 1, num: 1 }); expect(external).not.toHaveBeenCalled();
          finished = true;
          await writeFile('/tmp/cinashop-integral-limits-browser-result.json', JSON.stringify({ ...result(),
            public_table_count: Object.keys(await refundEvidenceSnapshot(f.db)).length,
            sequence_count: (await refundEvidenceSequences(f.db)).length }, null, 2) + '\n');
        } else {
          expect(stage).toBe(stages[evidence.length]); expect(data.text).toContain(stage === 'checkout' ? '确认订单' : stage.startsWith('admin') ? '编辑活动' : '积分限购样本');
          expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
          const expected = stage.includes('unlimited') ? { onceNum: -1, num: -1 } : stage.includes('zero') ? { onceNum: 0, num: -1 } : { onceNum: 1, num: 1 };
          expect(await caps()).toEqual(expected);
          if (stage.startsWith('admin')) expect(data.inputs).toMatchObject({ '每单购买上限': String(expected.onceNum), '累计购买上限': String(expected.num) });
          if (stage === 'h5-unlimited') { expect(data.text).toContain('每单不限件数'); expect(data.text).toContain('每人累计不限件数'); expect(data.buy_disabled).toBe(false); }
          if (stage === 'h5-zero') { expect(data.text).toContain('上限为0，暂不可兑换'); expect(data.buy_disabled).toBe(true); expect(traces.some(row => row.path === '/api/cart/add')).toBe(false); }
          if (stage === 'h5-finite') { expect(data.text).toContain('每单限兑 1 件'); expect(data.text).toContain('本次最多 1 件'); expect(data.buy_disabled).toBe(false); }
          if (stage === 'checkout') { expect(data.text).toContain('积分限购样本'); expect(data.text).toContain('10'); expect(traces.some(row => row.path === '/api/order/confirm')).toBe(true); }
          evidence.push({ stage, ...data });
        }
        json(res, { checked: evidence.map(row => row.stage), finished }); if (finished) complete();
      });
    }
    const session = { userInfo: { id: 170, account: '本机积分限购验收', head_pic: '', real_name: '本地合成数据', level: 1, roles: '170' },
      menus: [{ id: 170, pid: 0, path: '/activity', name: '营销活动', icon: '', sort: 1, type: 1, children: [] }], uniqueAuth: ['activity.view', 'activity.manage'] };
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>积分限购联合验收</title><style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:1200px;height:900px;border:1px solid #ddd}pre{max-height:45px;overflow:auto}</style><h1>积分限购：后台设置与H5选购</h1><button id="admin">进入实际后台</button><button id="h5">进入实际H5</button>${[...stages,'finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('admin').onclick=()=>{localStorage.setItem('admin_token',${JSON.stringify(adminToken)});localStorage.setItem('admin_session',${JSON.stringify(JSON.stringify(session))});frame.style.width='1200px';frame.src='/activity?tab=integral';};document.getElementById('h5').onclick=()=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(buyerToken)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.style.width='390px';frame.src='/__integral_h5#/pages/activity/integralDetail?id=170';};for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,b=d.querySelector('.buy-button');const data={text:d.body.textContent,href:frame.contentWindow.location.href,inputs:Object.fromEntries([...d.querySelectorAll('input[aria-label]')].map(x=>[x.getAttribute('aria-label'),x.value])),buy_disabled:b?b.disabled||b.getAttribute('disabled')!==null:null,page_width:d.documentElement.clientWidth,page_scroll_width:d.documentElement.scrollWidth};const r=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=await r.text();};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (path === '/legacy/integral-limits.png' || path === '/logo.png') return send(res, Buffer.from(r2.png), 200, 'image/png');
      const chrome: Row = { '/api/site_config': { site_name: '本地积分验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地积分验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] },
        '/adminapi/new_push': { ordernum: 0, inventory: 0, commentnum: 0, reflectnum: 0, msgcount: 0, sampled_at: Math.floor(Date.now()/1000) } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
      if (path.startsWith('/api/') || path.startsWith('/adminapi/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      for (const root of roots) {
        const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
        try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
          ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* next build or SPA */ }
      }
      send(res, await readFile(resolve(roots[path === '/__integral_h5' ? 1 : 0]!, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned Browser assertion failed: ' + String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('INTEGRAL_LIMITS_BROWSER_READY ' + JSON.stringify({ url: origin + control }) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
      expect(external).not.toHaveBeenCalled(); process.stdout.write('INTEGRAL_LIMITS_BROWSER_RESULT ' + JSON.stringify(result()) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
