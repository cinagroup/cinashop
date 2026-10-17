import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, browser: EventTarget, runtimeDirectory: string, hostDocument: { activeElement: null };
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import Page from './src/pages/FinanceExtracts.vue';export {Page};export const captured={};
    const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export * as api from './src/api/supplierExtracts';export * as mediaApi from './src/api/supplierExtractMedia';export {useAuthStore} from './src/stores/auth';export {http} from './src/api/http';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,ref} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-extract-media', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'supplier-extract', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-extract', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
    } }] });
  runtimeDirectory = mkdtempSync('/tmp/cinashop-supplier-extract-media-sfc-');
  const path = resolve(runtimeDirectory, 'compiled-page.mjs'); writeFileSync(path, result.outputFiles[0].text);
  runtime = await import(pathToFileURL(path).href);
}, 30000);
afterAll(() => { if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true }); });
function login(permissions = ['supplier.finance.view'], token = 'owned-extract-session-a', id = 21, supplierId = 7) {
  localStorage.setItem('supplier-token', token); localStorage.setItem('supplier-user', JSON.stringify({ id, supplier_id: supplierId }));
  localStorage.setItem('supplier-permissions', JSON.stringify(permissions));
}
beforeEach(() => {
  const local = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '' } }));
  class HostDocument { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('ShadowRoot', class {});
  hostDocument = new HostDocument(); vi.stubGlobal('document', hostDocument);
  vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) });
  login(); pinia = runtime.createPinia();
});


afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node; [key: string]: any };
const content = (node: Node): string => (node.text ?? '') + node.children.map(content).join('');
async function mount(url = '/finance/extracts', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [];
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config);
    const value = custom ?? transport(config);
    return { config, data: { status: 200, msg: 'owned extract transport', data: value }, status: 200, statusText: 'owned', headers: {} };
  };
  const host: Node = { children: [], props: {} };
  const renderer = runtime.createRenderer({ createElement: (tag: string) => {
    const node: Node = Object.assign(new EventTarget(), { tag, tagName: tag.toUpperCase(), children: [] as Node[], props: {}, value: '', multiple: false, selected: false, getRootNode: () => hostDocument });
    Object.defineProperty(node, 'options', { get: () => node.children.filter(child => child.tag === 'option') }); return node;
  }, createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
    insert(node: Node, parent: Node, anchor?: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(at < 0 ? parent.children.length : at, 0, node); },
    remove(node: Node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); }, parentNode: (node: Node) => node.parent,
    nextSibling: (node: Node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp(node: Node, property: string, _: unknown, value: unknown) { node.props[property] = value; if (['value', 'type', 'selected', 'multiple', 'checked'].includes(property)) node[property] = value; }, setText(node: Node, value: string) { node.text = value; }, setElementText(node: Node, value: string) { node.text = value; node.children = []; } });
  const refresh = runtime.ref(0);
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/finance/extracts', component: runtime.Page, props: () => ({ refreshKey: refresh.value }) }, { path: '/away', component: { render: () => null } } ] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  app.component('el-button', { inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h('button', attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, host, calls, router, refresh, close: () => app.unmount() };
}

