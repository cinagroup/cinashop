import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/supplier-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, preview: any, pinia: any, windowSurface: EventTarget;
beforeAll(async () => {
  const bundle = async (previewMode: boolean) => build({ absWorkingDir: root,
    stdin: { resolveDir: root, contents: previewMode ? `export * from './src/api/supplier';` : `
      export { default as Products } from './src/pages/Products.vue';
      export * as api from './src/api/supplier'; export { http } from './src/api/http';
      export * as dialog from 'element-plus'; export { createPinia, disposePinia } from 'pinia';
      export { createRenderer, h, nextTick } from 'vue';
      export { createRouter, createMemoryHistory, RouterView } from 'vue-router';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': String(previewMode),
      'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"', '__VUE_OPTIONS_API__': 'true',
      '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-category-sfc', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'supplier-category-regression', compilerOptions: { expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw new Error(String(template.errors));
        return { contents: compileScript(descriptor, { id: 'supplier-category-regression' }).content, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[],confirmations=[];
        export const ElMessage={success:m=>messages.push(m),warning:m=>messages.push(m),error:m=>messages.push(m)};
        export const ElMessageBox={confirm:async (...args)=>{confirmations.push(args)}};` }));
      builder.onResolve({ filter: /^@element-plus\/icons-vue$/ }, () => ({ path: 'icons', namespace: 'fixture-icons' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture-icons' }, () => ({ contents: 'export const Box={},Delete={},Edit={},Plus={},Search={},Setting={},WarningFilled={};' }));
    } }] });
  const actual = await bundle(false);
  runtime = await import(`data:text/javascript;base64,${Buffer.from(actual.outputFiles[0].text).toString('base64')}`);
  const simulated = await bundle(true);
  vi.stubGlobal('window', { location: { search: '?preview=1' } });
  preview = await import(`data:text/javascript;base64,${Buffer.from(simulated.outputFiles[0].text).toString('base64')}`);
  vi.unstubAllGlobals();
}, 60_000);
beforeEach(() => {
  const storage = new Map<string, string>(); windowSurface = new EventTarget();
  vi.stubGlobal('window', windowSurface);
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  localStorage.setItem('supplier-token', 'fixture-a'); localStorage.setItem('supplier-user', '{"id":99,"supplier_id":20}');
  localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
  pinia = runtime.createPinia(); runtime.dialog.messages.length = 0; runtime.dialog.confirmations.length = 0;
  runtime.dialog.ElMessageBox.confirm = async (...args: any[]) => { runtime.dialog.confirmations.push(args); };
});
afterEach(() => { runtime.disposePinia(pinia); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const node = (id: number, pid = 0, level = 0, children: any[] = []) => ({ id, pid, level, children,
  cate_name: `分类${id}`, path: pid ? String(pid) : '', pic: '/public/category.png', big_pic: 'https://images.example/big.png',
  sort: 10, is_show: 1, add_time: 100, revision: 'revision-a' });
const tree = () => [node(1, 0, 0, [node(2, 1, 1, [node(3, 2, 2)])]), node(4), node(5, 0, 0, [node(6, 5, 1)])];
function flatten(items: any[]): any[] { return items.flatMap(item => [item, ...flatten(item.children)]); }
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise<any>(r => resolve = r), resolve }; };
async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); await runtime.nextTick(); } }
async function mount(override: (config: any) => unknown = () => undefined) {
  const calls: any[] = []; let view: any;
  runtime.http.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config);
    const detail = /^\/product\/category\/([0-9]+)\/detail$/.exec(config.url);
    const data = custom !== undefined ? custom : config.url === '/product/category/tree' ? tree()
      : detail ? flatten(tree()).find(item => item.id === Number(detail[1]))
      : config.url === '/product/product' ? { list: [], count: 0 } : config.method === 'post' ? { id: 7 } : null;
    return { config, data: { status: 200, msg: 'fixture', data }, status: 200, statusText: 'fixture', headers: {} };
  };
  const wrapper = { setup(props: any, context: any) { view = runtime.Products.setup(props, context); return () => null; } };
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products', component: wrapper }, { path: '/elsewhere', component: { render: () => null } }] });
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }), createComment: (text: string) => ({ text }),
    insert(n: any, p: any) { n.parent = p; (p.children ??= []).push(n); }, remove() {}, parentNode: (n: any) => n.parent,
    nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) }); app.use(pinia); app.use(router);
  await router.push('/products'); app.mount({ children: [] }); await flush();
  return { view, calls, router, close: () => app.unmount() };
}
const writes = (f: any) => f.calls.filter((config: any) => ['post', 'put', 'delete'].includes(config.method));
async function createDraft(f: any) { await f.view.openCategories(); await f.view.editCategory(); f.view.categoryForm.cate_name = '新增分类'; }

