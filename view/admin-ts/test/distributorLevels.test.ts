import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import request, { AdminResponseError } from '../src/utils/request.ts';
import { normalizeDistributorValues, normalizeDistributorQuery, distributorImageReference, distributorImagePreview, distributorColor, distributorRatio, distributorTime,
  parseDistributorList, parseDistributorParents, parseDistributorDetail, normalizeDistributorIntent, distributorCanonical, distributorFingerprint, distributorPendingKey,
  parseDistributorPending, parseDistributorReceipt, assertDistributorReceipt, isDistributorStale, isDistributorRejected, distributorReceiptNotFound, distributorErrorMessage, distributorOrphanIds, distributorRejectedDraftKey,
  apiDistributorList, apiDistributorParents, apiDistributorDetail, apiDistributorWrite, apiDistributorReceipt, type DistributorIntent, type DistributorPending } from '../src/api/distributorLevels.ts';
const revision = 'a'.repeat(64), requestId = '123e4567-e89b-42d3-a456-426614174000';
const values = { name: '  星级 🌤 e\u0301  ', grade: 3, image: '/api/assets/42', color: ' rgba(1, 2, 3, 0.5) ', one_brokerage: 15, two_brokerage: 10, status: 1 as const };
const taskValues = { level_id: 7, name: ' 邀请 🌤 ', type: 1, number: 5, desc: ' 第一行\r\n\t第二行 ', sort: 3, status: 1 as const };
const input: DistributorIntent = { operation: 'level:create', id: 0, input: { request_id: requestId, revision, values } };
const config = { one_ratio: '10.00', two_ratio: '5.50', enabled: true };
const row = { ...normalizeDistributorValues('level', values), id: 7, is_del: 0, add_time: 0, task_count: 5, one_brokerage_ratio: '11.50', two_brokerage_ratio: '6.05', revision, image_preview: '/api/assets/42?sig=preview', issues: [] };
const parent = { id: 7, name: row.name, grade: row.grade, status: 1, revision };
const task = { ...normalizeDistributorValues('task', taskValues), id: 8, is_del: 0, add_time: 0, is_must: 9, type_name: '邀请好友成为下级', completed: true, revision, issues: [] };
const types = Array.from({ length: 5 }, (_, i) => ({ type: i + 1, name: `类型${i + 1}`, unit: i === 0 ? '人' : i === 1 || i === 3 ? '元' : '单', image: '' }));
const snapshot = { list: [row], count: 1, page: 1, limit: 20, revision, config, issues: [] };
const taskSnapshot = { list: [task], count: 1, page: 1, limit: 20, revision, parent, task_types: types, issues: [] };

