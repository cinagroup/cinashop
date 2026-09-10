import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppVariables, Env } from '@/env';
import { adminMobileProductUpdateAttrs } from '@/controllers/api/v1/AdminCrudController';
import { AdminMobileProductService, parseAdminProductSkuUpdates } from '@/services/admin/AdminMobileProductService';

// Shared Node/workerd contract: actual Request/Hono/controller and business parser.
// The service is intercepted; these tests make no database or authentication claims.
export function mobileProductBodyContract() {
  const maxBytes = 128 * 1024;
  const valid = { attr_value: [{ unique: 'qared001', price: '10.00', cost: '1.00', ot_price: '12.00', stock: 8 }] };
  const json = JSON.stringify(valid);
  const fixture = () => {
    const service = vi.spyOn(AdminMobileProductService.prototype, 'updateAttrs')
      .mockImplementation(async (_id, body) => ({ changed: parseAdminProductSkuUpdates(body).length }));
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    app.post('/api/admin/product/update_attrs/:id', adminMobileProductUpdateAttrs);
    return { service, app };
  };
  const makeRequest = (body: string | ReadableStream<Uint8Array>, length?: string) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (length !== undefined) headers.set('content-length', length);
    // Node requires duplex for a streaming Request; workerd ignores the extra field.
    const init = { method: 'POST', headers, body, duplex: 'half' as const };
    return new Request('http://localhost/api/admin/product/update_attrs/70', init);
  };
  afterEach(() => vi.restoreAllMocks());
  describe('mobile SKU update request body boundary', () => {
    it.each([
      { name: 'declared oversized', length: String(maxBytes + 1) },
      { name: 'no content length', length: undefined },
      { name: 'lying small content length', length: '1' },
    ])('rejects $name before invoking the business service', async ({ length }) => {
      const { app, service } = fixture();
      const response = await app.request(makeRequest(json + ' '.repeat(maxBytes + 1 - json.length), length));
      expect(await response.json()).toEqual({ status: 400, msg: '请求数据不能超过128 KiB', data: null });
      expect(service).not.toHaveBeenCalled();
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    });

    it('accepts an exactly 128 KiB JSON object and preserves the response contract', async () => {
      const { app, service } = fixture();
      const response = await app.request(makeRequest(json + ' '.repeat(maxBytes - json.length)));
      expect(await response.json()).toEqual({ status: 200, msg: '修改成功', data: { changed: 1 } });
      expect(service).toHaveBeenCalledExactlyOnceWith('70', valid);
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    });

    it('counts UTF-8 bytes rather than JavaScript string length', async () => {
      const { app, service } = fixture();
      const body = JSON.stringify({ ...valid, ignored: '中'.repeat(45_000) });
      expect(body.length).toBeLessThan(maxBytes);
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(maxBytes);
      expect(await (await app.request(makeRequest(body))).json())
        .toEqual({ status: 400, msg: '请求数据不能超过128 KiB', data: null });
      expect(service).not.toHaveBeenCalled();
    });

    it.each([undefined, '1'])('cancels chunked oversized input with length %s without pulling its tail', async length => {
      const { app, service } = fixture();
      const chunks = [
        new TextEncoder().encode(json + ' '.repeat(maxBytes - json.length)),
        new TextEncoder().encode(' '),
        new TextEncoder().encode('unread tail'),
      ];
      let pulls = 0;
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(chunks[pulls++]); if (pulls === chunks.length) controller.close(); },
        cancel,
      }, { highWaterMark: 0 });
      const response = await app.request(makeRequest(stream, length));
      expect(await response.json()).toEqual({ status: 400, msg: '请求数据不能超过128 KiB', data: null });
      expect(pulls).toBe(2);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(service).not.toHaveBeenCalled();
    });

    it('rejects a declared oversized stream before its first read', async () => {
      const { app, service } = fixture();
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new TextEncoder().encode(json)); controller.close();
      });
      const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
      const request = makeRequest(stream, String(maxBytes + 1));
      expect(await (await app.request(request)).json())
        .toEqual({ status: 400, msg: '请求数据不能超过128 KiB', data: null });
      expect(pull).not.toHaveBeenCalled();
      expect(service).not.toHaveBeenCalled();
      await request.body?.cancel();
    });

    it('decodes a legal Unicode ID split in the middle of a UTF-8 character', async () => {
      const { app, service } = fixture();
      const body = { attr_value: [{ ...valid.attr_value[0], unique: '红色规格' }] };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const split = bytes.findIndex(byte => byte > 127) + 1;
      let part = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(part++ === 0 ? bytes.slice(0, split) : bytes.slice(split));
          if (part === 2) controller.close();
        },
      }, { highWaterMark: 0 });
      expect(await (await app.request(makeRequest(stream))).json())
        .toEqual({ status: 200, msg: '修改成功', data: { changed: 1 } });
      expect(service).toHaveBeenCalledExactlyOnceWith('70', body);
    });

    it.each(['{', '[]', 'true', '"text"', '42'])('rejects malformed or non-object JSON %s before the service', async body => {
      const { app, service } = fixture();
      expect(await (await app.request(makeRequest(body))).json())
        .toEqual({ status: 400, msg: '请求数据格式错误', data: null });
      expect(service).not.toHaveBeenCalled();
    });

    it.each(['', 'null', '{}', '{"attr_value":[]}'])('retains business validation of empty attributes: %s', async body => {
      const { app } = fixture();
      expect(await (await app.request(makeRequest(body))).json())
        .toEqual({ status: 400, msg: '请填写属性值', data: null });
    });

    it.each(['utf8', 'escaped'] as const)('accepts 500 maximal field rows in formatted %s JSON', async encoding => {
      const { app, service } = fixture();
      const body = { attr_value: Array.from({ length: 500 }, (_, i) => ({
        unique: '界'.repeat(7) + String.fromCharCode(0x4e00 + i),
        price: '9999999999.99', cost: '9999999999.99', ot_price: '9999999999.99', stock: 2_147_483_647,
      })) };
      const formatted = JSON.stringify(body, null, 4);
      const serialized = encoding === 'utf8' ? formatted : formatted.replace(/[^\x00-\x7f]/g, char =>
        `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const size = new TextEncoder().encode(serialized).byteLength;
      expect(size).toBeGreaterThan(64 * 1024); expect(size).toBeLessThan(maxBytes);
      expect(await (await app.request(makeRequest(serialized))).json())
        .toEqual({ status: 200, msg: '修改成功', data: { changed: 500 } });
      expect(service).toHaveBeenCalledExactlyOnceWith('70', body);
      // Field/parser capacity only: the real service separately bounds aggregate stock.
      expect(parseAdminProductSkuUpdates(body)).toHaveLength(500);
    });

    it('keeps the 501-row business rejection independent of the byte budget', async () => {
      const { app } = fixture();
      const body = JSON.stringify({ attr_value: Array.from({ length: 501 }, (_, i) => ({
        ...valid.attr_value[0], unique: `qa${String(i).padStart(6, '0')}`,
      })) });
      expect(new TextEncoder().encode(body).byteLength).toBeLessThan(maxBytes);
      expect(await (await app.request(makeRequest(body))).json())
        .toEqual({ status: 400, msg: '请填写属性值', data: null });
    });

    it('propagates an input stream failure without calling the service', async () => {
      const { app, service } = fixture();
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error('isolated request stream failure')); },
      }, { highWaterMark: 0 });
      expect(await (await app.request(makeRequest(stream))).json())
        .toEqual({ status: 400, msg: 'isolated request stream failure', data: null });
      expect(service).not.toHaveBeenCalled();
    });
  });
}
