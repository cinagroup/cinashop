import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, createSSRApp, h, nextTick, proxyRefs } from 'vue';
import * as Vue from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import { renderToString } from '@vue/server-renderer';
const scripts = { page: ['/src/pages/user/MessageCenter.lifecycle-test.ts', '/src/pages/user/MessageCenter.vue'], nav: ['/src/components/PcMessageNav.lifecycle-test.ts', '/src/components/PcMessageNav.vue'] };
export function pcMessageCenterPlugin(root) {
  const entries = Object.values(scripts).map(([virtual, source]) => [root.replaceAll('\\', '/').replace(/\/$/, '') + virtual, virtual, root + source]);
  return { name: 'actual-pc-message-sfcs', resolveId(id) { return entries.find(([, virtual]) => virtual === id)?.[0]; }, async load(id) { const entry = entries.find(([full]) => full === id.replaceAll('\\', '/')); if (!entry) return; return compileScript(parse(await readFile(entry[2], 'utf8'), { filename: entry[2] }).descriptor, { id: entry[1] }).content; } };
}
const renderer = createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }), insert(n, p) { n.parent = p; (p.children ??= []).push(n); }, remove(n) { if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n); }, parentNode: n => n.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
const flush = async () => { for (let i = 0; i < 36; i++) { await Promise.resolve(); await nextTick(); } };
const gate = () => { let resolve; return { promise: new Promise(yes => { resolve = yes; }), resolve }; };
const row = (index, uid = 11) => ({ id: 500 - index, title: `账号${uid}站内信${index}`, content: '<script>alert(1)</script>\n第二行正文', add_time: 1794700800 - index });
let sequence = 0;
export function registerPcMessageCenterTests(context) {
  async function mount(override = () => undefined, options = {}) {
    const { server, authUtils, api, response } = context(), calls = [], listeners = new Map(), prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
    authUtils.setAuth('message-owner-' + (++sequence), 11); if (options.anonymous) authUtils.clearAuth();
    const doc = { visibilityState: 'visible', addEventListener(key, fn) { if (!listeners.has(key)) listeners.set(key, new Set()); listeners.get(key).add(fn); }, removeEventListener(key, fn) { listeners.get(key)?.delete(fn); } };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    const count = options.count ?? 22, reads = new Map();
    const seen = uid => { if (!reads.has(uid)) reads.set(uid, new Set()); return reads.get(uid); };
    const summary = uid => ({ version: 1, owner_uid: uid, unread: count - seen(uid).size });
    const list = (uid, page = 1) => { const items = Array.from({ length: Math.min(7, Math.max(0, count - (page - 1) * 7)) }, (_, i) => row((page - 1) * 7 + i, uid)); const before = summary(uid).unread, rows = items.map(r => ({ ...r, read_before: seen(uid).has(r.id) })); items.forEach(r => seen(uid).add(r.id)); return { version: 1, owner_uid: uid, query: { page, limit: 7 }, list: rows, count, page_count: Math.ceil(count / 7), unread_before: before, unread_after: summary(uid).unread }; };
    const detail = (uid, id) => { seen(uid).add(id); return { owner_uid: uid, id, message: row(500 - id, uid), service_num: summary(uid).unread }; };
    api.defaults.adapter = async config => {
      calls.push(config); assert.equal(config.method, 'get'); const uid = authUtils.getUid(), helpers = { uid, summary: () => summary(uid), list: page => list(uid, page), detail: id => detail(uid, id), seen: seen(uid) };
      const custom = await override(config, helpers); if (custom !== undefined) return response(config, custom);
      let data; if (config.url === '/user/message') { assert.deepEqual(config.params, { view: 'pc_message_summary' }); data = summary(uid); }
      else if (config.url === '/user/message_system/list') { assert.deepEqual(config.params, { view: 'pc_system_messages', page: config.params.page, limit: 7 }); data = list(uid, config.params.page); }
      else if (/^\/user\/message_system\/detail\/\d+$/.test(config.url)) { assert.deepEqual(config.params, { view: 'system_message_detail' }); data = detail(uid, Number(config.url.split('/').at(-1))); }
      else throw Error('Unexpected inbox request ' + config.url);
      return response(config, { status: 200, data });
    };
    const pageComponent = (await server.ssrLoadModule(scripts.page[0])).default, navComponent = (await server.ssrLoadModule(scripts.nav[0])).default;
    const dto = await server.ssrLoadModule('/@fs/' + new URL('../../common/pcMessageCenter.ts', import.meta.url).pathname.replace(/^\//, ''));
    const badge = await server.ssrLoadModule('/src/composables/usePcMessageBadge.ts');
    let view, nav;
    const Page = { setup(props, ctx) { view = pageComponent.setup(props, ctx); return () => null; } }, Nav = { setup(props, ctx) { nav = navComponent.setup(props, ctx); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/user/messages', alias: '/user/messageCenter', component: Page }, { path: '/away', component: { render: () => null } }, { path: '/login', component: { render: () => null } }] });
    const app = renderer.createApp({ render: () => h('div', [options.nav === false ? null : h(Nav), h(RouterView)]) }); app.use(router); await router.push(options.path ?? '/user/messages'); app.mount({ children: [] }); await flush(); let closed = false;
    return { get view() { return view; }, get nav() { return nav; }, dto, badge, calls, reads, router, doc, listeners, changeVisibility(value) { doc.visibilityState = value; for (const fn of [...(listeners.get('visibilitychange') ?? [])]) fn(); }, close() { if (closed) return; closed = true; app.unmount(); if (prior) Object.defineProperty(globalThis, 'document', prior); else delete globalThis.document; } };
  }
  const pages = f => f.calls.filter(c => c.url === '/user/message_system/list');
  const summaries = f => f.calls.filter(c => c.url === '/user/message');
  const details = f => f.calls.filter(c => c.url.startsWith('/user/message_system/detail/'));
  it('PC actual inbox SFC reads complete replacement pages 7/7/7/1 and updates only authoritative system unread counts', async () => {
    const f = await mount(); try { assert.equal(f.view.state.result.list.length, 7); assert.equal(f.view.badge.unread, 15); assert.ok(f.view.state.result.list.every(r => !r.read_before));
      for (const page of [2, 3, 4]) { await f.view.load(page); assert.equal(f.view.state.result.query.page, page); }
      assert.equal(f.view.state.result.list.length, 1); assert.equal(f.view.state.result.count, 22); assert.equal(f.view.badge.unread, 0); assert.deepEqual(pages(f).map(c => c.params.page), [1, 2, 3, 4]);
      await f.view.load(1); assert.ok(f.view.state.result.list.every(r => r.read_before)); assert.equal(f.view.badge.unread, 0);
    } finally { f.close(); }
  });
  it('PC failed next page preserves its prior page and retries the exact target without optimistic unread subtraction', async () => {
    let fail = true; const f = await mount((c, h) => c.url.endsWith('/list') && c.params.page === 2 && fail ? (fail = false, h.list(2), { status: 503, msg: '本页回执丢失' }) : undefined);
    try { await f.view.load(2); assert.equal(f.view.state.result.query.page, 1); assert.equal(f.view.state.result.list.length, 7); assert.equal(f.view.state.failedPage, 2); assert.match(f.view.state.error, /回执丢失/); assert.equal(f.view.badge.unread, null);
      const previous = pages(f).length; f.view.page(3); await flush(); assert.equal(pages(f).length, previous); await f.view.checkUnread(); assert.equal(f.view.badge.unread, 8); assert.equal(pages(f).length, previous);
      await f.view.retry(); assert.equal(f.view.state.result.query.page, 2); assert.ok(f.view.state.result.list.every(r => r.read_before)); assert.deepEqual(pages(f).map(c => c.params.page), [1, 2, 2]);
    } finally { f.close(); }
  });
  it('PC no render/computed access repeats the consuming list, and navigation manual refresh reads summary only', async () => {
    const f = await mount(); try { const length = pages(f).length; for (let i = 0; i < 12; i++) { void f.view.state.result; void f.view.locked.value; } await flush(); assert.equal(pages(f).length, length); await f.nav.refresh(); assert.equal(pages(f).length, length); assert.ok(summaries(f).length > 0); } finally { f.close(); }
  });
  it('PC an older in-flight summary cannot overwrite a later list receipt', async () => {
    const wait = gate(); let hold = false; const f = await mount(c => hold && c.url === '/user/message' ? wait.promise : undefined);
    try { hold = true; const operation = f.nav.refresh(); await flush(); await f.view.load(2); assert.equal(f.view.badge.unread, 8); wait.resolve({ status: 200, data: { version: 1, owner_uid: 11, unread: 22 } }); await operation; assert.equal(f.view.badge.unread, 8); } finally { wait.resolve({ status: 400 }); f.close(); }
  });
  it('PC a summary cannot start across an active page consumption', async () => {
    const wait = gate(); let hold = false; const f = await mount(c => hold && c.url.endsWith('/list') ? wait.promise : undefined);
    try { hold = true; const operation = f.view.load(2); await flush(); const count = summaries(f).length; await f.nav.refresh(); assert.equal(summaries(f).length, count); wait.resolve({ status: 503, msg: '结果未确认' }); await operation; assert.equal(f.view.badge.unread, null); } finally { wait.resolve({ status: 400 }); f.close(); }
  });
  it('PC collapse after a detail error sends no request, while reopen and explicit retry read that message', async () => {
    let fail = true;
    const f = await mount((c) => c.url.endsWith('/500') && fail ? { status: 503, msg: '详情暂不可用' } : undefined);
    try {
      await f.view.open(500); assert.ok(f.view.state.detailError); assert.equal(details(f).length, 1);
      await f.view.open(500); assert.equal(f.view.state.detailId, 0); assert.equal(details(f).length, 1);
      await f.view.open(500); assert.ok(f.view.state.detailError); assert.equal(details(f).length, 2);
      fail = false; await f.view.retryDetail(); assert.equal(f.view.state.detail.id, 500); assert.equal(details(f).length, 3);
      await f.view.open(500); assert.equal(f.view.state.detailId, 0); assert.equal(details(f).length, 3);
    } finally { f.close(); }
  });
  it('PC real detail has an explicit null state and retries only that exact current message', async () => {
    let mode = 'null'; const f = await mount((c, h) => c.url.endsWith('/500') ? mode === 'null' ? { status: 200, data: { owner_uid: h.uid, id: 500, message: null, service_num: 15 } } : mode === 'fail' ? { status: 503, msg: '详情暂不可用' } : undefined : undefined);
    try { await f.view.open(500); assert.equal(f.view.state.detailLoaded, true); assert.equal(f.view.state.detail, null); await f.view.open(500); assert.equal(f.view.state.detailId, 0); mode = 'fail'; await f.view.open(500); assert.match(f.view.state.detailError, /详情暂不可用/); mode = 'ok'; await f.view.retryDetail(); assert.equal(f.view.state.detail.id, 500); assert.equal(details(f).length, 3); await f.view.open(500); assert.equal(details(f).length, 3); } finally { f.close(); }
  });
  for (const change of [{ version: 2 }, { owner_uid: 22 }, { query: { page: 2, limit: 7 } }, { query: { page: 1, limit: 20 } }, { count: 2147483648 }, { page_count: 99 }, { unread_after: -1 }, { unread_before: -1 }, { list: [] }, { other_user: 'secret' }]) {
    it('PC rejects malformed or foreign list before publishing rows ' + JSON.stringify(change), async () => { const f = await mount((c, h) => c.url.endsWith('/list') ? { status: 200, data: { ...h.list(1), ...change } } : undefined); try { assert.equal(f.view.state.result, null); assert.ok(f.view.state.error); assert.equal(f.view.badge.unread, null); } finally { f.close(); } });
  }
  for (const mutation of [d => { d.list[1] = { ...d.list[0] }; }, d => { d.list[0].read_before = 0; }, d => { d.list[0].content = 'x'.repeat(65537); }, d => { d.list[0].title = '\u0000'; }, d => { d.list.reverse(); }]) {
    it('PC rejects duplicate, unordered, invalid-text or oversized message rows ' + mutation.toString(), async () => { const f = await mount((c, h) => { if (!c.url.endsWith('/list')) return; const data = h.list(1); mutation(data); return { status: 200, data }; }); try { assert.equal(f.view.state.result, null); assert.ok(f.view.state.error); } finally { f.close(); } });
  }
  for (const change of [{ owner_uid: 22 }, { id: 499 }, { message: { ...row(0), id: 499 } }, { message: {} }, { service_num: -1 }, { extra: 1 }]) {
    it('PC rejects mismatched detail without replacing the current page ' + JSON.stringify(change), async () => { const f = await mount((c, h) => c.url.endsWith('/500') ? { status: 200, data: { ...h.detail(500), ...change } } : undefined); try { await f.view.open(500); assert.equal(f.view.state.detail, null); assert.ok(f.view.state.detailError); assert.equal(f.view.state.result.query.page, 1); assert.equal(f.view.badge.unread, null); } finally { f.close(); } });
  }
  for (const change of [{ owner_uid: 22 }, { version: 2 }, { unread: -1 }, { unread: '3' }, { service: [] }]) {
    it('PC rejects malformed summary without inventing a zero badge ' + JSON.stringify(change), async () => { const f = await mount(c => c.url === '/user/message' ? { status: 200, data: { version: 1, owner_uid: 11, unread: 3, ...change } } : undefined); try { const old = f.view.badge.unread; await f.view.checkUnread(); assert.equal(f.view.badge.unread, old); assert.ok(f.view.badge.error); } finally { f.close(); } });
  }
  for (const kind of ['list', 'detail', 'summary']) for (const ending of ['identity', 'new-token-same-uid', 'same-token-generation', 'query', 'hidden', 'unmount']) {
    it(`PC late ${kind} cannot repopulate old state or badge after ${ending}`, async () => {
      const wait = gate(); let hold = false, pendingData; const match = c => kind === 'list' ? c.url.endsWith('/list') : kind === 'detail' ? c.url.endsWith('/500') : c.url === '/user/message';
      const f = await mount((c, h) => { if (!hold || !match(c)) return; pendingData = kind === 'list' ? h.list(2) : kind === 'detail' ? h.detail(500) : h.summary(); return wait.promise; });
      try { hold = true; const operation = kind === 'list' ? f.view.load(2) : kind === 'detail' ? f.view.open(500) : f.nav.refresh(); await flush(); hold = false;
        if (ending === 'identity') context().authUtils.setAuth('message-owner-b', 22);
        else if (ending === 'new-token-same-uid') context().authUtils.setAuth('message-renewed', 11);
        else if (ending === 'same-token-generation') context().authUtils.setAuth(context().authUtils.getToken(), 11);
        else if (ending === 'query') await f.router.push('/user/messages?changed=1');
        else if (ending === 'hidden') f.changeVisibility('hidden'); else f.close();
        await flush(); const current = { result: f.view.state.result && JSON.stringify(f.view.state.result), detail: f.view.state.detail, error: f.view.state.error, unread: f.badge.pcMessageBadge.unread };
        wait.resolve({ status: 200, data: pendingData }); await operation; await flush(); assert.deepEqual({ result: f.view.state.result && JSON.stringify(f.view.state.result), detail: f.view.state.detail, error: f.view.state.error, unread: f.badge.pcMessageBadge.unread }, current);
      } finally { wait.resolve({ status: 400 }); f.close(); }
    });
  }
  it('PC route A-B-A and reopening a hidden page perform one new list and do not revive an old detail', async () => {
    const wait = gate(); let hold = false; const f = await mount((c, h) => hold && c.url.endsWith('/500') ? (h.detail(500), wait.promise) : undefined);
    try { hold = true; const operation = f.view.open(500); await flush(); await f.router.push('/away'); await f.router.push('/user/messages'); await flush(); wait.resolve({ status: 200, data: { owner_uid: 11, id: 500, message: row(0), service_num: 0 } }); await operation; assert.equal(f.view.state.detailId, 0); const before = pages(f).length; f.changeVisibility('hidden'); assert.equal(f.view.state.result, null); assert.equal(f.view.badge.unread, null); f.changeVisibility('visible'); await flush(); assert.equal(pages(f).length, before + 1); assert.equal(f.view.badge.unread, 15); } finally { wait.resolve({ status: 400 }); f.close(); }
  });
  it('PC anonymous canonical and legacy messages retain the exact login return and perform no private I/O', async () => {
    const f = await mount(() => undefined, { anonymous: true, path: '/user/messageCenter?types=3' }); try { assert.equal(f.view.loggedIn.value, false); assert.equal(f.view.loginPath.value, '/login?redirect=%2Fuser%2FmessageCenter%3Ftypes%3D3'); await f.view.load(); await f.view.checkUnread(); await f.nav.refresh(); assert.equal(f.calls.length, 0); } finally { f.close(); }
  });
  it('PC empty inbox is a successful empty state and a large complete directory supports its actual last page', async () => {
    let f = await mount(() => undefined, { count: 0 }); try { assert.deepEqual(f.view.state.result.list, []); assert.equal(f.view.state.result.page_count, 0); assert.equal(f.view.badge.unread, 0); } finally { f.close(); }
    f = await mount(); try { const count = 2147483647, page = Math.ceil(count / 7), list = Array.from({ length: count - (page - 1) * 7 }, (_, i) => ({ ...row(i), read_before: true })); const parsed = f.dto.normalizePcMessagePage({ version: 1, owner_uid: 11, query: { page, limit: 7 }, list, count, page_count: page, unread_before: 0, unread_after: 0 }, 11, page); assert.equal(parsed.page_count, 306783379); assert.equal(parsed.list.length, 1); } finally { f.close(); }
  });
  it('PC accepts newly arrived unread facts, rejects UTF8 pages above one MiB, and coalesces an active page action', async () => {
    const wait = gate(); let hold = false; const f = await mount(c => hold && c.url.endsWith('/list') ? wait.promise : undefined);
    try { const list = Array.from({ length: 7 }, (_, i) => ({ ...row(i), content: '汉'.repeat(65536), read_before: true })); assert.throws(() => f.dto.normalizePcMessagePage({ version: 1, owner_uid: 11, query: { page: 1, limit: 7 }, list, count: 7, page_count: 1, unread_before: 0, unread_after: 0 }, 11, 1), /容量/);
      const fresh = f.dto.normalizePcMessagePage({ ...f.view.state.result, unread_before: 0, unread_after: 23 }, 11, 1); assert.equal(fresh.unread_after, 23);
      hold = true; const first = f.view.load(2), before = pages(f).length; await f.view.load(2); assert.equal(pages(f).length, before); wait.resolve({ status: 503, msg: '本页读取未确认' }); await first;
    } finally { wait.resolve({ status: 400 }); f.close(); }
  });
  it('PC invalid page jumps perform no I/O and direct bad API inputs are rejected before Axios', async () => {
    const f = await mount(); try { const before = f.calls.length; for (const value of ['0', '01', '1e2', '2.5', '5', '2147483648']) { f.view.pageInput.value = value; f.view.jump(); assert.ok(f.view.pageError.value); } assert.equal(f.calls.length, before); const api = await context().server.ssrLoadModule('/src/api/pcMessages.ts'); for (const page of [0, NaN, 1.5, 2147483648]) await assert.rejects(api.apiPcMessagePage(11, page)); await assert.rejects(api.apiPcMessageSummary(0)); assert.equal(f.calls.length, before); } finally { f.close(); }
  });
  it('PC actual page template renders the real nullable/retry/pagination contract and escapes full multiline content', async () => {
    const f = await mount(); try { await f.view.open(500); const template = parse(await readFile(new URL('../src/pages/user/MessageCenter.vue', import.meta.url), 'utf8')).descriptor.template.content; assert.doesNotMatch(template, /v-html/); const render = Vue.compile(template, { mode: 'function', prefixIdentifiers: true }), ctx = proxyRefs(f.view), app = createSSRApp({ render() { return render(ctx, []); } }); app.config.warnHandler = () => {}; app.component('RouterLink', { props: ['to'], render() { return h('a', { href: this.to }, this.$slots.default?.()); } }); const html = await renderToString(app); for (const label of ['打开一页站内信会将该页消息标记为已读', '本次打开前未读', '共 22 条站内信', '每页 7 条', '只读核对未读数', '下一页', '最后一页', '&lt;script&gt;alert(1)&lt;/script&gt;', '第二行正文']) assert.ok(html.includes(label), label); assert.equal(details(f).length, 1); } finally { f.close(); }
  });
  it('PC navigation template uses the system-only badge and current actual router keeps the legacy route protected', async () => {
    const f = await mount(); try { const source = await readFile(new URL('../src/components/PcMessageNav.vue', import.meta.url), 'utf8'); assert.match(source, /badge\.unread > 99 \? '99\+'/); assert.doesNotMatch(source, /mssage_num|service_num/); const router = await readFile(new URL('../src/router/index.ts', import.meta.url), 'utf8'), layout = await readFile(new URL('../src/layouts/DefaultLayout.vue', import.meta.url), 'utf8'), center = await readFile(new URL('../src/pages/user/UserCenter.vue', import.meta.url), 'utf8'); assert.match(router, /path: "user\/messages", alias: "\/user\/messageCenter"/); assert.match(layout, /<PcMessageNav \/>/); assert.match(center, /to="\/user\/messages"/); const auth = await context().server.ssrLoadModule('/src/utils/authNavigation.ts'); assert.equal(auth.requiresPcAuth('/user/messageCenter'), true); assert.equal(auth.requiresPcAuth('/user/messages'), true); } finally { f.close(); }
  });
}
