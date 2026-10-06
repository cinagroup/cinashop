const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict'), Module = require('node:module');
const { parse, compileScript } = require('@vue/compiler-sfc'), esbuild = require('esbuild'), vue = require('vue');
const app = path.resolve(__dirname, '..'), root = path.resolve(app, '../..');
const attempt = process.argv[2] || 'direct'; if (!/^[-a-z0-9]+$/.test(attempt)) throw Error('Closed attempt');
const compiledFile = path.join(root, `.cache/kefu-mobile-fe-runtime-${attempt}-20261003.bundle.cjs`);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceFile = path.join(app, 'src/pages/WorkbenchPage.vue'), sourceBytes = fs.readFileSync(sourceFile);
const descriptor = parse(sourceBytes.toString('utf8'), { filename: sourceFile }).descriptor;
const compiled = compileScript(descriptor, { id: 'kefu-runtime' }).content + '\nexport { announceKefuSessionChange } from "@/services/session";';
function storage() { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; }
const row = (domain = 0, id = domain + 1) => ({ id, user_id: 1001, to_uid: 9, nickname: domain ? '游客九' : '用户九', avatar: '', phone: domain ? '' : '13900000009', is_tourist: domain, online: 1, type: 0, add_time: 1, update_time: id, mssage_num: 2, message: '最新消息', message_type: 1 });
const msg = (id, domain = 0, type = 1, content = `message-${id}`) => ({ id, uid: 9, to_uid: 1001, is_tourist: domain, add_time: id, type: 0, msn_type: type, msn: content });
function deferred() { let resolve, reject; return { promise: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject }; }
async function settle() { await vue.nextTick(); for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); }
const cases = [], results = []; function test(name, run) { cases.push({ name, run }); }
let bundleCode;
async function fixture(overrides = {}) {
  const sockets = [], mounted = [], unmounted = [], calls = [];
  const target = new EventTarget(); Object.assign(target, { location: { origin: 'http://127.0.0.1:5298', search: '' }, setTimeout, clearTimeout, setInterval, clearInterval, matchMedia: () => ({ matches: false }) });
  global.window = target; global.sessionStorage = storage(); global.localStorage = storage(); sessionStorage.setItem('cinashop_kefu_token', 'runtime-agent');
  class Socket extends EventTarget {
    static OPEN = 1; static CONNECTING = 0; constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }); }
    send(value) { if (this.failSend) throw Error('socket send failed'); this.sent.push(JSON.parse(value)); }
    close(code = 1000) { this.readyState = 3; const event = new Event('close'); event.code = code; this.dispatchEvent(event); }
    message(value) { const event = new Event('message'); event.data = JSON.stringify(value); this.dispatchEvent(event); }
  }
  global.WebSocket = Socket;
  const route = vue.reactive({ path: '/mobile_list', fullPath: '/mobile_list', query: {}, meta: { mobileMode: 'list' } });
  const router = { async push(value) { calls.push(['route', value]); const url = typeof value === 'string' ? value : value.path; route.path = url; route.query = typeof value === 'string' ? {} : value.query || {}; route.meta = url.includes('mobile_list') ? { mobileMode: 'list' } : url.includes('mobile_chat') ? { mobileMode: 'chat' } : {}; route.fullPath = url + '?' + new URLSearchParams(route.query); }, async replace(value) { return this.push(value); } };
  const customer = { uid: 9, nickname: '用户九', avatar: '', spread_uid: 0, spread_name: '', is_promoter: 0, birthday: '', now_money: '0', user_type: 'h5', level: 0, level_name: '', group_id: 0, group_name: '', phone: '', is_money_level: 0, labelNames: [], labels: [] };
  const product = { id: 27, store_name: '真实商品上下文', image: '', price: '19.90', vip_price: '18.90', ot_price: '29.90', stock: 2, sales: 1, slider_image: [], description: '商品内容' };
  const order = { id: 33, uid: 9, order_id: 'ORDER-33', cartInfo: [], pay_price: '39.80', _status: { _title: '待发货' }, paid: 1, status: 0, shipping_type: 1, refund_status: 0, remark: '', total_price: '39.80', user_phone: '', real_name: '', user_address: '', _add_time: '2026-10-03', pay_type: 'wechat' };
  const refund = { id: 44, uid: 9, order_id: 'REFUND-44', cartInfo: [], refund_price: '19.90', _status: { _title: '待退款' }, remark: '', refund_reason: '退款原因' };
  const api = { sessions: async input => { calls.push(['sessions', input]); return { list: [row(input.is_tourist)], next_cursor: null }; }, history: async (uid, input) => { calls.push(['history', uid, input]); return [msg(10, input.is_tourist)]; }, groups: async () => [], userInfo: async () => customer, userLabels: async () => [], customerOrders: async () => [], purchasedProducts: async () => [], visitedProducts: async () => [], hotProducts: async () => [], speechcraftCategories: async () => [], speechcraft: async () => [], transferTargets: async () => ({ list: [], count: 0 }), uploadImage: async () => ({ url: '/api/assets/1' }), productInfo: async id => { calls.push(['productInfo', id]); return product; }, orderInfo: async id => { calls.push(['orderInfo', id]); return { orderInfo: order, userInfo: customer }; }, refundDetail: async id => { calls.push(['refundDetail', id]); return { orderInfo: refund, userInfo: customer }; }, ...overrides };
  let mod;
  const auth = vue.reactive({ token: 'runtime-agent', generation: 0, identity: { id: 1, uid: 1001, nickname: '测试客服', online: 1 }, refreshIdentity: async () => {}, usePreviewIdentity() {}, async logout() { sessionStorage.removeItem('cinashop_kefu_token'); auth.token = ''; mod.announceKefuSessionChange(); auth.generation++; return true; } });
  global.__kefuRuntime = { api, auth, route, router, vue: { ...vue, onMounted: handler => mounted.push(handler), onBeforeUnmount: handler => unmounted.push(handler) } };
  const loaded = new Module(compiledFile, module); loaded.filename = compiledFile; loaded.paths = module.paths; loaded._compile(bundleCode, compiledFile); mod = loaded.exports;
  const state = mod.default.setup({}, { expose() {} }); await state.initialize(); await settle();
  return { state, auth, api, route, router, calls, sockets, Socket, replaceIdentity() { sessionStorage.setItem('cinashop_kefu_token', 'replacement-agent'); auth.token = 'replacement-agent'; mod.announceKefuSessionChange(); auth.generation++; }, cleanup() { for (const release of unmounted) release(); } };
}
test('actual SFC preserves server unread while history is still pending; only server acknowledgement clears it', async () => {
  const pending = deferred(), f = await fixture({ history: () => pending.promise });
  try { const run = f.state.openSession(row()); f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 0, num: 7 } }); assert.equal(f.state.sessions.value.find(r => !r.is_tourist).mssage_num, 7); pending.resolve([msg(11)]); await run; f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 0, num: 0 } }); assert.equal(f.state.sessions.value.find(r => !r.is_tourist).mssage_num, 0); } finally { f.cleanup(); }
});
test('actual SFC rejects late registered history after selecting tourist with the same UID', async () => {
  const pending = deferred(), f = await fixture({ history: (_uid, input) => input.is_tourist ? Promise.resolve([msg(22, 1)]) : pending.promise });
  try { const old = f.state.openSession(row()); await f.state.openSession(row(1)); pending.resolve([msg(99)]); await old; assert.deepEqual(f.state.messages.value.map(m => m.id), [22]); assert.equal(f.state.customer.value.user_type, 'visitor'); } finally { f.cleanup(); }
});
test('actual SFC image upload cannot send to a replacement conversation with identical numeric UID', async () => {
  const pending = deferred(), f = await fixture({ uploadImage: () => pending.promise });
  try { await f.state.openSession(row(1)); const upload = f.state.sendSelectedImage({ currentTarget: { files: [new File([new Uint8Array([1])], 'one.png', { type: 'image/png' })], value: 'x' } }); await f.state.openSession(row()); pending.resolve({ url: '/api/assets/5' }); await upload; assert.equal(f.sockets.flatMap(socket => socket.sent).filter(event => event.type === 'chat' && event.data.msn_type === 3).length, 0); assert.equal(f.state.uploadingImage.value, false); } finally { f.cleanup(); }
});
test('actual SFC return to mobile list cancels viewing and keeps both identities separate', async () => {
  const f = await fixture(); try { await f.state.openSession(row(1)); await f.state.returnToList(); await settle(); assert.equal(f.state.selected.value, null); assert.deepEqual(f.state.messages.value, []); assert.equal(f.route.path, '/mobile_list'); assert.ok(f.sockets.flatMap(socket => socket.sent).some(event => event.type === 'to_chat' && event.data.id === 0)); assert.equal(f.state.sessions.value.length, 2); } finally { f.cleanup(); }
});
test('actual SFC online state requires server confirmation and does not pretend a failed send succeeded', async () => {
  const f = await fixture(); try { f.state.handleRealtimeEvent({ type: 'online', data: { uid: 1001, online: 1, is_tourist: 0 } }); const socket = f.sockets.at(-1); socket.failSend = true; f.state.toggleAvailability(); assert.equal(f.state.availability.value, true); assert.match(f.state.toast.value, /socket send failed/); socket.failSend = false; f.state.toggleAvailability(); assert.equal(f.state.availability.value, true); assert.equal(f.state.onlineBusy.value, true); socket.message({ type: 'online', data: { uid: 1001, online: 0, is_tourist: 0 } }); assert.equal(f.state.availability.value, false); assert.equal(f.state.onlineBusy.value, false); } finally { f.cleanup(); }
});
test('actual SFC consumes type 5/6/7 context and opens their real detail handlers; tourist orders remain unavailable', async () => {
  const f = await fixture({ history: (_uid, input) => Promise.resolve([msg(50, input.is_tourist, 5, '27'), msg(60, input.is_tourist, 6, '33'), msg(70, input.is_tourist, 7, '44')]) });
  try { await f.state.openSession(row()); assert.deepEqual(Object.values(f.state.richMessages.value).map(r => r.title), ['真实商品上下文', 'ORDER-33', 'REFUND-44']); await f.state.openRichMessage(f.state.messages.value[0]); assert.equal(f.state.productDetail.value.id, 27); await f.state.openRichMessage(f.state.messages.value[1]); assert.equal(f.state.orderDetail.value.orderInfo.id, 33); await f.state.openRichMessage(f.state.messages.value[2]); assert.equal(f.state.refundDetail.value.orderInfo.id, 44); await f.state.openSession(row(1)); assert.equal(f.state.richMessages.value[60].unavailable, true); assert.equal(f.state.richMessages.value[70].unavailable, true); } finally { f.cleanup(); }
});
test('actual SFC discards late errors and old socket events after logout and replacement identity', async () => {
  const pending = deferred(), f = await fixture({ history: () => pending.promise });
  try { const old = f.state.openSession(row()), socket = f.sockets.at(-1); await f.state.logout(); f.api.history = async () => []; await f.router.push('/mobile_list'); f.replaceIdentity(); await settle(); pending.reject(Error('old private failure')); await old; socket.message({ type: 'reply', data: msg(999) }); socket.close(4001); await settle(); assert.deepEqual(f.state.messages.value, []); assert.equal(f.state.toast.value, ''); assert.equal(sessionStorage.getItem('cinashop_kefu_token'), 'replacement-agent'); assert.equal(f.auth.token, 'replacement-agent'); } finally { f.cleanup(); }
});
test('actual SFC transfer-out rejects delayed old summaries and confirms any claimed transfer-in against server ownership', async () => {
  const f = await fixture();
  try { await f.state.openSession(row()); f.api.sessions = async input => ({ list: input.is_tourist ? [row(1)] : [], next_cursor: null }); f.state.handleRealtimeEvent({ type: 'transfer_out', data: { uid: 9, is_tourist: 0 } }); await settle(); f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 0, num: 3, recored: row(0, 7) } }); assert.equal(f.state.sessions.value.some(r => !r.is_tourist), false); f.state.handleRealtimeEvent({ type: 'transfer', data: { recored: row(0, 8) } }); await settle(); assert.equal(f.state.sessions.value.some(r => !r.is_tourist), false); assert.equal(f.state.selected.value, null); } finally { f.cleanup(); }
});
test('actual SFC refreshes existing same-domain and redacted cross-domain summaries without regressing an old payload', async () => {
  const f = await fixture();
  try {
    f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 0, num: 3, recored: { ...row(), update_time: 99, message: '后台新文本', message_type: 1 } } });
    assert.equal(f.state.sessions.value[0].is_tourist, 0);
    assert.equal(f.state.sessions.value[0].update_time, 99);
    assert.equal(f.state.sessions.value[0].message, '后台新文本');
    assert.equal(f.state.sessions.value[0].message_type, 1);
    assert.equal(f.state.sessions.value[0].mssage_num, 3);
    const fresh = { ...row(1), update_time: 100, message: '', message_type: 3 };
    f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 1, num: 5, recored: fresh } });
    assert.equal(f.state.sessions.value[0].is_tourist, 1);
    assert.equal(f.state.sessions.value[0].update_time, 100);
    assert.equal(f.state.sessions.value[0].mssage_num, 5);
    assert.equal(f.state.sessionMessagePreview(f.state.sessions.value[0].message, f.state.sessions.value[0].message_type), '[图片]');
    f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 1, num: 6, recored: { ...row(1), update_time: 90, message: 'late raw text', message_type: 1 } } });
    assert.equal(f.state.sessions.value[0].update_time, 100);
    assert.equal(f.state.sessions.value[0].message, '');
    assert.equal(f.state.sessions.value[0].mssage_num, 6);
    f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 1, num: 0, recored: {} } });
    assert.equal(f.state.sessions.value[0].mssage_num, 0);
    assert.equal(f.state.sessions.value[0].update_time, 100);
  } finally { f.cleanup(); }
});
test('actual SFC logout category reset does not schedule protected speech API reads after session clear', async () => {
  let categoryReads = 0;
  const f = await fixture({ speechcraftCategories: async () => { categoryReads++; return [{ id: 1, name: '公共', sort: 0 }]; } });
  try { assert.equal(f.state.activeSpeechCategory.value, 1); const before = categoryReads; await f.state.logout(); await settle(); assert.equal(categoryReads, before); assert.equal(f.state.activeSpeechCategory.value, 0); assert.equal(f.auth.token, ''); } finally { f.cleanup(); }
});
test('actual SFC rejects obsolete versioned summary badges and orders same-second previews by the real message ID', async () => {
  const f = await fixture();
  try {
    const summary = (message_id, text, num) => ({ type: 'mssage_num', data: { uid: 9, is_tourist: 0, message_id, num, recored: { ...row(), update_time: 100, message: text, message_type: 1 } } });
    f.state.handleRealtimeEvent(summary(700, '第一条后台消息', 3));
    f.state.handleRealtimeEvent(summary(701, '同秒新后台消息', 4));
    assert.equal(f.state.sessions.value[0].message, '同秒新后台消息');
    assert.equal(f.state.sessions.value[0].latestMessageId, 701);
    assert.equal(f.state.sessions.value[0].mssage_num, 4);
    f.state.handleRealtimeEvent(summary(699, '旧后台消息', 2));
    assert.equal(f.state.sessions.value[0].message, '同秒新后台消息');
    assert.equal(f.state.sessions.value[0].latestMessageId, 701);
    assert.equal(f.state.sessions.value[0].mssage_num, 4);
    f.state.handleRealtimeEvent({ type: 'mssage_num', data: { uid: 9, is_tourist: 0, num: 0, recored: {} } });
    assert.equal(f.state.sessions.value[0].message, '同秒新后台消息');
    assert.equal(f.state.sessions.value[0].mssage_num, 0);
  } finally { f.cleanup(); }
});
async function main() {
  const built = await esbuild.build({ stdin: { contents: compiled, loader: 'ts', resolveDir: path.dirname(sourceFile) }, bundle: true, write: false, platform: 'node', format: 'cjs', define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_API_BASE': '""' }, plugins: [{ name: 'actual-sfc-fixture-boundaries', setup(build) { build.onResolve({ filter: /^vue$|^vue-router$|^@\/api\/kefu$|^@\/stores\/auth$|^@\/components\// }, args => ({ path: args.path, namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'vue' ? 'module.exports=globalThis.__kefuRuntime.vue;' : args.path === 'vue-router' ? 'export const useRoute=()=>globalThis.__kefuRuntime.route;export const useRouter=()=>globalThis.__kefuRuntime.router;' : args.path === '@/api/kefu' ? 'export const kefuApi=globalThis.__kefuRuntime.api;' : args.path === '@/stores/auth' ? 'export const useAuthStore=()=>globalThis.__kefuRuntime.auth;' : 'export default {};', loader: 'js' })); build.onResolve({ filter: /^@\// }, args => ({ path: path.join(app, 'src', args.path.slice(2)) + '.ts' })); } }] });
  bundleCode = built.outputFiles[0].text; fs.writeFileSync(compiledFile, bundleCode, { flag: 'wx' });
  for (const item of cases) { try { await item.run(); results.push({ name: item.name, passed: true }); console.log('PASS ' + item.name); } catch (error) { results.push({ name: item.name, passed: false, error: error.stack }); console.error('FAIL ' + item.name + '\n' + error.stack); } }
  const report = { source: { file: 'view/kefu-ts/src/pages/WorkbenchPage.vue', sha256: sha(sourceBytes) }, compiled: { file: path.relative(root, compiledFile).replaceAll('\\', '/'), sha256: sha(Buffer.from(bundleCode)), bytes: Buffer.byteLength(bundleCode) }, tests: results, passed: results.every(result => result.passed) };
  console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
