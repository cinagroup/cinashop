import assert from 'node:assert/strict';
import { test } from 'node:test';
import request, { AdminResponseError } from '../src/utils/request.ts';
import { normalizeCityDeliveryQuery, normalizeCityDeliveryStoreQuery, cityDeliveryShanghaiSeconds, cityDeliveryTime,
  cityDeliveryMoney, cityDeliveryDistance, cityDeliveryOwnerLabel, cityDeliveryStoreLabel, cityDeliveryOriginLabel, cityDeliveryImage, cityDeliveryIssueLabel, cityDeliveryReadError,
  parseCityDeliveryRecord, parseCityDeliveryPage, parseCityDeliveryStores, parseCityDeliveryDetail, createCityDeliveryReadGuard,
  apiCityDeliveryRecords, apiCityDeliveryDetail, apiCityDeliveryStores, type CityDeliveryRecord } from '../src/api/cityDeliveryRecords.ts';

const record: CityDeliveryRecord = { id: 71, type: 1, relation_id: 7, uid: 12, oid: 31, station_type: 1,
  provider_label: '达达', status: 2, status_label: '待取货', order_id: 'DELIVERY_%\\', delivery_no: 'DADA_7',
  from_address: '起点 / 1 楼', to_address: '终点 🌤', mark: '发单备注', add_time: 0,
  owner: { kind: 'store', id: 7, label: '旧门店', image: '/assets/store.png', is_show: 0, is_del: 1 },
  origin_order: { id: 31, order_id: 'ORDER_31', pid: 0, status: 1, is_del: 1 },
  distance_meters: 123.4, distance_km: '0.1234', cargo_price: '99999999999999999.1234', fee: '0.0100', deduct_fee: '0', invalid_values: {}, issues: ['owner_hidden', 'owner_deleted', 'origin_order_deleted'] };
const detail = { record, metadata: { city_code: '021', mer_id: 0, mark: '发单备注', reason: '历史原因', receiver_name: '收货人', receiver_phone: '13800138000', from_address: record.from_address, to_address: record.to_address } };
const store = { id: 7, label: '旧门店', is_show: 0, is_del: 1, issues: ['owner_hidden', 'owner_deleted'] };
const page = { items: [record], total: 1, page: 1, limit: 20 };

test('record query preserves literal search text and distinguishes omitted filters from status/time zero', () => {
  const input = { page: 1, limit: 20, keyword: '  🌤 %_\\  ', status: '0', date_from: '0', date_to: '0', station_type: '2', store_id: '7' };
  const original = JSON.stringify(input);
  assert.deepEqual(normalizeCityDeliveryQuery(input), { page: 1, limit: 20, keyword: '🌤 %_\\', station_type: 2, status: 0, store_id: 7, date_from: 0, date_to: 0 });
  assert.deepEqual(normalizeCityDeliveryQuery({ station_type: '', status: '', store_id: '', keyword: '' }), { page: 1, limit: 20 });
  assert.equal(JSON.stringify(input), original);
  assert.equal(normalizeCityDeliveryQuery({ keyword: '🌤'.repeat(100) }).keyword, '🌤'.repeat(100));
  for (const keyword of ['🌤'.repeat(101), '\tvalid', 'valid\n', 'a\u007fb', 5, null]) assert.throws(() => normalizeCityDeliveryQuery({ keyword }));
});

test('record and store pagination have independent limits and the exact bounded offset', () => {
  assert.deepEqual(normalizeCityDeliveryQuery({ page: 5001, limit: 20 }), { page: 5001, limit: 20 });
  assert.deepEqual(normalizeCityDeliveryQuery({ page: '1001', limit: '100' }), { page: 1001, limit: 100 });
  assert.deepEqual(normalizeCityDeliveryStoreQuery({ page: 2001, limit: 50, keyword: ' old ' }), { page: 2001, limit: 50, keyword: 'old' });
  for (const value of [{ page: 5002, limit: 20 }, { page: 0 }, { page: '01' }, { page: null }, { limit: 101 }, { limit: 0 }, { limit: 2.5 }, { page: '1e2' }, { page: [1] }, { extra: 1 }]) assert.throws(() => normalizeCityDeliveryQuery(value));
  for (const value of [{ limit: 51 }, { page: 2002, limit: 50 }, { store_id: 7 }, { keyword: '\n' }]) assert.throws(() => normalizeCityDeliveryStoreQuery(value));
});

