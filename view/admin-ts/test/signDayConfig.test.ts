import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import request, { AdminResponseError } from '../src/utils/request.ts';
import { apiSignDayList, apiSignDayDetail, apiSignDayMutate, apiSignDayReceipt, parseSignDayRow, parseSignDayList,
  normalizeSignDayOperation, signDayCanonical, signDayFingerprint, parseSignDayReceipt, assertSignDayReceipt,
  parseSignDayPending, signDayPendingKey, signDayReceiptNotFound, type SignDayOperation, type SignDayPending } from '../src/api/signDayConfig.ts';

const revision = 'a'.repeat(64), requestId = '123e4567-e89b-42d3-a456-426614174000';
const body = { revision, day: '  今天签到 🌤  ', sign_num: 8, sort: 3, status: 1 as const, request_id: requestId };
const create: SignDayOperation = { operation: 'create', id: 0, body };
const update: SignDayOperation = { operation: 'update', id: 7, body };
const status: SignDayOperation = { operation: 'status', id: 7, body: { revision, status: 0, request_id: requestId } };
const remove: SignDayOperation = { operation: 'delete', id: 7, body: { revision, request_id: requestId } };
const row = { id: 7, gid: 46, day: '自由文字', sign_num: 8, sort: 3, status: 1, add_time: 1790700000, revision, issues: [] };
const page = { group_present: true, list: [row], count: 1, revision, theme: 1, theme_issue: null };

