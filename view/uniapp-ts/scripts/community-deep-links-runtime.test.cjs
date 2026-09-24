const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

const root = path.resolve(__dirname, '..');
const topic = { id: 1, name: '生活灵感', isRecommend: 1 };
const post = (id, extra = {}) => ({ id, type: 2, relationId: 101, contentType: 1,
  title: `周末分享 ${id}`, content: '周末在花市散步', image: '', sliderImage: null,
  likeNum: id, commentNum: 1, playNum: 3, isLike: 0, status: 1, addTime: 1786710800,
  topic_id: [1], ...extra });
const video = post(9003, { contentType: 2, title: '周末花市短片', videoUrl: 'https://media.example.test/9003.mp4' });

function setup(mode, send, videoRoute) {
  const r = runtime({ feature: 'useCommunityDeepLink', send });
  const feed = mode === 'topic' ? r.checkout : r.load(path.join(root, 'src/composables/useCommunityDeepLink.ts')).useCommunityDeepLink(mode, videoRoute);
  return { r, feed, stop() { feed.dispose(); if (feed !== r.checkout) r.checkout.dispose(); r.stop(); } };
}

test('legacy topic id resolves against live topic catalogue and filters hot/new pages', async () => {
  const { r, feed, stop } = setup('topic', call => call.url.endsWith('/community/topic')
    ? { data: [topic] } : { data: [post(9001)] });
  try {
    await feed.initialize({ id: '1', name: 'untrusted name' });
    assert.equal(feed.topicName.value, topic.name);
    assert.deepEqual(r.calls.map(call => call.url), ['/api/community/topic', '/api/community/list']);
    assert.deepEqual(r.calls[1].data, { page: 1, limit: 20, topic_id: 1, order: 2 });
    feed.changeOrder(1);
    assert.deepEqual(r.navigations, ['/pages/discover/discoverTopic/index?id=1&order=1']);
    assert.deepEqual(feed.posts.value.map(item => item.id), [9001]);
  } finally { stop(); }
});

test('invalid or retired topic deep links fail closed before listing any posts', async () => {
  for (const query of [{ id: '../1' }, { id: '2' }]) {
    const { r, feed, stop } = setup('topic', () => ({ data: [topic] }));
    try {
      await feed.initialize(query);
      assert.match(feed.routeError.value, /无效|不存在/);
      assert.equal(r.calls.filter(call => call.url.endsWith('/community/list')).length, 0);
      assert.deepEqual(feed.posts.value, []);
    } finally { stop(); }
  }
});

test('search consumes keyword/topic query, updates address on search and retries exact page', async () => {
  let failPageTwo = true;
  const { r, feed, stop } = setup('search', call => {
    if (call.url.endsWith('/community/topic')) return { data: [topic] };
    if (call.data.page === 2 && failPageTwo) { failPageTwo = false; return { transport: 'offline' }; }
    return { data: call.data.page === 1 ? Array.from({ length: 20 }, (_, index) => post(9000 + index)) : [post(9020)] };
  });
  try {
    await feed.initialize({ keyword: ' 周末 ', topic_id: '1' });
    assert.deepEqual(r.calls[1].data, { page: 1, limit: 20, topic_id: 1, keyword: '周末' });
    feed.keywordInput.value = '花 市';
    feed.submitSearch();
    assert.deepEqual(r.navigations, ['/pages/discover/discoverSearch/index?keyword=%E8%8A%B1%20%E5%B8%82&topic_id=1']);
    await feed.loadMore();
    assert.match(feed.error.value, /offline/);
    assert.equal(feed.posts.value.length, 20);
    await feed.loadMore();
    assert.equal(feed.posts.value.length, 21);
    assert.deepEqual(r.calls.filter(call => call.url.endsWith('/community/list')).map(call => call.data.page), [1, 2, 2]);
    feed.selectTopic(null);
    assert.equal(r.navigations.at(-1), '/pages/discover/discoverSearch/index?keyword=%E5%91%A8%E6%9C%AB');
  } finally { stop(); }
});

test('video deep link pins exact post and applies type/start/author filters to later pages', async () => {
  const { r, feed, stop } = setup('video', call => call.url.endsWith('/detail/9003')
    ? { data: video } : { data: [video, post(9002, { contentType: 2 })] });
  try {
    await feed.initialize({ id: '9003', relation_id: '101' });
    assert.equal(feed.activeVideo.value.id, 9003);
    assert.deepEqual(feed.posts.value.map(item => item.id), [9003, 9002]);
    assert.deepEqual(r.calls.map(call => call.url), ['/api/community/detail/9003', '/api/community/list']);
    assert.deepEqual(r.calls[1].data, { page: 1, limit: 10, content_type: 2, start_id: 9003, relation_id: 101 });
    feed.selectVideo(post(9002, { contentType: 2 }));
    assert.equal(r.navigations.at(-1), '/pages/discover/discoverVideo/index?id=9002&relation_id=101');
  } finally { stop(); }
});

