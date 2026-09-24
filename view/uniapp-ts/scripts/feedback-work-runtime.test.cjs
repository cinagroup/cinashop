const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const root = path.resolve(__dirname, '..');
const state = 'a'.repeat(64);

function browser() {
  const data = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const location = {
    origin: 'https://work.example.test', pathname: '/',
    href: 'https://work.example.test/#/pages/work/userInfo/index', assigned: '',
    assign(url) { this.assigned = url; },
  };
  global.window = {
    location,
    sessionStorage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
      removeItem: key => data.delete(key),
    },
    history: { replaceState: (_state, _title, url) => { location.href = url; } },
    addEventListener: (name, listener) => windowListeners.set(name, listener),
    setTimeout, clearTimeout,
  };
  global.document = {
    visibilityState: 'visible',
    addEventListener: (name, listener) => documentListeners.set(name, listener),
  };
  return { data, location,
    hide() { global.document.visibilityState = 'hidden'; documentListeners.get('visibilitychange')?.(); },
    dispose() { delete global.window; delete global.document; },
  };
}

function installTargetSdk(kind = 'client', id = 'external-1') {
  const target = { kind, id };
  const sdk = {
    configurations: 0,
    ready(callback) { this.readyCallback = callback; }, error() {},
    config() { this.configurations++; queueMicrotask(() => this.readyCallback()); },
    agentConfig(input) { queueMicrotask(() => input.success()); },
    invoke(name, _input, callback) {
      if (name === 'getContext') queueMicrotask(() => callback({ err_msg: 'getContext:ok',
        entry: target.kind === 'group' ? 'group_chat_tools' : 'single_chat_tools' }));
      else if (name === 'getCurExternalContact') queueMicrotask(() => callback({
        err_msg: 'getCurExternalContact:ok', userId: target.id }));
      else if (name === 'getCurExternalChat') queueMicrotask(() => callback({
        err_msg: 'getCurExternalChat:ok', chatId: target.id }));
      else throw new Error(`unexpected SDK invocation ${name}`);
    },
  };
  global.document = { ...global.document,
    createElement: () => ({ remove() {} }),
    head: { appendChild: element => queueMicrotask(() => element.onload()) },
  };
  global.window.jWeixin = sdk;
  return { target, sdk, switchTo(nextKind, nextId) { target.kind = nextKind; target.id = nextId; } };
}

function workConfig(call) {
  if (call.url === '/api/work/config') return { data: {
    appId: 'corp', timestamp: 1, nonceStr: 'nonce', signature: 'sig', jsApiList: [] } };
  if (call.url === '/api/work/agentConfig') return { data: {
    corpid: 'corp', agentid: 1, timestamp: 1, nonceStr: 'nonce', signature: 'sig', jsApiList: [] } };
  return null;
}

async function callbackTo(r, location, query) {
  location.href = `https://work.example.test/?work_oauth=1&code=work-code&state=${state}`;
  r.load(path.join(root, 'src/composables/workContext.ts')).prepareWorkOAuthRoute();
  assert.ok(!location.href.includes('code='), 'OAuth code removed before page rendering');
  await r.start(query);
}

test('feedback form uses shopper authorization and exact escaped-content limit', async () => {
  const r = runtime({ component: 'pages/extension/customer_list/feedback.vue', send: call => {
    if (call.url === '/api/user/service/feedback' && call.method === 'GET') return { data: { feedback: '稍后回复' } };
    assert.equal(call.url, '/api/user/service/feedback');
    assert.match(call.header['Authori-zation'], /^Bearer synthetic-local-token$/);
    assert.deepEqual(call.data, { rela_name: '张三', phone: '13900000000', content: '反馈内容' });
    return { data: { id: 8 } };
  } });
  try {
    await r.start();
    r.checkout.name.value = '张三';
    r.checkout.phone.value = '13900000000';
    r.checkout.content.value = "'".repeat(100);
    await r.checkout.submit();
    assert.match(r.checkout.error.value, /转义后最多500字/);
    assert.equal(r.calls.filter(call => call.data?.rela_name).length, 0);
    r.checkout.content.value = '反馈内容';
    await r.checkout.submit();
    assert.equal(r.calls.filter(call => call.data?.rela_name).length, 1);
    assert.equal(r.checkout.content.value, '');
    assert.equal(r.toasts.at(-1).title, '反馈已提交');
  } finally { r.stop(); }
});

