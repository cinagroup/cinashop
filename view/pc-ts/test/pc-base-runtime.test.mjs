import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer, transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, defineComponent, h, markRaw, nextTick } from 'vue';
const root = fileURLToPath(new URL('../', import.meta.url));
const storage = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };
const originalGlobals = new Map();
let server, api, auth, pc;
before(async () => {
  for (const [key, value] of Object.entries({ sessionStorage: storage(), localStorage: storage(), window: { location: { origin: 'https://shop.example.test', pathname: '/', search: '', hash: '', replace() {} }, addEventListener() {}, removeEventListener() {} } })) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  server = await createServer({ configFile: false, root, envFile: false, logLevel: 'error',
    plugins: [{ name: 'actual-client-pc-components', async load(id) { if (!id.startsWith(root) || !id.endsWith('.vue')) return;
      const { descriptor } = parse(await readFile(id, 'utf8'), { filename: id });
      return (await transformWithEsbuild(compileScript(descriptor, { id: 'actual-pc-template', inlineTemplate: true }).content, id, { loader: 'ts' })).code;
    } }], resolve: { alias: { '@': root + 'src' } }, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null } });
  api = (await server.ssrLoadModule('/src/utils/request.ts')).default;
  auth = await server.ssrLoadModule('/src/utils/auth.ts');
  pc = await server.ssrLoadModule('/src/api/pcBase.ts');
});
after(async () => { await server?.close(); for (const [key, value] of originalGlobals) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
const node = tag => markRaw({ tag, text: '', props: {}, children: [], parent: null });
const renderer = createRenderer({ createElement: node, createText: text => Object.assign(node('#text'), { text }), createComment: text => Object.assign(node('#comment'), { text }),
  insert(child, parent, anchor) { if (child.parent) child.parent.children = child.parent.children.filter(row => row !== child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child); },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(row => row !== child); child.parent = null; }, parentNode: child => child?.parent, nextSibling: () => null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; }, setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; } });
