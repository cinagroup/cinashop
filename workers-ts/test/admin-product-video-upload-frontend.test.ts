import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc'), { compile } = require('@vue/compiler-dom');
let runtime: any, browser: EventTarget, storage: Map<string, string>, sessionValues: Map<string, string>, sessionStore: any;
const closes: Array<() => void> = [], key = (actor = 20) => `cinashop.product-video.pending.v1.${actor}`;
const grants = ['product.manage', 'attachment.view', 'attachment.manage'];
beforeAll(async () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/product/edit/19', search: '', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as Uploader } from './src/components/ProductVideoUploader.vue';
    export * as api from './src/api/productVideoUpload'; export { default as request } from './src/utils/request';
    export * as vue from 'vue'; export { createRenderer, reactive, nextTick } from 'vue';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'real-product-video-uploader', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, script = compileScript(descriptor, { id: 'product-video-upload' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'product-video-upload', compilerOptions: { bindingMetadata: script.bindings } });
        if (template.errors.length) throw Error(template.errors.map(String).join('\n'));
        return { contents: script.content, loader: 'ts' };
      });
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});
beforeEach(() => {
  storage = new Map(); sessionValues = new Map(); browser = Object.assign(new EventTarget(), { location: { pathname: '/product/edit/19', search: '', href: '' } });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('localStorage', { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) });
  sessionStore = { getItem: vi.fn((name: string) => sessionValues.get(name) ?? null), setItem: vi.fn((name: string, value: string) => sessionValues.set(name, value)), removeItem: vi.fn((name: string) => sessionValues.delete(name)) };
  vi.stubGlobal('sessionStorage', sessionStore); login();
});
afterEach(() => { for (const close of closes.splice(0)) close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function login(actor = 20, permissions = grants) {
  storage.set('admin_token', 'video-token-' + actor);
  storage.set('admin_session', JSON.stringify({ userInfo: { id: actor, account: 'owned-video-' + actor, level: 1, roles: '1' }, menus: [], uniqueAuth: permissions }));
}
const flush = async () => { for (let index = 0; index < 8; index++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
async function until(predicate: () => boolean) { for (let index = 0; index < 60; index++) { if (predicate()) return; await flush(); } throw Error('Expected uploader boundary was not reached'); }
function deferred<T = void>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const body = (config: any) => typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
const mutations = (calls: any[]) => calls.filter(call => call.method !== 'get');
const parts = (calls: any[]) => calls.filter(call => call.method === 'put').map(call => Number(call.url.split('/').at(-1)));
function bytes(length = 43) { const value = Uint8Array.from({ length }, (_, index) => index % 251); value.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]); return value; }
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const file = (value = bytes(), name = 'owned.mp4', type = 'video/mp4') => new File([value], name, { type });
function manifest(value = bytes(), chunk = 16) { return { filename: 'owned.mp4', total_size: value.length, chunk_size: chunk, pid: 0,
  sha256: Array.from({ length: Math.ceil(value.length / chunk) }, (_, index) => sha(value.slice(index * chunk, (index + 1) * chunk))) }; }
function serverManifest(value: any) { return { version: 1, mode: 'manifest', filename: value.filename, total_size: value.total_size,
  chunk_size: value.chunk_size, total_chunks: value.sha256.length, sha256: [...value.sha256], pid: value.pid, client_md5: null }; }
function fakeServer() {
  const records = new Map<string, any>();
  const seed = (id: string, source = manifest(), confirmed: number[] = [], state = 'active', actor = 20) => {
    const row = { upload_id: id, actor_id: actor, state, manifest: serverManifest(source), confirmed: [...confirmed],
      result: state === 'committed' ? { id: 301, url: '/api/assets/301', size: source.total_size } : null }; records.set(id, row); return row;
  };
  const respond = (config: any): any => {
    const match = /^\/file\/video_uploads\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(config.url); if (!match) throw Error('Unexpected uploader request ' + config.url);
    const id = match[1], action = match[2] ?? '', actor = Number(String(config.headers['Authori-zation']).match(/-(\d+)$/)?.[1] ?? 20);
    let row = records.get(id);
    if (config.method === 'get' && !action) return structuredClone(row ?? { upload_id: id, actor_id: actor, state: 'unknown', manifest: null, confirmed: [], result: null });
    if (config.method === 'post' && !action) {
      const source = body(config); expect(Object.keys(source).sort()).toEqual(['chunk_size', 'filename', 'pid', 'sha256', 'total_size']);
      if (!row) row = seed(id, source, [], 'active', actor); return structuredClone(row);
    }
    if (config.method === 'post' && action === 'cancel') {
      expect(config.data).toBeUndefined();
      if (!row) { row = { upload_id: id, actor_id: actor, state: 'cancelled', manifest: null, confirmed: [], result: null }; records.set(id, row); }
      if (row.state !== 'committed') row.state = 'cancelled'; return structuredClone(row);
    }
    if (!row) throw Error('Missing fixture upload');
    if (config.method === 'put' && /^parts\/[1-9]\d*$/.test(action)) {
      if (row.state === 'cancelled') throw Error('Owned fixture rejects a late cancelled part');
      const index = Number(action.split('/')[1]); expect(config.data).toBeInstanceOf(ArrayBuffer);
      expect(sha(new Uint8Array(config.data))).toBe(row.manifest.sha256[index - 1]);
      if (!row.confirmed.includes(index)) row.confirmed.push(index); return structuredClone(row);
    }
    if (config.method === 'post' && action === 'complete') {
      expect(config.data).toBeUndefined(); expect(row.confirmed.length).toBe(row.manifest.total_chunks);
      row.state = 'committed'; row.result = { id: 301, url: '/api/assets/301', size: row.manifest.total_size }; return structuredClone(row);
    }
    if (config.method === 'get' && action === 'preview') return { url: row.result.url, src: row.result.url + '?expires=2000000000&signature=temporary-video-preview' };
    throw Error('Unhandled uploader fixture ' + config.method + ' ' + action);
  };
  return { records, seed, respond };
}
async function mount(options: { server?: ReturnType<typeof fakeServer>; respond?: (config: any, server: ReturnType<typeof fakeServer>) => unknown; disabled?: boolean; permissions?: string[] } = {}) {
  if (options.permissions) login(20, options.permissions);
  const server = options.server ?? fakeServer(), calls: any[] = [], emissions: unknown[][] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = options.respond ? await options.respond(config, server) : undefined, data = custom === undefined ? server.respond(config) : custom;
    return { config, data: data?.__envelope ?? { status: 200, msg: 'ok', data }, status: 200, statusText: 'owned uploader fixture', headers: {} };
  };
  const props = runtime.reactive({ open: true, disabled: options.disabled ?? false, contextKey: 'product:19:ordinary' }); let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); }, remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null,
    patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(_props: unknown, context: any) { view = runtime.Uploader.setup(props, { ...context, emit: (...args: unknown[]) => emissions.push(args) }); return () => null; } });
  app.mount({ children: [] }); let closed = false; const close = () => { if (!closed) { closed = true; app.unmount(); } }; closes.push(close); await flush();
  return { view, props, calls, server, emissions, close };
}
function renderNodes(h: Awaited<ReturnType<typeof mount>>) {
  const descriptor = parse(readFileSync(resolve(root, 'src/components/ProductVideoUploader.vue'), 'utf8')).descriptor;
  const components = new Map(), facade = new Proxy(runtime.vue, { get: (target, key) => key === 'resolveComponent' ? (name: string) => {
    if (!components.has(name)) components.set(name, { name }); return components.get(name);
  } : target[key] });
  const render = new Function('Vue', compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true }).code)(facade);
  const context = new Proxy(h.view, { get(target, name) { return runtime.vue.unref(name in target ? target[name] : h.props[name]); },
    set(target, name, value) { if (runtime.vue.isRef(target[name])) target[name].value = value; else target[name] = value; return true; } });
  const nodes: any[] = [], collect = (value: any) => { if (!value || typeof value !== 'object') return; if (Array.isArray(value)) return value.forEach(collect);
    nodes.push(value); if (value.children && typeof value.children === 'object' && !Array.isArray(value.children)) for (const slot of Object.values(value.children)) { if (typeof slot === 'function') collect(slot()); } else collect(value.children); };
  collect(render(context, [])); return nodes;
}
function text(value: any): string { return typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.children) : ''; }
const button = (h: Awaited<ReturnType<typeof mount>>, label: string) => renderNodes(h).find(node => node.type?.name === 'el-button' && text(node.children?.default?.()).includes(label));
function choose(h: Awaited<ReturnType<typeof mount>>, value = file()) { const input = renderNodes(h).find(node => node.type === 'input' && node.props.type === 'file'); expect(input).toBeTruthy(); input.props.onChange({ target: { files: [value] } }); }
function storedPending(id = randomUUID()) { const pending = { upload_id: id, actor_id: 20 }; sessionValues.set(key(), JSON.stringify(pending)); return pending; }

