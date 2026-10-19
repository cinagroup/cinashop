/** Actual production detail -> repurchase -> current direct-buy checkout, without creating/paying an order. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { storeCart, storeOrderCartInfo, storeProductAttrValue } from '@/models/schema';
import { customerOrderRepurchaseFixture } from '../helpers/customerOrderRepurchase';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Owned repurchase App boundary absent'); return wiring.container;
} }));
type Row = Record<string, any>;
const stages = ['source-ready', 'checkout-ready', 'unknown-source-ready', 'unknown-locked', 'unknown-reloaded', 'source-cleared', 'source-recovered'];
async function bytes(req: IncomingMessage, max = 65536) {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of req) { const part = Buffer.from(chunk); total += part.length; expect(total).toBeLessThanOrEqual(max); chunks.push(part); }
  return Buffer.concat(chunks);
}

it.each(['pc', 'mobile'] as const)('actual %s ordinary repurchase uses current prices and isolates acknowledged direct-buy rows', async kind => {
  const f = await customerOrderRepurchaseFixture(), app = createApp();
  const root = resolve(import.meta.dirname, '../../../view', kind === 'pc' ? 'pc-ts/dist' : 'uniapp-ts/dist/build/h5');
  const control = '/__order_repurchase/' + randomUUID(), origin = 'http://127.0.0.1:40751';
  const sourcePath = kind === 'pc' ? '/order/' + f.ids.publicOrderId : '/#/pages/order/detail?orderId=' + f.ids.publicOrderId;
  const traces: Row[] = [], evidence: Row[] = [], acknowledgements: Row[] = [];
  let finished = false, failAgain = false, failDetail = false, thumbnailReads = 0;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) { const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous; try { return await work(); } finally { release(); } }
  const result = () => ({ kind, source_order: f.ids.publicOrderId, source_row_id: f.ids.sourceOrder,
    traces, evidence, acknowledgements, required_stages: stages, finished,
    provider_calls: 0, r2_reads: f.r2Reads.length, r2_puts: f.r2Writes.length, r2_deletes: f.r2Deletes.length, fixture_thumbnail_reads: thumbnailReads });
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); }
  }
  try {
    expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    // Registered checkout/allocation and synthetic paid admission are inherited.
    // Completion is display-fixture maintenance, not a receipt/reward acceptance.
    await f.db.update(storeProductAttrValue).set({ price: '18.88' }).where(eq(storeProductAttrValue.productId, 70));
    const sourceRows = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, f.ids.sourceOrder)).orderBy(storeOrderCartInfo.id);
    expect(sourceRows.map(row => [row.productId, row.cartNum])).toEqual([[70, 2], [71, 1]]);
    // Both unrelated reusable and direct-buy contexts must survive and be excluded.
    await f.db.insert(storeCart).values([0, 1].map((isNew, index) => ({ id: 9001 + index, uid: 11,
      productId: 70, productAttrUnique: sourceRows[0]!.skuUnique, cartNum: 1, isNew, status: 1 })));
    await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('store_cart','id'),9002,true)`);
    const preserved = await f.db.select().from(storeCart);
    const container = createContainerFromDb(f.db);

    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const path = url.pathname, again = req.method === 'POST' && path === '/api/order/again';
        const quote = req.method === 'POST' && (path === '/api/order/confirm' || /^\/api\/order\/computed\/[A-Za-z0-9_-]+$/.test(path));
        const detail = req.method === 'GET' && path === '/api/order/detail/' + f.ids.publicOrderId;
        const read = req.method === 'GET' && (detail || ['/api/cart/list', '/api/cart/count', '/api/address/list', '/api/store/list',
          '/api/coupons/order/0', '/api/get_script', '/api/v2/diy/color_change/color_change', '/api/payment/readiness'].includes(path));
        expect(again || quote || read, 'Unexpected business request: ' + req.method + ' ' + path).toBe(true);
        const before = await f.snapshot(), sequences = await f.sequences(), rawBody = req.method === 'POST' ? await bytes(req) : undefined;
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        wiring.container = container;
        const response = await app.fetch(new Request(origin + url.pathname + url.search,
          { method: req.method, headers, ...(rawBody ? { body: rawBody } : {}) }), f.env);
        const raw = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
        const body = path === '/api/get_script' ? null : JSON.parse(raw.toString()); if (body) expect(body.status, body.msg).toBe(200);
        const trace: Row = { method: req.method, path, search: url.search, http: response.status,
          boundary: 'owned_fixture_maintenance_SQL', SQL_rows_sequences_unchanged_expected: !again };
        if (!again) { expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); trace.all_public_tables_sequences_unchanged = true; }
        else {
          expect(JSON.parse(rawBody!.toString())).toEqual({ uni: f.ids.publicOrderId });
          const ack = body.data; expect(ack.sourceOrderId).toBe(f.ids.publicOrderId); expect(ack.sourceRowId).toBe(f.ids.sourceOrder);
          expect(ack.cartIds).toHaveLength(2); expect(new Set(ack.cartIds).size).toBe(2); expect(ack.cateId).toBe(ack.cartIds.join(','));
          const carts = await f.db.select().from(storeCart), prepared = ack.cartIds.map((id: number) => carts.find(row => row.id === id));
          expect(prepared.map((row: Row) => [row.productId, row.cartNum])).toEqual([[70, 2], [71, 1]]);
          for (const row of prepared) expect(row).toMatchObject({ uid: 11, type: 0, isNew: 1, isPay: 0, isDel: 0, status: 1, activityId: 0 });
          for (const row of preserved) expect(carts.find(item => item.id === row.id)).toEqual(row);
          for (const previous of acknowledgements) expect(ack.cartIds.some((id: number) => previous.cartIds.includes(id))).toBe(false);
          const after = await f.snapshot(); for (const name of Object.keys(before)) if (name !== 'store_cart') expect(after[name], name).toEqual(before[name]);
          const afterSequences = await f.sequences(); for (const entry of sequences) if (entry.name !== 'store_cart_id_seq')
            expect(afterSequences.find(row => row.name === entry.name)).toEqual(entry);
          Object.assign(trace, { exact_body: { uni: f.ids.publicOrderId }, prepared_ids: [...ack.cartIds],
            original_and_unrelated_carts_unchanged: true, only_cart_rows_and_cart_sequence_changed: true });
          acknowledgements.push({ ...ack, cartIds: [...ack.cartIds] });
        }
        if (path === '/api/cart/list' && url.searchParams.get('scope') === 'buy') {
          const ids = url.searchParams.get('ids')!.split(',').map(Number);
          expect(ids).toEqual(acknowledgements[0]!.cartIds); expect(body.data.map((row: Row) => row.id)).toEqual(ids);
          expect(body.data.map((row: Row) => row.cartNum)).toEqual([2, 1]);
          expect(body.data[0].productInfo.price).toBe('18.88');
          trace.exact_direct_buy_selection = true; trace.current_first_sku_price = '18.88';
        }
        if (quote) {
          // These are the real server preview rows, not a client-side estimate.
          // Shipping is separate; 67.76 is the goods subtotal, never pay total.
          expect(body.data.cartInfo.map((row: Row) => row.trueSumPrice)).toEqual(['37.76', '30.00']);
          expect(body.data.cartInfo[0].productInfo.price).toBe('18.88');
          trace.actual_current_price_quote = true;
          trace.server_line_totals = ['37.76', '30.00']; trace.server_goods_subtotal = '67.76';
          trace.quote_cache_qualification = 'Legacy preview may store its short-lived KV key; SQL/R2 mutation is forbidden';
        }
        expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]);
        if (again && failAgain) { failAgain = false; trace.injected_http = 503; traces.push(trace); return send(res, 'Owned response lost after committed preparation', 503, 'text/plain'); }
        if (detail && failDetail) { failDetail = false; trace.injected_http = 503; traces.push(trace); return send(res, 'Owned source read failure after backend200', 503, 'text/plain'); }
        traces.push(trace); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const name = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString() || '{}');
        if (name === 'response-failure') { failAgain = true; expect(acknowledgements).toHaveLength(1); }
        else if (name === 'detail-failure') failDetail = true;
        else if (name === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages); expect(acknowledgements).toHaveLength(2);
          expect(traces.filter(row => row.exact_direct_buy_selection).length).toBeGreaterThanOrEqual(1);
          expect(traces.some(row => row.path === '/api/order/confirm' && row.actual_current_price_quote)).toBe(true);
          expect(traces.filter(row => row.path === '/api/order/again' && row.injected_http === 503)).toHaveLength(1);
          finished = true; await writeFile('/tmp/cinashop-customer-order-repurchase-browser-' + kind + '-result.json',
            JSON.stringify({ ...result(), table_count: Object.keys(await f.snapshot()).length, sequence_count: (await f.sequences()).length }, null, 2) + '\n');
        } else {
          expect(stages[evidence.length]).toBe(name); expect(data.page_scroll_width).toBeLessThanOrEqual(data.page_width + 1);
          if (['source-ready', 'unknown-source-ready'].includes(name)) {
            expect(data.text).toContain('订单详情'); expect(data.text).toContain(f.ids.publicOrderId);
            expect(data.repurchase_buttons).toEqual([{ disabled: false, text: '再次购买' }]);
          } else if (name === 'checkout-ready') {
            expect(data.text).toContain('确认订单');
            // PC shows unit price; H5 intentionally renders the quoted line total.
            expect(data.text).toContain(kind === 'pc' ? '18.88' : '37.76');
            expect(data.text).toContain('37.76'); expect(data.text).toContain('67.76');
            const location = new URL(data.href); const route = kind === 'pc' ? location : new URL(location.hash.slice(1), origin);
            expect(route.pathname).toBe(kind === 'pc' ? '/checkout' : '/pages/order/confirm');
            expect(route.searchParams.get('mode')).toBe('buy'); expect(route.searchParams.get('cartIds')).toBe(acknowledgements[0]!.cateId);
            expect(traces.filter(row => row.path === '/api/order/again')).toHaveLength(1);
            expect(traces.some(row => row.path === '/api/order/confirm' && row.actual_current_price_quote)).toBe(true);
          } else if (['unknown-locked', 'unknown-reloaded', 'source-recovered'].includes(name)) {
            expect(data.text).toContain('准备结果尚未确认'); expect(data.repurchase_buttons).toEqual([{ disabled: true, text: '再次购买' }]);
            expect(traces.filter(row => row.path === '/api/order/again')).toHaveLength(2);
          } else if (name === 'source-cleared') {
            expect(data.text).not.toContain(f.ids.publicOrderId); expect(data.repurchase_buttons).toEqual([]);
            expect(data.text).toContain(kind === 'mobile' ? '请求失败' : '503');
          }
          evidence.push({ stage: name, ...data });
        }
        send(res, JSON.stringify(result()), 200, 'application/json'); if (finished) done();
      });
    }
    const enter = kind === 'pc' ? `sessionStorage.setItem('pc_token',${JSON.stringify(f.tokens.buyer)});sessionStorage.setItem('pc_uid','11');`
      : `localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.tokens.buyer)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));`;
    function shell() { return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>${kind}订单再次购买验收</title><style>body{font:14px sans-serif;margin:12px}button{margin:4px}pre{max-height:60px;overflow:auto;white-space:pre-wrap}iframe{display:block;width:${kind === 'pc' ? 1200 : 390}px;height:844px;border:1px solid #ccc}</style><h1>${kind} 实际再次购买验收</h1><button id="enter">进入实际订单</button>${stages.map(name => `<button data-stage="${name}">${name}</button>`).join('')}<button data-stage="response-failure">模拟准备响应丢失</button><button data-stage="detail-failure">模拟原订单读取失败</button><button data-stage="finish">完成验收</button><pre id="result"></pre><iframe title="实际生产页面"></iframe><script>const frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{${enter}frame.src=${JSON.stringify(sourcePath)};};for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const stage=button.dataset.stage,doc=frame.contentDocument;const data={text:doc.body.textContent,href:frame.contentWindow.location.href,repurchase_buttons:[...doc.querySelectorAll('.repurchase-button')].map(node=>({disabled:!!node.disabled||(node.hasAttribute('disabled')&&node.getAttribute('disabled')!=='false'),text:node.textContent.trim()})),page_width:doc.documentElement.clientWidth,page_scroll_width:doc.documentElement.scrollWidth};const response=await fetch('${control}/'+stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();document.getElementById('result').textContent=JSON.stringify({kind:value.kind,checked:value.evidence.map(row=>row.stage),finished:value.finished});if(stage==='response-failure')frame.src=${JSON.stringify(sourcePath)};};</script></html>`; }
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (path === '/api/qa/image.svg' && req.method === 'GET') { thumbnailReads++; return send(res, Buffer.from(f.png), 200, 'image/png'); }
      const chrome: Row = { '/api/site_config': { site_name: '本地再次购买验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地再次购买验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return send(res, JSON.stringify({ status: 200, data: chrome[path], msg: 'Owned shell only' }), 200, 'application/json');
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      const target = resolve(root, '.' + decodeURIComponent(path)); if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
      try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
        ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* SPA route */ }
      send(res, await readFile(resolve(root, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error))); if (!res.headersSent) send(res, 'Owned acceptance assertion failed', 500); else res.destroy(); }); });
    const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Repurchase acceptance forbids provider dispatch'));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('ORDER_REPURCHASE_BROWSER_READY ' + JSON.stringify({ kind, url: origin + control, source_order: f.ids.publicOrderId }) + '\n');
      deadline = setTimeout(() => fail(Error('Repurchase Browser completion absent')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled();
      process.stdout.write('ORDER_REPURCHASE_BROWSER_RESULT ' + JSON.stringify({ kind, stages: evidence.map(row => row.stage), business_requests: traces.length, prepared_selections: acknowledgements.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
      server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { await f.close(); }
}, 21 * 60_000);