const all = el => [el, ...el.children.flatMap(all)], words = el => all(el).map(el => el.text).join(' ');
const flush = async () => { for (let i = 0; i < 16; i++) { await nextTick(); await new Promise(setImmediate); } };
const until = async predicate => { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) { await new Promise(resolve => setTimeout(resolve, 20)); await flush(); } assert.ok(predicate(), 'actual asynchronous QR render completes'); };
const gate = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
const card = id => ({ id, image: 'http://images.example.test/product.png', store_name: '完整商品' + id, price: '12.00', sales: 2, price_type: '', vip_price: '0', level_name: '' });
const home = (offset = 0) => ({ info: { bastList: Array.from({ length: 151 }, (_v, n) => card(offset + n + 1)), firstList: Array.from({ length: 101 }, (_v, n) => card(offset + n + 1001)) } });
const response = (config, data) => ({ data: { status: 200, msg: 'ok', data }, status: 200, statusText: 'owned', headers: {}, config });
async function mount(path, answer, props = {}) {
  auth.clearAuth(); const calls = [];
  api.defaults.adapter = async config => { calls.push(config); return response(config, await answer(config)); };
  const component = (await server.ssrLoadModule(path)).default, tree = node('root'), app = renderer.createApp({ render: () => h(component, props) }), warnings = [];
  const generic = name => defineComponent({ name, setup(_props, { slots }) { return () => h('div', {}, slots.default?.()); } });
  for (const name of ['el-skeleton','el-carousel','el-carousel-item','router-link']) app.component(name, generic(name));
  app.config.warnHandler = value => warnings.push(value); app.mount(tree); await flush();
  return { tree, calls, warnings, close: () => app.unmount(), click(label) { const button = all(tree).find(row => row.tag === 'button' && words(row).includes(label)); assert.ok(button, label); button.props.onClick({}); } };
}
const homeAnswer = config => config.url === '/index' ? home() : config.url === '/pc/get_banner' ? [] : config.url === '/category' ? [] : (() => { throw Error('Unexpected ' + config.url); })();
it('actual Home template renders all151 best and101 new cards with no ordinary products request or frontend100 slice', async () => {
  const f = await mount('/src/pages/Home.vue', homeAnswer);
  try { const sections = all(f.tree).filter(row => row.tag === 'section' && ['精品推荐','首发新品'].includes(row.props['aria-label']));
    assert.equal(sections.length, 2); assert.deepEqual(sections.map(row => all(row).filter(row => row.props.class === 'goods-card').length), [151,101]);
    assert.ok(words(f.tree).includes('完整商品151')); assert.ok(words(f.tree).includes('完整商品1101')); assert.equal(f.calls.filter(c => c.url === '/products').length, 0);
  } finally { f.close(); }
});
it('an account switch clears old member cards and a late prior response cannot replace current complete arrays', async () => {
  let reads = 0; const old = gate(); const f = await mount('/src/pages/Home.vue', config => config.url === '/index' ? (++reads === 1 ? old.promise : home(5000)) : homeAnswer(config));
  try { auth.setAuth('new-session', 8); await flush(); assert.ok(words(f.tree).includes('完整商品5001'));
    old.resolve(home(9000)); await flush(); assert.ok(!words(f.tree).includes('完整商品9001')); assert.ok(words(f.tree).includes('完整商品5001'));
    auth.clearAuth(); await flush(); assert.equal(reads, 3);
  } finally { old.resolve(home()); f.close(); }
});
it('failed complete home reads display an error with neither partial best nor partial new success', async () => {
  const f = await mount('/src/pages/Home.vue', config => config.url === '/index' ? { info: { bastList: home().info.bastList, firstList: null } } : homeAnswer(config));
  try { assert.match(words(f.tree), /无法完整读取/); assert.equal(all(f.tree).filter(row => row.props.class === 'goods-card').length, 0); } finally { f.close(); }
});
it('a Home unmount aborts its pending real Axios request', async () => {
  const wait = gate(); const f = await mount('/src/pages/Home.vue', config => config.url === '/index' ? wait.promise : homeAnswer(config));
  const request = f.calls.find(c => c.url === '/index'); f.close(); assert.equal(request.signal.aborted, true); wait.resolve(home()); await flush();
});
it('company projection preserves HTTP images and ordered duplicate names while rejecting unsafe links independently', () => {
  const company = pc.checkedPcCompany({ pc_logo: 'http://images.example.test/logo.png', site_name: 'PC商城', links_open: 1,
    links_list: [{ name: '相同', url: '/one' }, { name: '相同', url: 'http://example.test/two' }, { name: '坏地址', url: 'javascript:private' }],
    filing_list: [{ name: '', url: '', icon: 'http://images.example.test/filing.png' }], site_description: '保留\r\n换行' });
  assert.equal(company.logo, 'http://images.example.test/logo.png'); assert.deepEqual(company.links.map(row => row.name), ['相同','相同']); assert.equal(company.description, '保留\r\n换行'); assert.equal(company.filings[0].icon, 'http://images.example.test/filing.png');
});
it('public media rejects historical private tickets and credentials while admitting only canonical server ticket shapes', () => {
  const signed = '/api/assets/42?expires=1793300000&signature=' + 'a'.repeat(43);
  assert.equal(pc.pcPublicImage(signed), signed);
  for (const value of ['/api/assets/42','/api/assets/42?signature=private','http://user:secret@example.test/p.png','javascript:private','/api/%61ssets/42']) assert.equal(pc.pcPublicImage(value), '');
});
it('complete homepage parser rejects repeated identities and keeps decorated values at index100', () => {
  const data = home(); data.info.bastList[100] = { ...data.info.bastList[100], brand_name: '品牌', store_label: [{ id: 1 }], promotions: { id: 2 }, vip_price: '9.60', price_type: 'level' };
  assert.deepEqual(pc.checkedPcHomepage(data).best[100].promotions, { id: 2 });
  data.info.bastList[100].id = 1; assert.throws(() => pc.checkedPcHomepage(data));
});
it('actual product phone component creates H5 QR for the fixed PHP goods_details path and keeps source HTTP origin', async () => {
  const f = await mount('/src/components/ProductPhoneBuy.vue', () => ({ site_url: 'http://mobile.example.test', routineCode: '' }), { productId: 70 });
  try { f.click('手机购买'); await until(() => all(f.tree).some(row => row.tag === 'img')); assert.equal(f.calls[0].url, '/pc/get_product_code/70');
    const link = all(f.tree).find(row => row.tag === 'a'); assert.equal(link.props.href, 'http://mobile.example.test/pages/goods_details/index?id=70');
    assert.match(all(f.tree).find(row => row.tag === 'img').props.src, /^data:image\/png;base64,/);
  } finally { f.close(); }
});
it('actual product phone component renders provider PNG without manufacturing an alternate mobile link', async () => {
  const png = 'data:image/png;base64,YQ=='; const f = await mount('/src/components/ProductPhoneBuy.vue', () => ({ site_url: 'https://mobile.example.test', routineCode: png }), { productId: 71 });
  try { f.click('手机购买'); await flush(); assert.equal(all(f.tree).find(row => row.tag === 'img').props.src, png); assert.equal(all(f.tree).filter(row => row.tag === 'a').length, 0); } finally { f.close(); }
});
it('phone code from a prior session is retired before a deferred provider result arrives', async () => {
  const wait = gate(); const f = await mount('/src/components/ProductPhoneBuy.vue', () => wait.promise, { productId: 72 });
  try { f.click('手机购买'); await flush(); auth.setAuth('other-session', 9); await flush(); wait.resolve({ site_url: 'https://mobile.example.test', routineCode: 'data:image/png;base64,YQ==' }); await flush(); assert.equal(all(f.tree).filter(row => row.tag === 'img').length, 0); } finally { wait.resolve({ site_url: '', routineCode: '' }); f.close(); }
});
it('unsafe mobile origin never becomes a clickable purchase link or QR', async () => {
  const f = await mount('/src/components/ProductPhoneBuy.vue', () => ({ site_url: 'https://user:secret@example.test', routineCode: '' }), { productId: 73 });
  try { f.click('手机购买'); await flush(); assert.equal(all(f.tree).filter(row => ['a','img'].includes(row.tag)).length, 0); assert.match(words(f.tree), /暂无可用/); } finally { f.close(); }
});

