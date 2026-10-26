const { test, assert, path, vue, root, loader, mount, all, text, tick, deferred, elementStub } = require('./helpers/diy-navigation-runtime.cjs');
const pageFile = path.join(root, 'pages/user/UserList.vue'), pickerFile = path.join(root, 'pages/user/UserDirectoryOptionPicker.vue');
const copy = value => JSON.parse(JSON.stringify(value));
const row = uid => ({ uid, account: `user${uid}`, nickname: `会员${uid}`, phone: `1390000${String(uid).padStart(4, '0')}`, avatar: '', now_money: '12.50', integral: 3, level: 0, status: 1, add_time: 1700000000, spread_uid: 0 });
const allRows = Array.from({ length: 64 }, (_, index) => row(64 - index));
const catalog = Array.from({ length: 31 }, (_, index) => ({ id: index + 1, name: `选项${index + 1}` }));
function base(url, params) {
  if (url === '/user/list') return { list: allRows.slice((params.page - 1) * params.limit, params.page * params.limit), count: allRows.length, page: params.page, limit: params.limit };
  if (url === '/user/filter_options') {
    const ids = params.selected_ids ? params.selected_ids.split(',').map(Number) : [];
    const filtered = params.keyword ? catalog.filter(item => item.name.includes(params.keyword)) : catalog;
    return { list: filtered.slice((params.page - 1) * params.limit, params.page * params.limit), count: filtered.length, page: params.page, limit: params.limit,
      selected: ids.flatMap(id => catalog.filter(item => item.id === id)), missing_ids: ids.filter(id => !catalog.some(item => item.id === id)) };
  }
  if (url === '/user/filter_regions') return params.pid === 0 ? [{ id: 10, name: '浙江', children: [] }, { id: 20, name: '江苏', children: [] }] : [];
  if (url.startsWith('/user/info/')) return { ...row(Number(url.split('/').at(-1))), pwd: 'must-not-survive' };
  throw Error('Unexpected GET ' + url);
}
async function create(options = {}, file = pageFile, props = {}) {
  const actor = vue.reactive({ token: 'token-A', userInfo: { id: 11, level: 1 }, menus: [], uniqueAuth: ['user.view', 'user.manage'] });
  actor.$patch = values => Object.assign(actor, values);
  const calls = [], notices = [], get = async (url, config = {}) => {
    const entry = { url, params: copy(config.params ?? {}), signal: config.signal }; calls.push(entry);
    return { data: options.get ? await options.get(entry, () => base(url, entry.params), calls.length) : base(url, entry.params) };
  };
  const gateway = { get, post: async (url, input, config) => { calls.push({ method: 'POST', url, input, signal: config.signal }); return { data: { uid: 1 } }; } };
  const l = loader({ actor, actualAuth: true, gateway });
  l.storage.set('admin_token', actor.token); l.storage.set('admin_session', JSON.stringify({ userInfo: copy(actor.userInfo), menus: [], uniqueAuth: copy(actor.uniqueAuth) }));
  const component = l.load(file).default;
  // Register only Element adapters; the real page/picker/API/normalizer/owner stay compiled and live.
  const { node, renderer, elementNames } = require('./helpers/diy-navigation-runtime.cjs');
  const tree = node('root'), app = renderer.createApp({ setup: () => () => vue.h(component, props) });
  for (const name of [...elementNames, 'el-avatar', 'el-date-picker', 'el-skeleton']) app.component(name, elementStub(name));
  app.directive('loading', {}); app.mount(tree); await tick(); await tick();
  return { l, actor, calls, tree, notices, get state() { return l.instances.get(file).at(-1); }, unmount() { app.unmount(); } };
}
const listCalls = m => m.calls.filter(item => item.url === '/user/list');
async function flush() { await tick(); await tick(); }
async function button(m, label) {
  const value = all(m.tree, node => node.tag === 'button' && text(node) === label)[0]; assert.ok(value, 'real template button ' + label);
  assert.equal(typeof value.props.onClick, 'function'); await value.props.onClick(); await flush(); return value;
}

test('real user directory loads exact count and initial15; pagination uses applied query instead of edited draft', async () => {
  const m = await create(); try {
    assert.equal(m.state.total, 64); assert.equal(m.state.list.length, 15); assert.equal(m.state.pageSize, 15);
    m.state.draft.nickname = 'unsubmitted'; await m.state.load(2, true, false); await flush();
    assert.deepEqual(listCalls(m).at(-1).params, { field_key: 'all', page: 2, limit: 15 });
    await button(m, '搜索');
    assert.deepEqual(listCalls(m).at(-1).params, { field_key: 'all', nickname: 'unsubmitted', page: 1, limit: 15 });
  } finally { m.unmount(); }
});

