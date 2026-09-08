const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, deferred } = require('./uni-store-runtime.cjs');

// Real Vue/Pinia/composable/request/API/shared parser; only native I/O is synthetic.
function catalogue(id = 80) {
  const minimum = id === 90 ? '4.00' : '2.00', cut = id === 90 ? '6.00' : '8.00';
  return { selection_only: true, type: 2, bargain_id: 40, product_id: 70, title: '隔离砍价', image: '',
    activity_price: '10.00', minimum_price: '2.00', people: 2, date_window: 'active',
    start_time: new Date(Date.now() - 60000).toISOString(), stop_time: new Date(Date.now() + 60000).toISOString(),
    can_select: !!id, participation: id ? { id, status: 3, state: 'ready', original_price: '10.00', minimum_price: minimum,
      cut_price: cut, current_price: minimum, remaining_cut: '0.00', catalog_price: minimum, activity_price_changed: false, progress_percent: 100 } : null,
    skus: [{ unique: 'actred40', base_unique: 'qared001', suk: '红色大号', image: '', stock: 6, max_quantity: 6, catalog_price: id ? minimum : null },
      { unique: 'actblu40', base_unique: 'qablue01', suk: '蓝色小号', image: '', stock: 2, max_quantity: 2, catalog_price: id ? minimum : null }] };
}
function myRow(id = 80) {
  return { id, uid: 11, bargain_id: 40, title: '隔离砍价', image: '', status: 3,
    bargain_price: '10.00', bargain_price_min: '2.00', price: '8.00', residue_price: '2.00', pay_status: true };
}
function setup({ detail = call => ({ data: catalogue(call.data.bargain_user_id || 80) }),
  add = () => ({ data: { id: 901 } }), my = () => ({ data: [myRow()] }), mutate = () => ({ data: { id: 80 } }), component } = {}) {
  return runtime({ feature: 'useBargainPurchase', component, send: call => {
    if (call.url === '/api/bargain/detail/40') return detail(call);
    if (call.url === '/api/cart/add') return add(call);
    if (call.url === '/api/bargain/user/list') return my(call);
    if (['/api/bargain/start', '/api/bargain/help'].includes(call.url)) return mutate(call);
    throw new Error(`Unexpected bargain I/O: ${call.url}`);
  } });
}
const adds = r => r.calls.filter(c => c.url === '/api/cart/add');
const reads = r => r.calls.filter(c => c.url === '/api/bargain/detail/40');
const writes = r => r.calls.filter(c => ['/api/cart/add', '/api/bargain/start', '/api/bargain/help'].includes(c.url));
const start = (r, id = '80') => r.start({ id: '40', bargainUserId: id });

test('actual page bindings select activity SKU and preserve exact participation into checkout', async () => {
  for (const id of [80, 90]) {
    const r = setup({ component: 'pages/activity/bargainDetail.vue' }); try {
      await start(r, String(id)); const p = r.checkout;
      assert.deepEqual(reads(r)[0].data, { view: 'skus', bargain_user_id: id });
      assert.equal(p.canBuy.value, false); p.choose('actblu40'); p.setQuantity({ detail: { value: '2' } });
      assert.equal(p.selectedSku.value.catalog_price, id === 80 ? '2.00' : '4.00');
      await p.purchase();
      assert.deepEqual(adds(r)[0].data, { productId: 70, activityId: 40, bargainUserId: id, type: 2, unique: 'actblu40', cartNum: 2, new: 1 });
      assert.equal(r.navigations.at(-1), `/pages/order/confirm?mode=buy&cartId=901&type=2&bargainUserId=${id}`);
      assert.ok(r.calls.every(c => !/order\/(confirm|create|computed)|pay/.test(c.url)));
    } finally { r.stop(); }
  }
});

test('invalid or mixed link namespaces never request data or mutate', async () => {
  const invalid = [{}, { id: '0' }, { id: '01' }, { id: ['40'] }, { id: '2147483648' }, { id: '40', bargainUserId: '0' },
    { id: '40', bargainUserId: '-1' }, { id: '40', bargainUserId: ['80'] }, { mine: 'true' }, { mine: '1', id: '40' }, { mine: '1', bargainUserId: '80' }];
  for (const query of invalid) {
    const r = setup(); try { await r.start(query); assert.equal(r.calls.length, 0); assert.ok(r.checkout.error.value);
      await r.checkout.purchase(); await r.checkout.startBargain(); assert.equal(writes(r).length, 0);
    } finally { r.stop(); }
  }
});