function metadataHead() {
  const nodes = [];
  const head = { ownerDocument: { createElement() { const attributes = new Map(); return { parentNode: null, getAttribute: key => attributes.get(key) ?? null, setAttribute: (key, value) => attributes.set(key, String(value)), remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); this.parentNode = null; } }; } },
    append(node) { nodes.push(node); node.parentNode = head; },
    querySelector(selector) { const match = /^meta\[(name|property)="([^"]+)"\]$/.exec(selector); return nodes.find(node => node.getAttribute(match[1]) === match[2]) ?? null; } };
  const set = (key, content) => { const el = head.ownerDocument.createElement('meta'); el.setAttribute('name', key); el.setAttribute('content', content); head.append(el); return el; };
  return { head, set, nodes };
}
it('global PC metadata uses compare-and-restore and cannot overwrite a product writer that won the await race', async () => {
  const { pcBaseMetadataLease } = await server.ssrLoadModule('/src/utils/pcBaseMetadata.ts'); const f = metadataHead();
  const product = f.set('description', '原页面'), lease = pcBaseMetadataLease(f.head); product.setAttribute('content', '商品独立描述');
  lease.set('name', 'description', '迟到PC描述'); assert.equal(product.getAttribute('content'), '商品独立描述'); lease.close(); assert.equal(product.getAttribute('content'), '商品独立描述');
});
it('metadata cleanup restores only owned values and retains subsequent route metadata', async () => {
  const { pcBaseMetadataLease } = await server.ssrLoadModule('/src/utils/pcBaseMetadata.ts'); const f = metadataHead();
  const description = f.set('description', '原描述'), lease = pcBaseMetadataLease(f.head);
  lease.set('name', 'description', 'PC描述'); lease.set('name', 'keywords', 'PC关键词'); assert.equal(f.nodes.length, 2);
  f.head.querySelector('meta[name="keywords"]').setAttribute('content', '新路由关键词'); lease.close();
  assert.equal(description.getAttribute('content'), '原描述'); assert.equal(f.head.querySelector('meta[name="keywords"]').getAttribute('content'), '新路由关键词');
});
it('created metadata nodes are removed only when the owner still owns their exact content', async () => {
  const { pcBaseMetadataLease } = await server.ssrLoadModule('/src/utils/pcBaseMetadata.ts'); const f = metadataHead(), lease = pcBaseMetadataLease(f.head);
  lease.set('name', 'description', '第一行\r\n第二行'); assert.equal(f.nodes[0].getAttribute('content'), '第一行\r\n第二行'); lease.close(); assert.equal(f.nodes.length, 0);
});

it('public homepage keeps an authorized signed canonical product image at the real100 boundary', () => {
  const data = home(), signed = '/api/assets/99205?expires=1793300000&signature=' + 'a'.repeat(43);
  for (const index of [98,99,100]) data.info.bastList[index].image = signed;
  data.info.bastList[101].image = '/api/assets/99206';
  const result = pc.checkedPcHomepage(data);
  for (const index of [98,99,100]) assert.equal(result.best[index].image, signed);
  assert.equal(result.best[101].image, '');
});