test('provider, signed status and store IDs reject coercion and preserve historical unknown codes', () => {
  for (const status of [-2147483648, -1, 0, 1, 987, 2147483647]) assert.equal(normalizeCityDeliveryQuery({ status }).status, status);
  for (const station_type of [1, 2, '1', '2']) assert.equal(normalizeCityDeliveryQuery({ station_type }).station_type, Number(station_type));
  for (const value of [{ station_type: 0 }, { station_type: 3 }, { status: '-0' }, { status: -0 }, { status: '+1' }, { status: ' 1' }, { status: '01' }, { status: '1.0' }, { status: null }, { status: 2147483648 }, { status: -2147483649 }, { store_id: 0 }, { store_id: -1 }, { store_id: true }]) assert.throws(() => normalizeCityDeliveryQuery(value));
});

test('timestamp filters are paired and inclusive across epoch and INT32 limits', () => {
  assert.deepEqual(normalizeCityDeliveryQuery({ date_from: 0, date_to: 2147483647 }), { page: 1, limit: 20, date_from: 0, date_to: 2147483647 });
  for (const value of [{ date_from: 0 }, { date_to: 0 }, { date_from: 2, date_to: 1 }, { date_from: -1, date_to: 0 }, { date_from: 0, date_to: 2147483648 }, { date_from: '00', date_to: '1' }]) assert.throws(() => normalizeCityDeliveryQuery(value));
});

test('Shanghai second conversion validates calendar fields rather than normalizing an impossible date', () => {
  assert.equal(cityDeliveryShanghaiSeconds('1970-01-01 08:00:00'), 0);
  assert.equal(cityDeliveryShanghaiSeconds('2038-01-19 11:14:07'), 2147483647);
  assert.equal(cityDeliveryTime(cityDeliveryShanghaiSeconds('2024-02-29 00:00:01')), '2024-02-29 00:00:01');
  for (const value of ['2023-02-29 00:00:00', '2024-02-30 00:00:00', '2024-01-01 24:00:00', '2024-01-01 00:60:00', '2024-01-01 00:00:60', '1970-01-01 07:59:59', '2038-01-19 11:14:08', '2024-01-01', '2024-01-01 00:00', '2024-01-01T00:00:00']) assert.throws(() => cityDeliveryShanghaiSeconds(value));
  assert.equal(cityDeliveryTime(0), '未记录');
  assert.equal(cityDeliveryTime(0, false), '1970-01-01 08:00:00');
  assert.equal(cityDeliveryTime(-1), '时间无效');
  assert.equal(cityDeliveryTime(NaN), '时间无效');
});

test('currency and distance formatting preserve source decimal precision without rounding or double conversion', () => {
  assert.equal(cityDeliveryMoney('99999999999999999.1234'), '¥99999999999999999.1234');
  assert.equal(cityDeliveryMoney('0.0100'), '¥0.0100');
  assert.equal(cityDeliveryDistance('0.1234'), '0.1234 km');
  assert.equal(cityDeliveryDistance('0.000000001'), '0.000000001 km');
  for (const value of [null, 'NaN', '-1', '1e3', 'Infinity', '1.']) {
    assert.equal(cityDeliveryMoney(value), '未记录或历史值无效'); assert.equal(cityDeliveryDistance(value), '未记录或历史值无效');
  }
});

