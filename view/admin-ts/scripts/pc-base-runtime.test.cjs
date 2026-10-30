const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./helpers/bargain-records-runtime.cjs');
const { tick, copy, deferred, all, text, buttons, byLabel, replay, click, update } = H;
const BASE = '/config/pc', PREFIX = 'cinashop_pc_base_pending_v1_';
const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
const KEYS = ['pc_logo','bast_number','first_number','product_phone_buy_url','contact_number','company_address','copyright','seo_title','site_keywords','site_description','links_open','links_list','filing_list'];
const values = () => ({ pc_logo: 'http://images.example.test/logo.png', bast_number: 151, first_number: 101, product_phone_buy_url: 2,
  contact_number: '4001234567', company_address: '  原始地址  ', copyright: '版权原值', seo_title: '历史标题', site_keywords: '关键词', site_description: '第一行\n第二行', links_open: 1,
  links_list: [{ name: '第一条', url: 'http://example.test/a', sort: 0.5 }, { name: '第二条', url: '/b', sort: 2 }],
  filing_list: [{ icon: 'http://images.example.test/filing.png', name: '', url: '', sort: 0.25 }] });
const jwt = (actor = 7, exp = Math.floor(Date.now() / 1000) + 3600) => 'header.' + Buffer.from(JSON.stringify({ exp, jti: { id: actor, type: 'admin' } })).toString('base64url') + '.controlled-signature';
const ticket = (source, exp = Math.floor(Date.now() / 1000) + 120) => source + '?expires=' + exp + '&signature=' + 'a'.repeat(43);
const publicPreviews = data => Object.fromEntries([['pc_logo', data.pc_logo], ...(data.filing_list ?? []).map((row, i) => ['filing_list.' + i + '.icon', row.icon])]
  .filter(([, value]) => typeof value === 'string').map(([slot, value]) => [slot, /^\/api\/assets\//u.test(value) ? ticket(value) : value]));
function snapshot(patch = {}) { const settings = { ...values(), ...patch.settings }, fields = { ...Object.fromEntries(KEYS.map(key => [key, { present: true, parseable: true, redacted: false }])), ...patch.fields };
  return { revision: 'a'.repeat(64), runtime_ready: true, issues: [], ...patch, settings, fields, asset_previews: patch.asset_previews ?? publicPreviews(settings) }; }
const pending = (id = ID, actor = 7) => ({ version: 1, domain: 'pc_base', actor_id: actor, request_id: id });
const key = (id = ID, actor = 7) => PREFIX + actor + '_' + id;
const receipt = (id = ID, actor = 7, patch = {}) => ({ request_id: id, actor_id: actor, state: 'committed', revision: 'b'.repeat(64), created_at: 1793100000, replayed: false, cache_status: 'cleared', ...patch });
const envelope = data => ({ data }), failure = (status, msg) => ({ httpStatus: status, status, msg, data: null });
const journal = r => [...r.storage].filter(([name]) => name.startsWith(PREFIX));
const saves = r => r.calls.filter(call => call.method === 'POST' && call.url === BASE);
const reads = r => r.calls.filter(call => call.method === 'GET' && call.url === BASE);
const seals = r => r.calls.filter(call => call.method === 'POST' && call.url.endsWith('/resolve'));
const capture = (r, label) => { const node = buttons(r, label)[0]; assert.ok(node, 'actual native button ' + label); return node.props.onClick; };
const labelledButton = (r, label) => { const node = all(r.tree, n => n.tag === 'button' && n.props['aria-label'] === label)[0]; assert.ok(node, 'actual row button ' + label); return node; };
async function rowClick(r, label) { const node = labelledButton(r, label); assert.equal(!!node.props.disabled, false); replay(node.props.onClick, {}); await tick(); }
function runtime(options = {}) {
  let r;
  const server = { snapshot: snapshot(options.snapshot), records: new Map(), serial: 10 }, confirmations = [];
  function answer(call, fallback) {
    if (call.url === '/login') return fallback();
    if (call.method === 'GET' && call.url === BASE) return envelope(copy(server.snapshot));
    if (call.method === 'POST' && call.url === BASE) {
      const body = call.body;
      if (server.records.has(body.request_id)) return envelope(copy(server.records.get(body.request_id)));
      const result = receipt(body.request_id, r.auth.userInfo.id); server.records.set(body.request_id, result);
      for (const key of KEYS) if (body.fields[key].action === 'replace') { server.snapshot.settings[key] = copy(body.fields[key].value); server.snapshot.fields[key] = { present: true, parseable: true, redacted: false }; }
      server.snapshot.revision = (++server.serial).toString(16).padStart(64, '0'); server.snapshot.asset_previews = publicPreviews(server.snapshot.settings);
      return envelope(copy(result));
    }
    if (call.method === 'GET' && call.url.startsWith(BASE + '/operations/')) { const row = server.records.get(call.url.split('/').at(-1)); return row ? envelope(copy(row)) : { status: 404, msg: 'PC配置回执不存在', data: null }; }
    if (call.method === 'POST' && call.url.endsWith('/resolve')) { const id = call.url.split('/').at(-2); assert.deepEqual(call.body, { confirmed: true });
      if (!server.records.has(id)) server.records.set(id, receipt(id, r.auth.userInfo.id, { state: 'not_applied', cache_status: 'not_required' })); return envelope(copy(server.records.get(id))); }
    throw Error('Unexpected PC controlled transport ' + call.method + ' ' + call.url);
  }
  r = H.runtime({ page: 'pages/settings/PcBaseAuthor.vue', permissions: options.permissions ?? ['pc_base.view','pc_base.manage'],
    send(call, fallback) { if (typeof call.body === 'string') { call.rawBody = call.body; call.body = JSON.parse(call.body); } const next = () => answer(call, fallback); return options.send ? options.send(call, next, r) : next(); } });
  r.route.fullPath = '/config/pc'; r.window.location.pathname = '/config/pc';
  r.window.confirm = message => { confirmations.push(String(message)); return options.confirm ? options.confirm(message, r) : true; };
  r.sync({ token: options.token ?? jwt() });
  for (const row of options.pending ?? []) r.storage.set(key(row.request_id, row.actor_id), JSON.stringify(row));
  if (options.stored !== undefined) r.storage.set(key(), typeof options.stored === 'string' ? options.stored : JSON.stringify(options.stored));
  return Object.assign(r, { server, confirmations, journal: () => journal(r), saves: () => saves(r), api: () => r.load(path.join(H.root, 'api/pcBase.ts')) });
}
function scenario(name, fn) { test(name, async () => { const mounted = [], mount = async options => { const r = runtime(options); mounted.push(r); await tick(); return r; };
  try { await fn(mount); } finally { for (const r of mounted) await r.finish(); } }); }
const save = r => click(r, '确认并保存配置');
async function unknown(mount, committed = false, patch = {}) { return mount({ ...patch, send(call, next, r) { if (call.method === 'POST' && call.url === BASE) { if (committed) next(); throw Error('Network Error'); } return patch.send ? patch.send(call, next, r) : next(); } }); }

scenario('complete thirteen fields default to keep and preserve safe HTTP without unrelated requests', async mount => {
  const r = await mount(); assert.ok(byLabel(r, 'PC端LOGO')); assert.equal(byLabel(r, '精品推荐个数').props.value, '151'); assert.equal(byLabel(r, '首发新品个数').props.value, '101');
  assert.ok(byLabel(r, '历史SEO标题（仅存储）')); assert.ok(byLabel(r, '网站描述')); assert.ok(byLabel(r, '底部图标1'));
  await save(r); assert.deepEqual(Object.keys(saves(r)[0].body.fields), KEYS); for (const field of Object.values(saves(r)[0].body.fields)) assert.deepEqual(field, { action: 'keep' });
  assert.ok(r.calls.every(call => call.url === BASE)); assert.equal(journal(r).length, 0);
});
scenario('one scalar edit replaces only that key while missing and redacted historical fields remain keep', async mount => {
  const r = await mount({ snapshot: { settings: { pc_logo: null, company_address: null, first_number: null }, fields: { pc_logo: { present: true, parseable: true, redacted: true }, company_address: { present: true, parseable: false, redacted: true }, first_number: { present: false, parseable: false, redacted: false } } } });
  assert.equal(byLabel(r, 'PC端LOGO').props.value, ''); await update(r, '版权信息', '仅替换版权'); await save(r);
  const fields = saves(r)[0].body.fields; assert.deepEqual(fields.copyright, { action: 'replace', value: '仅替换版权' }); for (const key of KEYS.filter(key => key !== 'copyright')) assert.deepEqual(fields[key], { action: 'keep' });
});
scenario('returning to keep discards edited field material and accepts legitimate fast native typing', async mount => {
  const r = await mount(), field = byLabel(r, '公司地址'), listener = field.props.onInput, staleSave = capture(r, '确认并保存配置');
  for (const value of ['新', '新地', '新地址']) replay(listener, { target: { value } }); await tick(); assert.equal(byLabel(r, '公司地址').props.value, '新地址');
  replay(staleSave, {}); await tick(); assert.equal(saves(r).length, 0); await update(r, '公司地址处理方式', 'keep'); assert.equal(byLabel(r, '公司地址').props.value, '  原始地址  ');
  await save(r); assert.deepEqual(saves(r)[0].body.fields.company_address, { action: 'keep' }); assert.ok(!saves(r)[0].rawBody.includes('新地址'));
});
scenario('counts above100 and decimal table sorting normalize without clamping or reordering authored rows', async mount => {
  const r = await mount(); await update(r, '精品推荐个数', '251'); await update(r, '首发新品个数', '101'); await update(r, '友情链接排序1', '2.75'); await save(r);
  assert.deepEqual(saves(r)[0].body.fields.bast_number, { action: 'replace', value: 251 }); assert.equal(saves(r)[0].body.fields.first_number.value, 101); assert.equal(saves(r)[0].body.fields.links_list.value[0].sort, 2.75); assert.equal(saves(r)[0].body.fields.links_list.value[0].name, '第一条');
});
scenario('links add edit move and delete through real native listeners without leaking editor row IDs', async mount => {
  const r = await mount(); await click(r, '添加友情链接'); await update(r, '友情链接名称3', '新链接'); await update(r, '友情链接地址3', 'http://example.test/new'); await update(r, '友情链接排序3', '0.125');
  await rowClick(r, '上移友情链接3'); await rowClick(r, '删除友情链接1'); await save(r);
  const rows = saves(r)[0].body.fields.links_list.value; assert.deepEqual(rows.map(row => row.name), ['新链接', '第二条']); assert.equal(rows[0].sort, 0.125); assert.deepEqual(Object.keys(rows[0]), ['name','url','sort']);
});
scenario('filing supports optional empty fields and canonical author references separate from preview tickets', async mount => {
  const r = await mount({ snapshot: { settings: { pc_logo: '/api/assets/42' } } }); assert.equal(byLabel(r, 'PC端LOGO').props.value, '/api/assets/42');
  assert.ok(all(r.tree, node => node.tag === 'img').some(node => node.props.src.startsWith('/api/assets/42?')));
  await click(r, '添加底部项目'); await update(r, '底部图标2', '/api/assets/43'); await update(r, '底部排序2', '0.5'); await rowClick(r, '上移底部项目2'); await save(r);
  const rows = saves(r)[0].body.fields.filing_list.value; assert.deepEqual(rows[0], { icon: '/api/assets/43', name: '', url: '', sort: 0.5 });
  assert.deepEqual(saves(r)[0].body.fields.pc_logo, { action: 'keep' }); assert.ok(!saves(r)[0].rawBody.includes('signature=')); assert.ok(!JSON.stringify(r.writes.filter(row => row.key.startsWith(PREFIX))).includes('signature='));
});
scenario('safe HTTP replacement remains exact and signed-ticket input is rejected before persistence or dispatch', async mount => {
  const r = await mount(); await update(r, 'PC端LOGO', 'http://images.example.test/new.png'); await save(r); assert.equal(saves(r)[0].body.fields.pc_logo.value, 'http://images.example.test/new.png');
  await update(r, 'PC端LOGO', ticket('/api/assets/42')); await save(r); assert.equal(saves(r).length, 1); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /签名|素材/);
});
scenario('invalid count empty SEO and unsafe link are rejected before UUID persistence', async mount => {
  for (const [label, value] of [['精品推荐个数','0'], ['历史SEO标题（仅存储）',''], ['友情链接地址1','javascript:alert(1)']]) { const r = await mount(); await update(r, label, value); await save(r); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0); }
});
scenario('row deletion and keep replace ABA retire captured input handlers', async mount => {
  const r = await mount(), old = byLabel(r, '友情链接名称1').props.onInput;
  await rowClick(r, '删除友情链接1'); replay(old, { target: { value: '迟到旧行' } }); await tick(); assert.equal(byLabel(r, '友情链接名称1').props.value, '第二条');
  const oldScalar = byLabel(r, '公司地址').props.onInput; await update(r, '公司地址处理方式', 'replace'); await update(r, '公司地址处理方式', 'keep'); await update(r, '公司地址处理方式', 'replace');
  replay(oldScalar, { target: { value: '旧ABA' } }); await tick(); assert.equal(byLabel(r, '公司地址').props.value, '  原始地址  ');
});
scenario('no view readonly and unready environments cannot dispatch a copied save callback', async mount => {
  const none = await mount({ permissions: [] }); assert.equal(reads(none).length, 0);
  const read = await mount({ permissions: ['pc_base.view'] }); replay(capture(read, '确认并保存配置'), {}); replay(byLabel(read, '版权信息').props.onInput, { target: { value: '禁止' } }); await tick(); assert.equal(saves(read).length, 0);
  const unready = await mount({ snapshot: { runtime_ready: false } }); replay(capture(unready, '确认并保存配置'), {}); await tick(); assert.equal(saves(unready).length, 0);
});
scenario('cancelled and edit-invalidated confirmations never persist or dispatch', async mount => {
  const cancelled = await mount({ confirm: () => false }); await save(cancelled); assert.equal(journal(cancelled).length, 0); assert.equal(saves(cancelled).length, 0);
  const changed = await mount({ confirm(_message, r) { replay(byLabel(r, '版权信息').props.onInput, { target: { value: '确认期间变更' } }); return true; } }); await save(changed); assert.equal(journal(changed).length, 0); assert.equal(saves(changed).length, 0);
});
scenario('unknown save keeps only domain actor UUID and does not resend on reload or404 receipt', async mount => {
  const r = await unknown(mount); await update(r, '版权信息', 'PRIVATE_DRAFT_VALUE'); await save(r); assert.equal(saves(r).length, 1); assert.equal(journal(r).length, 1);
  const stored = JSON.parse(journal(r)[0][1]); assert.deepEqual(Object.keys(stored).sort(), ['actor_id','domain','request_id','version']); assert.equal(stored.domain, 'pc_base'); assert.ok(!JSON.stringify(journal(r)).includes('PRIVATE_DRAFT_VALUE')); assert.ok(!JSON.stringify(journal(r)).includes('revision'));
  await click(r, '读取保存回执'); assert.equal(journal(r).length, 1); assert.match(text(r.tree), /没有回执不代表未保存/); await click(r, '重新读取'); assert.equal(saves(r).length, 1); assert.equal(buttons(r, '确认并保存配置')[0].props.disabled, true);
});
scenario('explicit owner sealing resolves absent UUID and late acknowledgement resolves committed UUID without resending', async mount => {
  const missing = await unknown(mount); await save(missing); await click(missing, '核对并封存未受理请求'); assert.equal(journal(missing).length, 0); assert.equal(seals(missing).length, 1); assert.equal(saves(missing).length, 1);
  const committed = await unknown(mount, true); await save(committed); await click(committed, '读取保存回执'); assert.equal(journal(committed).length, 0); assert.equal(saves(committed).length, 1); assert.match(text(committed.tree), /PC配置已保存/);
});
scenario('lost domain grants retain only owner recovery and never issue a configuration read', async mount => {
  const r = await mount({ pending: [pending()] }), before = reads(r).length; r.sync({ uniqueAuth: [] }); await tick(); assert.equal(reads(r).length, before);
  await click(r, '核对并封存未受理请求'); assert.equal(seals(r).length, 1); assert.equal(journal(r).length, 0); assert.equal(reads(r).length, before);
});
scenario('owner and route ABA plus same-value session events retire old native callbacks', async mount => {
  const r = await mount(), old = capture(r, '确认并保存配置'), original = copy(r.auth.userInfo), token = r.auth.token;
  r.route.fullPath = '/config/pc?q=1'; await tick(); r.route.fullPath = '/config/pc'; await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
  const identity = capture(r, '确认并保存配置'); r.sync({ userInfo: { ...original, id: 8 }, token: jwt(8) }); await tick(); r.sync({ userInfo: original, token }); await tick(); replay(identity, {}); await tick(); assert.equal(saves(r).length, 0);
  const same = capture(r, '确认并保存配置'); r.sync({}, 'storage'); await tick(); replay(same, {}); await tick(); assert.equal(saves(r).length, 0);
});
scenario('leaving the PC route aborts IO and never activates a fresh request for another page', async mount => {
  const r = await mount(), old = capture(r, '确认并保存配置'), before = r.calls.length;
  r.route.fullPath = '/orders'; await tick(); replay(old, {}); await tick(); assert.equal(r.calls.length, before);
  r.route.fullPath = '/config/pc'; await tick(); assert.equal(reads(r).length, 2); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
});
scenario('actual unmount retires old handlers and remount restores unknown identifier without a draft', async mount => {
  const r = await unknown(mount); await update(r, '版权信息', '不持久化草稿'); await save(r); const before = journal(r), old = capture(r, '读取保存回执');
  r.visible.value = false; await tick(); replay(old, {}); await tick(); r.visible.value = true; await tick(); replay(old, {}); await tick(); assert.deepEqual(journal(r), before); assert.equal(saves(r).length, 1); assert.equal(byLabel(r, '版权信息').props.value, '版权原值');
});
scenario('late committed save response after account switch cannot clear original owner journal', async mount => {
  const hold = deferred(); const r = await mount({ send(call, next) { if (call.method === 'POST' && call.url === BASE) { hold.result = next(); return hold.promise; } return next(); } });
  await save(r); const original = journal(r)[0][0]; r.sync({ userInfo: { ...r.auth.userInfo, id: 8 }, token: jwt(8) }); await tick(); hold.resolve(hold.result); await tick(); assert.ok(r.storage.has(original)); assert.ok(!text(r.tree).includes('PC配置已保存。'));
});
scenario('late snapshot rejection cannot overwrite a replacement route generation', async mount => {
  const hold = deferred(); let n = 0; const r = await mount({ send(call, next) { if (call.method === 'GET' && call.url === BASE && ++n === 2) return hold.promise; return next(); } });
  await click(r, '重新读取'); r.route.fullPath = '/config/pc?new=1'; await tick(); hold.reject(Error('旧读取错误')); await tick(); assert.ok(!text(r.tree).includes('旧读取错误')); assert.equal(r.bindings.loading, false);
});
scenario('forged receipt identity and malformed local journal remain unknown and never expose raw material', async mount => {
  const r = await mount({ pending: [pending()], send(call, next) { return call.method === 'GET' && call.url.includes('/operations/') ? envelope(receipt(ID, 99)) : next(); } });
  await click(r, '读取保存回执'); assert.equal(journal(r).length, 1);
  const corrupt = await mount({ stored: { ...pending(), raw: 'PRIVATE_OLD_RAW' } }); assert.equal(saves(corrupt).length, 0); assert.ok(corrupt.storage.has(key())); assert.ok(!text(corrupt.tree).includes('PRIVATE_OLD_RAW')); assert.match(text(corrupt.tree), /标识身份无效/);
});
scenario('journal persistence failure and a same-session event during confirm cannot dispatch', async mount => {
  const r = await mount(), original = r.storage.set.bind(r.storage); r.storage.set = (name, value) => { if (name.startsWith(PREFIX)) throw Error('storage unavailable'); return original(name, value); };
  await save(r); assert.equal(saves(r).length, 0);
  const changed = await mount({ confirm(_message, host) { host.sync({}, 'storage'); return true; } }); await save(changed); assert.equal(saves(changed).length, 0); assert.equal(journal(changed).length, 0);
});
scenario('same-value session replacement during journal persistence retains the pointer but dispatches no HTTP save', async mount => {
  const r = await mount(), original = r.storage.set.bind(r.storage); let changed = false;
  r.storage.set = (name, value) => { const result = original(name, value); if (name.startsWith(PREFIX) && !changed) { changed = true; r.sync({}, 'storage'); } return result; };
  await save(r); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 1);
});
scenario('multiple owner UUID selection ABA only resolves the current selected record', async mount => {
  const r = await mount({ pending: [pending(ID), pending(ID2)] }), old = capture(r, '核对并封存未受理请求'); await click(r, ID2); await click(r, ID); replay(old, {}); await tick(); assert.equal(seals(r).length, 0);
  await click(r, '核对并封存未受理请求'); assert.equal(journal(r).length, 1); assert.equal(journal(r)[0][0], key(ID2));
});
scenario('expired and mismatched JWT subjects have no lease and token TTL retires already captured callbacks', async mount => {
  const expired = await mount({ token: jwt(7, Math.floor(Date.now() / 1000) - 1) }); assert.equal(reads(expired).length, 0);
  const wrong = await mount({ token: jwt(8) }); assert.equal(reads(wrong).length, 0);
  const r = await mount(); r.sync({ token: jwt(7, Math.floor(Date.now() / 1000) + 2) }); await tick(); const old = capture(r, '确认并保存配置'); await new Promise(resolve => setTimeout(resolve, 2100)); await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0); assert.equal(byLabel(r, '版权信息'), undefined);
});
scenario('preview ticket expiry hides display without changing canonical author field or persisting ticket bytes', async mount => {
  const source = '/api/assets/42', r = await mount(), preview = ticket(source, Math.floor(Date.now() / 1000) + 2);
  r.server.snapshot.settings.pc_logo = source; r.server.snapshot.asset_previews.pc_logo = preview; await click(r, '重新读取');
  assert.ok(all(r.tree, n => n.tag === 'img').some(n => n.props.src === preview)); assert.equal(byLabel(r, 'PC端LOGO').props.value, source); await new Promise(resolve => setTimeout(resolve, 2100)); await tick(); assert.ok(!all(r.tree, n => n.tag === 'img').some(n => n.props.src === preview)); assert.equal(byLabel(r, 'PC端LOGO').props.value, source); assert.ok(!JSON.stringify(r.writes).includes('signature='));
});
scenario('actual API rejects raw projections extra Open keys and preview tickets bound to another canonical source', async mount => {
  const r = await mount(), api = r.api(); assert.throws(() => api.checkedPcBaseSnapshot({ ...snapshot(), raw_public_values: { pc_logo: 'PRIVATE' } }));
  assert.throws(() => api.checkedPcBaseSnapshot(snapshot({ settings: { wechat_open_app_secret: 'PRIVATE' } })));
  assert.throws(() => api.checkedPcBaseSnapshot(snapshot({ settings: { pc_logo: ticket('/api/assets/42') } })));
  assert.throws(() => api.checkedPcBaseSnapshot(snapshot({ settings: { pc_logo: '/api/assets/42' }, asset_previews: { pc_logo: ticket('/api/assets/43') } })));
  assert.throws(() => api.checkedPcBaseSnapshot(snapshot({ fields: { copyright: { present: true, parseable: true, redacted: true } } })));
});