test('anonymous explicit record and mine mode require login without leaking private requests', async () => {
  for (const query of [{ id: '40', bargainUserId: '80' }, { mine: '1' }]) {
    const r = setup(); try {
      r.auth.clear(); await r.start(query); assert.equal(r.calls.length, 0); assert.match(r.checkout.error.value, /登录/);
      r.checkout.login(); r.checkout.login(); assert.deepEqual(r.navigations, ['/pages/auth/login']);
      r.hooks.onHide(); r.auth.setLogin('return-token', 11); r.hooks.onShow(); await tick();
      assert.equal(r.checkout.error.value, ''); assert.equal(r.calls.length, 1); assert.equal(writes(r).length, 0);
    } finally { r.stop(); }
  }
});

test('anonymous public SKU intent resumes after login without automatically starting or buying', async () => {
  let anonymous = true;
  const r = setup({ detail: () => ({ data: catalogue(anonymous ? 0 : 80) }) }); try {
    r.auth.clear(); await r.start({ id: '40' }); const p = r.checkout;
    p.choose('actblu40'); p.quantity.value = 2; assert.equal(p.canBuy.value, false); p.login();
    r.hooks.onHide(); anonymous = false; r.auth.setLogin('return-token', 11); r.hooks.onShow(); await tick();
    assert.equal(p.selected.value, 'actblu40'); assert.equal(p.quantity.value, 2); assert.equal(p.canBuy.value, true);
    assert.equal(writes(r).length, 0);
  } finally { r.stop(); }
});

test('expired write restores exact participation and selection only for the same owner', async () => {
  for (const uid of [11, 22]) {
    const r = setup({ add: () => ({ status: 410002, msg: 'Synthetic expiry' }) }); try {
      await r.start({ id: '40' }); const p = r.checkout; p.choose('actblu40'); p.quantity.value = 2;
      await p.purchase(); assert.equal(adds(r).length, 1); assert.equal(r.navigations.at(-1), '/pages/auth/login');
      r.hooks.onHide(); r.auth.setLogin('return-token', uid); r.hooks.onShow(); await tick();
      assert.equal(p.participantId.value, 80); assert.equal(p.selected.value, uid === 11 ? 'actblu40' : '');
      assert.equal(p.quantity.value, uid === 11 ? 2 : 1); assert.equal(adds(r).length, 1);
      assert.deepEqual(reads(r).at(-1).data, { view: 'skus', bargain_user_id: 80 });
    } finally { r.stop(); }
  }
});

test('returned stock reduction does not silently shrink the selected purchase quantity', async () => {
  let stock = 2;
  const r = setup({ add: () => ({ status: 410002 }), detail: () => {
    const data = catalogue(); data.skus[1].stock = stock; data.skus[1].max_quantity = stock; return { data };
  } }); try {
    await start(r); const p = r.checkout; p.choose('actblu40'); p.quantity.value = 2; await p.purchase();
    r.hooks.onHide(); stock = 1; r.auth.setLogin('new', 11); r.hooks.onShow(); await tick();
    assert.equal(p.quantity.value, 2); assert.equal(p.canBuy.value, false); assert.match(p.error.value, /库存或限购/);
  } finally { r.stop(); }
});

test('invalid catalogues fail closed instead of falling back to ordinary goods', async () => {
  for (const change of [d => ({ ...d, type: 0 }), d => ({ ...d, bargain_id: 70 }), d => ({ ...d, participation: null }),
    d => ({ ...d, participation: { ...d.participation, id: 90 } }), d => ({ ...d, skus: [d.skus[0], d.skus[0]] }),
    d => ({ ...d, skus: [{ ...d.skus[0], catalog_price: '777.00' }] })]) {
    const r = setup({ detail: () => ({ data: change(catalogue()) }) }); try {
      await start(r); assert.equal(r.checkout.detail.value, null); assert.ok(r.checkout.error.value);
      r.checkout.choose('qablue01'); await r.checkout.purchase(); assert.equal(writes(r).length, 0);
    } finally { r.stop(); }
  }
});

