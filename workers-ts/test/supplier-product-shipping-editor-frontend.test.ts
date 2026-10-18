import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../../view/supplier-ts'), require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
let runtime: any, pinia: any, surface: EventTarget, ownedDocument: any;
beforeAll(async () => {
    const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `import Form from './src/pages/ProductForm.vue';import Wrapper from './src/components/SupplierProductShippingTemplates.vue';import Picker from './src/components/ShippingTemplatePicker.vue';
    export {Form};export const captured={};for(const [key,component] of [['view',Form],['integration',Wrapper],['picker',Picker]]){const original=component.setup;component.setup=(p,c)=>{const value=original(p,c);captured[key]=value;return value;};}
    export {http,ApiError} from './src/api/http';export {useAuthStore} from './src/stores/auth';export * as dialogs from 'element-plus';
    export {creationHash} from '../shared/shippingCreation';export {createPinia,disposePinia} from 'pinia';export {createRenderer,h,nextTick,provide,inject} from 'vue';
    export {createRouter,createMemoryHistory,RouterView} from 'vue-router';` },
        alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"',
            '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
        bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-copy-editor-with-transport', setup(builder) {
                    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
                        if (path.includes('/components/') && !['SupplierProductShippingTemplates.vue', 'SupplierShippingTemplateEditor.vue', 'ShippingTemplatePicker.vue'].some(name => path.endsWith(name)))
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
    localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage","supplier.shipping.view","supplier.shipping.manage"]');
    pinia = runtime.createPinia();
    runtime.dialogs.messages.length = 0;
    runtime.captured.picker = undefined;
    runtime.captured.integration = undefined;
});
afterEach(() => { runtime.disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sku = (card = false) => ({ suk: '默认', detail: { 规格: '默认' }, image: '', price: '12.00', settle_price: '6.00', cost: '3.00',
    ot_price: '14.00', vip_price: '11.00', stock: card ? 0 : 8, bar_code: '', weight: '1.00', volume: '1.00', brokerage: '0.00', brokerage_two: '0.00', code: 'SOURCE', disk_info: '' });
const seed = (id = 80, type = 0) => ({ copy: { source_id: id, token: 'a'.repeat(64), destination: { type: 2, relation_id: 20 } }, product: {
        id: 0, product_type: type, store_name: '来源商品', store_info: '来源简介', keyword: '关键词', unit_name: '件', bar_code: '', cate_id: [1],
        slider_image: ['https://images.invalid/source.png'], description: '<p>来源说明</p>', spec_type: 0, items: [{ value: '规格', detail: ['默认'] }], attrs: [sku(type === 1)],
        retired_attrs: [], freight: 3, postage: '0.00', temp_id: 201, is_postage: 1, is_support_refund: 1, is_limit: 0, limit_type: 0, limit_num: 0,
        brand_id: [1, 2], brand_selection: { brand_id: 2, brand_com: '1,2', consistent: true, available: true }, sort: 1, ficti: 9, video_link: '', is_show: 0, is_verify: 0, store_label_id: [4], media: { version: 1, previews: {} },
    } });
const gate = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await runtime.nextTick();
} }
type Node = {
    tag?: string;
    text?: string;
    children: Node[];
    props: Record<string, any>;
    parent?: Node;
};
async function mount(url = '/products/80/edit', override: (config: any, fixture: any) => unknown = () => undefined) {
    const calls: any[] = [], fixture = { templates: new Map<number, any>([[201, shippingDetail()]]), reads: 0 };
    runtime.http.defaults.adapter = async (config: any) => {
        calls.push(config);
        let value = await override(config, fixture);
        if (value === undefined) {
            if (config.url === '/product/category/tree')
                value = [{ id: 1, cate_name: '本机分类' }];
            else if (config.url === '/product/product/get_rule')
                value = [];
            else if (config.url === '/product/product/shipping-template-options')
                value = { data: [...fixture.templates].map(([id, d]) => ({ id, name: d.formData.name, type: '按件数' })), count: fixture.templates.size };
            else if (/^\/product\/product\/shipping-template-options\/\d+$/.test(config.url)) {
                const id = Number(config.url.split('/').at(-1));
                const d = fixture.templates.get(id);
                value = { id, name: d?.formData.name ?? '当前不可用', type: '按件数' };
            }
            else if (config.url === '/setting/shipping_templates/city_list')
                value = [];
            else if (/^\/setting\/shipping_templates\/\d+\/edit$/.test(config.url)) {
                fixture.reads++;
                value = JSON.parse(JSON.stringify(fixture.templates.get(Number(config.url.split('/').at(-2))) ?? shippingDetail()));
            }
            else if (/^\/setting\/shipping_templates\/save\/\d+$/.test(config.url)) {
                const id = Number(config.url.split('/').at(-1)), body = JSON.parse(config.data);
                expect(body.expectedRevision).toBe(fixture.templates.get(id).revision);
                fixture.templates.set(id, shippingDetail(body.name, body.region_info[0].first_price, 'b'));
                value = { id };
            }
            else if (config.url.startsWith('/product/product/copy/'))
                value = seed(80);
            else if (/^\/product\/product\/\d+$/.test(config.url)) {
                value = config.method === 'post' ? { id: Number(config.url.split('/').at(-1)), is_verify: 0, is_show: 0 } : { ...seed().product, id: Number(config.url.split('/').at(-1)), store_name: '原商品' + config.url.split('/').at(-1), auto_on_time: 0, auto_off_time: 0 };
            }
            else
                throw Error('Unexpected actual inline endpoint ' + config.method + ' ' + config.url);
        }
        return { config, data: { status: 200, msg: 'owned inline shipping transport', data: value }, status: 200, statusText: 'owned', headers: {} };
    };
    const host: Node = { children: [], props: {} };
    const renderer = runtime.createRenderer({ createElement: (tag: string) => ({ tag, tagName: tag.toUpperCase(), children: [], props: {}, value: '', listeners: {}, addEventListener(name: string, fn: any) { (this.listeners as any)[name] ??= []; (this.listeners as any)[name].push(fn); }, removeEventListener() { }, getRootNode() { return ownedDocument; } }), createText: (text: string) => ({ text, children: [], props: {} }), createComment: () => ({ children: [], props: {} }),
        insert(n: Node, p: Node, anchor?: Node) { if (n.parent)
            n.parent.children = n.parent.children.filter(item => item !== n); n.parent = p; const at = anchor ? p.children.indexOf(anchor) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, n); },
        remove(n: Node) { if (n.parent)
            n.parent.children = n.parent.children.filter(item => item !== n); }, parentNode: (n: Node) => n.parent,
        nextSibling: (n: Node) => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp(n: Node, k: string, _: unknown, v: unknown) { n.props[k] = v; },
        setText(n: Node, v: string) { n.text = v; }, setElementText(n: Node, v: string) { n.text = v; n.children = []; } });
    const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [{ path: '/products/new', component: runtime.Form },
            { path: '/products/:id/edit', component: runtime.Form }, { path: '/products/copy-result', component: runtime.Form },
            { path: '/products', component: { render: () => null } }] });
    const app = renderer.createApp({ render: () => runtime.h(runtime.RouterView) });
    app.use(pinia);
    app.use(router);
    const tags = [...['pages/ProductForm', 'components/SupplierProductShippingTemplates', 'components/SupplierShippingTemplateEditor', 'components/ShippingTemplatePicker'].flatMap(page => [...readFileSync(resolve(root, `src/${page}.vue`), 'utf8').matchAll(/<(el-[a-z-]+)/g)])].map(m => m[1]);
    for (const name of new Set(tags))
        if (!['el-table', 'el-table-column'].includes(name))
            app.component(name, { inheritAttrs: false, setup(_: unknown, { slots, attrs }: any) { return () => runtime.h(name === 'el-button' ? 'button' : name, attrs, slots.default?.()); } });
    app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('owned-copy-table-rows', () => props.data ?? []); return () => runtime.h('table', {}, slots.default?.()); } });
    app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('owned-copy-table-rows'); return () => runtime.h('column', { label: props.label }, rows().map((row: any) => runtime.h('cell', {}, slots.default ? slots.default({ row }) : String(row[props.prop] ?? '')))); } });
    app.directive('loading', {});
    await router.push(url);
    app.mount(host);
    await flush();
    return { get picker() { return runtime.captured.picker; }, get integration() { return runtime.captured.integration; }, get editor() { return runtime.captured.integration.editor; }, view: runtime.captured.view, calls, fixture, host, router, close: () => app.unmount() };
}
const shippingDetail = (name = '原运费模板', price = '8.00', version = 'a') => ({ revision: 'shipping-v1:' + version.repeat(64), formData: { name, type: 1, appoint_check: 0, no_delivery_check: 0, sort: 0 }, templateList: [{ city_ids: [[0]], first: '1.00', first_price: price, continue: '1.00', continue_price: '2.00' }], appointList: [], noDeliveryList: [] });
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const templateWrites = (f: any) => f.calls.filter((c: any) => c.method === 'post' && c.url.startsWith('/setting/shipping_templates/save/'));
const productWrites = (f: any) => f.calls.filter((c: any) => c.method === 'post' && c.url.startsWith('/product/product/'));
function dirty(f: any) { f.view.form.store_name = '未保存商品草稿'; f.view.form.unit_name = '未保存袋'; f.view.form.keyword = '未保存关键词'; f.view.form.description = '<p>尚未保存说明</p>'; f.view.form.attrs[0].price = '23.45'; f.view.form.attrs[0].stock = 7; return clone(f.view.form); }
function assertDraft(f: any, before: any) { expect(clone(f.view.form)).toEqual(before); expect(productWrites(f)).toEqual([]); }
async function createFetch(f: any, lose = false) {
    let once = lose;
    const sent: any[] = [], receipts = new Map<string, any>();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
        const headers = new Headers(init.headers), key = headers.get('Idempotency-Key')!, body = JSON.parse(init.body);
        sent.push({ url, key, body, scope: headers.get('X-Shipping-Creation-Scope'), authorization: headers.get('Authorization') });
        let value;
        if (url.endsWith('/creation-receipt'))
            value = receipts.get(key) ?? null;
        else {
            value = receipts.get(key);
            if (!value) {
                value = { version: 'shipping-create-v1', requestKey: key, requestHash: await runtime.creationHash(body, 2), id: 301 };
                receipts.set(key, value);
                f.fixture.templates.set(301, shippingDetail(body.name, body.region_info[0].first_price, 'c'));
            }
            value = { ...value, replayed: receipts.has(key) && sent.length > 1 };
            if (once) {
                once = false;
                throw Error('Owned committed response lost');
            }
        }
        return new Response(JSON.stringify({ status: 200, data: value }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    return { sent, receipts };
}
describe('actual ProductForm inline shared shipping author preserves its unsaved product', () => {
    it('opens full grouped details and cancels without navigating or changing any product draft or SKU identity', async () => { const f = await mount(); try {
        const before = dirty(f), sku = f.view.form.attrs[0];
        await f.integration.viewTemplate();
        await flush();
        expect(f.editor.form.expectedRevision).toBe('shipping-v1:' + 'a'.repeat(64));
        expect(f.editor.form.region_info[0].first_price).toBe('8.00');
        f.editor.cancelEditor();
        await flush();
        assertDraft(f, before);
        expect(f.view.form.attrs[0]).toBe(sku);
        expect(f.router.currentRoute.value.path).toBe('/products/80/edit');
        expect(templateWrites(f)).toEqual([]);
    }
    finally {
        f.close();
    } });
    it('updates the shared template through real transport and authoritative revision readback, refreshing only the current metadata label', async () => { const f = await mount(); try {
        const before = dirty(f), sku = f.view.form.attrs[0];
        await f.integration.viewTemplate();
        await flush();
        const oldReads = f.fixture.reads;
        f.editor.form.name = '更新后的模板';
        f.editor.form.region_info[0].first_price = '12.00';
        await f.editor.submit();
        await flush();
        expect(templateWrites(f)).toHaveLength(1);
        expect(JSON.parse(templateWrites(f)[0].data)).toMatchObject({ name: '更新后的模板', expectedRevision: 'shipping-v1:' + 'a'.repeat(64) });
        expect(f.fixture.reads).toBeGreaterThan(oldReads);
        expect(f.picker.selected.value.name).toBe('更新后的模板');
        assertDraft(f, before);
        expect(f.view.form.attrs[0]).toBe(sku);
    }
    finally {
        f.close();
    } });
    it('creates with the mature original UUID receipt and selects the new template only after explicit acknowledgement and picker action', async () => { const f = await mount(); try {
        const before = dirty(f), transport = await createFetch(f);
        await f.integration.createTemplate();
        await flush();
        f.editor.form.name = '从商品页新增';
        await f.editor.submit();
        await flush();
        expect(transport.sent).toHaveLength(1);
        expect(transport.sent[0]).toMatchObject({ scope: 'v1:2:20:21', authorization: 'Bearer owned-copy-a' });
        expect(transport.sent[0].key).toMatch(/^[a-f0-9-]{36}$/);
        expect(f.editor.creation.value.receipt.id).toBe(301);
        assertDraft(f, before);
        await f.editor.creationAction('acknowledge');
        await flush();
        assertDraft(f, before);
        expect(f.integration.savedMessage.value).toContain('#301');
        await f.picker.open();
        await flush();
        f.picker.choose(301);
        await flush();
        expect(f.view.form.temp_id).toBe(301);
        expect({ ...clone(f.view.form), temp_id: before.temp_id }).toEqual(before);
        expect(productWrites(f)).toEqual([]);
    }
    finally {
        f.close();
    } });
    it('reopens a lost creation result with its original frozen payload and key and recovers the actual receipt without a second create', async () => { const f = await mount(); try {
        const before = dirty(f), transport = await createFetch(f, true);
        await f.integration.createTemplate();
        await flush();
        f.editor.form.name = '原始新增意图';
        await f.editor.submit();
        await flush();
        const key = f.editor.creation.value.requestKey;
        expect(f.editor.creation.value.receipt).toBeNull();
        f.editor.cancelEditor();
        await f.integration.createTemplate();
        await flush();
        expect(f.editor.creation.value.requestKey).toBe(key);
        expect(f.editor.form.name).toBe('原始新增意图');
        await f.editor.submit();
        expect(transport.sent).toHaveLength(1);
        await f.editor.creationAction('recover');
        await flush();
        expect(transport.sent).toHaveLength(2);
        expect(transport.sent[1].url).toContain('creation-receipt');
        expect(transport.sent[1].key).toBe(key);
        expect(f.editor.creation.value.receipt.id).toBe(301);
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('allows shipping-view inspection while product manage cannot grant missing shipping manage rights', async () => { localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage","supplier.shipping.view"]'); const f = await mount(); try {
        const before = dirty(f);
        await f.integration.viewTemplate();
        await flush();
        expect(f.editor.dialogVisible.value).toBe(true);
        expect(f.editor.canManage.value).toBe(false);
        await f.editor.submit();
        await f.editor.openCreate();
        assertDraft(f, before);
        expect(templateWrites(f)).toEqual([]);
    }
    finally {
        f.close();
    } });
    it('keeps product-only shipping selection usable without reading the full privileged template or city directory', async () => { localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.product.manage"]'); const f = await mount(); try {
        expect(f.picker.selected.value.id).toBe(201);
        await f.integration.viewTemplate();
        await f.integration.createTemplate();
        await flush();
        expect(f.calls.some((c: any) => c.url.startsWith('/setting/shipping_templates'))).toBe(false);
        expect(f.editor.dialogVisible.value).toBe(false);
        expect(productWrites(f)).toEqual([]);
    }
    finally {
        f.close();
    } });
    it('keeps draft and binding after a full template read fails', async () => { const f = await mount(undefined, c => { if (c.url === '/setting/shipping_templates/201/edit')
        throw Error('Owned detail503'); }); try {
        const before = dirty(f);
        await f.integration.viewTemplate();
        await flush();
        expect(f.editor.editError.value).toContain('503');
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('acknowledges a completed update with failed readback honestly and pauses resend until an explicit current read succeeds', async () => { let failRead = false; const f = await mount(undefined, c => { if (c.method === 'post' && c.url === '/setting/shipping_templates/save/201')
        failRead = true;
    else if (failRead && c.url === '/setting/shipping_templates/201/edit')
        throw Error('Owned readback503'); }); try {
        const before = dirty(f);
        await f.integration.viewTemplate();
        await flush();
        f.editor.form.name = '已提交名称';
        await f.editor.submit();
        await flush();
        expect(templateWrites(f)).toHaveLength(1);
        expect(f.editor.needsReload.value).toBe(true);
        expect(f.editor.editError.value).toMatch(/已.*(?:更新|保存)/);
        await f.editor.submit();
        expect(templateWrites(f)).toHaveLength(1);
        assertDraft(f, before);
        failRead = false;
        await f.editor.reloadEditor();
        await flush();
        expect(f.picker.selected.value.name).toBe('已提交名称');
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('retains a stale-revision user edit and requires explicit reread rather than silently retrying the same write', async () => { const f = await mount(undefined, c => { if (c.method === 'post' && c.url === '/setting/shipping_templates/save/201')
        throw new runtime.ApiError('模板已被其他操作修改，请核对编辑版本', 400); }); try {
        const before = dirty(f);
        await f.integration.viewTemplate();
        await flush();
        f.editor.form.name = '冲突时保留输入';
        await f.editor.submit();
        await flush();
        expect(f.editor.needsReload.value).toBe(true);
        expect(f.editor.form.name).toBe('冲突时保留输入');
        await f.editor.submit();
        expect(templateWrites(f)).toHaveLength(1);
        assertDraft(f, before);
    }
    finally {
        f.close();
    } });
    it('aborts an old route read across 80→81→80 and never replaces the new product draft', async () => { const wait = gate(); let held: any; const f = await mount(undefined, c => { if (c.url === '/setting/shipping_templates/201/edit' && !held) {
        held = c;
        return wait.promise;
    } }); try {
        void f.integration.viewTemplate();
        await flush();
        const oldEditor = f.editor;
        await f.router.push('/products/81/edit');
        await flush();
        await f.router.push('/products/80/edit');
        await flush();
        const before = dirty(f);
        expect(held.signal.aborted).toBe(true);
        wait.resolve(shippingDetail('旧路由迟到'));
        await flush();
        expect(f.editor).not.toBe(oldEditor);
        assertDraft(f, before);
        expect(f.editor.form.name).not.toBe('旧路由迟到');
    }
    finally {
        wait.resolve(shippingDetail());
        f.close();
    } });
    it('permanently invalidates a pending editor after actual session A→B→A without any template or product write', async () => { const wait = gate(); let held: any; const f = await mount(undefined, c => { if (c.url === '/setting/shipping_templates/201/edit') {
        held = c;
        return wait.promise;
    } }); try {
        void f.integration.viewTemplate();
        await flush();
        const keys = ['supplier-token', 'supplier-user', 'supplier-permissions'];
        const original = keys.map(key => localStorage.getItem(key)!);
        localStorage.setItem('supplier-token', 'owned-shipping-b');
        localStorage.setItem('supplier-user', '{"id":22,"supplier_id":20}');
        localStorage.setItem('supplier-permissions', '["supplier.product.view","supplier.shipping.view"]');
        surface.dispatchEvent(new Event('supplier-session-changed'));
        keys.forEach((key, i) => localStorage.setItem(key, original[i]));
        surface.dispatchEvent(new Event('supplier-session-changed'));
        expect(f.view.mediaInvalidated.value).toBe(true);
        expect(f.view.productReadReady.value).toBe(false);
        expect(f.view.form.id).toBe(0);
        const invalidatedDraft = clone(f.view.form);
        wait.resolve(shippingDetail('旧身份迟到'));
        await flush();
        expect(held.signal.aborted).toBe(true);
        expect(f.editor.sessionInvalidated.value).toBe(true);
        expect(f.editor.dialogVisible.value).toBe(false);
        await f.editor.openEdit(201);
        expect(templateWrites(f)).toEqual([]);
        expect(productWrites(f)).toEqual([]);
        expect(clone(f.view.form)).toEqual(invalidatedDraft);
    }
    finally {
        wait.resolve(shippingDetail());
        f.close();
    } });
    it('keeps the existing safe copy product fields intact while viewing and editing an independent template', async () => { const f = await mount('/products/new?copy=80'); try {
        expect(f.view.copyReady.value).toBe(true);
        const before = dirty(f);
        await f.integration.viewTemplate();
        await flush();
        f.editor.form.name = '复制页面模板编辑';
        await f.editor.submit();
        await flush();
        assertDraft(f, before);
        expect(f.view.copyReady.value).toBe(true);
        expect(templateWrites(f)).toHaveLength(1);
    }
    finally {
        f.close();
    } });
});