test('Work client OAuth clears code, exchanges bounded target and keeps token out of storage', async () => {
  const b = browser();
  const r = runtime({ component: 'pages/work/userInfo/index.vue', send: call => {
    if (call.url === '/api/work/context/challenge') {
      assert.equal(call.header['Authori-zation'], undefined);
      assert.equal(call.data.redirect_uri, 'https://work.example.test/?work_oauth=1');
      return { data: { authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    }
    if (call.url === '/api/work/context/exchange') {
      assert.equal(call.header['Authori-zation'], undefined);
      assert.deepEqual(call.data, { state, code: 'work-code', target_type: 'client', external_userid: 'external-1' });
      return { data: { token: 'work-context-secret', token_type: 'Bearer', expires_in: 0.1,
        target: { type: 'client', id: 5 } } };
    }
    assert.equal(call.url, '/api/work/client/info');
    assert.equal(call.header.Authorization, 'Bearer work-context-secret');
    assert.equal(call.header['Authori-zation'], undefined);
    assert.deepEqual(call.data, {});
    return { data: { id: 5, external_userid: 'external-1', uid: 8, name: '客户甲', avatar: '',
      corp_name: '', position: '', remark: '', tags: [], userInfo: null } };
  } });
  try {
    await r.start({ userid: 'external-1' });
    assert.equal(r.calls.length, 1, 'query target alone never reads private customer data');
    assert.match(b.location.assigned, /^https:\/\/open\.weixin\.qq\.com\//);
    await callbackTo(r, b.location, { userid: 'external-1' });
    assert.equal(r.checkout.client.value.name, '客户甲');
    assert.deepEqual(r.storage.get('uni_token'), 'synthetic-local-token');
    assert.ok(![...r.storage.values()].includes('work-context-secret'));
    assert.equal(b.data.size, 0, 'one-time OAuth target/state removed from session storage');
    await new Promise(resolve => setTimeout(resolve, 160));
    await tick();
    assert.equal(r.checkout.client.value, null, 'private projection clears when context expires');
    assert.equal(r.auth.uid, 11, 'Work expiry does not revoke the shopper session');
  } finally { r.stop(); b.dispose(); }
});

test('Work group page uses group audience, bounded member page and client handoff only through target hint', async () => {
  const b = browser();
  const r = runtime({ component: 'pages/work/groupInfo/index.vue', send: call => {
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') {
      assert.deepEqual(call.data, { state, code: 'work-code', target_type: 'group', chat_id: 'chat-1' });
      return { data: { token: 'group-secret', token_type: 'Bearer', expires_in: 300, target: { type: 'group', id: 7 } } };
    }
    assert.equal(call.header.Authorization, 'Bearer group-secret');
    if (call.url === '/api/work/groupInfo') return { data: { id: 7, name: '工作群', owner: 'employee-1', member_num: 1,
      todaySum: 1, retreat_group_num: 0, group_create_time: '2026-09-24', notice: '' } };
    assert.equal(call.url, '/api/work/groupMember/7');
    assert.deepEqual(call.data, { page: 1, limit: 20, name: '' });
    return { data: { list: [{ id: 10, type: 2, userid: 'external-2', client: { id: 9, name: '客户乙', avatar: '', gender: 0 },
      member: null, group_chat_num: 0, join_time: '2026-09-24', tags: [] }], count: 1 } };
  } });
  try {
    await r.start({ chat_id: 'chat-1' });
    assert.equal(r.calls.length, 1);
    await callbackTo(r, b.location, { chat_id: 'chat-1' });
    assert.equal(r.checkout.group.value.name, '工作群');
    assert.equal(r.checkout.members.value.length, 1);
    await r.checkout.openClient(r.checkout.members.value[0]);
    assert.equal(r.navigations.at(-1), '/pages/work/userInfo/index?userid=external-2');
    assert.ok(!r.navigations.at(-1).includes('group-secret'));
    b.hide();
    await tick();
    assert.equal(r.checkout.group.value, null, 'backgrounding clears group details before a possible chat switch');
    assert.equal(r.checkout.members.value.length, 0);
  } finally { r.stop(); b.dispose(); }
});

test('authorized group member keeps client target through customer, orders, detail and footprint tabs', async () => {
  const b = browser();
  const r = runtime({ component: 'pages/work/groupInfo/index.vue', send: call => {
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') {
      assert.deepEqual(call.data.target_type === 'group'
        ? { target_type: call.data.target_type, chat_id: call.data.chat_id }
        : { target_type: call.data.target_type, external_userid: call.data.external_userid },
      call.data.target_type === 'group'
        ? { target_type: 'group', chat_id: 'chat-1' }
        : { target_type: 'client', external_userid: 'external-2' });
      return { data: { token: call.data.target_type === 'group' ? 'group-secret' : 'client-secret',
        token_type: 'Bearer', expires_in: 300,
        target: { type: call.data.target_type, id: call.data.target_type === 'group' ? 7 : 9 } } };
    }
    if (call.url === '/api/work/groupInfo') return { data: { id: 7, chat_id: 'chat-1', name: '工作群', owner: '',
      member_num: 1, todaySum: 0, retreat_group_num: 0, group_create_time: '', notice: '' } };
    if (call.url === '/api/work/groupMember/7') return { data: { list: [{ id: 10, type: 2,
      userid: 'external-2', client: { id: 9, name: '客户乙', avatar: '', gender: 0 }, member: null,
      group_chat_num: 0, join_time: '', tags: [] }], count: 1 } };
    assert.equal(call.header.Authorization, 'Bearer client-secret', 'each customer read stays server-authorized for this target');
    if (call.url === '/api/work/client/info') return { data: { id: 9, external_userid: 'external-2',
      name: '客户乙', avatar: '', corp_name: '', position: '', remark: '', tags: [], userInfo: null } };
    if (call.url === '/api/work/order/list') return { data: [{ id: 44, order_id: 'order-44',
      _add_time: '', pay_price: '8.00', total_num: 1, paid: 1, refund_type: 0,
      _status: { _title: '已付款' }, cartInfo: [] }] };
    if (call.url === '/api/work/order/info/44') return { data: { orderInfo: { id: 44, order_id: 'order-44',
      _add_time: '', pay_price: '8.00', total_num: 1, paid: 1, refund_type: 0,
      _status: { _title: '已付款' }, cartInfo: [] }, userInfo: null } };
    if (call.url === '/api/work/product/cart_list') return { data: [{ id: 3, store_name: '花',
      image: '', stock: 1, price: '8.00', sales: 1 }] };
    throw new Error(`unexpected API ${call.url}`);
  } });
  try {
    r.uni.redirectTo = ({ url }) => r.navigations.push(url);
    await r.start({ chat_id: 'chat-1' });
    await callbackTo(r, b.location, { chat_id: 'chat-1' });
    await r.checkout.openClient(r.checkout.members.value[0]);
    assert.equal(r.navigations.at(-1), '/pages/work/userInfo/index?userid=external-2');
    r.hooks.onUnload();

    const user = r.load(path.join(root, 'src/pages/work/userInfo/index.vue')).default.setup({}, { expose() {} });
    await r.start({ userid: 'external-2' });
    await callbackTo(r, b.location, { userid: 'external-2' });
    assert.equal(user.client.value.external_userid, 'external-2');
    const navComponent = r.load(path.join(root, 'src/components/work/WorkNav.vue')).default;
    const navBeforeAuthorization = navComponent.setup({ active: 'client', ready: false,
      targetHint: 'external-2' }, { expose() {} });
    const navigationCount = r.navigations.length;
    navBeforeAuthorization.go('/pages/work/orderList/index');
    assert.equal(r.navigations.length, navigationCount, 'navigation stays disabled before a scoped client token');
    const navOrdinaryClient = navComponent.setup({ active: 'client', ready: true }, { expose() {} });
    navOrdinaryClient.go('/pages/work/orderList/index');
    assert.equal(r.navigations.at(-1), '/pages/work/orderList/index',
      'an ordinary client chat remains hint-free and rechecks the SDK on the next page');
    const navFromUser = navComponent.setup({ active: 'client', ready: true, targetHint: 'external-2' }, { expose() {} });
    navFromUser.go('/pages/work/orderList/index');
    assert.equal(r.navigations.at(-1), '/pages/work/orderList/index?userid=external-2');
    assert.ok(!r.navigations.at(-1).includes('client-secret'));
    r.hooks.onUnload();

    const orders = r.load(path.join(root, 'src/pages/work/orderList/index.vue')).default.setup({}, { expose() {} });
    await r.start({ userid: 'external-2' });
    assert.equal(orders.rows.value[0].id, 44, 'group context can open the authorized customer orders');
    orders.open(44);
    assert.equal(r.navigations.at(-1), '/pages/work/orderDetail/index?id=44&userid=external-2');
    r.hooks.onUnload();

    const detail = r.load(path.join(root, 'src/pages/work/orderDetail/index.vue')).default.setup({}, { expose() {} });
    await r.start({ id: '44', userid: 'external-2' });
    assert.equal(detail.order.value.id, 44);
    detail.back();
    assert.equal(r.navigations.at(-1), '/pages/work/orderList/index?userid=external-2');
    r.hooks.onUnload();

    const navFromOrders = navComponent.setup({ active: 'orders', ready: true, targetHint: 'external-2' }, { expose() {} });
    navFromOrders.go('/pages/work/record/index');
    assert.equal(r.navigations.at(-1), '/pages/work/record/index?userid=external-2');
    const record = r.load(path.join(root, 'src/pages/work/record/index.vue')).default.setup({}, { expose() {} });
    await r.start({ userid: 'external-2' });
    assert.equal(record.items.value[0].store_name, '花');
    assert.equal(r.calls.filter(call => call.url === '/api/work/context/challenge').length, 2,
      'the verified client context is reused without another OAuth redirect');
    for (const name of ['userInfo', 'orderList', 'record']) {
      assert.match(readFileSync(path.join(root, `src/pages/work/${name}/index.vue`), 'utf8'), /:target-hint=/);
    }
  } finally { r.stop(); b.dispose(); }
});

test('no-hint OAuth callback rejects a chat switch before exchanging the pending SDK target', async () => {
  const b = browser();
  const sdk = installTargetSdk('client', 'external-1');
  const r = runtime({ component: 'pages/work/userInfo/index.vue', send: call => {
    const config = workConfig(call); if (config) return config;
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    throw new Error(`unexpected API ${call.url}`);
  } });
  try {
    await r.start({});
    assert.equal(JSON.parse(b.data.get('cinashop_work_oauth_pending')).sdkDiscovered, true);
    sdk.switchTo('client', 'external-2');
    await callbackTo(r, b.location, {});
    assert.match(r.checkout.access.error.value, /会话已切换/);
    assert.equal(r.checkout.client.value, null);
    assert.equal(r.calls.filter(call => call.url === '/api/work/context/exchange').length, 0);
    assert.equal(sdk.sdk.configurations, 1, 'SDK signature configuration is cached for the same URL');
  } finally { r.stop(); b.dispose(); }
});

test('no-hint OAuth callback rejects a chat switch during exchange before activating a token', async () => {
  const b = browser();
  const sdk = installTargetSdk('client', 'external-1');
  const exchange = deferred();
  const r = runtime({ component: 'pages/work/userInfo/index.vue', send: call => {
    const config = workConfig(call); if (config) return config;
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') return exchange.promise;
    throw new Error(`unexpected API ${call.url}`);
  } });
  try {
    await r.start({});
    await callbackTo(r, b.location, {});
    assert.equal(r.calls.filter(call => call.url === '/api/work/context/exchange').length, 1);
    sdk.switchTo('client', 'external-2');
    exchange.resolve({ data: { token: 'stale-client-secret', token_type: 'Bearer', expires_in: 300,
      target: { type: 'client', id: 5 } } });
    await tick();
    assert.match(r.checkout.access.error.value, /会话已切换/);
    assert.equal(r.checkout.client.value, null);
    assert.equal(r.calls.filter(call => call.url === '/api/work/client/info').length, 0);
    assert.equal(sdk.sdk.configurations, 1);
  } finally { r.stop(); b.dispose(); }
});

test('all five no-hint private pages discard a response after the Enterprise chat switches', async () => {
  const cases = [
    { page: 'userInfo', kind: 'client', endpoint: '/api/work/client/info', query: {},
      data: { id: 5, external_userid: 'external-1', name: '旧客户', avatar: '', corp_name: '',
        position: '', remark: '', tags: [], userInfo: null }, empty: page => page.client.value === null },
    { page: 'orderList', kind: 'client', endpoint: '/api/work/order/list', query: {},
      data: [{ id: 44, order_id: 'order-44', _add_time: '', pay_price: '8.00', total_num: 1,
        paid: 1, refund_type: 0, _status: {}, cartInfo: [] }], empty: page => page.rows.value.length === 0 },
    { page: 'orderDetail', kind: 'client', endpoint: '/api/work/order/info/44', query: { id: '44' },
      data: { orderInfo: { id: 44, order_id: 'order-44', _add_time: '', pay_price: '8.00',
        total_num: 1, paid: 1, refund_type: 0, _status: {}, cartInfo: [] }, userInfo: null },
      empty: page => page.order.value === null },
    { page: 'record', kind: 'client', endpoint: '/api/work/product/cart_list', query: {},
      data: [{ id: 3, store_name: '花', image: '', stock: 1, price: '8.00', sales: 1 }],
      empty: page => page.items.value.length === 0 },
    { page: 'groupInfo', kind: 'group', endpoint: '/api/work/groupInfo', query: {},
      data: { id: 7, chat_id: 'chat-1', name: '旧群', owner: '', member_num: 1,
        todaySum: 0, retreat_group_num: 0, group_create_time: '', notice: '' },
      empty: page => page.group.value === null && page.members.value.length === 0 },
  ];
  for (const scenario of cases) {
    const b = browser();
    const initialId = scenario.kind === 'group' ? 'chat-1' : 'external-1';
    const sdk = installTargetSdk(scenario.kind, initialId);
    const response = deferred();
    const r = runtime({ component: `pages/work/${scenario.page}/index.vue`, send: call => {
      const config = workConfig(call); if (config) return config;
      if (call.url === '/api/work/context/challenge') return { data: {
        authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
      if (call.url === '/api/work/context/exchange') return { data: { token: 'work-secret',
        token_type: 'Bearer', expires_in: 300, target: { type: scenario.kind, id: 5 } } };
      assert.equal(call.url, scenario.endpoint);
      assert.equal(call.header.Authorization, 'Bearer work-secret');
      return response.promise;
    } });
    try {
      await r.start(scenario.query);
      await callbackTo(r, b.location, scenario.query);
      assert.equal(r.calls.filter(call => call.url === scenario.endpoint).length, 1, scenario.page);
      sdk.switchTo(scenario.kind, scenario.kind === 'group' ? 'chat-2' : 'external-2');
      response.resolve({ data: scenario.data });
      await tick();
      assert.ok(scenario.empty(r.checkout), `${scenario.page} must not publish the old response`);
      assert.equal(r.checkout.access.token.value, '', `${scenario.page} must clear the stale token`);
      assert.equal(r.calls.filter(call => call.url === '/api/work/groupMember/7').length, 0);
    } finally { r.stop(); b.dispose(); }
  }
});

test('group page checks the current chat between group and member requests', async () => {
  const b = browser();
  const sdk = installTargetSdk('group', 'chat-1');
  const members = deferred();
  const r = runtime({ component: 'pages/work/groupInfo/index.vue', send: call => {
    const config = workConfig(call); if (config) return config;
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') return { data: { token: 'group-secret',
      token_type: 'Bearer', expires_in: 300, target: { type: 'group', id: 7 } } };
    if (call.url === '/api/work/groupInfo') return { data: { id: 7, chat_id: 'chat-1', name: '旧群',
      owner: '', member_num: 1, todaySum: 0, retreat_group_num: 0, group_create_time: '', notice: '' } };
    assert.equal(call.url, '/api/work/groupMember/7');
    return members.promise;
  } });
  try {
    await r.start({});
    await callbackTo(r, b.location, {});
    assert.equal(r.calls.filter(call => call.url === '/api/work/groupMember/7').length, 1);
    sdk.switchTo('group', 'chat-2');
    members.resolve({ data: { list: [{ id: 10, userid: 'external-1', type: 2,
      client: { id: 5, name: '旧成员', avatar: '', gender: 0 }, member: null,
      group_chat_num: 0, join_time: '', tags: [] }], count: 1 } });
    await tick();
    assert.equal(r.checkout.group.value, null);
    assert.equal(r.checkout.members.value.length, 0);
    assert.equal(r.checkout.access.token.value, '');
  } finally { r.stop(); b.dispose(); }
});

test('group member handoff checks the current group before opening an explicit customer route', async () => {
  const b = browser();
  const sdk = installTargetSdk('group', 'chat-1');
  const r = runtime({ component: 'pages/work/groupInfo/index.vue', send: call => {
    const config = workConfig(call); if (config) return config;
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') return { data: { token: 'group-secret',
      token_type: 'Bearer', expires_in: 300, target: { type: 'group', id: 7 } } };
    if (call.url === '/api/work/groupInfo') return { data: { id: 7, chat_id: 'chat-1', name: '旧群',
      owner: '', member_num: 1, todaySum: 0, retreat_group_num: 0, group_create_time: '', notice: '' } };
    assert.equal(call.url, '/api/work/groupMember/7');
    return { data: { list: [{ id: 10, userid: 'external-1', type: 2,
      client: { id: 5, name: '旧成员', avatar: '', gender: 0 }, member: null,
      group_chat_num: 0, join_time: '', tags: [] }], count: 1 } };
  } });
  try {
    await r.start({});
    await callbackTo(r, b.location, {});
    assert.equal(r.checkout.members.value.length, 1);
    sdk.switchTo('group', 'chat-2');
    await r.checkout.openClient(r.checkout.members.value[0]);
    assert.equal(r.navigations.length, 0);
    assert.equal(r.checkout.members.value.length, 0, 'token loss clears rendered group rows synchronously');
    assert.equal(r.checkout.access.token.value, '');
  } finally { r.stop(); b.dispose(); }
});

