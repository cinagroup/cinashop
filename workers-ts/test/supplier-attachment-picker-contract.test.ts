import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { signAttachmentReferences } from '@/services/system/AttachmentService';

let actual: any, storage: Storage, surface: EventTarget;
const pickers: any[] = [];
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../view/supplier-ts');
  const output = await build({ absWorkingDir: root, stdin: { resolveDir: root, contents: `
    export * as attachments from './src/api/attachments';
    export { useAttachmentSelection } from './src/utils/attachmentSelection';
    export { http } from './src/api/http';
  ` }, alias: { '@': resolve(root, 'src') }, define: { 'import.meta.env.VITE_API_BASE_URL': '"/supplierapi"' },
    bundle: true, write: false, platform: 'browser', format: 'esm' });
  actual = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}, 60_000);
beforeEach(() => {
  const values = new Map<string, string>();
  storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); }, removeItem: key => { values.delete(key); } } as Storage;
  surface = new EventTarget(); vi.stubGlobal('localStorage', storage); vi.stubGlobal('window', surface);
  storage.setItem('supplier-token', 'fixture-a');
  storage.setItem('supplier-user', '{"id":99,"supplier_id":20}');
  storage.setItem('supplier-permissions', '["supplier.product.manage","supplier.attachment.view"]');
});
afterEach(() => { for (const picker of pickers.splice(0)) picker.dispose(); vi.unstubAllGlobals(); });

const query = (pid = 0, page = 1, name = '') => ({ pid, page, name });
function ticket(id: number) { return `/api/assets/${id}?expires=${Math.floor(Date.now() / 1000) + 900}&signature=${'a'.repeat(43)}`; }
function row(id = 1, pid = 0, override: Record<string, unknown> = {}) {
  return { att_id: id, pid, type: 4, file_type: 1, module_type: 1, relation_id: 20, real_name: `图片${id}.png`,
    att_type: 'image/png', canonical_url: `/api/assets/${id}`, att_dir: ticket(id), satt_dir: ticket(id), ...override };
}
function category(id = 10, pid = 0, override: Record<string, unknown> = {}) {
  return { id, pid, type: 4, file_type: 1, relation_id: 20, name: '商品图', children: [], loading: false, ...override };
}
const envelope = (data: unknown) => ({ status: 200, msg: 'fixture', data });
const response = (config: any, data: unknown) => ({ config, data, status: 200, statusText: 'fixture', headers: {} });
function reply(list: unknown[], count = list.length) {
  const adapter = vi.fn(async (config: any) => response(config, envelope({ list, count })));
  actual.http.defaults.adapter = adapter; return adapter;
}
function picker(limit = 2) {
  const result = actual.useAttachmentSelection({ supplierId: 20, limit }); pickers.push(result); return result;
}
function pendingRequests() {
  const buffered: any[] = [], waiters: Array<(request: any) => void> = [];
  actual.http.defaults.adapter = (config: any) => new Promise(resolve => {
    const request = { config, finish: (data: unknown) => resolve(response(config, data)) };
    const waiting = waiters.shift(); if (waiting) waiting(request); else buffered.push(request);
  });
  return { take: () => buffered.length ? Promise.resolve(buffered.shift()) : new Promise<any>(resolve => waiters.push(resolve)) };
}

