import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer, transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, defineComponent, h, markRaw, nextTick, onBeforeUnmount } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';

// The real layout, Pinia stores, session publisher, Axios interceptors and
// memory router execute. Only transport, DOM storage/head and unused Element
// presentation/message UI are hosted here; no auth or API module is replaced.
const root = fileURLToPath(new URL('../', import.meta.url));
const descriptors = new Map();
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key), clear: () => values.clear() };
};
const splitIdentity = value => { const at = value.indexOf(':'); return [value.slice(0, at), value.slice(at + 1)]; };
const metaKeys = ['name:description', 'name:keywords', 'property:og:title', 'property:og:description', 'property:og:image'];
function documentHost() {
  const nodes = [], doc = { title: 'Initial document title' };
  const make = tag => {
    const attrs = new Map();
    return { tag, parentNode: null, getAttribute: key => attrs.get(key) ?? null, setAttribute: (key, value) => attrs.set(key, String(value)),
      get rel() { return attrs.get('rel') ?? ''; }, set rel(value) { attrs.set('rel', value); },
      get href() { return attrs.get('href') ?? ''; }, set href(value) { attrs.set('href', value); },
      remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); this.parentNode = null; } };
  };
  doc.createElement = make;
  doc.head = { ownerDocument: doc, append(node) { nodes.push(node); node.parentNode = this; }, querySelector(selector) {
    if (selector === 'link[rel~="icon"]') return nodes.find(row => row.tag === 'link' && row.rel.split(' ').includes('icon')) ?? null;
    const match = /^meta\[(name|property)="([^"]+)"\]$/u.exec(selector);
    assert.ok(match, 'unexpected metadata selector ' + selector);
    return nodes.find(row => row.tag === 'meta' && row.getAttribute(match[1]) === match[2]) ?? null;
  } };
  const node = identity => {
    const [attribute, key] = splitIdentity(identity);
    return doc.head.querySelector(`meta[${attribute}="${key}"]`);
  };
  const read = identity => node(identity)?.getAttribute('content') ?? null;
  const write = (identity, content) => {
    const [attribute, key] = splitIdentity(identity), current = node(identity), target = current ?? make('meta');
    target.setAttribute(attribute, key); target.setAttribute('content', content); if (!current) doc.head.append(target);
  };
  for (const identity of metaKeys) write(identity, 'initial ' + identity);
  return { doc, read, write, values: () => Object.fromEntries(metaKeys.map(key => [key, read(key)])) };
}
let server, api, authUtils, useAuthStore, bindAuthStores, pc;
before(async () => {
  for (const [key, value] of Object.entries({ document: documentHost().doc, sessionStorage: storage(), localStorage: storage(),
    window: { location: { origin: 'https://shop.example.test', pathname: '/', search: '', hash: '', replace() {} }, addEventListener() {}, removeEventListener() {} } })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  server = await createServer({ configFile: false, root, envFile: false, logLevel: 'error',
    plugins: [{ name: 'actual-pc-layout-template', resolveId(id) { if (id === '/@test/pc-layout-messages') return id; }, async load(id) {
      if (id === '/@test/pc-layout-messages') return 'export const ElMessage = { success() { throw Error("unexpected logout message"); }, warning() { throw Error("unexpected logout message"); } };';
      if (!id.startsWith(root) || !id.endsWith('.vue')) return;
      const { descriptor } = parse(await readFile(id, 'utf8'), { filename: id });
      const compiled = compileScript(descriptor, { id: 'actual-pc-layout', inlineTemplate: true }).content
        .replace(/from (["'])element-plus\1/gu, 'from "/@test/pc-layout-messages"');
      return (await transformWithEsbuild(compiled, id, { loader: 'ts' })).code;
    } }], resolve: { alias: { '@': root + 'src' } }, optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null } });
  api = (await server.ssrLoadModule('/src/utils/request.ts')).default;
  authUtils = await server.ssrLoadModule('/src/utils/auth.ts');
  ({ useAuthStore } = await server.ssrLoadModule('/src/stores/auth.ts'));
  ({ bindAuthStores } = await server.ssrLoadModule('/src/stores/session.ts'));
  pc = await server.ssrLoadModule('/src/api/pcBase.ts');
});
after(async () => {
  await server?.close();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
});
const node = tag => markRaw({ tag, text: '', props: {}, children: [], parent: null });
const renderer = createRenderer({ createElement: node, createText: text => Object.assign(node('#text'), { text }), createComment: text => Object.assign(node('#comment'), { text }),
  insert(child, parent, anchor) { if (child.parent) child.parent.children = child.parent.children.filter(row => row !== child); child.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child); },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(row => row !== child); },
  parentNode: child => child?.parent, nextSibling: child => { const siblings = child?.parent?.children ?? []; return siblings[siblings.indexOf(child) + 1] ?? null; },
  patchProp: (el, key, _old, value) => { el.props[key] = value; }, setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; } });
