import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const operations = new Map<string, any>();
let runtime: any, pinia: any, browser: EventTarget, runtimeDirectory: string, hostDocument: { activeElement: null }, local: Map<string, string>;
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    import Page from './src/pages/FinanceApply.vue';export {Page};export const captured={};
    const setup=Page.setup;Page.setup=(p,c)=>{const value=setup(p,c);captured.view=value;return value;};
    export * as api from './src/api/supplierExtractApplication';export * as mediaApi from './src/api/supplierExtractApplicationMedia';export {useAuthStore} from './src/stores/auth';export {http} from './src/api/http';
    export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,ref} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
      '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-supplier-extract-application-media', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'supplier-extract-application', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-extract-application', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
    } }] });
  runtimeDirectory = mkdtempSync('/tmp/cinashop-supplier-extract-application-media-sfc-');
  const path = resolve(runtimeDirectory, 'compiled-page.mjs'); writeFileSync(path, result.outputFiles[0].text);
  runtime = await import(pathToFileURL(path).href);
}, 30000);
afterAll(() => { if (runtimeDirectory) rmSync(runtimeDirectory, { recursive: true, force: true }); });
function login(permissions = ['supplier.finance.view', 'supplier.finance.manage'], token = 'owned-extract-application-session-a', id = 21, supplierId = 7) {
  localStorage.setItem('supplier-token', token); localStorage.setItem('supplier-user', JSON.stringify({ id, supplier_id: supplierId }));
  localStorage.setItem('supplier-permissions', JSON.stringify(permissions));
}
beforeEach(() => {
  local = new Map<string, string>(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { search: '' } }));
  class HostDocument { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('ShadowRoot', class {});
  hostDocument = new HostDocument(); vi.stubGlobal('document', hostDocument);
  vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value), removeItem: (key: string) => local.delete(key) });
  const tails = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: { request: async (key: string, _options: unknown, work: () => unknown) => { const previous = tails.get(key) ?? Promise.resolve(); const next = previous.catch(() => {}).then(work); tails.set(key, next); return next; } } });
  operations.clear(); currentSeed = seed(); settingsSeed = undefined; login(); pinia = runtime.createPinia();
});


afterEach(() => { runtime.disposePinia(pinia); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); await runtime.nextTick(); } };
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node; [key: string]: any };
const content = (node: Node): string => (node.text ?? '') + node.children.map(content).join('');
async function mount(url = '/finance/apply', override: (config: any) => unknown = () => undefined) {
  const calls: any[] = [];
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config);
    const value = custom ?? await transport(config);
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
    { path: '/finance/apply', component: runtime.Page }, { path: '/finance/application-result', component: runtime.Page }, { path: '/away', component: { render: () => null } } ] });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  app.component('el-button', { inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h('button', attrs, slots.default?.()); } });
  await router.push(url); app.mount(host); await flush();
  return { view: runtime.captured.view, host, calls, router, refresh, close: () => app.unmount() };
}

