const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const today = '2026-10-25', uid = 11, pendingKey = 'cinashop_sign_pending_v1_11';
const row = (id = 1, day = today, extra = {}) => ({ id, uid, title: '每日签到', number: 7, exp_num: 2, add_time: day, ...extra });
function cells(month = '2026-10', signed = false, day = today) {
  const [y, m] = month.split('-').map(Number), count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => ({ day: `${m}/${String(i + 1).padStart(2, '0')}`, is_sign: signed && `${month}-${String(i + 1).padStart(2, '0')}` === today,
    sign_day: `${month}-${String(i + 1).padStart(2, '0')}` === day, type: 1, point: 3, days: 0, sign_type: 0 }));
}
function weekly(day, signed) {
  const date = new Date(day + 'T00:00:00Z'), monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * 86400000;
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday + i * 86400000), key = d.toISOString().slice(0, 10);
    return { day: `${d.getUTCMonth() + 1}/${String(d.getUTCDate()).padStart(2, '0')}`, is_sign: signed && key === day,
      sign_day: key === day, type: 1, point: 3, days: 0, sign_type: 0 };
  });
}
function fixture(extra = {}) {
  const state = { signed: false, enabled: true, day: today, remind: 0, rows: [], months: [], ...extra };
  const summary = () => ({ continuousSignDays: state.signed ? 2 : 1, cumulativeSignDays: state.rows.length, nextContinuousDays: 3, nextCumulativeDays: 5, checkSign: state.signed });
  const send = call => {
    const route = call.url;
    if (route === '/api/sign/config') return { data: { ...summary(), signList: weekly(state.day, state.signed), signMode: 1,
      signRemindStatus: state.remind, signRemindSwitch: 1, signStatus: Number(state.enabled), signData: { sign_point: 3, sign_exp: 2 } } };
    if (route === '/api/sign/status') return { data: { signedToday: state.signed, enabled: state.enabled, integral: 7, exp: 2, continuousDays: 999, cumulativeDays: state.rows.length } };
    if (route === '/api/sign/calendar') {
      const month = call.data.time ?? state.day.slice(0, 7);
      const list = cells(month, false, state.day).map((c, i) => ({ ...c, is_sign: state.rows.some(r => r.add_time === month + '-' + String(i + 1).padStart(2, '0')) }));
      return { data: { ...summary(), today: state.day, w: String(new Date(month + '-01T00:00:00Z').getUTCDay()), signList: list } };
    }
    if (route === '/api/sign/list') { assert.deepEqual(call.data, { page: 1, limit: 10 }); return { data: state.rows.slice(0, 10) }; }
    if (route === '/api/sign/month') return { data: state.months.slice((call.data.page - 1) * 8, call.data.page * 8) };
    if (route === '/api/sign/user') { assert.equal(call.method, 'POST'); assert.deepEqual(call.data, { sign: 1 }); return { data: { uid, integral: 80 } }; }
    if (route === '/api/sign/integral') { assert.equal(call.method, 'POST'); assert.deepEqual(call.data, {}); state.signed = true; state.rows = [row()];
      return { data: { point: 7, sign_point: 7, exp: 2, sign_exp: 2, continuousDays: 2, cumulativeDays: 1 } }; }
    if (/^\/api\/sign\/remind\/[01]$/.test(route)) { assert.equal(call.method, 'GET'); state.remind = Number(route.at(-1)); return { data: null }; }
    throw Error('Unexpected request ' + route);
  };
  return { state, send };
}
async function start(options = {}) {
  const f = fixture(options.state), traces = [];
  const r = runtime({ feature: options.feature ?? 'useSignCentre', storage: options.storage, authenticated: options.authenticated ?? true,
    send: call => { traces.push({ url: call.url, method: call.method, data: call.data }); return options.send ? options.send(call, f) : f.send(call); } });
  await r.start(); return { ...r, ...f, traces };
}
const writes = r => r.traces.filter(c => c.url === '/api/sign/integral' || c.url.startsWith('/api/sign/remind/'));

