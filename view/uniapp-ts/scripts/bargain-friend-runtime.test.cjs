const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

function ownedSelection() {
  return { selection_only: true, type: 2, bargain_id: 40, product_id: 70, title: '朋友砍价样本', image: '',
    activity_price: '10.00', minimum_price: '2.00', people: 2, date_window: 'active',
    start_time: new Date(Date.now() - 60000).toISOString(), stop_time: new Date(Date.now() + 60000).toISOString(),
    can_select: false, participation: { id: 101, status: 1, state: 'cutting', original_price: '10.00', minimum_price: '2.00',
      cut_price: '2.00', current_price: '8.00', remaining_cut: '6.00', catalog_price: '8.00', activity_price_changed: false, progress_percent: 25 },
    skus: [{ unique: 'aabbccdd', base_unique: 'short7', suk: '短规格', image: '', stock: 6, max_quantity: 6, catalog_price: '8.00' }] };
}
function friendView() {
  return { help_only: true, type: 2, bargain_id: 40, participant_id: 101, product_id: 70,
    title: '朋友砍价样本', image: '', owner: { nickname: '发起人', avatar: '' }, is_owner: false,
    start_time: new Date(Date.now() - 60000).toISOString(), stop_time: new Date(Date.now() + 60000).toISOString(),
    date_window: 'active', people: 2, help_count: 1, already_helped: false, remaining_helper_uses: 3,
    in_stock: true, can_help: true, help_state: 'available', participation: ownedSelection().participation };
}
function setup(options = {}) {
  return runtime({ feature: 'useBargainPurchase', ...options, send: options.send || (call => {
    if (call.url === '/api/bargain/detail/40') return { data: call.data.view === 'help' ? friendView() : ownedSelection() };
    if (call.url === '/api/v2/diy/product_detail') return { status: 400, msg: 'Owned default design' };
    throw Error('Unexpected friend I/O: ' + call.url);
  }) });
}

test('canonical invitation reads the exact helper view and cannot purchase or start for the owner', async () => {
  const r = setup(); try {
    r.auth.setLogin('owned-helper-token', 22);
    await r.start({ id: '40', bargainUserId: '101', help: '1', spid: '11' });
    const read = r.calls.find(c => c.url === '/api/bargain/detail/40');
    assert.deepEqual(read.data, { view: 'help', bargain_user_id: 101 });
    assert.equal(r.checkout.friend.value.participant_id, 101);
    assert.equal(r.checkout.canHelpFriend.value, true);
    assert.equal(r.checkout.canBuy.value, false); assert.equal(r.checkout.canStart.value, false);
    await r.checkout.purchase(); await r.checkout.startBargain();
    assert.equal(r.calls.filter(c => /\/(?:cart\/add|bargain\/start)$/.test(c.url)).length, 0);
  } finally { r.stop(); }
});

test('legacy bare activity links still open the activity without inventing a participant', async () => {
  const r = setup(); try {
    await r.start({ bargain_id: '40' });
    assert.equal(r.checkout.activityId.value, 40);
    assert.deepEqual(r.calls.find(c => c.url === '/api/bargain/detail/40').data, { view: 'skus' });
    assert.equal(r.checkout.error.value, '');
  } finally { r.stop(); }
});

test('actual owned page native share retains the exact participant and canonical activity identity', async () => {
  const r = setup({ component: 'pages/activity/bargainDetail.vue' }); try {
    await r.start({ id: '40', bargainUserId: '101' }); await tick();
    assert.equal(r.hooks.onShareAppMessage().path, '/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1&spid=11');
  } finally { r.stop(); }
});

test('invitation QR descriptor preserves participant identity instead of falling back to a generic activity code', () => {
  const r = setup(); try {
    const protocol = r.load(path.join(__dirname, '../src/utils/legacyShare.ts'));
    assert.deepEqual(protocol.activityShareDescriptor('/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1'),
      { type: 2, id: 40, bargainUserId: 101 });
  } finally { r.stop(); }
});

