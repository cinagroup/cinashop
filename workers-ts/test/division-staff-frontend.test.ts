import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { DivisionStaffSession, divisionStaffDates, divisionStaffInviteReturnPath, normalizeDivisionStaffInviteInfo,
  normalizeDivisionStaffPage, parseDivisionStaffInviteRoute } from '../../view/common/divisionStaff';

const revision = 'a'.repeat(64);
const projection = () => ({ list: [{ uid: 44, nickname: '员工甲', avatar: '', phone: '13800000044', spread_uid: 22,
  spread_time: '2023/11/15', spreadTime: 1700000000, divisionPercent: 10, division_percent: 10, payCount: 0, pay_count: 0,
  childCount: 1, orderCount: 2, numberCount: '30.00', revision }], count: 1, page: 1, limit: 20, brokerage: '1.50',
  agent: { uid: 22, divisionPercent: 40, divisionEndTime: 1800000000 } });
const preview = (bound = false) => ({ agent: { uid: 22, name: '真实隔离代理' }, source: 'qrcode', codeId: 901,
  canBind: !bound, alreadyBound: bound, revision });
describe('employee projections and platform-independent invitation parser', () => {
  it('retains exact money/counts and preserves true parent/current-owner identity', () => {
    expect(normalizeDivisionStaffPage(projection(), 22, 1)).toMatchObject({ brokerage: '1.50', items: [{ uid: 44, percent: 10, children: 1, orders: 2, orderAmount: '30.00' }] });
    expect(() => normalizeDivisionStaffPage(projection(), 30, 1)).toThrow('所属用户');
  });
  it.each([{ division_percent: 11 }, { revision: 'forged' }, { childCount: -1 }, { numberCount: '0.001' }])('fails closed on malformed current employee field %j', update => {
    const p = projection(); Object.assign(p.list[0], update); expect(() => normalizeDivisionStaffPage(p, 22, 1)).toThrow();
  });
  it('uses inclusive Shanghai day epochs and rejects missing/reversed/invalid date filters', () => {
    expect(divisionStaffDates('2023-11-15', '2023-11-15')).toEqual({ start: 1699977600, stop: 1700063999 });
    for (const dates of [['', '2023-11-15'], ['2024-02-30', '2024-03-01'], ['2024-03-01', '2024-02-01']]) expect(() => divisionStaffDates(...dates as [string, string])).toThrow();
  });
  it('parses modern a and original numeric/id-spid scenes and retains legacy auto/expectedUID through return navigation', () => {
    const modern = parseDivisionStaffInviteRoute({ scene: 'a%3D901' }); expect(modern).toMatchObject({ agentCode: 901, agentId: 0, autoBind: false });
    const old = parseDivisionStaffInviteRoute({ scene: 'id%3D901%26spid%3D22' }); expect(old).toMatchObject({ agentCode: 901, expectedAgentId: 22, autoBind: true });
    expect(divisionStaffInviteReturnPath(old)).toBe('/pages/users/agent/bind?id=901&spid=22');
    expect(divisionStaffInviteReturnPath(parseDivisionStaffInviteRoute({ scene: '901' }))).toBe('/pages/users/agent/bind?id=901');
    expect(divisionStaffInviteReturnPath(modern)).toBe('/pages/users/agent/bind?a=901');
  });
  it.each([{ scene: 'a=901&a=902' }, { scene: 'id=901&spid=0' }, { scene: 'id%253D901' }, { a: '901', agent_id: '22' },
    { scene: 'https://untrusted.test/a=901' }, { scene: 'id=901&secret=1' }, { a: '0901' }, { scene: '9'.repeat(129) }])('rejects ambiguous/duplicate/unbounded/foreign invitation %j', input => {
    expect(() => parseDivisionStaffInviteRoute(input)).toThrow();
  });
  it('works without browser URL/URLSearchParams/TextEncoder/crypto capabilities', () => {
    for (const name of ['URL', 'URLSearchParams', 'TextEncoder', 'crypto']) vi.stubGlobal(name, undefined);
    expect(parseDivisionStaffInviteRoute({ scene: 'id%3D901%26spid%3D22' })).toMatchObject({ agentCode: 901, expectedAgentId: 22 });
    expect(normalizeDivisionStaffInviteInfo(preview(), parseDivisionStaffInviteRoute({ a: '901' }))).toMatchObject({ agentId: 22, codeId: 901 });
  });
  it('does not use spid as binding authority or accept another QR/agent preview', () => {
    const old = parseDivisionStaffInviteRoute({ id: '901', spid: '22' });
    expect(() => normalizeDivisionStaffInviteInfo({ ...preview(), agent: { uid: 30, name: 'foreign' } }, old)).toThrow('目标');
    expect(() => normalizeDivisionStaffInviteInfo({ ...preview(), codeId: 22 }, old)).toThrow('目标');
  });
  it('withdraws an actual late list response after a scope/owner reset', async () => {
    let resolve!: (value: unknown) => void; const pending = new Promise<unknown>(yes => { resolve = yes; });
    const session = new DivisionStaffSession(() => pending, () => {});
    const load = session.load({ keyword: '', start: 0, stop: 0, page: 1, limit: 20 }, { uid: 22, token: 'owner', version: 0 });
    session.reset(); resolve(projection()); await load; expect(session.state.result).toBeNull();
  });
});

