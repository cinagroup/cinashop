const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vue = require('vue');
const sfc = require('@vue/compiler-sfc');
const adminRoot = path.resolve(__dirname, '../src');
const revision = 'a'.repeat(64), nextRevision = 'b'.repeat(64), hash = 'c'.repeat(64);
const id = n => `12345678-1234-4123-8123-${String(n).padStart(12, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function loader(gateway = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file); if (!path.extname(file)) file += '.ts';
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    let source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.vue')) source = sfc.compileScript(sfc.parse(source, { filename: file }).descriptor, { id: 'city-delivery-actual-runtime' }).content;
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    new Function('require', 'exports', output)(name => {
      if (name === 'vue') return vue;
      if (name === 'axios') return { default: { isAxiosError: value => value?.isAxiosError === true }, isAxiosError: value => value?.isAxiosError === true };
      if (name === '@/utils/request') return { __esModule: true, default: gateway, getData: async result => (await result).data };
      if (name.startsWith('@/')) return load(path.join(adminRoot, name.slice(2)));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return require(name);
    }, exports);
    return exports;
  }
  return { load };
}
function harness(overrides = {}, storage = new Map()) {
  const actual = loader(), api = actual.load(path.join(adminRoot, 'api/cityDeliverySettings.ts'));
  const Controller = actual.load(path.join(adminRoot, 'pages/setting/cityDeliverySettingsController.ts')).CityDeliverySettingsController;
  let actor = { id: 11, identity: 'admin11:sessionA:view/manage', stored: 'sessionA', view: true, manage: true }, sequence = 1;
  const records = { prepare: [], confirm: [], intent: [], receipt: [], read: [], ask: [] }, prepared = new Map();
  const snapshot = (changes = {}) => ({ revision, editable: true,
    flags: { city_delivery_status: 1, self_delivery_status: 1, dada_delivery_status: 1, uu_delivery_status: 1 },
    credentials: Object.fromEntries(api.CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, { configured: true, source: 'env', issues: [] }])),
    readiness: { cipher_ready: true, dada_client_id: true, dada_callback_token: true, uu_callback_token: true, uu_timestamp_unit: true }, issues: [], ...changes });
  const input = (changes = {}) => ({ request_id: id(90), client_nonce: id(91), revision, flags: snapshot().flags, credentials: Object.fromEntries(api.CITY_DELIVERY_CREDENTIAL_KEYS.map(key => [key, { action: 'keep' }])), ...changes });
  const metadata = value => ({ version: 1, operation: 'update', request_id: value.request_id, client_nonce: value.client_nonce, revision: value.revision, payload_hash: hash, flags: clone(value.flags), actions: api.cityDeliveryActions(value) });
  const intent = value => ({ ...metadata(value), intent_id: value.request_id, expires_at: 1800000000, state: 'prepared', receipt: null });
  const memory = { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const ports = {
    read: async signal => { records.read.push(signal); return snapshot(); },
    prepare: async (value, signal) => { records.prepare.push({ input: clone(value), signal }); const result = intent(value); prepared.set(value.request_id, result); return result; },
    intent: async (requestId, signal) => { records.intent.push({ requestId, signal }); if (!prepared.has(requestId)) throw notFound(); return clone(prepared.get(requestId)); },
    confirm: async (value, signal) => { records.confirm.push({ input: clone(value), signal }); const result = prepared.get(value.request_id); if (!result) throw notFound(); const { intent_id, expires_at, state, receipt, ...proof } = result; return clone(proof); },
    receipt: async (requestId, signal) => { records.receipt.push({ requestId, signal }); throw notFound(); },
    ask: async message => { records.ask.push(message); }, storage: memory, uuid: () => id(sequence++), ...overrides,
  };
  const c = new Controller(() => actor, ports);
  return { c, api, ports, records, storage, prepared, snapshot, input, intent, metadata, actual, setActor: changes => { actor = { ...actor, ...changes }; } };
}
const notFound = () => ({ isAxiosError: true, response: { status: 404, data: { status: 404 } } });
function proof(status, journal, changes = {}) { return { isAxiosError: true, response: { status, data: { status, data: { code: status === 400 ? 'CITY_DELIVERY_SETTINGS_REJECTED' : 'CITY_DELIVERY_SETTINGS_STALE_VERSION', operation: 'update', request_id: journal.request_id, client_nonce: journal.client_nonce, payload_hash: journal.payload_hash, ...changes } } } }; }
function replace(r, key = 'dada_app_sercret', value = 'synthetic-only-private-value') { r.c.setAction(key, 'replace'); r.c.setValue(key, value); }

test('strict preparation covers exactly four flags six credential actions and two independent UUIDs', () => {
  const r = harness(), value = r.input(); value.credentials.dada_app_key = { action: 'replace', value: '  synthetic-new-key  ' };
  const normalized = r.api.normalizeCityDeliveryPrepare(value);
  assert.equal(normalized.credentials.dada_app_key.value, 'synthetic-new-key');
  assert.notEqual(normalized.request_id, normalized.client_nonce);
  assert.equal(Object.keys(normalized.flags).length, 4); assert.equal(Object.keys(normalized.credentials).length, 6);
  assert.throws(() => r.api.normalizeCityDeliveryPrepare({ ...value, client_nonce: 'd'.repeat(64) }));
  assert.throws(() => r.api.normalizeCityDeliveryPrepare({ ...value, unexpected: 1 }));
  assert.throws(() => r.api.normalizeCityDeliveryPrepare({ ...value, flags: { ...value.flags, self_delivery_status: null } }));
  assert.throws(() => r.api.normalizeCityDeliveryPrepare({ ...value, credentials: { ...value.credentials, uupt_app_id: { action: 'keep', value: 'must-not-be-sent' } } }));
  for (const key of r.api.CITY_DELIVERY_CREDENTIAL_KEYS) {
    const limit = r.api.CITY_DELIVERY_CREDENTIAL_BYTE_LIMITS[key];
    value.credentials[key] = { action: 'replace', value: 'a'.repeat(limit) }; assert.doesNotThrow(() => r.api.normalizeCityDeliveryPrepare(value));
    for (const text of ['a'.repeat(limit + 1), '🌤'.repeat(Math.floor(limit / 4) + 1), ' ', '\tvalue', 'value\n', 'value\x7f']) { value.credentials[key].value = text; assert.throws(() => r.api.normalizeCityDeliveryPrepare(value)); }
    value.credentials[key] = { action: 'keep' };
  }
  r.c.dispose();
});

test('strict read intent and receipt parsers permit only bounded metadata and no secret or ciphertext', () => {
  const r = harness(), value = r.input(), intent = r.intent(value), snapshot = r.snapshot();
  assert.deepEqual(r.api.parseCityDeliverySnapshot(snapshot), snapshot); assert.deepEqual(r.api.parseCityDeliveryIntent(intent), intent);
  assert.deepEqual(r.api.parseCityDeliveryReceipt(r.metadata(value)), r.metadata(value));
  assert.throws(() => r.api.parseCityDeliverySnapshot({ ...snapshot, raw_values: { dada_app_key: 'not-allowed' } }));
  assert.throws(() => r.api.parseCityDeliverySnapshot({ ...snapshot, credentials: { ...snapshot.credentials, dada_app_key: { ...snapshot.credentials.dada_app_key, value: 'not-allowed' } } }));
  assert.throws(() => r.api.parseCityDeliveryIntent({ ...intent, ciphertext: 'not-allowed' }));
  assert.throws(() => r.api.parseCityDeliveryIntent({ ...intent, expires_at: 2147483648 }));
  assert.throws(() => r.api.parseCityDeliveryIntent({ ...intent, state: 'applied', receipt: { ...r.metadata(value), client_nonce: id(92) } }));
  assert.throws(() => r.api.parseCityDeliveryReceipt({ ...r.metadata(value), actions: { ...intent.actions, dada_app_key: 'overwrite' } }));
  r.c.dispose();
});

test('actual API methods use the five local contracts and confirmation never resends replacement values', async () => {
  const r = harness(), calls = [], source = r.input(), expected = r.intent(source), gateway = {
    get: async (url, options) => { calls.push({ method: 'GET', url, options }); return { data: url.endsWith('city-delivery') ? r.snapshot() : url.includes('/intent/') ? expected : r.metadata(source) }; },
    post: async (url, body, options) => { calls.push({ method: 'POST', url, body: clone(body), options }); return { data: url.endsWith('/intent') ? expected : r.metadata(source) }; },
  };
  const api = loader(gateway).load(path.join(adminRoot, 'api/cityDeliverySettings.ts')), signal = new AbortController().signal;
  source.credentials.dada_app_key = { action: 'replace', value: 'synthetic-api-key' }; expected.actions.dada_app_key = 'replace';
  await api.apiCityDeliverySettings(signal); await api.apiPrepareCityDelivery(source, signal); await api.apiCityDeliveryIntent(source.request_id, signal);
  const opaque = { request_id: source.request_id, client_nonce: source.client_nonce, payload_hash: hash };
  await api.apiConfirmCityDelivery(opaque, signal); await api.apiCityDeliveryReceipt(source.request_id, signal);
  assert.deepEqual(calls.map(x => x.url), ['/config/city-delivery', '/config/city-delivery/intent', `/config/city-delivery/intent/${source.request_id}`, '/config/city-delivery/confirm', `/config/city-delivery/request/${source.request_id}`]);
  assert.deepEqual(calls[3].body, opaque); assert.equal(JSON.stringify(calls[3].body).includes('synthetic-api-key'), false);
  assert.ok(calls.every(x => x.options.signal === signal)); r.c.dispose();
});

test('actor-bound browser journal rejects tampering and contains only action summaries UUIDs and server proof', () => {
  const r = harness(), value = r.input(); value.credentials.uupt_appkey = { action: 'replace', value: 'synthetic-not-in-storage' };
  const journal = r.api.cityDeliveryJournal(value, 11), raw = JSON.stringify(journal);
  assert.equal(raw.includes('synthetic-not-in-storage'), false); assert.equal(raw.includes('credentials'), false);
  assert.deepEqual(r.api.parseCityDeliveryJournal(raw, 11), journal);
  for (const changed of [{ actor: 22 }, { client_nonce: 'd'.repeat(64) }, { payload_hash: hash }, { phase: 'confirm-unknown' }, { ciphertext: 'x' }]) assert.throws(() => r.api.parseCityDeliveryJournal(JSON.stringify({ ...journal, ...changed }), 11));
  r.c.dispose();
});

test('closing the master and provider retains all hidden actions and prepares the complete ten-key intent', async () => {
  const r = harness(); await r.c.activate(); replace(r); r.c.setAction('uupt_app_id', 'clear'); r.c.setFlag('dada_delivery_status', 0); r.c.setFlag('city_delivery_status', 0);
  assert.equal(r.c.state.draft.credentials.dada_app_sercret.value, 'synthetic-only-private-value');
  await r.c.prepare(); const sent = r.records.prepare[0].input;
  assert.equal(sent.flags.city_delivery_status, 0); assert.equal(sent.flags.self_delivery_status, 1); assert.equal(sent.credentials.dada_app_sercret.action, 'replace'); assert.equal(sent.credentials.uupt_app_id.action, 'clear');
  assert.equal(r.records.confirm.length, 0); assert.equal(r.c.state.journal.phase, 'prepared'); assert.equal(r.c.state.draft.credentials.dada_app_sercret.value, '');
  assert.equal([...r.storage.values()].join('').includes('synthetic-only-private-value'), false); assert.equal(r.c.summary().includes('synthetic-only-private-value'), false); r.c.dispose();
});

test('readonly corrupt snapshot missing values and encryption readiness prevent preparation without bypassing controls', async () => {
  for (const mode of ['readonly', 'corrupt', 'cipher', 'invalid-flag']) {
    const r = harness(); if (mode === 'readonly') r.setActor({ manage: false });
    if (mode === 'corrupt') r.ports.read = async () => r.snapshot({ editable: false });
    if (mode === 'cipher') r.ports.read = async () => r.snapshot({ readiness: { ...r.snapshot().readiness, cipher_ready: false } });
    if (mode === 'invalid-flag') r.ports.read = async () => r.snapshot({ flags: { ...r.snapshot().flags, uu_delivery_status: null } });
    await r.c.activate(); r.c.setFlag('city_delivery_status', 0); await r.c.prepare(); assert.equal(r.records.prepare.length, 0, mode); assert.equal(r.storage.size, 0, mode); r.c.dispose();
  }
});

test('preparation clears secret inputs while its request is pending and cancellation never confirms', async () => {
  const r = harness(), gate = deferred(); r.ports.prepare = async value => { r.records.prepare.push({ input: clone(value) }); return gate.promise; };
  await r.c.activate(); replace(r); const task = r.c.prepare(); await tick();
  assert.equal(r.c.state.draft.credentials.dada_app_sercret.value, ''); assert.equal(r.c.editorDisabled, true); assert.equal(r.c.state.journal.phase, 'preparing');
  gate.resolve(r.intent(r.records.prepare[0].input)); await task; r.ports.ask = async () => { throw Error('cancel'); }; await r.c.confirmPrepared();
  assert.equal(r.records.confirm.length, 0); assert.equal(r.c.state.journal.phase, 'prepared'); assert.equal(r.c.canAbandon, true); r.c.dispose();
});

test('lost preparation restores server metadata across refresh without downloading secrets or automatically confirming', async () => {
  const r = harness(); await r.c.activate(); replace(r, 'uupt_appkey');
  r.ports.prepare = async value => { r.prepared.set(value.request_id, r.intent(value)); throw Error('lost response'); }; await r.c.prepare();
  assert.equal(r.c.state.journal.phase, 'preparing'); const stored = [...r.storage.values()][0]; r.c.dispose();
  const fresh = harness({}, r.storage); fresh.ports.intent = async requestId => clone(r.prepared.get(requestId)); fresh.ports.confirm = async value => { fresh.records.confirm.push({ input: clone(value) }); const { intent_id, expires_at, state, receipt, ...proof } = r.prepared.get(value.request_id); return proof; };
  await fresh.c.activate(); assert.equal(fresh.c.state.journal.phase, 'prepared'); assert.equal(fresh.c.state.draft.credentials.uupt_appkey.value, ''); assert.equal(fresh.records.confirm.length, 0); assert.equal(stored.includes('synthetic-only-private-value'), false);
  await fresh.c.confirmPrepared(); assert.equal(fresh.records.confirm.length, 1); assert.equal(Object.keys(fresh.records.confirm[0].input).length, 3); assert.equal(fresh.c.state.journal, null); fresh.c.dispose();
});

test('explicit abandonment before confirmation aborts late preparation and cannot apply its response', async () => {
  const r = harness(), gate = deferred(); let signal, submitted;
  r.ports.prepare = (value, requestSignal) => { signal = requestSignal; submitted = clone(value); return gate.promise; };
  await r.c.activate(); replace(r); const pending = r.c.prepare(); await tick(); assert.equal(r.c.canAbandon, true);
  await r.c.abandonUnconfirmed(); assert.equal(signal.aborted, true); assert.equal(r.c.state.journal, null); assert.equal(r.storage.size, 0);
  gate.resolve(r.intent(submitted)); await pending; assert.equal(r.c.state.intent, null); assert.equal(r.records.confirm.length, 0); assert.match(r.c.state.notice, /服务器准备可保留/); r.c.dispose();
});

test('preconfirmation actual404 stays frozen until explicit abandonment and never silently prepares a new UUID', async () => {
  const r = harness(); r.ports.prepare = async () => { throw Error('prepare unknown'); }; await r.c.activate(); await r.c.prepare();
  const requestId = r.c.state.journal.request_id; await r.c.readIntent(); assert.equal(r.c.state.journal.request_id, requestId); assert.equal(r.c.canAbandon, true); assert.equal(r.records.confirm.length, 0);
  await r.c.abandonUnconfirmed(); assert.equal(r.c.state.journal, null); assert.equal(r.records.prepare.length, 0); assert.equal(r.c.state.ready, true); r.c.dispose();
});

test('unknown confirmation persists its phase before POST and reloads the identical intent without replacement content', async () => {
  const r = harness(); await r.c.activate(); replace(r); await r.c.prepare(); const original = clone(r.c.state.journal); let submitted;
  r.ports.confirm = async value => { submitted = clone(value); assert.equal(JSON.parse(r.storage.get(r.api.cityDeliveryPendingKey(11))).phase, 'confirm-unknown'); throw Error('after-write network failure'); };
  await r.c.confirmPrepared(); assert.equal(r.c.state.journal.phase, 'confirm-unknown'); assert.equal(r.c.canAbandon, false); const entries = new Map(r.storage); r.c.dispose();
  const fresh = harness({}, entries); fresh.ports.intent = async requestId => clone(r.prepared.get(requestId)); fresh.ports.confirm = async value => { fresh.records.confirm.push({ input: clone(value) }); throw Error('still uncertain'); };
  await fresh.c.activate(); assert.equal(fresh.c.state.journal.phase, 'confirm-unknown'); assert.equal(fresh.c.canAbandon, false); await fresh.c.confirmPrepared(); assert.deepEqual(fresh.records.confirm[0].input, submitted); assert.equal(fresh.c.state.journal.request_id, original.request_id); fresh.c.dispose();
});

test('after confirmation all404 and expired metadata leave the original immutable request locked', async () => {
  const r = harness(); await r.c.activate(); await r.c.prepare(); r.ports.confirm = async () => { throw Error('unknown'); }; await r.c.confirmPrepared(); const journal = clone(r.c.state.journal);
  r.ports.intent = async () => { throw notFound(); }; await r.c.readIntent(); await r.c.readReceipt(); await r.c.abandonUnconfirmed(); assert.deepEqual(clone(r.c.state.journal), journal); assert.equal(r.c.canAbandon, false);
  r.ports.intent = async () => ({ ...r.prepared.get(journal.request_id), state: 'expired' }); await r.c.readIntent(); assert.equal(r.c.state.intent.state, 'expired'); assert.equal(r.c.state.journal.phase, 'confirm-unknown'); assert.equal(r.c.editorDisabled, true); assert.equal(r.c.canConfirm, true); r.c.dispose();
});

test('matching successful receipt or applied metadata recovers success while foreign metadata remains frozen', async () => {
  for (const channel of ['receipt', 'applied', 'wrong-nonce', 'wrong-hash', 'wrong-flags', 'wrong-actions']) {
    const r = harness(); await r.c.activate(); await r.c.prepare(); r.ports.confirm = async () => { throw Error('unknown'); }; await r.c.confirmPrepared(); const j = clone(r.c.state.journal), result = { ...r.prepared.get(j.request_id) }; const { intent_id, expires_at, state, receipt, ...p } = result;
    if (channel === 'wrong-nonce') p.client_nonce = id(999); if (channel === 'wrong-hash') p.payload_hash = 'f'.repeat(64); if (channel === 'wrong-flags') p.flags = { ...p.flags, uu_delivery_status: 0 }; if (channel === 'wrong-actions') p.actions = { ...p.actions, dada_app_key: 'clear' };
    if (channel === 'applied') { r.ports.intent = async () => ({ ...result, state: 'applied', receipt: p }); await r.c.readIntent(); } else { r.ports.receipt = async () => p; await r.c.readReceipt(); }
    if (['receipt', 'applied'].includes(channel)) { assert.equal(r.c.state.journal, null); assert.equal(r.c.state.success, true); assert.equal(r.storage.size, 0); }
    else { assert.deepEqual(clone(r.c.state.journal), j); assert.equal(r.c.editorDisabled, true); } r.c.dispose();
  }
});

test('only matched actual400 or409 rollback permits correction after explicit reread with a new UUID', async () => {
  for (const status of [400, 409]) {
    const r = harness(); await r.c.activate(); replace(r); r.c.setFlag('self_delivery_status', 0); await r.c.prepare(); const old = clone(r.c.state.journal);
    r.ports.confirm = async () => { throw proof(status, r.c.state.journal); }; await r.c.confirmPrepared();
    assert.equal(r.c.state.journal, null); assert.equal(r.c.state.needsReread, true); assert.equal(r.c.state.draft.flags.self_delivery_status, 0); assert.equal(r.c.state.draft.credentials.dada_app_sercret.action, 'replace'); assert.equal(r.c.state.draft.credentials.dada_app_sercret.value, '');
    await r.c.prepare(); assert.equal(r.records.prepare.length, 1); r.ports.read = async () => r.snapshot({ revision: nextRevision }); await r.c.reread(); replace(r, 'dada_app_sercret', 'synthetic-corrected-value'); await r.c.prepare();
    assert.notEqual(r.c.state.journal.request_id, old.request_id); assert.notEqual(r.c.state.journal.client_nonce, old.client_nonce); assert.equal(r.c.state.journal.revision, nextRevision); assert.equal(r.records.prepare[1].input.credentials.dada_app_sercret.value, 'synthetic-corrected-value'); r.c.dispose();
  }
});

test('bare errors HTTP200 business envelopes wrong UUID nonce hash operation and code cannot unlock confirmed requests', async () => {
  for (const variant of ['bare400', 'bare409', 'body409', 'uuid', 'nonce', 'hash', 'operation', 'code', 'timeout']) {
    const r = harness(); await r.c.activate(); await r.c.prepare(); r.ports.confirm = async () => {
      if (variant === 'timeout') throw Error('timeout'); if (variant.startsWith('bare')) throw { isAxiosError: true, response: { status: Number(variant.slice(4)), data: { status: Number(variant.slice(4)) } } };
      const reason = proof(409, r.c.state.journal); if (variant === 'body409') reason.response.status = 200;
      const field = { uuid: 'request_id', nonce: 'client_nonce', hash: 'payload_hash', operation: 'operation', code: 'code' }[variant]; if (field) reason.response.data.data[field] = field === 'payload_hash' ? 'f'.repeat(64) : 'foreign'; throw reason;
    }; await r.c.confirmPrepared(); assert.equal(r.c.state.journal.phase, 'confirm-unknown', variant); assert.equal(r.c.canAbandon, false, variant); assert.equal(r.c.editorDisabled, true, variant); r.c.dispose();
  }
});

test('foreign prepare nonce flags actions and revision are never accepted or automatically confirmed', async () => {
  for (const field of ['client_nonce', 'revision', 'flags', 'actions']) {
    const r = harness(); r.ports.prepare = async value => { const result = r.intent(value); if (field === 'client_nonce') result.client_nonce = id(777); if (field === 'revision') result.revision = nextRevision; if (field === 'flags') result.flags.uu_delivery_status = 0; if (field === 'actions') result.actions.uupt_appkey = 'clear'; return result; };
    await r.c.activate(); await r.c.prepare(); assert.equal(r.c.state.journal.phase, 'preparing', field); assert.equal(r.c.state.journal.payload_hash, null); assert.equal(r.c.canConfirm, false); assert.equal(r.records.confirm.length, 0); r.c.dispose();
  }
});

test('actor switch permission revocation and unload abort and fence every late private response', async () => {
  for (const channel of ['read', 'prepare', 'intent', 'confirm', 'receipt', 'ask']) {
    const r = harness(), gate = deferred(); let pending, signal, input;
    if (channel === 'read') { r.ports.read = value => { signal = value; return gate.promise; }; pending = r.c.activate(); }
    else {
      await r.c.activate(); replace(r);
      if (channel === 'prepare') { r.ports.prepare = (value, requestSignal) => { input = clone(value); signal = requestSignal; return gate.promise; }; pending = r.c.prepare(); }
      else { await r.c.prepare(); input = r.records.prepare[0].input;
        if (channel === 'ask') { r.ports.ask = () => gate.promise; pending = r.c.confirmPrepared(); }
        else if (channel === 'confirm') { r.ports.confirm = (_value, requestSignal) => { signal = requestSignal; return gate.promise; }; pending = r.c.confirmPrepared(); }
        else { r.ports[channel] = (_value, requestSignal) => { signal = requestSignal; return gate.promise; }; pending = channel === 'intent' ? r.c.readIntent() : r.c.readReceipt(); }
      }
    }
    await tick(); r.setActor({ id: 22, identity: 'admin22:new-session', stored: 'new-session', view: false, manage: false }); r.c.invalidate();
    if (signal) assert.equal(signal.aborted, true, channel); gate.resolve(channel === 'read' ? r.snapshot() : channel === 'prepare' || channel === 'intent' ? r.intent(input) : channel === 'ask' ? undefined : r.metadata(input)); await pending;
    assert.equal(r.c.state.snapshot, null, channel); assert.equal(r.c.state.journal, null, channel); assert.equal(r.c.state.intent, null, channel); assert.equal(r.c.state.success, false, channel); assert.equal(r.c.state.draft.credentials.dada_app_sercret.value, '', channel); assert.equal(r.storage.has(r.api.cityDeliveryPendingKey(22)), false, channel); r.c.dispose();
  }
});

test('load failure preserves the draft but disables new preparation until an explicit successful reread', async () => {
  const r = harness(); await r.c.activate(); replace(r); r.c.setFlag('self_delivery_status', 0); r.ports.read = async () => { throw Error('failed load'); }; await r.c.reread();
  assert.equal(r.c.state.draft.credentials.dada_app_sercret.value, 'synthetic-only-private-value'); assert.equal(r.c.state.draft.flags.self_delivery_status, 0); assert.equal(r.c.state.ready, false); assert.equal(r.c.editorDisabled, true); await r.c.prepare(); assert.equal(r.records.prepare.length, 0);
  r.ports.read = async () => r.snapshot({ revision: nextRevision }); await r.c.reread(); assert.equal(r.c.state.draft.credentials.dada_app_sercret.value, 'synthetic-only-private-value'); await r.c.prepare(); assert.equal(r.records.prepare[0].input.revision, nextRevision); r.c.dispose();
});

test('browser storage failures and malformed foreign journal never allow unrecorded preparation or confirmation', async () => {
  const r = harness(); await r.c.activate(); r.ports.storage.setItem = () => { throw Error('storage denied'); }; await r.c.prepare(); assert.equal(r.records.prepare.length, 0); r.c.dispose();
  const corrupted = harness({}, new Map([['admin_city_delivery_pending:11', '{"version":1,"actor":22}']])); await corrupted.c.activate(); assert.ok(corrupted.c.state.recoveryError); assert.equal(corrupted.c.editorDisabled, true); await corrupted.c.prepare(); assert.equal(corrupted.records.prepare.length, 0); assert.equal(corrupted.storage.size, 1); corrupted.c.dispose();
  const confirmation = harness(); await confirmation.c.activate(); await confirmation.c.prepare(); confirmation.ports.storage.setItem = () => { throw Error('storage denied'); }; await confirmation.c.confirmPrepared(); assert.equal(confirmation.records.confirm.length, 0); assert.ok(confirmation.c.state.recoveryError); assert.equal(confirmation.c.state.journal.phase, 'prepared'); confirmation.c.dispose();
});

test('expired intent cannot unlock by reading but a matched expiration rejection proves the original confirmation did not apply', async () => {
  const r = harness(); await r.c.activate(); await r.c.prepare(); r.ports.confirm = async () => { throw Error('unknown'); }; await r.c.confirmPrepared();
  r.ports.intent = async requestId => ({ ...r.prepared.get(requestId), state: 'expired' }); await r.c.readIntent(); assert.ok(r.c.state.journal);
  r.ports.confirm = async () => { throw proof(400, r.c.state.journal); }; await r.c.confirmPrepared(); assert.equal(r.c.state.journal, null); assert.equal(r.c.state.needsReread, true); r.c.dispose();
});

test('actual credential component renders masked replacement and explicit readonly keep replace clear controls', async () => {
  const file = path.join(adminRoot, 'components/CityDeliveryCredentialField.vue'), actual = loader(), component = actual.load(file).default;
  const descriptor = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }).descriptor;
  const bindings = sfc.compileScript(descriptor, { id: 'credential-ssr' }).bindings;
  component.render = new Function('Vue', require('@vue/compiler-dom').compile(descriptor.template.content, { mode: 'function', prefixIdentifiers: true, bindingMetadata: bindings }).code)(vue);
  const elementPlus = require('element-plus');
  const app = vue.createSSRApp(component, { label: '达达 AppSecret', statusLabel: '已配置（部署兼容来源）', action: 'replace', value: '', limit: 256, disabled: true }); app.use(elementPlus); app.provide(elementPlus.ID_INJECTION_KEY, { prefix: 10, current: 0 });
  const html = await require('@vue/server-renderer').renderToString(app);
  for (const label of ['保留', '替换', '清除', '部署兼容来源', '不会回显现有值']) assert.ok(html.includes(label), label);
  assert.match(html, /type="password"/); assert.equal((html.match(/type="radio"/g) ?? []).length, 3); assert.equal((html.match(/disabled/g) ?? []).length >= 4, true); assert.equal(html.includes('synthetic-only-private-value'), false);
});

test('actual page and credential SFCs compile with explicit disabled controls nested preservation and the dedicated legacy route', () => {
  for (const relative of ['pages/setting/CityDeliverySettings.vue', 'components/CityDeliveryCredentialField.vue']) {
    const file = path.join(adminRoot, relative), result = sfc.parse(fs.readFileSync(file, 'utf8'), { filename: file }); assert.deepEqual(result.errors, []);
    const script = sfc.compileScript(result.descriptor, { id: 'city-sfc-check' });
    const compiled = sfc.compileTemplate({ source: result.descriptor.template.content, filename: file, id: 'city-sfc-check', compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(compiled.errors, []);
  }
  const page = fs.readFileSync(path.join(adminRoot, 'pages/setting/CityDeliverySettings.vue'), 'utf8');
  assert.match(page, /v-show="state\.draft\.flags\[provider\.flag\] === 1"/); assert.match(page, /:disabled="controller\.editorDisabled"/); assert.match(page, /admin-session-changed/); assert.match(page, /ElMessageBox\.close\(\)/);
  const route = fs.readFileSync(path.join(adminRoot, 'router/index.ts'), 'utf8'), menu = fs.readFileSync(path.join(adminRoot, 'layouts/AdminLayout.vue'), 'utf8');
  assert.ok(route.includes('alias: "/admin/setting/city/delivery/setting"')); assert.match(route, /setting\/city-delivery-settings/); assert.match(menu, /canMenu\('\/setting\/city-delivery-settings'\)/);
});
