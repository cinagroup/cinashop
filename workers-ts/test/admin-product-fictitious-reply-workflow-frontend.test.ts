import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const base = '/product/reply';
let runtime: any, browser: EventTarget, values: Map<string, string>;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/reply', href: '' } }));
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export {default as Page} from './src/pages/reply/ReplyList.vue';
    export {default as Dialog} from './src/pages/reply/FictitiousReplyDialog.vue';
    export {default as request} from './src/utils/request'; export * as api from './src/api/reply';
    export * as dialogs from 'element-plus'; export * as routing from 'vue-router';
    export {createPinia,disposePinia} from 'pinia';
    export {createRenderer,nextTick,h,provide,inject,watch} from 'vue';` },
    alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false', '__VUE_OPTIONS_API__': 'true', '__VUE_PROD_DEVTOOLS__': 'false', '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm', plugins: [{ name: 'actual-admin-reply-page', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
        const descriptor = parse(readFileSync(path, 'utf8'), { filename: path }).descriptor;
        const script = compileScript(descriptor, { id: 'admin-reply-runtime', genDefaultAs: '__Page' });
        const template = compileTemplate({ source: descriptor.template.content, filename: path, id: 'admin-reply-runtime', compilerOptions: { bindingMetadata: script.bindings, expressionPlugins: ['typescript'] } });
        if (template.errors.length) throw Error(String(template.errors));
        return { contents: `${script.content}\n${template.code}\n__Page.render=render;export default __Page;`, loader: 'ts' };
      });
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'dialogs', namespace: 'fixture' }));
      builder.onResolve({ filter: /^vue-router$/ }, () => ({ path: 'routing', namespace: 'fixture' }));
      builder.onLoad({ filter: /dialogs/, namespace: 'fixture' }, () => ({ contents: `
        export const state={successes:[],errors:[],confirmations:[],confirm:async()=>{}};
        export const ElMessage={success:m=>state.successes.push(m),error:m=>state.errors.push(m)};
        export const ElMessageBox={confirm(...args){state.confirmations.push(args);return state.confirm(...args)}};` }));
      builder.onLoad({ filter: /routing/, namespace: 'fixture' }, () => ({ resolveDir: root, contents: `import {reactive} from 'vue';export const route=reactive({query:{}});export const useRoute=()=>route;` }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  values = new Map(); browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { location: { pathname: '/reply', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  runtime.dialogs.state.successes.length = runtime.dialogs.state.errors.length = runtime.dialogs.state.confirmations.length = 0;
  runtime.dialogs.state.confirm = async () => {}; runtime.routing.route.query = {};
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const comment = (id = 71, pid = 0, uid = 0) => ({ id, type: 0, relation_id: 0, uid, praise: 2, content: '平台原回复', pid, reply_id: 7, create_time: '2026-10-14 10:00:00', update_time: '1970-01-01 08:00:00' });
const row = () => ({ id: 7, uid: 31, oid: 101, type: 2, relation_id: 20, unique: 'review-snapshot', product_id: 51, sku_unique: 'sku-snapshot', sku: '红色', reply_type: 'product', reply_score: 3,
  product_score: 5, service_score: 4, delivery_score: 3, comment: '<评价正文>', pics: ['https://example.test/review.png'], add_time: '2026-10-14 09:00:00', praise: 2, views_num: 10,
  merchant_reply_content: '旧独立商家字段', merchant_reply_time: 0, is_del: 0, is_reply: 0, nickname: '顾客快照', avatar: '', store_name: '供应商商品', image: '', account: '顾客快照',
  create_time: '2026-10-14 09:00:00', time: '1小时前', score: '4', status: 1, replyComment: comment() });
const gate = () => { let resolve!: (value: any) => void; return { promise: new Promise<any>(done => { resolve = done; }), resolve }; };
async function flush() { for (let i = 0; i < 35; i++) { await Promise.resolve(); await runtime.nextTick(); } }
function login(permissions = ['reply.view', 'reply.manage'], token = 'reply-admin-a', id = 20) {
  values.set('admin_token', token); values.set('admin_session', JSON.stringify({ userInfo: { id, account: 'moderator', head_pic: '', real_name: 'Moderator', level: 1, roles: '7' }, menus: [], uniqueAuth: permissions }));
}
type Node = { tag?: string; text?: string; children: Node[]; props: Record<string, any>; parent?: Node };
const walk = (node: Node): Node[] => [node, ...node.children.flatMap(walk)];
const textOf = (node: Node): string => `${node.text ?? ''}${node.children.map(textOf).join('')}`;
const envelope = (data: unknown) => ({ status: 200, msg: 'owned-moderation-transport', data });
function controls(app: any) {
  const pass = (tag: string) => ({ inheritAttrs: false, setup(_: unknown, { attrs, slots }: any) { return () => runtime.h(tag, attrs, slots.default?.()); } });
  for (const [name, tag] of Object.entries({ 'el-form': 'form', 'el-form-item': 'field', 'el-button': 'button', 'el-option': 'option', 'el-tag': 'tag', 'el-image': 'image', 'el-upload': 'upload' })) app.component(name, pass(tag));
  app.component('el-input', { inheritAttrs: false, props: ['modelValue', 'type'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h(props.type === 'textarea' ? 'textarea' : 'input', { ...attrs, value: props.modelValue, onInput: (event: any) => emit('update:modelValue', event.target.value) }); } });
  app.component('el-select', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit, slots }: any) { return () => runtime.h('select', { ...attrs, value: props.modelValue, onChange: (value: any) => { emit('update:modelValue', value); attrs.onChange?.(value); } }, slots.default?.()); } });
  app.component('el-date-picker', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('date-range', { ...attrs, value: props.modelValue, onChange: (value: any) => emit('update:modelValue', value) }); } });
  app.component('el-rate', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('rate', { ...attrs, value: props.modelValue, onRate: (value: number) => emit('update:modelValue', value) }); } });
  app.component('el-pagination', { inheritAttrs: false, props: ['currentPage', 'pageSize', 'total', 'disabled'], emits: ['current-change'], setup(props: any, { emit }: any) {
    // Model the actual Element Plus clamp found by Chrome QA. A zero count
    // during page-2 loading causes the component to emit current-change(1).
    runtime.watch(() => [props.currentPage, props.total, props.pageSize], () => { const maximum = Math.max(1, Math.ceil(props.total / props.pageSize)); if (props.currentPage > maximum) emit('current-change', maximum); });
    return () => runtime.h('pagination', { ...props, onPage: (page: number) => emit('current-change', page) }, `总计 ${props.total}`);
  } });
  app.component('el-dialog', { inheritAttrs: false, props: ['modelValue', 'title'], setup(props: any, { slots }: any) { return () => props.modelValue ? runtime.h('dialog', { title: props.title }, [slots.default?.(), slots.footer?.()]) : null; } });
  app.component('el-alert', { props: ['title', 'type'], setup(props: any) { return () => runtime.h('alert', { type: props.type }, props.title); } });
  app.component('el-empty', { props: ['description'], setup(props: any) { return () => runtime.h('empty', {}, props.description); } });
  app.component('el-table', { props: ['data'], setup(props: any, { slots }: any) { runtime.provide('reply-fixture-rows', () => props.data); return () => runtime.h('table', {}, slots.default?.()); } });
  app.component('el-table-column', { props: ['prop', 'label'], setup(props: any, { slots }: any) { const rows = runtime.inject('reply-fixture-rows'); return () => runtime.h('column', { label: props.label }, rows().map((value: any) => runtime.h('cell', { row: value.id }, slots.default ? slots.default({ row: value }) : String(value[props.prop] ?? '')))); } });
  app.directive('loading', {});
}
async function mount(permissions = ['reply.view', 'reply.manage', 'product.view', 'attachment.view', 'attachment.manage'], override: (config: any, fixture: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [], fixture = {
    rows: [] as any[], products: [product(51, 2, 0), product(52, 1, 1)], count: 21,
    assets: [asset(31), asset(32)], categories: [{ id: 1, name: '自评素材' }],
    respond(config: any) {
      const body = typeof config.data === 'string' && config.data ? JSON.parse(config.data) : {};
      if (config.method === 'get') {
        // This transport models the response-only signing contract. Actual SQL,
        // attachment ownership and asset GET signatures are verified separately.
        if (config.url === base) return { list: structuredClone(fixture.rows).map((item: any) => item.uid === 0 && item.type === 0 && item.relation_id === 0
          ? { ...item, avatar: signedCanonical(item.avatar), pics: item.pics.map(signedCanonical) } : item), count: fixture.rows.length };
        if (config.url.startsWith(`${base}/fictitious_reply/`)) return definition(Number(config.url.split('/').at(-1)));
        if (config.url === '/product/product/list') return { list: structuredClone(fixture.products), count: fixture.count };
        if (config.url === '/file/category') return { list: structuredClone(fixture.categories) };
        if (config.url === '/file/file') return { list: structuredClone(fixture.assets), count: fixture.assets.length };
      }
      if (config.method === 'post' && config.url === `${base}/save_fictitious_reply`) {
        fixture.rows.push({ ...row(), id: 8, uid: 0, oid: 0, type: 0, relation_id: 0, product_id: body.image.product_id,
          nickname: body.nickname, account: body.nickname, comment: body.comment, avatar: body.avatar, pics: [...body.pics],
          product_score: body.product_score, service_score: body.service_score, delivery_score: body.delivery_score,
          score: String((body.product_score + body.service_score + body.delivery_score) / 3), replyComment: null });
        return undefined;
      }
      if (config.method === 'post' && config.url === '/file/upload') {
        const item = asset(33); fixture.assets.unshift(item); return { att_id: item.att_id, src: item.att_dir, url: item.canonical_url };
      }
      throw Error(`Unexpected fixture request: ${config.method} ${config.url}`);
    }
  };
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config); const custom = await override(config, fixture);
    const result = custom === undefined ? fixture.respond(config) : custom;
    return { config, data: (result as any)?.__envelope ?? envelope(result), status: 200, statusText: 'fixture', headers: {} };
  };
  const node = (tag?: string, text?: string): Node => ({ tag, text, props: {}, children: [] });
  const renderer = runtime.createRenderer({ createElement: (tag: string) => node(tag), createText: (text: string) => node('#text', text), createComment: (text: string) => node('#comment', text),
    insert(child: Node, parent: Node, anchor?: Node) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child); },
    remove(child: Node) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = undefined; },
    parentNode: (child: Node) => child.parent, nextSibling: (child: Node) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
    patchProp(child: Node, key: string, _previous: any, value: any) { child.props[key] = value; }, setText(child: Node, text: string) { child.text = text; }, setElementText(child: Node, text: string) { child.text = text; child.children = []; } });
  let view: any, dialog: any; const originalDialogSetup = runtime.Dialog.setup; runtime.Dialog.setup = (props: any, context: any) => { dialog = originalDialogSetup(props, context); return dialog; }; const page = { ...runtime.Page, setup(props: any, context: any) { view = runtime.Page.setup(props, context); return view; } };
  const app = renderer.createApp(page), pinia = runtime.createPinia(), surface = node('root'); app.use(pinia); controls(app); app.mount(surface); runtime.Dialog.setup = originalDialogSetup; await flush();
  return { view, dialog, fixture, calls, surface, nodes: () => walk(surface), text: () => textOf(surface), close() { app.unmount(); runtime.disposePinia(pinia); } };
}
const writes = (f: any) => f.calls.filter((config: any) => ['put', 'post', 'delete'].includes(config.method));
function button(f: any, label: string, scope?: Node): Node { const result = (scope ? walk(scope) : f.nodes()).find((node: Node) => node.tag === 'button' && textOf(node) === label); if (!result) throw Error(`Missing rendered button: ${label}`); return result; }
async function click(f: any, label: string, scope?: Node) { const control = button(f, label, scope); if (control.props.disabled || control.props.loading) return; await control.props.onClick(); await flush(); }
async function input(f: any, placeholder: string, value: string) { const control = f.nodes().find((node: Node) => ['input', 'textarea'].includes(node.tag ?? '') && node.props.placeholder === placeholder); if (!control) throw Error(`Missing rendered input: ${placeholder}`); control.props.onInput({ target: { value } }); await flush(); }


const product = (id = 51, type = 2, isShow = 0) => ({ id, type, relation_id: type ? 20 : 0, store_name: type === 2 ? '供应商下架商品' : type === 1 ? '门店商品' : '平台商品', image: '/uploads/product.png', is_show: isShow,
  attrValue: [{ id: id * 10, product_id: id, unique: `sku${id}001`, suk: '红色,大码', type: 0, is_retired: 0, image: '/uploads/sku.png', stock: 0, price: '15.00' },
    { id: id * 10 + 1, product_id: id, unique: `sku${id}002`, suk: '蓝色,小码', type: 0, is_retired: 0, image: '/uploads/blue.png', stock: 5, price: '12.00' }] });
const signedPreview = (id: number) => `/api/assets/${id}?expires=1900000000&signature=${'A'.repeat(43)}`;
const signedCanonical = (value: string) => { const match = /^\/api\/assets\/([1-9]\d*)$/u.exec(value); return match ? signedPreview(Number(match[1])) : value; };
const asset = (id: number) => ({ att_id: id, canonical_url: `/api/assets/${id}`, att_dir: signedPreview(id), satt_dir: `${signedPreview(id)}&variant=thumbnail&width=100&height=100`, att_type: 'image/png', real_name: `素材${id}.png` });
const definition = (id: number) => ({ title: '添加虚拟评论', action: 'product/reply/save_fictitious_reply', method: 'POST', rules: [id ? { type: 'hidden', field: 'product_id', value: id } : { type: 'frame', field: 'image' }, { type: 'rate', field: 'product_score', value: 0 }] });
function dialogNode(f: any, title: string): Node { const value = f.nodes().find((node: Node) => node.tag === 'dialog' && node.props.title === title); if (!value) throw Error(`Missing rendered dialog: ${title}`); return value; }
async function select(f: any, aria: string, value: unknown) { const control = f.nodes().find((node: Node) => node.tag === 'select' && node.props['aria-label'] === aria); if (!control) throw Error(`Missing rendered select: ${aria}`); control.props.onChange(value); if (control.props.onChange instanceof Array) throw Error('Fixture event must dispatch update and change'); await flush(); }
async function selectSku(f: any, unique = 'sku51001') {
  const control = f.nodes().find((node: Node) => node.tag === 'select' && node.props['aria-label'] === '自评商品规格'); if (!control) throw Error('Missing SKU control'); control.props.onChange(unique); await flush();
}
async function ready(f: any) { await click(f, '添加自评'); await click(f, '选择商品', dialogNode(f, '添加自评')); await selectSku(f); }
async function fill(f: any, nickname = '自评名称') {
  await input(f, '头像稳定图片地址', '/uploads/avatar.png'); await input(f, '请输入自评用户名称', nickname); await input(f, '请输入自评评价文字', '管理员自评正文');
  for (const [name, value] of [['自评商品质量', 5], ['自评服务态度', 4], ['自评物流服务', 3]] as const) { const rate = f.nodes().find((node: Node) => node.tag === 'rate' && node.props['aria-label'] === name); if (!rate) throw Error(`Missing rate ${name}`); rate.props.onRate(value); } await flush();
}

describe('actual rendered Admin self-review, SKU selector and existing attachment picker with compiled Axios', () => {
  it('submits the source snake payload for a Supplier off-shelf product and renders the added self-review', async () => {
    const f = await mount();
    try {
      await ready(f); expect(f.text()).toContain('不关联真实顾客或订单'); expect(f.text()).toContain('供应商下架商品'); expect(f.text()).toContain('下架');
      expect(f.calls.find((call: any) => call.url === '/product/product/list')).toMatchObject({ method: 'get', baseURL: '/adminapi', params: { page: 1, limit: 10, cate_id: '', store_name: '', is_new: '', store_label_id: '', is_integral: 1 } });
      expect(f.calls.filter((call: any) => call.url.includes('/fictitious_reply/')).map((call: any) => call.url)).toEqual([`${base}/fictitious_reply/0`, `${base}/fictitious_reply/51`]);
      await fill(f, ' 😀自评昵称 '); await input(f, '请输入自评评价文字', ' 😀自评正文\n第二行 ');
      await select(f, '自评好中差评', '2'); await click(f, '添加图片地址'); await input(f, '评价图片地址 1', 'https://example.test/review.png');
      const date = f.nodes().find((node: Node) => node.tag === 'date-range' && node.props.type === 'datetime')!;
      expect(date.props['value-format']).toBe('YYYY-MM-DD HH:mm:ss'); date.props.onChange('2026-10-01 09:30:00'); await flush();
      await click(f, '添加自评并保存');
      const write = writes(f)[0]; expect(writes(f)).toHaveLength(1); expect(write).toMatchObject({ method: 'post', url: `${base}/save_fictitious_reply` }); expect(write.headers['Authori-zation']).toBe('Bearer reply-admin-a');
      expect(JSON.parse(write.data)).toEqual({ image: { product_id: 51, image: '/uploads/product.png' }, unique: 'sku51001', nickname: ' 😀自评昵称 ', avatar: '/uploads/avatar.png', comment: ' 😀自评正文\n第二行 ', product_score: 5, service_score: 4, delivery_score: 3, reply_score: '2', pics: ['https://example.test/review.png'], add_time: '2026-10-01 09:30:00' });
      expect(f.text()).toContain(' 😀自评正文\n第二行 '); expect(f.fixture.rows[0]).toMatchObject({ uid: 0, oid: 0, type: 0, relation_id: 0 }); expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toEqual([]);
    } finally { f.close(); }
  });

  it('opens the existing real picker, preserves canonical avatar/picture references and uploads with separate attachment.manage', async () => {
    const f = await mount();
    try {
      await ready(f); await fill(f); const avatarField = f.nodes().find((node: Node) => node.tag === 'field' && node.props.label === '用户头像')!;
      await click(f, '从图库选择', avatarField); const avatarPicker = dialogNode(f, '选择自评头像');
      expect(f.calls.filter((call: any) => ['/file/category', '/file/file'].includes(call.url)).map((call: any) => call.url)).toEqual(['/file/category', '/file/file']);
      const upload = walk(avatarPicker).find(node => node.tag === 'upload')!; const file = new File(['image-fixture'], 'avatar.png', { type: 'image/png' });
      await upload.props['http-request']({ file }); await flush(); const uploaded = f.calls.find((call: any) => call.url === '/file/upload');
      expect(uploaded.method).toBe('post'); expect(uploaded.data).toBeInstanceOf(FormData); expect(uploaded.data.get('file').name).toBe('avatar.png'); expect(uploaded.data.get('pid')).toBe('0');
      await click(f, '选择', dialogNode(f, '选择自评头像')); await click(f, '添加所选图片', dialogNode(f, '选择自评头像'));
      expect(f.dialog.form.avatar).toBe('/api/assets/33');
      expect(walk(avatarField).find(node => node.tag === 'image')?.props.src).toBe(signedPreview(33));
      const pictureField = f.nodes().find((node: Node) => node.tag === 'field' && node.props.label === '评价图片')!;
      await click(f, '从图库选择', pictureField); const picturePicker = dialogNode(f, '选择自评评价图片');
      const articles = walk(picturePicker).filter(node => node.tag === 'article'); await click(f, '选择', articles[1]); await click(f, '选择', articles[2]); await click(f, '添加所选图片', dialogNode(f, '选择自评评价图片'));
      expect(walk(pictureField).filter(node => node.tag === 'image').map(node => node.props.src)).toEqual([signedPreview(31), signedPreview(32)]);
      await click(f, '添加自评并保存'); const create = writes(f).find((call: any) => call.url === `${base}/save_fictitious_reply`);
      expect(JSON.parse(create.data)).toMatchObject({ avatar: '/api/assets/33', pics: ['/api/assets/31', '/api/assets/32'] }); expect(create.data).not.toContain('expires='); expect(create.data).not.toContain('signature=');
      expect(f.fixture.rows[0]).toMatchObject({ avatar: '/api/assets/33', pics: ['/api/assets/31', '/api/assets/32'] });
      expect(f.calls.at(-1)).toMatchObject({ method: 'get', url: base });
      const displayed = f.nodes().find((node: Node) => node.tag === 'image' && node.props.class === 'pic')!;
      expect(displayed.props.src).toBe(signedPreview(31)); expect(displayed.props['preview-src-list']).toEqual([signedPreview(31), signedPreview(32)]);
      expect(f.view.list.value[0].avatar).toBe(signedPreview(33));
      expect(f.calls.filter((call: any) => call.url === '/file/file')).toHaveLength(3);
    } finally { f.close(); }
  });

  it('keeps reply, product and attachment permission gates independent, including direct handlers and product routes', async () => {
    const readOnly = await mount(['reply.view', 'product.view', 'attachment.view']);
    try { expect(() => button(readOnly, '添加自评')).toThrow(); await readOnly.view.openFictitious(); await readOnly.dialog.save(); expect(readOnly.calls.map((call: any) => call.url)).toEqual([base]); } finally { readOnly.close(); }
    runtime.routing.route.query = { product_id: '51' }; const noProduct = await mount(['reply.view', 'reply.manage', 'attachment.view', 'attachment.manage']);
    try { await click(noProduct, '添加自评'); expect(noProduct.text()).toContain('选择商品需要商品查看权限'); expect(noProduct.calls.some((call: any) => call.url === '/product/product/list')).toBe(false);
      await noProduct.dialog.chooseProduct(product()); await noProduct.dialog.loadProducts(); await noProduct.dialog.save(); expect(writes(noProduct)).toEqual([]); expect(noProduct.dialog.selected.value).toBeNull();
    } finally { noProduct.close(); }
    const noAssets = await mount(['reply.view', 'reply.manage', 'product.view']);
    try { await ready(noAssets); await fill(noAssets); expect(noAssets.text()).toContain('选择图片需要图库查看权限');
      const avatarField = noAssets.nodes().find((node: Node) => node.tag === 'field' && node.props.label === '用户头像')!; expect(button(noAssets, '从图库选择', avatarField).props.disabled).toBe(true);
      await click(noAssets, '从图库选择', avatarField); expect(noAssets.calls.some((call: any) => call.url.startsWith('/file/'))).toBe(false); await click(noAssets, '添加自评并保存'); expect(writes(noAssets)).toHaveLength(1);
    } finally { noAssets.close(); }
  });

  it('renders unavailable saved-image placeholders without displaying an unsigned private canonical URL', async () => {
    const f = await mount(undefined, (config, fixture) => config.url === base && fixture.rows.length
      ? { list: fixture.rows.map((item: any) => ({ ...item, pics: [''], avatar: '' })), count: fixture.rows.length } : undefined);
    try {
      await ready(f); await fill(f); await click(f, '添加图片地址'); await input(f, '评价图片地址 1', '/api/assets/31'); await click(f, '添加自评并保存');
      expect(JSON.parse(writes(f)[0].data).pics).toEqual(['/api/assets/31']); expect(f.fixture.rows[0].pics).toEqual(['/api/assets/31']);
      expect(f.view.list.value[0].pics).toEqual(['']); expect(f.text()).toContain('图片暂不可用');
      expect(f.nodes().filter((node: Node) => node.tag === 'image' && node.props.class === 'pic')).toEqual([]);
    } finally { f.close(); }
  });

  it('permits picker selection with attachment.view while hiding upload without attachment.manage', async () => {
    const f = await mount(['reply.view', 'reply.manage', 'product.view', 'attachment.view']);
    try { await ready(f); await fill(f); const avatarField = f.nodes().find((node: Node) => node.tag === 'field' && node.props.label === '用户头像')!;
      await click(f, '从图库选择', avatarField); const picker = dialogNode(f, '选择自评头像'); expect(walk(picker).filter(node => node.tag === 'upload')).toEqual([]);
      await click(f, '选择', picker); await click(f, '添加所选图片', picker); await click(f, '添加自评并保存'); expect(JSON.parse(writes(f)[0].data).avatar).toBe('/api/assets/31'); expect(f.calls.some((call: any) => call.url === '/file/upload')).toBe(false);
    } finally { f.close(); }
  });

  it('uses rendered selector filters, counts and delayed page events without the Element Plus page-one clamp', async () => {
    const wait = gate(), f = await mount(undefined, (config, fixture) => config.url === '/product/product/list' && config.params.page === 2 ? wait.promise.then(() => fixture.respond(config)) : undefined);
    try {
      await click(f, '添加自评'); await input(f, '搜索商品名称、关键词或ID', ' 供应商 '); await select(f, '自评商品新品筛选', 1); await click(f, '查询商品');
      expect(f.calls.filter((call: any) => call.url === '/product/product/list').at(-1).params).toEqual({ page: 1, limit: 10, store_name: '供应商', cate_id: '', store_label_id: '', is_new: 1, is_integral: 1 });
      const pager = walk(dialogNode(f, '添加自评')).find(node => node.tag === 'pagination')!; const pending = pager.props.onPage(2); await flush(); expect(f.dialog.productPage.value).toBe(2); expect(f.dialog.productCount.value).toBe(21);
      expect(f.calls.filter((call: any) => call.url === '/product/product/list').map((call: any) => call.params.page)).toEqual([1, 1, 2]); wait.resolve(undefined); await pending; await flush(); expect(f.dialog.productPage.value).toBe(2);
    } finally { wait.resolve(undefined); f.close(); }
  });

  it('discards obsolete selector results and aborts them when a newer rendered query completes', async () => {
    const wait = gate(), f = await mount(undefined, config => config.url === '/product/product/list' && config.params.store_name === '红色' ? wait.promise : config.url === '/product/product/list' && config.params.store_name === '蓝色' ? { list: [product(52, 1, 1)], count: 1 } : undefined);
    try {
      await click(f, '添加自评'); await input(f, '搜索商品名称、关键词或ID', '红色'); const older = button(f, '查询商品').props.onClick(); await flush();
      const obsolete = f.calls.filter((call: any) => call.url === '/product/product/list').at(-1); await input(f, '搜索商品名称、关键词或ID', '蓝色'); await click(f, '查询商品'); expect(obsolete.signal.aborted).toBe(true);
      wait.resolve({ list: [product(51)], count: 21 }); await older; await flush(); expect(f.dialog.products.value.map((item: any) => item.id)).toEqual([52]); expect(f.dialog.productCount.value).toBe(1); expect(f.dialog.productLoading.value).toBe(false);
    } finally { wait.resolve({ list: [], count: 0 }); f.close(); }
  });

  it('loads the selected hidden product ID, discards older form reads and clears fields when the product or SKU changes', async () => {
    const wait = gate(), f = await mount(undefined, config => config.url === `${base}/fictitious_reply/51` ? wait.promise : undefined);
    try {
      await click(f, '添加自评'); const older = button(f, '选择商品', dialogNode(f, '添加自评')).props.onClick(); await flush();
      const oldRead = f.calls.find((call: any) => call.url === `${base}/fictitious_reply/51`); const buttons = walk(dialogNode(f, '添加自评')).filter(node => node.tag === 'button' && textOf(node) === '选择商品'); await buttons.at(-1)!.props.onClick(); await flush();
      wait.resolve(definition(51)); await older; await flush(); expect(oldRead.signal.aborted).toBe(true); expect(f.dialog.selected.value.id).toBe(52); expect(f.dialog.formReady.value).toBe(true);
      await selectSku(f, 'sku52001'); await fill(f); await click(f, '添加图片地址'); await input(f, '评价图片地址 1', '/uploads/a.png'); await selectSku(f, 'sku52002');
      expect(f.dialog.form).toMatchObject({ nickname: '', avatar: '', comment: '', pics: [], product_score: 0, service_score: 0, delivery_score: 0, add_time: '' }); expect(writes(f)).toEqual([]);
      await fill(f); const firstCell = walk(dialogNode(f, '添加自评')).find(node => node.tag === 'cell' && node.props.row === 51 && walk(node).some(child => child.tag === 'button'))!;
      const pending = button(f, '选择商品', firstCell).props.onClick(); await flush(); expect(f.dialog.skuUnique.value).toBe(''); expect(f.dialog.form.nickname).toBe(''); wait.resolve(definition(51)); await pending;
    } finally { wait.resolve(definition(51)); f.close(); }
  });

  it('blocks saving after a failed or mismatched form read and after corrupted SKU lists', async () => {
    const failed = await mount(undefined, config => config.url === `${base}/fictitious_reply/51` ? { ...definition(51), rules: [{ type: 'hidden', field: 'product_id', value: 52 }] } : undefined);
    try { await ready(failed); await fill(failed); expect(failed.text()).toContain('商品表单与当前选择不一致'); expect(button(failed, '添加自评并保存').props.disabled).toBe(true); await failed.dialog.save(); expect(writes(failed)).toEqual([]); } finally { failed.close(); }
    const polluted = await mount(undefined, config => config.url === '/product/product/list' ? { list: [{ ...product(), attrValue: [{ ...product().attrValue[0], type: 1 }] }], count: 1 } : undefined);
    try { await click(polluted, '添加自评'); expect(polluted.text()).toContain('商品规格已失效'); expect(polluted.dialog.products.value).toEqual([]); expect(writes(polluted)).toEqual([]); } finally { polluted.close(); }
    const unavailable = await mount(undefined, config => config.url === '/product/product/list' ? Promise.reject(Error('商品列表不可用')) : undefined);
    try { await click(unavailable, '添加自评'); expect(unavailable.text()).toContain('商品列表不可用'); expect(unavailable.dialog.productLoading.value).toBe(false); } finally { unavailable.close(); }
  });

  it('validates source Unicode limits, URLs, integer ratings, Shanghai calendar dates and the eight-picture cap through rendered controls', async () => {
    const f = await mount();
    try {
      await ready(f); await fill(f);
      for (const [placeholder, invalid, valid] of [['请输入自评用户名称', '😀'.repeat(65), '😀'.repeat(64)], ['请输入自评评价文字', '😀'.repeat(513), '😀'.repeat(512)], ['头像稳定图片地址', `/${'a'.repeat(255)}`, '/uploads/avatar.png']] as const) {
        await input(f, placeholder, invalid); await click(f, '添加自评并保存'); expect(writes(f)).toEqual([]); expect(f.dialog.error.value).not.toBe(''); await input(f, placeholder, valid);
      }
      for (const invalid of ['bad\u0001name', 'bad\ud800name']) { await input(f, '请输入自评用户名称', invalid); await click(f, '添加自评并保存'); expect(writes(f)).toEqual([]); } await input(f, '请输入自评用户名称', '😀'.repeat(64));
      for (const invalid of ['javascript:alert(1)', 'data:image/png;base64,a', '//example.test/a.png', 'https://user:secret@example.test/a.png', '/uploads/bad%00.png', 'https://example.test/a.png?signature=temp', '/api/assets/31?%65xpires=1900000000&%73ignature=abc', '/api/assets/31?%54oKeN=temp', 'https://example.test/a.png?%58-AmZ-%73iGnAtUrE=temp']) { await input(f, '头像稳定图片地址', invalid); await click(f, '添加自评并保存'); expect(writes(f)).toEqual([]); } await input(f, '头像稳定图片地址', 'http://example.test/avatar.png');
      const rate = f.nodes().find((node: Node) => node.tag === 'rate' && node.props['aria-label'] === '自评物流服务')!; rate.props.onRate(1.5); await flush(); await click(f, '添加自评并保存'); expect(writes(f)).toEqual([]); rate.props.onRate(3); await flush();
      const date = f.nodes().find((node: Node) => node.tag === 'date-range' && node.props.type === 'datetime')!;
      for (const invalid of ['2026-02-30 12:00:00', '2026-01-01 24:00:00', '2099-01-01 12:00:00', 'invalid']) { date.props.onChange(invalid); await flush(); await click(f, '添加自评并保存'); expect(writes(f)).toEqual([]); }
      date.props.onChange(null); await flush();
      for (let index = 1; index <= 8; index++) { await click(f, '添加图片地址'); await input(f, `评价图片地址 ${index}`, `/uploads/picture-${index}.png`); }
      expect(button(f, '添加图片地址').props.disabled).toBe(true); await f.dialog.addPicture(); expect(f.dialog.form.pics).toHaveLength(8);
      await input(f, '评价图片地址 1', '/api/assets/31?%65xpires=1900000000&%73ignature=abc'); await click(f, '添加自评并保存'); expect(writes(f)).toEqual([]); await input(f, '评价图片地址 1', '/uploads/picture-1.png');
      await click(f, '添加自评并保存'); const value = JSON.parse(writes(f)[0].data); expect(value.nickname).toBe('😀'.repeat(64)); expect(value.comment).toBe('😀'.repeat(512)); expect(value.avatar).toBe('http://example.test/avatar.png'); expect(value.add_time).toBe(''); expect(value.pics).toHaveLength(8);
    } finally { f.close(); }
  });

  it('treats a real 409 business response as a rejection and requires current product/SKU reselection', async () => {
    let rejected = true; const f = await mount(undefined, config => config.url === `${base}/save_fictitious_reply` && rejected ? { __envelope: { status: 409, msg: '商品或规格已变化' } } : undefined);
    try { await ready(f); await fill(f); await click(f, '添加自评并保存'); expect(writes(f)).toHaveLength(1); expect(f.text()).toContain('添加未完成：商品或规格已变化'); expect(f.view.writeUncertain.value).toBe(false); expect(f.dialog.selected.value).toBeNull();
      await f.dialog.save(); expect(writes(f)).toHaveLength(1); rejected = false; await click(f, '选择商品', dialogNode(f, '添加自评')); await selectSku(f); await fill(f); await click(f, '添加自评并保存'); expect(writes(f)).toHaveLength(2); expect(f.text()).toContain('管理员自评正文');
    } finally { f.close(); }
  });

  it('never replays an unknown creation outcome and clears the editor before a real counted-list reconciliation', async () => {
    const f = await mount(undefined, (config, fixture) => { if (config.url === `${base}/save_fictitious_reply`) { fixture.respond(config); throw Error('创建连接中断'); } });
    try { await ready(f); await fill(f); await click(f, '添加自评并保存'); expect(writes(f)).toHaveLength(1); expect(f.text()).toContain('添加结果尚未确认'); expect(button(f, '添加自评并保存').props.disabled).toBe(true);
      await f.dialog.save(); await f.view.openFictitious(); expect(writes(f)).toHaveLength(1); await click(f, '刷新评价核对'); expect(f.text()).toContain('管理员自评正文'); expect(f.view.writeUncertain.value).toBe(false); expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toEqual([]);
      await click(f, '添加自评'); expect(f.dialog.form.nickname).toBe(''); expect(f.dialog.selected.value).toBeNull(); expect(writes(f)).toHaveLength(1);
    } finally { f.close(); }
  });

  it('blocks duplicate clicks during creation and discards a late success after actual session replacement', async () => {
    const wait = gate(), f = await mount(undefined, (config, fixture) => config.url === `${base}/save_fictitious_reply` ? wait.promise.then(() => fixture.respond(config)) : undefined);
    try { await ready(f); await fill(f); const pending = button(f, '添加自评并保存').props.onClick(); await flush(); await f.dialog.save(); expect(writes(f)).toHaveLength(1); expect(button(f, '取消自评').props.disabled).toBe(true);
      login(['reply.view'], 'reply-admin-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); expect(f.view.fictitiousVisible.value).toBe(false); expect(f.dialog.form.nickname).toBe('');
      wait.resolve(undefined); await pending; await flush(); expect(runtime.dialogs.state.successes).toEqual([]); expect(writes(f)).toHaveLength(1); expect(f.view.canManage.value).toBe(false);
    } finally { wait.resolve(undefined); f.close(); }
  });

  it('clears and aborts selected form/media reads when reply.manage is withdrawn or the route product changes', async () => {
    const wait = gate(), f = await mount(undefined, config => config.url === '/file/file' ? wait.promise : undefined);
    try { await ready(f); await fill(f); const avatarField = f.nodes().find((node: Node) => node.tag === 'field' && node.props.label === '用户头像')!; const pending = button(f, '从图库选择', avatarField).props.onClick(); await flush();
      const read = f.calls.find((call: any) => call.url === '/file/file'); login(['reply.view', 'product.view', 'attachment.view'], 'reply-admin-a', 20); browser.dispatchEvent(new Event('admin-session-changed')); await flush();
      expect(read.signal.aborted).toBe(true); expect(f.dialog.selected.value).toBeNull(); expect(f.dialog.form.nickname).toBe(''); wait.resolve({ list: [asset(31)], count: 1 }); await pending; await flush(); expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toEqual([]); expect(writes(f)).toEqual([]);
    } finally { wait.resolve({ list: [], count: 0 }); f.close(); }
    const changed = await mount(); try { await ready(changed); await fill(changed); runtime.routing.route.query = { product_id: '52' }; await flush(); expect(changed.view.fictitiousVisible.value).toBe(false); expect(changed.dialog.form.nickname).toBe(''); expect(changed.view.query.product_id).toBe(52); expect(writes(changed)).toEqual([]); } finally { changed.close(); }
  });
});