it('hashes one bounded slice at a time, uses real SHA256 and stops hashing before another slice after cancellation', async () => {
  const source = file(), reads = vi.spyOn(source, 'slice'), whole = vi.spyOn(source, 'arrayBuffer').mockRejectedValue(Error('Whole-file buffering is forbidden'));
  const original = crypto.subtle.digest.bind(crypto.subtle); let active = 0, maximum = 0;
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => { active++; maximum = Math.max(maximum, active); try { return await original(algorithm, data); } finally { active--; } });
  const progress: number[] = [], result = await runtime.api.videoFileManifest(source, 16, () => true, (size: number) => progress.push(size));
  expect(result).toEqual(manifest()); expect(progress).toEqual([16, 32, 43]); expect(maximum).toBe(1); expect(digest).toHaveBeenCalledTimes(3); expect(whole).not.toHaveBeenCalled();
  expect(reads.mock.calls.every(([start, end]) => Number(end) - Number(start) <= 16)).toBe(true);
  let current = true; digest.mockClear(); await expect(runtime.api.videoFileManifest(source, 16, () => current, () => { current = false; })).rejects.toThrow('停止'); expect(digest).toHaveBeenCalledTimes(1);
});

it.each(['oversized', 'wrong-name', 'wrong-mime', 'bad-ftyp', 'too-many-parts'])('rejects %s files before hashing the complete body', async kind => {
  const value = kind === 'wrong-name' ? file(bytes(), 'owned.mov') : kind === 'wrong-mime' ? file(bytes(), 'owned.mp4', 'image/png')
    : kind === 'bad-ftyp' ? file(new Uint8Array(43)) : kind === 'too-many-parts' ? file(bytes(1212)) : file();
  if (kind === 'oversized') Object.defineProperty(value, 'size', { value: runtime.api.VIDEO_MAX_SIZE + 1 });
  const digest = vi.spyOn(crypto.subtle, 'digest'); await expect(runtime.api.videoFileManifest(value, kind === 'too-many-parts' ? 12 : 16)).rejects.toThrow(); expect(digest).not.toHaveBeenCalled();
});