const query = (changes: Record<string, unknown> = {}) => ({ status: '', pay_status: '', extract_type: '', data: '', page: 1, limit: 20, ...changes });
const marks = new Map<number, { mark: string; revision: string }>();
beforeEach(() => marks.clear());
function row(id = 105): any {
  return { id, supplier_id: 7, extract_type: id === 104 ? 'weixin' : id === 103 ? 'alipay' : 'bank',
    bank_code: '000062220001', bank_address: '申请时开户行', alipay_account: 'historical-alipay', wechat: 'historical-wechat',
    qrcode_url: [103,104].includes(id) ? '/api/assets/31' : '', extract_price: id === 104 ? '30.00' : id === 103 ? '20.00' : id === 102 ? '40.00' : '1.00',
    balance: '735.00', supplier_mark: marks.get(id)?.mark ?? '', status: id === 102 ? -1 : [103, 104].includes(id) ? 1 : 0,
    pay_status: id === 104 ? 1 : 0, admin_id: [103, 104].includes(id) ? 101 : 0, admin_name: [103, 104].includes(id) ? '历史经办人' : '',
    fail_msg: id === 102 ? '账目待复核' : '', fail_time: id === 102 ? '2026-09-05 11:00:00' : '',
    voucher_image: id === 104 ? '/api/assets/42' : '', voucher_title: id === 104 ? '本机转账登记' : '',
    pay_time: id === 104 ? '2026-09-05 12:00:00' : '', add_time: '2026-09-04 12:00:00', revision: marks.get(id)?.revision ?? 'a'.repeat(64) };
}
function history(q = query()) {
  let list = Array.from({ length: 105 }, (_, i) => row(105 - i));
  if (q.status) list = list.filter(value => value.status === Number(q.status));
  if (q.pay_status) list = list.filter(value => value.pay_status === Number(q.pay_status));
  if (q.extract_type) list = list.filter(value => value.extract_type === q.extract_type);
  return { version: 'supplier-extract-v1', selection: 'history', supplier_id: 7, ...q, bounded: true,
    statistics: { pending_review: '102.00', pending_transfer: '20.00', paid: '30.00', withdrawable: '735.00', extract_min_price: '5.50', extract_max_price: '200.00' },
    count: list.length, list: list.slice((Number(q.page) - 1) * Number(q.limit), Number(q.page) * Number(q.limit)) };
}
function markResult(id: number) { const value = row(id); return { version: 'supplier-extract-mark-v1', supplier_id: 7, id, supplier_mark: value.supplier_mark, revision: value.revision, bounded: true }; }
function transport(config: any): any {
  const mediaId = Number(config.url.match(/\/(\d+)\/media$/)?.[1]); if (mediaId) return mediaContext(row(mediaId));
  const id = Number(config.url.match(/\/mark\/(\d+)$/)?.[1]);
  if (id) { if (config.method === 'post') marks.set(id, { mark: JSON.parse(config.data).mark, revision: 'b'.repeat(64) }); return markResult(id); }
  return history(config.params);
}
function nodes(node: Node, tag: string): Node[] { return [...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => nodes(child, tag))]; }


function mediaContext(source = row(104), actor = 21) {
  const expires = Math.floor(Date.now() / 1000) + 300;
  const preview = (reference: string, eligible: boolean) => {
    const id = /\/assets\/([1-9]\d*)/.exec(reference)?.[1];
    if (!reference || !eligible) return { reference, status: 'unavailable', src: '', expires_at: null };
    return { reference, status: 'ready', src: id ? `/api/assets/${id}?expires=${expires}&signature=${'a'.repeat(43)}` : reference, expires_at: id ? expires : null };
  };
  return { version: 'supplier-extract-media-v1', actor_id: actor, supplier_id: source.supplier_id, id: source.id,
    revision: source.revision, previews: { qrcode: preview(source.qrcode_url, ['alipay','weixin'].includes(source.extract_type)),
      voucher: preview(source.voucher_image, source.status === 1 && source.pay_status === 1 && !!source.pay_time && source.admin_id > 0) }, bounded: true };
}
const mediaCalls = (f: any) => f.calls.filter((c: any) => /\/\d+\/media$/.test(c.url));
const openPaid = async (f: any) => { f.view.openDetails(f.view.result.value.list.find((r: any) => r.id === 104)); await flush(); };
const sources = (f: any) => nodes(f.host, 'img').map(n => n.props.src as string);

