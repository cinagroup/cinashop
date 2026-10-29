const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
const component = 'pages/user/finance.vue';
const pathname = call => new URL(call.url, 'https://local.invalid').pathname;
const summary = (owner = 11, extra = {}) => ({ yesterdayCommission: '4.50', totalCommission: owner === 11 ? '108.75' : '22.25', frozenCommission: '8.25', withdrawable: owner === 11 ? '92.50' : '14.00', spreadCount: owner === 11 ? 7 : 2, ...extra });
const ledger = (id, extra = {}) => ({ id, uid: 11, linkId: '', pm: 1, title: `佣金${id}`, category: 'brokerage', type: 'one_brokerage', number: '3.50', balance: '92.50', mark: '', status: 1, addTime: 1900000000, ...extra });
async function start(options = {}) {
  let r;
  const traces = [];
  r = runtime({ component, authenticated: options.authenticated ?? true, platform: options.platform, storage: options.storage ?? new Map(), send: call => {
    const p = pathname(call);
    traces.push({ path: p, method: call.method, data: { ...call.data }, authorization: call.header['Authori-zation'] });
    const custom = options.send?.(call, r, traces);
    if (custom !== undefined) return custom;
    if (p === '/api/commission') return { data: summary(r.auth.uid) };
    if (/^\/api\/user\/commission\/list\/\d+$/.test(p)) return { data: [ledger(r.auth.uid, { uid: r.auth.uid })] };
    if (p === '/api/user/spread' && call.method === 'POST') return { data: null };
    throw new Error(`Unexpected finance request: ${call.method} ${p}`);
  } });
  options.configure?.(r);
  await r.start();
  return Object.assign(r, { traces });
}
const privateCalls = r => r.traces.filter(c => c.path !== '/api/user/spread');

test('ordinary PHP menu destinations and both commission ledgers keep actual registered navigation', async () => {
  const r = await start();
  try {
    r.checkout.openPromoterOrders();
    r.checkout.openPeople();
    r.checkout.openRanking('commissionRank');
    r.checkout.openLedger(1);
    r.checkout.openRanking('promoterRank');
    r.checkout.openSpread();
    r.checkout.openDistributionLevel();
    r.checkout.openAgentExplanation();
    r.checkout.openLedger(4);
    r.checkout.openExtract();
    assert.deepEqual(r.navigations, [
      '/pages/user/promoterOrders', '/pages/user/promoterPeople', '/pages/user/commissionRank',
      '/pages/user/distributionLedgers?type=1', '/pages/user/promoterRank', '/pages/user/spread',
      '/pages/users/user_distribution_level/index', '/pages/user/agentExplanation',
      '/pages/user/distributionLedgers?type=4', '/pages/user/withdrawalApplication',
    ]);
    assert.deepEqual(r.traces.map(c => [c.method, c.path]), [
      ['GET', '/api/commission'], ['GET', '/api/user/commission/list/1'],
    ]);
    assert.equal(r.checkout.info.value.withdrawable, '92.50');
    assert.equal(r.checkout.info.value.totalCommission, '108.75');
    assert.equal(r.checkout.info.value.frozenCommission, '8.25');
    assert.equal(r.modals.length, 0);
  } finally { r.stop(); }
});

for (const platform of ['H5', 'MP-WEIXIN', 'APP-PLUS']) test(platform + ' center entry reads existing finance contracts without an evaluator or financial write', async () => {
  const r = await start({ platform });
  try {
    assert.equal(r.traces.length, 2);
    assert.ok(r.traces.every(c => c.method === 'GET' && c.authorization === 'Bearer synthetic-local-token'));
    assert.ok(r.traces.every(c => !/level_list|level_task_list|extract\/cash/.test(c.path)));
    r.checkout.openSpread();
    assert.equal(r.navigations.at(-1), '/pages/user/spread');
    assert.equal(r.traces.length, 2);
  } finally { r.stop(); }
});

test('guest retains public explanation and login recovery without private reads or binding dialog', async () => {
  const r = await start({ authenticated: false });
  try {
    r.checkout.openAgentExplanation();
    r.checkout.openSpread(); r.checkout.openPeople(); r.checkout.openDistributionLevel();
    r.checkout.openPromoterOrders(); r.checkout.openLedger(1); r.checkout.openRanking('promoterRank');
    r.checkout.openBind();
    assert.equal(r.checkout.showBind.value, false);
    assert.deepEqual(r.navigations, ['/pages/user/agentExplanation']);
    assert.equal(r.traces.length, 0);
    r.checkout.openExtract();
    assert.deepEqual(r.navigations, ['/pages/user/agentExplanation', '/pages/auth/login']);
    assert.equal(r.modals.length, 0);
    r.hooks.onHide();
    r.checkout.openAgentExplanation(); r.checkout.openExtract(); r.checkout.openSpread(); r.checkout.openBind();
    assert.equal(r.navigations.length, 2);
    assert.equal(r.traces.length, 0);
  } finally { r.stop(); }
});