test('actual QR component sends the invitation record and clears it on identity changes', async () => {
  const token = 'a'.repeat(24), image = `/api/share/code/image/${token}/wechat?expires=1800000000&signature=${'b'.repeat(64)}`;
  const r = runtime({ component: 'components/LegacyShareCode.vue', props: { type: 2, id: 40, bargainUserId: 101 },
    send: () => ({ data: { routineUrl: '', wechatUrl: image, site_name: '本机', nickname: '帮砍人' } }) });
  try {
    await r.checkout.generate();
    assert.deepEqual(r.calls[0].data, { bargain_user_id: 101 });
    r.auth.setLogin('replacement', 33); await tick(); assert.equal(r.checkout.code.value, '');
  } finally { r.stop(); }
});

test('legacy owner links resolve once while canonical referrers never become an owner selector', async () => {
  const r = setup(); try {
    await r.start({ bargain_id: '40', spid: '11' });
    assert.deepEqual(r.calls.at(-1).data, { view: 'help', bargain_user_uid: 11 });
    await r.checkout.load();
    assert.deepEqual(r.calls.at(-1).data, { view: 'help', bargain_user_id: 101 });
    r.hooks.onHide(); r.auth.setLogin('helper', 22); r.hooks.onShow(); await tick();
    assert.deepEqual(r.calls.at(-1).data, { view: 'help', bargain_user_id: 101 });
    await r.start({ id: '40', spid: '11' });
    assert.deepEqual(r.calls.at(-1).data, { view: 'skus' });
  } finally { r.stop(); }
});

test('login return reads the exact invitation and never automatically helps', async () => {
  const r = setup(); try {
    r.auth.clear();
    await r.start({ id: '40', bargainUserId: '101', help: '1' });
    assert.equal(r.calls.length, 0); r.checkout.login();
    assert.deepEqual(r.navigations, ['/pages/auth/login']);
    r.hooks.onHide(); r.auth.setLogin('helper', 22); r.hooks.onShow(); await tick();
    assert.equal(r.checkout.canHelpFriend.value, true);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].data, { view: 'help', bargain_user_id: 101 });
  } finally { r.stop(); }
});

test('helper double clicks write once and uncertain results require an explicit fresh read', async () => {
  const gate = deferred(); let fail = false;
  const r = setup({ send: call => call.url.endsWith('/help') ? gate.promise :
    fail ? { status: 503, msg: '邀请读取失败' } : { data: friendView() } });
  try {
    await r.start({ id: '40', bargainUserId: '101', help: '1' });
    const first = r.checkout.helpFriend(); await r.checkout.helpFriend(); await tick();
    assert.equal(r.calls.filter(c => c.url.endsWith('/help')).length, 1);
    assert.deepEqual(r.calls.at(-1).data, { bargain_user_id: 101 });
    gate.resolve({ transport: '帮砍结果未知' }); await first;
    assert.equal(r.checkout.friend.value, null); assert.equal(r.checkout.canHelpFriend.value, false);
    await r.checkout.helpFriend(); fail = true; await r.checkout.load();
    assert.match(r.checkout.error.value, /邀请读取失败/); assert.equal(r.checkout.friend.value, null);
    fail = false; await r.checkout.load(); assert.equal(r.checkout.canHelpFriend.value, true);
    assert.equal(r.calls.filter(c => c.url.endsWith('/help')).length, 1);
  } finally { r.stop(); }
});

test('actual friend page refreshes completed progress and exposes no owner purchase action', async () => {
  let helped = false;
  const r = setup({ component: 'pages/activity/bargainDetail.vue', send: call => {
    if (call.url.endsWith('/help')) { helped = true; return { data: {} }; }
    if (call.url.endsWith('product_detail')) return { status: 400 };
    const view = friendView();
    if (helped) Object.assign(view, { can_help: false, help_state: 'ready', help_count: 2, already_helped: true,
      remaining_helper_uses: 2, participation: { ...view.participation, status: 3, state: 'ready',
        cut_price: '8.00', current_price: '2.00', remaining_cut: '0.00', progress_percent: 100 } });
    return { data: view };
  } });
  try {
    await r.start({ id: '40', bargainUserId: '101', help: '1' }); await r.checkout.helpFriend();
    assert.equal(r.checkout.friend.value.participation.current_price, '2.00');
    assert.equal(r.checkout.canHelpFriend.value, false); assert.equal(r.checkout.canBuy.value, false);
    r.checkout.goOwn(); assert.equal(r.navigations.at(-1), '/pages/activity/bargainDetail?id=40');
    assert.equal(r.hooks.onShareAppMessage().path, '/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1&spid=11');
  } finally { r.stop(); }
});

