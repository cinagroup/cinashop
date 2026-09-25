const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const promoter = (overrides = {}) => ({ user: {
  id: 7, uid: 11, nickname: 'Alice', real_name: 'Alice Chen', phone: '13800138000',
  status: 2, add_time: '2026-09-24 10:00:00', status_time: '2026-09-24 11:00:00',
  refusal_reason: '请核对姓名', ...overrides,
}, agreement: { content: '<p>分销说明</p>' } });
const division = (overrides = {}) => ({
  id: 9, uid: 11, divisionName: '青山代理商', name: 'Alice', phone: '13800138000',
  divisionInvite: 123456, images: ['/assets/one'], status: 2,
  addTime: 1727160000, statusTime: 1727163600, refusalReason: '请补充资质', ...overrides,
});

test('promoter application reads its own response shape and submits only that identity', async () => {
  const writes = [];
  const r = runtime({ component: 'components/AgentApplicationForm.vue', props: { kind: 'promoter' }, send: call => {
    if (call.url.endsWith('/user/promoter/apply/info')) return { data: promoter() };
    if (call.url.endsWith('/user/promoter/apply/7')) { writes.push(call); return { data: { id: 7 } }; }
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.checkout.load();
    assert.equal(r.checkout.application.value.kind, 'promoter');
    assert.equal(r.checkout.form.name, 'Alice Chen');
    r.checkout.form.code = '042731';
    r.checkout.agreed.value = true;
    await r.checkout.submit();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].data, { nickname: 'Alice', real_name: 'Alice Chen', phone: '13800138000', code: '042731' });
    assert.equal(r.navigations.at(-1), '/pages/users/agent/state?type=promoter&id=7');
  } finally { r.stop(); }
});

test('agent application requires invitation and image, then uses separate division endpoint', async () => {
  const writes = [];
  const r = runtime({ component: 'components/AgentApplicationForm.vue', props: { kind: 'agent' }, send: call => {
    if (call.url.endsWith('/division/agent/apply/info')) return { data: division() };
    if (call.url.endsWith('/agreement/2')) return { data: { member_explain: { type: 2, status: 1, content: '<p>代理商协议</p>' } } };
    if (call.url.endsWith('/division/agent/apply/9')) { writes.push(call); return { data: { id: 9 } }; }
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.checkout.load();
    assert.equal(r.checkout.application.value.kind, 'agent');
    r.checkout.form.images = [];
    r.checkout.form.code = '998877';
    r.checkout.agreed.value = true;
    await r.checkout.submit();
    assert.equal(writes.length, 0);
    assert.match(r.checkout.error.value, /完整填写/);
    r.checkout.form.images = ['/assets/one'];
    await r.checkout.submit();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].data, {
      division_name: '青山代理商', name: 'Alice', phone: '13800138000', code: '998877',
      division_invite: 123456, images: ['/assets/one'],
    });
    assert.equal(r.navigations.at(-1), '/pages/users/agent/state?type=agent&id=9');
  } finally { r.stop(); }
});