test('typed owner labels cannot confuse supplier and store IDs and deleted store choices stay recognizable', () => {
  assert.equal(cityDeliveryOwnerLabel(record.owner), '门店：旧门店（#7）');
  assert.equal(cityDeliveryOwnerLabel({ ...record.owner, kind: 'supplier' }), '供应商：旧门店（#7）');
  assert.match(cityDeliveryStoreLabel(store), /旧门店（#7） · 已隐藏 · 已删除/u);
  assert.match(cityDeliveryStoreLabel({ ...store, is_show: 9 }), /状态异常/u);
  assert.equal(cityDeliveryImage('https://example.test/image.png'), 'https://example.test/image.png');
  assert.equal(cityDeliveryImage('/image.png'), '/image.png');
  for (const value of [null, '', '//unknown.test/a', 'javascript:alert(1)', 'data:image/svg+xml,test', '/bad\\path', 'https://example.test/a\n']) assert.equal(cityDeliveryImage(value), undefined);
  assert.equal(cityDeliveryIssueLabel('origin_owner_mismatch'), '原订单归属与配送记录不匹配');
  assert.equal(cityDeliveryIssueLabel('origin_owner_unverified'), '原单当前站点与历史归属无法核实');
  assert.equal(cityDeliveryOriginLabel({ ...record, origin_order: null, issues: ['origin_owner_unverified'] }), '原订单归属无法核实');
});

test('multiple attempts, missing owners and orphaned orders remain distinct projected records', () => {
  const orphan = { ...record, id: 72, type: 9, relation_id: -1, status: 987, status_label: '未知状态 (987)', station_type: 9, provider_label: '未知平台 (9)', origin_order: null,
    owner: { kind: 'unknown', id: -1, label: '未知归属 (9)', image: null, is_show: null, is_del: null }, fee: null, distance_meters: null, distance_km: null,
    invalid_values: { fee: '-3.00', distance_meters: 'NaN' }, issues: ['owner_type_unknown', 'origin_order_missing', 'provider_unknown', 'status_unknown', 'fee_invalid', 'distance_invalid'] };
  const parsed = parseCityDeliveryPage({ ...page, items: [record, orphan], total: 2 }, { page: 1, limit: 20 });
  assert.deepEqual(parsed.items.map(item => item.id), [71, 72]);
  assert.equal(parsed.items[1].origin_order, null); assert.equal(parsed.items[1].owner.kind, 'unknown');
  assert.deepEqual(parsed.items[1].invalid_values, { fee: '-3.00', distance_meters: 'NaN' });
  assert.equal(parsed.items[0].fee, '0.0100');
});

test('record and detail projections exclude finish codes, coordinates, provider raw data and unreviewed nested secrets', () => {
  const extra = { ...record, finish_code: 'PRIVATE', lat: 30, raw_provider: { secret: 'PRIVATE' }, owner: { ...record.owner, bank_account: 'PRIVATE' }, origin_order: { ...record.origin_order!, uid: 999, secret: 'PRIVATE' }, invalid_values: { fee: '-3', finish_code: 'PRIVATE' } };
  const parsed = parseCityDeliveryRecord(extra);
  assert.deepEqual(parsed.invalid_values, { fee: '-3' });
  assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false);
  const projected = parseCityDeliveryDetail({ ...detail, record: extra, metadata: { ...detail.metadata, raw_provider: 'PRIVATE', finish_code: 'PRIVATE', lat: 30 }, timeline: ['PRIVATE'] }, 71);
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
  assert.equal(projected.metadata.receiver_phone, '13800138000'); assert.equal(projected.record.owner.image, '/assets/store.png');
});

test('malformed and unrelated rows cannot become valid list or detail snapshots', () => {
  for (const patch of [{ id: 0 }, { id: '71' }, { status: '2' }, { from_address: null }, { owner: { ...record.owner, kind: ['store'] } }, { origin_order: { ...record.origin_order!, id: 999 } }, { fee: '-1' }, { distance_meters: Infinity }, { issues: [null] }, { invalid_values: { fee: 1 } }]) assert.throws(() => parseCityDeliveryRecord({ ...record, ...patch }));
  const truncated = { ...record } as Partial<CityDeliveryRecord>; delete truncated.owner; assert.throws(() => parseCityDeliveryRecord(truncated));
  assert.throws(() => parseCityDeliveryDetail(detail, 72));
  assert.throws(() => parseCityDeliveryDetail({ ...detail, metadata: { ...detail.metadata, receiver_name: null } }, 71));
});

test('pagination echoes are exact, duplicate IDs reject, and hidden/deleted stores are retained', () => {
  for (const patch of [{ page: 2 }, { limit: 100 }, { total: '1' }, { total: 0 }, { items: [record, record], total: 2 }, { items: Array(21).fill(record), total: 21 }]) assert.throws(() => parseCityDeliveryPage({ ...page, ...patch }, { page: 1, limit: 20 }));
  assert.deepEqual(parseCityDeliveryPage({ ...page, items: [], total: 100, page: 6 }, { page: 6, limit: 20 }), { items: [], total: 100, page: 6, limit: 20 });
  const stores = parseCityDeliveryStores({ items: [store], total: 50, page: 1, limit: 20 }, { page: 1, limit: 20 });
  assert.deepEqual(stores.items, [store]); assert.equal(stores.total, 50);
  assert.throws(() => parseCityDeliveryStores({ items: [store, store], total: 2, page: 1, limit: 20 }, { page: 1, limit: 20 }));
});

