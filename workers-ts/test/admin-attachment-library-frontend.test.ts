import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, storage: Map<string, string>, browser: EventTarget;
const closes: Array<() => void> = [];
beforeAll(async () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/assets', search: '', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  const result = await build({
    absWorkingDir: root, stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/system/AttachmentLibrary.vue';
      export { default as request } from './src/utils/request';
      export * from './src/api/attachment'; export * from './src/utils/attachmentLibrary';
      export { createRenderer, nextTick } from 'vue'; export { createPinia } from 'pinia';
      export * as messages from 'element-plus';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'attachment-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'attachment-page' }).content, loader: 'ts' }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { confirms: [], confirm: async () => true, errors: [], closed: 0 };
        export const ElMessage = { error: value => state.errors.push(value) };
        export const ElMessageBox = { confirm: (...args) => { state.confirms.push(args); return state.confirm(...args); }, close: () => state.closed++ };` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  storage = new Map(); browser = Object.assign(new EventTarget(), { location: { pathname: '/assets', search: '', href: '' } });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  Object.assign(runtime.messages.state, { confirms: [], confirm: async () => true, errors: [], closed: 0 });
});
afterEach(() => { for (const close of closes.splice(0)) close(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 6; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
const category = (id: number, pid = 0, name = `分类${id}`) => ({ id, pid, name, title: name, type: 1, file_type: 1, relation_id: 0 });
const categories = [category(1, 0, '品牌'), category(2, 1, '产品'), category(3, 2, '子类')];
const image = (id: number, pid = 0) => ({ att_id: id, pid, real_name: `素材${id}.png`, canonical_url: `https://assets.example.test/assets/${id}.png`,
  att_dir: `https://assets.example.test/assets/${id}.png?expires=2000000000&signature=preview`, satt_dir: '', att_type: 'image/png', att_size: '12 KiB', raw_size: 12288, time: '2026-10-07 08:00:00',
  type: 1, file_type: 1, relation_id: 0, module_type: 1 });
