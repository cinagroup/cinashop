const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { setupEditorial, root, tick, vue } = require('./diy-editorial-fixture.cjs');

const platforms = ['H5', 'MP-WEIXIN', 'APP-PLUS'];
const families = ['news', 'hotspot', 'activeParty'];
const options = { timeout: 30000 };
const copy = value => JSON.parse(JSON.stringify(value));
const mini = 'packageA/detail/index?item=7@APPID=wxABCDEF0123456789';

function linkedBlock(kind, url) {
  if (kind === 'news') return { listConfig: { list: [{ show: 1, chiild: [{ val: '真实公告' }, { val: url }] }] }, linkConfig: { value: url } };
  if (kind === 'hotspot') return { picStyle: { url: '/static/hotspot.png', list: [{ number: 1, starX: 75, starY: 50, areaWidth: 150, areaHeight: 100, nowImgWidth: 750, link: url }] } };
  return { menuConfig: { list: [{ img: '/static/party.png', info: [{ value: '活动标题' }, { value: '活动简介' }, { value: url }] }] } };
}

function projectedLink(r, kind) {
  const c = r.c.config.value;
  return kind === 'news' ? c.newsItems[0]?.link ?? '' : kind === 'hotspot' ? c.hotspotAreas[0]?.link ?? '' : c.partyItems[0]?.link ?? '';
}

/** Capture only native terminal I/O; actual normalizer, stores, composable and dispatcher run. */
function platformIo(r, platform = 'H5') {
  const pages = [], tabs = [], minis = [], opened = [], handles = [], oldWindow = global.window;
  r.uni.navigateTo = value => pages.push(value);
  r.uni.switchTab = value => tabs.push(value);
  r.uni.navigateToMiniProgram = value => minis.push(value);
  global.window = platform === 'H5' ? { ...(oldWindow ?? {}), location: { origin: oldWindow?.location?.origin ?? 'https://owned.example' }, open(...args) { opened.push(args); const handle = { opener: 'initial' }; handles.push(handle); return handle; } } : undefined;
  return { pages, tabs, minis, opened, handles, restore() { global.window = oldWindow; } };
}

function blocked(r, transition) {
  if (transition === 'uid') r.auth.uid = 22;
  else if (transition === 'token') r.auth.token = 'rotated-owner-token';
  else if (transition === 'session') r.auth.sessionVersion++;
  else if (transition === 'config') r.props.block = { ...r.props.block, timestamp: 999 };
  else if (transition === 'hide') r.props.active = false;
  else if (transition === 'disabled') r.props.block.isShow = false;
  else r.c.dispose();
}