describe('actual mounted Supplier Products category setup and HTTP contracts', () => {
  it('reads the modern tree and loads fresh detail with both image fields and CAS revision', async () => {
    const f = await mount(); try {
      await f.view.openCategories(); await f.view.editCategory(f.view.categories.value[1]);
      expect(f.calls.map(c => c.url)).toContain('/product/category/tree'); expect(f.calls.map(c => c.url)).toContain('/product/category/4/detail');
      expect(f.view.categoryForm).toMatchObject({ id: 4, pic: '/public/category.png', big_pic: 'https://images.example/big.png', expected_revision: 'revision-a' });
      expect(f.view.categoryPreview(f.view.categoryForm.pic)).toBe('/public/category.png');
    } finally { f.close(); }
  });
  it('excludes self, descendants and parents that would make the subtree exceed three levels', async () => {
    const f = await mount(); try {
      await f.view.openCategories(); await f.view.editCategory(f.view.categories.value[0]);
      expect(f.view.categoryParentOptions.value.map((row: any) => row.id)).toEqual([]);
      f.view.categoryForm.pid = 2; await f.view.submitCategory(); expect(writes(f)).toEqual([]);
      await f.view.editCategory(f.view.flatCategories.value.find((row: any) => row.id === 2));
      expect(f.view.categoryParentOptions.value.map((row: any) => row.id)).toEqual([1, 4, 5]);
    } finally { f.close(); }
  });
  it('saves complete image fields and revision once, then reloads fresh tree', async () => {
    const wait = gate(), f = await mount(c => c.method === 'put' ? wait.promise : undefined);
    try {
      await f.view.openCategories(); await f.view.editCategory(f.view.categories.value[1]); f.view.categoryForm.cate_name = '修改名称';
      const action = f.view.submitCategory(); await flush(); await f.view.submitCategory(); expect(writes(f)).toHaveLength(1);
      expect(JSON.parse(writes(f)[0].data)).toEqual({ pid: 0, cate_name: '修改名称', pic: '/public/category.png', big_pic: 'https://images.example/big.png', sort: 10, is_show: 1, expected_revision: 'revision-a' });
      wait.resolve({ id: 4 }); await action; expect(f.view.categoryFormVisible.value).toBe(false);
      expect(f.calls.filter(c => c.url === '/product/category/tree')).toHaveLength(2); expect(f.view.categoryFresh.value).toBe(true);
    } finally { wait.resolve({ id: 4 }); f.close(); }
  });
  it('creates a child at the selected parent and excludes id/revision from the create body', async () => {
    const f = await mount(); try {
      await f.view.openCategories(); await f.view.editCategory(undefined, 2); f.view.categoryForm.cate_name = '新末级'; await f.view.submitCategory();
      expect(writes(f)[0].url).toBe('/product/category'); expect(JSON.parse(writes(f)[0].data)).toEqual({ pid: 2, cate_name: '新末级', pic: '', big_pic: '', sort: 0, is_show: 1 });
    } finally { f.close(); }
  });
  it('rejects long names, duplicate siblings, invalid sort and unsafe image URLs before dispatch', async () => {
    const f = await mount(); try {
      await createDraft(f);
      for (const patch of [{ cate_name: '长'.repeat(31) }, { cate_name: '分类4' }, { cate_name: '可用名', sort: 1.5 },
        { sort: 1, pic: 'javascript:alert(1)' }, { pic: '/api/assets/7?expires=1&signature=old' }, { pic: '', big_pic: 'https://user:pw@images.example/a.png' },
        { big_pic: 'https://images.example/' + 'x'.repeat(256) }]) {
        Object.assign(f.view.categoryForm, patch); await f.view.submitCategory();
      }
      expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('keeps a failed save draft and blocks repeat writes until an explicit fresh reload', async () => {
    const f = await mount(c => { if (c.method === 'post') throw new Error('fixture unknown response'); });
    try {
      await createDraft(f); f.view.categoryForm.pic = '/draft.png'; await f.view.submitCategory(); await f.view.submitCategory();
      expect(writes(f)).toHaveLength(1); expect(f.view.categoryFormVisible.value).toBe(true);
      expect(f.view.categoryForm.cate_name).toBe('新增分类'); expect(f.view.categoryForm.pic).toBe('/draft.png'); expect(f.view.categoryFresh.value).toBe(false);
      await f.view.loadCategories(); expect(f.view.categoryForm.pic).toBe('/draft.png'); expect(f.view.categoryFresh.value).toBe(true);
    } finally { f.close(); }
  });
  it('leaves tree and draft intact when refreshing fails and exposes retry state', async () => {
    let reads = 0; const f = await mount(c => { if (c.url === '/product/category/tree' && ++reads > 1) throw new Error('fixture read failed'); });
    try {
      await createDraft(f); await f.view.loadCategories(); expect(f.view.categories.value).toHaveLength(3);
      expect(f.view.categoryForm.cate_name).toBe('新增分类'); expect(f.view.categoryFresh.value).toBe(false); expect(f.view.categoryError.value).toContain('read failed');
    } finally { f.close(); }
  });
  it('allows view-only tree reads while all category write handlers refuse direct invocation', async () => {
    localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount();
    try {
      await f.view.openCategories(); expect(f.view.categories.value).toHaveLength(3); expect(f.view.canManageCategories.value).toBe(false);
      await f.view.editCategory(f.view.categories.value[1]); f.view.categoryFormVisible.value = true; f.view.categoryForm.cate_name = '非法草稿';
      await f.view.submitCategory(); await f.view.removeCategory(f.view.categories.value[1]); await f.view.toggleCategoryShow(f.view.categories.value[1]);
      expect(writes(f)).toEqual([]); expect(runtime.dialog.confirmations).toEqual([]);
    } finally { f.close(); }
  });
  it('warns that a status change includes every descendant and sends revision in the PUT body', async () => {
    const f = await mount(); try {
      await f.view.openCategories(); await f.view.toggleCategoryShow(f.view.categories.value[0]);
      expect(runtime.dialog.confirmations[0][0]).toContain('全部子级');
      expect(writes(f)[0].url).toBe('/product/category/set_show/1/0'); expect(JSON.parse(writes(f)[0].data)).toEqual({ expected_revision: 'revision-a' });
      expect(f.calls.filter(c => c.url === '/product/category/tree')).toHaveLength(2);
    } finally { f.close(); }
  });
  it('refuses non-leaf deletion and sends leaf DELETE revision without mutating the local tree optimistically', async () => {
    const wait = gate(), f = await mount(c => c.method === 'delete' ? wait.promise : undefined);
    try {
      await f.view.openCategories(); await f.view.removeCategory(f.view.categories.value[0]); expect(writes(f)).toEqual([]);
      const action = f.view.removeCategory(f.view.categories.value[1]); await flush();
      expect(writes(f)[0].url).toBe('/product/category/4'); expect(JSON.parse(writes(f)[0].data)).toEqual({ expected_revision: 'revision-a' });
      expect(f.view.categories.value).toHaveLength(3); wait.resolve(null); await action;
    } finally { wait.resolve(null); f.close(); }
  });
  it('requires a revision for existing-row mutation and rejects enabling under a disabled parent', async () => {
    const f = await mount(); try {
      await f.view.openCategories(); f.view.categories.value[1].revision = undefined; await f.view.removeCategory(f.view.categories.value[1]);
      f.view.categories.value[0].is_show = 0; f.view.categories.value[0].children[0].is_show = 0;
      await f.view.toggleCategoryShow(f.view.categories.value[0].children[0]); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
  });
  it('never dispatches a delayed confirmation after a URL change', async () => {
    const prompt = gate(), f = await mount(); runtime.dialog.ElMessageBox.confirm = () => prompt.promise;
    try {
      await f.view.openCategories(); const action = f.view.removeCategory(f.view.categories.value[1]);
      await f.router.push('/products?scope=changed'); await flush(); prompt.resolve(undefined); await action;
      expect(writes(f)).toEqual([]); expect(f.view.categories.value).toEqual([]); expect(f.view.categoryVisible.value).toBe(false);
    } finally { prompt.resolve(undefined); f.close(); }
  });
  it('ignores a late tree read after logout or permission ABA without restoring private data', async () => {
    const wait = gate(), f = await mount(c => c.url === '/product/category/tree' ? wait.promise : undefined);
    try {
      const action = f.view.openCategories(); await flush();
      localStorage.setItem('supplier-permissions', '[]'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
      localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
      wait.resolve(tree()); await action; expect(f.view.categories.value).toEqual([]); expect(f.view.categoryInvalidated.value).toBe(true);
      await f.view.openCategories(); expect(f.calls.filter(c => c.url === '/product/category/tree')).toHaveLength(1);
    } finally { wait.resolve(tree()); f.close(); }
  });
  it('ignores late edit detail after the form is closed and a new create dialog opens', async () => {
    const wait = gate(), f = await mount(c => c.url === '/product/category/4/detail' ? wait.promise : undefined);
    try {
      await f.view.openCategories(); const action = f.view.editCategory(f.view.categories.value[1]); await flush();
      f.view.categoryFormVisible.value = false; await f.view.editCategory(undefined, 1); f.view.categoryForm.cate_name = '新草稿';
      wait.resolve(node(4)); await action; expect(f.view.categoryForm).toMatchObject({ id: 0, pid: 1, cate_name: '新草稿' });
    } finally { wait.resolve(node(4)); f.close(); }
  });
  it('clears form images on session change and ignores a late save receipt', async () => {
    const wait = gate(), f = await mount(c => c.method === 'post' ? wait.promise : undefined);
    try {
      await createDraft(f); f.view.categoryForm.pic = '/private-draft.png'; const action = f.view.submitCategory(); await flush();
      localStorage.removeItem('supplier-token'); windowSurface.dispatchEvent(new Event('supplier-session-changed'));
      wait.resolve({ id: 7 }); await action; expect(f.view.categoryForm.cate_name).toBe(''); expect(f.view.categoryForm.pic).toBe('');
      expect(f.view.categories.value).toEqual([]); expect(runtime.dialog.messages).not.toContain('分类已创建');
    } finally { wait.resolve({ id: 7 }); f.close(); }
  });
  it('renders public images safely and marks actual failures unavailable', async () => {
    const f = await mount(); try {
      await createDraft(f); expect(f.view.categoryPreview('https://images.example/a.png?x=1&y=2')).toBe('https://images.example/a.png?x=1&y=2');
      for (const src of ['javascript:alert(1)', '//images.example/a.png', '/api/assets/7', '/old/../api/assets/7', '/kefuapi/assets/7?ticket=old']) expect(f.view.categoryPreview(src)).toBeNull();
      f.view.categoryImageFailed({ currentTarget: { getAttribute: () => '/public/category.png' } }); expect(f.view.categoryPreview('/public/category.png')).toBeNull();
    } finally { f.close(); }
  });
});

describe('preview category simulation (does not validate database references)', () => {
  const payload = (cate_name: string, pid = 0, patch: any = {}) => ({ cate_name, pid, pic: '/public.png', big_pic: 'https://images.example/big.png', sort: 0, is_show: 1, ...patch });
  it('creates, edits, moves and deletes nested categories while preserving paths, levels, images and fresh revisions', async () => {
    const a = (await preview.saveProductCategory(0, payload('预览根A'))).id;
    const b = (await preview.saveProductCategory(0, payload('预览根B'))).id;
    const child = (await preview.saveProductCategory(0, payload('预览子级', a))).id;
    const grandchild = (await preview.saveProductCategory(0, payload('预览末级', child))).id;
    let row = await preview.getProductCategoryDetail(child);
    await preview.saveProductCategory(child, payload('移动子级', b, { pic: '/moved.png', expected_revision: row.revision }));
    row = await preview.getProductCategoryDetail(grandchild); expect(row).toMatchObject({ pid: child, path: `${b},${child}`, level: 2 });
    expect(await preview.getProductCategoryDetail(child)).toMatchObject({ pid: b, path: String(b), level: 1, pic: '/moved.png', big_pic: 'https://images.example/big.png' });
    await expect(preview.deleteProductCategory(child, row.revision)).rejects.toThrow('下级');
    await preview.setProductCategoryShow(b, 0, row.revision);
    expect(flatten(await preview.getProductCategories()).filter(item => [b, child, grandchild].includes(item.id)).map(item => item.is_show)).toEqual([0, 0, 0]);
    row = await preview.getProductCategoryDetail(grandchild); await expect(preview.setProductCategoryShow(grandchild, 1, row.revision)).rejects.toThrow('父级');
    for (const id of [grandchild, child, a, b]) { row = await preview.getProductCategoryDetail(id); await preview.deleteProductCategory(id, row.revision); }
    expect(flatten(await preview.getProductCategories()).some(item => [a, b, child, grandchild].includes(item.id))).toBe(false);
  });
  it('rejects cycles, duplicate siblings, overflow depth, stale revisions, unsafe URLs and known sample product references', async () => {
    const a = (await preview.saveProductCategory(0, payload('约束根'))).id;
    const stale = await preview.getProductCategoryDetail(a);
    const child = (await preview.saveProductCategory(0, payload('约束子', a))).id;
    const grandchild = (await preview.saveProductCategory(0, payload('约束末', child))).id;
    await expect(preview.saveProductCategory(a, payload('约束根', 0, { expected_revision: stale.revision }))).rejects.toThrow('修改');
    const row = await preview.getProductCategoryDetail(a);
    await expect(preview.saveProductCategory(a, payload('约束根', grandchild, { expected_revision: row.revision }))).rejects.toThrow('自身');
    await expect(preview.saveProductCategory(0, payload('约束子', a))).rejects.toThrow('重复');
    await expect(preview.saveProductCategory(0, payload('第四级', grandchild))).rejects.toThrow('三级');
    await expect(preview.saveProductCategory(0, payload('危险图片', 0, { pic: '/api/assets/7?ticket=old' }))).rejects.toThrow('图片地址');
    const referenced = await preview.getProductCategoryDetail(12); await expect(preview.deleteProductCategory(12, referenced.revision)).rejects.toThrow('示例商品');
    for (const id of [grandchild, child, a]) { const current = await preview.getProductCategoryDetail(id); await preview.deleteProductCategory(id, current.revision); }
  });
});