const all = el => [el, ...el.children.flatMap(all)], words = el => all(el).map(row => row.text).join(' ');
const flush = async () => { for (let n = 0; n < 18; n++) { await nextTick(); await new Promise(setImmediate); } };
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const company = (change = {}) => ({ pc_logo: '/uploads/pc-logo.png', logoUrl: 'https://wap.example.test/uploads/pc-logo.png', site_name: 'Current company',
  contact_number: '4001234567', company_address: 'Current address', copyright: 'Current copyright', record_No: 'Current record',
  site_keywords: 'Current keywords', site_description: 'Current description', links_open: 1, links_list: [{ name: 'Current link', url: '/terms' }], filing_list: [], ...change });
const site = (change = {}) => ({ site_name: 'Current site', record_No: 'Current site record', ico_path: 'https://images.example.test/icon.png', ...change });
const share = (change = {}) => ({ title: 'Current share title', synopsis: 'Current share description', img: 'https://images.example.test/share.png', ...change });
const publicValue = url => url === '/site_config' ? site() : url === '/share' ? share() : url === '/pc/get_company_info' ? company() : (() => { throw Error('unexpected API ' + url); })();
const token = id => 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, jti: { id, type: 'user' } })).toString('base64url') + '.signature';
async function mount(answer = () => undefined, options = {}) {
  authUtils.clearAuth(); const head = documentHost(); globalThis.document = head.doc;
  const calls = [], warnings = [], errors = [];
  api.defaults.adapter = async config => {
    calls.push(config); const custom = await answer(config, calls);
    return { data: { status: 200, msg: 'ok', data: custom === undefined ? publicValue(config.url) : custom }, status: 200, statusText: 'owned', headers: {}, config };
  };
  const pinia = createPinia(), auth = useAuthStore(pinia), unbind = bindAuthStores(pinia);
  const layout = (await server.ssrLoadModule('/src/layouts/DefaultLayout.vue')).default;
  const product = defineComponent({ name: 'ActualRouteMetadataWriter', setup() {
    const beforeTitle = document.title, before = head.values();
    document.title = 'Product route title'; for (const key of metaKeys) head.write(key, 'product ' + key);
    if (options.restoreProduct) onBeforeUnmount(() => {
      if (document.title === 'Product route title') document.title = beforeTitle;
      for (const key of metaKeys) if (head.read(key) === 'product ' + key) head.write(key, before[key]);
    });
    return () => h('p', {}, 'Product child');
  } });
  const empty = defineComponent({ name: 'ChildRoute', setup: () => () => h('p', {}, 'Home child') });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: layout, children: [
    { path: '', component: empty }, { path: 'login', component: empty }, { path: 'goods/70', component: product },
    ...['category', 'goods', 'seckill', 'bargain', 'combination', 'presale', 'community', 'service', 'cart', 'user', 'search'].map(path => ({ path, component: empty })),
  ] }] });
  const tree = node('root'), app = renderer.createApp({ render: () => h(RouterView) });
  for (const name of ['ElInput', 'ElButton', 'ElBadge']) app.component(name, defineComponent({ name, setup(_props, { slots }) {
    return () => h('span', {}, [slots.default?.(), slots.append?.()]);
  } }));
  app.config.warnHandler = message => warnings.push(message); app.config.errorHandler = error => errors.push(error);
  app.use(pinia); app.use(router); await router.push(options.path ?? '/'); await router.isReady(); app.mount(tree); await flush();
  const layoutNode = all(tree).find(row => row.props.class === 'layout'); assert.ok(layoutNode);
  let closed = false;
  return { tree, head, calls, warnings, auth, router, layoutNode,
    sameLayout() { assert.equal(all(tree).find(row => row.props.class === 'layout'), layoutNode); },
    close() { if (!closed) { app.unmount(); unbind(); closed = true; } assert.deepEqual(errors, []); assert.deepEqual(warnings, []); } };
}