let currentSeed: any, settingsSeed: any;
function seed(): any {
  return { version: 'supplier-extract-application-seed-v1', actor_id: 21, supplier_id: 7, revision: 'a'.repeat(64),
    available: '735.00', min_price: '5.50', max_price: '200.00', can_apply: true,
    accounts: { bank: { bank_code: '000062220001', bank_address: '申请时开户行', ready: true },
      alipay: { account: 'owned-alipay', qrcode_url: '/api/assets/31', ready: true },
      weixin: { account: 'owned-wechat', qrcode_url: '/api/assets/32', ready: true } } };
}
function preview(reference: string) {
  const id = /\/assets\/([1-9]\d*)/.exec(reference)?.[1], expires = Math.floor(Date.now()/1000)+300;
  return reference ? { reference, status:'ready', src:id?`/api/assets/${id}?expires=${expires}&signature=${'a'.repeat(43)}`:reference, expires_at:id?expires:null }
    : { reference, status:'unavailable', src:'', expires_at:null };
}
function settings(value = settingsSeed ?? currentSeed) {
  const a = value.accounts;
  return { version:'supplier-finance-accounts-v1', actor_id:21, supplier_id:7, revision:'f'.repeat(64),
    accounts:{bank_code:a.bank.bank_code==='0'?'':a.bank.bank_code,bank_address:a.bank.bank_address,alipay_account:a.alipay.account,
      alipay_qrcode_url:a.alipay.qrcode_url,wechat:a.weixin.account,wechat_qrcode_url:a.weixin.qrcode_url},
    ready:{bank:a.bank.ready,alipay:a.alipay.ready,weixin:a.weixin.ready},previews:{alipay:preview(a.alipay.qrcode_url),weixin:preview(a.weixin.qrcode_url)},bounded:true };
}
const pendingKey = () => runtime.api.extractApplicationStorageKey(21,7);
async function pending(channel='alipay', operation='2e37c214-2497-4f05-a25b-d084e6c43521'): Promise<any> {
  const intent=runtime.api.makeExtractApplicationIntent(currentSeed,operation,channel,'25.50','原申请备注');
  return {version:'supplier-extract-application-pending-v1',operation_id:operation,actor_id:21,supplier_id:7,
    request_hash:await runtime.api.extractApplicationRequestHash(intent),money:'25.50',extract_type:channel};
}
function terminal(p:any, state='committed'): any {
  const a=currentSeed.accounts, type=p.extract_type;
  return {version:'supplier-extract-application-receipt-v1',operation_id:p.operation_id,actor_id:21,supplier_id:7,state,
    request_hash:state==='committed'?p.request_hash:'',result:state==='committed'?{id:51,extract_type:type,extract_price:'25.50',balance:'709.50',
      bank_code:type==='bank'?a.bank.bank_code:'',bank_address:type==='bank'?a.bank.bank_address:'',alipay_account:type==='alipay'?a.alipay.account:'',
      wechat:type==='weixin'?a.weixin.account:'',qrcode_url:type==='bank'?'':a[type].qrcode_url,supplier_mark:'原申请备注',status:0,pay_status:0,add_time:1788235200}:null};
}
function receiptProjection(receipt:any) {
  return {version:'supplier-extract-application-media-v1',operation_id:receipt.operation_id,actor_id:receipt.actor_id,supplier_id:receipt.supplier_id,
    request_hash:receipt.request_hash,extract_id:receipt.result.id,preview:preview(receipt.result.qrcode_url),bounded:true};
}
async function transport(c:any): Promise<any> {
  if(c.url==='/finance/info') {expect(c.method).toBe('get');expect(c.params).toEqual({selection:'accounts'});return settings();}
  if(c.url.endsWith('/cash')) {
    if(c.method==='get')return structuredClone(currentSeed);
    const body=JSON.parse(c.data),intent={version:'supplier-extract-application-intent-v1',...body,actor_id:21,supplier_id:7};
    const p={operation_id:body.operation_id,request_hash:await runtime.api.extractApplicationRequestHash(intent),extract_type:body.extract_type};
    const value=terminal(p);operations.set(p.operation_id,value);return structuredClone(value);
  }
  const operation=c.url.match(/application_operations\/([^/]+)/)?.[1];
  if(c.url.endsWith('/media')) {const value=operations.get(operation);expect(c.method).toBe('get');expect(c.params).toEqual({request_hash:value.request_hash});return receiptProjection(value);}
  const p=JSON.parse(local.get(pendingKey())!);expect(operation).toBe(p.operation_id);
  return structuredClone(operations.get(operation)??terminal(p,'unknown'));
}
const sources=(f:any)=>nodes(f.host,'img').map(n=>n.props.src as string);
function nodes(node:Node,tag:string):Node[]{return[...(node.tag===tag?[node]:[]),...node.children.flatMap(child=>nodes(child,tag))];}
const seedCalls=(f:any)=>f.calls.filter((c:any)=>c.url==='/finance/info');
const mediaCalls=(f:any)=>f.calls.filter((c:any)=>c.url.endsWith('/media'));
const posts=(f:any)=>f.calls.filter((c:any)=>c.method==='post');
function ready(f:any){f.view.money.value='25.5';f.view.mark.value='原申请备注';f.view.confirmed.value=true;}
async function recoverFixture(override:(c:any)=>unknown=()=>undefined,channel='alipay') {
  const p=await pending(channel),r=terminal(p);operations.set(p.operation_id,r);local.set(pendingKey(),JSON.stringify(p));
  const f=await mount('/finance/application-result',override);await f.view.recover();await flush();return{f,p,r};
}

