const { test, assert, clone, tick, all, text, kinds, block, harness, update, sign, response } = require('./helpers/diy-state-runtime.cjs');

test('compiled previews convert complete imported scientific rpx lengths and corners without changing any raw author values', async () => {
  for (const kind of kinds) {
    const b = block(kind);
    b.topConfig.val = 1e-7; b.bottomConfig.val = ' 1e-8 '; b.prConfig.val = '2.5e-9'; b.mbConfig.val = 5e-7;
    b.fillet.type = true; b.fillet.valList = [1e-7, '1e-8', 1e-9, ' 1e-10 '].map(val => ({ val }));
    const neighbor = { name: 'extension-state', timestamp: 11, raw: 'keep' }, r = harness([b, neighbor]);
    try {
      const raw = r.props.modelValue; await tick();
      const shell = all(r.tree, node => node.props.class === 'state-author-preview')[0];
      const panel = all(shell, node => node.props.class === 'panel')[0];
      assert.equal(shell.props.style.padding, '1e-7px 2.5e-9px 1e-8px');
      assert.equal(shell.props.style.marginTop, '5e-7px');
      assert.equal(panel.props.style.borderRadius, ['userInfor', 'signIn'].includes(kind) ? '1e-7px 1e-8px 1e-9px 1e-10px' : '1e-7px 1e-8px 1e-10px 1e-9px');
      assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []); assert.deepEqual(r.value(), [b, neighbor]);
    } finally { r.unmount(); }
  }
});

test('compiled sign background controls identify the actual weekly and reward slots and change only their corresponding current style', async () => {
  const b = block('signIn'); b.styleConfig.tabVal = 0; b.toneConfig.tabVal = 1;
  const neighbor = { name: 'extension-state', timestamp: 12, keep: true }, r = harness([b, neighbor]);
  try {
    await tick();
    const weekly = r.state.colours.find(field => field.key === 'moduleColor2' && field.index === 0);
    const reward = r.state.colours.find(field => field.key === 'moduleColor' && field.index === 0);
    assert.ok(weekly); assert.ok(reward); assert.match(weekly.label, /每周|经典/u); assert.match(reward.label, /奖励/u);
    await update(r, '签到' + weekly.label, '#123abc');
    let shell = all(r.tree, node => node.props.class === 'state-author-preview')[0];
    assert.match(all(shell, node => node.props.class === 'panel')[0].props.style.background, /#123abc/u);
    assert.equal(r.value()[0].moduleColor.color[0].item, b.moduleColor.color[0].item);
    await update(r, '签到展示风格', 1); await update(r, '签到' + reward.label, '#abc123');
    shell = all(r.tree, node => node.props.class === 'state-author-preview')[0];
    assert.match(all(shell, node => node.props.class === 'panel')[0].props.style.background, /#abc123/u);
    const expected = clone(b); expected.styleConfig.tabVal = 1; expected.moduleColor2.color[0].item = '#123abc'; expected.moduleColor.color[0].item = '#abc123';
    assert.deepEqual(r.value(), [expected, neighbor]);
  } finally { r.unmount(); }
});

for (const boundary of ['selection', 'page', 'actor']) test(`actual saved-media error is cleared across ${boundary} without writing or moving the prior component`, async () => {
  const b = block('ranking'), value = [b, block('newVip', 20)], r = harness(value), old = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return response({ value: [] }); };
  try {
    const raw = r.props.modelValue; await r.state.loadSavedMedia(); await tick();
    assert.match(r.state.error, /当前组件与已发布内容不同/u);
    assert.ok(all(r.tree, node => node.props['data-element'] === 'el-alert' && node.props['data-title'] === r.state.error).length);
    if (boundary === 'selection') r.state.select(1);
    if (boundary === 'page') r.props.editorKey = 'state:3';
    if (boundary === 'actor') r.actor.userInfo.id = 22;
    await tick();
    assert.equal(r.state.error, '');
    assert.equal(all(r.tree, node => node.props['data-element'] === 'el-alert' && /当前组件与已发布内容不同/u.test(node.props['data-title'] ?? '')).length, 0);
    assert.equal(r.props.modelValue, raw); assert.deepEqual(r.value(), value); assert.deepEqual(r.writes, []);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/diy/get_diy/2'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.credentials, 'omit');
  } finally { global.fetch = old; r.unmount(); }
});

test('compiled weekly sign preview displays each actual receipt reward type and date rather than a fabricated integral amount', async () => {
  const b = block('signIn'), data = sign(); b.styleConfig.tabVal = 0;
  data.signList[0][0].type = 1; data.signList[0][0].point = 991;
  data.signList[0][1].type = 2; data.signList[0][1].point = 992;
  data.signList[0][2].is_sign = true; data.signList[0][2].point = 993;
  const r = harness([b]), old = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return response(data); };
  try {
    const raw = r.props.modelValue; await r.state.loadPreview(); await tick();
    const week = all(r.tree, node => node.props.class === 'week')[0]; assert.ok(week);
    const days = all(week, node => node !== week && node.tag === 'div'); assert.equal(days.length, 7);
    assert.match(text(days[0]), /积分/u); assert.ok(text(days[0]).includes(data.signList[0][0].day));
    assert.match(text(days[1]), /经验/u); assert.doesNotMatch(text(days[1]), /积分/u); assert.ok(text(days[1]).includes(data.signList[0][1].day));
    assert.match(text(days[2]), /✓|已签/u); assert.ok(text(days[2]).includes(data.signList[0][2].day));
    assert.doesNotMatch(text(week), /991|992|993/u);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/diy/sign'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.credentials, 'omit');
    assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
  } finally { global.fetch = old; r.unmount(); }
});

test('both compiled member styles keep the actual Uni integral money coupon metric order and style0 excludes the duplicate member code', async () => {
  const old = global.fetch; let reads = 0; global.fetch = async () => { reads++; throw Error('Member author placeholders must not read personal data'); };
  try {
    for (const style of [0, 1]) {
      const b = block('userInfor'); b.styleConfig.tabVal = style; b.checkboxInfo.type = [0, 1, 2, 3, 4, 5]; const r = harness([b]);
      try {
        const raw = r.props.modelValue; await tick();
        const expectedIds = style === 0 ? [1, 2, 0, 4, 5] : [1, 2, 0, 3, 4, 5];
        const expectedLabels = style === 0 ? ['积分', '余额', '优惠券', '收藏', '浏览'] : ['积分', '余额', '优惠券', '会员码', '收藏', '浏览'];
        assert.deepEqual(r.preview().metrics.map(item => item.id), expectedIds);
        const metrics = all(r.tree, node => String(node.props.class ?? '').split(/\s+/u).includes('metrics'))[0]; assert.ok(metrics);
        assert.deepEqual(all(metrics, node => node.tag === 'span').map(text), expectedLabels);
        assert.equal(all(r.tree, node => node.props.class === 'member-code').length, style === 0 ? 1 : 0);
        assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
      } finally { r.unmount(); }
    }
    assert.equal(reads, 0);
  } finally { global.fetch = old; }
});
