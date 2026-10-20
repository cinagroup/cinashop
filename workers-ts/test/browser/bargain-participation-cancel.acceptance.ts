/** Built PC/H5, actual App/JWT and owned PG16. Historical records and
 * session/navigation chrome are test fixtures; cancellation uses the real UI. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeBargainUser, storeBargainUserHelp } from '@/models/schema';
import { bargainShortSkuRuntimeFixture } from '../helpers/bargainShortSkuRuntime';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Owned cancellation SQL missing'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.container) throw Error('Owned Admin SQL missing');
    return { container: wiring.container, close: async () => {} }; },
}));
type Row = Record<string, any>;
async function bytes(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const value = Buffer.from(chunk); size += value.length;
    expect(size).toBeLessThan(64000); chunks.push(value); }
  return Buffer.concat(chunks);
}
it('H5 and PC cancel only exact cutting records and recover a lost committed response by read', async () => {
  const f = await bargainShortSkuRuntimeFixture(), app = createApp();
  const roots = [resolve(import.meta.dirname, '../../../view/pc-ts/dist'), resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5')];
  const origin = 'http://127.0.0.1:40751', control = '/__bargain_cancel/' + randomUUID();
  const stages = ['h5-list', 'h5-confirm', 'h5-kept', 'h5-cancelled', 'pc-list', 'pc-confirm', 'pc-unknown', 'pc-recovered', 'h5-final'];
  const evidence: Row[] = [], traces: Row[] = [];
  let injectLostResponse = false, finished = false;
  let done!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { done = yes; fail = no; });
  let chain = Promise.resolve();
  async function serial<T>(work: () => Promise<T>) {
    const previous = chain; let release!: () => void;
    chain = new Promise<void>(yes => { release = yes; }); await previous;
    try { return await work(); } finally { release(); }
  }
  function send(res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  }
  const json = (res: ServerResponse, value: unknown) => send(res, JSON.stringify(value), 200, 'application/json');
  const external = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned cancellation forbids providers'));
  wiring.container = f.container;
  try {
    for (const root of roots) expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
    const setup = await app.request('/adminapi/activity/save', { method: 'POST',
      headers: { Authorization: 'Bearer ' + f.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...f.adminInput(), storeName: '砍价取消样本', title: '砍价取消样本' }) }, f.env);
    const saved = await setup.json<Row>(); expect(saved.status, saved.msg).toBe(200);
    const activityId = saved.data.id;
    await f.db.insert(storeBargainUser).values([101, 102, 103, 104, 105].map(id => ({
      id, uid: id === 105 ? 22 : 11, bargainId: activityId, bargainPrice: '10.00', bargainPriceMin: '2.00',
      price: id === 103 || id === 104 ? '8.00' : '2.00', status: id === 103 ? 3 : id === 104 ? 4 : 1,
      addTime: Math.floor(Date.now() / 1000), isDel: 0,
    })));
    await f.db.insert(storeBargainUserHelp).values({ id: 501, uid: 22, bargainId: activityId, bargainUserId: 101, price: '2.00', type: 0 });
    const baseline = await f.snapshot(), sequences = await f.sequences();
    expect(Object.keys(baseline)).toHaveLength(283); expect(sequences).toHaveLength(229);
    const cancelled = (rows: unknown, ids: number[]) => (rows as Array<{ row: Row }>).map(entry =>
      ids.includes(entry.row.id) ? { ...entry, row: { ...entry.row, status: 2, is_del: 1 } } : entry);
    async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const path = url.pathname, rawBody = await bytes(req);
        const cancel = req.method === 'POST' && path === '/api/bargain/user/cancel';
        const read = req.method === 'GET' && ['/api/get_script', '/api/cart/count', '/api/cart/list',
          '/api/bargain/list', '/api/bargain/user/list', '/api/v2/diy/color_change/color_change', '/api/v2/diy/product_detail'].includes(path);
        expect(read || cancel, req.method + ' ' + path).toBe(true);
        const input = cancel ? JSON.parse(rawBody.toString()) : undefined;
        if (cancel) expect(input).toEqual({ id: injectLostResponse ? 102 : 101, bargainId: activityId });
        const before = await f.snapshot(), beforeSeq = await f.sequences(), headers = new Headers();
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const pending: Promise<unknown>[] = [];
        const response = await app.fetch(new Request(url.href, { method: req.method, headers,
          ...(rawBody.length ? { body: rawBody.toString() } : {}) }), f.env,
          { waitUntil: value => { pending.push(value); }, passThroughOnException() {} } as ExecutionContext);
        await Promise.all(pending);
        const raw = Buffer.from(await response.arrayBuffer());
        const body = response.headers.get('Content-Type')?.includes('application/json') ? JSON.parse(raw.toString()) : undefined;
        expect(response.status, raw.toString().slice(0, 300)).toBe(200);
        if (body) expect(body.status, body.msg).toBe(200);
        const after = await f.snapshot();
        expect(after).toEqual(cancel ? { ...before, store_bargain_user: cancelled(before.store_bargain_user, [input.id]) } : before);
        expect(await f.sequences()).toEqual(beforeSeq);
        if (path === '/api/bargain/user/list') expect(response.headers.get('Cache-Control')).toBe('private, no-store');
        const inject = cancel && injectLostResponse;
        traces.push({ method: req.method, path, query: url.search, upstream_status: response.status,
          browser_status: inject ? 503 : response.status, ...(cancel ? { input, exact_soft_delete_only: true } : { all_tables_unchanged: true }),
          all_sequences_unchanged: true });
        if (inject) return send(res, JSON.stringify({ status: 503, msg: '取消响应丢失，请刷新记录', data: null }), 503, 'application/json');
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(raw);
      });
    }
    async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
      return serial(async () => {
        const stage = url.pathname.slice(control.length + 1), data = JSON.parse((await bytes(req)).toString());
        if (stage === 'lose-response') { expect(evidence.at(-1)?.stage).toBe('pc-confirm'); injectLostResponse = true; }
        else if (stage === 'finish') {
          expect(evidence.map(row => row.stage)).toEqual(stages);
          expect(traces.filter(row => row.method === 'POST').map(row => row.input.id)).toEqual([101, 102]);
          expect(await f.snapshot()).toEqual({ ...baseline, store_bargain_user: cancelled(baseline.store_bargain_user, [101, 102]) });
          expect(await f.sequences()).toEqual(sequences); expect(external).not.toHaveBeenCalled(); finished = true;
          await writeFile('/tmp/cinashop-bargain-cancel-browser-result.json', JSON.stringify({ evidence, traces,
            public_tables: 283, sequences: 229, provider_calls: 0, order_changes: 0, help_history_preserved: true,
            authority: 'actual createApp/JWT on owned maintenance SQL; seeded history and synthetic sessions/navigation; no production LOGIN claim',
          }, null, 2) + '\n');
        } else {
          expect(stage).toBe(stages[evidence.length]); expect(data.scroll_width).toBeLessThanOrEqual(data.width + 1);
          const expectedIds = ['h5-list', 'h5-confirm', 'h5-kept'].includes(stage) ? [101, 102, 103, 104]
            : ['h5-cancelled', 'pc-list', 'pc-confirm'].includes(stage) ? [102, 103, 104] : stage === 'pc-unknown' ? [] : [103, 104];
          expect(data.records.map((row: Row) => row.id).sort((a: number, b: number) => a - b)).toEqual(expectedIds);
          for (const row of data.records) if ([103, 104].includes(row.id)) expect(row.cancel_count).toBe(0);
          if (stage.endsWith('confirm')) {
            expect(data.confirm_count).toBe(1); expect(data.text).toContain('确认取消参与 #' + (stage === 'h5-confirm' ? 101 : 102));
          } else expect(data.confirm_count).toBe(0);
          if (stage === 'pc-unknown') expect(data.text).toContain('请刷新记录确认结果，不会自动重试');
          evidence.push({ stage, ...data });
        }
        json(res, { checked: evidence.map(row => row.stage), finished }); if (finished) done();
      });
    }
    const shell = () => `<!doctype html><html lang="zh"><meta charset="utf-8"><title>砍价参与取消验收</title>
<style>body{font:14px sans-serif;margin:8px}button{margin:3px}iframe{display:block;width:390px;height:850px;border:1px solid #ddd}pre{max-height:50px;overflow:auto}</style>
<h1>实际 PC / H5 取消参与</h1><button id="h5">H5 我的砍价</button><button id="pc">PC 我的砍价</button>
${[...stages, 'lose-response', 'finish'].map(stage => `<button data-stage="${stage}">${stage}</button>`).join('')}<pre id="result"></pre><iframe title="实际砍价页面"></iframe><script>
const frame=document.querySelector('iframe');
document.getElementById('h5').onclick=()=>{localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(f.token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));frame.style.width='390px';frame.src='/__cancel_h5#/pages/activity/bargainDetail?mine=1';};
document.getElementById('pc').onclick=()=>{sessionStorage.setItem('pc_token',${JSON.stringify(f.token)});sessionStorage.setItem('pc_uid','11');frame.style.width='1100px';frame.src='/bargain?my=1';};
for(const button of document.querySelectorAll('[data-stage]'))button.onclick=async()=>{const d=frame.contentDocument,buttons=[...d.querySelectorAll('uni-button,button')],data={href:frame.contentWindow.location.href,text:d.body.textContent,records:[...d.querySelectorAll('.record,.my-item')].map(row=>({id:Number(row.textContent.match(/(?:记录|参与) #(\\d+)/)?.[1]),cancel_count:[...row.querySelectorAll('uni-button,button')].filter(x=>x.textContent.trim()==='取消此参与').length})),confirm_count:buttons.filter(x=>x.textContent.trim()==='确认取消此参与').length,width:d.documentElement.clientWidth,scroll_width:d.documentElement.scrollWidth};
const response=await fetch('${control}/'+button.dataset.stage,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});document.getElementById('result').textContent=JSON.stringify(await response.json());};</script></html>`;
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname;
      if (path === control && req.method === 'GET') return send(res, shell());
      if (path.startsWith(control + '/') && req.method === 'POST') return action(req, res, url);
      if (['/legacy/bargain-short-sku.png', '/logo.png', '/api/qa/image.svg'].includes(path)) return send(res, Buffer.from(f.png), 200, 'image/png');
      const chrome: Row = { '/api/site_config': { site_name: '本地取消验收', site_logo: '', record_No: '', ico_path: '' },
        '/api/share': { title: '本地取消验收', synopsis: '', img: '' }, '/api/diy/get_suspended': { is_show: 0, button: [] } };
      if (req.method === 'GET' && Object.hasOwn(chrome, path)) return json(res, { status: 200, data: chrome[path], msg: 'Synthetic navigation chrome only' });
      if (path.startsWith('/api/')) return api(req, res, url);
      if (path === '/favicon.ico') return send(res, '', 204);
      for (const root of roots) {
        const target = resolve(root, '.' + decodeURIComponent(path));
        if (target !== root && !target.startsWith(root + sep)) return send(res, 'Owned build only', 403);
        try { if (target !== root && (await stat(target)).isFile()) return send(res, await readFile(target), 200,
          ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' } as Row)[extname(target)] ?? 'application/octet-stream'); } catch { /* next build or SPA */ }
      }
      send(res, await readFile(resolve(roots[path === '/__cancel_h5' ? 1 : 0]!, 'index.html')));
    })().catch(error => { fail(error instanceof Error ? error : Error(String(error)));
      if (!res.headersSent) send(res, 'Owned cancellation assertion failed: ' + String(error), 500); else res.destroy(); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((yes, no) => { server.once('error', no); server.listen(40751, '127.0.0.1', yes); });
      process.stdout.write('BARGAIN_CANCEL_BROWSER_READY ' + JSON.stringify({ url: origin + control }) + '\n');
      deadline = setTimeout(() => fail(Error('Browser completion absent')), 20 * 60_000); await completion;
      process.stdout.write('BARGAIN_CANCEL_BROWSER_RESULT ' + JSON.stringify({ stages, requests: traces.length }) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections();
      if (server.listening) await new Promise<void>(yes => server.close(() => yes())); }
  } finally { external.mockRestore(); wiring.container = undefined; await f.close(); }
}, 21 * 60_000);
