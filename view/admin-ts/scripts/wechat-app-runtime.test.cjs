const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./helpers/bargain-records-runtime.cjs');
const { tick, copy, deferred, all, text, buttons, byLabel, replay, click, update } = H;

const BASE = '/wechat/app', PREFIX = 'cinashop_wechat_app_pending_v1_';
const ID = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';
const APP = 'native optional AppID', REVISION = 'a'.repeat(64);
const pending = (id = ID, actor = 7) => ({ version: 1, domain: 'wechat_app', actor_id: actor, request_id: id });
const key = (id = ID, actor = 7) => PREFIX + actor + '_' + id;
const snapshot = (patch = {}) => ({ settings: { wechat_app_appid: APP },
  fields: { wechat_app_appid: { present: true, parseable: true }, wechat_app_appsecret: { present: true, parseable: true } },
  secrets: { wechat_app_appsecret: { present: true } }, revision: REVISION, runtime_ready: true,
  credentials_complete: true, issues: [], ...patch });
const receipt = (id = ID, patch = {}) => ({ request_id: id, actor_id: 7, state: 'committed', revision: 'b'.repeat(64),
  created_at: 1793100000, replayed: false, cache_status: 'cleared', ...patch });
const envelope = data => ({ data }), failure = (httpStatus, msg) => ({ httpStatus, status: httpStatus, msg, data: null });
const capture = (r, label) => { const node = buttons(r, label)[0]; assert.ok(node, 'actual native button ' + label); return node.props.onClick; };
const journal = r => [...r.storage].filter(([name]) => name.startsWith(PREFIX));
const saves = r => r.calls.filter(call => call.method === 'POST' && call.url === BASE);
const reads = r => r.calls.filter(call => call.method === 'GET' && call.url === BASE);
const receipts = r => r.calls.filter(call => call.method === 'GET' && call.url.startsWith(BASE + '/operations/'));
const seals = r => r.calls.filter(call => call.method === 'POST' && call.url.startsWith(BASE + '/operations/') && call.url.endsWith('/resolve'));

/** The accepted host compiles the actual SFC/common/API/session modules and
 * runs real Vue, Pinia and Axios. Only HTTP responses and browser storage are
 * controlled here; this suite does not claim SQL, provider or native SDK proof. */
