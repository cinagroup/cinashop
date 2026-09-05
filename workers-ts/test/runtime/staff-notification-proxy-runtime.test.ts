import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest as adminProxy } from '../../../view/admin-ts/functions/adminapi/[[path]]';
import { onRequest as kefuProxy } from '../../../view/kefu-ts/functions/kefuapi/[[path]]';

afterEach(() => vi.restoreAllMocks());
function context(request: Request<unknown, IncomingRequestCfProperties>): Parameters<typeof adminProxy>[0] {
  return { request, env: { WORKERS_API: 'https://notice-api.example', ASSETS: { fetch: async () => new Response(null) } }, params: {}, data: {}, functionPath: '/',
    waitUntil: () => {}, passThroughOnException: () => {}, next: async () => new Response(null) };
}
describe('same-origin staff notification Pages proxy', () => {
  it.each([
    { proxy: adminProxy, path: '/adminapi/extract/notifications/socket', upstreamPath: '/api/admin/extract/notifications/socket' },
    { proxy: kefuProxy, path: '/kefuapi/messages/socket', upstreamPath: '/kefuapi/messages/socket' },
  ])('preserves the $path WebSocket and exact Origin/subprotocol', async ({ proxy, path, upstreamPath }) => {
    const pair = new WebSocketPair(); pair[1].accept();
    const upstream = new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'cinashop' } });
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://notice-api.example${upstreamPath}`);
      expect(request.headers.get('Origin')).toBe('https://staff.example');
      expect(request.headers.get('Sec-WebSocket-Protocol')).toBe('cinashop, cinashop-auth.fixture');
      expect(request.redirect).toBe('manual'); return upstream;
    });
    const response = await proxy(context(new Request<unknown, IncomingRequestCfProperties>(`https://staff.example${path}`, { headers: { Upgrade: 'websocket', Origin: 'https://staff.example', 'Sec-WebSocket-Protocol': 'cinashop, cinashop-auth.fixture' } })));
    expect(outbound).toHaveBeenCalledTimes(1); expect(response).toBe(upstream);
    const client = response.webSocket!;
    const received = new Promise<string>((resolve) => client.addEventListener('message', (event) => resolve(String(event.data)), { once: true }));
    client.accept(); pair[1].send('notification-frame'); expect(await received).toBe('notification-frame');
    client.close(); pair[1].close();
  });
  it('preserves non-upgrade error status, cache policy and streaming body', async () => {
    const response = new Response('Unavailable', { status: 503, headers: { 'cache-control': 'private, no-store' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    expect(await adminProxy(context(new Request<unknown, IncomingRequestCfProperties>('https://staff.example/adminapi/new_push')))).toBe(response);
    expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('Unavailable');
  });
});