test('read channels abort replacements, retain independent requests and invalidate actor or permission changes', () => {
  let actor: string | null = 'actor7:view'; const guard = createCityDeliveryReadGuard(() => actor);
  const old = guard.begin('list')!, stores = guard.begin('stores')!, current = guard.begin('list')!;
  assert.equal(old.controller.signal.aborted, true); assert.equal(guard.current('list', old), false);
  assert.equal(guard.current('stores', stores), true); assert.equal(guard.current('list', current), true);
  actor = 'actor8:view'; assert.equal(guard.current('list', current), false); assert.equal(guard.finish('list', current), false);
  const detail = guard.begin('detail')!; actor = null; assert.equal(guard.current('detail', detail), false); assert.equal(guard.begin('list'), null);
  guard.reset(); assert.equal(detail.controller.signal.aborted, true); assert.equal(stores.controller.signal.aborted, true);
  actor = 'actor8:view'; const next = guard.begin('list')!; guard.dispose(); assert.equal(next.controller.signal.aborted, true); assert.equal(guard.begin('list'), null);
});

test('late asynchronous data cannot replace a new actor snapshot or finish its active request', async () => {
  let actor: string | null = 'actor7'; const guard = createCityDeliveryReadGuard(() => actor);
  let release: (value: string) => void = () => {}, displayed = '';
  const delayed = new Promise<string>(resolve => { release = resolve; }), old = guard.begin('list')!;
  const oldTask = delayed.then(value => { if (guard.current('list', old)) displayed = value; return guard.finish('list', old); });
  actor = 'actor8'; guard.reset(); const next = guard.begin('list')!;
  displayed = 'actor8 data'; release('actor7 PRIVATE'); assert.equal(await oldTask, false);
  assert.equal(displayed, 'actor8 data'); assert.equal(guard.current('list', next), true); assert.equal(guard.finish('list', next), true);
});

test('REST uses only bounded GET endpoints, exact literal params, detail ID and AbortSignals without retries', async () => {
  const adapter = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method?: string; url?: string; params: unknown; signal: unknown }> = [], signal = new AbortController().signal;
  request.defaults.adapter = async config => {
    calls.push({ method: config.method, url: config.url, params: config.params, signal: config.signal });
    const data = config.url === '/city_delivery/records/71' ? detail : config.url === '/city_delivery/stores' ? { items: [store], total: 1, page: 1, limit: 20 } : page;
    return { config, data: { status: 200, msg: 'ok', data }, headers: {}, status: 200, statusText: 'OK' };
  };
  try {
    await apiCityDeliveryRecords({ page: 1, limit: 20, keyword: ' %_\\ ', status: 0, date_from: 0, date_to: 0 }, signal);
    await apiCityDeliveryDetail(71, signal); await apiCityDeliveryStores({ page: 1, limit: 20, keyword: ' old ' }, signal);
    assert.deepEqual(calls.map(call => [call.method, call.url]), [['get', '/city_delivery/records'], ['get', '/city_delivery/records/71'], ['get', '/city_delivery/stores']]);
    assert.deepEqual(calls[0].params, { page: 1, limit: 20, keyword: '%_\\', status: 0, date_from: 0, date_to: 0 });
    assert.equal(calls[1].params, undefined); assert.deepEqual(calls[2].params, { page: 1, limit: 20, keyword: 'old' }); assert.ok(calls.every(call => call.signal === signal));
    const before = calls.length; await assert.rejects(apiCityDeliveryDetail(0)); await assert.rejects(apiCityDeliveryRecords({ page: 1, limit: 101 })); await assert.rejects(apiCityDeliveryStores({ page: 1, limit: 51 })); assert.equal(calls.length, before);
    request.defaults.adapter = async config => { calls.push({ method: config.method, url: config.url, params: config.params, signal: config.signal }); return { config, data: { status: 404, msg: '业务404，HTTP200', data: null }, headers: {}, status: 200, statusText: 'OK' }; };
    await assert.rejects(apiCityDeliveryDetail(71), reason => reason instanceof AdminResponseError && reason.status === 404);
    assert.equal(calls.length, before + 1); assert.ok(calls.every(call => call.method === 'get'));
    assert.equal(cityDeliveryReadError({ isAxiosError: true, response: { status: 500, data: { msg: '读取门店失败' } } }), '读取门店失败');
    assert.equal(cityDeliveryReadError({ isAxiosError: true, response: { status: 500, data: { msg: { secret: 'unreviewed' } } } }), '读取失败，请重新读取');
    assert.equal(cityDeliveryReadError({ isAxiosError: true, code: 'ECONNABORTED' }), '读取超时，请重新读取');
  } finally { request.defaults.adapter = adapter; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
