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
const thread = () => ({ ...comment(81, 0, 31), content: '<用户原评论>', user: { uid: 31, nickname: '小**明', avatar: '', is_money_level: 1, level_name: '普通会员', vip_status: 1 },
  children: { ...comment(82, 81), content: '原二级回复', user: { nickname: '平台站点', avatar: '' }, is_praise: false }, is_praise: false });
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
  for (const [name, tag] of Object.entries({ 'el-form': 'form', 'el-form-item': 'field', 'el-button': 'button', 'el-option': 'option', 'el-tag': 'tag', 'el-image': 'image' })) app.component(name, pass(tag));
  app.component('el-input', { inheritAttrs: false, props: ['modelValue', 'type'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h(props.type === 'textarea' ? 'textarea' : 'input', { ...attrs, value: props.modelValue, onInput: (event: any) => emit('update:modelValue', event.target.value) }); } });
  app.component('el-select', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit, slots }: any) { return () => runtime.h('select', { ...attrs, value: props.modelValue, onChange: (value: any) => emit('update:modelValue', value) }, slots.default?.()); } });
  app.component('el-date-picker', { inheritAttrs: false, props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { attrs, emit }: any) { return () => runtime.h('date-range', { ...attrs, value: props.modelValue, onChange: (value: any) => emit('update:modelValue', value) }); } });
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
async function mount(permissions = ['reply.view', 'reply.manage'], override: (config: any, fixture: any) => unknown = () => undefined) {
  login(permissions); const calls: any[] = [], fixture = { rows: [row()], roots: [thread()], count: 31, threadCount: 16,
    respond(config: any) {
      const body = config.data ? JSON.parse(config.data) : {};
      if (config.method === 'get') {
        if (config.url === base) return { list: structuredClone(fixture.rows), count: fixture.count };
        if (config.url === `${base}/get_reply/7`) return structuredClone(fixture.rows[0]?.replyComment ?? { content: '' });
        if (config.url === `${base}/comment/7`) return { list: structuredClone(fixture.roots), count: fixture.threadCount };
      }
      if (config.method === 'put') fixture.rows[0].replyComment = { ...comment(), content: body.content };
      if (config.method === 'post' && config.url === `${base}/save_comment/7/81`) fixture.roots[0].children = { ...fixture.roots[0].children, content: body.content };
      if (config.method === 'post' && config.url === '/reply/status/7') fixture.rows[0].status = body.status;
      if (config.method === 'delete' && config.url === `${base}/7`) { fixture.rows = []; fixture.count = 0; }
      if (config.method === 'delete' && config.url === `${base}/delete_comment/81`) { fixture.roots = []; fixture.threadCount = 0; }
      if (config.method === 'delete' && config.url === `${base}/delete_comment/82`) fixture.roots[0].children = null as any;
      return null;
    } };
  runtime.request.defaults.adapter = async (config: any) => { calls.push(config); const custom = await override(config, fixture);
    const result = custom === undefined ? fixture.respond(config) : custom;
    return { config, data: envelope(result), status: 200, statusText: 'fixture', headers: {} };
  };
  const node = (tag?: string, text?: string): Node => ({ tag, text, props: {}, children: [] });
  const renderer = runtime.createRenderer({ createElement: (tag: string) => node(tag), createText: (text: string) => node('#text', text), createComment: (text: string) => node('#comment', text),
    insert(child: Node, parent: Node, anchor?: Node) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child); },
    remove(child: Node) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = undefined; },
    parentNode: (child: Node) => child.parent, nextSibling: (child: Node) => child.parent?.children[child.parent.children.indexOf(child) + 1] ?? null,
    patchProp(child: Node, key: string, _previous: any, value: any) { child.props[key] = value; }, setText(child: Node, text: string) { child.text = text; }, setElementText(child: Node, text: string) { child.text = text; child.children = []; } });
  let view: any; const page = { ...runtime.Page, setup(props: any, context: any) { view = runtime.Page.setup(props, context); return view; } };
  const app = renderer.createApp(page), pinia = runtime.createPinia(), surface = node('root'); app.use(pinia); controls(app); app.mount(surface); await flush();
  return { view, fixture, calls, surface, nodes: () => walk(surface), text: () => textOf(surface), close() { app.unmount(); runtime.disposePinia(pinia); } };
}
const writes = (f: any) => f.calls.filter((config: any) => ['put', 'post', 'delete'].includes(config.method));
function button(f: any, label: string): Node { const result = f.nodes().find((node: Node) => node.tag === 'button' && textOf(node) === label); if (!result) throw Error(`Missing rendered button: ${label}`); return result; }
async function click(f: any, label: string) { const control = button(f, label); if (control.props.disabled || control.props.loading) return; await control.props.onClick(); await flush(); }
async function input(f: any, placeholder: string, value: string) { const control = f.nodes().find((node: Node) => ['input', 'textarea'].includes(node.tag ?? '') && node.props.placeholder === placeholder); if (!control) throw Error(`Missing rendered input: ${placeholder}`); control.props.onInput({ target: { value } }); await flush(); }

