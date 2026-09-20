import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { responseCacheMiddleware } from '../../src/middleware/response-cache';
import { errorHandler } from '../../src/middleware/error';
import { NotFoundException } from '../../src/utils/errors';
import { jsonFail } from '../../src/utils/json';

export function responseCacheContract() {
  describe('response cache transport contract', () => {
    it.each([undefined, '', '   '])('defaults missing/empty policy %s without changing JSON bytes', async (declared) => {
      const app = new Hono(); app.use('*', responseCacheMiddleware);
      app.get('/', (c) => {
        if (declared !== undefined) c.header('Cache-Control', declared);
        return jsonFail(c, 'fixture');
      });
      const response = await app.request('/');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"status":400,"msg":"fixture","data":null}');
    });

    it.each(['public, max-age=60, s-maxage=300', 'private, no-store', 'no-store, max-age=0'])
      ('preserves explicit successful policy %s and other headers', async (declared) => {
        const app = new Hono(); app.use('*', responseCacheMiddleware);
        app.get('/', () => new Response('fixture', { headers: {
          'Cache-Control': declared, ETag: '"fixture"', Vary: 'Origin', 'Content-Type': 'text/plain',
        } }));
        const response = await app.request('/');
        expect(response.headers.get('Cache-Control')).toBe(declared);
        expect(response.headers.get('ETag')).toBe('"fixture"');
        expect(response.headers.get('Vary')).toBe('Origin');
        expect(await response.text()).toBe('fixture');
      });

    it.each(['private, no-store', 'no-store, max-age=0'])
      ('retains an existing failure no-store policy %s', async (declared) => {
        const app = new Hono(); app.use('*', responseCacheMiddleware);
        app.get('/', (c) => { c.header('Cache-Control', declared); throw new NotFoundException(); });
        app.onError(errorHandler);
        expect((await app.request('/')).headers.get('Cache-Control')).toBe(declared);
      });

    it.each([404, 429, 500, 503] as const)('rejects explicit caching on HTTP %i', async (status) => {
      const app = new Hono(); app.use('*', responseCacheMiddleware);
      app.get('/', () => new Response('failed', { status, headers: { 'Cache-Control': 'public, max-age=60' } }));
      const response = await app.request('/');
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
      expect(await response.text()).toBe('failed');
    });

    it('returns headers before an open stream finishes and preserves its exact bytes', async () => {
      let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { sink = controller; } });
      const app = new Hono(); app.use('*', responseCacheMiddleware);
      app.get('/', () => new Response(stream, { headers: {
        'Content-Type': 'text/event-stream', 'Set-Cookie': 'fixture=value; HttpOnly', Vary: 'Origin',
      } }));
      // A buffering implementation times out here: the stream has no data yet.
      const response = await app.request('/');
      expect(response.bodyUsed).toBe(false);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
      expect(response.headers.get('Set-Cookie')).toBe('fixture=value; HttpOnly');
      expect(response.headers.get('Vary')).toBe('Origin');
      sink!.enqueue(new TextEncoder().encode('data: fixture\n\n'));
      sink!.close();
      expect(await response.text()).toBe('data: fixture\n\n');
    });

    it('preserves HEAD and redirect status/location without consuming bodies', async () => {
      const app = new Hono(); app.use('*', responseCacheMiddleware);
      app.get('/data', (c) => c.text('fixture'));
      app.get('/redirect', (c) => c.redirect('/data', 302));
      const head = await app.request('/data', { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect(head.headers.get('Cache-Control')).toContain('no-store');
      const redirect = await app.request('/redirect');
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('Location')).toBe('/data');
      expect(redirect.headers.get('Cache-Control')).toContain('no-store');
    });
  });
}