test('full filter intersection preserves explicit zeroes, all tag IDs and Shanghai date wire', async () => {
  const m = await create(); try {
    Object.assign(m.state.draft, { field_key: 'uid', nickname: '11', group_id: 0, label_ids: [7, 8], sex: '0', level: 2,
      isMember: '0', is_promoter: '0', dates: ['2026/10/01', '2026/10/25'], user_time_type: 'visit', pay_count: '0', country: 'domestic', province: '浙江', city: '杭州' });
    await button(m, '搜索'); const q = listCalls(m).at(-1).params;
    assert.deepEqual(q, { field_key: 'uid', nickname: '11', group_id: 0, label_ids: '7,8', sex: '0', level: 2,
      isMember: '0', is_promoter: '0', pay_count: '0', country: 'domestic', user_time_type: 'visit', user_time: '2026/10/01-2026/10/25', province: '浙江', city: '杭州', page: 1, limit: 15 });
  } finally { m.unmount(); }
});

test('source tabs retain applied filters; complete reset removes hidden fields, source, selected objects and region IDs', async () => {
  const m = await create(); try {
    m.state.draft.nickname = 'first'; await button(m, '搜索'); m.state.draft.nickname = 'draft-only';
    m.state.changeSource('routine'); await flush();
    assert.deepEqual(listCalls(m).at(-1).params, { field_key: 'all', nickname: 'first', user_type: 'routine', page: 1, limit: 15 });
    Object.assign(m.state.draft, { isMember: '1', label_ids: [1], province: 'old', city: 'old', dates: ['2026/10/01', '2026/10/20'], user_time_type: 'visit' });
    m.state.chosen.labels = [{ id: 1, name: '标签' }]; m.state.provinceId = 10; m.state.cityId = 11;
    m.state.changePageSize(30); await flush(); await button(m, '重置');
    assert.deepEqual(listCalls(m).at(-1).params, { field_key: 'all', page: 1, limit: 30 });
    assert.equal(m.state.draft.isMember, ''); assert.equal(m.state.draft.province, ''); assert.equal(m.state.draft.city, '');
    assert.equal(m.state.provinceId, undefined); assert.equal(m.state.cityId, undefined); assert.deepEqual(m.state.chosen.labels, []); assert.equal(m.state.draft.dates, null); assert.equal(m.state.source, '');
  } finally { m.unmount(); }
});

for (const [name, value] of [
  ['mode without dates', { user_time_type: 'visit' }], ['dates without mode', { dates: ['2026/10/01', '2026/10/02'] }],
  ['invalid leap day', { dates: ['2026/02/29', '2026/03/01'], user_time_type: 'visit' }],
  ['reversed date range', { dates: ['2026/10/25', '2026/10/01'], user_time_type: 'visit' }],
  ['bad UID', { field_key: 'uid', nickname: 'abc' }], ['duplicate tags', { label_ids: [1, 1] }], ['101 tags', { label_ids: Array.from({ length: 101 }, (_, i) => i + 1) }],
]) test(`invalid submitted filter refuses any new read: ${name}`, async () => {
  const m = await create(); try { const count = m.calls.length; Object.assign(m.state.draft, value); await button(m, '搜索'); assert.equal(m.calls.length, count); assert.ok(m.state.validationError); assert.equal(m.state.total, 64); } finally { m.unmount(); }
});

test('shrunk exact count makes only one bounded fallback read, then displays actual returned empty result', async () => {
  const m = await create({ get: async (entry, normal) => entry.url === '/user/list' && entry.params.page > 1 ?
    { list: [], count: entry.params.page === 5 ? 20 : 0, page: entry.params.page, limit: entry.params.limit } : normal() });
  try { const before = listCalls(m).length; await m.state.load(5); await flush();
    assert.deepEqual(listCalls(m).slice(before).map(item => item.params.page), [5, 2]); assert.equal(m.state.total, 0); assert.deepEqual(m.state.list, []); assert.equal(m.state.loading, false);
  } finally { m.unmount(); }
});

test('late success/error/finally from old search cannot replace current results or clear newer loading', async () => {
  const slow = deferred(), latest = deferred();
  const m = await create({ get: (entry, normal) => entry.params.nickname === 'slow' ? slow.promise : entry.params.nickname === 'latest' ? latest.promise : normal() });
  try {
    m.state.draft.nickname = 'slow'; m.state.search(); await flush(); const old = listCalls(m).at(-1);
    m.state.draft.nickname = 'latest'; m.state.search(); await flush(); assert.equal(old.signal.aborted, true);
    slow.reject(Error('old failure')); await flush(); assert.equal(m.state.loading, true); assert.equal(m.state.error, '');
    latest.resolve({ list: [row(777)], count: 1, page: 1, limit: 15 }); await flush(); assert.equal(m.state.list[0].uid, 777); assert.equal(m.state.loading, false);
  } finally { m.unmount(); }
});

