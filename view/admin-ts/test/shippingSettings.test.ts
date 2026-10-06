import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import request, { AdminResponseError } from '../src/utils/request.ts';
import { normalizeShippingMoney, normalizeShippingCoordinate, normalizeShippingSettingsWrite,
  shippingSettingsCanonical, shippingSettingsFingerprint, parseShippingSettingsSnapshot,
  parseShippingSettingsCities, parseShippingSettingsReceipt, assertShippingSettingsReceipt,
  shippingSettingsPendingKey, parseShippingSettingsPending, shippingSettingsReceiptNotFound, isShippingSettingsStale,
  apiShippingSettings, apiSaveShippingSettings, apiShippingSettingsReceipt, apiShippingSettingsCities,
  type ShippingSettingsWrite, type ShippingSettingsPending } from '../src/api/shippingSettings.ts';

const revision = 'a'.repeat(64), requestId = '123e4567-e89b-42d3-a456-426614174000';
const input: ShippingSettingsWrite = { request_id: requestId, revision, whole_free_shipping: 1,
  store_free_postage: '99.9', offline_postage: 0, store_self_mention: 1,
  pickup: { name: '  提货点 🌤  ', phone: '13800138000', address_ids: [1, 2, 3, 4],
    detailed_address: '  A座 / 2 楼  ', day_time: ['22:30', '05:15'], latitude: '-0.000000', longitude: '113.920000' } };
const snapshot = { settings: { whole_free_shipping: 1, store_free_postage: '99.90', offline_postage: 0, store_self_mention: 1 },
  raw_values: { whole_free_shipping: '"1"', store_free_postage: '"99.9"', offline_postage: '"0"', store_self_mention: '"1"' },
  missing_keys: [], issues: [], revision,
  pickup: { id: 7, name: '提货点 🌤', phone: '13800138000', address_ids: [1, 2, 3, 4],
    address_labels: ['省份', '城市', '区县', '街道'], detailed_address: 'A座 / 2 楼', day_time: ['22:30', '05:15'],
    latitude: '0', longitude: '113.92', is_show: 1, is_store: 1 } };

test('currency normalization preserves every cent without float, exponent or silent rounding', () => {
  for (const [given, expected] of [['0', '0.00'], ['0.1', '0.10'], ['0.01', '0.01'], ['99.90', '99.90'], ['99999999.99', '99999999.99']]) assert.equal(normalizeShippingMoney(given), expected);
  for (const given of ['', ' ', ' 0', '0 ', '01', '1.', '.1', '-1', '1.001', '100000000', '1e2', 'NaN', 1, null]) assert.throws(() => normalizeShippingMoney(given));
});

test('coordinate normalization retains six decimal precision and handles negative zero safely', () => {
  assert.equal(normalizeShippingCoordinate('-0.000000', true), '0');
  assert.equal(normalizeShippingCoordinate('-1.230000', true), '-1.23');
  assert.equal(normalizeShippingCoordinate('89.999999', true), '89.999999');
  assert.equal(normalizeShippingCoordinate('-180.000000', false), '-180');
  for (const given of ['90.000001', '-90.000001', ' 1', '+1', '01', '-090', '1e1', '1.1234567', '.2', 'NaN']) assert.throws(() => normalizeShippingCoordinate(given, true));
  assert.throws(() => normalizeShippingCoordinate('180.000001', false));
});