test('hidden, unloaded, replaced-account and reused-route views discard late helper reads and writes', async () => {
  for (const kind of ['read', 'write']) for (const change of ['hide', 'unload', 'account', 'route']) {
    const gate = deferred(); let delayed = kind === 'read';
    const r = setup({ send: call => delayed || call.url.endsWith('/help') ? gate.promise : { data: friendView() } });
    try {
      await r.start({ id: '40', bargainUserId: '101', help: '1' });
      const pending = kind === 'write' ? r.checkout.helpFriend() : Promise.resolve(); await tick(); delayed = false;
      if (change === 'hide') r.hooks.onHide();
      else if (change === 'unload') r.hooks.onUnload();
      else if (change === 'account') r.auth.setLogin('new-helper', 33);
      else r.hooks.onLoad({ id: '41', bargainUserId: '102', help: '1' });
      gate.resolve({ data: kind === 'read' ? friendView() : {} }); await pending; await tick();
      assert.equal(r.checkout.friend.value, null, `${kind}/${change}`);
      assert.equal(r.checkout.canHelpFriend.value, false); assert.equal(r.navigations.length, 0);
      assert.equal(r.calls.length, kind === 'read' ? 1 : 2);
    } finally { r.stop(); }
  }
});

test('malformed links, amounts, eligibility and cross-record replies fail closed', async () => {
  for (const query of [{ id: '40', help: '1' }, { id: '40', bargainUserId: '0', help: '1' },
    { id: '40', bargain_id: '41' }, { id: '40', bargain_user_id: '101' }, { mine: '1', help: '1' }]) {
    const r = setup(); try { await r.start(query); assert.equal(r.calls.length, 0); assert.ok(r.checkout.error.value); } finally { r.stop(); }
  }
  for (const alter of [v => v.participant_id = 102, v => v.skus = [], v => v.participation.current_price = '1.00',
    v => v.can_help = false, v => v.owner.nickname = 'bad\nname']) {
    const value = friendView(); alter(value);
    const r = setup({ send: () => ({ data: value }) }); try {
      await r.start({ id: '40', bargainUserId: '101', help: '1' });
      assert.equal(r.checkout.friend.value, null); assert.equal(r.checkout.canHelpFriend.value, false);
    } finally { r.stop(); }
  }
});

test('eligibility states and deadline prevent help before any outgoing mutation', async () => {
  const cases = [
    { is_owner: true, help_state: 'owner' }, { already_helped: true, help_state: 'already_helped' },
    { remaining_helper_uses: 0, help_state: 'limit_reached' }, { help_count: 2, help_state: 'people_full' },
    { in_stock: false, help_state: 'sold_out' }, { date_window: 'future', help_state: 'future' },
    { date_window: 'ended', help_state: 'ended' },
  ];
  for (const overrides of cases) {
    const r = setup({ send: () => ({ data: { ...friendView(), can_help: false, ...overrides } }) }); try {
      await r.start({ id: '40', bargainUserId: '101', help: '1' });
      assert.ok(r.checkout.friend.value); await r.checkout.helpFriend(); assert.equal(r.calls.length, 1);
    } finally { r.stop(); }
  }
  const r = setup(); try {
    await r.start({ id: '40', bargainUserId: '101', help: '1' });
    assert.equal(r.checkout.canHelpFriend.value, true);
    const original = Date.now, expired = Date.parse(r.checkout.friend.value.stop_time) + 1;
    try { Date.now = () => expired; await r.checkout.helpFriend(); } finally { Date.now = original; }
    assert.equal(r.calls.length, 1); assert.equal(r.checkout.friend.value, null);
  } finally { r.stop(); }
});