describe('actual Supplier historical withdrawal private media', () => {
  it('delegates only the selected historical QR and recorded Admin voucher with finance.view and no attachment capability', async () => {
    const f = await mount(); try {
      await openPaid(f); expect(f.view.media.value).toMatchObject({ actor_id: 21, supplier_id: 7, id: 104, revision: 'a'.repeat(64) });
      expect(mediaCalls(f)).toHaveLength(1); expect(mediaCalls(f)[0]).toMatchObject({ method: 'get', url: '/finance/supplier_extract/104/media', params: { revision: 'a'.repeat(64) } });
      expect(sources(f)).toHaveLength(2); expect(sources(f)[0]).toMatch(/^\/api\/assets\/31\?expires=/); expect(sources(f)[1]).toMatch(/^\/api\/assets\/42\?expires=/);
      expect(content(f.host)).toContain('历史经办人'); expect(content(f.host)).toContain('本机转账登记'); expect(content(f.host)).not.toContain('编辑备注');
      expect(f.calls.some((c: any) => /file\/|finance\/info/.test(c.url) || c.method !== 'get')).toBe(false);
    } finally { f.close(); }
  });
  it('does not dispatch history or media without live finance.view', async () => {
    login([]); const f = await mount(); try { f.view.openDetails(row(104)); await f.view.loadMedia(); expect(f.calls).toHaveLength(0); expect(sources(f)).toHaveLength(0); }
    finally { f.close(); }
  });
  it('keeps safe public historical images available without acquiring a private projection', async () => {
    const f = await mount(undefined, (c: any) => { const value = transport(c); if (c.url.endsWith('/list')) { value.list.find((r: any) => r.id === 104).qrcode_url = '/owned-media/old-qr.png'; value.list.find((r: any) => r.id === 104).voucher_image = 'https://cdn.invalid/old-proof.png'; } return value; });
    try { await openPaid(f); expect(sources(f)).toEqual(['/owned-media/old-qr.png','https://cdn.invalid/old-proof.png']); expect(mediaCalls(f)).toHaveLength(0); }
    finally { f.close(); }
  });
  it('does not borrow a QR projection for a voucher with the same reference', async () => {
    const source = { ...row(104), voucher_image: '/api/assets/31' }, context = mediaContext(source);
    context.previews.voucher = { reference: source.voucher_image, status: 'unavailable', src: '', expires_at: null };
    const parsed = runtime.mediaApi.parseSupplierExtractMedia(context, { actor_id: 21, supplier_id: 7 }, source);
    expect(runtime.mediaApi.supplierExtractMediaImage(parsed, source, 'qrcode')).toMatch(/^\/api\/assets\/31\?/);
    expect(runtime.mediaApi.supplierExtractMediaImage(parsed, source, 'voucher')).toBe('');
  });
  it('uses a new authorized ticket for a stored historical bearer alias instead of rendering the alias', async () => {
    const source = { ...row(104), qrcode_url: '/kefuapi/assets/31?expires=1&signature='+'e'.repeat(43) }, parsed = runtime.mediaApi.parseSupplierExtractMedia(mediaContext(source), { actor_id:21,supplier_id:7 }, source);
    expect(runtime.mediaApi.supplierExtractMediaImage(parsed, source, 'qrcode')).toMatch(/^\/api\/assets\/31\?expires=/);
    expect(runtime.mediaApi.supplierExtractMediaImage(undefined, source, 'qrcode')).toBe('');
  });
  it('hides failed QR bytes without hiding the separate voucher and retries only on an explicit read', async () => {
    const f = await mount(); try { await openPaid(f); nodes(f.host,'img')[0].props.onError(); await flush(); expect(sources(f)).toHaveLength(1); expect(sources(f)[0]).toMatch(/^\/api\/assets\/42\?/);
      expect(mediaCalls(f)).toHaveLength(1); await f.view.loadMedia(); await flush(); expect(mediaCalls(f)).toHaveLength(2); expect(sources(f)).toHaveLength(2);
    } finally { f.close(); }
  });
  it('hides expired private previews and obtains fresh tickets only after the user rereads', async () => {
    vi.useFakeTimers(); const f = await mount(); try { await openPaid(f); expect(sources(f)).toHaveLength(2); const count=mediaCalls(f).length;
      vi.setSystemTime(Date.now()+301000); await vi.advanceTimersByTimeAsync(1000); await flush(); expect(sources(f)).toHaveLength(0); expect(mediaCalls(f)).toHaveLength(count);
      await f.view.loadMedia(); await flush(); expect(mediaCalls(f)).toHaveLength(count+1); expect(sources(f)).toHaveLength(2);
    } finally { f.close(); vi.useRealTimers(); }
  });
  it('retains no private image after an unknown read failure and never retries automatically', async () => {
    let failed=true; const f=await mount(undefined,(c:any)=>{if(c.url.endsWith('/media')&&failed)throw Error('owned read unavailable');});
    try {await openPaid(f); expect(sources(f)).toHaveLength(0);expect(f.view.media.value).toBeUndefined();expect(content(f.host)).toContain('owned read unavailable');expect(mediaCalls(f)).toHaveLength(1);
      failed=false;await f.view.loadMedia();await flush();expect(sources(f)).toHaveLength(2);expect(mediaCalls(f)).toHaveLength(2);expect(f.calls.every((c:any)=>c.method==='get')).toBe(true);
    } finally {f.close();}
  });
  it('rejects a response from a newer row and asks for a fresh historical query',async()=>{
    const f=await mount(undefined,(c:any)=>c.url.endsWith('/media')?{...mediaContext(),revision:'b'.repeat(64)}:undefined);
    try{await openPaid(f);expect(sources(f)).toHaveLength(0);expect(f.view.media.value).toBeUndefined();expect(content(f.host)).toContain('若记录已变化，请重新查询提现记录');}
    finally{f.close();}
  });
  it.each(['detail','close','filter','route','session_aba','permission','refresh','unmount'])('discards an ignored-abort late media response after %s',async(kind:string)=>{
    const late=gate(),f=await mount(undefined,(c:any)=>{if(c.url==='/finance/supplier_extract/104/media'){c.signal=undefined;return late.promise;}});let closed=false;
    try{await openPaid(f);expect(f.view.mediaLoading.value).toBe(true);
      if(kind==='detail'){f.view.openDetails(f.view.result.value.list.find((r:any)=>r.id===103));await flush();}
      if(kind==='close')f.view.closeDetails();if(kind==='filter')f.view.status.value='1';if(kind==='route')await f.router.push('/away');
      if(kind==='session_aba'){login([],'owned-b',31,8);browser.dispatchEvent(new Event('supplier-session-changed'));login();browser.dispatchEvent(new Event('supplier-session-changed'));}
      if(kind==='permission')runtime.useAuthStore(pinia).permissions=[];if(kind==='refresh')await f.view.load();if(kind==='unmount'){f.close();closed=true;}
      late.resolve(mediaContext());await flush();expect(f.view.media.value?.id).not.toBe(104);expect(sources(f).some(src=>src.startsWith('/api/assets/42?'))).toBe(false);
      if(kind==='detail'){expect(f.view.detail.value.id).toBe(103);expect(f.view.media.value?.id).toBe(103);expect(sources(f)).toHaveLength(1);}else expect(sources(f)).toHaveLength(0);
    }finally{if(!closed)f.close();}
  });
  it('cancels a real Axios queued media GET before the adapter after session A to B to A',async()=>{
    const queued=gate(),f=await mount();const interceptor=runtime.http.interceptors.request.use(async(c:any)=>{if(c.url.endsWith('/media'))await queued.promise;return c;});
    try{await openPaid(f);expect(mediaCalls(f)).toHaveLength(0);login([],'owned-b',31,8);browser.dispatchEvent(new Event('supplier-session-changed'));login();browser.dispatchEvent(new Event('supplier-session-changed'));queued.resolve(undefined);await flush();expect(mediaCalls(f)).toHaveLength(0);expect(f.view.result.value).toBeNull();expect(sources(f)).toHaveLength(0);}
    finally{runtime.http.interceptors.request.eject(interceptor);f.close();}
  });
  it('clears historical accounts and previews if storage becomes unavailable',async()=>{
    const f=await mount();try{await openPaid(f);expect(sources(f)).toHaveLength(2);localStorage.getItem=()=>{throw Error('owned storage denied');};expect(f.view.image('qrcode')).toBe('');await flush();expect(f.view.result.value).toBeNull();expect(f.view.media.value).toBeUndefined();expect(sources(f)).toHaveLength(0);}
    finally{f.close();}
  });
});