let runtime: any, platform: any;
const closes: Array<() => void> = [];
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../view/uniapp-ts'), require = createRequire(resolve(root, 'package.json'));
  const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
  for (const file of ['staff_list.vue', 'bind.vue']) {
    const filename = resolve(root, 'src/pages/users/agent', file), descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
    expect(compileTemplate({ source: descriptor.template.content, filename, id: 'staff-proof' }).errors).toEqual([]);
  }
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `export {default as StaffPage} from './src/pages/users/agent/staff_list.vue';export {default as BindPage} from './src/pages/users/agent/bind.vue';export {createRenderer,reactive,nextTick} from 'vue';` },
    alias: { '@': resolve(root, 'src') }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'division-staff-native-fixture', setup(builder) {
      builder.onResolve({ filter: /^@dcloudio\/uni-app$/ }, () => ({ path: 'hooks', namespace: 'staff-native' }));
      builder.onResolve({ filter: /(?:^@\/stores\/auth$|[\\/]stores[\\/]auth(?:\.ts)?$)/ }, () => ({ path: 'auth', namespace: 'staff-native' }));
      builder.onResolve({ filter: /ThemePage\.vue$/ }, () => ({ path: 'theme', namespace: 'staff-native' }));
      builder.onLoad({ filter: /.*/, namespace: 'staff-native' }, ({ path }) => ({ contents: path === 'hooks'
        ? `export const onLoad=fn=>globalThis.__divisionStaffPlatform.hooks.load.push(fn);export const onShow=fn=>globalThis.__divisionStaffPlatform.hooks.show.push(fn);export const onHide=fn=>globalThis.__divisionStaffPlatform.hooks.hide.push(fn);export const onUnload=fn=>globalThis.__divisionStaffPlatform.hooks.unload.push(fn);`
        : path === 'auth' ? `export const useAuthStore=()=>globalThis.__divisionStaffPlatform.auth;` : `export default {render:()=>null};` }));
      builder.onLoad({ filter: /\.vue$/ }, ({ path }) => ({ contents: compileScript(parse(readFileSync(path, 'utf8'), { filename: path }).descriptor, { id: 'staff-proof' }).content, loader: 'ts' }));
    } }] });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}, 30000);
