import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import request, { AdminResponseError } from '../src/utils/request.ts';
import { pcBannerFieldType, pcBannerAssetReference, pcBannerPreview, pcBannerLinkIsSafe, parsePcBannerFields,
  normalizePcBannerQuery, parsePcBannerList, parsePcBannerDetail, validatePcBannerValues, normalizePcBannerIntent,
  pcBannerCanonical, pcBannerFingerprint, parsePcBannerReceipt, assertPcBannerReceipt, pcBannerPendingKey,
  parsePcBannerPending, pcBannerReceiptNotFound, isPcBannerStale, apiPcBannerList, apiPcBannerDetail,
  apiPcBannerWrite, apiPcBannerReceipt, type PcBannerField, type PcBannerIntent, type PcBannerPending } from '../src/api/pcBanner.ts';

const revision = 'a'.repeat(64), requestId = '123e4567-e89b-42d3-a456-426614174000';
const fields: PcBannerField[] = [
  { key: 'title', label: '图片标题', type: 'input', choices: [], placeholder: '' },
  { key: 'image', label: '图片', type: 'upload', choices: [], placeholder: '' },
  { key: 'url', label: '跳转路径', type: 'input', choices: [], placeholder: '' },
  { key: 'note', label: '说明', type: 'textarea', choices: [], placeholder: '请输入说明' },
  ...['radio', 'checkbox', 'select'].map(type => ({ key: type, label: type, type, choices: [{ value: '0', label: '零' }, { value: '1', label: '一' }], placeholder: '' })),
  { key: 'gallery', label: '多图', type: 'uploads', choices: [], placeholder: '' },
  { key: 'future', label: '未来字段', type: 'future_type', choices: [], placeholder: '' },
];
const values = { title: '  轮播 🌤 e\u0301  ', image: '/api/assets/42', url: '/product/detail/9?from=banner', note: '第一行\r\n\t第二行', radio: '0', checkbox: ['1', '0'], select: '1', gallery: ['/static/a.png', '/static/a.png'], future: '可编辑' };
const input: PcBannerIntent = { operation: 'create', id: 0, input: { request_id: requestId, revision, values, sort: 8, status: 1 } };
const row = { id: 7, gid: 66, values, sort: 8, status: 1, issues: [], revision, image_preview: '/api/assets/42?sig=preview', image_previews: { image: ['/api/assets/42?sig=preview'], gallery: ['/static/a.png', '/static/a.png'] }, editable: true };
const group = { id: 66, name: 'PC端首页banner', info: 'PC首页', fields, issues: [] };
const snapshot = { group_present: true, group, default_fields: fields.slice(0, 3), list: [row], count: 1, page: 1, limit: 20, revision };

