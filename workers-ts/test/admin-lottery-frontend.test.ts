import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any, browser: EventTarget;
const envelope = (data: unknown) => ({ status: 200, msg: 'ok', data });
const activity = { id: 7, name: '秋日抽奖', status: 1, factor: 1, time_status: 1,
  lottery_all: 40, lottery_people: 25, lottery_win: 8, startTime: 1790510000, endTime: 1790596400 };
const record = { id: 44, uid: 19, lotteryId: 7, type: 6, isReceive: 1, isDeliver: 0,
  receiveTime: 0, deliverTime: 0, addTime: 1790510000, user: { uid: 19, nickname: '中奖用户', phone: '13800000000' },
  lottery: { id: 7, name: '秋日抽奖', factor: 1 }, prize: { type: 6, name: '礼盒', image: '/gift.png' },
  deliver_info: { mark: '待处理', deliver_name: '秘密快递', deliver_number: '123' },
  receive_info: { address: '不应显示的地址' } };

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1280, location: { pathname: '/marketing/lottery', href: '' } }));
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export { default as LotteryList } from './src/pages/activity/LotteryList.vue';
    export { default as LotteryRecords } from './src/pages/marketing/LotteryRecords.vue';
    export { default as request } from './src/utils/request';
    export * as api from './src/api/lottery';
    export { createRenderer, nextTick } from 'vue';
    export { createPinia } from 'pinia';
    export { createRouter, createMemoryHistory } from 'vue-router';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' }, bundle: true, write: false,
    platform: 'browser', format: 'esm', plugins: [{ name: 'lottery-runtime', setup(builder) {
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'element-plus', namespace: 'lottery-test' }));
      builder.onLoad({ filter: /.*/, namespace: 'lottery-test' }, () => ({ contents: `
        export const ElMessage = { error() {}, success() {} };
        export const ElMessageBox = { confirm: async () => 'confirm' };
      `, loader: 'js' }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor,
        { id: 'lottery-runtime' }).content, loader: 'ts' }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

function login(permissions: string[], token = 'lottery-token-a', id = 31) {
  localStorage.setItem('admin_token', token);
  localStorage.setItem('admin_session', JSON.stringify({ userInfo: { id, account: 'operator', level: 1, roles: '' },
    menus: [], uniqueAuth: permissions }));
}

beforeEach(() => {
  const values = new Map<string, string>();
  browser = new EventTarget();
  vi.stubGlobal('window', Object.assign(browser, { innerWidth: 1280, location: { pathname: '/marketing/lottery', href: '' } }));
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

async function mount(kind: 'list' | 'records', permissions: string[], route = '/marketing/lottery-records',
  respond: (config: any) => Promise<unknown> | unknown = () => undefined) {
  login(permissions);
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const custom = await respond(config);
    const data = custom ?? envelope(config.url === '/lottery/list' ? { list: [activity], count: 1, page: Number(config.params.page), limit: 15 } :
      config.url.startsWith('/lottery/record/detail/') ? { id: 44, type: 6,
        deliver_info: { deliver_name: '顺丰', deliver_number: 'SF123', mark: '待处理' } } :
      { list: [record], count: 1, page: Number(config.params.page), limit: 15 });
    return { config, data, status: 200, statusText: 'isolated lottery fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const component = kind === 'list' ? runtime.LotteryList : runtime.LotteryRecords;
  const router = runtime.createRouter({ history: runtime.createMemoryHistory(), routes: [
    { path: '/marketing/lottery', component }, { path: '/marketing/lottery-records', component },
  ] });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = component.setup(props, context); return () => null; } });
  app.use(runtime.createPinia()); app.use(router); await router.push(route); await router.isReady();
  app.mount({ children: [] }); await flush();
  return { view, calls, router, close: () => app.unmount() };
}