describe('closed historical media projection and kind validation',()=>{
  it.each(['actor','tenant','id','revision','version','bounded','extra','previews_extra','qrcode_reference','voucher_reference','signed_id','expiry_property','expired','overlong_expiry','missing_signature','unknown_status','unavailable_src','unavailable_expiry','public_substitution','ready_without_payment','ready_bank_qr'])('rejects a malformed or unbound %s projection',(kind:string)=>{
    const source=row(104),v:any=mediaContext(source),now=Math.floor(Date.now()/1000);
    if(kind==='actor')v.actor_id=22;if(kind==='tenant')v.supplier_id=8;if(kind==='id')v.id=103;if(kind==='revision')v.revision='b'.repeat(64);if(kind==='version')v.version='wrong';if(kind==='bounded')v.bounded=false;if(kind==='extra')v.assets=[];if(kind==='previews_extra')v.previews.extra={};
    if(kind==='qrcode_reference')v.previews.qrcode.reference='/api/assets/32';if(kind==='voucher_reference')v.previews.voucher.reference='/api/assets/43';if(kind==='signed_id')v.previews.qrcode.src=v.previews.qrcode.src.replace('/31?','/32?');if(kind==='expiry_property')v.previews.qrcode.expires_at++;
    if(kind==='expired'){v.previews.qrcode.expires_at=now;v.previews.qrcode.src=`/api/assets/31?expires=${now}&signature=${'a'.repeat(43)}`;}
    if(kind==='overlong_expiry'){v.previews.qrcode.expires_at=now+301;v.previews.qrcode.src=`/api/assets/31?expires=${now+301}&signature=${'a'.repeat(43)}`;}
    if(kind==='missing_signature')v.previews.qrcode.src='/api/assets/31';if(kind==='unknown_status')v.previews.qrcode.status='pending';if(kind==='unavailable_src')v.previews.qrcode.status='unavailable';if(kind==='unavailable_expiry'){v.previews.qrcode.status='unavailable';v.previews.qrcode.src='';}
    if(kind==='public_substitution'){source.qrcode_url='/owned-media/recorded.png';v.previews.qrcode={reference:source.qrcode_url,status:'ready',src:'https://elsewhere.invalid/replacement.png',expires_at:null};}
    if(kind==='ready_without_payment')source.pay_status=0;if(kind==='ready_bank_qr')source.extract_type='bank';
    expect(()=>runtime.mediaApi.parseSupplierExtractMedia(v,{actor_id:21,supplier_id:7},source,now)).toThrow();
  });
  it.each(['other_id','other_tenant','new_revision','ineligible_voucher','bank_qrcode'])('does not reuse an existing private projection after %s',(kind:string)=>{
    const source=row(104),value=runtime.mediaApi.parseSupplierExtractMedia(mediaContext(source),{actor_id:21,supplier_id:7},source),next={...source};let channel='qrcode';
    if(kind==='other_id')next.id=103;if(kind==='other_tenant')next.supplier_id=8;if(kind==='new_revision')next.revision='b'.repeat(64);if(kind==='ineligible_voucher'){next.pay_status=0;channel='voucher';}if(kind==='bank_qrcode')next.extract_type='bank';
    expect(runtime.mediaApi.supplierExtractMediaImage(value,next,channel)).toBe('');
  });
  it.each(['https://foreign.invalid/api/assets/31',' /api/assets/31','/api/assets/31 ','/%61pi/assets/31','/api/assets/31#fragment','/api/assets/31?signature=short','/api/assets/31?expires=1&signature=short','/api/assets/31?expires=1&expires=2&signature='+ 'a'.repeat(43),'/api/assets/31?expires=1&signature='+ 'a'.repeat(43)+'&id=31'])('does not accept a forged renewal of ambiguous stored reference %s',(reference:string)=>{
    const source={...row(104),qrcode_url:reference},v=mediaContext(source);expect(runtime.mediaApi.extractHistoricalPrivateMediaId(reference)).toBeUndefined();expect(()=>runtime.mediaApi.parseSupplierExtractMedia(v,{actor_id:21,supplier_id:7},source)).toThrow();
  });
  it('requires literal string preview status instead of coercing an object',()=>{
    const v:any=mediaContext();v.previews.qrcode.status={toString:()=> 'ready'};expect(()=>runtime.mediaApi.parseSupplierExtractMedia(v,{actor_id:21,supplier_id:7},row(104))).toThrow();
  });
  it('does not dispatch a source with forged supplier or revision',async()=>{
    const f=await mount();try{await expect(runtime.mediaApi.readSupplierExtractMedia({actor_id:21,supplier_id:8},row(104))).rejects.toThrow();await expect(runtime.mediaApi.readSupplierExtractMedia({actor_id:21,supplier_id:7},{...row(104),revision:'weak'})).rejects.toThrow();expect(mediaCalls(f)).toHaveLength(0);}
    finally{f.close();}
  });
});