it('actual persistent layout consumes the matching legacy public logo origin while private signed assets remain same-origin', async () => {
  const f = await mount();
  try {
    assert.equal(all(f.tree).find(row => row.props.class === 'logo-img').props.src, 'https://wap.example.test/uploads/pc-logo.png');
    assert.ok(words(f.tree).includes('Current address')); assert.equal(f.head.read('name:description'), 'Current description');
    const absolute = 'http://images.example.test/%E5%8E%9F%E5%9B%BE.png?size=2';
    assert.equal(pc.checkedPcCompany(company({ pc_logo: absolute, logoUrl: 'https://wrong.example.test/different.png' })).logo, absolute);
    const signed = '/api/assets/42?expires=1793300000&signature=' + 'a'.repeat(43);
    assert.equal(pc.checkedPcCompany(company({ pc_logo: signed, logoUrl: 'https://wap.example.test' + signed })).logo, signed);
    for (const logoUrl of ['https://wap.example.test/different.png', 'https://user:secret@wap.example.test/uploads/pc-logo.png', 'javascript:private', '/api/assets/42?signature=private']) {
      assert.equal(pc.checkedPcCompany(company({ logoUrl })).logo, '/uploads/pc-logo.png');
    }
  } finally { f.close(); }
});

it('a real Pinia login aborts all old public requests and restores company data in the same layout before a late prior response', async () => {
  const oldCompany = gate(); let reads = 0;
  const f = await mount(config => config.url === '/pc/get_company_info' ? (++reads === 1 ? oldCompany.promise : company({ company_address: 'New session address', site_description: 'New session description' })) : undefined);
  try {
    const initial = f.calls.slice(); assert.equal(initial.length, 3); assert.equal(new Set(initial.map(row => row.signal)).size, 1);
    await f.router.push('/login'); await flush(); f.sameLayout();
    const nextToken = token(8); f.auth.applyLogin({ token: nextToken }); await flush(); await f.router.push('/'); await flush(); f.sameLayout();
    assert.ok(initial.every(row => row.signal.aborted));
    for (const url of ['/site_config', '/share', '/pc/get_company_info']) assert.equal(f.calls.filter(row => row.url === url).length, 2);
    assert.ok(f.calls.slice(3).every(row => row.headers.get('Authori-zation') === 'Bearer ' + nextToken));
    assert.ok(words(f.tree).includes('New session address'));
    oldCompany.resolve(company({ company_address: 'Retired account address', site_description: 'Retired account description' })); await flush();
    assert.ok(!words(f.tree).includes('Retired account address')); assert.ok(words(f.tree).includes('New session address'));
  } finally { oldCompany.resolve(company()); f.close(); }
});

