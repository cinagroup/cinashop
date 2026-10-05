import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../view/admin-ts');
const require = createRequire(resolve(root, 'package.json'));
const { parse, compileScript } = require('@vue/compiler-sfc');
let runtime: any;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/member', href: '' } }));
  const result = await build({ absWorkingDir: root,
    stdin: { resolveDir: root, contents: `
      export { default as Page } from './src/pages/user/PaidMembership.vue';
      export { default as request } from './src/utils/request';
      export * as api from './src/api/membership';
      export { createRenderer, nextTick } from 'vue'; export * as messages from 'element-plus';
    ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.DEV': 'false' },
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'member-record-runtime', setup(builder) {
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({
        contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'member-record' }).content,
        loader: 'ts',
      }));
      builder.onResolve({ filter: /^element-plus$/ }, () => ({ path: 'messages', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const state = { errors: [], warnings: [], successes: [] };
        export const ElMessage = {
          error: value => state.errors.push(value), warning: value => state.warnings.push(value),
          success: value => state.successes.push(value),
        };
        export const ElMessageBox = { confirm: () => Promise.resolve() };
      ` }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
});

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { pathname: '/member', href: '' } }));
  runtime.messages.state.errors = [];
});
afterEach(() => vi.unstubAllGlobals());

const flush = async () => { for (let i = 0; i < 8; i++) { await new Promise(done => setTimeout(done, 1)); await runtime.nextTick(); } };
const record = { id: 4, uid: 7, type: 2, order_id: 'hy-card', member_type: 'free', member_title: '卡密激活',
  member_plan_type: 'free', pay_type: '', pay_price: '0.00', member_price: '0.00', paid: 1, pay_time: 1790550000,
  channel_type: 'h5', is_free: 0, is_permanent: 0, overdue_time: 1793142000, vip_day: 30,
  add_time: 1790546400, code_masked: 'CARD****1234', username: '上海会员', phone: '13800000007' };

async function mount() {
  const calls: any[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(config);
    const data = config.url === '/member/ship'
      ? { list: [{ id: 2, title: '年度会员', type: 'year', is_del: 0 }], count: 1 }
      : config.url === '/member/record' ? { list: [record], count: 1 }
        : { list: [], count: 0 };
    return { config, data: { status: 200, msg: 'ok', data }, status: 200, statusText: 'isolated member fixture', headers: {} };
  };
  let view: any;
  const renderer = runtime.createRenderer({ createElement: () => ({ children: [] }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), insert(node: any, parent: any) { node.parent = parent; (parent.children ??= []).push(node); },
    remove() {}, parentNode: (node: any) => node.parent, nextSibling: () => null, patchProp() {}, setText() {}, setElementText() {} });
  const app = renderer.createApp({ setup(props: unknown, context: unknown) { view = runtime.Page.setup(props, context); return () => null; } });
  app.mount({ children: [] }); await flush();
  return { calls, view, close: () => app.unmount() };
}

it('loads active plan choices and translates legacy card/free record semantics without writing', async () => {
  const f = await mount();
  try {
    expect(f.view.recordPlanOptions.value).toEqual([{ value: '2', label: '年度会员' }]);
    expect(f.view.recordPayLabel(record)).toBe('卡密领取');
    expect(f.view.recordPayLabel({ ...record, type: 1, is_free: 1 })).toBe('免费领取');
    expect(f.view.recordExpiryLabel({ ...record, member_plan_type: 'ever' })).toBe('永久');
    expect(f.view.recordExpiryLabel(record)).not.toBe('—');
    expect(f.calls.every(call => call.method === 'get')).toBe(true);
    const template = readFileSync(resolve(root, 'src/pages/user/PaidMembership.vue'), 'utf8');
    expect(template).toContain('value="card"');
    expect(template).toContain('value="free"');
    expect(template).toContain('label="到期时间"');
  } finally { f.close(); }
});

it('sends member type, free payment and inclusive Shanghai purchase-minute bounds', async () => {
  const f = await mount();
  try {
    f.view.recordQuery.name = '  上海  ';
    f.view.recordQuery.member_type = 'card';
    f.view.recordQuery.pay_type = 'free';
    f.view.recordQuery.purchase_time = ['2026-09-28 09:15', '2026-09-28 10:30'];
    f.view.resetRecords(); await flush();
    expect(f.calls.filter(call => call.url === '/member/record').at(-1).params).toMatchObject({
      name: '上海', member_type: 'card', pay_type: 'free', page: 1, limit: 20,
      start_time: 1790558100, end_time: 1790562659,
    });
    expect(f.calls.every(call => call.method === 'get')).toBe(true);
  } finally { f.close(); }
});

it('rejects invalid Shanghai date ranges before issuing a record request', async () => {
  const f = await mount();
  try {
    const before = f.calls.filter(call => call.url === '/member/record').length;
    f.view.recordQuery.purchase_time = ['2026-02-30 10:00', '2026-03-01 10:00'];
    f.view.resetRecords(); await flush();
    expect(f.calls.filter(call => call.url === '/member/record')).toHaveLength(before);
    expect(runtime.messages.state.errors.at(-1)).toContain('格式错误');
    expect(() => runtime.api.membershipRecordParams({ name: '', member_type: '', pay_type: '',
      purchase_time: ['2026-09-28 10:31', '2026-09-28 10:30'] }, 1)).toThrow('结束时间');
  } finally { f.close(); }
});

it('loads every active plan page instead of silently omitting plan 101', async () => {
  const calls: number[] = [];
  runtime.request.defaults.adapter = async (config: any) => {
    calls.push(Number(config.params.page));
    const page = Number(config.params.page);
    const list = Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({ id: (page - 1) * 100 + index + 1,
      title: `套餐 ${String((page - 1) * 100 + index + 1)}`, type: 'month', is_del: 0 }));
    return { config, data: { status: 200, msg: 'ok', data: { list, count: 101 } }, status: 200, statusText: 'isolated plan fixture', headers: {} };
  };
  const options = await runtime.api.apiMembershipRecordPlanOptions();
  expect(options).toHaveLength(101);
  expect(options.at(-1)).toEqual({ value: '101', label: '套餐 101' });
  expect(calls).toEqual([1, 2]);
});
