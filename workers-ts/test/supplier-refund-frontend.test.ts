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
    export { default as Component } from './src/pages/Refunds.vue';
    export { http } from './src/api/http'; export * as api from './src/api/supplier';
    export * as dialog from 'element-plus'; export * as session from './src/utils/supplierSession';
    export { createPinia, disposePinia } from 'pinia';
    export { createRenderer, h, nextTick } from 'vue';
    export { createRouter, createMemoryHistory, RouterView } from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"' },
    plugins: [{ name: 'actual-refund-sfc', setup(builder) {
      builder.onLoad({ filter: /Refunds\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'supplier-refund-test' }).content, loader: 'ts' }));
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
  localStorage.setItem('supplier-permissions', '["supplier.refund.view","supplier.refund.manage"]');
  pinia = runtime.createPinia(); runtime.dialog.state.messages = []; runtime.dialog.state.closed = 0; runtime.dialog.state.confirm = async () => {};
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); });
const detail = (id = 25, changes = {}) => ({ id, store_order_id: id, refund_order_id: `R${id}`, order_id: `O${id}`, real_name: '本地客户', user_phone: '000000',
  is_cancel: 0, apply_type: 2, apply_price: '5.00', refund_type: 5, refund_num: 1, refund_price: '5.00', refunded_price: '0.00', refund_reason: '本地原因',
  refuse_reason: '', remark: '内部备注', add_time: 1700000000, refunded_time: 0, pay_type: 'yue', pay_price: '10.00', refund_explain: '申请说明',
  refund_express: `LOCAL-${id}`, refund_express_name: '本地快递甲', refund_phone: '000000', refund_goods_explain: '用户退货备注', returnImages: [], returnImagesError: '', cartInfo: null, orderInfo: null, ...changes });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(r => { resolve = r; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
async function mount(override: (config: any) => unknown = () => undefined) {
  const calls: any[] = []; let view: any;
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config);
    const body = await override(config) ?? { status: 200, data: config.url === '/refund/list' ? { list: [detail(25), detail(32)], count: 2 }
      : config.url === '/refund/reason' ? ['本地原因'] : config.method === 'put' ? null : detail(Number(config.url.split('/').at(-1))) };
    return { config, data: body, status: 200, statusText: 'local fixture', headers: {} };
  };
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/refunds', component: { setup(p: unknown, c: unknown) { view = runtime.Component.setup(p, c); return () => null; } } }, { path: '/away', component: { render: () => null } }] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router); await router.push('/refunds'); app.mount({ children: [] }); await flush();
  return { view, calls, router, writes: () => calls.filter(c => c.method === 'put'), close: () => app.unmount() };
}
it('renders a validated returned detail and clears sensitive content immediately when changing selection or closing', async () => {
  const wait = gate(), f = await mount(c => c.url === '/refund/detail/32' ? wait.promise : undefined);
  try { await f.view.openRefund({ id: 25 }); expect(f.view.current.value.refund_express).toBe('LOCAL-25');
    const pending = f.view.openRefund({ id: 32 }); expect(f.view.current.value).toBeNull(); expect(f.view.remark.value).toBe('');
    f.view.drawerOpen.value = false; wait.resolve({ status: 200, data: detail(32) }); await pending;
    expect(f.view.current.value).toBeNull(); expect(f.view.canWrite.value).toBe(false);
  } finally { f.close(); }
});
it('ignores A -> B -> A delayed detail responses', async () => {
  let count = 0; const wait = gate(), f = await mount(c => c.url === '/refund/detail/25' && ++count === 1 ? wait.promise : undefined);
  try { const first = f.view.openRefund({ id: 25 }); await f.view.openRefund({ id: 32 }); await f.view.openRefund({ id: 25 });
    wait.resolve({ status: 200, data: detail(25, { refund_goods_explain: 'stale' }) }); await first; expect(f.view.current.value.refund_goods_explain).toBe('用户退货备注');
  } finally { f.close(); }
});
it.each(['failure', 'wrong-id', 'active-image', 'missing-contract'])('fails closed with visible retry for %s detail receipts', async kind => {
  const f = await mount(c => c.url === '/refund/detail/32' ? { status: kind === 'failure' ? 500 : 200, msg: 'offline', data: kind === 'wrong-id' ? detail(25)
    : kind === 'active-image' ? detail(32, { returnImages: [{url:'javascript:alert(1)',src:'javascript:alert(1)'}] }) : detail(32, {is_cancel:undefined}) } : undefined);
  try { await f.view.openRefund({ id: 25 }); await f.view.openRefund({ id: 32 }); expect(f.view.current.value).toBeNull(); expect(f.view.detailError.value).toBeTruthy();
    await f.view.refundAction(); expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it.each(['switch', 'close', 'session', 'route'])('does not submit a confirmed refund after %s invalidates its exact view', async kind => {
  const wait = gate(), f = await mount(); runtime.dialog.state.confirm = () => wait.promise;
  try { await f.view.openRefund({ id: 25 }); const action = f.view.refundAction(); await flush();
    if (kind === 'switch') { await f.view.openRefund({ id: 32 }); await f.view.openRefund({ id: 25 }); }
    if (kind === 'close') f.view.drawerOpen.value = false;
    if (kind === 'session') surface.dispatchEvent(new Event('supplier-session-changed'));
    if (kind === 'route') await f.router.push('/away');
    wait.resolve(); await action; expect(f.writes()).toHaveLength(0);
  } finally { f.close(); }
});
it('captured exact refund identity/amount is sent only once; PROCESSING is never displayed as completed', async () => {
  const wait = gate(), f = await mount(c => c.method === 'put' ? wait.promise : undefined);
  try { await f.view.openRefund({ id: 25 }); const first = f.view.refundAction(); await flush(); await f.view.refundAction();
    expect(f.writes()).toHaveLength(1); expect(JSON.parse(f.writes()[0].data)).toEqual({ type: 1, refund_price: '5.00' }); expect(f.writes()[0].url).toBe('/refund/refund/25');
    wait.resolve({ status: 200, data: { completed: false, status: 'PROCESSING' } }); await first;
    expect(runtime.dialog.state.messages).toContainEqual(['success', '退款已受理，正在等待渠道确认']); expect(runtime.dialog.state.messages).not.toContainEqual(['success','退款完成']);
  } finally { f.close(); }
});
it.each([null, {}, {completed:true,status:'PROCESSING'}])('marks ambiguous refund success %j for read-only reconciliation without automatic retry', async receipt => {
  const f = await mount(c => c.method === 'put' ? {status:200,data:receipt} : undefined);
  try { await f.view.openRefund({id:25}); await f.view.refundAction(); expect(f.view.uncertainIds.has(25)).toBe(true);
    await f.view.refreshCurrent(); await f.view.refundAction(); expect(f.writes()).toHaveLength(1); expect(f.view.canWrite.value).toBe(false);
  } finally { f.close(); }
});
it('read-only and cancelled views cannot mutate even through direct event-handler invocation', async () => {
  localStorage.setItem('supplier-permissions', '["supplier.refund.view"]'); const f = await mount();
  try { await f.view.openRefund({id:25}); for (const action of ['saveRemark','agreeReturnAction','openRefuse','refundAction']) await f.view[action](); expect(f.writes()).toHaveLength(0); }
  finally { f.close(); }
  localStorage.setItem('supplier-permissions', '["supplier.refund.view","supplier.refund.manage"]');
  const cancelled = await mount(c => c.url === '/refund/detail/25' ? {status:200,data:detail(25,{is_cancel:1})} : undefined);
  try { await cancelled.view.openRefund({id:25}); expect(cancelled.view.displayStatus(cancelled.view.current.value).label).toBe('用户已取消'); await cancelled.view.saveRemark(); expect(cancelled.writes()).toHaveLength(0); }
  finally { cancelled.close(); }
});
it('late previous-row remark response cannot overwrite the new selection or emit a success toast', async () => {
  const wait = gate(), f = await mount(c => c.method === 'put' ? wait.promise : undefined);
  try { await f.view.openRefund({id:25}); f.view.remark.value='captured'; const action=f.view.saveRemark(); await flush(); await f.view.openRefund({id:32});
    wait.resolve({status:200,data:null}); await action; expect(f.view.current.value.id).toBe(32); expect(runtime.dialog.state.messages).toEqual([]);
    expect(f.writes()).toHaveLength(1); expect(JSON.parse(f.writes()[0].data)).toEqual({remark:'captured'});
  } finally { f.close(); }
});
it('session invalidation cancels queued API writes and clears rows, details, notes and images', async () => {
  const f = await mount();
  try { await f.view.openRefund({id:25}); const action=f.view.saveRemark(); surface.dispatchEvent(new Event('supplier-session-changed')); await action;
    expect(f.writes()).toHaveLength(0); expect(f.view.rows.value).toEqual([]); expect(f.view.current.value).toBeNull(); expect(f.view.remark.value).toBe('');
  } finally { f.close(); }
});
it('list refresh ignores a superseded response and failed search does not retain prior customer rows', async () => {
  const wait=gate(); let slow=false, failed=false;
  const f=await mount(c=>c.url==='/refund/list'&&(failed||slow)?failed?{status:500,msg:'list offline'}:wait.promise:undefined);
  try { slow=true; const older=f.view.load(); slow=false; await f.view.load(); wait.resolve({status:200,data:{list:[detail(99)],count:1}}); await older;
    expect(f.view.rows.value.map((r:any)=>r.id)).toEqual([25,32]); failed=true; await f.view.load(); expect(f.view.rows.value).toEqual([]); expect(f.view.listError.value).toBe('list offline');
  } finally {f.close();}
});
it('completed write with failed read-back offers only a refresh, and unknown write cannot be repeated', async () => {
  let written=false; const f=await mount(c=>c.method==='put'?(written=true,{status:200,data:null}):written&&c.url==='/refund/detail/25'?{status:500,msg:'read offline'}:undefined);
  try {await f.view.openRefund({id:25});await f.view.saveRemark();expect(f.view.current.value).toBeNull();expect(f.view.detailError.value).toBe('read offline');
    expect(runtime.dialog.state.messages).toContainEqual(['warning','操作已受理，但最新详情读取失败，请刷新核对']);await f.view.saveRemark();expect(f.writes()).toHaveLength(1);
  }finally{f.close();}
});
it('an ambiguous remark reply locks only that refund and a later valid image refresh clears the broken-image display', async () => {
  const f=await mount(c=>c.method==='put'?{status:500,msg:'transport unknown'}:undefined);
  try{await f.view.openRefund({id:25});await f.view.saveRemark();await f.view.saveRemark();expect(f.writes()).toHaveLength(1);expect(f.view.uncertainIds.has(25)).toBe(true);
    await f.view.openRefund({id:32});expect(f.view.canWrite.value).toBe(true);f.view.brokenImages.add('expired');await f.view.refreshCurrent();expect(f.view.brokenImages.size).toBe(0);
  }finally{f.close();}
});
it('explicit rejection permits a deliberate retry without automatic dispatch', async () => {
  const f=await mount(c=>c.method==='put'?{status:400,msg:'invalid note'}:undefined);
  try{await f.view.openRefund({id:25});await f.view.saveRemark();expect(f.view.uncertainIds.size).toBe(0);expect(f.writes()).toHaveLength(1);await f.view.saveRemark();expect(f.writes()).toHaveLength(2);}
  finally{f.close();}
});