describe('actual rendered Admin moderation SFC and compiled Axios consumers', () => {
  it('renders snake-case legacy DTOs and routes a product entry to the counted 15-row list', async () => {
    runtime.routing.route.query = { product_id: '51' }; const f = await mount();
    try { expect(f.calls).toHaveLength(1); expect(f.calls[0]).toMatchObject({ method: 'get', url: base, baseURL: '/adminapi', params: { store_name: '', account: '', product_id: 51, is_reply: '', data: '', page: 1, limit: 15 } });
      expect(f.calls[0].headers['Authori-zation']).toBe('Bearer reply-admin-a'); expect(f.text()).toContain('供应商商品'); expect(f.text()).toContain('<评价正文>'); expect(f.text()).toContain('平台原回复'); expect(f.text()).toContain('综合 4');
      expect(f.nodes().find((node: Node) => node.tag === 'pagination')?.props.total).toBe(31); expect(f.text()).toContain('2026-10-14 09:00:00');
    } finally { f.close(); }
  });
  it('uses rendered query controls, Shanghai date strings, totals and real page events', async () => {
    const f = await mount(); try { await input(f, '商品名称、关键词或ID', '红色'); await input(f, '用户昵称', '小明'); await input(f, '全部商品', '51');
      f.nodes().find((node: Node) => node.tag === 'select')!.props.onChange(0);
      const dates = f.nodes().find((node: Node) => node.tag === 'date-range')!; expect(dates.props['value-format']).toBe('YYYY/MM/DD'); dates.props.onChange(['2026/10/01', '2026/10/14']); await click(f, '查询');
      expect(f.calls.at(-1).params).toEqual({ store_name: '红色', account: '小明', product_id: 51, is_reply: 0, data: '2026/10/01-2026/10/14', page: 1, limit: 15 });
      await f.nodes().find((node: Node) => node.tag === 'pagination')!.props.onPage(2); await flush(); expect(f.calls.at(-1).params.page).toBe(2);
      await click(f, '重置'); expect(f.calls.at(-1).params).toEqual({ store_name: '', account: '', product_id: 0, is_reply: '', data: '', page: 1, limit: 15 });
    } finally { f.close(); }
  });
  it('loads get_reply before the rendered primary editor submits the exact PUT content', async () => {
    const f = await mount(); try { await click(f, '平台回复'); expect(f.calls.at(-1).url).toBe(`${base}/get_reply/7`);
      expect(f.nodes().find((node: Node) => node.tag === 'textarea')?.props.value).toBe('平台原回复');
      await input(f, '请输入平台回复内容', ' 😀平台回复\n第二行 '); await click(f, '保存平台回复');
      expect(writes(f)).toHaveLength(1); expect(writes(f)[0]).toMatchObject({ method: 'put', url: `${base}/set_reply/7` }); expect(JSON.parse(writes(f)[0].data)).toEqual({ content: '😀平台回复\n第二行' });
      expect(f.text()).toContain('😀平台回复\n第二行'); expect(f.nodes().filter((node: Node) => node.tag === 'dialog')).toEqual([]);
    } finally { f.close(); }
  });
  it('retains known review and thread totals during delayed page loads so pagination cannot clamp back to one', async () => {
    const listWait = gate(), threadWait = gate(), f = await mount(undefined, (config, fixture) => {
      if (config.method === 'get' && config.url === base && config.params.page === 2) return listWait.promise.then(() => fixture.respond(config));
      if (config.method === 'get' && config.url === `${base}/comment/7` && config.params.page === 2) return threadWait.promise.then(() => fixture.respond(config));
    });
    try {
      const pendingList = f.view.changePage(2); await flush(); expect(f.view.query.page).toBe(2); expect(f.view.total.value).toBe(31); expect(f.calls.filter((config: any) => config.url === base)).toHaveLength(2);
      listWait.resolve(undefined); await pendingList; await click(f, '评论线程');
      const pendingThread = f.view.loadThreads(2); await flush(); expect(f.view.threadPage.value).toBe(2); expect(f.view.threadTotal.value).toBe(16);
      expect(f.calls.filter((config: any) => config.url === `${base}/comment/7`)).toHaveLength(2); threadWait.resolve(undefined); await pendingThread;
      expect(f.view.query.page).toBe(2); expect(f.view.threadPage.value).toBe(2);
    } finally { listWait.resolve(undefined); threadWait.resolve(undefined); f.close(); }
  });
  it('opens roots and their single child and saves through the rendered secondary editor', async () => {
    const f = await mount(); try { await click(f, '评论线程'); expect(f.calls.at(-1)).toMatchObject({ url: `${base}/comment/7`, params: { time: '', page: 1, limit: 15 } });
      expect(f.text()).toContain('小**明'); expect(f.text()).toContain('<用户原评论>'); expect(f.text()).toContain('原二级回复'); expect(f.text()).toContain('平台站点');
      await click(f, '回复评论'); expect(f.nodes().find((node: Node) => node.tag === 'textarea')?.props.value).toBe('原二级回复'); await input(f, '请输入评论回复内容', '新的二级回复'); await click(f, '保存评论回复');
      expect(writes(f)[0]).toMatchObject({ method: 'post', url: `${base}/save_comment/7/81` }); expect(JSON.parse(writes(f)[0].data)).toEqual({ content: '新的二级回复' }); expect(f.text()).toContain('新的二级回复');
      const dates = f.nodes().find((node: Node) => node.tag === 'date-range' && node.props.value === null && node !== f.nodes().find((entry: Node) => entry.tag === 'date-range'))!;
      dates.props.onChange(['2026/10/02', '2026/10/14']); await click(f, '查询评论'); expect(f.calls.at(-1).params).toEqual({ time: '2026/10/02-2026/10/14', page: 1, limit: 15 });
    } finally { f.close(); }
  });
  it('keeps modern hide/show and soft deletion while legacy threads delete exact IDs with empty bodies', async () => {
    const f = await mount(); try { await click(f, '隐藏'); expect(writes(f)[0]).toMatchObject({ method: 'post', url: '/reply/status/7' }); expect(JSON.parse(writes(f)[0].data)).toEqual({ status: 0 }); await click(f, '显示');
      await click(f, '评论线程'); await click(f, '删除回复'); expect(writes(f).at(-1)).toMatchObject({ method: 'delete', url: `${base}/delete_comment/82` }); expect(writes(f).at(-1).data).toBeUndefined();
      await click(f, '删除评论'); expect(writes(f).at(-1).url).toBe(`${base}/delete_comment/81`); expect(f.text()).toContain('暂无用户评论');
      await click(f, '删除评价'); expect(writes(f).at(-1)).toMatchObject({ method: 'delete', url: `${base}/7` }); expect(writes(f).at(-1).data).toBeUndefined(); expect(f.text()).toContain('暂无评价');
    } finally { f.close(); }
  });
  it('renders read-only actions and prevents direct write handlers without reply.manage', async () => {
    const f = await mount(['reply.view']); try { expect(f.text()).toContain('仅查看'); expect(() => button(f, '平台回复')).toThrow(); await click(f, '评论线程'); expect(() => button(f, '回复评论')).toThrow();
      await f.view.openReply(f.view.list.value[0]); await f.view.toggle(f.view.list.value[0]); await f.view.del(f.view.list.value[0]); await f.view.deleteComment(f.view.threads.value[0]); await f.view.saveReply(); await f.view.saveComment(); expect(writes(f)).toEqual([]);
    } finally { f.close(); }
    const denied = await mount(['product.view', 'product.manage']); try { expect(denied.calls).toEqual([]); expect(denied.text()).toContain('没有商品评价查看权限'); } finally { denied.close(); }
  });
  it('distinguishes user cancel from failed deletion and never replays an unknown write before a read', async () => {
    const f = await mount(undefined, config => { if (config.method === 'delete') throw Error('删除连接中断'); });
    try { runtime.dialogs.state.confirm = async () => { throw 'cancel'; }; await click(f, '删除评价'); expect(writes(f)).toEqual([]); expect(runtime.dialogs.state.errors).toEqual([]);
      runtime.dialogs.state.confirm = async () => {}; await click(f, '删除评价'); expect(writes(f)).toHaveLength(1); expect(f.text()).toContain('删除连接中断'); expect(f.view.writeUncertain.value).toBe(true);
      await f.view.del(f.view.list.value[0]); expect(writes(f)).toHaveLength(1); await click(f, '刷新'); expect(f.view.writeUncertain.value).toBe(false); expect(writes(f)).toHaveLength(1);
    } finally { f.close(); }
  });
  it('does not submit a primary editor whose detail read failed and displays load errors', async () => {
    const f = await mount(undefined, config => { if (config.url === `${base}/get_reply/7`) throw Error('详情已撤权'); });
    try { await click(f, '平台回复'); expect(f.text()).toContain('详情已撤权'); expect(button(f, '保存平台回复').props.disabled).toBe(true); await input(f, '请输入平台回复内容', '不得覆盖未知回复'); await f.view.saveReply(); expect(writes(f)).toEqual([]); } finally { f.close(); }
    const failed = await mount(undefined, () => { throw Error('列表不可用'); }); try { expect(failed.text()).toContain('列表不可用'); expect(failed.view.loading.value).toBe(false); } finally { failed.close(); }
  });
  it('counts Unicode code points and preserves primary zero while rejecting secondary zero and invalid input', async () => {
    const f = await mount(); try { await click(f, '平台回复'); await input(f, '请输入平台回复内容', '😀'.repeat(1000)); await click(f, '保存平台回复'); expect(JSON.parse(writes(f)[0].data).content).toBe('😀'.repeat(1000));
      await click(f, '平台回复'); await input(f, '请输入平台回复内容', '0'); await click(f, '保存平台回复'); expect(JSON.parse(writes(f)[1].data)).toEqual({ content: '0' });
      await click(f, '平台回复'); for (const value of ['😀'.repeat(1001), 'x\u0001y', 'x\u0085y', 'x\ud800y']) { await input(f, '请输入平台回复内容', value); await f.view.saveReply(); expect(writes(f)).toHaveLength(2); expect(f.view.replyError.value).not.toBe(''); }
      await click(f, '取消'); await click(f, '评论线程'); await click(f, '回复评论'); await input(f, '请输入评论回复内容', '0'); await click(f, '保存评论回复'); expect(writes(f)).toHaveLength(2); expect(f.text()).toContain('请输入回复内容');
    } finally { f.close(); }
  });
  it('rejects obsolete list and detail completions after a new filter or route query', async () => {
    const wait = gate(), f = await mount(undefined, config => config.url === `${base}/get_reply/7` ? wait.promise : undefined);
    try { const pending = f.view.openReply(f.view.list.value[0]); await flush(); runtime.routing.route.query = { product_id: '52' }; await flush(); wait.resolve(comment()); await pending; expect(f.view.replyVisible.value).toBe(false); expect(f.view.query.product_id).toBe(52); expect(f.calls.at(-1).params.product_id).toBe(52);
    } finally { wait.resolve(comment()); f.close(); }
  });
  it('blocks duplicate writes and discards results after actual Admin session replacement', async () => {
    const wait = gate(), f = await mount(undefined, (config, fixture) => config.method === 'put' ? wait.promise.then(() => fixture.respond(config)) : undefined);
    try { await click(f, '平台回复'); await input(f, '请输入平台回复内容', '待提交回复'); const pending = f.view.saveReply(); await flush(); await f.view.saveReply(); expect(writes(f)).toHaveLength(1); expect(button(f, '取消').props.disabled).toBe(true);
      login(['reply.view'], 'reply-admin-b', 21); browser.dispatchEvent(new Event('admin-session-changed')); await flush(); wait.resolve(undefined); await pending; expect(f.view.canManage.value).toBe(false); expect(f.view.replyVisible.value).toBe(false); expect(runtime.dialogs.state.successes).toEqual([]); expect(writes(f)).toHaveLength(1);
    } finally { wait.resolve(undefined); f.close(); }
  });
  it('rechecks context after delete confirmation and rejects malformed product routes without requests', async () => {
    const wait = gate(), f = await mount(); runtime.dialogs.state.confirm = () => wait.promise;
    try { const pending = f.view.del(f.view.list.value[0]); await flush(); await f.view.changePage(2); wait.resolve(undefined); await pending; expect(writes(f)).toEqual([]); } finally { wait.resolve(undefined); f.close(); }
    runtime.routing.route.query = { product_id: ['51', '52'] }; const bad = await mount(); try { expect(bad.calls).toEqual([]); expect(bad.text()).toContain('商品ID格式错误'); } finally { bad.close(); }
  });
});