test('the complete canonical contract trims field edges, preserves internal address text and excludes UUID', async () => {
  const original = JSON.stringify(input), normalized = normalizeShippingSettingsWrite(input);
  const canonical = { operation: 'save', revision, whole_free_shipping: 1, store_free_postage: '99.90', offline_postage: 0,
    store_self_mention: 1, pickup: { name: '提货点 🌤', phone: '13800138000', address_ids: [1, 2, 3, 4], detailed_address: 'A座 / 2 楼', day_time: ['22:30', '05:15'], latitude: '0', longitude: '113.92' } };
  assert.deepEqual(shippingSettingsCanonical(input), canonical);
  assert.equal(JSON.stringify(shippingSettingsCanonical(input)), JSON.stringify(canonical));
  assert.equal(await shippingSettingsFingerprint(input), createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  assert.equal(await shippingSettingsFingerprint(input), '8224985a003da6096ab7e75e91624588cffd22df70460d9061e4e8f5fa9e7500');
  assert.equal(await shippingSettingsFingerprint(input), await shippingSettingsFingerprint({ ...input, request_id: '123e4567-e89b-42d3-a456-426614174001' }));
  assert.notEqual(await shippingSettingsFingerprint(input), await shippingSettingsFingerprint({ ...input, offline_postage: 1 }));
  assert.equal(JSON.stringify(input), original);
  assert.notEqual(normalized.pickup?.address_ids, input.pickup?.address_ids);
});

test('disabling pickup submits no store mutation while keeping the full three postage settings', () => {
  const disabled = { ...input, store_self_mention: 0 as const, pickup: null };
  assert.deepEqual(shippingSettingsCanonical(disabled), { operation: 'save', revision, whole_free_shipping: 1,
    store_free_postage: '99.90', offline_postage: 0, store_self_mention: 0, pickup: null });
  assert.throws(() => normalizeShippingSettingsWrite({ ...input, store_self_mention: 0 }));
  assert.throws(() => normalizeShippingSettingsWrite({ ...input, pickup: null }));
  assert.throws(() => normalizeShippingSettingsWrite({ ...disabled, store_free_postage: 'invalid' }));
});

test('all switch values, body keys, request identity and CAS revision are exact', () => {
  for (const key of ['whole_free_shipping', 'offline_postage', 'store_self_mention']) {
    for (const value of [null, '1', -1, 2]) assert.throws(() => normalizeShippingSettingsWrite({ ...input, [key]: value } as ShippingSettingsWrite));
  }
  for (const change of [{ revision: 'old' }, { request_id: requestId.toUpperCase() }, { request_id: 'uuid' }, { extra: 7 }]) assert.throws(() => normalizeShippingSettingsWrite({ ...input, ...change }));
  const incomplete = { ...input } as Partial<ShippingSettingsWrite>; delete incomplete.offline_postage;
  assert.throws(() => normalizeShippingSettingsWrite(incomplete as ShippingSettingsWrite));
  assert.throws(() => normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, image: '/ignored.png' } } as ShippingSettingsWrite));
});

test('pickup requires the complete region chain, valid mobile and bounded real text fields', () => {
  for (const address_ids of [[], [1], [1, 2], [1, 2, 0], [1, 2, 2], [1, 2, 3, 4, 5], [1, 2, '3']]) assert.throws(() => normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, address_ids } } as ShippingSettingsWrite));
  for (const phone of ['123', '23800138000', '1380013800x', '13800138000\n']) assert.throws(() => normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, phone } }));
  for (const name of ['', ' ', 'a\u0000b', '🌤'.repeat(101)]) assert.throws(() => normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, name } }));
  for (const detailed_address of ['', ' ', 'a\nb', 'a'.repeat(256)]) assert.throws(() => normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, detailed_address } }));
  assert.equal(normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, name: '🌤'.repeat(100), address_ids: [1, 2, 3] } }).pickup?.name, '🌤'.repeat(100));
});

test('business times accept overnight and all-day schedules but reject malformed or partial times', () => {
  for (const day_time of [['22:30', '05:15'], ['00:00', '00:00'], ['23:59', '00:00']]) assert.deepEqual(normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, day_time } } as ShippingSettingsWrite).pickup?.day_time, day_time);
  for (const day_time of [[], ['09:00'], ['24:00', '08:00'], ['9:00', '18:00'], ['09:00:00', '18:00'], ['00:60', '01:00'], ['09:00', '18:00', '20:00']]) assert.throws(() => normalizeShippingSettingsWrite({ ...input, pickup: { ...input.pickup!, day_time } } as ShippingSettingsWrite));
});

test('historical invalid configuration and pickup values remain visible for explicit repair', () => {
  const historical = { ...snapshot, settings: { whole_free_shipping: null, store_free_postage: null, offline_postage: null, store_self_mention: null },
    missing_keys: ['offline_postage'], issues: [{ key: 'pickup.latitude', message: '历史纬度无效' }],
    pickup: { ...snapshot.pickup, name: '', address_ids: [], address_labels: [], day_time: [], latitude: 'invalid', is_show: 9, is_store: -1 } };
  assert.deepEqual(parseShippingSettingsSnapshot(historical), historical);
  assert.deepEqual(parseShippingSettingsSnapshot({ ...snapshot, pickup: null }).pickup, null);
});

