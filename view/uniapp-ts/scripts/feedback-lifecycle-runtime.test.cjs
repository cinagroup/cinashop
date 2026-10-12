const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vue = require('vue');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const component = 'pages/extension/customer_list/feedback.vue';
const composable = path.resolve(__dirname, '../src/composables/useFeedback.ts');
const fill = (page, content = '反馈内容') => {
  page.name.value = '张三'; page.phone.value = '13900000000'; page.content.value = content;
};
const postCount = r => r.calls.filter(call => call.data?.rela_name).length;
const run = submit => runtime({ component, send: call => call.method === 'GET'
  ? { data: { feedback: '稍后回复' } } : submit(call) });

test('feedback submits the validated snapshot once, accepts a real receipt and clears only the sent draft', async () => {
  const r = run(call => {
    assert.equal(call.url, '/api/user/service/feedback');
    assert.equal(call.header['Authori-zation'], 'Bearer synthetic-local-token');
    assert.deepEqual(call.data, { rela_name: '张三', phone: '13900000000', content: '反馈内容' });
    return { data: { id: 8 } };
  });
  try {
    await r.start(); assert.equal(r.checkout.message.value, '稍后回复');
    fill(r.checkout); await r.checkout.submit();
    assert.equal(postCount(r), 1); assert.equal(r.checkout.content.value, '');
    assert.equal(r.checkout.unknown.value, false); assert.equal(r.checkout.canEdit.value, true);
    assert.equal(r.toasts.at(-1).title, '反馈已提交');
  } finally { r.stop(); }
});

test('feedback invalid input and escaped-size boundaries send no POST', async () => {
  const r = run(() => { throw new Error('invalid feedback must not be sent'); });
  try {
    await r.start(); fill(r.checkout, "'".repeat(100)); await r.checkout.submit();
    assert.match(r.checkout.error.value, /转义后最多500字/);
    fill(r.checkout); r.checkout.phone.value = '100'; await r.checkout.submit();
    assert.match(r.checkout.error.value, /手机号/); assert.equal(postCount(r), 0);
    assert.equal(r.checkout.canEdit.value, true);
  } finally { r.stop(); }
});

test('feedback double click is one POST and disables editing until its receipt', async () => {
  const wait = deferred(), r = run(() => wait.promise);
  try {
    await r.start(); fill(r.checkout); const pending = r.checkout.submit(); await tick();
    assert.equal(r.checkout.submitting.value, true); assert.equal(r.checkout.canEdit.value, false);
    await r.checkout.submit(); assert.equal(postCount(r), 1);
    wait.resolve({ data: { id: 8 } }); await pending;
    assert.equal(r.checkout.submitting.value, false); assert.equal(r.checkout.canEdit.value, true);
    assert.equal(r.toasts.length, 1);
  } finally { wait.resolve({ data: { id: 8 } }); r.stop(); }
});

test('feedback receipt does not erase a later local draft that the request never sent', async () => {
  const wait = deferred(), r = run(() => wait.promise);
  try {
    await r.start(); fill(r.checkout, '已发送的A'); const pending = r.checkout.submit(); await tick();
    assert.equal(r.checkout.canEdit.value, false);
    // Native input is disabled; another local caller can still change the refs.
    fill(r.checkout, '未发送的B'); wait.resolve({ data: { id: 8 } }); await pending;
    assert.equal(r.calls.find(call => call.data?.rela_name).data.content, '已发送的A');
    assert.equal(r.checkout.content.value, '未发送的B'); assert.equal(r.toasts.length, 1);
  } finally { wait.resolve({ data: { id: 8 } }); r.stop(); }
});

test('feedback hide and resume discard a late introduction and load the current one', async () => {
  const old = deferred(); let reads = 0;
  const r = runtime({ component, send: () => ++reads === 1 ? old.promise : { data: { feedback: '当前介绍' } } });
  try {
    await r.start(); fill(r.checkout); r.hooks.onHide();
    assert.equal(r.checkout.name.value, '张三'); assert.equal(r.checkout.canEdit.value, false);
    r.hooks.onShow(); await tick(); assert.equal(r.checkout.message.value, '当前介绍');
    old.resolve({ data: { feedback: '旧介绍' } }); await tick();
    assert.equal(r.checkout.message.value, '当前介绍'); assert.equal(r.checkout.canEdit.value, true);
    assert.equal(r.checkout.name.value, '张三'); assert.equal(r.checkout.phone.value, '13900000000');
    assert.equal(r.checkout.content.value, '反馈内容'); assert.equal(postCount(r), 0);
  } finally { old.resolve({ data: { feedback: '' } }); r.stop(); }
});

