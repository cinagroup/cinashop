/** Installed Browser, production H5, real HTTP readers/JWT/restricted PG16.
 * Only the Work OAuth bootstrap uses a freshly exchanged local identity;
 * historical record controls and 503/malformed responses are explicit interventions. */
import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { storeOrderStatus, storeProduct, storeProductAttrValue, user, workClientFollow } from '@/models/schema';
import { withEditScenario } from '../helpers/adminOrderEdit';
import { orderCreationClient } from '../helpers/orderCreationHistory';
import { orderTimelineWork } from '../helpers/orderTimelineWork';

it('renders buyer and Work timelines, refreshes native records and clears failed/revoked reads', async () => {
  const root = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  await withEditScenario(async s => {
    const work = await orderTimelineWork(s);
    await s.f.db.update(storeProduct).set({ image: '' }); await s.f.db.update(storeProductAttrValue).set({ image: '' });
    const client = await orderCreationClient(s), { order } = await client.checkout();
    await s.seed(820001, 'TimelineEmpty');
    const control = '/__order_timeline_fixture/' + crypto.randomUUID(), fakeState = 'a'.repeat(64);
    const snapshot = async () => ({ business: await s.f.state(), sequences: await s.f.exec("SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename") });
    let expected = await snapshot(), origin = '', nextFailure = '', appended = false, revokedBuyer = false, revokedWork = false, finished = false;
    const calls: Array<{ path: string; method: string; status: number }> = [];
    let finish!: () => void, fail!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
    const state = () => ({ calls, appended, revokedBuyer, revokedWork, finished, id: order.id, orderId: order.orderId });
    const send = (res: import('node:http').ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body); };
    const server = createServer((req, res) => { void (async () => {
      if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host) return send(res, 'Owned loopback only', 403);
      const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
      if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>订单生命周期 PG16 联合验收</title><h1>订单进度记录联合验收</h1><p>真实未付款建单；Work 使用本机身份提供器交换的短期上下文。历史记录和故障由独立控制提交。</p><button id="buyer">打开买家订单</button><button id="empty">打开无记录订单</button><button id="work">打开企业微信订单</button>${['append','fail','malformed','revokeBuyer','revokeWork','status','finish'].map(name => '<button id="'+name+'">'+name+'</button>').join('')}<pre id="state"></pre><script>
        function shopper(number){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:${JSON.stringify(client.token)}}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:11}));location.href='/#/pages/order/detail?orderId='+number;}
        document.getElementById('buyer').onclick=()=>shopper(${JSON.stringify(order.orderId)});document.getElementById('empty').onclick=()=>shopper('TimelineEmpty');
        document.getElementById('work').onclick=()=>{sessionStorage.setItem('cinashop_work_oauth_pending',JSON.stringify({state:${JSON.stringify(fakeState)},target:{target_type:'client',external_userid:${JSON.stringify(work.externalUserid)}},sdkDiscovered:false,returnRoute:${JSON.stringify('/pages/work/orderDetail/index?id=' + order.id + '&userid=' + work.externalUserid)},expiresAt:Date.now()+120000}));location.href='/?work_oauth=1&state=${fakeState}&code=owned-local-bootstrap';};
        for(const name of ['append','fail','malformed','revokeBuyer','revokeWork','status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script>`);
      if (path.startsWith(control + '/')) {
        expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
        if (path.endsWith('/append')) { expect(appended).toBe(false);
          await s.f.db.insert(storeOrderStatus).values([{ oid: order.id, changeType: 'delivery', changeTime: 0, changeMessage: 'Declared historical delivery' },
            { oid: order.id, changeType: 'delivery_goods', changeTime: 172800, changeMessage: 'Declared lower-priority history' }]); appended = true; expected = await snapshot();
        }
        if (path.endsWith('/fail')) nextFailure = '503';
        if (path.endsWith('/malformed')) nextFailure = 'malformed';
        if (path.endsWith('/revokeBuyer')) { await s.f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11)); revokedBuyer = true; expected = await snapshot(); }
        if (path.endsWith('/revokeWork')) { await s.f.db.update(workClientFollow).set({ isDelUser: 1 }).where(eq(workClientFollow.id, work.follow.id)); revokedWork = true; expected = await snapshot(); }
        if (path.endsWith('/finish')) {
          expect(appended && revokedBuyer && revokedWork).toBe(true); expect(await snapshot()).toEqual(expected);
          expect(calls.filter(row => row.path.includes('/order/detail/') && row.status === 200).length).toBeGreaterThanOrEqual(3);
          expect(calls.some(row => row.path.includes('/work/order/info/') && row.status === 200)).toBe(true);
          expect(calls.some(row => row.status === 503)).toBe(true); finished = true;
          await writeFile('/tmp/cinashop-order-lifecycle-timeline-browser-result.json', JSON.stringify(state(), null, 2) + '\n');
        }
        send(res, JSON.stringify(state()), 200, 'application/json'); if (finished) finish(); return;
      }
      // Explicit local OAuth bootstrap only: each token is issued by the actual
      // challenge/exchange service with its normal SQL authorization.
      if (path === '/api/work/context/exchange') {
        expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ state: fakeState, code: 'owned-local-bootstrap', target_type: 'client', external_userid: work.externalUserid });
        const challenge = await work.service.challenge('https://work.example.test', 'https://work.example.test/?work_oauth=1');
        const context = await work.service.exchange({ origin: 'https://work.example.test', state: challenge.state,
          code: crypto.randomUUID(), cookieValue: challenge.cookie_value, target: { type: 'client', externalUserid: work.externalUserid } });
        expect(await snapshot()).toEqual(expected);
        return send(res, JSON.stringify({ status: 200, msg: 'Owned fresh local identity bootstrap', data: context }), 200, 'application/json');
      }
      if (path === '/favicon.ico') return send(res, '', 204);
      if (path.startsWith('/api/')) {
        expect(method).toBe('GET');
        const isDetail = path.includes('/order/detail/') || path.includes('/work/order/info/');
        if (isDetail && nextFailure === '503') { nextFailure = ''; calls.push({ path, method, status: 503 }); return send(res, JSON.stringify({ status: 503, msg: 'Owned timeline read failure', data: null }), 503, 'application/json'); }
        const headers = new Headers(); for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
        const response = await s.fetch(new Request(origin + req.url, { method, headers }));
        let text = await response.text(); const body = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
        if (isDetail) { expect(response.headers.get('cache-control')).toContain('no-store'); calls.push({ path, method, status: body?.status ?? response.status });
          if (nextFailure === 'malformed') { nextFailure = ''; const info = body.data.orderInfo ?? body.data; delete info.order_log; text = JSON.stringify(body); }
        }
        expect(await snapshot()).toEqual(expected); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return;
      }
      expect(method).toBe('GET'); const target = resolve(root, '.' + path); expect(target === root || target.startsWith(root + sep)).toBe(true);
      const file = await stat(target).catch(() => null), selected = file?.isFile() ? target : resolve(root, 'index.html');
      send(res, await readFile(selected), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf' } as Record<string, string>)[extname(selected)] ?? 'text/html; charset=utf-8');
    })().catch(error => { if (!res.headersSent) send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned address'); origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('ORDER_TIMELINE_BROWSER_READY ' + JSON.stringify({ control: origin + control, id: order.id, orderId: order.orderId }) + '\n');
      deadline = setTimeout(() => fail(Error('Timeline Browser finish not received')), 15 * 60_000); await completion;
    } finally { if (deadline) clearTimeout(deadline); server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
  });
}, 16 * 60_000);