describe('Supplier attachment strict decoding with the real signing contract', () => {
  it('accepts actual backend tickets and keeps the canonical path separate from both preview URLs', async () => {
    const canonical = '/api/assets/7';
    const [signed] = await signAttachmentReferences('fixture-local-key', [canonical]);
    const result = actual.attachments.decodeSupplierAttachmentPage({ list: [row(7, 0, { att_dir: signed, satt_dir: signed })], count: 1 }, query(), 20);
    expect(result.list[0]).toEqual({ id: 7, pid: 0, name: '图片7.png', canonicalUrl: canonical, previewUrl: signed, thumbnailUrl: signed });
    expect(result.list[0].canonicalUrl).not.toContain('?'); expect(Object.isFrozen(result.list[0])).toBe(true);
  });
  it.each([
    ['type', 1], ['module_type', 2], ['file_type', 2], ['relation_id', 99], ['pid', 10], ['att_id', '1'],
    ['att_type', 'text/html'], ['real_name', ''], ['canonical_url', '/api/assets/2'],
    ['canonical_url', 'javascript:alert(1)'], ['canonical_url', '//evil.test/a.png'],
    ['canonical_url', 'https://user:password@example.test/a.png'], ['canonical_url', 'https://example.test/a.png#fragment'],
    ['canonical_url', 'https://example.test/a.png?expires=1&signature=abc'],
    ['canonical_url', 'https://example.test/api/assets/1'], ['canonical_url', 'https://example.test/\\evil.png'],
    ['att_dir', '/api/assets/1'], ['att_dir', ticket(2)], ['satt_dir', ticket(2)],
    ['att_dir', `/api/assets/1?expires=1&signature=${'a'.repeat(43)}`],
    ['att_dir', `${ticket(1)}&other=1`], ['att_dir', `${ticket(1)}#fragment`],
  ])('atomically rejects an invalid %s row after a valid first row (%s)', (field, value) => {
    expect(() => actual.attachments.decodeSupplierAttachmentPage({ list: [row(8), row(1, 0, { [field]: value })], count: 2 }, query(), 20)).toThrow();
  });
  it('rejects duplicate IDs, impossible counts and oversized pages', () => {
    for (const data of [
      { list: [row(), row()], count: 2 }, { list: [row()], count: 0 },
      { list: Array.from({ length: 21 }, (_, i) => row(i + 1)), count: 21 }, { list: [], count: '0' },
    ]) expect(() => actual.attachments.decodeSupplierAttachmentPage(data, query(), 20)).toThrow();
    expect(() => actual.attachments.decodeSupplierAttachmentPage({ list: [row()], count: 20 }, query(0, 2), 20)).toThrow();
  });
  it('retains old HTTPS sources exactly, supports an independent HTTPS thumbnail and rejects swapped previews', () => {
    const external = 'https://cdn.example.test/a.png?v=3';
    const good = row(1, 0, { canonical_url: external, att_dir: external, satt_dir: 'https://cdn.example.test/thumb.png' });
    const decoded = actual.attachments.decodeSupplierAttachmentPage({ list: [good], count: 1 }, query(), 20).list[0];
    expect(decoded.canonicalUrl).toBe(external); expect(decoded.previewUrl).toBe(external);
    expect(() => actual.attachments.decodeSupplierAttachmentPage({ list: [{ ...good, att_dir: 'https://evil.test/other.png' }], count: 1 }, query(), 20)).toThrow();
  });
  it('uses a fresh preview when the historical thumbnail is empty', () => {
    const decoded = actual.attachments.decodeSupplierAttachmentPage({ list: [row(1, 0, { satt_dir: '' })], count: 1 }, query(), 20);
    expect(decoded.list[0].thumbnailUrl).toBe(decoded.list[0].previewUrl);
  });
  it('decodes exact-parent categories and rejects a whole mixed, duplicated or malformed batch', () => {
    expect(actual.attachments.decodeSupplierAttachmentCategories({ list: [category(10), category(11, 0, { loading: undefined })] }, 0, 20))
      .toEqual([{ id: 10, pid: 0, name: '商品图', hasChildren: true }, { id: 11, pid: 0, name: '商品图', hasChildren: false }]);
    for (const bad of [category(11, 1), category(11, 0, { relation_id: 99 }), category(11, 0, { type: 1 }),
      category(11, 0, { file_type: 2 }), category(11, 0, { children: [{}] }), category(11, 0, { loading: true }), category(10)]) {
      expect(() => actual.attachments.decodeSupplierAttachmentCategories({ list: [category(), bad] }, 0, 20)).toThrow();
    }
  });
});

