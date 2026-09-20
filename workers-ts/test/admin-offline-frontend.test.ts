import { beforeAll, beforeEach, afterEach, it, expect, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { offlineH5ScanImage, offlineMiniScanImage, offlineScanUrl } from '../src/services/order/OfflineScanCode';

// Actual SFC setup, decoder, Vue reactivity, session scope and Axios adapter.
// No DOM rendering in this suite: that is separately exercised in the browser.
let runtime: any, surface: EventTarget;
const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
beforeAll(async () => {
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Page } from './src/pages/order/OfflineOrders.vue';
    export * as api from './src/api/offline'; export * as transport from './src/utils/orderRequest';
    export * as read from './src/utils/offlineOrderRead'; export * as auth from './src/utils/auth';
    export * as scanRead from './src/utils/offlineScan';
    export { AxiosError } from 'axios';
    export { createRenderer, nextTick } from 'vue';
  ` }, alias: { '@': resolve(root, 'src') }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'actual-admin-offline', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'admin-offline' }).content, loader: 'ts' }));
    } }] });
  runtime = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
});
beforeEach(() => {
  const values = new Map<string,string>(); surface = new EventTarget();
  vi.stubGlobal('window', Object.assign(surface, { location: { search: '', pathname: '/order/offline', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key,value), removeItem: (key: string) => values.delete(key) });
  localStorage.setItem('admin_token','local-offline-token');
  localStorage.setItem('admin_session',JSON.stringify({ userInfo: { id: 2, level: 1 }, menus: [{ path: '/order' }], uniqueAuth: ['order.view'] }));
});
afterEach(() => vi.unstubAllGlobals());
const row = (id = 23, change: Record<string,unknown> = {}) => ({ id, order_id: 'xx'+id.toString(16).padStart(30,'0'), uid: 11,
  nickname: '本地会员', phone: '13800000011', account_available: true, money: '12.50', pay_price: '10.00', true_price: '2.50',
  add_time: 1700000000, hidden: false, recorded_paid: 0, channel: 'h5', paid: false, pay_type: '', paid_at: null, state: 'UNPAID', reason: null, ...change });
const paid = (id = 23, change: Record<string,unknown> = {}) => row(id,{ state: 'PAID', paid: true, recorded_paid: 1, pay_type: 'yue', paid_at: 1700000010, ...change });
const unverified = (id = 23, change: Record<string,unknown> = {}) => row(id,{ order_id: 'legacy', uid: 0, account_available: false,
  state: 'UNVERIFIED', paid: null, recorded_paid: 1, pay_type: null, paid_at: null, reason: 'MISSING_ADMISSION', ...change });
const listing = (list: unknown[], next = '', limit = 20) => ({ version: 'admin-offline-read-v1', list, limit, next_cursor: next });
const detail = (record: unknown) => ({ version: 'admin-offline-read-v1', record });
const envelope = (data: unknown) => ({ status: 200, data });
const gate = () => { let resolve!: (value: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve }; };
const flush = async () => { for (let i=0;i<12;i++) { await new Promise(r => setTimeout(r,1)); await runtime.nextTick(); } };
async function mount(override: (config: any) => unknown = () => undefined) {
  const calls: any[] = []; let view: any;
  runtime.transport.orderRequest.defaults.adapter = async (config: any) => {
    calls.push(config);
    const value = await override(config) ?? envelope(config.url === '/order/scan_list' ? listing([row()]) : detail(row(Number(config.url.split('/').at(-1)))));
    return { config, data: value, status: 200, statusText: 'local fixture', headers: {} };
  };
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any,p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(p: unknown,c: unknown) { view = runtime.Page.setup(p,c); return () => null; } });
  app.mount({ children: [] }); await flush();
  return { view, calls, close: () => app.unmount() };
}

it.each([
  ['unpaid',row()], ['pending',row(23,{ state:'PENDING',pay_type:'alipay' })], ['zero',row(23,{ state:'UNAVAILABLE',pay_price:'0.00',true_price:'12.50' })],
  ['hidden',row(23,{ state:'UNAVAILABLE',hidden:true })], ['wallet paid',paid()], ['review paid',paid(23,{ state:'REVIEW_REQUIRED' })],
  ['review pending',row(23,{ state:'REVIEW_REQUIRED',pay_type:'weixin' })], ['legacy flag',unverified()], ['legacy amounts',unverified(23,{ money:null,true_price:null })],
])('decodes %s without substituting recorded flag for collection', (_name,source) => {
  const parsed = runtime.read.parseOfflineDetail(detail(source),'23'); expect(parsed).toEqual(source);
  if (source.state === 'UNVERIFIED') expect(runtime.read.offlineStateLabel(parsed)).toBe('凭据未核验');
});

it.each([
  ['numeric money',{ pay_price: 10 }], ['string paid',{ paid: 'true' }], ['missing paid',{ paid: undefined }], ['unknown state',{ state:'SUCCESS' }],
  ['flag only',{ paid:true }], ['zero paid',{ pay_price:'0.00',true_price:'12.50',paid:true,state:'PAID',recorded_paid:1,pay_type:'yue',paid_at:1700000010 }],
  ['paid contradiction',{ ...paid(),recorded_paid:0 }], ['paid time missing',{ ...paid(),paid_at:null }], ['bad discount',{ true_price:'1.00' }],
  ['hidden payable',{ hidden:true }], ['unpaid wallet',{ pay_type:'yue' }], ['unexpected ticket',{ ticket:{kind:'alipay-wap'} }],
  ['unverified true',{ ...unverified(),paid:true }], ['unverified timestamp',{ ...unverified(),paid_at:1700000010 }], ['unknown reason',{ ...unverified(),reason:'GUESS' }],
  ['numeric ID',{ id:'23' }], ['huge ID',{ id:2147483648 }], ['noncanonical price',{ pay_price:'010.00' }],
])('rejects contradictory or malformed record: %s', (_name,change) => {
  expect(() => runtime.read.parseOfflineDetail(detail(row(23,change)),'23')).toThrow();
});

it.each(['version','extra','array','too-many','duplicate-id','ascending','cursor-not-last','cursor-short-page','past-before','wrong-uid','wrong-order','wrong-date','wrong-flag'])('rejects malformed list %s', kind => {
  const value: any = listing([row(23),row(22)]), query: any = { limit:20 };
  if (kind === 'version') value.version = 'old'; if (kind === 'extra') value.count = 2;
  if (kind === 'array') value.list = {}; if (kind === 'too-many') value.list = Array.from({length:21},(_,i)=>row(30-i));
  if (kind === 'duplicate-id') value.list[1] = row(23); if (kind === 'ascending') value.list.reverse();
  if (kind === 'cursor-not-last') { query.limit=2;value.limit=2;value.next_cursor='21'; }
  if (kind === 'cursor-short-page') value.next_cursor='22'; if (kind === 'past-before') query.before='23';
  if (kind === 'wrong-uid') query.uid='12'; if (kind === 'wrong-order') query.order_id='other';
  if (kind === 'wrong-date') { query.from='1700000001';query.to='1700000002'; } if (kind === 'wrong-flag') query.recorded_paid='1';
  expect(()=>runtime.read.parseOfflineList(value,query)).toThrow();
});
it('allows duplicate legacy order numbers as separate unverified records and rejects wrong detail identity',()=>{
  expect(runtime.read.parseOfflineList(listing([unverified(23),unverified(22)]),{limit:20}).list).toHaveLength(2);
  expect(()=>runtime.read.parseOfflineDetail(detail(row(22)),'23')).toThrow();
});
it.each([{limit:21},{limit:0},{limit:20,before:'01'},{limit:20,uid:'-1'},{limit:20,from:'1'},
  {limit:20,from:'2',to:'1'},{limit:20,order_id:'a b'},{limit:20,recorded_paid:'true'},{limit:20,name:'\n'},
  {limit:20,page:1},{limit:20,before:23}])('rejects unsafe query before HTTP: %j',query=>{
  expect(()=>runtime.read.validateOfflineQuery(query)).toThrow();
});
it('normalizes only expected filters and validates calendar dates instead of accepting rollover',()=>{
  const filters={...runtime.read.emptyOfflineFilters(),name:'  _%\\  ',uid:'11',from:'2026-09-20T08:00',to:'2026-09-20T09:00'};
  const query=runtime.read.offlineQueryFromFilters(filters,'23');
  expect(query).toMatchObject({limit:20,name:'_%\\',uid:'11',before:'23'});expect(Number(query.to)-Number(query.from)).toBe(3600);
  expect(()=>runtime.read.offlineQueryFromFilters({...filters,from:'2026-02-30T08:00'})).toThrow();
});

it('loads automatically with only GET, clears on input edits and distinguishes empty success from errors',async()=>{
  let fail=false; const f=await mount(c=>fail?{status:503,msg:'not ready',data:null}:c.params?.name?envelope(listing([])):undefined);
  try {
    expect(f.view.records.value).toHaveLength(1);f.view.form.name='absent';expect(f.view.records.value).toEqual([]);expect(f.view.loaded.value).toBe(false);
    f.view.search();await flush();expect(f.view.loaded.value).toBe(true);expect(f.view.records.value).toEqual([]);expect(f.view.readError.value).toBe('');
    fail=true;await f.view.loadPage();expect(f.view.loaded.value).toBe(false);expect(f.view.readError.value).toContain('not ready');
    fail=false;await f.view.loadPage();expect(f.view.loaded.value).toBe(true);expect(f.calls.every(c=>c.method==='get')).toBe(true);
  } finally {f.close();}
});
it.each(['list','detail','scan'].flatMap(part=>[503,0].map(status=>({part,status}))))('localizes actual Axios $status failure in $part and permits only an explicit reread',async({part,status})=>{
  let fail=false;
  const f=await mount(c=>{
    if(fail) throw new runtime.AxiosError('Request failed with status code '+status, status?'ERR_BAD_RESPONSE':'ECONNABORTED',c,undefined,
      status?{status,data:{status:503,msg:'internal SQL diagnostic must not leak'},headers:{},config:c}:undefined);
    return c.url==='/order/offline_scan'?envelope(scanResponse()):undefined;
  });
  try {
    if(part==='detail')await f.view.openDetail(23);if(part==='scan')await f.view.openScan();
    fail=true;
    const read=()=>part==='list'?f.view.loadPage():part==='detail'?f.view.refreshDetail():f.view.loadScan();
    await read();
    const message=part==='list'?f.view.readError.value:part==='detail'?f.view.detailError.value:f.view.scanError.value;
    expect(message).toContain('暂时无法');expect(message).not.toMatch(/Request failed|SQL|ECONNABORTED/);
    expect(part==='list'?f.view.records.value:part==='detail'?f.view.detail.value:f.view.scan.value).toEqual(part==='list'?[]:null);
    expect(f.view.sessionValid.value).toBe(true);expect(localStorage.getItem('admin_token')).toBe('local-offline-token');
    const count=f.calls.length;await flush();expect(f.calls).toHaveLength(count);
    fail=false;await read();expect(part==='list'?f.view.records.value.length:part==='detail'?f.view.detail.value:f.view.scan.value).toBeTruthy();
    expect(f.calls.every(c=>c.method==='get')).toBe(true);
  } finally {f.close();}
});
it.each([401,403])('actual HTTP %s still invalidates the view instead of becoming a retryable read error',async status=>{
  let fail=false;
  const f=await mount(c=>{if(fail)throw new runtime.AxiosError('denied','ERR_BAD_REQUEST',c,undefined,{status,data:{},headers:{},config:c});});
  try {fail=true;await f.view.openDetail(23);expect(f.view.sessionValid.value).toBe(false);expect(f.view.records.value).toEqual([]);
    expect(f.view.detail.value).toBeNull();const count=f.calls.length;await f.view.loadPage();expect(f.calls).toHaveLength(count);
    expect(localStorage.getItem('admin_token')).toBe(status===401?null:'local-offline-token');
  } finally {f.close();}
});
it('pages by validated cursor, refetches previous page and resets cursor on filter changes',async()=>{
  const f=await mount(c=>c.url==='/order/scan_list'?envelope(c.params.before?listing([row(3),row(2),row(1)]):listing(Array.from({length:20},(_,i)=>row(23-i)),'4')):undefined);
  try {
    f.view.nextPage();await flush();expect(f.view.currentPage.value).toBe(1);expect(f.view.records.value.map((r:any)=>r.id)).toEqual([3,2,1]);
    expect(f.calls.at(-1).params.before).toBe('4');await f.view.loadPage(0);expect(f.calls.at(-1).params.before).toBeUndefined();
    f.view.form.uid='12';expect(f.view.currentPage.value).toBe(0);expect(f.view.nextCursor.value).toBe('');expect(f.view.records.value).toEqual([]);
  } finally {f.close();}
});
it('late list responses cannot override new filters or a newer request even when the adapter ignores abort',async()=>{
  const wait=gate(),f=await mount(c=>c.params?.name==='old'?wait.promise:c.params?.name==='new'?envelope(listing([row(24)])):undefined);
  try {
    f.view.form.name='old';const old=f.view.loadPage();await flush();f.view.form.name='new';await f.view.loadPage();
    wait.resolve(envelope(listing([row(99)])));await old;expect(f.view.records.value[0].id).toBe(24);
  } finally {f.close();}
});
it('detail is a fresh keyed read; switching, closing, refreshing and failed identity never retain the old paid claim',async()=>{
  const wait=gate();let mode='slow';const f=await mount(c=>c.url==='/order/scan_list'?envelope(listing([row(23),row(22)])):
    c.url==='/order/scan_detail/23'&&mode==='slow'?wait.promise:envelope(detail(mode==='wrong'?paid(21):paid(Number(c.url.split('/').at(-1))))));
  try {
    const slow=f.view.openDetail(23);await flush();expect(f.view.detail.value).toBeNull();await f.view.openDetail(22);
    wait.resolve(envelope(detail(paid(23))));await slow;expect(f.view.detail.value.id).toBe(22);
    mode='wrong';await f.view.refreshDetail();expect(f.view.detail.value).toBeNull();expect(f.view.detailError.value).toBeTruthy();
    mode='ok';await f.view.refreshDetail();expect(f.view.detail.value.id).toBe(22);f.view.closeDetail();expect(f.view.detail.value).toBeNull();expect(f.view.selectedId.value).toBeNull();
    const count=f.calls.length;await f.view.openDetail(999);expect(f.calls).toHaveLength(count);
  } finally {f.close();}
});
it('changing filters closes and cancels an outstanding detail',async()=>{
  const wait=gate(),f=await mount(c=>c.url.includes('scan_detail')?wait.promise:undefined);
  try {const pending=f.view.openDetail(23);await flush();f.view.form.name='new';expect(f.view.detailOpen.value).toBe(false);
    wait.resolve(envelope(detail(paid())));await pending;expect(f.view.detail.value).toBeNull();expect(f.view.records.value).toEqual([]);
  } finally {f.close();}
});
it('permission revocation on detail clears the entire list and disables further reads',async()=>{
  const f=await mount(c=>c.url.includes('scan_detail')?{status:400011,msg:'revoked',data:null}:undefined);
  try {await f.view.openDetail(23);expect(f.view.records.value).toEqual([]);expect(f.view.detail.value).toBeNull();expect(f.view.sessionValid.value).toBe(false);
    const count=f.calls.length;f.view.search();await flush();expect(f.calls).toHaveLength(count);expect(f.view.readError.value).toContain('权限已失效');
  } finally {f.close();}
});
it.each(['token-roundtrip','storage-clear','session-change','silent-token'])('sticky invalidation clears sensitive rows and query after %s',async kind=>{
  const f=await mount();try{
    f.view.form.name='本地会员';await f.view.loadPage();await f.view.openDetail(23);
    if(kind==='token-roundtrip'){runtime.auth.setToken('b');runtime.auth.setToken('local-offline-token');}
    if(kind==='storage-clear'){const event=Object.assign(new Event('storage'),{key:null,storageArea:localStorage});surface.dispatchEvent(event);}
    if(kind==='session-change'){localStorage.setItem('admin_session','{}');surface.dispatchEvent(new Event('admin-session-changed'));}
    if(kind==='silent-token'){localStorage.setItem('admin_token','b');await f.view.loadPage();}
    expect(f.view.records.value).toEqual([]);expect(f.view.detail.value).toBeNull();expect(f.view.form.name).toBe('');expect(f.view.sessionValid.value).toBe(false);
    const count=f.calls.length;await f.view.loadPage();await f.view.refreshDetail();expect(f.calls).toHaveLength(count);
  }finally{f.close();}
});
it('late auth expiry cannot log out a replacement account, including A to B to A',async()=>{
  const wait=gate(),f=await mount(()=>wait.promise);try{
    runtime.auth.setToken('b');runtime.auth.setToken('local-offline-token');wait.resolve({status:410001,msg:'late expiry',data:null});await flush();
    expect(localStorage.getItem('admin_token')).toBe('local-offline-token');expect(f.view.records.value).toEqual([]);
  }finally{f.close();}
});
it('no local order permission prevents requests; unmount aborts and cannot revive records',async()=>{
  localStorage.setItem('admin_session',JSON.stringify({userInfo:{id:3,level:1},menus:[],uniqueAuth:['product.view']}));
  const denied=await mount();try{expect(denied.calls).toEqual([]);expect(denied.view.readError.value).toContain('没有');}finally{denied.close();}
  localStorage.setItem('admin_session',JSON.stringify({userInfo:{id:2,level:1},menus:[],uniqueAuth:['order.view']}));
  const wait=gate(),f=await mount(()=>wait.promise);f.close();wait.resolve(envelope(listing([paid()])));await flush();expect(f.view.records.value).toEqual([]);
});

const scanPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const scanResponse = (type:0|1=1,status:'ready'|'unavailable'|'not_configured'='ready') => ({version:'admin-offline-scan-v1',type,
  wechat_url:offlineScanUrl('https://cinashop-h5.pages.dev'),wechat:offlineH5ScanImage(offlineScanUrl('https://cinashop-h5.pages.dev'),type),
  routine:status==='ready'?offlineMiniScanImage(scanPng,type):'',routine_status:status});
const fromSvg = (value:string) => Buffer.from(value.split(',')[1],'base64').toString('utf8');
const toSvg = (value:string) => 'data:image/svg+xml;base64,'+Buffer.from(value).toString('base64');
it.each([0,1] as const)('accepts actual backend type %s images with all mini-program availability states',type=>{
  for(const status of ['ready','unavailable','not_configured'] as const){
    const input=scanResponse(type,status),parsed=runtime.scanRead.parseOfflineScan(input,type);
    expect(parsed).toEqual({type,wechat:input.wechat,wechatUrl:input.wechat_url,routine:input.routine,routineStatus:status});
    expect(runtime.scanRead.offlineScanFilename(parsed,'wechat')).toBe(`cinashop-offline-h5-${type?'poster':'qr'}.svg`);
    if(status==='ready')expect(runtime.scanRead.offlineScanFilename(parsed,'routine')).toBe(`cinashop-offline-mini-${type?'poster.svg':'qr.png'}`);
  }
});
it.each(['version','missing','extra','type','numeric-type-string','status','hidden-image','empty-ready','numeric-image',
  'insecure-origin','url-query','url-fragment','credentials','port','prefix','base64','png-spoof','oversize'])('rejects malformed scan contract %s',kind=>{
  const data: any = scanResponse(0);
  if(kind==='version')data.version='old';if(kind==='missing')delete data.routine_status;if(kind==='extra')data.ticket='capability';
  if(kind==='type')data.type=1;if(kind==='numeric-type-string')data.type='0';if(kind==='status')data.routine_status='success';
  if(kind==='hidden-image')data.routine_status='not_configured';if(kind==='empty-ready')data.routine='';if(kind==='numeric-image')data.wechat=1;
  if(kind==='insecure-origin')data.wechat_url=data.wechat_url.replace('https:','http:');
  if(kind==='url-query')data.wechat_url+='?money=1';if(kind==='url-fragment')data.wechat_url+='&orderId=1';
  if(kind==='credentials')data.wechat_url=data.wechat_url.replace('https://','https://u:p@');
  if(kind==='port')data.wechat_url=data.wechat_url.replace('.dev/','.dev:8443/');
  if(kind==='prefix')data.wechat='https://evil.test/image.svg';if(kind==='base64')data.wechat+='\n';
  if(kind==='png-spoof')data.routine='data:image/png;base64,YWJj';if(kind==='oversize')data.wechat='data:image/svg+xml;base64,'+'A'.repeat(350000);
  expect(()=>runtime.scanRead.parseOfflineScan(data,0)).toThrow();
});
it.each(['script','onload','foreignObject','entity','comment','style','external-image','quiet-zone','path-command','dimension','extra-root'])('rejects active or non-contract raw SVG %s',kind=>{
  const data=scanResponse(0);let text=fromSvg(data.wechat);
  if(kind==='script')text=text.replace('</svg>','<script>alert(1)</script></svg>');
  if(kind==='onload')text=text.replace('<svg ','<svg onload="alert(1)" ');
  if(kind==='foreignObject')text=text.replace('</svg>','<foreignObject/></svg>');
  if(kind==='entity')text='<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///secret">]>'+text;
  if(kind==='comment')text=text.replace('</svg>','<!-- test --></svg>');
  if(kind==='style')text=text.replace('<svg ','<svg style="background:url(https://evil.test)" ');
  if(kind==='external-image')text=text.replace('</svg>','<image href="https://evil.test"/></svg>');
  if(kind==='quiet-zone')text=text.replace('M24,24','M0,0');if(kind==='path-command')text=text.replace('M24,24','C24,24');
  if(kind==='dimension')text=text.replace('width="246px"','width="99999px"');if(kind==='extra-root')text+='<svg/>';
  data.wechat=toSvg(text);expect(()=>runtime.scanRead.parseOfflineScan(data,0)).toThrow();
});
it.each(['title','caption','link','nested-svg','surface','script','minimum','doctype'])('rejects non-contract poster %s',kind=>{
  const data=scanResponse(1);let text=fromSvg(data.wechat);
  if(kind==='title')text=text.replace('线下消费收银海报','另一站点');if(kind==='caption')text=text.replace('H5 扫码','微信 扫码');
  if(kind==='link')text=text.replace(/href="[^"]+"/,'href="https://evil.test"');
  if(kind==='nested-svg')text=text.replace(/href="[^"]+"/,`href="${data.routine}"`);
  if(kind==='surface')text=fromSvg(data.routine);if(kind==='script')text=text.replace('</svg>','<script/></svg>');
  if(kind==='minimum')text=text.replace('0.01','0.00');if(kind==='doctype')text='<!DOCTYPE svg>'+text;
  data.wechat=toSvg(text);expect(()=>runtime.scanRead.parseOfflineScan(data,1)).toThrow();
});
it.each(['bom','invalid-utf8'])('rejects non-contract raw SVG encoding %s',kind=>{
  const data=scanResponse(0),prefix=kind==='bom'?Buffer.from([0xef,0xbb,0xbf]):Buffer.from([0xff]);
  data.wechat='data:image/svg+xml;base64,'+Buffer.concat([prefix,Buffer.from(fromSvg(data.wechat))]).toString('base64');
  expect(()=>runtime.scanRead.parseOfflineScan(data,0)).toThrow();
});
it('does not request scan assets until explicitly opened; mode changes and refresh clear stale images',async()=>{
  const f=await mount(c=>c.url==='/order/offline_scan'?envelope(scanResponse(c.params.type)):undefined);
  try{
    expect(f.calls.every(c=>c.url==='/order/scan_list')).toBe(true);await f.view.openScan();
    expect(f.view.scanOpen.value).toBe(true);expect(f.view.scan.value.type).toBe(1);
    expect(f.calls.at(-1)).toMatchObject({url:'/order/offline_scan',method:'get',params:{type:1}});
    const next=f.view.changeScanType(0);expect(f.view.scan.value).toBeNull();expect(f.view.scanImagesReady.wechat).toBe(false);
    await next;expect(f.view.scan.value.type).toBe(0);const count=f.calls.length;
    await f.view.changeScanType(2);await f.view.changeScanType(0);expect(f.calls).toHaveLength(count);
    await f.view.loadScan();expect(f.calls).toHaveLength(count+1);expect(f.calls.every(c=>c.method==='get')).toBe(true);
    f.view.closeScan();expect(f.view.scan.value).toBeNull();await f.view.loadScan();expect(f.calls).toHaveLength(count+1);
  }finally{f.close();}
});
it('late scan response cannot replace a new format or restore a closed dialog',async()=>{
  const wait=gate();let slow=true;const f=await mount(c=>c.url==='/order/offline_scan'?(slow&&c.params.type===1?wait.promise:envelope(scanResponse(c.params.type))):undefined);
  try{
    const old=f.view.openScan();await flush();await f.view.changeScanType(0);expect(f.view.scan.value.type).toBe(0);
    wait.resolve(envelope(scanResponse(1)));await old;expect(f.view.scan.value.type).toBe(0);
    slow=false;const pending=f.view.loadScan();f.view.closeScan();await pending;expect(f.view.scan.value).toBeNull();expect(f.view.scanOpen.value).toBe(false);
  }finally{f.close();}
});
it('malformed, unavailable and revoked scan responses never reuse an old image',async()=>{
  let mode='ok';const f=await mount(c=>c.url==='/order/offline_scan'?mode==='revoked'?{status:400011,msg:'revoked',data:null}:
    envelope({...scanResponse(c.params.type,mode==='unavailable'?'unavailable':'ready'),...(mode==='malformed'?{type:9}:{})}):undefined);
  try{
    await f.view.openScan();mode='malformed';await f.view.loadScan();expect(f.view.scan.value).toBeNull();expect(f.view.scanError.value).toContain('响应无效');
    mode='unavailable';await f.view.loadScan();expect(f.view.scan.value.routineStatus).toBe('unavailable');expect(f.view.scan.value.routine).toBe('');
    mode='revoked';await f.view.loadScan();expect(f.view.scanOpen.value).toBe(false);expect(f.view.scan.value).toBeNull();
    expect(f.view.records.value).toEqual([]);expect(f.view.sessionValid.value).toBe(false);const count=f.calls.length;
    await f.view.openScan();expect(f.calls).toHaveLength(count);
  }finally{f.close();}
});
it.each(['filter','detail','token-roundtrip','storage-clear','expiry','unmount'])('clears code data and blocks late scan completion after %s',async mode=>{
  const wait=gate(),f=await mount(c=>c.url==='/order/offline_scan'?wait.promise:undefined);let closed=false;
  try{
    const pending=f.view.openScan();await flush();
    if(mode==='filter')f.view.form.name='new';if(mode==='detail')await f.view.openDetail(23);
    if(mode==='token-roundtrip'){runtime.auth.setToken('b');runtime.auth.setToken('local-offline-token');}
    if(mode==='storage-clear')surface.dispatchEvent(Object.assign(new Event('storage'),{key:null,storageArea:localStorage}));
    if(mode==='expiry')surface.dispatchEvent(new Event('admin-auth-expired'));
    if(mode==='unmount'){f.close();closed=true;}
    wait.resolve(envelope(scanResponse()));await pending;
    expect(f.view.scan.value).toBeNull();expect(f.view.scanOpen.value).toBe(false);expect(f.view.scanImagesReady).toEqual({wechat:false,routine:false});
  }finally{if(!closed)f.close();}
});
it('only a current, successfully decoded image enables saving; stale image events and changed sessions are ignored',async()=>{
  class ImageFixture extends EventTarget{naturalWidth=500;constructor(readonly src:string){super();}getAttribute(){return this.src;}}
  vi.stubGlobal('HTMLImageElement',ImageFixture);
  const f=await mount(c=>c.url==='/order/offline_scan'?envelope(scanResponse(c.params.type)):undefined);
  const event=(src:string,type='load')=>{const image=new ImageFixture(src),e=new Event(type);image.dispatchEvent(e);return e;};
  const saving=()=>{const e=new Event('click',{cancelable:true});f.view.beforeScanDownload(e,'wechat');return e.defaultPrevented;};
  try{
    await f.view.openScan();expect(saving()).toBe(true);f.view.scanImageLoaded('wechat',event('data:old'));expect(saving()).toBe(true);
    f.view.scanImageLoaded('wechat',event(f.view.scan.value.wechat));expect(saving()).toBe(false);
    f.view.scanImageFailed('wechat',event(f.view.scan.value.wechat,'error'));expect(saving()).toBe(true);
    await f.view.loadScan();expect(f.view.scanImageErrors.wechat).toBe(false);expect(saving()).toBe(true);
    f.view.scanImageLoaded('wechat',event(f.view.scan.value.wechat));localStorage.setItem('admin_token','silent-new-token');
    expect(saving()).toBe(true);expect(f.view.scan.value).toBeNull();
  }finally{f.close();}
});

it.each(['close','format','refresh','filter','detail','session','unmount'])('revokes every allocated scan download URL on %s',async mode=>{
  const blobs: Blob[] = [], revoked: string[] = [];
  const create=vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{blobs.push(blob as Blob);return `blob:scan-${blobs.length}`;});
  const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(url=>{revoked.push(url);});
  const f=await mount(c=>c.url==='/order/offline_scan'?envelope(scanResponse(c.params.type)):undefined);let closed=false;
  try{
    await f.view.openScan();expect(f.view.scanDownloadUrls).toEqual({wechat:'blob:scan-1',routine:'blob:scan-2'});
    expect(blobs.map(blob=>blob.type)).toEqual(['image/svg+xml','image/svg+xml']);
    expect(await blobs[0].text()).toBe(fromSvg(scanResponse(1).wechat));
    if(mode==='close')f.view.closeScan();if(mode==='format')await f.view.changeScanType(0);if(mode==='refresh')await f.view.loadScan();
    if(mode==='filter')f.view.form.name='new';if(mode==='detail')await f.view.openDetail(23);
    if(mode==='session')runtime.auth.setToken('new');if(mode==='unmount'){f.close();closed=true;}
    expect(revoked).toEqual(['blob:scan-1','blob:scan-2']);
    if(mode==='format'||mode==='refresh'){
      expect(f.view.scanDownloadUrls).toEqual({wechat:'blob:scan-3',routine:'blob:scan-4'});
      if(mode==='format')expect(blobs[3].type).toBe('image/png');
    }else expect(f.view.scanDownloadUrls).toEqual({wechat:'',routine:''});
    if(!closed){f.close();closed=true;}expect(revoked).toEqual(blobs.map((_,i)=>`blob:scan-${i+1}`));
  }finally{if(!closed)f.close();create.mockRestore();revoke.mockRestore();}
});
it('cleans partially allocated download URLs and offers retry when Blob allocation fails',async()=>{
  const create=vi.spyOn(URL,'createObjectURL').mockReturnValueOnce('blob:first').mockImplementationOnce(()=>{throw new Error('local allocation failed');}).mockReturnValue('blob:retry');
  const revoke=vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const f=await mount(c=>c.url==='/order/offline_scan'?envelope(scanResponse(c.params.type)):undefined);
  try{
    await f.view.openScan();expect(revoke).toHaveBeenCalledWith('blob:first');expect(f.view.scan.value).toBeNull();
    expect(f.view.scanDownloadUrls).toEqual({wechat:'',routine:''});expect(f.view.scanError.value).toContain('allocation failed');
    expect(f.view.scanOpen.value).toBe(true);expect(f.view.scanLoading.value).toBe(false);
    await f.view.loadScan();expect(f.view.scanError.value).toBe('');expect(f.view.scan.value.type).toBe(1);
  }finally{f.close();create.mockRestore();revoke.mockRestore();}
});