beforeEach(() => {
  if (!runtime) return;
  platform = { auth: runtime.reactive({ uid: 22, token: 'synthetic-staff-owner', sessionVersion: 0, isLoggedIn: true,
    clear() { this.uid = 0; this.token = ''; this.sessionVersion++; this.isLoggedIn = false; } }),
    hooks: { load: [], show: [], hide: [], unload: [] }, calls: [], modal: null, sender: null, bound: false, removed: false, navigations: [] };
  vi.stubGlobal('__divisionStaffPlatform', platform); vi.stubGlobal('location', { origin: 'http://employee.local' });
  vi.stubGlobal('uni', { request(call: any) {
    platform.calls.push(call); if (platform.sender?.(call)) return;
    const path = call.url.split('?')[0]; let data: unknown = null;
    if (path.endsWith('/staff_list')) { const p = projection(); p.page = call.data.page; if (platform.removed) { p.list = []; p.count = 0; } data = p; }
    else if (path.endsWith('/bind_info')) data = preview(platform.bound);
    else if (path.endsWith('/spread')) platform.bound = true;
    else if (path.endsWith('/staff/44')) platform.removed = true;
    else if (path.endsWith('/spread/code')) data = { url: `http://employee.local/api/division/agent/spread/code/image/22?expires=${Math.floor(Date.now() / 1000) + 600}&signature=${revision}`, expires: Math.floor(Date.now() / 1000) + 600 };
    call.success({ statusCode: 200, data: { status: 200, msg: 'ok', data }, header: {} });
  }, showModal(call: any) { platform.modal = call; }, navigateTo({ url }: any) { platform.navigations.push(url); }, showToast() {}, getStorageSync: () => '', setStorageSync() {}, removeStorageSync() {} });
});
afterEach(() => { while (closes.length) closes.pop()!(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); await runtime.nextTick(); } };
function mount(component: any) {
  const renderer = runtime.createRenderer({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ ...component, render: () => null }); app.mount({}); closes.push(() => app.unmount()); return app._instance.setupState;
}
async function show(component: any, options: Record<string, string> = {}) { const page = mount(component); for (const fn of platform.hooks.load) fn(options); for (const fn of platform.hooks.show) fn(); await flush(); return page; }
describe('actual compiled employee pages, real request adapter and restored invitation lifecycle', () => {
  it('sends genuine date scope and immutable revision commands, then reads deletion result instead of optimistic splicing', async () => {
    const page = await show(runtime.StaffPage); page.startDate = '2023-11-15'; page.stopDate = '2023-11-15'; page.search(); await flush();
    expect(platform.calls.filter((call: any) => call.url.endsWith('/staff_list')).at(-1).data).toMatchObject({ start: 1699977600, stop: 1700063999 });
    page.remove(page.state.result.items[0]); expect(platform.calls.some((call: any) => call.method === 'DELETE')).toBe(false);
    await platform.modal.success({ confirm: true }); await flush();
    expect(platform.calls.find((call: any) => call.method === 'DELETE').data).toEqual({ revision }); expect(page.state.result.items).toEqual([]);
  });
  it('rejects stale delete confirmation after same-UID session replacement', async () => {
    const page = await show(runtime.StaffPage); page.remove(page.state.result.items[0]); const modal = platform.modal;
    platform.auth.sessionVersion++; await flush(); await modal.success({ confirm: true }); await flush();
    expect(platform.calls.some((call: any) => call.method === 'DELETE')).toBe(false);
  });
  it('validates strict lower ratio and never revives a hidden employee read', async () => {
    const page = await show(runtime.StaffPage); page.beginPercent(page.state.result.items[0]); page.percent = '40'; await page.savePercent();
    expect(platform.calls.some((call: any) => call.url.endsWith('/staff_percent'))).toBe(false); page.percent = '0'; await page.savePercent(); await flush();
    expect(platform.calls.find((call: any) => call.url.endsWith('/staff_percent')).data).toEqual({ uid: 44, division_percent: 0, revision });
    let delayed: any; platform.sender = (call: any) => { if (call.url.endsWith('/staff_list')) { delayed = call; return true; } }; page.refresh();
    for (const fn of platform.hooks.hide) fn(); delayed.success({ statusCode: 200, data: { status: 200, data: projection() } }); await flush(); expect(page.state.result).toBeNull();
  });
  it('withdraws late signed invitation after hide and supports API/scene without web globals', async () => {
    const page = await show(runtime.StaffPage); for (const name of ['URL', 'URLSearchParams', 'TextEncoder', 'crypto']) vi.stubGlobal(name, undefined);
    await page.loadInvite(); await flush(); expect(page.inviteImage).toContain('/image/22?expires=');
    for (const fn of platform.hooks.hide) fn(); expect(page.inviteImage).toBe('');
  });
  it('previews modern actual QRid901 then explicitly binds with QR authority and re-reads real relationship', async () => {
    platform.auth.uid = 77;
    const page = await show(runtime.BindPage, { scene: 'a%3D901' }); expect(page.info.agentId).toBe(22);
    expect(platform.calls.some((call: any) => call.url.endsWith('/spread'))).toBe(false);
    await page.confirmBind(); await flush(); expect(platform.calls.find((call: any) => call.url.endsWith('/spread')).data).toEqual({ agent_code: 901, invite_revision: revision });
    expect(page.info.alreadyBound).toBe(true);
  });
  it.each(['901', 'id%3D901%26spid%3D22'])('restores original authenticated numeric/id-spid scene once: %s', async scene => {
    platform.auth.uid = 77; const page = await show(runtime.BindPage, { scene });
    expect(platform.calls.filter((call: any) => call.url.endsWith('/spread'))).toHaveLength(1); expect(page.info.alreadyBound).toBe(true);
    for (const fn of platform.hooks.show) fn(); await flush(); expect(platform.calls.filter((call: any) => call.url.endsWith('/spread'))).toHaveLength(1);
  });
  it('preserves legacy scene/spid intent across login hide/identity update/return and still binds once after real target preview', async () => {
    platform.auth.uid = 0; platform.auth.token = ''; platform.auth.isLoggedIn = false;
    const page = await show(runtime.BindPage, { scene: 'id%3D901%26spid%3D22' }); expect(platform.calls).toEqual([]);
    page.login(); for (const fn of platform.hooks.hide) fn();
    platform.auth.uid = 77; platform.auth.token = 'new-authenticated-login'; platform.auth.sessionVersion++; platform.auth.isLoggedIn = true; await flush();
    for (const fn of platform.hooks.show) fn(); await flush();
    expect(platform.navigations).toEqual(['/pages/auth/login']);
    expect(platform.calls.filter((call: any) => call.url.endsWith('/spread'))).toHaveLength(1);
    expect(platform.calls.find((call: any) => call.url.endsWith('/spread')).data).toEqual({ agent_code: 901, invite_revision: revision }); expect(page.info.alreadyBound).toBe(true);
  });
  it('blocks mismatched old spid without any binding', async () => {
    platform.auth.uid = 77; const page = await show(runtime.BindPage, { id: '901', spid: '30' }); expect(page.error).toContain('目标');
    expect(platform.calls.some((call: any) => call.url.endsWith('/spread'))).toBe(false);
  });
  it('withdraws a late preview after non-login owner replacement without replaying legacy auto-binding', async () => {
    platform.auth.uid = 77;
    let delayed: any;
    platform.sender = (call: any) => { if (call.url.endsWith('/bind_info')) { delayed ??= call; return true; } };
    const page = await show(runtime.BindPage, { id: '901', spid: '22' });
    expect(delayed).toBeTruthy();
    platform.auth.uid = 65; platform.auth.token = 'replacement-owner'; platform.auth.sessionVersion++; await flush();
    delayed.success({ statusCode: 200, data: { status: 200, data: preview() }, header: {} }); await flush();
    expect(page.info).toBeNull();
    expect(platform.calls.some((call: any) => call.url.endsWith('/spread'))).toBe(false);
  });
  it('reads ambiguous committed binding after transport loss and never automatically repeats the identity write', async () => {
    platform.auth.uid = 77; platform.sender = (call: any) => { if (call.url.endsWith('/spread')) { platform.bound = true; call.fail({ errMsg: 'synthetic lost response' }); return true; } };
    const page = await show(runtime.BindPage, { scene: '901' }); expect(page.info.alreadyBound).toBe(true);
    await page.readInvite(); await flush(); expect(platform.calls.filter((call: any) => call.url.endsWith('/spread'))).toHaveLength(1);
  });
});