test('no-hint pagination refuses a changed chat before request and after a delayed response', async () => {
  for (const scenario of [
    { page: 'orderList', kind: 'client', endpoint: '/api/work/order/list',
      list: () => Array.from({ length: 10 }, (_, index) => ({ id: index + 1, order_id: `order-${index + 1}`,
        _add_time: '', pay_price: '8.00', total_num: 1, paid: 1, refund_type: 0, _status: {}, cartInfo: [] })),
      privateRows: page => page.rows.value.length },
    { page: 'record', kind: 'client', endpoint: '/api/work/product/cart_list',
      list: () => Array.from({ length: 10 }, (_, index) => ({ id: index + 1, store_name: `花 ${index + 1}`,
        image: '', stock: 1, price: '8.00', sales: 1 })),
      privateRows: page => page.items.value.length },
    { page: 'groupInfo', kind: 'group', endpoint: '/api/work/groupMember/7',
      list: () => [{ id: 10, userid: 'external-1', type: 2,
        client: { id: 5, name: '旧成员', avatar: '', gender: 0 }, member: null,
        group_chat_num: 0, join_time: '', tags: [] }],
      privateRows: page => page.members.value.length },
  ]) {
    for (const switchTime of ['before', 'during']) {
      const b = browser();
      const initialId = scenario.kind === 'group' ? 'chat-1' : 'external-1';
      const sdk = installTargetSdk(scenario.kind, initialId);
      const nextPage = deferred();
      const r = runtime({ component: `pages/work/${scenario.page}/index.vue`, send: call => {
        const config = workConfig(call); if (config) return config;
        if (call.url === '/api/work/context/challenge') return { data: {
          authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
        if (call.url === '/api/work/context/exchange') return { data: { token: 'work-secret',
          token_type: 'Bearer', expires_in: 300, target: { type: scenario.kind, id: 5 } } };
        if (call.url === '/api/work/groupInfo') return { data: { id: 7, chat_id: 'chat-1', name: '旧群',
          owner: '', member_num: 2, todaySum: 0, retreat_group_num: 0, group_create_time: '', notice: '' } };
        assert.equal(call.url, scenario.endpoint);
        if (call.data.page === 2) return nextPage.promise;
        return { data: scenario.kind === 'group'
          ? { list: scenario.list(), count: 2 } : scenario.list() };
      } });
      try {
        await r.start({});
        await callbackTo(r, b.location, {});
        assert.ok(r.checkout.hasMore.value, `${scenario.page} needs a second page`);
        if (switchTime === 'before') sdk.switchTo(scenario.kind,
          scenario.kind === 'group' ? 'chat-2' : 'external-2');
        const loading = r.checkout.loadMore();
        await tick();
        const secondRequests = r.calls.filter(call => call.url === scenario.endpoint && call.data.page === 2);
        assert.equal(secondRequests.length, switchTime === 'before' ? 0 : 1,
          `${scenario.page} ${switchTime} switch must guard the request boundary`);
        if (switchTime === 'during') {
          sdk.switchTo(scenario.kind, scenario.kind === 'group' ? 'chat-2' : 'external-2');
          nextPage.resolve({ data: scenario.kind === 'group'
            ? { list: scenario.list(), count: 2 } : scenario.list() });
        }
        await loading;
        assert.equal(scenario.privateRows(r.checkout), 0,
          `${scenario.page} ${switchTime} switch must immediately clear old private rows`);
        assert.equal(r.checkout.access.token.value, '');
      } finally { r.stop(); b.dispose(); }
    }
  }
});

test('switching Enterprise WeChat chats clears old customer and refuses to push old product into new chat', async () => {
  const b = browser();
  let currentChat = 'external-2';
  let pushes = 0;
  const sdk = {
    ready(callback) { this.readyCallback = callback; }, error() {},
    config() { queueMicrotask(() => this.readyCallback()); },
    agentConfig(input) { queueMicrotask(() => input.success()); },
    invoke(name, _input, callback) {
      if (name === 'getContext') queueMicrotask(() => callback({ err_msg: 'getContext:ok', entry: 'single_chat_tools' }));
      else if (name === 'getCurExternalContact') queueMicrotask(() => callback({ err_msg: 'getCurExternalContact:ok', userId: currentChat }));
      else { pushes++; queueMicrotask(() => callback({ err_msg: 'sendChatMessage:ok' })); }
    },
  };
  global.document = { ...global.document,
    createElement: () => ({ remove() {} }),
    head: { appendChild: element => queueMicrotask(() => element.onload()) },
  };
  global.window.jWeixin = sdk;
  const r = runtime({ component: 'pages/work/userInfo/index.vue', send: call => {
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') return { data: {
      token: 'old-client-secret', token_type: 'Bearer', expires_in: 300, target: { type: 'client', id: 5 } } };
    if (call.url === '/api/work/client/info') return { data: {
      id: 5, external_userid: 'external-1', uid: 8, name: '旧客户', avatar: '', corp_name: '',
      position: '', remark: '', tags: [], userInfo: null } };
    if (call.url === '/api/work/config') return { data: {
      appId: 'corp', timestamp: 1, nonceStr: 'nonce', signature: 'sig', jsApiList: [] } };
    if (call.url === '/api/work/agentConfig') return { data: {
      corpid: 'corp', agentid: 1, timestamp: 1, nonceStr: 'nonce', signature: 'sig', jsApiList: [] } };
    throw new Error(`unexpected API ${call.url}`);
  } });
  try {
    await r.start({ userid: 'external-1' });
    await callbackTo(r, b.location, { userid: 'external-1' });
    assert.equal(r.checkout.client.value.name, '旧客户');
    const work = r.load(path.join(root, 'src/composables/workContext.ts'));
    await assert.rejects(work.sendWorkProduct({ id: 3, store_name: '商品', image: '' }, 'old-client-secret'), /会话已切换/);
    await tick();
    assert.equal(pushes, 0);
    assert.equal(r.checkout.client.value, null);
    await assert.rejects(work.ensureWorkContext('client', '/pages/work/orderList/index'), /正在跳转企业微信授权/);
    const pending = JSON.parse(b.data.get('cinashop_work_oauth_pending'));
    assert.equal(pending.target.external_userid, currentChat);
    assert.equal(r.calls.filter(call => call.url === '/api/work/client/info').length, 1,
      'new chat cannot reuse old customer read');
  } finally { r.stop(); b.dispose(); }
});

