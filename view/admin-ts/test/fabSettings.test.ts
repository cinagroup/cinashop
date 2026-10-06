import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { AxiosError } from 'axios';
import request, { AdminResponseError } from '../src/utils/request.ts';
import { normalizeFabValues, normalizeFabWrite, fabLinkSafe, fabPreview, fabCanonical, fabFingerprint, parseFabSnapshot, parseFabReceipt, assertFabReceipt, parseFabPending, fabPendingKey, fabDraftKey, isFabRejected, isFabStale, fabReceiptNotFound, fabErrorMessage, fabEditor, fabEditorValues, remapFabEditor, apiFabSettings, apiSaveFabSettings, apiFabReceipt, normalizeFabLinkQuery, parseFabLinkCategories, parseFabLinkTargets, fabLinkKinds, apiFabLinkCategories, apiFabLinkTargets, type FabPending, type FabWrite } from '../src/api/fabSettings.ts';
import { FabRequestScope } from '../src/pages/setting/fabSettingsController.ts';
const revision = 'a'.repeat(64), requestId = '123e4567-e89b-42d3-a456-426614174000', sourceId = 'b'.repeat(64);
const values = { is_show: 1 as const, index: 1 as const, shifting: 0, main_ago_image: ' /api/assets/42 ', main_after_image: '', button: [{ source_id: sourceId, img: ' /static/My%20Banner.png ', url: ' /pages/goods/goods_list/index?keyword=white%20shirt ' }] };
const input: FabWrite = { request_id: requestId, revision, values };
const normalized = normalizeFabWrite(input), baseline = normalized.values.button.map(row => ({ ...row }));
const snapshot = { present: true, row: { id: 7, status: 0, is_show: 0, is_del: 0 }, revision, values: normalized.values, raw_values: { ...normalized.values, opaque: undefined }, editable: true, issues: [], image_previews: { main_ago_image: '/api/assets/42?sig=preview', main_after_image: '', button: ['/static/My%20Banner.png'] } };
delete (snapshot.raw_values as Record<string, unknown>).opaque;
const pending = async (): Promise<FabPending> => ({ version: 1, actor: 12, id: 7, input: normalized, fingerprint: await fabFingerprint(normalized), baseline });
const error = (status: number, body: unknown) => new AxiosError('request failed', 'ERR_BAD_REQUEST', undefined, undefined, { status, data: body, statusText: '', headers: {}, config: {} } as never);

