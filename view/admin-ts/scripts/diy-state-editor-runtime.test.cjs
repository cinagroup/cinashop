const { test, assert, path, vue, root, pageFile, clone, tick, deferred, all, text, loader, mount, editorFile, previewFile, utilFile, projectionFile, defaults, kinds, labels, block, harness, controlNode, update, payload, response, galleryItem, ticket } = require('./helpers/diy-state-runtime.cjs');
const cornerLabels = kind => ['userInfor', 'signIn'].includes(kind) ? ['左上', '右上', '右下', '左下'] : ['左上', '右上', '左下', '右下'];
for (const kind of kinds) for (const style of [0, 1]) test(`compiled ${kind} style${style} edits every actual color/tone/spacing/corner/checkbox field through parent v-model and retains dormant metadata`, async () => {
  const b = block(kind), neighbor = { name: 'unsupported-state', timestamp: 5, raw: { empty: [], zero: 0 } }, r = harness([b, neighbor]);
  try {
    await update(r, `${labels[kind]}展示风格`, style); assert.equal(r.preview().p.style, style);
    const tones = kind === 'newVip' ? [['toneConfig', '新人积分色调'], ['toneCouponConfig', '新人优惠券色调'], ['toneGoodsConfig', '新人商品价格色调']] : [['toneConfig', kind === 'userInfor' ? '进度条色调' : '组件色调']];
    assert.deepEqual(r.state.tones.map(field => field.key), tones.map(([key]) => key));
    for (const [key, label] of tones) { await update(r, label, 1); assert.equal(r.value()[0][key].tabVal, 1); }
    const colorSlots = Object.entries(defaults[kind]).flatMap(([key, value]) => Array.isArray(value?.color) ? value.color.map((_item, index) => `${key}:${index}`) : []);
    assert.deepEqual(r.state.colours.map(field => `${field.key}:${field.index}`), colorSlots);
    for (const field of r.state.colours) { await update(r, labels[kind] + field.label, field.index ? '#abcdef' : '#123456'); assert.equal(r.value()[0][field.key].color[field.index].item, field.index ? '#abcdef' : '#123456'); }
    const lengthKeys = [...(kind === 'ranking' ? ['titleNumber', 'bntNumber'] : kind === 'newVip' ? ['spacingConfig', 'spacingConfig2'] : []), 'topConfig', 'bottomConfig', 'prConfig', 'mbConfig'];
    assert.deepEqual(r.state.lengths.map(field => field.key), lengthKeys);
    for (const field of r.state.lengths) { await update(r, labels[kind] + field.label, 12.5); assert.equal(r.value()[0][field.key].val, 12.5); }
    assert.deepEqual(r.state.radiusFields.map(field => field.key), kind === 'ranking' ? ['fillet', 'filletBg', 'filletImg'] : ['fillet']);
    for (const field of r.state.radiusFields) {
      await update(r, labels[kind] + field.label + '值', 6.5); assert.equal(r.value()[0][field.key].val, 6.5);
      await update(r, labels[kind] + field.label + '模式', 1);
      for (const [index, label] of cornerLabels(kind).entries()) await update(r, labels[kind] + field.label + label, index + 1.25);
      assert.deepEqual(r.value()[0][field.key].valList.map(item => item.val), [1.25, 2.25, 3.25, 4.25]);
    }
    if (kind === 'userInfor' || kind === 'newVip') {
      for (let id = 0; id <= (kind === 'userInfor' ? 5 : 2); id++) { r.state.setCheck(id, true); await tick(); assert.equal(r.preview().p.checks.includes(id), true); }
      r.state.setCheck(0, false); await tick(); assert.equal(r.preview().p.checks.includes(0), false);
    }
    if (kind === 'ranking') {
      await update(r, '排行榜标题方式', 1); await update(r, '排行榜标题文字', '真实榜单'); await update(r, '排行榜更多文字', '看更多');
      for (const font of [0, 1, 2]) { await update(r, '排行榜标题字形', font); assert.equal(r.preview().p.titleStyle.fontWeight, font === 0 ? 'bold' : 'normal'); assert.equal(r.preview().p.titleStyle.fontStyle, font === 2 ? 'italic' : 'normal'); }
    }
    const before = r.value(); await update(r, `${labels[kind]}展示风格`, 1 - style); const after = r.value(); after[0].styleConfig.tabVal = style; assert.deepEqual(after, before);
    assert.deepEqual(after[1], neighbor); assert.deepEqual(after[0].authorExtra, b.authorExtra);
    const shell = all(r.tree, node => node.props.class === 'state-author-preview')[0], panel = all(shell, node => node.props.class === 'panel')[0];
    assert.equal(shell.props.style.padding, '12.5px 12.5px 12.5px'); assert.equal(shell.props.style.marginTop, '12.5px');
    assert.equal(panel.props.style.borderRadius, ['userInfor', 'signIn'].includes(kind) ? '1.25px 2.25px 3.25px 4.25px' : '1.25px 2.25px 4.25px 3.25px');
    if (kind === 'ranking') assert.equal(r.preview().p.rankCardStyle.borderRadius, '1.25px 2.25px 4.25px 3.25px');
    for (const [key, field] of Object.entries(defaults[kind])) if (field && typeof field === 'object') for (const meta of ['title', 'default', 'tabList', 'list', 'name', 'min', 'type']) if (Object.hasOwn(field, meta) && !['checkboxInfo', 'fillet', 'filletBg', 'filletImg'].includes(key)) assert.deepEqual(after[0][key][meta], field[meta], key + '.' + meta);
  } finally { r.unmount(); }
});
for (const kind of kinds) test(`${kind} opens complete raw imports without default merging, count inventions, clipping or a single emitted update`, async () => {
  const b = block(kind); b.styleConfig.tabVal = '01'; b.topConfig.val = '1e30'; b.prConfig.val = ' 125.5 '; b.fillet.type = true; b.fillet.valList = [{ val: '5e-4' }, { val: ' 2.25 ' }, { val: '3e0' }, { val: 4.75 }];
  b.largeImport = Array.from({ length: 2501 }, (_, index) => ({ index, image: ticket(22), inactive: [] })); b.numConfig = { val: 101, dormant: true }; b.numberConfig = { val: 0, dormant: true };
  const value = [b, { ...clone(b), timestamp: 11, isHide: true }, { name: 'pageFoot', timestamp: -999, menuList: [] }, { name: 'unsupported-state', timestamp: -1e30, raw: 'retain' }], r = harness(value);
  try { const raw = r.props.modelValue; await tick(); r.state.select(1); await tick(); r.state.select(0); await tick(); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
    r.state.visible(false); await tick(); const expected = clone(value); expected[0].isHide = true; assert.deepEqual(r.value(), expected); assert.equal(r.value()[0].largeImport.length, 2501);
  } finally { r.unmount(); }
});
test('ordinary additions allow duplicate state families, bind new timestamps only to real body neighbors and insert before the footer', async () => {
  const unknown = { name: 'unsupported-state', timestamp: 1e30, data: { keep: true } }, footer = { name: 'pageFoot', timestamp: 999, menuList: [] }, title = { name: 'titles', timestamp: 20, titleConfig: { value: '保留正文' } }, r = harness([block('userInfor'), unknown, title, footer]);
  try { for (const kind of kinds) { r.state.addKind = kind; r.state.add(); await tick(); const added = r.value()[r.state.selected], expected = clone(defaults[kind]); expected.timestamp = added.timestamp; assert.deepEqual(added, expected); assert.ok(added.timestamp < 100); assert.equal(r.value().at(-1).name, 'pageFoot'); }
    assert.equal(r.value().filter(row => row.name === 'userInfor').length, 2); assert.deepEqual(r.value()[1], unknown); assert.deepEqual(r.value().find(row => row.name === 'titles'), title);
  } finally { r.unmount(); }
});
test('explicit state move swaps only real neighboring body timestamps and leaves unsupported neighbors and footer intact', async () => {
  const value = [{ name: 'titles', timestamp: 5, titleConfig: { value: '正文' } }, block('ranking', 10), { name: 'unsupported-state', timestamp: 9, opaque: [0] }, block('signIn', 20), { name: 'pageFoot', timestamp: 0, menuList: [] }], r = harness(value);
  try { r.state.move(1); await tick(); const expected = clone(value); expected[1] = { ...value[3], timestamp: 10 }; expected[3] = { ...value[1], timestamp: 20 }; assert.deepEqual(r.value(), expected); assert.equal(r.state.selected, 3);
    const raw = r.props.modelValue; r.state.move(1); await tick(); assert.equal(r.props.modelValue, raw); assert.ok(r.state.error);
    r.state.remove(); await tick(); assert.equal(r.value().some(row => row.name === 'ranking'), false); assert.deepEqual(r.value().find(row => row.name === 'unsupported-state'), value[2]);
  } finally { r.unmount(); }
});
for (const bad of ['null', '{}', '[{"name":"ranking","constructor":{}}]', 'not-json']) test(`invalid author document ${bad} stays raw and exposes an error without a partial component rewrite`, async () => {
  const r = harness([], { props: { modelValue: bad } }); try { await tick(); assert.ok(r.state.parsed.error); r.state.add(); r.state.visible(false); await tick(); assert.equal(r.props.modelValue, bad); assert.deepEqual(r.writes, []); } finally { r.unmount(); }
});
test('malformed existing containers are never overwritten by typed setters and valid unknown checkbox members survive explicit selection', async () => {
  const b = block(); b.fillet = null; b.checkboxInfo.type = [0, '0', false, 99, { opaque: true }, 2]; const r = harness([b]);
  try { const raw = r.props.modelValue; r.state.setRadius('fillet', -1, 5); await tick(); assert.equal(r.props.modelValue, raw); assert.ok(r.state.error);
    r.state.setCheck(0, false); await tick(); assert.deepEqual(r.value()[0].checkboxInfo.type, ['0', false, 99, { opaque: true }, 2]); r.state.setCheck(5, true); await tick(); assert.deepEqual(r.value()[0].checkboxInfo.type, ['0', false, 99, { opaque: true }, 2, 5]); assert.equal(r.value()[0].fillet, null);
    const before = r.props.modelValue; r.state.setCheck(6, true); await tick(); assert.equal(r.props.modelValue, before);
  } finally { r.unmount(); }
});
test('actual bounded field handlers reject invalid input and equal projected numeric values preserve raw strings and true corner flags', async () => {
  const b = block('ranking'); b.styleConfig.tabVal = '01'; b.titleText.tabVal = '2e0'; b.topConfig.val = ' 12.5 '; b.fillet.type = true; const r = harness([b]);
  try { const raw = r.props.modelValue; r.state.setStyle(1); r.state.setEnum('titleText', 2, 2); r.state.setLength('topConfig', 12.5); r.state.setRadiusType('fillet', 1); await tick(); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
    for (const value of [-1, 101, NaN, Infinity, '3', null]) { r.state.setLength('topConfig', value); r.state.setRadius('fillet', 0, value); } for (const value of [-1, 2, '1', true, null]) r.state.setStyle(value);
    r.state.setText('titleTxtConfig', 'control\u0000text'); r.state.setColour(r.state.colours[0], 'url(javascript:bad)'); await tick(); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
  } finally { r.unmount(); }
});
test('ranking imported longer text is fully visible and editable within its existing bound without trimming on mount or unrelated changes', async () => {
  const b = block('ranking'); b.titleTxtConfig.value = '  导入超过六字的榜单标题  '; b.rightBntConfig.value = '导入超过六字按钮'; const r = harness([b]);
  try { const raw = r.props.modelValue; await tick(); assert.equal(controlNode(r, '排行榜标题文字').props.modelValue, b.titleTxtConfig.value); assert.equal(controlNode(r, '排行榜标题文字').props.maxlength, b.titleTxtConfig.value.length); assert.equal(r.props.modelValue, raw);
    await update(r, '排行榜标题文字', '保存导入长榜单标题'); assert.equal(r.value()[0].titleTxtConfig.value, '保存导入长榜单标题'); assert.equal(r.value()[0].rightBntConfig.value, b.rightBntConfig.value);
    const before = r.props.modelValue; await update(r, '排行榜更多文字', '超'.repeat(b.rightBntConfig.value.length + 1)); assert.equal(r.props.modelValue, before);
  } finally { r.unmount(); }
});
for (const kind of ['userInfor', 'ranking']) test(`compiled ${kind} real gallery selection flows through actual picker and v-model, binding only the same-reference preview ticket`, async () => {
  const r = harness([block(kind)], { gallery: async () => ({ list: [galleryItem(7)], count: 1 }) });
  try { const picker = r.instances.get(path.join(root, 'pages/activity/SeckillActivityImagePicker.vue')).at(-1); await picker.open(); await tick(); picker.choose(picker.items[0]); await tick(); await tick();
    const key = kind === 'userInfor' ? 'logoConfig' : 'imgConfig'; assert.equal(r.value()[0][key].url, '/api/assets/7'); assert.equal(r.state.imagePreview, ticket(7)); assert.deepEqual(r.state.previews, { '/api/assets/7': ticket(7) });
    assert.equal(r.writes.length, 1); assert.equal(r.galleryCalls.length, 1); assert.equal(r.galleryCalls[0].params.file_type, 1); assert.equal(r.uploadCalls.length, 0);
  } finally { r.unmount(); }
});
test('actual gallery reselects the same canonical stored image and refreshes only its current matching preview ticket without a JSON author update', async () => {
  const b = block('ranking'); b.imgConfig.url = '/api/assets/7'; const r = harness([b], { gallery: async () => ({ list: [galleryItem(7)], count: 1 }) });
  try { const raw = r.props.modelValue, picker = r.instances.get(path.join(root, 'pages/activity/SeckillActivityImagePicker.vue')).at(-1); await picker.open(); await tick(); picker.choose(picker.items[0]); await tick(); await tick();
    assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []); assert.equal(r.state.imageReference, '/api/assets/7'); assert.equal(r.state.imagePreview, ticket(7)); assert.deepEqual(r.state.previews, { '/api/assets/7': ticket(7) }); assert.equal(r.galleryCalls.length, 1);
  } finally { r.unmount(); }
});
for (const kind of ['userInfor', 'ranking']) test(`${kind} different-reference gallery preview never substitutes another asset and old gallery callbacks are fenced after selection changes`, async () => {
  const value = [block(kind), block('signIn', 20)], r = harness(value); try {
    const choose = r.state.mediaSession.choose, originalPreview = r.state.imagePreview, originalRaw = r.props.modelValue; await choose('/api/assets/7', ticket(8)); await tick(); assert.equal(r.state.imagePreview, originalPreview); assert.equal(r.props.modelValue, originalRaw); assert.deepEqual(r.state.previews, {});
    const stale = r.state.mediaSession.choose; r.state.select(1); await tick(); const raw = r.props.modelValue; await stale('/api/assets/9', ticket(9)); await tick(); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.state.previews, {});
  } finally { r.unmount(); }
});
for (const kind of ['userInfor', 'ranking']) test(`${kind} saved-media preview accepts only the canonical whole matching component and anonymous current-reference GET`, async () => {
  const b = block(kind), key = kind === 'userInfor' ? 'logoConfig' : 'imgConfig'; b[key].url = '/api/assets/7'; const r = harness([b]), old = global.fetch, calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return response({ value: [{ ...clone(b), [key]: { ...b[key], url: ticket(7) } }] }); };
  try { const raw = r.props.modelValue; await r.state.loadSavedMedia(); await tick(); assert.equal(r.state.imagePreview, ticket(7)); assert.deepEqual(r.state.previews, { '/api/assets/7': ticket(7) }); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
    assert.equal(calls[0].url, '/api/diy/get_diy/2'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.headers, undefined);
  } finally { global.fetch = old; r.unmount(); }
});
for (const kind of ['userInfor', 'ranking']) test(`${kind} saved image cannot be adopted from a changed component, another asset, expired ticket or unpublished page`, async () => {
  const b = block(kind), key = kind === 'userInfor' ? 'logoConfig' : 'imgConfig'; b[key].url = '/api/assets/7'; const r = harness([b]), old = global.fetch; let reply, reads = 0; global.fetch = async () => { reads++; return response(reply); };
  try { const raw = r.props.modelValue; for (const value of [{ value: [{ ...clone(b), timestamp: 99, [key]: { ...b[key], url: ticket(7) } }] }, { value: [{ ...clone(b), [key]: { ...b[key], url: ticket(8) } }] }, { value: [{ ...clone(b), [key]: { ...b[key], url: '/api/assets/7?expires=1&signature=' + 'a'.repeat(43) } }] }, { value: null }]) { reply = value; await r.state.loadSavedMedia(); await tick(); assert.deepEqual(r.state.previews, {}); }
    r.props.pagePublished = false; await tick(); const before = reads; await r.state.loadSavedMedia(); assert.equal(reads, before); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
  } finally { global.fetch = old; r.unmount(); }
});
for (const boundary of ['selection', 'raw', 'page', 'page-id', 'unpublished', 'actor', 'permission', 'token', 'session', 'auth-event', 'disabled', 'unmount']) test(`captured media callback and abort-ignoring saved-image response cannot cross ${boundary}`, async () => {
  const b = block('ranking'); b.imgConfig.url = '/api/assets/7'; const r = harness([b, block('newVip', 20)]), old = global.fetch, pending = deferred(); global.fetch = () => pending.promise;
  try { const choose = r.state.mediaSession.choose, job = r.state.loadSavedMedia(); await tick();
    if (boundary === 'selection') r.state.select(1); if (boundary === 'raw') r.props.modelValue = JSON.stringify([...r.value(), { name: 'extension' }]); if (boundary === 'page') r.props.editorKey = 'other-state-page'; if (boundary === 'actor') r.actor.userInfo.id = 99;
    if (boundary === 'page-id') r.props.pageId = 3; if (boundary === 'unpublished') r.props.pagePublished = false; if (boundary === 'auth-event') r.window.dispatchEvent(new Event('admin-auth-expired'));
    if (boundary === 'permission') { r.actor.userInfo.level = 1; r.actor.uniqueAuth = []; } if (boundary === 'token') r.storage.set('admin_token', 'B'); if (boundary === 'session') { r.storage.set('admin_session', 'B'); r.window.dispatchEvent(new Event('storage')); } if (boundary === 'disabled') r.props.disabled = true; if (boundary === 'unmount') r.unmount();
    await tick(); const raw = r.props.modelValue; await choose('/api/assets/9', ticket(9)); pending.resolve(response({ value: [{ ...clone(b), imgConfig: { ...b.imgConfig, url: ticket(7) } }] })); await job; await tick(); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.state.previews, {}); assert.equal(r.state.mediaLoading, false);
  } finally { pending.resolve(response({ value: [] })); global.fetch = old; r.unmount(); }
});
test('an old saved-media rejection cannot replace a newer same-component preview error or release its loading state', async () => {
  const b = block('ranking'); b.imgConfig.url = '/api/assets/7'; const r = harness([b]), old = global.fetch, first = deferred(), second = deferred(); let reads = 0; global.fetch = () => ++reads === 1 ? first.promise : second.promise;
  try { const previous = r.state.loadSavedMedia(); await tick(); const current = r.state.loadSavedMedia(); await tick(); first.reject(Error('旧图片请求失败')); await previous; await tick(); assert.equal(r.state.mediaLoading, true); assert.equal(r.state.error, ''); assert.deepEqual(r.state.previews, {});
    second.resolve(response({ value: [{ ...clone(b), imgConfig: { ...b.imgConfig, url: ticket(7) } }] })); await current; await tick(); assert.equal(r.state.mediaLoading, false); assert.deepEqual(r.state.previews, { '/api/assets/7': ticket(7) }); assert.equal(r.state.error, '');
  } finally { first.resolve(response({ value: [] })); second.resolve(response({ value: [] })); global.fetch = old; r.unmount(); }
});
test('readonly, minimal writer and revoked media permissions remain separate and stale setter callbacks refuse synchronous revocation', async () => {
  const actor = vue.reactive({ token: 'A', userInfo: { id: 11, level: 1 }, uniqueAuth: ['dise.view'] }), r = harness([block()], { actor });
  try { assert.equal(r.state.canEdit, false); const raw = r.props.modelValue; r.state.visible(false); r.state.add(); await tick(); assert.equal(r.props.modelValue, raw); assert.equal(r.state.canChooseMedia, false);
    actor.uniqueAuth = ['dise.view', 'dise.manage']; await tick(); assert.equal(r.state.canEdit, true); assert.equal(r.state.canChooseMedia, false); const choose = r.state.mediaSession.choose; await choose('/api/assets/7', ticket(7)); assert.equal(r.props.modelValue, raw);
    const handler = controlNode(r, '会员权益组件显示').props['onUpdate:modelValue']; actor.uniqueAuth = ['dise.view']; handler(false); await tick(); assert.equal(r.props.modelValue, raw); assert.deepEqual(r.writes, []);
  } finally { r.unmount(); }
});
test('actual DiseList parent saves exact two canonical state slots together with the retained existing canonicalizer chain and independent content', async () => {
  const writes = [], l = loader({ gateway: { get: async () => ({ data: [] }), post: async (url, body) => { writes.push({ url, body: clone(body) }); return { data: { id: 2, version: 'saved' } }; } } }), m = mount(l, pageFile, vue.reactive({}));
  const member = block('userInfor'), rank = block('ranking', 20); member.logoConfig.url = ticket(7); member.logoConfig.link = ticket(8); rank.imgConfig.url = ticket(9); rank.productList = [{ image: ticket(10) }];
  const value = [member, rank, { name: 'videos', timestamp: 30, imgConfig: { url: ticket(11) }, videoConfig: { url: ticket(12) } }, { name: 'pageFoot', timestamp: 40, menuList: [{ imgList: [ticket(13), ticket(14), ticket(15)] }] }];
  try { m.state.openForm({ id: 2, name: '状态页', title: '状态标题', value: JSON.stringify(value), content: 'independent-state-content', status: 1, type: 2, template_name: 'micro', is_diy: 1, is_show: 1, version: 'old', add_time: 100, update_time: 200 }); await tick();
    const editor = l.instances.get(editorFile).at(-1); editor.visible(false); await tick(); assert.equal(JSON.parse(m.state.form.value)[0].isHide, true); await m.state.save(); assert.equal(writes.length, 1);
    const expected = clone(value); expected[0].isHide = true; expected[0].logoConfig.url = '/api/assets/7'; expected[1].imgConfig.url = '/api/assets/9'; expected[2].imgConfig.url = '/api/assets/11'; expected[2].videoConfig.url = '/api/assets/12'; expected[3].menuList[0].imgList[0] = '/api/assets/13'; expected[3].menuList[0].imgList[1] = '/api/assets/14';
    assert.deepEqual(JSON.parse(writes[0].body.value), expected); assert.equal(writes[0].body.content, 'independent-state-content'); assert.deepEqual(Object.keys(writes[0].body).sort(), ['content', 'id', 'name', 'status', 'title', 'value']); assert.equal(m.state.form.type, 2); assert.equal(m.state.form.templateName, 'micro'); assert.equal(m.state.form.isDiy, 1);
  } finally { m.unmount(); }
});
test('actual parent page replacement invalidates old media closures and metadata-only save leaves untouched imported state JSON bytes alone', async () => {
  const writes = [], l = loader({ gateway: { get: async () => ({ data: [] }), post: async (url, body) => { writes.push({ url, body: clone(body) }); return { data: { id: 3, version: 'saved' } }; } } }), m = mount(l, pageFile, vue.reactive({}));
  const imported = ' [ ' + JSON.stringify(block('ranking')) + ' ] ', raw = JSON.stringify(JSON.parse(imported), null, 2), row = id => ({ id, name: '状态页' + id, title: '状态标题', value: imported, content: 'independent-content', status: 1, type: 2, template_name: 'micro', is_diy: 1, is_show: 1, version: 'old', add_time: 100, update_time: 200 });
  try { m.state.openForm(row(2)); await tick(); const first = l.instances.get(editorFile).at(-1), choose = first.mediaSession.choose; m.state.openForm(row(3)); await tick(); await choose('/api/assets/7', ticket(7)); await tick(); assert.equal(m.state.form.value, raw); assert.equal(m.state.form.id, 3);
    m.state.form.title = '状态新标题'; await m.state.save(); assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, { id: 3, title: '状态新标题' }); assert.equal(m.state.form.value, raw); assert.equal(m.state.form.content, 'independent-content');
  } finally { m.unmount(); }
});
