const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');
function setup(send = () => ({ data: { id: 31 } })) {
  const r = runtime({ feature: 'useCommunityPublish', send });
  const choices = [], uploads = [];
  r.uni.chooseVideo = options => choices.push(options);
  r.uni.uploadFile = options => uploads.push(options);
  return Object.assign(r, { choices, uploads });
}
const uploaded = { url: '/api/assets/71', src: '/api/assets/71?expires=9999999999&signature=test', name: 'clip.mp4' };
async function select(r) {
  r.checkout.chooseVideo();
  const work = r.choices.at(-1).success({ size: 2048, tempFilePath: '/owned/clip.mp4' });
  await tick();
  r.uploads.at(-1).success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploaded }) });
  await work;
}
test('video selection uploads once, publishes only canonical ownership reference and keeps the topic', async () => {
  const r = setup();
  try {
    await r.start(); await select(r); const p = r.checkout;
    assert.equal(r.uploads.length, 1); assert.equal(r.uploads[0].url, '/api/upload/video');
    assert.equal(r.uploads[0].header['Authori-zation'], 'Bearer synthetic-local-token');
    p.title.value = '短片'; p.content.value = '测试视频'; assert.equal(await p.publish(9), 31);
    assert.deepEqual(r.calls, [{ url: '/api/community_save', data: { title: '短片', content: '测试视频',
      content_type: 2, video_url: '/api/assets/71', topic_id: [9] } }]);
    assert.equal(r.modals.length, 0);
  } finally { r.stop(); }
});
test('text publishing survives and uploaded videos can be removed before publishing', async () => {
  const r = setup();
  try {
    await r.start(); await select(r); r.checkout.removeVideo(); r.checkout.content.value = '文字';
    await r.checkout.publish(); assert.equal(r.calls[0].data.content_type, 1);
    assert.equal(r.calls[0].data.video_url, undefined);
  } finally { r.stop(); }
});
test('oversized/cancelled selections perform no upload and show useful validation', async () => {
  const r = setup();
  try {
    await r.start(); r.checkout.chooseVideo();
    await r.choices[0].success({ size: 50 * 1024 * 1024 + 1, tempFilePath: '/large' });
    assert.match(r.checkout.error.value, /50 MiB/); assert.equal(r.uploads.length, 0);
    r.checkout.chooseVideo(); r.choices[1].fail({ errMsg: 'chooseVideo:fail cancel' });
    assert.equal(r.checkout.choosing.value, false); assert.equal(r.checkout.error.value, '');
  } finally { r.stop(); }
});
test('duplicate choose/publish and secondary controls cannot replay a pending request', async () => {
  const waiting = deferred(), r = setup(() => waiting.promise);
  try {
    await r.start(); r.checkout.chooseVideo(); r.checkout.chooseVideo(); assert.equal(r.choices.length, 1);
    r.choices[0].fail({ errMsg: 'cancel' }); r.checkout.content.value = '一次';
    const work = r.checkout.publish(); await tick(); await r.checkout.publish();
    r.checkout.chooseVideo(); assert.equal(r.checkout.reset(), false); assert.equal(r.calls.length, 1);
    waiting.resolve({ data: { id: 31 } }); assert.equal(await work, 31);
  } finally { waiting.resolve({ data: { id: 31 } }); r.stop(); }
});
test('uncertain publish blocks replay until the user explicitly ends the draft', async () => {
  for (const failure of [{ transport: 'lost reply' }, { httpStatus: 503, status: 503 }, { httpStatus: 503, status: 400 }, { data: { id: 'invalid' } }]) {
    const r = setup(() => failure);
    try {
      await r.start(); r.checkout.content.value = '未知'; await r.checkout.publish();
      assert.equal(r.checkout.unknown.value, true); assert.match(r.checkout.error.value, /勿重复发布/);
      await r.checkout.publish(); assert.equal(r.calls.length, 1);
      assert.equal(r.checkout.reset(), true); assert.equal(r.checkout.content.value, '');
    } finally { r.stop(); }
  }
});
test('business validation rejection preserves editable content without pretending success', async () => {
  const r = setup(() => ({ status: 400, msg: '视频已失效' }));
  try {
    await r.start(); r.checkout.content.value = '保留'; await r.checkout.publish();
    assert.equal(r.checkout.unknown.value, false); assert.equal(r.checkout.content.value, '保留');
    assert.equal(r.checkout.error.value, '视频已失效'); assert.equal(r.checkout.publishedId.value, 0);
  } finally { r.stop(); }
});
test('upload failures never turn a video into a text post, and can be explicitly reselected', async () => {
  const r = setup();
  try {
    await r.start(); r.checkout.chooseVideo(); const work = r.choices[0].success({ size: 5, tempFilePath: '/clip' });
    await tick(); r.uploads[0].fail(); await work;
    assert.equal(r.checkout.video.value, null); assert.equal(r.checkout.busy.value, false);
    assert.match(r.checkout.error.value, /重新选择/); r.checkout.content.value = '不得变成文字'; await r.checkout.publish(); assert.equal(r.calls.length, 0);
    await select(r); assert.equal(r.checkout.video.value.url, uploaded.url);
  } finally { r.stop(); }
});
test('upload callbacks from old accounts or hidden pages cannot supply video to a later draft', async () => {
  for (const boundary of ['account', 'hide', 'unload']) {
    const r = setup();
    try {
      await r.start(); r.checkout.chooseVideo();
      const work = r.choices[0].success({ size: 5, tempFilePath: '/clip' }); await tick();
      if (boundary === 'account') r.auth.setLogin('other-token', 22);
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      r.uploads[0].success({ statusCode: 200, data: JSON.stringify({ status: 200, data: uploaded }) });
      await work; assert.equal(r.checkout.video.value, null); assert.equal(r.calls.length, 0);
    } finally { r.stop(); }
  }
});
test('lost ownership and page lifecycle suppress stale publish success', async () => {
  for (const boundary of ['account', 'hide', 'unload']) {
    const waiting = deferred(), r = setup(() => waiting.promise);
    try {
      await r.start(); r.checkout.content.value = '旧请求'; const work = r.checkout.publish(); await tick();
      if (boundary === 'account') r.auth.setLogin('other-token', 22);
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      waiting.resolve({ data: { id: 31 } }); assert.equal(await work, null);
      assert.equal(r.checkout.publishedId.value, 0); assert.equal(r.calls.length, 1);
    } finally { waiting.resolve({ data: { id: 31 } }); r.stop(); }
  }
});

test('the actual page does not reopen a private post preview after hiding during its feed refresh', async () => {
  const waiting = deferred(); let saved = false;
  const r = runtime({ component: 'pages/discover/index.vue', send: call => {
    if (call.url === '/api/community_save') { saved = true; return { data: { id: 31 } }; }
    if (saved && call.url === '/api/community/list') return waiting.promise;
    if (call.url === '/api/community/detail/31') throw Error('Stale detail read must not start');
    return { data: [] };
  } });
  try {
    await r.start({}); r.checkout.publishContent.value = '待审核';
    const work = r.checkout.publish(); await tick(); r.hooks.onHide();
    waiting.resolve({ data: [] }); await work;
    assert.equal(r.checkout.detail.value, null);
    assert.equal(r.calls.filter(call => call.url === '/api/community/detail/31').length, 0);
  } finally { waiting.resolve({ data: [] }); r.stop(); }
});