test('real adapter and owner store render effective streak, actual estimates, recent10 and do no mount writes', async () => {
  const r = await start(); const s = r.checkout;
  assert.equal(s.loaded.value, true); assert.equal(s.config.value.continuousSignDays, 1); assert.equal(s.status.value.integral, 7); assert.equal(s.points.value, 80);
  assert.equal(s.canSign.value, true); assert.equal(writes(r).length, 0); assert.equal(s.config.value.signList.length, 7); r.stop();
});
test('daily sign submits once, adopts returned actual point/experience, then refreshes server data', async () => {
  const late = deferred(); let count = 0;
  const r = await start({ send: (call, f) => call.url === '/api/sign/integral' ? (count++, late.promise) : f.send(call) });
  const pending = r.checkout.doSign(); await tick(); await r.checkout.doSign(); await r.checkout.setRemind(true); assert.equal(count, 1);
  r.state.signed = true; r.state.rows = [row()]; late.resolve({ data: { point: 7, sign_point: 7, exp: 2, sign_exp: 2, continuousDays: 2, cumulativeDays: 1 } });
  await pending; assert.equal(r.checkout.status.value.signedToday, true); assert.equal(r.checkout.recent.value.length, 1);
  assert.match(r.checkout.notice.value, /7 积分、2 经验/); assert.equal(r.storage.has(pendingKey), false); assert.equal(writes(r).length, 1); r.stop();
});
for (const reply of [{ transport: 'timeout' }, { data: { point: 7 } }, { status: 500, httpStatus: 500, msg: 'failed' }]) test(`unknown sign (${JSON.stringify(reply)}) never repeats, even on refresh/remount`, async () => {
  const r = await start({ send: (call, f) => call.url === '/api/sign/integral' ? reply : f.send(call) });
  await r.checkout.doSign(); assert.equal(r.checkout.pendingDay.value, today); assert.equal(r.checkout.canSign.value, false);
  await r.checkout.doSign(); await r.checkout.load(); assert.equal(writes(r).length, 1); assert.equal(r.toasts.length, 0);
  const storage = r.storage; r.stop(); const next = await start({ storage }); assert.equal(next.checkout.canSign.value, false); assert.equal(writes(next).length, 0); next.stop();
});
test('lost success is reconciled by captured-day rows without fabricating a reward receipt', async () => {
  const r = await start({ send: (call, f) => { if (call.url !== '/api/sign/integral') return f.send(call); f.send(call); return { transport: 'lost reply' }; } });
  await r.checkout.doSign(); assert.equal(r.checkout.pendingDay.value, ''); assert.equal(r.checkout.status.value.signedToday, true);
  assert.match(r.checkout.notice.value, /已有签到记录/); assert.doesNotMatch(r.checkout.notice.value, /签到成功|获得/); assert.equal(r.toasts.length, 0); r.stop();
});
test('midnight reconciliation reads captured old month and offers a separate today action without declaring old failure', async () => {
  const storage = new Map([[pendingKey, '2026-09-30']]);
  const r = await start({ storage });
  assert.ok(r.traces.some(c => c.url === '/api/sign/calendar' && c.data.time === '2026-09'));
  assert.match(r.checkout.notice.value, /原请求结果仍未确认/); assert.equal(r.checkout.canSign.value, true); assert.equal(writes(r).length, 0); r.stop();
});
test('another device already signed: definitive400 refreshes state and never claims new reward', async () => {
  const r = await start({ send: (call, f) => { if (call.url !== '/api/sign/integral') return f.send(call); f.state.signed = true; f.state.rows = [row()]; return { status: 400, msg: '今日已签到' }; } });
  await r.checkout.doSign(); assert.equal(r.checkout.status.value.signedToday, true); assert.equal(r.checkout.canSign.value, false); assert.equal(r.toasts.length, 0); assert.match(r.checkout.notice.value, /今日已签到/); r.stop();
});
for (const action of ['onHide', 'onUnload', 'renew', 'switch']) test(`late sign completion after ${action} cannot publish into next page/owner`, async () => {
  const late = deferred(); const r = await start({ send: (call, f) => call.url === '/api/sign/integral' ? late.promise : f.send(call) });
  const promise = r.checkout.doSign(); await tick();
  if (action === 'renew') r.auth.setLogin(r.auth.token, r.auth.uid); else if (action === 'switch') r.auth.setLogin('other-token', 22); else r.hooks[action]();
  late.resolve({ data: { point: 7, sign_point: 7, exp: 2, sign_exp: 2, continuousDays: 2, cumulativeDays: 1 } }); await promise;
  assert.equal(r.checkout.config.value, null); assert.deepEqual(r.toasts, []); assert.equal(r.storage.get(pendingKey), today); assert.equal(writes(r).length, 1); r.stop();
});
test('preflight hides/session changes fence the write before dispatch', async () => {
  const late = deferred(); let held = false;
  const r = await start({ send: (call, f) => held && call.url === '/api/sign/calendar' ? late.promise : f.send(call) }); held = true;
  const promise = r.checkout.doSign(); await tick(); r.hooks.onHide(); late.resolve(r.send({ url: '/api/sign/calendar', data: {} })); await promise;
  assert.equal(writes(r).length, 0); assert.equal(r.storage.has(pendingKey), false); r.stop();
});
test('reminder is explicit, one GET write; unknown result re-reads config and never resends', async () => {
  let reminderCalls = 0;
  const r = await start({ send: (call, f) => { if (!call.url.startsWith('/api/sign/remind/')) return f.send(call); reminderCalls++; f.send(call); return { transport: 'lost setting reply' }; } });
  assert.equal(reminderCalls, 0); await r.checkout.showCalendar(); await r.checkout.changeMonth(-1); assert.equal(reminderCalls, 0);
  await r.checkout.setRemind(true); assert.equal(reminderCalls, 1); assert.equal(r.checkout.config.value.signRemindStatus, 1);
  assert.match(r.checkout.notice.value, /未确认/); await r.checkout.setRemind(true); assert.equal(reminderCalls, 1); r.stop();
});
test('calendar is full Gregorian month, browsing and closing cannot sign or overwrite newer month', async () => {
  const r = await start(); await r.checkout.showCalendar(); assert.equal(r.checkout.calendar.value.signList.length, 31);
  await r.checkout.loadCalendar('2024-02'); assert.equal(r.checkout.calendar.value.signList.length, 29); assert.equal(r.checkout.calendar.value.w, '4');
  r.checkout.closeCalendar(); assert.equal(r.checkout.calendarOpen.value, false); assert.equal(writes(r).length, 0); r.stop();
});
test('loading/network failure is distinct from disabled; mismatched parallel states fail closed', async () => {
  for (const result of [{ transport: 'offline' }, { data: { signedToday: true, enabled: true, integral: 3, exp: 0, cumulativeDays: 0 } }]) {
    const r = await start({ send: (call, f) => call.url === '/api/sign/status' ? result : f.send(call) });
    assert.ok(r.checkout.error.value); assert.equal(r.checkout.status.value, null); assert.equal(r.checkout.canSign.value, false); assert.notEqual(r.checkout.buttonText.value, '签到未开启'); r.stop();
  }
  const r = await start({ state: { enabled: false } }); assert.equal(r.checkout.error.value, ''); assert.equal(r.checkout.buttonText.value, '签到未开启'); r.stop();
});
test('guest and changed identity discard all old personal data and provide explicit login/refresh', async () => {
  const r = await start({ authenticated: false }); assert.equal(r.calls.length, 0); r.checkout.login(); assert.deepEqual(r.navigations, ['/pages/auth/login']); r.stop();
  const next = await start(); next.auth.setLogin('next', 22); assert.equal(next.checkout.config.value, null); assert.equal(next.checkout.points.value, null); assert.deepEqual(next.checkout.recent.value, []); next.stop();
});
test('signed int4 wallet balances and nonzero legacy sign switches remain valid', async () => {
  const r = await start({ send: (call, f) => {
    const result = f.send(call);
    if (call.url === '/api/sign/user') result.data.integral = -1;
    if (call.url === '/api/sign/config') result.data.signStatus = 2;
    return result;
  } });
  assert.equal(r.checkout.points.value, -1); assert.equal(r.checkout.canSign.value, true); assert.equal(r.checkout.error.value, ''); r.stop();
});
test('strict adapters reject foreign UID, impossible date, wrong calendar shape, duplicate row and ambiguous award', async () => {
  const r = await start(), api = r.load(path.resolve(__dirname, '../src/api/signCentre.ts'));
  for (const bad of [[row(1, today, { uid: 22 })], [row(), row()], [row(1, '2026-02-30')], [row(1, today, { number: '7' })]]) assert.throws(() => api.decodeSignRecords(bad, uid));
  assert.throws(() => api.decodeSignAward({ point: 3, sign_point: 4, exp: 0, sign_exp: 0, continuousDays: 1, cumulativeDays: 1 }));
  const cal = r.send({ url: '/api/sign/calendar', data: {} }).data;
  assert.throws(() => api.decodeSignCalendar({ ...cal, w: '0' })); assert.throws(() => api.decodeSignCalendar({ ...cal, signList: cal.signList.slice(0, 28) }));
  for (const month of ['1969-12', '2038-01', '2026-13', '2026-1', '../']) assert.throws(() => api.signMonth(month)); r.stop();
});
function monthGroups() { return Array.from({ length: 9 }, (_, i) => { const month = `2026-${String(10 - i).padStart(2, '0')}`; return { month, list: [row(100 - i, month + '-01')] }; }); }
test('history paginates MONTH groups8, keeps whole month rows, retries same failed page and stops on terminal result', async () => {
  let fail = true;
  const months = monthGroups(); months[0].list = Array.from({ length: 20 }, (_, i) => row(200 + i, '2026-10-01'));
  const r = await start({ feature: 'useSignRecords', state: { months }, send: (call, f) => call.data.page === 2 && fail ? (fail = false, { transport: 'offline' }) : f.send(call) });
  assert.equal(r.checkout.groups.value.length, 8); assert.equal(r.checkout.groups.value[0].list.length, 20);
  await r.checkout.load(true); assert.equal(r.checkout.groups.value.length, 8); assert.ok(r.checkout.error.value);
  r.hooks.onReachBottom(); await tick(); assert.equal(r.calls.length, 2);
  await r.checkout.load(true); assert.deepEqual(r.traces.map(c => c.data.page), [1, 2, 2]); assert.equal(r.checkout.groups.value.length, 9); assert.equal(r.checkout.hasMore.value, false); r.stop();
});
test('history rejects overlapping/changed months, and hidden late reads cannot restore rows', async () => {
  const months = monthGroups(), late = deferred(); let hold = false;
  const r = await start({ feature: 'useSignRecords', state: { months }, send: (call, f) => hold ? late.promise : call.data.page === 2 ? { data: [months[0]] } : f.send(call) });
  await r.checkout.load(true); assert.match(r.checkout.error.value, /已变化/); assert.equal(r.checkout.groups.value.length, 8);
  hold = true; const promise = r.checkout.load(true); await tick(); r.hooks.onHide(); late.resolve({ data: [months[8]] }); await promise; assert.deepEqual(r.checkout.groups.value, []); r.stop();
});
test('exact PHP assets and historical sign deep link point to the dedicated registered history page', async () => {
  const manifest = require('./fixtures/sign-centre-original-assets-20261025.json');
  for (const item of manifest.assets) { const data = fs.readFileSync(path.resolve(__dirname, '..', item.target)); assert.equal(data.length, item.bytes); assert.equal(crypto.createHash('sha256').update(data).digest('hex'), item.sha256); }
  const r = await start(), navigation = r.load(path.resolve(__dirname, '../src/config/navigation.ts'));
  assert.equal(navigation.REGISTERED_PAGE_ROUTES.has('/pages/user/signRecords'), true);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../src/config/navigation.ts'), 'utf8'), /"\/pages\/users\/user_sgin_list\/index": \{ target: "\/pages\/user\/signRecords", coverage: "candidate_covered" \}/);
  assert.ok(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/pages.json'))).pages.some(p => p.path === 'pages/user/signRecords'));
  r.checkout.history(); assert.deepEqual(r.navigations, ['/pages/user/signRecords']); r.stop();
});

test('an uncertain same-day operation permits only explicit retry after complete read reconciliation', async () => {
  let posts = 0;
  const r = await start({ send: (call, f) => call.url === '/api/sign/integral' && ++posts === 1 ? { transport: 'not delivered' } : f.send(call) });
  await r.checkout.doSign(); assert.equal(posts, 1); assert.equal(r.checkout.canSign.value, false); assert.equal(r.checkout.canRetry.value, true);
  await r.checkout.load(); assert.equal(posts, 1); assert.equal(r.checkout.pendingDay.value, today);
  await r.checkout.retryUnknown(); assert.equal(posts, 2); assert.equal(r.checkout.pendingDay.value, ''); assert.equal(r.checkout.status.value.signedToday, true);
  assert.match(r.checkout.notice.value, /签到成功/); r.stop();
});
test('a rejected manual retry preserves the first unknown operation until a day record proves it', async () => {
  let posts = 0;
  const r = await start({ send: (call, f) => call.url === '/api/sign/integral' ? ++posts === 1 ? { transport: 'timeout' } : { status: 400, msg: '今日已签到' } : f.send(call) });
  await r.checkout.doSign(); await r.checkout.retryUnknown();
  assert.equal(posts, 2); assert.equal(r.storage.get(pendingKey), today); assert.equal(r.checkout.pendingDay.value, today); assert.equal(r.toasts.length, 0);
  r.state.rows = [row()]; r.state.signed = true; await r.checkout.load();
  assert.equal(r.checkout.pendingDay.value, ''); assert.match(r.checkout.notice.value, /已有签到记录/); assert.equal(posts, 2); r.stop();
});
test('manual retry crossing Shanghai midnight performs reads only and requires a separate today action', async () => {
  const r = await start({ storage: new Map([[pendingKey, today]]) }); assert.equal(r.checkout.canRetry.value, true);
  r.state.day = '2026-10-26'; await r.checkout.retryUnknown();
  assert.equal(writes(r).length, 0); assert.equal(r.checkout.pendingDay.value, ''); assert.equal(r.checkout.canSign.value, true); assert.match(r.checkout.notice.value, /原请求结果仍未确认/); r.stop();
});
test('two manual retry taps while the real response is pending issue just one additional write', async () => {
  const late = deferred(); let posts = 0;
  const r = await start({ storage: new Map([[pendingKey, today]]), send: (call, f) => call.url === '/api/sign/integral' ? (posts++, late.promise) : f.send(call) });
  const promise = r.checkout.retryUnknown(); await tick(); await r.checkout.retryUnknown(); await r.checkout.doSign(); assert.equal(posts, 1);
  r.state.signed = true; r.state.rows = [row()]; late.resolve({ data: { point: 7, sign_point: 7, exp: 2, sign_exp: 2, continuousDays: 2, cumulativeDays: 1 } }); await promise;
  assert.equal(r.checkout.pendingDay.value, ''); r.stop();
});
for (const action of ['onHide', 'switch']) test(`manual retry preflight ${action} preserves old pending and never dispatches`, async () => {
  const late = deferred(); let hold = false;
  const r = await start({ storage: new Map([[pendingKey, today]]), send: (call, f) => hold && call.url === '/api/sign/calendar' ? late.promise : f.send(call) });
  hold = true; const promise = r.checkout.retryUnknown(); await tick(); if (action === 'switch') r.auth.setLogin('next-owner', 22); else r.hooks.onHide();
  late.resolve(r.send({ url: '/api/sign/calendar', data: {} })); await promise;
  assert.equal(writes(r).length, 0); assert.equal(r.storage.get(pendingKey), today); assert.equal(r.checkout.config.value, null); r.stop();
});
test('signed historical points/experience remain faithful data while new awards reject negative values', async () => {
  const r = await start({ state: { rows: [row(7, '2026-10-24', { number: -2, exp_num: -1 })] } });
  assert.equal(r.checkout.loaded.value, true); assert.equal(r.checkout.recent.value[0].number, -2); assert.equal(r.checkout.recent.value[0].exp_num, -1);
  const api = r.load(path.resolve(__dirname, '../src/api/signCentre.ts'));
  assert.throws(() => api.decodeSignAward({ point: -2, sign_point: -2, exp: 0, sign_exp: 0, continuousDays: 1, cumulativeDays: 1 })); r.stop();
});
test('contradictory sign flags within one calendar/config response cannot authorize a write', async () => {
  for (const route of ['/api/sign/calendar', '/api/sign/config']) {
    const r = await start({ send: (call, f) => {
      const result = f.send(call); if (call.url === route) result.data.signList.find(c => c.sign_day).is_sign = true; return result;
    } });
    assert.equal(r.checkout.loaded.value, false); assert.ok(r.checkout.error.value); await r.checkout.doSign(); assert.equal(writes(r).length, 0); r.stop();
  }
});

test('the actual compiled sign page uses server reward estimates before signing and actual day records afterwards', async () => {
  const f = fixture();
  const r = runtime({ component: 'pages/user/sign.vue', send: f.send }); await r.start();
  assert.equal(r.checkout.s.loaded, true); assert.deepEqual(r.checkout.reward.value, { point: 7, exp: 2 });
  f.state.signed = true; f.state.rows = [row(1, today, { number: 9, exp_num: 1 })]; await r.checkout.s.load();
  assert.deepEqual(r.checkout.reward.value, { point: 9, exp: 1 });
  assert.equal(r.checkout.s.canSign, false); r.stop();
});
