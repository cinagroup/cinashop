/** Installed Browser + production Admin bundle + real App/JWT/restricted PG16. */
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeOrder, storeOrderStatus, storeProduct, storeProductAttrValue, systemRole } from '@/models/schema';
import { withEditScenario } from '../helpers/adminOrderEdit';
import { orderCreationClient } from '../helpers/orderCreationHistory';

it('reads stable pages, refreshes after a real peer remark, clears failed reads and refuses a withdrawn viewer', async () => {
  const root = resolve(import.meta.dirname, '../../../view/admin-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  await withEditScenario(async s => {
    await s.f.db.update(storeProduct).set({ image: '' }); await s.f.db.update(storeProductAttrValue).set({ image: '' });
    const creation = await (await orderCreationClient(s)).checkout(), order = creation.order, id = order.id, control = '/__admin_order_history_fixture/' + crypto.randomUUID();
    const createdStatus = await s.f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id));
    expect(createdStatus).toHaveLength(1); expect(createdStatus[0]).toMatchObject({ oid: id, changeType: 'cache_key_create_order', changeMessage: '订单生成', changeTime: order.addTime });
    await s.f.db.insert(storeOrderStatus).values(Array.from({ length: 45 }, (_, n) => ({ oid: id, changeTime: 1700000000 + n,
      changeType: n === 4 ? 'unknown_legacy_event' : 'history_fixture',
      changeMessage: n === 4 ? '<script>仅作原文展示</script>' : `历史记录 ${String(n + 1).padStart(2, '0')}` })));
    const snapshot = async () => ({ ...await s.snapshot(), sequences: await s.f.exec("SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename") });
    const originalOrder = (await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
    const originalStatus = await s.f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id));
    let expected = await snapshot(), origin = '', failNext = false, failed = false, appended = false, withdrawn = false, finished = false;
    const paths: Array<{ path: string; method: string; page: string | null; status: number; envelope?: number }> = [];
    let finish!: () => void, fail!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
    const state = async () => ({ paths, failed, appended, withdrawn, finished, initialCount: originalStatus.length, creationStatus: createdStatus[0],
      status: await s.f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id)),
      order: (await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0] });
    const session = { userInfo: { id: 103, account: 'remark-viewer', head_pic: '', real_name: '本机订单只读管理员', level: 1, roles: '820002' }, menus: [], uniqueAuth: ['order.view'] };
    const send = (res: import('node:http').ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
    };
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
      if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>订单操作记录 PG16 浏览器验收</title><h1>订单记录联合验收</h1><p>实际建单、JWT、独立受限 LOGIN；初始 ${originalStatus.length} 条记录。</p><button id="login">进入只读订单详情</button><button id="append">独立管理员提交真实备注</button><button id="fail">下一次记录读取返回503</button><button id="withdraw">撤销读取权限</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>
        document.getElementById('login').onclick=()=>{localStorage.setItem('admin_token',${JSON.stringify(s.token('viewer'))});localStorage.setItem('admin_session',${JSON.stringify(JSON.stringify(session))});location.href=${JSON.stringify('/order/' + order.orderId)};};
        for(const name of ['append','fail','withdraw','status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script>`);
      if (path.startsWith(control + '/')) {
        expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
        if (path.endsWith('/append')) {
          expect(appended).toBe(false);
          const result = await s.request('POST', `/adminapi/order/remark/${order.orderId}`, { remark: '独立管理员提交的真实备注' }, s.token('manager'));
          expect(result.status, result.msg).toBe(200); appended = true; expected = await snapshot();
        }
        if (path.endsWith('/fail')) failNext = true;
        if (path.endsWith('/withdraw')) { await s.f.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 820002)); withdrawn = true; expected = await snapshot(); }
        if (path.endsWith('/finish')) {
          expect(appended && failed && withdrawn).toBe(true); expect(await snapshot()).toEqual(expected);
          expect((await state()).order).toEqual({ ...originalOrder, remark: '独立管理员提交的真实备注' });
          const current = (await state()).status; expect(current).toHaveLength(originalStatus.length + 1);
          expect(current.filter(row => row.changeType === 'admin_order_remark')).toHaveLength(1);
          expect(current.filter(row => row.changeType === 'cache_key_create_order')).toEqual(createdStatus);
          expect(paths.every(row => row.method === 'GET')).toBe(true);
          expect(paths.some(row => row.page === '2' && row.envelope === 200)).toBe(true);
          expect(paths.some(row => row.envelope === 409)).toBe(true); expect(paths.some(row => row.envelope === 400011)).toBe(true);
          finished = true; await writeFile('/tmp/cinashop-admin-order-history-browser-result.json', JSON.stringify(await state(), null, 2) + '\n');
        }
        send(res, JSON.stringify(await state()), 200, 'application/json'); if (finished) finish(); return;
      }
      if (path === '/favicon.ico') return send(res, '', 204);
      if (path.startsWith('/adminapi/') || path.startsWith('/api/')) {
        expect(method).toBe('GET');
        if (failNext && path === `/adminapi/order/history/${id}`) { failNext = false; failed = true;
          paths.push({ path, method, page: url.searchParams.get('page'), status: 503, envelope: 503 });
          return send(res, JSON.stringify({ status: 503, msg: 'Owned history read failure', data: null }), 503, 'application/json');
        }
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const response = await s.fetch(new Request(origin + req.url, { method, headers })), text = await response.text();
        const body = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
        paths.push({ path, method, page: url.searchParams.get('page'), status: response.status, ...(body ? { envelope: body.status } : {}) });
        expect(await snapshot()).toEqual(expected);
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return;
      }
      const target = resolve(root, '.' + path); expect(target === root || target.startsWith(root + sep)).toBe(true);
      const file = await stat(target).catch(() => null), selected = file?.isFile() ? target : resolve(root, 'index.html');
      send(res, await readFile(selected), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' } as Record<string, string>)[extname(selected)] ?? 'text/html; charset=utf-8');
    })().catch(error => { if (!res.headersSent) send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned address'); origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('ADMIN_ORDER_HISTORY_BROWSER_READY ' + JSON.stringify({ control: origin + control, detail: origin + '/order/' + order.orderId, initialCount: originalStatus.length }) + '\n');
      deadline = setTimeout(() => fail(Error('History Browser finish not received')), 15 * 60_000); await completion;
      process.stdout.write('ADMIN_ORDER_HISTORY_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
  });
}, 16 * 60_000);