test('full level values normalize declared trimming without changing Unicode or safe color spelling', () => {
  const normalized = normalizeDistributorValues('level', { ...values, image: ' /api/assets/42 ' });
  assert.deepEqual(Object.keys(normalized), ['name', 'grade', 'image', 'color', 'one_brokerage', 'two_brokerage', 'status']);
  assert.equal(normalized.name, '星级 🌤 e\u0301'); assert.equal((normalized as typeof values).image, '/api/assets/42'); assert.equal((normalized as typeof values).color, 'rgba(1, 2, 3, 0.5)');
});
test('level and task fields reject missing/extra fields, invalid integer boundaries and crossed brokerage', () => {
  for (const changed of [{ ...values, grade: 0 }, { ...values, grade: 32768 }, { ...values, one_brokerage: 0.5 }, { ...values, two_brokerage: 16 }, { ...values, status: 2 }, { ...values, extra: 1 }]) assert.throws(() => normalizeDistributorValues('level', changed));
  for (const changed of [{ ...taskValues, level_id: 0 }, { ...taskValues, type: 6 }, { ...taskValues, number: 0 }, { ...taskValues, sort: 32768 }, { ...taskValues, is_must: 1 }]) assert.throws(() => normalizeDistributorValues('task', changed));
  assert.throws(() => normalizeDistributorValues('level', { ...values, name: undefined }));
});
test('codepoint limits apply before trimming; only task descriptions accept line breaks and tabs', () => {
  assert.equal(normalizeDistributorValues('level', { ...values, name: '🌤'.repeat(50) }).name, '🌤'.repeat(50));
  assert.equal((normalizeDistributorValues('task', { ...taskValues, desc: '🌤'.repeat(255) }) as typeof taskValues).desc, '🌤'.repeat(255));
  assert.equal((normalizeDistributorValues('task', taskValues) as typeof taskValues).desc, '第一行\r\n\t第二行');
  for (const name of [' x\n', '🌤'.repeat(51), ` ${'x'.repeat(50)}`, '\ud800', 'a\u007fb']) assert.throws(() => normalizeDistributorValues('level', { ...values, name }));
  assert.throws(() => normalizeDistributorValues('task', { ...taskValues, desc: 'a\u0000b' }));
});
test('stable background references permit encoded spaces/cache paths but reject temporary signatures and normalized asset aliases', () => {
  for (const value of ['/api/assets/42', '/static/My%20Card.png?v=1', '/static/a.png?token=cache', 'https://cdn.test/api/assets/bg.png', 'https://cdn.test/My%20Card.png']) assert.equal(distributorImageReference(value), true, value);
  for (const value of ['/api/assets/42?sig=x', '/api/assets/42#x', '/api/%61ssets/42', '/a/../api/assets/42', '/a/%252e%252e/api/assets/42', '/a/..//evil.test', '/static/a%255cb.png', '/a%250ab', '//evil.test/a', 'http://cdn.test/a', 'https:cdn.test/a', 'https://u:p@cdn.test/a', 'https://cdn.test/a?ToKeN=x', 'https://cdn.test/a?X-Amz-Signature=x']) assert.equal(distributorImageReference(value), false, value);
  assert.equal(distributorImagePreview('/api/assets/42?sig=preview'), '/api/assets/42?sig=preview');
});
test('safe CSS colors include exact RGBA numeric rules without arbitrary CSS expressions', () => {
  for (const color of ['#ABC', '#abcd', '#aabbcc', '#11223344', 'rgb(0,255,12)', 'rgba(1,2,3,1.000)', 'rgba(1,2,3,0.125)']) assert.equal(distributorColor(color), color);
  for (const color of ['red', 'var(--x)', 'url(javascript:x)', '#12345', 'rgb(256,0,0)', 'rgba(1,2,3,.5)', 'rgba(1,2,3,1.001)', 'rgb(1,2,3,0.5)', 'rgba(1,2,3)', ' #ABC\n']) assert.equal(distributorColor(color), '');
});
test('base and uplift calculations use exact hundredths and retain missing configuration', () => {
  assert.equal(distributorRatio('10.00', 10), '11.00'); assert.equal(distributorRatio('5.50', 10), '6.05'); assert.equal(distributorRatio('0.01', 1), '0.01'); assert.equal(distributorRatio('100.00', 1000), '1100.00');
  for (const base of [null, 'NaN', '-1', '1e2', '1.001']) assert.equal(distributorRatio(base, 10), null); assert.equal(distributorRatio('10', -1), null);
  assert.equal(distributorTime(0), '未记录'); assert.equal(distributorTime(-1), '时间无效'); assert.equal(distributorTime(1), '1970-01-01 08:00:01');
});
test('query retains status zero and literal keyword while bounding offset and requiring positive parent', () => {
  assert.deepEqual(normalizeDistributorQuery('task', { page: 1001, limit: 100, level_id: 7, status: 0, keyword: ' %_\\🌤 ' }), { page: 1001, limit: 100, keyword: '%_\\🌤', status: 0, level_id: 7 });
  for (const query of [{ page: 1002, limit: 100 }, { page: 1, limit: 101 }, { page: 0, limit: 20 }, { page: 1, limit: 20, status: 2 }, { page: 1, limit: 20, keyword: 'x'.repeat(51) }, { page: 1, limit: 20, keyword: '\nword' }, { page: 1, limit: 20, unknown: 1 }]) assert.throws(() => normalizeDistributorQuery('level', query as never));
  assert.throws(() => normalizeDistributorQuery('task', { page: 1, limit: 20, level_id: 0 })); assert.throws(() => normalizeDistributorQuery('parents', { page: 1, limit: 20, level_id: 7 }));
});
test('list/detail retain historical diagnostics, null configuration, completed task and readonly is_must', () => {
  const parsed = parseDistributorList('level', { ...snapshot, config: { one_ratio: null, two_ratio: null, enabled: null }, list: [{ ...row, grade: -1, issues: ['invalid grade'] }] });
  assert.equal(parsed.list[0].grade, -1);
  assert.equal(parseDistributorList('task', taskSnapshot, { page: 1, limit: 20, level_id: 7 }).list[0].id, 8);
  assert.equal(parseDistributorDetail('task', { info: task, parent, task_types: types, issues: [] }, 8).info.id, 8);
  assert.deepEqual(parseDistributorParents({ list: [parent], count: 1, page: 1, limit: 20, revision, issues: [] }).list, [parent]);
});
test('mismatched versions, duplicate rows, partial DTOs and foreign parent cannot enter snapshots', () => {
  for (const value of [{ ...snapshot, list: [row, row], count: 2 }, { ...snapshot, list: [{ ...row, revision: 'b'.repeat(64) }] }, { ...snapshot, config: {} }, { ...snapshot, revision: 'wrong' }]) assert.throws(() => parseDistributorList('level', value));
  assert.throws(() => parseDistributorList('level', snapshot, { page: 2, limit: 20 }));
  assert.throws(() => parseDistributorList('task', { ...taskSnapshot, list: [{ ...task, level_id: 9 }] }));
  assert.throws(() => parseDistributorDetail('task', { info: task, parent: { ...parent, id: 9 }, task_types: types, issues: [] }, 8));
});
test('canonical hashing fixes resource/action and full values order, excludes UUID and uses normalized text', async () => {
  const canonical = distributorCanonical(input); assert.deepEqual(Object.keys(canonical), ['operation', 'id', 'revision', 'values']);
  assert.equal(await distributorFingerprint(input), createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  assert.equal(await distributorFingerprint({ ...input, input: { ...input.input, request_id: '123e4567-e89b-42d3-a456-426614174001' } }), await distributorFingerprint(input));
  assert.deepEqual(distributorCanonical({ operation: 'task:status', id: 8, input: { request_id: requestId, revision, status: 0 } }), { operation: 'task:status', id: 8, revision, status: 0 });
  assert.deepEqual(distributorCanonical({ operation: 'level:delete', id: 7, input: { request_id: requestId, revision } }), { operation: 'level:delete', id: 7, revision });
});
test('operation-specific IDs and UUID/input shapes reject before a pending intent is stored', () => {
  for (const changed of [{ ...input, id: 7 }, { ...input, operation: 'create' }, { ...input, input: { ...input.input, request_id: requestId.toUpperCase() } }, { ...input, input: { ...input.input, status: 1 } }]) assert.throws(() => normalizeDistributorIntent(changed as never));
  assert.throws(() => normalizeDistributorIntent({ operation: 'task:delete', id: 0, input: { request_id: requestId, revision } }));
});
test('shared frontend/backend golden hash fixes Unicode, whitespace normalization and percentage field order', async () => {
  assert.equal(await distributorFingerprint(input), 'b9effe63d201674b2bf45df1e1bad49351e9588ecabdcae39b8d0f27c7d833ff');
});
test('one actor-bound pending record spans both pages and rejects tampered/noncanonical text', async () => {
  const normalized = normalizeDistributorIntent(input), pending: DistributorPending = { version: 1, actor: 12, ...normalized, fingerprint: await distributorFingerprint(normalized) };
  assert.deepEqual(await parseDistributorPending(JSON.stringify(pending), 12), pending); assert.equal(distributorPendingKey(12), 'admin_distributor_catalog_pending:12');
  await assert.rejects(parseDistributorPending(JSON.stringify(pending), 13)); await assert.rejects(parseDistributorPending(JSON.stringify({ ...pending, fingerprint: 'b'.repeat(64) }), 12));
  await assert.rejects(parseDistributorPending(JSON.stringify({ ...pending, input: { ...pending.input, values: { ...values, name: ' changed ' } } }), 12));
});
test('receipt matches operation, target ID, original UUID and payload fingerprint', async () => {
  const pending: DistributorPending = { version: 1, actor: 12, ...normalizeDistributorIntent(input), fingerprint: await distributorFingerprint(input) };
  const receipt = parseDistributorReceipt({ operation: 'level:create', id: 99, request_id: requestId, payload_hash: pending.fingerprint }, requestId); assert.doesNotThrow(() => assertDistributorReceipt(receipt, pending));
  for (const change of [{ operation: 'task:create' }, { request_id: 'wrong' }, { payload_hash: 'b'.repeat(64) }]) assert.throws(() => assertDistributorReceipt({ ...receipt, ...change } as never, pending));
  assert.throws(() => assertDistributorReceipt({ ...receipt, operation: 'level:update', id: 8 }, { ...pending, operation: 'level:update', id: 7 }));
});
test('only actual HTTP409 matched rollback proof releases frozen input; business envelopes remain uncertain', async () => {
  const pending: DistributorPending = { version: 1, actor: 12, ...normalizeDistributorIntent(input), fingerprint: await distributorFingerprint(input) }, proof = { code: 'DISTRIBUTOR_LEVEL_STALE_VERSION', operation: pending.operation, request_id: requestId, payload_hash: pending.fingerprint };
  const reason = { isAxiosError: true, response: { status: 409, data: { status: 409, data: proof } } }; assert.equal(isDistributorStale(reason, pending), true);
  for (const changed of [new AdminResponseError('body409', 409), { ...reason, response: { ...reason.response, status: 200 } }, ...[{ operation: 'task:create' }, { request_id: 'wrong' }, { payload_hash: 'b'.repeat(64) }, { code: 'OTHER' }].map(change => ({ ...reason, response: { ...reason.response, data: { status: 409, data: { ...proof, ...change } } } }))]) assert.equal(isDistributorStale(changed, pending), false);
  assert.equal(distributorReceiptNotFound({ isAxiosError: true, response: { status: 404 } }), true); assert.equal(distributorReceiptNotFound(new AdminResponseError('body404', 404)), false);
});
test('REST handles both catalog resources, independent parents, full CRUD and exact DELETE body with abort signal', async () => {
  const oldAdapter = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), calls: { method?: string; url?: string; body: unknown; params: unknown; signal: unknown }[] = [], signal = new AbortController().signal;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  request.defaults.adapter = async options => {
    calls.push({ method: options.method, url: options.url, body: options.data ? JSON.parse(String(options.data)) : null, params: options.params, signal: options.signal });
    const kind = options.url?.includes('level-tasks') ? 'task' : 'level';
    const data = options.method === 'get' && options.url?.endsWith('/parents') ? { list: [parent], count: 1, page: 1, limit: 20, revision, issues: [] }
      : options.method === 'get' && options.url === '/agent/levels' ? snapshot : options.method === 'get' && options.url === '/agent/level-tasks' ? taskSnapshot
      : options.method === 'get' && /\/(?:7|8)$/u.test(options.url!) ? kind === 'level' ? { info: row, config, issues: [] } : { info: task, parent, task_types: types, issues: [] }
      : { operation: `${kind}:${options.method === 'post' ? 'create' : options.method === 'put' ? 'update' : options.method === 'patch' ? 'status' : 'delete'}`, id: kind === 'level' ? 7 : 8, request_id: requestId, payload_hash: revision };
    return { config: options, data: { status: 200, msg: 'ok', data }, headers: {}, status: 200, statusText: 'OK' };
  };
  try {
    await apiDistributorList('level', { page: 1, limit: 20, status: 0 }, signal); await apiDistributorList('task', { page: 1, limit: 20, level_id: 7 }, signal); await apiDistributorParents({ page: 1, limit: 20 }, signal);
    for (const kind of ['level', 'task'] as const) {
      const id = kind === 'level' ? 7 : 8, data = kind === 'level' ? values : taskValues;
      await apiDistributorDetail(kind, id, signal); await apiDistributorWrite({ operation: `${kind}:create`, id: 0, input: { request_id: requestId, revision, values: data } }, signal);
      await apiDistributorWrite({ operation: `${kind}:update`, id, input: { request_id: requestId, revision, values: data } }, signal); await apiDistributorWrite({ operation: `${kind}:status`, id, input: { request_id: requestId, revision, status: 0 } }, signal);
      await apiDistributorWrite({ operation: `${kind}:delete`, id, input: { request_id: requestId, revision } }, signal); await apiDistributorReceipt(kind, requestId, signal);
    }
    assert.equal(calls.length, 15); assert.ok(calls.every(call => call.signal === signal)); assert.deepEqual(calls.filter(call => call.method === 'delete').map(call => call.body), [{ request_id: requestId, revision }, { request_id: requestId, revision }]);
    const before = calls.length; await assert.rejects(apiDistributorList('task', { page: 1, limit: 20, level_id: 0 })); await assert.rejects(apiDistributorWrite({ ...input, id: 7 })); assert.equal(calls.length, before);
  } finally { request.defaults.adapter = oldAdapter; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
test('only matched actual HTTP400 rejected-intent proof permits correction; journal/body errors stay uncertain', async () => {
  const pending: DistributorPending = { version: 1, actor: 12, ...normalizeDistributorIntent(input), fingerprint: await distributorFingerprint(input) }, proof = { code: 'DISTRIBUTOR_LEVEL_REJECTED', operation: pending.operation, request_id: requestId, payload_hash: pending.fingerprint };
  const reason = { isAxiosError: true, response: { status: 400, data: { status: 400, msg: '该分销等级已存在', data: proof } } };
  assert.equal(isDistributorRejected(reason, pending), true); assert.equal(distributorErrorMessage(reason), '该分销等级已存在'); assert.equal(distributorRejectedDraftKey(12), 'admin_distributor_catalog_rejected:12');
  for (const changed of [new AdminResponseError('body400', 400), { ...reason, response: { ...reason.response, status: 200 } }, { ...reason, response: { ...reason.response, data: { status: 400, data: null } } }, ...[{ code: 'OTHER' }, { operation: 'task:create' }, { request_id: 'wrong' }, { payload_hash: 'b'.repeat(64) }].map(change => ({ ...reason, response: { ...reason.response, data: { status: 400, data: { ...proof, ...change } } } }))]) assert.equal(isDistributorRejected(changed, pending), false);
  for (const msg of [{ text: 'unsafe' }, '\u0000bad', 'x'.repeat(1001)]) assert.equal(distributorErrorMessage({ ...reason, response: { ...reason.response, data: { msg } } }), '请求失败，请重新读取并核对');
});
test('orphan repair derives only exact positive INT32 task IDs without interpreting unrelated graph diagnostics', () => {
  assert.deepEqual(distributorOrphanIds(['orphan_task:8', 'orphan_task:7', 'orphan_task:8', 'orphan_task:0', 'orphan_task:01', 'orphan_task:2147483648', 'orphan_task:7extra', 'invalid_grade:7']), [7, 8]);
  assert.equal(parseDistributorParents({ list: [], count: 0, page: 1, limit: 20, revision, issues: Array.from({ length: 120 }, (_, i) => `orphan_task:${i + 1}`) }).issues.length, 120);
});
