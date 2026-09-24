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