test('cutting, closed, used, expired and sold-out records cannot be purchased', async () => {
  for (const kind of ['cutting', 'closed', 'used', 'expired', 'soldout']) {
    const r = setup({ detail: () => {
      const data = catalogue(); data.can_select = false;
      if (kind === 'cutting') Object.assign(data.participation, { status: 1, state: 'cutting', cut_price: '6.00', current_price: '4.00', remaining_cut: '2.00', catalog_price: '4.00', progress_percent: 75 });
      if (kind === 'closed' || kind === 'used') Object.assign(data.participation, { status: kind === 'closed' ? 2 : 4, state: kind });
      if (kind === 'expired') data.date_window = 'ended';
      data.skus = data.skus.map(s => ({ ...s, catalog_price: data.participation.catalog_price, ...(kind === 'soldout' ? { stock: 0, max_quantity: 0 } : {}) }));
      return { data };
    } }); try {
      await start(r); const p = r.checkout; assert.ok(p.detail.value, kind); p.choose('actblu40');
      assert.equal(p.canBuy.value, false); await p.purchase(); assert.equal(adds(r).length, 0);
    } finally { r.stop(); }
  }
});

test('quantity input and base SKU substitutions cannot bypass activity constraints', async () => {
  const r = setup({ component: 'pages/activity/bargainDetail.vue' }); try {
    await start(r); const p = r.checkout; p.choose('actblu40');
    for (const value of ['', '0', '-1', '1.5', '1e1', '3', '999999']) {
      p.setQuantity({ detail: { value } }); assert.equal(p.canBuy.value, false); await p.purchase();
    }
    p.setQuantity({ target: { value: '2' } }); assert.equal(p.canBuy.value, true);
    p.selected.value = 'qablue01'; assert.equal(p.canBuy.value, false); await p.purchase(); assert.equal(adds(r).length, 0);
  } finally { r.stop(); }
});

test('successful add and failed native navigation retry only the exact prepared cart', async () => {
  const pending = deferred(), r = setup({ add: () => pending.promise }); try {
    await start(r); const p = r.checkout; p.choose('actblu40'); const callbacks = [];
    r.uni.navigateTo = opts => { callbacks.push(opts); r.navigations.push(opts.url); };
    const work = p.purchase(); await tick(); await p.purchase(); await p.load(); p.choose('actred40');
    assert.equal(adds(r).length, 1); assert.equal(reads(r).length, 1); assert.equal(p.selected.value, 'actblu40');
    pending.resolve({ data: { id: 901 } }); await work;
    await p.purchase(); assert.equal(callbacks.length, 1); callbacks[0].fail({});
    assert.deepEqual(p.prepared.value, { id: 901, participantId: 80 }); assert.match(p.error.value, /无需重新加购/);
    await p.purchase(); assert.equal(adds(r).length, 1); assert.equal(callbacks.length, 2);
    callbacks[0].fail({}); assert.equal(p.navigating.value, true); callbacks[1].success?.({});
    await p.purchase(); assert.equal(callbacks.length, 2); assert.equal(p.navigating.value, true);
    r.hooks.onHide(); assert.equal(p.prepared.value, null);
  } finally { r.stop(); }
});

test('late reads and writes cannot navigate or repopulate hidden, unloaded or replaced pages', async () => {
  for (const action of ['read', 'write']) for (const boundary of ['hide', 'unload', 'identity', 'route']) {
    const pending = deferred(), r = setup(action === 'read' ? { detail: () => pending.promise } : { add: () => pending.promise });
    try {
      await start(r); const p = r.checkout;
      let work; if (action === 'write') { p.choose('actblu40'); work = p.purchase(); await tick(); }
      if (boundary === 'identity') r.auth.setLogin('replacement', 22);
      else if (boundary === 'route') r.hooks.onLoad({ id: '40', bargainUserId: '90' });
      else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      pending.resolve({ data: action === 'read' ? catalogue() : { id: 901 } }); await work; await tick();
      assert.equal(p.detail.value, null); assert.equal(p.prepared.value, null); assert.equal(r.navigations.length, 0);
    } finally { r.stop(); }
  }
});

