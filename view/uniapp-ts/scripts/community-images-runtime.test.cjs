const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick } = require('./uni-store-runtime.cjs');
function setup() {
  const r = runtime({ feature: 'useCommunityPublish', send: () => ({ data: { id: 31 } }) });
  const choices = [], videos = [], uploads = [];
  r.uni.chooseImage = value => choices.push(value); r.uni.chooseVideo = value => videos.push(value);
  r.uni.uploadFile = value => uploads.push(value);
  return Object.assign(r, { choices, videos, uploads });
}
const media = id => ({ url: `/api/assets/${id}`, src: `/api/assets/${id}?signature=preview`, name: `${id}.png` });
async function select(r, ids, cover = false) {
  r.checkout[cover ? 'chooseCover' : 'chooseImages']();
  const work = r.choices.at(-1).success({ tempFiles: ids.map(() => ({ size: 300 })), tempFilePaths: ids.map(id => `/owned/${id}.png`) });
  for (const id of ids) { await tick(); r.uploads.at(-1).success({ statusCode: 200, data: JSON.stringify({ status: 200, data: media(id) }) }); }
  await work;
}
test('gallery upload is ordered, removal updates the cover, and publishing stores only canonical references', async () => {
  const r = setup(); try {
    await r.start(); await select(r, [71, 72, 73]); r.checkout.removeImage(0);
    r.checkout.content.value = '相册'; await r.checkout.publish(9);
    assert.deepEqual(r.calls[0].data, { title: undefined, content: '相册', content_type: 1, video_url: undefined, image: '/api/assets/72', slider_image: ['/api/assets/72', '/api/assets/73'], topic_id: [9] });
    assert.equal(r.uploads[0].url, '/api/upload/image'); assert.equal(r.uploads[0].header['Authori-zation'], 'Bearer synthetic-local-token');
    assert.equal(r.modals.length, 0);
  } finally { r.stop(); }
});
test('nine-image selection and video exclusivity cannot be bypassed by repeated calls', async () => {
  const r = setup(); try {
    await r.start(); await select(r, [1,2,3,4,5,6,7,8,9]);
    r.checkout.chooseImages(); r.checkout.chooseVideo(); assert.equal(r.choices.length, 1); assert.equal(r.videos.length, 0);
    r.checkout.removeImage(0); r.checkout.chooseImages(); assert.equal(r.choices.at(-1).count, 1);
    r.choices.at(-1).fail({ errMsg: 'cancel' }); r.checkout.clearImages(); r.checkout.chooseVideo(); assert.equal(r.videos.length, 1);
  } finally { r.stop(); }
});
test('partially uploaded batches do not silently publish fewer photos; explicit removal restores text publishing', async () => {
  const r = setup(); try {
    await r.start(); r.checkout.chooseImages();
    const work = r.choices[0].success({ tempFiles: [{ size: 3 }, { size: 3 }], tempFilePaths: ['/one', '/two'] });
    await tick(); r.uploads[0].success({ statusCode: 200, data: JSON.stringify({ status: 200, data: media(71) }) });
    await tick(); r.uploads[1].fail(); await work;
    assert.equal(r.checkout.images.value.length, 0); r.checkout.content.value = '不丢图'; await r.checkout.publish(); assert.equal(r.calls.length, 0);
    assert.equal(r.checkout.imageFailed.value, true); r.checkout.clearImages(); await r.checkout.publish(); assert.equal(r.calls.length, 1);
  } finally { r.stop(); }
});
test('invalid sizes and chooser counts reject before upload, while cancellation does not lose existing photos', async () => {
  const r = setup(); try {
    await r.start(); await select(r, [71]);
    for (const size of [0, NaN, 10 * 1024 * 1024 + 1]) {
      r.checkout.chooseImages(); await r.choices.at(-1).success({ tempFiles: [{ size }], tempFilePaths: ['/bad'] });
    }
    assert.equal(r.uploads.length, 1); assert.equal(r.checkout.images.value.length, 1);
    r.checkout.chooseImages(); r.choices.at(-1).fail({ errMsg: 'chooseImage:fail cancel' });
    assert.equal(r.checkout.images.value.length, 1); assert.equal(r.checkout.imageFailed.value, true);
  } finally { r.stop(); }
});
test('duplicate controls stay locked through the entire batch and account/page changes stop subsequent uploads', async () => {
  for (const boundary of ['account', 'hide', 'unload']) {
    const r = setup(); try {
      await r.start(); r.checkout.chooseImages(); r.checkout.chooseImages(); assert.equal(r.choices.length, 1);
      const work = r.choices[0].success({ tempFiles: [{ size: 3 }, { size: 3 }], tempFilePaths: ['/one', '/two'] }); await tick();
      r.checkout.clearImages(); assert.equal(r.checkout.reset(), false);
      if (boundary === 'account') r.auth.setLogin('other', 22); else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      r.uploads[0].success({ statusCode: 200, data: JSON.stringify({ status: 200, data: media(71) }) }); await work;
      assert.equal(r.uploads.length, 1); assert.equal(r.checkout.images.value.length, 0);
    } finally { r.stop(); }
  }
});
test('video cover upload, replacement failure and explicit removal retain video identity', async () => {
  const r = setup(); try {
    await r.start(); r.checkout.chooseVideo(); const video = r.videos[0].success({ size: 3000, tempFilePath: '/clip.mp4' }); await tick();
    r.uploads[0].success({ statusCode: 200, data: JSON.stringify({ status: 200, data: { ...media(90), name: 'clip.mp4' } }) }); await video;
    r.checkout.chooseImages(); assert.equal(r.choices.length, 0); await select(r, [71], true); assert.equal(r.choices[0].count, 1);
    r.checkout.chooseCover(); const bad = r.choices[1].success({ tempFiles: [{ size: 3 }], tempFilePaths: ['/broken'] }); await tick(); r.uploads.at(-1).fail(); await bad;
    r.checkout.content.value = '视频封面'; await r.checkout.publish(); assert.equal(r.calls.length, 0);
    assert.equal(r.checkout.cover.value.url, '/api/assets/71'); await select(r, [72], true); await r.checkout.publish();
    assert.equal(r.calls[0].data.image, '/api/assets/72'); assert.equal(r.calls[0].data.video_url, '/api/assets/90'); assert.equal(r.calls[0].data.slider_image, undefined);
    r.checkout.reset(); assert.equal(r.checkout.cover.value, null);
  } finally { r.stop(); }
});
test('malformed and wrong-origin upload receipts cannot enter a gallery', async () => {
  for (const data of ['<html>', JSON.stringify({ status: 200, data: { ...media(1), url: 'https://example.test/private' } }),
    JSON.stringify({ status: 200, data: { ...media(1), src: '/api/assets/2?signature=other' } })]) {
    const r = setup(); try {
      await r.start(); r.checkout.chooseImages(); const work = r.choices[0].success({ tempFiles: [{ size: 1 }], tempFilePaths: ['/one'] }); await tick();
      r.uploads[0].success({ statusCode: 200, data }); await work;
      assert.equal(r.checkout.images.value.length, 0); assert.equal(r.checkout.imageFailed.value, true);
    } finally { r.stop(); }
  }
});
test('actual detail page resolves gallery URLs and opens native preview at the selected image', async () => {
  const post = { id: 1, type: 2, relationId: 11, contentType: 1, title: '双图图集', content: '详情回读图集',
    image: '/api/assets/71?signature=a', sliderImage: ['/api/assets/71?signature=a', '/api/assets/72?signature=b'],
    likeNum: 0, isLike: 0, commentNum: 0, playNum: 1, shareNum: 0, status: 1, is_verify: 1, addTime: 100 };
  const r = runtime({ component: 'pages/discover/index.vue',
    send: call => ({ data: call.url === '/api/community/detail/1' ? post : [] }) });
  const previews = []; r.uni.previewImage = value => previews.push(value);
  try {
    await r.start({}); await r.checkout.openDetail({ id: 1, contentType: 1, image: '/api/assets/71?signature=a', sliderImage: ['/api/assets/71?signature=a', '/api/assets/72?signature=b'] });
    assert.equal(r.checkout.detailError.value, '');
    assert.equal(r.calls.filter(call => call.url === '/api/community/detail/1').length, 1);
    r.checkout.previewImage(1); assert.deepEqual(previews, [{ current: 1, urls: ['/api/assets/71?signature=a', '/api/assets/72?signature=b'] }]);
    r.hooks.onHide(); r.checkout.previewImage(0); assert.equal(previews.length, 1);
  } finally { r.stop(); }
});
