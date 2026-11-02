/** Actual SFC/router/axios lifecycle; HTTP/dialog/storage are labelled fixtures.
 * SQL and rendered Browser acceptance are separate. */
import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assignmentRequestHash, captureAssignmentRequest } from '@/services/order/FulfillmentAssignmentProtocol';
import { captureAdminAssignment, adminAssignmentHash, parseAdminAssignmentReceipt, parseAdminAssignmentReview, type AdminAssignmentInput, type AdminAssignmentReceipt } from '../../view/common/fulfillmentAssignment';
import { makeAssignmentIntent, readAssignmentIntent, writeAssignmentIntent, parseAssignmentIntent, withAssignmentIntentLock } from '../../view/admin-ts/src/utils/fulfillmentAssignmentIntent';

const hex = 'a'.repeat(64), base = '/order/fulfillment_assignment';
const input = (id = 91) => ({ format_version: 1 as const, operation_id: randomUUID(), kind: 'grant' as const,
  order_id: id, target_store_id: 77, expected_head: { ordinal: 0, operation_id: null }, expected_order_revision: hex, expected_source_hash: hex });
async function receipt(value: AdminAssignmentInput): Promise<AdminAssignmentReceipt> {
  const a = captureAssignmentRequest(value);
  return { operation_id: a.operation_id, format_version: 1, kind: a.kind, actor_id: 100, root_order_id: a.order_id,
    order_id: a.order_id, target_store_id: a.target_store_id, customer_uid: 11, financial_store_id: 0,
    ordinal: a.expected_head.ordinal + 1, previous_ref: a.expected_head.operation_id, order_revision: a.expected_order_revision,
    payload_hash: await assignmentRequestHash(a, 100), source_hash: a.expected_source_hash, created_at: 1793590000 };
}
const review = (id = 91) => ({ format_version: 1, order_id: id, customer_uid: 11, financial_store_id: 0, current_head: null,
  expected_head: { ordinal: 0, operation_id: null }, grant: { order_no: 'REAL' + id, order_revision: hex, source_hash: hex,
    source: { cart_rows: [{ row_id: 1, cart_id: 'cart-' + id, product_id: 70, unique: '蓝色', quantity: 2 }] } },
  grant_reason: '', revoke: null, admission: 'requires_locked_commit', can_append: true });