it('uses only server-confirmed bytes for rendered progress while sequential requests are still pending', async () => {
  const pending = storedPending(), server = fakeServer(); server.seed(pending.upload_id);
  const first = deferred(), second = deferred(), third = deferred(), gates = [first, second, third];
  const h = await mount({ server, respond: async config => { if (config.method === 'put') await gates[Number(config.url.split('/').at(-1)) - 1].promise; } });
  choose(h); const uploading = button(h, '继续上传').props.onClick(); await until(() => parts(h.calls).length === 1);
  expect(h.view.percentage.value).toBe(0); expect(renderNodes(h).find(node => node.type?.name === 'el-progress').props.percentage).toBe(0);
  first.resolve(); await until(() => parts(h.calls).length === 2); expect(h.view.confirmedBytes.value).toBe(16); expect(h.view.percentage.value).toBe(37);
  second.resolve(); await until(() => parts(h.calls).length === 3); expect(h.view.confirmedBytes.value).toBe(32);
  third.resolve(); await uploading; expect(h.view.receipt.value.state).toBe('committed'); expect(h.view.percentage.value).toBe(100);
});

it('queries the original UUID and sends only unconfirmed parts after selecting the same file', async () => {
  const pending = storedPending(), server = fakeServer(); server.seed(pending.upload_id, manifest(), [1, 3]); const h = await mount({ server });
  await button(h, '查询上传结果').props.onClick(); choose(h); await button(h, '继续上传').props.onClick();
  expect(parts(h.calls)).toEqual([2]); expect(h.calls.every(call => call.url.includes(pending.upload_id))).toBe(true);
  expect(h.calls[0].method).toBe('get'); expect(h.view.receipt.value.result.url).toBe('/api/assets/301');
});

