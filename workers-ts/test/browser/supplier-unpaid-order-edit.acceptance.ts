/** Installed Browser + production bundle + actual App/JWT + restricted PG16 LOGIN. */
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { user } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { supplierUnpaidOrderEditFixture, supplierOrderEditAppKey, supplierOrderEditPassword } from '../helpers/supplierUnpaidOrderEdit';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing owned Supplier order edit Browser fixture'); return wiring.container;
} }));
it('edits the actual unpaid checkout and recovers one committed change after lost response, reload and management withdrawal', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierUnpaidOrderEditFixture(), order = await f.checkout(), id = order.id, before = await f.editState(id);
  const buyer = await f.db.select().from(user).where(eq(user.uid, 11)), control = '/__supplier_order_edit_fixture/' + randomUUID();
  const token = (await createToken(21, 'supplier', md5(supplierOrderEditPassword), supplierOrderEditAppKey)).token;
  const env = { APP_KEY: supplierOrderEditAppKey, NODE_ENV: 'test', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '',
    ORDER_QUEUE: { send: async () => {}, sendBatch: async () => {} },
    CONFIG_KV: { get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {} } } as unknown as Env;
  const app = createApp(), paths: Array<{ method: string; path: string; status: number; envelope?: number }> = [];
  let dropped = false, recovered = false, withdrawn = false, finished = false, outbound = 0, origin = '', operationId = '';
  const send = (res: import('node:http').ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  };
  const state = async () => ({ order: (await f.editState(id)).order, paths, dropped, recovered, withdrawn, finished, outbound, operationId });
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商订单编辑 PG16 验收</title><h1>供应商未付款订单编辑联合验收</h1><p>真实 App、JWT、受限 LOGIN 与 PostgreSQL；本机合成数据。</p><button id="login">进入订单管理</button><button id="withdraw">撤销本地夹具管理权限并核对回执</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>document.getElementById('login').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(token)});localStorage.setItem('supplier-user',JSON.stringify({id:21,supplier_id:7,supplier_name:'本机合成供应商',account:'owned-order-edit'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view','supplier.order.manage']));location.href='/orders';};document.getElementById('withdraw').onclick=async()=>{const r=await fetch(${JSON.stringify(control + '/withdraw')},{method:'POST'});if(r.ok){localStorage.setItem('supplier-permissions','["supplier.order.view"]');location.href='/orders/edit-result';}};for(const name of ['status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script></html>`);
    if ([control + '/status', control + '/finish', control + '/withdraw'].includes(path)) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
      if (path.endsWith('/withdraw')) {
        expect(dropped).toBe(true); await f.db.execute(sql`UPDATE public.system_role SET rules='supplier.order.view' WHERE id=21 AND type=4 AND relation_id=7`); withdrawn = true;
      }
      if (path.endsWith('/finish')) {
        const after = await f.editState(id);
        expect(after.order).toEqual({ ...before.order, payPrice: '18.75', changePrice: (Number(before.order.payPrice) + Number(before.order.changePrice) - 18.75).toFixed(2), gainIntegral: '17.00' });
        for (const row of after.carts) {
          const prior = before.carts.find(old => old.id === row.id)!;
          expect({ ...row, cartInfo: prior.cartInfo }).toEqual(prior);
          const oldJson = JSON.parse(prior.cartInfo!), newJson = JSON.parse(row.cartInfo!); delete oldJson.gain_integral; delete newJson.gain_integral; expect(newJson).toEqual(oldJson);
        }
        expect(await f.db.select().from(user).where(eq(user.uid, 11))).toEqual(buyer);
        expect(after.statuses).toHaveLength(before.statuses.length + 1);
        expect(after.statuses.at(-1)).toMatchObject({ changeType: 'order_edit' });
        expect(after.outbox).toHaveLength(before.outbox.length + 1);
        expect(after.operations).toHaveLength(1); expect(after.operations[0]).toMatchObject({ operation_id: operationId, actor_id: 21, supplier_id: 7, order_id: id, state: 'committed' });
        expect(paths.filter(p => p.method === 'PUT' && p.path === `/supplierapi/order/update/${id}`)).toHaveLength(1);
        expect(paths.filter(p => p.method === 'GET' && p.path === `/supplierapi/order/edit_operations/${operationId}`)).toHaveLength(1);
        expect(paths.filter(p => p.path === `/supplierapi/order/edit/${id}`)).toHaveLength(1);
        expect(paths.some(p => p.path === '/api/get_script' && p.status === 200)).toBe(true);
        expect(dropped && recovered && withdrawn).toBe(true); expect(outbound).toBe(0); finished = true;
        await writeFile('/tmp/cinashop-supplier-order-edit-browser-result.json', JSON.stringify(await state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(await state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; expect(length).toBeLessThanOrEqual(16384); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks), headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const response = await app.fetch(new Request(origin + req.url, { method, headers, ...(bytes.length ? { body: new Uint8Array(bytes).buffer } : {}) }), env);
      const text = await response.text();
      if (path === '/api/get_script') { paths.push({ path, method, status: response.status }); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/javascript'); expect(text).toBe(''); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return; }
      const body = JSON.parse(text); paths.push({ path, method, status: response.status, envelope: body.status });
      if (method === 'PUT' && path === `/supplierapi/order/update/${id}` && body.status === 200 && !dropped) {
        expect(body.data.state).toBe('committed'); operationId = body.data.operation_id; dropped = true;
        return send(res, JSON.stringify({ status: 502, msg: 'Owned committed acknowledgement deliberately discarded', data: null }), 502, 'application/json');
      }
      if (withdrawn && method === 'GET' && path === `/supplierapi/order/edit_operations/${operationId}` && body.status === 200 && body.data.state === 'committed') recovered = true;
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return;
    }
    if (path.startsWith('/uploads/')) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9edf3"/></svg>', 200, 'image/svg+xml');
    const target = path.startsWith('/assets/') ? resolve(root, '.' + path) : resolve(root, 'index.html');
    expect(target === resolve(root, 'index.html') || target.startsWith(root + sep)).toBe(true);
    send(res, await readFile(target), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(target)] ?? 'text/html; charset=utf-8');
  })().catch(error => { send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('No outbound provider traffic in owned order edit Browser acceptance'); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.withEditRuntime(async runtime => {
      wiring.container = runtime.container;
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('SUPPLIER_ORDER_EDIT_BROWSER_READY ' + JSON.stringify({ control: origin + control, orders: origin + '/orders', edit: origin + `/orders/${id}/edit` }) + '\n');
      deadline = setTimeout(() => fail(Error('Supplier order edit Browser finish not received')), 15 * 60_000);
      await completion; process.stdout.write('SUPPLIER_ORDER_EDIT_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
    });
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await f.close();
  }
}, 16 * 60_000);