test('feedback hidden pending POST becomes UNKNOWN and cannot publish a late success or resend on resume', async () => {
  const wait = deferred(), r = run(() => wait.promise);
  try {
    await r.start(); fill(r.checkout); const pending = r.checkout.submit(); await tick(); r.hooks.onHide();
    assert.equal(r.checkout.unknown.value, true); assert.equal(r.checkout.submitting.value, false);
    assert.equal(r.checkout.content.value, '反馈内容'); r.hooks.onShow(); await tick();
    assert.match(r.checkout.error.value, /尚未确认/); assert.equal(r.checkout.canEdit.value, false);
    fill(r.checkout); await r.checkout.submit(); assert.equal(postCount(r), 1);
    wait.resolve({ data: { id: 8 } }); await pending;
    assert.equal(r.checkout.unknown.value, true); assert.equal(r.toasts.length, 0);
    assert.equal(r.checkout.content.value, '反馈内容');
  } finally { wait.resolve({ data: { id: 8 } }); r.stop(); }
});

test('feedback unloaded POST keeps a same-login new page blocked without storing private feedback', async () => {
  const wait = deferred(), r = run(() => wait.promise); let nextScope;
  try {
    await r.start(); fill(r.checkout); const pending = r.checkout.submit(); await tick(); r.stop();
    nextScope = vue.effectScope();
    const next = nextScope.run(() => r.load(composable).useFeedback());
    r.hooks.onShow(); await tick();
    assert.equal(next.unknown.value, true); assert.equal(next.canEdit.value, false);
    assert.equal(next.name.value, ''); assert.equal(next.phone.value, ''); assert.equal(next.content.value, '');
    fill(next); await next.submit(); assert.equal(postCount(r), 1);
    assert.deepEqual([...r.storage.keys()].sort(), ['uni_token', 'uni_uid']);
    wait.resolve({ data: { id: 8 } }); await pending;
    assert.equal(next.unknown.value, true); assert.equal(r.toasts.length, 0);
  } finally { wait.resolve({ data: { id: 8 } }); nextScope?.stop(); r.stop(); }
});

test('feedback Vue scope disposal alone invalidates a pending POST without a native unload hook', async () => {
  const wait = deferred(), r = run(() => wait.promise);
  try {
    await r.start(); fill(r.checkout); const pending = r.checkout.submit(); await tick();
    delete r.hooks.onUnload; r.stop();
    assert.equal(r.checkout.content.value, '');
    // Computed refs may retain cached values after effectScope.stop(). The detached
    // handler itself must refuse a new request regardless of those cached values.
    fill(r.checkout, '离页后调用'); await r.checkout.submit(); assert.equal(postCount(r), 1);
    wait.resolve({ data: { id: 8 } }); await pending;
    assert.equal(r.toasts.length, 0); assert.equal(r.checkout.content.value, '离页后调用');
  } finally { wait.resolve({ data: { id: 8 } }); r.stop(); }
});