describe('actual Supplier withdrawal source and immutable original QR previews',()=>{
  it('reads the existing account context only for a private selected source and binds its six values, not its different revision',async()=>{
    const f=await mount();try{expect(seedCalls(f)).toHaveLength(0);f.view.extractType.value='alipay';await flush();
      expect(seedCalls(f)).toHaveLength(1);expect(sources(f)).toHaveLength(1);expect(sources(f)[0]).toMatch(/^\/api\/assets\/31\?expires=/);
      expect(f.view.seedMedia.value.seed_revision).toBe('a'.repeat(64));expect(f.view.source.value.revision).toBe('a'.repeat(64));
      expect(f.calls.every((c:any)=>c.method==='get'&&!/file\//.test(c.url))).toBe(true);
      f.view.extractType.value='weixin';await flush();expect(sources(f)).toHaveLength(1);expect(sources(f)[0]).toMatch(/^\/api\/assets\/32\?/);
    }finally{f.close();}
  });
  it('keeps public source and original literal images without extra media or current-settings reads',async()=>{
    currentSeed.accounts.alipay.qrcode_url='/owned-media/literal-qr.png';const f=await mount();try{
      f.view.extractType.value='alipay';await flush();expect(sources(f)).toEqual(['/owned-media/literal-qr.png']);expect(seedCalls(f)).toHaveLength(0);
      ready(f);await f.view.submit();await flush();expect(sources(f)).toEqual(['/owned-media/literal-qr.png']);expect(mediaCalls(f)).toHaveLength(0);expect(posts(f)).toHaveLength(1);
    }finally{f.close();}
  });
  it.each(['bank_code','bank_address','alipay_account','alipay_qrcode_url','wechat','wechat_qrcode_url'])('refuses a new settings preview after the displayed seed differs in %s',async field=>{
    settingsSeed=structuredClone(currentSeed);const target:any={bank_code:['bank','bank_code'],bank_address:['bank','bank_address'],alipay_account:['alipay','account'],
      alipay_qrcode_url:['alipay','qrcode_url'],wechat:['weixin','account'],wechat_qrcode_url:['weixin','qrcode_url']};const[ch,key]=target[field];settingsSeed.accounts[ch][key]=key==='qrcode_url'?`/api/assets/${ch==='alipay'?32:31}`:field==='wechat'?'later-wx':settingsSeed.accounts[ch][key]+'-changed';
    const f=await mount();try{f.view.extractType.value='alipay';await flush();expect(f.view.source.value).toBeNull();expect(sources(f)).toEqual([]);
      expect(content(f.host)).toContain('收款资料已变化');ready(f);await f.view.submit();expect(posts(f)).toHaveLength(0);
    }finally{f.close();}
  });
  it('shows the original private QR after a genuine page submission without mutating the receipt or making another financial POST',async()=>{
    const f=await mount();try{f.view.extractType.value='alipay';await flush();ready(f);await f.view.submit();await flush();const original=JSON.stringify(f.view.receipt.value);
      expect(posts(f)).toHaveLength(1);expect(mediaCalls(f)).toHaveLength(1);expect(local.has(pendingKey())).toBe(false);expect(sources(f)[0]).toMatch(/^\/api\/assets\/31\?/);
      expect(nodes(f.host,'img')[0].props.alt).toBe('原申请收款二维码');await f.view.loadMedia();await flush();expect(posts(f)).toHaveLength(1);expect(JSON.stringify(f.view.receipt.value)).toBe(original);
    }finally{f.close();}
  });
  it('recovers own private original QR with both finance capabilities removed and ignores current settings',async()=>{
    login([]);const{f,r}=await recoverFixture();try{currentSeed.accounts.alipay={account:'later-setting',qrcode_url:'/api/assets/32',ready:true};
      expect(f.view.canManage.value).toBe(false);expect(seedCalls(f)).toHaveLength(0);expect(mediaCalls(f)).toHaveLength(1);expect(posts(f)).toHaveLength(0);
      expect(content(f.host)).toContain('owned-alipay');expect(sources(f)[0]).toMatch(/^\/api\/assets\/31\?/);expect(JSON.stringify(f.view.receipt.value)).toBe(JSON.stringify(r));
    }finally{f.close();}
  });
  it('renews a valid expired Kefu ticket using only the stored original operation and hash',async()=>{
    currentSeed.accounts.alipay.qrcode_url='/kefuapi/assets/31?expires=1&signature='+'e'.repeat(43);
    const{f,r}=await recoverFixture();try{expect(sources(f)[0]).toMatch(/^\/api\/assets\/31\?expires=/);expect(f.view.receipt.value.result.qrcode_url).toBe(r.result.qrcode_url);expect(seedCalls(f)).toHaveLength(0);}
    finally{f.close();}
  });
  it.each(['unknown','not_applied'])('never requests a preview or submits again for %s original state',async state=>{
    const p=await pending();operations.set(p.operation_id,terminal(p,state));local.set(pendingKey(),JSON.stringify(p));const f=await mount('/finance/application-result');
    try{await f.view.recover();await flush();expect(mediaCalls(f)).toHaveLength(0);expect(seedCalls(f)).toHaveLength(0);expect(sources(f)).toHaveLength(0);expect(posts(f)).toHaveLength(0);expect(local.has(pendingKey())).toBe(state==='unknown');}
    finally{f.close();}
  });
  it('does not request any media for a bank original result',async()=>{const{f}=await recoverFixture(()=>undefined,'bank');try{expect(mediaCalls(f)).toHaveLength(0);expect(sources(f)).toHaveLength(0);}finally{f.close();}});
  it('keeps a committed original receipt through media failure and retries only the read after explicit action',async()=>{
    let failed=true;const{f,r}=await recoverFixture((c:any)=>{if(c.url.endsWith('/media')&&failed)throw Error('owned QR read unavailable');});
    try{expect(sources(f)).toHaveLength(0);expect(content(f.host)).toContain('owned QR read unavailable');expect(f.view.receipt.value).toEqual(r);expect(local.has(pendingKey())).toBe(false);expect(mediaCalls(f)).toHaveLength(1);
      failed=false;await f.view.loadMedia();await flush();expect(sources(f)).toHaveLength(1);expect(mediaCalls(f)).toHaveLength(2);expect(posts(f)).toHaveLength(0);
    }finally{f.close();}
  });
  it.each(['seed','receipt'])('hides expired %s tickets without automatic requests and refreshes only by an explicit read',async mode=>{
    vi.useFakeTimers();const f=mode==='seed'?await mount():(await recoverFixture()).f;
    try{if(mode==='seed'){f.view.extractType.value='alipay';await flush();}expect(sources(f)).toHaveLength(1);const count=f.calls.length;
      vi.setSystemTime(Date.now()+301000);await vi.advanceTimersByTimeAsync(1000);await flush();expect(sources(f)).toHaveLength(0);expect(f.calls).toHaveLength(count);
      await f.view.loadMedia();await flush();expect(sources(f)).toHaveLength(1);expect(f.calls).toHaveLength(count+1);expect(posts(f)).toHaveLength(0);
    }finally{f.close();vi.useRealTimers();}
  });
  it('uses the visible manual control after an image-byte error without changing the original receipt',async()=>{
    const{f,r}=await recoverFixture();try{nodes(f.host,'img')[0].props.onError();await flush();expect(sources(f)).toHaveLength(0);expect(mediaCalls(f)).toHaveLength(1);
      const button=nodes(f.host,'button').find(n=>content(n)==='重新核对原申请二维码')!;button.props.onClick();await flush();expect(sources(f)).toHaveLength(1);expect(mediaCalls(f)).toHaveLength(2);expect(f.view.receipt.value).toEqual(r);
    }finally{f.close();}
  });
  it.each(['seed','receipt'])('cancels a real queued Axios %s GET before adapter dispatch after session ABA',async mode=>{
    const late=gate();let entered=false;const id=runtime.http.interceptors.request.use(async(c:any)=>{if(c.url==='/finance/info'||c.url.endsWith('/media')){entered=true;await late.promise;}return c;});let f:any;
    try{if(mode==='seed'){f=await mount();f.view.extractType.value='alipay';await flush();}else f=(await recoverFixture()).f;
      expect(entered).toBe(true);expect(seedCalls(f).length+mediaCalls(f).length).toBe(0);login([],'other',31,8);browser.dispatchEvent(new Event('supplier-session-changed'));login();browser.dispatchEvent(new Event('supplier-session-changed'));
      late.resolve(undefined);await flush();expect(seedCalls(f).length+mediaCalls(f).length).toBe(0);expect(f.view.receipt.value).toBeNull();expect(f.view.source.value).toBeNull();expect(sources(f)).toHaveLength(0);
    }finally{runtime.http.interceptors.request.eject(id);f?.close();}
  });
  it.each(['seed','receipt'])('clears all %s PII and images if browser storage fails',async mode=>{
    const f=mode==='seed'?await mount():(await recoverFixture()).f;try{if(mode==='seed'){f.view.extractType.value='alipay';await flush();}expect(sources(f)).toHaveLength(1);
      localStorage.getItem=()=>{throw Error('owned unreadable storage');};expect(f.view.image(mode)).toBe('');await flush();expect(f.view.source.value).toBeNull();expect(f.view.receipt.value).toBeNull();expect(sources(f)).toHaveLength(0);
    }finally{f.close();}
  });
  it.each(['seed','receipt'].flatMap(mode=>['session','permission','route','unmount','refresh'].map(kind=>({mode,kind}))))('ignores an abort-insensitive $mode response after $kind',async({mode,kind})=>{
    const late=gate();let captured:any,held=false;const override=(c:any)=>{if(!held&&((mode==='seed'&&c.url==='/finance/info')||(mode==='receipt'&&c.url.endsWith('/media')))){held=true;c.signal=undefined;captured=mode==='seed'?settings():receiptProjection(operations.get(c.url.match(/application_operations\/([^/]+)/)[1]));return late.promise;}};
    const f=mode==='seed'?await mount(undefined,override):(await recoverFixture(override)).f;let closed=false;
    try{if(mode==='seed'){f.view.extractType.value='alipay';await flush();}expect(f.view.mediaLoading.value).toBe(true);
      if(kind==='session'){login([],'other',31,8);browser.dispatchEvent(new Event('supplier-session-changed'));login();browser.dispatchEvent(new Event('supplier-session-changed'));}
      if(kind==='permission')runtime.useAuthStore(pinia).permissions=[];
      if(kind==='route')await f.router.push('/away');if(kind==='unmount'){f.close();closed=true;}if(kind==='refresh'){if(mode==='seed'){currentSeed.revision='b'.repeat(64);currentSeed.accounts.alipay.qrcode_url='/api/assets/32';}await f.view.load();await flush();}
      late.resolve(captured);await flush();expect(f.view.receiptMedia.value).toBeUndefined();
      if(kind==='refresh'&&mode==='seed'){expect(f.view.seedMedia.value.seed_revision).toBe('b'.repeat(64));expect(sources(f)[0]).toMatch(/^\/api\/assets\/32\?/);}
      else{expect(f.view.seedMedia.value).toBeUndefined();expect(sources(f)).toHaveLength(0);}
    }finally{if(!closed)f.close();}
  });
});

describe('closed original receipt media admission',()=>{
  it.each(['version','operation','actor','supplier','request_hash','extract_id','bounded','extra','preview_extra','reference','signed_id','expired','overlong','expiry_property','signature','status_object','status_unknown','unavailable_src','unavailable_expiry','public_substitution','bank_ready'])('rejects malformed or unrelated %s metadata',async kind=>{
    const r=terminal(await pending()),v:any=receiptProjection(r),now=Math.floor(Date.now()/1000);
    if(kind==='version')v.version='wrong';if(kind==='operation')v.operation_id=crypto.randomUUID();if(kind==='actor')v.actor_id=22;if(kind==='supplier')v.supplier_id=8;
    if(kind==='request_hash')v.request_hash='b'.repeat(64);if(kind==='extract_id')v.extract_id=52;if(kind==='bounded')v.bounded=false;if(kind==='extra')v.assets=[];if(kind==='preview_extra')v.preview.any=true;
    if(kind==='reference')v.preview.reference='/api/assets/32';if(kind==='signed_id')v.preview.src=v.preview.src.replace('/31?','/32?');
    if(kind==='expired'||kind==='overlong'){v.preview.expires_at=now+(kind==='expired'?-1:301);v.preview.src=`/api/assets/31?expires=${v.preview.expires_at}&signature=${'a'.repeat(43)}`;}
    if(kind==='expiry_property')v.preview.expires_at++;if(kind==='signature')v.preview.src='/api/assets/31';if(kind==='status_object')v.preview.status={toString:()=> 'ready'};if(kind==='status_unknown')v.preview.status='yes';
    if(kind==='unavailable_src'){v.preview.status='unavailable';v.preview.expires_at=null;}if(kind==='unavailable_expiry'){v.preview.status='unavailable';v.preview.src='';}
    if(kind==='public_substitution')v.preview.src='https://other.invalid/qr.png';if(kind==='bank_ready')r.result.extract_type='bank';
    expect(()=>runtime.mediaApi.parseExtractReceiptMedia(v,r,now)).toThrow();
  });
  it('accepts an explicitly unavailable owned QR without changing the raw original reference',async()=>{
    const r=terminal(await pending()),v=receiptProjection(r);v.preview={reference:r.result.qrcode_url,status:'unavailable',src:'',expires_at:null};
    const parsed=runtime.mediaApi.parseExtractReceiptMedia(v,r);expect(runtime.mediaApi.extractReceiptQrImage(parsed,r)).toBe('');expect(parsed.preview.reference).toBe('/api/assets/31');
  });
});