test('free day text and surrounding spaces remain intact in the canonical receipt contract', async () => {
  const before = JSON.stringify(create), normalized = normalizeSignDayOperation(create);
  assert.equal((normalized as typeof create).body.day, body.day);
  assert.equal(JSON.stringify(create), before);
  const canonical = { operation: 'create', id: 0, revision, day: body.day, sign_num: 8, sort: 3, status: 1 };
  assert.equal(JSON.stringify(signDayCanonical(create)), JSON.stringify(canonical));
  assert.equal(await signDayFingerprint(create), createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  assert.notEqual(await signDayFingerprint(create), await signDayFingerprint({ ...create, body: { ...body, day: body.day.trim() } }));
  assert.equal(await signDayFingerprint(create), await signDayFingerprint({ ...create, body: { ...body, request_id: '123e4567-e89b-42d3-a456-426614174001' } }));
});

test('all four operations have distinct bounded canonical fields and exclude the UUID', () => {
  assert.deepEqual(signDayCanonical(update), { operation: 'update', id: 7, revision, day: body.day, sign_num: 8, sort: 3, status: 1 });
  assert.deepEqual(signDayCanonical(status), { operation: 'status', id: 7, revision, status: 0 });
  assert.deepEqual(signDayCanonical(remove), { operation: 'delete', id: 7, revision });
  assert.throws(() => normalizeSignDayOperation({ ...status, body: { ...status.body, day: '不允许' } } as unknown as SignDayOperation));
  assert.throws(() => normalizeSignDayOperation({ ...remove, body: { ...remove.body, status: 0 } } as unknown as SignDayOperation));
  assert.throws(() => normalizeSignDayOperation({ ...create, id: 7 } as unknown as SignDayOperation));
  assert.throws(() => normalizeSignDayOperation({ ...update, id: 0 }));
});

test('day uses Unicode character length and is not restricted to numeric day ordinals', () => {
  for (const day of ['周末加油', '第八次见面', '自定义积分展示', '🌤'.repeat(64)]) {
    const normalized = normalizeSignDayOperation({ ...create, body: { ...body, day } });
    assert.equal((normalized as typeof create).body.day, day);
  }
  for (const day of ['', '  ', '\n', 'a\u0000b', 'a'.repeat(65), '🌤'.repeat(65)]) {
    assert.throws(() => normalizeSignDayOperation({ ...create, body: { ...body, day } }), /文案/);
  }
});

test('write values require positive integer display amounts and bounded nonnegative sorting', () => {
  assert.equal((normalizeSignDayOperation({ ...create, body: { ...body, sign_num: 2147483647, sort: 2147483647 } }) as typeof create).body.sign_num, 2147483647);
  for (const sign_num of [0, -1, 1.5, NaN, Infinity, 2147483648, '1' as unknown as number]) assert.throws(() => normalizeSignDayOperation({ ...create, body: { ...body, sign_num } }));
  for (const sort of [-1, 1.5, NaN, 2147483648, '0' as unknown as number]) assert.throws(() => normalizeSignDayOperation({ ...create, body: { ...body, sort } }));
  for (const value of [2, -1, '1']) assert.throws(() => normalizeSignDayOperation({ ...create, body: { ...body, status: value } } as unknown as SignDayOperation));
  for (const change of [{ revision: 'old' }, { request_id: 'not-a-uuid' }, { request_id: requestId.toUpperCase() }]) assert.throws(() => normalizeSignDayOperation({ ...create, body: { ...body, ...change } }));
});

test('historical malformed rows remain visible for repair without loosening new-write rules', () => {
  const historical = { ...row, day: null, sign_num: null, sort: -3, status: 9, issues: ['历史文案无效', '历史状态无效'] };
  assert.deepEqual(parseSignDayRow(historical), historical);
  const overSeven = { ...page, list: Array.from({ length: 8 }, (_, index) => ({ ...historical, id: index + 1 })), count: 8 };
  assert.deepEqual(parseSignDayList(overSeven), overSeven);
  assert.deepEqual(parseSignDayList({ ...page, group_present: false, list: [], count: 0, theme: null, theme_issue: '未配置主题' }).list, []);
  assert.throws(() => normalizeSignDayOperation({ ...update, body: { ...body, sign_num: null, status: 9, sort: -3 } } as unknown as SignDayOperation));
});

test('list and detail reject truncated, duplicate, cross-group or mismatched identities', () => {
  assert.deepEqual(parseSignDayList(page), page);
  for (const value of [{ ...page, count: 2 }, { ...page, group_present: false }, { ...page, list: [row, row], count: 2 },
    { ...page, list: [row, { ...row, id: 8, gid: 47 }], count: 2 }, { ...page, theme: 7 }, { ...page, revision: 'bad' },
    { ...page, list: [{ ...row, revision: '' }] }, { ...page, list: [{ ...row, add_time: '1790700000' }] },
    { ...page, list: [{ ...row, issues: [7] }] }]) assert.throws(() => parseSignDayList(value));
});

test('pending recovery preserves the exact original UUID and body and isolates the actor', async () => {
  const frozen: SignDayPending = { version: 1, actor: 12, input: update, fingerprint: await signDayFingerprint(update) };
  const saved = JSON.stringify(frozen), restored = await parseSignDayPending(saved, 12);
  assert.equal(JSON.stringify(restored), saved);
  assert.equal(restored.input.body.request_id, requestId);
  assert.deepEqual(signDayCanonical(restored.input), signDayCanonical(update));
  assert.notEqual(signDayPendingKey(12), signDayPendingKey(13));
  await assert.rejects(parseSignDayPending(saved, 13));
  await assert.rejects(parseSignDayPending(JSON.stringify({ ...frozen, input: { ...update, body: { ...body, day: '被改写' } } }), 12));
  await assert.rejects(parseSignDayPending(JSON.stringify({ ...frozen, version: 2 }), 12));
  await assert.rejects(parseSignDayPending(JSON.stringify({ ...frozen, extra: '不能忽略' }), 12));
  await assert.rejects(parseSignDayPending('{', 12));
  await assert.rejects(parseSignDayPending('x'.repeat(8193), 12));
});

test('receipt validation binds original operation, record, UUID and canonical payload hash', async () => {
  const frozen: SignDayPending = { version: 1, actor: 12, input: update, fingerprint: await signDayFingerprint(update) };
  const receipt = { operation: 'update' as const, id: 7, request_id: requestId, payload_hash: frozen.fingerprint };
  assertSignDayReceipt(parseSignDayReceipt(receipt, requestId), frozen);
  for (const change of [{ operation: 'create' }, { id: 8 }, { payload_hash: 'b'.repeat(64) }, { request_id: '123e4567-e89b-42d3-a456-426614174001' }]) assert.throws(() => assertSignDayReceipt({ ...receipt, ...change } as typeof receipt, frozen));
  for (const change of [{ operation: 'unknown' }, { id: 0 }, { payload_hash: '' }, { request_id: 'bad' }]) assert.throws(() => parseSignDayReceipt({ ...receipt, ...change }, requestId));
  const creating = { ...frozen, input: create, fingerprint: await signDayFingerprint(create) };
  assertSignDayReceipt({ operation: 'create', id: 123, request_id: requestId, payload_hash: creating.fingerprint }, creating);
});

test('only an actual receipt HTTP 404 permits retry, never a successful HTTP envelope with body 404', () => {
  assert.equal(signDayReceiptNotFound(new AdminResponseError('业务404但HTTP200', 404)), false);
  assert.equal(signDayReceiptNotFound(new AdminResponseError('回执异常', 400)), false);
  assert.equal(signDayReceiptNotFound(new Error('回执格式损坏')), false);
  assert.equal(signDayReceiptNotFound({ isAxiosError: true, response: { status: 200, data: { status: 404 } } }), false);
  assert.equal(signDayReceiptNotFound({ isAxiosError: true, response: { status: 404 } }), true);
  assert.equal(signDayReceiptNotFound({ isAxiosError: true, response: { status: 400 } }), false);
});

test('REST calls use exact methods, fixed bodies and cancellation signals, with no implicit retries', async () => {
  const adapter = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method?: string; url?: string; body: unknown; signal: unknown }> = [];
  const signal = new AbortController().signal;
  request.defaults.adapter = async config => {
    calls.push({ method: config.method, url: config.url, body: config.data ? JSON.parse(String(config.data)) : null, signal: config.signal });
    const data = config.url === '/marketing/sign-day-config' && config.method === 'get' ? page
      : config.url === '/marketing/sign-day-config/7' && config.method === 'get' ? { info: row }
      : { operation: config.method === 'post' ? 'create' : config.method === 'put' ? 'update' : config.method === 'patch' ? 'status' : 'delete', id: 7, request_id: requestId, payload_hash: 'b'.repeat(64) };
    return { config, data: { status: 200, msg: 'ok', data }, headers: {}, status: 200, statusText: 'OK' };
  };
  try {
    assert.deepEqual(await apiSignDayList(signal), page);
    assert.deepEqual(await apiSignDayDetail(7, signal), row);
    for (const operation of [create, update, status, remove]) await apiSignDayMutate(operation, signal);
    await apiSignDayReceipt(requestId, signal);
    assert.deepEqual(calls.map(call => [call.method, call.url]), [['get', '/marketing/sign-day-config'], ['get', '/marketing/sign-day-config/7'],
      ['post', '/marketing/sign-day-config'], ['put', '/marketing/sign-day-config/7'], ['patch', '/marketing/sign-day-config/7/status'],
      ['delete', '/marketing/sign-day-config/7'], ['get', `/marketing/sign-day-config/receipts/${requestId}`]]);
    assert.deepEqual(calls[2].body, body); assert.deepEqual(calls[3].body, body);
    assert.deepEqual(calls[4].body, status.body); assert.deepEqual(calls[5].body, remove.body);
    assert.ok(calls.every(call => call.signal === signal));
    request.defaults.adapter = async config => { calls.push({ method: config.method, url: config.url, body: null, signal: config.signal }); return { config, data: { status: 404, msg: '该管理员未发现回执', data: null }, headers: {}, status: 200, statusText: 'OK' }; };
    const before = calls.length;
    await assert.rejects(apiSignDayReceipt(requestId, signal), reason => reason instanceof AdminResponseError && reason.status === 404);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1)?.method, 'get');
  } finally { request.defaults.adapter = adapter; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('detail rejects a successful envelope for a different record and cannot silently edit it', async () => {
  const adapter = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  request.defaults.adapter = async config => ({ config, data: { status: 200, msg: 'ok', data: { info: { ...row, id: 8 } } }, headers: {}, status: 200, statusText: 'OK' });
  try { await assert.rejects(apiSignDayDetail(7), /身份不一致/); }
  finally { request.defaults.adapter = adapter; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