test('obsolete navigation callbacks cannot unlock the current identity navigation', async () => {
  const r = setup(); try {
    await start(r); const p = r.checkout; const callbacks = []; r.uni.navigateTo = opts => callbacks.push(opts);
    p.goMine(); r.hooks.onHide(); r.hooks.onShow(); await tick(); p.goMine();
    callbacks[0].fail({}); assert.equal(p.navigating.value, true);
    callbacks[1].fail({}); assert.equal(p.navigating.value, false); assert.match(p.error.value, /页面打开失败/);
  } finally { r.stop(); }
});

test('write boundary checks activity deadline before the next UI clock tick', async () => {
  const r = setup(), actualNow = Date.now; try {
    await start(r); const p = r.checkout; p.choose('actblu40');
    Date.now = () => Date.parse(p.detail.value.stop_time) + 1;
    await p.purchase(); assert.equal(adds(r).length, 0); assert.equal(p.detail.value, null); assert.match(p.error.value, /不可购买/);
  } finally { Date.now = actualNow; r.stop(); }
});

test('failed and uncertain cart responses require a fresh read and explicit new selection', async () => {
  for (const result of [{ status: 400, msg: '资格已失效' }, { transport: 'Synthetic lost response' }, { data: { id: 0 } }, { data: null }]) {
    const r = setup({ add: () => result }); try {
      await start(r); const p = r.checkout; p.choose('actblu40'); await p.purchase(); await p.purchase();
      assert.equal(adds(r).length, 1); assert.equal(p.detail.value, null); assert.equal(p.prepared.value, null); assert.ok(p.error.value);
      await p.load(); assert.equal(p.selected.value, ''); assert.equal(p.canBuy.value, false);
    } finally { r.stop(); }
  }
});

test('start preserves the returned participation when its follow-up read fails; retries never repeat start', async () => {
  let started = false, fail = true;
  const r = setup({ detail: () => started && fail ? { status: 400, msg: 'Synthetic read failure' } : { data: catalogue(started ? 80 : 0) },
    mutate: () => { started = true; return { data: { id: 80 } }; } });
  try {
    await r.start({ id: '40' }); const p = r.checkout; assert.equal(p.canStart.value, true);
    await p.startBargain(); assert.equal(p.participantId.value, 80); assert.equal(p.detail.value, null); assert.ok(p.error.value);
    await p.startBargain(); assert.equal(writes(r).length, 1); fail = false; await p.load();
    assert.deepEqual(reads(r).at(-1).data, { view: 'skus', bargain_user_id: 80 }); assert.equal(p.canStart.value, false);
  } finally { r.stop(); }
});

test('self help sends the selected participant once and reloads server amounts', async () => {
  const pending = deferred(); let helped = false;
  const r = setup({ detail: () => {
    const data = catalogue(); if (!helped) {
      data.can_select = false; Object.assign(data.participation, { status: 1, state: 'cutting', cut_price: '6.00', current_price: '4.00', remaining_cut: '2.00', catalog_price: '4.00', progress_percent: 75 });
      data.skus.forEach(s => { s.catalog_price = '4.00'; });
    } return { data };
  }, mutate: () => pending.promise }); try {
    await start(r); const p = r.checkout; assert.equal(p.canHelp.value, true);
    const work = p.helpSelf(); await tick(); await p.helpSelf(); assert.equal(writes(r).length, 1);
    assert.deepEqual(writes(r)[0].data, { bargain_user_id: 80 }); helped = true; pending.resolve({ data: { price: '8.00' } }); await work;
    assert.equal(p.detail.value.participation.current_price, '2.00'); assert.equal(p.canHelp.value, false); assert.equal(p.selected.value, '');
  } finally { r.stop(); }
});

test('mine=1 is a paginated owner-validated list, with exact-record detail links', async () => {
  const r = setup({ my: c => ({ data: c.data.page === 1 ? Array.from({ length: 20 }, (_, i) => myRow(80 + i)) : [myRow(101)] }) }); try {
    await r.start({ mine: '1' }); const p = r.checkout;
    assert.equal(p.mine.value, true); assert.equal(p.records.value.length, 20); assert.equal(reads(r).length, 0);
    await p.load(2); assert.equal(p.page.value, 2); assert.equal(p.records.value[0].current, '2.00');
    assert.deepEqual(r.calls.map(c => c.data), [{ page: 1, limit: 20 }, { page: 2, limit: 20 }]);
    p.chooseRecord(80); assert.equal(r.navigations.length, 0); p.chooseRecord(101); p.chooseRecord(101);
    assert.deepEqual(r.navigations, ['/pages/activity/bargainDetail?id=40&bargainUserId=101']);
  } finally { r.stop(); }
});