test('feedback two live instances reuse a refreshed login record and a hidden write blocks a later same-login page', async () => {
  const wait = deferred(), r = run(() => wait.promise); let secondScope, thirdScope;
  try {
    await r.start(); const firstHooks = { ...r.hooks };
    secondScope = vue.effectScope();
    const second = secondScope.run(() => r.load(composable).useFeedback());
    r.hooks.onShow(); await tick();
    // Both existing instances observe this refresh synchronously. Neither may
    // replace the other instance's shared record with an independent idle record.
    r.auth.setLogin('refreshed-local-token', 11); fill(r.checkout, '刷新登录后的反馈');
    const pending = r.checkout.submit(); await tick();
    assert.equal(second.submitting.value, true); assert.equal(second.canEdit.value, false);
    firstHooks.onHide(); assert.equal(second.unknown.value, true);
    firstHooks.onUnload(); secondScope.stop();
    thirdScope = vue.effectScope();
    const third = thirdScope.run(() => r.load(composable).useFeedback());
    r.hooks.onShow(); await tick(); fill(third); await third.submit();
    assert.equal(third.unknown.value, true); assert.equal(third.canEdit.value, false); assert.equal(postCount(r), 1);
    wait.resolve({ data: { id: 8 } }); await pending;
    assert.equal(third.unknown.value, true); assert.equal(r.toasts.length, 0);
  } finally { wait.resolve({ data: { id: 8 } }); secondScope?.stop(); thirdScope?.stop(); r.stop(); }
});

test('feedback token-only refresh cannot clear UNKNOWN shared by two live pages or let an old response clear a new draft', async () => {
  const wait = deferred(), r = run(() => wait.promise); let secondScope;
  try {
    await r.start(); const firstHooks = { ...r.hooks };
    secondScope = vue.effectScope();
    const second = secondScope.run(() => r.load(composable).useFeedback());
    r.hooks.onShow(); await tick(); fill(r.checkout);
    const pending = r.checkout.submit(); await tick(); const epoch = r.auth.sessionVersion;
    r.auth.token = 'token-refreshed-without-login';
    assert.equal(r.auth.sessionVersion, epoch); assert.equal(r.checkout.content.value, '');
    assert.equal(r.checkout.unknown.value, true); assert.equal(second.unknown.value, true);
    fill(second, '新的本地草稿'); await second.submit(); assert.equal(postCount(r), 1);
    firstHooks.onHide(); r.hooks.onShow(); await tick();
    assert.equal(second.unknown.value, true); wait.resolve({ data: { id: 8 } }); await pending;
    assert.equal(second.content.value, '新的本地草稿'); assert.equal(second.canEdit.value, false);
    assert.equal(r.toasts.length, 0);
  } finally { wait.resolve({ data: { id: 8 } }); secondScope?.stop(); r.stop(); }
});

test('feedback uid22 and ABA identity changes clear old drafts and locks without letting old POST reset a newer submission', async () => {
  const waits = [deferred(), deferred(), deferred()]; let writes = 0;
  const r = run(() => waits[writes++].promise);
  try {
    await r.start(); fill(r.checkout, '旧用户A'); const first = r.checkout.submit(); await tick();
    r.auth.setLogin('user22-local-token', 22);
    assert.equal(r.checkout.content.value, ''); assert.equal(r.checkout.submitting.value, false);
    assert.equal(r.checkout.canEdit.value, true); fill(r.checkout, '用户22');
    const second = r.checkout.submit(); await tick();
    r.auth.setLogin('synthetic-local-token', 11);
    assert.equal(r.checkout.content.value, ''); assert.equal(r.checkout.submitting.value, false);
    fill(r.checkout, '重新登录的A'); const third = r.checkout.submit(); await tick();
    waits[0].resolve({ data: { id: 8 } }); waits[1].resolve({ transport: 'old timeout' });
    await Promise.all([first, second]);
    assert.equal(r.checkout.submitting.value, true); assert.equal(r.checkout.content.value, '重新登录的A');
    assert.equal(r.checkout.error.value, ''); assert.equal(r.toasts.length, 0);
    waits[2].resolve({ data: { id: 9 } }); await third;
    assert.equal(r.checkout.content.value, ''); assert.equal(r.toasts.length, 1); assert.equal(postCount(r), 3);
  } finally { waits.forEach(wait => wait.resolve({ data: { id: 9 } })); r.stop(); }
});

test('feedback old identity read cannot refill the new identity introduction', async () => {
  const wait = deferred(); let reads = 0;
  const r = runtime({ component, send: () => ++reads === 1 ? wait.promise : { data: { feedback: '新登录介绍' } } });
  try {
    await r.start(); r.auth.setLogin('user22-local-token', 22); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.message.value, '新登录介绍');
    wait.resolve({ data: { feedback: '旧登录介绍' } }); await tick();
    assert.equal(r.checkout.message.value, '新登录介绍'); assert.equal(r.checkout.error.value, '');
  } finally { wait.resolve({ data: { feedback: '' } }); r.stop(); }
});

