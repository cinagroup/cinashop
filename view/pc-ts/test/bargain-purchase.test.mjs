import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
const moduleId = name => `/src/pages/activity/${name}.test-script.ts`;
export function bargainComponentPlugin(root) {
  const ids = new Map(['Bargain', 'BargainDetail'].map(name => [`${root.replaceAll('\\', '/').replace(/\/$/, '')}${moduleId(name)}`, name]));
  return { name: 'actual-bargain-setup', resolveId(id) { if (['Bargain', 'BargainDetail'].some(name => moduleId(name) === id)) return `${root.replaceAll('\\', '/').replace(/\/$/, '')}${id}`; },
    async load(id) { const name = ids.get(id.replaceAll('\\', '/')); if (!name) return;
      const filename = `${root}/src/pages/activity/${name}.vue`, { descriptor } = parse(await readFile(filename, 'utf8'), { filename });
      return compileScript(descriptor, { id: `actual-${name}` }).content;
    } };
}
const renderer = createRenderer({ createElement: () => ({ children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  insert(node, parent) { node.parent = parent; (parent.children ??= []).push(node); }, remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); },
  parentNode: node => node.parent, nextSibling: () => null, patchProp() {}, setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; } });
const flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick(); } };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const mine = (id = 80, status = 3) => ({ id, uid: 11, bargain_id: 40, title: '本人砍价', image: '', status,
  bargain_price: '10.00', bargain_price_min: '2.00', price: status === 1 ? '2.00' : '8.00', residue_price: status === 1 ? '8.00' : '2.00', pay_status: status === 3 });
export function bargainFixture(config = { url: '/bargain/detail/40', params: {} }, anonymous = false) {
  const activity = Number(config.url.split('/').at(-1)), id = config.params?.bargain_user_id || 80, floor = id === 90 ? '4.00' : '2.00', cut = id === 90 ? '6.00' : '8.00';
  return { selection_only: true, type: 2, bargain_id: activity, product_id: 70, title: '隔离砍价商品', image: '', activity_price: '10.00', minimum_price: '2.00', people: 2,
    start_time: new Date(Date.now() - 60_000).toISOString(), stop_time: new Date(Date.now() + 600_000).toISOString(), date_window: 'active', can_select: !anonymous,
    participation: anonymous ? null : { id, status: 3, state: 'ready', original_price: '10.00', minimum_price: floor, cut_price: cut, current_price: floor,
      remaining_cut: '0.00', catalog_price: floor, activity_price_changed: false, progress_percent: 100 },
    skus: ['red', 'blu'].map((color, i) => ({ unique: `act${color}${activity}`, base_unique: i ? 'qablue01' : 'qared001', suk: i ? '蓝色' : '红色', stock: i ? 2 : 6,
      max_quantity: i ? 2 : 6, catalog_price: anonymous ? null : floor, image: '' })) };
}
const friendFixture = (changes = {}) => ({
  help_only: true, type: 2, bargain_id: 40, participant_id: 80, product_id: 70, title: '朋友邀请商品', image: '',
  owner: { nickname: '发起人', avatar: '' }, is_owner: false,
  participation: { id: 80, status: 1, state: 'cutting', original_price: '10.00', minimum_price: '2.00',
    cut_price: '4.00', current_price: '6.00', remaining_cut: '4.00', progress_percent: 50 },
  start_time: new Date(Date.now() - 60000).toISOString(), stop_time: new Date(Date.now() + 600000).toISOString(),
  date_window: 'active', people: 2, help_count: 1, already_helped: false, remaining_helper_uses: 3,
  in_stock: true, can_help: true, help_state: 'available', ...changes,
});
const friendReady = () => friendFixture({ can_help: false, help_state: 'ready', help_count: 2, already_helped: true,
  participation: { id: 80, status: 3, state: 'ready', original_price: '10.00', minimum_price: '2.00',
    cut_price: '8.00', current_price: '2.00', remaining_cut: '0.00', progress_percent: 100 } });