test('video deep link refuses an image post or mismatched author and preserves old H5 content_type=0', async () => {
  for (const [query, expected] of [
    [{ id: '9003' }, post(9003)],
    [{ id: '9003', relation_id: '102' }, video],
  ]) {
    const { r, feed, stop } = setup('video', () => ({ data: expected }));
    try {
      await feed.initialize(query);
      assert.match(feed.routeError.value, /不匹配/);
      assert.equal(r.calls.length, 1);
    } finally { stop(); }
  }
  const { r, feed, stop } = setup('video', call => call.url.endsWith('/detail/9003')
    ? { data: post(9003) } : { data: [post(9003)] });
  try {
    await feed.initialize({ id: '9003', content_type: '0' });
    assert.equal(feed.routeError.value, '');
    assert.equal(r.calls[1].data.content_type, undefined);
    assert.equal(feed.activeVideo.value.id, 9003);
  } finally { stop(); }
});

test('late page response cannot repaint changed route or logged-in identity', async () => {
  const old = deferred();
  let lists = 0;
  const { r, feed, stop } = setup('search', call => call.url.endsWith('/community/topic')
    ? { data: [topic] }
    : ++lists === 1 ? old.promise : { data: [post(9002)] });
  try {
    const first = feed.initialize({ keyword: '旧词' });
    await tick();
    await feed.initialize({ keyword: '新词' });
    old.resolve({ data: [post(9001)] });
    await first;
    assert.deepEqual(feed.posts.value.map(item => item.id), [9002]);
    assert.equal(feed.keyword.value, '新词');
    r.auth.setLogin('another-token', 22);
    await tick();
    assert.ok(r.calls.some(call => call.data?.keyword === '新词'));
    assert.deepEqual(feed.posts.value.map(item => item.id), [9002]);
  } finally { stop(); }
});

test('old App web-view URL yields only validated video state, never an external web-view or token', async () => {
  const outer = 'https://untrusted.example.test/pages/discover/discoverVideo/index?content_type=2&token=SECRET&id=9003&relation_id=101';
  const { r, feed, stop } = setup('video', call => call.url.endsWith('/detail/9003')
    ? { data: video } : { data: [video] }, '/pages/discover/discoverVideo/app');
  try {
    await feed.initialize({ url: encodeURIComponent(outer) });
    assert.equal(feed.activeVideo.value.id, 9003);
    assert.deepEqual(r.calls.map(call => call.url), ['/api/community/detail/9003', '/api/community/list']);
    assert.ok(!JSON.stringify(r.calls).includes('SECRET'));
    feed.selectVideo(post(9002, { contentType: 2 }));
    assert.equal(r.navigations.at(-1), '/pages/discover/discoverVideo/app?id=9002&relation_id=101');
  } finally { stop(); }
  const parser = r.load(path.join(root, 'src/composables/useCommunityDeepLink.ts')).parseLegacyAppVideoUrl;
  assert.equal(parser('https://untrusted.example.test/other?token=x&id=9003'), null);
  assert.equal(parser('javascript:alert(1)'), null);
  assert.equal(parser('https://host/pages/discover/discoverVideo/index?id=0'), null);
});

test('old App unencoded outer ampersands and generic mixed-feed URL retain only safe state', async () => {
  const split = 'https://old.example.test/pages/discover/discoverVideo/index?content_type=2';
  const { r, feed, stop } = setup('video', call => call.url.endsWith('/detail/9003')
    ? { data: video } : { data: [video] }, '/pages/discover/discoverVideo/app');
  try {
    await feed.initialize({ url: split, token: 'SECRET', id: '9003', relation_id: '101' });
    assert.equal(feed.activeVideo.value.id, 9003);
    assert.deepEqual(r.calls[1].data, { page: 1, limit: 10, content_type: 2, start_id: 9003, relation_id: 101 });
    assert.ok(!JSON.stringify(r.calls).includes('SECRET'));
    await feed.initialize({ url: split.replace('content_type=2', 'content_type=0'), token: 'SECRET' });
    assert.equal(feed.routeError.value, '');
    assert.equal(r.calls.at(-1).data.content_type, undefined);
  } finally { stop(); }
});

test('video player accepts historical HTTP and same-site paths but rejects unsafe schemes', () => {
  const { r, stop } = setup('topic', () => ({ data: [] }));
  try {
    const source = r.load(path.join(root, 'src/utils/communityMedia.ts')).communityVideoSource;
    assert.equal(source('http://legacy.example.test/v.mp4'), 'http://legacy.example.test/v.mp4');
    assert.equal(source('https://media.example.test/v.mp4'), 'https://media.example.test/v.mp4');
    assert.equal(source('/uploads/video.mp4'), '/uploads/video.mp4');
    for (const unsafe of ['javascript:alert(1)', 'data:video/mp4;base64,aaaa', '//evil.test/v.mp4', '/\\evil.test', 'https://user:pass@host.test/v.mp4']) {
      assert.equal(source(unsafe), '', unsafe);
    }
  } finally { stop(); }
});
