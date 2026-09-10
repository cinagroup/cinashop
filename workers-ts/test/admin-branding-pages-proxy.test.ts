import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../../view/admin-ts/functions/api/site_config';

afterEach(() => vi.restoreAllMocks());
function context(method = 'GET', target?: string): Parameters<typeof onRequest>[0] {
  return {
    request: new Request('https://admin.example/api/site_config?locale=zh', {
      method,
      headers: { Host: 'admin.example', Accept: 'application/json', Cookie: 'synthetic=fixture',
        Authorization: 'Bearer fixture', 'Authori-zation': 'Bearer fixture', 'If-None-Match': 'fixture-etag' },
    }),
    env: { WORKERS_API: target, ASSETS: { fetch: async () => new Response(null) } },
    params: {}, data: {}, functionPath: '/api/site_config', waitUntil: () => {},
    passThroughOnException: () => {}, next: async () => new Response('HTML shell'),
  };
}

describe('Admin public branding Pages route', () => {
  it.each(['GET', 'HEAD'])('proxies %s without forwarding authentication or buffering the response', async method => {
    const upstream = new Response(method === 'HEAD' ? null : '{"status":200,"data":{}}', {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
    });
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://worker.example/api/site_config?locale=zh');
      expect(request.method).toBe(method);
      expect(request.redirect).toBe('manual');
      for (const header of ['host', 'cookie', 'authorization', 'authori-zation']) expect(request.headers.get(header)).toBeNull();
      expect(request.headers.get('accept')).toBe('application/json');
      expect(request.headers.get('if-none-match')).toBe('fixture-etag');
      return upstream;
    });
    expect(await onRequest(context(method, 'https://worker.example/'))).toBe(upstream);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(upstream.bodyUsed).toBe(false);
  });

  it('uses the existing Worker origin when no Pages override is configured', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await onRequest(context());
    expect(String(outbound.mock.calls[0]![0])).toBe('https://cinashop-api.cinagroup.workers.dev/api/site_config?locale=zh');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s locally without an upstream request', async method => {
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected upstream'));
    const response = await onRequest(context(method));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each([503, 302])('preserves upstream status %s and does not fall back to the SPA', async status => {
    const upstream = new Response(null, { status, headers: { 'cache-control': 'no-store', location: 'https://worker.example/unavailable' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);
    expect(await onRequest(context())).toBe(upstream);
  });
});
