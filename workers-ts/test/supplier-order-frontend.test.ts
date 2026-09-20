import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

let runtime: any, surface: EventTarget, pinia: any;
const root = resolve(import.meta.dirname, '../../view/supplier-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
beforeAll(async () => {
  const output = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Component } from './src/pages/Orders.vue';
    export { http } from './src/api/http'; export * as api from './src/api/supplier';
    export * as dialog from 'element-plus'; export * as session from './src/utils/supplierSession';
    export { createPinia, disposePinia } from 'pinia';
    export * as downloads from './src/utils/legacy-export';
    export { createRenderer, h, nextTick } from 'vue';
    export { createRouter, createMemoryHistory, RouterView } from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    plugins: [{ name: 'actual-order-sfc', setup(builder) {
      builder.onLoad({ filter: /Orders\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'supplier-order-test' }).content, loader: 'ts' }));
      builder.onLoad({ filter: /legacy-export\.ts$/ }, () => ({ contents: 'export const saved=[]; export const downloadLegacyExport=m=>saved.push(m);' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const state={confirm:async()=>{},messages:[],closed:0};
        export const ElMessage={success:m=>state.messages.push(['success',m]),warning:m=>state.messages.push(['warning',m]),error:m=>state.messages.push(['error',m])};
        export const ElMessageBox={confirm:(...a)=>state.confirm(...a),close:()=>{state.closed++}};` }));
    } }], bundle: true, write: false, platform: 'browser', format: 'esm' });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  const values = new Map<string, string>(); surface = new EventTarget();
  vi.stubGlobal('window', surface); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  localStorage.setItem('supplier-token', 'fixture-a'); localStorage.setItem('supplier-user', '{"id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.order.view","supplier.order.manage","supplier.print.manage","supplier.waybill.manage"]');
  pinia = runtime.createPinia(); runtime.dialog.state.messages = []; runtime.dialog.state.closed = 0; runtime.dialog.state.confirm = async () => {}; runtime.downloads.saved.length = 0;
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); });

const order = (id = 25, changes = {}) => ({ id, pid: 0, order_id: `LOCAL-${id}`, real_name: `客户${id}`, user_phone: '000000',
  total_num: 2, pay_price: '10.00', paid: 1, status: 0, pay_type: 'yue', refund_status: 0, shipping_type: 1, product_type: 0,
  delivery_type: '', delivery_name: '', delivery_code: '', delivery_id: '', fictitious_content: '', remark: `备注${id}`,
  add_time: 1700000000, pay_time: 1700000001, cart_info: [], ...changes });
const cart = (id = 25) => ({ id, cart_id: `cart-${id}`, product_id: 1, sku_unique: '', cart_num: 2, refund_num: 0, surplus_num: 2,
  product_name: `商品${id}`, image: '', sku: '', cart_info: null });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(r => { resolve = r; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
async function mount(override: (config: any) => unknown = () => undefined) {
  const calls: any[] = []; let view: any;
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config);
    const id = Number(config.url.split('/').at(-1));
    const body = await override(config) ?? { status: 200, data:
      config.method === 'put' ? null :
      config.url === '/order/list' ? { list: [order(25), order(32)], count: 2 } :
      config.url === '/order/express_list' ? [{id:1,code:'LOCAL',name:'本地快递'}] :
      config.url.startsWith('/order/split_cart_info/') ? [cart(id)] :
      config.url.startsWith('/order/split_order/') ? [{ ...order(id), cart_info: [cart(id)] }] :
      config.url.startsWith('/order/status/') ? [{ id, oid:id, changeType:'pay',changeMessage:'已支付',changeTime:1700000001 }] : order(id) };
    return { config, data: body, status: 200, statusText: 'local fixture', headers: {} };
  };
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/orders', component: { setup(p: unknown, c: unknown) { view = runtime.Component.setup(p, c); return () => null; } } }, { path: '/away', component: { render: () => null } }] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router); await router.push('/orders'); app.mount({ children: [] }); await flush();
  return { view, calls, router, writes: () => calls.filter(c => c.method === 'put' || c.method === 'post'), close: () => app.unmount() };
}
function fillDelivery(view: any) { view.selectExpress(1); view.deliveryForm.company_id = 1; view.deliveryForm.delivery_id = 'LOCAL-TRACKING'; }
it('clears old order details synchronously and ignores late content after drawer close', async () => {
  const wait = gate(), f = await mount(c => c.url === '/order/info/32' ? wait.promise : undefined);
  try { await f.view.openOrder(order(25)); const pending = f.view.openOrder(order(32));
    expect(f.view.current.value).toBeNull(); expect(f.view.remark.value).toBe('');
    f.view.drawerOpen.value = false; wait.resolve({status:200,data:order(32)}); await pending;
    expect(f.view.current.value).toBeNull();
  } finally { wait.resolve({status:200,data:order(32)}); f.close(); }
});
it('delivery submits its captured order, not an unrelated detail drawer selection', async () => {
  const f = await mount();
  try { await f.view.openDelivery(order(25)); fillDelivery(f.view); await f.view.openOrder(order(32));
    await f.view.submitDelivery(); expect(f.writes()).toHaveLength(1); expect(f.writes()[0].url).toBe('/order/delivery/25');
    expect(f.view.current.value.id).toBe(32);
  } finally { f.close(); }
});
it('closing delivery while it loads never reopens it from a late response', async () => {
  const wait = gate(), f = await mount(c => c.url === '/order/split_cart_info/25' ? wait.promise : undefined);
  try { const pending = f.view.openDelivery(order(25)); await flush();
    expect(f.view.deliveryDialogOpen.value).toBe(true); f.view.deliveryDialogOpen.value = false;
    wait.resolve({status:200,data:[cart(25)]}); await pending;
    expect(f.view.deliveryDialogOpen.value).toBe(false); expect(f.view.splitItems.value).toEqual([]);
  } finally { wait.resolve({status:200,data:[cart(25)]}); f.close(); }
});
it('remark is captured once and cannot mutate another order or accept duplicate submission', async () => {
  const wait = gate(), f = await mount(c => c.method === 'put' ? wait.promise : undefined);
  try { await f.view.openOrder(order(25)); f.view.remark.value = '提交时备注';
    const pending = f.view.saveRemark(); await flush(); const duplicate = f.view.saveRemark(); await flush();
    expect(f.writes()).toHaveLength(1); await f.view.openOrder(order(32));
    wait.resolve({status:200,data:null}); await Promise.all([pending,duplicate]);
    expect(f.view.current.value.remark).toBe('备注32');
    expect(JSON.parse(f.writes()[0].data)).toEqual({remark:'提交时备注'});
  } finally { wait.resolve({status:200,data:null}); f.close(); }
});
it('session A -> B -> A clears all customer content and forbids writes', async () => {
  const f = await mount();
  try { await f.view.openOrder(order(25)); await f.view.openDelivery(order(25)); fillDelivery(f.view);
    runtime.session.clearSupplierSession(); localStorage.setItem('supplier-token','fixture-a');
    await f.view.saveRemark(); await f.view.submitDelivery();
    expect(f.view.rows.value).toEqual([]); expect(f.view.current.value).toBeNull(); expect(f.view.splitItems.value).toEqual([]); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it('new list request drops selection and ignores older completion', async () => {
  const wait = gate(); let delay = false;
  const f = await mount(c => delay && c.url === '/order/list' && c.params.order === 'old' ? wait.promise : undefined);
  try { f.view.selectOrders([order(25)]); delay = true; f.view.filters.order = 'old'; const pending = f.view.load(); await flush();
    expect(f.view.selectedOrders.value).toEqual([]); expect(f.view.rows.value).toEqual([]);
    f.view.filters.order = 'new'; await f.view.load(); wait.resolve({status:200,data:{list:[order(99)],count:1}}); await pending;
    expect(f.view.rows.value.map((r:any)=>r.id)).toEqual([25,32]);
  } finally { wait.resolve({status:200,data:{list:[],count:0}}); f.close(); }
});

it('detail and delivery A -> B -> A cannot resurrect earlier data or release current loading', async () => {
  const oldDetail = gate(), newDetail = gate(), oldCart = gate(); let details = 0, carts = 0;
  const f = await mount(c => c.url === '/order/info/25' ? (++details === 1 ? oldDetail.promise : newDetail.promise)
    : c.url === '/order/split_cart_info/25' && ++carts === 1 ? oldCart.promise : undefined);
  try {
    const first = f.view.openOrder(order(25)); await flush(); await f.view.openOrder(order(32));
    const latest = f.view.openOrder(order(25)); await flush(); oldDetail.resolve({status:200,data:order(25,{remark:'过期'})}); await first;
    expect(f.view.current.value).toBeNull(); expect(f.view.detailLoading.value).toBe(true);
    newDetail.resolve({status:200,data:order(25)}); await latest;
    const firstDelivery = f.view.openDelivery(order(25)); await flush(); await f.view.openDelivery(order(32)); await f.view.openDelivery(order(25));
    oldCart.resolve({status:200,data:[cart(99)]}); await firstDelivery;
    expect(f.view.splitItems.value[0].cart_id).toBe('cart-25'); expect(f.view.current.value.remark).toBe('备注25');
  } finally { oldDetail.resolve(); newDetail.resolve(); oldCart.resolve(); f.close(); }
});
it.each(['wrong-id','wrong-log','incomplete','failure'])('detail fails closed and can explicitly retry after %s', async kind => {
  let broken = true;
  const f = await mount(c => broken && c.url === (kind === 'wrong-log' ? '/order/status/25' : '/order/info/25')
    ? {status:kind === 'failure' ? 500 : 200, msg:'local failure', data:kind === 'wrong-id' ? order(32) : kind === 'incomplete' ? {} : kind === 'wrong-log' ? [{id:1,oid:32,changeMessage:'错单',changeTime:1}] : null} : undefined);
  try { await f.view.openOrder(order()); expect(f.view.current.value).toBeNull(); expect(f.view.detailError.value).toBeTruthy();
    await f.view.saveRemark(); expect(f.writes()).toHaveLength(0); broken = false; await f.view.refreshCurrent(); expect(f.view.current.value.id).toBe(25);
  } finally { f.close(); }
});
it.each(['permission','route','drawer','selection'])('pending confirmation cannot print after %s changes its view', async kind => {
  const wait = gate(), f = await mount(); runtime.dialog.state.confirm = () => wait.promise;
  try { await f.view.openOrder(order()); const pending = f.view.printOrder(order()); await flush();
    await f.view.printOrder(order()); expect(f.writes()).toHaveLength(0);
    if (kind === 'permission') { localStorage.setItem('supplier-permissions','[]'); surface.dispatchEvent(new Event('supplier-session-changed')); }
    if (kind === 'route') await f.router.push('/away');
    if (kind === 'drawer') f.view.drawerOpen.value = false;
    if (kind === 'selection') { await f.view.openOrder(order(32)); await f.view.openOrder(order(25)); }
    wait.resolve(); await pending; expect(f.writes()).toHaveLength(0);
  } finally { wait.resolve(); f.close(); }
});
it('read-only role rejects all write handlers and reopening a blocked delivery does not send', async () => {
  localStorage.setItem('supplier-permissions','["supplier.order.view"]'); const f = await mount();
  try { await f.view.openOrder(order()); await f.view.saveRemark(); await f.view.openDelivery(order()); await f.view.submitDelivery();
    await f.view.confirmTake(order(25,{status:1})); await f.view.printOrder(order()); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it.each(['failure','empty','duplicate-cart','bad-quantity'])('invalid delivery preparation %s stays non-submittable', async kind => {
  const f = await mount(c => c.url === '/order/split_cart_info/25' ? {status:kind === 'failure' ? 500 : 200,msg:'local',data:
    kind === 'empty' ? [] : kind === 'duplicate-cart' ? [cart(),cart()] : [ {...cart(),surplus_num:3} ]} : undefined);
  try { await f.view.openDelivery(order()); fillDelivery(f.view); await f.view.submitDelivery(); expect(f.view.deliveryError.value).toBeTruthy(); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it('delivery quantity and target are captured once while further edits cannot duplicate dispatch', async () => {
  const wait = gate(), f = await mount(c => c.method === 'put' ? wait.promise : undefined);
  try { await f.view.openDelivery(order()); fillDelivery(f.view); f.view.deliveryMode.value = 'partial'; f.view.selectedQuantities['cart-25'] = 1;
    const pending = f.view.submitDelivery(); await flush(); await f.view.submitDelivery();
    f.view.deliveryMode.value = 'whole'; f.view.deliveryForm.delivery_id = 'CHANGED'; f.view.selectedQuantities['cart-25'] = 2;
    expect(f.writes()).toHaveLength(1); expect(f.writes()[0].url).toBe('/order/split_delivery/25');
    expect(JSON.parse(f.writes()[0].data)).toMatchObject({delivery_id:'LOCAL-TRACKING',cart_ids:[{cart_id:'cart-25',cart_num:1}]});
    wait.resolve({status:200,data:{split:true,order_id:50,remaining_order_id:51}}); await pending;
    expect(runtime.dialog.state.messages).toContainEqual(['success','本批商品已发货']);
  } finally { wait.resolve(); f.close(); }
});
it.each(['transport','5xx','malformed-success'])('unknown delivery result %s stays read-only even after refresh', async kind => {
  const f = await mount(c => { if(c.method !== 'put') return; if(kind === 'transport') throw new Error('connection lost'); return {status:kind === '5xx' ? 500 : 200,data:{},msg:'local'}; });
  try { await f.view.openDelivery(order()); fillDelivery(f.view); await f.view.submitDelivery(); expect(f.view.uncertainIds.has(25)).toBe(true);
    await f.view.submitDelivery(); await f.view.load(); await f.view.openOrder(order()); await f.view.saveRemark(); await f.view.openDelivery(order()); await f.view.submitDelivery();
    expect(f.writes()).toHaveLength(1); expect(runtime.dialog.state.messages.some((m:any)=>m[0]==='success')).toBe(false);
  } finally { f.close(); }
});
it('accepted delivery with failed readback is never reported as failed delivery or retried', async () => {
  let accepted = false; const f = await mount(c => c.method === 'put' ? (accepted=true,{status:200,data:null})
    : accepted && c.url === '/order/list' ? {status:500,msg:'read unavailable'} : undefined);
  try { await f.view.openDelivery(order()); fillDelivery(f.view); await f.view.submitDelivery(); await f.view.submitDelivery();
    expect(f.writes()).toHaveLength(1); expect(f.view.rows.value).toEqual([]); expect(f.view.listError.value).toBeTruthy();
    expect(runtime.dialog.state.messages).toContainEqual(['success','订单已发货']);
    expect(runtime.dialog.state.messages.some((m:any)=>m[0]==='warning' && m[1].includes('操作已成功'))).toBe(true);
    expect(f.view.uncertainIds.has(25)).toBe(false);
  } finally { f.close(); }
});
it('an explicit command rejection permits deliberate corrected submission, not automatic retry', async () => {
  let rejected = true; const f = await mount(c => c.method === 'put' ? {status:rejected ? 400 : 200,msg:'tracking invalid',data:null} : undefined);
  try { await f.view.openDelivery(order()); fillDelivery(f.view); await f.view.submitDelivery(); expect(f.writes()).toHaveLength(1); expect(f.view.uncertainIds.has(25)).toBe(false);
    rejected = false; f.view.deliveryForm.delivery_id = 'CORRECTED'; await f.view.submitDelivery(); expect(f.writes()).toHaveLength(2);
  } finally { f.close(); }
});
it('selected order exports send an exact captured selection through the real HTTP client',async()=>{
  const manifest={filename:'local-selected'}, f=await mount(c=>c.url==='/export/storeOrder'?{status:200,data:manifest}:undefined);
  try {f.view.selectOrders(f.view.rows.value);await f.view.downloadSelectedOrders(0);
    expect(f.calls.find(c=>c.url==='/export/storeOrder').params).toEqual({ids:'25,32',type:0,page:1,selection:'exact'});
    expect(runtime.downloads.saved).toEqual([manifest]);expect(f.writes()).toEqual([]);
  }finally{f.close();}
});
it.each(['session','filter','route'])('late order exports cannot download after %s invalidation', async kind => {
  const wait = gate(), f = await mount(c => c.url === '/export/storeOrder' ? wait.promise : undefined);
  try { f.view.selectOrders(f.view.rows.value); const pending = f.view.downloadSelectedOrders(0); await flush();
    if (kind === 'session') runtime.session.clearSupplierSession();
    if (kind === 'filter') { f.view.filters.order = 'new'; await f.view.load(); }
    if (kind === 'route') await f.router.push('/away');
    wait.resolve({status:200,data:{filename:'fixture'}}); await pending; expect(runtime.downloads.saved).toHaveLength(0);
  } finally { wait.resolve(); f.close(); }
});
it('late queue detail cannot repopulate a closed dialog or a different task', async () => {
  const wait = gate(), f = await mount(c => c.url === '/queue/delivery/log/1/3' ? wait.promise : c.url.startsWith('/queue/delivery/log/') ? {status:200,data:{list:[],count:0}} : undefined);
  try { const first = f.view.openQueueDetail({id:1,cache_type:3}); await flush(); await f.view.openQueueDetail({id:2,cache_type:3});
    f.view.queueDetailOpen.value = false; wait.resolve({status:200,data:{list:[{binding_id:1,type:3}],count:1}}); await first;
    expect(f.view.queueDetailRows.value).toEqual([]); expect(f.view.queueDetailCurrent.value).toBeNull();
  } finally { wait.resolve(); f.close(); }
});
it('unmount clears customer content and prevents a late read or accepted write restoring it', async () => {
  const wait = gate(), f = await mount(c => c.method === 'put' ? wait.promise : undefined);
  await f.view.openOrder(order()); f.view.remark.value = 'pending'; const pending = f.view.saveRemark(); await flush(); f.close();
  wait.resolve({status:200,data:null}); await pending; expect(f.view.current.value).toBeNull(); expect(f.view.rows.value).toEqual([]);
  expect(runtime.dialog.state.messages).toEqual([]);
});
it('receipt confirmation reserves its action before the modal and dispatches only once', async () => {
  const confirm = gate(), write = gate(), f = await mount(c => c.method === 'put' ? write.promise : undefined);
  runtime.dialog.state.confirm = () => confirm.promise;
  try { const pending = f.view.confirmTake(order(25,{status:1})); await f.view.confirmTake(order(25,{status:1}));
    confirm.resolve(); await flush(); await f.view.confirmTake(order(25,{status:1}));
    expect(f.writes()).toHaveLength(1); expect(f.writes()[0].url).toBe('/order/take/25');
    write.resolve({status:200,data:null}); await pending; expect(runtime.dialog.state.messages).toContainEqual(['success','已确认收货，订单进入结算']);
  } finally { confirm.resolve(); write.resolve(); f.close(); }
});
it.each(['print','waybill'])('ambiguous %s acceptance cannot generate a new request key on retry', async type => {
  const f = await mount(c => c.method === 'post' ? {status:200,data:{duplicate:false}} : undefined);
  try {
    if(type === 'print') { await f.view.printOrder(order()); await f.view.printOrder(order()); }
    else { await f.view.openDelivery(order()); fillDelivery(f.view); f.view.deliveryForm.delivery_type = 'waybill'; await f.view.submitDelivery(); await f.view.submitDelivery(); }
    expect(f.writes()).toHaveLength(1); expect(f.view.uncertainIds.has(25)).toBe(true);
    expect(JSON.parse(f.writes()[0].data).request_key).toMatch(/^[a-f0-9-]{36}$/);
  } finally { f.close(); }
});
it('late success does not replace a newer local remark draft or another order', async () => {
  const wait = gate(), f = await mount(c => c.method === 'put' ? wait.promise : undefined);
  try { await f.view.openOrder(order()); f.view.remark.value = 'submitted'; const pending = f.view.saveRemark(); await flush();
    f.view.remark.value = 'new local draft'; wait.resolve({status:200,data:null}); await pending;
    expect(f.view.current.value.remark).toBe('submitted'); expect(f.view.remark.value).toBe('new local draft');
  } finally { wait.resolve(); f.close(); }
});
it('session changes suppress late failures and leave no customer state', async () => {
  const wait = gate(), f = await mount(c => c.url === '/order/info/25' ? wait.promise : undefined);
  try { const pending = f.view.openOrder(order()); await flush(); runtime.session.clearSupplierSession();
    wait.resolve({status:500,msg:'late error'}); await pending;
    expect(f.view.detailError.value).toBe(''); expect(f.view.current.value).toBeNull(); expect(runtime.dialog.state.messages).toEqual([]);
  } finally { wait.resolve(); f.close(); }
});
it.each([[null], [{...order(),cart_info:[null]}], [{...order(),cart_info:Array.from({length:201},()=>cart())}]])('rejects malformed shipment rendering payloads without partial detail %j', async payload => {
  const f = await mount(c => c.url === '/order/split_order/25' ? {status:200,data:payload} : undefined);
  try { await f.view.openOrder(order()); expect(f.view.current.value).toBeNull(); expect(f.view.detailError.value).toBeTruthy(); expect(f.view.shipments.value).toEqual([]); }
  finally { f.close(); }
});