test('truncated settings and mismatched region responses never become editable snapshots', () => {
  for (const value of [{ ...snapshot, revision: '' }, { ...snapshot, settings: { whole_free_shipping: 1 } },
    { ...snapshot, settings: { ...snapshot.settings, store_free_postage: '99.9' } }, { ...snapshot, settings: { ...snapshot.settings, offline_postage: '0' } },
    { ...snapshot, raw_values: {} }, { ...snapshot, missing_keys: ['secret_key'] }, { ...snapshot, missing_keys: ['offline_postage', 'offline_postage'] },
    { ...snapshot, issues: [{ key: 'bad', message: 7 }] }, { ...snapshot, pickup: undefined },
    { ...snapshot, pickup: { ...snapshot.pickup, address_labels: [] } }, { ...snapshot, pickup: { ...snapshot.pickup, day_time: ['09:00'] } },
    { ...snapshot, pickup: { ...snapshot.pickup, id: 0 } }]) assert.throws(() => parseShippingSettingsSnapshot(value));
  const city = { id: 2, value: 2, label: '城市', pid: 1, level: 2, has_children: true };
  assert.deepEqual(parseShippingSettingsCities([city], 1), [city]);
  for (const value of [[city, city], [{ ...city, pid: 0 }], [{ ...city, value: 3 }], [{ ...city, level: 5 }], [{ ...city, has_children: '1' }]]) assert.throws(() => parseShippingSettingsCities(value, 1));
});

test('pending recovery preserves the exact normalized UUID and body and cannot cross actors', async () => {
  const normalized = normalizeShippingSettingsWrite(input);
  const pending: ShippingSettingsPending = { version: 1, actor: 12, input: normalized, fingerprint: await shippingSettingsFingerprint(normalized) };
  const raw = JSON.stringify(pending);
  assert.equal(JSON.stringify(await parseShippingSettingsPending(raw, 12)), raw);
  assert.notEqual(shippingSettingsPendingKey(12), shippingSettingsPendingKey(13));
  assert.throws(() => shippingSettingsPendingKey(0));
  await assert.rejects(parseShippingSettingsPending(raw, 13));
  await assert.rejects(parseShippingSettingsPending(JSON.stringify({ ...pending, input: { ...normalized, store_free_postage: '99.9' } }), 12));
  await assert.rejects(parseShippingSettingsPending(JSON.stringify({ ...pending, input: { ...normalized, offline_postage: 1 } }), 12));
  await assert.rejects(parseShippingSettingsPending(JSON.stringify({ ...pending, extra: 'cannot ignore' }), 12));
  await assert.rejects(parseShippingSettingsPending('x'.repeat(8193), 12));
});

test('receipts bind the original save operation, UUID and whole canonical payload hash', async () => {
  const pending: ShippingSettingsPending = { version: 1, actor: 12, input: normalizeShippingSettingsWrite(input), fingerprint: await shippingSettingsFingerprint(input) };
  const receipt = { operation: 'save' as const, request_id: requestId, payload_hash: pending.fingerprint };
  assertShippingSettingsReceipt(parseShippingSettingsReceipt(receipt, requestId), pending);
  for (const change of [{ operation: 'delete' }, { request_id: '123e4567-e89b-42d3-a456-426614174001' }, { payload_hash: 'b'.repeat(64) }]) assert.throws(() => assertShippingSettingsReceipt({ ...receipt, ...change } as typeof receipt, pending));
  for (const change of [{ operation: 'update' }, { request_id: 'wrong' }, { payload_hash: 'bad' }]) assert.throws(() => parseShippingSettingsReceipt({ ...receipt, ...change }, requestId));
});

test('only a real HTTP receipt 404 permits retry; body 404, broken data or 500 remain unknown', () => {
  assert.equal(shippingSettingsReceiptNotFound({ isAxiosError: true, response: { status: 404 } }), true);
  for (const reason of [new AdminResponseError('body404', 404), new Error('格式错误'),
    { isAxiosError: true, response: { status: 200, data: { status: 404 } } }, { isAxiosError: true, response: { status: 400 } },
    { isAxiosError: true, response: { status: 500 } }]) assert.equal(shippingSettingsReceiptNotFound(reason), false);
});