test('persistent token replacement fences retained template handlers and pending read before an event flush', async () => {
  const slow = deferred(); const m = await create({ get: (entry, normal) => entry.params.nickname === 'slow' ? slow.promise : normal() });
  try {
    const retained = all(m.tree, node => node.tag === 'button' && text(node) === '搜索')[0];
    m.state.draft.nickname = 'slow'; m.state.search(); await flush(); const before = m.calls.length;
    m.l.storage.set('admin_token', 'replacement'); await retained.props.onClick(); assert.equal(m.calls.length, before);
    slow.resolve({ list: [row(999)], count: 1, page: 1, limit: 15 }); await flush(); assert.equal(m.state.list.length, 0);
    m.l.window.dispatchEvent(new Event('admin-session-changed')); await flush(); assert.equal(m.actor.token, 'replacement'); assert.equal(m.state.list[0].uid, 64); assert.equal(m.state.draft.nickname, '');
  } finally { m.unmount(); }
});

test('persisted permission revocation blocks stale manage/read actions without trusting the reactive grant', async () => {
  const m = await create(); try {
    const selected = m.state.list[0]; m.state.adjustMoney(selected); assert.equal(m.state.moneyDialog.show, true);
    m.l.storage.set('admin_session', JSON.stringify({ userInfo: copy(m.actor.userInfo), menus: [], uniqueAuth: [] }));
    const before = m.calls.length; m.state.moneyDialog.amount = 1; await m.state.submitMoney(); await m.state.showDetail(selected); m.state.search();
    assert.equal(m.calls.length, before); assert.equal(m.state.owner.has(), false);
    m.l.window.dispatchEvent(new Event('admin-session-changed')); await flush(); assert.equal(m.state.moneyDialog.show, false); assert.deepEqual(m.state.list, []);
  } finally { m.unmount(); }
});

test('late detail and source/list read after unmount cannot repopulate private state or publish notices', async () => {
  const pending = deferred(); const m = await create({ get: (entry, normal) => entry.url.startsWith('/user/info/') ? pending.promise : normal() });
  const uid = m.state.list[0].uid; m.state.showDetail(m.state.list[0]); await flush(); m.unmount(); pending.resolve({ ...row(uid), pwd: 'secret' }); await flush();
  assert.equal(m.state.detail, null); assert.equal(m.state.detailDialog.show, false); assert.deepEqual(m.l.notices, []);
});

test('region requests use label names and reject a slower previous province response', async () => {
  const a = deferred(), b = deferred(); const m = await create({ get: (entry, normal) => entry.url === '/user/filter_regions' && entry.params.pid === 10 ? a.promise : entry.url === '/user/filter_regions' && entry.params.pid === 20 ? b.promise : normal() });
  try {
    m.state.draft.country = 'domestic'; m.state.changeCountry(); await flush();
    m.state.chooseProvince(10); await flush(); m.state.chooseProvince(20); await flush(); b.resolve([{ id: 21, name: '南京' }]); await flush(); a.resolve([{ id: 11, name: '杭州' }]); await flush();
    assert.deepEqual(m.state.cities.map(item => item.name), ['南京']); m.state.chooseCity(21); await button(m, '搜索');
    assert.equal(listCalls(m).at(-1).params.province, '江苏'); assert.equal(listCalls(m).at(-1).params.city, '南京');
    m.state.draft.country = 'abroad'; m.state.changeCountry(); assert.equal(m.state.draft.province, ''); assert.equal(m.state.draft.city, '');
  } finally { m.unmount(); }
});

test('actual paged tag picker keeps first-page selection when choosing a later page and emits all IDs', async () => {
  const applied = []; const m = await create({}, pickerFile, { modelValue: true, kind: 'labels', initial: [{ id: 1, name: '选项1' }], onApply: value => applied.push(copy(value)) });
  try { assert.equal(m.state.count, 31); await m.state.load(2); await flush(); const next = m.state.rows[0]; assert.equal(next.id, 16); m.state.choose(next); m.state.apply();
    assert.deepEqual(applied[0].map(item => item.id), [1, 16]); assert.equal(m.calls.at(-1).params.page, 2);
  } finally { m.unmount(); }
});

test('unavailable selected tag stays visible and blocks apply until explicitly removed', async () => {
  const applied = []; const m = await create({}, pickerFile, { modelValue: true, kind: 'labels', initial: [{ id: 99, name: '旧标签' }], onApply: value => applied.push(copy(value)) });
  try { assert.deepEqual(m.state.selected.map(item => item.id), [99]); assert.deepEqual(m.state.missing, [99]); assert.ok(text(m.tree).includes('已不可用'));
    m.state.apply(); assert.equal(applied.length, 0); m.state.remove(99); m.state.apply(); assert.deepEqual(applied, [[]]);
  } finally { m.unmount(); }
});