test('all dynamic field types including unknown input fallback retain complete values without trimming or Unicode normalization', () => {
  assert.equal(pcBannerFieldType(fields.at(-1)!), 'input');
  assert.deepEqual(validatePcBannerValues(values, fields), values);
  assert.equal(validatePcBannerValues(values, fields).title, '  轮播 🌤 e\u0301  ');
  assert.deepEqual(validatePcBannerValues(values, fields).gallery, ['/static/a.png', '/static/a.png']);
});
test('complete metadata rejects missing/extra fields, invalid choices and duplicate checkbox selections', () => {
  for (const changed of [{ ...values, title: '' }, { ...values, future: ' \t ' }, { ...values, radio: '2' }, { ...values, select: '' }, { ...values, checkbox: [] }, { ...values, checkbox: ['0', '0'] }, { ...values, extra: 'bad' }]) assert.throws(() => validatePcBannerValues(changed, fields));
  const missing = { ...values }; Reflect.deleteProperty(missing, 'future'); assert.throws(() => validatePcBannerValues(missing, fields));
  for (const gallery of [[], Array(6).fill('/static/a.png'), ['/api/assets/42?sig=temporary']]) assert.throws(() => validatePcBannerValues({ ...values, gallery }, fields));
});
test('textarea alone admits CR/LF/tab and respects codepoint lengths; malformed Unicode and control bytes fail closed', () => {
  assert.equal(validatePcBannerValues({ ...values, note: '🌤'.repeat(10000) }, fields).note, '🌤'.repeat(10000));
  assert.equal(validatePcBannerValues({ ...values, title: '🌤'.repeat(4096) }, fields).title, '🌤'.repeat(4096));
  for (const change of [{ title: 'a\nb' }, { future: '\ttext' }, { note: 'a\u0000b' }, { note: 'x'.repeat(10001) }, { title: 'x'.repeat(4097) }, { title: '\ud800' }]) assert.throws(() => validatePcBannerValues({ ...values, ...change }, fields));
});
test('metadata validates full long placeholders, unique keys/choices and bounded definitions', () => {
  assert.equal(parsePcBannerFields([{ ...fields[3], placeholder: 'x'.repeat(10000) }])[0].placeholder.length, 10000);
  for (const value of [[fields[0], fields[0]], [{ ...fields[0], key: '__proto__' }], [{ ...fields[0], key: ' title ' }], [{ ...fields[0], label: 'x'.repeat(257) }], [{ ...fields[3], placeholder: 'x'.repeat(10001) }], [{ ...fields[4], choices: [{ value: '0', label: 'a' }, { value: '0', label: 'b' }] }], Array(101).fill(fields[0])]) assert.throws(() => parsePcBannerFields(value));
});
test('stable image references distinguish canonical assets, legacy cache URLs and short-lived preview signatures', () => {
  for (const value of ['/api/assets/42', '/static/My%20Banner.png?v=1', 'https://img.example/My%20Banner.png?token=old#fragment', 'https://img.example/api/assets/42']) assert.equal(pcBannerAssetReference(value), true, value);
  for (const value of ['/api/assets/42?sig=temp', '/api/assets/42#fragment', '/api/%61ssets/42', '/api/assets/0', '/a/../api/assets/42', '/a/%2e%2e/api/assets/42', '/a/%252e%252e/api/assets/42', 'https://img.example/a.png?X-Amz-Signature=temp', 'http://img.example/a.png', '//evil/a.png', '/a%255cb.png', '/a%250ab.png', '/My Banner.png', 'https://u:p@img.example/a.png']) assert.equal(pcBannerAssetReference(value), false, value);
  assert.equal(pcBannerPreview('/api/assets/42?sig=preview'), '/api/assets/42?sig=preview');
});
test('safe jumps retain HTTP/HTTPS and encoded ordinary spaces while rejecting dangerous decoded layers', () => {
  for (const value of ['/goods?q=white%20shirt', '/legacy/path', '/product/detail/9', 'http://legacy.example/page', 'https://example.test/a?key=1']) assert.equal(pcBannerLinkIsSafe(value), true, value);
  for (const value of ['javascript:alert(1)', 'data:text/plain,x', '//evil.test/x', '/%252f%252fevil', '/a%25255cb', '/a%250db', 'https://u:p@example.test/x', ' /goods', '/goods?q=white shirt', 'goods/7', 'https:example.com', 'http:example.com', '/a/..//evil.test', '/a/%2e%2e//evil.test']) assert.equal(pcBannerLinkIsSafe(value), false, value);
});
test('core display fields preserve public scalar semantics independently of dynamic metadata type', () => {
  const custom = fields.map(field => field.key === 'image' ? { ...field, type: 'future_image_type' } : field.key === 'url' ? { ...field, type: 'select', choices: [{ value: '/goods/9', label: '商品9' }, { value: 'javascript:alert(1)', label: '危险历史选项' }] } : field.key === 'title' ? { ...field, type: 'textarea' } : field);
  assert.equal(validatePcBannerValues({ ...values, url: '/goods/9' }, custom).image, '/api/assets/42');
  for (const change of [{ image: '/api/assets/42?sig=temp' }, { url: 'javascript:alert(1)' }, { title: '带\n换行标题' }]) assert.throws(() => validatePcBannerValues({ ...values, url: '/goods/9', ...change }, custom));
  for (const key of ['title', 'image', 'url']) for (const type of ['checkbox', 'uploads']) assert.throws(() => parsePcBannerFields(fields.map(field => field.key === key ? { ...field, type } : field)));
});
test('canonical hashes use fixed outer order, sorted complete values, original array order and exclude UUID', async () => {
  const normalized = normalizePcBannerIntent(input, fields), canonical = pcBannerCanonical(normalized);
  assert.deepEqual(Object.keys(canonical), ['operation', 'id', 'revision', 'values', 'sort', 'status']);
  assert.deepEqual(Object.keys(canonical.values as object), Object.keys(values).sort());
  assert.equal(await pcBannerFingerprint(normalized), createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  assert.equal(await pcBannerFingerprint({ ...normalized, input: { ...normalized.input, request_id: '123e4567-e89b-42d3-a456-426614174001' } }), await pcBannerFingerprint(normalized));
  assert.notEqual(await pcBannerFingerprint({ ...normalized, input: { ...normalized.input, values: { ...values, checkbox: ['0', '1'] } } }), await pcBannerFingerprint(normalized));
  assert.deepEqual(pcBannerCanonical({ operation: 'status', id: 7, input: { request_id: requestId, revision, status: 0 } }), { operation: 'status', id: 7, revision, status: 0 });
  assert.deepEqual(pcBannerCanonical({ operation: 'delete', id: 7, input: { request_id: requestId, revision } }), { operation: 'delete', id: 7, revision });
});
test('mutation shapes, UUID, operation-specific IDs, integer sort and body bounds reject before dispatch', () => {
  for (const change of [{ id: 7 }, { operation: 'unknown' }, { input: { ...input.input, extra: 1 } }, { input: { ...input.input, sort: -1 } }, { input: { ...input.input, status: '1' } }, { input: { ...input.input, request_id: requestId.toUpperCase() } }, { input: { ...input.input, values: {} } }, { input: { ...input.input, revision: 'bad' } }]) assert.throws(() => normalizePcBannerIntent({ ...input, ...change } as PcBannerIntent));
  assert.throws(() => normalizePcBannerIntent({ operation: 'delete', id: 7, input: { request_id: requestId, revision, status: 0 } }));
  assert.throws(() => normalizePcBannerIntent({ ...input, input: { ...input.input, values: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, '🌤'.repeat(10000)])) } }));
});
test('list supports all records beyond the public ten and retains repairable null fields versus corrupt JSON rows', () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ ...row, id: i + 1 }));
  assert.equal(parsePcBannerList({ ...snapshot, list, count: 45 }).count, 45);
  assert.equal(parsePcBannerList({ ...snapshot, list: [{ ...row, values: { ...values, image: null }, issues: ['image invalid'], editable: true }] }).list[0].editable, true);
  assert.equal(parsePcBannerList({ ...snapshot, list: [{ ...row, values: {}, issues: ['invalid JSON'], editable: false }] }).list[0].editable, false);
  assert.deepEqual(parsePcBannerList({ ...snapshot, group_present: false, group: null, list: [], count: 0 }).default_fields, fields.slice(0, 3));
  assert.equal(parsePcBannerList({ ...snapshot, group: { ...group, fields: [], issues: ['malformed metadata'] } }).group?.fields.length, 0);
});
test('truncated, mismatched and foreign list/detail projections do not become valid snapshots', () => {
  for (const value of [{ ...snapshot, group_present: false }, { ...snapshot, group: null }, { ...snapshot, revision: '' }, { ...snapshot, list: [row, row] }, { ...snapshot, list: [{ ...row, gid: 67 }] }, { ...snapshot, list: [{ ...row, editable: undefined }] }, { ...snapshot, default_fields: null }]) assert.throws(() => parsePcBannerList(value));
  assert.throws(() => parsePcBannerList(snapshot, { page: 2, limit: 20 }));
  assert.throws(() => parsePcBannerDetail({ info: row, group }, 8));
  assert.throws(() => parsePcBannerDetail({ info: row, group: { ...group, id: 67 } }, 7));
  assert.deepEqual(parsePcBannerDetail({ info: row, group }, 7).info, row);
});
test('pagination preserves explicit hidden status zero and enforces maximum offset without a ten-record management cap', () => {
  assert.deepEqual(normalizePcBannerQuery({ page: 1001, limit: 100, status: 0 }), { page: 1001, limit: 100, status: 0 });
  for (const value of [{ page: 0, limit: 20 }, { page: 1002, limit: 100 }, { page: 1, limit: 101 }, { page: 1, limit: 20, status: 2 }, { page: 1, limit: 20, gid: 1 }]) assert.throws(() => normalizePcBannerQuery(value as never));
});
test('pending intent recovery is bound to actor, complete canonical bytes and original UUID', async () => {
  const normalized = normalizePcBannerIntent(input), pending: PcBannerPending = { version: 1, actor: 12, ...normalized, fingerprint: await pcBannerFingerprint(normalized) };
  assert.deepEqual(await parsePcBannerPending(JSON.stringify(pending), 12), pending);
  assert.equal(pcBannerPendingKey(12), 'admin_pc_home_banner_pending:12');
  await assert.rejects(parsePcBannerPending(JSON.stringify(pending), 13));
  await assert.rejects(parsePcBannerPending(JSON.stringify({ ...pending, input: { ...pending.input, status: 0 } }), 12));
  await assert.rejects(parsePcBannerPending(JSON.stringify({ ...pending, fingerprint: 'b'.repeat(64) }), 12));
});
test('successful create/update/status/delete receipts must match the full pending operation, id, nonce and hash', async () => {
  const pending: PcBannerPending = { version: 1, actor: 12, ...normalizePcBannerIntent(input), fingerprint: await pcBannerFingerprint(input) };
  const receipt = parsePcBannerReceipt({ operation: 'create', id: 99, request_id: requestId, payload_hash: pending.fingerprint }, requestId);
  assert.doesNotThrow(() => assertPcBannerReceipt(receipt, pending));
  for (const changed of [{ ...receipt, operation: 'update' }, { ...receipt, request_id: 'other' }, { ...receipt, payload_hash: 'b'.repeat(64) }]) assert.throws(() => assertPcBannerReceipt(changed as never, pending));
  assert.throws(() => parsePcBannerReceipt({ ...receipt, id: 0 }, requestId));
  assert.throws(() => assertPcBannerReceipt({ ...receipt, operation: 'update', id: 8 }, { ...pending, operation: 'update', id: 7 }));
});
test('only actual 409 rollback proof matching operation/UUID/hash can release a pending intent', async () => {
  const pending: PcBannerPending = { version: 1, actor: 12, ...normalizePcBannerIntent(input), fingerprint: await pcBannerFingerprint(input) };
  const proof = { code: 'PC_BANNER_STALE_VERSION', operation: 'create', request_id: requestId, payload_hash: pending.fingerprint };
  const error = { isAxiosError: true, response: { status: 409, data: { status: 409, data: proof } } };
  assert.equal(isPcBannerStale(error, pending), true);
  for (const reason of [new AdminResponseError('业务409', 409), { ...error, response: { ...error.response, status: 200 } }, { ...error, response: { ...error.response, data: { status: 200, data: proof } } }, ...[{ operation: 'update' }, { request_id: 'wrong' }, { payload_hash: 'b'.repeat(64) }, { code: 'OTHER' }].map(change => ({ ...error, response: { ...error.response, data: { status: 409, data: { ...proof, ...change } } } }))]) assert.equal(isPcBannerStale(reason, pending), false);
  assert.equal(pcBannerReceiptNotFound({ isAxiosError: true, response: { status: 404 } }), true);
  assert.equal(pcBannerReceiptNotFound(new AdminResponseError('HTTP200业务404', 404)), false);
});
test('REST dispatches all seven bounded APIs and DELETE body with cancellation, without automatic retries', async () => {
  const adapter = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  const calls: Array<{ method?: string; url?: string; body: unknown; params: unknown; signal: unknown }> = [], signal = new AbortController().signal;
  request.defaults.adapter = async config => {
    calls.push({ method: config.method, url: config.url, body: config.data ? JSON.parse(String(config.data)) : null, params: config.params, signal: config.signal });
    const data = config.method === 'get' && config.url === '/setting/pc-banners' ? snapshot : config.method === 'get' && config.url === '/setting/pc-banners/7' ? { info: row, group }
      : { operation: config.method === 'post' ? 'create' : config.method === 'put' ? 'update' : config.method === 'patch' ? 'status' : 'delete', id: 7, request_id: requestId, payload_hash: revision };
    return { config, data: { status: 200, msg: 'ok', data }, headers: {}, status: 200, statusText: 'OK' };
  };
  try {
    await apiPcBannerList({ page: 1, limit: 20, status: 0 }, signal); await apiPcBannerDetail(7, signal);
    await apiPcBannerWrite(input, signal); await apiPcBannerWrite({ ...input, operation: 'update', id: 7 }, signal);
    await apiPcBannerWrite({ operation: 'status', id: 7, input: { request_id: requestId, revision, status: 0 } }, signal);
    await apiPcBannerWrite({ operation: 'delete', id: 7, input: { request_id: requestId, revision } }, signal); await apiPcBannerReceipt(requestId, signal);
    assert.deepEqual(calls.map(call => [call.method, call.url]), [['get', '/setting/pc-banners'], ['get', '/setting/pc-banners/7'], ['post', '/setting/pc-banners'], ['put', '/setting/pc-banners/7'], ['patch', '/setting/pc-banners/7/status'], ['delete', '/setting/pc-banners/7'], ['get', `/setting/pc-banners/request/${requestId}`]]);
    assert.deepEqual(calls[5].body, { request_id: requestId, revision }); assert.deepEqual(calls[0].params, { page: 1, limit: 20, status: 0 }); assert.ok(calls.every(call => call.signal === signal));
    const before = calls.length; await assert.rejects(apiPcBannerWrite({ ...input, id: 7 }, signal)); await assert.rejects(apiPcBannerList({ page: 0, limit: 20 }, signal)); assert.equal(calls.length, before);
  } finally { request.defaults.adapter = adapter; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
