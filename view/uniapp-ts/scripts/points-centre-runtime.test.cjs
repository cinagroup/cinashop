const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const summary = (extra = {}) => ({ uid: 11, integral: -5, sum_integral: 3000000001, deduction_integral: 5, frozen_integral: 3,
  today_integral: 1, clear_integral: 0, clear_time: 0, clear_end: '', ...extra });
function row(index = 0, extra = {}) {
  const month = index < 13 ? '2026-10' : '2026-09', zero = index === 22;
  const date = zero ? '' : month + '-15';
  return { id: 123 - index, uid: 11, category: 'integral', pm: index % 2, number: index + 1, balance: -5,
    title: '原始积分账目' + index, mark: '积分用途' + index, status: index === 5 ? 0 : 1,
    add_time: zero ? '' : date + ' 12:34:56', time_key: zero ? '' : month, time: zero ? '' : month, day: date, ...extra };
}
function page(rows, p = 1) { const list = rows.slice((p - 1) * 10, p * 10); return { list, count: rows.length, times: [...new Set(list.map(r => r.time_key))] }; }
async function start(options = {}) {
  const rows = options.rows ?? Array.from({ length: 23 }, (_, i) => row(i)), traces = [];
  const send = call => {
    traces.push({ url: call.url, method: call.method, data: structuredClone(call.data) });
    if (options.send) { const result = options.send(call); if (result !== undefined) return result; }
    if (call.url === '/api/sign/user') { assert.equal(call.method, 'POST'); assert.deepEqual(call.data, { sign: 1, integral: 1, all: 1 }); return { data: summary(options.summary) }; }
    if (call.url === '/api/sign/config') { assert.equal(call.method, 'GET'); return { data: { signStatus: options.signStatus ?? 1 } }; }
    if (call.url === '/api/integral/list') { assert.equal(call.method, 'GET'); assert.equal(call.data.limit, 10); return { data: page(rows, call.data.page) }; }
    throw Error('Unexpected business request ' + call.url);
  };
  const r = runtime({ feature: options.feature ?? 'usePointsCentre', component: options.component, authenticated: options.authenticated ?? true, send });
  await r.start(); return { ...r, rows, traces };
}
test('centre uses exact PHP read flags and preserves negative balance and totals above int4', async () => {
  const r = await start(); assert.equal(r.checkout.loaded.value, true); assert.equal(r.checkout.summary.value.integral, -5);
  assert.equal(r.checkout.summary.value.sum_integral, 3000000001); assert.equal(r.checkout.signEnabled.value, true);
  assert.deepEqual(r.traces.map(c => c.url).sort(), ['/api/sign/config', '/api/sign/user']); r.stop();
});
test('expiry text uses actual Shanghai clear_end; disabled expiry remains absent', async () => {
  const clear_time = Date.parse('2026-12-31T16:00:00Z') / 1000;
  const r = await start({ summary: { integral: 100, clear_integral: 20, clear_time, clear_end: '2027-01-01' } });
  assert.equal(r.checkout.summary.value.clear_end, '2027-01-01'); assert.equal(r.checkout.summary.value.clear_integral, 20); r.stop();
  const off = await start(); assert.equal(off.checkout.summary.value.clear_end, ''); off.stop();
});
test('real centre SFC setup keeps distinct mall, ledger, sign, shop and integral lottery destinations', async () => {
  const r = await start({ component: 'pages/user/points.vue' }); const s = r.checkout.s;
  for (const kind of ['mall','ledger','sign','shop','lottery']) s.go(kind);
  assert.deepEqual(r.navigations, ['/pages/user/integral','/pages/user/integralLogs','/pages/user/sign','/pages/index/index','/pages/activity/lottery?factor=1']);
  r.stop(); s.go('mall'); assert.equal(r.navigations.length, 5);
});
for (const signStatus of [0, 2, -1]) test('sign task follows actual legacy switch ' + signStatus, async () => {
  const r = await start({ signStatus }); assert.equal(r.checkout.signEnabled.value, signStatus !== 0); r.checkout.go('sign');
  assert.equal(r.navigations.length, signStatus === 0 ? 0 : 1); r.stop();
});
for (const extra of [{ uid: 22 }, { integral: '5' }, { frozen_integral: Number.MAX_SAFE_INTEGER + 1 }, { clear_time: 1, clear_end: '' }, { clear_time: 0, clear_end: '1970-01-01' }, { clear_time: 1767196800, clear_end: '2026-02-30' }]) test('invalid or foreign summary fails visibly: ' + JSON.stringify(extra), async () => {
  const r = await start({ summary: extra }); assert.equal(r.checkout.loaded.value, false); assert.equal(r.checkout.summary.value, null); assert.ok(r.checkout.error.value); r.stop();
});
test('centre transport failure does not invent zero totals; refresh can recover', async () => {
  let fail = true; const r = await start({ send: c => fail && c.url === '/api/sign/user' ? { transport: 'offline' } : undefined });
  assert.equal(r.checkout.summary.value, null); assert.equal(r.checkout.loaded.value, false); assert.match(r.checkout.error.value, /offline/);
  fail = false; await r.checkout.load(); assert.equal(r.checkout.loaded.value, true); r.stop();
});
for (const feature of ['usePointsCentre','usePointsLedger']) for (const event of ['onHide','onUnload','owner','renew']) test(feature + ' fences late data after ' + event, async () => {
  const d = deferred(); const r = await start({ feature, send: c => c.url === (feature === 'usePointsCentre' ? '/api/sign/user' : '/api/integral/list') ? d.promise : undefined });
  if (event === 'owner') r.auth.setLogin('other-token', 22); else if (event === 'renew') r.auth.setLogin(r.auth.token, r.auth.uid); else r.hooks[event]();
  d.resolve({ data: feature === 'usePointsCentre' ? summary() : page(r.rows) }); await tick();
  assert.equal(r.checkout.loaded.value, false); assert.equal(r.checkout.loading.value, false); assert.equal(r.checkout.error.value, '');
  if (feature === 'usePointsCentre') assert.equal(r.checkout.summary.value, null); else assert.deepEqual(r.checkout.groups.value, []);
  assert.deepEqual(r.modals, []); assert.deepEqual(r.toasts, []); r.stop();
});
for (const feature of ['usePointsCentre','usePointsLedger']) test(feature + ' guest performs no private reads and offers explicit login', async () => {
  const r = await start({ feature, authenticated: false }); assert.deepEqual(r.traces, []); r.checkout.login(); assert.deepEqual(r.navigations, ['/pages/auth/login']); r.stop();
});
test('ledger merges one month across page boundaries and preserves all rows/status0/unknown time', async () => {
  const r = await start({ feature: 'usePointsLedger' }), s = r.checkout;
  assert.deepEqual(s.groups.value.map(g => [g.month,g.list.length]), [['2026-10',10]]);
  await s.load(true); assert.deepEqual(s.groups.value.map(g => [g.month,g.list.length]), [['2026-10',13],['2026-09',7]]);
  await s.load(true); assert.deepEqual(s.groups.value.map(g => [g.month,g.list.length]), [['2026-10',13],['2026-09',9],['',1]]);
  assert.equal(s.rows.value.length, 23); assert.equal(s.rows.value[5].status, 0); assert.equal(s.rows.value.at(-1).add_time, ''); assert.equal(s.hasMore.value, false);
  await s.load(true); assert.deepEqual(r.traces.map(t => t.data.page), [1,2,3]); r.stop();
});
test('failed append retains page/rows and retries the same page only after explicit action', async () => {
  let failed = true; const r = await start({ feature: 'usePointsLedger', send: c => c.data.page === 2 && failed ? { transport: 'offline' } : undefined });
  await r.checkout.load(true); assert.equal(r.checkout.rows.value.length, 10); assert.match(r.checkout.error.value, /offline/);
  r.hooks.onReachBottom(); await tick(); assert.deepEqual(r.traces.map(t => t.data.page), [1,2]);
  failed = false; await r.checkout.load(true); assert.deepEqual(r.traces.map(t => t.data.page), [1,2,2]); assert.equal(r.checkout.rows.value.length, 20); r.stop();
});
test('concurrent scroll and click cannot dispatch duplicate pages', async () => {
  const d = deferred(); const r = await start({ feature: 'usePointsLedger', send: c => c.data.page === 2 ? d.promise : undefined });
  const pending = r.checkout.load(true); r.hooks.onReachBottom(); await r.checkout.load(true); assert.equal(r.traces.length, 2);
  d.resolve({ data: page(r.rows, 2) }); await pending; assert.equal(r.checkout.rows.value.length, 20); r.stop();
});
for (const variant of ['foreign','overlap','count-change','partial','times','decimal','bad-date','epoch-overflow']) test('ledger rejects ' + variant + ' without publishing or advancing', async () => {
  const r = await start({ feature: 'usePointsLedger', send: c => {
    if (c.data.page !== 2) return; const data = page(Array.from({ length: 23 }, (_, i) => row(i)), 2);
    if (variant === 'foreign') data.list[0].uid = 22;
    if (variant === 'overlap') data.list[0].id = 123;
    if (variant === 'count-change') data.count++;
    if (variant === 'partial') data.list.pop();
    if (variant === 'times') data.times = ['2026-01'];
    if (variant === 'decimal') data.list[0].number = 1.5;
    if (variant === 'bad-date') data.list[0].add_time = '2026-02-30 00:00:00';
    if (variant === 'epoch-overflow') Object.assign(data.list[0],{ add_time:'2038-01-19 12:00:00', time_key:'2038-01', time:'2038-01', day:'2038-01-19' });
    return { data };
  } });
  await r.checkout.load(true); assert.equal(r.checkout.rows.value.length, 10); assert.ok(r.checkout.error.value); r.stop();
});
test('empty is proven only by a successful zero count response', async () => {
  const r = await start({ feature: 'usePointsLedger', rows: [] }); assert.equal(r.checkout.loaded.value, true); assert.equal(r.checkout.total.value, 0); assert.deepEqual(r.checkout.groups.value, []); r.stop();
  const bad = await start({ feature: 'usePointsLedger', send: () => ({ transport: 'offline' }) }); assert.equal(bad.checkout.loaded.value, false); assert.equal(bad.checkout.total.value, null); assert.ok(bad.checkout.error.value); bad.stop();
});
test('safe integer ledger amounts retain real pm reversal without double signs or int4 truncation', async () => {
  const r = await start(); const api = r.load(path.resolve(__dirname,'../src/api/pointsCentre.ts'));
  for (const [pm,number,expected] of [[1,3,'+3'],[0,3,'-3'],[1,-2,'-2'],[0,-2,'+2'],[1,0,'+0'],[0,0,'-0'],[1,3000000001,'+3000000001']]) assert.equal(api.pointsLedgerAmount({ pm, number }), expected);
  const raw = page([row(0, { number: -2, balance: -5, pm: 0 })]); assert.equal(api.decodePointsLedger(raw,11).list[0].number,-2); r.stop();
});
test('actual ledger SFC and template compile with all error/empty/month states and no local partial filters', async () => {
  const r = await start({ component: 'pages/user/integralLogs.vue' }); assert.equal(r.checkout.s.rows.length,10); r.stop();
  const { parse, compileTemplate } = require('@vue/compiler-sfc');
  for (const file of ['points.vue','integralLogs.vue']) {
    const source = fs.readFileSync(path.join(__dirname,'../src/pages/user',file),'utf8'), descriptor = parse(source).descriptor;
    const compiled = compileTemplate({ source: descriptor.template.content, filename: file, id: file }); assert.deepEqual(compiled.errors, []);
    assert.doesNotMatch(source, /as any|filteredList|onMounted/);
  }
});
test('all ten PHP assets retain independently fixed source bytes and are actually used by rendered pages', () => {
  const root = path.join(__dirname,'../../..'), manifestPath = path.join(__dirname,'fixtures/points-centre-original-assets-20261025.json');
  const raw = fs.readFileSync(manifestPath); assert.equal(crypto.createHash('sha256').update(raw).digest('hex'),'5345c0e4507822461726d753be5e6ce71ba8d198b1e7c945225536d993632d63');
  const manifest = JSON.parse(raw), source = ['points.vue','integralLogs.vue'].map(f => fs.readFileSync(path.join(__dirname,'../src/pages/user',f),'utf8')).join('\n');
  assert.equal(manifest.php_ref,'8ed2a5b139f9170dd11b0dff91803f2fd59e40a5'); assert.equal(manifest.assets.length,10);
  for (const asset of manifest.assets) { const b=fs.readFileSync(path.join(root,asset.target)); assert.equal(b.length,asset.bytes);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),asset.sha256);assert.ok(source.includes('/static/php-points/'+path.basename(asset.target))); }
  assert.doesNotMatch(source,/background(?:-image)?\s*:[^;]*url\(/);
});