test('Work order status change invalidates old rows and a denied read clears private data', async () => {
  const b = browser();
  const r = runtime({ component: 'pages/work/orderList/index.vue', send: call => {
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') return { data: {
      token: 'order-context', token_type: 'Bearer', expires_in: 300, target: { type: 'client', id: 5 } } };
    assert.equal(call.url, '/api/work/order/list');
    assert.equal(call.header.Authorization, 'Bearer order-context');
    if (call.data.type === 1) return { status: 403, httpStatus: 403, msg: '跟进关系已撤销' };
    return { data: [{ id: 9, order_id: 'order-9', _add_time: '2026-09-24', pay_price: '12.00',
      total_num: 1, paid: 0, refund_type: 0, _status: { _title: '待付款' }, cartInfo: [] }] };
  } });
  try {
    await r.start({ userid: 'external-1' });
    await callbackTo(r, b.location, { userid: 'external-1' });
    assert.equal(r.checkout.rows.value.length, 1);
    r.checkout.changeStatus(1);
    await tick();
    assert.equal(r.checkout.rows.value.length, 0);
    assert.match(r.checkout.access.error.value, /权限已变化/);
    assert.equal(r.auth.uid, 11);
  } finally { r.stop(); b.dispose(); }
});

test('Work purchased and visited product tabs use separate scoped endpoints and reset search paging', async () => {
  const b = browser();
  const r = runtime({ component: 'pages/work/record/index.vue', send: call => {
    if (call.url === '/api/work/context/challenge') return { data: {
      authorization_url: `https://open.weixin.qq.com/connect/oauth2/authorize?state=${state}`, state, expires_in: 300 } };
    if (call.url === '/api/work/context/exchange') return { data: {
      token: 'record-context', token_type: 'Bearer', expires_in: 300, target: { type: 'client', id: 5 } } };
    assert.equal(call.header.Authorization, 'Bearer record-context');
    assert.equal(call.data.page, 1);
    assert.equal(call.data.limit, 10);
    return { data: [{ id: 3, store_name: '花', image: '', stock: 4, price: '9.00', sales: 2 }] };
  } });
  try {
    await r.start({ userid: 'external-1' });
    await callbackTo(r, b.location, { userid: 'external-1' });
    assert.equal(r.checkout.items.value.length, 1);
    r.checkout.changeTab(1);
    r.checkout.searchInput.value = ' 花 ';
    r.checkout.search();
    await tick();
    assert.equal(r.checkout.items.value.length, 1);
    assert.deepEqual(r.calls.filter(call => call.url.includes('/product/')).map(call => call.url), [
      '/api/work/product/cart_list', '/api/work/product/visit_list',
    ]);
    assert.equal(r.calls.at(-1).data.store_name, '花');
  } finally { r.stop(); b.dispose(); }
});