it('separates activity viewing, activity writes and record access', async () => {
  const denied = await mount('list', ['lottery_record.view']);
  try { expect(denied.calls).toEqual([]); expect(denied.view.canView.value).toBe(false); } finally { denied.close(); }
  const viewer = await mount('list', ['lottery.view']);
  try {
    expect(viewer.calls.map(call => call.url)).toEqual(['/lottery/list']);
    expect(viewer.calls[0].params).toMatchObject({ page: 1, limit: 15 });
    expect(viewer.view.canManage.value).toBe(false);
    expect(viewer.view.canRecordView.value).toBe(false);
    await viewer.view.openForm(activity);
    await viewer.view.toggleStatus(activity);
    expect(viewer.calls).toHaveLength(1);
  } finally { viewer.close(); }
  const recordsLink = await mount('list', ['lottery.view', 'lottery_record.view']);
  try { expect(recordsLink.view.canRecordView.value).toBe(true); } finally { recordsLink.close(); }
});

it('lists the old activity phase and three participation statistics with 15-row pagination', async () => {
  const f = await mount('list', ['lottery.view']);
  try {
    f.view.query.startStatus = -1;
    f.view.query.name = '  7  ';
    f.view.search(); await flush();
    expect(f.calls.at(-1).params).toMatchObject({ page: 1, limit: 15, start_status: -1, name: '7' });
    expect(f.view.list.value[0]).toMatchObject({ lottery_all: 40, lottery_people: 25, lottery_win: 8 });
    expect(readFileSync(resolve(root, 'src/pages/activity/LotteryList.vue'), 'utf8')).toContain('lottery_people');
  } finally { f.close(); }
});

it('loads independent record pages, filters by a closed Shanghai date range and hides logistics in list data', async () => {
  const denied = await mount('records', ['lottery.view']);
  try { expect(denied.calls).toEqual([]); expect(denied.view.canView.value).toBe(false); } finally { denied.close(); }
  const f = await mount('records', ['lottery_record.view'], '/marketing/lottery-records?lottery_id=7');
  try {
    expect(f.calls[0].url).toBe('/lottery/record/list/7');
    expect(f.calls[0].params).toMatchObject({ lottery_id: 7, page: 1, limit: 15 });
    expect(f.view.canManage.value).toBe(false);
    expect(f.view.records.value[0].user.phone).toBeUndefined();
    expect(f.view.records.value[0].receive_info).toBeUndefined();
    expect(f.view.records.value[0].deliver_info).toEqual({ mark: '待处理' });
    await f.view.openDeliver(f.view.records.value[0]);
    expect(f.calls).toHaveLength(1);
    f.view.draftFactor.value = 1; f.view.draftType.value = 6; f.view.draftKeyword.value = ' 中奖 ';
    f.view.draftDates.value = ['2026-09-28', '2026-09-29'];
    f.view.draftReceive.value = 1; f.view.draftDeliver.value = 0;
    f.view.search(); await flush();
    expect(f.calls.at(-1).params).toMatchObject({ factor: 1, type: 6, keyword: '中奖',
      is_receive: 1, is_deliver: 0, start_time: runtime.api.shanghaiLotteryDay('2026-09-28'),
      end_time: runtime.api.shanghaiLotteryDay('2026-09-29', true) });
    await f.view.load(2); expect(f.calls.at(-1).params.page).toBe(2);
  } finally { f.close(); }
});

it('fetches manage-only fulfillment detail before editing and never lets a late old-session page repopulate', async () => {
  const f = await mount('records', ['lottery_record.view', 'lottery_record.manage']);
  try {
    await f.view.openDeliver(f.view.records.value[0]);
    expect(f.calls.at(-1).url).toBe('/lottery/record/detail/44');
    expect(f.view.deliverForm.deliver_number).toBe('SF123');
    await f.view.submitDeliver(); await flush();
    expect(f.calls.some(call => call.url === '/lottery/record/deliver' && call.method === 'post')).toBe(true);
  } finally { f.close(); }
  const delayed = deferred();
  const stale = await mount('records', ['lottery_record.view'], '/marketing/lottery-records', async config => {
    if (config.url === '/lottery/record/list' && config.params.page === 2) {
      await delayed.promise;
      return envelope({ list: [record], count: 16, page: 2, limit: 15 });
    }
    return undefined;
  });
  try {
    const pending = stale.view.load(2);
    // A same-token session replacement can arrive before the browser emits storage.
    login(['lottery.view'], 'lottery-token-a', 32);
    delayed.resolve(); await pending; await flush();
    expect(stale.view.records.value).toEqual([]);
    expect(stale.view.canView.value).toBe(false);
  } finally { stale.close(); }
});