test('full six-key normalization preserves opaque sources, Unicode query and exact trims', () => {
  assert.deepEqual(Object.keys(normalized.values), ['is_show', 'index', 'shifting', 'main_ago_image', 'main_after_image', 'button']);
  assert.deepEqual(normalized.values.button[0], { source_id: sourceId, img: '/static/My%20Banner.png', url: '/pages/goods/goods_list/index?keyword=white%20shirt' });
  assert.equal(normalized.values.shifting, 0);
  assert.deepEqual(normalizeFabValues({ ...values, index: 4, main_ago_image: '', button: Array.from({ length: 3 }, () => ({ source_id: null, img: '/static/a.png', url: 'https://example.test/a' })) }).index, 4);
});
test('four style image/count contracts remain required even when display is off', () => {
  for (const changed of [{ ...values, is_show: 0, main_ago_image: '' }, { ...values, index: 2, main_after_image: '/static/a.png' }, { ...values, index: 3 }, { ...values, index: 4, main_ago_image: '', button: [] }, { ...values, button: [...values.button, ...values.button] }, { ...values, shifting: 100.1 }, { ...values, shifting: -1 }]) assert.throws(() => normalizeFabValues(changed));
  assert.equal(normalizeFabValues({ ...values, index: 2, is_show: 0, button: [], shifting: 100 }).button.length, 0);
  for (const value of [{ ...input, extra: 1 }, { ...input, request_id: 'invalid' }, { ...input, revision: 'invalid' }, { ...input, values: { ...values, unknown: 'x' } }]) assert.throws(() => normalizeFabWrite(value));
});
test('stable images reject signed and normalized canonical aliases; previews may be signed', () => {
  for (const img of ['/api/assets/42?sig=x', '/a/../api/assets/42', '/a/%252e%252e/api/assets/42', '/static/a%255cb.png', 'https://u:p@cdn.test/a', 'https://cdn.test/a?signature=x', 'http://cdn.test/a', 'https:cdn.test/a']) assert.throws(() => normalizeFabValues({ ...values, main_ago_image: img }), img);
  for (const img of ['/static/a.png?v=1', 'https://cdn.test/api/assets/banner.png', 'https://cdn.test/My%20Banner.png']) assert.equal(normalizeFabValues({ ...values, main_ago_image: img }).main_ago_image, img);
  assert.equal(fabPreview('/api/assets/42?sig=x'), '/api/assets/42?sig=x'); assert.equal(fabPreview('//evil.test/a'), '');
});
test('links permit registered/partial legacy pages, real HTTP(S), and external mini-program independent package paths', () => {
  for (const url of ['/pages/goods/goods_list/index?keyword=white%20shirt', '/pages/users/user_info/index', 'http://external.test/a', 'https://external.test/a?x=%20', 'packageA/detail/index?x=1@APPID=wxABCDEF0123456789', '/external/detail?q=1@APPID=wx0123456789abcdef']) assert.equal(fabLinkSafe(url), true, url);
  for (const url of ['/pages/unknown/page', '/goods/42', 'https:example.test', '//evil.test', '/a/..//evil.test', 'javascript:alert(1)', 'https://u:p@evil.test', '/pages/index/index%250a', 'https://external.test/a%255c', 'a/../b@APPID=wx0123456789abcdef', 'https://external.test@APPID=wx0123456789abcdef', 'pkg/页@APPID=wx0123456789abcdef', 'package/detail@APPID=other', 'a@APPID=wx0123456789abcdef@APPID=wx0123456789abcdef']) assert.equal(fabLinkSafe(url), false, url);
  assert.throws(() => normalizeFabValues({ ...values, main_ago_image: '\n/api/assets/42' })); assert.throws(() => normalizeFabValues({ ...values, button: [{ source_id: null, img: '/static/a.png', url: 'x\t' }] }));
});
test('canonical key order fixes all six fields and button source order while excluding UUID', async () => {
  const canonical = fabCanonical(input); assert.deepEqual(Object.keys(canonical), ['operation', 'revision', 'values']); assert.deepEqual(Object.keys(canonical.values.button[0]!), ['source_id', 'img', 'url']);
  const actual = await fabFingerprint(input); assert.equal(actual, createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  assert.equal(actual, 'de3eebcb21e2def9942ece093cd0bafc1a7a6ed8a1f64025e1ea1c45b312b7d0');
  assert.equal(await fabFingerprint({ ...input, request_id: '123e4567-e89b-42d3-a456-426614174001' }), actual);
  assert.notEqual(await fabFingerprint({ ...input, values: { ...values, shifting: 100 } }), actual);
});
test('GET retains row-column versus payload distinction and duplicate readonly diagnostic without reseeding', () => {
  const parsed = parseFabSnapshot(snapshot); assert.equal(parsed.values?.is_show, 1); assert.equal(parsed.row?.status, 0);
  const duplicate = parseFabSnapshot({ ...snapshot, row: null, values: null, raw_values: null, editable: false, issues: ['配置重复'], image_previews: { main_ago_image: '', main_after_image: '', button: [] } });
  assert.equal(duplicate.present, true); assert.equal(duplicate.editable, false);
  assert.equal(parseFabSnapshot({ ...snapshot, present: false, row: null, raw_values: null }).editable, true);
  const large = parseFabSnapshot({ ...snapshot, values: { ...normalized.values, main_ago_image: null }, raw_values: { ...snapshot.raw_values, main_ago_image: 'x'.repeat(600000) }, issues: ['历史主图无效'] }); assert.equal(large.values?.main_ago_image, null);
});
test('malformed DTO, source duplicates and mismatched previews never become editable snapshots', () => {
  for (const row of [{ ...snapshot, revision: 'wrong' }, { ...snapshot, editable: 'true' }, { ...snapshot, values: { ...normalized.values, button: [baseline[0], baseline[0]] }, image_previews: { ...snapshot.image_previews, button: ['', ''] } }, { ...snapshot, image_previews: { ...snapshot.image_previews, button: [] } }, { ...snapshot, values: null }, { ...snapshot, raw_values: {} }]) assert.throws(() => parseFabSnapshot(row));
});
test('actor pending is canonical and source-bound, refusing tamper or another actor', async () => {
  const frozen = await pending(), raw = JSON.stringify(frozen); assert.deepEqual(await parseFabPending(raw, 12), frozen); assert.notEqual(fabPendingKey(12), fabPendingKey(13)); assert.notEqual(fabDraftKey(12), fabPendingKey(12));
  for (const changed of [{ ...frozen, actor: 13 }, { ...frozen, fingerprint: 'c'.repeat(64) }, { ...frozen, baseline: [] }, { ...frozen, input: { ...frozen.input, values: { ...frozen.input.values, main_ago_image: ' /api/assets/42 ' } } }]) await assert.rejects(parseFabPending(JSON.stringify(changed), 12));
});
test('only actual matching rollback proof releases rejection/stale; bare/business/foreign proofs remain unknown', async () => {
  const frozen = await pending(), data = { operation: 'update', request_id: requestId, payload_hash: frozen.fingerprint };
  assert.equal(isFabRejected(error(400, { status: 400, data: { ...data, code: 'FAB_SETTINGS_REJECTED' } }), frozen), true);
  assert.equal(isFabStale(error(409, { status: 409, data: { ...data, code: 'FAB_SETTINGS_STALE_VERSION' } }), frozen), true);
  for (const status of [200, 400, 409, 500]) { assert.equal(isFabRejected(error(status, { status: 400, data: { ...data, request_id: 'other', code: 'FAB_SETTINGS_REJECTED' } }), frozen), false); assert.equal(isFabStale(error(status, { status: 409, data: { ...data, payload_hash: 'c'.repeat(64), code: 'FAB_SETTINGS_STALE_VERSION' } }), frozen), false); }
  assert.equal(isFabRejected(error(400, { status: 400 }), frozen), false); assert.equal(isFabStale(new AdminResponseError('changed', 409), frozen), false);
});
test('receipt matches UUID/hash/id; only actual HTTP404 enables identical retry', async () => {
  const frozen = await pending(), receipt = { operation: 'update' as const, id: 7, request_id: requestId, payload_hash: frozen.fingerprint };
  assert.doesNotThrow(() => assertFabReceipt(parseFabReceipt(receipt, requestId), frozen));
  for (const changed of [{ ...receipt, id: 8 }, { ...receipt, payload_hash: 'c'.repeat(64) }, { ...receipt, request_id: '123e4567-e89b-42d3-a456-426614174001' }]) assert.throws(() => assertFabReceipt(changed, frozen));
  assert.equal(fabReceiptNotFound(error(404, { status: 404 })), true); assert.equal(fabReceiptNotFound(new AdminResponseError('missing', 404)), false);
  assert.equal(fabErrorMessage(error(400, { msg: { long: 'x' } })), '请求失败，请重新核对');
});
test('reread remaps a unique original pair despite edited fields/reordering and never guesses duplicate/changed extensions', () => {
  const editor = fabEditor(normalized.values), fresh = [{ ...baseline[0]!, source_id: 'c'.repeat(64) }];
  editor.button[0]!.img = '/static/new.png';
  const repaired = remapFabEditor(editor, baseline, fresh); assert.equal(repaired.button[0]!.source_id, fresh[0]!.source_id); assert.equal(repaired.button[0]!.img, '/static/new.png'); assert.equal(repaired.button[0]!.unresolved, false);
  assert.equal(remapFabEditor(editor, baseline, [{ ...fresh[0]!, url: '/pages/index/index' }]).button[0]!.unresolved, true);
  assert.equal(remapFabEditor(editor, baseline, [fresh[0]!, { ...fresh[0]!, source_id: 'd'.repeat(64) }]).button[0]!.unresolved, true);
  const bad = remapFabEditor(editor, baseline, []); assert.throws(() => fabEditorValues(bad)); bad.button[0]!.source_id = null; bad.button[0]!.unresolved = false; assert.equal(fabEditorValues(bad).button[0]!.source_id, null);
});
test('aborted generations discard late load/write/receipt after account switch, revoke and dispose', async () => {
  let identity = 'a:12:view,manage', stored = 'session-a', view = true;
  const scope = new FabRequestScope(() => identity, () => stored, () => view), old = scope.begin('write'), receipt = scope.begin('receipt');
  identity = 'b:13:view,manage'; stored = 'session-b'; scope.invalidate(); assert.equal(old.controller.signal.aborted, true); assert.equal(receipt.controller.signal.aborted, true); assert.equal(scope.valid('write', old), false);
  const next = scope.begin('load'), last = scope.begin('load'); assert.equal(next.controller.signal.aborted, true); assert.equal(scope.finish('load', next), false); assert.equal(scope.valid('load', last), true);
  view = false; assert.equal(scope.valid('load', last), false); view = true; scope.dispose(); assert.equal(scope.current(last.stamp), false);
});
test('API transports exact read/write/receipt routes with abort ownership and parsed response', async () => {
  const frozen = await pending(), paths: string[] = [], original = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), signal = new AbortController().signal;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  request.defaults.adapter = async config => { paths.push(config.url!); assert.equal(config.signal, signal); let data: unknown = snapshot; if (config.method === 'post') { assert.deepEqual(JSON.parse(config.data), normalized); data = { operation: 'update', id: 7, request_id: requestId, payload_hash: frozen.fingerprint }; } else if (config.url?.includes('/request/')) data = { operation: 'update', id: 7, request_id: requestId, payload_hash: frozen.fingerprint }; return { config, status: 200, statusText: 'OK', headers: {}, data: { status: 200, data } }; };
  try { await apiFabSettings(signal); await apiSaveFabSettings(input, signal); await apiFabReceipt(requestId, signal); assert.deepEqual(paths, ['/setting/fab', '/setting/fab', '/setting/fab/request/' + requestId]); } finally { request.defaults.adapter = original; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
test('link directory and hierarchy query preserve parent zero, literal search, bounded paging and reject foreign categories', () => {
  const categories = { list: fabLinkKinds.map(kind => ({ kind, name: kind, group: '商品与页面' })), issues: [] };
  assert.equal(parseFabLinkCategories(categories).list.length, 13);
  assert.throws(() => parseFabLinkCategories({ ...categories, list: categories.list.slice(1) }));
  const query = normalizeFabLinkQuery({ kind: 'product_category', page: 1, limit: 15, parent_id: 0, search: '  %_🌤  ' });
  assert.deepEqual(query, { kind: 'product_category', page: 1, limit: 15, search: '%_🌤', parent_id: 0 });
  for (const value of [{ kind: 'unknown', page: 1, limit: 15 }, { kind: 'basic', page: 1, limit: 15, parent_id: 2 }, { kind: 'product', page: 102, limit: 100 }, { kind: 'product', page: 1, limit: 101 }, { kind: 'product', page: 1, limit: 15, search: 'a\n' }]) assert.throws(() => normalizeFabLinkQuery(value as never));
  const target = { id: 7, kind: 'product_category', name: '分类', url: '/pages/goods/list?cid=7', selectable: true, partial: false, issues: [], parent_id: 0, has_children: true };
  const response = { list: [target], count: 1, page: 1, limit: 15, issues: [] };
  assert.equal(parseFabLinkTargets(response, query).list[0]!.has_children, true);
  assert.equal(parseFabLinkTargets({ ...response, list: [{ ...target, url: '', selectable: false, issues: ['旧页面暂无落点'] }] }, query).list[0]!.selectable, false);
  for (const value of [{ ...response, page: 2 }, { ...response, list: [{ ...target, kind: 'product' }] }, { ...response, list: [{ ...target, url: 'javascript:x' }] }, { ...response, list: [target, target], count: 2 }]) assert.throws(() => parseFabLinkTargets(value, query));
});
test('both selector APIs are readonly and retain query/signal ownership without a generic list endpoint', async () => {
  const old = request.defaults.adapter, storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), calls: unknown[] = [], signal = new AbortController().signal;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  request.defaults.adapter = async config => { assert.equal(config.method, 'get'); assert.equal(config.signal, signal); calls.push([config.url, config.params]); return { config, status: 200, statusText: 'OK', headers: {}, data: { status: 200, data: config.url!.endsWith('link-categories') ? { list: fabLinkKinds.map(kind => ({ kind, name: kind, group: '' })), issues: [] } : { list: [], count: 0, page: 2, limit: 15, issues: [] } } }; };
  try { await apiFabLinkCategories(signal); await apiFabLinkTargets({ kind: 'product', page: 2, limit: 15, parent_id: 7, search: ' phone ' }, signal); assert.deepEqual(calls, [['/setting/fab/link-categories', undefined], ['/setting/fab/link-targets', { kind: 'product', page: 2, limit: 15, search: 'phone', parent_id: 7 }]]); } finally { request.defaults.adapter = old; if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

