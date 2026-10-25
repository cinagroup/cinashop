const { test, assert, path, vue, root, loader, node, renderer, all, text, tick } = require('./helpers/diy-navigation-runtime.cjs');
const { createRouter, createMemoryHistory } = require('vue-router');

const file = path.join(root, 'components/AdminDashboardShortcuts.vue');
const expected = [
  ['/user', '用户管理'],
  ['/config', '系统设置'],
  ['/product', '商品'],
  ['/order', '订单管理'],
  ['/setting/notification', '消息配置'],
  ['/content/article', '文章管理'],
  ['/agent', '分销管理'],
  ['/coupon', '优惠券'],
];
const paths = expected.map(([to]) => to);
const menus = values => values.map(value => typeof value === 'string' ? { path: value } : value);
const anchors = m => all(m.tree, n => n.tag === 'a');
const hrefs = m => anchors(m).map(n => n.props.href);

async function mount(overrides = {}) {
  const actor = vue.reactive({ token: 'token-A', userInfo: { id: 11, level: 0 }, menus: [], uniqueAuth: [], ...overrides });
  const l = loader({ actor });
  const component = l.load(file).default;
  const empty = vue.defineComponent({ setup: () => () => null });
  const router = createRouter({ history: createMemoryHistory(), routes: ['/dashboard', ...paths].map(to => ({ path: to, component: empty })) });
  await router.push('/dashboard');
  await router.isReady();
  const tree = node('root');
  const app = renderer.createApp({ setup: () => () => vue.h(component) });
  app.use(router);
  app.mount(tree);
  await tick();
  return { actor, tree, router, l, unmount: () => app.unmount() };
}

function clickEvent(overrides = {}) {
  return { button: 0, detail: 1, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false, currentTarget: { getAttribute: () => null },
    preventDefault() { this.defaultPrevented = true; }, ...overrides };
}
async function click(anchor, event = clickEvent()) {
  assert.equal(typeof anchor.props.onClick, 'function', 'the real template must wire its fresh authorization guard');
  await anchor.props.onClick(event);
  await tick();
  return event;
}

// The actual compiled component, reactive auth store and real RouterLink/useLink
// run in the shared custom Vue renderer. Native font loading, layout and browser
// keyboard defaults remain the separate browser acceptance's responsibility.
test('authenticated super admin sees all eight original PHP labels in order with native anchor hrefs', async () => {
  const m = await mount();
  try {
    assert.deepEqual(hrefs(m), paths);
    expected.forEach(([to, label], index) => {
      const anchor = anchors(m)[index];
      assert.equal(anchor.props.href, to);
      assert.ok(text(anchor).includes(label), `${to} must expose its visible label`);
      assert.notEqual(anchor.props.role, 'button');
      assert.notEqual(anchor.props.tabindex, -1);
      assert.notEqual(anchor.props.tabindex, '-1');
    });
    assert.deepEqual(m.l.calls, [], 'quick links must not issue business requests');
  } finally { m.unmount(); }
});

test('limited roles use exact menu paths without inheriting parent, child or similarly prefixed permissions', async () => {
  const m = await mount({ userInfo: { id: 11, level: 1 }, menus: menus(['/config', '/user', '/user', '/product/edit/1', '/order/offline', '/coupon/issue', '/agent/other', '/content/article-extra', '/setting/notification/templates']) });
  try {
    assert.deepEqual(hrefs(m), ['/user', '/config']);
    m.actor.menus = menus(['/product', '/content/article', '/coupon']);
    await tick();
    assert.deepEqual(hrefs(m), ['/product', '/content/article', '/coupon']);
    m.actor.menus.splice(1, 1);
    await tick();
    assert.deepEqual(hrefs(m), ['/product', '/coupon']);
  } finally { m.unmount(); }
});