describe('actual Axios endpoints and Supplier identity boundaries', () => {
  it('dispatches only exact read params and captures the Supplier token and supplier_id rather than administrator id', async () => {
    const adapter = reply([row(1, 10)], 21);
    await actual.attachments.getSupplierAttachments(query(10, 2, '  图片  '));
    const config = adapter.mock.calls[0][0];
    expect(config.url).toBe('/file/file'); expect(config.method).toBe('get');
    expect(config.params).toEqual({ pid: 10, name: '图片', page: 2, limit: 20, file_type: 1 });
    expect(config.headers.Authorization).toBe('Bearer fixture-a');
    reply([category(11, 10)]); await actual.attachments.getSupplierAttachmentCategories(10);
    const latest = actual.http.defaults.adapter.mock.calls[0][0];
    expect(latest.url).toBe('/file/category'); expect(latest.params).toEqual({ pid: 10, file_type: 1 });
  });
  it('rejects anonymous, missing supplier_id, invalid query and already cancelled requests before dispatch', async () => {
    const adapter = reply([]);
    const controller = new AbortController(); controller.abort();
    await expect(actual.attachments.getSupplierAttachments(query(), controller.signal)).rejects.toThrow();
    expect(() => actual.attachments.getSupplierAttachments(query(0, 0))).toThrow();
    expect(() => actual.attachments.getSupplierAttachments(query(0, 1, 'x'.repeat(81)))).toThrow();
    storage.setItem('supplier-user', '{"id":20}');
    await expect(actual.attachments.getSupplierAttachments(query())).rejects.toThrow('登录资料');
    storage.removeItem('supplier-token');
    await expect(actual.attachments.getSupplierAttachments(query())).rejects.toThrow();
    expect(adapter).not.toHaveBeenCalled();
  });
  it.each(['token', 'user', 'permissions'])('does not return a late successful page after a silent %s replacement', async key => {
    const pending = pendingRequests(), reading = actual.attachments.getSupplierAttachments(query()), request = await pending.take();
    storage.setItem('supplier-' + key, key === 'user' ? '{"id":99,"supplier_id":30}' : 'new-value');
    request.finish(envelope({ list: [row()], count: 1 }));
    await expect(reading).rejects.toThrow('会话已改变');
  });
  it('combined read cancellation reaches Axios and ignores a delayed adapter result', async () => {
    const pending = pendingRequests(), controller = new AbortController();
    const reading = actual.attachments.getSupplierAttachments(query(), controller.signal), request = await pending.take();
    controller.abort(); expect(request.config.signal.aborted).toBe(true);
    request.finish(envelope({ list: [row()], count: 1 }));
    await expect(reading).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  });
  it('explicit upload uses one multipart request, validates the real response and never returns a signed persistence URL', async () => {
    const data = new FormData(); data.append('file', new Blob(['local-image'], { type: 'image/png' }), 'local.png'); data.append('pid', '0');
    const signed = ticket(5);
    const adapter = vi.fn(async (config: any) => response(config, envelope({ att_id: 5, url: '/api/assets/5', src: signed, name: 'local.png', size: 11, type: 'image/png' })));
    actual.http.defaults.adapter = adapter;
    const result = await actual.attachments.uploadSupplierImage(data);
    expect(adapter).toHaveBeenCalledTimes(1); expect(adapter.mock.calls[0][0]).toMatchObject({ method: 'post', url: '/file/upload' });
    expect(adapter.mock.calls[0][0].data).toBe(data);
    expect(result).toMatchObject({ id: 5, canonicalUrl: '/api/assets/5', previewUrl: signed, mime: 'image/png' });
    expect(() => actual.attachments.decodeSupplierUploadedImage({ att_id: 5, url: ticket(5), src: ticket(5), name: 'local.png', size: 11, type: 'image/png' })).toThrow();
    expect(() => actual.attachments.decodeSupplierUploadedImage({ att_id: 5, url: '/api/assets/5', src: ticket(6), name: 'local.png', size: 11, type: 'image/png' })).toThrow();
  });
  it('does not expose a late upload receipt after permissions change or repeat an unknown upload result', async () => {
    const form = new FormData(), pending = pendingRequests();
    const uploading = actual.attachments.uploadSupplierImage(form), request = await pending.take();
    storage.setItem('supplier-permissions', '[]'); surface.dispatchEvent(new Event('supplier-session-changed'));
    expect(request.config.signal.aborted).toBe(true);
    request.finish(envelope({ att_id: 5, url: '/api/assets/5', src: ticket(5), name: 'local.png', size: 11, type: 'image/png' }));
    await expect(uploading).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    const adapter = vi.fn(async () => { throw new Error('fixture lost response'); }); actual.http.defaults.adapter = adapter;
    await expect(actual.attachments.uploadSupplierImage(form)).rejects.toThrow('fixture lost response');
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});

describe('real Vue selection state under reads, cancellation and permissions ABA', () => {
  it('prevents choosing old results while a search is pending, applies page/query together and enforces the selection maximum', async () => {
    const selection = picker(1); reply([row(1), row(2)]); await selection.load(query());
    expect(selection.toggle(1)).toBe(true); expect(selection.toggle(2)).toBe(false);
    const pending = pendingRequests(), reading = selection.load(query(10, 1, '红图')), request = await pending.take();
    expect(selection.rows.value).toEqual([]); expect(selection.toggle(1)).toBe(false); expect(selection.confirm()).toBeNull();
    expect(selection.canConfirm.value).toBe(false);
    request.finish(envelope({ list: [row(3, 10)], count: 1 })); await reading;
    expect(selection.applied.value).toEqual(query(10, 1, '红图')); expect(selection.rows.value[0].id).toBe(3);
    expect(selection.toggle(3)).toBe(false); selection.remove(1); expect(selection.toggle(3)).toBe(true);
    expect(selection.confirm()[0].canonicalUrl).toBe('/api/assets/3'); expect(selection.confirm()[0].previewUrl).toContain('?expires=');
  });
  it('accepts the latest search and ignores a delayed earlier response after Axios cancellation', async () => {
    const selection = picker(), pending = pendingRequests();
    const first = selection.load(query(0, 1, '旧')), old = await pending.take();
    const second = selection.load(query(0, 2, '新')), fresh = await pending.take();
    expect(old.config.signal.aborted).toBe(true);
    fresh.finish(envelope({ list: [row(2)], count: 21 })); await second;
    old.finish(envelope({ list: [row(1)], count: 1 })); await first;
    expect(selection.rows.value.map((row: any) => row.id)).toEqual([2]); expect(selection.applied.value).toEqual(query(0, 2, '新'));
    expect(selection.pages.value).toBe(2); expect(selection.error.value).toBe(''); expect(selection.loading.value).toBe(false);
  });
  it('fails atomically and retries the same query without leaving old results selectable', async () => {
    const selection = picker(); reply([row()]); await selection.load(query()); selection.toggle(1);
    reply([row(3, 10), row(4, 10, { relation_id: 30 })]); await selection.load(query(10, 1, '图'));
    expect(selection.rows.value).toEqual([]); expect(selection.error.value).toContain('响应无效'); expect(selection.confirm()).toBeNull();
    const adapter = reply([row(3, 10)]); await selection.retry();
    expect(adapter.mock.calls[0][0].params).toMatchObject({ pid: 10, name: '图', page: 1 });
    expect(selection.error.value).toBe(''); expect(selection.confirm()[0].canonicalUrl).toBe('/api/assets/1');
  });
  it('retains selections across pages, rejects duplicate canonical URLs and requires changed sources to be chosen again', async () => {
    const selection = picker(); reply([row(1)]); await selection.load(query()); selection.toggle(1);
    reply([row(2)], 21); await selection.load(query(0, 2)); selection.toggle(2);
    expect(selection.confirm().map((row: any) => row.canonicalUrl)).toEqual(['/api/assets/1', '/api/assets/2']);
    const url = 'https://cdn.example.test/a.png';
    reply([row(1, 0, { canonical_url: url, att_dir: url, satt_dir: url }), row(3, 0, { canonical_url: url, att_dir: url, satt_dir: url })]);
    await selection.load(query()); expect(selection.selected.value.map((row: any) => row.id)).toEqual([2]);
    selection.remove(2); expect(selection.toggle(1)).toBe(true); expect(selection.toggle(3)).toBe(false);
  });
  it('changes category atomically, blocks selection during category failure and retries the exact parent', async () => {
    const selection = picker(); reply([row()]); await selection.load(query()); selection.toggle(1);
    const pending = pendingRequests(), reading = selection.loadCategories(10), request = await pending.take();
    expect(selection.rows.value).toEqual([]); expect(selection.confirm()).toBeNull();
    request.finish(envelope({ list: [category(11, 20)] })); await reading;
    expect(selection.categories.value).toEqual([]); expect(selection.categoriesError.value).toContain('响应无效');
    const adapter = reply([category(11, 10)]); await selection.retryCategories();
    expect(adapter.mock.calls[0][0].params).toEqual({ pid: 10, file_type: 1 }); expect(selection.categories.value[0].hasChildren).toBe(true);
    reply([row(2, 10)]); await selection.load(query(10)); expect(selection.toggle(2)).toBe(true);
  });
  it('newer category results survive a delayed old category reply', async () => {
    const selection = picker(), pending = pendingRequests();
    const first = selection.loadCategories(0), old = await pending.take();
    const second = selection.loadCategories(10), fresh = await pending.take();
    fresh.finish(envelope({ list: [category(11, 10)] })); await second;
    old.finish(envelope({ list: [category(9)] })); await first;
    expect(selection.categories.value).toEqual([{ id: 11, pid: 10, name: '商品图', hasChildren: true }]);
  });
  it('permissions A -> B -> A clears results and selections immediately and cannot revive late reads', async () => {
    const selection = picker(); reply([row()]); await selection.load(query()); selection.toggle(1);
    const pending = pendingRequests(), reading = selection.load(query(0, 2)), request = await pending.take();
    const categoriesReading = selection.loadCategories(0), categoryRequest = await pending.take();
    storage.setItem('supplier-permissions', '[]'); surface.dispatchEvent(new Event('supplier-session-changed'));
    storage.setItem('supplier-permissions', '["supplier.product.manage","supplier.attachment.view"]'); surface.dispatchEvent(new Event('supplier-session-changed'));
    expect(selection.invalidated.value).toBe(true); expect(selection.selected.value).toEqual([]); expect(selection.rows.value).toEqual([]);
    expect(request.config.signal.aborted).toBe(true);
    expect(categoryRequest.config.signal.aborted).toBe(true);
    request.finish(envelope({ list: [row(2)], count: 21 })); await reading;
    categoryRequest.finish(envelope({ list: [category()] })); await categoriesReading;
    expect(selection.rows.value).toEqual([]); expect(selection.toggle(2)).toBe(false); expect(selection.confirm()).toBeNull();
    expect(selection.categories.value).toEqual([]);
    selection.reset(); expect(selection.invalidated.value).toBe(true);
  });
  it.each(['reset', 'dispose'])('%s aborts pending reads and prevents a late response from restoring rows', async action => {
    const selection = picker(), pending = pendingRequests(), reading = selection.load(query()), request = await pending.take();
    selection[action](); expect(request.config.signal.aborted).toBe(true); expect(selection.rows.value).toEqual([]);
    request.finish(envelope({ list: [row()], count: 1 })); await reading; expect(selection.rows.value).toEqual([]);
    if (action === 'dispose') { const adapter = reply([row()]); await selection.load(query()); expect(adapter).not.toHaveBeenCalled(); }
    else { reply([row(2)]); await selection.load(query()); expect(selection.toggle(2)).toBe(true); }
  });
  it('rejects a mismatched supplier owner before any request and never falls back to anonymous preview data', async () => {
    const adapter = reply([row()]); const selection = actual.useAttachmentSelection({ supplierId: 99, limit: 1 }); pickers.push(selection);
    await selection.load(query()); expect(selection.invalidated.value).toBe(true); expect(adapter).not.toHaveBeenCalled();
    expect(() => picker(0)).toThrow(); expect(() => picker(21)).toThrow();
  });
});