test('picker retained choose and apply reject revoked persistent user.view permission', async () => {
  const applied = []; const m = await create({}, pickerFile, { modelValue: true, kind: 'groups', initial: [], onApply: value => applied.push(copy(value)) });
  try { const item = m.state.rows[0]; m.l.storage.set('admin_session', JSON.stringify({ userInfo: copy(m.actor.userInfo), menus: [], uniqueAuth: [] })); m.state.choose(item); m.state.chooseUngrouped(); m.state.apply(); assert.deepEqual(m.state.selected, []); assert.deepEqual(applied, []); } finally { m.unmount(); }
});

test('real API receipt parser rejects missing counts/duplicate users and strips extra fields; unnamed catalog rows retain IDs', async () => {
  const m = await create(); try {
    const api = m.l.load(path.join(root, 'api/userDirectory.ts'));
    const parsed = api.parseUserDirectoryPage({ list: [{ ...row(1), pwd: 'private' }], count: 1, page: 1, limit: 15 }); assert.equal(parsed.list[0].pwd, undefined);
    assert.throws(() => api.parseUserDirectoryPage({ list: [row(1)], page: 1, limit: 15 }));
    assert.throws(() => api.parseUserDirectoryPage({ list: [row(1), row(1)], count: 2, page: 1, limit: 15 }));
    const unnamed = api.parseUserFilterOptionPage({ list: [{ id: 1, name: '' }], count: 1, page: 1, limit: 15, selected: [], missing_ids: [] }); assert.deepEqual(unnamed.list, [{ id: 1, name: '未命名 #1' }]);
  } finally { m.unmount(); }
});

test('failed source change stays on requested page1 and retry uses the same source and applied criteria', async () => {
  let fail = true; const m = await create({ get: (entry, normal) => { if (entry.url === '/user/list' && entry.params.user_type === 'h5' && fail) throw Error('temporary read'); return normal(); } });
  try { await m.state.load(2); await flush(); m.state.changeSource('h5'); await flush(); assert.equal(m.state.page, 1); assert.equal(m.state.error, 'temporary read');
    fail = false; await m.state.load(m.state.page); await flush(); assert.equal(listCalls(m).at(-1).params.page, 1); assert.equal(listCalls(m).at(-1).params.user_type, 'h5'); assert.equal(m.state.error, '');
  } finally { m.unmount(); }
});

test('historical dates and leading-zero UID use the same valid bounded contract as the backend', async () => {
  const m = await create(); try { Object.assign(m.state.draft, { field_key: 'uid', nickname: '00011', dates: ['1969/12/01', '1970/01/01'], user_time_type: 'visit' }); await button(m, '搜索');
    assert.equal(listCalls(m).at(-1).params.nickname, '00011'); assert.equal(listCalls(m).at(-1).params.user_time, '1969/12/01-1970/01/01'); assert.equal(m.state.validationError, '');
  } finally { m.unmount(); }
});

test('actual clear event restores an empty enum after Element emits undefined, while explicit zero was sent earlier', async () => {
  const m = await create(); try {
    m.state.expanded = true; await flush(); m.state.draft.sex = '0'; await button(m, '搜索'); assert.equal(listCalls(m).at(-1).params.sex, '0');
    const select = all(m.tree, node => node.props['aria-label'] === '性别')[0]; assert.ok(select); select.props['onUpdate:modelValue'](undefined); select.props.onClear(); await button(m, '搜索'); assert.equal(listCalls(m).at(-1).params.sex, undefined); assert.equal(m.state.validationError, '');
  } finally { m.unmount(); }
});

test('late option page from an old catalog cannot overwrite the newly opened catalog', async () => {
  const delayed = deferred(), props = vue.reactive({ modelValue: true, kind: 'labels', initial: [] });
  const m = await create({ get: (entry, normal) => entry.params.kind === 'labels' ? delayed.promise : normal() }, pickerFile, props);
  try { const old = m.calls.at(-1); props.kind = 'groups'; await flush(); assert.equal(old.signal.aborted, true); assert.equal(m.state.rows[0].name, '选项1');
    delayed.resolve({ list: [{ id: 999, name: 'old tag' }], count: 1, page: 1, limit: 15, selected: [], missing_ids: [] }); await flush(); assert.equal(m.state.rows[0].name, '选项1'); assert.equal(m.state.count, 31); assert.equal(m.state.loading, false);
  } finally { m.unmount(); }
});