for (const platform of platforms) test(`immutable PHP follow corners use explicit 2/4/6/8 rpx on ${platform}`, options, () => {
  // PHP 8ed2a5b follow.vue:89–96 pushes valList[i] directly into CSS order.
  // These independent literals deliberately do not call an author projection.
  const raw = { type: 1, valList: [1, 2, 3, 4].map(val => ({ val })) };
  const r = setupEditorial('follow', { platform, block: { fillet: copy(raw) } });
  try {
    assert.equal(r.c.config.value.followCardStyle.borderRadius, '2rpx 4rpx 6rpx 8rpx');
    assert.deepEqual(r.props.block.fillet, raw);
    assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
});

for (const platform of platforms) for (const style of [0, 1]) for (const tone of [0, 1]) test(`PHP news ${style ? 'list' : 'ticker'} tone ${tone} on ${platform} keeps separate title contracts`, options, () => {
  const r = setupEditorial('news', { platform, block: { styleConfig: { tabVal: style }, toneConfig: { tabVal: tone }, titleConfig: { tabVal: 1 }, titleColor: { color: [{ item: '#123456' }] }, titleBgColor: { color: [{ item: '#aabbcc' }, { item: '#ddeeff' }] } } });
  try {
    // Use a nondefault theme to distinguish the runtime preset from literal red.
    r.load(path.join(root, 'src/stores/theme.ts')).useThemeStore().status = 1;
    const c = r.c.config.value;
    assert.equal(c.newsListStyle, style === 1);
    assert.equal(c.titleStyle.color, '#123456');
    assert.equal(c.tickerTitleStyle.color, tone ? '#123456' : '#ffffff');
    assert.equal(c.tickerTitleStyle.background, tone ? 'linear-gradient(90deg, #aabbcc 0%, #ddeeff 100%)' : '#1DB0FC');
    assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
});

async function actualNewsMarkup(r) {
  const sfc = require('@vue/compiler-sfc'), compiler = require('@vue/compiler-dom');
  const file = path.join(root, 'src/components/diy/DiyEditorialWidget.vue');
  const descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  const bindings = sfc.compileScript(descriptor, { id: 'editorial-independent-parity' }).bindings;
  const render = new Function('Vue', compiler.compile(descriptor.template.content, {
    mode: 'function', prefixIdentifiers: true, bindingMetadata: bindings,
    isCustomElement: tag => ['view', 'text', 'image', 'button', 'swiper', 'swiper-item', 'official-account'].includes(tag),
  }).code)(vue);
  const actual = r.load(file).default;
  const app = vue.createSSRApp({ props: actual.props, render, setup: () => r.checkout }, { ...r.props });
  app.use(require('pinia').getActivePinia());
  return require('@vue/server-renderer').renderToString(app);
}

for (const style of [0, 1]) for (const tone of [0, 1]) test(`actual news template uses its ${style ? 'list' : 'ticker'} title style for tone ${tone}`, options, async () => {
  const r = setupEditorial('news', { platform: 'H5', block: { styleConfig: { tabVal: style }, toneConfig: { tabVal: tone }, titleConfig: { tabVal: 1 }, titleColor: { color: [{ item: '#123456' }] }, titleBgColor: { color: [{ item: '#aabbcc' }, { item: '#ddeeff' }] } } });
  try {
    r.load(path.join(root, 'src/stores/theme.ts')).useThemeStore().status = 1;
    const html = await actualNewsMarkup(r);
    if (style) {
      assert.match(html, /class="news-title"[^>]*style="color:#123456;/u);
      assert.doesNotMatch(html, /class="news-ticker-title"/u);
    } else {
      assert.match(html, tone ? /class="news-ticker-title"[^>]*style="color:#123456;background:linear-gradient\(90deg, #aabbcc 0%, #ddeeff 100%\);/u : /class="news-ticker-title"[^>]*style="color:#ffffff;background:#1DB0FC;/u);
      assert.doesNotMatch(html, /class="news-title"/u);
    }
    assert.deepEqual(r.calls, []);
  } finally { r.stop(); }
});

const pageCases = [
  ['/pages/goods/goods_list/index?cid=9', '/pages/goods/list?cid=9', false],
  ['/pages/goods/list?cid=9', '/pages/goods/list?cid=9', false],
  ['/pages/extension/news_details/index?id=12', '/pages/article/detail?id=12', false],
  ['/pages/article/detail?id=12', '/pages/article/detail?id=12', false],
  ['/pages/order_addcart/order_addcart', '/pages/cart/index', true],
  ['/pages/cart/index?legacy=1', '/pages/cart/index?legacy=1', true],
];
for (const platform of platforms) for (const kind of families) test(`${kind} consumes old and new registered page links on ${platform}`, options, () => {
  const r = setupEditorial(kind, { platform }), io = platformIo(r, platform);
  try {
    for (const [raw, expected, tab] of pageCases) {
      r.props.block = { ...r.props.block, ...linkedBlock(kind, raw) };
      const original = copy(r.props.block), link = projectedLink(r, kind);
      assert.equal(link, expected);
      if (kind === 'news') assert.equal(r.c.config.value.moreLink, expected);
      r.c.open(link);
      assert.equal((tab ? io.tabs : io.pages).at(-1).url, tab ? expected.split('?')[0] : expected);
      assert.deepEqual(r.props.block, original);
    }
    assert.equal(io.pages.length, 4);
    assert.equal(io.tabs.length, 2);
    assert.deepEqual(io.minis, []);
    assert.deepEqual(r.calls, []);
  } finally { io.restore(); r.stop(); }
});

for (const platform of platforms) for (const kind of families) test(`${kind} HTTP and HTTPS authored links reach the real ${platform} terminal adapter`, options, () => {
  const r = setupEditorial(kind, { platform }), io = platformIo(r, platform);
  try {
    for (const url of ['http://external.example/a?x=%20', 'https://external.example/a?x=%20']) {
      r.props.block = { ...r.props.block, ...linkedBlock(kind, url) };
      assert.equal(projectedLink(r, kind), url);
      r.c.open(projectedLink(r, kind));
      if (platform === 'H5') {
        assert.deepEqual(io.opened.at(-1), [url, '_blank', 'noopener,noreferrer']);
        assert.equal(io.handles.at(-1).opener, null);
      } else assert.equal(io.pages.at(-1).url, `/pages/common/fabWebView?url=${encodeURIComponent(url)}`);
    }
    assert.equal(platform === 'H5' ? io.opened.length : io.pages.length, 2);
    assert.deepEqual(io.minis, []);
    assert.deepEqual(r.calls, []);
  } finally { io.restore(); r.stop(); }
});

for (const platform of platforms) for (const kind of families) test(`${kind} external mini-program link has an explicit ${platform} outcome`, options, () => {
  const r = setupEditorial(kind, { platform, block: linkedBlock(kind, mini) }), io = platformIo(r, platform);
  try {
    assert.equal(projectedLink(r, kind), mini);
    r.c.open(projectedLink(r, kind));
    if (platform === 'MP-WEIXIN') {
      assert.equal(io.minis.length, 1);
      assert.deepEqual({ ...io.minis[0], fail: undefined }, { appId: 'wxABCDEF0123456789', path: 'packageA/detail/index?item=7', envVersion: 'release', fail: undefined });
      assert.equal(typeof io.minis[0].fail, 'function');
      assert.deepEqual(r.toasts, []);
    } else {
      assert.deepEqual(io.minis, []);
      assert.match(r.toasts.at(-1).title, /不支持.*小程序/u);
    }
    assert.deepEqual(io.pages, []);
    assert.deepEqual(io.tabs, []);
    assert.deepEqual(io.opened, []);
    assert.deepEqual(r.calls, []);
  } finally { io.restore(); r.stop(); }
});

const unsafe = ['javascript:alert(1)', 'data:text/html,x', '//evil.example/a', 'https://u:p@evil.example/a', 'http:evil.example/a', 'https://evil.example/%0a', 'https://evil.example/a%255c', '/pages/unknown/index', '/pages/index/index#hash', '/pages/index/index%250a', 'a/../b@APPID=wx0123456789abcdef', 'https://evil.example/a@APPID=wx0123456789abcdef', 'package/index@APPID=bad', 'package/index@APPID=wx0123456789abcdef@APPID=wx0123456789abcdef'];
for (const platform of platforms) for (const kind of families) test(`${kind} unsafe links cannot survive normalization or execute on ${platform}`, options, () => {
  const r = setupEditorial(kind, { platform }), io = platformIo(r, platform);
  try {
    const normalizer = r.load(path.join(root, 'src/utils/diyEditorialLink.ts')).normalizeDiyEditorialLink;
    for (const url of unsafe) {
      r.props.block = { ...r.props.block, ...linkedBlock(kind, url) };
      const original = copy(r.props.block);
      assert.equal(normalizer(url), '', url);
      assert.equal(projectedLink(r, kind), '', url);
      r.c.open(projectedLink(r, kind));
      r.c.open(url);
      assert.deepEqual(r.props.block, original);
    }
    for (const values of [io.pages, io.tabs, io.minis, io.opened, r.calls]) assert.deepEqual(values, []);
  } finally { io.restore(); r.stop(); }
});

for (const platform of platforms) test(`fresh editorial navigation failures remain visible on ${platform}`, options, () => {
  for (const kind of families) {
    const r = setupEditorial(kind, { platform, block: linkedBlock(kind, '/pages/article/list') }), io = platformIo(r, platform);
    try {
      r.c.open(projectedLink(r, kind));
      assert.equal(io.pages.length, 1);
      io.pages[0].fail({ errMsg: 'fresh failure' });
      assert.equal(r.toasts.length, 1);
      assert.match(r.toasts[0].title, /暂时无法打开/u);
      assert.deepEqual(r.calls, []);
    } finally { io.restore(); r.stop(); }
  }
});

for (const platform of platforms) for (const transition of ['uid', 'token', 'session', 'config', 'hide', 'disabled', 'dispose']) test(`editorial late navigation failure cannot cross ${transition} on ${platform}`, options, async () => {
  for (const kind of families) {
    const r = setupEditorial(kind, { platform, block: linkedBlock(kind, '/pages/article/list') }), io = platformIo(r, platform);
    try {
      r.c.open(projectedLink(r, kind));
      assert.equal(io.pages.length, 1);
      const fail = io.pages[0].fail;
      assert.equal(typeof fail, 'function');
      blocked(r, transition);
      await tick();
      fail({ errMsg: 'late failure' });
      assert.deepEqual(r.toasts, []);
      assert.deepEqual(r.calls, []);
      assert.equal(io.pages.length, 1);
    } finally { io.restore(); r.stop(); }
  }
});

test('native MP editorial page, web and mini links work without a browser URL global', options, () => {
  const old = global.URL;
  global.URL = undefined;
  try {
    for (const kind of families) {
      const r = setupEditorial(kind, { platform: 'MP-WEIXIN' }), io = platformIo(r, 'MP-WEIXIN');
      try {
        for (const url of ['/pages/goods/goods_list/index?cid=9', 'https://external.example/a?x=%20', mini]) {
          r.props.block = { ...r.props.block, ...linkedBlock(kind, url) };
          assert.notEqual(projectedLink(r, kind), '');
          r.c.open(projectedLink(r, kind));
        }
        assert.deepEqual(io.pages.map(row => row.url), ['/pages/goods/list?cid=9', '/pages/common/fabWebView?url=https%3A%2F%2Fexternal.example%2Fa%3Fx%3D%2520']);
        assert.equal(io.minis[0].appId, 'wxABCDEF0123456789');
        assert.deepEqual(r.toasts, []);
        assert.deepEqual(r.calls, []);
      } finally { io.restore(); r.stop(); }
    }
  } finally { global.URL = old; }
});

test('MP mini navigation failure carries the original actor and visibility lease', options, async () => {
  for (const transition of ['uid', 'hide', 'disabled', 'dispose']) {
    const r = setupEditorial('hotspot', { platform: 'MP-WEIXIN', block: linkedBlock('hotspot', mini) }), io = platformIo(r, 'MP-WEIXIN');
    try {
      r.c.open(projectedLink(r, 'hotspot'));
      assert.equal(io.minis.length, 1);
      const fail = io.minis[0].fail;
      blocked(r, transition);
      await tick();
      fail({ errMsg: 'obsolete mini failure' });
      assert.deepEqual(r.toasts, []);
    } finally { io.restore(); r.stop(); }
  }
});

test('already hidden or disabled editorial widgets cannot begin any native navigation', options, () => {
  for (const kind of families) for (const transition of ['hide', 'disabled', 'dispose']) {
    const r = setupEditorial(kind, { platform: 'MP-WEIXIN', block: linkedBlock(kind, mini) }), io = platformIo(r, 'MP-WEIXIN');
    try {
      blocked(r, transition);
      r.c.open(mini);
      r.c.open('/pages/article/list');
      assert.deepEqual(io.pages, []);
      assert.deepEqual(io.minis, []);
      assert.deepEqual(r.toasts, []);
      assert.deepEqual(r.calls, []);
    } finally { io.restore(); r.stop(); }
  }
});