test('mine failures differ from empty and retry the same page; invalid ownership is rejected', async () => {
  let fails = true;
  const r = setup({ my: c => c.data.page === 2 && fails ? { status: 400, msg: 'Synthetic list failure' } : { data: [] } }); try {
    await r.start({ mine: '1' }); const p = r.checkout; assert.equal(p.error.value, '');
    await p.load(2); assert.ok(p.error.value); assert.equal(p.page.value, 2); fails = false; await p.load();
    assert.equal(p.error.value, ''); assert.deepEqual(p.records.value, []);
    assert.deepEqual(r.calls.slice(1).map(c => c.data), Array(2).fill({ page: 2, limit: 20 }));
  } finally { r.stop(); }
  const wrong = setup({ my: () => ({ data: [{ ...myRow(), uid: 22 }] }) }); try {
    await wrong.start({ mine: '1' }); assert.deepEqual(wrong.checkout.records.value, []); assert.ok(wrong.checkout.error.value);
  } finally { wrong.stop(); }
});

test('private late list results are discarded after hide, unload or account replacement', async () => {
  for (const boundary of ['hide', 'unload', 'identity']) {
    const pending = deferred(), r = setup({ my: c => c.data.page === 2 ? pending.promise : { data: [myRow()] } }); try {
      await r.start({ mine: '1' }); const p = r.checkout, work = p.load(2); await tick();
      if (boundary === 'identity') r.auth.setLogin('another', 22); else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      pending.resolve({ data: [myRow(90)] }); await work;
      assert.deepEqual(p.records.value, []); assert.equal(p.loading.value, false); p.chooseRecord(90); assert.equal(r.navigations.length, 0);
    } finally { r.stop(); }
  }
});

function activitySetup(send) {
  return runtime({ component: 'pages/activity/index.vue', send: c => { assert.equal(c.url, '/api/bargain/list'); return send(c); } });
}

test('delayed expiry cannot restore purchase intent into a reused route', async () => {
  const pending = deferred(), r = setup({ add: () => pending.promise }); try {
    await start(r); const p = r.checkout; p.choose('actblu40'); p.quantity.value = 2;
    const work = p.purchase(); await tick(); r.hooks.onLoad({ id: '40', bargainUserId: '90' });
    pending.resolve({ status: 410002 }); await work;
    r.hooks.onHide(); r.auth.setLogin('return', 11); r.hooks.onShow(); await tick();
    assert.equal(p.participantId.value, 90); assert.equal(p.selected.value, ''); assert.equal(p.quantity.value, 1);
  } finally { r.stop(); }
});

test('late start or help results after lifecycle and identity changes never replace current participation', async () => {
  for (const kind of ['start', 'help']) for (const boundary of ['hide', 'identity', 'route']) {
    const pending = deferred(), r = setup({ detail: () => {
      const data = catalogue(kind === 'start' ? 0 : 80);
      if (kind === 'help') {
        data.can_select = false; Object.assign(data.participation, { status: 1, state: 'cutting', cut_price: '6.00', current_price: '4.00', remaining_cut: '2.00', catalog_price: '4.00', progress_percent: 75 });
        data.skus.forEach(s => { s.catalog_price = '4.00'; });
      } return { data };
    }, mutate: () => pending.promise }); try {
      await r.start(kind === 'start' ? { id: '40' } : { id: '40', bargainUserId: '80' }); const p = r.checkout;
      const work = kind === 'start' ? p.startBargain() : p.helpSelf(); await tick();
      if (boundary === 'hide') r.hooks.onHide();
      else if (boundary === 'identity') r.auth.setLogin('different', 22);
      else r.hooks.onLoad({ id: '40', bargainUserId: '90' });
      pending.resolve({ data: { id: 80, price: '8.00' } }); await work;
      assert.equal(p.detail.value, null); assert.equal(reads(r).length, 1); assert.equal(r.navigations.length, 0);
      assert.equal(p.participantId.value, boundary === 'route' ? 90 : kind === 'start' ? 0 : 80);
    } finally { r.stop(); }
  }
});