test('pending withdrawal intent remains owner scoped and opening recovery never posts another deduction', async () => {
  const r = await start({ storage: new Map([['finance_withdrawal_pending_11', { request_id: 'synthetic-pending-center-request' }]]) });
  try {
    assert.equal(r.checkout.uncertain.value, true);
    r.checkout.openExtract();
    assert.equal(r.navigations.at(-1), '/pages/user/withdrawalApplication');
    assert.equal(r.traces.filter(c => c.method === 'POST').length, 0);
    assert.ok(r.storage.has('finance_withdrawal_pending_11'));
    r.auth.setLogin('other-owner', 22); await tick();
    assert.equal(r.checkout.uncertain.value, false);
    assert.ok(r.storage.has('finance_withdrawal_pending_11'));
    assert.equal(r.checkout.info.value.withdrawable, '14.00');
  } finally { r.stop(); }
});

test('manual binding is explicit, validates UID, and refreshes current commission after one accepted write', async () => {
  const r = await start();
  try {
    assert.equal(r.traces.filter(c => c.method === 'POST').length, 0);
    r.checkout.openBind(); assert.equal(r.checkout.showBind.value, true);
    for (const invalid of ['', '0', '-1', '1.5', '2147483648', '1e2']) {
      r.checkout.bindUid.value = invalid; await r.checkout.doBind();
    }
    assert.equal(r.traces.filter(c => c.method === 'POST').length, 0);
    r.checkout.bindUid.value = '42'; await r.checkout.doBind(); await tick();
    assert.deepEqual(r.traces.filter(c => c.method === 'POST').map(c => [c.path, c.data]), [['/api/user/spread', { spread_uid: 42 }]]);
    assert.equal(r.checkout.showBind.value, false);
    assert.equal(r.traces.filter(c => c.path === '/api/commission').length, 2);
    assert.ok(r.toasts.some(t => t.title === '绑定成功'));
    r.hooks.onHide(); r.checkout.openBind();
    assert.equal(r.checkout.showBind.value, false);
  } finally { r.stop(); }
});

test('late accepted binding response cannot toast or refresh after account replacement', async () => {
  const held = deferred();
  const r = await start({ send: c => pathname(c) === '/api/user/spread' ? held.promise : undefined });
  try {
    r.checkout.openBind(); r.checkout.bindUid.value = '42';
    const write = r.checkout.doBind(); await tick();
    r.auth.setLogin('other-owner', 22); await tick();
    const reads = privateCalls(r).length;
    held.resolve({ data: null }); await write; await tick();
    assert.equal(privateCalls(r).length, reads);
    assert.equal(r.toasts.filter(t => t.title === '绑定成功').length, 0);
    assert.equal(r.checkout.bindUid.value, '');
    assert.equal(r.checkout.info.value.withdrawable, '14.00');
  } finally { r.stop(); }
});

