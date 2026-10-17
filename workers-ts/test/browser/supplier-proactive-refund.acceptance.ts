/** Installed Browser + production Vue bundle + actual App/JWT and separate
 * restricted PG16 LOGINs. Only synthetic cart/invoice inputs are prepared by
 * the fixture; checkout, edits, payments, paid consumption and every refund
 * run their actual services. No provider or tax service is contacted. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { capitalFlow, storeCart, storeOrder, storeOrderInvoice, storeOrderRefund, storeOrderRefundPayment,
  storeOrderRefundSplit, supplierFlowingWater, supplierTransactions, systemRole, user, userBill } from '@/models/schema';
import { createToken } from '@/utils/jwt';
import { installSupplierProactiveRefund } from '@/migrations/supplierProactiveRefund';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { StoreOrderPayService } from '@/services/order/StoreOrderPayService';
import type { SupplierProactiveRefundReceipt } from '@/services/supplier/SupplierProactiveRefundOperation';
import { supplierManualRefundFixture } from '../helpers/supplierManualRefund';
import { supplierOrderEditActor, supplierOrderEditAppKey } from '../helpers/supplierUnpaidOrderEdit';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing actual owned Supplier proactive refund runtime');
  return wiring.container;
} }));

it('executes actual goods and money refunds in Browser and recovers the original committed UUID without another write', async () => {
  const root = resolve(import.meta.dirname, '../../../view/supplier-ts/dist');
  expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierManualRefundFixture(), actor = supplierOrderEditActor();
  const control = '/__supplier_proactive_refund_fixture/' + randomUUID();
  const token = (await createToken(21, 'supplier', actor.authVersion, supplierOrderEditAppKey)).token;
  const viewerToken = (await createToken(22, 'supplier', supplierOrderEditActor(22).authVersion, supplierOrderEditAppKey)).token;
  const env = { ...f.paymentEnvironment, NODE_ENV: 'test', CONFIG_KV: {
    get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {},
  } } as unknown as Env;
  const app = createApp(), paths: Array<{ method: string; path: string; status: number; actor: number | null;
    envelope?: number; operation_id?: string; kind?: string; amount?: string }> = [];
  const writes = new Map<string, { order: number; kind: string; amount: string }>();
  let mainId = 0, yueId = 0, mainNo = '', origin = '', outbound = 0, finished = false;
  let dropped = false, recovered = false, withdrawn = false, restored = false, viewerObserved = false;
  let firstOperation = '', lostOperation = '', tailOperation = '', refuseOperation = '', yueOperation = '';
  let mainRefundId = 0, yueRefundId = 0;
  let apiChain = Promise.resolve(), deadline: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const snapshot = async () => ({ ...await f.manualSnapshot(),
    flows: await f.db.select().from(capitalFlow).orderBy(capitalFlow.id),
    invoices: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
    proactive: await f.exec('SELECT * FROM public.supplier_proactive_refund_operation_v1 ORDER BY operation_id'),
    decisions: await f.exec('SELECT * FROM public.supplier_proactive_refund_decision_v1 ORDER BY operation_id'),
    money_completions: await f.exec('SELECT * FROM public.supplier_refund_money_completion_v1 ORDER BY operation_id'),
    money_payments: await f.exec('SELECT * FROM public.supplier_refund_money_payment_v1 ORDER BY operation_id') });
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  let firstGoods: Snapshot | undefined, afterMain: Snapshot | undefined;
  let firstGoodsBuyer: typeof user.$inferSelect | undefined, paidBuyer: typeof user.$inferSelect | undefined;
  const buyer = async () => (await f.db.select().from(user).where(eq(user.uid, 11)))[0]!;
  const order = async (id: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0]!;
  function onlyMoneyChanged(before: Snapshot, after: Snapshot) {
    const allowed = new Set(['store_order', 'store_order_status', 'user', 'user_bill', 'supplier_transactions',
      'proactive', 'decisions', 'flows', 'money_completions']);
    for (const [table, rows] of Object.entries(before)) {
      if (allowed.has(table)) continue;
      if (table === 'consumer_tables') {
        for (const [name, values] of Object.entries(rows as Record<string, unknown>))
          if (!allowed.has(name)) expect(after.consumer_tables[name]).toEqual(values);
      } else expect((after as Record<string, unknown>)[table]).toEqual(rows);
    }
  }
  const state = async () => ({ main: await order(mainId), yue: await order(yueId), mainRefundId, yueRefundId,
    paths, writes: [...writes].map(([operation_id, value]) => ({ operation_id, ...value })),
    firstOperation, lostOperation, tailOperation, refuseOperation, yueOperation,
    dropped, recovered, withdrawn, restored, viewerObserved, finished, outbound });
  const send = (res: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store' }); res.end(body);
  };
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host)
      return send(res, 'Owned loopback only', 403, 'text/plain');
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>供应商主动退款 PG16 验收</title><h1>真实供应商主动退款联合验收</h1>
      <p>仅本机合成数据。先 offline 商品退款7.00，再补退5.00（真实提交后故意丢回执）；撤权后只读恢复原 UUID，恢复权限后补退6.75。最后在独立余额单拒绝7.00，再退款7.00。</p>
      <p>线下订单 #${mainId}；独立余额订单 #${yueId}。查看子账号应没有“主动退款”按钮。</p>
      <button id="login">进入订单管理</button><button id="viewer">查看子账号进入订单管理</button><button id="withdraw">撤销管理权并核对原结果</button><button id="restore">恢复管理权并核对余款</button><button id="yue">进入独立余额订单</button><button id="status">读取 SQL 状态</button><button id="finish">完成并关闭夹具</button><pre id="state"></pre><script>
      const ownerToken=${JSON.stringify(token)},viewerToken=${JSON.stringify(viewerToken)},control=${JSON.stringify(control)};
      function login(viewer,path){localStorage.setItem('supplier-token',viewer?viewerToken:ownerToken);localStorage.setItem('supplier-user',JSON.stringify({id:viewer?22:21,supplier_id:7,supplier_name:'本机主动退款供应商',account:viewer?'owned-proactive-viewer':'owned-proactive-owner'}));localStorage.setItem('supplier-permissions',JSON.stringify(viewer?['supplier.order.view']:['supplier.order.view','supplier.order.manage']));location.href=path;}
      document.getElementById('login').onclick=()=>login(false,'/orders');document.getElementById('viewer').onclick=()=>login(true,'/orders');
      document.getElementById('withdraw').onclick=async()=>{const r=await fetch(control+'/withdraw',{method:'POST'});if(r.ok){localStorage.setItem('supplier-permissions','["supplier.order.view"]');location.href='/orders/refund-result';}else document.getElementById('state').textContent=await r.text();};
      document.getElementById('restore').onclick=async()=>{const r=await fetch(control+'/restore',{method:'POST'});if(r.ok)login(false,'/orders/${mainId}/refund');else document.getElementById('state').textContent=await r.text();};
      document.getElementById('yue').onclick=()=>login(false,'/orders/${yueId}/refund');
      for(const name of ['status','finish'])document.getElementById(name).onclick=async()=>{const r=await fetch(control+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();};</script></html>`);
    if ([control + '/status', control + '/finish', control + '/withdraw', control + '/restore'].includes(path)) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
      if (path.endsWith('/withdraw')) {
        expect(dropped && !!lostOperation && !tailOperation).toBe(true);
        await f.db.update(systemRole).set({ rules: 'supplier.order.view' }).where(eq(systemRole.id, 21)); withdrawn = true;
      }
      if (path.endsWith('/restore')) {
        expect(withdrawn && recovered).toBe(true);
        await f.db.update(systemRole).set({ rules: 'supplier.order.view,supplier.order.manage' }).where(eq(systemRole.id, 21)); restored = true;
      }
      if (path.endsWith('/finish')) {
        expect(dropped && recovered && withdrawn && restored && viewerObserved).toBe(true);
        expect([firstOperation, lostOperation, tailOperation, refuseOperation, yueOperation].every(Boolean)).toBe(true);
        expect(new Set([firstOperation, lostOperation, tailOperation, refuseOperation, yueOperation]).size).toBe(5);
        expect(writes.size).toBe(5);
        expect(await order(mainId)).toMatchObject({ paid: 1, payType: 'offline', payPrice: '18.75', refundPrice: '18.75', refundStatus: 2, refundType: 6 });
        expect(await order(yueId)).toMatchObject({ paid: 1, payType: 'yue', payPrice: '18.75', refundPrice: '7.00', refundStatus: 2, refundType: 6 });
        const mainRefunds = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, mainId));
        expect(mainRefunds).toHaveLength(1); expect(mainRefunds[0]).toMatchObject({ id: mainRefundId, refundType: 6, refundNum: 3, refundPrice: '7.00', refundedPrice: '7.00' });
        const yueRefunds = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, yueId));
        expect(yueRefunds).toHaveLength(1); expect(yueRefunds[0]).toMatchObject({ id: yueRefundId, refundType: 6, refundNum: 3, refundPrice: '7.00', refundedPrice: '7.00' });
        expect(await f.db.select().from(storeOrderRefundSplit)).toHaveLength(2);
        expect(await f.db.select().from(storeOrderRefundPayment)).toHaveLength(0);
        expect(await f.exec('SELECT operation_id FROM public.supplier_refund_money_payment_v1')).toHaveLength(0);
        expect(await f.exec('SELECT operation_id FROM public.supplier_proactive_refund_operation_v1')).toHaveLength(5);
        expect(await f.exec('SELECT operation_id FROM public.supplier_proactive_refund_decision_v1')).toHaveLength(5);
        expect(await f.exec('SELECT refund_id FROM public.supplier_manual_refund_proof_v1')).toHaveLength(1);
        const completions = await f.exec('SELECT amount::text,before_refunded::text,after_refunded::text FROM public.supplier_refund_money_completion_v1 AS completion ORDER BY completion.before_refunded');
        expect(completions).toEqual([{ amount: '5.00', before_refunded: '7.00', after_refunded: '12.00' }, { amount: '6.75', before_refunded: '12.00', after_refunded: '18.75' }]);
        expect((await f.db.select().from(capitalFlow).orderBy(capitalFlow.id)).map(row => row.price)).toEqual(['-7.00', '-5.00', '-6.75']);
        const transactions = await f.db.select().from(supplierTransactions).where(eq(supplierTransactions.linkId, mainNo));
        expect(transactions.filter(row => row.type === 2).map(row => row.payPrice).sort()).toEqual(['5.00', '6.75', '7.00']);
        const mainLedger = await f.db.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.linkId, mainNo));
        expect(mainLedger).toHaveLength(2); expect(mainLedger.filter(row => row.type === 2)).toHaveLength(1);
        expect((await f.db.select().from(userBill)).filter(row => row.type === 'pay_product_refund')).toMatchObject([{ uid: 11, number: '7.00', category: 'now_money', pm: 1, status: 1 }]);
        expect(BigInt((await buyer()).nowMoney.replace('.', '')) - BigInt(paidBuyer!.nowMoney.replace('.', ''))).toBe(700n);
        expect((await f.db.select().from(storeOrderInvoice)).map(row => ({ amount: row.invoiceAmount, refunded: row.isRefund, issued: row.isInvoice })))
          .toEqual([{ amount: '18.75', refunded: 1, issued: 0 }, { amount: '18.75', refunded: 1, issued: 0 }]);
        expect(paths.filter(row => row.method === 'PUT' && row.path === `/supplierapi/order/refund/${mainId}`)).toHaveLength(3);
        expect(paths.filter(row => row.method === 'PUT' && row.path === `/supplierapi/order/refund/${yueId}`)).toHaveLength(2);
        expect(paths.some(row => row.method === 'GET' && row.path === `/supplierapi/order/refund_operations/${lostOperation}` && row.actor === 21)).toBe(true);
        expect(paths.filter(row => row.actor === 22 && row.method !== 'GET')).toEqual([]);
        expect(paths.some(row => row.path === '/api/get_script' && row.status === 200)).toBe(true);
        expect(outbound).toBe(0); finished = true;
        await writeFile('/tmp/cinashop-supplier-proactive-refund-browser-result.json', JSON.stringify(await state(), null, 2) + '\n');
      }
      send(res, JSON.stringify(await state()), 200, 'application/json'); if (finished) finish(); return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (path.startsWith('/supplierapi/') || path === '/api/get_script') {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; expect(length).toBeLessThanOrEqual(16384); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks), headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const principal = headers.get('authorization') === 'Bearer ' + token ? 21 : headers.get('authorization') === 'Bearer ' + viewerToken ? 22 : null;
      apiChain = apiChain.then(async () => {
        const isWrite = method === 'PUT' && [mainId, yueId].some(id => path === `/supplierapi/order/refund/${id}`);
        if (withdrawn && !restored) expect(isWrite).toBe(false);
        const recoveringOriginal = withdrawn && method === 'GET' && path === `/supplierapi/order/refund_operations/${lostOperation}`;
        const before = isWrite || recoveringOriginal ? await snapshot() : undefined;
        const response = await app.fetch(new Request(origin + req.url, { method, headers,
          ...(bytes.length ? { body: new Uint8Array(bytes).buffer } : {}) }), env);
        const text = await response.text();
        if (path === '/api/get_script') {
          paths.push({ path, method, status: response.status, actor: principal }); expect(response.status).toBe(200);
          expect(response.headers.get('content-type')).toContain('application/javascript'); expect(text).toBe('');
          res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text); return;
        }
        const body = JSON.parse(text) as { status: number; data?: SupplierProactiveRefundReceipt };
        const receipt = body.data;
        paths.push({ path, method, status: response.status, actor: principal, envelope: body.status,
          ...(isWrite && receipt ? { operation_id: receipt.operation_id, kind: receipt.result?.kind, amount: receipt.result?.amount } : {}) });
        if (principal === 22 && method === 'GET' && path === '/supplierapi/order/list' && body.status === 200) viewerObserved = true;
        if (isWrite && body.status === 200) {
          expect(principal).toBe(21); expect(response.headers.get('cache-control')).toContain('private, no-store');
          expect(receipt).toMatchObject({ state: 'committed', actor_id: 21, supplier_id: 7 });
          const result = receipt!.result!, submitted = JSON.parse(bytes.toString('utf8')) as { operation_id: string; refund_price: string; type?: number };
          expect(receipt!.operation_id).toBe(submitted.operation_id); expect(result.amount).toBe(submitted.refund_price);
          expect(writes.has(receipt!.operation_id)).toBe(false);
          writes.set(receipt!.operation_id, { order: result.order_id, kind: result.kind, amount: result.amount });
          if (path === `/supplierapi/order/refund/${mainId}`) {
            if (!firstOperation) {
              expect(result).toMatchObject({ order_id: mainId, kind: 'goods', amount: '7.00', status: 'CASH_SUCCESS' });
              firstOperation = receipt!.operation_id; mainRefundId = result.refund_id!;
              expect(await order(mainId)).toMatchObject({ refundPrice: '7.00', refundStatus: 2, refundType: 6 });
              firstGoods = await snapshot(); firstGoodsBuyer = await buyer();
            } else {
              expect(result).toMatchObject({ order_id: mainId, refund_id: mainRefundId, kind: 'money', status: 'CASH_SUCCESS' });
              onlyMoneyChanged(firstGoods!, await snapshot()); expect(await buyer()).toEqual(firstGoodsBuyer);
              if (!lostOperation) {
                expect(result.amount).toBe('5.00'); lostOperation = receipt!.operation_id; dropped = true;
                expect(await order(mainId)).toMatchObject({ refundPrice: '12.00' });
                return send(res, JSON.stringify({ status: 502, msg: 'Owned committed money acknowledgement deliberately discarded', data: null }), 502, 'application/json');
              }
              expect(restored && recovered && !tailOperation).toBe(true); expect(result.amount).toBe('6.75');
              tailOperation = receipt!.operation_id; expect(await order(mainId)).toMatchObject({ refundPrice: '18.75' }); afterMain = await snapshot();
            }
          } else {
            expect(!!tailOperation && !!afterMain).toBe(true);
            if (!refuseOperation) {
              expect(submitted.type).toBe(2); expect(result).toMatchObject({ order_id: yueId, refund_id: null, kind: 'refuse', amount: '7.00', status: 'REFUSED' });
              const after = await snapshot();
              expect({ ...after, store_order: [], proactive: [], decisions: [] }).toEqual({ ...before!, store_order: [], proactive: [], decisions: [] });
              expect(await order(yueId)).toMatchObject({ refundPrice: '0.00', refundStatus: 0, refundType: 3 }); refuseOperation = receipt!.operation_id;
            } else {
              expect(!yueOperation).toBe(true); expect(result).toMatchObject({ order_id: yueId, kind: 'goods', amount: '7.00', status: 'BALANCE_SUCCESS' });
              yueOperation = receipt!.operation_id; yueRefundId = result.refund_id!;
            }
          }
        }
        if (recoveringOriginal) {
          expect(body).toMatchObject({ status: 200, data: { operation_id: lostOperation, actor_id: 21, supplier_id: 7, order_id: mainId,
            state: 'committed', result: { kind: 'money', refund_id: mainRefundId, amount: '5.00', status: 'CASH_SUCCESS' } } });
          expect(await snapshot()).toEqual(before); recovered = true;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(text);
      }).catch(error => { send(res, 'Owned proactive refund fixture failed', 500, 'text/plain'); fail(error); });
      await apiChain; return;
    }
    if (path.startsWith('/uploads/')) return send(res, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#d9edf3"/></svg>', 200, 'image/svg+xml');
    const target = path.startsWith('/assets/') ? resolve(root, '.' + path) : resolve(root, 'index.html');
    expect(target === resolve(root, 'index.html') || target.startsWith(root + sep)).toBe(true);
    send(res, await readFile(target), 200, ({ '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(target)] ?? 'text/html; charset=utf-8');
  })().catch(error => { send(res, 'Owned proactive refund fixture failed', 500, 'text/plain'); fail(error); }); });
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { outbound++; throw Error('No outbound provider or tax traffic in owned Supplier proactive refund acceptance'); });
  try {
    const main = await f.createOffline(); mainId = main.id; mainNo = main.orderId;
    await f.withEditRuntime(async (_runtime, edit) => {
      const seed = await edit.seed(mainId, actor);
      await edit.save(mainId, { ...seed.values, operation_id: randomUUID(), revision: seed.revision, pay_price: '18.75', gain_integral: '17' }, actor);
    });
    await f.withPaymentRuntime(async (_runtime, payment) => payment.pay(mainId, await f.paymentBody(mainId, payment), actor));
    await f.consumePaid(mainId);
    const yue = await f.withPaymentRuntime(async runtime => {
      // The first checkout owns paid cart1/2. A second real checkout needs
      // independent owned cart input, never reuse the paid rows or stamp paid.
      const original = await f.db.select().from(storeCart).where(sql`${storeCart.id} IN (1,2)`).orderBy(storeCart.id);
      expect(original).toHaveLength(2);
      const carts = await f.db.insert(storeCart).values(original.map(row => ({ ...row, id: row.id + 1000, isPay: 0, status: 1 }))).returning({ id: storeCart.id });
      const created = await StoreOrderCreateService.createWithRuntime(runtime.container,
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'wx' + randomUUID().replaceAll('-', '').slice(0, 28) },
        { uid: 11, key: randomUUID(), cartIds: carts.map(row => row.id), addressId: 11, userIp: '127.0.0.1', useIntegral: true, payType: 'offline', from: 'pc' });
      expect(await new StoreOrderPayService(runtime.container, f.paymentEnvironment).offlinePay(11, created.orderId, 'pc')).toMatchObject({ paid: false, pay_type: 'offline' });
      const [actual] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      if (!actual || actual.paid !== 0 || actual.supplierId !== 7 || actual.payType !== 'offline') throw Error('Independent actual Supplier checkout absent');
      return actual;
    }); yueId = yue.id;
    await f.withEditRuntime(async (_runtime, edit) => {
      const seed = await edit.seed(yueId, actor);
      await edit.save(yueId, { ...seed.values, operation_id: randomUUID(), revision: seed.revision, pay_price: '18.75', gain_integral: '17' }, actor);
    });
    await f.withPaidConsumer(async runtime => {
      expect(await new StoreOrderPayService(runtime.container, f.paymentEnvironment).yuePay(11, yue.orderId)).toEqual({ paid: true });
    });
    await f.consumePaid(yueId); paidBuyer = await buyer();
    // Genuine owned unissued invoice inputs. Issued red-note/tax delivery is
    // deliberately outside this browser acceptance and remains unclaimed.
    await f.db.insert(storeOrderInvoice).values([mainId, yueId].map(id => ({ orderId: id, uid: 11, category: 'order', isPay: 1,
      isRefund: 0, isInvoice: 0, invoiceAmount: '18.75', name: '主动退款真实原整票', addTime: Math.floor(Date.now() / 1000) })));
    await f.withManualRuntime(async runtime => {
      await f.db.transaction(tx => installSupplierProactiveRefund(tx, { runtimeRole: runtime.role }));
      await f.db.update(systemRole).set({ rules: 'supplier.order.view,supplier.order.manage' }).where(eq(systemRole.id, 21));
      const grants = runtimeBusinessPrivilegePlan('app').tables.capital_flow;
      for (const privilege of ['SELECT', 'INSERT']) expect(grants).toContain(privilege);
      await f.exec(`GRANT SELECT,INSERT ON public.capital_flow TO "${runtime.role}";GRANT USAGE ON SEQUENCE public.capital_flow_id_seq TO "${runtime.role}"`);
      wiring.container = runtime.container;
      await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
      const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing owned loopback address');
      origin = `http://127.0.0.1:${address.port}`;
      process.stdout.write('SUPPLIER_PROACTIVE_REFUND_BROWSER_READY ' + JSON.stringify({ control: origin + control,
        orders: origin + '/orders', refund: origin + `/orders/${mainId}/refund`, result: origin + '/orders/refund-result',
        yue: origin + `/orders/${yueId}/refund`, mainId, yueId,
        steps: ['viewer has no proactive refund button', 'owner offline goods7.00', 'offline money5.00 loses committed reply',
          'withdraw manage, reload result, GET original UUID', 'restore manage, money6.75', 'fresh yue refuse7.00', 'fresh yue goods7.00', 'finish'] }) + '\n');
      deadline = setTimeout(() => fail(Error('Supplier proactive refund Browser finish not received')), 18 * 60_000);
      await completion;
      process.stdout.write('SUPPLIER_PROACTIVE_REFUND_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
    });
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.container = undefined;
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(yes => server.close(() => yes()));
    await f.close();
  }
}, 19 * 60_000);