it('a same-route auth generation refreshes public metadata only while the layout still owns the exact nodes and title', async () => {
  const delayed = gate(); let reads = 0;
  const f = await mount(config => config.url === '/pc/get_company_info' ? (++reads === 1 ? delayed.promise : company({ site_description: 'Fresh description', site_keywords: 'Fresh keywords' })) : undefined);
  try {
    f.auth.applyLogin({ token: token(9) }); await flush(); f.sameLayout();
    assert.equal(f.head.read('name:description'), 'Fresh description'); assert.equal(document.title, 'Current company');
    f.head.write('name:keywords', 'Product component keywords'); document.title = 'Product component title';
    authUtils.setAuth(token(9), 9); await flush();
    assert.equal(f.head.read('name:keywords'), 'Product component keywords'); assert.equal(document.title, 'Product component title');
    delayed.resolve(company({ site_description: 'Retired description' })); await flush(); assert.equal(f.head.read('name:description'), 'Fresh description');
  } finally { delayed.resolve(company()); f.close(); }
});

it('an initial product child wins the real layout metadata await race and cleanup does not overwrite its metadata', async () => {
  const delayed = gate(), f = await mount(config => config.url === '/pc/get_company_info' ? delayed.promise : undefined, { path: '/goods/70' });
  try {
    delayed.resolve(company()); await flush();
    for (const key of metaKeys) assert.equal(f.head.read(key), 'product ' + key);
    assert.equal(document.title, 'Product route title'); assert.ok(words(f.tree).includes('Current address'));
    f.close(); await flush(); for (const key of metaKeys) assert.equal(f.head.read(key), 'product ' + key); assert.equal(document.title, 'Product route title');
  } finally { delayed.resolve(company()); f.close(); }
});

it('route A to product B to A permanently retires metadata ownership even after nodes return to their original values and auth rereads', async () => {
  const delayed = gate(); let reads = 0;
  const f = await mount(config => config.url === '/pc/get_company_info' ? (++reads === 1 ? delayed.promise : company({ site_description: 'New auth global description' })) : undefined, { restoreProduct: true });
  try {
    const initial = f.head.values(); await f.router.push('/goods/70'); await flush(); f.sameLayout();
    assert.equal(document.title, 'Product route title'); await f.router.push('/'); await flush(); f.sameLayout();
    assert.deepEqual(f.head.values(), initial); assert.equal(document.title, 'Initial document title');
    delayed.resolve(company()); await flush(); assert.deepEqual(f.head.values(), initial); assert.equal(document.title, 'Initial document title');
    f.auth.applyLogin({ token: token(10) }); await flush(); f.sameLayout();
    assert.equal(reads, 2); assert.ok(words(f.tree).includes('Current address')); assert.deepEqual(f.head.values(), initial); assert.equal(document.title, 'Initial document title');
  } finally { delayed.resolve(company()); f.close(); }
});

it('layout unmount restores only still-owned values and aborts pending full public rereads without later auth dispatch', async () => {
  const late = gate(); let hold = false;
  const f = await mount(() => hold ? late.promise : undefined, { restoreProduct: true });
  try {
    assert.equal(f.head.read('name:description'), 'Current description'); assert.equal(document.title, 'Current company');
    f.head.write('name:keywords', 'Later route keywords'); hold = true; f.auth.applyLogin({ token: token(11) }); await flush();
    const pending = f.calls.slice(-3); assert.ok(pending.every(row => !row.signal.aborted));
    await f.router.push('/goods/70'); await flush(); f.sameLayout(); assert.equal(document.title, 'Product route title'); f.close(); await flush();
    assert.ok(pending.every(row => row.signal.aborted)); assert.equal(f.head.read('name:description'), 'initial name:description');
    assert.equal(f.head.read('name:keywords'), 'Later route keywords'); assert.equal(document.title, 'Initial document title');
    const count = f.calls.length; authUtils.setAuth(token(12), 12); await flush(); assert.equal(f.calls.length, count);
    late.resolve(company({ site_description: 'Unmounted description' })); await flush();
    assert.equal(f.head.read('name:description'), 'initial name:description'); assert.equal(f.head.read('name:keywords'), 'Later route keywords'); assert.equal(document.title, 'Initial document title');
  } finally { late.resolve(company()); f.close(); }
});