test('disabled agent agreement prevents application submission', async () => {
  let writes = 0;
  const r = runtime({ component: 'components/AgentApplicationForm.vue', props: { kind: 'agent' }, send: call => {
    if (call.url.endsWith('/division/agent/apply/info')) return { data: division() };
    if (call.url.endsWith('/agreement/2')) return { data: { member_explain: { type: 2, status: 0, content: '<p>已停用</p>' } } };
    if (call.url.endsWith('/division/agent/apply/9')) { writes++; return { data: { id: 9 } }; }
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.checkout.load();
    r.checkout.form.code = '998877'; r.checkout.agreed.value = true;
    await r.checkout.submit();
    assert.equal(writes, 0);
    assert.match(r.checkout.error.value, /协议/);
  } finally { r.stop(); }
});

test('unknown submit result freezes automatic replay until explicit status reread', async () => {
  let writes = 0;
  const r = runtime({ component: 'components/AgentApplicationForm.vue', props: { kind: 'promoter' }, send: call => {
    if (call.url.endsWith('/user/promoter/apply/info')) return { data: promoter() };
    if (call.url.endsWith('/user/promoter/apply/7')) { writes++; return { transport: 'connection lost' }; }
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.checkout.load();
    r.checkout.form.code = '042731'; r.checkout.agreed.value = true;
    await r.checkout.submit();
    assert.equal(r.checkout.submissionUnknown.value, true);
    await r.checkout.submit();
    assert.equal(writes, 1);
    await r.checkout.load();
    assert.equal(r.checkout.submissionUnknown.value, false);
    assert.equal(r.checkout.form.code, '');
  } finally { r.stop(); }
});

test('old state link refuses another application id and record reads both domains', async () => {
  const state = runtime({ component: 'pages/users/agent/state.vue', send: call => {
    assert.equal(call.url, '/api/user/promoter/apply/info'); return { data: promoter({ status: 1 }) };
  } });
  try {
    await state.start({ type: 'promoter', id: '999' });
    assert.equal(state.checkout.application.value, null);
    assert.match(state.checkout.error.value, /编号与当前账号不匹配/);
  } finally { state.stop(); }
  const record = runtime({ component: 'pages/users/agent/record.vue', send: call => {
    if (call.url.endsWith('/user/promoter/apply/info')) return { data: promoter() };
    if (call.url.endsWith('/division/agent/apply/info')) return { data: division() };
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await record.start();
    assert.deepEqual(record.checkout.applications.value.map(row => row.kind), ['promoter', 'agent']);
    record.checkout.open(record.checkout.applications.value[1]);
    assert.equal(record.navigations.at(-1), '/pages/users/agent/state?type=agent&id=9');
  } finally { record.stop(); }
});

test('stale account response cannot populate another user application', async () => {
  const old = deferred();
  let reads = 0;
  const r = runtime({ component: 'components/AgentApplicationForm.vue', props: { kind: 'promoter' }, send: call => {
    if (!call.url.endsWith('/user/promoter/apply/info')) throw Error('unexpected');
    return ++reads === 1 ? old.promise : { data: promoter({ uid: 22, nickname: 'Bob', id: 22 }) };
  } });
  try {
    const first = r.checkout.load();
    r.auth.setLogin('second-user-token', 22);
    await tick();
    old.resolve({ data: promoter() });
    await first; await tick();
    assert.equal(r.checkout.application.value.uid, 22);
    assert.equal(r.checkout.application.value.nickname, 'Bob');
  } finally { r.stop(); }
});

test('image picker and upload cannot write into a different login session', async () => {
  let picker;
  let upload;
  const r = runtime({ component: 'components/AgentApplicationForm.vue', props: { kind: 'agent' }, send: call => {
    if (call.url.endsWith('/division/agent/apply/info')) return { data: division(r.auth.uid === 11 ? {} : { id: r.auth.uid, images: [] }) };
    if (call.url.endsWith('/agreement/2')) return { data: { member_explain: { type: 2, status: 1, content: '<p>代理商协议</p>' } } };
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.checkout.load();
    r.uni.chooseImage = options => { picker = options; };
    r.uni.uploadFile = options => { upload = options; };
    const oldPicker = r.checkout.chooseImages();
    assert.ok(picker);
    r.auth.setLogin('second-user-token', 22);
    await tick();
    picker.success({ tempFilePaths: ['/old-owner-image'] });
    await oldPicker;
    assert.equal(upload, undefined, 'old picker must not upload under the new token');
    assert.deepEqual(r.checkout.form.images, []);

    const currentPicker = r.checkout.chooseImages();
    picker.success({ tempFilePaths: ['/second-owner-image'] });
    await tick();
    assert.ok(upload);
    r.auth.setLogin('third-user-token', 33);
    await tick();
    upload.success({ statusCode: 200, data: JSON.stringify({ status: 200, data: { url: '/old', src: '/old' } }) });
    await currentPicker;
    assert.deepEqual(r.checkout.form.images, [], 'late upload response must not mutate the third owner');
  } finally { r.stop(); }
});

test('late SMS challenge failure cannot leave the next account blocked or in error', async () => {
  const oldChallenge = deferred();
  const r = runtime({ component: 'components/AgentApplicationForm.vue', props: { kind: 'promoter' }, send: call => {
    if (call.url.endsWith('/user/promoter/apply/info')) return { data: promoter({ id: r.auth.uid }) };
    if (call.url.endsWith('/verify_code')) return oldChallenge.promise;
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.checkout.load();
    const sending = r.checkout.sendCode();
    await tick();
    assert.equal(r.checkout.sendingCode.value, true);
    r.auth.setLogin('new-owner-token', 22);
    await tick();
    assert.equal(r.checkout.sendingCode.value, false);
    oldChallenge.resolve({ transport: 'old challenge failed' });
    await sending;
    assert.equal(r.checkout.error.value, '');
    assert.equal(r.checkout.sendingCode.value, false);
  } finally { r.stop(); }
});

test('state and record stop loading on logout while their old reads are pending', async () => {
  for (const component of ['pages/users/agent/state.vue', 'pages/users/agent/record.vue']) {
    const pending = deferred();
    const r = runtime({ component, send: call => {
      if (call.url.endsWith('/division/agent/apply/info')) return pending.promise;
      if (call.url.endsWith('/user/promoter/apply/info')) return { data: promoter() };
      throw Error(`unexpected ${call.url}`);
    } });
    try {
      await r.start(component.endsWith('state.vue') ? { type: 'agent', id: '9' } : {});
      assert.equal(r.checkout.loading.value, true);
      r.auth.clear();
      await tick();
      assert.equal(r.checkout.loading.value, false);
      assert.equal(r.checkout.error.value, '请先登录');
      pending.resolve({ data: division() });
      await tick();
      assert.equal(r.checkout.loading.value, false);
      assert.equal(r.checkout.error.value, '请先登录');
    } finally { r.stop(); }
  }
});

test('staff removal prompt and percent write ignore changed login sessions', async () => {
  let modal;
  const write = deferred();
  const writes = [];
  const row = uid => ({ uid, nickname: `User ${uid}`, phone: '13800138000', divisionPercent: 10, orderCount: 2,
    spreadTime: 0, payCount: 0, numberCount: '0', avatar: '' });
  const r = runtime({ component: 'pages/users/agent/staff_list.vue', modal: options => { modal = options; }, send: call => {
    if (call.url.endsWith('/division/agent/staff_list')) return { data: { list: [row(r.auth.uid === 11 ? 33 : 44)], count: 1,
      page: 1, limit: 20, brokerage: '0' } };
    if (call.url.endsWith('/division/agent/staff_percent')) { writes.push(call); return write.promise; }
    if (call.url.includes('/division/agent/staff/')) { writes.push(call); return { data: null }; }
    throw Error(`unexpected ${call.url}`);
  } });
  try {
    await r.start();
    r.checkout.remove(r.checkout.staff.value[0]);
    r.auth.setLogin('second-user-token', 22);
    await tick();
    modal.success({ confirm: true });
    await tick();
    assert.equal(writes.length, 0, 'old owner confirmation must not issue DELETE');

    r.checkout.beginPercent(r.checkout.staff.value[0]);
    r.checkout.percent.value = '20';
    const saving = r.checkout.savePercent();
    await tick();
    assert.equal(writes.length, 1);
    r.auth.setLogin('third-user-token', 33);
    await tick();
    write.resolve({ data: null });
    await saving;
    await tick();
    assert.equal(r.checkout.writeNotice.value, '');
    assert.equal(r.checkout.writing.value, false);
    assert.equal(r.checkout.staff.value[0].uid, 44);
  } finally { r.stop(); }
});

test('promoter UTC text and division epoch render as the same Shanghai instant', () => {
  const r = runtime({ component: 'pages/users/agent/record.vue', send: () => ({ data: division() }) });
  try {
    const { formatAgentApplicationTime } = r.load(require('node:path').join(__dirname, '../src/api/agentSelfService.ts'));
    const seconds = Date.UTC(2024, 8, 24, 6, 40, 0) / 1000;
    assert.equal(formatAgentApplicationTime('2024-09-24 06:40:00'), '2024-09-24 14:40');
    assert.equal(formatAgentApplicationTime(seconds), '2024-09-24 14:40');
    assert.equal(formatAgentApplicationTime('2024-02-30 06:40:00'), '');
  } finally { r.stop(); }
});