test('QR landing retains exact invitation, rejects target swaps and supports old owner links without browser URL globals', () => {
  const r = setup(); const oldUrl = global.URL, oldParams = global.URLSearchParams;
  try {
    global.URL = undefined; global.URLSearchParams = undefined;
    const p = r.load(path.join(__dirname, '../src/utils/legacyShare.ts'));
    const value = { type: 2, id: 40, spid: 22, bargain_user_id: 101,
      path: '/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1&spid=22' };
    assert.equal(p.shareDestination(p.parseShareScene(value)), '/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1');
    assert.equal(p.shareDestination(p.parseShareScene({ type: 2, id: 40, spid: 11,
      path: '/pages/activity/bargainDetail?bargain_id=40&spid=11' })), '/pages/activity/bargainDetail?bargain_id=40&spid=11');
    for (const changed of [{ bargain_user_id: 102 }, { bargain_user_id: undefined },
      { path: value.path + '&help=1' }, { path: value.path.replace('id=40', 'id=41') },
      { path: value.path.replace('help=1', 'help=0') }, { type: 1 }]) assert.throws(() => p.parseShareScene({ ...value, ...changed }));
    for (const extra of ['&bargainUserId=102', '&help=1', '&uid=11', '#other'])
      assert.equal(p.activityShareDescriptor('/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1' + extra), null);
  } finally { global.URL = oldUrl; global.URLSearchParams = oldParams; r.stop(); }
});

test('actual activity menu forwards the exact participant through APP sharing and its QR descriptor', async () => {
  const invitation = '/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1', shares = [];
  const r = runtime({ component: 'components/productDetail/ActivityDetailMenu.vue',
    props: { menu: [1], productId: 70, path: invitation, title: '朋友帮砍', image: '', active: true },
    send: call => { assert.equal(call.url, '/api/product/detail/70');
      return { data: { id: 70, stock: 12, price: '17.00', site_url: 'https://shop.example.test' } }; } });
  try {
    r.uni.getProvider = value => value.success({ provider: ['weixin'] });
    r.uni.share = value => { shares.push(value); value.success(); };
    await r.checkout.act(1);
    assert.equal(shares[0].href, 'https://shop.example.test/#' + invitation + '&spid=11');
    assert.deepEqual(r.checkout.shareDescriptor.value, { type: 2, id: 40, bargainUserId: 101 });
  } finally { r.stop(); }
});

test('same-document H5 invitation changes fence late reads and reject duplicate query keys', async () => {
  const prior = global.window, handlers = new Map(), gate = deferred();
  global.window = { location: { hash: '#/pages/activity/bargainDetail?id=40&bargainUserId=101&help=1' },
    addEventListener: (key, value) => handlers.set(key, value), removeEventListener: key => handlers.delete(key) };
  let r;
  try {
    r = setup({ send: call => call.data.bargain_user_id === 101 ? gate.promise : {
      data: { ...friendView(), participant_id: 102, participation: { ...friendView().participation, id: 102 } } } });
    await r.start();
    global.window.location.hash = '#/pages/activity/bargainDetail?id=40&bargainUserId=102&help=1';
    handlers.get('hashchange')(); await tick(); assert.equal(r.checkout.friend.value.participant_id, 102);
    gate.resolve({ data: friendView() }); await tick(); assert.equal(r.checkout.friend.value.participant_id, 102);
    const count = r.calls.length;
    global.window.location.hash += '&bargainUserId=101'; handlers.get('hashchange')(); await tick();
    assert.equal(r.checkout.friend.value, null); assert.equal(r.calls.length, count);
    r.stop(); r = undefined; assert.equal(handlers.has('hashchange'), false);
  } finally { gate.resolve({ data: null }); r?.stop(); if (prior === undefined) delete global.window; else global.window = prior; }
});
