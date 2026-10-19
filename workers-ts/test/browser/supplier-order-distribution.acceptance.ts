/** Actual built Orders/editor -> Hono/JWT -> independent narrow writer LOGIN.
 * Browser interactions use the connected Codex Browser; no provider is called. */
import { expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { supplierOrderDistributionFixture } from '../helpers/supplierOrderDistribution';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned distribution Browser LOGIN'); return wiring.container;
} }));
type Row = Record<string, any>;
it('cancels without writes, corrects single/child/manual-virtual/legacy-send facts, and keeps the 390px footer usable', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierOrderDistributionFixture(), app = createApp(), control = '/__distribution/' + randomUUID();
  const baseline = await f.snapshot(), baselineSequences = await f.sequences(), paths: Row[] = [], evidence: Row[] = [];
  let origin = '', finished = false, cancelled = false, chain = Promise.resolve(), runtime: Container;
  let complete!: () => void, reject!: (cause: Error) => void, deadline: ReturnType<typeof setTimeout> | undefined;
  const completion = new Promise<void>((yes, no) => { complete = yes; reject = no; });
  const state = () => ({ paths, evidence, cancelled, finished });
  async function serial<T>(work: () => Promise<T>) { const before = chain; let release!: () => void; chain = new Promise<void>(yes => { release = yes; }); await before; try { return await work(); } finally { release(); } }
  function send(res: ServerResponse, data: string | Buffer, status = 200, type = 'text/html; charset=utf-8') { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(data); } }
  async function body(req: IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; expect(size).toBeLessThan(65536); chunks.push(bytes); } return Buffer.concat(chunks).toString(); }
  function verifyWrite(before: Row, after: Row, id: number, input: Row) {
    for (const table of Object.keys(before)) {
      if (!['store_order', 'store_order_status'].includes(table)) { expect(after[table], table).toEqual(before[table]); continue; }
      if (table === 'store_order') {
        const old = before[table].find((r: Row) => r.row.id === id)?.row; expect(old).toBeTruthy();
        const changed = { ...old };
        if (old.delivery_type === 'fictitious') changed.fictitious_content = input.fictitious_content;
        else { changed.delivery_name = input.delivery_name; changed.delivery_id = input.delivery_id; if (old.delivery_type === 'express') changed.delivery_code = 'shentong'; }
        expect(after[table]).toHaveLength(before[table].length);
        for (const item of after[table]) expect(item.row).toEqual(item.row.id === id ? changed : before[table].find((r: Row) => r.row.id === item.row.id).row);
      } else {
        expect(after[table]).toHaveLength(before[table].length + 1);
        for (const item of before[table]) expect(after[table]).toContainEqual(item);
        const added = after[table].filter((r: Row) => !before[table].some((b: Row) => b.row.id === r.row.id)); expect(added).toHaveLength(1);
        expect(added[0].row).toMatchObject({ oid: id, change_type: 'distribution' });
        expect(added[0].row.change_message).not.toContain(input.delivery_id || input.fictitious_content || '__NONE__');
      }
    }
  }
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      const write = req.method === 'PUT', id = Number(url.pathname.split('/').at(-1));
      expect(write ? /^\/supplierapi\/order\/distribution\/(100|102|103|202)$/.test(url.pathname)
        : req.method === 'GET' && (url.pathname === '/api/get_script' || url.pathname === '/supplierapi/order/list'
          || /^\/supplierapi\/order\/(info|status|split_order|distribution)\/(100|102|103|104|200|201|202)$/.test(url.pathname))).toBe(true);
      if (write) expect(cancelled).toBe(true);
      const before = await f.snapshot(), seq = await f.sequences(), data = write ? await body(req) : undefined;
      const headers = new Headers(); for (const name of ['authorization', 'authori-zation']) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
      if (write) headers.set('Content-Type', 'application/json'); wiring.container = runtime;
      const response = await app.request(url.pathname + url.search, { method: req.method, headers, body: data }, f.env);
      const bytes = Buffer.from(await response.arrayBuffer()); expect(response.status).toBe(200);
      const envelope = url.pathname === '/api/get_script' ? null : JSON.parse(bytes.toString());
      if (envelope) expect(envelope.status, envelope.msg).toBe(200);
      if (url.pathname !== '/api/get_script') expect(response.headers.get('Cache-Control')).toContain('private, no-store');
      const entry: Row = { method: req.method, path: url.pathname, http: response.status };
      if (write) {
        const input = JSON.parse(data!); verifyWrite(before, await f.snapshot(), id, input);
        expect(envelope.data).toMatchObject({ id, ...(id === 102 ? { fictitious_content: input.fictitious_content } : { delivery_name: input.delivery_name, delivery_id: input.delivery_id }) });
        const afterSeq = await f.sequences();
        for (const current of afterSeq) { const prior = seq.find(s => s.name === current.name)!; if (current.name !== 'store_order_status_id_seq') expect(current).toEqual(prior); else { expect(Number(current.last_value)).toBe(Number(prior.last_value) + (prior.is_called ? 1 : 0)); expect(current.is_called).toBe(true); } }
        entry.id = id; entry.only_delivery_fields_and_one_audit_changed = true;
      } else { expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); entry.sql_and_sequences_unchanged = true; }
      paths.push(entry); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(bytes);
    });
  }
  async function action(req: IncomingMessage, res: ServerResponse, url: URL) {
    await serial(async () => {
      const name = url.pathname.slice(control.length + 1);
      if (name === 'cancelled') { expect(paths.some(row => row.path === '/supplierapi/order/distribution/100')).toBe(true); expect(paths.every(row => row.method === 'GET')).toBe(true); expect(await f.snapshot()).toEqual(baseline); expect(await f.sequences()).toEqual(baselineSequences); cancelled = true; }
      else if (name === 'desktop' || name === 'phone') {
        const data = JSON.parse(await body(req)); expect(data.width).toBe(name === 'phone' ? 390 : 1200); expect(data.height).toBe(844);
        expect(data.dialog.left).toBeGreaterThanOrEqual(0); expect(data.dialog.right).toBeLessThanOrEqual(data.width);
        expect(data.dialog.top).toBeGreaterThanOrEqual(0); expect(data.dialog.bottom).toBeLessThanOrEqual(844);
        expect(data.footer_visible).toBe(true); expect(data.unobscured).toBe(true); expect(data.content).toContain('配送信息'); evidence.push({ stage: name, ...data });
      } else if (name === 'finish') {
        expect(paths.filter(row => row.method === 'PUT').map(row => row.id)).toEqual([100, 202, 102, 103]);
        expect(evidence.map(row => row.stage)).toEqual(['desktop', 'phone']);
        const final = await f.snapshot();
        for (const table of Object.keys(baseline)) if (!['store_order', 'store_order_status'].includes(table)) expect(final[table]).toEqual(baseline[table]);
        expect(final.store_order_status.length - baseline.store_order_status.length).toBe(4);
        for (const row of final.store_order) if (![100, 202, 102, 103].includes(Number(row.row.id))) expect(baseline.store_order).toContainEqual(row);
        finished = true; await writeFile('/tmp/cinashop-supplier-order-distribution-browser-result.json', JSON.stringify({ ...state(), table_count: Object.keys(baseline).length, sequence_count: baselineSequences.length, provider_calls: 0, writes: 4 }, null, 2) + '\n');
      } else expect(name).toBe('status');
      send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) complete();
    });
  }
  function shell() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商配送信息真实 PG16 验收</title><style>body{margin:12px;font:14px sans-serif}button{margin:4px}pre{max-height:90px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}iframe{display:block;width:1200px;height:844px;border:1px solid #bbb}</style>
      <h1>供应商已发货包裹配送信息修订</h1><button id="enter">登录并进入订单</button><button id="cancelled">核对取消未写入</button><button id="desktop">核对桌面弹窗</button><button id="mobile">切换390手机宽度</button><button id="phone">核对手机弹窗</button><button id="finish">完成验收并关闭夹具</button><pre id="result"></pre><iframe title="实际Supplier订单生产页面"></iframe>
      <script>const control=${JSON.stringify(control)},frame=document.querySelector('iframe');document.getElementById('enter').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(f.tokens.manager)});localStorage.setItem('supplier-user',JSON.stringify({id:21,supplier_id:7,supplier_name:'本店配送'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view','supplier.order.manage']));frame.src='/orders';};
      async function report(name,data={}){const r=await fetch(control+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();document.getElementById('result').textContent=JSON.stringify({requests:value.paths.length,writes:value.paths.filter(x=>x.method==='PUT').length,cancelled:value.cancelled,checked:value.evidence.map(x=>x.stage),finished:value.finished});}
      document.getElementById('cancelled').onclick=()=>report('cancelled');document.getElementById('mobile').onclick=()=>{frame.style.width='390px';};
      for(const mode of ['desktop','phone'])document.getElementById(mode).onclick=()=>{const doc=frame.contentDocument,dialog=doc.querySelector('.supplier-distribution-dialog'),r=dialog.getBoundingClientRect(),footer=dialog.querySelector('.el-dialog__footer').getBoundingClientRect(),buttons=[...dialog.querySelectorAll('.el-dialog__footer button')];report(mode,{width:frame.contentWindow.innerWidth,height:frame.contentWindow.innerHeight,dialog:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},footer_visible:footer.bottom<=844,unobscured:buttons.every(n=>{const b=n.getBoundingClientRect(),top=doc.elementFromPoint(b.left+b.width/2,b.top+b.height/2);return top===n||n.contains(top);}),content:dialog.innerText});};document.getElementById('finish').onclick=()=>report('finish');</script></html>`;
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
  })().catch(cause => { reject(cause instanceof Error ? cause : Error(String(cause))); if (!res.headersSent) send(res, 'Owned distribution assertion failed', 500); else res.destroy(); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Distribution metadata correction must not call an external provider'); });
  try {
    await f.withWriter(async peer => {
      runtime = peer.container; const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_table_privilege(current_user,'store_order','UPDATE') AS whole_table_write,has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, whole_table_write: false, creates: false });
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned Browser port');
      origin = 'http://127.0.0.1:' + address.port; process.stdout.write('SUPPLIER_ORDER_DISTRIBUTION_BROWSER_READY ' + JSON.stringify({ control: origin + control }) + '\n');
      deadline = setTimeout(() => reject(Error('Distribution Browser finish not received')), 20 * 60_000);
      await completion; expect(external).not.toHaveBeenCalled(); process.stdout.write('SUPPLIER_ORDER_DISTRIBUTION_BROWSER_RESULT ' + JSON.stringify(state()) + '\n');
    });
  } finally { if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined; server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes())); await f.close(); }
}, 21 * 60_000);