for (const httpStatus of [200, 400]) {
  test(`feedback explicit pre-insert status400/HTTP${httpStatus} preserves editable draft for a corrected retry`, async () => {
    let attempts = 0;
    const r = run(() => ++attempts === 1 ? { status: 400, httpStatus, msg: '手机号格式错误' } : { data: { id: 8 } });
    try {
      await r.start(); fill(r.checkout); await r.checkout.submit();
      assert.equal(r.checkout.canEdit.value, true); assert.equal(r.checkout.unknown.value, false);
      assert.equal(r.checkout.content.value, '反馈内容'); assert.equal(r.checkout.error.value, '手机号格式错误');
      r.checkout.phone.value = '13800000000'; await r.checkout.submit();
      assert.equal(postCount(r), 2); assert.equal(r.toasts.length, 1);
      assert.equal(r.calls.filter(call => call.data?.rela_name).at(-1).data.phone, '13800000000');
    } finally { r.stop(); }
  });
}

for (const [label, result] of [
  ['transport timeout', { transport: 'timeout-after-possible-commit' }],
  ['status500 over HTTP200', { status: 500, httpStatus: 200, msg: '服务异常' }],
  ['status400 over HTTP500', { status: 400, httpStatus: 500, msg: 'contradictory rejection' }],
  ['HTTP503', { status: 503, httpStatus: 503, msg: 'service unavailable' }],
  ['non-numeric envelope status', { status: '200', data: { id: 8 } }],
  ['ambiguous response headers', { headers: { 'X-Receipt': 'a', 'x-receipt': 'b' }, data: { id: 8 } }],
  ['undefined receipt', { data: undefined }],
  ['null receipt', { data: null }],
  ['missing id', { data: {} }],
  ['string id', { data: { id: '8' } }],
  ['zero id', { data: { id: 0 } }],
  ['negative id', { data: { id: -1 } }],
  ['fractional id', { data: { id: 1.5 } }],
  ['unsafe integer id', { data: { id: Number.MAX_SAFE_INTEGER + 1 } }],
]) {
  test(`feedback ${label} is UNKNOWN, has no success toast and blocks a second POST`, async () => {
    const r = run(() => result);
    try {
      await r.start(); fill(r.checkout); await r.checkout.submit();
      assert.equal(r.checkout.unknown.value, true); assert.equal(r.checkout.submitting.value, false);
      assert.equal(r.checkout.canEdit.value, false); assert.match(r.checkout.error.value, /尚未确认/);
      assert.equal(r.checkout.content.value, '反馈内容'); assert.equal(r.toasts.length, 0);
      await r.checkout.submit(); assert.equal(postCount(r), 1);
    } finally { r.stop(); }
  });
}

test('feedback optional introduction failure does not overwrite an uncertain POST warning', async () => {
  const intro = deferred();
  const r = runtime({ component, send: call => call.method === 'GET' ? intro.promise : { transport: 'timeout' } });
  try {
    await r.start(); fill(r.checkout); await r.checkout.submit();
    const warning = r.checkout.error.value; intro.resolve({ transport: 'intro unavailable' }); await tick();
    assert.equal(r.checkout.error.value, warning); assert.equal(r.checkout.unknown.value, true);
    assert.equal(r.checkout.message.value, '');
  } finally { intro.resolve({ data: { feedback: '' } }); r.stop(); }
});

test('feedback logout and invalid identity do not dispatch reads or writes, and disposed login cannot navigate', async () => {
  const r = run(() => { throw new Error('logged-out feedback must not be sent'); });
  try {
    await r.start(); r.auth.clear(); const calls = r.calls.length;
    r.hooks.onShow(); fill(r.checkout); await r.checkout.submit();
    assert.equal(r.checkout.loggedIn.value, false); assert.equal(r.checkout.canEdit.value, false);
    assert.equal(r.calls.length, calls); r.checkout.login();
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.stop(); r.checkout.login(); assert.equal(r.navigations.length, 1);
  } finally { r.stop(); }
});