export function registerBargainPurchaseTests(getContext) {
  async function mount({ entry = '/bargain/40?bargainUserId=80', read, post = () => ({ status: 200, data: { id: 91, cartNum: 2 } }), list = false } = {}) {
    const { server, api, location, response, authUtils } = getContext(), calls = [], reads = [];
    const saved = { pathname: location.pathname, search: location.search, hash: location.hash };
    const component = (await server.ssrLoadModule(moduleId(list ? 'Bargain' : 'BargainDetail'))).default; let view;
    const target = { setup(props, context) { view = component.setup(props, context); return () => null; } };
    const router = createRouter({ history: createMemoryHistory(), routes: [ { path: list ? '/bargain' : '/bargain/:id', component: target },
      ...['/login', '/checkout', '/elsewhere'].map(path => ({ path, component: { render: () => null } })) ] });
    const unbind = router.afterEach(to => { const url = new URL(to.fullPath, location.origin); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash }); });
    api.defaults.adapter = async config => {
      if (config.method === 'get') { reads.push({ url: config.url, params: structuredClone(config.params) });
        return response(config, read ? await read(config) : { status: 200, data: bargainFixture(config, !authUtils.getToken()) }); }
      calls.push({ url: config.url, body: JSON.parse(config.data) }); return response(config, await post(config));
    };
    const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router); let mounted = false;
    const close = () => { if (mounted) { app.unmount(); mounted = false; } unbind(); Object.assign(location, saved); };
    try { await router.push(entry); app.mount({ children: [] }); mounted = true; await flush(); return { router, reads, calls, get view() { return view; }, close }; }
    catch (e) { close(); throw e; }
  }
  const choose = f => { f.view.choose('actblu40'); f.view.quantity.value = 2; };
  const checkout = id => ({ mode: 'buy', cartId: '91', type: '2', bargainUserId: String(id) });
  function cancellationMount({ rows = () => [mine(80, 1), mine(90, 1), mine(91, 3), mine(92, 4)],
    post = () => ({ status: 200, data: null }) } = {}) {
    getContext().authUtils.setAuth('cancel-owner', 11);
    return mount({ list: true, entry: '/bargain?my=1',
      read: async config => ({ status: 200, data: config.url === '/bargain/user/list' ? await rows(config) : [] }), post });
  }
  it('PC cancellation confirmation stays inline and only selects a current cutting record', async () => {
    const f = await cancellationMount(); try {
      f.view.requestCancel(91); f.view.requestCancel(92); f.view.requestCancel(999); assert.equal(f.view.pendingCancel.value, null);
      f.view.requestCancel(80); assert.deepEqual({ ...f.view.pendingCancel.value }, { id: 80, activityId: 40, title: '本人砍价' });
      const reads = f.reads.length; f.view.requestCancel(90); await f.view.loadMy(2); await f.view.mutate(f.view.myList.value[1], 'help');
      assert.equal(f.reads.length, reads); assert.equal(f.calls.length, 0); assert.equal(f.view.pendingCancel.value.id, 80);
      f.view.keepParticipation(); await f.view.confirmCancel(); assert.equal(f.view.pendingCancel.value, null); assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  it('PC cancel submits exact record and activity and refreshes the original page', async () => {
    let cancelled = false;
    const f = await cancellationMount({ rows: () => cancelled ? [mine(90, 1)] : [mine(80, 1), mine(90, 1)],
      post: () => { cancelled = true; return { status: 200, data: null }; } });
    try {
      await f.view.loadMy(2); f.view.requestCancel(80); await f.view.confirmCancel();
      assert.deepEqual(f.calls, [{ url: '/bargain/user/cancel', body: { id: 80, bargainId: 40 } }]);
      assert.deepEqual(f.reads.at(-1).params, { page: 2, limit: 20 }); assert.deepEqual(f.view.myList.value.map(x => x.id), [90]);
      assert.equal(f.view.pendingCancel.value, null); await f.view.confirmCancel(); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
  it('PC cancellation confirmation expires on close, account, route and unmount', async () => {
    for (const boundary of ['close', 'account', 'route', 'unmount']) {
      const f = await cancellationMount(); let closed = false;
      try {
        f.view.requestCancel(80);
        if (boundary === 'close') f.view.closeMy();
        else if (boundary === 'account') getContext().authUtils.setAuth('other', 22);
        else if (boundary === 'route') await f.router.push('/bargain?my=0');
        else { f.close(); closed = true; }
        await flush(); await f.view.confirmCancel(); assert.equal(f.calls.length, 0); assert.equal(f.view.pendingCancel.value, null);
      } finally { if (!closed) f.close(); }
    }
  });
  it('PC cancellation in flight ignores duplicate controls and late responses across identity or navigation', async () => {
    for (const boundary of ['none', 'close', 'account', 'route', 'unmount']) {
      const waiting = gate(), started = gate(), f = await cancellationMount({ post: () => { started.release(); return waiting.promise; } }); let closed = false;
      try {
        f.view.requestCancel(80); const work = f.view.confirmCancel(); await started.promise;
        await f.view.confirmCancel(); f.view.keepParticipation(); f.view.requestCancel(90); await f.view.loadMy(2);
        assert.equal(f.calls.length, 1); assert.equal(f.view.pendingCancel.value.id, 80);
        if (boundary === 'close') f.view.closeMy();
        else if (boundary === 'account') getContext().authUtils.setAuth('other', 22);
        else if (boundary === 'route') await f.router.push('/bargain?my=0');
        else if (boundary === 'unmount') { f.close(); closed = true; }
        await flush(); const reads = f.reads.length;
        waiting.release({ status: 200, data: null }); await work; await flush();
        assert.equal(f.reads.length, reads + (boundary === 'none' ? 1 : 0)); assert.equal(f.calls.length, 1);
        assert.equal(f.view.pendingCancel.value, null);
      } finally { waiting.release({ status: 200, data: null }); if (!closed) f.close(); }
    }
  });
  it('PC lost cancellation response clears private records and recovers by read without repeating the write', async () => {
    let committed = false;
    const f = await cancellationMount({ rows: () => committed ? [mine(90, 1)] : [mine(80, 1), mine(90, 1)],
      post: () => { committed = true; throw Error('Synthetic lost response'); } });
    try {
      f.view.requestCancel(80); await f.view.confirmCancel(); assert.equal(f.view.myList.value.length, 0);
      assert.equal(f.view.pendingCancel.value, null); assert.match(f.view.myError.value, /请刷新记录确认结果/);
      f.view.requestCancel(80); await f.view.confirmCancel(); assert.equal(f.calls.length, 1);
      await f.view.loadMy(); assert.deepEqual(f.view.myList.value.map(x => x.id), [90]); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
  it('PC failed cancel or post-write reload never replays and preserves current page', async () => {
    for (const rejection of [true, false]) {
      let changed = false, readFailure = false;
      const f = await cancellationMount({ rows: () => { if (readFailure) throw Error('read failed'); return [mine(80, changed ? 3 : 1)]; },
        post: () => { changed = true; readFailure = !rejection; return rejection ? { status: 400, msg: '状态错误' } : { status: 200, data: null }; } });
      try {
        await f.view.loadMy(2); f.view.requestCancel(80); await f.view.confirmCancel();
        assert.equal(f.view.myList.value.length, 0); assert.equal(f.view.pendingCancel.value, null);
        assert.equal(f.view.myPage.value, 2); assert.ok(f.view.myError.value);
        readFailure = false; await f.view.loadMy(2); f.view.requestCancel(80); await f.view.confirmCancel(); assert.equal(f.calls.length, 1);
      } finally { f.close(); }
    }
  });
  it('PC cancel API validates paired numeric identities and active authentication before I/O', async () => {
    const { server, authUtils, api, response } = getContext(), model = await server.ssrLoadModule('/src/api/activity.ts'); let calls = 0;
    api.defaults.adapter = async config => { calls++; return response(config, { status: 200, data: null }); };
    for (const args of [[0, 40], [80, 0], [80, '40'], [80, 2147483648], [NaN, 40]]) await assert.rejects(model.apiBargainCancel(...args));
    assert.equal(calls, 0); authUtils.clearAuth(); await assert.rejects(model.apiBargainCancel(80, 40)); assert.equal(calls, 0);
  });
  it('PC friend invitation uses exact help-only reads and real Axios help without purchase authority', async () => {
    let helped = false;
    const f = await mount({ entry: '/bargain/40?bargainUserId=80&help=1',
      read: () => ({ status: 200, data: helped ? friendReady() : friendFixture() }),
      post: () => { helped = true; return { status: 200, data: { price: '4.00' } }; } });
    try {
      assert.deepEqual(f.reads[0], { url: '/bargain/detail/40', params: { view: 'help', bargain_user_id: 80 } });
      assert.equal(f.view.detail.value, null); assert.equal(f.view.canBuy.value, false);
      assert.equal(f.view.invitationPath.value, '/bargain/40?bargainUserId=80&help=1');
      assert.equal(f.view.invitationUrl.value, 'https://shop.example.test/bargain/40?bargainUserId=80&help=1');
      await f.view.start(); await f.view.buy(); await f.view.helpSelf(); assert.equal(f.calls.length, 0);
      await f.view.helpFriend(); assert.deepEqual(f.calls, [{ url: '/bargain/help', body: { bargain_user_id: 80 } }]);
      assert.equal(f.view.friend.value.participation.current_price, '2.00'); assert.equal(f.view.canHelpFriend.value, false);
      await f.view.helpFriend(); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
  it('PC friend guest login retains exact invitation and never implicitly helps', async () => {
    const { authUtils } = getContext(); authUtils.clearAuth();
    const f = await mount({ entry: '/bargain/40?bargainUserId=80&help=1', read: () => ({ status: 200, data: friendFixture() }) });
    try {
      assert.equal(f.reads.length, 0); assert.equal(f.view.friend.value, null);
      await f.view.helpFriend(); await f.view.login();
      const redirect = f.router.currentRoute.value.query.redirect;
      assert.equal(redirect, '/bargain/40?bargainUserId=80&help=1');
      authUtils.setAuth('friend-login', 22); await f.router.push(redirect); await flush();
      assert.equal(f.view.friend.value.participant_id, 80); assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  it('PC friend rejects ambiguous, missing and purchase parameters before I/O', async () => {
    for (const query of ['help=1', 'help=0&bargainUserId=80', 'help=1&help=1&bargainUserId=80',
      'help=1&bargainUserId=80&bargainUserId=90', 'help=1&bargainUserId=80&sku=actblu40',
      'help=1&bargainUserId=80&quantity=2', 'help=1&bargainUserId=2147483648']) {
      const f = await mount({ entry: '/bargain/40?' + query });
      try { assert.equal(f.reads.length, 0, query); assert.equal(f.calls.length, 0); assert.equal(f.view.friend.value, null); assert.ok(f.view.error.value); }
      finally { f.close(); }
    }
  });
  it('PC help API rejects invalid identities and mismatched or purchase-shaped data', async () => {
    const { server, api, response } = getContext(), model = await server.ssrLoadModule('/src/api/activity.ts'); let reads = 0;
    api.defaults.adapter = async config => { reads++; return response(config, { status: 200, data: friendFixture() }); };
    for (const ids of [[0, 80], [40, 0], [40, 1.5], ['40', 80], [40, 2147483648]]) await assert.rejects(model.apiBargainFriendView(...ids));
    assert.equal(reads, 0);
    for (const data of [friendFixture({ participant_id: 90 }), friendFixture({ bargain_id: 41 }), bargainFixture()]) {
      api.defaults.adapter = async config => response(config, { status: 200, data });
      await assert.rejects(model.apiBargainFriendView(40, 80));
    }
  });
  it('PC closed, owner, helped, exhausted, full and ended invitations cannot dispatch help', async () => {
    for (const change of [
      { is_owner: true, help_state: 'owner' }, { already_helped: true, help_state: 'already_helped' },
      { remaining_helper_uses: 0, help_state: 'limit_reached' }, { help_count: 2, help_state: 'people_full' },
      { in_stock: false, help_state: 'sold_out' }, { date_window: 'future', help_state: 'future' },
      { date_window: 'ended', help_state: 'ended' },
      { participation: { ...friendFixture().participation, status: 2, state: 'closed' }, help_state: 'closed' },
    ]) {
      const f = await mount({ entry: '/bargain/40?bargainUserId=80&help=1', read: () => ({ status: 200, data: friendFixture({ can_help: false, ...change }) }) });
      try { assert.ok(f.view.friend.value); assert.equal(f.view.canHelpFriend.value, false); await f.view.helpFriend(); assert.equal(f.calls.length, 0); }
      finally { f.close(); }
    }
  });
  for (const mutation of ['identity', 'route', 'query', 'unmount']) it(`PC late help response cannot restore old invitation after ${mutation}`, async () => {
    const waiting = gate(), started = gate(); let closed = false;
    const f = await mount({ entry: '/bargain/40?bargainUserId=80&help=1',
      read: config => ({ status: 200, data: friendFixture({ participant_id: config.params.bargain_user_id,
        participation: { ...friendFixture().participation, id: config.params.bargain_user_id } }) }),
      post: () => { started.release(); return waiting.promise; } });
    try {
      const helping = f.view.helpFriend(); await started.promise; await f.view.helpFriend(); assert.equal(f.calls.length, 1);
      if (mutation === 'identity') getContext().authUtils.setAuth('replacement-friend', 22);
      if (mutation === 'route') await f.router.push('/elsewhere');
      if (mutation === 'query') await f.router.push('/bargain/40?bargainUserId=90&help=1');
      if (mutation === 'unmount') { f.close(); closed = true; }
      await flush(); const reads = f.reads.length;
      waiting.release({ status: 200, data: { price: '4.00' } }); await helping; await flush();
      assert.equal(f.reads.length, reads); assert.equal(f.calls.length, 1);
      if (mutation === 'query') assert.equal(f.view.friend.value.participant_id, 90);
    } finally { waiting.release({ status: 200, data: {} }); if (!closed) f.close(); }
  });
  it('PC unknown help outcome clears controls until an explicit refresh reads the committed result', async () => {
    let helped = false;
    const f = await mount({ entry: '/bargain/40?bargainUserId=80&help=1',
      read: () => ({ status: 200, data: helped ? friendReady() : friendFixture() }),
      post: () => { helped = true; throw new Error('connection lost'); } });
    try {
      await f.view.helpFriend(); assert.equal(f.view.friend.value, null); assert.equal(f.view.invitationPath.value, '');
      assert.match(f.view.error.value, /请刷新确认/); await f.view.helpFriend(); assert.equal(f.calls.length, 1);
      await f.view.load(); assert.equal(f.view.friend.value.participation.current_price, '2.00'); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
  it('PC cached eligibility is rechecked against the wall clock before help dispatch', async () => {
    const f = await mount({ entry: '/bargain/40?bargainUserId=80&help=1', read: () => ({ status: 200, data: friendFixture() }) });
    const original = Date.now;
    try { assert.equal(f.view.canHelpFriend.value, true); Date.now = () => original() + 3600000;
      await f.view.helpFriend(); assert.equal(f.calls.length, 0); assert.equal(f.view.friend.value, null); }
    finally { Date.now = original; f.close(); }
  });
  it('PC self help pins the loaded record, checks ownership and cannot be repeated after success', async () => {
    const owner = () => friendFixture({ is_owner: true, can_help: false, help_state: 'owner', already_helped: false, help_count: 0 });
    const f = await mount({ entry: '/bargain/40',
      read: config => { const row = bargainFixture(config); row.can_select = false;
        row.participation = { ...row.participation, ...friendFixture().participation, catalog_price: '6.00', activity_price_changed: false };
        row.skus.forEach(s => { s.catalog_price = '6.00'; });
        return { status: 200, data: config.params.view === 'help' ? owner() : row }; },
      post: () => ({ status: 200, data: { price: '4.00' } }) });
    try {
      assert.equal(f.view.canHelpSelf.value, true); await f.view.helpSelf();
      assert.equal(f.router.currentRoute.value.query.bargainUserId, '80');
      assert.deepEqual(f.reads[1].params, { view: 'help', bargain_user_id: 80 });
      assert.deepEqual(f.calls, [{ url: '/bargain/help', body: { bargain_user_id: 80 } }]);
      assert.equal(f.view.canHelpSelf.value, false); await f.view.load(); await f.view.helpSelf(); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
  it('PC go-own preserves an owner record but drops a friend record without starting anything', async () => {
    for (const owner of [true, false]) {
      const f = await mount({ entry: '/bargain/40?bargainUserId=80&help=1',
        read: config => ({ status: 200, data: config.params.view === 'help'
          ? friendFixture({ is_owner: owner, can_help: !owner, help_state: owner ? 'owner' : 'available' }) : bargainFixture(config) }) });
      try { await f.view.goOwn(); await flush();
        assert.deepEqual({ ...f.router.currentRoute.value.query }, owner ? { bargainUserId: '80' } : {});
        assert.equal(f.view.helpMode.value, false); assert.equal(f.calls.length, 0);
      } finally { f.close(); }
    }
  });
  for (const id of [80, 90]) it(`bargain participation ${id} is bound through actual Axios and checkout navigation`, async () => {
    const f = await mount({ entry: `/bargain/40?bargainUserId=${id}` }); try {
      assert.deepEqual(f.reads[0], { url: '/bargain/detail/40', params: { view: 'skus', bargain_user_id: id } });
      assert.equal(f.view.detail.value.participation.catalog_price, id === 80 ? '2.00' : '4.00'); choose(f); await f.view.buy();
      assert.deepEqual(f.calls, [{ url: '/cart/add', body: { productId: 70, activityId: 40, bargainUserId: id, type: 2, unique: 'actblu40', cartNum: 2, new: 1 } }]);
      assert.deepEqual({ ...f.router.currentRoute.value.query }, checkout(id));
    } finally { f.close(); }
  });
  it('anonymous exact participation login restores identity, latest SKU and quantity without an unauthenticated write', async () => {
    const { authUtils } = getContext(); authUtils.clearAuth(); const f = await mount(); try {
      assert.deepEqual(f.reads[0].params, { view: 'skus' }); assert.equal(f.view.detail.value.participation, null); choose(f); await f.view.login();
      const redirect = f.router.currentRoute.value.query.redirect; assert.match(redirect, /bargainUserId=80/); assert.match(redirect, /sku=actblu40/);
      authUtils.setAuth('bargain-new', 11); await f.router.push(redirect); await flush();
      assert.equal(f.view.selected.value, 'actblu40'); assert.equal(f.view.quantity.value, 2); assert.equal(f.view.detail.value.participation.id, 80); assert.equal(f.calls.length, 0);
    } finally { f.close(); }
  });
  it('expired authentication returns to the latest bound intent without falling back to another participation', async () => {
    const { authUtils, navigation, location } = getContext(); const f = await mount({ post: () => ({ status: 410002, msg: 'expired' }) }); try {
      choose(f); await f.view.buy(); const redirect = new URL(navigation.at(-1), location.origin).searchParams.get('redirect');
      assert.match(redirect, /bargainUserId=80/); assert.match(redirect, /sku=actblu40/); assert.match(redirect, /quantity=2/);
      await f.router.push('/login'); authUtils.setAuth('bargain-renewed', 11); await f.router.push(redirect); await flush();
      assert.equal(f.view.selected.value, 'actblu40'); assert.equal(f.view.detail.value.participation.id, 80); assert.equal(f.calls.length, 1);
    } finally { f.close(); }
  });
  for (const mutation of ['identity', 'route', 'query', 'unmount', 'cancel']) it(`no bargain add after ${mutation} during intent navigation`, async () => {
    const f = await mount(), waiting = gate(), started = gate(); choose(f); let closed = false;
    const off = f.router.beforeEach(async to => { if (to.query.sku !== 'actblu40') return; started.release(); await waiting.promise; if (mutation === 'cancel') return false; });
    try {
      const buying = f.view.buy(); await started.promise; await f.view.buy();
      if (mutation === 'identity') getContext().authUtils.setAuth('replacement', 22);
      if (mutation === 'route') await f.router.push('/elsewhere');
      if (mutation === 'query') await f.router.push('/bargain/40?bargainUserId=90');
      if (mutation === 'unmount') { f.close(); closed = true; }
      waiting.release(); await buying; await flush(); assert.equal(f.calls.length, 0);
    } finally { waiting.release(); off(); if (!closed) f.close(); }
  });
  for (const mutation of ['identity', 'route', 'query', 'unmount']) it(`late cart response cannot navigate after bargain ${mutation}`, async () => {
    const waiting = gate(), started = gate(); const f = await mount({ post: () => { started.release(); return waiting.promise; } }); choose(f); let closed = false;
    try {
      const buying = f.view.buy(); await started.promise; await f.view.buy();
      if (mutation === 'identity') getContext().authUtils.setAuth('replacement', 22);
      if (mutation === 'route') await f.router.push('/elsewhere');
      if (mutation === 'query') await f.router.push('/bargain/40?bargainUserId=90');
      if (mutation === 'unmount') { f.close(); closed = true; }
      waiting.release({ status: 200, data: { id: 91 } }); await buying; await flush();
      assert.equal(f.calls.length, 1); assert.notEqual(f.router.currentRoute.value.path, '/checkout');
    } finally { waiting.release({ status: 200, data: { id: 91 } }); if (!closed) f.close(); }
  });
  it('failed checkout navigation retains the exact bargain cart and retries navigation only', async () => {
    const f = await mount(); choose(f); const off = f.router.beforeEach(to => to.path === '/checkout' ? false : undefined);
    try { await f.view.buy(); assert.ok(f.view.prepared.value); const reads = f.reads.length; await f.view.load(); assert.equal(f.reads.length, reads);
      f.view.choose('actred40'); assert.equal(f.view.selected.value, 'actblu40'); off(); await f.view.buy(); assert.equal(f.calls.length, 1); assert.deepEqual({ ...f.router.currentRoute.value.query }, checkout(80));
    } finally { off(); f.close(); }
  });
  it('retains the successful start ID across failed navigation, without replaying start', async () => {
    const f = await mount({ entry: '/bargain/40', read: config => ({ status: 200, data: config.params.bargain_user_id ? bargainFixture(config) : bargainFixture(config, true) }), post: () => ({ status: 200, data: { id: 80 } }) });
    const off = f.router.beforeEach(to => to.query.bargainUserId ? false : undefined);
    try { await f.view.start(); assert.equal(f.view.pendingStart.value, 80); off(); await f.view.start(); await flush(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, '/bargain/start'); assert.equal(f.view.detail.value.participation.id, 80); }
    finally { off(); f.close(); }
  });
  it('ignores stale participation selection and explicitly reloads a changed record', async () => {
    const waiting = gate(); let delay = false; const f = await mount({ read: config => delay && config.params.bargain_user_id === 80 ? waiting.promise : { status: 200, data: bargainFixture(config) } });
    try { delay = true; const old = f.view.load(); await flush(); await f.router.push('/bargain/40?bargainUserId=90'); await flush();
      assert.equal(f.view.detail.value.participation.id, 90); waiting.release({ status: 200, data: bargainFixture() }); await old; assert.equal(f.view.detail.value.participation.id, 90);
    } finally { waiting.release({ status: 200, data: bargainFixture() }); f.close(); }
  });
  for (const state of ['closed', 'used', 'cutting', 'ended', 'stock']) it(`bargain ${state} cannot be purchased or silently corrected`, async () => {
    const f = await mount({ entry: '/bargain/40?bargainUserId=80&sku=actblu40&quantity=2', read: config => {
      const row = bargainFixture(config);
      if (state === 'stock') row.skus[1].max_quantity = 1;
      else if (state === 'ended') { row.date_window = 'ended'; row.stop_time = new Date(Date.now() - 1).toISOString(); row.can_select = false; }
      else { Object.assign(row.participation, { state, status: state === 'closed' ? 2 : state === 'used' ? 4 : 1 }); row.can_select = false;
        if (state === 'cutting') { Object.assign(row.participation, { cut_price: '2.00', current_price: '8.00', remaining_cut: '6.00', catalog_price: '8.00', progress_percent: 25 }); row.skus.forEach(s => { s.catalog_price = '8.00'; }); } }
      return { status: 200, data: row };
    } }); try { assert.ok(f.view.detail.value); assert.equal(f.view.canBuy.value, false); await f.view.buy(); assert.equal(f.calls.length, 0); if (state === 'stock') assert.equal(f.view.quantity.value, 2); } finally { f.close(); }
  });
  it('rechecks the deadline after intent navigation waits', async () => {
    const f = await mount(), waiting = gate(), started = gate(); choose(f);
    const off = f.router.beforeEach(async to => { if (to.query.sku) { started.release(); await waiting.promise; } });
    try { const buying = f.view.buy(); await started.promise; f.view.detail.value.stop_time = new Date(Date.now() - 1).toISOString(); waiting.release(); await buying; assert.equal(f.calls.length, 0); assert.ok(f.view.error.value); }
    finally { waiting.release(); off(); f.close(); }
  });
  it('bargain list and mine use canonical money, owner identity and independent page retries', async () => {
    let failed = false; const f = await mount({ list: true, entry: '/bargain', read: config => {
      if (config.params.page === 2 && !failed) { failed = true; throw new Error('page retry'); }
      return { status: 200, data: config.url === '/bargain/list' ? [{ id: 40, title: '真标题', image: '', price: 10, min_price: 2 }] : [mine()] };
    } }); try {
      assert.equal(f.view.goods.value[0].title, '真标题'); assert.equal(f.view.goods.value[0].minimum, '2.00');
      await f.view.load(2); assert.equal(f.view.page.value, 2); assert.match(f.view.error.value, /page retry/); assert.equal(f.view.goods.value.length, 0);
      await f.view.load(2); assert.equal(f.view.goods.value.length, 1); await f.view.openMy();
      assert.equal(f.view.myList.value[0].current, '2.00'); assert.equal(f.view.myList.value[0].progress, 100);
      await f.view.loadMy(2); assert.deepEqual(f.reads.at(-1), { url: '/bargain/user/list', params: { page: 2, limit: 20 } });
      getContext().authUtils.setAuth('different-owner', 22); assert.equal(f.view.myList.value.length, 0); assert.equal(f.view.myVisible.value, false);
    } finally { f.close(); }
  });
  it('closing my bargain list suppresses a late private response', async () => {
    const waiting = gate(), started = gate(); const f = await mount({ list: true, entry: '/bargain', read: config => {
      if (config.url === '/bargain/user/list') { started.release(); return waiting.promise; } return { status: 200, data: [] };
    } }); try { const read = f.view.openMy(); await started.promise; f.view.myVisible.value = false; f.view.closeMy(); waiting.release({ status: 200, data: [mine()] }); await read; assert.deepEqual(f.view.myList.value, []); }
    finally { waiting.release({ status: 200, data: [] }); f.close(); }
  });
  it('actual parsers reject namespace/SKU/amount contradictions and preserve price-change semantics', async () => {
    const model = await getContext().server.ssrLoadModule('/../common/bargainPurchase.ts');
    for (const change of [r => { r.bargain_id = 41; }, r => { r.participation.id = 90; }, r => { r.participation.catalog_price = '1.00'; },
      r => { r.skus[0].catalog_price = '999.00'; }, r => { r.skus[1].unique = r.skus[0].unique; }, r => { r.skus[0].base_unique = r.skus[1].unique; },
      r => { r.participation.progress_percent = 0; }, r => { r.can_select = false; }]) {
      const row = bargainFixture(); change(row); assert.throws(() => model.parseBargainSelection(row, 40, 80));
    }
    const row = bargainFixture(); row.activity_price = '12.00'; row.participation.activity_price_changed = true;
    assert.equal(model.parseBargainSelection(row, 40, 80).participation.catalog_price, '2.00');
    row.participation.catalog_price = '4.00'; row.skus.forEach(s => { s.catalog_price = '4.00'; });
    assert.throws(() => model.parseBargainSelection(row, 40, 80));
    assert.throws(() => model.parseBargainSelection(row, 40, 80, false)); assert.throws(() => model.parseMyBargains([mine()], 22));
    assert.equal(model.parseMyBargains([{ ...mine(), price: '99.00', residue_price: '0.00' }], 11)[0].amountsValid, false);
  });
}
