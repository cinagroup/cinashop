import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget, ownedDocument: any;
beforeAll(async () => {
    const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/ProductForm.vue';import Wrapper from './src/components/SupplierProductRuleCreate.vue';
    export {Form};export const captured={};for(const [key,component] of [['view',Form],['integration',Wrapper]]){const original=component.setup;component.setup=(p,c)=>{const value=original(p,c);captured[key]=value;return value;};}
    export {http,ApiError} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as dialogs from 'element-plus';
export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
        alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
            '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
        bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
                    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
                        if (path.includes('/components/') && !['SupplierProductRuleCreate.vue', 'SupplierProductRuleEditor.vue'].some(name => path.endsWith(name)))
                            return { contents: 'export default {render:()=>null}', loader: 'ts' };
                        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
                        const script = compileScript(descriptor, { id: 'owned-copy-editor', genDefaultAs: '__Page' });
                        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'owned-copy-editor',
                            compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
                        if (template.errors.length)
                            throw Error(String(template.errors));
                        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
                    });
                    builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialog', namespace: 'fixture' }));
                    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const messages=[];
        export const ElMessage={success:m=>messages.push(m),error:m=>messages.push(m),warning:m=>messages.push(m)};
        export const ElMessageBox={confirm:async()=>{},close:()=>{},prompt:async()=>({value:'owned'})};` }));
                } }] });
    runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
    const local = new Map<string, string>(), session = new Map<string, string>();
    surface = new EventTarget();
    vi.stubGlobal('window', surface);
    class OwnedDocument {
        activeElement = null;
    }
    ;
    class OwnedShadowRoot {
    }
    ;
    vi.stubGlobal('Document', OwnedDocument);
    vi.stubGlobal('ShadowRoot', OwnedShadowRoot);
    ownedDocument = new OwnedDocument();
    vi.stubGlobal('document', ownedDocument);
    const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k) });
    vi.stubGlobal('localStorage', storage(local));
    vi.stubGlobal('sessionStorage', storage(session));
    vi.stubGlobal('navigator', { locks: { request: async (_name: any, _options: any, work: any) => work({ name: 'owned-shipping-lock' }) } });
    localStorage.setItem('supplier-token', 'owned-copy-a');
    localStorage.setItem('supplier-user', '{"id":21,"supplier_id":20}');
    localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]');
    pinia = runtime.createPinia();
    runtime.dialogs.messages.length = 0;
    runtime.dialogs.ElMessageBox.confirm = async () => { };
    runtime.captured.integration = undefined;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sku = (card = false) => ({ suk: '默认', detail: { 规格: '默认' }, image: '', price: '12.00', settle_price: '6.00', cost: '3.00',
    ot_price: '14.00', vip_price: '11.00', stock: card ? 0 : 8, bar_code: '', weight: '1.00', volume: '1.00', brokerage: '0.00', brokerage_two: '0.00', code: 'SOURCE', disk_info: '' });
const seed = (id = 80, type = 0) => ({ copy: { source_id: id, token: 'a'.repeat(64), destination: { type: 2, relation_id: 20 } }, product: {
        id: 0, product_type: type, store_name: '来源商品', store_info: '来源简介', keyword: '关键词', unit_name: '件', bar_code: '', cate_id: [1],
        slider_image: ['https://images.invalid/source.png'], description: '<p>来源说明</p>', spec_type: 1, items: ruleSpec(), attrs: ['红,S', '红,M', '蓝,S', '蓝,M'].map((suk, i) => ({ ...sku(type === 1), id: 8001 + i, unique: 'inline_sku_' + i, suk, detail: { 颜色: suk.split(',')[0], 尺码: suk.split(',')[1] }, stock: 8 + i })),
        retired_attrs: [], freight: 3, postage: '0.00', temp_id: 201, is_postage: 1, is_support_refund: 1, is_limit: 0, limit_type: 0, limit_num: 0,
        brand_id: [1, 2], brand_selection: { brand_id: 2, brand_com: '1,2', consistent: true, available: true }, sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
    } });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() {
    for (let i = 0; i < 40; i++) {
        await Promise.resolve();
        await runtime.nextTick();
    }
}
type Node = {
    tag?: string;
    text?: string;
    children: Node[];
    props: Record<string, any>;
    parent?: Node;
};
async function mount(url = '/products/80/edit', override: (config: any, fixture: any) => unknown = () => undefined) {
    const calls: any[] = [], fixture = { catalog: ruleCatalog(), apply(config: any) {
            const body = JSON.parse(config.data), id = Number(config.url.split('/').at(-1)) || 400;
            expect(body.expected_revision).toBe(fixture.catalog.revision);
            const saved = ruleRow(id, body.rule_name, body.spec, 'd');
            fixture.catalog.list.push(saved);
            fixture.catalog.count++;
            fixture.catalog.revision = 'b'.repeat(64);
            return { id, revision: saved.revision };
        } };
    runtime.http.defaults.adapter = async (config: any) => {
        calls.push(config);
        let value = await override(config, fixture);
        if (value === undefined) {
            if (config.url === '/product/category/tree')
                value = [{ id: 1, cate_name: '本机分类' }];
            else if (config.url === '/product/product/get_rule')
                value = fixture.catalog.list.map((r: any) => ({ ...clone(r), rule_value: clone(r.spec) }));
            else if (config.url === '/product/product/rule')
                value = { ...clone(fixture.catalog), page: config.params?.page ?? 0, limit: config.params?.limit ?? 0 };
            else if (config.url === '/product/product/rule/0' && config.method === 'post')
                value = fixture.apply(config);
            else if (config.url.startsWith('/product/product/copy/'))
                value = { ...seed(80), product: { ...seed(80).product, attrs: seed(80).product.attrs.map(({ id, unique, ...row }) => row) } };
            else if (/^\/product\/product\/\d+$/.test(config.url))
                value = config.method === 'post' ? { id: Number(config.url.split('/').at(-1)), is_verify: 0, is_show: 0 } : { ...seed().product, id: Number(config.url.split('/').at(-1)), store_name: '原商品' + config.url.split('/').at(-1), auto_on_time: 0, auto_off_time: 0 };
            else
                throw Error('Unexpected actual inline rule endpoint ' + config.method + ' ' + config.url);
        }
        return { config, data: { status: 200, msg: 'owned inline rule transport', data: value }, status: 200, statusText: 'owned', headers: {} };
    };
    const host: Node = { children: [], props: {} };
    const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, tagName: tag.toUpperCase(), children: [], props: {}, value: '', listeners: {}, addEventListener(name: string, fn: any) { (this.listeners as any)[name] ??= []; (this.listeners as any)[name].push(fn); }, removeEventListener() { }, getRootNode() { return ownedDocument; } }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
        insert(n: Node, p: Node, anchor?: Node) {
            if (n.parent)
                n.parent.children = n.parent.children.filter(item => item !== n);
            n.parent = p;
            const at = anchor ? p.children.indexOf(anchor) : -1;
            p.children.splice(at < 0 ? p.children.length : at, 0, n);
        },
        remove(n: Node) {
            if (n.parent)
                n.parent.children = n.parent.children.filter(item => item !== n);
        }, parentNode: (n: Node) => n.parent,
        nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, k: string, _: unknown, v: unknown) { n.props[k] = v; },
        setText(n: Node, v: string) { n.text = v; }, setElementText(n: Node, v: string) { n.text = v; n.children = []; } });
    const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products/new', component: runtime.Form },
            { path: '/products/:id/edit', component: runtime.Form }, { path: '/products/copy-result', component: runtime.Form },
            { path: '/products', component: { render: () => null } }] });
    const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) });
    app.use(pinia);
    app.use(router);
    const tags = [...['pages/ProductForm', 'components/SupplierProductRuleCreate', 'components/SupplierProductRuleEditor'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
    for (const name of new Set(tags))
        if (!['el-table', 'el-table-column'].includes(name))
            app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
    app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
    app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
    app.directive('loading', {});
    await router.push(url);
    app.mount(host);
    await flush();
    return { get integration() { return runtime.captured.integration; }, get editor() { return runtime.captured.integration.editor; }, view: runtime.captured.view, calls, fixture, host, router, close: () => app.unmount() };
}
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const ruleSpec = () => [{ value: '颜色', detail: ['红', '蓝'] }, { value: '尺码', detail: ['S', 'M'] }];
const createdSpec = () => [{ value: '颜色', detail: ['橙', '紫'] }, { value: '尺码', detail: ['S', 'M'] }];
const ruleRow = (id = 201, name = '原规格模板', spec = ruleSpec(), revision = 'c') => ({ id, type: 2, relation_id: 20, rule_name: name, rule_value: JSON.stringify(spec), attr_name: spec.map(r => r.value).join(','), attr_value: spec.map(r => r.detail.join(',')), spec, revision: revision.repeat(64) });
const ruleCatalog = () => ({ count: 1, page: 0, limit: 0, revision: 'a'.repeat(64), list: [ruleRow()] });
const templateWrites = (f: any) => f.calls.filter((c: any) => c.method === 'post' && c.url === '/product/product/rule/0');
const productWrites = (f: any) => f.calls.filter((c: any) => c.method === 'post' && /^\/product\/product\/\d+$/.test(c.url));
function dirty(f: any) { f.view.form.store_name = '未保存规格商品'; f.view.form.unit_name = '袋'; f.view.form.keyword = '原商品关键词'; f.view.form.description = '<p>未保存说明及图片</p>'; f.view.form.attrs[0].price = '23.45'; f.view.form.attrs[0].image = 'https://images.invalid/dirty.png'; f.view.selectedRuleId.value = 201; return clone(f.view.form); }
function assertDraft(f: any, before: any) { expect(clone(f.view.form)).toEqual(before); expect(productWrites(f)).toEqual([]); }
async function create(f: any, name = '商品内新增规格', spec = createdSpec()) { await f.integration.openCreate(); await flush(); Object.assign(f.editor.form, { rule_name: name, spec }); await f.editor.submit(); await flush(); }
describe('actual ProductForm inline specification creator and explicit staged application', () => {
    it('opens and cancels the complete creator while preserving product values selected template and exact priced SKU objects', async () => { const f = await mount(); try {
        const before = dirty(f), skus = [...f.view.form.attrs];
        await f.integration.openCreate();
        expect(f.editor.editing.value).toBe(true);
        expect(f.editor.createIds.value).toEqual([201]);
        f.editor.closeEditor();
        await flush();
        assertDraft(f, before);
        expect(f.view.selectedRuleId.value).toBe(201);
        skus.forEach((s, i) => expect(f.view.form.attrs[i]).toBe(s));
        expect(templateWrites(f)).toEqual([]);
        expect(f.router.currentRoute.value.path).toBe('/products/80/edit');
    }
    finally {
        f.close();
    } });
    it('creates against the complete owner catalog revision and refreshes only the directory after exact stored ID and revision verification', async () => { const f = await mount(); try {
        const before = dirty(f), sku = f.view.form.attrs[0];
        await create(f);
        expect(templateWrites(f)).toHaveLength(1);
        expect(JSON.parse(templateWrites(f)[0].data)).toEqual({ rule_name: '商品内新增规格', spec: createdSpec(), expected_revision: 'a'.repeat(64) });
        expect(f.editor.attempt.value).toBeNull();
        expect(f.editor.editing.value).toBe(false);
        expect(f.view.ruleTemplates.value.map((r: any) => r.id)).toEqual([201, 400]);
        expect(f.view.selectedRuleId.value).toBe(201);
        assertDraft(f, before);
        expect(f.view.form.attrs[0]).toBe(sku);
        expect(f.integration.notice.value).toContain('明确选择');
    }
    finally {
        f.close();
    } });
    it('changes no SKU on explicit selection or cancelled apply and stages four new SKU candidates only after confirmation', async () => { const f = await mount(); try {
        const before = dirty(f);
        await create(f);
        f.view.selectedRuleId.value = 400;
        assertDraft(f, before);
        runtime.dialogs.ElMessageBox.confirm = async () => { throw 'cancel'; };
        await f.view.applyProductRule();
        assertDraft(f, before);
        runtime.dialogs.ElMessageBox.confirm = async () => { };
        await f.view.applyProductRule();
        expect(f.view.form.items).toEqual(createdSpec());
        expect(f.view.form.attrs.map((r: any) => r.suk)).toEqual(['橙,S', '橙,M', '紫,S', '紫,M']);
        expect(f.view.form.attrs.every((r: any) => !r.id && !r.unique && r.price === '0.00' && r.stock === 0)).toBe(true);
        expect({ ...clone(f.view.form), items: before.items, attrs: before.attrs }).toEqual(before);
        expect(productWrites(f)).toEqual([]);
    }
    finally {
        f.close();
    } });
    it('stores a legal 15×15 library template but rejects overflowing application without touching the priced product or media target', async () => { const f = await mount(); try {
        const before = dirty(f), sku = f.view.form.attrs[0];
        const spec = [{ value: '维度甲', detail: Array.from({ length: 15 }, (_, i) => '甲' + i) }, { value: '维度乙', detail: Array.from({ length: 15 }, (_, i) => '乙' + i) }];
        await create(f, '合法大模板', spec);
        expect(templateWrites(f)).toHaveLength(1);
        f.view.selectedRuleId.value = 400;
        const media = f.view.mediaTarget.value;
        await f.view.applyProductRule();
        assertDraft(f, before);
        expect(f.view.form.attrs[0]).toBe(sku);
        expect(f.view.mediaTarget.value).toBe(media);
        expect(runtime.dialogs.messages.some((s: string) => s.includes('200'))).toBe(true);
    }
    finally {
        f.close();
    } });
    it('rejects ambiguous comma combinations before replacing any SKU or media state', async () => { const f = await mount(); try {
        const before = dirty(f), sku = f.view.form.attrs[0];
        await create(f, '含分隔符模板', [{ value: 'A', detail: ['a,b', 'a'] }, { value: 'B', detail: ['c', 'b,c'] }]);
        f.view.selectedRuleId.value = 400;
        const media = f.view.mediaTarget.value;
        await f.view.applyProductRule();
        assertDraft(f, before);
        expect(f.view.form.attrs[0]).toBe(sku);
        expect(f.view.mediaTarget.value).toBe(media);
        expect(runtime.dialogs.messages.some((s: string) => s.includes('歧义'))).toBe(true);
    }
    finally {
        f.close();
    } });
    it('freezes an unknown committed create and recovers it by GET without replay or automatic selection', async () => { const f = await mount(undefined, (c, x) => { if (c.method === 'post' && c.url === '/product/product/rule/0') {
        x.apply(c);
        throw Error('Owned committed rule response lost');
    } }); try {
        const before = dirty(f);
        await create(f);
        const original = f.editor.attempt.value;
        expect(Object.isFrozen(original.payload.spec[0].detail)).toBe(true);
        f.editor.closeEditor();
        await f.integration.openCreate();
        await f.editor.submit();
        expect(templateWrites(f)).toHaveLength(1);
        expect(f.editor.attempt.value).toBe(original);
        await f.editor.recover();
        await flush();
        expect(f.editor.attempt.value).toBeNull();
        expect(f.view.ruleTemplates.value.map((r: any) => r.id)).toEqual([201, 400]);
        expect(f.view.selectedRuleId.value).toBe(201);
        assertDraft(f, before);
        expect(templateWrites(f)).toHaveLength(1);
    }
    finally {
        f.close();
    } });
    it('never mistakes a pre-existing matching template for a lost create and requires fresh facts before explicitly ending it', async () => { const f = await mount(undefined, c => { if (c.method === 'post' && c.url === '/product/product/rule/0')
        throw Error('Owned unknown before commit'); }); try {
        const before = dirty(f);
        await create(f, '原规格模板', ruleSpec());
        f.editor.finishAttempt();
        expect(f.editor.attempt.value).not.toBeNull();
        await f.editor.recover();
        expect(f.editor.attempt.value).not.toBeNull();
        expect(f.editor.recoveryRead.value).toBe(true);
        expect(f.integration.notice.value).toBe('');
        f.editor.finishAttempt();
        await flush();
        expect(f.editor.attempt.value).toBeNull();
        assertDraft(f, before);
        expect(f.view.ruleTemplates.value.map((r: any) => r.id)).toEqual([201]);
        expect(templateWrites(f)).toHaveLength(1);
    }
    finally {
        f.close();
    } });
    it('does not repeat an acknowledged POST when its verification read fails and recovers against exact current ID and revision', async () => { let fail = false; const f = await mount(undefined, c => { if (c.method === 'post' && c.url === '/product/product/rule/0')
        fail = true;
    else if (fail && c.url === '/product/product/rule')
        throw Error('Owned catalog503'); }); try {
        const before = dirty(f);
        await create(f);
        expect(f.editor.attempt.value).not.toBeNull();
        expect(f.editor.receipt.value.id).toBe(400);
        await f.editor.submit();
        expect(templateWrites(f)).toHaveLength(1);
        fail = false;
        await f.editor.recover();
        await flush();
        expect(f.editor.attempt.value).toBeNull();
        expect(f.view.ruleTemplates.value.some((r: any) => r.id === 400)).toBe(true);
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('retains the old product directory after confirmed save and failed projection refresh then retries only that GET', async () => { let fail = false; const f = await mount(undefined, c => { if (c.method === 'post' && c.url === '/product/product/rule/0')
        fail = true;
    else if (fail && c.url === '/product/product/get_rule')
        throw Error('Owned projection503'); }); try {
        const before = dirty(f);
        await create(f);
        expect(f.editor.attempt.value).toBeNull();
        expect(f.integration.directoryError.value).toContain('已确认保存');
        expect(f.view.ruleTemplates.value.map((r: any) => r.id)).toEqual([201]);
        assertDraft(f, before);
        fail = false;
        await f.integration.refreshDirectory();
        await flush();
        expect(f.view.ruleTemplates.value.map((r: any) => r.id)).toEqual([201, 400]);
        expect(templateWrites(f)).toHaveLength(1);
        expect(f.view.selectedRuleId.value).toBe(201);
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('permits deliberate draft correction after an atomic conflict without changing the product', async () => { let reject = true; const f = await mount(undefined, c => { if (c.method === 'post' && c.url === '/product/product/rule/0' && reject) {
        reject = false;
        throw new runtime.ApiError('Owned definite conflict', 409);
    } }); try {
        const before = dirty(f);
        await create(f);
        expect(f.editor.attempt.value).toBeNull();
        expect(f.editor.editing.value).toBe(true);
        f.editor.form.rule_name = '明确更正后新增';
        await f.editor.submit();
        await flush();
        expect(templateWrites(f)).toHaveLength(2);
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('blocks inline authoring for a read-only product account', async () => { localStorage.setItem('supplier-permissions', '["supplier.product.view"]'); const f = await mount(); try {
        const before = clone(f.view.form);
        await f.integration.openCreate();
        await f.editor.openCreate();
        await f.editor.submit();
        expect(templateWrites(f)).toEqual([]);
        expect(f.editor.canManage.value).toBe(false);
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('aborts a held creator snapshot across actual route80→81→80 and rejects a late old result', async () => { const wait = gate(); let held: any; const f = await mount(undefined, c => { if (c.url === '/product/product/rule' && !held) {
        held = c;
        return wait.promise;
    } }); try {
        const old = f.editor;
        void f.integration.openCreate();
        await flush();
        await f.router.push('/products/81/edit');
        await flush();
        await f.router.push('/products/80/edit');
        await flush();
        const before = dirty(f);
        expect(held.signal.aborted).toBe(true);
        wait.resolve(ruleCatalog());
        await flush();
        expect(f.editor).not.toBe(old);
        expect(f.editor.editing.value).toBe(false);
        assertDraft(f, before);
        expect(templateWrites(f)).toEqual([]);
    }
    finally {
        wait.resolve(ruleCatalog());
        f.close();
    } });
    it('permanently invalidates an outstanding write after actual session21→22→21 and cannot repopulate the cleared product', async () => { const wait = gate(); let held: any; const f = await mount(undefined, (c, x) => { if (c.method === 'post' && c.url === '/product/product/rule/0') {
        held = c;
        return wait.promise.then(() => x.apply(c));
    } }); try {
        await f.integration.openCreate();
        Object.assign(f.editor.form, { rule_name: '旧身份提交', spec: createdSpec() });
        const pending = f.editor.submit();
        await flush();
        const keys = ['supplier-token', 'supplier-user', 'supplier-permissions'], original = keys.map(k => localStorage.getItem(k)!);
        localStorage.setItem(keys[0], 'owned-rule-b');
        localStorage.setItem(keys[1], '{"id":22,"supplier_id":20}');
        localStorage.setItem(keys[2], '["supplier.product.view"]');
        surface.dispatchEvent(new Event('supplier-session-changed'));
        keys.forEach((k, i) => localStorage.setItem(k, original[i]));
        surface.dispatchEvent(new Event('supplier-session-changed'));
        expect(f.view.mediaInvalidated.value).toBe(true);
        expect(f.view.productReadReady.value).toBe(false);
        const cleared = clone(f.view.form);
        expect(held.signal.aborted).toBe(true);
        wait.resolve();
        await pending;
        await flush();
        expect(f.editor.current()).toBe(false);
        expect(f.editor.editing.value).toBe(false);
        expect(f.integration.notice.value).toBe('');
        expect(clone(f.view.form)).toEqual(cleared);
        expect(templateWrites(f)).toHaveLength(1);
        expect(productWrites(f)).toEqual([]);
    }
    finally {
        wait.resolve();
        f.close();
    } });
    it('preserves the mature safe copy draft while creating its independent reusable template', async () => { const f = await mount('/products/new?copy=80'); try {
        expect(f.view.copyReady.value).toBe(true);
        const before = dirty(f);
        await create(f);
        assertDraft(f, before);
        expect(f.view.copyReady.value).toBe(true);
        expect(f.view.selectedRuleId.value).toBe(201);
        expect(templateWrites(f)).toHaveLength(1);
    }
    finally {
        f.close();
    } });
});