test('menu, level, token and account changes reactively remove revoked links and restore only current grants', async () => {
  const m = await mount({ userInfo: { id: 11, level: 1 }, menus: menus(['/user']) });
  try {
    assert.deepEqual(hrefs(m), ['/user']);
    m.actor.menus = menus(['/order', '/coupon']); await tick();
    assert.deepEqual(hrefs(m), ['/order', '/coupon']);
    m.actor.userInfo.level = 0; await tick();
    assert.deepEqual(hrefs(m), paths);
    m.actor.userInfo.level = 1; await tick();
    assert.deepEqual(hrefs(m), ['/order', '/coupon']);
    m.actor.token = ''; await tick(); assert.deepEqual(hrefs(m), []);
    m.actor.token = 'token-B'; await tick(); assert.deepEqual(hrefs(m), ['/order', '/coupon']);
    m.actor.userInfo = null; await tick(); assert.deepEqual(hrefs(m), []);
    m.actor.userInfo = { id: 22, level: 1 }; m.actor.menus = menus(['/agent']); await tick();
    assert.deepEqual(hrefs(m), ['/agent']);
    m.actor.menus = []; await tick(); assert.deepEqual(hrefs(m), []);
    m.actor.userInfo = { id: 22, level: 0 }; await tick(); assert.deepEqual(hrefs(m), paths);
    m.actor.token = null; await tick(); assert.deepEqual(hrefs(m), []);
  } finally { m.unmount(); }
});

for (const [name, revoke] of [
  ['menu replacement', actor => { actor.menus = []; }],
  ['exact path removal', actor => { actor.menus[0].path = '/user/groups'; }],
  ['token loss', actor => { actor.token = ''; }],
  ['account removal', actor => { actor.userInfo = null; }],
  ['super-admin demotion', actor => { actor.userInfo.level = 1; actor.menus = []; }],
]) {
  test(`a previously rendered anchor rejects ${name} before Vue flushes`, async () => {
    const m = await mount({ userInfo: { id: 11, level: name === 'super-admin demotion' ? 0 : 1 }, menus: menus(['/user']) });
    try {
      const stale = anchors(m).find(n => n.props.href === '/user');
      assert.ok(stale);
      revoke(m.actor);
      // Do not await nextTick here: exercise the old compiled template handler
      // while its anchor still exists, rather than only the computed filtering.
      const event = clickEvent();
      await stale.props.onClick(event);
      await tick();
      assert.equal(event.defaultPrevented, true, 'denial must suppress the stale native href too');
      assert.equal(m.router.currentRoute.value.path, '/dashboard');
      assert.deepEqual(hrefs(m), []);
    } finally { m.unmount(); }
  });
}

test('real RouterLink navigation follows an allowed click and a keyboard-generated click', async () => {
  const m = await mount({ userInfo: { id: 11, level: 1 }, menus: menus(['/user', '/coupon']) });
  try {
    const event = await click(anchors(m).find(n => n.props.href === '/user'));
    assert.equal(event.defaultPrevented, true);
    assert.equal(m.router.currentRoute.value.path, '/user');
    await m.router.push('/dashboard'); await tick();
    const keyboardClick = await click(anchors(m).find(n => n.props.href === '/coupon'), clickEvent({ detail: 0 }));
    assert.equal(keyboardClick.defaultPrevented, true);
    assert.equal(m.router.currentRoute.value.path, '/coupon');
  } finally { m.unmount(); }
});

test('allowed native hrefs retain modified-click and middle-click browser handling', async () => {
  const m = await mount({ userInfo: { id: 11, level: 1 }, menus: menus(['/user']) });
  try {
    for (const overrides of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const anchor = anchors(m)[0];
      assert.equal(anchor.props.href, '/user');
      const event = await click(anchor, clickEvent(overrides));
      assert.equal(event.defaultPrevented, false, JSON.stringify(overrides));
      assert.equal(m.router.currentRoute.value.path, '/dashboard');
    }
  } finally { m.unmount(); }
});
