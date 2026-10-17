/** Interactive installed Browser acceptance. Production Admin/UniApp bundles
 * use actual App/JWT and two independent SELECT-only PG16 LOGINs. The visible
 * loopback control page alone invokes the real Supplier fixture writer. */
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderInvoice, storeOrderRefund, storeProduct, storeProductAttrValue,
  storeService, systemRole, userBill } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { supplierRefundSettlementReadOnlyRole } from '@/migrations/supplierRefundSettlementRead';
import { parseSupplierRefundSettlement, type SupplierRefundSettlement } from '../../../view/common/supplierRefundSettlement';
import { supplierRefundSettlementReadFixture, settlementReadPassword } from '../helpers/supplierRefundSettlementRead';

const wiring = vi.hoisted(() => ({ ordinary: undefined as Container | undefined, admin: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.ordinary) throw Error('Owned Customer reader absent'); return wiring.ordinary; },
  createAdminDatabaseSession: () => { if (!wiring.admin) throw Error('Owned Admin reader absent');
    return { container: wiring.admin, close: async () => {} }; },
}));
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected owned Browser response object');
  return value as Record<string, unknown>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('joins Customer and view-only Admin cumulative refund panels to actual immutable Supplier money evidence', async () => {
  const adminRoot = resolve(import.meta.dirname, '../../../view/admin-ts/dist');
  const mobileRoot = resolve(import.meta.dirname, '../../../view/uniapp-ts/dist/build/h5');
  for (const root of [adminRoot, mobileRoot]) expect((await stat(resolve(root, 'index.html'))).isFile()).toBe(true);
  const f = await supplierRefundSettlementReadFixture(), app = createApp();
  const control = '/__supplier_refund_settlement_fixture/' + randomUUID();
  const env = { ...f.paymentEnvironment, NODE_ENV: 'test', CONFIG_KV: {
    get: async (key: string) => key === 'cfg_system_statistics' ? '' : null, put: async () => {}, delete: async () => {},
  } } as unknown as Env;
  const customerToken = (await createToken(101, 'api', md5(settlementReadPassword), env.APP_KEY)).token;
  const adminToken = (await createToken(101, 'admin', md5(settlementReadPassword), env.APP_KEY)).token;
  type Snapshot = Awaited<ReturnType<typeof f.snapshot>>;
  type Realm = 'customer' | 'admin';
  const calls: Array<{ method: string; path: string; realm: Realm | null; http_status: number;
    status?: number; before: string; after: string; summary?: SupplierRefundSettlement; held?: boolean }> = [];
  const snapshots = new Map<string, Snapshot>(), controls: Array<{ action: string; at: string; snapshot: string }> = [];
  const writes: Array<{ order_id: number; operation_id: string; amount: string; kind: string }> = [];
  const summaryStages = new Set<string>(), denied = new Set<Realm>(), unavailable = new Set<Realm>(), damaged = new Set<Realm>();
  const historicalSupplierReads = new Set<Realm>();
  let origin = '', mainId = 0, secondId = 0, mainRefundId = 0, secondRefundId = 0;
  let mainNo = '', secondNo = '', mainRefundNo = '', secondRefundNo = '';
  let outbound = 0, finished = false, supplierWithdrawn = false, customerWithdrawn = false, adminWithdrawn = false;
  let selectWithdrawn = false, corrupt = false, heldCount = 0, releasedCount = 0;
  let arm: Realm | undefined, held: { response: ServerResponse; status: number; headers: Record<string, string>; text: string } | undefined;
  let chain = Promise.resolve(), deadline: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void, fail!: (error: Error) => void;
  const completion = new Promise<void>((yes, no) => { finish = yes; fail = no; });
  const capture = async () => { const snapshot = await f.snapshot(), fingerprint = hash(snapshot);
    snapshots.set(fingerprint, snapshot); return { snapshot, fingerprint }; };
  const actualOrder = async (id: number) => { const [row] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, id));
    if (!row) throw Error('Actual owned paid order absent'); return row; };
  const actualRefund = async (id: number) => { const rows = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId, id));
    expect(rows).toHaveLength(1); return rows[0]!; };
  const state = async () => ({ main: await actualOrder(mainId), second: await actualOrder(secondId), mainRefundId, secondRefundId,
    mainRefundNo, secondRefundNo, writes, calls, controls, summary_stages: [...summaryStages],
    historical_supplier_reads: [...historicalSupplierReads], denied: [...denied], unavailable: [...unavailable], damaged: [...damaged],
    supplierWithdrawn, customerWithdrawn, adminWithdrawn, selectWithdrawn, corrupt, hold_armed: arm ?? null,
    held: Boolean(held), heldCount, releasedCount, outbound, finished });
  const send = (response: ServerResponse, body: string | Buffer, status = 200, type = 'text/html; charset=utf-8') => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'" }); response.end(body);
  };
  const deliver = (response: ServerResponse, status: number, headers: Record<string, string>, text: string) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, headers); response.end(text);
  };
  const shell: Record<string, unknown> = {
    '/api/site_config': { site_name: 'CinaShop 本机只读核验', site_logo: '', record_No: '', ico_path: '/favicon.ico' },
    '/api/share': { title: '本机只读核验', synopsis: '', img: '' }, '/api/cart/count': { count: 0 },
    '/api/cart/list': [], '/api/diy/get_suspended': { is_show: 0, button: [] },
  };
  // Installed Browser performs all interactions. No external driver or browser
  // executable is loaded by this test process.
  const external = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    outbound++; throw Error('Owned settlement Browser forbids outbound provider or tax I/O');
  });
  let handleControl: (action: string) => Promise<void> = async () => { throw Error('Owned control not initialized'); };
  const server = createServer((req, res) => { void (async () => {
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(origin).host)
      return send(res, 'Owned loopback only', 403, 'text/plain');
    const url = new URL(req.url ?? '/', origin), path = url.pathname, method = req.method ?? 'GET';
    if (path === control && method === 'GET') {
      const links = {
        'customer-order-a': '/mobile/#/pages/customer-work/orderDetail?orderId=' + encodeURIComponent(mainNo),
        'customer-refund-a': '/mobile/#/pages/customer-work/refundDetail?refundOrderId=' + encodeURIComponent(mainRefundNo),
        'customer-order-b': '/mobile/#/pages/customer-work/orderDetail?orderId=' + encodeURIComponent(secondNo),
        'customer-refund-b': '/mobile/#/pages/customer-work/refundDetail?refundOrderId=' + encodeURIComponent(secondRefundNo),
        'admin-a': '/refund', 'admin-b': '/refund',
      };
      const actions = ['status', 'money5', 'tail6.75', 'supplier-withdraw', 'supplier-restore',
        'customer-withdraw', 'customer-restore', 'admin-withdraw', 'admin-restore', 'select-withdraw', 'select-restore',
        'damage', 'repair', 'hold-admin', 'hold-customer', 'release', 'finish'];
      return send(res, `<!doctype html><html lang="zh"><meta charset="utf-8"><title>累计供应商退款真实 PG16 验收</title>
        <h1>Customer / Admin 累计供应商退款只读验收</h1>
        <p>主单 A：订单 #${mainId} / ${mainNo}；首退款 #${mainRefundId} / ${mainRefundNo}。独立余额单 B：订单 #${secondId} / ${secondNo}；首退款 #${secondRefundId} / ${secondRefundNo}。</p>
        <p>Admin 只有 refund.view。进入后使用“恢复原操作的退款单 ID”打开 A=${mainRefundId} 或 B=${secondRefundId}，再点击“核验供应商累计退款”。两域原申请均应始终为7.00。</p>
        <p>先分别核验 A 的7.00；money5 后重新加载详情再核验12.00/余6.75；tail6.75 后重新加载核验18.75/余0.00。B是独立真实余额首退7.00，用于 A→B→A。旧页面 consistency 变动后须重新加载。</p>
        <p>撤回历史 Supplier 管理权限后两域仍可只读核验；恢复后才能继续补退。Customer/Admin 撤权各自应拒绝；select-withdraw 两域核验503；damage 两域核验409；之后必须恢复/repair。</p>
        <p>hold-admin 或 hold-customer 只扣住下一次 A 核验的真实成功回包。另一个控制页 tab 读取 status 确认 held，再在原页面 A→B→A，最后 release；旧回包不得覆盖新详情。整个过程只读页面不发送任何业务写请求。</p>
        <nav>${Object.keys(links).map(name => `<button id="${name}">${name}</button>`).join(' ')}</nav><hr>
        ${actions.map(name => `<button id="${name}">${name}</button>`).join(' ')}<pre id="state"></pre><script>
        const control=${JSON.stringify(control)},links=${JSON.stringify(links)},customerToken=${JSON.stringify(customerToken)},adminToken=${JSON.stringify(adminToken)};
        function login(kind){if(kind==='customer'){localStorage.setItem('uni_token',JSON.stringify({type:'string',data:customerToken}));localStorage.setItem('uni_uid',JSON.stringify({type:'number',data:101}));}
          else{localStorage.setItem('admin_token',adminToken);localStorage.setItem('admin_session',JSON.stringify({userInfo:{id:101,account:'owned-settlement-admin-101',head_pic:'',real_name:'只读核验员',level:1,roles:'101'},uniqueAuth:['refund.view'],menus:[{id:1,pid:0,path:'/refund',name:'退款审核',icon:'',sort:1,type:1,children:[]}]}));}}
        for(const [name,path] of Object.entries(links))document.getElementById(name).onclick=()=>{login(name.startsWith('customer')?'customer':'admin');location.href=path;};
        for(const name of ${JSON.stringify(actions)})document.getElementById(name).onclick=async()=>{try{const r=await fetch(control+'/'+name,{method:'POST'});document.getElementById('state').textContent=await r.text();}catch(e){document.getElementById('state').textContent=String(e);}};
        </script></html>`);
    }
    if (path.startsWith(control + '/')) {
      expect(method).toBe('POST'); expect(req.headers.origin).toBe(origin);
      const action = path.slice(control.length + 1);
      // A held HTTP response is deliberately outside this chain. Control and
      // subsequent A/B/A reads must continue while that response is pending.
      chain = chain.then(async () => { await handleControl(action); send(res, JSON.stringify(await state()), 200, 'application/json');
        if (finished) finish(); });
      await chain; return;
    }
    if (path === '/favicon.ico') return send(res, '', 204);
    if (method === 'GET' && Object.hasOwn(shell, path))
      return send(res, JSON.stringify({ status: 200, msg: 'owned shell only', data: shell[path] }), 200, 'application/json');
    if (path.startsWith('/api/') || path.startsWith('/adminapi/')) {
      expect(method, 'Readonly UI must never invoke a business mutation').toBe('GET');
      const allowed = path === '/api/get_script' || path === '/api/v2/diy/color_change/color_change'
        || /^\/api\/mobile\/work\/(?:context|orders\/[A-Za-z0-9_-]{1,50}(?:\/(?:remark|fulfillment))?|refunds\/[A-Za-z0-9_-]{1,50}|financial\/(?:orders|refunds)\/[1-9]\d*(?:\/supplier-refund-settlement)?|fulfillment\/waybills)$/.test(path)
        || /^\/(?:adminapi|api\/admin)\/(?:new_push|refund\/(?:list|detail\/[1-9]\d*|settlement\/[1-9]\d*))$/.test(path);
      expect(allowed, 'Unexpected actual business read: ' + path).toBe(true);
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const bearer = headers.get('authorization') ?? headers.get('authori-zation');
      const realm: Realm | null = bearer === 'Bearer ' + customerToken ? 'customer' : bearer === 'Bearer ' + adminToken ? 'admin' : null;
      chain = chain.then(async () => {
        const before = await capture();
        const response = await app.fetch(new Request(origin + req.url, { method, headers }), env);
        const text = await response.text(), after = await capture();
        expect(after.snapshot, 'Every actual HTTP GET must preserve the complete owned SQL snapshot: ' + path).toEqual(before.snapshot);
        const call: (typeof calls)[number] = { method, path: path + url.search, realm,
          http_status: response.status, before: before.fingerprint, after: after.fingerprint };
        calls.push(call);
        if (path === '/api/get_script') {
          expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/javascript'); expect(text).toBe('');
        } else {
          const body = object(JSON.parse(text)); expect(typeof body.status).toBe('number'); call.status = body.status as number;
          const isSummary = path.endsWith('/supplier-refund-settlement') || /\/refund\/settlement\//.test(path);
          if (isSummary) {
            expect(realm).not.toBe(null);
            if (body.status === 200) {
              const raw = realm === 'customer' ? object(body.data).data : body.data;
              const id = object(raw).order_id;
              if (typeof id !== 'number' || ![mainId, secondId].includes(id)) throw Error('Actual summary order outside owned pair');
              const actual = await actualOrder(id), refund = id === mainId ? mainRefundId : secondRefundId;
              const summary = parseSupplierRefundSettlement(raw, { order_id: actual.id, order_no: actual.orderId,
                uid: actual.uid, supplier_id: actual.supplierId, store_id: actual.storeId, refund_id: refund,
                refund_no: id === mainId ? mainRefundNo : secondRefundNo, goods_refunded: '7.00' });
              expect(summary).toMatchObject({ uid: 11, supplier_id: 7, paid: '18.75', goods_refunded: '7.00',
                pay_type: id === mainId ? 'offline' : 'yue', order_no: id === mainId ? mainNo : secondNo,
                refund_no: id === mainId ? mainRefundNo : secondRefundNo });
              expect(summary.refunded).toBe(actual.refundPrice);
              expect(response.headers.get('cache-control')).toContain('private, no-store');
              expect(JSON.stringify(summary)).not.toContain('operation_id'); call.summary = summary;
              summaryStages.add(`${realm}:${id}:${summary.refunded}`);
              if (supplierWithdrawn) historicalSupplierReads.add(realm!);
              if (arm === realm && id === mainId) {
                expect(held).toBeUndefined(); call.held = true; heldCount++;
                held = { response: res, status: response.status, headers: Object.fromEntries(response.headers), text };
                arm = undefined; return;
              }
            } else if (body.status === 503) { expect(selectWithdrawn).toBe(true); unavailable.add(realm!); }
            else if (body.status === 409) { expect(corrupt).toBe(true); damaged.add(realm!); }
            else if ((realm === 'customer' && customerWithdrawn || realm === 'admin' && adminWithdrawn)
              && [403, 400011, 410000, 410001, 410002].includes(body.status as number)) denied.add(realm!);
            else throw Error('Unexpected settlement rejection status ' + String(body.status));
          }
          if ((realm === 'customer' && customerWithdrawn || realm === 'admin' && adminWithdrawn)
            && [403, 400011, 410000, 410001, 410002].includes(body.status as number)) denied.add(realm);
        }
        deliver(res, response.status, Object.fromEntries(response.headers), text);
      });
      await chain; return;
    }
    expect(method).toBe('GET');
    const decoded = decodeURIComponent(path), candidates = decoded.startsWith('/mobile/')
      ? [resolve(mobileRoot, '.' + decoded.slice('/mobile'.length))]
      : [resolve(adminRoot, '.' + decoded), resolve(mobileRoot, '.' + decoded)];
    if (decoded === '/mobile' || decoded === '/mobile/' || decoded === '/mobile/index.html') candidates.unshift(resolve(mobileRoot, 'index.html'));
    if (!extname(decoded) && !decoded.startsWith('/mobile/')) candidates.unshift(resolve(adminRoot, 'index.html'));
    for (const candidate of candidates) {
      expect(candidate.startsWith(adminRoot + sep) || candidate.startsWith(mobileRoot + sep)).toBe(true);
      try { if (!(await stat(candidate)).isFile()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
      return send(res, await readFile(candidate), 200, types[extname(candidate)] ?? 'application/octet-stream');
    }
    send(res, 'Owned production asset absent', 404, 'text/plain');
  })().catch(error => { send(res, 'Owned settlement Browser bridge failed', 500, 'text/plain'); fail(error); }); });
  try {
    // Media is outside this acceptance; prepare original owned product input
    // before actual checkout freezes it into order cart snapshots.
    await f.db.update(storeProduct).set({ image: '' }); await f.db.update(storeProductAttrValue).set({ image: '' });
    mainId = await f.paid('offline'); secondId = await f.paid('yue', true);
    await f.db.insert(storeOrderInvoice).values([mainId, secondId].map(orderId => ({ orderId, uid: 11, category: 'order', isPay: 1,
      isRefund: 0, isInvoice: 0, invoiceAmount: '18.75', name: '累计退款核验真实未开原票', addTime: Math.floor(Date.now() / 1000) })));
    await f.withWriter(async (_writer, service) => {
      for (const id of [mainId, secondId]) {
        const result = await f.execute(service, id, '7.00');
        expect(result.result).toMatchObject({ state: 'committed', result: { order_id: id, kind: 'goods', amount: '7.00' } });
        writes.push({ order_id: id, operation_id: result.body.operation_id, amount: '7.00', kind: 'goods' });
      }
      const main = await actualOrder(mainId), second = await actualOrder(secondId);
      mainNo = main.orderId; secondNo = second.orderId;
      const first = await actualRefund(mainId), other = await actualRefund(secondId);
      mainRefundId = first.id; mainRefundNo = first.orderId; secondRefundId = other.id; secondRefundNo = other.orderId;
      const goods = await capture(), goodsPoints = (await f.db.select().from(userBill)).filter(row => row.category === 'integral');
      const invoices = await f.db.select().from(storeOrderInvoice);
      const [supplierRole] = await f.db.select().from(systemRole).where(eq(systemRole.id, 21));
      if (!supplierRole) throw Error('Actual Supplier actor role absent');
      const unchangedGoods = async () => {
        const current = (await capture()).snapshot;
        for (const key of ['store_order_refund', 'store_order_cart_info', 'store_product', 'store_product_attr_value', 'supplier_flowing_water', 'manual_proofs']) {
          expect(key in goods.snapshot && key in current).toBe(true);
          expect((current as Record<string, unknown>)[key], key).toEqual((goods.snapshot as Record<string, unknown>)[key]);
        }
        expect((await f.db.select().from(userBill)).filter(row => row.category === 'integral')).toEqual(goodsPoints);
        expect(await f.db.select().from(storeOrderInvoice)).toEqual(invoices);
      };
      await f.withReader(async (customer, commissionCustomer) => f.withReader(async (admin, commissionAdmin) => {
        await commissionCustomer(); await commissionAdmin(); expect(customer.role).not.toBe(admin.role);
        expect((await supplierRefundSettlementReadOnlyRole(customer.db)).ready).toBe(true);
        expect((await supplierRefundSettlementReadOnlyRole(admin.db)).ready).toBe(true);
        wiring.ordinary = customer.container; wiring.admin = admin.container;
        handleControl = async action => {
          expect(!finished).toBe(true);
          if (action === 'money5' || action === 'tail6.75') {
            expect(supplierWithdrawn || corrupt || selectWithdrawn).toBe(false);
            const amount = action === 'money5' ? '5.00' : '6.75';
            expect((await actualOrder(mainId)).refundPrice).toBe(action === 'money5' ? '7.00' : '12.00');
            const operation = await f.execute(service, mainId, amount);
            expect(operation.result).toMatchObject({ state: 'committed', result: { kind: 'money', order_id: mainId, refund_id: mainRefundId, amount } });
            writes.push({ order_id: mainId, operation_id: operation.body.operation_id, amount, kind: 'money' });
            await unchangedGoods();
          } else if (action === 'supplier-withdraw' || action === 'supplier-restore') {
            supplierWithdrawn = action.endsWith('withdraw');
            await f.db.update(systemRole).set({ rules: supplierWithdrawn ? 'supplier.order.view' : supplierRole.rules }).where(eq(systemRole.id, 21));
          } else if (action === 'customer-withdraw' || action === 'customer-restore') {
            customerWithdrawn = action.endsWith('withdraw');
            await f.db.update(storeService).set({ customer: customerWithdrawn ? 0 : 1 }).where(eq(storeService.id, 101));
          } else if (action === 'admin-withdraw' || action === 'admin-restore') {
            adminWithdrawn = action.endsWith('withdraw');
            await f.db.update(systemRole).set({ rules: adminWithdrawn ? 'order.view' : 'refund.view' }).where(eq(systemRole.id, 101));
          } else if (action === 'select-withdraw' || action === 'select-restore') {
            selectWithdrawn = action.endsWith('withdraw');
            for (const role of [customer.role, admin.role])
              await f.exec(`${selectWithdrawn ? 'REVOKE SELECT ON' : 'GRANT SELECT ON'} public.supplier_proactive_refund_decision_v1 ${selectWithdrawn ? 'FROM' : 'TO'} "${role}"`);
          } else if (action === 'damage' || action === 'repair') {
            corrupt = action === 'damage';
            await f.db.update(storeOrderRefund).set({ refundedPrice: corrupt ? '6.99' : '7.00' }).where(eq(storeOrderRefund.id, mainRefundId));
          } else if (action === 'hold-admin' || action === 'hold-customer') {
            expect(held || arm).toBeFalsy(); arm = action === 'hold-admin' ? 'admin' : 'customer';
          } else if (action === 'release') {
            expect(held).toBeDefined(); const original = held!; held = undefined; releasedCount++;
            deliver(original.response, original.status, original.headers, original.text);
          } else if (action === 'finish') {
            expect(corrupt || selectWithdrawn || customerWithdrawn || adminWithdrawn || Boolean(held) || Boolean(arm)).toBe(false);
            expect(await actualOrder(mainId)).toMatchObject({ payType: 'offline', payPrice: '18.75', refundPrice: '18.75', refundType: 6, refundStatus: 2 });
            expect(await actualOrder(secondId)).toMatchObject({ payType: 'yue', payPrice: '18.75', refundPrice: '7.00', refundType: 6, refundStatus: 2 });
            for (const id of [mainId, secondId]) expect(await actualRefund(id)).toMatchObject({ refundPrice: '7.00', refundedPrice: '7.00', refundNum: 3, refundType: 6 });
            for (const realm of ['customer', 'admin'] as const) {
              for (const total of ['7.00', '12.00', '18.75']) expect(summaryStages.has(`${realm}:${mainId}:${total}`), `${realm} actual main stage ${total}`).toBe(true);
              expect(summaryStages.has(`${realm}:${secondId}:7.00`)).toBe(true);
              expect(historicalSupplierReads.has(realm)).toBe(true); expect(denied.has(realm)).toBe(true);
              expect(unavailable.has(realm)).toBe(true); expect(damaged.has(realm)).toBe(true);
            }
            expect(heldCount).toBeGreaterThanOrEqual(1); expect(releasedCount).toBe(heldCount);
            expect(writes).toHaveLength(4); expect(new Set(writes.map(row => row.operation_id)).size).toBe(4);
            const final = (await capture()).snapshot;
            expect(final.proactive).toHaveLength(4); expect(final.decisions).toHaveLength(4);
            expect(final.money_completions).toHaveLength(2); expect(final.money_payments).toHaveLength(0);
            expect(calls.every(call => call.method === 'GET' && call.before === call.after)).toBe(true);
            expect(calls.some(call => call.path === '/api/get_script' && call.status === undefined && call.http_status === 200)).toBe(true);
            expect(outbound).toBe(0); await unchangedGoods(); finished = true;
          } else expect(action).toBe('status');
          controls.push({ action, at: new Date().toISOString(), snapshot: (await capture()).fingerprint });
          if (finished) {
            await writeFile('/tmp/cinashop-supplier-refund-settlement-browser-snapshots.json', JSON.stringify(Object.fromEntries(snapshots), null, 2) + '\n');
            await writeFile('/tmp/cinashop-supplier-refund-settlement-browser-result.json', JSON.stringify(await state(), null, 2) + '\n');
          }
        };
        await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
        const address = server.address(); if (!address || typeof address === 'string') throw Error('Owned loopback missing');
        origin = `http://127.0.0.1:${address.port}`;
        process.stdout.write('SUPPLIER_REFUND_SETTLEMENT_BROWSER_READY ' + JSON.stringify({ control: origin + control,
          admin: origin + '/refund', customerOrder: origin + '/mobile/#/pages/customer-work/orderDetail?orderId=' + mainNo,
          customerRefund: origin + '/mobile/#/pages/customer-work/refundDetail?refundOrderId=' + mainRefundNo,
          mainId, mainRefundId, secondId, secondRefundId, reader_roles: { customer: customer.role, admin: admin.role },
          result: '/tmp/cinashop-supplier-refund-settlement-browser-result.json',
          steps: ['both main goods7', 'both second yue goods7 and A/B/A', 'money5; reload both main12',
            'Supplier withdraw; both still read; restore', 'Customer/Admin withdraw deny then restore',
            'SELECT withdraw both503 then restore', 'damage both409 then repair', 'arm/hold actual main GET; A/B/A then release',
            'tail6.75; reload both main18.75 remaining0', 'desktop/mobile render and finish'] }) + '\n');
        deadline = setTimeout(() => fail(Error('Supplier settlement Browser finish not received')), 18 * 60_000);
        await completion;
        process.stdout.write('SUPPLIER_REFUND_SETTLEMENT_BROWSER_RESULT ' + JSON.stringify(await state()) + '\n');
      }));
    });
  } finally {
    if (deadline) clearTimeout(deadline); external.mockRestore(); wiring.ordinary = undefined; wiring.admin = undefined;
    server.closeAllConnections(); if (server.listening) await new Promise<void>(yes => server.close(() => yes()));
    await f.close();
  }
}, 19 * 60_000);