it('updates a shipped record remark without resubmitting unchanged tracking information', async () => {
  const shipped = await mount('records', ['lottery_record.manage'], '/marketing/lottery-records', config =>
    config.url === '/lottery/record/list'
      ? envelope({ list: [{ ...record, isDeliver: 1 }], count: 1, page: Number(config.params.page), limit: 15 })
      : undefined);
  try {
    await shipped.view.openDeliver(shipped.view.records.value[0]);
    shipped.view.deliverForm.mark = '已回访';
    await shipped.view.submitDeliver();
    const write = shipped.calls.find(call => call.url === '/lottery/record/deliver');
    expect(JSON.parse(write.data)).toMatchObject({ id: 44, mark: '已回访', deliver_name: '', deliver_number: '' });
  } finally { shipped.close(); }
});

it('clears activity detail and record rows when storage changes account or permissions under the same token', async () => {
  const delayed = deferred();
  const list = await mount('list', ['lottery.view', 'lottery.manage'], '/marketing/lottery', async config => {
    if (config.url === '/lottery/detail/7') { await delayed.promise; return envelope({ ...activity, prize: [] }); }
    return undefined;
  });
  try {
    const pending = list.view.openForm(activity);
    login(['lottery.view'], 'lottery-token-a', 34);
    const event = Object.assign(new Event('storage'), { key: 'admin_session' });
    browser.dispatchEvent(event);
    delayed.resolve(); await pending; await flush();
    expect(list.view.formVisible.value).toBe(false);
    expect(list.view.canManage.value).toBe(false);
    expect(list.view.list.value[0].id).toBe(7);
  } finally { list.close(); }
  const records = await mount('records', ['lottery_record.view']);
  try {
    login(['lottery.view'], 'lottery-token-a', 35);
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'admin_session' }));
    await flush();
    expect(records.view.records.value).toEqual([]);
    expect(records.view.canView.value).toBe(false);
  } finally { records.close(); }
});

it('rejects invalid activity IDs and impossible dates before requests', async () => {
  expect(() => runtime.api.shanghaiLotteryDay('2026-02-30')).toThrow();
  expect(() => runtime.api.normalizeLotteryRecordQuery({ page: 1, limit: 15, start_time: 100, end_time: 99 })).toThrow();
  const orphan = runtime.api.parseLotteryRecordPage({ list: [{ ...record, lottery: null, prize: null,
    user: { uid: 0, nickname: '用户已注销', is_deleted: true } }], count: 1, page: 1, limit: 15 }, { page: 1, limit: 15 });
  expect(orphan.list[0].lottery).toBeNull();
  expect(orphan.list[0].prize.name).toBe('');
  expect(orphan.list[0].user.is_deleted).toBe(true);
  const f = await mount('records', ['lottery_record.view']);
  try {
    const original = f.calls.length;
    f.view.draftLotteryId.value = '7x'; f.view.search(); await flush();
    expect(f.calls).toHaveLength(original);
    f.view.draftLotteryId.value = '';
    f.view.draftFactor.value = '';
    f.view.draftType.value = '';
    f.view.draftDates.value = null;
    f.view.draftReceive.value = '';
    f.view.draftDeliver.value = '';
    f.view.search(); await flush();
    expect(f.calls.at(-1).params.factor).toBeUndefined();
    expect(f.calls.at(-1).params.type).toBeUndefined();
    expect(f.calls.at(-1).params.start_time).toBeUndefined();
  } finally { f.close(); }
});