function runtime(options = {}) {
  let r;
  const state = { snapshot: snapshot(options.snapshot), records: new Map(), nextRevision: 10 }, confirmations = [];
  function answer(call, fallback) {
    if (call.url === '/login') return fallback();
    if (call.method === 'GET' && call.url === BASE) return envelope(copy(state.snapshot));
    if (call.method === 'POST' && call.url === BASE) {
      const body = call.body;
      assert.deepEqual(Object.keys(body).sort(), ['confirmed', 'fields', 'request_id', 'revision']);
      assert.deepEqual(Object.keys(body.fields).sort(), ['wechat_app_appid', 'wechat_app_appsecret']);
      assert.equal(body.confirmed, true);
      if (state.records.has(body.request_id)) return envelope(copy(state.records.get(body.request_id)));
      assert.equal(body.revision, state.snapshot.revision);
      for (const name of ['wechat_app_appid', 'wechat_app_appsecret']) {
        const intent = body.fields[name];
        if (intent.action === 'keep') continue;
        state.snapshot.fields[name] = { present: true, parseable: true };
        if (name === 'wechat_app_appid') state.snapshot.settings.wechat_app_appid = intent.value;
        else state.snapshot.secrets.wechat_app_appsecret.present = intent.action === 'replace';
      }
      state.snapshot.credentials_complete = !!state.snapshot.settings.wechat_app_appid && state.snapshot.secrets.wechat_app_appsecret.present;
      state.snapshot.issues = state.snapshot.issues.filter(issue => !state.snapshot.fields[issue.key].parseable);
      state.snapshot.revision = (++state.nextRevision).toString(16).padStart(64, '0');
      const result = receipt(body.request_id, { actor_id: r.auth.userInfo.id, revision: state.snapshot.revision });
      state.records.set(body.request_id, result); return envelope(copy(result));
    }
    if (call.method === 'GET' && call.url.startsWith(BASE + '/operations/')) {
      const value = state.records.get(call.url.split('/').at(-1));
      return value ? envelope(copy(value)) : failure(404, '原生App配置回执不存在');
    }
    if (call.method === 'POST' && call.url.startsWith(BASE + '/operations/') && call.url.endsWith('/resolve')) {
      const id = call.url.split('/').at(-2); assert.deepEqual(call.body, { confirmed: true });
      if (!state.records.has(id)) state.records.set(id, receipt(id, { actor_id: r.auth.userInfo.id, state: 'not_applied', cache_status: 'not_required' }));
      return envelope(copy(state.records.get(id)));
    }
    throw Error('Unexpected Native App controlled transport ' + call.method + ' ' + call.url);
  }
  r = H.runtime({ page: 'pages/content/WechatAppAuthor.vue', permissions: options.permissions ?? ['wechat_app.view', 'wechat_app.manage'],
    send(call, fallback) {
      if (typeof call.body === 'string') { call.rawBody = call.body; call.body = JSON.parse(call.body); }
      const next = () => answer(call, fallback); return options.send ? options.send(call, next, r) : next();
    } });
  r.route.fullPath = '/content/wechat-app'; r.window.location.pathname = '/content/wechat-app';
  r.window.confirm = value => { confirmations.push(String(value)); return options.confirm ? options.confirm(value, r) : true; };
  for (const row of options.pending ?? []) r.storage.set(key(row.request_id, row.actor_id), JSON.stringify(row));
  if (options.stored !== undefined) r.storage.set(key(), typeof options.stored === 'string' ? options.stored : JSON.stringify(options.stored));
  return Object.assign(r, { server: state, confirmations,
    api: () => r.load(path.join(H.root, 'api/wechatApp.ts')),
    common: () => r.load(path.join(H.repository, 'view/common/wechatApp.ts')) });
}
function scenario(name, run) {
  test(name, async () => {
    const mounted = [], mount = async options => { const r = runtime(options); mounted.push(r); await tick(); return r; };
    try { await run(mount); } finally { for (const r of mounted) await r.finish(); }
  });
}
const save = r => click(r, '确认并保存配置');
async function replace(r, label, value) { await update(r, label + '处理方式', 'replace'); await update(r, '新' + label, value); }
async function unknown(mount, committed, patch = {}) {
  return mount({ ...patch, send(call, next, r) {
    if (call.method === 'POST' && call.url === BASE) { if (committed) next(); throw Error('Network Error'); }
    return patch.send ? patch.send(call, next, r) : next();
  } });
}

scenario('renders only the optional App text author and posts two explicit keep intents', async mount => {
  const r = await mount();
  assert.ok(byLabel(r, 'AppID处理方式')); assert.ok(byLabel(r, 'AppSecret处理方式'));
  assert.equal(byLabel(r, '新AppID'), undefined); assert.equal(byLabel(r, '新AppSecret'), undefined);
  assert.match(text(r.tree), /填写状态不代表微信登录或支付已验证可用/);
  assert.equal(byLabel(r, '数据库凭据'), undefined); assert.ok(r.calls.every(call => call.url === BASE));
  await save(r);
  assert.deepEqual(saves(r)[0].body.fields, { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' } });
  assert.equal(journal(r).length, 0);
});

scenario('preserves empty AppID, long Unicode text and whitespace multiline replacements exactly', async mount => {
  const values = ['', '  optional id\nsecond line\r\n  ', '😀'.repeat(4998), 'native\0App'];
  for (const value of values) {
    const r = await mount(), secret = '  secret\nline\r\n  ';
    await replace(r, 'AppID', value); await replace(r, 'AppSecret', secret); await save(r);
    assert.deepEqual(saves(r)[0].body.fields, { wechat_app_appid: { action: 'replace', value },
      wechat_app_appsecret: { action: 'replace', value: secret } });
    assert.equal(r.server.snapshot.settings.wechat_app_appid, value);
    assert.ok(!JSON.stringify(r.writes).includes('secret\\nline'));
  }
});

scenario('enforces the shared 5000 serialized character boundary and refuses empty Secret replace before journaling', async mount => {
  for (const label of ['AppID', 'AppSecret']) {
    const r = await mount(); await replace(r, label, 'x'.repeat(4999)); await save(r);
    assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /5000字符容量/);
    await update(r, '新' + label, 'x'.repeat(4998)); await save(r);
    assert.equal(saves(r).length, 1); assert.equal(saves(r)[0].body.fields[label === 'AppID' ? 'wechat_app_appid' : 'wechat_app_appsecret'].value.length, 4998);
  }
  const r = await mount(); await update(r, 'AppSecret处理方式', 'replace'); await save(r);
  assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /须明确选择清空/);
  assert.equal(r.confirmations.length, 0);
});