for (const event of ['owner', 'renew', 'logout', 'onHide', 'onUnload', 'persisted-owner']) test('held old summary and ledger cannot repopulate finance after ' + event, async () => {
  const heldSummary = deferred(), heldList = deferred(); let firstSummary = true, firstList = true;
  const r = await start({ send: c => {
    if (pathname(c) === '/api/commission' && firstSummary) { firstSummary = false; return heldSummary.promise; }
    if (/^\/api\/user\/commission\/list\//.test(pathname(c)) && firstList) { firstList = false; return heldList.promise; }
  } });
  try {
    if (event === 'owner') r.auth.setLogin('other-owner', 22);
    else if (event === 'renew') r.auth.setLogin(r.auth.token, 11);
    else if (event === 'logout') r.auth.clear();
    else if (event === 'persisted-owner') { r.storage.set('uni_token', 'other-owner'); r.storage.set('uni_uid', 22); }
    else r.hooks[event]();
    await tick();
    heldSummary.resolve({ data: summary(11, { withdrawable: '999999.99' }) });
    heldList.resolve({ data: [ledger(999999)] }); await tick();
    assert.notEqual(r.checkout.info.value.withdrawable, '999999.99');
    assert.ok(!r.checkout.list.value.some(row => row.id === 999999));
    if (['logout', 'onHide', 'onUnload', 'persisted-owner'].includes(event)) {
      assert.equal(r.checkout.info.value.withdrawable, '0.00'); assert.equal(r.checkout.list.value.length, 0);
    }
    if (event === 'owner') assert.equal(r.checkout.info.value.withdrawable, '14.00');
    const navigationCount = r.navigations.length;
    if (['logout', 'onHide', 'onUnload', 'persisted-owner'].includes(event)) {
      r.checkout.openSpread(); r.checkout.openBind();
      assert.equal(r.checkout.showBind.value, false); assert.equal(r.navigations.length, navigationCount);
    }
  } finally { r.stop(); }
});

test('old tab response cannot replace the later selected classification', async () => {
  const held = deferred(); let first = true;
  const r = await start({ send: c => {
    if (pathname(c).endsWith('/list/1') && first) { first = false; return held.promise; }
    if (pathname(c).endsWith('/list/2')) return { data: [ledger(202, { type: 'two_brokerage' })] };
  } });
  try {
    await r.checkout.switchTab(2);
    assert.equal(r.checkout.activeTab.value, 2);
    assert.deepEqual(r.checkout.list.value.map(row => row.id), [202]);
    held.resolve({ data: [ledger(101)] }); await tick();
    assert.deepEqual(r.checkout.list.value.map(row => row.id), [202]);
  } finally { r.stop(); }
});

test('failed icon state is idempotent per filename and resets with page ownership', async () => {
  const r = await start();
  try {
    assert.equal(r.checkout.iconFailed('spread_dd.png'), false);
    r.checkout.failIcon('spread_dd.png'); r.checkout.failIcon('spread_dd.png');
    assert.equal(r.checkout.iconFailed('spread_dd.png'), true);
    assert.equal(r.checkout.failedIcons.value.filter(x => x === 'spread_dd.png').length, 1);
    assert.equal(r.checkout.iconFailed('spread_yq.png'), false);
    r.hooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.iconFailed('spread_dd.png'), false);
  } finally { r.stop(); }
});

test('explicit retry recovers failed current finance reads without evaluating levels or writing money', async () => {
  let offline = true;
  const r = await start({ send: c => offline ? { transport: 'synthetic finance network unavailable' } : undefined });
  try {
    assert.match(r.checkout.pageError.value, /network unavailable/);
    assert.equal(r.checkout.info.value.withdrawable, '0.00');
    assert.equal(r.checkout.list.value.length, 0);
    offline = false; await r.checkout.retryInfo(); await tick();
    assert.equal(r.checkout.info.value.withdrawable, '92.50');
    assert.deepEqual(r.checkout.list.value.map(row => row.id), [11]);
    assert.equal(r.checkout.pageError.value, '');
    assert.deepEqual(r.traces.map(c => c.path), [
      '/api/commission', '/api/user/commission/list/1', '/api/commission', '/api/user/commission/list/1',
    ]);
    assert.ok(r.traces.every(c => c.method === 'GET'));
  } finally { r.stop(); }
});

test('actual updated page template compiles with the existing lifecycle and public explanation contracts', () => {
  const { parse, compileTemplate } = require('@vue/compiler-sfc');
  const file = path.join(__dirname, '../src/pages/user/finance.vue');
  const descriptor = parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: file, id: 'finance-center' }).errors, []);
});

test('successful tab reads do not swallow a failed commission overview or its retry', async () => {
 let failing=true; const r=await start({send:c=>pathname(c)==='/api/commission'&&failing?{transport:'overview offline'}:undefined});
 try { assert.match(r.checkout.summaryError.value,/overview offline/); await r.checkout.switchTab(2); assert.match(r.checkout.summaryError.value,/overview offline/); failing=false;r.checkout.retryInfo();await tick();assert.equal(r.checkout.summaryError.value,'');assert.equal(r.checkout.info.value.withdrawable,'92.50'); }finally{r.stop();}
});
test('explicit icon retry does not reread finances or evaluate a level', async () => {
 const r=await start();try{r.checkout.failIcon('spread_dd');const reads=r.traces.length;r.checkout.retryIcons();assert.equal(r.checkout.failedIcons.value.length,0);assert.equal(r.traces.length,reads);}finally{r.stop();}
});