it('queries a discarded committed complete response without a new initialize part or complete request', async () => {
  let dropped = false; const h = await mount({ respond: (config, server) => { if (config.url.endsWith('/complete') && !dropped) { dropped = true; server.respond(config); throw Error('Owned committed response lost'); } } });
  choose(h); await button(h, '开始上传').props.onClick(); const operation = { ...h.view.pending.value }, before = mutations(h.calls).length;
  expect(h.view.error.value).toContain('尚未确认'); expect(h.view.receipt.value.state).toBe('active'); await button(h, '查询上传结果').props.onClick();
  expect(h.view.receipt.value.state).toBe('committed'); expect(h.view.pending.value).toEqual(operation); expect(mutations(h.calls)).toHaveLength(before);
  expect(h.calls.filter(call => call.url.endsWith('/complete'))).toHaveLength(1);
});

it('stores only two identity fields and emits a stable reference only after the explicit use button', async () => {
  const h = await mount(); choose(h); await button(h, '开始上传').props.onClick();
  const record = JSON.parse(sessionValues.get(key())!); expect(Object.keys(record).sort()).toEqual(['actor_id', 'upload_id']); expect(record).toEqual({ upload_id: h.view.pending.value.upload_id, actor_id: 20 });
  expect([...sessionValues.values(), ...storage.values()].join('')).not.toContain('owned.mp4'); expect([...sessionValues.values(), ...storage.values()].join('')).not.toContain('temporary-video-preview');
  expect(h.emissions.filter(event => event[0] === 'use')).toEqual([]); expect(renderNodes(h).find(node => node.type === 'video').props.src).toContain('signature=');
  button(h, '使用这个视频').props.onClick(); const emitted = h.emissions.find(event => event[0] === 'use')![1] as any;
  expect(emitted.url).toBe('/api/assets/301'); expect(emitted.url).not.toContain('?'); expect(emitted.src).toContain('signature=');
  expect(h.emissions).toContainEqual(['update:open', false]);
  const initialized = h.calls.find(call => call.method === 'post' && !call.url.endsWith('/complete')); expect(JSON.stringify(body(initialized))).not.toContain('signature=');
});

it.each(['write', 'read', 'parse'])('does not mutate when recovery storage %s fails', async mode => {
  if (mode === 'read') sessionStore.getItem.mockImplementation(() => { throw Error('Owned storage read failure'); });
  if (mode === 'parse') sessionValues.set(key(), JSON.stringify({ upload_id: randomUUID(), actor_id: 20, body: 'must not overwrite an invalid recovery record' }));
  const h = await mount(); if (mode === 'write') sessionStore.setItem.mockImplementation(() => { throw Error('Owned storage write failure'); });
  if (mode === 'write') choose(h); else expect(h.view.canUpload.value).toBe(false);
  await h.view.upload(false); expect(mutations(h.calls)).toEqual([]); expect(h.view.error.value).toContain(mode === 'parse' ? '恢复记录无效' : 'storage');
});

it('aborts the current transfer before writing a cancellation tombstone for its original UUID', async () => {
  const wait = deferred(); let activeSignal: AbortSignal | undefined;
  const h = await mount({ respond: async config => { if (config.method === 'put') { activeSignal = config.signal; await wait.promise; }
    if (config.url.endsWith('/cancel')) expect(activeSignal?.aborted).toBe(true); } });
  choose(h); const uploading = button(h, '开始上传').props.onClick(); await until(() => !!activeSignal); const original = h.view.pending.value.upload_id;
  await button(h, '取消本次上传').props.onClick(); wait.resolve(); await uploading;
  expect(h.view.receipt.value.state).toBe('cancelled'); expect(h.calls.filter(call => call.url.endsWith('/complete'))).toEqual([]);
  expect(h.calls.find(call => call.url.endsWith('/cancel')).url).toContain(original); expect(JSON.parse(sessionValues.get(key())!).upload_id).toBe(original);
  expect(h.emissions.filter(event => event[0] === 'use')).toEqual([]);
});

