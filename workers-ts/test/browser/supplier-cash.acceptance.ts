/** Installed Browser + production Vue bundle + actual App/JWT + independent
 * Supplier writer, paid consumer and refund LOGINs on process-owned PG16. */
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { user, storeOrderRefund, storeOrderRefundPayment, storeOrderRefundSplit } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { supplierManualRefundFixture } from '../helpers/supplierManualRefund';
import { supplierOrderEditActor, supplierOrderEditAppKey, supplierOrderEditPassword } from '../helpers/supplierUnpaidOrderEdit';
const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing actual owned Supplier cash runtime'); return wiring.container;
} }));
it('confirms actual Supplier collection and cash refund with one write each, lost replies, reload and live readonly recovery', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist'); expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierManualRefundFixture(), order = await f.createOffline(), id = order.id;
  await f.service.save(id, { ...await f.body(id), pay_price: '18.75', gain_integral: '17' }, supplierOrderEditActor());
  const [buyer] = await f.db.select().from(user).where(eq(user.uid, 11)), control = '/__supplier_cash_fixture/' + randomUUID();
  const token = (await createToken(21, 'supplier', md5(supplierOrderEditPassword), supplierOrderEditAppKey)).token;
  const env = { ...f.paymentEnvironment, NODE_ENV: 'test', CONFIG_KV: {
    get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {},
  } } as unknown as Env;
  const app = createApp(), paths: Array<{ method: string; path: string; status: number; envelope?: number }> = [];
  let paymentDropped = false, refundDropped = false, paymentRecovered = false, refundRecovered = false,
    paymentWithdrawn = false, refundWithdrawn = false, finished = false, outbound = 0, origin = '', paymentOperation = '', refundOperation = '', refundId = 0;
  let paymentContainer: Container, refundContainer: Container, applyRefund: () => Promise<number>;
  let apiChain = Promise.resolve();
  const state = async () => ({ order: (await f.editState(id)).order, refundId, paths, paymentDropped, refundDropped, paymentRecovered,
    refundRecovered, paymentWithdrawn, refundWithdrawn, finished, outbound, paymentOperation, refundOperation });
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const send = (res: import('node:http').ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  };
  const server = createServer((req, res) => { void (async () => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname, method = req.method ?? 'GET';
    if (path === control) return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商现金 PG16 验收</title><h1>真实供应商收款与退款验收</h1><p>仅本机合成数据，真实 JWT、受限 LOGIN 和业务处理。</p><button id="login">进入订单管理</button><button id="withdraw-payment">撤销收款管理权并核对原结果</button><button id="withdraw-refund">撤销退款管理权并核对原结果</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>
      document.getElementById('login').onclick=()=>{localStorage.setItem('supplier-token',${JSON.stringify(token)});localStorage.setItem('supplier-user',JSON.stringify({id:21,supplier_id:7,supplier_name:'本机现金供应商',account:'owned-cash'}));localStorage.setItem('supplier-permissions',JSON.stringify(['supplier.order.view','supplier.order.manage','supplier.refund.view','supplier.refund.manage']));location.href='/orders';};
      for(const stage of ['payment','refund'])document.getElementById('withdraw-'+stage).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/withdraw-'+stage,{method:'POST'});if(r.ok){localStorage.setItem('supplier-permissions',JSON.stringify(stage==='payment'?['supplier.order.view','supplier.refund.view','supplier.refund.manage']:['supplier.order.view','supplier.refund.view']));location.href=stage==='payment'?'/orders/cash-result':'/refunds/cash-result';}};
      for(const name of ['status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(${JSON.stringify(control)}+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script></html>`);
    if ([control + '/status', control + '/finish', control + '/withdraw-payment', control + '/withdraw-refund'].includes(path)) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
      if (path.endsWith('/withdraw-payment')) {
        expect(paymentDropped).toBe(true); await f.db.execute(sql`UPDATE public.system_role SET rules='supplier.order.view,supplier.refund.manage' WHERE id=21`); paymentWithdrawn = true;
      }
      if (path.endsWith('/withdraw-refund')) {
        expect(refundDropped).toBe(true); await f.db.execute(sql`UPDATE public.system_role SET rules='supplier.order.view,supplier.refund.view' WHERE id=21`); refundWithdrawn = true;
      }
      if (path.endsWith('/finish')) {
        const after = await f.editState(id), [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
        expect(after.order).toMatchObject({ paid: 1, payType: 'offline', payPrice: '18.75', gainIntegral: '17.00' });
        expect(refund).toMatchObject({ id: refundId, refundType: 6, refundedPrice: refund.refundPrice });
        expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].nowMoney).toBe(buyer.nowMoney);
        expect(await f.db.select().from(storeOrderRefundPayment)).toHaveLength(0);
        expect(await f.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, refundId))).toHaveLength(1);
        expect(await f.exec('SELECT operation_id FROM public.supplier_offline_payment_operation_v1')).toHaveLength(1);
        expect(await f.exec('SELECT operation_id FROM public.supplier_manual_refund_operation_v1')).toHaveLength(1);
        expect(await f.exec('SELECT refund_id FROM public.supplier_manual_refund_proof_v1')).toHaveLength(1);
        expect(paths.filter(p => p.method === 'POST' && p.path === `/supplierapi/order/pay_offline/${id}`)).toHaveLength(1);
        expect(paths.filter(p => p.method === 'PUT' && p.path === `/supplierapi/refund/manual/${refundId}`)).toHaveLength(1);
        expect(paths.filter(p => p.method === 'GET' && p.path === `/supplierapi/order/payment_operations/${paymentOperation}`)).toHaveLength(1);
        expect(paths.filter(p => p.method === 'GET' && p.path === `/supplierapi/refund/manual_operations/${refundOperation}`)).toHaveLength(1);
        expect(paymentDropped && refundDropped && paymentRecovered && refundRecovered && paymentWithdrawn && refundWithdrawn).toBe(true);
        expect(paths.some(p => p.path === '/api/get_script' && p.status === 200)).toBe(true); expect(outbound).toBe(0); finished = true;
        await writeFile('/tmp/cinashop-supplier-cash-browser-result.json', JSON.stringify(await state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(await state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; expect(length).toBeLessThanOrEqual(16384); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks), headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      apiChain = apiChain.then(async () => {
        wiring.container = path.startsWith('/supplierapi/refund/') ? refundContainer : paymentContainer;
        const response = await app.fetch(new Request(origin + req.url, { method, headers, ...(bytes.length ? { body: new Uint8Array(bytes).buffer } : {}) }), env);
        const text = await response.text();
        if (path === '/api/get_script') { paths.push({ path, method, status: response.status }); expect(response.status).toBe(200); expect(text).toBe(''); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return; }
        const body = JSON.parse(text); paths.push({ path, method, status: response.status, envelope: body.status });
        if (method === 'POST' && path === `/supplierapi/order/pay_offline/${id}` && body.status === 200 && !paymentDropped) {
          expect(body.data.state).toBe('committed'); paymentOperation = body.data.operation_id; paymentDropped = true;
          await f.consumePaid(id); refundId = await applyRefund();
          return send(res, JSON.stringify({ status: 502, msg: 'Owned committed collection acknowledgement deliberately discarded', data: null }), 502, 'application/json');
        }
        if (method === 'PUT' && path === `/supplierapi/refund/manual/${refundId}` && body.status === 200 && !refundDropped) {
          expect(body.data.state).toBe('committed'); refundOperation = body.data.operation_id; refundDropped = true;
          return send(res, JSON.stringify({ status: 502, msg: 'Owned committed refund acknowledgement deliberately discarded', data: null }), 502, 'application/json');
        }
        if (paymentWithdrawn && method === 'GET' && path === `/supplierapi/order/payment_operations/${paymentOperation}` && body.status === 200 && body.data.state === 'committed') paymentRecovered = true;
        if (refundWithdrawn && method === 'GET' && path === `/supplierapi/refund/manual_operations/${refundOperation}` && body.status === 200 && body.data.state === 'committed') refundRecovered = true;
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text);
      }).catch(error => { send(res, 'Owned cash fixture failed', 500, 'text/plain'); fail(error); });
      await apiChain; return;
    }
    if (path.startsWith('/uploads/')) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9edf3"/></svg>', 200, 'image/svg+xml');
    const target = path.startsWith('/assets/') ? resolve(root, '.' + path) : resolve(root, 'index.html');
    expect(target === resolve(root, 'index.html') || target.startsWith(root + sep)).toBe(true);
    send(res, await readFile(target), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(target)] ?? 'text/html; charset=utf-8');
  })().catch(error => { send(res, 'Owned fixture failed', 500, 'text/plain'); fail(error); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('No outbound provider traffic in owned Supplier cash acceptance'); });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.withPaymentRuntime(async runtime => { paymentContainer = runtime.container;
      await f.withManualRuntime(async manualRuntime => { refundContainer = manualRuntime.container; applyRefund = () => f.apply(manualRuntime, id);
        await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address'); origin = `http://127.0.0.1:${address.port}`;
        process.stdout.write('SUPPLIER_CASH_BROWSER_READY ' + JSON.stringify({ control: origin + control, orders: origin + '/orders', payment: origin + `/orders/${id}/offline` }) + '\n');
        deadline = setTimeout(() => fail(Error('Supplier cash Browser finish not received')), 15 * 60_000);
        await completion; process.stdout.write('SUPPLIER_CASH_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
      });
    });
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); await f.close();
  }
}, 16 * 60_000);