let runtime: any, surface: EventTarget, values: Map<string, string>, held = false;
const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export {default as Page} from './src/pages/order/FulfillmentAssignment.vue';
    export * as auth from './src/utils/auth'; export * as transport from './src/utils/orderRequest';
    export * as dialog from 'element-plus'; export {createRenderer,h,nextTick} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'real-assignment-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path,'utf8'), { filename: path }).descriptor,
        { id: 'assignment-page' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const state={confirm:async()=>{}};export const ElMessageBox={confirm:(...args)=>state.confirm(...args)};' }));
    } }] });
  runtime = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
});
function login(permissions = ['order.view','order.manage'], id = 100) {
  localStorage.setItem('admin_token', 'fixture-token-' + id);
  localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, level: 1 }, uniqueAuth: permissions, menus: [] }));
}
beforeEach(() => {
  values = new Map(); surface = new EventTarget(); held = false;
  vi.stubGlobal('window', Object.assign(surface, { location: { href: '', search: '', pathname: '/order' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
    key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } });
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object | null) => Promise<unknown>) => {
    if (held) return work(null); held = true; try { return await work({}); } finally { held = false; }
  } } });
  login(); runtime.dialog.state.confirm = async () => {};
});
afterEach(() => vi.unstubAllGlobals());
const envelope = (data: unknown) => ({ status: 200, data });
const flush = async () => { for (let i=0;i<25;i++) { await new Promise(r => setTimeout(r,1)); await runtime.nextTick(); } };
const gate = () => { let resolve!: (v: unknown) => void; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function mount(override: (config: any) => unknown = () => undefined, id = 91) {
  const calls: any[] = []; let view: any;
  runtime.transport.orderRequest.defaults.adapter = async (config: any) => {
    calls.push(config); let data = await override(config);
    if (data === undefined) data = envelope(config.url.startsWith(base + '/review/') ? review(Number(config.url.split('/').at(-1)))
      : config.url === base + '/stores' ? { list: [{ id: 77, name: '履约门店七七' }, { id: 78, name: '履约门店七八' }], next_after: null }
      : config.url === base + '/commit' ? { receipt: await receipt(JSON.parse(config.data)), replayed: false } : { state: 'unknown', receipt: null });
    return { config, data, status: 200, statusText: 'frontend fixture', headers: {} };
  };
  const component = { setup(p: unknown,c: unknown) { view = runtime.Page.setup(p,c); return () => null; } };
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/order/fulfillment-assignment', component }, { path: '/away', component: { render: () => null } }] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any,p: any) { n.parent=p; (p.children??=[]).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(router);
  await router.push('/order/fulfillment-assignment' + (id ? '?order_id=' + id : '')); app.mount({ children: [] }); await flush();
  return { get view() { return view; }, calls, router, writes: () => calls.filter(c => c.method === 'post'), close: () => app.unmount() };
}
it('matches the actual backend digest and validates stored receipt identity without source PII', async () => {
  const a = captureAdminAssignment(input()); expect(await adminAssignmentHash(a,100)).toBe(await assignmentRequestHash(captureAssignmentRequest(a),100));
  const saved = await receipt(a); expect(await parseAdminAssignmentReceipt(saved,100,a)).toMatchObject(saved);
  for (const change of [{ actor_id: 101 }, { order_id: 92 }, { financial_store_id: 77 }, { target_store_id: 78 }, { source_hash: 'b'.repeat(64) }, { extra: 1 }])
    await expect(parseAdminAssignmentReceipt({ ...saved,...change },100,a)).rejects.toThrow();
  expect((await parseAdminAssignmentReview(review(),91)).grant?.source.cart_rows[0].unique).toBe('蓝色');
  await expect(parseAdminAssignmentReview({ ...review(), expected_head: { ordinal: 1,operation_id: randomUUID() } },91)).rejects.toThrow();
});
it('refuses accessors, coercion and caller authority before hashing', () => {
  let invoked=0; const raw=input();
  for (const bad of [{ ...raw, get order_id() { invoked++; return 91; } }, { ...raw, actor_id: 100 }, { ...raw, order_id: '91' },
    Object.assign(Object.create({ inherited: true }),raw), { ...raw,[Symbol('authority')]:true }]) expect(()=>captureAdminAssignment(bad)).toThrow();
  expect(invoked).toBe(0);
});
it('persists exact pending content, keeps a recorded tombstone and rejects stale or corrupt local records', async () => {
  const saved=await makeAssignmentIntent(100,input()), raw=await writeAssignmentIntent(saved,null);
  expect(await readAssignmentIntent(100,91)).toEqual({raw,intent:saved});
  const final=await writeAssignmentIntent({...saved,phase:'recorded',receipt:await receipt(saved.input)},raw);
  await expect(writeAssignmentIntent(saved,null)).rejects.toThrow('另一标签'); expect((await readAssignmentIntent(100,91)).raw).toBe(final);
  for (const change of [{actor_id:101},{order_id:92},{payload_hash:'b'.repeat(64)},{phase:'unknown'},{receipt:{}}])
    await expect(parseAssignmentIntent({...saved,...change},100,91)).rejects.toThrow();
});
it('holds an immediate entity Web Lock and fails closed without support', async () => {
  const stop=gate(), first=withAssignmentIntentLock(91,()=>stop.promise);
  await expect(withAssignmentIntentLock(91,async()=>{})).rejects.toThrow('另一标签'); stop.resolve(null); await first;
  vi.stubGlobal('navigator',{}); await expect(withAssignmentIntentLock(91,async()=>{})).rejects.toThrow('Web Locks');
});
it('uses actual scoped bearer and persists the exact original request before its POST', async () => {
  let storedBeforePost=false;
  const f=await mount(async config=>{if(config.method==='post'){const sent=JSON.parse(config.data),saved=await readAssignmentIntent(100,91);
    storedBeforePost=saved.intent?.phase==='pending'&&saved.intent.input.operation_id===sent.operation_id; expect(saved.intent?.input).toEqual(sent);}});
  try {expect(f.view.review.value.order_id).toBe(91);expect(f.calls[0].headers['Authori-zation']).toBe('Bearer fixture-token-100');
    f.view.target.value=77;await f.view.decide('grant'); expect(storedBeforePost).toBe(true);expect(f.writes()).toHaveLength(1);
    expect((await readAssignmentIntent(100,91)).intent?.phase).toBe('recorded');expect(f.view.review.value).toBeNull();
    expect(f.view.message.value).toContain('服务器回执');
  }finally{f.close();}
});
it('retains a lost response as pending, unknown leaves it pending and restore uses identical UUID/body', async () => {
  let posts=0;const f=await mount(config=>{if(config.method==='post'&&++posts===1)throw Error('labelled lost POST response');});
  try {f.view.target.value=77;await f.view.decide('grant');const first=f.writes()[0].data;
    expect(f.view.intent.value.phase).toBe('pending');await f.view.recover(false);expect(f.view.message.value).toContain('不能据此认定未执行');
    await f.view.decide('grant');expect(f.writes()).toHaveLength(1);await f.view.recover(true);
    expect(f.writes()).toHaveLength(2);expect(f.writes()[1].data).toBe(first);expect(f.view.intent.value.phase).toBe('recorded');
  }finally{f.close();}
});
it('sends nothing when durable local storage fails', async () => {
  const f=await mount();try{f.view.target.value=77;vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('fixture quota');});
    await f.view.decide('grant');expect(f.writes()).toHaveLength(0);expect(f.view.message.value).toContain('quota');
  }finally{vi.restoreAllMocks();f.close();}
});
it('shows a safe capability error instead of throwing when secure UUID support is absent', async () => {
  const f=await mount();try{vi.stubGlobal('crypto',{subtle:crypto.subtle});f.view.target.value=77;
    await f.view.decide('grant');expect(f.writes()).toHaveLength(0);expect(f.view.busy.value).toBe(false);
    expect(f.view.message.value).toContain('安全请求编号');expect(values.has('admin-fulfillment-assignment-journal-v1:100:91')).toBe(false);
  }finally{f.close();}
});
it('account ABA during the actual request hash cannot persist or submit the captured intent', async () => {
  const f=await mount(), release=gate(), cryptoBefore=crypto;let entered=false;
  try{vi.stubGlobal('crypto',{randomUUID:()=>cryptoBefore.randomUUID(),subtle:{digest:async(...args:Parameters<SubtleCrypto['digest']>)=>{
      entered=true;await release.promise;return cryptoBefore.subtle.digest(...args);
    }}});f.view.target.value=77;const pending=f.view.decide('grant');
    for(let i=0;i<50&&!entered;i++)await new Promise(resolve=>setTimeout(resolve,1));expect(entered).toBe(true);
    runtime.auth.setToken('fixture-token-B');runtime.auth.setToken('fixture-token-100');release.resolve(null);await pending;
    expect(f.view.sessionValid.value).toBe(false);expect(f.view.review.value).toBeNull();expect(f.writes()).toHaveLength(0);
    expect(values.has('admin-fulfillment-assignment-journal-v1:100:91')).toBe(false);
  }finally{release.resolve(null);f.close();}
});
it('keeps owner recovery reachable with no order permission and performs no review/stores/POST', async () => {
  const saved=await makeAssignmentIntent(100,input());await writeAssignmentIntent(saved,null);login([]);
  const actual=await receipt(saved.input), f=await mount(config=>config.url.startsWith(base+'/receipt/')?envelope({state:'recorded',receipt:actual}):undefined);
  try{expect(f.calls).toHaveLength(0);expect(f.view.intent.value.input).toEqual(saved.input);expect(f.view.canManage.value).toBe(false);
    await f.view.recover(false);expect(f.calls).toHaveLength(1);expect(f.calls[0].url).toBe(base+'/receipt/'+saved.input.operation_id);
    expect(f.view.intent.value.phase).toBe('recorded');expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it('a read-only reviewer cannot submit or fetch the manage-only target directory', async () => {
  login(['order.view']);const f=await mount();try{expect(f.view.review.value).not.toBeNull();expect(f.view.canManage.value).toBe(false);
    f.view.target.value=77;await f.view.decide('grant');expect(f.writes()).toHaveLength(0);expect(f.calls.some(c=>c.url===base+'/stores')).toBe(false);
  }finally{f.close();}
});
it('account A to B to A invalidation cancels a delayed review and old captured actions', async () => {
  const delayed=gate();const f=await mount(c=>c.url===base+'/review/91'?delayed.promise:undefined);
  try{const captured=f.view.decide;runtime.auth.setToken('fixture-token-B');runtime.auth.setToken('fixture-token-100');
    delayed.resolve(envelope(review()));await flush();expect(f.view.sessionValid.value).toBe(false);expect(f.view.review.value).toBeNull();
    f.view.target.value=77;await captured('grant');expect(f.writes()).toHaveLength(0);expect(f.calls[0].signal.aborted).toBe(true);
  }finally{f.close();}
});
it('route changes prevent a delayed old order from replacing the new review', async () => {
  const delayed=gate();const f=await mount(c=>c.url===base+'/review/91'?delayed.promise:undefined);
  try{await f.router.push('/order/fulfillment-assignment?order_id=92');await flush();expect(f.view.review.value.order_id).toBe(92);
    delayed.resolve(envelope(review()));await flush();expect(f.view.review.value.order_id).toBe(92);expect(f.writes()).toHaveLength(0);
  }finally{f.close();}
});
it('the default recovery page lists only this actor pending requests without business API reads', async () => {
  await writeAssignmentIntent(await makeAssignmentIntent(100,input()),null);await writeAssignmentIntent(await makeAssignmentIntent(101,input(92)),null);
  const f=await mount(undefined,0);try{expect(f.view.pendingOrders.value).toEqual([91]);expect(f.calls).toHaveLength(0);}finally{f.close();}
});