test('only an actual HTTP409 CAS rollback proof bound to the complete pending intent permits clearing it', async () => {
  const pending: ShippingSettingsPending = { version: 1, actor: 12, input: normalizeShippingSettingsWrite(input), fingerprint: await shippingSettingsFingerprint(input) };
  const data = { code: 'SHIPPING_SETTINGS_STALE_VERSION', request_id: requestId, payload_hash: pending.fingerprint };
  const certain = { isAxiosError: true, response: { status: 409, data: { status: 409, msg: '旧版本没有保存', data } } };
  assert.equal(isShippingSettingsStale(certain, pending), true);
  for (const reason of [new AdminResponseError('业务409，HTTP200', 409), new AdminResponseError('通用400', 400),
    { ...certain, isAxiosError: false }, { ...certain, response: { ...certain.response, status: 200 } },
    { ...certain, response: { ...certain.response, status: 400 } },
    { ...certain, response: { ...certain.response, data: { ...certain.response.data, status: '409' } } },
    { ...certain, response: { ...certain.response, data: { ...certain.response.data, status: 400 } } },
    { ...certain, response: { ...certain.response, data: { status: 409, data: null } } }]) assert.equal(isShippingSettingsStale(reason, pending), false);
  for (const change of [{ code: 'GENERIC_CONFLICT' }, { request_id: '123e4567-e89b-42d3-a456-426614174001' }, { payload_hash: 'b'.repeat(64) }]) {
    assert.equal(isShippingSettingsStale({ ...certain, response: { ...certain.response, data: { ...certain.response.data, data: { ...data, ...change } } } }, pending), false);
  }
});

test('REST uses the complete flat normalized body, bounded city query and cancellation without retries', async () => {
  const adapter = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method?: string; url?: string; body: unknown; params: unknown; signal: unknown }> = [];
  const signal = new AbortController().signal;
  request.defaults.adapter = async config => {
    calls.push({ method: config.method, url: config.url, body: config.data ? JSON.parse(String(config.data)) : null, params: config.params, signal: config.signal });
    const data = config.url === '/config/shipping' && config.method === 'get' ? snapshot : config.url === '/config/shipping/cities'
      ? [{ id: 1, value: 1, label: '省份', pid: 0, level: 1, has_children: true }]
      : { operation: 'save', request_id: requestId, payload_hash: 'b'.repeat(64) };
    return { config, data: { status: 200, msg: 'ok', data }, headers: {}, status: 200, statusText: 'OK' };
  };
  try {
    assert.deepEqual(await apiShippingSettings(signal), snapshot);
    await apiSaveShippingSettings(input, signal); await apiShippingSettingsReceipt(requestId, signal); await apiShippingSettingsCities(0, signal);
    assert.deepEqual(calls.map(call => [call.method, call.url]), [['get', '/config/shipping'], ['post', '/config/shipping'], ['get', `/config/shipping/receipts/${requestId}`], ['get', '/config/shipping/cities']]);
    assert.deepEqual(calls[1].body, normalizeShippingSettingsWrite(input)); assert.deepEqual(calls[3].params, { pid: 0 });
    assert.ok(calls.every(call => call.signal === signal));
    const before = calls.length;
    await assert.rejects(apiSaveShippingSettings({ ...input, store_free_postage: '99.999' }, signal));
    await assert.rejects(apiShippingSettingsCities(-1, signal)); await assert.rejects(apiShippingSettingsReceipt('bad', signal));
    assert.equal(calls.length, before);
    request.defaults.adapter = async config => { calls.push({ method: config.method, url: config.url, body: null, params: config.params, signal: config.signal }); return { config, data: { status: 404, msg: '业务404，HTTP200', data: null }, headers: {}, status: 200, statusText: 'OK' }; };
    await assert.rejects(apiShippingSettingsReceipt(requestId), reason => reason instanceof AdminResponseError && reason.status === 404);
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)?.method, 'get');
  } finally { request.defaults.adapter = adapter; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