const galleryAnswer = call => {
  if (call.url === BASE + '/attachment-categories') return envelope({ list: [{ id: 9, pid: 0, name: 'PC品牌' }] });
  if (call.url === BASE + '/attachment-options') {
    const query = call.params ?? {}, page = Number(query.page ?? 1), pid = Number(query.pid ?? 0), id = page === 1 ? 42 : 43;
    return envelope({ list: [{ att_id: id, pid, real_name: 'PC图片' + id, reference: '/api/assets/' + id, preview: ticket('/api/assets/' + id) }], count: 1, page, limit: 20 });
  }
};
scenario('PC scoped picker writes only the selected stable logo reference and never persists its preview ticket', async mount => {
  const r = await mount({ send(call, next) { return galleryAnswer(call) ?? next(); } });
  await click(r, '从图库选择PC端LOGO'); await click(r, 'PC图片42'); assert.equal(byLabel(r, 'PC端LOGO').props.value, '/api/assets/42');
  assert.ok(all(r.tree, n => n.tag === 'img').some(n => n.props.src.startsWith('/api/assets/42?')));
  await save(r); assert.deepEqual(saves(r)[0].body.fields.pc_logo, { action: 'replace', value: '/api/assets/42' });
  assert.ok(!saves(r)[0].rawBody.includes('signature=')); assert.ok(r.calls.every(c => c.url.startsWith(BASE)));
});
scenario('filing picker identity is tied to its exact row and a detached selection cannot target a replacement row', async mount => {
  const r = await mount({ send(call, next) { return galleryAnswer(call) ?? next(); } });
  await rowClick(r, '选择底部图标1'); const old = capture(r, 'PC图片42'); await rowClick(r, '删除底部项目1');
  await click(r, '添加底部项目'); replay(old, {}); await tick(); assert.equal(byLabel(r, '底部图标1').props.value, '');
  await rowClick(r, '选择底部图标1'); await click(r, 'PC图片42'); await save(r);
  assert.equal(saves(r)[0].body.fields.filing_list.value[0].icon, '/api/assets/42'); assert.ok(!saves(r)[0].rawBody.includes('signature='));
});
scenario('late picker IO and captured image selection cannot cross a same-value session event', async mount => {
  const hold = deferred(); const r = await mount({ send(call, next) { if (call.url.endsWith('/attachment-options')) return hold.promise; return galleryAnswer(call) ?? next(); } });
  await click(r, '从图库选择PC端LOGO'); r.sync({}, 'storage'); await tick();
  hold.resolve(galleryAnswer({ url: BASE + '/attachment-options', params: { page: 1, pid: 0 } })); await tick();
  assert.equal(buttons(r, 'PC图片42').length, 0); assert.equal(byLabel(r, 'PC端LOGO').props.value, values().pc_logo); assert.equal(saves(r).length, 0);
});
scenario('picker refuses mismatched canonical preview identity and a view-only actor cannot open it', async mount => {
  const r = await mount({ send(call, next) { if (call.url.endsWith('/attachment-options')) { const result = galleryAnswer(call); result.data.list[0].preview = ticket('/api/assets/99'); return result; } return galleryAnswer(call) ?? next(); } });
  await click(r, '从图库选择PC端LOGO'); assert.match(text(r.tree), /图库读取失败/); assert.equal(buttons(r, 'PC图片42').length, 0);
  const readonly = await mount({ permissions: ['pc_base.view'] }); replay(capture(readonly, '从图库选择PC端LOGO'), {}); await tick(); assert.equal(readonly.calls.filter(c => c.url.includes('/attachment-')).length, 0);
});
