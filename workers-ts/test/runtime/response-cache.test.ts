import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { responseCacheContract } from '../helpers/responseCacheContract';
import { responseCacheMiddleware } from '../../src/middleware/response-cache';

responseCacheContract();

it('preserves a real workerd WebSocket upgrade', async () => {
  const app = new Hono(); app.use('*', responseCacheMiddleware);
  const pair = new WebSocketPair();
  pair[1].accept();
  app.get('/', () => new Response(null, { status: 101, webSocket: pair[0] }));
  const response = await app.request('/');
  expect(response.status).toBe(101);
  expect(response.webSocket).toBe(pair[0]);
  expect(response.headers.get('Cache-Control')).toBeNull();
  pair[0].accept();
  pair[0].close(1000, 'test complete');
  pair[1].close(1000, 'test complete');
});