test('unknown or invalid start results cannot fabricate a participant or auto-repeat a write', async () => {
  for (const result of [{ transport: 'Synthetic lost response' }, { data: { id: 0 } }, { data: { id: '80' } }, { status: 400, msg: '已存在多条有效记录' }]) {
    const r = setup({ detail: () => ({ data: catalogue(0) }), mutate: () => result }); try {
      await r.start({ id: '40' }); const p = r.checkout; await p.startBargain(); await p.startBargain();
      assert.equal(writes(r).length, 1); assert.equal(p.participantId.value, 0); assert.equal(p.detail.value, null); assert.ok(p.error.value);
    } finally { r.stop(); }
  }
});

test('activity repricing is displayed as a different catalogue price, not silently rewritten to the floor', async () => {
  const r = setup({ detail: () => { const data = catalogue(); data.activity_price = '12.00';
    data.participation.catalog_price = '4.00'; data.participation.activity_price_changed = true;
    data.skus.forEach(s => { s.catalog_price = '4.00'; }); return { data }; } }); try {
    await start(r); const p = r.checkout;
    assert.equal(p.detail.value.participation.current_price, '2.00'); assert.equal(p.detail.value.participation.catalog_price, '4.00');
    p.choose('actblu40'); assert.equal(p.selectedSku.value.catalog_price, '4.00'); assert.equal(p.canBuy.value, true);
  } finally { r.stop(); }
});

test('activity catalogue errors remain distinct from empty and retry their original page', async () => {
  let fails = true;
  const r = activitySetup(c => c.data.page === 2 && fails ? { status: 400, msg: 'Synthetic failure' } : { data: [] }); try {
    await r.start({ type: 'bargain' }); const p = r.checkout; await p.loadBargain(2);
    assert.ok(p.bargainError.value); assert.equal(p.bargainPage.value, 2); assert.deepEqual(p.bargainList.value, []);
    fails = false; await p.loadBargain(p.bargainPage.value); assert.equal(p.bargainError.value, '');
    assert.deepEqual(r.calls.slice(1).map(c => c.data), Array(2).fill({ page: 2, limit: 20 }));
  } finally { r.stop(); }
});
const item = id => ({ id, title: `砍价 ${id}`, image: '', price: 10, min_price: 2 });
test('actual activity bargain tab paginates and only navigates a current catalogue entry', async () => {
  const r = activitySetup(c => ({ data: c.data.page === 1 ? Array.from({ length: 20 }, (_, i) => item(i + 40)) : [item(60)] })); try {
    await r.start({ type: 'bargain' }); const p = r.checkout; assert.equal(p.bargainList.value.length, 20);
    assert.equal(p.bargainList.value[0].minimum, '2.00'); await p.loadBargain(2);
    p.goBargain(40); assert.equal(r.navigations.length, 0); p.goBargain(60);
    assert.deepEqual(r.navigations, ['/pages/activity/bargainDetail?id=60']); p.goMyBargain();
    assert.equal(r.navigations.at(-1), '/pages/activity/bargainDetail?mine=1');
    assert.deepEqual(r.calls.map(c => c.data), [{ page: 1, limit: 20 }, { page: 2, limit: 20 }]);
  } finally { r.stop(); }
});

test('late activity catalogue responses do not survive hide, tab changes or unload', async () => {
  for (const boundary of ['hide', 'tab', 'unload']) {
    const pending = deferred(), r = activitySetup(c => c.data.page === 2 ? pending.promise : { data: [item(40)] }); try {
      await r.start({ type: 'bargain' }); const p = r.checkout, work = p.loadBargain(2); await tick();
      if (boundary === 'tab') p.switchTab('lottery'); else r.hooks[boundary === 'hide' ? 'onHide' : 'onUnload']();
      pending.resolve({ data: [item(60)] }); await work; assert.deepEqual(p.bargainList.value, []); assert.equal(p.bargainLoading.value, false);
      p.goBargain(60); assert.equal(r.navigations.length, 0);
      if (boundary !== 'unload') {
        if (boundary === 'tab') p.switchTab('bargain'); else r.hooks.onShow(); await tick();
        assert.deepEqual(p.bargainList.value.map(r => r.id), [40]); assert.equal(p.bargainPage.value, 1);
      }
    } finally { r.stop(); }
  }
});
