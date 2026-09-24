const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const agreement = (type, content = '<p>协议正文</p>') => ({ data: { type, content } });
const memberAgreement = (overrides = {}) => ({ data: { member_explain: {
  id: 7, type: 1, title: '会员服务协议', content: '<p>会员正文</p>',
  sort: 0, status: 1, add_time: 1_700_000_000, ...overrides,
} } });

function start(send, query) {
  const r = runtime({ feature: 'useGovernanceAgreement', send });
  const titles = [];
  r.uni.setNavigationBarTitle = ({ title }) => titles.push(title);
  return r.start(query).then(() => ({ ...r, titles }));
}

test('legacy legal types use the public exact-key Worker contract and sanitize rich text', async () => {
  for (const [type, title] of [['user', '用户协议'], ['privacy', '隐私协议'], ['cancel', '注销协议'], ['supplier', '供应商入驻协议']]) {
    const r = await start(() => agreement(type, '<p onclick="evil()">正文</p><a href="javascript:evil()">链接</a><img src="/logo.png" onerror="evil()">'), { type });
    assert.deepEqual(r.calls, [{ url: `/api/user_agreement/${type}`, data: {} }]);
    assert.equal(r.checkout.title.value, title);
    assert.deepEqual(r.titles, [title]);
    assert.match(r.checkout.content.value, /正文/);
    assert.doesNotMatch(r.checkout.content.value, /onclick|onerror|javascript:/);
    assert.equal(r.checkout.loaded.value, true);
    r.stop();
  }
});

test('payVip reads the public member agreement, including without a shopper session', async () => {
  const r = runtime({ feature: 'useGovernanceAgreement', send: () => memberAgreement({ content: '<p onclick="evil()">会员正文</p>' }) });
  const titles = [];
  r.uni.setNavigationBarTitle = ({ title }) => titles.push(title);
  r.auth.clear();
  await r.start({ type: 'payVip' });
  assert.deepEqual(r.calls, [{ url: '/api/agreement/1', data: {} }]);
  assert.equal(r.checkout.title.value, '会员服务协议');
  assert.deepEqual(titles, ['会员服务协议']);
  assert.match(r.checkout.content.value, /会员正文/);
  assert.doesNotMatch(r.checkout.content.value, /onclick/);
  assert.equal(r.checkout.loaded.value, true);
  assert.deepEqual(r.navigations, []);
  r.stop();

  const empty = await start(() => ({ data: { member_explain: [] } }), { type: 'payVip' });
  assert.deepEqual(empty.calls, [{ url: '/api/agreement/1', data: {} }]);
  assert.equal(empty.checkout.loaded.value, true);
  assert.equal(empty.checkout.content.value, '');
  empty.stop();

  const disabled = await start(() => memberAgreement({ status: 0, content: '<p onclick="evil()">停用协议正文</p>' }), { type: 'payVip' });
  assert.deepEqual(disabled.calls, [{ url: '/api/agreement/1', data: {} }]);
  assert.match(disabled.checkout.content.value, /停用协议正文/);
  assert.doesNotMatch(disabled.checkout.content.value, /onclick/);
  assert.equal(disabled.checkout.error.value, '');
  disabled.stop();
});

test('payVip rejects a user-agreement alias, another agreement type, and malformed records', async () => {
  for (const response of [
    agreement('user', '<p>Wrong document</p>'),
    memberAgreement({ type: 2 }),
    memberAgreement({ status: 2 }),
    memberAgreement({ content: null }),
    { data: { member_explain: { id: 7, type: 1, title: '会员服务协议', content: '<p>Wrong shape</p>', status: 1 } } },
  ]) {
    const r = await start(() => response, { type: 'payVip' });
    assert.deepEqual(r.calls, [{ url: '/api/agreement/1', data: {} }]);
    assert.equal(r.checkout.content.value, '');
    assert.equal(r.checkout.error.value, '协议响应格式错误');
    r.stop();
  }
});

test('missing and unknown types never fall through to another agreement', async () => {
  for (const type of [undefined, '1', '', 'unexpected', '../user', ['user']]) {
    const r = await start(() => { throw Error('unexpected request'); }, type === undefined ? {} : { type });
    assert.equal(r.calls.length, 0);
    assert.equal(r.checkout.error.value, '协议类型不支持');
    assert.equal(r.checkout.content.value, '');
    r.hooks.onHide();
    r.hooks.onShow();
    await tick();
    assert.equal(r.checkout.error.value, '协议类型不支持');
    assert.equal(r.calls.length, 0);
    r.stop();
  }
});

test('public agreements remain available without a shopper session and reject mismatched response types', async () => {
  const r = runtime({ feature: 'useGovernanceAgreement', send: () => agreement('user', '<p>Wrong document</p>') });
  r.uni.setNavigationBarTitle = () => {};
  r.auth.clear();
  await r.start({ type: 'privacy' });
  assert.deepEqual(r.calls, [{ url: '/api/user_agreement/privacy', data: {} }]);
  assert.equal(r.navigations.length, 0);
  assert.equal(r.checkout.content.value, '');
  assert.equal(r.checkout.error.value, '协议响应格式错误');
  r.stop();
});

test('failed read retries explicitly and stale hidden responses cannot replace fresh content', async () => {
  let firstFailure = true;
  const retry = await start(() => firstFailure ? (firstFailure = false, { transport: 'offline' }) : agreement('cancel', '<p>重试成功</p>'), { type: 'cancel' });
  assert.match(retry.checkout.error.value, /offline/);
  assert.equal(retry.calls.length, 1);
  await retry.checkout.load();
  assert.equal(retry.calls.length, 2);
  assert.match(retry.checkout.content.value, /重试成功/);
  retry.stop();

  const old = deferred();
  let reads = 0;
  const r = await start(() => ++reads === 1 ? old.promise : agreement('privacy', '<p>新内容</p>'), { type: 'privacy' });
  r.hooks.onHide();
  assert.equal(r.checkout.content.value, '');
  r.hooks.onShow();
  await tick();
  assert.match(r.checkout.content.value, /新内容/);
  old.resolve(agreement('privacy', '<p>旧内容</p>'));
  await tick();
  assert.doesNotMatch(r.checkout.content.value, /旧内容/);
  r.stop();
});

test('agreement list contains exactly the legacy read-only links; candidate has no cancellation write', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/pages/user/agreements.vue'), 'utf8');
  const links = [...source.matchAll(/url="(\/pages\/user\/legalContent\?type=[^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, [
    '/pages/user/legalContent?type=user',
    '/pages/user/legalContent?type=privacy',
    '/pages/user/legalContent?type=cancel',
  ]);
  assert.doesNotMatch(source, /cancel\/user|rand_code|<form|@submit/);
});