function actor() { return { identity: 'actor-a', token: 'token-a', storedToken: 'token-a', session: 'session-a', view: true, manage: true }; }
async function harness(overrides: Record<string, unknown> = {}, amount = 3) {
  let current = actor(); const calls: Array<{ method: string; input: any; signal?: AbortSignal }> = [];
  const record = (method: string, input: any, signal?: AbortSignal) => calls.push({ method, input, signal });
  const ports = {
    list: async (q: any, signal: AbortSignal) => { record('list', q, signal); return { list: Array.from({ length: Math.min(q.limit, amount) }, (_, i) => image(i + 1, q.pid)), count: amount }; },
    categories: async (signal: AbortSignal) => { record('categories', {}, signal); return { list: categories }; },
    move: async (input: any, signal: AbortSignal) => { record('move', input, signal); return input; },
    rename: async (input: any, signal: AbortSignal) => { record('rename', input, signal); return input; },
    remove: async (input: any, signal: AbortSignal) => { record('remove', input, signal); return { ids: input, deleted: input.length }; },
    upload: async () => ({ att_id: 50 }), createCategory: async () => ({ id: 4 }), confirm: async () => true,
    ...overrides,
  };
  const controller = new runtime.AttachmentLibraryController(() => current, ports);
  await controller.activate();
  return { controller, state: controller.state, calls, replace: (value: any) => { current = value; } };
}
function login(permissions = ['attachment.view', 'attachment.manage'], token = 'media-token-a', id = 20, level = 1) {
  storage.set('admin_token', token); storage.set('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level, roles: '' }, menus: [], uniqueAuth: permissions }));
}
async function mount(permissions?: string[], respond?: (config: any) => unknown, level = 1) {
  login(permissions, 'media-token-a', 20, level); const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const data = respond ? await respond(config) : config.url === '/file/category' ? { list: categories } : config.url === '/config/storage'
      ? { active: { name: 'Cloudflare R2', binding: 'ASSETS_BUCKET', configured: true, private: true } } : { list: [image(1, config.params.pid)], count: 1 };
    return { config, data: { status: 200, msg: 'ok', data }, status: 200, statusText: 'fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.mount({ children: [] }); let closed = false; const close = () => { if (!closed) { closed = true; app.unmount(); } }; closes.push(close); await flush(); return { view, calls, close };
}

it('sends the existing exact PUT contracts with frozen IDs and no signed/canonical URL', async () => {
  login(); const calls: any[] = []; const abort = new AbortController();
  runtime.request.defaults.adapter = async (config: any) => { calls.push(config); return { config, data: { status: 200, msg: 'ok', data: config.url.includes('do_move') ? JSON.parse(config.data) : { id: 3, real_name: JSON.parse(config.data).real_name } }, status: 200, statusText: 'fixture', headers: {} }; };
  const ids = [4, 3]; await runtime.apiAttachmentMove({ ids, pid: 2 }, abort.signal); await runtime.apiAttachmentRename({ id: 3, real_name: ' 新名称.png ' }, abort.signal);
  expect(ids).toEqual([4, 3]); expect(calls.map(c => [c.method, c.url, JSON.parse(c.data)])).toEqual([['put', '/file/file/do_move', { ids: [3, 4], pid: 2 }], ['put', '/file/file/update/3', { real_name: '新名称.png' }]]);
  expect(calls.every(c => c.signal === abort.signal && c.baseURL === '/adminapi')).toBe(true);
});
it('preserves default root category reads and opts into all categories explicitly', async () => {
  login(); const calls: any[] = []; runtime.request.defaults.adapter = async (config: any) => { calls.push(config); return { config, data: { status: 200, data: { list: categories } }, status: 200, statusText: 'ok', headers: {} }; };
  await runtime.apiAttachmentCategories(); await runtime.apiAttachmentCategories(undefined, { all: true });
  expect(calls.map(c => c.params)).toEqual([{ pid: 0, file_type: 1 }, { pid: 0, file_type: 1, all: 1 }]);
});
it('validates one to fifty unique IDs, bounded targets and one trimmed Unicode name', () => {
  expect(runtime.normalizeAttachmentMove(Array.from({ length: 50 }, (_, i) => i + 1), 0).ids).toHaveLength(50);
  for (const ids of [[], [1, 1], ['1'], [0], [2147483648], Array.from({ length: 51 }, (_, i) => i + 1)]) expect(() => runtime.normalizeAttachmentMove(ids, 0)).toThrow();
  for (const pid of [-1, '1', NaN, 2147483648]) expect(() => runtime.normalizeAttachmentMove([1], pid)).toThrow();
  expect(runtime.normalizeAttachmentRename(1, ' 😀 '.repeat(1))).toEqual({ id: 1, real_name: '😀' });
  expect(runtime.normalizeAttachmentRename(1, '😀'.repeat(255)).real_name).toHaveLength(510);
  for (const value of ['', ' ', 'x\u0000', 'a'.repeat(256)]) expect(() => runtime.normalizeAttachmentRename(1, value)).toThrow();
});
it('offers full child paths and rejects foreign, cyclic, duplicate and orphan categories', () => {
  expect(runtime.decodeLibraryCategories({ list: categories }).map((c: any) => c.label)).toEqual(['品牌', '品牌 / 产品', '品牌 / 产品 / 子类']);
  for (const list of [[category(1), category(1)], [category(2, 9)], [category(1, 2), category(2, 1)], [{ ...category(1), relation_id: 5 }], [{ ...category(1), file_type: 2 }]]) expect(() => runtime.decodeLibraryCategories({ list })).toThrow();
});
it('fails closed for foreign/duplicate images and signed canonical URLs while retaining valid preview links', () => {
  const q = { pid: 0, page: 1, limit: 20, name: '' }; expect(runtime.decodeLibraryPage({ list: [image(1)], count: 1 }, q).list[0]).toEqual(image(1));
  for (const list of [[image(1, 2)], [image(1), image(1)], [{ ...image(1), relation_id: 2 }], [{ ...image(1), module_type: 2 }], [{ ...image(1), canonical_url: image(1).att_dir }], [{ ...image(1), att_dir: 'javascript:alert(1)' }]]) expect(() => runtime.decodeLibraryPage({ list, count: list.length }, q)).toThrow();
  expect(runtime.attachmentPreview('//foreign.test/image.png')).toBe(''); expect(runtime.attachmentPreview('https://assets.example.test/a.png')).toBeTruthy();
});
it('moves a fifty-item current page to a nested category and then the root without changing image URLs', async () => {
  const h = await harness({}, 50); await h.controller.setQuery({ limit: 50 }); const urls = h.state.items.map((r: any) => r.canonical_url);
  h.controller.selectPage(); h.controller.setTarget(3); expect(await h.controller.move()).toBe(true);
  expect(h.calls.find(c => c.method === 'move')?.input).toEqual({ ids: Array.from({ length: 50 }, (_, i) => i + 1), pid: 3 });
  expect(h.state.selected).toEqual([]); expect(h.state.items.map((r: any) => r.canonical_url)).toEqual(urls);
  await h.controller.setQuery({ pid: 3 }); h.controller.toggle(h.state.items[0], true); h.controller.setTarget(0); await h.controller.move();
  expect(h.calls.filter(c => c.method === 'move').at(-1)?.input).toEqual({ ids: [1], pid: 0 });
});
it('never sends IDs injected from a different page, category or stale row identity', async () => {
  const h = await harness(); h.controller.toggle(image(1, 2), true); expect(h.state.selected).toEqual([]);
  h.controller.openRename({ ...h.state.items[0], canonical_url: '/other.png' }); expect(h.state.rename).toBeNull();
  h.state.selected = [1, 999]; expect(await h.controller.move()).toBe(false); expect(h.calls.some(c => c.method === 'move')).toBe(false);
  h.state.selected = [1, 1]; expect(await h.controller.move()).toBe(false);
});
it.each(['reject', 'missing-id', 'wrong-target'])('retains failed move selection and target without success for %s', async failure => {
  const h = await harness({ move: async (input: any) => { if (failure === 'reject') throw Error('409 changed'); return failure === 'missing-id' ? { ids: [1], pid: input.pid } : { ...input, pid: 99 }; } });
  h.controller.toggle(h.state.items[0], true); h.controller.toggle(h.state.items[1], true); h.controller.setTarget(3);
  expect(await h.controller.move()).toBe(false); expect(h.state.selected).toEqual([1, 2]); expect(h.state.targetPid).toBe(3); expect(h.state.notice).toBe(''); expect(h.state.needsReview).toBe(true);
  expect(await h.controller.move()).toBe(false); await h.controller.load(); expect(h.state.needsReview).toBe(false); expect(h.state.selected).toEqual([1, 2]);
});
it('keeps a single rename draft and selection after rejection, and closes only on an exact acknowledgment', async () => {
  let reject = true; const h = await harness({ rename: async (input: any) => { if (reject) throw Error('409 changed'); return input; } });
  h.controller.toggle(h.state.items[1], true); h.controller.openRename(h.state.items[0]); h.controller.setRenameName(' 新显示名称.png ');
  expect(await h.controller.rename()).toBe(false); expect(h.state.rename).toEqual({ id: 1, name: ' 新显示名称.png ' }); expect(h.state.selected).toEqual([2]);
  await h.controller.load(); reject = false; expect(await h.controller.rename()).toBe(true); expect(h.state.rename).toBeNull(); expect(h.state.selected).toEqual([2]); expect(h.state.notice).toContain('重命名已确认');
});
it('does not accept a rename acknowledgment for a different identity or name', async () => {
  const h = await harness({ rename: async () => ({ id: 2, real_name: 'unrelated.png' }) }); h.controller.openRename(h.state.items[0]); h.controller.setRenameName('draft.png');
  expect(await h.controller.rename()).toBe(false); expect(h.state.rename).toEqual({ id: 1, name: 'draft.png' }); expect(h.state.notice).toBe('');
});
it('blocks duplicate writes and freezes draft/selection while a rename is pending', async () => {
  const waiting = deferred<unknown>(); let count = 0; const h = await harness({ rename: async () => { count++; return waiting.promise; } });
  h.controller.openRename(h.state.items[0]); h.controller.setRenameName('saved.png'); const pending = h.controller.rename();
  expect(h.controller.locked).toBe(true); expect(await h.controller.rename()).toBe(false); h.controller.setRenameName('changed.png'); h.controller.closeRename(); h.controller.toggle(h.state.items[1], true);
  expect(h.state.rename).toEqual({ id: 1, name: 'saved.png' }); expect(h.state.selected).toEqual([]); expect(count).toBe(1);
  waiting.resolve({ id: 1, real_name: 'saved.png' }); expect(await pending).toBe(true);
});
it('does not POST a stale confirmation after a category or account change', async () => {
  for (const change of ['category', 'actor']) {
    const confirm = deferred<unknown>(); const h = await harness({ confirm: () => confirm.promise }); h.controller.selectPage(); const pending = h.controller.move();
    if (change === 'category') await h.controller.setQuery({ pid: 2 }); else { h.replace({ ...actor(), identity: 'b', token: 'b', storedToken: 'b', session: 'b' }); await h.controller.activate(); }
    confirm.resolve(true); expect(await pending).toBe(false); expect(h.calls.some(c => c.method === 'move')).toBe(false); expect(h.state.selected).toEqual([]);
  }
});
it('aborts an in-flight PUT and ignores its late success after moving to a new category', async () => {
  const waiting = deferred<unknown>(); let signal!: AbortSignal; const h = await harness({ move: async (_: any, s: AbortSignal) => { signal = s; return waiting.promise; } });
  h.controller.selectPage(); h.controller.setTarget(3); const pending = h.controller.move(); await Promise.resolve(); await h.controller.setQuery({ pid: 2 });
  expect(signal.aborted).toBe(true); waiting.resolve({ ids: [1, 2, 3], pid: 3 }); expect(await pending).toBe(false); expect(h.state.query.pid).toBe(2); expect(h.state.items.every((r: any) => r.pid === 2)).toBe(true); expect(h.state.notice).toBe('');
});
it('does not report an old operation as current success after its refresh crosses an account boundary', async () => {
  const h = await harness(); const waiting = deferred<unknown>(); const original = h.controller['ports'].list;
  h.controller['ports'].list = () => waiting.promise; h.controller.openRename(h.state.items[0]); h.controller.setRenameName('saved.png'); const pending = h.controller.rename(); await Promise.resolve(); await Promise.resolve();
  h.replace({ ...actor(), identity: 'b', token: 'b', storedToken: 'b', session: 'b' }); h.controller['ports'].list = original; await h.controller.activate();
  h.controller.openRename(h.state.items[0]); h.controller.setRenameName('new account draft'); waiting.resolve({ list: [image(1)], count: 1 });
  expect(await pending).toBe(false); expect(h.state.rename).toEqual({ id: 1, name: 'new account draft' }); expect(h.state.notice).toBe('');
});
it('replaces stale list requests and clears drafts on page, search and category changes', async () => {
  const h = await harness(); const old = deferred<unknown>(); let stale!: AbortSignal;
  h.controller.openRename(h.state.items[0]); h.controller.selectPage();
  const original = h.controller['ports'].list; h.controller['ports'].list = (q: any, s: AbortSignal) => q.page === 2 ? (stale = s, old.promise) : original(q, s);
  const pending = h.controller.setQuery({ page: 2 }); await h.controller.setQuery({ pid: 3, page: 1, name: ' new ' }); old.resolve({ list: [image(99)], count: 1 }); await pending;
  expect(stale.aborted).toBe(true); expect(h.state.query).toMatchObject({ pid: 3, page: 1, name: 'new' }); expect(h.state.items.map((r: any) => r.att_id)).toEqual([1, 2, 3]); expect(h.state.selected).toEqual([]); expect(h.state.rename).toBeNull();
});
it('restarts an aborted category read when a query changes during initial loading', async () => {
  const first = deferred<unknown>(); let calls = 0; const h = await harness();
  h.controller['ports'].categories = () => ++calls === 1 ? first.promise : Promise.resolve({ list: categories });
  const pending = h.controller.loadCategories(); await h.controller.setQuery({ name: 'later' }); first.resolve({ list: [category(99)] }); await pending;
  expect(calls).toBe(2); expect(h.state.categories.map((c: any) => c.id)).toEqual([1, 2, 3]); expect(h.controller.writable).toBe(true);
});
it('loads real page GETs only for attachment.view and uses the full tree/category scope', async () => {
  const h = await mount(['attachment.view']); expect(h.view.canView.value).toBe(true); expect(h.view.canManage.value).toBe(false);
  expect(h.calls.map(c => c.url).sort()).toEqual(['/config/storage', '/file/category', '/file/file']); expect(h.calls.find(c => c.url === '/file/category').params.all).toBe(1);
  expect(h.view.state.categories[2].label).toBe('品牌 / 产品 / 子类'); h.view.controller.selectPage(); h.view.controller.openRename(h.view.state.items[0]); expect(h.view.state.selected).toEqual([]); expect(h.view.state.rename).toBeNull();
  expect(await h.view.controller.move()).toBe(false); expect(h.calls.every(c => c.method === 'get')).toBe(true);
});
it('requires view plus manage even when an actor has the management grant', async () => {
  const h = await mount(['attachment.manage']); expect(h.view.canView.value).toBe(false); expect(h.calls).toEqual([]); await h.view.controller.load(); expect(h.calls).toEqual([]);
});
it('honors the actual level-zero Admin bypass and rejects a mismatched stored token', async () => {
  const h = await mount([], undefined, 0); expect(h.view.canManage.value).toBe(true);
  storage.set('admin_token', 'different'); expect(await h.view.controller.rename()).toBe(false); h.view.controller.selectPage(); expect(h.view.state.selected).toEqual([]);
});
it('checks the stored permission body afresh before a write even without a session event', async () => {
  const h = await mount(); h.view.controller.openRename(h.view.state.items[0]); h.view.controller.setRenameName('draft.png');
  login(['attachment.view']); expect(await h.view.controller.rename()).toBe(false); expect(h.calls.some(c => c.method === 'put')).toBe(false);
});
it('aborts old-account reads, clears private drafts and discards their late results', async () => {
  const oldList = deferred<unknown>(), oldCategories = deferred<unknown>(), oldStorage = deferred<unknown>();
  const h = await mount(undefined, config => config.headers['Authori-zation'] === 'Bearer media-token-a'
    ? config.url === '/file/file' ? oldList.promise : config.url === '/file/category' ? oldCategories.promise : oldStorage.promise
    : config.url === '/file/file' ? { list: [image(30)], count: 1 } : config.url === '/file/category' ? { list: categories } : { active: { name: 'new storage', binding: 'ASSETS_BUCKET' } });
  const stale = [...h.calls]; login(['attachment.view', 'attachment.manage'], 'media-token-b', 30); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
  expect(stale.every(c => c.signal.aborted)).toBe(true); expect(h.view.state.items.map((r: any) => r.att_id)).toEqual([30]);
  h.view.controller.openRename(h.view.state.items[0]); h.view.controller.setRenameName('new actor draft');
  oldList.resolve({ list: [image(20)], count: 1 }); oldCategories.resolve({ list: [category(99)] }); oldStorage.resolve({ active: { name: 'old storage' } }); await flush();
  expect(h.view.state.items.map((r: any) => r.att_id)).toEqual([30]); expect(h.view.state.rename.name).toBe('new actor draft'); expect(h.view.storage.name).toBe('new storage');
  login(['order.view'], 'media-token-c', 40); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); expect(h.view.state.items).toEqual([]); expect(h.view.state.rename).toBeNull(); expect(h.view.canView.value).toBe(false);
});
it('ignores the old PUT receipt and hides the draft immediately when the account changes', async () => {
  const waiting = deferred<unknown>(); const h = await mount(undefined, config => config.method === 'put' ? waiting.promise : config.url === '/file/category' ? { list: categories } : config.url === '/file/file' ? { list: [image(1)], count: 1 } : { active: { name: 'R2', binding: 'ASSETS_BUCKET' } });
  h.view.controller.openRename(h.view.state.items[0]); h.view.controller.setRenameName('old actor name'); const pending = h.view.controller.rename(); await flush(); const write = h.calls.find(c => c.method === 'put');
  login(['attachment.view'], 'media-token-b', 30); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); expect(write.signal.aborted).toBe(true); expect(h.view.state.rename).toBeNull();
  waiting.resolve({ id: 1, real_name: 'old actor name' }); expect(await pending).toBe(false); expect(h.view.state.notice).toBe(''); expect(h.view.canManage.value).toBe(false);
});
it('aborts all page requests and rejects late responses on unmount', async () => {
  const waiting = deferred<unknown>(); const h = await mount(undefined, () => waiting.promise); const requests = [...h.calls]; h.close();
  expect(requests.every(c => c.signal.aborted)).toBe(true); waiting.resolve({ list: [image(1)], count: 1 }); await flush(); expect(h.view.state.items).toEqual([]); expect(h.view.state.categories).toEqual([]);
});
it('compiles the actual template and wires current-page selection, gated writes and retained rename draft', () => {
  const filename = resolve(root, 'src/pages/system/AttachmentLibrary.vue'); const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename });
  expect(errors).toEqual([]); const result = compileTemplate({ source: descriptor.template.content, filename, id: 'attachment-page', compilerOptions: { bindingMetadata: compileScript(descriptor, { id: 'attachment-page' }).bindings } }); expect(result.errors).toEqual([]);
  expect(descriptor.template.content).toContain('!controller.writable'); expect(descriptor.template.content).toContain('controller.openRename(item)'); expect(descriptor.template.content).toContain('controller.move()'); expect(descriptor.template.content).toContain('state.selected.length }} / 50');
  expect(descriptor.template.content).toContain("[...(state.rename?.name.trim() ?? '')].length");
  expect(descriptor.template.content).not.toContain('maxlength="255"');
  const renameDialog = descriptor.template.content.slice(descriptor.template.content.indexOf('title="重命名图片"'), descriptor.template.content.indexOf('title="新建根分类"'));
  expect(renameDialog).toContain('v-if="state.needsReview" :disabled="controller.locked" @click="reload">重新读取并核对');
});