scenario('switching typed replacements to keep drops both draft values while Secret clear remains explicit', async mount => {
  const r = await mount(); await replace(r, 'AppID', 'DROP_APP_DRAFT'); await replace(r, 'AppSecret', 'DROP_SECRET_DRAFT');
  await update(r, 'AppID处理方式', 'keep'); await update(r, 'AppSecret处理方式', 'keep'); await save(r);
  assert.deepEqual(saves(r)[0].body.fields, { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' } });
  assert.ok(!saves(r)[0].rawBody.includes('DROP_'));
  await update(r, 'AppSecret处理方式', 'clear'); await save(r);
  assert.deepEqual(saves(r)[1].body.fields.wechat_app_appsecret, { action: 'clear' });
  assert.equal(r.server.snapshot.secrets.wechat_app_appsecret.present, false);
});

scenario('missing and malformed imported values remain keep intents without projecting or repairing raw data', async mount => {
  for (const present of [false, true]) {
    const state = { present, parseable: false };
    const r = await mount({ snapshot: { settings: { wechat_app_appid: null },
      fields: { wechat_app_appid: state, wechat_app_appsecret: state },
      secrets: { wechat_app_appsecret: { present: false } }, credentials_complete: false,
      issues: [{ key: 'wechat_app_appid', message: '历史AppID无法解析，可保留' }, { key: 'wechat_app_appsecret', message: '历史密钥无法解析，可保留' }] } });
    assert.match(text(r.tree), /原值缺失或无法解析/); await save(r);
    assert.deepEqual(saves(r)[0].body.fields, { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' } });
    assert.equal(r.server.snapshot.settings.wechat_app_appid, null);
    assert.deepEqual(r.server.snapshot.fields.wechat_app_appid, state);
  }
});

scenario('strict snapshot parsing rejects Open fields, raw material and inconsistent public states through real HTTP', async mount => {
  for (const patch of [
    { raw_public_values: { wechat_app_appid: 'PRIVATE_RAW' } },
    { settings: { wechat_app_appid: APP, wechat_open_app_id: 'FOREIGN_OPEN' } },
    { secrets: { wechat_app_appsecret: { present: true, value: 'PRIVATE_SECRET_RESPONSE' } } },
    { credentials_complete: false },
    { fields: { wechat_app_appid: { present: false, parseable: true }, wechat_app_appsecret: { present: true, parseable: true } } },
    { issues: [{ key: 'wechat_open_app_id', message: 'FOREIGN_OPEN' }] },
  ]) {
    const r = await mount({ snapshot: patch }); assert.equal(reads(r).length, 1);
    assert.equal(byLabel(r, 'AppID处理方式'), undefined); assert.equal(saves(r).length, 0);
    assert.ok(!text(r.tree).includes('PRIVATE_')); assert.ok(!text(r.tree).includes('FOREIGN_OPEN'));
    assert.notEqual(r.bindings.error, '');
  }
});

scenario('no-view, read-only and unavailable-runtime admissions block actual and retained native write handlers', async mount => {
  const hidden = await mount({ permissions: [] }); assert.equal(hidden.calls.length, 0); assert.match(text(hidden.tree), /没有原生App配置查看权限/);
  const readonly = await mount({ permissions: ['wechat_app.view'] });
  for (const label of ['AppID处理方式', 'AppSecret处理方式']) {
    const node = byLabel(readonly, label); assert.equal(node.props.disabled, true); replay(node.props.onChange, { target: { value: 'replace' } });
  }
  replay(capture(readonly, '确认并保存配置'), {}); await tick(); assert.equal(saves(readonly).length, 0);
  assert.equal(byLabel(readonly, '新AppSecret'), undefined);
  const unavailable = await mount({ snapshot: { runtime_ready: false } });
  await replace(unavailable, 'AppID', 'new optional id'); replay(capture(unavailable, '确认并保存配置'), {}); await tick();
  assert.equal(saves(unavailable).length, 0); assert.equal(journal(unavailable).length, 0); assert.match(text(unavailable.tree), /暂不支持保存/);
});

scenario('fast input keeps one native node live while the earlier save and submit callbacks retire', async mount => {
  const r = await mount(); await update(r, 'AppID处理方式', 'replace');
  const node = byLabel(r, '新AppID'), input = node.props.onInput, oldSave = capture(r, '确认并保存配置');
  const oldSubmit = all(r.tree, n => n.tag === 'form')[0].props.onSubmit;
  for (const value of ['N', 'Na', 'Native\noptional id']) replay(input, { target: { value } }); await tick();
  assert.strictEqual(byLabel(r, '新AppID'), node); assert.equal(node.props.value, 'Native\noptional id');
  replay(oldSave, {}); replay(oldSubmit, { preventDefault() {} }); await tick(); assert.equal(saves(r).length, 0);
  replay(all(r.tree, n => n.tag === 'form')[0].props.onSubmit, { preventDefault() {} }); await tick();
  assert.deepEqual(saves(r)[0].body.fields.wechat_app_appid, { action: 'replace', value: 'Native\noptional id' });
});

scenario('AppID and Secret input handlers retire across replace keep replace intent ABA', async mount => {
  for (const label of ['AppID', 'AppSecret']) {
    const r = await mount(); await update(r, label + '处理方式', 'replace');
    const node = byLabel(r, '新' + label), input = node.props.onInput;
    for (const value of ['T', 'Ty', 'Typed value']) replay(input, { target: { value } }); await tick();
    assert.strictEqual(byLabel(r, '新' + label), node); assert.equal(node.props.value, 'Typed value');
    await update(r, label + '处理方式', 'keep'); await update(r, label + '处理方式', 'replace');
    replay(input, { target: { value: 'RETIRED_PRIVATE_DRAFT' } }); await tick();
    assert.equal(byLabel(r, '新' + label).props.value, label === 'AppID' ? APP : '');
  }
});

scenario('confirmation cancellation and synchronous draft mutation dispatch neither journal nor POST', async mount => {
  const cancelled = await mount({ confirm: () => false }); await save(cancelled);
  assert.equal(journal(cancelled).length, 0); assert.equal(saves(cancelled).length, 0);
  const changed = await mount({ confirm(_message, r) { replay(byLabel(r, '新AppID').props.onInput, { target: { value: 'changed during confirm' } }); return true; } });
  await replace(changed, 'AppID', 'frozen draft'); await save(changed);
  assert.equal(journal(changed).length, 0); assert.equal(saves(changed).length, 0);
});

scenario('the exact domain owner UUID journal is durable before transport and never contains the draft or revision', async mount => {
  let observed = false;
  const r = await mount({ send(call, next, host) {
    if (call.method === 'POST' && call.url === BASE) {
      observed = true; const entries = journal(host); assert.equal(entries.length, 1);
      assert.equal(entries[0][0], key(call.body.request_id)); assert.deepEqual(JSON.parse(entries[0][1]), pending(call.body.request_id));
      assert.deepEqual(Object.keys(JSON.parse(entries[0][1])).sort(), ['actor_id', 'domain', 'request_id', 'version']);
      assert.deepEqual(copy(host.bindings.fields), { wechat_app_appid: { action: 'keep' }, wechat_app_appsecret: { action: 'keep' } });
    }
    return next();
  } });
  await replace(r, 'AppID', 'PRIVATE_APP_JOURNAL'); await replace(r, 'AppSecret', 'PRIVATE_SECRET_JOURNAL'); await save(r);
  assert.equal(observed, true);
  for (const write of r.writes) {
    assert.ok(!String(write.value).includes('PRIVATE_'));
    if (write.key.startsWith(PREFIX) && write.operation === 'set') assert.deepEqual(Object.keys(JSON.parse(write.value)).sort(), ['actor_id', 'domain', 'request_id', 'version']);
  }
});

scenario('throwing storage and silent failed readback both prevent POST and leak no typed material', async mount => {
  for (const silent of [false, true]) {
    const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_NOT_DURABLE');
    r.storage.set = silent ? function () { return this; } : () => { throw Error('storage denied'); };
    await save(r); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 0);
    assert.ok(!JSON.stringify(r.writes).includes('PRIVATE_NOT_DURABLE'));
  }
});

scenario('a committed lost ACK recovers by GET only without resending Secret or resolving the operation', async mount => {
  const r = await unknown(mount, true); await replace(r, 'AppSecret', 'PRIVATE_LOST_ACK'); await save(r);
  assert.equal(saves(r).length, 1); assert.equal(journal(r).length, 1); assert.equal(byLabel(r, '新AppSecret'), undefined);
  await click(r, '读取保存回执'); assert.equal(receipts(r).length, 1); assert.equal(journal(r).length, 0);
  assert.equal(saves(r).length, 1); assert.equal(seals(r).length, 0); assert.match(text(r.tree), /原生App配置已保存/);
  assert.ok(!JSON.stringify(r.writes).includes('PRIVATE_LOST_ACK'));
});

scenario('a real HTTP404 receipt stays unknown until explicit resolve seals the original UUID', async mount => {
  const r = await unknown(mount, false); await save(r); const id = JSON.parse(journal(r)[0][1]).request_id;
  await click(r, '读取保存回执'); assert.equal(journal(r).length, 1); assert.match(text(r.tree), /没有回执不代表未保存/);
  assert.equal(seals(r).length, 0); await click(r, '核对并封存未受理请求');
  assert.equal(journal(r).length, 0); assert.equal(saves(r).length, 1);
  assert.equal(seals(r)[0].url, BASE + '/operations/' + id + '/resolve'); assert.deepEqual(seals(r)[0].body, { confirmed: true });
  assert.match(text(r.tree), /封存为未应用/);
});

scenario('cancelled resolve keeps the unknown UUID and does not send any sealing request', async mount => {
  const r = await unknown(mount, false, { confirm: message => !message.startsWith('确认核对并封存') });
  await save(r); const before = copy(journal(r)); await click(r, '核对并封存未受理请求');
  assert.deepEqual(journal(r), before); assert.equal(seals(r).length, 0);
});

scenario('selected UUID ABA retires stale recovery handlers and removes only each selected terminal journal', async mount => {
  const r = await mount({ pending: [pending(ID), pending(ID2)] }), old = capture(r, '核对并封存未受理请求');
  assert.equal(buttons(r, '确认并保存配置')[0].props.disabled, true);
  await click(r, ID2); await click(r, ID); replay(old, {}); await tick(); assert.equal(seals(r).length, 0);
  await click(r, ID2); await click(r, '核对并封存未受理请求');
  assert.equal(seals(r)[0].url, BASE + '/operations/' + ID2 + '/resolve'); assert.deepEqual(journal(r), [[key(ID), JSON.stringify(pending(ID))]]);
  await click(r, '核对并封存未受理请求'); assert.equal(journal(r).length, 0); assert.equal(seals(r).length, 2);
});

scenario('view and manage revocation retains owner-only recovery without reading the configuration again', async mount => {
  const r = await mount({ pending: [pending()] }), before = reads(r).length;
  r.sync({ uniqueAuth: [] }); await tick(); assert.equal(reads(r).length, before); assert.equal(byLabel(r, 'AppID处理方式'), undefined);
  await click(r, '读取保存回执'); assert.equal(journal(r).length, 1); await click(r, '核对并封存未受理请求');
  assert.equal(journal(r).length, 0); assert.equal(reads(r).length, before); assert.equal(saves(r).length, 0);
});

scenario('owner changes cannot recover or clear another owners pending UUID using retained callbacks', async mount => {
  const r = await mount({ pending: [pending()] }), old = capture(r, '核对并封存未受理请求');
  r.sync({ userInfo: { ...r.auth.userInfo, id: 8 }, token: 'owner-B' }); await tick(); replay(old, {}); await tick();
  assert.ok(r.storage.has(key(ID, 7))); assert.equal(seals(r).length, 0); assert.equal(buttons(r, '读取保存回执').length, 0);
});

scenario('forged owner identity, invalid terminal cache state and extra Secret fields never clear pending', async mount => {
  for (const patch of [{ actor_id: 99 }, { request_id: ID2 }, { state: 'unknown' }, { cache_status: 'not_required' },
    { state: 'not_applied', cache_status: 'cleared' }, { created_at: 0 }, { secret: 'PRIVATE_RESPONSE' }]) {
    const r = await mount({ pending: [pending()], send(call, next) {
      return call.method === 'GET' && call.url.includes('/operations/') ? envelope(receipt(ID, patch)) : next();
    } });
    await click(r, '读取保存回执'); assert.equal(journal(r).length, 1); assert.equal(saves(r).length, 0);
    assert.ok(!text(r.tree).includes('PRIVATE_RESPONSE')); assert.notEqual(r.bindings.error, '');
  }
});

scenario('wrong-domain missing-domain and extra-field owner journals block saving and remain untouched', async mount => {
  const { domain, ...withoutDomain } = pending();
  for (const row of [withoutDomain, { ...pending(), domain: 'wechat_open' }, { ...pending(), secret: 'PRIVATE_BAD_JOURNAL' },
    { ...pending(), actor_id: 99 }, { ...pending(), request_id: 'invalid' }]) {
    const r = await mount({ stored: row }); assert.equal(r.storage.get(key()), JSON.stringify(row));
    replay(capture(r, '确认并保存配置'), {}); await tick(); assert.equal(saves(r).length, 0); assert.notEqual(r.bindings.journalError, '');
    assert.equal(r.storage.get(key()), JSON.stringify(row)); assert.ok(!text(r.tree).includes('PRIVATE_BAD_JOURNAL'));
  }
});

scenario('HTTP409 keeps the request journal and shows the actual bounded Axios server conflict message', async mount => {
  const r = await mount({ send(call, next) { return call.method === 'POST' && call.url === BASE ? failure(409, '配置版本已变化，请核对') : next(); } });
  await save(r); assert.equal(journal(r).length, 1); assert.equal(saves(r).length, 1);
  assert.match(text(r.tree), /配置版本已变化，请核对/); assert.equal(buttons(r, '确认并保存配置')[0].props.disabled, true);
});

scenario('cache-pending committed receipts are terminal and later unknown saves retire the old success notice', async mount => {
  let posts = 0;
  const r = await mount({ send(call, next) {
    if (call.method === 'POST' && call.url === BASE && ++posts === 2) throw Error('Network Error');
    const result = next(); if (call.method === 'POST' && call.url === BASE) result.data.cache_status = 'pending'; return result;
  } });
  await save(r); assert.equal(journal(r).length, 0); assert.match(text(r.tree), /部分缓存清理尚未完成/);
  await save(r); assert.equal(journal(r).length, 1); assert.ok(!text(r.tree).includes('部分缓存清理尚未完成'));
});

scenario('route ABA retires retained native input, save and submit handlers', async mount => {
  const r = await mount(); await update(r, 'AppID处理方式', 'replace');
  const input = byLabel(r, '新AppID').props.onInput, oldSave = capture(r, '确认并保存配置');
  const submit = all(r.tree, n => n.tag === 'form')[0].props.onSubmit;
  r.route.fullPath = '/content/wechat-app?q=1'; await tick(); r.route.fullPath = '/content/wechat-app'; await tick();
  replay(input, { target: { value: 'RETIRED_ROUTE_VALUE' } }); replay(oldSave, {}); replay(submit, { preventDefault() {} }); await tick();
  assert.equal(saves(r).length, 0); assert.equal(byLabel(r, '新AppID'), undefined); assert.equal(journal(r).length, 0);
});

scenario('identity token ABA clears draft Secrets and permanently retires the old owner save lease', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_OLD_OWNER');
  const old = capture(r, '确认并保存配置'), owner = copy(r.auth.userInfo);
  r.sync({ userInfo: { ...owner, id: 8 }, token: 'owner-B' }); await tick(); r.sync({ userInfo: owner, token: 'read-A' }); await tick();
  replay(old, {}); await tick(); assert.equal(saves(r).length, 0); assert.equal(byLabel(r, '新AppSecret'), undefined);
  assert.ok(!JSON.stringify(r.bindings.fields).includes('PRIVATE_OLD_OWNER'));
});

scenario('direct token mismatch retires a lease even after storage restores the same token', async mount => {
  const r = await mount(), old = capture(r, '确认并保存配置');
  r.storage.set('admin_token', 'temporary-B'); replay(old, {}); await tick();
  r.storage.set('admin_token', r.auth.token); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
});

scenario('equal session storage events and App pending storage events invalidate captured controls', async mount => {
  const r = await mount(), old = capture(r, '确认并保存配置');
  r.sync({}, 'storage'); await tick(); replay(old, {}); await tick(); assert.equal(saves(r).length, 0);
  const beforePending = capture(r, '确认并保存配置'); r.storage.set(key(), JSON.stringify(pending()));
  const event = new Event('storage'); Object.defineProperty(event, 'key', { value: key() }); r.window.dispatchEvent(event); await tick();
  replay(beforePending, {}); await tick(); assert.equal(saves(r).length, 0); assert.equal(journal(r).length, 1);
  assert.equal(buttons(r, '确认并保存配置')[0].props.disabled, true);
});

scenario('successful same-session login invalidates drafts while failed login keeps the still-current draft', async mount => {
  const r = await mount(); await replace(r, 'AppSecret', 'PRIVATE_BEFORE_LOGIN'); const old = capture(r, '确认并保存配置');
  await r.auth.login('operator', 'owned-password'); await tick(); replay(old, {}); await tick();
  assert.equal(saves(r).length, 0); assert.equal(byLabel(r, '新AppSecret'), undefined);
  const failed = await mount({ send(call, next) { return call.url === '/login' ? failure(503, '登录服务暂不可用') : next(); } });
  await replace(failed, 'AppSecret', 'PRIVATE_CURRENT'); await assert.rejects(failed.auth.login('operator', 'wrong')); await tick();
  assert.equal(byLabel(failed, '新AppSecret').props.value, 'PRIVATE_CURRENT'); await save(failed); assert.equal(saves(failed).length, 1);
});

scenario('late snapshot rejection and finally cannot overwrite a replacement route generation', async mount => {
  const hold = deferred(); let read = 0;
  const r = await mount({ send(call, next) { if (call.method === 'GET' && call.url === BASE && ++read === 2) return hold.promise; return next(); } });
  await click(r, '重新读取'); const obsolete = reads(r).at(-1);
  r.route.fullPath = '/content/wechat-app?fresh=1'; await tick(); assert.equal(obsolete.signal.aborted, true);
  assert.ok(byLabel(r, 'AppID处理方式')); hold.reject(Error('late obsolete failure')); await tick();
  assert.ok(!text(r.tree).includes('late obsolete failure')); assert.equal(r.bindings.loading, false); assert.equal(r.bindings.error, '');
});

scenario('late committed ACK after owner change cannot clear the original owner journal or announce success', async mount => {
  const hold = deferred(); let response;
  const r = await mount({ send(call, next) { if (call.method === 'POST' && call.url === BASE) { response = next(); return hold.promise; } return next(); } });
  await save(r); const entry = journal(r)[0];
  r.sync({ userInfo: { ...r.auth.userInfo, id: 8 }, token: 'owner-B' }); await tick(); assert.equal(saves(r)[0].signal.aborted, true);
  hold.resolve(response); await tick(); assert.equal(r.storage.get(entry[0]), entry[1]);
  assert.ok(!text(r.tree).includes('原生App配置已保存。')); assert.equal(r.bindings.busy, false);
});

scenario('late recovery cannot clear an old UUID after a route generation handles a different selected operation', async mount => {
  const hold = deferred(); let held = false;
  const r = await mount({ pending: [pending(ID), pending(ID2)], send(call, next) {
    if (!held && call.method === 'GET' && call.url === BASE + '/operations/' + ID) { held = true; return hold.promise; } return next();
  } });
  await click(r, '读取保存回执'); r.route.fullPath = '/content/wechat-app?new=1'; await tick();
  await click(r, ID2); await click(r, '核对并封存未受理请求'); assert.deepEqual(journal(r), [[key(ID), JSON.stringify(pending(ID))]]);
  hold.resolve(envelope(receipt(ID))); await tick(); assert.deepEqual(journal(r), [[key(ID), JSON.stringify(pending(ID))]]);
  assert.ok(!text(r.tree).includes('原生App配置已保存。'));
});

scenario('unmount preserves unknown journals and retires old callbacks before a fresh mount resumes recovery', async mount => {
  const r = await unknown(mount, false); await replace(r, 'AppSecret', 'PRIVATE_UNMOUNT'); await save(r);
  const saved = copy(journal(r)), old = capture(r, '核对并封存未受理请求');
  r.visible.value = false; await tick(); replay(old, {}); await tick(); assert.equal(seals(r).length, 0);
  r.visible.value = true; await tick(); replay(old, {}); await tick();
  assert.equal(seals(r).length, 0); assert.deepEqual(journal(r), saved); assert.equal(byLabel(r, '新AppSecret'), undefined);
  await click(r, '核对并封存未受理请求'); assert.equal(journal(r).length, 0); assert.equal(saves(r).length, 1);
});