it.each(['account', 'route', 'context', 'unmount'])('ignores a late committed response after %s changes', async mode => {
  const wait = deferred(); let completing = false;
  const h = await mount({ respond: async (config, server) => { if (config.url.endsWith('/complete')) { completing = true; const value = server.respond(config); await wait.promise; return value; } } });
  choose(h); const uploading = button(h, '开始上传').props.onClick(); await until(() => completing); const original = h.view.pending.value.upload_id;
  if (mode === 'account') { login(21); browser.dispatchEvent(new Event('admin-session-changed')); }
  else if (mode === 'unmount') h.close();
  else { if (mode === 'route') (browser as any).location.pathname = '/product/edit/20'; h.props.contextKey = mode === 'route' ? 'product:20:ordinary' : 'product:19:copy:22'; await flush(); }
  wait.resolve(); await uploading; expect(h.emissions.filter(event => event[0] === 'use')).toEqual([]); expect(h.view.previewSrc.value).toBe('');
  if (mode !== 'unmount') expect(h.view.receipt.value?.state).not.toBe('committed');
  expect(JSON.parse(sessionValues.get(key())!).upload_id).toBe(original); expect(sessionValues.has(key(21))).toBe(false);
});

it('explicitly retransmits all original parts to repair damaged R2 bytes instead of skipping previously confirmed parts', async () => {
  const pending = storedPending(), server = fakeServer(); server.seed(pending.upload_id, manifest(), [1, 2, 3]); const h = await mount({ server });
  await h.view.query(); choose(h); await button(h, '重新传输原文件分片').props.onClick(); expect(parts(h.calls)).toEqual([1, 2, 3]); expect(h.view.receipt.value.state).toBe('committed');
});

it('refuses a different original file before reinitializing the persisted upload ID', async () => {
  const pending = storedPending(), server = fakeServer(); server.seed(pending.upload_id, manifest(), [1]); const h = await mount({ server });
  const changed = bytes(); changed[20] ^= 1; choose(h, file(changed)); await h.view.upload(false);
  expect(h.view.error.value).toContain('同一文件'); expect(mutations(h.calls)).toEqual([]); expect(h.view.pending.value.upload_id).toBe(pending.upload_id);
});

it('keeps owned query and cancellation usable without upload permission while preventing use in a disabled editor', async () => {
  const pending = storedPending(), server = fakeServer(); server.seed(pending.upload_id); const h = await mount({ server, permissions: ['product.manage'], disabled: true });
  expect(h.view.canUpload.value).toBe(false); await h.view.query(); expect(h.view.receipt.value.state).toBe('active'); await h.view.cancel(); expect(h.view.receipt.value.state).toBe('cancelled');
  expect(mutations(h.calls).map(call => call.url.split('/').at(-1))).toEqual(['cancel']);
  server.seed(pending.upload_id, manifest(), [1, 2, 3], 'committed'); await h.view.query(); h.view.apply(); expect(h.emissions.filter(event => event[0] === 'use')).toEqual([]);
});

it('rejects mismatched operation identities and malformed nine-field manifests from actual Axios responses', async () => {
  const pending = storedPending(), server = fakeServer(), row = server.seed(pending.upload_id), h = await mount({ server });
  expect(Object.keys(row.manifest)).toHaveLength(9);
  for (const patch of [{ actor_id: 21 }, { upload_id: randomUUID() }, { confirmed: [1, 1] }, { confirmed: [4] },
    { manifest: { ...row.manifest, total_chunks: 9 } }, { manifest: { ...row.manifest, mode: 'legacy', client_md5: 'a'.repeat(32) } }]) {
    const changed = { ...structuredClone(row), ...patch }; h.server.records.set(pending.upload_id, changed);
    await expect(runtime.api.apiVideoQuery(pending)).rejects.toThrow();
  }
});
